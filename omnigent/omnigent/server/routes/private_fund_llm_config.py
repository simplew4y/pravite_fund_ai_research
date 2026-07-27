"""HTTP API for the private-fund workbench model configuration."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

from omnigent.server import private_fund_llm_config as service
from omnigent.server.auth import AuthProvider
from omnigent.server.routes._auth_helpers import require_user
from omnigent.server.user_llm_config_store import UserLlmConfig, UserLlmConfigStore


class LlmConfigInput(BaseModel):
    preset: str
    baseUrl: str
    model: str
    apiKey: str | None = None


def create_private_fund_llm_config_router(
    *,
    auth_provider: AuthProvider | None = None,
    has_running_sessions: Callable[[], bool] | None = None,
    account_store: Any | None = None,
) -> APIRouter:
    router = APIRouter()
    user_store: UserLlmConfigStore | None = None
    apply_locks: dict[str, asyncio.Lock] = {}
    apply_details: dict[str, str] = {}

    def get_user_store() -> UserLlmConfigStore | None:
        nonlocal user_store
        if auth_provider is None or account_store is None:
            return None
        if user_store is None:
            user_store = UserLlmConfigStore(account_store.storage_location)
        return user_store

    def authenticate(request: Request) -> str | None:
        return require_user(request, auth_provider)

    def current_config(user_id: str | None) -> service.RuntimeLlmConfig:
        selected_store = get_user_store()
        if selected_store is None or user_id is None:
            return service.runtime_config()
        stored = selected_store.get(user_id)
        if stored is None:
            return service.RuntimeLlmConfig(
                preset="custom",
                provider="custom_openai",
                base_url="",
                model="",
                api_key="",
            )
        return service.RuntimeLlmConfig(
            preset=stored.preset,
            provider=stored.provider,
            base_url=stored.base_url,
            model=stored.model,
            api_key=stored.api_key,
        )

    def public_config(user_id: str | None) -> dict[str, Any]:
        config = current_config(user_id)
        return {
            "preset": config.preset,
            "provider": config.provider,
            "baseUrl": config.base_url or service.PRESETS[config.preset]["base_url"],
            "model": config.model,
            "hasApiKey": bool(config.api_key),
            "maskedApiKey": service.mask_api_key(config.api_key),
            "configured": config.configured,
        }

    def apply_key(user_id: str | None) -> str:
        return user_id or "__legacy__"

    def activity(user_id: str | None) -> dict[str, Any]:
        key = apply_key(user_id)
        lock = apply_locks.get(key)
        applying = lock.locked() if lock is not None else False
        running = bool(
            get_user_store() is None
            and has_running_sessions
            and has_running_sessions()
        )
        detail = apply_details.get(key)
        if running and not applying:
            detail = "当前有回答正在生成，请等待完成后修改。"
        return {"busy": applying or running, "applying": applying, "detail": detail}

    @router.get("/private-fund/llm-config")
    async def get_config(request: Request) -> dict[str, Any]:
        user_id = authenticate(request)
        return public_config(user_id)

    @router.get("/private-fund/llm-config/status")
    async def get_status(request: Request) -> dict[str, Any]:
        user_id = authenticate(request)
        return activity(user_id)

    @router.post("/private-fund/llm-config/test")
    async def test_config(request: Request, payload: LlmConfigInput) -> dict[str, Any]:
        user_id = authenticate(request)
        try:
            candidate = service.validate_candidate(payload.model_dump(), current_config(user_id))
        except ValueError as error:
            return {"ok": False, "error": "validation", "detail": str(error)}
        return await service.test_upstream_config(candidate)

    @router.put("/private-fund/llm-config")
    async def save_config(request: Request, payload: LlmConfigInput) -> dict[str, Any]:
        user_id = authenticate(request)
        key = apply_key(user_id)
        apply_lock = apply_locks.setdefault(key, asyncio.Lock())
        current_activity = activity(user_id)
        if current_activity["busy"]:
            return {
                "ok": False,
                "error": "busy",
                "detail": current_activity.get("detail") or "模型配置正在应用，请稍候。",
            }
        async with apply_lock:
            apply_details[key] = "正在验证模型服务。"
            current = current_config(user_id)
            try:
                candidate = service.validate_candidate(payload.model_dump(), current)
            except ValueError as error:
                apply_details.pop(key, None)
                return {"ok": False, "error": "validation", "detail": str(error)}
            tested = await service.test_upstream_config(candidate)
            if not tested.get("ok"):
                apply_details.pop(key, None)
                return tested

            selected_store = get_user_store()
            if selected_store is not None and user_id is not None:
                selected_store.save(
                    user_id,
                    UserLlmConfig(
                        preset=candidate.preset,
                        provider=candidate.provider,
                        base_url=candidate.base_url,
                        model=candidate.model,
                        api_key=candidate.api_key,
                    ),
                )
                apply_details.pop(key, None)
                return {"ok": True, "config": public_config(user_id)}

            config_path = service.config_path()
            generated_path = service.generated_litellm_path()
            config_snapshot = service.snapshot_file(config_path)
            generated_snapshot = service.snapshot_file(generated_path)
            try:
                apply_details[key] = "正在应用模型配置。"
                service.save_runtime_config(candidate, config_path)
                revision = service.write_generated_litellm_config(candidate, path=generated_path)
                applied = await service.wait_for_litellm_revision(revision)
                if not applied.get("ok"):
                    raise RuntimeError(str(applied.get("detail") or "模型配置应用失败。"))
                return {"ok": True, "config": public_config(user_id)}
            except Exception as error:  # noqa: BLE001
                service.restore_file(config_path, config_snapshot)
                service.restore_file(generated_path, generated_snapshot)
                if current.configured:
                    await service.wait_for_litellm_revision(
                        service.config_revision_alias(current),
                        timeout_seconds=15.0,
                    )
                return {
                    "ok": False,
                    "error": "apply",
                    "detail": f"模型配置应用失败，已恢复原配置：{str(error)[:500]}",
                }
            finally:
                apply_details.pop(key, None)

    return router
