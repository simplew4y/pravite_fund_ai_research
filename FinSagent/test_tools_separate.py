#!/usr/bin/env python3
"""
Quick smoke test for the Finnhub-backed company tools.

Examples:
  python test_company_tools.py --symbol ZK
  python test_company_tools.py --symbol Apple --limit 5 --raw
"""

import argparse
import json
import os
import sys
from typing import Any, Dict

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.join(ROOT_DIR, "src")
if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)

try:
    from utils.tools import basic_financials, company_news  # noqa: E402
except ModuleNotFoundError as exc:
    missing_package = exc.name or str(exc)
    print(
        f"Missing dependency: {missing_package}. "
        "Activate the project Python environment and install the required package before running this smoke test.",
        file=sys.stderr,
    )
    raise SystemExit(2) from exc


KEY_METRICS = [
    "10DayAverageTradingVolume",
    "13WeekPriceReturnDaily",
    "26WeekPriceReturnDaily",
    "52WeekHigh",
    "52WeekHighDate",
    "52WeekLow",
    "52WeekLowDate",
    "52WeekPriceReturnDaily",
    "beta",
    "currentDividendYieldTTM",
    "epsGrowth5Y",
    "grossMarginTTM",
    "marketCapitalization",
    "netProfitMarginTTM",
    "peBasicExclExtraTTM",
    "peNormalizedAnnual",
    "revenueGrowthTTMYoy",
]


def _print_json(title: str, payload: Dict[str, Any]) -> None:
    print(f"\n{'=' * 80}\n{title}\n{'=' * 80}")
    print(json.dumps(payload, ensure_ascii=False, indent=2, default=str))


def _compact_news(payload: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "input": payload.get("input"),
        "resolved_symbol": payload.get("resolved_symbol") or payload.get("symbol"),
        "company_match": payload.get("company_match"),
        "from_date": payload.get("from_date"),
        "to_date": payload.get("to_date"),
        "count": payload.get("count"),
        "personnel_change_count": payload.get("personnel_change_count"),
        "news": payload.get("news", []),
    }


def _compact_financials(payload: Dict[str, Any]) -> Dict[str, Any]:
    metrics = payload.get("metrics") or {}
    compact_metrics = {
        key: metrics.get(key)
        for key in KEY_METRICS
        if key in metrics
    }
    series = payload.get("series") or {}
    return {
        "input": payload.get("input"),
        "resolved_symbol": payload.get("resolved_symbol") or payload.get("symbol"),
        "key_metrics": compact_metrics,
        "available_metric_count": len(metrics),
        "available_series_groups": list(series.keys()) if isinstance(series, dict) else [],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Smoke test company_news and basic_financials tools.")
    parser.add_argument("--symbol", default="ZK", help="Company name or ticker, e.g. ZK, Zeekr, AAPL, Apple.")
    parser.add_argument("--from-date", default=None, help="News start date in YYYY-MM-DD. Defaults to tool's recent window.")
    parser.add_argument("--to-date", default=None, help="News end date in YYYY-MM-DD. Defaults to today.")
    parser.add_argument("--limit", type=int, default=5, help="Max news items to print.")
    parser.add_argument("--metric", default="all", help="Metric selector passed to basic_financials. Defaults to all.")
    parser.add_argument("--raw", action="store_true", help="Print full raw tool outputs.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    news_result = company_news(
        symbol=args.symbol,
        from_date=args.from_date,
        to_date=args.to_date,
        limit=args.limit,
    )
    financials_result = basic_financials(symbol=args.symbol, metric=args.metric)

    if args.raw:
        _print_json("company_news raw result", news_result)
        _print_json("basic_financials raw result", financials_result)
        return

    _print_json("company_news compact result", _compact_news(news_result))
    _print_json("basic_financials compact result", _compact_financials(financials_result))

    if news_result.get("error") or financials_result.get("error"):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
