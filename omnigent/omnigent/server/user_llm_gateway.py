"""Token-bound local LLM gateway for private-fund runners."""

from __future__ import annotations

import json
import os
import time
from collections.abc import AsyncIterator
from typing import Any

import jwt
from fastapi import APIRouter, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, StreamingResponse

from omnigent.server.user_llm_config_store import UserLlmConfig, UserLlmConfigStore

TOKEN_AUDIENCE = "omnigent-private-fund-llm"
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

    def config_store() -> UserLlmConfigStore:
        nonlocal store
        if store is None:
            store = UserLlmConfigStore(storage_location)
        return store

    @router.post("/v1/messages", response_model=None)
    async def anthropic_messages(request: Request) -> JSONResponse | StreamingResponse:
        user_id = _decode_user(request)
        config = _require_config(config_store(), user_id)
        payload = await request.json()
        payload.pop("model", None)
        stream = bool(payload.get("stream"))
        try:
            import litellm

            _install_anthropic_usage_only_chunk_compatibility()
            result = await litellm.anthropic_messages(
                model=_target_model(config),
                api_base=config.base_url,
                api_key=config.api_key,
                **payload,
            )
        except Exception as exc:
            detail = str(exc).replace(config.api_key, "[redacted]")
            raise HTTPException(status_code=502, detail=detail[:1000]) from exc
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
        config = _require_config(config_store(), user_id)
        payload = await request.json()
        payload.pop("model", None)
        stream = bool(payload.get("stream"))
        try:
            import litellm

            result = await litellm.acompletion(
                model=_target_model(config),
                api_base=config.base_url,
                api_key=config.api_key,
                **payload,
            )
        except Exception as exc:
            detail = str(exc).replace(config.api_key, "[redacted]")
            raise HTTPException(status_code=502, detail=detail[:1000]) from exc
        if not stream:
            return JSONResponse(_dump(result))

        async def events() -> AsyncIterator[bytes]:
            async for chunk in result:
                yield f"data: {json.dumps(_dump(chunk), ensure_ascii=False)}\n\n".encode()
            yield b"data: [DONE]\n\n"

        return StreamingResponse(events(), media_type="text/event-stream")

    return router
