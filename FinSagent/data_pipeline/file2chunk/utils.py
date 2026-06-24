"""file2chunk 共享工具

封装：
- 全局共享的 OpenAI client（懒加载，从环境变量读取配置）
- LLM 调用统一入口 ``chat_complete``：内部调用 ``client.chat.completions.create``，
  自动累计 usage、自动通过 ``call_with_retry`` 做错误重试。
- 线程安全的 ``LLMUsageTracker``：可通过 ``usage_tracker.snapshot()`` / ``reset()``
  在任意调用方汇总最终统计。

重试策略（``call_with_retry``）：
- 普通错误：最多重试 ``max_attempts`` 次（默认 3）。
- HTTP 429（Rate Limit）：不计入重试次数，sleep 3 秒后再试，安全上限
  ``RATE_LIMIT_MAX_RETRIES``。
- 用尽后抛出 ``LLMCallError``。
"""
from __future__ import annotations

import copy
import os
import threading
import time
from typing import Any, Callable, Dict, List, Optional

from dotenv import load_dotenv
from openai import OpenAI

# ---------------------------------------------------------------------------
# 重试封装
# ---------------------------------------------------------------------------
DEFAULT_MAX_ATTEMPTS = 3
RATE_LIMIT_MAX_RETRIES = 50
RATE_LIMIT_SLEEP_SECONDS = 3


class LLMCallError(RuntimeError):
    """LLM 调用在重试用尽后仍然失败时抛出。"""


def _is_rate_limit_error(exc: BaseException) -> bool:
    """仅识别 HTTP 429。"""
    status = getattr(exc, "status_code", None) or getattr(exc, "http_status", None)
    if status == 429:
        return True
    response = getattr(exc, "response", None)
    if response is not None and getattr(response, "status_code", None) == 429:
        return True
    if exc.__class__.__name__ == "RateLimitError":
        return True
    return False


def call_with_retry(
    func: Callable[..., Any],
    *args: Any,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    on_retry: Optional[Callable[[int, BaseException], None]] = None,
    **kwargs: Any,
) -> Any:
    """带重试的通用调用封装。

    - 非 429：算一次失败，达到 ``max_attempts`` 后抛 ``LLMCallError``。
    - 429：不计数，sleep 后重试；超出 ``RATE_LIMIT_MAX_RETRIES`` 才放弃。
    - ``on_retry(attempt_idx, exc)`` 回调中，429 时 ``attempt_idx`` 传 -1。
    """
    counted_attempt = 0
    rate_limit_retries = 0
    last_exc: Optional[BaseException] = None

    while counted_attempt < max_attempts:
        try:
            return func(*args, **kwargs)
        except BaseException as exc:  # noqa: BLE001
            last_exc = exc
            if _is_rate_limit_error(exc):
                if rate_limit_retries >= RATE_LIMIT_MAX_RETRIES:
                    raise LLMCallError(
                        f"429 rate-limit retries exhausted (>{RATE_LIMIT_MAX_RETRIES})"
                    ) from exc
                rate_limit_retries += 1
                if on_retry is not None:
                    try:
                        on_retry(-1, exc)
                    except Exception:
                        pass
                time.sleep(RATE_LIMIT_SLEEP_SECONDS)
                continue
            counted_attempt += 1
            if on_retry is not None:
                try:
                    on_retry(counted_attempt, exc)
                except Exception:
                    pass
            if counted_attempt >= max_attempts:
                break
            time.sleep(min(2 * counted_attempt, 5))

    raise LLMCallError(
        f"LLM call failed after {max_attempts} attempts: {last_exc}"
    ) from last_exc


# ---------------------------------------------------------------------------
# Usage tracker
# ---------------------------------------------------------------------------
def _extract_usage_value(usage: Any, key: str) -> int:
    if usage is None:
        return 0
    if isinstance(usage, dict):
        return usage.get(key, 0) or 0
    return getattr(usage, key, 0) or 0


