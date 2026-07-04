"""FMP (Financial Modeling Prep) API client.

Provides real-time market data for memo generation:
  - stock quote (price, market cap, 52-week range)
  - company profile (sector, industry, description)
  - financial ratios (P/E, P/B, ROE, dividend yield)
  - key metrics (ROE, revenue growth, EBITDA margin)
  - price target (analyst consensus)

All endpoints use the stable API:
  https://financialmodelingprep.com/stable/<endpoint>?symbol=NVDA&apikey=KEY
"""

import logging
import os
from typing import Any, Dict, Optional

import requests
import yaml

logger = logging.getLogger(__name__)

_config_path = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
    "config",
    "production.yaml",
)
with open(_config_path, "r", encoding="utf-8") as _f:
    _config = yaml.safe_load(_f)

FMP_API_KEY = os.environ.get("FMP_API_KEY") or _config.get("fmp_api_key", "")
BASE_URL = (_config.get("fmp_base_url") or "https://financialmodelingprep.com/stable").rstrip("/")

_SESSION = requests.Session()
_SESSION.headers.update({"Accept": "application/json"})


def _request(endpoint: str, params: Optional[Dict[str, Any]] = None,
             timeout: float = 15.0) -> Any:
    """Make a GET request to FMP API and return parsed JSON."""
    url = f"{BASE_URL}/{endpoint.lstrip('/')}"
    merged = {"apikey": FMP_API_KEY}
    if params:
        merged.update(params)
    try:
        resp = _SESSION.get(url, params=merged, timeout=timeout)
        resp.raise_for_status()
        return resp.json()
    except requests.exceptions.Timeout:
        logger.warning("[FMP] Timeout for %s", url)
        return None
    except requests.exceptions.RequestException as e:
        logger.warning("[FMP] Request failed for %s: %s", url, e)
        return None
    except Exception as e:
        logger.warning("[FMP] Unexpected error for %s: %s", url, e)
        return None


def _fmt_price(val: Any) -> str:
    """Format a numeric price as '$X.XX'."""
    if val is None:
        return "N/A"
    try:
        return f"${float(val):.2f}"
    except (ValueError, TypeError):
        return "N/A"


def _fmt_market_cap(val: Any) -> str:
    """Format market cap in T/B/M."""
    if val is None:
        return "N/A"
    try:
        v = float(val)
        if v >= 1e12:
            return f"${v / 1e12:.2f}T"
        elif v >= 1e9:
            return f"${v / 1e9:.2f}B"
        elif v >= 1e6:
            return f"${v / 1e6:.2f}M"
        return f"${v:,.0f}"
    except (ValueError, TypeError):
        return "N/A"


def _fmt_pct(val: Any) -> str:
    """Format a ratio (0.0123) as percentage string '1.23%'."""
    if val is None:
        return "N/A"
    try:
        v = float(val)
        if v > 1:
            return f"{v:.2f}%"
        return f"{v * 100:.2f}%"
    except (ValueError, TypeError):
        return "N/A"


def _fmt_ratio(val: Any) -> str:
    """Format a ratio like P/E."""
    if val is None:
        return "N/A"
    try:
        return f"{float(val):.2f}"
    except (ValueError, TypeError):
        return "N/A"


def stock_quote(symbol: str) -> Dict[str, Any]:
    """Get real-time stock quote from FMP.

    Returns: {symbol, price, market_cap, 52_week_high, 52_week_low,
              52_week_range, change_pct, volume, pe_ratio}
    """
    if not symbol:
        return {"error": "Symbol cannot be empty."}
    data = _request("quote", {"symbol": symbol})
    if not data or not isinstance(data, list) or not data:
        return {"error": f"No quote data for {symbol}"}
    q = data[0]
    price = q.get("price")
    mkt_cap = q.get("marketCap")
    high_52 = q.get("yearHigh")
    low_52 = q.get("yearLow")
    range_str = "N/A"
    if high_52 is not None and low_52 is not None:
        range_str = f"${float(low_52):.2f} - ${float(high_52):.2f}"
    result = {
        "symbol": symbol,
        "price": _fmt_price(price),
        "market_cap": _fmt_market_cap(mkt_cap),
        "52_week_high": _fmt_price(high_52),
        "52_week_low": _fmt_price(low_52),
        "52_week_range": range_str,
        "change_pct": _fmt_pct(q.get("changesPercentage")),
        "volume": q.get("volume"),
        "pe_ratio": _fmt_ratio(q.get("pe")),
    }
    logger.info("[FMP] stock_quote(%s): price=%s, mcap=%s", symbol, result["price"], result["market_cap"])
    return result


