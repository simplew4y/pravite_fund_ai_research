"""Five-metric valuation model versus market-data comparison.

The valuation workbook remains immutable evidence.  This module reads the
facts produced by the ingest pipeline, derives exactly five decision metrics,
fetches matching observations through a configurable market-data provider,
and persists an auditable comparison snapshot.  Missing provider data is
represented explicitly; trailing P/E is never substituted for Forward P/E.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sqlite3
import threading
import time
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from queue import Empty, Queue
from typing import Any, Protocol

import httpx

from omnigent.server import (
    private_fund_valuation_impact_agent,
    private_fund_valuation_metric_agent,
)

METRIC_SCHEMA_VERSION = 3
METRIC_ANALYZER_VERSION = "valuation-five-metrics-v2"


@dataclass(frozen=True)
class MetricDefinition:
    key: str
    label: str
    unit: str
    gap_mode: str
    warning_threshold: float
    critical_threshold: float
    description: str


METRIC_DEFINITIONS: tuple[MetricDefinition, ...] = (
    MetricDefinition(
        "quarter_net_profit_yoy",
        "单季净利润增速",
        "percent",
        "absolute",
        0.10,
        0.20,
        "本季度归母净利润相对上年同季度的增速",
    ),
    MetricDefinition(
        "quarter_gross_margin_qoq_delta",
        "单季毛利率环比变化",
        "percentage_point",
        "absolute",
        0.01,
        0.02,
        "本季度毛利率减去上一季度毛利率",
    ),
    MetricDefinition(
        "forward_pe",
        "Forward PE",
        "multiple",
        "relative",
        0.15,
        0.30,
        "当前价格或市值相对未来十二个月一致预期盈利的倍数",
    ),
    MetricDefinition(
        "avg_turnover_amount_20d",
        "近20日日均成交额",
        "currency",
        "relative",
        0.20,
        0.40,
        "最近二十个完整交易日成交额的算术平均值",
    ),
    MetricDefinition(
        "quarter_revenue_growth_qoq",
        "单季营收增速环比",
        "percentage_point",
        "absolute",
        0.10,
        0.20,
        "本季度营收同比增速减去上一季度营收同比增速",
    ),
)
METRIC_BY_KEY = {item.key: item for item in METRIC_DEFINITIONS}
METRIC_KEYS = tuple(item.key for item in METRIC_DEFINITIONS)
QUARTERLY_COMPARISON_KEYS = frozenset(
    {
        "quarter_net_profit_yoy",
        "quarter_gross_margin_qoq_delta",
        "quarter_revenue_growth_qoq",
    }
)
QUARTERLY_METRIC_DEFINITIONS = tuple(
    item for item in METRIC_DEFINITIONS if item.key in QUARTERLY_COMPARISON_KEYS
)
MARKET_METRIC_DEFINITIONS = tuple(
    item for item in METRIC_DEFINITIONS if item.key not in QUARTERLY_COMPARISON_KEYS
)
VALUATION_MODEL_SUBTYPES = frozenset(
    {
        "dcf_model",
        "comparable_company_model",
        "financial_forecast_model",
        "integrated_valuation_model",
    }
)


class MarketDataProvider(Protocol):
    name: str

    def fetch_metrics(self, *, company_name: str, ticker: str) -> dict[str, Any]: ...



def _now() -> datetime:
    return datetime.now(timezone.utc)


def _now_iso() -> str:
    return _now().isoformat()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _decode(value: Any, default: Any) -> Any:
    if value in (None, ""):
        return default
    try:
        return json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return default


def _digest(*parts: Any, length: int = 28) -> str:
    raw = "\0".join(str(part or "") for part in parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:length]


def _safe_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _market_data_trust_env_proxy() -> bool:
    """Opt in to process proxy variables for public market-data HTTP calls."""

    return os.getenv("PRIVATE_FUND_MARKET_TRUST_ENV_PROXY", "0").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _normalize(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().casefold()
    text = text.replace("_", " ").replace("/", " ")
    text = re.sub(r"[^a-z0-9%\u3400-\u9fff.-]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def ensure_metric_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS valuation_metric_model_values (
            model_metric_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            series_id TEXT NOT NULL,
            model_version_id TEXT NOT NULL,
            metric_key TEXT NOT NULL,
            value_numeric REAL,
            unit TEXT NOT NULL,
            period TEXT,
            status TEXT NOT NULL,
            method TEXT NOT NULL,
            source TEXT,
            evidence_ids_json TEXT NOT NULL DEFAULT '[]',
            quality_status TEXT NOT NULL DEFAULT 'review_required',
            created_at TEXT NOT NULL,
            UNIQUE(model_version_id, metric_key)
        );

        CREATE TABLE IF NOT EXISTS valuation_metric_manual_overrides (
            override_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            series_id TEXT NOT NULL,
            model_version_id TEXT NOT NULL,
            metric_key TEXT NOT NULL,
            value_numeric REAL NOT NULL,
            unit TEXT NOT NULL,
            period TEXT NOT NULL,
            method TEXT NOT NULL DEFAULT 'manual_override:source_verified',
            source TEXT NOT NULL,
            evidence_ids_json TEXT NOT NULL DEFAULT '[]',
            derivation TEXT NOT NULL,
            quality_status TEXT NOT NULL DEFAULT 'manual_verified',
            reviewer TEXT NOT NULL,
            review_note TEXT NOT NULL DEFAULT '',
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(model_version_id, metric_key)
        );

        CREATE TABLE IF NOT EXISTS valuation_market_snapshots (
            snapshot_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            series_id TEXT NOT NULL,
            model_version_id TEXT NOT NULL,
            company_name TEXT,
            company_ticker TEXT,
            provider TEXT NOT NULL,
            status TEXT NOT NULL,
            as_of TEXT,
            error_message TEXT,
            raw_json TEXT NOT NULL DEFAULT '{}',
            identity_snapshot_json TEXT NOT NULL DEFAULT '{}',
            is_stale INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS valuation_metric_actual_values (
            actual_metric_id TEXT PRIMARY KEY,
            snapshot_id TEXT NOT NULL,
            dataset_id TEXT NOT NULL,
            series_id TEXT NOT NULL,
            model_version_id TEXT NOT NULL,
            metric_key TEXT NOT NULL,
            value_numeric REAL,
            unit TEXT NOT NULL,
            period TEXT,
            status TEXT NOT NULL,
            source TEXT,
            observed_at TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            UNIQUE(snapshot_id, metric_key)
        );

        CREATE TABLE IF NOT EXISTS valuation_metric_comparisons (
            comparison_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            series_id TEXT NOT NULL,
            model_version_id TEXT NOT NULL,
            snapshot_id TEXT NOT NULL,
            metric_key TEXT NOT NULL,
            model_value REAL,
            actual_value REAL,
            absolute_gap REAL,
            relative_gap REAL,
            severity TEXT NOT NULL,
            status TEXT NOT NULL,
            explanation TEXT NOT NULL,
            model_period TEXT,
            actual_period TEXT,
            model_source TEXT,
            actual_source TEXT,
            evidence_ids_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            UNIQUE(model_version_id, snapshot_id, metric_key)
        );

        CREATE TABLE IF NOT EXISTS valuation_context_cards (
            card_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            model_version_id TEXT NOT NULL,
            source_doc_id TEXT NOT NULL,
            card_type TEXT NOT NULL,
            title TEXT NOT NULL,
            summary TEXT NOT NULL,
            insight TEXT NOT NULL,
            source_name TEXT NOT NULL,
            document_date TEXT,
            evidence_ids_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            UNIQUE(model_version_id, source_doc_id)
        );


        CREATE INDEX IF NOT EXISTS ix_valuation_metric_comparison_latest
            ON valuation_metric_comparisons(series_id, model_version_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS ix_valuation_metric_manual_override_version
            ON valuation_metric_manual_overrides(model_version_id, is_active, updated_at DESC);
        CREATE INDEX IF NOT EXISTS ix_valuation_market_snapshot_latest
            ON valuation_market_snapshots(series_id, model_version_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS ix_valuation_context_cards_version
            ON valuation_context_cards(model_version_id, created_at DESC);
        """
    )
    snapshot_columns = {
        str(row[1]) for row in conn.execute("PRAGMA table_info(valuation_market_snapshots)")
    }
    for column_name, definition in (
        ("identity_snapshot_json", "TEXT NOT NULL DEFAULT '{}'"),
        ("is_stale", "INTEGER NOT NULL DEFAULT 0"),
    ):
        if column_name not in snapshot_columns:
            conn.execute(
                f"ALTER TABLE valuation_market_snapshots ADD COLUMN {column_name} {definition}"
            )
    private_fund_valuation_metric_agent.ensure_agent_extraction_schema(conn)
    private_fund_valuation_impact_agent.ensure_impact_schema(conn)


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            (table_name,),
        ).fetchone()
        is not None
    )


def _manual_evidence_exists(conn: sqlite3.Connection, evidence_id: str) -> bool:
    prefix, separator, raw_id = evidence_id.partition(":")
    if not separator or not raw_id:
        return False
    table_and_column = {
        "fact": ("metric_facts", "fact_id"),
        "cell": ("excel_cells", "cell_id"),
        "document": ("documents", "doc_id"),
    }.get(prefix)
    if table_and_column is None:
        return False
    table_name, column_name = table_and_column
    if not _table_exists(conn, table_name):
        return False
    return (
        conn.execute(
            f"SELECT 1 FROM {table_name} WHERE {column_name}=? LIMIT 1",
            (raw_id,),
        ).fetchone()
        is not None
    )


def _manual_value_is_plausible(metric_key: str, value: float) -> bool:
    if metric_key == "forward_pe":
        return 0.0 < value < 2000.0
    if metric_key == "avg_turnover_amount_20d":
        return value >= 0.0
    return -10.0 <= value <= 10.0


def upsert_manual_metric_override(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    series_id: str,
    model_version_id: str,
    metric_key: str,
    value_numeric: float,
    period: str,
    source: str,
    evidence_ids: list[str],
    derivation: str,
    reviewer: str,
    review_note: str = "",
    quality_status: str = "manual_verified",
) -> dict[str, Any]:
    """Persist a source-backed manual value that survives comparison refreshes."""

    ensure_metric_schema(conn)
    if metric_key not in METRIC_BY_KEY:
        raise ValueError(f"unsupported valuation metric: {metric_key}")
    value = _safe_float(value_numeric)
    if value is None or not _manual_value_is_plausible(metric_key, value):
        raise ValueError(f"implausible manual value for {metric_key}")
    if not str(period or "").strip():
        raise ValueError("manual metric period is required")
    if not str(source or "").strip():
        raise ValueError("manual metric source is required")
    if not str(derivation or "").strip():
        raise ValueError("manual metric derivation is required")
    if not str(reviewer or "").strip():
        raise ValueError("manual metric reviewer is required")
    if quality_status not in {"manual_verified", "manual_verified_with_caveat"}:
        raise ValueError("unsupported manual metric quality status")
    evidence = list(dict.fromkeys(str(item) for item in evidence_ids if str(item).strip()))
    minimum_evidence = {
        "quarter_net_profit_yoy": 2,
        "quarter_gross_margin_qoq_delta": 2,
        "forward_pe": 1,
        "avg_turnover_amount_20d": 1,
        "quarter_revenue_growth_qoq": 4,
    }[metric_key]
    if len(evidence) < minimum_evidence:
        raise ValueError(f"insufficient manual evidence for {metric_key}")
    missing_evidence = [
        evidence_id for evidence_id in evidence if not _manual_evidence_exists(conn, evidence_id)
    ]
    if missing_evidence:
        raise ValueError(f"unresolved manual evidence: {', '.join(missing_evidence)}")
    version = conn.execute(
        "SELECT dataset_id, series_id FROM valuation_model_versions WHERE model_version_id=?",
        (model_version_id,),
    ).fetchone()
    if version is None:
        raise ValueError(f"unknown model version: {model_version_id}")
    if str(version["dataset_id"]) != dataset_id or str(version["series_id"]) != series_id:
        raise ValueError("manual metric model version does not belong to dataset and series")

    now = _now_iso()
    override_id = f"vmmo_{_digest(model_version_id, metric_key)}"
    definition = METRIC_BY_KEY[metric_key]
    conn.execute(
        """
        INSERT INTO valuation_metric_manual_overrides
            (override_id, dataset_id, series_id, model_version_id, metric_key,
             value_numeric, unit, period, method, source, evidence_ids_json,
             derivation, quality_status, reviewer, review_note, is_active,
             created_at, updated_at)
        VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, 'manual_override:source_verified',
            ?, ?, ?, ?, ?, ?, 1, ?, ?
        )
        ON CONFLICT(model_version_id, metric_key) DO UPDATE SET
            value_numeric=excluded.value_numeric, unit=excluded.unit,
            period=excluded.period, method=excluded.method, source=excluded.source,
            evidence_ids_json=excluded.evidence_ids_json,
            derivation=excluded.derivation, quality_status=excluded.quality_status,
            reviewer=excluded.reviewer, review_note=excluded.review_note,
            is_active=1, updated_at=excluded.updated_at
        """,
        (
            override_id,
            dataset_id,
            series_id,
            model_version_id,
            metric_key,
            value,
            definition.unit,
            str(period).strip(),
            str(source).strip(),
            _json(evidence),
            str(derivation).strip(),
            quality_status,
            str(reviewer).strip(),
            str(review_note).strip(),
            now,
            now,
        ),
    )
    return {
        "override_id": override_id,
        "metric_key": metric_key,
        "value_numeric": value,
        "unit": definition.unit,
        "period": str(period).strip(),
        "method": "manual_override:source_verified",
        "source": str(source).strip(),
        "evidence_ids": evidence,
        "derivation": str(derivation).strip(),
        "quality_status": quality_status,
        "reviewer": str(reviewer).strip(),
        "review_note": str(review_note).strip(),
        "updated_at": now,
    }


class UnavailableMarketDataProvider:
    name = "unconfigured"

    def fetch_metrics(self, *, company_name: str, ticker: str) -> dict[str, Any]:
        del company_name, ticker
        return {
            "provider": self.name,
            "status": "unavailable",
            "as_of": _now_iso(),
            "error": (
                "Market data provider is unavailable. The default uses AKShare and Eastmoney; "
                "PRIVATE_FUND_MARKET_DATA_API_URL may configure a normalized endpoint."
            ),
            "metrics": {},
        }


