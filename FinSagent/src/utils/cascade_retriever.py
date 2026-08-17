"""Dataset- and company-scoped DCI retrieval before semantic RAG."""
from __future__ import annotations

import logging
import os
import re
import sqlite3
import unicodedata
from contextlib import contextmanager
from typing import Any, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple

from utils.retrieval_scope import RetrievalScope

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
    "自由现金流": ("自由现金流", "free cash flow", "fcf", "fcf_ind", "cf_op_ind", "net cash from operating activities", "capex_ind", "purchase of ppe", "total capex"),
    "资产负债率": ("资产负债率", "debt asset ratio", "tot_liabs_ind", "total liabilities", "tot_assets_ind", "total assets"),
    "归母净利润率": ("归母净利润", "net profit attributable", "np_xord_ind", "营业收入", "revenue", "sales_ind"),
    "净利润率": ("净利润", "net profit", "net income", "np_xord_ind", "营业收入", "revenue", "sales_ind"),
    "trailing pe": ("trailing pe", "current price", "share price", "eps (reported)", "eps_rp_ind", "basic eps"),
    "pb市净率": ("current pbr", "current price", "share price", "bps", "bvps", "shr_eqty", "num_sh1"),
    "市净率": ("current pbr", "current price", "share price", "bps", "bvps", "shr_eqty", "num_sh1"),
    "当前价": ("current price", "share price", "price"),
    "bvps": ("bps", "bvps", "book value per share", "shr_eqty", "num_sh1"),
    "经营活动现金流": ("经营活动现金流", "经营性现金流", "operating cash flow", "net cash from operating activities", "cf_op_ind"),
    "经营性现金流": ("经营活动现金流", "经营性现金流", "operating cash flow", "net cash from operating activities", "cf_op_ind"),
    "资本开支": ("资本开支", "资本支出", "capital expenditure", "capex", "capex_ind", "purchase of ppe", "total capex"),
    "资本支出": ("资本开支", "资本支出", "capital expenditure", "capex", "capex_ind", "purchase of ppe", "total capex"),
    "总资产": ("总资产", "total assets", "tot_assets_ind"),
    "总负债": ("总负债", "total liabilities", "tot_liabs_ind"),
    "股东权益": ("股东权益", "shareholders' equity", "shareholder equity", "shr_eqty"),
    "现金及等价物": ("现金及等价物", "现金及现金等价物", "cash and equivalents", "cash and cash equivalents", "cash_ind"),
    "现金及现金等价物": ("现金及等价物", "现金及现金等价物", "cash and equivalents", "cash and cash equivalents", "cash_ind"),
    "应收账款": ("应收账款", "accounts receivable", "account receivables", "accts_rec_ind"),
    "存货": ("存货", "inventory", "inventories", "inventories_ind"),
    "有息负债": ("有息负债", "interest-bearing debt", "st_debt_ind", "lt_debt_ind", "short-term borrowings", "long-term borrowings"),
    "总股本": ("总股本", "shares outstanding", "num_sh1", "ord_capital", "share capital"),
    "毛利润": ("毛利润", "gross profit", "gp_ind"),
    "营业成本": ("营业成本", "cost of revenue", "cost of goods sold", "cogs_ind"),
    "营业利润": ("营业利润", "operating profit", "ebit", "ebit_ind"),
    "基本每股收益": ("基本每股收益", "basic eps", "eps (reported)", "eps_rp_ind"),
    "归母净利润": ("np_xord_ind", "net profit attributable to shareholders", "net profit attributable", "归母净利润", "profit attributable", "net profit", "net income"),
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
    "归母": ("归母", "attributable", "parent", "shareholders", "owners of the parent"),
    "扣非": ("扣非", "扣除非经常", "excluding non-recurring", "adjusted"),
    "剔除": ("剔除", "excluding", "exclude", "adjusted", "ex-"),
    "阶段性": ("阶段性", "temporary", "one-off", "non-recurring", "nonrecurring"),
    "实际": ("实际", "actual", "underlying", "normalized"),
    "调整后": ("调整后", "adjusted", "underlying", "normalized"),
    "持续经营": ("持续经营", "continuing operations", "continued operations"),
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
    periods = [
        re.sub(r"\s+", "", p).casefold()
        for p in re.findall(
            r"(?:19|20)\d{2}(?:e)?(?:\s*(?:年)?\s*(?:q[1-4]|[一二三四1-4]季度|上半年|下半年|全年))?|[1-4]q\d{2}",
            query,
            re.I,
        )
    ]
    lowered = query.casefold()
    inferred: List[str] = []
    if "同比" in query or "yoy" in lowered or "year-over-year" in lowered:
        for period in periods:
            quarter = re.fullmatch(r"([1-4])q(\d{2})", period)
            year = re.match(r"((?:19|20)\d{2})", period)
            if quarter:
                inferred.append(f"{quarter.group(1)}q{int(quarter.group(2)) - 1:02d}")
            elif year:
                inferred.append(str(int(year.group(1)) - 1))
    if any(trigger in lowered for trigger in ("平均股东权益", "期初期末", "roe")):
        for period in periods:
            year = re.match(r"((?:19|20)\d{2})", period)
            if year:
                inferred.append(str(int(year.group(1)) - 1))
    if "环比" in query or "qoq" in lowered or "quarter-over-quarter" in lowered:
        for period in periods:
            quarter = re.fullmatch(r"([1-4])q(\d{2})", period)
            if quarter:
                q, yy = int(quarter.group(1)), int(quarter.group(2))
                inferred.append(f"{q - 1}q{yy:02d}" if q > 1 else f"4q{yy - 1:02d}")
    estimate_compatible = [p[:-1] for p in periods if p.endswith("e")]
    return list(dict.fromkeys([*periods, *estimate_compatible, *inferred]))


