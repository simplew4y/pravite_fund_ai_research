"""Skill-driven valuation impacts extracted from current supporting documents."""

from __future__ import annotations

import hashlib
import html
import json
import math
import os
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
from xml.etree import ElementTree

import backoff

SKILL_NAME = "private-fund-valuation-impacts"
EXTRACTOR_VERSION = "valuation-impact-skill-v3"
MAX_DOCUMENTS = 6
MAX_CHUNKS_PER_DOCUMENT = 3
MAX_TOTAL_CHARS = 6_000
DEFAULT_SENTIMENT_LOOKBACK_DAYS = 90
MAX_SENTIMENT_EVIDENCE = 12

_SKILL_ROOT = (
    Path(__file__).resolve().parents[1] / "resources" / "private_fund_skills" / SKILL_NAME
)
_SKILL_PATH = _SKILL_ROOT / "SKILL.md"
_SCHEMA_PATH = _SKILL_ROOT / "references" / "output-schema.json"

_MODEL_SUBTYPES = frozenset(
    {
        "dcf_model",
        "comparable_company_model",
        "financial_forecast_model",
        "integrated_valuation_model",
    }
)
_DIRECTIONS = frozenset({"up", "down", "mixed"})
_REVIEW_STATUSES = frozenset({"ready", "needs_review"})
_AFFECTED_INPUTS = frozenset(
    {
        "revenue_growth",
        "gross_margin",
        "operating_margin",
        "unit_economics",
        "r_and_d",
        "capex",
        "working_capital",
        "free_cash_flow",
        "wacc",
        "terminal_growth",
        "valuation_multiple",
        "success_probability",
        "timing_discount",
        "overseas_revenue",
        "order_conversion",
    }
)
_VALUATION_TERMS = (
    "收入",
    "利润",
    "毛利",
    "成本",
    "订单",
    "交付",
    "价格",
    "市场",
    "增长",
    "资本开支",
    "研发",
    "现金流",
    "风险",
    "政策",
    "合规",
    "客户",
    "量产",
    "投产",
    "指引",
    "revenue",
    "profit",
    "margin",
    "cost",
    "order",
    "delivery",
    "growth",
    "capex",
    "cash flow",
    "risk",
    "policy",
)
_SENTIMENT_BALANCED_PROVIDERS = ("google_news_rss", "ifind_report_query")
_SENTIMENT_PROVIDER_MIN_QUOTA = 4
_SENTIMENT_RELEVANCE_TERMS = (
    "评级",
    "买入",
    "目标价",
    "回购",
    "分红",
    "资金流入",
    "南向资金",
    "盈利",
    "业绩",
    "估值",
    "海外",
    "扩张",
    "特许经营",
    "同店",
    "rating",
    "buy",
    "target price",
    "buyback",
    "dividend",
    "earnings",
    "same-store",
)
_SENTIMENT_LOW_VALUE_TERMS = (
    "monthly return",
    "月报表",
    "date of board meeting",
    "董事会会议日期",
)


class ValuationImpactChatClient(Protocol):
    def chat_json(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str: ...


class SentimentEvidenceAdapter(Protocol):
    def fetch_sentiment_evidence(
        self,
        *,
        dataset_id: str,
        series_id: str,
        model_version_id: str,
        as_of: str,
        lookback_days: int,
    ) -> list[dict[str, Any]]: ...


def _normalize_sentiment_story_title(title: Any) -> str:
    text = _clean_text(title, 300).casefold()
    text = re.sub(r"\s+-\s+[^-]{1,40}$", "", text)
    return re.sub(r"[^\w\u4e00-\u9fff]+", "", text)


def _sentiment_story_id(
    title: Any, published_at: Any, ticker: Any = "", fallback: Any = ""
) -> str:
    title_key = _normalize_sentiment_story_title(title)
    published_date = str(published_at or "")[:10]
    ticker_key = re.sub(r"\W+", "", str(ticker or "").casefold())
    if title_key and published_date:
        return _digest(title_key, published_date, ticker_key, length=24)
    return _digest(fallback, title_key, published_date, ticker_key, length=24)


def _ifind_code(ticker: str) -> str:
    value = str(ticker or "").strip().upper()
    if value.endswith(".HK"):
        code = value[:-3]
        if code.isdigit():
            return code.zfill(4) + ".HK"
    return value


def _ifind_report_type(ticker: str) -> str:
    if str(ticker or "").strip().upper().endswith(".HK"):
        return os.environ.get("PRIVATE_FUND_IFIND_HK_REPORT_TYPE", "904")
    return os.environ.get("PRIVATE_FUND_IFIND_A_REPORT_TYPE", "901")


_IFIND_REPORT_FIELDS = ("pdfURL", "reportTitle", "ctime", "reportDate", "seq")


def _ifind_column_table_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    if not any(key in payload for key in _IFIND_REPORT_FIELDS):
        return []
    list_lengths = [len(value) for value in payload.values() if isinstance(value, list)]
    if not list_lengths:
        return [payload]
    rows: list[dict[str, Any]] = []
    for index in range(max(list_lengths)):
        row: dict[str, Any] = {}
        for key, value in payload.items():
            if isinstance(value, list):
                row[key] = value[index] if index < len(value) else None
            else:
                row[key] = value
        rows.append(row)
    return rows


def _ifind_rows(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        rows: list[dict[str, Any]] = []
        for item in payload:
            rows.extend(_ifind_rows(item))
        return rows
    if not isinstance(payload, dict):
        return []
    rows = _ifind_column_table_rows(payload)
    if rows:
        return rows
    for key in ("data", "rows", "result", "table", "tables"):
        value = payload.get(key)
        rows = _ifind_rows(value)
        if rows:
            return rows
    return []


class IfindReportQuerySentimentAdapter:
    """Fetch announcement evidence from iFinD report_query."""

    def __init__(
        self,
        company_name: str,
        company_ticker: str = "",
        *,
        access_token: str | None = None,
        url: str | None = None,
        timeout: float = 8,
    ) -> None:
        self.company_name = company_name.strip()
        self.company_ticker = company_ticker.strip()
        self.access_token = access_token or os.environ.get("PRIVATE_FUND_IFIND_ACCESS_TOKEN", "")
        self.url = url or os.environ.get(
            "PRIVATE_FUND_IFIND_REPORT_QUERY_URL",
            "https://quantapi.51ifind.com/api/v1/report_query",
        )
        self.timeout = timeout

    def fetch_sentiment_evidence(
        self,
        *,
        dataset_id: str,
        series_id: str,
        model_version_id: str,
        as_of: str,
        lookback_days: int,
    ) -> list[dict[str, Any]]:
        del dataset_id, series_id, model_version_id
        if not self.access_token or not self.company_ticker:
            return []
        as_of_dt = _parse_datetime(as_of) or datetime.now(timezone.utc)
        window_start = as_of_dt - timedelta(days=max(1, lookback_days))
        code = _ifind_code(self.company_ticker)
        body = {
            "codes": code,
            "functionpara": {"reportType": _ifind_report_type(code)},
            "beginrDate": window_start.date().isoformat(),
            "endrDate": as_of_dt.date().isoformat(),
            "outputpara": (
                "pdfURL:Y,reportTitle:Y,ctime:Y,secName:Y,thscode:Y,"
                "reportDate:Y,announcementLanguage:Y,seq:Y"
            ),
        }
        request = Request(
            self.url,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "access_token": self.access_token,
                "User-Agent": "Omnigent/valuation-sentiment-ifind",
            },
            method="POST",
        )
        with urlopen(request, timeout=self.timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))

        captured_at = datetime.now(timezone.utc).isoformat()
        rows: list[dict[str, Any]] = []
        for item in _ifind_rows(payload)[:MAX_SENTIMENT_EVIDENCE]:
            title = _clean_text(item.get("reportTitle"), 300)
            url = _clean_text(item.get("pdfURL"), 500)
            if not title or not url:
                continue
            published_dt = _parse_datetime(item.get("ctime")) or _parse_datetime(
                item.get("reportDate")
            )
            if published_dt is None:
                continue
            published_at = published_dt.isoformat()
            sec_name = _clean_text(item.get("secName"), 160) or self.company_name
            source_name = sec_name or "\u540c\u82b1\u987aiFinD"
            story_id = _sentiment_story_id(
                title,
                published_at,
                item.get("thscode") or code,
                item.get("seq") or url,
            )
            excerpt = _clean_text(f"{title}\u3002{sec_name} {item.get('reportDate') or ''}", 700)
            rows.append(
                {
                    "sentiment_id": "ifind:" + _digest(item.get("seq"), url, title, length=24),
                    "provider": "ifind_report_query",
                    "source_type": "provider_api",
                    "source_name": source_name,
                    "source_url": url,
                    "publisher_url": url,
                    "canonical_url": url,
                    "canonical_story_id": story_id,
                    "title": title,
                    "excerpt": excerpt,
                    "locator": (
                        "\u540c\u82b1\u987aiFinD\u516c\u544a\u67e5\u8be2\uff1a"
                        "\u516c\u544a\u6807\u9898\u4e0e\u94fe\u63a5"
                    ),
                    "published_at": published_at,
                    "captured_at": captured_at,
                    "raw_json": item,
                }
            )
        return rows


