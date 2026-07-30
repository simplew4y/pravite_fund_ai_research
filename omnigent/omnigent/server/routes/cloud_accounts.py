"""Local BFF routes for the cloud-backed accounts provider."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import json
import logging
import os
import platform
import time
import uuid
from dataclasses import dataclass
from typing import Any

import httpx
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from starlette.responses import JSONResponse, Response

from omnigent.server.accounts_store import SqlAlchemyAccountStore
from omnigent.server.auth import UnifiedAuthProvider
from omnigent.server.cloud_accounts_config import CloudAccountsConfig
from omnigent.server.oidc import mint_session_cookie
from omnigent.server.routes.accounts_auth import _clear_session_cookie, _set_session_cookie

_logger = logging.getLogger(__name__)
_TOKEN_COOKIE_TTL_SECONDS = 30 * 24 * 3600
_REPLAY_TTL_SECONDS = 15.0


class CloudLoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=1024)


class CloudRegistrationEmailRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)


class CloudRegistrationRequest(CloudRegistrationEmailRequest):
    code: str = Field(pattern=r"^\d{4}$")
    password: str = Field(min_length=8, max_length=1024)
    nick_name: str | None = Field(default=None, max_length=120)


class CloudChangePasswordRequest(BaseModel):
    old_password: str = Field(min_length=1, max_length=1024)
    new_password: str = Field(min_length=8, max_length=1024)


class CloudFeedbackRequest(BaseModel):
    feedback_type: str = Field(min_length=1, max_length=32)
    title: str = Field(min_length=2, max_length=240)
    content: str = Field(min_length=2, max_length=20_000)
    rating: int | None = Field(default=None, ge=1, le=5)
    contact_allowed: bool = True
    client_platform: str | None = Field(default=None, max_length=32)
    client_version: str | None = Field(default=None, max_length=64)


@dataclass(frozen=True)
class _CloudTokenBundle:
    access_token: str
    refresh_token: str
    expires_at: int
    user_id: str

    def to_json(self) -> bytes:
        return json.dumps(
            {
                "access_token": self.access_token,
                "refresh_token": self.refresh_token,
                "expires_at": self.expires_at,
                "user_id": self.user_id,
            },
            separators=(",", ":"),
        ).encode("utf-8")

    @staticmethod
    def from_json(raw: bytes) -> _CloudTokenBundle:
        data = json.loads(raw)
        return _CloudTokenBundle(
            access_token=str(data["access_token"]),
            refresh_token=str(data["refresh_token"]),
            expires_at=int(data["expires_at"]),
            user_id=str(uuid.UUID(str(data["user_id"]))),
        )


class _TokenCipher:
    def __init__(self, secret: bytes) -> None:
        self._key = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=b"omnigent-cloud-accounts-v1",
            info=b"encrypted-cloud-token-cookie",
        ).derive(secret)

    def encrypt(self, bundle: _CloudTokenBundle) -> str:
        nonce = os.urandom(12)
        ciphertext = AESGCM(self._key).encrypt(nonce, bundle.to_json(), b"cloud_accounts")
        return base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii").rstrip("=")

    def decrypt(self, value: str) -> _CloudTokenBundle | None:
        try:
            padded = value + "=" * (-len(value) % 4)
            payload = base64.urlsafe_b64decode(padded.encode("ascii"))
            return _CloudTokenBundle.from_json(
                AESGCM(self._key).decrypt(payload[:12], payload[12:], b"cloud_accounts")
            )
        except Exception:  # noqa: BLE001 - malformed/tampered cookies are simply unauthenticated
            return None


def _cloud_error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": code, "message": message},
        headers={"Cache-Control": "private, no-store"},
    )


def _safe_json(response: httpx.Response) -> dict[str, Any] | None:
    try:
        data = response.json()
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _cloud_user(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError("cloud user payload is missing")
    user_id = str(uuid.UUID(str(data["id"])))
    namespace = str(uuid.UUID(str(data["data_namespace"])))
    email = str(data["email"]).strip().lower()
    if not email or data.get("status") != "active":
        raise ValueError("cloud account is unavailable")
    return {
        "id": user_id,
        "email": email,
        "nick_name": data.get("nick_name"),
        "status": str(data["status"]),
        "is_admin": False,
        "is_platform_admin": bool(data.get("is_admin", False)),
        "data_namespace": namespace,
        "balance_cny": str(data.get("balance_cny", "0.000000")),
        "last_login_at": data.get("last_login_at"),
        "created_at": data.get("created_at"),
    }


def create_cloud_accounts_router(
    auth_provider: UnifiedAuthProvider,
    account_store: SqlAlchemyAccountStore,
) -> APIRouter:
    if auth_provider._source != "cloud_accounts":
        raise RuntimeError("create_cloud_accounts_router called with non-cloud provider")
    config: CloudAccountsConfig = auth_provider._cloud_accounts_config
    cipher = _TokenCipher(config.cookie_secret)
    router = APIRouter()
    refresh_locks: dict[str, asyncio.Lock] = {}
    refresh_replay: dict[str, tuple[float, _CloudTokenBundle, dict[str, Any]]] = {}

    def cloud_url(path: str) -> str:
        return f"{config.backend_url}/api/v1/{path.lstrip('/')}"

    async def cloud_request(
        method: str,
        path: str,
        *,
        token: str | None = None,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> httpx.Response:
        headers = {"accept": "application/json"}
        if token:
            headers["authorization"] = f"Bearer {token}"
        try:
            async with httpx.AsyncClient(
                timeout=config.request_timeout_seconds,
                follow_redirects=False,
            ) as client:
                return await client.request(
                    method,
                    cloud_url(path),
                    headers=headers,
                    json=json_body,
                    params=params,
                )
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            raise RuntimeError("cloud_service_unavailable") from exc

    def read_bundle(request: Request) -> _CloudTokenBundle | None:
        value = request.cookies.get(config.token_cookie_name)
        return cipher.decrypt(value) if value else None

    def set_cloud_cookie(response: Response, bundle: _CloudTokenBundle) -> None:
        response.set_cookie(
            key=config.token_cookie_name,
            value=cipher.encrypt(bundle),
            max_age=_TOKEN_COOKIE_TTL_SECONDS,
            httponly=True,
            secure=config.secure_cookies,
            samesite="lax",
            path="/",
        )

    def clear_cookies(response: Response) -> None:
        _clear_session_cookie(
            response,
            cookie_name=config.session_cookie_name,
            secure=config.secure_cookies,
        )
        response.delete_cookie(
            key=config.token_cookie_name,
            path="/",
            secure=config.secure_cookies,
            httponly=True,
            samesite="lax",
        )

    def set_local_session(response: Response, user_id: str) -> None:
        max_age = config.session_ttl_hours * 3600
        session_token = mint_session_cookie(
            user_id=user_id,
            cookie_secret=config.cookie_secret,
            ttl_hours=config.session_ttl_hours,
            provider="cloud_accounts",
        )
        _set_session_cookie(
            response,
            session_token,
            cookie_name=config.session_cookie_name,
            secure=config.secure_cookies,
            max_age_seconds=max_age,
        )

    def persist_shadow(user: dict[str, Any]) -> None:
        account_store.upsert_cloud_user(
            user["id"],
            user["data_namespace"],
            logged_in_at=int(time.time()),
        )

    def bundle_from_token_response(
        data: dict[str, Any], user: dict[str, Any]
    ) -> _CloudTokenBundle:
        return _CloudTokenBundle(
            access_token=str(data["access_token"]),
            refresh_token=str(data["refresh_token"]),
            expires_at=int(time.time()) + int(data.get("expires_in", 900)),
            user_id=user["id"],
        )

    async def refresh_bundle(
        stale: _CloudTokenBundle,
    ) -> tuple[_CloudTokenBundle, dict[str, Any]] | None:
        key = hashlib.sha256(stale.refresh_token.encode("utf-8")).hexdigest()
        lock = refresh_locks.setdefault(key, asyncio.Lock())
        async with lock:
            now = time.monotonic()
            for expired_key, replay_value in list(refresh_replay.items()):
                if replay_value[0] <= now:
                    refresh_replay.pop(expired_key, None)
            replay = refresh_replay.get(key)
            if replay and replay[0] > time.monotonic():
                return replay[1], replay[2]
            response = await cloud_request(
                "POST",
                "auth/refresh",
                json_body={"refresh_token": stale.refresh_token},
            )
            if response.status_code != 200:
                return None
            data = _safe_json(response)
            if data is None:
                return None
            try:
                user = _cloud_user(data.get("user"))
                if user["id"] != stale.user_id:
                    return None
                persist_shadow(user)
                fresh = bundle_from_token_response(data, user)
            except (KeyError, TypeError, ValueError):
                return None
            refresh_replay[key] = (time.monotonic() + _REPLAY_TTL_SECONDS, fresh, user)
            return fresh, user

    async def authorized_request(
        request: Request,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> tuple[httpx.Response | None, _CloudTokenBundle | None, dict[str, Any] | None]:
        bundle = read_bundle(request)
        if bundle is None:
            return None, None, None
        response = await cloud_request(
            method,
            path,
            token=bundle.access_token,
            json_body=json_body,
            params=params,
        )
        if response.status_code != 401:
            return response, bundle, None
        refreshed = await refresh_bundle(bundle)
        if refreshed is None:
            return None, None, None
        fresh, user = refreshed
        response = await cloud_request(
            method,
            path,
            token=fresh.access_token,
            json_body=json_body,
            params=params,
        )
        return response, fresh, user

    def proxy_response(
        upstream: httpx.Response,
        bundle: _CloudTokenBundle,
        *,
        refreshed_user: dict[str, Any] | None = None,
    ) -> Response:
        if upstream.status_code == 204:
            response: Response = Response(status_code=204)
        else:
            payload = _safe_json(upstream)
            response = JSONResponse(
                status_code=upstream.status_code,
                content=payload or {"error": "invalid_cloud_response"},
                headers={"Cache-Control": "private, no-store"},
            )
        set_cloud_cookie(response, bundle)
        if refreshed_user is not None:
            set_local_session(response, refreshed_user["id"])
        return response

    def proxy_authenticated_response(
        upstream: httpx.Response,
        bundle: _CloudTokenBundle,
        *,
        refreshed_user: dict[str, Any] | None = None,
    ) -> Response:
        response = proxy_response(upstream, bundle, refreshed_user=refreshed_user)
        if upstream.status_code in {401, 403}:
            clear_cookies(response)
        return response

    @router.post("/auth/login")
    async def login(body: CloudLoginRequest) -> Response:
        try:
            upstream = await cloud_request(
                "POST",
                "auth/login",
                json_body={"email": body.email.strip().lower(), "password": body.password},
            )
        except RuntimeError:
            return _cloud_error(503, "cloud_service_unavailable", "云端账户服务暂时不可用")
        if upstream.status_code != 200:
            payload = _safe_json(upstream) or {}
            code = str(payload.get("code") or payload.get("error") or "login_failed")
            message = str(payload.get("message") or "邮箱或密码错误")
            return _cloud_error(upstream.status_code, code, message)
        data = _safe_json(upstream)
        try:
            if data is None:
                raise ValueError
            user = _cloud_user(data.get("user"))
            persist_shadow(user)
            bundle = bundle_from_token_response(data, user)
        except (KeyError, TypeError, ValueError):
            return _cloud_error(502, "invalid_cloud_response", "云端账户服务返回了无效数据")
        response = JSONResponse(
            {
                "expires_in": config.session_ttl_hours * 3600,
                "user": user,
            },
            headers={"Cache-Control": "private, no-store"},
        )
        set_local_session(response, user["id"])
        set_cloud_cookie(response, bundle)
        return response

    @router.post("/auth/register/send-code")
    async def send_registration_code(body: CloudRegistrationEmailRequest) -> Response:
        if not config.registration_enabled:
            return _cloud_error(404, "registration_unavailable", "注册功能未启用")
        try:
            upstream = await cloud_request(
                "POST",
                "auth/register/send-code",
                json_body={"email": body.email.strip().lower()},
            )
        except RuntimeError:
            return _cloud_error(503, "cloud_service_unavailable", "云端账户服务暂时不可用")
        payload = _safe_json(upstream)
        if payload is None:
            return _cloud_error(502, "invalid_cloud_response", "云端账户服务返回了无效数据")
        return JSONResponse(
            status_code=upstream.status_code,
            content=payload,
            headers={"Cache-Control": "private, no-store"},
        )

    @router.post("/auth/register")
    async def register(body: CloudRegistrationRequest) -> Response:
        if not config.registration_enabled:
            return _cloud_error(404, "registration_unavailable", "注册功能未启用")
        try:
            upstream = await cloud_request(
                "POST",
                "auth/register",
                json_body={
                    "email": body.email.strip().lower(),
                    "code": body.code,
                    "password": body.password,
                    "nick_name": body.nick_name.strip() if body.nick_name else None,
                },
            )
        except RuntimeError:
            return _cloud_error(503, "cloud_service_unavailable", "云端账户服务暂时不可用")
        if upstream.status_code not in {200, 201}:
            payload = _safe_json(upstream) or {}
            code = str(payload.get("code") or payload.get("error") or "registration_failed")
            message = str(payload.get("message") or "账户注册失败")
            return _cloud_error(upstream.status_code, code, message)
        data = _safe_json(upstream)
        try:
            if data is None:
                raise ValueError
            user = _cloud_user(data.get("user"))
            persist_shadow(user)
            bundle = bundle_from_token_response(data, user)
        except (KeyError, TypeError, ValueError):
            return _cloud_error(502, "invalid_cloud_response", "云端账户服务返回了无效数据")
        response = JSONResponse(
            status_code=201,
            content={
                "expires_in": config.session_ttl_hours * 3600,
                "user": user,
            },
            headers={"Cache-Control": "private, no-store"},
        )
        set_local_session(response, user["id"])
        set_cloud_cookie(response, bundle)
        return response

    @router.post("/auth/refresh")
    async def refresh(request: Request) -> Response:
        bundle = read_bundle(request)
        if bundle is None:
            response = _cloud_error(401, "not_authenticated", "登录状态已失效")
            clear_cookies(response)
            return response
        try:
            refreshed = await refresh_bundle(bundle)
        except RuntimeError:
            return _cloud_error(503, "cloud_service_unavailable", "云端账户服务暂时不可用")
        if refreshed is None:
            response = _cloud_error(401, "not_authenticated", "登录状态已失效")
            clear_cookies(response)
            return response
        fresh, user = refreshed
        response = JSONResponse(
            {"ok": True, "user": user},
            headers={"Cache-Control": "private, no-store"},
        )
        set_local_session(response, user["id"])
        set_cloud_cookie(response, fresh)
        return response

    @router.post("/auth/logout")
    async def logout(request: Request) -> Response:
        bundle = read_bundle(request)
        if bundle is not None:
            with contextlib.suppress(RuntimeError):
                await cloud_request(
                    "POST",
                    "auth/logout",
                    json_body={"refresh_token": bundle.refresh_token},
                )
        response = Response(
            status_code=204,
            headers={"Cache-Control": "private, no-store"},
        )
        clear_cookies(response)
        return response

    @router.get("/auth/me")
    async def me(request: Request) -> Response:
        try:
            upstream, bundle, refreshed_user = await authorized_request(request, "GET", "me")
        except RuntimeError:
            return _cloud_error(503, "cloud_service_unavailable", "云端账户服务暂时不可用")
        if upstream is None or bundle is None:
            response = _cloud_error(401, "not_authenticated", "登录状态已失效")
            clear_cookies(response)
            return response
        if upstream.status_code != 200:
            return proxy_authenticated_response(
                upstream,
                bundle,
                refreshed_user=refreshed_user,
            )
        try:
            user = _cloud_user(_safe_json(upstream))
            persist_shadow(user)
        except (KeyError, TypeError, ValueError):
            return _cloud_error(502, "invalid_cloud_response", "云端账户服务返回了无效数据")
        response = JSONResponse(user, headers={"Cache-Control": "private, no-store"})
        set_cloud_cookie(response, bundle)
        if refreshed_user is not None:
            set_local_session(response, user["id"])
        return response

    @router.post("/auth/users/me/password")
    async def change_password(body: CloudChangePasswordRequest, request: Request) -> Response:
        try:
            upstream, bundle, _ = await authorized_request(
                request,
                "POST",
                "me/change-password",
                json_body=body.model_dump(),
            )
        except RuntimeError:
            return _cloud_error(503, "cloud_service_unavailable", "云端账户服务暂时不可用")
        if upstream is None or bundle is None:
            response = _cloud_error(401, "not_authenticated", "登录状态已失效")
            clear_cookies(response)
            return response
        response = proxy_authenticated_response(upstream, bundle)
        if upstream.status_code < 300:
            clear_cookies(response)
        return response

    async def account_proxy(
        request: Request,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
    ) -> Response:
        params = dict(request.query_params)
        try:
            upstream, bundle, refreshed_user = await authorized_request(
                request,
                method,
                path,
                json_body=body,
                params=params,
            )
        except RuntimeError:
            return _cloud_error(503, "cloud_service_unavailable", "云端账户服务暂时不可用")
        if upstream is None or bundle is None:
            response = _cloud_error(401, "not_authenticated", "登录状态已失效")
            clear_cookies(response)
            return response
        return proxy_authenticated_response(
            upstream,
            bundle,
            refreshed_user=refreshed_user,
        )

    @router.get("/v1/account/usage")
    async def usage(request: Request) -> Response:
        return await account_proxy(request, "GET", "me/usage")

    @router.get("/v1/account/balance-records")
    async def balance_records(request: Request) -> Response:
        return await account_proxy(request, "GET", "me/balance-records")

    @router.get("/v1/account/feedback")
    async def feedback_list(request: Request) -> Response:
        return await account_proxy(request, "GET", "feedback")

    @router.post("/v1/account/feedback")
    async def feedback_create(body: CloudFeedbackRequest, request: Request) -> Response:
        payload = body.model_dump()
        payload["client_platform"] = payload["client_platform"] or platform.system().lower()
        return await account_proxy(request, "POST", "feedback", body=payload)

    return router