class HttpMarketDataProvider:
    """Adapter for an internal or third-party normalized metrics endpoint."""

    name = "configured_http_api"

    def __init__(self, url: str, token: str = "") -> None:
        self.url = url
        self.token = token

    def fetch_metrics(self, *, company_name: str, ticker: str) -> dict[str, Any]:
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        response = httpx.post(
            self.url,
            json={
                "company_name": company_name,
                "ticker": ticker,
                "metrics": list(METRIC_KEYS),
            },
            headers=headers,
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError("market-data API returned a non-object payload")
        payload.setdefault("provider", self.name)
        payload.setdefault("status", "completed")
        payload.setdefault("metrics", {})
        return payload


@dataclass(frozen=True)
class SecurityIdentity:
    canonical_ticker: str
    provider_symbol: str
    exchange: str
    currency: str
    market: str


def _security_identity(ticker: str) -> SecurityIdentity:
    """Normalize the A/H-share identifiers supported by the first AKShare adapter."""

    normalized = str(ticker or "").strip().upper()
    hk_match = re.fullmatch(r"(\d{1,5})\.HK", normalized)
    if hk_match:
        digits = hk_match.group(1).lstrip("0") or "0"
        return SecurityIdentity(
            canonical_ticker=f"{digits}.HK",
            provider_symbol=digits.zfill(5),
            exchange="HK",
            currency="HKD",
            market="hk",
        )

    a_match = re.fullmatch(r"(\d{6})(?:\.(SZ|SH|BJ))?", normalized)
    if a_match:
        digits, explicit_exchange = a_match.groups()
        exchange = explicit_exchange
        if not exchange:
            if digits.startswith(("4", "8")):
                exchange = "BJ"
            elif digits.startswith(("5", "6", "9")):
                exchange = "SH"
            else:
                exchange = "SZ"
        return SecurityIdentity(
            canonical_ticker=f"{digits}.{exchange}",
            provider_symbol=digits,
            exchange=exchange,
            currency="CNY",
            market="a_share",
        )

    raise ValueError(
        f"AKShare 首版仅支持 A 股六位代码和港股 .HK 代码，当前代码为 {ticker or '空'}。"
    )


def _ifind_ticker(identity: SecurityIdentity) -> str:
    return (
        f"{identity.provider_symbol[-4:]}.{identity.exchange}"
        if identity.market == "hk"
        else identity.canonical_ticker
    )


def _date_text(value: Any) -> str:
    if value in (None, ""):
        return ""
    if hasattr(value, "strftime"):
        try:
            return str(value.strftime("%Y-%m-%d"))
        except (TypeError, ValueError):
            pass
    text = str(value).strip()
    match = re.match(r"(20\d{2})[-/]?(\d{2})[-/]?(\d{2})", text)
    return f"{match.group(1)}-{match.group(2)}-{match.group(3)}" if match else text[:10]


def _frame_records(frame: Any) -> list[dict[str, Any]]:
    if frame is None:
        return []
    if hasattr(frame, "to_dict"):
        records = frame.to_dict("records")
        return [item for item in records if isinstance(item, dict)]
    if isinstance(frame, list):
        return [item for item in frame if isinstance(item, dict)]
    raise ValueError("AKShare 返回了无法识别的日线数据格式。")


def _normalized_price_bar(row: dict[str, Any]) -> dict[str, Any] | None:
    trade_date = _date_text(row.get("日期", row.get("date", row.get("trade_date"))))
    close = _safe_float(row.get("收盘", row.get("close")))
    if not trade_date or close is None:
        return None
    return {
        "trade_date": trade_date,
        "open": _safe_float(row.get("开盘", row.get("open"))),
        "high": _safe_float(row.get("最高", row.get("high"))),
        "low": _safe_float(row.get("最低", row.get("low"))),
        "close": close,
        "volume": _safe_float(row.get("成交量", row.get("volume", row.get("vol")))),
        "amount": _safe_float(row.get("成交额", row.get("amount"))),
    }


def _average_turnover_metric(
    bars: list[dict[str, Any]], *, source: str, metadata: dict[str, Any] | None = None
) -> dict[str, Any] | None:
    sample = [
        bar
        for bar in sorted(bars, key=lambda item: str(item.get("trade_date") or ""))
        if _safe_float(bar.get("amount")) is not None
    ][-20:]
    if len(sample) != 20:
        return None
    observed_at = str(sample[-1]["trade_date"])
    metric = {
        "value": sum(float(bar["amount"]) for bar in sample) / 20.0,
        "period": f"20D@{observed_at}",
        "unit": "currency",
        "source": source,
        "observed_at": observed_at,
    }
    estimated_days = sum(
        1 for bar in sample if bar.get("amount_quality") == "estimated_close_x_volume"
    )
    if metadata:
        metric["metadata"] = {**metadata, "estimated_days": estimated_days}
    return metric

class EastmoneyFinancialMarketDataProvider:
    """A-share quarterly financial metrics from Eastmoney's public F10 feed."""

    name = "eastmoney_financial"

    def __init__(
        self, http_client: Any | None = None, *, request_timeout_seconds: float | None = None
    ) -> None:
        self._http_client = http_client
        configured_timeout = request_timeout_seconds
        if configured_timeout is None:
            configured_timeout = _safe_float(
                os.getenv("PRIVATE_FUND_EASTMONEY_TIMEOUT_SECONDS", "8")
            )
        self.request_timeout_seconds = min(max(float(configured_timeout or 8), 1.0), 10.0)

    @staticmethod
    def _first_value(row: dict[str, Any], *names: str) -> Any:
        for name in names:
            if row.get(name) not in (None, "", "--"):
                return row[name]
        return None

    @staticmethod
    def _ratio(value: Any) -> float | None:
        number = _safe_float(value)
        if number is None:
            return None
        # Eastmoney F10 ratio fields are published as percentage points.
        return number / 100.0 if abs(number) > 1.0 else number

    def _rows(self, *, ticker: str) -> list[dict[str, Any]]:
        identity = _security_identity(ticker)
        symbol = f"{identity.provider_symbol}.{identity.exchange}"
        params = {
            "reportName": "RPT_F10_QTR_MAINFINADATA",
            "columns": "ALL",
            "quoteColumns": "",
            "filter": f'(SECUCODE="{symbol}")',
            "pageNumber": "1",
            "pageSize": "200",
            "sortTypes": "-1",
            "sortColumns": "REPORT_DATE",
            "source": "HSF10",
            "client": "PC",
        }
        url = "https://datacenter.eastmoney.com/securities/api/data/v1/get"
        if self._http_client is not None:
            response = self._http_client.get(url, params=params, timeout=self.request_timeout_seconds)
        else:
            response = httpx.get(
                url,
                params=params,
                timeout=self.request_timeout_seconds,
                follow_redirects=True,
                trust_env=_market_data_trust_env_proxy(),
            )
        response.raise_for_status()
        payload = response.json()
        records = ((payload.get("result") or {}).get("data") or []) if isinstance(payload, dict) else []
        if not isinstance(records, list):
            raise RuntimeError("Eastmoney financial response did not contain records")
        return [row for row in records if isinstance(row, dict)]

    def fetch_daily_prices(
        self, *, ticker: str, start_date: date, end_date: date
    ) -> dict[str, Any]:
        """Fetch unadjusted A-share daily bars from Eastmoney's public K-line feed."""

        identity = _security_identity(ticker)
        if identity.market != "a_share":
            raise ValueError("Eastmoney K-line fallback is limited to A-share tickers.")
        market_prefix = "1" if identity.exchange == "SH" else "0"
        params = {
            "secid": f"{market_prefix}.{identity.provider_symbol}",
            "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": "f51,f52,f53,f54,f55,f56,f57",
            "klt": "101",
            "fqt": "0",
            "beg": start_date.strftime("%Y%m%d"),
            "end": end_date.strftime("%Y%m%d"),
        }
        url = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
        if self._http_client is not None:
            response = self._http_client.get(url, params=params, timeout=self.request_timeout_seconds)
        else:
            response = httpx.get(
                url,
                params=params,
                timeout=self.request_timeout_seconds,
                follow_redirects=True,
                trust_env=_market_data_trust_env_proxy(),
            )
        response.raise_for_status()
        payload = response.json()
        data = payload.get("data") if isinstance(payload, dict) else {}
        lines = data.get("klines") if isinstance(data, dict) else []
        bars: list[dict[str, Any]] = []
        for line in lines or []:
            values = str(line).split(",")
            if len(values) < 7:
                continue
            trade_date = values[0]
            amount = _safe_float(values[6])
            if amount is None:
                continue
            bars.append(
                {
                    "trade_date": trade_date,
                    "open": _safe_float(values[1]),
                    "close": _safe_float(values[2]),
                    "high": _safe_float(values[3]),
                    "low": _safe_float(values[4]),
                    "volume": _safe_float(values[5]),
                    "amount": amount,
                }
            )
        bars.sort(key=lambda item: str(item["trade_date"]))
        return {
            "provider": self.name,
            "provider_symbol": identity.provider_symbol,
            "canonical_ticker": identity.canonical_ticker,
            "exchange": identity.exchange,
            "currency": identity.currency,
            "adjustment": "raw",
            "source": "Eastmoney public daily K-line",
            "bars": bars,
        }

    def fetch_metrics(self, *, company_name: str, ticker: str) -> dict[str, Any]:
        del company_name
        identity = _security_identity(ticker)
        if identity.market != "a_share":
            return {
                "provider": self.name,
                "status": "unavailable",
                "as_of": _now_iso(),
                "ticker": ticker,
                "metrics": {},
                "metric_history": [],
                "error": "Eastmoney financial fallback is limited to A-share tickers.",
            }

        rows_by_quarter: dict[tuple[int, int], dict[str, Any]] = {}
        for row in self._rows(ticker=ticker):
            key = _quarter_from_end_date(
                str(
                    self._first_value(
                        row, "REPORT_DATE", "REPORT_DATE_NAME", "DATE", "END_DATE"
                    )
                    or ""
                )
            )
            if key is not None and key not in rows_by_quarter:
                rows_by_quarter[key] = row

        def value(key: tuple[int, int], *names: str) -> float | None:
            return _safe_float(self._first_value(rows_by_quarter.get(key, {}), *names))

        def ratio(key: tuple[int, int], *names: str) -> float | None:
            return self._ratio(self._first_value(rows_by_quarter.get(key, {}), *names))

        def observed_at(key: tuple[int, int]) -> str:
            row = rows_by_quarter.get(key, {})
            return str(
                self._first_value(
                    row, "NOTICE_DATE", "PUBLISH_DATE", "REPORT_DATE", "REPORT_DATE_NAME"
                )
                or ""
            )[:10]

        def financial_metrics(key: tuple[int, int]) -> dict[str, dict[str, Any]]:
            prior = _previous_quarter(key)
            values: dict[str, dict[str, Any]] = {}
            net_profit_yoy = ratio(
                key,
                "PARENT_NETPROFIT_YOY",
                "PARENT_NETPROFIT_GROWTH",
                "PARENTNETPROFITTZ",
                "NETPROFIT_YOY",
                "NET_PROFIT_YOY",
                "NETPROFIT_GROWTH",
            )
            if net_profit_yoy is None:
                net_profit_yoy = _growth(
                    value(key, "PARENT_NETPROFIT", "PARENT_NET_PROFIT", "NETPROFIT", "NET_PROFIT"),
                    value((key[0] - 1, key[1]), "PARENT_NETPROFIT", "PARENT_NET_PROFIT", "NETPROFIT", "NET_PROFIT"),
                )
            if net_profit_yoy is not None:
                values["quarter_net_profit_yoy"] = {
                    "value": net_profit_yoy,
                    "period": _quarter_label(key),
                    "unit": "percent",
                    "source": "Eastmoney F10 quarterly financial indicators",
                    "observed_at": observed_at(key),
                }

            def margin_for(quarter_key: tuple[int, int]) -> float | None:
                direct = ratio(
                    quarter_key,
                    "XSMLL",
                    "GROSS_PROFIT_MARGIN",
                    "SALE_GROSS_PROFIT_MARGIN",
                    "GROSS_PROFIT_RATIO",
                    "GROSS_MARGIN",
                )
                if direct is not None:
                    return direct
                revenue_value = value(
                    quarter_key,
                    "TOTAL_OPERATE_INCOME",
                    "TOTALOPERATEINCOME",
                    "OPERATE_INCOME",
                    "OPERATE_REVENUE",
                )
                cost_value = value(
                    quarter_key,
                    "OPERATE_COST",
                    "TOTAL_OPERATE_COST",
                    "OPERATING_COST",
                    "OPERATECOST",
                )
                if revenue_value is None or cost_value is None or abs(revenue_value) <= 1e-12:
                    return None
                return (revenue_value - abs(cost_value)) / revenue_value

            current_margin = margin_for(key)
            prior_margin = margin_for(prior)
            if current_margin is not None and prior_margin is not None:
                values["quarter_gross_margin_qoq_delta"] = {
                    "value": current_margin - prior_margin,
                    "period": _quarter_label(key),
                    "unit": "percentage_point",
                    "source": "Eastmoney F10 quarterly financial indicators",
                    "observed_at": observed_at(key),
                }

            current_revenue_yoy = ratio(
                key,
                "TOTAL_OPERATE_INCOME_YOY",
                "TOTALOPERATEREVETZ",
                "TOTALOPERATEREV_YOY",
                "OPERATE_INCOME_YOY",
                "TOTAL_REVENUE_YOY",
                "REVENUE_YOY",
            )
            prior_revenue_yoy = ratio(
                prior,
                "TOTAL_OPERATE_INCOME_YOY",
                "TOTALOPERATEREVETZ",
                "TOTALOPERATEREV_YOY",
                "OPERATE_INCOME_YOY",
                "TOTAL_REVENUE_YOY",
                "REVENUE_YOY",
            )
            if current_revenue_yoy is None:
                current_revenue_yoy = _growth(
                    value(key, "TOTAL_OPERATE_INCOME", "TOTALOPERATEINCOME", "OPERATE_INCOME", "OPERATE_REVENUE"),
                    value((key[0] - 1, key[1]), "TOTAL_OPERATE_INCOME", "TOTALOPERATEINCOME", "OPERATE_INCOME", "OPERATE_REVENUE"),
                )
            if prior_revenue_yoy is None:
                prior_revenue_yoy = _growth(
                    value(prior, "TOTAL_OPERATE_INCOME", "TOTALOPERATEINCOME", "OPERATE_INCOME", "OPERATE_REVENUE"),
                    value((prior[0] - 1, prior[1]), "TOTAL_OPERATE_INCOME", "TOTALOPERATEINCOME", "OPERATE_INCOME", "OPERATE_REVENUE"),
                )
            if current_revenue_yoy is not None and prior_revenue_yoy is not None:
                values["quarter_revenue_growth_qoq"] = {
                    "value": current_revenue_yoy - prior_revenue_yoy,
                    "period": _quarter_label(key),
                    "unit": "percentage_point",
                    "source": "Eastmoney F10 quarterly financial indicators",
                    "observed_at": observed_at(key),
                    "metadata": {
                        "current_quarter_yoy": current_revenue_yoy,
                        "previous_quarter_yoy": prior_revenue_yoy,
                    },
                }
            return values

        periods = sorted(rows_by_quarter, reverse=True)
        metrics: dict[str, dict[str, Any]] = {}
        if periods:
            metrics.update(financial_metrics(periods[0]))
        history = [
            {
                "period": _quarter_label(key),
                "observed_at": observed_at(key),
                "metrics": period_metrics,
            }
            for key in sorted(periods[:20])
            if (period_metrics := financial_metrics(key))
        ]
        try:
            end = date.today()
            prices = self.fetch_daily_prices(
                ticker=ticker, start_date=end - timedelta(days=70), end_date=end
            )
            turnover = _average_turnover_metric(prices["bars"], source=str(prices["source"]))
            if turnover is not None:
                metrics["avg_turnover_amount_20d"] = turnover
        except Exception:
            pass

        return {
            "provider": self.name,
            "status": "completed" if metrics else "unavailable",
            "as_of": _now_iso(),
            "ticker": identity.canonical_ticker,
            "metrics": metrics,
            "metric_history": history,
            "error": (
                ""
                if metrics
                else "Eastmoney returned no usable quarterly net-profit, gross-margin, or revenue-growth fields."
            ),
        }



class YahooHkMarketDataProvider:
    """Free Yahoo Finance fallback for Hong Kong valuation metrics."""

    name = "yahoo"

    def __init__(self, yfinance_module: Any | None = None) -> None:
        self._yfinance_module = yfinance_module

    def _module(self) -> Any:
        if self._yfinance_module is not None:
            return self._yfinance_module
        try:
            import yfinance  # type: ignore[import-not-found]
        except ImportError as exc:
            raise RuntimeError("Yahoo Finance provider is not installed.") from exc
        self._yfinance_module = yfinance
        return yfinance

    @staticmethod
    def _line_values(statement: Any, names: tuple[str, ...]) -> dict[tuple[int, int], float]:
        for name in names:
            if hasattr(statement, "index") and name in statement.index:
                return {
                    quarter: value
                    for column, raw_value in statement.loc[name].items()
                    if (quarter := _quarter_from_end_date(str(column))) is not None
                    and (value := _safe_float(raw_value)) is not None
                }
        return {}

    @staticmethod
    def _latest_yoy(values: dict[tuple[int, int], float]) -> tuple[tuple[int, int], float] | None:
        for quarter in sorted(values, reverse=True):
            prior_year = (quarter[0] - 1, quarter[1])
            if (value := _growth(values.get(quarter), values.get(prior_year))) is not None:
                return quarter, value
        return None

    def fetch_metrics(self, *, company_name: str, ticker: str) -> dict[str, Any]:
        del company_name
        identity = _security_identity(ticker)
        if identity.market != "hk":
            raise ValueError("Yahoo fallback is limited to .HK tickers.")
        symbol = f"{identity.provider_symbol[-4:]}.HK"
        instrument = self._module().Ticker(symbol)
        metrics: dict[str, dict[str, Any]] = {}
        try:
            statement = instrument.quarterly_income_stmt
            revenue = self._line_values(statement, ("Total Revenue",))
            gross_profit = self._line_values(statement, ("Gross Profit",))
            net_income = self._line_values(
                statement, ("Net Income", "Net Income Common Stockholders")
            )
            if (net_yoy := self._latest_yoy(net_income)) is not None:
                quarter, value = net_yoy
                metrics["quarter_net_profit_yoy"] = {
                    "value": value,
                    "period": _quarter_label(quarter),
                    "unit": "percent",
                    "source": "Yahoo Finance quarterly income statement",
                    "observed_at": _quarter_end_date(quarter).isoformat(),
                }
            for quarter in sorted(set(revenue) & set(gross_profit), reverse=True):
                prior = _previous_quarter(quarter)
                if prior not in revenue or prior not in gross_profit:
                    continue
                current_margin = gross_profit[quarter] / revenue[quarter] if revenue[quarter] else None
                prior_margin = gross_profit[prior] / revenue[prior] if revenue[prior] else None
                if current_margin is not None and prior_margin is not None:
                    metrics["quarter_gross_margin_qoq_delta"] = {
                        "value": current_margin - prior_margin,
                        "period": _quarter_label(quarter),
                        "unit": "percentage_point",
                        "source": "Yahoo Finance quarterly income statement",
                        "observed_at": _quarter_end_date(quarter).isoformat(),
                    }
                    break
            yoy_by_quarter = {
                quarter: value
                for quarter in revenue
                if (value := _growth(revenue.get(quarter), revenue.get((quarter[0] - 1, quarter[1]))))
                is not None
            }
            for quarter in sorted(yoy_by_quarter, reverse=True):
                if (prior_yoy := yoy_by_quarter.get(_previous_quarter(quarter))) is not None:
                    metrics["quarter_revenue_growth_qoq"] = {
                        "value": yoy_by_quarter[quarter] - prior_yoy,
                        "period": _quarter_label(quarter),
                        "unit": "percentage_point",
                        "source": "Yahoo Finance quarterly income statement",
                        "observed_at": _quarter_end_date(quarter).isoformat(),
                    }
                    break
        except Exception as exc:  # noqa: BLE001 - market fields can still be returned
            financial_error = str(exc)[:500]
        else:
            financial_error = ""
        try:
            info = instrument.get_info()
            forward_pe = _safe_float((info or {}).get("forwardPE"))
            if forward_pe is not None:
                metrics["forward_pe"] = {
                    "value": forward_pe,
                    "period": "forward",
                    "unit": "multiple",
                    "source": "Yahoo Finance forwardPE",
                    "observed_at": _now().date().isoformat(),
                }
            history = instrument.history(period="3mo", auto_adjust=False)
            bars = []
            for row in _frame_records(history.reset_index() if hasattr(history, "reset_index") else history):
                close = _safe_float(row.get("Close"))
                volume = _safe_float(row.get("Volume"))
                if close is not None and volume is not None:
                    bars.append({"trade_date": _date_text(row.get("Date", row.get("date"))), "amount": close * volume})
            turnover = _average_turnover_metric(
                bars,
                source="Yahoo Finance daily close x volume",
                metadata={"amount_quality": "estimated_close_x_volume"},
            )
            if turnover is not None:
                metrics["avg_turnover_amount_20d"] = turnover
            market_error = ""
        except Exception as exc:  # noqa: BLE001 - financial fields remain usable
            market_error = str(exc)[:500]
        missing = [key for key in METRIC_KEYS if key not in metrics]
        return {
            "provider": self.name,
            "status": "completed" if not missing else "partial" if metrics else "unavailable",
            "as_of": _now_iso(),
            "ticker": identity.canonical_ticker,
            "metrics": metrics,
            "missing_metric_keys": missing,
            "error": "; ".join(item for item in (financial_error, market_error) if item),
        }

    def fetch_market_metrics_as_of(self, *, ticker: str, as_of: date) -> dict[str, Any]:
        """Return historical turnover plus clearly dated current Forward PE fallback."""

        identity = _security_identity(ticker)
        if identity.market != "hk":
            raise ValueError("Yahoo fallback is limited to .HK tickers.")
        symbol = f"{identity.provider_symbol[-4:]}.HK"
        instrument = self._module().Ticker(symbol)
        metrics: dict[str, dict[str, Any]] = {}
        errors: list[str] = []
        try:
            history = instrument.history(
                start=(as_of - timedelta(days=70)).isoformat(),
                end=(as_of + timedelta(days=1)).isoformat(),
                auto_adjust=False,
            )
            bars = [
                (
                    _date_text(row.get("Date", row.get("date"))),
                    _safe_float(row.get("Close")),
                    _safe_float(row.get("Volume")),
                )
                for row in _frame_records(
                    history.reset_index() if hasattr(history, "reset_index") else history
                )
            ]
            turnover_bars = [
                {"trade_date": trade_date, "amount": close * volume}
                for trade_date, close, volume in bars
                if trade_date <= as_of.isoformat() and close is not None and volume is not None
            ]
            turnover = _average_turnover_metric(
                turnover_bars,
                source="Yahoo Finance historical daily close x volume",
                metadata={"amount_quality": "estimated_close_x_volume"},
            )
            if turnover is not None:
                metrics["avg_turnover_amount_20d"] = turnover
        except Exception as exc:  # noqa: BLE001 - current Forward PE can still be returned
            errors.append(str(exc)[:500])
        try:
            forward_pe = _safe_float((instrument.get_info() or {}).get("forwardPE"))
            if forward_pe is not None:
                observed_at = _now().date().isoformat()
                metrics["forward_pe"] = {
                    "value": forward_pe,
                    "period": f"API@{observed_at}",
                    "unit": "multiple",
                    "source": "Yahoo Finance forwardPE (current fallback)",
                    "observed_at": observed_at,
                    "status": "stale",
                    "metadata": {
                        "stale_fallback": True,
                        "requested_as_of": as_of.isoformat(),
                        "as_of_supported": False,
                    },
                }
        except Exception as exc:  # noqa: BLE001 - historical turnover remains usable
            errors.append(str(exc)[:500])
        missing = [item.key for item in MARKET_METRIC_DEFINITIONS if item.key not in metrics]
        return {
            "provider": self.name,
            "status": "completed" if not missing else "partial" if metrics else "unavailable",
            "as_of": as_of.isoformat(),
            "ticker": identity.canonical_ticker,
            "metrics": metrics,
            "missing_metric_keys": missing,
            "error": "; ".join(dict.fromkeys(error for error in errors if error)),
        }

class TencentHkMarketDataProvider:
    """HK daily bars from Tencent Finance, used before slower AKShare fallbacks."""

    name = "tencent_hk"

    def __init__(
        self, http_client: Any | None = None, *, request_timeout_seconds: float | None = None
    ) -> None:
        self._http_client = http_client
        configured_timeout = request_timeout_seconds
        if configured_timeout is None:
            configured_timeout = _safe_float(
                os.getenv("PRIVATE_FUND_TENCENT_HK_TIMEOUT_SECONDS", "10")
            )
        self.request_timeout_seconds = min(max(float(configured_timeout or 10), 1.0), 15.0)

    def _payload(
        self, *, provider_symbol: str, limit: int, start_date: date | None = None, end_date: date | None = None
    ) -> dict[str, Any]:
        url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
        start_text = start_date.strftime("%Y%m%d") if start_date else ""
        end_text = end_date.strftime("%Y%m%d") if end_date else ""
        params = {"param": f"hk{provider_symbol},day,{start_text},{end_text},{limit},"}
        headers = {
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://gu.qq.com/",
            "Accept": "application/json,text/plain,*/*",
        }
        if self._http_client is not None:
            response = self._http_client.get(
                url,
                params=params,
                headers=headers,
                timeout=self.request_timeout_seconds,
            )
        else:
            response = httpx.get(
                url,
                params=params,
                headers=headers,
                timeout=self.request_timeout_seconds,
                follow_redirects=True,
                trust_env=_market_data_trust_env_proxy(),
            )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict) or int(payload.get("code", -1)) != 0:
            raise RuntimeError("Tencent HK K-line response was not successful")
        return payload

    def fetch_daily_prices(
        self, *, ticker: str, start_date: date, end_date: date, request_dates: bool = False
    ) -> dict[str, Any]:
        identity = _security_identity(ticker)
        if identity.market != "hk":
            raise ValueError("Tencent HK K-line provider is limited to .HK tickers.")
        symbol_key = f"hk{identity.provider_symbol}"
        limit = min(500, max(30, (end_date - start_date).days * 2))
        payload = self._payload(
            provider_symbol=identity.provider_symbol,
            limit=limit,
            start_date=start_date if request_dates else None,
            end_date=end_date if request_dates else None,
        )
        security_data = ((payload.get("data") or {}).get(symbol_key) or {})
        rows = security_data.get("day") or security_data.get("qfqday") or []
        quote_values = ((security_data.get("qt") or {}).get(symbol_key) or [])
        exact_trade_date = ""
        exact_amount = None
        if isinstance(quote_values, list) and len(quote_values) > 37:
            exact_trade_date = str(quote_values[30] or "")[:10].replace("/", "-")
            exact_amount = _safe_float(quote_values[37])
        bars: list[dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, list) or len(row) < 6:
                continue
            trade_date = str(row[0])
            close = _safe_float(row[2])
            volume = _safe_float(row[5])
            if (
                not trade_date
                or close is None
                or volume is None
                or not (start_date.isoformat() <= trade_date <= end_date.isoformat())
            ):
                continue
            is_exact_amount = trade_date == exact_trade_date and exact_amount is not None
            bars.append(
                {
                    "trade_date": trade_date,
                    "open": _safe_float(row[1]),
                    "close": close,
                    "high": _safe_float(row[3]),
                    "low": _safe_float(row[4]),
                    "volume": volume,
                    "amount": exact_amount if is_exact_amount else close * volume,
                    "amount_quality": "exact_quote" if is_exact_amount else "estimated_close_x_volume",
                }
            )
        bars.sort(key=lambda item: str(item["trade_date"]))
        return {
            "provider": self.name,
            "provider_symbol": identity.provider_symbol,
            "canonical_ticker": identity.canonical_ticker,
            "exchange": identity.exchange,
            "currency": identity.currency,
            "adjustment": "raw",
            "source": "Tencent Finance public HK daily K-line",
            "bars": bars,
        }

    def fetch_market_metrics_as_of(self, *, ticker: str, as_of: date) -> dict[str, Any]:
        prices = self.fetch_daily_prices(
            ticker=ticker,
            start_date=as_of - timedelta(days=70),
            end_date=as_of,
            request_dates=True,
        )
        turnover = _average_turnover_metric(
            prices["bars"],
            source=str(prices["source"]),
            metadata={"amount_quality": "mixed_exact_and_close_x_volume_estimate", "requested_as_of": as_of.isoformat()},
        )
        metrics: dict[str, dict[str, Any]] = {"avg_turnover_amount_20d": turnover} if turnover else {}
        return {
            "provider": self.name,
            "status": "completed" if metrics else "unavailable",
            "as_of": as_of.isoformat(),
            "ticker": prices["canonical_ticker"],
            "metrics": metrics,
            "missing_metric_keys": [
                item.key for item in MARKET_METRIC_DEFINITIONS if item.key not in metrics
            ],
            "error": "" if metrics else "Tencent HK K-line did not return 20 complete trading sessions.",
        }

    def fetch_metrics(self, *, company_name: str, ticker: str) -> dict[str, Any]:
        del company_name
        end = date.today()
        prices = self.fetch_daily_prices(
            ticker=ticker,
            start_date=end - timedelta(days=70),
            end_date=end,
        )
        turnover = _average_turnover_metric(
            prices["bars"],
            source=str(prices["source"]),
            metadata={"amount_quality": "mixed_exact_and_close_x_volume_estimate"},
        )
        metrics: dict[str, Any] = {"avg_turnover_amount_20d": turnover} if turnover else {}
        return {
            "provider": self.name,
            "status": "completed" if metrics else "unavailable",
            "as_of": _now_iso(),
            "ticker": prices["canonical_ticker"],
            "metrics": metrics,
            "error": (
                ""
                if metrics
                else "Tencent HK K-line did not return 20 complete trading sessions."
            ),
        }


