#!/usr/bin/env python
# coding: utf-8
"""
Memo / Report Generation API Routes
====================================
Provides endpoints for generating equity research reports using FinSagent's
RAG + LLM and FinRobot's professional HTML template.
"""
import os
import sys
import json
import asyncio
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/memo", tags=["memo"])

# ── Output directory for generated reports ───────────────────────────────────
REPO_ROOT = os.path.realpath(os.path.join(os.path.dirname(__file__), ".."))
REPORTS_DIR = os.environ.get(
    "MEMO_REPORTS_DIR",
    os.path.join(REPO_ROOT, "reports"),
)
os.makedirs(REPORTS_DIR, exist_ok=True)


# ── Request / Response models ────────────────────────────────────────────────
class MemoGenerateRequest(BaseModel):
    company_name: str
    company_ticker: str
    sector: str = "N/A"
    share_price: str = "N/A"
    target_price: str = "N/A"
    market_cap: str = "N/A"
    fwd_pe: str = "N/A"
    pb_ratio: str = "N/A"
    roe: str = "N/A"
    dividend_yield: str = "N/A"
    week_52_range: str = "N/A"
    session_id: str = "memo_session"


class MemoGenerateResponse(BaseModel):
    report_id: str
    html_path: str
    html_url: str
    sections: dict
    evidence_count: int
    evidence_sources: list
    message: str = "Report generated successfully"


# ── Helper: get chat_service from app state ──────────────────────────────────
def _get_chat_service():
    """Retrieve the global chat_service instance."""
    # chat_service is a module-level global in app.py
    import app as app_module
    cs = getattr(app_module, "chat_service", None)
    if cs is None:
        raise HTTPException(status_code=503, detail="Chat service not initialized")
    return cs


# ── Routes ───────────────────────────────────────────────────────────────────
@router.post("/generate")
async def generate_memo(req: MemoGenerateRequest):
    """
    Generate a full equity research report with SSE streaming progress.
    Returns text/event-stream with progress events and final result.
    """
    cs = _get_chat_service()

    rag = getattr(cs, "rag", None)
    if rag is None:
        raise HTTPException(status_code=503, detail="RAG instance not available")

    session_manager = cs.get_or_create_session(req.session_id)
    config = getattr(cs, "config", {})

    sys.path.insert(0, os.path.join(REPO_ROOT, "src"))
    from memo.report_generator import generate_report

    output_dir = os.path.join(REPORTS_DIR, req.company_ticker)
    os.makedirs(output_dir, exist_ok=True)

    async def event_stream():
        queue: asyncio.Queue = asyncio.Queue()

        async def progress_cb(event):
            await queue.put(event)

        async def run_generation():
            try:
                result = await generate_report(
                    company_name=req.company_name,
                    company_ticker=req.company_ticker,
                    rag=rag,
                    session_manager=session_manager,
                    config=config,
                    output_dir=output_dir,
                    sector=req.sector,
                    share_price=req.share_price,
                    target_price=req.target_price,
                    market_cap=req.market_cap,
                    fwd_pe=req.fwd_pe,
                    pb_ratio=req.pb_ratio,
                    roe=req.roe,
                    dividend_yield=req.dividend_yield,
                    week_52_range=req.week_52_range,
                    progress_callback=progress_cb,
                )

                html_filename = os.path.basename(result["html_path"])
                html_url = f"/memo/report/{req.company_ticker}/{html_filename}"

                final_event = {
                    "type": "result",
                    "report_id": result["report_id"],
                    "html_path": result["html_path"],
                    "html_url": html_url,
                    "sections": result["sections"],
                    "evidence_count": result["evidence_count"],
                    "evidence_sources": result["evidence_sources"],
                    "token_usage": result.get("token_usage", []),
                }

                # Write memo summary to chat session history so subsequent
                # chat questions can recall what memo was generated.
                try:
                    sections = result["sections"]
                    tagline = sections.get("tagline", "")
                    section_count = len([v for v in sections.values() if v and v.strip()])
                    memo_summary = (
                        f"[Memo Generated] {req.company_name} ({req.company_ticker}) coverage memo "
                        f"(report_id={result['report_id']}). "
                        f"{section_count} sections, {result['evidence_count']} evidence chunks. "
                        f"Tagline: {tagline[:200]}. "
                        f"HTML: {html_url}"
                    )
                    # Add to in-memory chat history
                    session_manager.add_exchange(
                        f"生成 {req.company_name} ({req.company_ticker}) 覆盖 memo",
                        memo_summary,
                    )
                    # Persist to sessions.sqlite3
                    store = getattr(cs, "session_history_store", None)
                    if store is not None:
                        import asyncio as _aio
                        await _aio.to_thread(
                            store.append_turn,
                            req.session_id,
                            f"生成 {req.company_name} ({req.company_ticker}) 覆盖 memo",
                            None,
                            memo_summary,
                            ["memo_generation"],
                            False,
                        )
                        logger.info(f"[Memo] Wrote memo summary to session history ({req.session_id})")
                except Exception as e:
                    logger.warning(f"[Memo] Failed to write session history: {e}")

                await queue.put(final_event)
            except Exception as e:
                logger.error(f"Memo generation failed: {e}", exc_info=True)
                await queue.put({"type": "error", "detail": str(e)})
            finally:
                await queue.put(None)  # sentinel

        task = asyncio.create_task(run_generation())

        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        finally:
            if not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/report/{ticker}/{filename}")
