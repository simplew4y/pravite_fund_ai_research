"""Authenticated tenant context for private-fund data access."""

from __future__ import annotations

import contextvars
import os
from collections.abc import AsyncIterator, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import Request

from omnigent.server.auth import AuthProvider
from omnigent.server.routes._auth_helpers import require_user


@dataclass(frozen=True)
class PrivateFundTenantContext:
    user_id: str
    data_namespace: str
    user_root: Path
    dataset_root: Path
    knowledge_base_root: Path
    cache_root: Path


_current_tenant: contextvars.ContextVar[PrivateFundTenantContext | None] = (
    contextvars.ContextVar("private_fund_tenant", default=None)
)


def project_root() -> Path:
    return Path(__file__).resolve().parents[3]


def user_data_root() -> Path:
    """Return the configured root that owns all per-user workbench data."""
    configured = os.environ.get("PRIVATE_FUND_USER_DATA_ROOT", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return (project_root() / "output" / "users").resolve()


def current_tenant() -> PrivateFundTenantContext | None:
    return _current_tenant.get()


def current_dataset_root(fallback: Path) -> Path:
    tenant = current_tenant()
    return tenant.dataset_root if tenant is not None else fallback


def build_tenant_context(user_id: str, account_store: Any) -> PrivateFundTenantContext:
    namespace = account_store.get_or_create_data_namespace(user_id)
    return build_tenant_context_from_namespace(user_id, namespace)


def build_tenant_context_from_namespace(
    user_id: str,
    namespace: str,
) -> PrivateFundTenantContext:
    user_root = (user_data_root() / namespace).resolve()
    dataset_root = user_root / "private_fund_datasets"
    knowledge_base_root = user_root / "knowledge_base"
    cache_root = user_root / "cache"
    for path in (dataset_root, knowledge_base_root, cache_root):
        path.mkdir(parents=True, exist_ok=True)
    return PrivateFundTenantContext(
        user_id=user_id,
        data_namespace=namespace,
        user_root=user_root,
        dataset_root=dataset_root,
        knowledge_base_root=knowledge_base_root,
        cache_root=cache_root,
    )


def tenant_job_payload() -> dict[str, str] | None:
    tenant = current_tenant()
    if tenant is None:
        return None
    return {
        "user_id": tenant.user_id,
        "data_namespace": tenant.data_namespace,
    }


@contextmanager
def bind_tenant_job_payload(payload: dict[str, Any]) -> Iterator[None]:
    tenant_payload = payload.get("_tenant")
    if not isinstance(tenant_payload, dict):
        yield
        return
    user_id = tenant_payload.get("user_id")
    namespace = tenant_payload.get("data_namespace")
    if not isinstance(user_id, str) or not isinstance(namespace, str):
        raise RuntimeError("invalid private-fund tenant job payload")
    tenant = build_tenant_context_from_namespace(user_id, namespace)
    token = _current_tenant.set(tenant)
    try:
        yield
    finally:
        _current_tenant.reset(token)


@contextmanager
def bind_tenant_namespace(data_namespace: str) -> Iterator[PrivateFundTenantContext]:
    """Bind a background worker to one validated user namespace."""
    namespace = str(data_namespace)
    tenant = build_tenant_context_from_namespace(f"worker:{namespace}", namespace)
    token = _current_tenant.set(tenant)
    try:
        yield tenant
    finally:
        _current_tenant.reset(token)


def tenant_scope_dependency(
    auth_provider: AuthProvider | None,
    account_store: Any | None,
):
    async def bind(request: Request) -> AsyncIterator[PrivateFundTenantContext | None]:
        user_id = require_user(request, auth_provider)
        if user_id is None:
            yield None
            return
        if account_store is None:
            raise RuntimeError("Private-fund multi-user mode requires an account store")
        tenant = build_tenant_context(user_id, account_store)
        token = _current_tenant.set(tenant)
        request.state.private_fund_tenant = tenant
        try:
            yield tenant
        finally:
            _current_tenant.reset(token)

    return bind