class AkshareMarketDataProvider:
    """Free A/H-share price adapter backed by AKShare's public-data interfaces.

    The adapter deliberately requests unadjusted daily bars (``adjust=''``),
    because a same-date model target price must be compared with the actually
    traded close, not a back-adjusted series.
    """

    name = "akshare"

    def __init__(self, akshare_module: Any | None = None) -> None:
        self._akshare_module = akshare_module

    def _module(self) -> Any:
        if self._akshare_module is not None:
            return self._akshare_module
        try:
            import akshare  # type: ignore[import-not-found]
        except ImportError as exc:
            raise RuntimeError("AKShare 未安装，请先安装项目依赖。") from exc
        self._akshare_module = akshare
        return akshare

    def fetch_daily_prices(
        self, *, ticker: str, start_date: date, end_date: date
    ) -> dict[str, Any]:
        identity = _security_identity(ticker)
        akshare = self._module()
        params = {
            "symbol": identity.provider_symbol,
            "period": "daily",
            "start_date": start_date.strftime("%Y%m%d"),
            "end_date": end_date.strftime("%Y%m%d"),
            "adjust": "",
        }
        if identity.market == "hk":
            try:
                frame = akshare.stock_hk_hist(**params)
                source = "AKShare stock_hk_hist (Eastmoney)"
            except Exception:  # noqa: BLE001 - fall back when this AKShare upstream fails
                frame = akshare.stock_hk_daily(symbol=identity.provider_symbol, adjust="")
                source = "AKShare stock_hk_daily (Sina fallback)"
        else:
            try:
                frame = akshare.stock_zh_a_hist(**params)
                source = "AKShare stock_zh_a_hist (Eastmoney)"
            except Exception:
                if identity.exchange == "BJ":
                    raise
                frame = akshare.stock_zh_a_daily(
                    symbol=f"{identity.exchange.lower()}{identity.provider_symbol}",
                    start_date=params["start_date"],
                    end_date=params["end_date"],
                    adjust="",
                )
                source = "AKShare stock_zh_a_daily (Sina fallback)"
        bars = [
            bar
            for row in _frame_records(frame)
            if (bar := _normalized_price_bar(row)) is not None
            and start_date.isoformat() <= str(bar["trade_date"]) <= end_date.isoformat()
        ]
        bars.sort(key=lambda item: str(item["trade_date"]))
        return {
            "provider": self.name,
            "provider_symbol": identity.provider_symbol,
            "canonical_ticker": identity.canonical_ticker,
            "exchange": identity.exchange,
            "currency": identity.currency,
            "adjustment": "raw",
            "source": source,
            "bars": bars,
        }

    def fetch_metrics(self, *, company_name: str, ticker: str) -> dict[str, Any]:
        del company_name
        end = date.today()
        prices = self.fetch_daily_prices(
            ticker=ticker, start_date=end - timedelta(days=70), end_date=end
        )
        turnover = _average_turnover_metric(prices["bars"], source=str(prices["source"]))
        metrics: dict[str, Any] = {"avg_turnover_amount_20d": turnover} if turnover else {}
        return {
            "provider": self.name,
            "status": "completed" if prices["bars"] else "unavailable",
            "as_of": _now_iso(),
            "ticker": prices["canonical_ticker"],
            "metrics": metrics,
            "error": (
                "AKShare 免费行情已接入；季度财务指标和 Forward PE 仍需财报或一致预期数据源。"
            ),
        }


def _quarter_from_end_date(value: str) -> tuple[int, int] | None:
    match = re.search(r"(20\d{2})[-/]?(\d{2})[-/]?(\d{2})", str(value or ""))
    if not match:
        return None
    year, month = int(match.group(1)), int(match.group(2))
    quarter = {3: 1, 6: 2, 9: 3, 12: 4}.get(month)
    return (year, quarter) if quarter else None


def _quarter_label(key: tuple[int, int]) -> str:
    return f"{key[0]}Q{key[1]}"


def _quarter_end_date(key: tuple[int, int]) -> date:
    month = key[1] * 3
    return date(key[0], month, 31 if month in {3, 12} else 30)


def _previous_quarter(key: tuple[int, int]) -> tuple[int, int]:
    return (key[0] - 1, 4) if key[1] == 1 else (key[0], key[1] - 1)


def _growth(current: float | None, previous: float | None) -> float | None:
    if current is None or previous is None or abs(previous) <= 1e-12:
        return None
    return current / previous - 1.0


IFIND_DEFAULT_BASE_URL = "https://quantapi.51ifind.com/api/v1"
IFIND_FINANCIAL_INDICATORS = {
    "net_profit_yoy": "ths_sq_np_atsopc_yoy_stock",
    "gross_margin": "ths_sales_gross_interest_sq_stock",
    "revenue_yoy": "ths_revenue_yoy_sq_stock",
}
IFIND_MARKET_INDICATORS = {
    "forward_pe": "ths_fore_pe_in_12m_stock",
    "turnover_amount": "ths_amt_stock",
}
IFIND_HK_FINANCIAL_INDICATORS = {
    "net_profit_yoy": "np_atsopc_yoy",
    "gross_margin": "sales_gross_interest_sq",
    "gross_margin_fallback": "gross_selling_rate",
    "revenue_yoy": "or_yoy",
}
IFIND_HK_MARKET_INDICATORS = {
    "forward_pe": "fore_pe_in_12m",
    "turnover_amount": "amt",
}


def _ifind_indicators(identity: SecurityIdentity) -> tuple[dict[str, str], dict[str, str]]:
    if identity.market == "hk":
        return IFIND_HK_FINANCIAL_INDICATORS, IFIND_HK_MARKET_INDICATORS
    return IFIND_FINANCIAL_INDICATORS, IFIND_MARKET_INDICATORS


def _market_source_timeout_seconds() -> float:
    """Keep one unavailable public source from holding the durable job forever."""

    raw_value = os.environ.get("PRIVATE_FUND_MARKET_SOURCE_TIMEOUT_SECONDS", "8")
    try:
        timeout = float(raw_value)
    except (TypeError, ValueError):
        return 8.0
    return min(15.0, max(0.01, timeout))


def _market_source_timeout_for(source_name: str) -> float:
    default = 15.0 if str(source_name or "").strip().lower() == "yahoo" else _market_source_timeout_seconds()
    normalized = str(source_name or "").strip().upper()
    configured = os.environ.get(
        f"PRIVATE_FUND_{normalized}_SOURCE_TIMEOUT_SECONDS",
        "",
    ).strip()
    if configured:
        try:
            return min(15.0, max(0.01, float(configured)))
        except ValueError:
            pass
    if source_name == "eastmoney_financial":
        return max(default, 12.0)
    if source_name == "tencent_hk":
        return max(default, 10.0)
    return default


def _call_market_source_with_timeout(callback: Any, *, source_name: str) -> dict[str, Any]:
    """Run a blocking provider call with a bounded wait."""

    result_queue: Queue[tuple[dict[str, Any] | None, BaseException | None]] = Queue(maxsize=1)

    def _run() -> None:
        try:
            result_queue.put((callback(), None))
        except BaseException as exc:  # noqa: BLE001
            result_queue.put((None, exc))

    worker = threading.Thread(target=_run, name=f"valuation-market-{source_name}", daemon=True)
    worker.start()
    timeout = _market_source_timeout_for(source_name)
    try:
        payload, error = result_queue.get(timeout=timeout)
    except Empty as exc:
        raise TimeoutError(f"{source_name} did not respond within {timeout:g}s") from exc
    if error is not None:
        raise error
    if not isinstance(payload, dict):
        raise TypeError(f"{source_name} returned an invalid payload")
    return payload