async def serve_report_html(ticker: str, filename: str):
    """
    Serve a generated HTML report file.
    """
    # Sanitize inputs
    safe_ticker = os.path.basename(ticker)
    safe_filename = os.path.basename(filename)

    if not safe_filename.endswith(".html"):
        raise HTTPException(status_code=400, detail="Only HTML files are served")

    html_path = os.path.join(REPORTS_DIR, safe_ticker, safe_filename)
    html_path = os.path.realpath(html_path)

    # Prevent directory traversal
    expected_root = os.path.realpath(REPORTS_DIR)
    if not html_path.startswith(expected_root):
        raise HTTPException(status_code=400, detail="Invalid path")

    if not os.path.exists(html_path):
        raise HTTPException(status_code=404, detail=f"Report not found: {safe_filename}")

    # Read file directly to avoid FileResponse issues with non-ASCII filenames
    with open(html_path, "r", encoding="utf-8") as f:
        html_content = f.read()

    # Use ASCII-safe filename in Content-Disposition header
    ascii_filename = safe_filename.encode("ascii", "replace").decode("ascii")
    from fastapi.responses import HTMLResponse
    return HTMLResponse(
        content=html_content,
        headers={
            "Content-Disposition": f"inline; filename=\"{ascii_filename}\"",
            "X-Frame-Options": "SAMEORIGIN",
        },
    )


@router.get("/reports")
async def list_reports():
    """List all generated reports."""
    reports = []
    if not os.path.exists(REPORTS_DIR):
        return {"reports": []}

    for ticker_dir in sorted(os.listdir(REPORTS_DIR)):
        ticker_path = os.path.join(REPORTS_DIR, ticker_dir)
        if not os.path.isdir(ticker_path):
            continue
        for fname in sorted(os.listdir(ticker_path)):
            if fname.endswith(".json"):
                meta_path = os.path.join(ticker_path, fname)
                try:
                    with open(meta_path, "r", encoding="utf-8") as f:
                        meta = json.load(f)
                    html_fname = fname.replace(".json", ".html")
                    reports.append({
                        "report_id": meta.get("report_id", ""),
                        "company_name": meta.get("company_name", ""),
                        "company_ticker": meta.get("company_ticker", ""),
                        "created_at": meta.get("created_at", ""),
                        "html_url": f"/memo/report/{ticker_dir}/{html_fname}",
                        "evidence_count": meta.get("evidence_count", 0),
                        "evidence_sources": meta.get("evidence_sources", []),
                    })
                except Exception:
                    pass

    return {"reports": reports}


