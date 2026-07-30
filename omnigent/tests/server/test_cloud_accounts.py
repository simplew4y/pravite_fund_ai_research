"""Cloud accounts BFF authentication and local identity isolation tests."""

from __future__ import annotations

import secrets
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from omnigent.db.utils import get_or_create_engine
from omnigent.server.accounts_config import AccountsConfig
from omnigent.server.accounts_store import SqlAlchemyAccountStore
from omnigent.server.auth import UnifiedAuthProvider
from omnigent.server.cloud_accounts_config import CloudAccountsConfig
from omnigent.server.routes.cloud_accounts import create_cloud_accounts_router


@pytest.fixture
def cloud_store(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> SqlAlchemyAccountStore:
    monkeypatch.setenv("OMNIGENT_USER_SECRETS_KEY", secrets.token_hex(32))
    db_url = f"sqlite:///{tmp_path}/cloud-accounts.db"
    get_or_create_engine(db_url)
    return SqlAlchemyAccountStore(db_url)


@pytest.fixture
def cloud_config() -> CloudAccountsConfig:
    return CloudAccountsConfig(
        accounts=AccountsConfig(
            cookie_secret=secrets.token_bytes(32),
            session_ttl_hours=8,
            base_url="http://127.0.0.1:6768",
            init_admin_password=None,
            invite_ttl_seconds=3600,
            magic_ttl_seconds=600,
        ),
        backend_url="https://cloud.example.test/private_fund/backend",
        request_timeout_seconds=10,
    )


def _user(*, is_admin: bool = True) -> dict[str, Any]:
    return {
        "id": "c7fd31fd-c47a-41d9-8f52-075c9f717edf",
        "email": "researcher@example.com",
        "nick_name": "Researcher",
        "status": "active",
        "is_admin": is_admin,
        "data_namespace": "450c7d39-96e0-4277-b6bf-c50a9c132b4d",
        "balance_cny": "12.500000",
        "last_login_at": None,
        "created_at": "2026-07-29T00:00:00+00:00",
    }


def _token_payload() -> dict[str, Any]:
    return {
        "access_token": "cloud-access-secret",
        "refresh_token": "cloud-refresh-secret-value-long-enough",
        "token_type": "bearer",
        "expires_in": 900,
        "user": _user(),
    }


def _app(
    config: CloudAccountsConfig,
    store: SqlAlchemyAccountStore,
) -> FastAPI:
    provider = UnifiedAuthProvider(
        source="cloud_accounts",
        accounts_config=config.accounts,
    )
    provider._cloud_accounts_config = config
    app = FastAPI()
    app.include_router(create_cloud_accounts_router(provider, store))
    return app


def _fake_async_client(
    handler: Callable[[str, str, dict[str, Any]], httpx.Response],
) -> type:
    class FakeAsyncClient:
        def __init__(self, **_: Any) -> None:
            pass

        async def __aenter__(self) -> FakeAsyncClient:
            return self

        async def __aexit__(self, *_: Any) -> None:
            return None

        async def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
            return handler(method, url, kwargs)

    return FakeAsyncClient


def test_cloud_login_keeps_tokens_out_of_frontend_and_local_db(
    monkeypatch: pytest.MonkeyPatch,
    cloud_config: CloudAccountsConfig,
    cloud_store: SqlAlchemyAccountStore,
) -> None:
    def handler(method: str, url: str, kwargs: dict[str, Any]) -> httpx.Response:
        assert method == "POST"
        assert url.endswith("/api/v1/auth/login")
        assert kwargs["json"] == {
            "email": "researcher@example.com",
            "password": "correct horse battery staple",
        }
        return httpx.Response(200, json=_token_payload())

    monkeypatch.setattr(httpx, "AsyncClient", _fake_async_client(handler))
    with TestClient(_app(cloud_config, cloud_store)) as client:
        response = client.post(
            "/auth/login",
            json={
                "email": "Researcher@Example.com",
                "password": "correct horse battery staple",
            },
        )

    assert response.status_code == 200
    response_text = response.text
    assert "access_token" not in response_text
    assert "refresh_token" not in response_text
    assert "cloud-access-secret" not in response_text
    assert "cloud-refresh-secret" not in response_text
    assert response.json()["user"]["is_platform_admin"] is True
    assert response.json()["user"]["is_admin"] is False
    assert response.headers["cache-control"] == "private, no-store"

    set_cookie = response.headers.get_list("set-cookie")
    assert any("ap_session=" in value and "HttpOnly" in value for value in set_cookie)
    encrypted = next(value for value in set_cookie if "pf_cloud_session=" in value)
    assert "cloud-access-secret" not in encrypted
    assert "cloud-refresh-secret" not in encrypted

    shadow = cloud_store.get_user(_user()["id"])
    assert shadow is not None
    assert shadow.data_namespace == _user()["data_namespace"]
    assert shadow.has_password is False
    assert shadow.is_admin is False


def test_cloud_profile_update_returns_public_user_and_keeps_tokens_server_side(
    monkeypatch: pytest.MonkeyPatch,
    cloud_config: CloudAccountsConfig,
    cloud_store: SqlAlchemyAccountStore,
) -> None:
    def handler(method: str, url: str, kwargs: dict[str, Any]) -> httpx.Response:
        if url.endswith("/api/v1/auth/login"):
            return httpx.Response(200, json=_token_payload())
        assert method == "PATCH"
        assert url.endswith("/api/v1/me/profile")
        assert kwargs["headers"]["authorization"] == "Bearer cloud-access-secret"
        assert kwargs["json"] == {"nick_name": "新昵称"}
        return httpx.Response(200, json={**_user(), "nick_name": "新昵称"})

    monkeypatch.setattr(httpx, "AsyncClient", _fake_async_client(handler))
    with TestClient(_app(cloud_config, cloud_store)) as client:
        logged_in = client.post(
            "/auth/login",
            json={"email": "researcher@example.com", "password": "password123"},
        )
        assert logged_in.status_code == 200
        updated = client.patch(
            "/auth/users/me/profile",
            json={"nick_name": "  新昵称  "},
        )

    assert updated.status_code == 200
    assert updated.json()["nick_name"] == "新昵称"
    assert updated.json()["email"] == "researcher@example.com"
    assert "cloud-access-secret" not in updated.text
    assert "cloud-refresh-secret" not in updated.text


def test_cloud_registration_proxies_code_and_creates_shadow_session(
    monkeypatch: pytest.MonkeyPatch,
    cloud_config: CloudAccountsConfig,
    cloud_store: SqlAlchemyAccountStore,
) -> None:
    calls: list[tuple[str, str, dict[str, Any]]] = []

    def handler(method: str, url: str, kwargs: dict[str, Any]) -> httpx.Response:
        calls.append((method, url, kwargs))
        if url.endswith("/api/v1/auth/register/send-code"):
            assert kwargs["json"] == {"email": "researcher@example.com"}
            return httpx.Response(
                202,
                json={"ok": True, "expires_in": 600, "resend_after": 60},
            )
        assert url.endswith("/api/v1/auth/register")
        assert kwargs["json"] == {
            "email": "researcher@example.com",
            "code": "0123",
            "password": "password123",
            "nick_name": "Researcher",
        }
        return httpx.Response(201, json=_token_payload())

    monkeypatch.setattr(httpx, "AsyncClient", _fake_async_client(handler))
    with TestClient(_app(cloud_config, cloud_store)) as client:
        code_response = client.post(
            "/auth/register/send-code",
            json={"email": "Researcher@Example.com"},
        )
        registered = client.post(
            "/auth/register",
            json={
                "email": "Researcher@Example.com",
                "code": "0123",
                "password": "password123",
                "nick_name": " Researcher ",
            },
        )

    assert code_response.status_code == 202
    assert code_response.json()["resend_after"] == 60
    assert registered.status_code == 201
    assert "access_token" not in registered.text
    assert "refresh_token" not in registered.text
    assert registered.json()["user"]["is_admin"] is False
    assert any("ap_session=" in value for value in registered.headers.get_list("set-cookie"))
    shadow = cloud_store.get_user(_user()["id"])
    assert shadow is not None
    assert shadow.data_namespace == _user()["data_namespace"]
    assert len(calls) == 2


def test_cloud_account_proxy_uses_bearer_without_exposing_it(
    monkeypatch: pytest.MonkeyPatch,
    cloud_config: CloudAccountsConfig,
    cloud_store: SqlAlchemyAccountStore,
) -> None:
    calls: list[tuple[str, str, dict[str, Any]]] = []

    def handler(method: str, url: str, kwargs: dict[str, Any]) -> httpx.Response:
        calls.append((method, url, kwargs))
        if url.endswith("/auth/login"):
            return httpx.Response(200, json=_token_payload())
        assert url.endswith("/api/v1/me/usage")
        assert kwargs["headers"]["authorization"] == "Bearer cloud-access-secret"
        return httpx.Response(
            200,
            json={
                "items": [],
                "summary": {
                    "request_count": 0,
                    "prompt_tokens": 0,
                    "completion_tokens": 0,
                    "total_tokens": 0,
                    "charged_amount_cny": "0.000000",
                },
                "page": 1,
                "page_size": 10,
            },
        )

    monkeypatch.setattr(httpx, "AsyncClient", _fake_async_client(handler))
    with TestClient(_app(cloud_config, cloud_store)) as client:
        login = client.post(
            "/auth/login",
            json={"email": _user()["email"], "password": "password123"},
        )
        assert login.status_code == 200
        usage = client.get("/v1/account/usage?page=1&page_size=10")

    assert usage.status_code == 200
    assert usage.json()["summary"]["total_tokens"] == 0
    assert "cloud-access-secret" not in usage.text
    assert len(calls) == 2


def test_platform_model_prepare_keeps_gateway_token_server_side(
    monkeypatch: pytest.MonkeyPatch,
    cloud_config: CloudAccountsConfig,
    cloud_store: SqlAlchemyAccountStore,
) -> None:
    monkeypatch.setenv("OMNIGENT_USER_SECRETS_KEY", secrets.token_hex(32))

    def handler(method: str, url: str, kwargs: dict[str, Any]) -> httpx.Response:
        if url.endswith("/auth/login"):
            return httpx.Response(200, json=_token_payload())
        assert kwargs["headers"]["authorization"] == "Bearer cloud-access-secret"
        if method == "GET" and url.endswith("/api/v1/me"):
            return httpx.Response(200, json=_user())
        if method == "GET" and url.endswith("/api/v1/models"):
            return httpx.Response(
                200,
                json={
                    "object": "list",
                    "available": True,
                    "default_model": "private-fund-default",
                    "data": [
                        {
                            "id": "private-fund-default",
                            "display_name": "Qwen3 Max",
                            "provider": "dashscope",
                            "input_price_cny_per_million": "3.200000",
                            "output_price_cny_per_million": "12.800000",
                        }
                    ],
                },
            )
        assert method == "POST"
        assert url.endswith("/api/v1/model-access-token")
        return httpx.Response(
            200,
            json={
                "access_token": "pfm_server-only-secret",
                "expires_in": 604800,
                "gateway_base_url": "https://cloud.example.test/gateway/v1",
            },
        )

    monkeypatch.setattr(httpx, "AsyncClient", _fake_async_client(handler))
    with TestClient(_app(cloud_config, cloud_store)) as client:
        assert (
            client.post(
                "/auth/login",
                json={"email": _user()["email"], "password": "password123"},
            ).status_code
            == 200
        )
        response = client.post("/v1/private-fund/model-service/prepare")

    assert response.status_code == 200
    assert response.json()["source"] == "platform"
    assert response.json()["ready"] is True
    assert response.json()["platform"]["models"][0]["displayName"] == "Qwen3 Max"
    assert response.json()["platform"]["balanceCny"] == "12.500000"
    assert "pfm_server-only-secret" not in response.text


def test_disabled_cloud_account_clears_both_session_cookies(
    monkeypatch: pytest.MonkeyPatch,
    cloud_config: CloudAccountsConfig,
    cloud_store: SqlAlchemyAccountStore,
) -> None:
    def handler(method: str, url: str, kwargs: dict[str, Any]) -> httpx.Response:
        if url.endswith("/auth/login"):
            return httpx.Response(200, json=_token_payload())
        assert method == "GET"
        assert url.endswith("/api/v1/me")
        return httpx.Response(
            403,
            json={"code": "account_unavailable", "message": "account is not active"},
        )

    monkeypatch.setattr(httpx, "AsyncClient", _fake_async_client(handler))
    with TestClient(_app(cloud_config, cloud_store)) as client:
        assert (
            client.post(
                "/auth/login",
                json={"email": _user()["email"], "password": "password123"},
            ).status_code
            == 200
        )
        response = client.get("/auth/me")

    assert response.status_code == 403
    deleted_cookies = response.headers.get_list("set-cookie")
    assert any(
        value.startswith(f"{cloud_config.session_cookie_name}=") and "Max-Age=0" in value
        for value in deleted_cookies
    )
    assert any(
        value.startswith(f"{cloud_config.token_cookie_name}=") and "Max-Age=0" in value
        for value in deleted_cookies
    )


def test_rotating_refresh_is_deduplicated_for_the_same_stale_cookie(
    monkeypatch: pytest.MonkeyPatch,
    cloud_config: CloudAccountsConfig,
    cloud_store: SqlAlchemyAccountStore,
) -> None:
    refresh_count = 0

    def handler(method: str, url: str, kwargs: dict[str, Any]) -> httpx.Response:
        nonlocal refresh_count
        assert method == "POST"
        if url.endswith("/auth/login"):
            return httpx.Response(200, json=_token_payload())
        assert url.endswith("/api/v1/auth/refresh")
        assert kwargs["json"]["refresh_token"] == _token_payload()["refresh_token"]
        refresh_count += 1
        payload = _token_payload()
        payload["access_token"] = "rotated-access-secret"
        payload["refresh_token"] = "rotated-refresh-secret-value-long-enough"
        return httpx.Response(200, json=payload)

    monkeypatch.setattr(httpx, "AsyncClient", _fake_async_client(handler))
    app = _app(cloud_config, cloud_store)
    with TestClient(app) as first:
        login = first.post(
            "/auth/login",
            json={"email": _user()["email"], "password": "password123"},
        )
        assert login.status_code == 200
        stale_cookie = first.cookies.get(cloud_config.token_cookie_name)
        assert stale_cookie is not None
        refreshed = first.post("/auth/refresh")
        assert refreshed.status_code == 200
        assert "rotated-access-secret" not in refreshed.text

    with TestClient(app) as concurrent:
        concurrent.cookies.set(cloud_config.token_cookie_name, stale_cookie, path="/")
        replayed = concurrent.post("/auth/refresh")

    assert replayed.status_code == 200
    assert refresh_count == 1


def test_cloud_namespace_collision_is_rejected(
    cloud_store: SqlAlchemyAccountStore,
) -> None:
    namespace = "450c7d39-96e0-4277-b6bf-c50a9c132b4d"
    cloud_store.upsert_cloud_user(
        "c7fd31fd-c47a-41d9-8f52-075c9f717edf",
        namespace,
        logged_in_at=1,
    )
    with pytest.raises(ValueError, match="already owned"):
        cloud_store.upsert_cloud_user(
            "f3346a46-f511-435b-9256-adb05c768234",
            namespace,
            logged_in_at=2,
        )


def test_cloud_config_requires_absolute_backend_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OMNIGENT_ACCOUNTS_COOKIE_SECRET", secrets.token_hex(32))
    monkeypatch.setenv("OMNIGENT_ACCOUNTS_BASE_URL", "http://127.0.0.1:6768")
    monkeypatch.setenv("OMNIGENT_CLOUD_BACKEND_URL", "capoo.fun/private_fund/backend")
    with pytest.raises(RuntimeError, match="OMNIGENT_CLOUD_BACKEND_URL"):
        CloudAccountsConfig.from_env()
