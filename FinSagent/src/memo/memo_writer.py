#!/usr/bin/env python
# coding: utf-8
"""
Memo Writer — persists memo drafts, sections, citations, and generation runs
into the memos.sqlite database.

Tables:
  memo_drafts          — one row per memo
  memo_sections        — one row per section (company_overview, financials, …)
  citations            — one row per citation linking a section to evidence
  memo_generation_runs — audit trail for each generation run
"""
from __future__ import annotations

import json
import sqlite3
import uuid
import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Default DB path (relative to FinSagent repo root)
_REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB_PATH = str(_REPO_ROOT / "memos.sqlite")


# ── Section type mapping ────────────────────────────────────────────────────
# Maps the section keys used in report_generator to the design-doc section types
_SECTION_TYPE_MAP = {
    "tagline": "overview",
    "company_overview": "overview",
    "investment_overview": "thesis",
    "valuation_overview": "valuation",
    "risks": "risks",
    "competitor_analysis": "recent_changes",
    "major_takeaways": "financials",
    "news_summary": "recent_changes",
}

# Sections that require citations per the design doc
_CITATION_REQUIRED_SECTIONS = {"thesis", "financials", "valuation", "risks", "catalysts"}


def _now_iso() -> str:
    return datetime.now().isoformat()


def _connect(db_path: str = DEFAULT_DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def init_db(db_path: str = DEFAULT_DB_PATH) -> None:
    """Create tables if they don't exist."""
    conn = _connect(db_path)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS memo_drafts (
            memo_id        TEXT PRIMARY KEY,
            project_id     TEXT NOT NULL DEFAULT 'default',
            analyst_id     TEXT NOT NULL DEFAULT 'ai_analyst',
            company_id     TEXT NOT NULL DEFAULT '',
            title          TEXT NOT NULL DEFAULT '',
            memo_type      TEXT NOT NULL DEFAULT 'coverage',
            status         TEXT NOT NULL DEFAULT 'draft',
            created_from   TEXT NOT NULL DEFAULT 'user_request',
            created_at     TEXT NOT NULL,
            updated_at     TEXT NOT NULL,
            metadata_json  TEXT DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS memo_sections (
            section_id     TEXT PRIMARY KEY,
            memo_id        TEXT NOT NULL,
            section_type   TEXT NOT NULL,
            title          TEXT NOT NULL DEFAULT '',
            content        TEXT NOT NULL DEFAULT '',
            sort_order     INTEGER NOT NULL DEFAULT 0,
            needs_review   INTEGER NOT NULL DEFAULT 0,
            review_notes   TEXT DEFAULT '',
            created_at     TEXT NOT NULL,
            updated_at     TEXT NOT NULL,
            metadata_json  TEXT DEFAULT '{}',
            FOREIGN KEY (memo_id) REFERENCES memo_drafts(memo_id)
        );
        CREATE TABLE IF NOT EXISTS citations (
            citation_id    TEXT PRIMARY KEY,
            source_type    TEXT NOT NULL DEFAULT 'memo_section',
            source_id      TEXT NOT NULL,
            evidence_id    TEXT DEFAULT '',
            doc_id         TEXT DEFAULT '',
            claim          TEXT DEFAULT '',
            quote          TEXT DEFAULT '',
            reason         TEXT DEFAULT '',
            display        TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS memo_generation_runs (
            run_id              TEXT PRIMARY KEY,
            memo_id             TEXT DEFAULT '',
            project_id          TEXT NOT NULL DEFAULT 'default',
            analyst_id          TEXT NOT NULL DEFAULT 'ai_analyst',
            user_instruction    TEXT DEFAULT '',
            evidence_pack_json  TEXT DEFAULT '{}',
            section_plan_json   TEXT DEFAULT '[]',
            generated_sections  TEXT DEFAULT '[]',
            unsupported_claims  TEXT DEFAULT '[]',
            status              TEXT NOT NULL DEFAULT 'started',
            error               TEXT DEFAULT '',
            started_at          TEXT NOT NULL,
            finished_at         TEXT DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_sections_memo ON memo_sections(memo_id);
        CREATE INDEX IF NOT EXISTS idx_citations_source ON citations(source_id);
        CREATE INDEX IF NOT EXISTS idx_runs_memo ON memo_generation_runs(memo_id);
    """)
    conn.commit()
    conn.close()
    logger.info(f"[MemoWriter] DB initialized at {db_path}")


def create_generation_run(
    db_path: str,
    project_id: str = "default",
    analyst_id: str = "ai_analyst",
    user_instruction: str = "",
    evidence_pack: Optional[Dict] = None,
    section_plan: Optional[List] = None,
) -> str:
    """Create a memo_generation_run record and return the run_id."""
    run_id = f"run_{uuid.uuid4().hex[:12]}"
    conn = _connect(db_path)
    conn.execute(
        """INSERT INTO memo_generation_runs
           (run_id, memo_id, project_id, analyst_id, user_instruction,
            evidence_pack_json, section_plan_json, generated_sections,
            unsupported_claims, status, error, started_at, finished_at)
           VALUES (?, '', ?, ?, ?, ?, ?, '[]', '[]', 'started', '', ?, '')""",
        (run_id, project_id, analyst_id, user_instruction,
         json.dumps(evidence_pack or {}, ensure_ascii=False),
         json.dumps(section_plan or [], ensure_ascii=False),
         _now_iso()),
    )
    conn.commit()
    conn.close()
    logger.info(f"[MemoWriter] Created generation run {run_id}")
    return run_id


def finish_generation_run(
    db_path: str,
    run_id: str,
    memo_id: str,
    generated_sections: List[Dict],
    unsupported_claims: List[Dict],
    status: str = "completed",
    error: str = "",
) -> None:
    """Update a generation run with results."""
    conn = _connect(db_path)
    conn.execute(
        """UPDATE memo_generation_runs
           SET memo_id = ?, generated_sections = ?, unsupported_claims = ?,
               status = ?, error = ?, finished_at = ?
           WHERE run_id = ?""",
        (memo_id,
         json.dumps(generated_sections, ensure_ascii=False),
         json.dumps(unsupported_claims, ensure_ascii=False),
         status, error, _now_iso(), run_id),
    )
    conn.commit()
    conn.close()


def write_memo(
    db_path: str,
    company_name: str,
    company_ticker: str,
    report_id: str,
    sections: Dict[str, str],
    section_sources: Dict[str, List[Dict[str, Any]]],
    financial_statements: Optional[Dict] = None,
    catalyst_analysis: Optional[Dict] = None,
    sensitivity_analysis: Optional[Dict] = None,
    peer_comparison: Optional[Dict] = None,
    key_metrics: Optional[Dict] = None,
    evidence_sources: Optional[List[str]] = None,
    token_usage: Optional[List] = None,
    html_path: str = "",
    meta_path: str = "",
    project_id: str = "default",
    analyst_id: str = "ai_analyst",
    memo_type: str = "coverage",
    created_from: str = "user_request",
) -> Tuple[str, List[str]]:
    """Write a complete memo to the database.

    Returns (memo_id, list_of_section_ids).
    """
    memo_id = f"memo_{report_id}"
    now = _now_iso()
    section_ids: List[str] = []

    # Build metadata
    metadata = {
        "html_path": html_path,
        "meta_path": meta_path,
        "financial_statements": financial_statements or {},
        "catalyst_analysis": catalyst_analysis or {},
        "sensitivity_analysis": sensitivity_analysis or {},
        "peer_comparison": peer_comparison or {},
        "key_metrics": key_metrics or {},
        "evidence_sources": evidence_sources or [],
        "token_usage": token_usage or [],
    }

    conn = _connect(db_path)

    # 1. Write memo_drafts
    conn.execute(
        """INSERT OR REPLACE INTO memo_drafts
           (memo_id, project_id, analyst_id, company_id, title,
            memo_type, status, created_from, created_at, updated_at, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)""",
        (memo_id, project_id, analyst_id, company_ticker,
         f"{company_name} ({company_ticker}) Coverage Memo",
         memo_type, created_from, now, now,
         json.dumps(metadata, ensure_ascii=False)),
    )

    # 2. Write memo_sections + citations
    # Define section order matching the design doc template
    section_order = [
        ("tagline", "Tagline", "overview"),
        ("company_overview", "公司概况", "overview"),
        ("investment_overview", "核心观点", "thesis"),
        ("major_takeaways", "财务表现", "financials"),
        ("valuation_overview", "估值假设摘要", "valuation"),
        ("risks", "风险", "risks"),
        ("news_summary", "近期动态", "recent_changes"),
        ("competitor_analysis", "竞争格局", "recent_changes"),
    ]

    # Add structured data sections
    structured_sections = []
    if catalyst_analysis and catalyst_analysis.get("top_catalysts"):
        structured_sections.append(("catalysts", "催化剂", "catalysts", catalyst_analysis))
    if sensitivity_analysis and sensitivity_analysis.get("summary"):
        structured_sections.append(("sensitivity", "敏感度分析", "thesis", sensitivity_analysis))

    sort_idx = 0
    for key, title, sec_type in section_order:
        content = sections.get(key, "")
        if not content.strip():
            continue
        section_id = f"sec_{report_id}_{key}"
        section_ids.append(section_id)

        # Check if section has citations
        sources = section_sources.get(key, [])
        has_citations = len(sources) > 0
        needs_review = 0 if has_citations or sec_type not in _CITATION_REQUIRED_SECTIONS else 1
        review_notes = "" if not needs_review else "No citations found for this section."

        sec_meta = {"source_count": len(sources)}

        conn.execute(
            """INSERT OR REPLACE INTO memo_sections
               (section_id, memo_id, section_type, title, content,
                sort_order, needs_review, review_notes,
                created_at, updated_at, metadata_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (section_id, memo_id, sec_type, title, content,
             sort_idx, needs_review, review_notes, now, now,
             json.dumps(sec_meta, ensure_ascii=False)),
        )

        # Write citations for this section
        for src in sources:
            citation_id = f"cit_{uuid.uuid4().hex[:10]}"
            src_idx = src.get("index", "")
            src_file = src.get("source", "unknown")
            src_page = src.get("page", "")
            src_snippet = src.get("snippet", "")
            display = f"{Path(src_file).name}"
            if src_page:
                display += f", p.{src_page}"

            conn.execute(
                """INSERT OR REPLACE INTO citations
                   (citation_id, source_type, source_id, evidence_id,
                    doc_id, claim, quote, reason, display)
                   VALUES (?, 'memo_section', ?, ?, ?, ?, ?, ?, ?)""",
                (citation_id, section_id, str(src_idx),
                 src_file, src_snippet[:200], "", "",
                 display),
            )

        sort_idx += 1

    # Write structured data sections (catalysts, sensitivity)
    for key, title, sec_type, data in structured_sections:
        section_id = f"sec_{report_id}_{key}"
        section_ids.append(section_id)
        content = json.dumps(data, ensure_ascii=False, indent=2)

        conn.execute(
            """INSERT OR REPLACE INTO memo_sections
               (section_id, memo_id, section_type, title, content,
                sort_order, needs_review, review_notes,
                created_at, updated_at, metadata_json)
               VALUES (?, ?, ?, ?, ?, ?, 0, '', ?, ?, ?)""",
            (section_id, memo_id, sec_type, title, content,
             sort_idx, now, now, "{}"),
        )

        # Write citations from structured data
        if key == "catalysts":
            for cat in data.get("top_catalysts", []):
                cit_num = cat.get("citation", 0)
                if cit_num and str(cit_num).isdigit() and int(cit_num) > 0:
                    citation_id = f"cit_{uuid.uuid4().hex[:10]}"
                    src_file = ""
                    if cit_num <= len(evidence_sources or []):
                        src_file = evidence_sources[cit_num - 1]
                    display = f"{Path(src_file).name}" if src_file else f"Evidence [{cit_num}]"
                    conn.execute(
                        """INSERT OR REPLACE INTO citations
                           (citation_id, source_type, source_id, evidence_id,
                            doc_id, claim, quote, reason, display)
                           VALUES (?, 'memo_section', ?, ?, ?, ?, ?, ?, ?)""",
                        (citation_id, section_id, str(cit_num),
                         src_file, cat.get("description", "")[:200], "",
                         f"Catalyst: {cat.get('event_type', '')}",
                         display),
                    )
        sort_idx += 1

    # Add a sources section
    if evidence_sources:
        section_id = f"sec_{report_id}_sources"
        section_ids.append(section_id)
        sources_content = "\n".join(f"[{i+1}] {s}" for i, s in enumerate(evidence_sources))
        conn.execute(
            """INSERT OR REPLACE INTO memo_sections
               (section_id, memo_id, section_type, title, content,
                sort_order, needs_review, review_notes,
                created_at, updated_at, metadata_json)
               VALUES (?, ?, 'sources', '引用来源', ?, ?, 0, '', ?, ?, ?)""",
            (section_id, memo_id, sources_content, sort_idx, now, now, "{}"),
        )

    conn.commit()
    conn.close()

    logger.info(f"[MemoWriter] Wrote memo {memo_id} with {len(section_ids)} sections")
    return memo_id, section_ids


def get_memo(db_path: str, memo_id: str) -> Optional[Dict[str, Any]]:
    """Retrieve a memo with its sections and citations."""
    conn = _connect(db_path)
    memo = conn.execute(
        "SELECT * FROM memo_drafts WHERE memo_id = ?", (memo_id,)
    ).fetchone()
    if not memo:
        conn.close()
        return None

    sections = conn.execute(
        "SELECT * FROM memo_sections WHERE memo_id = ? ORDER BY sort_order", (memo_id,)
    ).fetchall()

    result = {
        "memo": dict(memo),
        "sections": [],
    }
    for sec in sections:
        sec_dict = dict(sec)
        citations = conn.execute(
            "SELECT * FROM citations WHERE source_id = ?", (sec["section_id"],)
        ).fetchall()
        sec_dict["citations"] = [dict(c) for c in citations]
        result["sections"].append(sec_dict)

    conn.close()
    return result


def list_memos(
    db_path: str,
    company_id: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 50,
) -> List[Dict[str, Any]]:
    """List memos, optionally filtered by company or status."""
    conn = _connect(db_path)
    query = "SELECT * FROM memo_drafts"
    params: List = []
    conditions = []
    if company_id:
        conditions.append("company_id = ?")
        params.append(company_id)
    if status:
        conditions.append("status = ?")
        params.append(status)
    if conditions:
        query += " WHERE " + " AND ".join(conditions)
    query += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]
