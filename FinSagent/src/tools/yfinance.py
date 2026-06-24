import logging
from typing import Any, Dict, List

import yfinance as yf

logger = logging.getLogger(__name__)


def _normalize_symbol(value: Any) -> str:
    return str(value).strip().upper()


def _safe_round(value: Any, digits: int = 2) -> Any:
    try:
        return None if value is None else round(float(value), digits)
    except Exception:
        return value


def _to_iso_date(value: Any) -> str:
    if hasattr(value, "strftime"):
        return value.strftime("%Y-%m-%d")
    return str(value)


def stock_snapshot(symbol: str) -> Dict[str, Any]:
    """Get a compact market snapshot from Yahoo Finance."""
    if not symbol:
        return {"error": "Ticker symbol cannot be empty."}
    symbol = _normalize_symbol(symbol)
    try:
        stock = yf.Ticker(symbol)
        info = stock.info or {}
        hist = stock.history(period="1mo")
        if hist.empty:
            return {"error": f"No price data available for {symbol}."}
        current_price = float(hist["Close"].iloc[-1])
        month_ago_price = float(hist["Close"].iloc[0])
        price_change_pct = ((current_price - month_ago_price) / month_ago_price) * 100 if month_ago_price else None
        result = {
            "input": symbol,
            "symbol": symbol,
            "company_name": info.get("longName") or info.get("shortName") or symbol,
            "sector": info.get("sector"),
            "industry": info.get("industry"),
            "currency": info.get("currency"),
            "exchange": info.get("exchange"),
            "current_price": _safe_round(current_price),
            "price_change_1mo_pct": _safe_round(price_change_pct),
            "market_cap": info.get("marketCap"),
            "pe_ratio": info.get("trailingPE"),
            "fifty_two_week_high": info.get("fiftyTwoWeekHigh"),
            "fifty_two_week_low": info.get("fiftyTwoWeekLow"),
        }
        logger.info(f"[STOCK SNAPSHOT TOOL] {result}")
        return result
    except Exception as e:
        logger.error(f"Error fetching stock snapshot: {e}")
        return {"error": f"An unexpected error occurred: {e}"}


def price_history(
    symbol: str,
    period: str = "1mo",
    interval: str = "1d",
    max_points: int = 60,
) -> Dict[str, Any]:
    """Get historical OHLCV data from Yahoo Finance."""
    if not symbol:
        return {"error": "Ticker symbol cannot be empty."}
    symbol = _normalize_symbol(symbol)
    max_points = max(1, min(int(max_points), 120))
    try:
        hist = yf.download(symbol, period=period, interval=interval, progress=False, auto_adjust=False)
        if hist.empty:
            return {"error": f"No price history available for {symbol}."}
        hist = hist.tail(max_points)
        points: List[Dict[str, Any]] = []
        for idx, row in hist.iterrows():
            points.append({
                "date": _to_iso_date(idx),
                "open": _safe_round(row.get("Open")),
                "high": _safe_round(row.get("High")),
                "low": _safe_round(row.get("Low")),
                "close": _safe_round(row.get("Close")),
                "adj_close": _safe_round(row.get("Adj Close")),
                "volume": int(row.get("Volume")) if row.get("Volume") is not None else None,
            })
        result = {
            "input": symbol,
            "symbol": symbol,
            "period": period,
            "interval": interval,
            "count": len(points),
            "prices": points,
        }
        logger.info(f"[PRICE HISTORY TOOL] symbol={symbol} period={period} interval={interval} count={len(points)}")
        return result
    except Exception as e:
        logger.error(f"Error fetching price history: {e}")
        return {"error": f"An unexpected error occurred: {e}"}