class CompositeSentimentEvidenceAdapter:
    def __init__(self, adapters: list[SentimentEvidenceAdapter]) -> None:
        self.adapters = adapters

    def fetch_sentiment_evidence(self, **kwargs: Any) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for adapter in self.adapters:
            try:
                rows.extend(adapter.fetch_sentiment_evidence(**kwargs))
            except Exception:  # noqa: BLE001 - keep one provider failure non-blocking
                continue
        return rows


def default_sentiment_adapter(company_name: str, company_ticker: str) -> SentimentEvidenceAdapter:
    adapters: list[SentimentEvidenceAdapter] = [
        GoogleNewsRssSentimentAdapter(company_name, company_ticker)
    ]
    if os.environ.get("PRIVATE_FUND_IFIND_ACCESS_TOKEN"):
        adapters.append(IfindReportQuerySentimentAdapter(company_name, company_ticker))
    return CompositeSentimentEvidenceAdapter(adapters)


class GoogleNewsRssSentimentAdapter:
    """Fetch recent public-news evidence without requiring another API key."""

    def __init__(
        self,
        company_name: str,
        company_ticker: str = "",
        *,
        timeout: float = 8,
    ) -> None:
        self.company_name = company_name.strip()
        self.company_ticker = company_ticker.strip()
        self.timeout = timeout

    def fetch_sentiment_evidence(
        self,
        *,
        dataset_id: str,
        series_id: str,
        model_version_id: str,
        as_of: str,
        lookback_days: int,
    ) -> list[dict[str, Any]]:
        del dataset_id, series_id, model_version_id
        as_of_dt = _parse_datetime(as_of) or datetime.now(timezone.utc)
        window_start = as_of_dt - timedelta(days=max(1, lookback_days))
        terms = [f'"{self.company_name}"']
        if self.company_ticker:
            terms.append(f'"{self.company_ticker}"')
        query = (
            " OR ".join(terms)
            + f" after:{window_start.date().isoformat()}"
            + f" before:{(as_of_dt + timedelta(days=1)).date().isoformat()}"
        )
        feed_url = "https://news.google.com/rss/search?" + urlencode(
            {"q": query, "hl": "zh-CN", "gl": "CN", "ceid": "CN:zh-Hans"}
        )
        request = Request(
            feed_url,
            headers={"User-Agent": "Omnigent/valuation-sentiment"},
        )
        with urlopen(request, timeout=self.timeout) as response:
            root = ElementTree.fromstring(response.read())

        captured_at = datetime.now(timezone.utc).isoformat()
        rows: list[dict[str, Any]] = []
        for item in root.findall("./channel/item")[:MAX_SENTIMENT_EVIDENCE]:
            title = _clean_text(item.findtext("title"), 300)
            link = _clean_text(item.findtext("link"), 500)
            published_raw = _clean_text(item.findtext("pubDate"), 100)
            source_node = item.find("source")
            source_name = _clean_text(source_node.text if source_node is not None else "", 160)
            publisher_url = _clean_text(
                source_node.get("url") if source_node is not None else "", 500
            )
            description = html.unescape(
                re.sub(r"<[^>]+>", " ", str(item.findtext("description") or ""))
            )
            excerpt = _clean_text(f"{title}。{description}", 700)
            if not title or not link or not excerpt:
                continue
            try:
                published_at = (
                    parsedate_to_datetime(published_raw).astimezone(timezone.utc).isoformat()
                )
            except (TypeError, ValueError, OverflowError):
                continue
            rows.append(
                {
                    "sentiment_id": "gnews:" + _digest(link, length=24),
                    "provider": "google_news_rss",
                    "source_type": "public_web",
                    "source_name": source_name or "Google News",
                    "source_url": link,
                    "publisher_url": publisher_url,
                    "canonical_url": link,
                    "canonical_story_id": _sentiment_story_id(
                        title, published_at, self.company_ticker, link
                    ),
                    "title": title,
                    "excerpt": excerpt,
                    "locator": "Google News RSS 条目标题与摘要",
                    "published_at": published_at,
                    "captured_at": captured_at,
                }
            )
        return rows


class RetryableLLMError(RuntimeError):
    """Transient LLM failure that may succeed on a bounded retry."""


_RETRYABLE_LLM_HTTP_STATUSES = frozenset({408, 429, 500, 502, 503, 504})
_NON_RETRYABLE_LLM_ERROR_MARKERS = (
    "authentication required",
    "invalid api key",
    "model not found",
    "unknown model",
    "invalid request",
    "unsupported parameter",
)


def _is_retryable_llm_error(exc: Exception) -> bool:
    message = str(exc).strip().casefold()
    if any(marker in message for marker in _NON_RETRYABLE_LLM_ERROR_MARKERS):
        return False
    status_match = re.search(r"\bhttp\s+(\d{3})\b", message)
    if status_match is not None:
        return int(status_match.group(1)) in _RETRYABLE_LLM_HTTP_STATUSES
    return "response was empty" in message or "timed out" in message


@backoff.on_exception(
    backoff.expo,
    RetryableLLMError,
    max_tries=3,
    factor=0.25,
    max_value=1.0,
    jitter=backoff.full_jitter,
)
def _request_valuation_impacts(
    llm_client: ValuationImpactChatClient,
    messages: list[dict[str, str]],
) -> str:
    try:
        return llm_client.chat_json(
            messages,
            max_tokens=6_000,
            temperature=0.0,
        )
    except Exception as exc:
        if _is_retryable_llm_error(exc):
            raise RetryableLLMError(str(exc)) from exc
        raise


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _decode(value: Any, default: Any) -> Any:
    if value in (None, ""):
        return default
    try:
        return json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return default


def _digest(*parts: Any, length: int = 32) -> str:
    payload = "\0".join(str(part or "") for part in parts)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:length]


def _safe_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _clean_text(value: Any, limit: int) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _parse_datetime(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        try:
            parsed = datetime.fromisoformat(f"{text}T00:00:00+00:00")
        except ValueError:
            return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _url_host(value: Any) -> str:
    host = (urlparse(str(value or "")).hostname or "").casefold()
    return host[4:] if host.startswith("www.") else host


def _is_whitelisted_url(url: str, whitelist_hosts: list[str] | None) -> bool:
    hosts = {
        host[4:] if host.startswith("www.") else host
        for host in (str(item or "").strip().casefold() for item in whitelist_hosts or [])
        if host
    }
    if not hosts:
        return True
    host = _url_host(url)
    return any(host == item or host.endswith(f".{item}") for item in hosts)


def _tables(conn: sqlite3.Connection) -> set[str]:
    return {
        str(row[0]) for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }


def _columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table_name})")}