def _metric_row_rank(query: str, row: Dict[str, Any], periods: Sequence[str]) -> int:
    """Put canonical operands ahead of similarly named checks and aggregates."""
    query_lower = query.casefold()
    name = str(row.get("metric_name") or "").casefold()
    normalized = _normalize(name)
    rank = 0
    if "check" in name or "检查" in name:
        rank -= 200
    if "归母" in query and (
        normalized == "npxordind" or name.startswith("net profit attributable")
    ):
        rank += 120
    if "股东权益" in query and (
        normalized == "shreqty" or name.startswith("shareholders")
    ):
        rank += 120
    if any(term in query_lower for term in ("pb市净率", "市净率", "bvps")) and (
        normalized in {"bps", "bvps", "currentpbr"} or "book value per share" in name
    ):
        rank += 120
    if "自由现金流" in query and "正式口径" in query and (
        normalized in {"cfopind", "capexind"}
        or name in {"net cash from operating activities", "purchase of ppe", "total capex (cny m)"}
    ):
        rank += 140
    period = str(row.get("period") or "").casefold()
    for index, requested in enumerate(periods):
        if requested and requested in period:
            rank += max(1, 30 - index)
            break
    return rank


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


def _positive_scope_query(query: str) -> str:
    """Keep issuer mentions that define scope and drop explicitly forbidden peers."""
    text = str(query or "")
    restrictive = re.search(
        r"(?:仅|只)(?:能|需|要)?(?:使用|基于|依据|参考)?\s*(.{1,80}?)(?:文档|资料|模型|数据)",
        text,
        flags=re.I,
    )
    if restrictive:
        return restrictive.group(1)
    text = re.sub(
        r"(?:不得|不要|禁止|避免)(?:引用|使用|混用|采用|参考)?[^。；;]*",
        " ",
        text,
        flags=re.I,
    )
    text = re.sub(
        r"(?:do\s+not|don't|must\s+not|never)\s+(?:cite|use|mix|include)[^.;]*",
        " ",
        text,
        flags=re.I,
    )
    return text


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

    @staticmethod
    def _infer_sheet_unit(
        conn: sqlite3.Connection,
        doc_id: Any,
        sheet_name: Any,
        cell_ref: Any,
    ) -> str:
        """Infer a missing row unit from the nearest preceding sheet heading."""
        if not doc_id or not sheet_name or not CascadeRetriever._columns(conn, "excel_cells"):
            return ""
        match = re.search(r"(\d+)$", str(cell_ref or ""))
        if not match:
            return ""
        target_row = int(match.group(1))
        try:
            headings = conn.execute(
                """SELECT display_value FROM excel_cells
                   WHERE doc_id = ? AND sheet_name = ? AND row_index <= ?
                     AND display_value IS NOT NULL
                     AND (
                       LOWER(display_value) LIKE '%eurm%'
                       OR LOWER(display_value) LIKE '%cnym%'
                       OR LOWER(display_value) LIKE '%rmbm%'
                       OR LOWER(display_value) LIKE '%usdm%'
                       OR LOWER(display_value) LIKE '%hkdm%'
                       OR LOWER(display_value) LIKE '%eur million%'
                       OR LOWER(display_value) LIKE '%cny million%'
                       OR LOWER(display_value) LIKE '%rmb million%'
                       OR LOWER(display_value) LIKE '%usd million%'
                       OR LOWER(display_value) LIKE '%hkd million%'
                     )
                   ORDER BY row_index DESC, col_index ASC LIMIT 32""",
                (str(doc_id), str(sheet_name), target_row),
            ).fetchall()
        except sqlite3.Error:
            return ""
        unit_map = {"rmb": "CNYm", "cny": "CNYm", "eur": "EURm", "usd": "USDm", "hkd": "HKDm"}
        for heading in headings:
            text = str(heading[0] or "")
            unit_match = re.search(r"\b(RMB|CNY|EUR|USD|HKD)\s*(?:m|mn|million)\b", text, re.I)
            if unit_match:
                return unit_map[unit_match.group(1).casefold()]
        return ""

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
        query_norm = _normalize(_positive_scope_query(query))
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

    def resolve_scope(self, query: str, dataset_id: str = "") -> RetrievalScope:
        """Resolve the immutable scope inherited by every rewritten sub-query."""
        doc_ids, explicit_company = self.resolve_query_doc_ids(query)
        return RetrievalScope.from_doc_ids(
            query,
            doc_ids,
            explicit_company=explicit_company,
            dataset_id=dataset_id,
        )

    def resolve_scope_with_history(
        self,
        query: str,
        prior_user_queries: Sequence[str],
        dataset_id: str = "",
    ) -> RetrievalScope:
        """Resolve a follow-up against the nearest explicit user entity.

        Assistant messages are intentionally not accepted here: generated text
        may mention comparison companies and must never redefine the user's
        retrieval boundary.
        """
        current_scope = self.resolve_scope(query, dataset_id=dataset_id)
        if current_scope.explicit_company:
            return current_scope
        for prior_query in reversed([str(value) for value in prior_user_queries if value]):
            prior_scope = self.resolve_scope(prior_query, dataset_id=dataset_id)
            if prior_scope.explicit_company:
                return RetrievalScope.from_doc_ids(
                    query,
                    prior_scope.source_doc_ids,
                    explicit_company=True,
                    dataset_id=dataset_id,
                )
        return current_scope

    @staticmethod
    def _scope_clause(doc_ids: Sequence[str], column: str = "doc_id") -> Tuple[str, List[str]]:
        clean = [str(x) for x in doc_ids if x]
        if not clean:
            return "1 = 0", []
        return f"{column} IN ({','.join('?' for _ in clean)})", clean

    def search_metric(
        self,
        query: str,
        allowed_doc_ids: Optional[Sequence[str]] = None,
        scope_explicit: Optional[bool] = None,
        confidence_query: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        terms = _metric_terms(query)
        if not terms:
            return None
        validation_query = str(confidence_query or query)
        resolved_ids, explicit_company = self.resolve_query_doc_ids(query)
        doc_ids = list(allowed_doc_ids) if allowed_doc_ids is not None else resolved_ids
        if scope_explicit is not None:
            explicit_company = bool(scope_explicit)
        periods = _extract_periods(validation_query)
        with self._connection() as conn:
            if conn is None:
                return None
            cols = self._columns(conn, "metric_facts")
            if "metric_name" not in cols or "doc_id" not in cols:
                return None
            selected = [c for c in (
                "metric_name", "metric_alias", "value_numeric", "value_text", "unit", "currency",
                "doc_id", "period", "actual_or_estimate", "sheet_name", "cell_ref",
                "formula", "confidence", "quality_flag",
            ) if c in cols]
            scope_sql, params = self._scope_clause(doc_ids)
            searchable_cols = ["metric_name"]
            if "metric_alias" in cols:
                searchable_cols.append("metric_alias")
            term_sql = " OR ".join(
                f"LOWER(COALESCE({column},'')) LIKE ?"
                for term in terms
                for column in searchable_cols
            )
            params.extend(f"%{term}%" for term in terms for _ in searchable_cols)
            sql = f"SELECT {', '.join(selected)} FROM metric_facts WHERE {scope_sql} AND ({term_sql})"
            if "period" in cols and periods:
                sql += " AND (" + " OR ".join("LOWER(COALESCE(period,'')) LIKE ?" for _ in periods) + ") ORDER BY rowid"
                params.extend(f"%{p}%" for p in periods)
            else:
                sql += " ORDER BY rowid"
            rows = conn.execute(sql + " LIMIT 96", params).fetchall()
            row_dicts = [dict(r) for r in rows]
            for row in row_dicts:
                if not str(row.get("unit") or "").strip():
                    row["unit"] = self._infer_sheet_unit(
                        conn,
                        row.get("doc_id"),
                        row.get("sheet_name"),
                        row.get("cell_ref"),
                    )
        if not row_dicts:
            return None
        row_dicts.sort(key=lambda row: _metric_row_rank(validation_query, row, periods), reverse=True)
        row_dicts = row_dicts[:24]
        period_match = not periods or any(any(p[:4] in str(r.get("period") or "").casefold() for p in periods) for r in row_dicts)
        source_ids = {str(r.get("doc_id") or "") for r in row_dicts}
        metric_names = [str(r.get("metric_name") or "") for r in row_dicts]
        unique_metric_names = {_normalize(name) for name in metric_names if name}
        returned_periods = {_normalize(r.get("period")) for r in row_dicts if r.get("period")}
        period_unambiguous = bool(periods) or len(returned_periods) <= 1
        high_confidence = (
            explicit_company and period_match and period_unambiguous
            and len(source_ids) == 1 and len(unique_metric_names) == 1
            and _qualifiers_match(validation_query, metric_names)
        )
        return {
            "type": "dci_metric", "query": query,
            "chunks": self._metric_rows_to_chunks(row_dicts),
            "matched_metric_names": metric_names,
            "scope_explicit": explicit_company, "period_match": period_match,
            "high_confidence": high_confidence, "source_doc_ids": sorted(source_ids),
            "final_chunks": True, "pre_rerank_chunks": [], "time_info": [],
        }

    def search_keyword(
        self,
        query: str,
        allowed_doc_ids: Optional[Sequence[str]] = None,
        scope_explicit: Optional[bool] = None,
    ) -> Optional[Dict[str, Any]]:
        candidates = _keyword_terms(query)
        if not candidates:
            return None
        resolved_ids, explicit_company = self.resolve_query_doc_ids(query)
        doc_ids = list(allowed_doc_ids) if allowed_doc_ids is not None else resolved_ids
        if scope_explicit is not None:
            explicit_company = bool(scope_explicit)
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
            text = " ".join(
                x for x in (
                    period,
                    f"{metric}: {value}",
                    str(row.get("unit") or ""),
                    f"formula={row.get('formula')}" if row.get("formula") else "",
                ) if x
            ).strip()
            chunks.append({
                "page_content": text,
                "metadata": {
                    "content_type": "metric_fact", "metric_name": metric, "value": value,
                    "unit": str(row.get("unit") or ""), "period": period,
                    "currency": str(row.get("currency") or ""),
                    "actual_or_estimate": str(row.get("actual_or_estimate") or ""),
                    "source_doc_id": str(row.get("doc_id") or ""),
                    "source_ref": " ".join(x for x in (str(row.get("sheet_name") or ""), str(row.get("cell_ref") or "")) if x),
                    "formula": str(row.get("formula") or ""),
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
