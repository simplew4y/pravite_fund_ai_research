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


class LlmConfigInput(BaseModel):
    preset: str
    baseUrl: str
    model: str
    apiKey: str | None = None


_apply_lock = asyncio.Lock()
_apply_detail: str | None = None


def create_private_fund_llm_config_router(
    *,
    auth_provider: AuthProvider | None = None,
    has_running_sessions: Callable[[], bool] | None = None,
) -> APIRouter:
    router = APIRouter()

    def authenticate(request: Request) -> None:
        require_user(request, auth_provider)

    def activity() -> dict[str, Any]:
        applying = _apply_lock.locked()
        running = bool(has_running_sessions and has_running_sessions())
        detail = _apply_detail
        if running and not applying:
            detail = "当前有回答正在生成，请等待完成后修改。"
        return {"busy": applying or running, "applying": applying, "detail": detail}

    @router.get("/private-fund/llm-config")
    async def get_config(request: Request) -> dict[str, Any]:
        authenticate(request)
        return service.public_config()

    @router.get("/private-fund/llm-config/status")
    async def get_status(request: Request) -> dict[str, Any]:
        authenticate(request)
        return activity()

    @router.post("/private-fund/llm-config/test")
    async def test_config(request: Request, payload: LlmConfigInput) -> dict[str, Any]:
        authenticate(request)
        try:
            candidate = service.validate_candidate(payload.model_dump(), service.runtime_config())
        except ValueError as error:
            return {"ok": False, "error": "validation", "detail": str(error)}
        return await service.test_upstream_config(candidate)

    @router.put("/private-fund/llm-config")
    async def save_config(request: Request, payload: LlmConfigInput) -> dict[str, Any]:
        global _apply_detail
        authenticate(request)
        current_activity = activity()
        if current_activity["busy"]:
            return {
                "ok": False,
                "error": "busy",
                "detail": current_activity.get("detail") or "模型配置正在应用，请稍候。",
            }
        async with _apply_lock:
            _apply_detail = "正在验证模型服务。"
            current = service.runtime_config()
            try:
                candidate = service.validate_candidate(payload.model_dump(), current)
            except ValueError as error:
                _apply_detail = None
                return {"ok": False, "error": "validation", "detail": str(error)}
            tested = await service.test_upstream_config(candidate)
            if not tested.get("ok"):
                _apply_detail = None
                return tested

            config_path = service.config_path()
            generated_path = service.generated_litellm_path()
            config_snapshot = service.snapshot_file(config_path)
            generated_snapshot = service.snapshot_file(generated_path)
            try:
                _apply_detail = "正在应用模型配置。"
                service.save_runtime_config(candidate, config_path)
                revision = service.write_generated_litellm_config(candidate, path=generated_path)
                applied = await service.wait_for_litellm_revision(revision)
                if not applied.get("ok"):
                    raise RuntimeError(str(applied.get("detail") or "模型配置应用失败。"))
                return {"ok": True, "config": service.public_config()}
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
                _apply_detail = None

    return router