@router.get("/pdf/{ticker}/{filename}")
async def serve_report_pdf(ticker: str, filename: str):
    """
    Convert a generated HTML report to PDF and serve it.
    The filename should be the HTML report filename (with .html extension).
    """
    safe_ticker = os.path.basename(ticker)
    safe_filename = os.path.basename(filename)

    if not safe_filename.endswith(".html"):
        raise HTTPException(status_code=400, detail="Only HTML reports can be converted")

    html_path = os.path.join(REPORTS_DIR, safe_ticker, safe_filename)
    html_path = os.path.realpath(html_path)

    expected_root = os.path.realpath(REPORTS_DIR)
    if not html_path.startswith(expected_root):
        raise HTTPException(status_code=400, detail="Invalid path")

    if not os.path.exists(html_path):
        raise HTTPException(status_code=404, detail=f"Report not found: {safe_filename}")

    # Derive PDF path (replace .html with .pdf)
    pdf_filename = safe_filename.rsplit(".html", 1)[0] + ".pdf"
    pdf_path = html_path.rsplit(".html", 1)[0] + ".pdf"

    # Generate PDF if not cached or stale
    need_regen = (not os.path.exists(pdf_path)
                  or os.path.getmtime(pdf_path) < os.path.getmtime(html_path))
    if need_regen:
        try:
            from weasyprint import HTML, CSS
            # Read HTML and inject print-specific overrides
            with open(html_path, "r", encoding="utf-8") as _f:
                html_content = _f.read()

            # Remove external resource links that timeout in WeasyPrint
            import re as _re
            html_content = _re.sub(r'<script[^>]*cdn\.tailwindcss\.com[^>]*></script>', '', html_content)
            html_content = _re.sub(r'<link[^>]*fonts\.googleapis\.com[^>]*/>', '', html_content)

            # Use base_url so relative image paths resolve correctly
            base_url = f"file://{os.path.dirname(html_path)}/"
            HTML(string=html_content, base_url=base_url).write_pdf(pdf_path)
            logger.info(f"[Memo] PDF generated: {pdf_path}")
        except Exception as e:
            logger.error(f"[Memo] PDF generation failed: {e}")
            raise HTTPException(status_code=500, detail=f"PDF generation failed: {e}")

    # Read and serve PDF
    with open(pdf_path, "rb") as f:
        pdf_content = f.read()

    ascii_pdf_name = pdf_filename.encode("ascii", "replace").decode("ascii")
    return Response(
        content=pdf_content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"inline; filename=\"{ascii_pdf_name}\"",
            "X-Frame-Options": "SAMEORIGIN",
        },
    )


# ── Memo SQLite API routes ───────────────────────────────────────────────────
_MEMO_DB = os.path.join(REPO_ROOT, "memos.sqlite")


@router.get("/memos")
async def list_memos_route(company: Optional[str] = None, status: Optional[str] = None, limit: int = 50):
    """List memos from the SQLite database."""
    sys.path.insert(0, os.path.join(REPO_ROOT, "src"))
    from memo.memo_writer import list_memos
    memos = list_memos(_MEMO_DB, company_id=company, status=status, limit=limit)
    return {"memos": memos, "count": len(memos)}


@router.get("/memos/{memo_id}")
async def get_memo_route(memo_id: str):
    """Get a single memo with sections and citations."""
    sys.path.insert(0, os.path.join(REPO_ROOT, "src"))
    from memo.memo_writer import get_memo
    memo = get_memo(_MEMO_DB, memo_id)
    if not memo:
        raise HTTPException(status_code=404, detail=f"Memo not found: {memo_id}")
    return memo


@router.get("/memos/{memo_id}/markdown")
async def get_memo_markdown_route(memo_id: str):
    """Serve the markdown file for a memo."""
    sys.path.insert(0, os.path.join(REPO_ROOT, "src"))
    from memo.memo_writer import get_memo
    memo = get_memo(_MEMO_DB, memo_id)
    if not memo:
        raise HTTPException(status_code=404, detail=f"Memo not found: {memo_id}")

    md_dir = os.path.join(REPO_ROOT, "analyst_space", "markdown_memory", "memos")
    md_path = os.path.join(md_dir, f"{memo_id}.md")
    if not os.path.exists(md_path):
        raise HTTPException(status_code=404, detail=f"Markdown file not found: {memo_id}.md")

    with open(md_path, "r", encoding="utf-8") as f:
        content = f.read()
    return Response(
        content=content,
        media_type="text/markdown",
        headers={"Content-Disposition": f"inline; filename=\"{memo_id}.md\""},
    )


@router.get("/memory/search")
async def search_memory_route(q: str, company: Optional[str] = None, limit: int = 10):
    """Search memory_items for a query."""
    sys.path.insert(0, os.path.join(REPO_ROOT, "src"))
    from memo.memo_memory_writer import search_memory
    results = search_memory(_MEMO_DB, query=q, company_id=company, limit=limit)
    return {"results": results, "count": len(results)}


@router.get("/runs")
async def list_generation_runs_route(limit: int = 20):
    """List recent memo generation runs for audit."""
    import sqlite3
    if not os.path.exists(_MEMO_DB):
        return {"runs": []}
    conn = sqlite3.connect(_MEMO_DB)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM memo_generation_runs ORDER BY started_at DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    return {"runs": [dict(r) for r in rows], "count": len(rows)}
