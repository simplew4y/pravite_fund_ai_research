"""Private-fund model configuration shared by the API and dev launcher."""

from __future__ import annotations

import asyncio
import hashlib
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
import yaml

LOCAL_MODEL_ALIAS = "private-fund-default"
LOCAL_GATEWAY_KEY = "sk-local-cc-haha"

PRESETS: dict[str, dict[str, str]] = {
    "dashscope": {
        "provider": "dashscope",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    },
    "deepseek": {
        "provider": "deepseek",
        "base_url": "https://api.deepseek.com/v1",
    },
    "openai": {
        "provider": "openai",
        "base_url": "https://api.openai.com/v1",
    },
    "anthropic": {
        "provider": "anthropic",
        "base_url": "https://api.anthropic.com",
    },
    "custom": {"provider": "custom_openai", "base_url": ""},
}


@dataclass(frozen=True)
class RuntimeLlmConfig:
    preset: str
    provider: str
    base_url: str
    model: str
    api_key: str

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.model and self.api_key)


def project_root() -> Path:
    override = os.environ.get("PRIVATE_FUND_PROJECT_ROOT", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return Path(__file__).resolve().parents[3]


def config_path() -> Path:
    override = os.environ.get("FINSAGENT_CONFIG", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return project_root() / "FinSagent/config/production.yaml"


def generated_litellm_path() -> Path:
    override = os.environ.get("LITELLM_CONFIG", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return project_root() / "omnigent/.tmp-litellm-runtime/config.yaml"


def _load_yaml(path: Path | None = None) -> dict[str, Any]:
    selected = path or config_path()
    if not selected.exists():
        return {}
    value = yaml.safe_load(selected.read_text(encoding="utf-8")) or {}
    return value if isinstance(value, dict) else {}


def infer_preset(base_url: str, explicit: str = "") -> str:
    if explicit in PRESETS:
        return explicit
    host = (urlparse(base_url).hostname or "").lower()
    if "dashscope" in host:
        return "dashscope"
    if "deepseek" in host:
        return "deepseek"
    if host == "api.openai.com":
        return "openai"
    if host == "api.anthropic.com":
        return "anthropic"
    return "custom"


def mask_api_key(value: str) -> str:
    key = value.strip()
    if not key:
        return ""
    if len(key) <= 8:
        return f"{key[:2]}*****************{key[-1:]}"
    return f"{key[:6]}*****************{key[-2:]}"


def normalize_base_url(base_url: str, preset: str) -> str:
    normalized = base_url.strip().rstrip("/")
    if preset == "anthropic":
        if normalized.endswith("/v1/messages"):
            return normalized[: -len("/v1/messages")]
        return normalized
    for suffix in ("/chat/completions", "/models"):
        if normalized.endswith(suffix):
            return normalized[: -len(suffix)]
    return normalized


def runtime_config(data: dict[str, Any] | None = None) -> RuntimeLlmConfig:
    source = data if data is not None else _load_yaml()
    raw_base_url = str(source.get("llm_base_url") or "").strip()
    inferred_preset = infer_preset(
        raw_base_url,
        str(source.get("llm_provider_preset") or "").strip(),
    )
    base_url = normalize_base_url(raw_base_url, inferred_preset)
    preset = inferred_preset
    provider = str(source.get("llm_provider") or PRESETS[preset]["provider"]).strip()
    if preset != "custom":
        provider = PRESETS[preset]["provider"]
    return RuntimeLlmConfig(
        preset=preset,
        provider=provider or "custom_openai",
        base_url=base_url,
        model=str(source.get("llm_model_name") or "").strip(),
        api_key=str(source.get("llm_api_key") or "").strip(),
    )


def public_config(data: dict[str, Any] | None = None) -> dict[str, Any]:
    config = runtime_config(data)
    return {
        "preset": config.preset,
        "provider": config.provider,
        "baseUrl": config.base_url or PRESETS[config.preset]["base_url"],
        "model": config.model,
        "hasApiKey": bool(config.api_key),
        "maskedApiKey": mask_api_key(config.api_key),
        "configured": config.configured,
    }


def validate_candidate(
    input_data: dict[str, Any], current: RuntimeLlmConfig | None = None
) -> RuntimeLlmConfig:
    preset = str(input_data.get("preset") or "").strip()
    if preset not in PRESETS:
        raise ValueError("Unsupported model provider.")
    model = str(input_data.get("model") or "").strip()
    if not model:
        raise ValueError("Model name is required.")
    base_url = normalize_base_url(
        str(input_data.get("baseUrl") or PRESETS[preset]["base_url"]),
        preset,
    )
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Base URL must be a valid HTTP or HTTPS URL.")
    supplied_key = str(input_data.get("apiKey") or "").strip()
    api_key = supplied_key or (current.api_key if current else "")
    if not api_key:
        raise ValueError("API Key is required.")
    return RuntimeLlmConfig(
        preset=preset,
        provider=PRESETS[preset]["provider"],
        base_url=base_url,
        model=model,
        api_key=api_key,
    )


def _atomic_write(path: Path, content: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
        os.chmod(path, mode)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def save_runtime_config(config: RuntimeLlmConfig, path: Path | None = None) -> dict[str, Any]:
    selected = path or config_path()
    data = _load_yaml(selected)
    data.update(
        {
            "llm_model_name": config.model,
            "llm_api_key": config.api_key,
            "llm_base_url": config.base_url,
            "llm_provider_preset": config.preset,
            "llm_provider": config.provider,
        }
    )
    rendered = yaml.safe_dump(data, allow_unicode=True, sort_keys=False)
    _atomic_write(selected, rendered)
    return data


def config_revision_alias(config: RuntimeLlmConfig) -> str:
    material = "\0".join((config.provider, config.base_url, config.model, config.api_key))
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()[:12]
    return f"private-fund-config-{digest}"


def render_litellm_config(
    config: RuntimeLlmConfig,
    *,
    source_data: dict[str, Any] | None = None,
) -> tuple[str, str]:
    effective = config
    if not effective.configured:
        effective = RuntimeLlmConfig(
            preset="custom",
            provider="openai",
            base_url="http://127.0.0.1:9/v1",
            model="not-configured",
            api_key="not-configured",
        )
    # LiteLLM's native `openai` provider may switch thinking/Agent turns to
    # the Responses API. Generic compatible gateways commonly implement only
    # Chat Completions, so preserve `custom_openai` to keep that protocol.
    target_model = (
        effective.model if "/" in effective.model else f"{effective.provider}/{effective.model}"
    )
    revision_alias = config_revision_alias(effective)
    exposed_names = list(
        dict.fromkeys(
            [
                LOCAL_MODEL_ALIAS,
                revision_alias,
                effective.model,
                "qwen3-max",
                "claude-sonnet-4-6",
                "claude-sonnet-4-5",
                "claude-opus-4-6",
                "claude-opus-4-7",
                "claude-opus-4-8",
                "claude-haiku-4-6",
                "claude-haiku-4-5",
                "claude-haiku-4-5-20251001",
            ]
        )
    )
    thinking = str((source_data or {}).get("llm_chat_template_enable_thinking") or "").lower()
    model_list: list[dict[str, Any]] = []
    for name in exposed_names:
        params: dict[str, Any] = {
            "model": target_model,
            "api_base": effective.base_url,
            "api_key": effective.api_key,
        }
        if thinking in {"0", "false", "no", "off"}:
            params["extra_body"] = {"chat_template_kwargs": {"enable_thinking": False}}
        model_list.append({"model_name": name, "litellm_params": params})
    content = yaml.safe_dump(
        {
            "model_list": model_list,
            "litellm_settings": {"drop_params": True, "request_timeout": 600},
        },
        allow_unicode=True,
        sort_keys=False,
    )
    return content, revision_alias


def write_generated_litellm_config(
    config: RuntimeLlmConfig | None = None,
    *,
    path: Path | None = None,
) -> str:
    selected_config_path = config_path()
    source_data = _load_yaml(selected_config_path)
    effective = config or runtime_config(source_data)
    content, revision_alias = render_litellm_config(effective, source_data=source_data)
    _atomic_write(path or generated_litellm_path(), content)
    return revision_alias


def _openai_chat_url(base_url: str) -> str:
    normalized = normalize_base_url(base_url, "custom")
    if normalized.endswith("/chat/completions"):
        return normalized
    return f"{normalized}/chat/completions"


def _anthropic_messages_url(base_url: str) -> str:
    normalized = base_url.rstrip("/")
    if normalized.endswith("/v1/messages"):
        return normalized
    if normalized.endswith("/v1"):
        return f"{normalized}/messages"
    return f"{normalized}/v1/messages"


def _error_result(error: Exception, api_key: str = "") -> dict[str, Any]:
    detail = str(error)
    if api_key:
        detail = detail.replace(api_key, "[redacted]")
    low = detail.lower()
    status = getattr(error, "response", None)
    status_code = getattr(status, "status_code", None)
    kind = "provider"
    if status_code in {401, 403} or any(
        marker in low for marker in ("unauthorized", "authentication", "invalid api key")
    ):
        kind = "authentication"
    elif status_code == 404 or (
        "model" in low
        and any(marker in low for marker in ("not found", "does not exist", "invalid"))
    ):
        kind = "model"
    elif isinstance(error, (httpx.ConnectError, httpx.NetworkError)) or any(
        marker in low for marker in ("connect", "network", "dns", "refused")
    ):
        kind = "connection"
    elif isinstance(error, httpx.TimeoutException) or "timeout" in low:
        kind = "timeout"
    return {"ok": False, "error": kind, "detail": detail[:600]}


async def test_upstream_config(config: RuntimeLlmConfig) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            if config.preset == "anthropic":
                response = await client.post(
                    _anthropic_messages_url(config.base_url),
                    headers={
                        "x-api-key": config.api_key,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                    },
                    json={
                        "model": config.model,
                        "max_tokens": 32,
                        "messages": [{"role": "user", "content": "Reply with OK only."}],
                    },
                )
                response.raise_for_status()
                data = response.json()
                text = "".join(
                    str(block.get("text") or "")
                    for block in data.get("content", [])
                    if isinstance(block, dict) and block.get("type") == "text"
                )
                if not text.strip():
                    raise RuntimeError("Model returned no visible text.")
                return {"ok": True}

            headers = {
                "Authorization": f"Bearer {config.api_key}",
                "Content-Type": "application/json",
            }
            url = _openai_chat_url(config.base_url)
            if config.preset != "custom":
                response = await client.post(
                    url,
                    headers=headers,
                    json={
                        "model": config.model,
                        "messages": [{"role": "user", "content": "Reply with OK only."}],
                        "max_tokens": 32,
                    },
                )
                response.raise_for_status()
                data = response.json()
                content = ((data.get("choices") or [{}])[0].get("message") or {}).get("content")
                if not isinstance(content, str) or not content.strip():
                    raise RuntimeError("Model returned no visible text.")
                return {"ok": True}

            tools = [
                {
                    "type": "function",
                    "function": {
                        "name": "connection_check",
                        "description": "Return the supplied value.",
                        "parameters": {
                            "type": "object",
                            "properties": {"value": {"type": "string"}},
                            "required": ["value"],
                        },
                    },
                }
            ]
            messages: list[dict[str, Any]] = [
                {
                    "role": "user",
                    "content": "Call connection_check with value OK, then answer with its result.",
                }
            ]
            first = await client.post(
                url,
                headers=headers,
                json={
                    "model": config.model,
                    "messages": messages,
                    "tools": tools,
                    "max_tokens": 256,
                },
            )
            first.raise_for_status()
            assistant = (first.json().get("choices") or [{}])[0].get("message") or {}
            tool_calls = assistant.get("tool_calls") or []
            if not tool_calls:
                raise RuntimeError(
                    "Model did not complete the Agent tool-call compatibility check."
                )
            messages.append(assistant)
            for call in tool_calls:
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.get("id"),
                        "content": "OK",
                    }
                )
            second = await client.post(
                url,
                headers=headers,
                json={
                    "model": config.model,
                    "messages": messages,
                    "tools": tools,
                    "max_tokens": 256,
                },
            )
            second.raise_for_status()
            content = ((second.json().get("choices") or [{}])[0].get("message") or {}).get(
                "content"
            )
            if not isinstance(content, str) or not content.strip():
                raise RuntimeError("Model returned no visible text after the tool call.")
            return {"ok": True}
    except Exception as error:  # noqa: BLE001
        return _error_result(error, config.api_key)


async def wait_for_litellm_revision(
    revision_alias: str,
    *,
    base_url: str | None = None,
    timeout_seconds: float = 45.0,
) -> dict[str, Any]:
    gateway = (base_url or os.environ.get("LITELLM_URL") or "http://127.0.0.1:4000").rstrip("/")
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    last_error = ""
    async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
        while asyncio.get_running_loop().time() < deadline:
            try:
                response = await client.post(
                    f"{gateway}/v1/messages?beta=true",
                    headers={
                        "x-api-key": LOCAL_GATEWAY_KEY,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                    },
                    json={
                        "model": revision_alias,
                        "max_tokens": 32,
                        "messages": [{"role": "user", "content": "Reply with OK only."}],
                    },
                )
                if response.is_success:
                    data = response.json()
                    content = "".join(
                        str(block.get("text") or "")
                        for block in data.get("content", [])
                        if isinstance(block, dict) and block.get("type") == "text"
                    )
                    if data.get("type") == "message" and content.strip():
                        return {"ok": True}
                last_error = f"HTTP {response.status_code}: {response.text[:300]}"
            except Exception as error:  # noqa: BLE001
                last_error = str(error)
            await asyncio.sleep(0.75)
    return {
        "ok": False,
        "error": "apply",
        "detail": f"LiteLLM did not apply the new model configuration: {last_error[:400]}",
    }


def snapshot_file(path: Path) -> tuple[bytes | None, int | None]:
    if not path.exists():
        return None, None
    return path.read_bytes(), path.stat().st_mode & 0o777


def restore_file(path: Path, snapshot: tuple[bytes | None, int | None]) -> None:
    content, mode = snapshot
    if content is None:
        path.unlink(missing_ok=True)
        return
    _atomic_write(path, content.decode("utf-8"), mode or 0o600)