def company_profile(symbol: str) -> Dict[str, Any]:
    """Get company profile from FMP.

    Returns: {symbol, company_name, sector, industry, description,
              ceo, exchange, website, beta}
    """
    if not symbol:
        return {"error": "Symbol cannot be empty."}
    data = _request("profile", {"symbol": symbol})
    if not data or not isinstance(data, list) or not data:
        return {"error": f"No profile data for {symbol}"}
    p = data[0]
    result = {
        "symbol": symbol,
        "company_name": p.get("companyName", ""),
        "sector": p.get("sector", "N/A"),
        "industry": p.get("industry", "N/A"),
        "description": (p.get("description") or "")[:500],
        "ceo": p.get("ceo", ""),
        "exchange": p.get("exchange", ""),
        "website": p.get("website", ""),
        "beta": _fmt_ratio(p.get("beta")),
    }
    logger.info("[FMP] company_profile(%s): sector=%s, industry=%s", symbol, result["sector"], result["industry"])
    return result


def financial_ratios(symbol: str) -> Dict[str, Any]:
    """Get financial ratios from FMP (most recent period).

    Returns: {symbol, pe_ratio, pb_ratio, dividend_yield, roe,
              gross_margin, operating_margin, net_margin}
    """
    if not symbol:
        return {"error": "Symbol cannot be empty."}
    data = _request("ratios", {"symbol": symbol})
    if not data or not isinstance(data, list) or not data:
        return {"error": f"No ratio data for {symbol}"}
    r = data[0]
    result = {
        "symbol": symbol,
        "pe_ratio": _fmt_ratio(r.get("priceToEarningsRatio")),
        "pb_ratio": _fmt_ratio(r.get("priceToBookRatio")),
        "dividend_yield": _fmt_pct(r.get("dividendYield")),
        "roe": _fmt_pct(r.get("returnOnEquity")),
        "gross_margin": _fmt_pct(r.get("grossProfitMargin")),
        "operating_margin": _fmt_pct(r.get("operatingProfitMargin")),
        "net_margin": _fmt_pct(r.get("netProfitMargin")),
        "ebitda_margin": _fmt_pct(r.get("ebitdaMargin")),
    }
    logger.info("[FMP] financial_ratios(%s): PE=%s, PB=%s, ROE=%s", symbol, result["pe_ratio"], result["pb_ratio"], result["roe"])
    return result


def key_metrics(symbol: str) -> Dict[str, Any]:
    """Get key metrics from FMP (most recent period).

    Returns: {symbol, roe, revenue_growth, ebitda_margin, eps}
    """
    if not symbol:
        return {"error": "Symbol cannot be empty."}
    data = _request("key-metrics", {"symbol": symbol})
    if not data or not isinstance(data, list) or not data:
        return {"error": f"No key-metrics data for {symbol}"}
    m = data[0]
    result = {
        "symbol": symbol,
        "roe": _fmt_pct(m.get("returnOnEquity")),
        "revenue_growth": _fmt_pct(m.get("revenueGrowth") or m.get("revenuePerShare")),
        "ebitda_margin": _fmt_pct(m.get("ebitdaMargin")),
        "eps": _fmt_price(m.get("netIncomePerShare")),
    }
    logger.info("[FMP] key_metrics(%s): ROE=%s, rev_growth=%s", symbol, result["roe"], result["revenue_growth"])
    return result


def price_target(symbol: str) -> Dict[str, Any]:
    """Get analyst price target consensus from FMP.

    Returns: {symbol, target_price, target_high, target_low, target_median}
    """
    if not symbol:
        return {"error": "Symbol cannot be empty."}
    data = _request("price-target-consensus", {"symbol": symbol})
    if not data or not isinstance(data, list) or not data:
        return {"error": f"No price-target data for {symbol}"}
    t = data[0]
    result = {
        "symbol": symbol,
        "target_price": _fmt_price(t.get("targetConsensus")),
        "target_high": _fmt_price(t.get("targetHigh")),
        "target_low": _fmt_price(t.get("targetLow")),
        "target_median": _fmt_price(t.get("targetMedian")),
    }
    logger.info("[FMP] price_target(%s): target=%s", symbol, result["target_price"])
    return result


