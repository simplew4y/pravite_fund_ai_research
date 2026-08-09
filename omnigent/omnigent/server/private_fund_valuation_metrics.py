"""Five-metric valuation model versus market-data comparison.

The valuation workbook remains immutable evidence.  This module reads the
facts produced by the ingest pipeline, derives exactly five decision metrics,
fetches matching observations through a configurable market-data provider,
and persists an auditable comparison snapshot.  Missing provider data is
represented explicitly; trailing P/E is never substituted for Forward P/E.
"""

from __future__ import annotations

import copy
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

    def fetch_daily_prices(
        self, *, ticker: str, start_date: date, end_date: date
    ) -> dict[str, Any]: ...


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

        CREATE TABLE IF NOT EXISTS valuation_market_price_bars (
            bar_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            provider_symbol TEXT NOT NULL,
            canonical_ticker TEXT NOT NULL,
            exchange TEXT NOT NULL,
            currency TEXT NOT NULL,
            trade_date TEXT NOT NULL,
            open REAL,
            high REAL,
            low REAL,
            close REAL NOT NULL,
            volume REAL,
            amount REAL,
            adjustment TEXT NOT NULL DEFAULT 'raw',
            source TEXT,
            fetched_at TEXT NOT NULL,
            UNIQUE(dataset_id, provider, provider_symbol, trade_date, adjustment)
        );

        CREATE TABLE IF NOT EXISTS valuation_price_comparisons (
            price_comparison_id TEXT PRIMARY KEY,
            snapshot_id TEXT NOT NULL,
            dataset_id TEXT NOT NULL,
            series_id TEXT NOT NULL,
            model_version_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            provider_symbol TEXT,
            currency TEXT,
            valuation_date TEXT,
            benchmark_trade_date TEXT,
            benchmark_close REAL,
            latest_trade_date TEXT,
            latest_close REAL,
            target_price REAL,
            target_unit TEXT,
            target_source TEXT,
            target_evidence_id TEXT,
            implied_upside REAL,
            latest_upside REAL,
            status TEXT NOT NULL,
            error_message TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            UNIQUE(model_version_id, snapshot_id)
        );

        CREATE INDEX IF NOT EXISTS ix_valuation_metric_comparison_latest
            ON valuation_metric_comparisons(series_id, model_version_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS ix_valuation_metric_manual_override_version
            ON valuation_metric_manual_overrides(model_version_id, is_active, updated_at DESC);
        CREATE INDEX IF NOT EXISTS ix_valuation_market_snapshot_latest
            ON valuation_market_snapshots(series_id, model_version_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS ix_valuation_context_cards_version
            ON valuation_context_cards(model_version_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS ix_valuation_market_price_bars_lookup
            ON valuation_market_price_bars(dataset_id, canonical_ticker, trade_date DESC);
        CREATE INDEX IF NOT EXISTS ix_valuation_price_comparison_latest
            ON valuation_price_comparisons(series_id, model_version_id, created_at DESC);
        """
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
                "真实数据 Provider 不可用。默认使用 AKShare；也可配置 "
                "TUSHARE_TOKEN 或 PRIVATE_FUND_MARKET_DATA_API_URL。"
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


def _tushare_code(ticker: str) -> str:
    normalized = str(ticker or "").strip().upper()
    if re.fullmatch(r"\d{6}\.(?:SZ|SH|BJ)", normalized):
        return normalized
    digits = re.sub(r"\D", "", normalized)
    if len(digits) != 6:
        return normalized
    if digits.startswith(("4", "8")):
        suffix = "BJ"
    elif digits.startswith(("5", "6", "9")):
        suffix = "SH"
    else:
        suffix = "SZ"
    return f"{digits}.{suffix}"


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
    hk_match = re.fullmatch(r"0?(\d{4,5})\.HK", normalized)
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
        bars = list(reversed(prices["bars"]))
        amounts = [bar.get("amount") for bar in bars[:20] if bar.get("amount") is not None]
        metrics: dict[str, Any] = {}
        if len(amounts) == 20:
            metrics["avg_turnover_amount_20d"] = {
                "value": sum(float(value) for value in amounts) / 20.0,
                "period": f"20D@{bars[0]['trade_date']}",
                "unit": "currency",
                "source": prices["source"],
                "observed_at": bars[0]["trade_date"],
            }
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
    match = re.fullmatch(r"(\d{4})(\d{2})(\d{2})", str(value or ""))
    if not match:
        return None
    year, month = int(match.group(1)), int(match.group(2))
    quarter = {3: 1, 6: 2, 9: 3, 12: 4}.get(month)
    return (year, quarter) if quarter else None


def _quarter_label(key: tuple[int, int]) -> str:
    return f"{key[0]}Q{key[1]}"


def _previous_quarter(key: tuple[int, int]) -> tuple[int, int]:
    return (key[0] - 1, 4) if key[1] == 1 else (key[0], key[1] - 1)


def _standalone_quarters(
    rows: list[dict[str, Any]], fields: tuple[str, ...]
) -> dict[tuple[int, int], dict[str, float | None]]:
    cumulative: dict[tuple[int, int], dict[str, float | None]] = {}
    for row in rows:
        key = _quarter_from_end_date(str(row.get("end_date") or ""))
        if key is None or key in cumulative:
            continue
        cumulative[key] = {field: _safe_float(row.get(field)) for field in fields}
    standalone: dict[tuple[int, int], dict[str, float | None]] = {}
    for key, values in cumulative.items():
        prior_key = _previous_quarter(key)
        result: dict[str, float | None] = {}
        for field, value in values.items():
            if value is None:
                result[field] = None
                continue
            if key[1] == 1:
                result[field] = value
                continue
            prior = cumulative.get(prior_key, {}).get(field)
            result[field] = value - prior if prior is not None else None
        standalone[key] = result
    return standalone


def _growth(current: float | None, previous: float | None) -> float | None:
    if current is None or previous is None or abs(previous) <= 1e-12:
        return None
    return current / previous - 1.0


class TushareMarketDataProvider:
    """Tushare adapter for A-share statements and trading data.

    Tushare does not expose a universal consensus NTM P/E in the endpoints used
    here.  Forward P/E therefore stays unavailable unless a normalized
    consensus endpoint is configured; this prevents accidental TTM fallback.
    """

    name = "tushare"

    _rate_lock = threading.Lock()
    _last_request_at = 0.0

    def __init__(self, token: str, base_url: str = "https://api.tushare.pro") -> None:
        self.token = token
        self.base_url = base_url
        self.min_interval_seconds = max(
            0.0,
            float(os.environ.get("TUSHARE_MIN_INTERVAL_SECONDS", "0.45")),
        )
        self.cache_ttl_seconds = max(
            0.0,
            float(os.environ.get("TUSHARE_CACHE_TTL_SECONDS", "300")),
        )
        self.max_request_attempts = max(
            1,
            min(5, int(os.environ.get("TUSHARE_REQUEST_ATTEMPTS", "3"))),
        )
        self._metric_cache: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}
        self._price_cache: dict[tuple[str, date, date], tuple[float, dict[str, Any]]] = {}

    def _throttle(self) -> None:
        """Keep all provider instances below the account-wide request ceiling."""

        provider_type = type(self)
        with provider_type._rate_lock:
            elapsed = time.monotonic() - provider_type._last_request_at
            wait_seconds = self.min_interval_seconds - elapsed
            if wait_seconds > 0:
                time.sleep(wait_seconds)
            provider_type._last_request_at = time.monotonic()

    def _cached(
        self,
        cache: dict[Any, tuple[float, dict[str, Any]]],
        key: Any,
    ) -> dict[str, Any] | None:
        cached = cache.get(key)
        if cached is None or time.monotonic() - cached[0] > self.cache_ttl_seconds:
            return None
        return copy.deepcopy(cached[1])

    @staticmethod
    def _store_cache(
        cache: dict[Any, tuple[float, dict[str, Any]]],
        key: Any,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        cache[key] = (time.monotonic(), copy.deepcopy(payload))
        return payload

    def _call(
        self, api_name: str, params: dict[str, Any], fields: list[str]
    ) -> list[dict[str, Any]]:
        response: httpx.Response | None = None
        last_error: httpx.TransportError | None = None
        for attempt in range(self.max_request_attempts):
            self._throttle()
            try:
                response = httpx.post(
                    self.base_url,
                    json={
                        "api_name": api_name,
                        "token": self.token,
                        "params": params,
                        "fields": ",".join(fields),
                    },
                    headers={"Accept-Encoding": "gzip", "Connection": "close"},
                    follow_redirects=True,
                    timeout=35,
                )
                response.raise_for_status()
                break
            except httpx.TransportError as exc:
                last_error = exc
                if attempt + 1 >= self.max_request_attempts:
                    raise
                time.sleep(float(2**attempt))
        if response is None:
            raise RuntimeError(f"Tushare {api_name} request failed") from last_error
        payload = response.json()
        if int(payload.get("code") or 0) != 0:
            raise RuntimeError(str(payload.get("msg") or f"Tushare {api_name} failed"))
        data = payload.get("data") or {}
        names = data.get("fields") or []
        return [dict(zip(names, item, strict=False)) for item in data.get("items") or []]

    def _consensus_forward_pe(self, *, company_name: str, ticker: str) -> dict[str, Any] | None:
        url = os.environ.get("PRIVATE_FUND_CONSENSUS_API_URL", "").strip()
        if not url:
            return None
        token = os.environ.get("PRIVATE_FUND_CONSENSUS_API_TOKEN", "")
        payload = HttpMarketDataProvider(url, token).fetch_metrics(
            company_name=company_name, ticker=ticker
        )
        metric = (payload.get("metrics") or {}).get("forward_pe")
        return metric if isinstance(metric, dict) else None

    def fetch_daily_prices(
        self, *, ticker: str, start_date: date, end_date: date
    ) -> dict[str, Any]:
        code = _tushare_code(ticker)
        cache_key = (code, start_date, end_date)
        cached = self._cached(self._price_cache, cache_key)
        if cached is not None:
            return cached
        identity = _security_identity(code)
        if identity.market != "a_share":
            raise ValueError("当前 Tushare 财务适配器仅支持 A 股代码")
        rows = self._call(
            "daily",
            {
                "ts_code": code,
                "start_date": start_date.strftime("%Y%m%d"),
                "end_date": end_date.strftime("%Y%m%d"),
            },
            ["ts_code", "trade_date", "open", "high", "low", "close", "vol", "amount"],
        )
        bars = []
        for row in rows:
            bar = _normalized_price_bar(row)
            if bar is None:
                continue
            if bar["amount"] is not None:
                bar["amount"] *= 1000.0  # Tushare daily amount is expressed in CNY thousands.
            bars.append(bar)
        bars.sort(key=lambda item: str(item["trade_date"]))
        return self._store_cache(
            self._price_cache,
            cache_key,
            {
                "provider": self.name,
                "provider_symbol": code,
                "canonical_ticker": identity.canonical_ticker,
                "exchange": identity.exchange,
                "currency": identity.currency,
                "adjustment": "raw",
                "source": "Tushare daily",
                "bars": bars,
            },
        )

    def fetch_metrics(self, *, company_name: str, ticker: str) -> dict[str, Any]:
        code = _tushare_code(ticker)
        try:
            identity = _security_identity(code)
        except ValueError:
            identity = None
        if identity is None or identity.market != "a_share":
            return {
                "provider": self.name,
                "status": "unavailable",
                "as_of": _now_iso(),
                "ticker": code,
                "metrics": {},
                "error": "当前 Tushare 财务适配器仅支持 A 股；未向接口发送该代码。",
            }
        cache_key = (company_name, code)
        cached = self._cached(self._metric_cache, cache_key)
        if cached is not None:
            return cached
        end = date.today()
        # Keep enough source history to calculate twenty quarterly snapshots plus
        # their year-on-year comparison periods in one provider refresh.
        financial_start = end - timedelta(days=2700)
        market_history_start = end - timedelta(days=2200)
        income = self._call(
            "income",
            {"ts_code": code, "start_date": financial_start.strftime("%Y%m%d")},
            [
                "ts_code",
                "ann_date",
                "f_ann_date",
                "end_date",
                "report_type",
                "revenue",
                "total_revenue",
                "oper_cost",
                "n_income_attr_p",
            ],
        )
        income.sort(
            key=lambda row: (
                str(row.get("end_date") or ""),
                str(row.get("f_ann_date") or row.get("ann_date") or ""),
            ),
            reverse=True,
        )
        standalone = _standalone_quarters(
            income, ("revenue", "total_revenue", "oper_cost", "n_income_attr_p")
        )
        usable_keys = sorted(
            (
                key
                for key, values in standalone.items()
                if values.get("n_income_attr_p") is not None
                or values.get("revenue") is not None
                or values.get("total_revenue") is not None
            ),
            reverse=True,
        )
        def revenue(values: dict[str, Any]) -> float | None:
            primary = _safe_float(values.get("revenue"))
            return primary if primary is not None else _safe_float(values.get("total_revenue"))

        def gross_margin(values: dict[str, Any]) -> float | None:
            rev = revenue(values)
            cost = _safe_float(values.get("oper_cost"))
            if rev is None or cost is None or abs(rev) <= 1e-12:
                return None
            return (rev - cost) / rev

        def observed_at(key: tuple[int, int]) -> str:
            return next(
                (
                    str(row.get("f_ann_date") or row.get("ann_date") or "")
                    for row in income
                    if _quarter_from_end_date(str(row.get("end_date") or "")) == key
                ),
                "",
            )

        def financial_metrics(key: tuple[int, int]) -> dict[str, dict[str, Any]]:
            prior_key = _previous_quarter(key)
            yoy_key = (key[0] - 1, key[1])
            prior_yoy_key = (prior_key[0] - 1, prior_key[1])
            current = standalone.get(key, {})
            prior = standalone.get(prior_key, {})
            yoy = standalone.get(yoy_key, {})
            prior_yoy = standalone.get(prior_yoy_key, {})
            values: dict[str, dict[str, Any]] = {}

            net_growth = _growth(
                _safe_float(current.get("n_income_attr_p")),
                _safe_float(yoy.get("n_income_attr_p")),
            )
            if net_growth is not None:
                values["quarter_net_profit_yoy"] = {
                    "value": net_growth,
                    "period": _quarter_label(key),
                    "unit": "percent",
                    "source": "Tushare income",
                    "observed_at": observed_at(key),
                }

            current_margin = gross_margin(current)
            prior_margin = gross_margin(prior)
            if current_margin is not None and prior_margin is not None:
                values["quarter_gross_margin_qoq_delta"] = {
                    "value": current_margin - prior_margin,
                    "period": _quarter_label(key),
                    "unit": "percentage_point",
                    "source": "Tushare income",
                    "observed_at": observed_at(key),
                }

            current_revenue_yoy = _growth(revenue(current), revenue(yoy))
            prior_revenue_yoy = _growth(revenue(prior), revenue(prior_yoy))
            if current_revenue_yoy is not None and prior_revenue_yoy is not None:
                values["quarter_revenue_growth_qoq"] = {
                    "value": current_revenue_yoy - prior_revenue_yoy,
                    "period": _quarter_label(key),
                    "unit": "percentage_point",
                    "source": "Tushare income",
                    "observed_at": observed_at(key),
                    "metadata": {
                        "current_quarter_yoy": current_revenue_yoy,
                        "previous_quarter_yoy": prior_revenue_yoy,
                    },
                }
            return values

        metrics: dict[str, dict[str, Any]] = {}
        if usable_keys:
            metrics.update(financial_metrics(usable_keys[0]))

        daily = self._call(
            "daily",
            {
                "ts_code": code,
                "start_date": market_history_start.strftime("%Y%m%d"),
                "end_date": end.strftime("%Y%m%d"),
            },
            ["ts_code", "trade_date", "close", "amount"],
        )
        completed = sorted(daily, key=lambda row: str(row.get("trade_date") or ""), reverse=True)
        amounts = [_safe_float(row.get("amount")) for row in completed[:20]]
        amounts = [value for value in amounts if value is not None]
        if len(amounts) == 20:
            metrics["avg_turnover_amount_20d"] = {
                "value": sum(amounts) / len(amounts) * 1000.0,
                "period": f"20D@{completed[0].get('trade_date', '')}",
                "unit": "currency",
                "source": "Tushare daily",
                "observed_at": str(completed[0].get("trade_date") or ""),
            }

        history: list[dict[str, Any]] = []
        for quarter_key in sorted(usable_keys[:20]):
            period_metrics = financial_metrics(quarter_key)
            quarter_end = f"{quarter_key[0]}{quarter_key[1] * 3:02d}{(31, 30, 30, 31)[quarter_key[1] - 1]:02d}"
            eligible_daily = [
                row
                for row in completed
                if str(row.get("trade_date") or "") <= quarter_end
                and _safe_float(row.get("amount")) is not None
            ][:20]
            if len(eligible_daily) == 20:
                period_metrics["avg_turnover_amount_20d"] = {
                    "value": sum(_safe_float(row.get("amount")) or 0.0 for row in eligible_daily)
                    / 20.0
                    * 1000.0,
                    "period": f"20D@{eligible_daily[0].get('trade_date', '')}",
                    "unit": "currency",
                    "source": "Tushare daily",
                    "observed_at": str(eligible_daily[0].get("trade_date") or ""),
                }
            if period_metrics:
                history.append(
                    {
                        "period": _quarter_label(quarter_key),
                        "observed_at": observed_at(quarter_key),
                        "metrics": period_metrics,
                    }
                )

        forward_pe = self._consensus_forward_pe(company_name=company_name, ticker=code)
        if forward_pe:
            metrics["forward_pe"] = forward_pe

        return self._store_cache(
            self._metric_cache,
            cache_key,
            {
                "provider": self.name,
                "status": "completed" if metrics else "unavailable",
                "as_of": _now_iso(),
                "ticker": code,
                "metrics": metrics,
                "metric_history": history,
                "error": (
                    "Forward PE 需要一致预期数据源，当前未配置该指标。"
                    if "forward_pe" not in metrics
                    else ""
                ),
            },
        )


class RoutedMarketDataProvider:
    """Use Tushare for A shares and preserve the free HK price fallback."""

    name = "a-h-market-router"

    def __init__(
        self,
        *,
        a_share_provider: MarketDataProvider,
        hk_provider: MarketDataProvider,
    ) -> None:
        self.a_share_provider = a_share_provider
        self.hk_provider = hk_provider

    def _provider(self, ticker: str) -> MarketDataProvider | None:
        try:
            identity = _security_identity(ticker)
        except ValueError:
            return None
        return self.a_share_provider if identity.market == "a_share" else self.hk_provider

    def fetch_metrics(self, *, company_name: str, ticker: str) -> dict[str, Any]:
        provider = self._provider(ticker)
        if provider is None:
            return {
                "provider": self.name,
                "status": "unavailable",
                "as_of": _now_iso(),
                "ticker": ticker,
                "metrics": {},
                "error": "当前自动行情刷新只覆盖 A 股和港股。",
            }
        return provider.fetch_metrics(company_name=company_name, ticker=ticker)

    def fetch_daily_prices(
        self, *, ticker: str, start_date: date, end_date: date
    ) -> dict[str, Any]:
        provider = self._provider(ticker)
        if provider is None or not hasattr(provider, "fetch_daily_prices"):
            raise ValueError("当前自动行情刷新只覆盖 A 股和港股")
        return provider.fetch_daily_prices(
            ticker=ticker,
            start_date=start_date,
            end_date=end_date,
        )


def default_market_data_provider() -> MarketDataProvider:
    selected = os.environ.get("PRIVATE_FUND_MARKET_DATA_PROVIDER", "").strip().lower()
    url = os.environ.get("PRIVATE_FUND_MARKET_DATA_API_URL", "").strip()
    if selected in {"http", "api"} or (url and not selected):
        if not url:
            return UnavailableMarketDataProvider()
        return HttpMarketDataProvider(
            url, os.environ.get("PRIVATE_FUND_MARKET_DATA_API_TOKEN", "")
        )
    token = (
        os.environ.get("TUSHARE_TOKEN", "").strip()
        or os.environ.get("TUSHARE_API_TOKEN", "").strip()
    )
    if selected in {"tushare", "hybrid", "auto"} or (token and not selected):
        if not token:
            return UnavailableMarketDataProvider()
        tushare_provider = TushareMarketDataProvider(
            token, os.environ.get("TUSHARE_API_URL", "https://api.tushare.pro")
        )
        if selected in {"hybrid", "auto"}:
            return RoutedMarketDataProvider(
                a_share_provider=tushare_provider,
                hk_provider=AkshareMarketDataProvider(),
            )
        return tushare_provider
    if selected in {"disabled", "none", "off"}:
        return UnavailableMarketDataProvider()
    return AkshareMarketDataProvider()


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


def _facts_for_document(conn: sqlite3.Connection, doc_id: str) -> list[dict[str, Any]]:
    tables = {
        str(row[0]) for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    if "metric_facts" not in tables:
        return []
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
    return [dict(row) for row in rows]


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


def extract_model_metrics(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    series_id: str,
    model_version_id: str,
    doc_id: str,
    target_period: str = "",
) -> list[dict[str, Any]]:
    facts = _facts_for_document(conn, doc_id)
    target_quarter = _parse_quarter(target_period)
    net = _quarterly_values(facts, "net_profit")
    revenue = _quarterly_values(facts, "revenue")
    gross = _quarterly_values(facts, "gross_profit")
    gross_margin = _quarterly_values(facts, "gross_margin")
    cost = _quarterly_values(facts, "cost")
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
        facts,
        (
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
        ),
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
        facts,
        (
            "20 day average turnover",
            "20d average turnover",
            "20 day average trading value",
            "20d average traded value",
            "近20日日均成交额",
            "20日平均成交额",
        ),
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
    if definition.key in QUARTERLY_COMPARISON_KEYS:
        model_period = _parse_quarter(model.get("period"))
        actual_period = _parse_quarter(actual.get("period"))
        if model_period is None or actual_period is None or model_period != actual_period:
            model_label = str(model.get("period") or "未知期间")
            actual_label = str(actual.get("period") or "未知期间")
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


_MONTH_NUMBERS = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}


def _valuation_date(version: dict[str, Any]) -> date | None:
    filename = str(version.get("original_filename") or "")
    named = re.search(
        r"(?P<year>20\d{2})[_ .-](?P<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)"
        r"[_ .-](?P<day>\d{1,2})",
        filename,
        re.I,
    )
    if named:
        try:
            return date(
                int(named.group("year")),
                _MONTH_NUMBERS[named.group("month").lower()],
                int(named.group("day")),
            )
        except ValueError:
            pass
    numeric = re.search(
        r"(?P<year>20\d{2})[-_.]?(?P<month>0?[1-9]|1[0-2])[-_.]?(?P<day>0?[1-9]|[12]\d|3[01])",
        filename,
    )
    if numeric:
        try:
            return date(
                int(numeric.group("year")),
                int(numeric.group("month")),
                int(numeric.group("day")),
            )
        except ValueError:
            pass
    raw = str(version.get("document_date") or "")[:10]
    try:
        return date.fromisoformat(raw) if raw else None
    except ValueError:
        return None


def _target_price_value(conn: sqlite3.Connection, model_version_id: str) -> dict[str, Any] | None:
    tables = {
        str(row[0]) for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    if not {"valuation_model_nodes", "valuation_model_node_values"}.issubset(tables):
        return None
    row = conn.execute(
        """
        SELECT v.value_numeric, v.unit, v.sheet_name, v.cell_ref, v.evidence_id,
               v.quality_status, v.confidence, n.period, n.scenario
        FROM valuation_model_node_values v
        JOIN valuation_model_nodes n ON n.node_id=v.node_id
        WHERE v.model_version_id=? AND n.metric_key='target_price'
          AND v.value_numeric IS NOT NULL
        ORDER BY CASE WHEN lower(COALESCE(n.scenario,'')) IN ('base','base case','基准')
                      THEN 0 ELSE 1 END,
                 CASE v.quality_status WHEN 'candidate_complete' THEN 0
                      WHEN 'review_required' THEN 1 ELSE 2 END,
                 v.confidence DESC
        LIMIT 1
        """,
        (model_version_id,),
    ).fetchone()
    if row is None:
        return None
    return {
        "value": _safe_float(row["value_numeric"]),
        "unit": str(row["unit"] or ""),
        "source": f"{row['sheet_name']}!{row['cell_ref']}",
        "evidence_id": str(row["evidence_id"] or ""),
        "quality_status": str(row["quality_status"] or ""),
        "period": str(row["period"] or ""),
        "scenario": str(row["scenario"] or ""),
    }


def _upside(target: float | None, close: float | None) -> float | None:
    if target is None or close is None or abs(close) <= 1e-12:
        return None
    return target / close - 1.0


def refresh_price_comparison(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    series: dict[str, Any],
    version: dict[str, Any],
    snapshot_id: str,
    provider: MarketDataProvider,
    valuation_date_override: str = "",
    valuation_date_metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Cache raw daily bars and compare the selected model target with real closes."""

    ensure_metric_schema(conn)
    now = _now_iso()
    series_id = str(series["series_id"])
    model_version_id = str(version["model_version_id"])
    ticker = str(series.get("company_ticker") or "")
    comparison_id = f"vpc_{_digest(model_version_id, snapshot_id)}"
    effective_date = None
    if valuation_date_override:
        try:
            effective_date = date.fromisoformat(valuation_date_override)
        except ValueError:
            effective_date = None
    effective_date = effective_date or _valuation_date(version)
    target = _target_price_value(conn, model_version_id)
    provider_name = str(getattr(provider, "name", type(provider).__name__))
    result: dict[str, Any] = {
        "price_comparison_id": comparison_id,
        "snapshot_id": snapshot_id,
        "dataset_id": dataset_id,
        "series_id": series_id,
        "model_version_id": model_version_id,
        "provider": provider_name,
        "provider_symbol": "",
        "currency": "",
        "valuation_date": effective_date.isoformat() if effective_date else "",
        "benchmark_trade_date": "",
        "benchmark_close": None,
        "latest_trade_date": "",
        "latest_close": None,
        "target_price": target.get("value") if target else None,
        "target_unit": target.get("unit", "") if target else "",
        "target_source": target.get("source", "") if target else "",
        "target_evidence_id": target.get("evidence_id", "") if target else "",
        "implied_upside": None,
        "latest_upside": None,
        "status": "unavailable",
        "error_message": "",
        "metadata": {
            "target_quality_status": target.get("quality_status", "") if target else "",
            "target_period": target.get("period", "") if target else "",
            "target_scenario": target.get("scenario", "") if target else "",
            "valuation_date_method": (
                "agent_skill"
                if valuation_date_override and effective_date
                else "filename_or_document"
            ),
            "valuation_date_source": str((valuation_date_metadata or {}).get("source") or ""),
            "valuation_date_evidence_ids": list(
                (valuation_date_metadata or {}).get("evidence_ids") or []
            ),
        },
        "created_at": now,
    }
    fetch_prices = getattr(provider, "fetch_daily_prices", None)
    if not ticker:
        result["error_message"] = "模型系列缺少证券代码，无法查询真实价格。"
    elif not callable(fetch_prices):
        result["error_message"] = f"{provider_name} 暂未提供日线价格接口。"
    else:
        end = date.today()
        start = effective_date - timedelta(days=14) if effective_date else end - timedelta(days=90)
        if start > end:
            start = end - timedelta(days=90)
        try:
            price_payload = fetch_prices(ticker=ticker, start_date=start, end_date=end)
            bars = price_payload.get("bars") if isinstance(price_payload, dict) else []
            if not isinstance(bars, list):
                raise ValueError("行情 Provider 返回的 bars 不是列表。")
            result["provider"] = str(price_payload.get("provider") or provider_name)
            result["provider_symbol"] = str(price_payload.get("provider_symbol") or "")
            result["currency"] = str(price_payload.get("currency") or "")
            adjustment = str(price_payload.get("adjustment") or "raw")
            source = str(price_payload.get("source") or "")
            normalized_bars = []
            for raw_bar in bars:
                if not isinstance(raw_bar, dict):
                    continue
                bar = _normalized_price_bar(raw_bar)
                if bar is None:
                    continue
                normalized_bars.append(bar)
                bar_id = "vpb_" + _digest(
                    dataset_id,
                    result["provider"],
                    result["provider_symbol"],
                    bar["trade_date"],
                    adjustment,
                )
                conn.execute(
                    """
                    INSERT INTO valuation_market_price_bars
                        (bar_id, dataset_id, provider, provider_symbol, canonical_ticker,
                         exchange, currency, trade_date, open, high, low, close, volume,
                         amount, adjustment, source, fetched_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(dataset_id, provider, provider_symbol, trade_date, adjustment)
                    DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low,
                                  close=excluded.close, volume=excluded.volume,
                                  amount=excluded.amount, source=excluded.source,
                                  fetched_at=excluded.fetched_at
                    """,
                    (
                        bar_id,
                        dataset_id,
                        result["provider"],
                        result["provider_symbol"],
                        str(price_payload.get("canonical_ticker") or ticker),
                        str(price_payload.get("exchange") or ""),
                        result["currency"],
                        bar["trade_date"],
                        bar["open"],
                        bar["high"],
                        bar["low"],
                        bar["close"],
                        bar["volume"],
                        bar["amount"],
                        adjustment,
                        source,
                        now,
                    ),
                )
            normalized_bars.sort(key=lambda item: str(item["trade_date"]))
            latest = normalized_bars[-1] if normalized_bars else None
            benchmark = None
            if effective_date:
                benchmark = next(
                    (
                        item
                        for item in reversed(normalized_bars)
                        if str(item["trade_date"]) <= effective_date.isoformat()
                    ),
                    None,
                )
            if latest:
                result["latest_trade_date"] = latest["trade_date"]
                result["latest_close"] = latest["close"]
            if benchmark:
                result["benchmark_trade_date"] = benchmark["trade_date"]
                result["benchmark_close"] = benchmark["close"]
            result["implied_upside"] = _upside(result["target_price"], result["benchmark_close"])
            result["latest_upside"] = _upside(result["target_price"], result["latest_close"])
            missing = []
            if not target:
                missing.append("模型目标价")
            if not effective_date:
                missing.append("估值基准日")
            if effective_date and not benchmark:
                missing.append("基准日之前的收盘价")
            if not latest:
                missing.append("日线价格")
            result["status"] = "completed" if not missing else "partial"
            result["error_message"] = f"缺少{'、'.join(missing)}。" if missing else ""
            result["metadata"].update(
                {
                    "adjustment": adjustment,
                    "price_source": source,
                    "bars_fetched": len(normalized_bars),
                    "target_currency_inferred": bool(target and not target.get("unit")),
                }
            )
        except Exception as exc:  # noqa: BLE001 - comparison failure remains auditable
            result["status"] = "failed"
            result["error_message"] = str(exc)[:2000]

    conn.execute(
        """
        INSERT INTO valuation_price_comparisons
            (price_comparison_id, snapshot_id, dataset_id, series_id, model_version_id,
             provider, provider_symbol, currency, valuation_date, benchmark_trade_date,
             benchmark_close, latest_trade_date, latest_close, target_price, target_unit,
             target_source, target_evidence_id, implied_upside, latest_upside, status,
             error_message, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            comparison_id,
            snapshot_id,
            dataset_id,
            series_id,
            model_version_id,
            result["provider"],
            result["provider_symbol"],
            result["currency"],
            result["valuation_date"],
            result["benchmark_trade_date"],
            result["benchmark_close"],
            result["latest_trade_date"],
            result["latest_close"],
            result["target_price"],
            result["target_unit"],
            result["target_source"],
            result["target_evidence_id"],
            result["implied_upside"],
            result["latest_upside"],
            result["status"],
            result["error_message"] or None,
            _json(result["metadata"]),
            now,
        ),
    )
    return result


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
    skill_extraction["manual_metric_keys"] = [
        key
        for key in METRIC_KEYS
        if any(str(item.get("metric_key")) == key for item in manual_overrides)
    ]
    skill_extraction["manual_overrides"] = manual_overrides
    formatted_extraction = skill_extraction.get("formatted_output") or {}
    agent_valuation_date = formatted_extraction.get("valuation_date")
    if not isinstance(agent_valuation_date, dict):
        agent_valuation_date = {}
    actual_metrics = {
        key: _normalize_actual_metric(key, market_metrics.get(key)) for key in METRIC_KEYS
    }
    conn.execute(
        """
        INSERT INTO valuation_market_snapshots
            (snapshot_id, dataset_id, series_id, model_version_id, company_name,
             company_ticker, provider, status, as_of, error_message, raw_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            snapshot_id,
            dataset_id,
            series_id,
            model_version_id,
            company_name,
            ticker,
            str(market.get("provider") or getattr(provider, "name", "unknown")),
            str(market.get("status") or "completed"),
            str(market.get("as_of") or now),
            str(market.get("error") or "")[:2000] or None,
            _json(market),
            now,
        ),
    )
    price_comparison = refresh_price_comparison(
        conn,
        dataset_id=dataset_id,
        series=series,
        version=version,
        snapshot_id=snapshot_id,
        provider=provider,
        valuation_date_override=str(agent_valuation_date.get("value") or ""),
        valuation_date_metadata=agent_valuation_date,
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
        if calculated["severity"] in {"warning", "critical"}:
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
        if calculated["severity"] not in {"warning", "critical"}:
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
                f"{definition.label}：{calculated['explanation']}",
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
        "price_comparison": price_comparison,
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
    model_quarters: set[tuple[int, int]] = set()
    for kind in ("net_profit", "revenue", "gross_profit", "gross_margin", "cost"):
        model_quarters.update(_quarterly_values(facts, kind))

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
        )
        models, _ = _apply_manual_metric_overrides(
            conn,
            model_version_id=model_version_id,
            model_metrics=models,
        )
        model_by_key = {str(item["metric_key"]): item for item in models}
        raw_actuals = actual_by_quarter.get(quarter, {})
        comparisons = []
        for definition in METRIC_DEFINITIONS:
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
                },
            )
        )
    price_comparison: dict[str, Any] | None = None
    if snapshot:
        price_row = conn.execute(
            """
            SELECT * FROM valuation_price_comparisons
            WHERE snapshot_id=?
            ORDER BY created_at DESC LIMIT 1
            """,
            (snapshot["snapshot_id"],),
        ).fetchone()
        if price_row:
            price_comparison = dict(price_row)
            price_comparison["metadata"] = _decode(price_comparison.pop("metadata_json", None), {})
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
                "provider": snapshot["provider"],
                "status": snapshot["status"],
                "as_of": snapshot["as_of"],
                "error_message": snapshot["error_message"] or "",
                "created_at": snapshot["created_at"],
            }
            if snapshot
            else {
                "snapshot_id": "",
                "provider": "",
                "status": "pending",
                "as_of": "",
                "error_message": "等待真实数据刷新。",
                "created_at": "",
            }
        ),
        "price_comparison": price_comparison
        or {
            "price_comparison_id": "",
            "snapshot_id": "",
            "provider": "",
            "provider_symbol": "",
            "currency": "",
            "valuation_date": "",
            "benchmark_trade_date": "",
            "benchmark_close": None,
            "latest_trade_date": "",
            "latest_close": None,
            "target_price": None,
            "target_unit": "",
            "target_source": "",
            "target_evidence_id": "",
            "implied_upside": None,
            "latest_upside": None,
            "status": "pending",
            "error_message": "等待 AKShare 真实价格刷新。",
            "metadata": {},
            "created_at": "",
        },
        "metric_comparisons": comparisons,
        "metric_timeline": metric_timeline,
        "context_cards": cards,
        "valuation_impacts": valuation_impacts,
    }
