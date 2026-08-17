"""Auditable A/H-share market-data providers and normalized records."""

import datetime as dt
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

from .artifacts import (
    artifact_descriptor,
    sha256_file,
    write_json_new_or_identical,
    write_ndjson_atomic,
)
from .errors import (
    ComputeOperationError,
    DependencyUnavailableError,
    ProviderError,
    ProviderNetworkError,
)
from .paths import generated_output_path


MAX_DESCRIPTOR_BYTES = 16 * 1024 * 1024
MAX_BARS = 100_000


@dataclass(frozen=True)
class SecurityIdentity:
    canonical_ticker: str
    provider_symbol: str
    exchange: str
    currency: str
    market: str


def _security_identity(ticker: str) -> SecurityIdentity:
    compact = re.sub(r"\s+", "", ticker).upper()
    hk_match = (
        re.fullmatch(r"(?:HK)?(\d{1,5})(?:\.HK)?", compact)
        if (
            compact.endswith(".HK")
            or compact.startswith("HK")
            or re.fullmatch(r"\d{1,5}", compact) is not None
        )
        else None
    )
    if hk_match is not None:
        symbol = hk_match.group(1).zfill(5)
        return SecurityIdentity(
            canonical_ticker="{}.HK".format(symbol),
            provider_symbol=symbol,
            exchange="HKEX",
            currency="HKD",
            market="hk",
        )

    match = re.fullmatch(
        r"(?:(SH|SZ|BJ))?(\d{6})(?:\.(SH|SZ|BJ))?", compact
    )
    if match is None:
        raise ComputeOperationError(
            "ticker must be an A-share or Hong Kong equity symbol",
            "invalid_market_request",
        )
    prefix, symbol, suffix = match.groups()
    if prefix and suffix and prefix != suffix:
        raise ComputeOperationError(
            "ticker exchange prefix and suffix disagree",
            "invalid_market_request",
        )
    exchange = prefix or suffix
    if exchange is None:
        if symbol.startswith(("4", "8", "92")):
            exchange = "BJ"
        elif symbol.startswith(("5", "6", "9")):
            exchange = "SH"
        else:
            exchange = "SZ"
    return SecurityIdentity(
        canonical_ticker="{}.{}".format(symbol, exchange),
        provider_symbol=symbol,
        exchange=exchange,
        currency="CNY",
        market="a_share",
    )


def _parse_date(value: Any, field: str) -> dt.date:
    if not isinstance(value, str):
        raise ComputeOperationError(
            "{} must be an ISO date".format(field), "invalid_market_request"
        )
    for pattern in ("%Y-%m-%d", "%Y%m%d"):
        try:
            return dt.datetime.strptime(value, pattern).date()
        except ValueError:
            pass
    raise ComputeOperationError(
        "{} must be YYYY-MM-DD or YYYYMMDD".format(field),
        "invalid_market_request",
    )


def _date_text(value: Any) -> str:
    if isinstance(value, (dt.datetime, dt.date)):
        return value.date().isoformat() if isinstance(value, dt.datetime) else value.isoformat()
    text = str(value or "").strip()
    for pattern in ("%Y-%m-%d", "%Y%m%d", "%Y/%m/%d"):
        try:
            return dt.datetime.strptime(text[:10], pattern).date().isoformat()
        except ValueError:
            pass
    return ""


def _number(value: Any, field: str, required: bool = False) -> Optional[float]:
    if value is None or value == "":
        if required:
            raise ComputeOperationError(
                "market bar {} is required".format(field),
                "invalid_market_data",
            )
        return None
    if isinstance(value, bool):
        raise ComputeOperationError(
            "market bar {} must be numeric".format(field),
            "invalid_market_data",
        )
    try:
        number = float(str(value).replace(",", ""))
    except (TypeError, ValueError) as exc:
        raise ComputeOperationError(
            "market bar {} must be numeric".format(field),
            "invalid_market_data",
        ) from exc
    if not math.isfinite(number):
        raise ComputeOperationError(
            "market bar {} must be finite".format(field),
            "invalid_market_data",
        )
    return number


