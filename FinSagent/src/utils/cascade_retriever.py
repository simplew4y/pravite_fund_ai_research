"""Dataset- and company-scoped DCI retrieval before semantic RAG."""
from __future__ import annotations

import logging
import os
import re
import sqlite3
import unicodedata
from contextlib import contextmanager
from typing import Any, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

NUMERIC_KEYWORDS = {
    "营收", "收入", "销售", "成本", "毛利", "毛利率", "净利", "净利润", "归母净利润",
    "净利率", "利润", "每股收益", "eps", "pe", "pb", "roe", "ebit", "ebitda",
    "现金流", "资产", "负债", "权益", "股本", "股息", "分红", "增长率", "增速",
    "同比", "环比", "价格", "销量", "产量", "费用", "研发", "所得税", "减值",
    "投资收益", "盈利", "亏损", "利润率", "revenue", "sales", "cost", "profit",
    "gross", "margin", "income", "cash", "debt", "asset", "operating", "expense",
    "tax", "net profit", "net income", "minority", "inventory", "receivable", "payable",
    "equity",
}

METRIC_EXPANSIONS = {
    "归母净利润": ("归母净利润", "net profit", "net income", "attributable", "profit attributable"),
    "净利润": ("净利润", "net profit", "net income"),
    "毛利率": ("毛利率", "gross margin"),
    "毛利": ("毛利", "gross profit"),
    "营收": ("营收", "收入", "revenue", "sales"),
    "收入": ("收入", "营收", "revenue", "sales"),
    "每股收益": ("每股收益", "eps", "earnings per share"),
    "现金流": ("现金流", "cash flow"),
    "研发": ("研发", "research and development", "r&d"),
}

QUALIFIER_GROUPS = {
    "剔除": ("剔除", "excluding", "exclude", "adjusted", "ex-"),
    "阶段性": ("阶段性", "temporary", "one-off", "non-recurring", "nonrecurring"),
    "实际": ("实际", "actual", "underlying", "normalized"),
    "调整后": ("调整后", "adjusted", "underlying", "normalized"),
    "储能": ("储能", "energy storage", "ess"),
    "光伏": ("光伏", "photovoltaic", "pv", "solar"),
    "海外": ("海外", "overseas", "international"),
    "中国": ("中国", "china", "domestic"),
}

_GENERIC_WORDS = {
    "公司", "集团", "股份", "有限公司", "inc", "corp", "corporation", "company", "group",
    "ag", "plc", "ltd", "limited", "holdings", "holding",
}


