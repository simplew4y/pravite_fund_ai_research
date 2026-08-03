"""Authenticated HTTP routes for user-managed Agent Skills."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from omnigent.server import skill_marketplace as service
from omnigent.server.auth import AuthProvider
from omnigent.server.private_fund_tenant import build_tenant_context
from omnigent.server.routes._auth_helpers import require_user


class InstallSkillRequest(BaseModel):
    marketplaceId: str = Field(min_length=1, max_length=500)


def create_skill_marketplace_router(
    *,
    auth_provider: AuthProvider | None = None,
    account_store: Any | None = None,
    marketplace_client: service.SkillsMarketplaceClient | None = None,
    single_user_skills_root: Path | None = None,
) -> APIRouter:
    """Create marketplace/search/install routes scoped to the current user."""

    router = APIRouter()
    client = marketplace_client or service.SkillsMarketplaceClient()
    operation_locks: dict[str, asyncio.Lock] = {}

    async def skills_root(request: Request) -> Path:
        user_id = require_user(request, auth_provider)
        if user_id is not None:
            if account_store is None:
                raise HTTPException(status_code=503, detail="用户技能存储暂不可用。")
            tenant = await asyncio.to_thread(build_tenant_context, user_id, account_store)
            return tenant.user_root / ".agents" / "skills"
        return single_user_skills_root or (Path.home() / ".agents" / "skills")

    def convert_error(error: service.SkillMarketplaceError) -> HTTPException:
        return HTTPException(
            status_code=error.status_code,
            detail={"code": error.code, "message": str(error)},
        )

    def root_key(root: Path) -> str:
        return str(root.expanduser().resolve())

    @router.get("/skills/marketplace")
    async def search_marketplace(
        request: Request,
        q: str = Query(default="financial analysis", min_length=2, max_length=200),
        page: int = Query(default=1, ge=1, le=100),
        limit: int = Query(default=12, ge=1, le=24),
        language: str | None = Query(default=None, min_length=2, max_length=3),
    ) -> dict[str, Any]:
        root = await skills_root(request)
        result = await client.search(q, page=page, limit=limit, language=language)
        installed = await asyncio.to_thread(service.list_installed_skills, root)
        installed_ids = {
            entry["marketplaceId"] for entry in installed if entry.get("marketplaceId")
        }
        installed_sources = {entry["githubUrl"] for entry in installed if entry.get("githubUrl")}
        for item in result["skills"]:
            item["installed"] = (
                item["id"] in installed_ids or item["githubUrl"] in installed_sources
            )
        result["query"] = q
        result["effectiveQuery"] = service.normalized_marketplace_query(q)
        return result

    @router.get("/skills/installed")
    async def list_installed(request: Request) -> dict[str, Any]:
        root = await skills_root(request)
        installed = await asyncio.to_thread(service.list_installed_skills, root)
        return {"skills": installed, "count": len(installed), "scope": "user"}

    @router.post("/skills/install", status_code=201)
    async def install_skill(request: Request, body: InstallSkillRequest) -> dict[str, Any]:
        root = await skills_root(request)
        item = client.catalog_item(body.marketplaceId)
        if item is None:
            raise HTTPException(
                status_code=404,
                detail={
                    "code": "catalog_item_not_found",
                    "message": "技能市场条目已过期，请重新搜索后再安装。",
                },
            )
        lock = operation_locks.setdefault(root_key(root), asyncio.Lock())
        async with lock:
            try:
                installed = await service.install_marketplace_skill(item, root)
            except service.SkillMarketplaceError as error:
                raise convert_error(error) from error
        return {"skill": installed, "restartRequired": False, "newSessionRecommended": True}

    @router.delete("/skills/installed/{install_id}")
    async def remove_skill(request: Request, install_id: str) -> dict[str, str]:
        root = await skills_root(request)
        lock = operation_locks.setdefault(root_key(root), asyncio.Lock())
        async with lock:
            try:
                return await asyncio.to_thread(service.uninstall_skill, root, install_id)
            except service.SkillMarketplaceError as error:
                raise convert_error(error) from error

    return router