class FreeComboMarketDataProvider:
    """iFinD-first waterfall with public A/H-share fallbacks."""

    name = "free_combo"

    def __init__(
        self,
        *,
        ifind_provider: MarketDataProvider | None = None,
        eastmoney_financial_provider: MarketDataProvider | None = None,
        tencent_hk_provider: MarketDataProvider | None = None,
        yahoo_provider: MarketDataProvider | None = None,
        akshare_provider: MarketDataProvider | None = None,
        consensus_provider: MarketDataProvider | None = None,
    ) -> None:
        self.ifind_provider = ifind_provider
        if self.ifind_provider is None:
            access_token = os.environ.get("PRIVATE_FUND_IFIND_ACCESS_TOKEN", "").strip()
            refresh_token = os.environ.get("PRIVATE_FUND_IFIND_REFRESH_TOKEN", "").strip()
            if access_token or refresh_token:
                self.ifind_provider = IFindHttpMarketDataProvider(
                    os.environ.get("PRIVATE_FUND_IFIND_BASE_URL", IFIND_DEFAULT_BASE_URL),
                    access_token,
                    refresh_token=refresh_token,
                )
        self.eastmoney_financial_provider = (
            eastmoney_financial_provider or EastmoneyFinancialMarketDataProvider()
        )
        self.tencent_hk_provider = tencent_hk_provider or TencentHkMarketDataProvider()
        self.yahoo_provider = yahoo_provider or YahooHkMarketDataProvider()
        self.akshare_provider = akshare_provider or AkshareMarketDataProvider()
        self.consensus_provider = consensus_provider
        if self.consensus_provider is None:
            consensus_url = os.environ.get("PRIVATE_FUND_CONSENSUS_API_URL", "").strip()
            if consensus_url:
                self.consensus_provider = HttpMarketDataProvider(
                    consensus_url,
                    os.environ.get("PRIVATE_FUND_CONSENSUS_API_TOKEN", ""),
                )

    def _providers_for_metrics(self, ticker: str) -> list[MarketDataProvider]:
        identity = _security_identity(ticker)
        preferred = [self.ifind_provider] if self.ifind_provider is not None else []
        if identity.market == "hk":
            return [*preferred, self.tencent_hk_provider, self.yahoo_provider]
        return [
            *preferred,
            self.akshare_provider,
            self.eastmoney_financial_provider,
        ]

    @staticmethod
    def _attempt_payload(
        *, provider_name: str, payload: dict[str, Any] | None, error: str, duration_ms: int
    ) -> dict[str, Any]:
        metrics = payload.get("metrics") if isinstance(payload, dict) else {}
        metric_keys = [key for key in METRIC_KEYS if isinstance(metrics, dict) and key in metrics]
        status = str((payload or {}).get("status") or ("failed" if error else "unavailable"))
        return {
            "provider": provider_name,
            "status": status,
            "fields_found": metric_keys,
            "error_message": error or str((payload or {}).get("error") or ""),
            "duration_ms": duration_ms,
            "timeout_seconds": _market_source_timeout_for(provider_name),
        }

    def fetch_market_metrics_as_of(self, *, ticker: str, as_of: date) -> dict[str, Any]:
        """Fill each historical HK market field in iFinD, Tencent, Yahoo order."""

        identity = _security_identity(ticker)
        providers: list[MarketDataProvider] = []
        if self.ifind_provider is not None:
            providers.append(self.ifind_provider)
        if identity.market == "hk":
            providers.extend([self.tencent_hk_provider, self.yahoo_provider])
        attempts: list[dict[str, Any]] = []
        metrics_payload: dict[str, dict[str, Any]] = {}
        errors: list[str] = []
        for source in providers:
            if all(item.key in metrics_payload for item in MARKET_METRIC_DEFINITIONS):
                break
            source_name = getattr(source, "name", type(source).__name__)
            fetch_period = getattr(source, "fetch_market_metrics_as_of", None)
            if not callable(fetch_period):
                attempts.append(
                    self._attempt_payload(
                        provider_name=source_name,
                        payload=None,
                        error="Historical market snapshots are not supported.",
                        duration_ms=0,
                    )
                )
                continue
            started_at = time.monotonic()
            payload: dict[str, Any] | None = None
            error = ""
            try:
                payload = _call_market_source_with_timeout(
                    lambda source=source: source.fetch_market_metrics_as_of(
                        ticker=ticker, as_of=as_of
                    ),
                    source_name=source_name,
                )
            except Exception as exc:  # noqa: BLE001 - subsequent sources remain valid fallbacks
                error = str(exc)
            attempts.append(
                self._attempt_payload(
                    provider_name=source_name,
                    payload=payload,
                    error=error,
                    duration_ms=int((time.monotonic() - started_at) * 1000),
                )
            )
            if error:
                errors.append(error)
            source_metrics = payload.get("metrics") if isinstance(payload, dict) else {}
            if not isinstance(source_metrics, dict):
                continue
            for definition in MARKET_METRIC_DEFINITIONS:
                value = source_metrics.get(definition.key)
                if definition.key not in metrics_payload and isinstance(value, dict):
                    metrics_payload[definition.key] = value
        missing = [item.key for item in MARKET_METRIC_DEFINITIONS if item.key not in metrics_payload]
        return {
            "provider": self.name,
            "status": "completed" if not missing else "partial" if metrics_payload else "unavailable",
            "as_of": as_of.isoformat(),
            "ticker": identity.canonical_ticker,
            "metrics": metrics_payload,
            "missing_metric_keys": missing,
            "provider_attempts": attempts,
            "error": "; ".join(dict.fromkeys(error for error in errors if error))[:2000],
        }
    def fetch_metrics(self, *, company_name: str, ticker: str) -> dict[str, Any]:
        if not str(ticker or "").strip():
            return {
                "provider": self.name,
                "status": "missing_ticker",
                "as_of": _now_iso(),
                "ticker": "",
                "metrics": {},
                "metric_history": [],
                "provider_attempts": [],
                "missing_metric_keys": list(METRIC_KEYS),
                "error": "模型系列缺少证券代码，等待补充后再拉取真实值。",
            }
        try:
            identity = _security_identity(ticker)
            providers = self._providers_for_metrics(ticker)
        except ValueError as exc:
            return {
                "provider": self.name,
                "status": "unavailable",
                "as_of": _now_iso(),
                "ticker": ticker,
                "metrics": {},
                "metric_history": [],
                "provider_attempts": [
                    {
                        "provider": self.name,
                        "status": "failed",
                        "fields_found": [],
                        "error_message": str(exc),
                        "duration_ms": 0,
                    }
                ],
                "missing_metric_keys": list(METRIC_KEYS),
                "error": str(exc),
            }
        attempts: list[dict[str, Any]] = []
        metrics_payload: dict[str, Any] = {}
        raw_payloads: dict[str, Any] = {}
        history: list[dict[str, Any]] = []
        for provider_index, provider in enumerate(providers):
            if set(METRIC_KEYS).issubset(metrics_payload):
                for skipped in providers[provider_index:]:
                    skipped_name = getattr(skipped, "name", type(skipped).__name__)
                    attempts.append(
                        {
                            "provider": skipped_name,
                            "status": "skipped",
                            "fields_found": [],
                            "error_message": "Higher-priority sources already supplied all five metrics.",
                            "duration_ms": 0,
                        }
                    )
                break
            provider_name = getattr(provider, "name", type(provider).__name__)
            started_at = time.monotonic()
            payload: dict[str, Any] | None = None
            error = ""
            try:
                payload = _call_market_source_with_timeout(
                    lambda: provider.fetch_metrics(company_name=company_name, ticker=ticker),
                    source_name=provider_name,
                )
            except Exception as exc:  # noqa: BLE001
                error = str(exc)
            attempts.append(
                self._attempt_payload(
                    provider_name=provider_name,
                    payload=payload,
                    error=error,
                    duration_ms=int((time.monotonic() - started_at) * 1000),
                )
            )
            if not isinstance(payload, dict):
                continue
            raw_payloads[str(payload.get("provider") or provider_name)] = payload
            source_metrics = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else {}
            for key in METRIC_KEYS:
                if key not in metrics_payload and isinstance(source_metrics.get(key), dict):
                    metrics_payload[key] = source_metrics[key]
            if not history and isinstance(payload.get("metric_history"), list):
                history = list(payload.get("metric_history") or [])
        if (
            identity.market != "hk"
            and "forward_pe" not in metrics_payload
            and self.consensus_provider is not None
        ):
            provider = self.consensus_provider
            provider_name = getattr(provider, "name", type(provider).__name__)
            started_at = time.monotonic()
            payload = None
            error = ""
            try:
                payload = _call_market_source_with_timeout(
                    lambda: provider.fetch_metrics(company_name=company_name, ticker=ticker),
                    source_name=provider_name,
                )
            except Exception as exc:  # noqa: BLE001
                error = str(exc)
            attempts.append(
                self._attempt_payload(
                    provider_name=provider_name,
                    payload=payload,
                    error=error,
                    duration_ms=int((time.monotonic() - started_at) * 1000),
                )
            )
            if isinstance(payload, dict):
                raw_payloads[str(payload.get("provider") or provider_name)] = payload
                source_metrics = (
                    payload.get("metrics") if isinstance(payload.get("metrics"), dict) else {}
                )
                if isinstance(source_metrics.get("forward_pe"), dict):
                    metrics_payload["forward_pe"] = source_metrics["forward_pe"]
        missing = [key for key in METRIC_KEYS if key not in metrics_payload]
        compared_count = len(METRIC_KEYS) - len(missing)
        status = (
            "completed"
            if compared_count == len(METRIC_KEYS)
            else "partial"
            if compared_count
            else "unavailable"
        )
        errors = [str(item.get("error_message") or "") for item in attempts if item.get("error_message")]
        if "forward_pe" in missing:
            errors.append("Forward PE requires a licensed consensus source (Wind, Choice, iFinD, or configured consensus API); TTM PE was not substituted.")
        return {
            "provider": self.name,
            "status": status,
            "as_of": _now_iso(),
            "ticker": identity.canonical_ticker,
            "metrics": metrics_payload,
            "metric_history": history,
            "provider_attempts": attempts,
            "missing_metric_keys": missing,
            "raw_provider_payloads": raw_payloads,
            "error": "; ".join(dict.fromkeys(error for error in errors if error))[:2000],
        }


def default_market_data_provider() -> MarketDataProvider:
    selected = os.environ.get("PRIVATE_FUND_MARKET_DATA_PROVIDER", "").strip().lower()
    if selected == "ifind":
        access_token = os.environ.get("PRIVATE_FUND_IFIND_ACCESS_TOKEN", "").strip()
        refresh_token = os.environ.get("PRIVATE_FUND_IFIND_REFRESH_TOKEN", "").strip()
        if not access_token and not refresh_token:
            return UnavailableMarketDataProvider()
        return IFindHttpMarketDataProvider(
            os.environ.get("PRIVATE_FUND_IFIND_BASE_URL", IFIND_DEFAULT_BASE_URL),
            access_token,
            refresh_token=refresh_token,
        )
    url = os.environ.get("PRIVATE_FUND_MARKET_DATA_API_URL", "").strip()
    if selected in {"http", "api"} or (url and not selected):
        if not url:
            return UnavailableMarketDataProvider()
        return HttpMarketDataProvider(
            url, os.environ.get("PRIVATE_FUND_MARKET_DATA_API_TOKEN", "")
        )
    if selected in {"disabled", "none", "off"}:
        return UnavailableMarketDataProvider()
    if selected == "akshare":
        return AkshareMarketDataProvider()
    if selected in {"", "free_combo", "combo", "hybrid"}:
        return FreeComboMarketDataProvider()
    raise ValueError(f"Unsupported PRIVATE_FUND_MARKET_DATA_PROVIDER: {selected}")


def _parse_quarter(value: Any) -> tuple[int, int] | None:
    text = unicodedata.normalize("NFKC", str(value or "")).upper().strip()
    patterns = (
        r"(?P<year>20\d{2})\s*[-/. ]?Q(?P<quarter>[1-4])",
        r"Q(?P<quarter>[1-4])\s*[-/. ]?(?P<year>20\d{2}|\d{2})",
        r"(?P<quarter>[1-4])\s*Q\s*[-/. ]?(?P<year>20\d{2}|\d{2})",
        r"(?P<year>20\d{2})年\s*(?P<quarter>[一二三四1234])季",
    )
    chinese = {"一": 1, "二": 2, "三": 3, "四": 4}
    for pattern in patterns:
        match = re.search(pattern, text)
        if not match:
            continue
        year = int(match.group("year"))
        if year < 100:
            year += 1900 if year >= 70 else 2000
        raw_quarter = match.group("quarter")
        return year, chinese.get(raw_quarter, int(raw_quarter) if raw_quarter.isdigit() else 0)
    return None


