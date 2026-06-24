"""
Template utilities for filtering verbose tool results before answer drafting.

The filtering policy is intentionally left as per-tool plugins. Register a
filter for each tool that needs special handling, then call filter_tool_results
with the tool_results dict from a sub-agent.
"""

import asyncio
import inspect
import json
import logging
import httpx
import openai
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


ToolFilterFn = Callable[["ToolFilterContext", Any], Any]
TOOL_FILTER_REGISTRY: Dict[str, ToolFilterFn] = {}
_CLIENT_CACHE: Dict[tuple[str, str, float, int], Any] = {}


@dataclass
class ToolResultFilterConfig:
    enabled: bool = False
    base_url: str = "http://127.0.0.1:8008/v1"
    api_key: str = "EMPTY"
    model: str = "tool-filter"
    timeout_seconds: float = 20.0
    max_retries: int = 1
    tools_enabled: List[str] = field(default_factory=lambda: ["company_news", "basic_financials"])

    @classmethod
    def from_config(cls, config: Optional[Dict[str, Any]]) -> "ToolResultFilterConfig":
        defaults = cls()
        payload = (config or {}).get("tool_result_filter") or {}
        return cls(
            enabled=bool(payload.get("enabled", defaults.enabled)),
            base_url=payload.get("base_url", defaults.base_url),
            api_key=payload.get("api_key", defaults.api_key),
            model=payload.get("model", defaults.model),
            timeout_seconds=float(payload.get("timeout_seconds", defaults.timeout_seconds)),
            max_retries=int(payload.get("max_retries", defaults.max_retries)),
            tools_enabled=list(payload.get("tools_enabled", defaults.tools_enabled)),
        )


@dataclass
class ToolFilterContext:
    original_query: str
    agent: str
    sub_queries: List[str]
    tool_name: str
    all_tool_results: Dict[str, Any]
    config: ToolResultFilterConfig


def register_tool_filter(tool_name: str) -> Callable[[ToolFilterFn], ToolFilterFn]:
    def decorator(fn: ToolFilterFn) -> ToolFilterFn:
        TOOL_FILTER_REGISTRY[tool_name] = fn
        return fn

    return decorator


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def get_filter_client(config: ToolResultFilterConfig) -> Any:
    key = (config.base_url, config.api_key, config.timeout_seconds, config.max_retries)
    client = _CLIENT_CACHE.get(key)
    if client is None:
        client = openai.AsyncOpenAI(
            api_key=config.api_key,
            base_url=config.base_url,
            timeout=httpx.Timeout(config.timeout_seconds),
            max_retries=config.max_retries,
        )
        _CLIENT_CACHE[key] = client
    return client


async def call_vllm_filter(
    context: ToolFilterContext,
    tool_result: Any,
    system_prompt: str,
    user_payload: Optional[Dict[str, Any]] = None,
    response_format: Optional[Dict[str, str]] = None,
) -> Any:
    """
    Helper for per-tool filters that want to call the vLLM OpenAI-compatible API.

    A tool-specific filter should provide the actual prompts and response parser.
    """
    client = get_filter_client(context.config)
    payload = user_payload or {
        "agent": context.agent,
        "original_query": context.original_query,
        "sub_queries": context.sub_queries,
        "tool_name": context.tool_name,
        "tool_result": tool_result,
    }
    kwargs: Dict[str, Any] = {}
    if response_format:
        kwargs["response_format"] = response_format
    response = await client.chat.completions.create(
        model=context.config.model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False, default=str)},
        ],
        temperature=0,
        **kwargs,
    )
    return response.choices[0].message.content


@register_tool_filter("company_news")
async def filter_company_news(context: ToolFilterContext, tool_result: Any) -> Any:
    """
    Filter company news based on query relevance using vLLM model.
    Assumes tool_result is a list of news items, each with 'title', 'content', etc.
    """
    if not isinstance(tool_result, list) or not tool_result:
        return tool_result

    system_prompt = (
        "You are a financial news filter. Given a user query and a list of company news articles, "
        "select only the news items that are directly relevant to answering the query. "
        "Return a JSON object with 'selected_indices' as a list of indices (0-based) of relevant news, "
        "and 'reasoning' as a brief explanation."
    )

    user_payload = {
        "query": context.original_query,
        "news_items": [
            {"index": i, "title": item.get("title", ""), "content": item.get("content", "")[:500]}  # Truncate content
            for i, item in enumerate(tool_result)
        ]
    }

    response_format = {"type": "json_object", "properties": {"selected_indices": {"type": "array", "items": {"type": "integer"}}, "reasoning": {"type": "string"}}}

    try:
        response_content = await call_vllm_filter(
            context,
            tool_result,
            system_prompt=system_prompt,
            user_payload=user_payload,
            response_format=response_format,
        )
        parsed = json.loads(response_content)
        selected_indices = parsed.get("selected_indices", [])
        # Filter the original tool_result to only include selected news
        filtered_news = [tool_result[i] for i in selected_indices if 0 <= i < len(tool_result)]
        return filtered_news
    except Exception as e:
        logger.warning(f"Failed to filter company news: {e}")
        return tool_result  # Fallback to original


