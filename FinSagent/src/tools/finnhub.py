import logging
import os
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import requests
import requests.adapters
import yaml

try:
    import finnhub
except ModuleNotFoundError:
    finnhub = None

logger = logging.getLogger(__name__)

_config_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "config", "production.yaml")
with open(_config_path, "r", encoding="utf-8") as _f:
    _config = yaml.safe_load(_f)

FINNHUB_API_KEY = os.environ.get("FINNHUB_API_KEY") or _config.get("finnhub_api_key")
BASE_URL = _config.get("finnhub_base_url")


def _get_client() -> Any:
    if finnhub is None:
        raise ImportError("finnhub-python is required for Finnhub client tools.")
    return finnhub.Client(api_key=FINNHUB_API_KEY)


def _normalize_symbol(value: Any) -> str:
    return str(value).strip().upper()



def company_ticker_lookup(query: str) -> Dict[str, Any]:
    """Resolve a company name or ticker using Finnhub's symbol search endpoint."""
    if not query:
        return {"error": "Symbol query cannot be empty."}
    lookup_query = query.strip()
    try:
        response = requests.get(
            f"{BASE_URL}/search",
            params={"q": lookup_query, "token": FINNHUB_API_KEY},
            timeout=15,
        )
        response.raise_for_status()
        payload = response.json() or {}
        raw_results = payload.get("result") or []
        if not raw_results:
            return {"error": f"No symbol lookup results for {lookup_query}."}
        best = raw_results[0]
        resolved_symbol = (best.get("symbol") or best.get("displaySymbol") or "").upper()
        if not resolved_symbol:
            return {"error": f"No symbol found for {lookup_query}."}
        result = {
            "input": query,
            "lookup_query": lookup_query,
            "symbol": resolved_symbol,
            "display_symbol": best.get("displaySymbol"),
            "description": best.get("description"),
            "type": best.get("type"),
            "count": payload.get("count", len(raw_results)),
        }
        logger.info(f"[COMPANY TICKER LOOKUP TOOL] {result}")
        return result
    except Exception as e:
        logger.warning(f"Symbol lookup failed for query '{lookup_query}': {e}")
        return {"error": f"Symbol lookup failed for {lookup_query}: {e}"}


def get_ipo_info(ticker: str = "LOT") -> Dict[str, Any]:
    """Get IPO information for a given ticker."""
    if not ticker:
        return {"error": "Ticker symbol cannot be empty."}
    ticker = _normalize_symbol(ticker)
    end_date = datetime.now()
    start_date = end_date - timedelta(days=730)
    try:
        response = requests.get(
            f"{BASE_URL}/calendar/ipo",
            params={
                "from": start_date.strftime("%Y-%m-%d"),
                "to": end_date.strftime("%Y-%m-%d"),
                "token": FINNHUB_API_KEY,
            },
        )
        response.raise_for_status()
        for ipo in response.json().get("ipoCalendar", []):
            if ipo.get("symbol") == ticker:
                return {
                    "companyName": ipo.get("name"),
                    "ticker": ipo.get("symbol"),
                    "ipoDate": ipo.get("date"),
                    "ipoPrice": ipo.get("price"),
                    "shares": ipo.get("numberOfShares"),
                    "exchange": ipo.get("exchange"),
                }
        return {"error": f"IPO information for {ticker} not found."}
    except Exception as e:
        logger.error(f"Error fetching IPO info: {e}")
        return {"error": f"An unexpected error occurred: {e}"}


def get_stock_price(ticker: str = "ZK") -> Dict[str, Any]:
    """Get current stock price for a given ticker."""
    if not ticker:
        return {"error": "Ticker symbol cannot be empty."}
    ticker = _normalize_symbol(ticker)
    try:
        response = requests.get(
            f"{BASE_URL}/quote",
            params={"symbol": ticker, "token": FINNHUB_API_KEY},
        )
        response.raise_for_status()
        data = response.json()
        if data.get("c") == 0 and data.get("pc") == 0:
            return {"error": f"No price data available for {ticker}."}
        return {
            "ticker": ticker,
            "currentPrice": data.get("c"),
            "previousClose": data.get("pc"),
            "change": data.get("d"),
            "percentChange": data.get("dp"),
        }
    except Exception as e:
        logger.error(f"Error fetching stock price: {e}")
        return {"error": f"An unexpected error occurred: {e}"}