def ensure_impact_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS valuation_impact_agent_runs (
            run_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            series_id TEXT NOT NULL,
            model_version_id TEXT NOT NULL,
            source_fingerprint TEXT NOT NULL,
            extractor_version TEXT NOT NULL,
            skill_name TEXT NOT NULL,
            status TEXT NOT NULL,
            card_count INTEGER NOT NULL DEFAULT 0,
            output_json TEXT NOT NULL DEFAULT '{}',
            document_versions_json TEXT NOT NULL DEFAULT '[]',
            selection_scope_json TEXT NOT NULL DEFAULT '{}',
            coverage_summary_json TEXT NOT NULL DEFAULT '{}',
            raw_response TEXT,
            error_message TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS valuation_impact_cards (
            card_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            dataset_id TEXT NOT NULL,
            series_id TEXT NOT NULL,
            model_version_id TEXT NOT NULL,
            source_fingerprint TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            direction TEXT NOT NULL,
            horizon TEXT NOT NULL,
            confidence REAL NOT NULL,
            title TEXT NOT NULL,
            evidence_summary TEXT NOT NULL,
            valuation_impact TEXT NOT NULL,
            affected_inputs_json TEXT NOT NULL DEFAULT '[]',
            watch_items_json TEXT NOT NULL DEFAULT '[]',
            source_refs_json TEXT NOT NULL DEFAULT '[]',
            evidence_ids_json TEXT NOT NULL DEFAULT '[]',
            evidence_locations_json TEXT NOT NULL DEFAULT '[]',
            review_status TEXT NOT NULL DEFAULT 'needs_review',
            review_reasons_json TEXT NOT NULL DEFAULT '[]',
            evidence_coverage_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            UNIQUE(run_id, ordinal)
        );

        CREATE INDEX IF NOT EXISTS ix_valuation_impact_runs_latest
            ON valuation_impact_agent_runs(model_version_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS ix_valuation_impact_cards_run
            ON valuation_impact_cards(run_id, ordinal);

        CREATE TABLE IF NOT EXISTS valuation_sentiment_evidence (
            sentiment_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            series_id TEXT,
            model_version_id TEXT,
            provider TEXT,
            source_type TEXT NOT NULL DEFAULT 'provider_api',
            source_name TEXT,
            source_url TEXT NOT NULL,
            canonical_url TEXT,
            canonical_story_id TEXT,
            title TEXT,
            excerpt TEXT NOT NULL,
            locator TEXT,
            published_at TEXT,
            captured_at TEXT NOT NULL,
            raw_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_valuation_sentiment_scope
            ON valuation_sentiment_evidence(
                dataset_id, series_id, model_version_id, published_at DESC
            );
        """
    )
    schema_row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='valuation_impact_agent_runs'"
    ).fetchone()
    if schema_row and "UNIQUE(model_version_id" in str(schema_row[0] or ""):
        conn.executescript(
            """
            CREATE TABLE valuation_impact_agent_runs_migrated (
                run_id TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL,
                series_id TEXT NOT NULL,
                model_version_id TEXT NOT NULL,
                source_fingerprint TEXT NOT NULL,
                extractor_version TEXT NOT NULL,
                skill_name TEXT NOT NULL,
                status TEXT NOT NULL,
                card_count INTEGER NOT NULL DEFAULT 0,
                output_json TEXT NOT NULL DEFAULT '{}',
                document_versions_json TEXT NOT NULL DEFAULT '[]',
                selection_scope_json TEXT NOT NULL DEFAULT '{}',
                coverage_summary_json TEXT NOT NULL DEFAULT '{}',
                raw_response TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT OR IGNORE INTO valuation_impact_agent_runs_migrated
                (run_id, dataset_id, series_id, model_version_id, source_fingerprint,
                 extractor_version, skill_name, status, card_count, output_json,
                 raw_response, error_message, created_at, updated_at)
            SELECT run_id, dataset_id, series_id, model_version_id, source_fingerprint,
                   extractor_version, skill_name, status, card_count, output_json,
                   raw_response, error_message, created_at, updated_at
            FROM valuation_impact_agent_runs;
            DROP TABLE valuation_impact_agent_runs;
            ALTER TABLE valuation_impact_agent_runs_migrated RENAME TO valuation_impact_agent_runs;
            """
        )
    run_columns = _columns(conn, "valuation_impact_agent_runs")
    for column_name, definition in (
        ("document_versions_json", "TEXT NOT NULL DEFAULT '[]'"),
        ("selection_scope_json", "TEXT NOT NULL DEFAULT '{}'"),
        ("coverage_summary_json", "TEXT NOT NULL DEFAULT '{}'"),
    ):
        if column_name not in run_columns:
            conn.execute(
                f"ALTER TABLE valuation_impact_agent_runs ADD COLUMN {column_name} {definition}"
            )
    conn.executescript(
        """
        CREATE INDEX IF NOT EXISTS ix_valuation_impact_runs_latest
            ON valuation_impact_agent_runs(model_version_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS ix_valuation_impact_cards_run
            ON valuation_impact_cards(run_id, ordinal);
        """
    )
    card_columns = _columns(conn, "valuation_impact_cards")
    for column_name, definition in (
        ("evidence_locations_json", "TEXT NOT NULL DEFAULT '[]'"),
        ("review_status", "TEXT NOT NULL DEFAULT 'needs_review'"),
        ("review_reasons_json", "TEXT NOT NULL DEFAULT '[]'"),
        ("evidence_coverage_json", "TEXT NOT NULL DEFAULT '{}'"),
    ):
        if column_name not in card_columns:
            conn.execute(
                f"ALTER TABLE valuation_impact_cards ADD COLUMN {column_name} {definition}"
            )


def _supporting_documents(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    document_ids: list[str] | None = None,
) -> list[dict[str, Any]]:
    if "documents" not in _tables(conn):
        return []
    document_columns = _columns(conn, "documents")

    def selected(column: str, fallback: str) -> str:
        return column if column in document_columns else f"{fallback} AS {column}"

    subtype_placeholders = ",".join("?" for _ in _MODEL_SUBTYPES)
    model_predicates = [
        "COALESCE(d.doc_type,'')='valuation_model'",
        f"COALESCE(d.doc_subtype,'') IN ({subtype_placeholders})",
    ]
    if "excel_workbooks" in _tables(conn):
        model_predicates.append(
            "EXISTS (SELECT 1 FROM excel_workbooks ew "
            "WHERE ew.doc_id=d.doc_id AND ew.workbook_type='valuation_model')"
        )
    params: list[Any] = [dataset_id, *sorted(_MODEL_SUBTYPES)]
    document_filter = ""
    if document_ids is not None:
        selected_ids = [str(item).strip() for item in document_ids if str(item).strip()]
        if not selected_ids:
            return []
        placeholders = ",".join("?" for _ in selected_ids)
        document_filter = f" AND d.doc_id IN ({placeholders})"
        params.extend(selected_ids)
    rows = conn.execute(
        f"""
        SELECT d.doc_id, d.original_filename,
               {selected("doc_type", "''")}, {selected("doc_subtype", "''")},
               {selected("document_date", "''")}, {selected("checksum", "''")},
               {selected("version_no", "1")}, {selected("logical_doc_id", "''")},
               {selected("created_at", "''")}, {selected("updated_at", "''")}
        FROM documents d
        WHERE d.dataset_id=? AND d.status='indexed'
          AND COALESCE(d.is_current,1)=1
          AND COALESCE(d.lifecycle_state,'active')='active'
          AND NOT ({" OR ".join(model_predicates)})
          {document_filter}
        ORDER BY COALESCE(d.document_date,'') DESC, d.created_at DESC
        """,
        params,
    ).fetchall()
    return [dict(row) for row in rows]


def _chunk_rows(conn: sqlite3.Connection, doc_id: str) -> list[dict[str, Any]]:
    if "chunks" not in _tables(conn):
        return []
    columns = _columns(conn, "chunks")

    def selected(column: str, fallback: str) -> str:
        return column if column in columns else f"{fallback} AS {column}"

    rows = conn.execute(
        f"""
        SELECT chunk_id, chunk_index, {selected("summary", "''")},
               {selected("content", "''")}, {selected("source_ref", "''")},
               {selected("title_path", "''")}, {selected("content_hash", "''")}
        FROM chunks WHERE doc_id=? ORDER BY chunk_index
        """,
        (doc_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def _ranked_chunks(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ranked: list[tuple[int, int, dict[str, Any]]] = []
    seen: set[str] = set()
    for row in rows:
        text = _clean_text(row.get("content") or row.get("summary"), 6_000)
        if not text:
            continue
        normalized = text.casefold()
        dedupe = str(row.get("content_hash") or _digest(normalized[:1_500]))
        if dedupe in seen:
            continue
        seen.add(dedupe)
        score = sum(1 for term in _VALUATION_TERMS if term in normalized)
        source_ref = str(row.get("source_ref") or "")
        if re.search(r"\bp\.?\s*\d+", source_ref, flags=re.IGNORECASE):
            score += 2
        if "document summary" in str(row.get("title_path") or "").casefold():
            score -= 3
        ranked.append((score, int(row.get("chunk_index") or 0), row))
    ranked.sort(key=lambda item: (-item[0], item[1]))
    return [item[2] for item in ranked[:MAX_CHUNKS_PER_DOCUMENT]]


def _model_context(conn: sqlite3.Connection, model_version_id: str) -> list[dict[str, Any]]:
    required = {"valuation_model_nodes", "valuation_model_node_values"}
    if not required.issubset(_tables(conn)):
        return []
    rows = conn.execute(
        """
        SELECT n.display_name, n.metric_key, n.scope, n.period, n.scenario,
               v.value_numeric, v.value_text, v.unit, v.sheet_name, v.cell_ref
        FROM valuation_model_node_values v
        JOIN valuation_model_nodes n ON n.node_id=v.node_id
        WHERE v.model_version_id=?
          AND (v.value_numeric IS NOT NULL OR NULLIF(v.value_text,'') IS NOT NULL)
        ORDER BY CASE WHEN NULLIF(n.metric_key,'') IS NOT NULL THEN 0 ELSE 1 END,
                 v.confidence DESC, n.display_name
        LIMIT 8
        """,
        (model_version_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def _document_version_payload(document: dict[str, Any]) -> dict[str, Any]:
    return {
        "document_id": str(document.get("doc_id") or ""),
        "logical_doc_id": str(document.get("logical_doc_id") or ""),
        "version_no": int(document.get("version_no") or 1),
        "checksum": str(document.get("checksum") or ""),
        "source_name": str(document.get("original_filename") or ""),
        "updated_at": str(document.get("updated_at") or document.get("created_at") or ""),
    }


def _evidence_location(
    *,
    document: dict[str, Any],
    chunk: dict[str, Any],
    source_ref: str,
) -> dict[str, Any] | None:
    raw_ref = _clean_text(source_ref, 240)
    title_path = _clean_text(chunk.get("title_path"), 240)
    page_match = re.search(r"(?:\bp\.?|page|页码?|第)\s*(\d{1,5})", raw_ref, flags=re.IGNORECASE)
    if page_match:
        return {
            "locator_type": "pdf_page_paragraph",
            "document_id": str(document.get("doc_id") or ""),
            "document_version_no": int(document.get("version_no") or 1),
            "page": int(page_match.group(1)),
            "paragraph": int(chunk.get("chunk_index") or 0),
            "source_ref": raw_ref,
        }
    cell_match = re.search(r"([^!\s]+)!\$?([A-Z]{1,3}\$?\d+)(?::\$?[A-Z]{1,3}\$?\d+)?", raw_ref)
    if cell_match:
        return {
            "locator_type": "excel_sheet_range",
            "document_id": str(document.get("doc_id") or ""),
            "document_version_no": int(document.get("version_no") or 1),
            "sheet_name": cell_match.group(1),
            "range_ref": raw_ref.split("!", 1)[1].split()[0],
            "source_ref": raw_ref,
        }
    if title_path:
        return {
            "locator_type": "word_heading_paragraph",
            "document_id": str(document.get("doc_id") or ""),
            "document_version_no": int(document.get("version_no") or 1),
            "heading_path": title_path,
            "paragraph": int(chunk.get("chunk_index") or 0),
            "source_ref": raw_ref,
        }
    return None


def _selection_scope(document_ids: list[str] | None) -> dict[str, Any]:
    selected = [str(item).strip() for item in document_ids or [] if str(item).strip()]
    return {
        "mode": "selected_documents"
        if document_ids is not None
        else "all_current_effective_documents",
        "document_ids": selected,
    }


def _stored_sentiment_rows(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    series_id: str,
    model_version_id: str,
) -> list[dict[str, Any]]:
    if "valuation_sentiment_evidence" not in _tables(conn):
        return []
    rows = conn.execute(
        """
        SELECT * FROM valuation_sentiment_evidence
        WHERE dataset_id=?
          AND (NULLIF(series_id,'') IS NULL OR series_id=?)
          AND (NULLIF(model_version_id,'') IS NULL OR model_version_id=?)
        ORDER BY COALESCE(published_at, captured_at, created_at) DESC
        LIMIT 50
        """,
        (dataset_id, series_id, model_version_id),
    ).fetchall()
    return [dict(row) for row in rows]


def _adapter_sentiment_rows(
    adapter: SentimentEvidenceAdapter | None,
    *,
    dataset_id: str,
    series_id: str,
    model_version_id: str,
    as_of: str,
    lookback_days: int,
) -> tuple[list[dict[str, Any]], str | None]:
    if adapter is None:
        return [], None
    try:
        rows = adapter.fetch_sentiment_evidence(
            dataset_id=dataset_id,
            series_id=series_id,
            model_version_id=model_version_id,
            as_of=as_of,
            lookback_days=lookback_days,
        )
    except Exception as exc:  # noqa: BLE001 - sentiment should not block document analysis
        return [], _clean_text(exc, 300)
    return [dict(row) for row in rows if isinstance(row, dict)], None


def _sentiment_independence_key(row: dict[str, Any]) -> str:
    explicit = _clean_text(row.get("canonical_story_id"), 160)
    if explicit:
        return f"story:{explicit.casefold()}"
    canonical_url = _clean_text(row.get("canonical_url"), 500) or _clean_text(
        row.get("source_url"), 500
    )
    title = _clean_text(row.get("title"), 240).casefold()
    excerpt = _clean_text(row.get("excerpt"), 500).casefold()
    published = str(row.get("published_at") or row.get("captured_at") or "")[:10]
    return "story:" + _digest(canonical_url, title, excerpt[:240], published, length=24)


def _sentiment_in_window(row: dict[str, Any], *, as_of_dt: datetime, lookback_days: int) -> bool:
    observed_at = _parse_datetime(row.get("published_at")) or _parse_datetime(
        row.get("captured_at")
    )
    if observed_at is None:
        return False
    window_start = as_of_dt - timedelta(days=max(0, lookback_days))
    return window_start <= observed_at <= as_of_dt


def _sentiment_location(row: dict[str, Any], excerpt: str) -> dict[str, Any]:
    return {
        "locator_type": "web_url_quote",
        "source_url": _clean_text(row.get("source_url"), 500),
        "canonical_url": _clean_text(row.get("canonical_url"), 500),
        "source_name": _clean_text(row.get("source_name"), 160),
        "provider": _clean_text(row.get("provider"), 120),
        "published_at": _clean_text(row.get("published_at"), 80),
        "captured_at": _clean_text(row.get("captured_at"), 80),
        "locator": _clean_text(row.get("locator"), 240),
        "quote": excerpt[:500],
    }


def _sentiment_provider(item: dict[str, Any]) -> str:
    location = item.get("evidence_location")
    if isinstance(location, dict):
        return _clean_text(location.get("provider"), 120)
    return ""


def _sentiment_relevance_score(item: dict[str, Any]) -> int:
    text = " ".join(
        str(item.get(key) or "")
        for key in ("title", "source_name", "source_ref", "content", "source_url")
    ).casefold()
    score = 0
    for term in (*_VALUATION_TERMS, *_SENTIMENT_RELEVANCE_TERMS):
        if str(term).casefold() in text:
            score += 2
    for term in _SENTIMENT_LOW_VALUE_TERMS:
        if str(term).casefold() in text:
            score -= 6
    if item.get("published_at"):
        score += 1
    if item.get("source_url"):
        score += 1
    return score


def _select_sentiment_excerpts(
    candidates: list[dict[str, Any]], *, limit: int = MAX_SENTIMENT_EVIDENCE
) -> list[dict[str, Any]]:
    if len(candidates) <= limit:
        return candidates

    def sort_key(item: dict[str, Any]) -> tuple[int, str, str]:
        return (
            int(item.get("relevance_score") or 0),
            _clean_text(item.get("published_at"), 80),
            _clean_text(item.get("evidence_id"), 160),
        )

    ranked = sorted(candidates, key=sort_key, reverse=True)
    selected: list[dict[str, Any]] = []
    selected_ids: set[str] = set()

    def add(item: dict[str, Any]) -> None:
        evidence_id = _clean_text(item.get("evidence_id"), 160)
        if len(selected) >= limit or not evidence_id or evidence_id in selected_ids:
            return
        selected.append(item)
        selected_ids.add(evidence_id)

    for provider in _SENTIMENT_BALANCED_PROVIDERS:
        provider_items = [item for item in ranked if _sentiment_provider(item) == provider]
        for item in provider_items[:_SENTIMENT_PROVIDER_MIN_QUOTA]:
            add(item)

    for item in ranked:
        add(item)

    return selected[:limit]


def _sentiment_provider_counts(items: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in items:
        provider = _sentiment_provider(item)
        if provider:
            counts[provider] = counts.get(provider, 0) + 1
    return dict(sorted(counts.items()))


def _sentiment_payloads(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    series_id: str,
    model_version_id: str,
    sentiment_adapter: SentimentEvidenceAdapter | None,
    sentiment_as_of: str | None,
    sentiment_lookback_days: int,
    sentiment_whitelist_hosts: list[str] | None,
) -> tuple[
    list[dict[str, Any]],
    dict[str, str],
    dict[str, dict[str, Any]],
    dict[str, dict[str, Any]],
    dict[str, Any],
]:
    as_of_dt = _parse_datetime(sentiment_as_of) or datetime.now(timezone.utc)
    as_of = as_of_dt.isoformat()
    stored = _stored_sentiment_rows(
        conn,
        dataset_id=dataset_id,
        series_id=series_id,
        model_version_id=model_version_id,
    )
    adapter_rows, adapter_error = _adapter_sentiment_rows(
        sentiment_adapter,
        dataset_id=dataset_id,
        series_id=series_id,
        model_version_id=model_version_id,
        as_of=as_of,
        lookback_days=sentiment_lookback_days,
    )
    candidate_excerpts: list[dict[str, Any]] = []
    sources: dict[str, str] = {}
    locations: dict[str, dict[str, Any]] = {}
    meta: dict[str, dict[str, Any]] = {}
    seen: set[str] = set()
    skipped = 0
    for row in [*stored, *adapter_rows]:
        url = _clean_text(row.get("source_url"), 500)
        excerpt = _clean_text(row.get("excerpt"), 700)
        captured_at = _clean_text(row.get("captured_at"), 80)
        if not url or not excerpt or not captured_at:
            skipped += 1
            continue
        whitelist_url = _clean_text(row.get("publisher_url"), 500) or url
        if not _is_whitelisted_url(whitelist_url, sentiment_whitelist_hosts):
            skipped += 1
            continue
        if not _sentiment_in_window(row, as_of_dt=as_of_dt, lookback_days=sentiment_lookback_days):
            skipped += 1
            continue
        raw_id = _clean_text(row.get("sentiment_id") or row.get("evidence_id"), 160)
        evidence_id = (
            raw_id
            if raw_id.startswith("sentiment:")
            else f"sentiment:{raw_id or _digest(url, excerpt, captured_at)}"
        )
        dedupe_key = f"{evidence_id}:{_digest(url, excerpt)}"
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        source_name = (
            _clean_text(row.get("source_name"), 160) or _url_host(url) or "sentiment source"
        )
        source_ref = f"{source_name} - {str(row.get('published_at') or captured_at)[:10]} - {url}"
        independence_key = _sentiment_independence_key(row)
        location = _sentiment_location(row, excerpt)
        item = {
            "evidence_id": evidence_id,
            "source_name": source_name,
            "source_type": _clean_text(row.get("source_type"), 80) or "provider_api",
            "source_url": url,
            "provider": location.get("provider", ""),
            "title": _clean_text(row.get("title"), 300),
            "published_at": _clean_text(row.get("published_at"), 80),
            "captured_at": captured_at,
            "source_ref": source_ref,
            "independence_key": independence_key,
            "evidence_location": location,
            "content": excerpt,
        }
        item["relevance_score"] = _sentiment_relevance_score(item)
        candidate_excerpts.append(item)

    excerpts = _select_sentiment_excerpts(candidate_excerpts)
    for item in excerpts:
        evidence_id = str(item["evidence_id"])
        sources[evidence_id] = str(item["source_ref"])
        location = item.get("evidence_location")
        locations[evidence_id] = location if isinstance(location, dict) else {}
        meta[evidence_id] = {
            "evidence_type": "sentiment",
            "independence_key": item["independence_key"],
            "source_url": item["source_url"],
        }

    summary = {
        "sentiment_as_of": as_of,
        "sentiment_lookback_days": sentiment_lookback_days,
        "sentiment_candidate_evidence_count": len(candidate_excerpts),
        "sentiment_evidence_count": len(excerpts),
        "sentiment_independent_source_count": len({item["independence_key"] for item in excerpts}),
        "sentiment_provider_counts": _sentiment_provider_counts(excerpts),
        "sentiment_candidate_provider_counts": _sentiment_provider_counts(candidate_excerpts),
        "sentiment_observations": excerpts,
        "sentiment_skipped_count": skipped,
    }
    if adapter_error:
        summary["sentiment_adapter_error"] = adapter_error
    return excerpts, sources, locations, meta, summary


def _review_for_card(
    *,
    confidence: float,
    valid_evidence: list[str],
    evidence_locations: list[dict[str, Any]],
    raw: dict[str, Any],
) -> tuple[str, list[str], dict[str, Any]]:
    reasons: list[str] = []
    if confidence < 0.6:
        reasons.append("confidence_below_review_threshold")
    if len(valid_evidence) < 2:
        reasons.append("single_source_or_single_excerpt")
    text = " ".join(
        str(raw.get(key) or "") for key in ("title", "evidence_summary", "valuation_impact")
    ).casefold()
    review_terms = (
        "management",
        "plan",
        "planned",
        "undelivered",
        "order",
        "unconfirmed",
        "管理层",
        "计划",
        "规划",
        "未交付",
        "订单",
        "待确认",
        "未确认",
    )
    if any(term in text for term in review_terms):
        reasons.append("forward_looking_or_management_only_evidence")
    if not evidence_locations:
        reasons.append("missing_precise_evidence_location")
    coverage = {
        "status": "located" if evidence_locations else "missing_precise_location",
        "evidence_count": len(valid_evidence),
        "located_evidence_count": len(evidence_locations),
        "document_ids": list(
            dict.fromkeys(
                str(item.get("document_id") or "")
                for item in evidence_locations
                if item.get("document_id")
            )
        ),
        "source_urls": list(
            dict.fromkeys(
                str(item.get("source_url") or "")
                for item in evidence_locations
                if item.get("source_url")
            )
        ),
        "locator_types": list(
            dict.fromkeys(str(item.get("locator_type") or "") for item in evidence_locations)
        ),
    }
    return ("needs_review" if reasons else "ready"), reasons, coverage


def build_evidence_packet(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    series_id: str,
    model_version_id: str,
    document_ids: list[str] | None = None,
    sentiment_adapter: SentimentEvidenceAdapter | None = None,
    sentiment_as_of: str | None = None,
    sentiment_lookback_days: int = DEFAULT_SENTIMENT_LOOKBACK_DAYS,
    sentiment_whitelist_hosts: list[str] | None = None,
) -> tuple[
    dict[str, Any], dict[str, str], dict[str, dict[str, Any]], dict[str, dict[str, Any]], str
]:
    documents = _supporting_documents(conn, dataset_id=dataset_id, document_ids=document_ids)
    excerpts: list[dict[str, Any]] = []
    evidence_sources: dict[str, str] = {}
    evidence_locations: dict[str, dict[str, Any]] = {}
    evidence_meta: dict[str, dict[str, Any]] = {}
    unlocatable_documents: dict[str, dict[str, Any]] = {}
    total_chunks = 0
    total_chars = 0
    for document in documents:
        filename = str(document.get("original_filename") or "supporting document")
        ranked_chunks = _ranked_chunks(_chunk_rows(conn, str(document["doc_id"])))
        total_chunks += len(ranked_chunks)
        located_for_document = 0
        for chunk in ranked_chunks:
            content = _clean_text(chunk.get("content") or chunk.get("summary"), 700)
            if not content or total_chars + len(content) > MAX_TOTAL_CHARS:
                continue
            source_ref = _clean_text(chunk.get("source_ref"), 240)
            source_ref = source_ref or f"{filename} · chunk {chunk.get('chunk_index', '')}"
            location = _evidence_location(document=document, chunk=chunk, source_ref=source_ref)
            if location is None:
                continue
            located_for_document += 1
            evidence_id = f"chunk:{chunk['chunk_id']}"
            excerpts.append(
                {
                    "evidence_id": evidence_id,
                    "document_id": f"document:{document['doc_id']}",
                    "document_version_no": int(document.get("version_no") or 1),
                    "source_name": filename,
                    "document_type": str(
                        document.get("doc_subtype") or document.get("doc_type") or ""
                    ),
                    "document_date": str(document.get("document_date") or ""),
                    "source_ref": source_ref,
                    "evidence_location": location,
                    "content": content,
                }
            )
            evidence_sources[evidence_id] = source_ref
            evidence_locations[evidence_id] = location
            evidence_meta[evidence_id] = {
                "evidence_type": "document_chunk",
                "independence_key": str(document.get("doc_id") or ""),
            }
            total_chars += len(content)
        if ranked_chunks and located_for_document == 0:
            unlocatable_documents[str(document.get("doc_id") or "")] = {
                **_document_version_payload(document),
                "reason": "未满足证据定位要求",
            }
    (
        sentiment_excerpts,
        sentiment_sources,
        sentiment_locations,
        sentiment_meta,
        sentiment_summary,
    ) = _sentiment_payloads(
        conn,
        dataset_id=dataset_id,
        series_id=series_id,
        model_version_id=model_version_id,
        sentiment_adapter=sentiment_adapter,
        sentiment_as_of=sentiment_as_of,
        sentiment_lookback_days=sentiment_lookback_days,
        sentiment_whitelist_hosts=sentiment_whitelist_hosts,
    )
    excerpts.extend(sentiment_excerpts)
    evidence_sources.update(sentiment_sources)
    evidence_locations.update(sentiment_locations)
    evidence_meta.update(sentiment_meta)
    document_versions = [_document_version_payload(document) for document in documents]
    coverage_summary = {
        "selection_scope": _selection_scope(document_ids),
        "selected_document_count": len(documents),
        "candidate_chunk_count": total_chunks,
        "usable_evidence_count": len(excerpts),
        "unlocatable_documents": list(unlocatable_documents.values()),
        "needs_reparse_count": len(unlocatable_documents),
        **sentiment_summary,
    }
    source_fingerprint = _digest(
        _json(_selection_scope(document_ids)),
        *(
            f"{item['document_id']}:{item['version_no']}:{item['checksum']}"
            for item in document_versions
        ),
        *(
            f"{item['evidence_id']}:{_digest(item['content'])}:{_json(item['evidence_location'])}"
            for item in excerpts
        ),
        _json({key: value.get("independence_key") for key, value in evidence_meta.items()}),
        length=40,
    )
    packet = {
        "dataset_id": dataset_id,
        "series_id": series_id,
        "model_version_id": model_version_id,
        "extractor_version": EXTRACTOR_VERSION,
        "selection_scope": _selection_scope(document_ids),
        "document_versions": document_versions,
        "coverage_summary": coverage_summary,
        "model_context": _model_context(conn, model_version_id),
        "supporting_documents": [
            {
                "evidence_id": f"document:{document['doc_id']}",
                "source_name": str(document.get("original_filename") or ""),
                "document_type": str(
                    document.get("doc_subtype") or document.get("doc_type") or ""
                ),
                "document_date": str(document.get("document_date") or ""),
                "version_no": int(document.get("version_no") or 1),
            }
            for document in documents
        ],
        "evidence_excerpts": excerpts,
    }
    return packet, evidence_sources, evidence_locations, evidence_meta, source_fingerprint


def _parse_json_object(text: str) -> dict[str, Any]:
    candidate = str(text or "").strip()
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", candidate, flags=re.IGNORECASE)
    if fenced:
        candidate = fenced.group(1).strip()
    try:
        payload = json.loads(candidate)
    except json.JSONDecodeError:
        start = candidate.find("{")
        end = candidate.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("Agent response did not contain a JSON object") from None
        payload = json.loads(candidate[start : end + 1])
    if not isinstance(payload, dict):
        raise ValueError("Agent response must be a JSON object")
    return payload


def _chat_json(
    llm_client: ValuationImpactChatClient,
    messages: list[dict[str, str]],
) -> tuple[dict[str, Any], str]:
    raw = _request_valuation_impacts(llm_client, messages)
    try:
        return _parse_json_object(raw), raw
    except (ValueError, json.JSONDecodeError):
        repaired = _request_valuation_impacts(
            llm_client,
            [
                {
                    "role": "system",
                    "content": (
                        "Repair the response into one valid JSON object matching the requested "
                        "schema. Return JSON only and do not invent or replace evidence IDs."
                    ),
                },
                {"role": "user", "content": raw[:120_000]},
            ],
        )
        return _parse_json_object(repaired), repaired


def validate_output(
    payload: dict[str, Any],
    *,
    evidence_sources: dict[str, str],
    evidence_locations: dict[str, dict[str, Any]] | None = None,
    evidence_meta: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    evidence_locations = evidence_locations or {}
    evidence_meta = evidence_meta or {}
    warnings = [
        _clean_text(item, 500) for item in payload.get("warnings", []) if _clean_text(item, 500)
    ]
    impacts: list[dict[str, Any]] = []
    titles: set[str] = set()
    raw_impacts = payload.get("impacts") if isinstance(payload.get("impacts"), list) else []
    for ordinal, raw in enumerate(raw_impacts[:8], 1):
        if not isinstance(raw, dict):
            warnings.append(f"第 {ordinal} 项不是对象，已忽略。")
            continue
        direction = str(raw.get("direction") or "")
        confidence = _safe_float(raw.get("confidence"))
        title = _clean_text(raw.get("title"), 120)
        title_key = title.casefold()
        evidence_summary = _clean_text(raw.get("evidence_summary"), 800)
        valuation_impact = _clean_text(raw.get("valuation_impact"), 800)
        submitted_evidence = [str(item) for item in raw.get("evidence_ids") or []]
        valid_evidence = [item for item in submitted_evidence if item in evidence_sources]
        affected_inputs = list(
            dict.fromkeys(
                str(item)
                for item in raw.get("affected_inputs") or []
                if str(item) in _AFFECTED_INPUTS
            )
        )[:6]
        watch_items = list(
            dict.fromkeys(
                _clean_text(item, 180)
                for item in raw.get("watch_items") or []
                if _clean_text(item, 180)
            )
        )[:6]
        valid = (
            direction in _DIRECTIONS
            and confidence is not None
            and 0.35 <= confidence <= 1.0
            and len(title) >= 4
            and title_key not in titles
            and len(evidence_summary) >= 12
            and len(valuation_impact) >= 12
            and bool(affected_inputs)
            and bool(watch_items)
            and bool(valid_evidence)
            and len(valid_evidence) == len(submitted_evidence)
        )
        if not valid:
            warnings.append(f"估值影响“{title or ordinal}”未通过结构或证据校验，已忽略。")
            continue
        sentiment_ids = [item for item in valid_evidence if item.startswith("sentiment:")]
        if sentiment_ids:
            independent_sentiment = {
                str((evidence_meta.get(item) or {}).get("independence_key") or item)
                for item in sentiment_ids
                if item in evidence_locations
            }
            if len(sentiment_ids) < 2 or len(independent_sentiment) < 2:
                warnings.append(
                    f"\u8206\u60c5\u5f71\u54cd\u201c{title or ordinal}\u201d"
                    "\u5c11\u4e8e\u4e24\u6761\u72ec\u7acb\u3001\u53ef\u5b9a\u4f4d\u8bc1\u636e\uff0c"
                    "\u5df2\u4fdd\u7559\u4e3a\u89c2\u5bdf\u4f46\u4e0d\u751f\u6210\u5f71\u54cd\u5361\u3002"
                )
                continue
        titles.add(title_key)
        locations = [
            evidence_locations[item] for item in valid_evidence if item in evidence_locations
        ]
        review_status, review_reasons, evidence_coverage = _review_for_card(
            confidence=confidence,
            valid_evidence=valid_evidence,
            evidence_locations=locations,
            raw=raw,
        )
        impacts.append(
            {
                "ordinal": len(impacts) + 1,
                "direction": direction,
                "horizon": _clean_text(raw.get("horizon"), 80) or "待验证",
                "confidence": confidence,
                "title": title,
                "evidence_summary": evidence_summary,
                "valuation_impact": valuation_impact,
                "affected_inputs": affected_inputs,
                "watch_items": watch_items,
                "source_refs": list(
                    dict.fromkeys(evidence_sources[item] for item in valid_evidence)
                ),
                "evidence_ids": list(dict.fromkeys(valid_evidence)),
                "evidence_locations": locations,
                "review_status": review_status,
                "review_reasons": review_reasons,
                "evidence_coverage": evidence_coverage,
            }
        )
    return {
        "analysis_summary": _clean_text(payload.get("analysis_summary"), 500),
        "impacts": impacts,
        "warnings": list(dict.fromkeys(warnings)),
    }


def _run_payload(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    payload = dict(row)
    formatted = _decode(payload.pop("output_json", None), {})
    payload["analysis_summary"] = str(formatted.get("analysis_summary") or "")
    payload["warnings"] = list(formatted.get("warnings") or [])
    payload["document_versions"] = _decode(payload.pop("document_versions_json", None), [])
    payload["selection_scope"] = _decode(payload.pop("selection_scope_json", None), {})
    payload["coverage_summary"] = _decode(payload.pop("coverage_summary_json", None), {})
    payload.pop("raw_response", None)
    cards = []
    for card_row in conn.execute(
        "SELECT * FROM valuation_impact_cards WHERE run_id=? ORDER BY ordinal",
        (payload["run_id"],),
    ):
        card = dict(card_row)
        card["affected_inputs"] = _decode(card.pop("affected_inputs_json"), [])
        card["watch_items"] = _decode(card.pop("watch_items_json"), [])
        card["source_refs"] = _decode(card.pop("source_refs_json"), [])
        card["evidence_ids"] = _decode(card.pop("evidence_ids_json"), [])
        card["evidence_locations"] = _decode(card.pop("evidence_locations_json", None), [])
        card["review_reasons"] = _decode(card.pop("review_reasons_json", None), [])
        card["evidence_coverage"] = _decode(card.pop("evidence_coverage_json", None), {})
        cards.append(card)
    payload["cards"] = cards
    return payload


def latest_impact_payload(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    model_version_id: str,
) -> dict[str, Any]:
    ensure_impact_schema(conn)
    row = conn.execute(
        """
        SELECT * FROM valuation_impact_agent_runs
        WHERE dataset_id=? AND model_version_id=?
        ORDER BY updated_at DESC LIMIT 1
        """,
        (dataset_id, model_version_id),
    ).fetchone()
    if row is None:
        return {
            "run_id": "",
            "status": "pending",
            "source_fingerprint": "",
            "extractor_version": EXTRACTOR_VERSION,
            "skill_name": SKILL_NAME,
            "analysis_summary": "",
            "warnings": [],
            "document_versions": [],
            "selection_scope": _selection_scope(None),
            "coverage_summary": {},
            "cards": [],
            "error_message": "等待基于项目资料生成估值影响。",
            "updated_at": "",
        }
    return _run_payload(conn, row)


def _fallback_source_cards(
    packet: dict[str, Any],
    evidence_sources: dict[str, str],
    evidence_locations: dict[str, dict[str, Any]],
    *,
    error: str,
) -> dict[str, Any]:
    """Create conservative, source-cited cards when the LLM gateway is unavailable."""

    impacts: list[dict[str, Any]] = []
    for excerpt in (packet.get("evidence_excerpts") or [])[:3]:
        if not isinstance(excerpt, dict):
            continue
        evidence_id = str(excerpt.get("evidence_id") or "")
        if evidence_id.startswith("sentiment:"):
            continue
        if evidence_id not in evidence_sources:
            continue
        source_name = _clean_text(excerpt.get("source_name"), 80) or "辅助资料"
        evidence_text = _clean_text(excerpt.get("content"), 500)
        if not evidence_text:
            continue
        impacts.append(
            {
                "ordinal": len(impacts) + 1,
                "direction": "mixed",
                "horizon": "待核验",
                "confidence": 0.4,
                "title": f"{source_name}：估值影响待核验",
                "evidence_summary": evidence_text,
                "valuation_impact": (
                    "该卡片由已上传资料的原文片段自动生成。需结合模型假设核验其对"
                    "收入增长、毛利率、现金流或估值倍数的实际影响。"
                ),
                "affected_inputs": ["revenue_growth", "gross_margin", "valuation_multiple"],
                "watch_items": ["核验资料事件对估值假设的传导路径和量化影响。"],
                "source_refs": [evidence_sources[evidence_id]],
                "evidence_ids": [evidence_id],
                "evidence_locations": [evidence_locations[evidence_id]]
                if evidence_id in evidence_locations
                else [],
                "review_status": "needs_review",
                "review_reasons": ["llm_unavailable_fallback", "requires_human_validation"],
                "evidence_coverage": {
                    "status": "located"
                    if evidence_id in evidence_locations
                    else "missing_precise_location",
                    "evidence_count": 1,
                    "located_evidence_count": 1 if evidence_id in evidence_locations else 0,
                    "document_ids": [str(evidence_locations[evidence_id].get("document_id") or "")]
                    if evidence_id in evidence_locations
                    else [],
                    "locator_types": [
                        str(evidence_locations[evidence_id].get("locator_type") or "")
                    ]
                    if evidence_id in evidence_locations
                    else [],
                },
            }
        )
    return {
        "analysis_summary": "LLM 网关暂不可用，已生成仅基于项目资料原文的待核验证据卡片。",
        "impacts": impacts,
        "warnings": [f"LLM Agent unavailable: {_clean_text(error, 300)}"],
    }


def _fallback_sentiment_card(
    packet: dict[str, Any],
    evidence_sources: dict[str, str],
    evidence_locations: dict[str, dict[str, Any]],
    evidence_meta: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    sentiment = [
        item
        for item in packet.get("evidence_excerpts") or []
        if isinstance(item, dict)
        and str(item.get("evidence_id") or "").startswith("sentiment:")
        and str(item.get("evidence_id") or "") in evidence_sources
        and str(item.get("evidence_id") or "") in evidence_locations
    ]
    independent = {
        str((evidence_meta.get(str(item.get("evidence_id") or "")) or {}).get("independence_key"))
        for item in sentiment
    }
    if len(sentiment) < 2 or len(independent) < 2:
        return None
    picked = sentiment[:3]
    evidence_ids = [str(item["evidence_id"]) for item in picked]
    return {
        "ordinal": 1,
        "direction": "mixed",
        "horizon": "待核验",
        "confidence": 0.6,
        "title": "公开舆情形成双向估值观察",
        "evidence_summary": "；".join(_clean_text(item.get("content"), 220) for item in picked),
        "valuation_impact": (
            "多条独立公开舆情显示市场关注度、资金流或机构观点已发生变化。该信号可影响"
            "估值倍数和情绪折价，但尚不足以直接改写收入、利润率或现金流假设。"
        ),
        "affected_inputs": ["valuation_multiple", "revenue_growth"],
        "watch_items": ["持续跟踪是否出现财务指引、订单、利润率或现金流层面的交叉验证。"],
        "source_refs": [evidence_sources[item] for item in evidence_ids],
        "evidence_ids": evidence_ids,
        "evidence_locations": [evidence_locations[item] for item in evidence_ids],
        "review_status": "needs_review",
        "review_reasons": ["sentiment_only_requires_fundamental_cross_check"],
        "evidence_coverage": {
            "status": "located",
            "evidence_count": len(evidence_ids),
            "located_evidence_count": len(evidence_ids),
            "source_urls": list(
                dict.fromkeys(
                    str(evidence_locations[item].get("source_url") or "") for item in evidence_ids
                )
            ),
            "locator_types": ["web_url_quote"],
        },
    }


def _insert_cards(
    conn: sqlite3.Connection,
    *,
    run_id: str,
    dataset_id: str,
    series_id: str,
    model_version_id: str,
    source_fingerprint: str,
    cards: list[dict[str, Any]],
    created_at: str,
) -> None:
    for card in cards:
        card_id = "viac_" + _digest(run_id, card["ordinal"], card["title"])
        conn.execute(
            """
            INSERT INTO valuation_impact_cards
                (card_id, run_id, dataset_id, series_id, model_version_id,
                 source_fingerprint, ordinal, direction, horizon, confidence, title,
                 evidence_summary, valuation_impact, affected_inputs_json,
                 watch_items_json, source_refs_json, evidence_ids_json,
                 evidence_locations_json, review_status, review_reasons_json,
                 evidence_coverage_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                card_id,
                run_id,
                dataset_id,
                series_id,
                model_version_id,
                source_fingerprint,
                card["ordinal"],
                card["direction"],
                card["horizon"],
                card["confidence"],
                card["title"],
                card["evidence_summary"],
                card["valuation_impact"],
                _json(card["affected_inputs"]),
                _json(card["watch_items"]),
                _json(card["source_refs"]),
                _json(card["evidence_ids"]),
                _json(card.get("evidence_locations") or []),
                str(card.get("review_status") or "needs_review"),
                _json(card.get("review_reasons") or []),
                _json(card.get("evidence_coverage") or {}),
                created_at,
            ),
        )


def _insert_run(
    conn: sqlite3.Connection,
    *,
    run_id: str,
    dataset_id: str,
    series_id: str,
    model_version_id: str,
    source_fingerprint: str,
    status: str,
    formatted: dict[str, Any],
    packet: dict[str, Any],
    raw_response: str | None,
    error_message: str | None,
    created_at: str,
) -> None:
    conn.execute(
        """
        INSERT INTO valuation_impact_agent_runs
            (run_id, dataset_id, series_id, model_version_id, source_fingerprint,
             extractor_version, skill_name, status, card_count, output_json,
             document_versions_json, selection_scope_json, coverage_summary_json,
             raw_response, error_message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            run_id,
            dataset_id,
            series_id,
            model_version_id,
            source_fingerprint,
            EXTRACTOR_VERSION,
            SKILL_NAME,
            status,
            len(formatted.get("impacts") or []),
            _json(formatted),
            _json(packet.get("document_versions") or []),
            _json(packet.get("selection_scope") or {}),
            _json(packet.get("coverage_summary") or {}),
            (raw_response or "")[:500_000] or None,
            (error_message or "")[:2_000] or None,
            created_at,
            created_at,
        ),
    )


def extract_with_skill(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    series_id: str,
    model_version_id: str,
    llm_client: ValuationImpactChatClient,
    document_ids: list[str] | None = None,
    sentiment_adapter: SentimentEvidenceAdapter | None = None,
    sentiment_as_of: str | None = None,
    sentiment_lookback_days: int = DEFAULT_SENTIMENT_LOOKBACK_DAYS,
    sentiment_whitelist_hosts: list[str] | None = None,
    locale: str = "zh-CN",
) -> dict[str, Any]:
    from omnigent.server.private_fund_memory import read_current_user_memory

    ensure_impact_schema(conn)
    packet, evidence_sources, evidence_locations, evidence_meta, source_fingerprint = (
        build_evidence_packet(
            conn,
            dataset_id=dataset_id,
            series_id=series_id,
            model_version_id=model_version_id,
            document_ids=document_ids,
            sentiment_adapter=sentiment_adapter,
            sentiment_as_of=sentiment_as_of,
            sentiment_lookback_days=sentiment_lookback_days,
            sentiment_whitelist_hosts=sentiment_whitelist_hosts,
        )
    )
    now = _now_iso()
    run_id = "viar_" + _digest(
        model_version_id,
        source_fingerprint,
        EXTRACTOR_VERSION,
        _json(packet.get("selection_scope") or {}),
        now,
        length=32,
    )
    excerpts = packet.get("evidence_excerpts") or []
    if not excerpts:
        english = locale == "en-US"
        formatted = {
            "analysis_summary": (
                "No supporting excerpts satisfy the precise evidence-location requirements."
                if english
                else "当前项目没有满足精确证据定位要求的辅助资料片段。"
            ),
            "impacts": [],
            "warnings": [
                (
                    "Sources that failed evidence-location checks are listed in coverage; reparse them before generating usable impact cards."
                    if english
                    else "未满足证据定位要求的资料已列入覆盖度摘要，需补充解析后才能生成可用影响卡。"
                )
            ] if (packet.get("coverage_summary") or {}).get("needs_reparse_count") else [],
        }
        _insert_run(
            conn,
            run_id=run_id,
            dataset_id=dataset_id,
            series_id=series_id,
            model_version_id=model_version_id,
            source_fingerprint=source_fingerprint,
            status="no_evidence",
            formatted=formatted,
            packet=packet,
            raw_response=None,
            error_message=None,
            created_at=now,
        )
        row = conn.execute(
            "SELECT * FROM valuation_impact_agent_runs WHERE run_id=?", (run_id,)
        ).fetchone()
        if row is None:
            raise RuntimeError("valuation impact no-evidence run was not persisted")
        return _run_payload(conn, row)

    skill = _SKILL_PATH.read_text(encoding="utf-8")
    schema = json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
    messages = [
        {
            "role": "system",
            "content": (
                f"Apply the following skill exactly.\n\n{skill}\n\n"
                f"{read_current_user_memory(fallback_locale=locale)}\n\n"
                "Return one JSON object only, with no Markdown or prose. "
                "The required root keys are analysis_summary, impacts, and warnings. "
                "Minimal JSON example: "
                '{"analysis_summary":"","impacts":[],"warnings":[]}.\n'
                "Its JSON Schema is:\n"
                f"{json.dumps(schema, ensure_ascii=False)}"
            ),
        },
        {
            "role": "user",
            "content": (
                "Generate distinct valuation-impact cards from the current supporting "
                "documents and supplied sentiment observations. Use no outside facts "
                "and cite only "
                "supplied chunk: or sentiment: IDs. Do not synthesize a single net direction "
                "unless explicit auditable quantitative assumptions are present. "
                "Treat one-source sentiment as observation only.\n"
                + json.dumps(packet, ensure_ascii=False)
            ),
        },
    ]
    raw_response = ""
    try:
        raw_payload, raw_response = _chat_json(llm_client, messages)
        formatted = validate_output(
            raw_payload,
            evidence_sources=evidence_sources,
            evidence_locations=evidence_locations,
            evidence_meta=evidence_meta,
        )
        if not formatted["impacts"]:
            sentiment_fallback = _fallback_sentiment_card(
                packet, evidence_sources, evidence_locations, evidence_meta
            )
            if sentiment_fallback is not None:
                formatted["impacts"] = [sentiment_fallback]
                formatted["warnings"].append(
                    "LLM 未生成正式影响卡，已基于两条以上独立、可定位舆情保留双向影响卡。"
                )
        status = "completed"
        error_message = None
    except Exception as exc:  # noqa: BLE001 - retain a conservative evidence fallback
        formatted = _fallback_source_cards(
            packet,
            evidence_sources,
            evidence_locations,
            error=str(exc),
        )
        status = "partial" if formatted["impacts"] else "failed"
        error_message = str(exc)
    _insert_cards(
        conn,
        run_id=run_id,
        dataset_id=dataset_id,
        series_id=series_id,
        model_version_id=model_version_id,
        source_fingerprint=source_fingerprint,
        cards=formatted["impacts"],
        created_at=now,
    )
    _insert_run(
        conn,
        run_id=run_id,
        dataset_id=dataset_id,
        series_id=series_id,
        model_version_id=model_version_id,
        source_fingerprint=source_fingerprint,
        status=status,
        formatted=formatted,
        packet=packet,
        raw_response=raw_response,
        error_message=error_message,
        created_at=now,
    )
    row = conn.execute(
        "SELECT * FROM valuation_impact_agent_runs WHERE run_id=?", (run_id,)
    ).fetchone()
    if row is None:
        raise RuntimeError("valuation impact Agent run was not persisted")
    return _run_payload(conn, row)


__all__ = [
    "DEFAULT_SENTIMENT_LOOKBACK_DAYS",
    "EXTRACTOR_VERSION",
    "SKILL_NAME",
    "CompositeSentimentEvidenceAdapter",
    "GoogleNewsRssSentimentAdapter",
    "IfindReportQuerySentimentAdapter",
    "SentimentEvidenceAdapter",
    "build_evidence_packet",
    "default_sentiment_adapter",
    "ensure_impact_schema",
    "extract_with_skill",
    "latest_impact_payload",
    "validate_output",
]
