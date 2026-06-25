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
from fastapi.responses import FileResponse, JSONResponse
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
@router.post("/generate", response_model=MemoGenerateResponse)
async def generate_memo(req: MemoGenerateRequest):
    """
    Generate a full equity research report.

    Uses FinSagent's RAG to retrieve evidence and LLM to generate text sections,
    then renders the final HTML using FinRobot's professional template.
    """
    cs = _get_chat_service()

    # Get RAG instance
    rag = getattr(cs, "rag", None)
    if rag is None:
        raise HTTPException(status_code=503, detail="RAG instance not available")

    # Get or create a session manager for LLM calls
    session_manager = cs.get_or_create_session(req.session_id)

    # Config
    config = getattr(cs, "config", {})

    # Import the report generator
    sys.path.insert(0, os.path.join(REPO_ROOT, "src"))
    from memo.report_generator import generate_report

    # Output directory
    output_dir = os.path.join(REPORTS_DIR, req.company_ticker)
    os.makedirs(output_dir, exist_ok=True)

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
        )

        html_filename = os.path.basename(result["html_path"])
        html_url = f"/memo/report/{req.company_ticker}/{html_filename}"

        return MemoGenerateResponse(
            report_id=result["report_id"],
            html_path=result["html_path"],
            html_url=html_url,
            sections=result["sections"],
            evidence_count=result["evidence_count"],
            evidence_sources=result["evidence_sources"],
        )
    except Exception as e:
        logger.error(f"Memo generation failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Report generation failed: {str(e)}")


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

    return FileResponse(
        html_path,
        media_type="text/html",
        headers={
            "Content-Disposition": f"inline; filename=\"{safe_filename}\"",
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