def _frame_records(frame: Any) -> List[Dict[str, Any]]:
    if frame is None:
        return []
    if hasattr(frame, "to_dict"):
        records = frame.to_dict("records")
        if (
            records
            and not any(
                key in records[0]
                for key in ("tradeDate", "日期", "date", "trade_date")
            )
            and hasattr(frame, "reset_index")
        ):
            records = frame.reset_index().to_dict("records")
    elif isinstance(frame, list):
        records = frame
    else:
        raise ProviderError("AKShare returned an unsupported data-frame shape")
    if not isinstance(records, list):
        raise ProviderError("AKShare returned an unsupported record collection")
    return [dict(record) for record in records if isinstance(record, Mapping)]


def _normalized_bar(row: Mapping[str, Any]) -> Dict[str, Any]:
    trade_date = _date_text(
        row.get(
            "tradeDate",
            row.get(
                "日期",
                row.get("date", row.get("trade_date", row.get("index"))),
            ),
        )
    )
    if not trade_date:
        raise ComputeOperationError(
            "market bar trade date is missing or invalid",
            "invalid_market_data",
        )
    bar = {
        "tradeDate": trade_date,
        "open": _number(row.get("open", row.get("开盘")), "open"),
        "high": _number(row.get("high", row.get("最高")), "high"),
        "low": _number(row.get("low", row.get("最低")), "low"),
        "close": _number(
            row.get("close", row.get("收盘")), "close", required=True
        ),
        "volume": _number(
            row.get("volume", row.get("成交量", row.get("vol"))), "volume"
        ),
        "amount": _number(
            row.get("amount", row.get("成交额")), "amount"
        ),
    }
    if bar["volume"] is not None and float(bar["volume"]) < 0:
        raise ComputeOperationError(
            "market bar volume may not be negative", "invalid_market_data"
        )
    if bar["amount"] is not None and float(bar["amount"]) < 0:
        raise ComputeOperationError(
            "market bar amount may not be negative", "invalid_market_data"
        )
    present_prices = [
        float(value)
        for value in (bar["open"], bar["high"], bar["low"], bar["close"])
        if value is not None
    ]
    if bar["high"] is not None and float(bar["high"]) < max(present_prices):
        raise ComputeOperationError(
            "market bar high is below another price", "invalid_market_data"
        )
    if bar["low"] is not None and float(bar["low"]) > min(present_prices):
        raise ComputeOperationError(
            "market bar low is above another price", "invalid_market_data"
        )
    return bar


def _network_like(error: BaseException) -> bool:
    if isinstance(error, (ConnectionError, TimeoutError)):
        return True
    name = type(error).__name__.lower()
    text = str(error).lower()
    return any(
        token in name or token in text
        for token in (
            "timeout",
            "connection",
            "network",
            "dns",
            "proxy",
            "temporary failure",
        )
    )


class FixtureMarketDataProvider:
    name = "fixture"

    def fetch(
        self,
        descriptor: Mapping[str, Any],
        identity: SecurityIdentity,
        start_date: dt.date,
        end_date: dt.date,
    ) -> Tuple[str, str, List[Dict[str, Any]]]:
        del identity, start_date, end_date
        raw_bars = descriptor.get("bars")
        if not isinstance(raw_bars, list):
            raise ComputeOperationError(
                "fixture market descriptor must contain a bars array",
                "invalid_market_request",
            )
        if any(not isinstance(item, Mapping) for item in raw_bars):
            raise ComputeOperationError(
                "fixture market bars must all be JSON objects",
                "invalid_market_request",
            )
        source = descriptor.get("source", "offline fixture")
        if not isinstance(source, str) or not source:
            raise ComputeOperationError(
                "fixture source must be a non-empty string",
                "invalid_market_request",
            )
        retrieved_at = descriptor.get("retrievedAt", "fixture")
        if not isinstance(retrieved_at, str) or not retrieved_at:
            raise ComputeOperationError(
                "fixture retrievedAt must be a non-empty string",
                "invalid_market_request",
            )
        return source, retrieved_at, [
            _normalized_bar(item)
            for item in raw_bars
        ]