def market_snapshot(symbol: str) -> Dict[str, Any]:
    """Fetch all market data for a symbol in one call.

    Aggregates stock_quote, company_profile, financial_ratios,
    key_metrics, and price_target into a single flat dict.
    Missing values default to "N/A".

    Returns dict with keys matching MemoGenerateRequest fields:
        share_price, target_price, market_cap, fwd_pe, pb_ratio,
        roe, dividend_yield, week_52_range, sector
    """
    snapshot: Dict[str, Any] = {
        "share_price": "N/A",
        "target_price": "N/A",
        "market_cap": "N/A",
        "fwd_pe": "N/A",
        "pb_ratio": "N/A",
        "roe": "N/A",
        "dividend_yield": "N/A",
        "week_52_range": "N/A",
        "sector": "N/A",
        # extra fields for report_data
        "eps": "N/A",
        "revenue_growth": "N/A",
        "ebitda_margin": "N/A",
        "gross_margin": "N/A",
        "operating_margin": "N/A",
        "net_margin": "N/A",
        "beta": "N/A",
        "company_name": "",
        "industry": "N/A",
        "company_description": "",
    }

    # Fetch all in parallel would be nice, but keep it simple and sequential
    # (each call is < 1s, total < 5s)
    quote = stock_quote(symbol)
    profile = company_profile(symbol)
    ratios = financial_ratios(symbol)
    metrics = key_metrics(symbol)
    target = price_target(symbol)

    # Merge quote data
    if "error" not in quote:
        if quote["price"] != "N/A":
            snapshot["share_price"] = quote["price"]
        if quote["market_cap"] != "N/A":
            snapshot["market_cap"] = quote["market_cap"]
        if quote["52_week_range"] != "N/A":
            snapshot["week_52_range"] = quote["52_week_range"]
        if quote["pe_ratio"] != "N/A":
            snapshot["fwd_pe"] = quote["pe_ratio"]

    # Merge profile data
    if "error" not in profile:
        if profile["sector"] != "N/A":
            snapshot["sector"] = profile["sector"]
        snapshot["company_name"] = profile.get("company_name", "")
        snapshot["industry"] = profile.get("industry", "N/A")
        snapshot["company_description"] = profile.get("description", "")
        snapshot["beta"] = profile.get("beta", "N/A")

    # Merge ratios data
    if "error" not in ratios:
        if ratios["pb_ratio"] != "N/A":
            snapshot["pb_ratio"] = ratios["pb_ratio"]
        if ratios["dividend_yield"] != "N/A":
            snapshot["dividend_yield"] = ratios["dividend_yield"]
        if ratios["roe"] != "N/A":
            snapshot["roe"] = ratios["roe"]
        if ratios["gross_margin"] != "N/A":
            snapshot["gross_margin"] = ratios["gross_margin"]
        if ratios["operating_margin"] != "N/A":
            snapshot["operating_margin"] = ratios["operating_margin"]
        if ratios["net_margin"] != "N/A":
            snapshot["net_margin"] = ratios["net_margin"]
        # Prefer ratios PE over quote PE if available
        if ratios["pe_ratio"] != "N/A":
            snapshot["fwd_pe"] = ratios["pe_ratio"]

    # Merge key metrics
    if "error" not in metrics:
        if metrics["roe"] != "N/A" and snapshot["roe"] == "N/A":
            snapshot["roe"] = metrics["roe"]
        if metrics["revenue_growth"] != "N/A":
            snapshot["revenue_growth"] = metrics["revenue_growth"]
        if metrics["ebitda_margin"] != "N/A":
            snapshot["ebitda_margin"] = metrics["ebitda_margin"]
        if metrics["eps"] != "N/A":
            snapshot["eps"] = metrics["eps"]

    # Merge price target
    if "error" not in target:
        if target["target_price"] != "N/A":
            snapshot["target_price"] = target["target_price"]

    logger.info("[FMP] market_snapshot(%s): price=%s, mcap=%s, PE=%s, sector=%s",
                symbol, snapshot["share_price"], snapshot["market_cap"],
                snapshot["fwd_pe"], snapshot["sector"])
    return snapshot