def company_profile(symbol: str) -> Dict[str, Any]:
    """Get a company profile from Finnhub."""
    if not symbol:
        return {"error": "Ticker symbol cannot be empty."}
    symbol = _normalize_symbol(symbol)
    try:
        profile = _get_client().company_profile2(symbol=symbol)
        if not profile:
            return {"error": f"No company profile found for {symbol}."}
        result = {
            "input": symbol,
            "symbol": symbol,
            "name": profile.get("name"),
            "ticker": profile.get("ticker"),
            "exchange": profile.get("exchange"),
            "ipo": profile.get("ipo"),
            "industry": profile.get("finnhubIndustry"),
            "country": profile.get("country"),
            "currency": profile.get("currency"),
            "marketCapitalization": profile.get("marketCapitalization"),
            "shareOutstanding": profile.get("shareOutstanding"),
            "weburl": profile.get("weburl"),
        }
        logger.info(f"[COMPANY PROFILE TOOL] {result}")
        return result
    except Exception as e:
        logger.error(f"Error fetching company profile: {e}")
        return {"error": f"An unexpected error occurred: {e}"}


def company_news(
    symbol: str,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    benchmark_date: Optional[str] = None,
    limit: int = 10,
) -> Dict[str, Any]:
    """Get recent company news from Finnhub for a ticker symbol."""
    if not symbol:
        return {"error": "Ticker symbol cannot be empty."}
    symbol = _normalize_symbol(symbol)
    if benchmark_date:
        # Use benchmark_date as the end_date, and start_date as benchmark_date - 90 days
        end_date = benchmark_date
        start_date = (datetime.strptime(benchmark_date, "%Y-%m-%d") - timedelta(days=90)).strftime("%Y-%m-%d")
    else:
        # Default to a wider benchmark window for historical data
        default_to = "2025-12-31"
        default_from = "2024-01-01"
        end_date = to_date or default_to
        start_date = from_date or default_from
    limit = max(1, min(int(limit), 50))
    try:
        raw_items = _get_client().company_news(symbol, _from=start_date, to=end_date) or []
        items: List[Dict[str, Any]] = []
        for item in raw_items[:limit]:
            items.append({
                "date": datetime.fromtimestamp(item.get("datetime", 0)).strftime("%Y-%m-%d") if item.get("datetime") else None,
                "headline": item.get("headline"),
                "summary": item.get("summary"),
                "source": item.get("source"),
                "url": item.get("url"),
            })
        result = {
            "input": symbol,
            "symbol": symbol,
            "from_date": start_date,
            "to_date": end_date,
            "count": len(items),
            "news": items,
        }
        logger.info(f"[COMPANY NEWS TOOL] symbol={symbol} count={len(items)}")
        return result
    except Exception as e:
        logger.error(f"Error fetching company news: {e}")
        return {"error": f"An unexpected error occurred: {e}"}


def basic_financials(symbol: str) -> Dict[str, Any]:
    """Get company basic financials such as margin, P/E ratio, 52-week high/low etc."""
    if not symbol:
        return {"error": "financial symbol cannot be empty."}
    symbol = _normalize_symbol(symbol)

    session = requests.Session()

    try:
        response = session.get(
            f"{BASE_URL}/stock/metric",
            params={"symbol": symbol, "metric": "all", "token": FINNHUB_API_KEY},
            timeout=25,
        )
        response.raise_for_status()
        payload = response.json() or {}
        result = {
            "input": symbol,
            "symbol": symbol,
            "metrics": payload.get("metric", {}),
            "series": payload.get("series", {}),
            "fallback_recommended": False,
        }
        logger.info("[BASIC FINANCIALS TOOL] symbol=%s", symbol)
        return result
    except requests.exceptions.Timeout:
        logger.error("[basic_financials] Timeout after 3 retries for symbol=%s", symbol)
        return {
            "error": (
                "API timeout after 3 retries. "
                "Financial ratio data is unavailable. "
                "Please fallback to RAG retrieval from the PDF vector store."
            ),
            "fallback_recommended": True,
            "symbol": symbol,
        }
    except requests.exceptions.RequestException as e:
        logger.error("[basic_financials] Request failed for %s: %s", symbol, e)
        return {
            "error": f"API request failed for {symbol}: {e}",
            "fallback_recommended": True,
            "symbol": symbol,
        }
    except Exception as e:
        logger.error("[basic_financials] Unexpected error for %s: %s", symbol, e)
        return {
            "error": f"An unexpected error occurred: {e}",
            "fallback_recommended": True,
            "symbol": symbol,
        }