def _normalize(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", text)


def _extract_money_keywords(text: str) -> List[str]:
    lowered = text.casefold()
    return sorted({kw for kw in NUMERIC_KEYWORDS if kw.casefold() in lowered}, key=len, reverse=True)


def _metric_terms(query: str) -> List[str]:
    terms: List[str] = []
    lowered = query.casefold()
    for trigger, expansions in METRIC_EXPANSIONS.items():
        if trigger.casefold() in lowered:
            terms.extend(expansions)
    terms.extend(_extract_money_keywords(query))
    return list(dict.fromkeys(t.casefold() for t in terms if t))


def _extract_periods(query: str) -> List[str]:
    periods = re.findall(r"(?:19|20)\d{2}(?:\s*(?:年)?\s*(?:q[1-4]|[一二三四1-4]季度|上半年|下半年|全年))?", query, re.I)
    return [re.sub(r"\s+", "", p).casefold() for p in periods]


def _qualifiers_match(query: str, metric_names: Sequence[str]) -> bool:
    joined = " ".join(str(name or "") for name in metric_names).casefold()
    for trigger, aliases in QUALIFIER_GROUPS.items():
        if trigger in query and not any(alias.casefold() in joined for alias in aliases):
            return False
    return True


def _keyword_terms(query: str) -> List[str]:
    terms = _metric_terms(query)
    terms.extend(re.findall(r"[a-zA-Z][a-zA-Z0-9.&_-]{1,}", query))
    terms.extend(re.findall(r"[\u4e00-\u9fff]{2,}", query))
    stop = {"多少", "是什么", "怎么样", "请问", "数据", "情况", "实际", "后的"}
    return list(dict.fromkeys(t for t in terms if _normalize(t) and t not in stop))[:12]


class CascadeRetriever:
    """DCI retriever whose every query is bounded to the active dataset DB."""

    def __init__(self, collection_db: str = "", company_aliases: Optional[Dict[str, Sequence[str]]] = None):
        self._db_path = collection_db
        self._company_aliases = company_aliases or {}

    @contextmanager
    def _connection(self) -> Iterator[Optional[sqlite3.Connection]]:
        if not self._db_path or not os.path.exists(self._db_path):
            yield None
            return
        conn = sqlite3.connect(self._db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def close(self) -> None:
        """Kept for compatibility; connections are request-scoped."""

    @staticmethod
    def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
        try:
            return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        except sqlite3.Error:
            return set()

    def _document_aliases(self, row: Dict[str, Any]) -> set[str]:
        values = {
            row.get("company_name"), row.get("company_ticker"), row.get("ticker"),
            row.get("original_filename"), row.get("filename"), row.get("source_name"),
            row.get("source_file"), row.get("title"),
        }
        canonical = _normalize(row.get("company_name"))
        identity_values = {
            canonical,
            _normalize(row.get("company_ticker") or row.get("ticker")),
            _normalize(row.get("original_filename") or row.get("filename")),
            _normalize(row.get("source_name")),
        }
        for key, aliases in self._company_aliases.items():
            normalized_key = _normalize(key)
            if any(normalized_key == value or normalized_key in value for value in identity_values if value):
                values.update(aliases or [])
        result = set()
        for value in values:
            if not value:
                continue
            result.add(_normalize(value))
            stem = os.path.splitext(os.path.basename(str(value)))[0]
            result.add(_normalize(stem))
            result.update(_normalize(token) for token in re.findall(r"[\w\u4e00-\u9fff]+", stem))
        return {v for v in result if len(v) >= 2 and v not in _GENERIC_WORDS}

    def resolve_query_doc_ids(self, query: str) -> Tuple[List[str], bool]:
        """Return matching source document IDs and whether company scope was explicit."""
        with self._connection() as conn:
            if conn is None or not self._columns(conn, "documents"):
                return [], False
            rows = [dict(r) for r in conn.execute("SELECT * FROM documents").fetchall()]
        query_norm = _normalize(query)
        matched: List[str] = []
        all_ids: List[str] = []
        for row in rows:
            doc_id = str(row.get("doc_id") or "")
            if not doc_id:
                continue
            all_ids.append(doc_id)
            aliases = self._document_aliases(row)
            if any(alias and alias in query_norm for alias in aliases):
                matched.append(doc_id)
        return (list(dict.fromkeys(matched)), True) if matched else (list(dict.fromkeys(all_ids)), False)

    @staticmethod
    def _scope_clause(doc_ids: Sequence[str], column: str = "doc_id") -> Tuple[str, List[str]]:
        clean = [str(x) for x in doc_ids if x]
        if not clean:
            return "1 = 0", []
        return f"{column} IN ({','.join('?' for _ in clean)})", clean

    def search_metric(self, query: str, allowed_doc_ids: Optional[Sequence[str]] = None) -> Optional[Dict[str, Any]]:
        terms = _metric_terms(query)
        if not terms:
            return None
        resolved_ids, explicit_company = self.resolve_query_doc_ids(query)
        doc_ids = list(allowed_doc_ids) if allowed_doc_ids is not None else resolved_ids
        periods = _extract_periods(query)
        with self._connection() as conn:
            if conn is None:
                return None
            cols = self._columns(conn, "metric_facts")
            if "metric_name" not in cols or "doc_id" not in cols:
                return None
            selected = [c for c in ("metric_name", "value_numeric", "value_text", "unit", "doc_id", "period", "sheet_name", "cell_ref", "confidence", "quality_flag") if c in cols]
            scope_sql, params = self._scope_clause(doc_ids)
            term_sql = " OR ".join("LOWER(metric_name) LIKE ?" for _ in terms)
            params.extend(f"%{term}%" for term in terms)
            sql = f"SELECT {', '.join(selected)} FROM metric_facts WHERE {scope_sql} AND ({term_sql})"
            if "period" in cols and periods:
                sql += " AND (" + " OR ".join("LOWER(COALESCE(period,'')) LIKE ?" for _ in periods) + ") ORDER BY rowid"
                params.extend(f"%{p[:4]}%" for p in periods)
            else:
                sql += " ORDER BY rowid"
            rows = conn.execute(sql + " LIMIT 12", params).fetchall()
        if not rows:
            return None
        row_dicts = [dict(r) for r in rows]
        period_match = not periods or any(any(p[:4] in str(r.get("period") or "").casefold() for p in periods) for r in row_dicts)
        source_ids = {str(r.get("doc_id") or "") for r in row_dicts}
        metric_names = [str(r.get("metric_name") or "") for r in row_dicts]
        unique_metric_names = {_normalize(name) for name in metric_names if name}
        returned_periods = {_normalize(r.get("period")) for r in row_dicts if r.get("period")}
        period_unambiguous = bool(periods) or len(returned_periods) <= 1
        high_confidence = (
            explicit_company and period_match and period_unambiguous
            and len(source_ids) == 1 and len(unique_metric_names) == 1
            and _qualifiers_match(query, metric_names)
        )
        return {
            "type": "dci_metric", "query": query,
            "chunks": self._metric_rows_to_chunks(row_dicts),
            "matched_metric_names": metric_names,
            "scope_explicit": explicit_company, "period_match": period_match,
            "high_confidence": high_confidence, "source_doc_ids": sorted(source_ids),
            "final_chunks": True, "pre_rerank_chunks": [], "time_info": [],
        }

    def search_keyword(self, query: str, allowed_doc_ids: Optional[Sequence[str]] = None) -> Optional[Dict[str, Any]]:
        candidates = _keyword_terms(query)
        if not candidates:
            return None
        resolved_ids, explicit_company = self.resolve_query_doc_ids(query)
        doc_ids = list(allowed_doc_ids) if allowed_doc_ids is not None else resolved_ids
        with self._connection() as conn:
            if conn is None:
                return None
            cols = self._columns(conn, "chunks")
            if "content" not in cols or "doc_id" not in cols:
                return None
            selected = [c for c in ("chunk_id", "doc_id", "content", "content_type", "source_ref", "chunk_index") if c in cols]
            scope_sql, params = self._scope_clause(doc_ids)
            match_sql = " OR ".join("LOWER(content) LIKE ?" for _ in candidates)
            params.extend(f"%{term.casefold()}%" for term in candidates)
            rows = conn.execute(
                f"SELECT {', '.join(selected)} FROM chunks WHERE {scope_sql} AND ({match_sql}) LIMIT 80",
                params,
            ).fetchall()
        scored = []
        for raw in rows:
            row = dict(raw)
            content_lower = str(row.get("content") or "").casefold()
            score = sum(1 for term in candidates if term.casefold() in content_lower)
            scored.append((score, row))
        scored.sort(key=lambda item: (-item[0], int(item[1].get("chunk_index") or 0)))
        chunks = []
        seen = set()
        for score, row in scored:
            chunk_id = row.get("chunk_id") or (row.get("content") or "")[:120]
            if chunk_id in seen:
                continue
            seen.add(chunk_id)
            chunks.append({
                "page_content": row.get("content", ""), "score": float(score),
                "metadata": {
                    "chunk_id": row.get("chunk_id", ""), "source_doc_id": row.get("doc_id", ""),
                    "content_type": row.get("content_type", ""), "source_ref": row.get("source_ref", ""),
                },
            })
            if len(chunks) >= 10:
                break
        if not chunks:
            return None
        return {
            "type": "dci_keyword", "query": query, "chunks": chunks,
            "scope_explicit": explicit_company, "source_doc_ids": sorted({c["metadata"]["source_doc_id"] for c in chunks}),
            "high_confidence": explicit_company and len(chunks) <= 3,
            "final_chunks": True, "pre_rerank_chunks": [], "time_info": [],
        }

    @staticmethod
    def _metric_rows_to_chunks(rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
        chunks = []
        for row in rows:
            value_num = row.get("value_numeric")
            value = str(value_num) if value_num is not None else str(row.get("value_text") or "?")
            period = str(row.get("period") or "")
            metric = str(row.get("metric_name") or "")
            text = " ".join(x for x in (period, f"{metric}: {value}", str(row.get("unit") or "")) if x).strip()
            chunks.append({
                "page_content": text,
                "metadata": {
                    "content_type": "metric_fact", "metric_name": metric, "value": value,
                    "unit": str(row.get("unit") or ""), "period": period,
                    "source_doc_id": str(row.get("doc_id") or ""),
                    "source_ref": " ".join(x for x in (str(row.get("sheet_name") or ""), str(row.get("cell_ref") or "")) if x),
                    "confidence": row.get("confidence"), "quality_flag": row.get("quality_flag", ""),
                },
            })
        return chunks


def should_skip_rag(cascade_result: Optional[Dict[str, Any]], agent: str) -> bool:
    """Skip semantic fallback only for explicitly scoped, high-confidence DCI hits."""
    if not cascade_result:
        return False
    if cascade_result.get("type") == "dci_metric":
        return bool(cascade_result.get("high_confidence"))
    chunks = cascade_result.get("chunks", [])
    return bool(cascade_result.get("scope_explicit")) and len(chunks) <= (3 if agent != "quant" else 5)
