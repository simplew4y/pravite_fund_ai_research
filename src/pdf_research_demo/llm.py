"""OpenAI-compatible LLM client for the PDF research demo."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "FinSagent/config/production.yaml"


class LLMError(RuntimeError):
    """Raised when the configured LLM cannot complete a chat request."""


@dataclass(frozen=True)
class LLMConfig:
    model_name: str
    base_url: str
    api_key: str
    timeout_seconds: float = 60.0
    max_tokens: int = 1200
    temperature: float = 0.2
    chat_template_enable_thinking: bool | None = None
    source: str = ""

    def safe_summary(self) -> dict[str, str | float | int | bool]:
        return {
            "enabled": bool(self.model_name and self.base_url and self.api_key),
            "model_name": self.model_name,
            "base_url": self.base_url,
            "timeout_seconds": self.timeout_seconds,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
            "chat_template_enable_thinking": self.chat_template_enable_thinking,
            "source": self.source,
        }


def _first_env(*names: str) -> str:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return ""


def _read_yaml(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    if not isinstance(data, dict):
        return {}
    return data


def _optional_bool(value: Any) -> bool | None:
    if value is None or str(value).strip() == "":
        return None
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"Invalid optional boolean value: {value!r}")


def load_llm_config(config_path: str | Path | None = None) -> LLMConfig | None:
    """Load LLM config from env overrides plus the local production YAML."""

    selected_path = Path(
        config_path
        or os.environ.get("PDF_RESEARCH_LLM_CONFIG")
        or DEFAULT_CONFIG_PATH
    ).expanduser()
    data = _read_yaml(selected_path.resolve())

    model_name = _first_env("PDF_RESEARCH_LLM_MODEL", "LLM_MODEL_NAME") or str(
        data.get("llm_model_name") or ""
    )
    base_url = _first_env(
        "PDF_RESEARCH_LLM_BASE_URL", "LLM_BASE_URL", "OPENAI_BASE_URL"
    ) or str(data.get("llm_base_url") or "")
    api_key = _first_env(
        "PDF_RESEARCH_LLM_API_KEY", "LLM_API_KEY", "OPENAI_API_KEY"
    ) or str(
        data.get("llm_api_key") or ""
    )
    if not (model_name and base_url and api_key):
        return None

    timeout_seconds = float(
        data.get("llm_timeout_seconds")
        or os.environ.get("PDF_RESEARCH_LLM_TIMEOUT")
        or 60
    )
    max_tokens = int(
        data.get("llm_max_tokens")
        or os.environ.get("PDF_RESEARCH_LLM_MAX_TOKENS")
        or 1200
    )
    temperature = float(
        data.get("llm_temperature")
        or os.environ.get("PDF_RESEARCH_LLM_TEMPERATURE")
        or 0.2
    )
    thinking_value = _first_env(
        "PDF_RESEARCH_LLM_ENABLE_THINKING",
        "LLM_CHAT_TEMPLATE_ENABLE_THINKING",
    )
    if not thinking_value:
        thinking_value = data.get("llm_chat_template_enable_thinking")

    return LLMConfig(
        model_name=model_name,
        base_url=base_url,
        api_key=api_key,
        timeout_seconds=timeout_seconds,
        max_tokens=max_tokens,
        temperature=temperature,
        chat_template_enable_thinking=_optional_bool(thinking_value),
        source=str(selected_path),
    )


def _chat_completions_url(base_url: str) -> str:
    normalized = base_url.rstrip("/")
    if normalized.endswith("/chat/completions"):
        return normalized
    return f"{normalized}/chat/completions"


class OpenAICompatibleChatClient:
    """Small HTTP client for `/chat/completions` compatible providers."""

    def __init__(self, config: LLMConfig) -> None:
        self.config = config

    def chat(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str:
        return self._chat_request(
            messages,
            max_tokens=max_tokens,
            temperature=temperature,
            response_format=None,
        )

    def chat_json(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str:
        """Prefer provider-enforced JSON and fall back when unsupported."""

        try:
            return self._chat_request(
                messages,
                max_tokens=max_tokens,
                temperature=temperature,
                response_format={"type": "json_object"},
            )
        except LLMError as exc:
            message = str(exc).lower()
            if not any(
                marker in message
                for marker in ("response_format", "json_object", "unsupported", "400")
            ):
                raise
            return self._chat_request(
                messages,
                max_tokens=max_tokens,
                temperature=temperature,
                response_format=None,
            )

    def _chat_request(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int | None,
        temperature: float | None,
        response_format: dict[str, str] | None,
    ) -> str:
        payload = {
            "model": self.config.model_name,
            "messages": messages,
            "temperature": self.config.temperature if temperature is None else temperature,
            "max_tokens": self.config.max_tokens if max_tokens is None else max_tokens,
        }
        if response_format is not None:
            payload["response_format"] = response_format
        if self.config.chat_template_enable_thinking is not None:
            payload["chat_template_kwargs"] = {
                "enable_thinking": self.config.chat_template_enable_thinking,
            }
        request = urllib.request.Request(
            _chat_completions_url(self.config.base_url),
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.config.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(
                request, timeout=self.config.timeout_seconds
            ) as response:
                data = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
            raise LLMError(f"LLM request failed with HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise LLMError(f"LLM request failed: {exc.reason}") from exc
        except TimeoutError as exc:
            raise LLMError("LLM request timed out.") from exc

        try:
            choice = data["choices"][0]
            message = choice.get("message") or {}
            content = message.get("content") or choice.get("text") or ""
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMError("LLM response did not contain a chat completion.") from exc

        if isinstance(content, list):
            content = "\n".join(
                str(item.get("text", item)) if isinstance(item, dict) else str(item)
                for item in content
            )
        text = str(content).strip()
        if not text:
            raise LLMError("LLM response was empty.")
        return text
