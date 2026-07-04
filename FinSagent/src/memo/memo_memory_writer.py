#!/usr/bin/env python
# coding: utf-8
"""
Memo Memory Writer — registers a generated memo as a memory_item so that
future queries can recall past memos.

Creates a `memory_items` table in memos.sqlite if it doesn't exist.
"""
from __future__ import annotations

import json
import sqlite3
import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB_PATH = str(_REPO_ROOT / "memos.sqlite")


def _now_iso() -> str:
    return datetime.now().isoformat()


def _connect(db_path: str = DEFAULT_DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def init_memory_table(db_path: str = DEFAULT_DB_PATH) -> None:
    """Create the memory_items table if it doesn't exist."""
    conn = _connect(db_path)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS memory_items (
            memory_id      TEXT PRIMARY KEY,
            memory_type    TEXT NOT NULL,
            project_id     TEXT NOT NULL DEFAULT 'default',
            analyst_id     TEXT NOT NULL DEFAULT 'ai_analyst',
            company_id     TEXT NOT NULL DEFAULT '',
            ref_id         TEXT DEFAULT '',
            title          TEXT NOT NULL DEFAULT '',
            content        TEXT NOT NULL DEFAULT '',
            tags           TEXT DEFAULT '[]',
            metadata_json  TEXT DEFAULT '{}',
            created_at     TEXT NOT NULL,
            updated_at     TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_company ON memory_items(company_id);
        CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_items(memory_type);
        CREATE INDEX IF NOT EXISTS idx_memory_ref ON memory_items(ref_id);
    """)
    conn.commit()
    conn.close()
    logger.info(f"[MemoMemoryWriter] memory_items table ready at {db_path}")


def register_memo_as_memory(
    db_path: str,
    memo_id: str,
    company_name: str,
    company_ticker: str,
    sections: Dict[str, str],
    markdown_path: str = "",
    html_path: str = "",
    project_id: str = "default",
    analyst_id: str = "ai_analyst",
) -> str:
    """Register a memo as a memory_item.

    Returns the memory_id.
    """
    init_memory_table(db_path)

    memory_id = f"mem_{memo_id}"
    now = _now_iso()

    # Build a searchable content summary from section text
    content_parts = []
    for key in ("tagline", "company_overview", "investment_overview",
                "major_takeaways", "valuation_overview", "risks",
                "news_summary", "competitor_analysis"):
        text = sections.get(key, "")
        if text.strip():
            content_parts.append(f"[{key}] {text[:500]}")
    content = "\n".join(content_parts)

    tags = json.dumps([company_ticker, "memo", "coverage"], ensure_ascii=False)
    metadata = json.dumps({
        "markdown_path": markdown_path,
        "html_path": html_path,
        "section_count": len([v for v in sections.values() if v.strip()]),
    }, ensure_ascii=False)

    conn = _connect(db_path)
    conn.execute(
        """INSERT OR REPLACE INTO memory_items
           (memory_id, memory_type, project_id, analyst_id, company_id,
            ref_id, title, content, tags, metadata_json,
            created_at, updated_at)
           VALUES (?, 'memo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (memory_id, project_id, analyst_id, company_ticker,
         memo_id,
         f"{company_name} ({company_ticker}) Coverage Memo",
         content, tags, metadata, now, now),
    )
    conn.commit()
    conn.close()

    logger.info(f"[MemoMemoryWriter] Registered memo {memo_id} as memory {memory_id}")
    return memory_id


def search_memory(
    db_path: str,
    query: str,
    company_id: Optional[str] = None,
    memory_type: Optional[str] = None,
    limit: int = 10,
) -> List[Dict[str, Any]]:
    """Simple text search over memory_items content."""
    conn = _connect(db_path)
    conditions = ["content LIKE ?"]
    params: List = [f"%{query}%"]
    if company_id:
        conditions.append("company_id = ?")
        params.append(company_id)
    if memory_type:
        conditions.append("memory_type = ?")
        params.append(memory_type)
    query_sql = (
        "SELECT * FROM memory_items WHERE "
        + " AND ".join(conditions)
        + " ORDER BY created_at DESC LIMIT ?"
    )
    params.append(limit)
    rows = conn.execute(query_sql, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]
