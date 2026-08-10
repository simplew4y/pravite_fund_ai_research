"""Token-bound local LLM gateway for private-fund runners."""

from __future__ import annotations

import json
import os
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import jwt
from fastapi import APIRouter, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, StreamingResponse

from omnigent.server.user_llm_config_store import UserLlmConfig, UserLlmConfigStore
from omnigent.server.user_model_routing_store import UserModelRoutingStore

TOKEN_AUDIENCE = "omnigent-private-fund-llm"
PLATFORM_MAX_OUTPUT_TOKENS = 32000
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")


def _signing_key() -> str:
    value = os.environ.get("OMNIGENT_USER_SECRETS_KEY", "").strip()
    if not value:
        raise RuntimeError("OMNIGENT_USER_SECRETS_KEY is required")
    return value


def issue_user_llm_token(user_id: str, session_id: str, ttl_seconds: int = 86400) -> str:
    now = int(time.time())
    return jwt.encode(
        {
            "sub": user_id,
            "sid": session_id,
            "aud": TOKEN_AUDIENCE,
            "iat": now,
            "exp": now + ttl_seconds,
        },
        _signing_key(),
        algorithm="HS256",
    )


def _extract_token(request: Request) -> str:
    authorization = request.headers.get("authorization", "")
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return request.headers.get("x-api-key", "").strip()


def _decode_user(request: Request) -> str:
    token = _extract_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="missing runner model token")
    try:
        claims = jwt.decode(
            token,
            _signing_key(),
            algorithms=["HS256"],
            audience=TOKEN_AUDIENCE,
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="invalid runner model token") from exc
    user_id = str(claims.get("sub") or "")
    if not user_id:
        raise HTTPException(status_code=401, detail="invalid runner model token")
    return user_id


def _target_model(config: UserLlmConfig) -> str:
    return config.model if "/" in config.model else f"{config.provider}/{config.model}"


@dataclass(frozen=True)
class _ModelTarget:
    source: str
    model: str
    api_base: str
    api_key: str
    max_output_tokens: int | None = None


def _normalize_payload(payload: dict[str, Any], target: _ModelTarget) -> None:
    """Apply provider limits without changing BYOK request semantics."""
    limit = target.max_output_tokens
    if limit is None:
        return
    for key in ("max_tokens", "max_completion_tokens"):
        value = payload.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value > limit:
            payload[key] = limit


def _provider_error_status(exc: Exception, source: str) -> tuple[int, str]:
    raw_status = getattr(exc, "status_code", None)
    try:
        status = int(raw_status)
    except (TypeError, ValueError):
        status = 502
    if source != "platform":
        return 502, "自有 API 调用失败"
    if status == 402:
        return 402, "当前可用额度不足，请等待正在进行的模型请求完成或补充余额。"
    if status == 429:
        return 429, "平台模型当前请求较多，请稍后再试。"
    if status in {401, 403}:
        return 401, "平台模型访问凭证已失效，请重新登录后再试。"
    if status in {502, 503, 504}:
        return 503, "平台模型服务暂时不可用，请稍后再试。"
    return 502, "平台模型调用失败"


def _dump(value: Any) -> dict[str, Any]:
    if hasattr(value, "model_dump"):
        return value.model_dump(exclude_none=True)
    if isinstance(value, dict):
        return value
    return jsonable_encoder(value)


def _install_anthropic_usage_only_chunk_compatibility() -> None:
    """Teach LiteLLM's Anthropic adapter about empty-choices usage chunks."""
    from litellm.llms.anthropic.experimental_pass_through.adapters.streaming_iterator import (
        AnthropicStreamWrapper,
    )
    from litellm.types.utils import Delta, StreamingChoices

    if getattr(AnthropicStreamWrapper, "_omnigent_usage_chunk_compatible", False):
        return
    original = AnthropicStreamWrapper._should_start_new_content_block

    def compatible_should_start(self: Any, chunk: Any) -> bool:
        choices = getattr(chunk, "choices", None)
        usage = getattr(chunk, "usage", None)
        if choices == [] and usage is not None:
            chunk.choices = [StreamingChoices(delta=Delta())]
        return original(self, chunk)

    AnthropicStreamWrapper._should_start_new_content_block = compatible_should_start
    AnthropicStreamWrapper._omnigent_usage_chunk_compatible = True


def _require_config(store: UserLlmConfigStore, user_id: str) -> UserLlmConfig:
    config = store.get(user_id)
    if config is None or not config.configured:
        raise HTTPException(status_code=409, detail="model service is not configured")
    return config


