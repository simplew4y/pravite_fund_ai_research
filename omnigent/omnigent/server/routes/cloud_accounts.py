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
from decimal import Decimal, InvalidOperation
from typing import Annotated, Any, Literal
from urllib.parse import urlparse

import httpx
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from fastapi import APIRouter, File, Form, Request, UploadFile
from pydantic import BaseModel, Field, ValidationError
from starlette.responses import JSONResponse, Response

from omnigent.server.accounts_store import SqlAlchemyAccountStore
from omnigent.server.auth import UnifiedAuthProvider
from omnigent.server.cloud_accounts_config import CloudAccountsConfig
from omnigent.server.oidc import mint_session_cookie
from omnigent.server.private_fund_locale import (
    normalize_app_locale,
    write_user_locale,
)
from omnigent.server.routes.accounts_auth import _clear_session_cookie, _set_session_cookie
from omnigent.server.user_llm_config_store import UserLlmConfigStore
from omnigent.server.user_model_routing_store import UserModelRoutingStore

_logger = logging.getLogger(__name__)
_TOKEN_COOKIE_TTL_SECONDS = 30 * 24 * 3600
_REPLAY_TTL_SECONDS = 15.0


class CloudLoginRequest(BaseModel):
    email: str | None = Field(default=None, min_length=3, max_length=320)
    username: str | None = Field(default=None, min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=1024)

    def login_email(self) -> str:
        return (self.email or self.username or "").strip().lower()


class CloudRegistrationEmailRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)


class CloudRegistrationRequest(CloudRegistrationEmailRequest):
    code: str = Field(pattern=r"^\d{6}$")
    password: str = Field(min_length=8, max_length=1024)
    nick_name: str | None = Field(default=None, max_length=120)
    preferred_locale: Literal["zh-CN", "en-US"] = "zh-CN"


