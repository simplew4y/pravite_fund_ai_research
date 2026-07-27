"""Cascade — fast DCI fallback before RAG.

Three-step cascade:
  1. metric_facts SQL exact match (fastest)
  2. chunks LIKE grep (fast)
  3. RAG / Chroma semantic (slow, only if 1+2 fail)
"""
import logging
import os
import re
import sqlite3
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Bilingual keywords — matches both Chinese queries and English metric_facts
NUMERIC_KEYWORDS = {
    # Chinese
    "营收", "收入", "销售", "成本", "毛利", "毛利率", "净利", "净利率",
    "利润", "每股收益", "EPS", "PE", "PB", "ROE", "EBIT", "EBITDA",
    "现金流", "资产", "负债", "权益", "股本", "股息", "分红",
    "增长率", "增速", "同比", "环比", "价格", "销量", "产量",
    "费用", "研发", "所得税", "减值", "投资收益",
    "盈利", "亏损", "毛利率", "净利率", "利润率",  # Chinese substrings
    # English (metric_facts stores English names)
    "revenue", "sales", "cost", "profit", "gross", "margin", "income",
    "eps", "roe", "ebit", "ebitda", "cash", "debt", "asset",
    "operating", "expense", "tax", "net profit", "minority",
    "inventory", "receivable", "payable", "equity",
}


def _extract_money_keywords(text: str) -> List[str]:
    """Extract finance-specific keywords from query text (bilingual)."""
    found = []
    text_lower = text.lower()
    for kw in NUMERIC_KEYWORDS:
        if kw.lower() in text_lower:
            found.append(kw)
    return found


def _extract_all_keywords(text: str) -> List[str]:
    """Extract all meaningful search terms from query.
    
    Handles Chinese text: individual CJK characters become search terms,
    English words are kept whole.
    """
    import unicodedata
    words = set()
    # Split by spaces first
    parts = text.split()
    for part in parts:
        # Check if this part is mostly CJK
        cjk_count = sum(1 for ch in part if unicodedata.category(ch).startswith("Lo"))
        if cjk_count >= 2:
            # CJK-heavy: extract individual characters >= 2 chars
            for ch in part:
                if unicodedata.category(ch).startswith("Lo"):
                    words.add(ch)
        else:
            # Latin/ASCII: keep whole words
            cleaned = re.sub(r"[^\w]", "", part)
            if len(cleaned) > 1:
                words.add(cleaned)
    return [w for w in words if w]


class CascadeRetriever:
    """Per-sub-query cascade: DCI metric → DCI grep → RAG."""

    def __init__(self, collection_db: str = ""):
        self._db_path = collection_db
        self._conn: Optional[sqlite3.Connection] = None

    def _ensure_db(self):
        if self._conn is not None:
            return
        if self._db_path and os.path.exists(self._db_path):
            self._conn = sqlite3.connect(self._db_path)
            self._conn.row_factory = sqlite3.Row
        else:
            self._conn = None

    def close(self):
        if self._conn:
            self._conn.close()
            self._conn = None

    def search_metric(self, query: str) -> Optional[Dict[str, Any]]:
        """Step 1 — metric_facts by metric_name (bilingual keyword match).

        Searches the metric_facts table for rows whose metric_name contains
        any of the finance keywords (Chinese or English) found in the query.
        """
        self._ensure_db()
        if self._conn is None:
            return None

        # Only attempt metric_facts search for queries that ask for numbers
        keywords = _extract_money_keywords(query)
        if not keywords:
            return None

        # Verify metric_facts table exists
        try:
            cols = [r["name"] for r in self._conn.execute("PRAGMA table_info(metric_facts)").fetchall()]
            if not cols:
                return None
        except Exception:
            return None

        metric_col = "metric_name"
        value_col = "value_numeric"
        text_col = "value_text"
        unit_col = "unit"

        for keyword in keywords:
            try:
                rows = self._conn.execute(
                    f"SELECT {metric_col}, {value_col}, {text_col}, {unit_col} "
                    f"FROM metric_facts WHERE LOWER({metric_col}) LIKE ? "
                    f"ORDER BY rowid LIMIT 5",
                    (f"%{keyword.lower()}%",),
                ).fetchall()
            except Exception:
                continue

            if rows:
                return {
                    "type": "dci_metric",
                    "query": query,
                    "chunks": self._metric_rows_to_chunks(rows, metric_col, value_col, text_col, unit_col),
                    "final_chunks": True,
                    "pre_rerank_chunks": [],
                    "time_info": [],
                }

        return None

    def search_keyword(self, query: str) -> Optional[Dict[str, Any]]:
        """Step 2 — chunks LIKE grep (OR logic, any keyword match).

        Returns evidence if at least one keyword matches ≤3 chunks at high
        relevance, skipping RAG when grep is sufficient.
        """
        self._ensure_db()
        if self._conn is None:
            return None

        # Get all meaningful keyword candidates from the query
        money_kws = _extract_money_keywords(query)
        all_kws = _extract_all_keywords(query)
        # Prioritize domain keywords; fall back to general words if none
        candidates = money_kws if money_kws else all_kws[:5]
        if not candidates:
            return None

        # Try OR logic: match any keyword (more practical than AND)
        try:
            sql = "SELECT content, content_type, source_ref FROM chunks WHERE "
            sql += " OR ".join(["content LIKE ?" for _ in candidates])
            sql += " LIMIT 15"
            params = [f"%{k}%" for k in candidates]
            rows = self._conn.execute(sql, params).fetchall()
        except Exception:
            return None

        if not rows:
            return None

        chunks = []
        seen = set()
        for r in rows:
            c = dict(r)
            content_preview = (c.get("content") or "")[:60]
            key = content_preview
            if key in seen:
                continue
            seen.add(key)
            chunks.append({
                "page_content": c.get("content", ""),
                "metadata": {
                    "content_type": c.get("content_type", ""),
                    "source_ref": c.get("source_ref", ""),
                },
            })
            if len(chunks) >= 10:
                break

        return {
            "type": "dci_keyword",
            "query": query,
            "chunks": chunks,
            "final_chunks": True,
            "pre_rerank_chunks": [],
            "time_info": [],
        }

    def _metric_rows_to_chunks(
        self, rows, metric_col: str, value_col: str, text_col: str, unit_col: Optional[str]
    ) -> List[Dict[str, Any]]:
        chunks = []
        for r in rows:
            d = dict(r)
            metric = d.get(metric_col, "")
            value_num = d.get(value_col)
            value_text = d.get(text_col, "")
            unit = d.get(unit_col) if unit_col else ""
            # Prefer non-null numerical value; fallback to text
            if value_num is not None:
                value = f"{value_num:.2f}" if isinstance(value_num, (int, float)) else str(value_num)
            else:
                value = str(value_text) if value_text else "?"
            text = f"{metric}: {value} {unit}".strip()
            chunks.append({
                "page_content": text,
                "metadata": {
                    "content_type": "metric_fact",
                    "metric_name": metric,
                    "value": value,
                    "unit": str(unit),
                },
            })
        return chunks


def should_skip_rag(cascade_result: Optional[Dict[str, Any]], agent: str) -> bool:
    """Decide whether DCI result is good enough to bypass RAG."""
    if cascade_result is None:
        return False

    # metric_facts exact match → always skip
    if cascade_result.get("type") == "dci_metric":
        return True

    # keyword grep: ≤3 chunks → skip for everyone
    chunks = cascade_result.get("chunks", [])
    if len(chunks) <= 3:
        return True

    # For quant agent, even moderate results can skip
    if agent == "quant" and len(chunks) <= 8:
        return True

    return False