class AkshareMarketDataProvider:
    """Raw daily A/H-share adapter audited from the legacy valuation service."""

    name = "akshare"

    def _module(self) -> Any:
        try:
            import akshare  # type: ignore
        except ImportError as exc:
            raise DependencyUnavailableError(
                "fetch_market_data provider=akshare requires akshare"
            ) from exc
        return akshare

    def fetch(
        self,
        descriptor: Mapping[str, Any],
        identity: SecurityIdentity,
        start_date: dt.date,
        end_date: dt.date,
    ) -> Tuple[str, str, List[Dict[str, Any]]]:
        del descriptor
        akshare = self._module()
        params = {
            "symbol": identity.provider_symbol,
            "period": "daily",
            "start_date": start_date.strftime("%Y%m%d"),
            "end_date": end_date.strftime("%Y%m%d"),
            "adjust": "",
        }
        primary_error: Optional[BaseException] = None
        try:
            if identity.market == "hk":
                frame = akshare.stock_hk_hist(**params)
                source = "AKShare stock_hk_hist (Eastmoney)"
            else:
                frame = akshare.stock_zh_a_hist(**params)
                source = "AKShare stock_zh_a_hist (Eastmoney)"
        except Exception as exc:
            primary_error = exc
            try:
                if identity.market == "hk":
                    frame = akshare.stock_hk_daily(
                        symbol=identity.provider_symbol, adjust=""
                    )
                    source = "AKShare stock_hk_daily (Sina fallback)"
                else:
                    if identity.exchange == "BJ":
                        raise exc
                    frame = akshare.stock_zh_a_daily(
                        symbol="{}{}".format(
                            identity.exchange.lower(),
                            identity.provider_symbol,
                        ),
                        start_date=params["start_date"],
                        end_date=params["end_date"],
                        adjust="",
                    )
                    source = "AKShare stock_zh_a_daily (Sina fallback)"
            except Exception as fallback_error:
                detail = "AKShare primary and fallback requests failed: {}; {}".format(
                    primary_error, fallback_error
                )
                if _network_like(primary_error) or _network_like(fallback_error):
                    raise ProviderNetworkError(detail) from fallback_error
                raise ProviderError(detail) from fallback_error
        return (
            source,
            dt.datetime.now(dt.timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z"),
            [_normalized_bar(row) for row in _frame_records(frame)],
        )


def _read_descriptor(input_path: Path) -> Dict[str, Any]:
    if input_path.stat().st_size > MAX_DESCRIPTOR_BYTES:
        raise ComputeOperationError(
            "market request descriptor exceeds {} bytes".format(
                MAX_DESCRIPTOR_BYTES
            ),
            "document_limit_exceeded",
        )
    try:
        value = json.loads(input_path.read_text(encoding="utf-8"))
    except UnicodeDecodeError as exc:
        raise ComputeOperationError(
            "market request descriptor must be UTF-8", "invalid_market_request"
        ) from exc
    except json.JSONDecodeError as exc:
        raise ComputeOperationError(
            "market request descriptor must be valid JSON",
            "invalid_market_request",
        ) from exc
    if not isinstance(value, dict):
        raise ComputeOperationError(
            "market request descriptor must be a JSON object",
            "invalid_market_request",
        )
    return value


def _provider(name: str) -> Any:
    if name == "fixture":
        return FixtureMarketDataProvider()
    if name == "akshare":
        return AkshareMarketDataProvider()
    raise ComputeOperationError(
        "unsupported market provider: {}".format(name),
        "unsupported_provider",
    )


def fetch_market_data(
    input_path: Path,
    output_directory: Path,
    options: Mapping[str, Any],
) -> Tuple[str, List[Dict[str, Any]], Dict[str, Any]]:
    descriptor = _read_descriptor(input_path)
    provider_name = options.get("provider", descriptor.get("provider", "fixture"))
    ticker = options.get("ticker", descriptor.get("ticker"))
    start_raw = options.get("startDate", descriptor.get("startDate"))
    end_raw = options.get("endDate", descriptor.get("endDate"))
    if not isinstance(provider_name, str):
        raise ComputeOperationError(
            "market provider must be a string", "invalid_market_request"
        )
    if not isinstance(ticker, str) or not ticker:
        raise ComputeOperationError(
            "market ticker must be non-empty", "invalid_market_request"
        )
    identity = _security_identity(ticker)
    start_date = _parse_date(start_raw, "startDate")
    end_date = _parse_date(end_raw, "endDate")
    if end_date < start_date:
        raise ComputeOperationError(
            "endDate must not precede startDate", "invalid_market_request"
        )
    if (end_date - start_date).days > 7_305:
        raise ComputeOperationError(
            "market date range may not exceed twenty years",
            "invalid_market_request",
        )

    source, retrieved_at, raw_bars = _provider(provider_name).fetch(
        descriptor, identity, start_date, end_date
    )
    bars_by_date: Dict[str, Dict[str, Any]] = {}
    for bar in raw_bars:
        date_text = str(bar["tradeDate"])
        if date_text < start_date.isoformat() or date_text > end_date.isoformat():
            continue
        if date_text in bars_by_date:
            raise ComputeOperationError(
                "market provider returned duplicate date {}".format(date_text),
                "invalid_market_data",
            )
        bars_by_date[date_text] = bar
    if len(bars_by_date) > MAX_BARS:
        raise ComputeOperationError(
            "market response exceeds {} bars".format(MAX_BARS),
            "document_limit_exceeded",
        )
    bars = [bars_by_date[key] for key in sorted(bars_by_date)]

    metadata = {
        "recordType": "market_metadata",
        "provider": provider_name,
        "source": source,
        "retrievedAt": retrieved_at,
        "canonicalTicker": identity.canonical_ticker,
        "providerSymbol": identity.provider_symbol,
        "exchange": identity.exchange,
        "currency": identity.currency,
        "adjustment": "raw",
        "startDate": start_date.isoformat(),
        "endDate": end_date.isoformat(),
        "barCount": len(bars),
    }

    def records() -> Iterable[Dict[str, Any]]:
        yield metadata
        for bar in bars:
            yield {
                "recordType": "market_bar",
                "provider": provider_name,
                "canonicalTicker": identity.canonical_ticker,
                "exchange": identity.exchange,
                "currency": identity.currency,
                "adjustment": "raw",
                **bar,
            }

    records_path = generated_output_path(
        output_directory, "market-records.ndjson"
    )
    record_count, records_bytes = write_ndjson_atomic(records(), records_path)
    records_artifact = artifact_descriptor(
        records_path, output_directory, "application/x-ndjson"
    )
    manifest = {
        "manifestVersion": 1,
        "operation": "fetch_market_data",
        "requestDescriptor": input_path.name,
        "requestChecksum": sha256_file(input_path),
        **metadata,
        "records": records_artifact,
    }
    manifest_path = generated_output_path(
        output_directory, "market-manifest.json"
    )
    write_json_new_or_identical(manifest, manifest_path)
    manifest_artifact = artifact_descriptor(
        manifest_path, output_directory, "application/json"
    )
    metrics = {
        "inputChecksum": manifest["requestChecksum"],
        "provider": provider_name,
        "canonicalTicker": identity.canonical_ticker,
        "exchange": identity.exchange,
        "currency": identity.currency,
        "adjustment": "raw",
        "barCount": len(bars),
        "recordCount": record_count,
        "recordsBytes": records_bytes,
    }
    return records_path.name, [records_artifact, manifest_artifact], metrics