class CloudChangePasswordRequest(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")
    new_password: str = Field(min_length=8, max_length=1024)


class CloudPasswordResetRequest(CloudRegistrationEmailRequest):
    code: str = Field(pattern=r"^\d{6}$")
    new_password: str = Field(min_length=8, max_length=1024)


class CloudUpdateProfileRequest(BaseModel):
    nick_name: str | None = Field(default=None, max_length=120)


class CloudUpdatePreferencesRequest(BaseModel):
    preferred_locale: Literal["zh-CN", "en-US"]


class CloudFeedbackRequest(BaseModel):
    feedback_type: Literal["bug", "experience", "feature", "answer_quality", "other"]
    title: str = Field(min_length=2, max_length=240)
    content: str = Field(min_length=2, max_length=20_000)
    rating: int | None = Field(default=None, ge=1, le=5)
    contact_allowed: bool = True
    client_platform: str | None = Field(default=None, max_length=32)
    client_version: str | None = Field(default=None, max_length=64)


class CloudModelSourceRequest(BaseModel):
    source: Literal["platform", "byok"]


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
        "preferred_locale": normalize_app_locale(data.get("preferred_locale")),
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
    byok_store = UserLlmConfigStore(account_store.storage_location)
    routing_store = UserModelRoutingStore(account_store.storage_location)
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
        form_data: dict[str, str] | None = None,
        files: list[tuple[str, tuple[str, Any, str]]] | None = None,
        params: dict[str, Any] | None = None,
        request_id: str | None = None,
        timeout_seconds: float | None = None,
    ) -> httpx.Response:
        headers = {"accept": "application/json"}
        if token:
            headers["authorization"] = f"Bearer {token}"
        if request_id:
            headers["X-Request-ID"] = request_id
        try:
            async with httpx.AsyncClient(
                timeout=timeout_seconds or config.request_timeout_seconds,
                follow_redirects=False,
            ) as client:
                return await client.request(
                    method,
                    cloud_url(path),
                    headers=headers,
                    json=json_body,
                    data=form_data,
                    files=files,
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

    def set_local_session(response: Response, user_id: str) -> str:
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
        return session_token

    def persist_shadow(user: dict[str, Any]) -> None:
        account_store.upsert_cloud_user(
            user["id"],
            user["data_namespace"],
            logged_in_at=int(time.time()),
        )
        write_user_locale(
            user["data_namespace"],
            normalize_app_locale(user.get("preferred_locale")),
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
        request_id = (
            request.headers.get("X-Request-ID")
            or getattr(request.state, "request_id", None)
            or str(uuid.uuid4())
        )
        if bundle is None:
            return None, None, None
        response = await cloud_request(
            method,
            path,
            token=bundle.access_token,
            json_body=json_body,
            params=params,
            request_id=request_id,
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
            request_id=request_id,
        )
        return response, fresh, user

    async def authorized_upload_request(
        request: Request,
        metadata: str,
        uploads: list[UploadFile],
    ) -> tuple[httpx.Response | None, _CloudTokenBundle | None, dict[str, Any] | None]:
        bundle = read_bundle(request)
        request_id = (
            request.headers.get("X-Request-ID")
            or getattr(request.state, "request_id", None)
            or str(uuid.uuid4())
        )
        if bundle is None:
            return None, None, None

        async def send(token: str) -> httpx.Response:
            for upload in uploads:
                await upload.seek(0)
            files = [
                (
                    "files",
                    (
                        upload.filename or "attachment",
                        upload.file,
                        upload.content_type or "application/octet-stream",
                    ),
                )
                for upload in uploads
            ]
            return await cloud_request(
                "POST",
                "feedback/with-attachments",
                token=token,
                form_data={"metadata": metadata},
                files=files,
                request_id=request_id,
                timeout_seconds=config.upload_timeout_seconds,
            )

        response = await send(bundle.access_token)
        if response.status_code != 401:
            return response, bundle, None
        refreshed = await refresh_bundle(bundle)
        if refreshed is None:
            return None, None, None
        fresh, user = refreshed
        response = await send(fresh.access_token)
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
            headers = {"Cache-Control": "private, no-store"}
            request_id = upstream.headers.get("X-Request-ID")
            if request_id:
                headers["X-Request-ID"] = request_id
            if payload is None:
                _logger.warning(
                    "Cloud account proxy received non-JSON status %s",
                    upstream.status_code,
                )
                payload = {
                    "code": "invalid_cloud_response",
                    "error": "invalid_cloud_response",
                    "message": "Cloud account service returned an invalid response",
                }
            response = JSONResponse(
                status_code=upstream.status_code,
                content=payload,
                headers=headers,
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
            routing_store.clear_platform_access(bundle.user_id)
            clear_cookies(response)
        return response

    def proxy_authenticated_file_response(
        upstream: httpx.Response,
        bundle: _CloudTokenBundle,
        *,
        refreshed_user: dict[str, Any] | None = None,
    ) -> Response:
        headers = {
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        }
        for name in ("content-disposition", "x-request-id"):
            value = upstream.headers.get(name)
            if value:
                headers[name] = value
        response = Response(
            content=upstream.content,
            status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type", "application/octet-stream"),
            headers=headers,
        )
        set_cloud_cookie(response, bundle)
        if refreshed_user is not None:
            set_local_session(response, refreshed_user["id"])
        return response

    @router.post("/auth/login")
    async def login(body: CloudLoginRequest) -> Response:
        email = body.login_email()
        if not email:
            return _cloud_error(422, "missing_email", "email is required")
        try:
            upstream = await cloud_request(
                "POST",
                "auth/login",
                json_body={"email": email, "password": body.password},
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
        max_age = config.session_ttl_hours * 3600
        session_token = mint_session_cookie(
            user_id=user["id"],
            cookie_secret=config.cookie_secret,
            ttl_hours=config.session_ttl_hours,
            provider="cloud_accounts",
        )
        response = JSONResponse(
            {
                "token": session_token,
                "expires_in": max_age,
                "user": user,
            },
            headers={"Cache-Control": "private, no-store"},
        )
        _set_session_cookie(
            response,
            session_token,
            cookie_name=config.session_cookie_name,
            secure=config.secure_cookies,
            max_age_seconds=max_age,
        )
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
                    "preferred_locale": body.preferred_locale,
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

    @router.post("/auth/password/reset/send-code")
    async def send_password_reset_code(body: CloudRegistrationEmailRequest) -> Response:
        try:
            upstream = await cloud_request(
                "POST",
                "auth/password/reset/send-code",
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

    @router.post("/auth/password/reset")
    async def reset_password(body: CloudPasswordResetRequest) -> Response:
        try:
            upstream = await cloud_request(
                "POST",
                "auth/password/reset",
                json_body={
                    "email": body.email.strip().lower(),
                    "code": body.code,
                    "new_password": body.new_password,
                },
            )
        except RuntimeError:
            return _cloud_error(503, "cloud_service_unavailable", "云端账户服务暂时不可用")
        if upstream.status_code == 204:
            response: Response = Response(status_code=204)
            clear_cookies(response)
            return response
        payload = _safe_json(upstream)
        return JSONResponse(
            status_code=upstream.status_code,
            content=payload or {"error": "invalid_cloud_response"},
            headers={"Cache-Control": "private, no-store"},
        )

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
            routing_store.clear_platform_access(bundle.user_id)
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

    @router.patch("/auth/users/me/profile")
    async def update_profile(body: CloudUpdateProfileRequest, request: Request) -> Response:
        nick_name = body.nick_name.strip() if body.nick_name else None
        try:
            upstream, bundle, refreshed_user = await authorized_request(
                request,
                "PATCH",
                "me/profile",
                json_body={"nick_name": nick_name or None},
            )
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

    @router.patch("/auth/users/me/preferences")
    async def update_preferences(
        body: CloudUpdatePreferencesRequest,
        request: Request,
    ) -> Response:
        try:
            upstream, bundle, refreshed_user = await authorized_request(
                request,
                "PATCH",
                "me/preferences",
                json_body={"preferred_locale": body.preferred_locale},
            )
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

    @router.post("/auth/users/me/password/send-code")
    async def send_change_password_code(request: Request) -> Response:
        try:
            upstream, bundle, refreshed_user = await authorized_request(
                request,
                "POST",
                "me/change-password/send-code",
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
            routing_store.clear_platform_access(bundle.user_id)
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

    def byok_public(user_id: str) -> dict[str, Any]:
        from omnigent.server import private_fund_llm_config as llm_config

        stored = byok_store.get(user_id)
        if stored is None:
            return {
                "preset": "custom",
                "provider": "custom_openai",
                "baseUrl": "",
                "model": "",
                "hasApiKey": False,
                "maskedApiKey": "",
                "configured": False,
            }
        return {
            "preset": stored.preset,
            "provider": stored.provider,
            "baseUrl": stored.base_url,
            "model": stored.model,
            "hasApiKey": bool(stored.api_key),
            "maskedApiKey": llm_config.mask_api_key(stored.api_key),
            "configured": stored.configured,
        }

    def normalized_models(payload: dict[str, Any]) -> tuple[list[dict[str, Any]], str]:
        def positive_int(value: Any) -> int:
            try:
                return max(0, int(value or 0))
            except (TypeError, ValueError):
                return 0

        raw_models = payload.get("data")
        if not isinstance(raw_models, list):
            return [], ""
        models: list[dict[str, Any]] = []
        for item in raw_models:
            if not isinstance(item, dict) or not item.get("id"):
                continue
            models.append(
                {
                    "id": str(item["id"]),
                    "displayName": str(item.get("display_name") or item["id"]),
                    "provider": str(item.get("provider") or "platform"),
                    "inputPriceCnyPerMillion": str(
                        item.get("input_price_cny_per_million") or "0.000000"
                    ),
                    "outputPriceCnyPerMillion": str(
                        item.get("output_price_cny_per_million") or "0.000000"
                    ),
                    "defaultMaxTokens": positive_int(item.get("default_max_tokens")),
                    "maxOutputTokens": positive_int(item.get("max_output_tokens")),
                }
            )
        default_model = str(payload.get("default_model") or "")
        if not default_model and models:
            default_model = str(models[0]["id"])
        return models, default_model

    async def cloud_model_context(
        request: Request,
    ) -> (
        tuple[dict[str, Any], dict[str, Any], _CloudTokenBundle, dict[str, Any] | None] | Response
    ):
        stale_bundle = read_bundle(request)
        try:
            me_response, me_bundle, refreshed_user = await authorized_request(
                request,
                "GET",
                "me",
            )
            models_response, models_bundle, models_refreshed_user = await authorized_request(
                request,
                "GET",
                "models",
            )
        except RuntimeError:
            return _cloud_error(503, "cloud_service_unavailable", "云端模型服务暂时不可用")
        if me_response is None or me_bundle is None:
            if stale_bundle is not None:
                routing_store.clear_platform_access(stale_bundle.user_id)
            response = _cloud_error(401, "not_authenticated", "登录状态已失效")
            clear_cookies(response)
            return response
        if models_response is None or models_bundle is None:
            if stale_bundle is not None:
                routing_store.clear_platform_access(stale_bundle.user_id)
            response = _cloud_error(401, "not_authenticated", "登录状态已失效")
            clear_cookies(response)
            return response
        if me_response.status_code != 200:
            return proxy_authenticated_response(
                me_response,
                me_bundle,
                refreshed_user=refreshed_user,
            )
        if models_response.status_code != 200:
            return proxy_authenticated_response(
                models_response,
                models_bundle,
                refreshed_user=models_refreshed_user,
            )
        try:
            user = _cloud_user(_safe_json(me_response))
        except (KeyError, TypeError, ValueError):
            return _cloud_error(502, "invalid_cloud_response", "云端账户服务返回了无效数据")
        models_payload = _safe_json(models_response)
        if models_payload is None:
            return _cloud_error(502, "invalid_cloud_response", "云端模型服务返回了无效数据")
        persist_shadow(user)
        return (
            user,
            models_payload,
            models_bundle,
            models_refreshed_user or refreshed_user,
        )

    def model_service_state(
        user: dict[str, Any],
        models_payload: dict[str, Any],
    ) -> dict[str, Any]:
        user_id = str(user["id"])
        byok = byok_public(user_id)
        routing = routing_store.get(user_id, byok_configured=bool(byok["configured"]))
        models, default_model = normalized_models(models_payload)
        available = bool(models_payload.get("available", True) and models and default_model)
        try:
            balance = Decimal(str(user.get("balance_cny") or "0"))
            if not balance.is_finite():
                balance = Decimal("0")
        except (InvalidOperation, ValueError):
            balance = Decimal("0")

        reason: str | None = None
        detail: str | None = None
        ready = False
        active_label = ""
        if routing.source == "byok":
            ready = bool(byok["configured"])
            active_label = str(byok.get("model") or "自有 API")
            if not ready:
                reason = "byok_not_configured"
                detail = "请先配置并验证自己的模型 API。"
        else:
            selected = next((item for item in models if item["id"] == default_model), None)
            active_label = str((selected or {}).get("displayName") or default_model or "平台模型")
            if not available:
                reason = "platform_unavailable"
                detail = "平台模型服务暂时不可用。"
            elif balance <= 0:
                reason = "insufficient_balance"
                detail = "平台账户余额不足，请查看账户或切换到自有 API。"
            elif not routing.platform_token_valid():
                reason = "platform_access_required"
                detail = "平台模型访问凭证需要刷新。"
            else:
                ready = True

        return {
            "userId": user_id,
            "source": routing.source,
            "ready": ready,
            "reason": reason,
            "detail": detail,
            "activeLabel": active_label,
            "platform": {
                "available": available,
                "balanceCny": str(user.get("balance_cny") or "0.000000"),
                "defaultModel": default_model,
                "models": models,
                "tokenExpiresAt": routing.platform_token_expires_at,
            },
            "byok": byok,
        }

    def model_json_response(
        state: dict[str, Any],
        bundle: _CloudTokenBundle,
        refreshed_user: dict[str, Any] | None,
    ) -> JSONResponse:
        response = JSONResponse(state, headers={"Cache-Control": "private, no-store"})
        set_cloud_cookie(response, bundle)
        if refreshed_user is not None:
            set_local_session(response, refreshed_user["id"])
        return response

    async def prepare_platform_access(
        request: Request,
        user: dict[str, Any],
        models_payload: dict[str, Any],
        bundle: _CloudTokenBundle,
        refreshed_user: dict[str, Any] | None,
    ) -> Response:
        state = model_service_state(user, models_payload)
        if state["source"] != "platform":
            return model_json_response(state, bundle, refreshed_user)
        if state["reason"] not in {None, "platform_access_required"}:
            return model_json_response(state, bundle, refreshed_user)
        user_id = str(user["id"])
        routing = routing_store.get(
            user_id,
            byok_configured=bool(state["byok"]["configured"]),
        )
        if routing.platform_token_valid(minimum_ttl_seconds=3600):
            return model_json_response(state, bundle, refreshed_user)
        try:
            token_response, token_bundle, token_refreshed_user = await authorized_request(
                request,
                "POST",
                "model-access-token",
            )
        except RuntimeError:
            state.update(
                ready=False,
                reason="platform_unavailable",
                detail="无法获取平台模型访问凭证，请稍后重试。",
            )
            return model_json_response(state, bundle, refreshed_user)
        if token_response is None or token_bundle is None:
            response = _cloud_error(401, "not_authenticated", "登录状态已失效")
            routing_store.clear_platform_access(user_id)
            clear_cookies(response)
            return response
        token_payload = _safe_json(token_response)
        if token_response.status_code != 200 or token_payload is None:
            state.update(
                ready=False,
                reason="platform_unavailable",
                detail="平台模型访问凭证签发失败，请稍后重试。",
            )
            return model_json_response(
                state,
                token_bundle,
                token_refreshed_user or refreshed_user,
            )
        token = str(token_payload.get("access_token") or "")
        try:
            expires_in = int(token_payload.get("expires_in") or 0)
        except (TypeError, ValueError):
            expires_in = 0
        gateway_base_url = str(token_payload.get("gateway_base_url") or "").rstrip("/")
        parsed = urlparse(gateway_base_url)
        if (
            not token.startswith("pfm_")
            or expires_in <= 0
            or parsed.scheme != "https"
            or not parsed.netloc
            or parsed.username
            or parsed.password
        ):
            state.update(
                ready=False,
                reason="platform_unavailable",
                detail="平台模型访问凭证格式无效。",
            )
            return model_json_response(
                state,
                token_bundle,
                token_refreshed_user or refreshed_user,
            )
        routing_store.save_platform_access(
            user_id,
            token=token,
            expires_at=int(time.time()) + expires_in,
            gateway_base_url=gateway_base_url,
            byok_configured=bool(state["byok"]["configured"]),
        )
        prepared = model_service_state(user, models_payload)
        return model_json_response(
            prepared,
            token_bundle,
            token_refreshed_user or refreshed_user,
        )

    @router.get("/v1/private-fund/model-service")
    async def get_model_service(request: Request) -> Response:
        context = await cloud_model_context(request)
        if isinstance(context, Response):
            return context
        user, models_payload, bundle, refreshed_user = context
        return model_json_response(
            model_service_state(user, models_payload),
            bundle,
            refreshed_user,
        )

    @router.put("/v1/private-fund/model-service/source")
    async def set_model_source(body: CloudModelSourceRequest, request: Request) -> Response:
        context = await cloud_model_context(request)
        if isinstance(context, Response):
            return context
        user, models_payload, bundle, refreshed_user = context
        byok = byok_public(str(user["id"]))
        routing_store.set_source(
            str(user["id"]),
            body.source,
            byok_configured=bool(byok["configured"]),
        )
        state = model_service_state(user, models_payload)
        if body.source == "platform":
            return await prepare_platform_access(
                request,
                user,
                models_payload,
                bundle,
                refreshed_user,
            )
        return model_json_response(state, bundle, refreshed_user)

    @router.post("/v1/private-fund/model-service/prepare")
    async def prepare_model_service(request: Request) -> Response:
        context = await cloud_model_context(request)
        if isinstance(context, Response):
            return context
        user, models_payload, bundle, refreshed_user = context
        return await prepare_platform_access(
            request,
            user,
            models_payload,
            bundle,
            refreshed_user,
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

    @router.post("/v1/account/feedback/with-attachments")
    async def feedback_create_with_attachments(
        request: Request,
        metadata: Annotated[str, Form()],
        files: Annotated[list[UploadFile], File()],
    ) -> Response:
        if len(files) > 3:
            return _cloud_error(413, "too_many_feedback_attachments", "附件最多上传 3 个")
        allowed_extensions = {".docx", ".pdf", ".png", ".jpg", ".jpeg"}
        total_bytes = 0
        for upload in files:
            extension = os.path.splitext(upload.filename or "")[1].lower()
            if extension not in allowed_extensions:
                return _cloud_error(
                    415,
                    "unsupported_attachment_type",
                    "仅支持 .docx、.pdf、.png、.jpg 和 .jpeg 文件",
                )
            if upload.size is not None:
                if upload.size > 50 * 1024 * 1024:
                    return _cloud_error(413, "attachment_too_large", "单个附件不能超过 50MB")
                total_bytes += upload.size
        if total_bytes > 150 * 1024 * 1024:
            return _cloud_error(
                413,
                "feedback_attachments_too_large",
                "附件总大小不能超过 150MB",
            )
        try:
            body = CloudFeedbackRequest.model_validate_json(metadata)
        except ValidationError:
            return _cloud_error(422, "invalid_feedback_metadata", "反馈内容格式无效")
        payload = body.model_dump()
        payload["client_platform"] = payload["client_platform"] or platform.system().lower()
        normalized_metadata = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        try:
            upstream, bundle, refreshed_user = await authorized_upload_request(
                request,
                normalized_metadata,
                files,
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

    @router.get("/v1/account/feedback/{feedback_id}/attachments/{attachment_id}")
    async def feedback_attachment_download(
        feedback_id: uuid.UUID,
        attachment_id: uuid.UUID,
        request: Request,
    ) -> Response:
        path = f"feedback/{feedback_id}/attachments/{attachment_id}"
        try:
            upstream, bundle, refreshed_user = await authorized_request(request, "GET", path)
        except RuntimeError:
            return _cloud_error(503, "cloud_service_unavailable", "云端账户服务暂时不可用")
        if upstream is None or bundle is None:
            response = _cloud_error(401, "not_authenticated", "登录状态已失效")
            clear_cookies(response)
            return response
        if upstream.status_code != 200:
            return proxy_authenticated_response(upstream, bundle, refreshed_user=refreshed_user)
        return proxy_authenticated_file_response(upstream, bundle, refreshed_user=refreshed_user)

    return router