class LLMUsageTracker:
    """线程安全的 LLM token usage 累计器，按 category 分类。"""

    _ZERO = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stats: Dict[str, Dict[str, int]] = {}

    def record(self, category: str, response: Any) -> None:
        usage = getattr(response, "usage", None)
        with self._lock:
            stats = self._stats.setdefault(category, dict(self._ZERO))
            stats["calls"] += 1
            stats["prompt_tokens"] += _extract_usage_value(usage, "prompt_tokens")
            stats["completion_tokens"] += _extract_usage_value(usage, "completion_tokens")
            stats["total_tokens"] += _extract_usage_value(usage, "total_tokens")

    def reset(self) -> None:
        with self._lock:
            self._stats.clear()

    def snapshot(self) -> Dict[str, Dict[str, int]]:
        with self._lock:
            return copy.deepcopy(self._stats)


usage_tracker = LLMUsageTracker()


# ---------------------------------------------------------------------------
# OpenAI client（懒加载）
# ---------------------------------------------------------------------------
_client: Optional[OpenAI] = None
_client_lock = threading.Lock()
_env_loaded = False


def _ensure_env() -> None:
    global _env_loaded
    if not _env_loaded:
        load_dotenv()
        _env_loaded = True


def get_default_model() -> str:
    _ensure_env()
    return os.getenv("LLM_MODEL_NAME", "deepseek-v3")


def get_client() -> OpenAI:
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _ensure_env()
                api_key = os.getenv("LLM_API_KEY")
                base_url = os.getenv("LLM_BASE_URL", "https://api.lkeap.cloud.tencent.com/v1")
                if not api_key:
                    raise RuntimeError(
                        "LLM_API_KEY not found. Please set it in .env file or environment variable."
                    )
                _client = OpenAI(api_key=api_key, base_url=base_url)
    return _client


# ---------------------------------------------------------------------------
# 统一 LLM 调用入口
# ---------------------------------------------------------------------------
def chat_complete(
    category: str,
    messages: List[Dict[str, str]],
    *,
    model: Optional[str] = None,
    temperature: float = 0.3,
    extra_body: Optional[Dict[str, Any]] = None,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    log_prefix: Optional[str] = None,
    return_full_response: bool = False,
    **extra_kwargs: Any,
) -> Any:
    """统一的 chat completion 调用：内部带重试、自动累加 usage。

    Args:
        category: usage 统计分类（如 ``"anaphora"``、``"summary"``）。
        messages: OpenAI 风格的 messages 列表。
        model: 默认走 ``LLM_MODEL_NAME`` 环境变量。
        temperature: 采样温度。
        extra_body: 透传给 OpenAI SDK 的 ``extra_body``，默认
            ``{"enable_thinking": False}``。
        max_attempts: 普通错误的最大尝试次数，传给 ``call_with_retry``。
        log_prefix: 重试日志前缀，默认 ``[{category} retry ...]``。
        return_full_response: True 时返回完整 response 对象，False（默认）
            返回 ``response.choices[0].message.content``。
        **extra_kwargs: 其它透传给 ``client.chat.completions.create`` 的参数。

    Returns:
        字符串内容 或 完整 response 对象。

    Raises:
        LLMCallError: 重试用尽。
    """
    if extra_body is None:
        extra_body = {"enable_thinking": False}
    chosen_model = model or get_default_model()
    prefix = log_prefix or f"[{category} retry"

    def _do_call():
        client = get_client()
        response = client.chat.completions.create(
            model=chosen_model,
            messages=messages,
            extra_body=extra_body,
            temperature=temperature,
            **extra_kwargs,
        )
        usage_tracker.record(category, response)
        if return_full_response:
            return response
        return response.choices[0].message.content

    return call_with_retry(
        _do_call,
        max_attempts=max_attempts,
        on_retry=lambda i, e: print(f"{prefix} attempt={i}] {type(e).__name__}: {e}"),
    )