@register_tool_filter("basic_financials")
async def filter_basic_financials(context: ToolFilterContext, tool_result: Any) -> Any:
    if not isinstance(tool_result, dict):
        return tool_result
        
    metrics = tool_result.get("metrics", {})
    series = tool_result.get("series", {})
    if not metrics and not series:
        return tool_result
        
    system_prompt = """You are an intelligent financial data filter.
Given the user's query and a list of available financial metric keys, identify which keys are directly relevant to answering the query.

Here is a glossary to help you understand some of the fields:
- TTM: Trailing Twelve Months
- Yoy: Year over Year
- EV: Enterprise Value
- EPS: Earnings Per Share
- roa: return on assets (e.g., roaRfy: recent fiscal year)
- roe: return on equity
- roi: return on investment (e.g., roic: invested capital)
- rotc: return on total capital
- AverageTradingVolume: trading activity
- ADReturnStd: Adjusted Return std (volatility)
- PriceReturnDaily: daily price return (e.g., monthToDatePriceReturnDaily)
- assetTurnoverAnnual: asset turnover
- inventoryTurnoverAnnual: inventory turnover
- receivablesTurnoverAnnual: receivables turnover
- revenueEmployeeAnnual: revenue per employee

Return your answer as a JSON object with two arrays of strings: "metrics_keys" and "series_keys", containing the keys to keep.
Only include keys that are strongly necessary. If no keys are relevant, return empty arrays.
Respond ONLY with valid JSON."""

    payload = {
        "query": context.original_query,
        "available_metrics_keys": list(metrics.keys()) if isinstance(metrics, dict) else [],
        "available_series_keys": list(series.keys()) if isinstance(series, dict) else []
    }

    try:
        response_text = await call_vllm_filter(
            context=context,
            tool_result=tool_result,
            system_prompt=system_prompt,
            user_payload=payload,
            response_format={"type": "json_object"}
        )
        parsed = json.loads(response_text)
        
        filtered_metrics = {k: metrics[k] for k in parsed.get("metrics_keys", []) if k in metrics}
        filtered_series = {k: series[k] for k in parsed.get("series_keys", []) if k in series}
        
        filtered_result = dict(tool_result)
        # Avoid overriding with completely empty dicts if parsing was likely flawed, but here we trust the model.
        filtered_result["metrics"] = filtered_metrics
        filtered_result["series"] = filtered_series
        return filtered_result
    except Exception as e:
        logger.warning(f"Failed to filter basic_financials result: {e}")
        return tool_result


async def filter_tool_results(
    tool_results: dict,
    original_query: str,
    agent: str,
    sub_queries: list[str],
    config: Optional[Dict[str, Any]] = None,
) -> dict:
    """
    Filter tool results through per-tool handlers.

    The default template is safe: filtering is disabled unless config enables it,
    and any per-tool failure falls back to the original tool output.
    """
    filter_config = ToolResultFilterConfig.from_config(config)
    if not tool_results or not filter_config.enabled:
        return tool_results

    filtered_results = dict(tool_results)
    enabled_tools = set(filter_config.tools_enabled)

    async def _filter_one(tool_name: str, tool_result: Any) -> tuple[str, Any]:
        filter_fn = TOOL_FILTER_REGISTRY.get(tool_name)
        if tool_name not in enabled_tools or not filter_fn:
            return tool_name, tool_result
        context = ToolFilterContext(
            original_query=original_query,
            agent=agent,
            sub_queries=sub_queries,
            tool_name=tool_name,
            all_tool_results=tool_results,
            config=filter_config,
        )
        try:
            return tool_name, await _maybe_await(filter_fn(context, tool_result))
        except Exception as e:
            logger.warning(
                "Tool result filter failed for tool=%s agent=%s; using raw tool result: %s",
                tool_name,
                agent,
                e,
                exc_info=True,
            )
            return tool_name, tool_result

    filtered_pairs = await asyncio.gather(
        *[_filter_one(tool_name, tool_result) for tool_name, tool_result in tool_results.items()]
    )
    for tool_name, filtered_value in filtered_pairs:
        filtered_results[tool_name] = filtered_value
    return filtered_results
