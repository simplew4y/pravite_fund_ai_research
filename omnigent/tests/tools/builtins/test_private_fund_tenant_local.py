from __future__ import annotations

import asyncio

from fastapi import Request

from omnigent.server.private_fund_tenant import tenant_scope_dependency


def test_local_single_user_does_not_require_account_store() -> None:
    class LocalProvider:
        def get_user_id(self, _request):
            return "local"

    async def invoke_dependency():
        dependency = tenant_scope_dependency(LocalProvider(), None)
        request = Request({"type": "http", "method": "GET", "path": "/", "headers": []})
        generator = dependency(request)
        try:
            return await anext(generator)
        finally:
            await generator.aclose()

    assert asyncio.run(invoke_dependency()) is None