def _standard_five_metric_facts(
    conn: sqlite3.Connection, doc_id: str, existing_facts: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Adapt the documented horizontal five-metric template into metric facts."""

    columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(excel_cells)")}
    required = {"cell_id", "sheet_name", "cell_ref", "display_value", "numeric_value"}
    if not required.issubset(columns):
        return []
    optional = {
        name: name if name in columns else f"NULL AS {name}"
        for name in ("row_index", "col_index", "formula", "cached_value")
    }
    rows = [
        dict(row)
        for row in conn.execute(
            f"""
            SELECT cell_id, sheet_name, cell_ref, display_value, numeric_value,
                   {optional['row_index']}, {optional['col_index']},
                   {optional['formula']}, {optional['cached_value']}
            FROM excel_cells WHERE doc_id=?
            ORDER BY sheet_name, row_index, col_index, cell_ref
            """,
            (doc_id,),
        )
    ]

    def coordinates(cell: dict[str, Any]) -> tuple[int, int]:
        if cell.get("row_index") is not None and cell.get("col_index") is not None:
            return int(cell["row_index"]), int(cell["col_index"])
        match = re.fullmatch(r"([A-Z]+)(\d+)", str(cell.get("cell_ref") or "").upper())
        if not match:
            return 0, 0
        column = 0
        for char in match.group(1):
            column = column * 26 + ord(char) - ord("A") + 1
        return int(match.group(2)), column

    cells = {(str(row["sheet_name"]), *coordinates(row)): row for row in rows}
    existing_by_cell = {
        (str(fact.get("sheet_name") or ""), str(fact.get("cell_ref") or "")): fact
        for fact in existing_facts
    }
    adapted: list[dict[str, Any]] = []
    for (sheet_name, header_row, _), cell in cells.items():
        if _normalize(cell.get("display_value")) != _normalize("\u6307\u6807\u4ee3\u7801"):
            continue
        if _normalize((cells.get((sheet_name, header_row, 1)) or {}).get("display_value")) != _normalize("\u6307\u6807\u540d\u79f0"):
            continue
        if _normalize((cells.get((sheet_name, header_row, 3)) or {}).get("display_value")) != _normalize("\u5355\u4f4d"):
            continue
        for metric_row in range(header_row + 1, header_row + 20):
            code_cell = cells.get((sheet_name, metric_row, 2))
            code = str((code_cell or {}).get("display_value") or "").strip().lower()
            if not code:
                break
            if code not in METRIC_KEYS:
                continue
            metric_name = str((cells.get((sheet_name, metric_row, 1)) or {}).get("display_value") or code).strip()
            unit = str((cells.get((sheet_name, metric_row, 3)) or {}).get("display_value") or "").strip()
            formula_description = str((cells.get((sheet_name, metric_row, 4)) or {}).get("display_value") or "").strip()
            for period_col in range(5, 100):
                period_cell = cells.get((sheet_name, header_row, period_col))
                value_cell = cells.get((sheet_name, metric_row, period_col))
                if not period_cell or not value_cell:
                    break
                period = str(period_cell.get("display_value") or "").strip()
                if _parse_quarter(period) is None:
                    continue
                value = _safe_float(value_cell.get("numeric_value"))
                if value is None:
                    value = _safe_float(value_cell.get("cached_value"))
                if value is None:
                    value = _safe_float(value_cell.get("display_value"))
                if value is None:
                    continue
                if code == "avg_turnover_amount_20d" and _normalize(unit) in {
                    "\u767e\u4e07\u5143", "\u4eba\u6c11\u5e01\u767e\u4e07\u5143", "rmb million", "cny million"
                }:
                    value *= 1_000_000.0
                prior = existing_by_cell.get((sheet_name, str(value_cell["cell_ref"])), {})
                adapted.append({
                    **prior,
                    "fact_id": prior.get("fact_id") or f"template:{value_cell['cell_id']}",
                    "metric_name": metric_name,
                    "metric_alias": code,
                    "period": period,
                    "value_numeric": value,
                    "value_text": str(value_cell.get("display_value") or value),
                    "unit": unit,
                    "sheet_name": sheet_name,
                    "cell_ref": str(value_cell["cell_ref"]),
                    "confidence": 1.0,
                    "quality_status": "candidate_complete",
                    "formula": formula_description or str(value_cell.get("formula") or ""),
                })
    return adapted


def _facts_for_document(conn: sqlite3.Connection, doc_id: str) -> list[dict[str, Any]]:
    tables = {
        str(row[0]) for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    facts: list[dict[str, Any]] = []
    if "metric_facts" in tables:
        columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(metric_facts)")}
        alias_column = "metric_alias" if "metric_alias" in columns else "NULL AS metric_alias"
        rows = conn.execute(
            f"""
            SELECT fact_id, metric_name, {alias_column}, period, value_numeric, value_text,
                   unit, sheet_name, cell_ref, confidence, quality_status, formula
            FROM metric_facts
            WHERE doc_id=? AND COALESCE(quality_status,'review_required')<>'rejected'
            ORDER BY sheet_name, cell_ref
            """,
            (doc_id,),
        ).fetchall()
        facts = [dict(row) for row in rows]
    adapted = _standard_five_metric_facts(conn, doc_id, facts)
    if not adapted:
        return facts
    adapted_cells = {(fact["sheet_name"], fact["cell_ref"]) for fact in adapted}
    return [
        fact for fact in facts
        if (fact.get("sheet_name"), fact.get("cell_ref")) not in adapted_cells
    ] + adapted


def _base_metric_kind(name: str) -> str:
    text = _normalize(name)
    if any(term in text for term in ("check", "difference", "variance")):
        return ""
    if any(term in text for term in ("growth", "yoy", "qoq", "增速", "同比", "环比")):
        return "derived"
    if any(
        term in text
        for term in (
            "net profit",
            "net income",
            "归母净利润",
            "净利润",
            "归属于母公司",
            "pat ni",
        )
    ) and not any(term in text for term in ("margin", "率", "per share", "eps")):
        return "net_profit"
    if any(term in text for term in ("gross margin", "gross profit margin", "毛利率")):
        return "gross_margin"
    if (
        any(term in text for term in ("gross profit", "毛利润", "毛利"))
        and "margin" not in text
        and "率" not in text
    ):
        return "gross_profit"
    if text in {"turnover", "营业收入", "收入"}:
        return "revenue"
    if any(term in text for term in ("revenue", "revenues", "sales")) and not any(
        term in text
        for term in (
            "%",
            "margin",
            "growth",
            "mix",
            "share",
            "cost",
            "expense",
            "tax",
            "per ",
            "days",
            "deferred",
            "contribution",
        )
    ):
        return "revenue"
    if any(
        term in text
        for term in (
            "cogs",
            "cost of sales",
            "operating cost",
            "oper cost",
            "营业成本",
            "销售成本",
        )
    ) and not any(term in text for term in ("%", "margin", "per ", "ratio")):
        return "cost"
    return ""


def _fact_metric_kind(fact: dict[str, Any]) -> str:
    """Resolve a fact kind using both its row label and numeric unit."""

    kind = _base_metric_kind(str(fact.get("metric_name") or ""))
    unit = _normalize(fact.get("unit"))
    is_percentage = "%" in unit or unit in {"percent", "percentage"}
    if kind == "gross_profit" and is_percentage:
        return "gross_margin"
    if kind in {"net_profit", "revenue", "gross_profit", "cost"} and is_percentage:
        return ""
    return kind


def _candidate_score(fact: dict[str, Any], kind: str) -> float:
    score = float(fact.get("confidence") or 0.5)
    sheet = _normalize(fact.get("sheet_name"))
    if any(term in sheet for term in ("qoq", "quarter", "单季", "季度")):
        score += 3.0
    if fact.get("quality_status") == "candidate_complete":
        score += 1.0
    name = _normalize(fact.get("metric_name"))
    if kind == "net_profit" and any(term in name for term in ("attributable", "归母", "归属于")):
        score += 2.0
    if kind == "revenue" and name in {"revenue", "营业收入"}:
        score += 1.0
    return score


def _quarterly_values(
    facts: list[dict[str, Any]], kind: str
) -> dict[tuple[int, int], dict[str, Any]]:
    selected: dict[tuple[int, int], dict[str, Any]] = {}
    for fact in facts:
        if _fact_metric_kind(fact) != kind:
            continue
        quarter = _parse_quarter(fact.get("period"))
        value = _safe_float(fact.get("value_numeric"))
        if quarter is None or value is None:
            continue
        current = selected.get(quarter)
        if current is None or _candidate_score(fact, kind) > _candidate_score(current, kind):
            selected[quarter] = fact
    return selected


def _direct_fact(
    facts: list[dict[str, Any]], terms: tuple[str, ...], target_quarter: tuple[int, int] | None
) -> dict[str, Any] | None:
    candidates = []
    normalized_terms = tuple(_normalize(term) for term in terms)
    for fact in facts:
        name = _normalize(f"{fact.get('metric_name', '')} {fact.get('metric_alias', '')}")
        if not any(term in name for term in normalized_terms):
            continue
        number = _safe_float(fact.get("value_numeric"))
        if number is None:
            continue
        quarter = _parse_quarter(fact.get("period"))
        period_score = 3.0 if target_quarter and quarter == target_quarter else 0.0
        forecast_score = (
            1.0 if re.search(r"(?:E|F|预测)", str(fact.get("period") or ""), re.I) else 0.0
        )
        candidates.append((period_score + forecast_score + _candidate_score(fact, "direct"), fact))
    return max(candidates, key=lambda item: item[0])[1] if candidates else None


def _evidence(facts: list[dict[str, Any]]) -> list[str]:
    return [f"fact:{fact['fact_id']}" for fact in facts if fact and fact.get("fact_id")]


def _source(facts: list[dict[str, Any]]) -> str:
    return ", ".join(
        dict.fromkeys(
            f"{fact.get('sheet_name', '')}!{fact.get('cell_ref', '')}" for fact in facts if fact
        )
    )


def _explicit_five_metric_contract(
    facts: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Read a labelled five-metric output table without inferring formulas."""

    aliases = {
        "quarter_net_profit_yoy": (
            "quarter net profit yoy",
            "quarterly net profit yoy",
            "\u5355\u5b63\u51c0\u5229\u6da6\u589e\u901f",
        ),
        "quarter_gross_margin_qoq_delta": (
            "quarter gross margin qoq delta",
            "quarterly gross margin qoq delta",
            "\u5355\u5b63\u6bdb\u5229\u7387\u73af\u6bd4\u53d8\u5316",
        ),
        "forward_pe": ("forward pe", "forward p e", "\u9884\u6d4b\u5e02\u76c8\u7387"),
        "avg_turnover_amount_20d": (
            "20d average turnover",
            "20 day average turnover",
            "20d average turnover amount",
            "\u8fd120\u65e5\u65e5\u5747\u6210\u4ea4\u989d",
        ),
        "quarter_revenue_growth_qoq": (
            "quarter revenue growth qoq",
            "quarterly revenue growth qoq",
            "\u5355\u5b63\u8425\u6536\u589e\u901f\u73af\u6bd4",
        ),
    }
    selected: dict[str, tuple[float, dict[str, Any]]] = {}
    for fact in facts:
        value = _safe_float(fact.get("value_numeric"))
        if value is None:
            continue
        name = _normalize(
            f"{fact.get('metric_name', '')} {fact.get('metric_alias', '')}"
        )
        sheet = _normalize(fact.get("sheet_name"))
        for key, candidates in aliases.items():
            exact_alias = _normalize(fact.get("metric_alias")) == _normalize(key)
            if not exact_alias and not any(
                _normalize(candidate) in name for candidate in candidates
            ):
                continue
            score = _candidate_score(fact, "direct")
            quarter = _parse_quarter(fact.get("period"))
            if quarter:
                score += quarter[0] + quarter[1] / 10.0
            if any(term in sheet for term in ("valuation output", "valuation metric", "\u4f30\u503c\u7ed3\u679c", "\u4f30\u503c\u6307\u6807")):
                score += 4.0
            existing = selected.get(key)
            if existing is None or score > existing[0]:
                selected[key] = (score, fact)
    return {key: fact for key, (_score, fact) in selected.items()}


FORWARD_PE_FACT_TERMS = (
    "forward pe",
    "forward p/e",
    "forward per",
    "fwd pe",
    "fwd p/e",
    "ntm pe",
    "ntm p/e",
    "next twelve month pe",
    "fy1 p/e",
    "动态市盈率",
    "预测市盈率",
)
TURNOVER_FACT_TERMS = (
    "20 day average turnover",
    "20d average turnover",
    "20 day average trading value",
    "20d average traded value",
    "近20日日均成交额",
    "20日平均成交额",
)


def _matching_direct_facts(
    facts: list[dict[str, Any]], terms: tuple[str, ...]
) -> list[dict[str, Any]]:
    normalized_terms = tuple(_normalize(term) for term in terms)
    return [
        fact
        for fact in facts
        if any(
            term
            in _normalize(f"{fact.get('metric_name', '')} {fact.get('metric_alias', '')}")
            for term in normalized_terms
        )
    ]


def _prepare_model_metric_facts(facts: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "quarterly": {
            kind: _quarterly_values(facts, kind)
            for kind in ("net_profit", "revenue", "gross_profit", "gross_margin", "cost")
        },
        "explicit": _explicit_five_metric_contract(facts),
        "forward": _matching_direct_facts(facts, FORWARD_PE_FACT_TERMS),
        "turnover": _matching_direct_facts(facts, TURNOVER_FACT_TERMS),
    }


def extract_model_metrics(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    series_id: str,
    model_version_id: str,
    doc_id: str,
    target_period: str = "",
    prepared_facts: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    prepared = prepared_facts or _prepare_model_metric_facts(
        _facts_for_document(conn, doc_id)
    )
    target_quarter = _parse_quarter(target_period)
    quarterly = prepared["quarterly"]
    net = quarterly["net_profit"]
    revenue = quarterly["revenue"]
    gross = quarterly["gross_profit"]
    gross_margin = quarterly["gross_margin"]
    cost = quarterly["cost"]
    if target_quarter is None:
        available = sorted(set(net) | set(revenue) | set(gross_margin), reverse=True)
        target_quarter = available[0] if available else None

    results: dict[str, dict[str, Any]] = {}

    def missing(key: str, method: str) -> dict[str, Any]:
        definition = METRIC_BY_KEY[key]
        return {
            "dataset_id": dataset_id,
            "series_id": series_id,
            "model_version_id": model_version_id,
            "metric_key": key,
            "value_numeric": None,
            "unit": definition.unit,
            "period": _quarter_label(target_quarter) if target_quarter else "",
            "status": "unavailable",
            "method": method,
            "source": "",
            "evidence_ids": [],
            "quality_status": "not_found",
        }

    for key in METRIC_KEYS:
        results[key] = missing(key, "not_found")

    for key, fact in prepared["explicit"].items():
        value = _safe_float(fact.get("value_numeric"))
        if value is None:
            continue
        results[key] = {
            **missing(key, "explicit_five_metric_contract"),
            "value_numeric": value,
            "period": str(fact.get("period") or target_period or "Model output"),
            "status": "available",
            "source": _source([fact]),
            "evidence_ids": _evidence([fact]),
            "quality_status": "explicit_model_output",
        }

    if target_quarter:
        current_net = net.get(target_quarter)
        yoy_net = net.get((target_quarter[0] - 1, target_quarter[1]))
        value = _growth(
            _safe_float(current_net.get("value_numeric")) if current_net else None,
            _safe_float(yoy_net.get("value_numeric")) if yoy_net else None,
        )
        if value is not None:
            inputs = [fact for fact in (current_net, yoy_net) if fact]
            results["quarter_net_profit_yoy"] = {
                **missing("quarter_net_profit_yoy", "standalone_quarter_yoy"),
                "value_numeric": value,
                "status": "available",
                "source": _source(inputs),
                "evidence_ids": _evidence(inputs),
                "quality_status": "derived_from_model_facts",
            }

        prior_quarter = _previous_quarter(target_quarter)

        def margin(key: tuple[int, int]) -> tuple[float | None, list[dict[str, Any]]]:
            rev_fact = revenue.get(key)
            gross_fact = gross.get(key)
            margin_fact = gross_margin.get(key)
            cost_fact = cost.get(key)
            if margin_fact:
                direct_margin = _safe_float(margin_fact.get("value_numeric"))
                if direct_margin is not None:
                    if 1.5 < abs(direct_margin) <= 100:
                        direct_margin /= 100.0
                    if -1.0 <= direct_margin <= 1.5:
                        return direct_margin, [margin_fact]
            rev = _safe_float(rev_fact.get("value_numeric")) if rev_fact else None
            if rev is None or abs(rev) <= 1e-12:
                return None, []
            if gross_fact:
                gp = _safe_float(gross_fact.get("value_numeric"))
                return (gp / rev if gp is not None else None), [rev_fact, gross_fact]
            if cost_fact:
                cogs = _safe_float(cost_fact.get("value_numeric"))
                if cogs is not None:
                    return (rev - abs(cogs)) / rev, [rev_fact, cost_fact]
            return None, []

        current_margin, current_margin_facts = margin(target_quarter)
        prior_margin, prior_margin_facts = margin(prior_quarter)
        if current_margin is not None and prior_margin is not None:
            inputs = current_margin_facts + prior_margin_facts
            results["quarter_gross_margin_qoq_delta"] = {
                **missing("quarter_gross_margin_qoq_delta", "quarter_margin_delta"),
                "value_numeric": current_margin - prior_margin,
                "status": "available",
                "source": _source(inputs),
                "evidence_ids": _evidence(inputs),
                "quality_status": "derived_from_model_facts",
            }

        def revenue_yoy(key: tuple[int, int]) -> tuple[float | None, list[dict[str, Any]]]:
            current = revenue.get(key)
            prior = revenue.get((key[0] - 1, key[1]))
            value = _growth(
                _safe_float(current.get("value_numeric")) if current else None,
                _safe_float(prior.get("value_numeric")) if prior else None,
            )
            return value, [fact for fact in (current, prior) if fact]

        current_revenue_yoy, current_revenue_facts = revenue_yoy(target_quarter)
        prior_revenue_yoy, prior_revenue_facts = revenue_yoy(prior_quarter)
        if current_revenue_yoy is not None and prior_revenue_yoy is not None:
            inputs = current_revenue_facts + prior_revenue_facts
            results["quarter_revenue_growth_qoq"] = {
                **missing("quarter_revenue_growth_qoq", "quarter_yoy_growth_acceleration"),
                "value_numeric": current_revenue_yoy - prior_revenue_yoy,
                "status": "available",
                "source": _source(inputs),
                "evidence_ids": _evidence(inputs),
                "quality_status": "derived_from_model_facts",
            }

    forward = _direct_fact(
        prepared["forward"],
        FORWARD_PE_FACT_TERMS,
        target_quarter,
    )
    if forward:
        value = _safe_float(forward.get("value_numeric"))
        if value is not None and 0 < value < 2000:
            results["forward_pe"] = {
                **missing("forward_pe", "explicit_forward_pe"),
                "value_numeric": value,
                "period": str(forward.get("period") or "Forward"),
                "status": "available",
                "source": _source([forward]),
                "evidence_ids": _evidence([forward]),
                "quality_status": "candidate_complete",
            }

    turnover = _direct_fact(
        prepared["turnover"],
        TURNOVER_FACT_TERMS,
        target_quarter,
    )
    if turnover:
        value = _safe_float(turnover.get("value_numeric"))
        if value is not None:
            results["avg_turnover_amount_20d"] = {
                **missing("avg_turnover_amount_20d", "explicit_model_value"),
                "value_numeric": value,
                "period": str(turnover.get("period") or "20D"),
                "status": "available",
                "source": _source([turnover]),
                "evidence_ids": _evidence([turnover]),
                "quality_status": "candidate_complete",
            }
    return [results[key] for key in METRIC_KEYS]


def _merge_agent_model_metrics(
    deterministic: list[dict[str, Any]],
    extraction: dict[str, Any] | None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Apply validated Skill values while retaining deterministic conflict guards."""

    formatted = (
        extraction.get("formatted_output")
        if isinstance(extraction, dict) and extraction.get("status") == "completed"
        else None
    )
    agent_metrics = formatted.get("metrics") if isinstance(formatted, dict) else None
    agent_by_key = {
        str(item.get("metric_key")): item
        for item in (agent_metrics or [])
        if isinstance(item, dict) and item.get("metric_key") in METRIC_BY_KEY
    }
    applied: list[str] = []
    conflicts: list[str] = []
    merged: list[dict[str, Any]] = []
    for fallback in deterministic:
        key = str(fallback["metric_key"])
        candidate = agent_by_key.get(key) or {}
        agent_value = _safe_float(candidate.get("value_numeric"))
        fallback_value = _safe_float(fallback.get("value_numeric"))
        if candidate.get("status") != "available" or agent_value is None:
            merged.append(fallback)
            continue
        if fallback_value is not None:
            tolerance = max(1e-8, abs(fallback_value) * 0.005)
            if abs(agent_value - fallback_value) > tolerance:
                conflicts.append(key)
                merged.append(
                    {
                        **fallback,
                        "quality_status": "agent_conflict_deterministic_fallback",
                    }
                )
                continue
        applied.append(key)
        merged.append(
            {
                **fallback,
                "value_numeric": agent_value,
                "unit": METRIC_BY_KEY[key].unit,
                "period": str(candidate.get("period") or fallback.get("period") or ""),
                "status": "available",
                "method": f"agent_skill:{candidate.get('method') or 'semantic_mapping'}",
                "source": str(candidate.get("source") or ""),
                "evidence_ids": list(candidate.get("evidence_ids") or []),
                "quality_status": "agent_skill_validated",
            }
        )
    return merged, {
        "status": str((extraction or {}).get("status") or "not_run"),
        "extraction_id": str((extraction or {}).get("extraction_id") or ""),
        "skill_name": str((extraction or {}).get("skill_name") or ""),
        "extractor_version": str((extraction or {}).get("extractor_version") or ""),
        "applied_metric_keys": applied,
        "conflict_metric_keys": conflicts,
        "error_message": str((extraction or {}).get("error_message") or ""),
        "formatted_output": formatted or {},
    }


def _apply_manual_metric_overrides(
    conn: sqlite3.Connection,
    *,
    model_version_id: str,
    model_metrics: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows = conn.execute(
        """
        SELECT * FROM valuation_metric_manual_overrides
        WHERE model_version_id=? AND is_active=1
        ORDER BY updated_at DESC
        """,
        (model_version_id,),
    ).fetchall()
    overrides: dict[str, dict[str, Any]] = {}
    audit_rows: list[dict[str, Any]] = []
    for row in rows:
        payload = dict(row)
        payload["evidence_ids"] = _decode(payload.pop("evidence_ids_json"), [])
        overrides[str(payload["metric_key"])] = payload
        audit_rows.append(payload)

    merged: list[dict[str, Any]] = []
    for model in model_metrics:
        key = str(model["metric_key"])
        override = overrides.get(key)
        if override is None:
            merged.append(model)
            continue
        merged.append(
            {
                **model,
                "value_numeric": _safe_float(override.get("value_numeric")),
                "unit": METRIC_BY_KEY[key].unit,
                "period": str(override.get("period") or ""),
                "status": "available",
                "method": str(override.get("method") or "manual_override:source_verified"),
                "source": str(override.get("source") or ""),
                "evidence_ids": list(override.get("evidence_ids") or []),
                "quality_status": str(override.get("quality_status") or "manual_verified"),
            }
        )
    return merged, audit_rows


def _normalize_actual_metric(key: str, raw: Any) -> dict[str, Any]:
    definition = METRIC_BY_KEY[key]
    if not isinstance(raw, dict):
        raw = {"value": raw}
    value = _safe_float(raw.get("value", raw.get("value_numeric")))
    return {
        "metric_key": key,
        "value_numeric": value,
        "unit": str(raw.get("unit") or definition.unit),
        "period": str(raw.get("period") or ""),
        "status": "available" if value is not None else str(raw.get("status") or "unavailable"),
        "source": str(raw.get("source") or ""),
        "observed_at": str(raw.get("observed_at") or ""),
        "metadata": raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {},
    }


def _market_window_end(value: Any) -> date | None:
    text = unicodedata.normalize("NFKC", str(value or "")).strip()
    match = re.search(r"(?:20D@)?(?P<date>20\d{2}[-/]\d{2}[-/]\d{2})", text)
    if not match:
        return None
    try:
        return date.fromisoformat(match.group("date").replace("/", "-"))
    except ValueError:
        return None


def _market_metric_periods_match(model_period: Any, actual_period: Any) -> bool:
    """Only compare a rolling market metric when both sides share an explicit end date."""

    model_end = _market_window_end(model_period)
    actual_end = _market_window_end(actual_period)
    return model_end is not None and actual_end is not None and model_end == actual_end


def _comparison(
    definition: MetricDefinition,
    model: dict[str, Any],
    actual: dict[str, Any],
) -> dict[str, Any]:
    model_value = _safe_float(model.get("value_numeric"))
    actual_value = _safe_float(actual.get("value_numeric"))
    if model_value is None or actual_value is None:
        missing = []
        if model_value is None:
            missing.append("模型值")
        if actual_value is None:
            missing.append("真实值")
        return {
            "model_value": model_value,
            "actual_value": actual_value,
            "absolute_gap": None,
            "relative_gap": None,
            "severity": "unavailable",
            "status": "incomplete",
            "explanation": f"{'、'.join(missing)}暂不可用，未触发预警。",
        }
    if actual.get("status") == "stale" and bool((actual.get("metadata") or {}).get("stale_fallback")):
        return {
            "model_value": model_value,
            "actual_value": actual_value,
            "absolute_gap": None,
            "relative_gap": None,
            "severity": "unavailable",
            "status": "stale",
            "explanation": "Stale market cache; gap alerts are suppressed.",
        }
    model_label = str(model.get("period") or "未知期间")
    actual_label = str(actual.get("period") or "未知期间")
    if definition.key in QUARTERLY_COMPARISON_KEYS:
        model_period = _parse_quarter(model.get("period"))
        actual_period = _parse_quarter(actual.get("period"))
        if model_period is None or actual_period is None or model_period != actual_period:
            return {
                "model_value": model_value,
                "actual_value": actual_value,
                "absolute_gap": None,
                "relative_gap": None,
                "severity": "unavailable",
                "status": "period_mismatch",
                "explanation": (
                    f"模型期间 {model_label} 与真实值期间 {actual_label} 不一致，"
                    "未计算差距、未触发预警。"
                ),
            }
    if definition.key == "avg_turnover_amount_20d" and not _market_metric_periods_match(
        model.get("period"), actual.get("period")
    ):
        return {
            "model_value": model_value,
            "actual_value": actual_value,
            "absolute_gap": None,
            "relative_gap": None,
            "severity": "unavailable",
            "status": "period_mismatch",
            "explanation": (
                f"模型成交额窗口 {model_label} 与 API 窗口 {actual_label} 不一致，"
                "仅展示两侧值，未计算差距、未触发预警。"
            ),
        }
    absolute_gap = model_value - actual_value
    relative_gap = absolute_gap / abs(actual_value) if abs(actual_value) > 1e-12 else None
    comparison_gap = abs(absolute_gap)
    if definition.gap_mode == "relative":
        comparison_gap = abs(relative_gap) if relative_gap is not None else math.inf
    if comparison_gap >= definition.critical_threshold:
        severity = "critical"
    elif comparison_gap >= definition.warning_threshold:
        severity = "warning"
    else:
        severity = "normal"
    if definition.gap_mode == "relative" and relative_gap is not None:
        gap_text = f"相对偏差 {relative_gap * 100:+.1f}%"
    elif definition.unit in {"percent", "percentage_point"}:
        gap_text = f"相差 {absolute_gap * 100:+.1f} 个百分点"
    else:
        gap_text = f"相差 {absolute_gap:+.2f}"
    return {
        "model_value": model_value,
        "actual_value": actual_value,
        "absolute_gap": absolute_gap,
        "relative_gap": relative_gap,
        "severity": severity,
        "status": "compared",
        "explanation": gap_text,
    }


def _alert_priority(severity: str) -> str:
    return "high" if severity == "critical" else "medium"




def refresh_model_metric_values(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    series: dict[str, Any],
    version: dict[str, Any],
    target_period: str = "",
) -> dict[str, Any]:
    """Rebuild the five persisted model values without contacting market APIs."""

    ensure_metric_schema(conn)
    model_version_id = str(version["model_version_id"])
    series_id = str(series["series_id"])
    deterministic = extract_model_metrics(
        conn,
        dataset_id=dataset_id,
        series_id=series_id,
        model_version_id=model_version_id,
        doc_id=str(version["doc_id"]),
        target_period=target_period,
    )
    agent_extraction = private_fund_valuation_metric_agent.latest_agent_extraction(
        conn,
        model_version_id=model_version_id,
    )
    model_metrics, skill_extraction = _merge_agent_model_metrics(
        deterministic,
        agent_extraction,
    )
    model_metrics, manual_overrides = _apply_manual_metric_overrides(
        conn,
        model_version_id=model_version_id,
        model_metrics=model_metrics,
    )
    now = _now_iso()
    for model in model_metrics:
        key = str(model["metric_key"])
        definition = METRIC_BY_KEY[key]
        conn.execute(
            """
            INSERT INTO valuation_metric_model_values
                (model_metric_id, dataset_id, series_id, model_version_id, metric_key,
                 value_numeric, unit, period, status, method, source,
                 evidence_ids_json, quality_status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(model_version_id, metric_key) DO UPDATE SET
                value_numeric=excluded.value_numeric, unit=excluded.unit,
                period=excluded.period, status=excluded.status, method=excluded.method,
                source=excluded.source, evidence_ids_json=excluded.evidence_ids_json,
                quality_status=excluded.quality_status, created_at=excluded.created_at
            """,
            (
                f"vmm_{_digest(model_version_id, key)}",
                dataset_id,
                series_id,
                model_version_id,
                key,
                model.get("value_numeric"),
                model.get("unit") or definition.unit,
                model.get("period"),
                model.get("status"),
                model.get("method"),
                model.get("source"),
                _json(model.get("evidence_ids") or []),
                model.get("quality_status") or "review_required",
                now,
            ),
        )
    return {
        "model_version_id": model_version_id,
        "model_metric_count": sum(
            1 for item in model_metrics if item.get("status") == "available"
        ),
        "metrics": model_metrics,
        "skill_extraction": {
            **skill_extraction,
            "manual_metric_keys": [
                str(item.get("metric_key"))
                for item in manual_overrides
                if item.get("metric_key")
            ],
        },
    }


def _latest_cached_market_metric(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    series_id: str,
    model_version_id: str,
    metric_key: str,
    ticker: str,
) -> dict[str, Any] | None:
    """Keep the last verified market window visible through a transient source outage."""

    row = conn.execute(
        """
        SELECT actual.*
        FROM valuation_metric_actual_values AS actual
        JOIN valuation_market_snapshots AS snapshot ON snapshot.snapshot_id=actual.snapshot_id
        WHERE actual.dataset_id=? AND actual.series_id=? AND actual.model_version_id=?
          AND actual.metric_key=? AND actual.value_numeric IS NOT NULL
          AND snapshot.company_ticker=?
        ORDER BY actual.created_at DESC
        LIMIT 1
        """,
        (dataset_id, series_id, model_version_id, metric_key, ticker),
    ).fetchone()
    if row is None:
        return None
    metadata = _decode(row["metadata_json"], {})
    if not isinstance(metadata, dict):
        metadata = {}
    source = str(row["source"] or "").strip()
    return {
        "metric_key": metric_key,
        "value_numeric": _safe_float(row["value_numeric"]),
        "unit": str(row["unit"] or METRIC_BY_KEY[metric_key].unit),
        "period": str(row["period"] or ""),
        "status": "stale",
        "source": f"{source} (last successful cache)" if source else "last successful cache",
        "observed_at": str(row["observed_at"] or ""),
        "metadata": {
            **metadata,
            "stale_fallback": True,
            "cached_at": str(row["created_at"] or ""),
        },
    }


def _with_persisted_model_fallback(
    conn: sqlite3.Connection,
    *,
    model_version_id: str,
    model_metrics: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Keep canonical model values when a market-period extraction has no match.

    Market refreshes align quarterly comparisons to the newest actual period. A
    model can legitimately have no forecast for that period, but that must not
    erase a model value extracted by the dedicated model-metric refresh job.
    """

    rows = conn.execute(
        """
        SELECT metric_key, value_numeric, unit, period, status, method, source,
               evidence_ids_json, quality_status
        FROM valuation_metric_model_values
        WHERE model_version_id=? AND status='available' AND value_numeric IS NOT NULL
        """,
        (model_version_id,),
    ).fetchall()
    persisted = {str(row["metric_key"]): row for row in rows}
    active_override_keys = {
        str(row["metric_key"])
        for row in conn.execute(
            """
            SELECT metric_key FROM valuation_metric_manual_overrides
            WHERE model_version_id=? AND is_active=1
            """,
            (model_version_id,),
        )
    }
    merged: list[dict[str, Any]] = []
    for model in model_metrics:
        key = str(model.get("metric_key") or "")
        row = persisted.get(key)
        if _safe_float(model.get("value_numeric")) is not None or row is None:
            merged.append(model)
            continue
        method = str(row["method"] or "")
        if method.startswith("manual_override:") and key not in active_override_keys:
            merged.append(model)
            continue
        merged.append(
            {
                **model,
                "value_numeric": _safe_float(row["value_numeric"]),
                "unit": str(row["unit"] or model.get("unit") or ""),
                "period": str(row["period"] or ""),
                "status": "available",
                "method": method,
                "source": str(row["source"] or ""),
                "evidence_ids": _decode(row["evidence_ids_json"], []),
                "quality_status": str(row["quality_status"] or "review_required"),
            }
        )
    return merged


def refresh_metric_comparison(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    series: dict[str, Any],
    version: dict[str, Any],
    provider: MarketDataProvider | None = None,
    llm_client: private_fund_valuation_metric_agent.ValuationMetricChatClient | None = None,
) -> dict[str, Any]:
    ensure_metric_schema(conn)
    provider = provider or default_market_data_provider()
    company_name = str(series.get("company_name") or "")
    ticker = str(series.get("company_ticker") or "")
    try:
        market = provider.fetch_metrics(company_name=company_name, ticker=ticker)
    except Exception as exc:  # noqa: BLE001 - provider failure is persisted, not fatal to ingest
        market = {
            "provider": getattr(provider, "name", type(provider).__name__),
            "status": "failed",
            "as_of": _now_iso(),
            "error": str(exc),
            "metrics": {},
        }
    if not isinstance(market, dict):
        market = {"status": "failed", "error": "provider returned invalid payload", "metrics": {}}
    now = _now_iso()
    model_version_id = str(version["model_version_id"])
    series_id = str(series["series_id"])
    snapshot_id = f"vmd_{_digest(dataset_id, series_id, model_version_id, now)}"
    market_metrics = market.get("metrics") if isinstance(market.get("metrics"), dict) else {}
    target_period = next(
        (
            str((market_metrics.get(key) or {}).get("period") or "")
            for key in (
                "quarter_net_profit_yoy",
                "quarter_gross_margin_qoq_delta",
                "quarter_revenue_growth_qoq",
            )
            if isinstance(market_metrics.get(key), dict)
            and (market_metrics.get(key) or {}).get("period")
        ),
        "",
    )
    deterministic_metrics = extract_model_metrics(
        conn,
        dataset_id=dataset_id,
        series_id=series_id,
        model_version_id=model_version_id,
        doc_id=str(version["doc_id"]),
        target_period=target_period,
    )
    agent_target_period = target_period or next(
        (
            str(item.get("period") or "")
            for item in deterministic_metrics
            if item.get("metric_key")
            in {
                "quarter_net_profit_yoy",
                "quarter_gross_margin_qoq_delta",
                "quarter_revenue_growth_qoq",
            }
            and item.get("status") == "available"
            and item.get("period")
        ),
        "",
    )
    agent_extraction = None
    if llm_client is not None:
        agent_extraction = private_fund_valuation_metric_agent.extract_with_skill(
            conn,
            dataset_id=dataset_id,
            series_id=series_id,
            model_version_id=model_version_id,
            doc_id=str(version["doc_id"]),
            version=version,
            target_period=agent_target_period,
            llm_client=llm_client,
        )
    else:
        agent_extraction = private_fund_valuation_metric_agent.latest_agent_extraction(
            conn,
            model_version_id=model_version_id,
        )
    model_metrics, skill_extraction = _merge_agent_model_metrics(
        deterministic_metrics,
        agent_extraction,
    )
    model_metrics, manual_overrides = _apply_manual_metric_overrides(
        conn,
        model_version_id=model_version_id,
        model_metrics=model_metrics,
    )
    model_metrics = _with_persisted_model_fallback(
        conn,
        model_version_id=model_version_id,
        model_metrics=model_metrics,
    )
    skill_extraction["manual_metric_keys"] = [
        key
        for key in METRIC_KEYS
        if any(str(item.get("metric_key")) == key for item in manual_overrides)
    ]
    skill_extraction["manual_overrides"] = manual_overrides
    formatted_extraction = skill_extraction.get("formatted_output") or {}
    actual_metrics = {
        key: _normalize_actual_metric(key, market_metrics.get(key)) for key in METRIC_KEYS
    }
    for key in METRIC_KEYS:
        if _safe_float(actual_metrics[key].get("value_numeric")) is not None:
            continue
        cached = _latest_cached_market_metric(
            conn,
            dataset_id=dataset_id,
            series_id=series_id,
            model_version_id=model_version_id,
            metric_key=key,
            ticker=ticker,
        )
        if cached is not None:
            actual_metrics[key] = cached
    conn.execute(
        """
        INSERT INTO valuation_market_snapshots
            (snapshot_id, dataset_id, series_id, model_version_id, company_name,
             company_ticker, provider, status, as_of, error_message, raw_json,
             identity_snapshot_json, is_stale, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        """,
        (
            snapshot_id,
            dataset_id,
            series_id,
            model_version_id,
            company_name,
            ticker,
            "",
            str(market.get("status") or "completed"),
            str(market.get("as_of") or now),
            str(market.get("error") or "")[:2000] or None,
            _json({key: value for key, value in market.items() if key != "provider"}),
            _json(
                {
                    "company_name": company_name,
                    "company_ticker": ticker,
                    "identity_source": series.get("identity_source") or "",
                    "identity_status": series.get("identity_status") or "",
                    "identity_updated_at": series.get("identity_updated_at") or "",
                }
            ),
            now,
        ),
    )
    comparisons: list[dict[str, Any]] = []
    for model in model_metrics:
        key = str(model["metric_key"])
        definition = METRIC_BY_KEY[key]
        actual = actual_metrics[key]
        conn.execute(
            """
            INSERT INTO valuation_metric_model_values
                (model_metric_id, dataset_id, series_id, model_version_id, metric_key,
                 value_numeric, unit, period, status, method, source,
                 evidence_ids_json, quality_status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(model_version_id, metric_key) DO UPDATE SET
                value_numeric=excluded.value_numeric, unit=excluded.unit,
                period=excluded.period, status=excluded.status, method=excluded.method,
                source=excluded.source, evidence_ids_json=excluded.evidence_ids_json,
                quality_status=excluded.quality_status, created_at=excluded.created_at
            WHERE valuation_metric_model_values.status<>'available'
               OR excluded.method LIKE 'manual_override:%'
               OR excluded.method LIKE 'agent_skill:%'
            """,
            (
                f"vmm_{_digest(model_version_id, key)}",
                dataset_id,
                series_id,
                model_version_id,
                key,
                model.get("value_numeric"),
                model.get("unit") or definition.unit,
                model.get("period"),
                model.get("status"),
                model.get("method"),
                model.get("source"),
                _json(model.get("evidence_ids") or []),
                model.get("quality_status") or "review_required",
                now,
            ),
        )
        conn.execute(
            """
            INSERT INTO valuation_metric_actual_values
                (actual_metric_id, snapshot_id, dataset_id, series_id, model_version_id,
                 metric_key, value_numeric, unit, period, status, source, observed_at,
                 metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                f"vma_{_digest(snapshot_id, key)}",
                snapshot_id,
                dataset_id,
                series_id,
                model_version_id,
                key,
                actual.get("value_numeric"),
                actual.get("unit") or definition.unit,
                actual.get("period"),
                actual.get("status"),
                actual.get("source"),
                actual.get("observed_at"),
                _json(actual.get("metadata") or {}),
                now,
            ),
        )
        calculated = _comparison(definition, model, actual)
        comparison_id = f"vmc5_{_digest(model_version_id, snapshot_id, key)}"
        evidence_ids = list(model.get("evidence_ids") or [])
        conn.execute(
            """
            INSERT INTO valuation_metric_comparisons
                (comparison_id, dataset_id, series_id, model_version_id, snapshot_id,
                 metric_key, model_value, actual_value, absolute_gap, relative_gap,
                 severity, status, explanation, model_period, actual_period,
                 model_source, actual_source, evidence_ids_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                comparison_id,
                dataset_id,
                series_id,
                model_version_id,
                snapshot_id,
                key,
                calculated["model_value"],
                calculated["actual_value"],
                calculated["absolute_gap"],
                calculated["relative_gap"],
                calculated["severity"],
                calculated["status"],
                calculated["explanation"],
                model.get("period"),
                actual.get("period"),
                model.get("source"),
                actual.get("source"),
                _json(evidence_ids),
                now,
            ),
        )
        item = {
            "comparison_id": comparison_id,
            "metric_key": key,
            "label": definition.label,
            "unit": definition.unit,
            "description": definition.description,
            **calculated,
            "model_period": model.get("period") or "",
            "actual_period": actual.get("period") or "",
            "model_source": model.get("source") or "",
            "actual_source": actual.get("source") or "",
            "model_quality_status": model.get("quality_status") or "",
            "evidence_ids": evidence_ids,
            "created_at": now,
        }
        comparisons.append(item)

        active_dedupe_key = ""
        alertable_metric = key in QUARTERLY_COMPARISON_KEYS
        if alertable_metric and calculated["severity"] in {"warning", "critical"}:
            active_dedupe_key = _digest(
                "model-actual-gap",
                model_version_id,
                key,
                calculated["severity"],
                length=40,
            )
        conn.execute(
            """
            UPDATE valuation_alerts
            SET status='dismissed', snoozed_until=NULL, updated_at=?
            WHERE dataset_id=? AND series_id=? AND alert_type='model_actual_gap'
              AND title=? AND status IN ('new','snoozed')
              AND (?='' OR dedupe_key<>?)
            """,
            (
                now,
                dataset_id,
                series_id,
                definition.label,
                active_dedupe_key,
                active_dedupe_key,
            ),
        )
        if not alertable_metric or calculated["severity"] not in {"warning", "critical"}:
            continue
        rule = conn.execute(
            """
            SELECT rule_id FROM valuation_watch_rules
            WHERE dataset_id=? AND active=1 AND (series_id IS NULL OR series_id='' OR series_id=?)
            ORDER BY created_at LIMIT 1
            """,
            (dataset_id, series_id),
        ).fetchone()
        if rule is None:
            continue
        dedupe_key = active_dedupe_key
        conn.execute(
            """
            INSERT OR IGNORE INTO valuation_alerts
                (alert_id, dataset_id, series_id, rule_id, change_id, alert_type,
                 priority, title, summary, evidence_ids_json, status, dedupe_key,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'model_actual_gap', ?, ?, ?, ?, 'new', ?, ?, ?)
            """,
            (
                f"val5_{_digest(dataset_id, dedupe_key)}",
                dataset_id,
                series_id,
                rule["rule_id"],
                comparison_id,
                _alert_priority(calculated["severity"]),
                definition.label,
                f"{definition.label}: {calculated['explanation']}",
                _json(evidence_ids),
                dedupe_key,
                now,
                now,
            ),
        )
    return {
        "snapshot_id": snapshot_id,
        "provider": str(market.get("provider") or getattr(provider, "name", "unknown")),
        "status": str(market.get("status") or "completed"),
        "as_of": str(market.get("as_of") or now),
        "error_message": str(market.get("error") or ""),
        "skill_extraction": skill_extraction,
        "comparisons": comparisons,
    }


_CONTEXT_CARD_TYPES = {
    "meeting_minutes": ("管理层口径", "用于解释经营节奏、管理层表述与模型假设。"),
    "research_report": ("外部观点", "用于交叉验证行业、竞争与盈利假设。"),
    "financial_report": ("财务复核", "用于核对财务口径、异常项目与披露时点。"),
    "earnings_release": ("业绩复核", "用于解释实际业绩与模型预测之间的差异。"),
}


def refresh_context_cards(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    model_version_id: str,
    limit: int = 12,
) -> list[dict[str, Any]]:
    ensure_metric_schema(conn)
    tables = {
        str(row[0]) for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    if "documents" not in tables:
        return []
    chunk_summary = (
        """
        COALESCE((SELECT NULLIF(c.summary,'') FROM chunks c
                  WHERE c.doc_id=d.doc_id ORDER BY c.chunk_index LIMIT 1),
                 (SELECT NULLIF(substr(c.content,1,360),'') FROM chunks c
                  WHERE c.doc_id=d.doc_id ORDER BY c.chunk_index LIMIT 1), '') AS excerpt
        """
        if "chunks" in tables
        else "'' AS excerpt"
    )
    model_subtypes = ",".join(f"'{value}'" for value in sorted(VALUATION_MODEL_SUBTYPES))
    model_predicates = [
        "COALESCE(d.doc_type,'')='valuation_model'",  # v1 compatibility
        f"COALESCE(d.doc_subtype,'') IN ({model_subtypes})",
    ]
    if "excel_workbooks" in tables:
        model_predicates.append(
            "EXISTS (SELECT 1 FROM excel_workbooks ew "
            "WHERE ew.doc_id=d.doc_id AND ew.workbook_type='valuation_model')"
        )
    rows = conn.execute(
        f"""
        SELECT d.doc_id, d.original_filename, d.doc_type, d.doc_subtype,
               d.document_date, {chunk_summary}
        FROM documents d
        WHERE d.dataset_id=? AND d.status='indexed'
          AND COALESCE(d.is_current,1)=1
          AND COALESCE(d.lifecycle_state,'active')='active'
          AND NOT ({" OR ".join(model_predicates)})
        ORDER BY COALESCE(d.document_date,'' ) DESC, d.created_at DESC
        LIMIT ?
        """,
        (dataset_id, max(1, min(limit, 30))),
    ).fetchall()
    conn.execute(
        "DELETE FROM valuation_context_cards WHERE dataset_id=? AND model_version_id=?",
        (dataset_id, model_version_id),
    )
    now = _now_iso()
    cards: list[dict[str, Any]] = []
    for row in rows:
        doc_type = str(row["doc_subtype"] or row["doc_type"] or "supporting_document")
        card_type, insight = _CONTEXT_CARD_TYPES.get(
            doc_type,
            _CONTEXT_CARD_TYPES.get(
                str(row["doc_type"] or ""),
                ("辅助证据", "用于解释模型假设，不参与五项指标数值和预警计算。"),
            ),
        )
        summary = re.sub(r"\s+", " ", str(row["excerpt"] or "")).strip()
        if not summary:
            summary = "文件已纳入估值模型辅助分析，等待可引用文本或结构化事实。"
        summary = summary[:360]
        source_name = str(row["original_filename"] or "辅助文件")
        card = {
            "card_id": f"vcc_{_digest(model_version_id, row['doc_id'])}",
            "card_type": card_type,
            "title": source_name.rsplit(".", 1)[0],
            "summary": summary,
            "insight": insight,
            "source_name": source_name,
            "document_date": str(row["document_date"] or ""),
            "evidence_ids": [f"document:{row['doc_id']}"],
        }
        conn.execute(
            """
            INSERT INTO valuation_context_cards
                (card_id, dataset_id, model_version_id, source_doc_id, card_type,
                 title, summary, insight, source_name, document_date,
                 evidence_ids_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                card["card_id"],
                dataset_id,
                model_version_id,
                row["doc_id"],
                card_type,
                card["title"],
                summary,
                insight,
                source_name,
                row["document_date"],
                _json(card["evidence_ids"]),
                now,
            ),
        )
        cards.append(card)
    return cards


def refresh_valuation_impacts(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    series_id: str,
    model_version_id: str,
    llm_client: private_fund_valuation_impact_agent.ValuationImpactChatClient | None = None,
    document_ids: list[str] | None = None,
    sentiment_adapter: private_fund_valuation_impact_agent.SentimentEvidenceAdapter | None = None,
    locale: str = "zh-CN",
) -> dict[str, Any]:
    """Generate source-backed valuation impacts or return the latest persisted run."""

    ensure_metric_schema(conn)
    if llm_client is None:
        return private_fund_valuation_impact_agent.latest_impact_payload(
            conn,
            dataset_id=dataset_id,
            model_version_id=model_version_id,
        )
    return private_fund_valuation_impact_agent.extract_with_skill(
        conn,
        dataset_id=dataset_id,
        series_id=series_id,
        model_version_id=model_version_id,
        llm_client=llm_client,
        document_ids=document_ids,
        sentiment_adapter=sentiment_adapter,
        locale=locale,
    )


def _timeline_quarter(value: Any) -> tuple[int, int] | None:
    parsed = _parse_quarter(value)
    if parsed is not None:
        return parsed
    text = unicodedata.normalize("NFKC", str(value or "")).upper().strip()
    dated = re.search(
        r"(?:20D@)?(?P<year>20\d{2})[-/]?(?P<month>\d{2})[-/]?(?P<day>\d{2})",
        text,
    )
    if dated:
        month = int(dated.group("month"))
        if 1 <= month <= 12:
            return int(dated.group("year")), (month - 1) // 3 + 1
    forecast = re.search(r"(?P<year>20\d{2})\s*(?:E|F|FY)", text)
    if forecast:
        return int(forecast.group("year")), 4
    return None


def _timeline_comparison(
    *,
    model_version_id: str,
    snapshot_id: str,
    period: str,
    definition: MetricDefinition,
    model: dict[str, Any],
    actual: dict[str, Any],
    created_at: str,
) -> dict[str, Any]:
    calculated = _comparison(definition, model, actual)
    return {
        "comparison_id": f"vmt_{_digest(model_version_id, snapshot_id, period, definition.key)}",
        "metric_key": definition.key,
        "label": definition.label,
        "unit": definition.unit,
        "description": definition.description,
        **calculated,
        "model_period": str(model.get("period") or ""),
        "actual_period": str(actual.get("period") or ""),
        "model_source": str(model.get("source") or ""),
        "model_method": str(model.get("method") or ""),
        "actual_source": str(actual.get("source") or ""),
        "model_quality_status": str(model.get("quality_status") or ""),
        "evidence_ids": list(model.get("evidence_ids") or []),
        "created_at": created_at,
    }


def _metric_timeline_payload(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    series_id: str,
    model_version_id: str,
    snapshot: sqlite3.Row | None,
) -> dict[str, Any]:
    version = conn.execute(
        "SELECT doc_id FROM valuation_model_versions WHERE model_version_id=?",
        (model_version_id,),
    ).fetchone()
    if version is None:
        return {"default_period": "", "latest_period": "", "periods": []}

    facts = _facts_for_document(conn, str(version["doc_id"]))
    prepared_facts = _prepare_model_metric_facts(facts)
    model_quarters: set[tuple[int, int]] = set()
    for values in prepared_facts["quarterly"].values():
        model_quarters.update(values)

    manual_rows = conn.execute(
        """
        SELECT period FROM valuation_metric_manual_overrides
        WHERE model_version_id=? AND is_active=1
        """,
        (model_version_id,),
    ).fetchall()
    for row in manual_rows:
        quarter = _timeline_quarter(row["period"])
        if quarter is not None:
            model_quarters.add(quarter)

    raw_market = _decode(snapshot["raw_json"], {}) if snapshot else {}
    raw_history = raw_market.get("metric_history") if isinstance(raw_market, dict) else None
    if not isinstance(raw_history, list):
        raw_history = []
    if not raw_history and isinstance(raw_market, dict):
        current_metrics = raw_market.get("metrics")
        if isinstance(current_metrics, dict):
            current_period = next(
                (
                    str((current_metrics.get(key) or {}).get("period") or "")
                    for key in QUARTERLY_COMPARISON_KEYS
                    if isinstance(current_metrics.get(key), dict)
                    and _timeline_quarter((current_metrics.get(key) or {}).get("period"))
                ),
                "",
            )
            if current_period:
                raw_history = [{"period": current_period, "metrics": current_metrics}]

    actual_by_quarter: dict[tuple[int, int], dict[str, Any]] = {}
    actual_observed_at: dict[tuple[int, int], str] = {}
    for entry in raw_history:
        if not isinstance(entry, dict):
            continue
        quarter = _timeline_quarter(entry.get("period"))
        entry_metrics = entry.get("metrics")
        if quarter is None or not isinstance(entry_metrics, dict):
            continue
        actual_by_quarter[quarter] = entry_metrics
        actual_observed_at[quarter] = str(entry.get("observed_at") or "")

    all_quarters = sorted(model_quarters | set(actual_by_quarter))[-24:]
    periods: list[dict[str, Any]] = []
    created_at = str(snapshot["created_at"] or "") if snapshot else ""
    snapshot_id = str(snapshot["snapshot_id"] or "") if snapshot else ""
    for quarter in all_quarters:
        period = _quarter_label(quarter)
        models = extract_model_metrics(
            conn,
            dataset_id=dataset_id,
            series_id=series_id,
            model_version_id=model_version_id,
            doc_id=str(version["doc_id"]),
            target_period=period,
            prepared_facts=prepared_facts,
        )
        models, _ = _apply_manual_metric_overrides(
            conn,
            model_version_id=model_version_id,
            model_metrics=models,
        )
        model_by_key = {str(item["metric_key"]): item for item in models}
        raw_actuals = actual_by_quarter.get(quarter, {})
        comparisons = []
        for definition in QUARTERLY_METRIC_DEFINITIONS:
            model = model_by_key[definition.key]
            if (
                definition.key not in QUARTERLY_COMPARISON_KEYS
                and _safe_float(model.get("value_numeric")) is not None
                and _timeline_quarter(model.get("period")) != quarter
            ):
                model = {
                    **model,
                    "value_numeric": None,
                    "status": "unavailable",
                    "source": "",
                    "evidence_ids": [],
                    "quality_status": "not_in_period",
                }
            actual = _normalize_actual_metric(definition.key, raw_actuals.get(definition.key))
            comparisons.append(
                _timeline_comparison(
                    model_version_id=model_version_id,
                    snapshot_id=snapshot_id,
                    period=period,
                    definition=definition,
                    model=model,
                    actual=actual,
                    created_at=created_at,
                )
            )
        model_count = sum(item["model_value"] is not None for item in comparisons)
        actual_count = sum(item["actual_value"] is not None for item in comparisons)
        compared_count = sum(item["status"] == "compared" for item in comparisons)
        alert_count = sum(item["severity"] in {"warning", "critical"} for item in comparisons)
        if compared_count:
            status = "comparable"
        elif model_count and actual_count:
            status = "partial"
        elif model_count:
            status = "model_only"
        elif actual_count:
            status = "actual_only"
        else:
            status = "unavailable"
        periods.append(
            {
                "period": period,
                "label": f"{quarter[0]} Q{quarter[1]}",
                "status": status,
                "model_available_count": model_count,
                "actual_available_count": actual_count,
                "compared_count": compared_count,
                "alert_count": alert_count,
                "observed_at": actual_observed_at.get(quarter, ""),
                "comparisons": comparisons,
            }
        )

    comparable = [item for item in periods if item["compared_count"]]
    with_actual = [item for item in periods if item["actual_available_count"]]
    default_candidates = comparable or with_actual or periods
    default_period = str(default_candidates[-1]["period"]) if default_candidates else ""
    return {
        "default_period": default_period,
        "latest_period": str(periods[-1]["period"]) if periods else "",
        "periods": periods,
    }


def _market_snapshot_payload(
    comparisons: list[dict[str, Any]],
    *,
    as_of: str,
) -> dict[str, Any]:
    market_keys = {"forward_pe", "avg_turnover_amount_20d"}
    items = [item for item in comparisons if str(item.get("metric_key")) in market_keys]
    model_count = sum(_safe_float(item.get("model_value")) is not None for item in items)
    actual_count = sum(_safe_float(item.get("actual_value")) is not None for item in items)
    compared_count = sum(str(item.get("status")) == "compared" for item in items)
    mismatch_count = sum(str(item.get("status")) == "period_mismatch" for item in items)
    if compared_count:
        status = "comparable"
    elif model_count or actual_count:
        status = "partial"
    else:
        status = "unavailable"
    return {
        "label": "当前市场快照",
        "as_of": as_of,
        "status": status,
        "model_available_count": model_count,
        "actual_available_count": actual_count,
        "compared_count": compared_count,
        "period_mismatch_count": mismatch_count,
        "comparisons": items,
    }


def latest_metric_payload(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    series_id: str,
    model_version_id: str,
) -> dict[str, Any]:
    ensure_metric_schema(conn)
    skill_extraction = private_fund_valuation_metric_agent.latest_agent_extraction(
        conn,
        model_version_id=model_version_id,
    )
    if skill_extraction:
        application_rows = conn.execute(
            """
            SELECT metric_key, method, quality_status
            FROM valuation_metric_model_values
            WHERE model_version_id=?
            """,
            (model_version_id,),
        ).fetchall()
        applied_keys = {
            str(row["metric_key"])
            for row in application_rows
            if str(row["method"] or "").startswith("agent_skill:")
        }
        conflict_keys = {
            str(row["metric_key"])
            for row in application_rows
            if str(row["quality_status"] or "") == "agent_conflict_deterministic_fallback"
        }
        skill_extraction["applied_metric_keys"] = [
            key for key in METRIC_KEYS if key in applied_keys
        ]
        skill_extraction["conflict_metric_keys"] = [
            key for key in METRIC_KEYS if key in conflict_keys
        ]
    manual_rows = conn.execute(
        """
        SELECT * FROM valuation_metric_manual_overrides
        WHERE model_version_id=? AND is_active=1
        ORDER BY updated_at DESC
        """,
        (model_version_id,),
    ).fetchall()
    manual_overrides = []
    for row in manual_rows:
        item = dict(row)
        item["evidence_ids"] = _decode(item.pop("evidence_ids_json"), [])
        manual_overrides.append(item)
    skill_payload = skill_extraction or {
        "status": "pending",
        "skill_name": private_fund_valuation_metric_agent.SKILL_NAME,
        "extractor_version": private_fund_valuation_metric_agent.EXTRACTOR_VERSION,
        "formatted_output": {},
        "applied_metric_keys": [],
        "conflict_metric_keys": [],
        "error_message": "等待估值指标 Agent 识别。",
    }
    skill_payload["manual_metric_keys"] = [
        key
        for key in METRIC_KEYS
        if any(str(item.get("metric_key")) == key for item in manual_overrides)
    ]
    skill_payload["manual_overrides"] = manual_overrides
    snapshot = conn.execute(
        """
        SELECT * FROM valuation_market_snapshots
        WHERE dataset_id=? AND series_id=? AND model_version_id=?
        ORDER BY created_at DESC LIMIT 1
        """,
        (dataset_id, series_id, model_version_id),
    ).fetchone()
    raw_market_payload = _decode(snapshot["raw_json"], {}) if snapshot else {}
    if not isinstance(raw_market_payload, dict):
        raw_market_payload = {}
    provider_attempts = raw_market_payload.get("provider_attempts")
    if not isinstance(provider_attempts, list):
        provider_attempts = []
    comparisons_by_key: dict[str, dict[str, Any]] = {}
    if snapshot:
        for row in conn.execute(
            """
            SELECT c.*, m.quality_status AS model_quality_status,
                   m.method AS model_method
            FROM valuation_metric_comparisons c
            LEFT JOIN valuation_metric_model_values m
              ON m.model_version_id=c.model_version_id AND m.metric_key=c.metric_key
            WHERE c.snapshot_id=?
            """,
            (snapshot["snapshot_id"],),
        ):
            payload = dict(row)
            payload["evidence_ids"] = _decode(payload.pop("evidence_ids_json"), [])
            definition = METRIC_BY_KEY[str(row["metric_key"])]
            payload.update(
                {
                    "label": definition.label,
                    "unit": definition.unit,
                    "description": definition.description,
                }
            )
            comparisons_by_key[str(row["metric_key"])] = payload
    comparisons = []
    for definition in METRIC_DEFINITIONS:
        comparisons.append(
            comparisons_by_key.get(
                definition.key,
                {
                    "comparison_id": "",
                    "metric_key": definition.key,
                    "label": definition.label,
                    "unit": definition.unit,
                    "description": definition.description,
                    "model_value": None,
                    "actual_value": None,
                    "absolute_gap": None,
                    "relative_gap": None,
                    "severity": "unavailable",
                    "status": "pending",
                    "explanation": "等待模型解析与真实数据刷新。",
                    "model_period": "",
                    "actual_period": "",
                    "model_source": "",
                    "model_method": "",
                    "actual_source": "",
                    "model_quality_status": "",
                    "evidence_ids": [],
                    "created_at": "",
                "is_stale": False,
                "identity_snapshot": {},
                },
            )
        )
    cards = []
    for row in conn.execute(
        """
        SELECT * FROM valuation_context_cards
        WHERE dataset_id=? AND model_version_id=?
        ORDER BY COALESCE(document_date,'') DESC, created_at DESC
        """,
        (dataset_id, model_version_id),
    ):
        card = dict(row)
        card["evidence_ids"] = _decode(card.pop("evidence_ids_json"), [])
        cards.append(card)
    valuation_impacts = private_fund_valuation_impact_agent.latest_impact_payload(
        conn,
        dataset_id=dataset_id,
        model_version_id=model_version_id,
    )
    metric_timeline = _metric_timeline_payload(
        conn,
        dataset_id=dataset_id,
        series_id=series_id,
        model_version_id=model_version_id,
        snapshot=snapshot,
    )
    return {
        "skill_extraction": skill_payload,
        "market_data": (
            {
                "snapshot_id": snapshot["snapshot_id"],
                "status": snapshot["status"],
                "as_of": snapshot["as_of"],
                "error_message": snapshot["error_message"] or "",
                "provider_attempts": provider_attempts,
                "created_at": snapshot["created_at"],
                "is_stale": bool(snapshot["is_stale"] if "is_stale" in snapshot.keys() else 0),
                "identity_snapshot": _decode(snapshot["identity_snapshot_json"] if "identity_snapshot_json" in snapshot.keys() else None, {}),
            }
            if snapshot
            else {
                "snapshot_id": "",
                "status": "pending",
                "as_of": "",
                "error_message": "等待真实数据刷新。",
                "provider_attempts": [],
                "created_at": "",
                "is_stale": False,
                "identity_snapshot": {},
            }
        ),
        "metric_comparisons": comparisons,
        "market_snapshot": _market_snapshot_payload(
            comparisons,
            as_of=str(snapshot["as_of"] or "") if snapshot else "",
        ),
        "metric_timeline": metric_timeline,
        "context_cards": cards,
        "valuation_impacts": valuation_impacts,
    }


def period_market_snapshot(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    series_id: str,
    model_version_id: str,
    period: str,
    provider: MarketDataProvider | None = None,
) -> dict[str, Any]:
    """Compare model market assumptions with iFinD values at the selected quarter end."""

    ensure_metric_schema(conn)
    quarter = _parse_quarter(period)
    if quarter is None:
        raise ValueError("period must use YYYYQ1-YYYYQ4 format")
    row = conn.execute(
        """
        SELECT s.company_name, s.company_ticker, v.doc_id
        FROM valuation_model_series AS s
        JOIN valuation_model_versions AS v ON v.series_id=s.series_id
        WHERE s.dataset_id=? AND s.series_id=? AND v.model_version_id=?
        """,
        (dataset_id, series_id, model_version_id),
    ).fetchone()
    if row is None:
        raise KeyError(model_version_id)

    models = extract_model_metrics(
        conn,
        dataset_id=dataset_id,
        series_id=series_id,
        model_version_id=model_version_id,
        doc_id=str(row["doc_id"]),
        target_period=_quarter_label(quarter),
    )
    models, _ = _apply_manual_metric_overrides(
        conn,
        model_version_id=model_version_id,
        model_metrics=models,
    )
    model_by_key = {str(item["metric_key"]): item for item in models}

    today = _now().date()
    quarter_start = date(quarter[0], (quarter[1] - 1) * 3 + 1, 1)
    requested_as_of = min(_quarter_end_date(quarter), today)
    market: dict[str, Any] = {"metrics": {}, "as_of": "", "provider": "ifind"}
    error = ""
    active_provider = provider or default_market_data_provider()
    fetch_period = getattr(active_provider, "fetch_market_metrics_as_of", None)
    if quarter_start > today:
        error = "The selected quarter has not started; no market snapshot is available."
    elif not callable(fetch_period):
        error = "The configured market-data provider does not support period snapshots."
    else:
        try:
            market = fetch_period(ticker=str(row["company_ticker"] or ""), as_of=requested_as_of)
        except Exception as exc:  # noqa: BLE001 - model values remain visible
            error = str(exc)[:500]

    raw_actuals = market.get("metrics") if isinstance(market.get("metrics"), dict) else {}
    comparisons: list[dict[str, Any]] = []
    created_at = _now_iso()
    for definition in MARKET_METRIC_DEFINITIONS:
        model = model_by_key[definition.key]
        if (
            _safe_float(model.get("value_numeric")) is not None
            and _timeline_quarter(model.get("period")) != quarter
        ):
            model = {
                **model,
                "value_numeric": None,
                "status": "unavailable",
                "source": "",
                "evidence_ids": [],
                "quality_status": "not_in_period",
            }
        actual = _normalize_actual_metric(definition.key, raw_actuals.get(definition.key))
        calculation_model = model
        if (
            definition.key == "avg_turnover_amount_20d"
            and _safe_float(model.get("value_numeric")) is not None
            and _safe_float(actual.get("value_numeric")) is not None
        ):
            calculation_model = {**model, "period": actual.get("period")}
        comparison = _timeline_comparison(
            model_version_id=model_version_id,
            snapshot_id=f"period-{period}",
            period=period,
            definition=definition,
            model=calculation_model,
            actual=actual,
            created_at=created_at,
        )
        comparison["model_period"] = str(model.get("period") or "")
        comparisons.append(comparison)

    payload = _market_snapshot_payload(
        comparisons,
        as_of=str(market.get("as_of") or requested_as_of.isoformat()),
    )
    return {
        **payload,
        "label": f"{_quarter_label(quarter)} 市场快照",
        "period": _quarter_label(quarter),
        "error_message": error,
    }


def _ifind_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Normalize the common JSON/table shapes returned by iFinD HTTP."""

    indicator_names = [str(item) for item in payload.get("indicators") or []]
    if not indicator_names:
        indicator_names = [
            str(item.get("itemid"))
            for item in payload.get("datatype") or []
            if isinstance(item, dict) and item.get("itemid")
        ]
    if not indicator_names:
        indicator_names = [
            *IFIND_FINANCIAL_INDICATORS.values(),
            *IFIND_MARKET_INDICATORS.values(),
        ]
    root_times = payload.get("time") if isinstance(payload.get("time"), list) else []
    rows: list[dict[str, Any]] = []

    def consume(node: Any, times: list[Any]) -> None:
        if isinstance(node, list):
            if node and all(isinstance(item, dict) for item in node):
                for item in node:
                    consume(item, times)
                return
            if node and all(isinstance(item, list) for item in node):
                if times and len(node) == len(times):
                    for index, values in enumerate(node):
                        row = {name: value for name, value in zip(indicator_names, values)}
                        row["time"] = times[index]
                        rows.append(row)
                elif times and len(node) == len(indicator_names):
                    for index, timestamp in enumerate(times):
                        row = {
                            name: values[index] if index < len(values) else None
                            for name, values in zip(indicator_names, node)
                        }
                        row["time"] = timestamp
                        rows.append(row)
                return
            if len(indicator_names) == 1 and times and len(node) == len(times):
                rows.extend(
                    {"time": timestamp, indicator_names[0]: value}
                    for timestamp, value in zip(times, node)
                )
            return
        if not isinstance(node, dict):
            return

        local_times = node.get("time") if isinstance(node.get("time"), list) else times
        scalar_time = node.get("time") if not isinstance(node.get("time"), list) else None
        scalar_row = {
            name: node.get(name)
            for name in indicator_names
            if name in node and not isinstance(node.get(name), (list, dict))
        }
        if scalar_time not in (None, "") and scalar_row:
            rows.append({"time": scalar_time, **scalar_row})

        series = {
            name: node.get(name)
            for name in indicator_names
            if isinstance(node.get(name), list)
        }
        if local_times and series:
            for index, timestamp in enumerate(local_times):
                rows.append(
                    {
                        "time": timestamp,
                        **{
                            name: values[index] if index < len(values) else None
                            for name, values in series.items()
                        },
                    }
                )

        for key in ("table", "data", "tables"):
            child = node.get(key)
            if child is not None:
                consume(child, local_times)
        for key, child in node.items():
            if key in {"time", "table", "data", "tables", *indicator_names}:
                continue
            if isinstance(child, dict) and re.fullmatch(r"[A-Z0-9.]+", str(key)):
                consume(child, local_times)

    consume(payload.get("data", payload.get("tables", payload)), root_times)
    deduplicated: dict[str, dict[str, Any]] = {}
    for row in rows:
        timestamp = _date_text(row.get("time"))
        if not timestamp:
            continue
        merged = deduplicated.setdefault(timestamp, {"time": timestamp})
        merged.update({key: value for key, value in row.items() if key != "time"})
    return [deduplicated[key] for key in sorted(deduplicated)]


class IFindHttpMarketDataProvider:
    """Direct adapter for the official iFinD HTTP date-sequence API."""

    name = "ifind"

    def __init__(
        self,
        base_url: str,
        access_token: str,
        *,
        refresh_token: str = "",
        http_client: Any | None = None,
        request_timeout_seconds: float = 30.0,
    ) -> None:
        self.base_url = str(base_url or IFIND_DEFAULT_BASE_URL).rstrip("/")
        self._access_token = str(access_token or "").strip()
        self._refresh_token = str(refresh_token or "").strip()
        self._http_client = http_client
        self.request_timeout_seconds = request_timeout_seconds

    def _refresh_access_token(self) -> str:
        if not self._refresh_token:
            raise ValueError("iFinD refresh token is not configured.")
        post = self._http_client.post if self._http_client is not None else httpx.post
        response = post(
            f"{self.base_url}/get_access_token",
            headers={"Content-Type": "application/json", "refresh_token": self._refresh_token},
            timeout=self.request_timeout_seconds,
        )
        response.raise_for_status()
        payload = response.json()
        token = str(((payload.get("data") or {}).get("access_token")) or "").strip()
        if not token:
            raise ValueError("iFinD get_access_token returned no access token.")
        self._access_token = token
        return token

    def _date_sequence(self, body: dict[str, Any]) -> dict[str, Any]:
        if not self._access_token:
            self._refresh_access_token()
        return self._post_date_sequence(body, retry_auth=True)

    def _post_date_sequence(self, body: dict[str, Any], *, retry_auth: bool) -> dict[str, Any]:
        headers = {"Content-Type": "application/json", "access_token": self._access_token, "ifindlang": "cn"}
        post = self._http_client.post if self._http_client is not None else httpx.post
        response = post(f"{self.base_url}/date_sequence", json=body, headers=headers, timeout=self.request_timeout_seconds)
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            if retry_auth and exc.response.status_code in {401, 403} and self._refresh_token:
                self._refresh_access_token()
                return self._post_date_sequence(body, retry_auth=False)
            raise
        payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError("iFinD date_sequence returned a non-object payload")
        error_code = payload.get("errorcode", 0)
        if str(error_code).strip() not in {"", "0", "0.0"}:
            message = str(payload.get("errmsg") or "unknown iFinD error")[:500]
            if retry_auth and self._refresh_token and "token" in message.lower():
                self._refresh_access_token()
                return self._post_date_sequence(body, retry_auth=False)
            raise ValueError(f"iFinD error {error_code}: {message}")
        return payload

    def _safe_error(self, exc: BaseException) -> str:
        message = str(exc)
        if self._access_token:
            message = message.replace(self._access_token, "[redacted]")
        if self._refresh_token:
            message = message.replace(self._refresh_token, "[redacted]")
        return message[:500]

    @staticmethod
    def _financial_metrics(
        rows: list[dict[str, Any]],
        indicators: dict[str, str] | None = None,
    ) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
        indicators = indicators or IFIND_FINANCIAL_INDICATORS
        by_quarter: dict[tuple[int, int], dict[str, Any]] = {}
        for row in rows:
            quarter = _quarter_from_end_date(str(row.get("time") or ""))
            if quarter is not None:
                by_quarter[quarter] = row

        def raw(key: tuple[int, int], indicator: str) -> float | None:
            return _safe_float((by_quarter.get(key) or {}).get(indicator))

        def build(key: tuple[int, int]) -> dict[str, dict[str, Any]]:
            prior = _previous_quarter(key)
            observed_at = str((by_quarter.get(key) or {}).get("time") or "")
            result: dict[str, dict[str, Any]] = {}
            net_profit = raw(key, indicators["net_profit_yoy"])
            if net_profit is not None:
                result["quarter_net_profit_yoy"] = {
                    "value": net_profit / 100.0,
                    "period": _quarter_label(key),
                    "unit": "percent",
                    "source": "iFinD official date_sequence",
                    "observed_at": observed_at,
                    "metadata": {
                        "indicator": indicators["net_profit_yoy"],
                        "raw_value": net_profit,
                        "raw_unit": "percent",
                    },
                }

            margin_indicator = indicators["gross_margin"]
            current_margin = raw(key, margin_indicator)
            prior_margin = raw(prior, margin_indicator)
            fallback = indicators.get("gross_margin_fallback")
            if fallback and (current_margin is None or prior_margin is None):
                fallback_current = raw(key, fallback)
                fallback_prior = raw(prior, fallback)
                if fallback_current is not None and fallback_prior is not None:
                    margin_indicator = fallback
                    current_margin, prior_margin = fallback_current, fallback_prior
            if current_margin is not None and prior_margin is not None:
                result["quarter_gross_margin_qoq_delta"] = {
                    "value": (current_margin - prior_margin) / 100.0,
                    "period": _quarter_label(key),
                    "unit": "percentage_point",
                    "source": "iFinD official date_sequence",
                    "observed_at": observed_at,
                    "metadata": {
                        "indicator": margin_indicator,
                        "current_raw_value": current_margin,
                        "previous_raw_value": prior_margin,
                        "raw_unit": "percent",
                    },
                }

            current_revenue = raw(key, indicators["revenue_yoy"])
            prior_revenue = raw(prior, indicators["revenue_yoy"])
            if current_revenue is not None and prior_revenue is not None:
                result["quarter_revenue_growth_qoq"] = {
                    "value": (current_revenue - prior_revenue) / 100.0,
                    "period": _quarter_label(key),
                    "unit": "percentage_point",
                    "source": "iFinD official date_sequence",
                    "observed_at": observed_at,
                    "metadata": {
                        "indicator": indicators["revenue_yoy"],
                        "current_raw_value": current_revenue,
                        "previous_raw_value": prior_revenue,
                        "raw_unit": "percent",
                    },
                }
            return result

        built = [(key, build(key)) for key in sorted(by_quarter, reverse=True)]
        latest = next((values for _key, values in built if values), {})
        history = [
            {
                "period": _quarter_label(key),
                "observed_at": str((by_quarter.get(key) or {}).get("time") or ""),
                "metrics": values,
            }
            for key, values in reversed(built[:20])
            if values
        ]
        return latest, history

    @staticmethod
    def _market_metrics(
        rows: list[dict[str, Any]],
        indicators: dict[str, str] | None = None,
        *,
        currency: str = "CNY",
    ) -> dict[str, dict[str, Any]]:
        indicators = indicators or IFIND_MARKET_INDICATORS
        metrics: dict[str, dict[str, Any]] = {}
        dated_rows = sorted(rows, key=lambda row: str(row.get("time") or ""))
        forward_indicator = indicators["forward_pe"]
        forward_rows = [
            row for row in dated_rows if _safe_float(row.get(forward_indicator)) is not None
        ]
        if forward_rows:
            latest = forward_rows[-1]
            metrics["forward_pe"] = {
                "value": _safe_float(latest.get(forward_indicator)),
                "period": str(latest.get("time") or ""),
                "unit": "multiple",
                "source": "iFinD official date_sequence",
                "observed_at": str(latest.get("time") or ""),
                "metadata": {"indicator": forward_indicator},
            }

        amount_indicator = indicators["turnover_amount"]
        amount_rows = [
            row for row in dated_rows if _safe_float(row.get(amount_indicator)) is not None
        ]
        sample = amount_rows[-20:]
        if len(sample) == 20:
            amounts = [_safe_float(row.get(amount_indicator)) for row in sample]
            end_date = str(sample[-1].get("time") or "")
            metrics["avg_turnover_amount_20d"] = {
                "value": sum(value for value in amounts if value is not None) / 20.0,
                "period": f"20D@{end_date}",
                "unit": "currency",
                "source": "iFinD official date_sequence",
                "observed_at": end_date,
                "metadata": {
                    "indicator": amount_indicator,
                    "raw_unit": currency,
                    "unit_assumption": True,
                    "sample_count": 20,
                    "window_start": str(sample[0].get("time") or ""),
                    "window_end": end_date,
                },
            }
        return metrics

    def fetch_metrics(self, *, company_name: str, ticker: str) -> dict[str, Any]:
        del company_name
        identity = _security_identity(ticker)

        if not self._access_token and not self._refresh_token:
            return {
                "provider": self.name,
                "status": "unavailable",
                "as_of": _now_iso(),
                "ticker": identity.canonical_ticker,
                "metrics": {},
                "metric_history": [],
                "error": "iFinD access or refresh token is not configured.",
            }

        end = _now().date()
        metrics: dict[str, dict[str, Any]] = {}
        history: list[dict[str, Any]] = []
        errors: list[str] = []
        financial_indicators, _market_indicators = _ifind_indicators(identity)
        financial_body = {
            "codes": _ifind_ticker(identity),
            "startdate": (end - timedelta(days=5 * 366)).isoformat(),
            "enddate": end.isoformat(),
            "functionpara": {"Interval": "Q", "Fill": "Blank", "Days": "Alldays"},
            "indipara": [
                {
                    "indicator": indicator,
                    "indiparams": [""] if identity.market == "hk" else ["", ""],
                }
                for indicator in financial_indicators.values()
            ],
        }
        try:
            financial_payload = self._date_sequence(financial_body)
            financial_metrics, history = self._financial_metrics(
                _ifind_rows(financial_payload), financial_indicators
            )
            metrics.update(financial_metrics)
        except Exception as exc:  # noqa: BLE001 - the market request must still run
            errors.append(self._safe_error(exc))

        try:
            market = self.fetch_market_metrics_as_of(ticker=ticker, as_of=end)
            metrics.update(market["metrics"])
        except Exception as exc:  # noqa: BLE001 - financial fields remain usable
            errors.append(self._safe_error(exc))

        missing = [key for key in METRIC_KEYS if key not in metrics]
        return {
            "provider": self.name,
            "status": "completed" if not missing else "partial" if metrics else "unavailable",
            "as_of": _now_iso(),
            "ticker": identity.canonical_ticker,
            "metrics": metrics,
            "metric_history": history,
            "missing_metric_keys": missing,
            "error": "; ".join(dict.fromkeys(error for error in errors if error)),
        }

    def fetch_market_metrics_as_of(self, *, ticker: str, as_of: date) -> dict[str, Any]:
        identity = _security_identity(ticker)

        if not self._access_token and not self._refresh_token:
            raise ValueError("iFinD access or refresh token is not configured.")
        _financial_indicators, market_indicators = _ifind_indicators(identity)
        market_body = {
            "codes": _ifind_ticker(identity),
            "startdate": (as_of - timedelta(days=60)).isoformat(),
            "enddate": as_of.isoformat(),
            "functionpara": {"Interval": "D", "Fill": "Blank", "Days": "Tradedays"},
            "indipara": [
                {
                    "indicator": indicator,
                    "indiparams": ["", "BB"]
                    if identity.market == "hk"
                    and indicator == market_indicators["turnover_amount"]
                    else [""],
                }
                for indicator in market_indicators.values()
            ],
        }
        market_payload = self._date_sequence(market_body)
        metrics = self._market_metrics(
            _ifind_rows(market_payload),
            market_indicators,
            currency=identity.currency,
        )
        return {
            "provider": self.name,
            "status": "completed" if len(metrics) == 2 else "partial" if metrics else "unavailable",
            "as_of": max(
                (str(item.get("observed_at") or "") for item in metrics.values()),
                default=as_of.isoformat(),
            ),
            "ticker": identity.canonical_ticker,
            "metrics": metrics,
            "missing_metric_keys": [
                item.key for item in MARKET_METRIC_DEFINITIONS if item.key not in metrics
            ],
        }