def create_user_llm_gateway_router(storage_location: str) -> APIRouter:
    router = APIRouter()
    store: UserLlmConfigStore | None = None
    routing_store: UserModelRoutingStore | None = None

    def config_store() -> UserLlmConfigStore:
        nonlocal store
        if store is None:
            store = UserLlmConfigStore(storage_location)
        return store

    def model_routing_store() -> UserModelRoutingStore:
        nonlocal routing_store
        if routing_store is None:
            routing_store = UserModelRoutingStore(storage_location)
        return routing_store

    def resolve_target(user_id: str) -> _ModelTarget:
        config = config_store().get(user_id)
        byok_configured = config is not None and config.configured
        routing = model_routing_store().get(
            user_id,
            byok_configured=byok_configured,
        )
        if routing.source == "platform":
            if not routing.platform_token_valid():
                raise HTTPException(
                    status_code=409,
                    detail="平台模型访问凭证缺失或已过期，请重新准备模型服务。",
                )
            return _ModelTarget(
                source="platform",
                # The cloud gateway exposes Chat Completions, not OpenAI's
                # Responses API. ``custom_openai`` keeps LiteLLM's Anthropic
                # message/tool conversion while routing to /chat/completions.
                model="custom_openai/private-fund-default",
                api_base=routing.platform_gateway_base_url,
                api_key=routing.platform_token,
                max_output_tokens=PLATFORM_MAX_OUTPUT_TOKENS,
            )
        config = _require_config(config_store(), user_id)
        return _ModelTarget(
            source="byok",
            model=_target_model(config),
            api_base=config.base_url,
            api_key=config.api_key,
        )

    def provider_error(exc: Exception, target: _ModelTarget) -> HTTPException:
        status, summary = _provider_error_status(exc, target.source)
        sanitized = str(exc).replace(target.api_key, "[redacted]")
        return HTTPException(
            status_code=status,
            detail=f"{summary}: {sanitized[:800]}",
        )

    @router.post("/v1/messages", response_model=None)
    async def anthropic_messages(request: Request) -> JSONResponse | StreamingResponse:
        user_id = _decode_user(request)
        target = resolve_target(user_id)
        payload = await request.json()
        payload.pop("model", None)
        _normalize_payload(payload, target)
        stream = bool(payload.get("stream"))
        try:
            import litellm

            _install_anthropic_usage_only_chunk_compatibility()
            result = await litellm.anthropic_messages(
                model=target.model,
                api_base=target.api_base,
                api_key=target.api_key,
                **payload,
            )
        except Exception as exc:
            raise provider_error(exc, target) from exc
        if not stream:
            return JSONResponse(_dump(result))

        async def events() -> AsyncIterator[bytes]:
            async for chunk in result:
                if isinstance(chunk, bytes):
                    yield chunk
                    continue
                if isinstance(chunk, str):
                    yield chunk.encode()
                    continue
                data = _dump(chunk)
                event_name = str(data.get("type") or "message")
                serialized = json.dumps(data, ensure_ascii=False)
                yield f"event: {event_name}\ndata: {serialized}\n\n".encode()

        return StreamingResponse(events(), media_type="text/event-stream")

    @router.post("/v1/chat/completions", response_model=None)
    async def chat_completions(request: Request) -> JSONResponse | StreamingResponse:
        user_id = _decode_user(request)
        target = resolve_target(user_id)
        payload = await request.json()
        payload.pop("model", None)
        _normalize_payload(payload, target)
        thinking = payload.pop("thinking", None)
        if thinking is not None:
            extra_body = payload.get("extra_body")
            payload["extra_body"] = {
                **(extra_body if isinstance(extra_body, dict) else {}),
                "thinking": thinking,
            }
        stream = bool(payload.get("stream"))
        try:
            import litellm

            result = await litellm.acompletion(
                model=target.model,
                api_base=target.api_base,
                api_key=target.api_key,
                **payload,
            )
        except Exception as exc:
            raise provider_error(exc, target) from exc
        if not stream:
            return JSONResponse(_dump(result))

        async def events() -> AsyncIterator[bytes]:
            async for chunk in result:
                yield f"data: {json.dumps(_dump(chunk), ensure_ascii=False)}\n\n".encode()
            yield b"data: [DONE]\n\n"

        return StreamingResponse(events(), media_type="text/event-stream")

    return router
