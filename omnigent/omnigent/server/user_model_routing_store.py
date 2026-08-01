"""Encrypted local persistence for platform/BYOK model routing."""

from __future__ import annotations

import base64
import os
import time
from dataclasses import dataclass

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from omnigent.db.db_models import SqlUserModelRouting
from omnigent.db.utils import get_or_create_engine, make_managed_session_maker
from omnigent.server.user_llm_config_store import master_key_from_env

MODEL_SOURCES = {"platform", "byok"}


@dataclass(frozen=True)
class UserModelRouting:
    source: str
    platform_token: str = ""
    platform_token_expires_at: int | None = None
    platform_gateway_base_url: str = ""

    def platform_token_valid(self, *, minimum_ttl_seconds: int = 0) -> bool:
        if not self.platform_token or not self.platform_gateway_base_url:
            return False
        if self.platform_token_expires_at is None:
            return False
        return self.platform_token_expires_at > int(time.time()) + minimum_ttl_seconds


class UserModelRoutingStore:
    def __init__(self, storage_location: str, master_key: bytes | None = None) -> None:
        self._engine = get_or_create_engine(storage_location)
        self._session = make_managed_session_maker(self._engine)
        self._aes = AESGCM(master_key or master_key_from_env())

    @staticmethod
    def _aad(user_id: str) -> bytes:
        return f"omnigent:user-platform-model-token:{user_id}".encode()

    def _encrypt(self, user_id: str, token: str) -> str:
        nonce = os.urandom(12)
        encrypted = self._aes.encrypt(nonce, token.encode("utf-8"), self._aad(user_id))
        return base64.urlsafe_b64encode(nonce + encrypted).decode("ascii")

    def _decrypt(self, user_id: str, ciphertext: str) -> str:
        raw = base64.urlsafe_b64decode(ciphertext.encode("ascii"))
        return self._aes.decrypt(raw[:12], raw[12:], self._aad(user_id)).decode("utf-8")

    def get(self, user_id: str, *, byok_configured: bool = False) -> UserModelRouting:
        with self._session() as session:
            row = session.get(SqlUserModelRouting, user_id)
            if row is None:
                return UserModelRouting(source="byok" if byok_configured else "platform")
            token = ""
            if row.platform_token_ciphertext:
                token = self._decrypt(user_id, row.platform_token_ciphertext)
            return UserModelRouting(
                source=row.source,
                platform_token=token,
                platform_token_expires_at=row.platform_token_expires_at,
                platform_gateway_base_url=row.platform_gateway_base_url or "",
            )

    def set_source(
        self,
        user_id: str,
        source: str,
        *,
        byok_configured: bool = False,
    ) -> UserModelRouting:
        if source not in MODEL_SOURCES:
            raise ValueError("model source must be platform or byok")
        now = int(time.time())
        with self._session() as session:
            row = session.get(SqlUserModelRouting, user_id)
            if row is None:
                row = SqlUserModelRouting(
                    user_id=user_id,
                    source=source,
                    platform_token_ciphertext=None,
                    platform_token_expires_at=None,
                    platform_gateway_base_url=None,
                    created_at=now,
                    updated_at=now,
                )
                session.add(row)
            else:
                row.source = source
                row.updated_at = now
            session.flush()
        return self.get(user_id, byok_configured=byok_configured)

    def save_platform_access(
        self,
        user_id: str,
        *,
        token: str,
        expires_at: int,
        gateway_base_url: str,
        byok_configured: bool = False,
    ) -> UserModelRouting:
        if not token or expires_at <= int(time.time()) or not gateway_base_url:
            raise ValueError("platform access token is incomplete")
        now = int(time.time())
        ciphertext = self._encrypt(user_id, token)
        with self._session() as session:
            row = session.get(SqlUserModelRouting, user_id)
            if row is None:
                row = SqlUserModelRouting(
                    user_id=user_id,
                    source="byok" if byok_configured else "platform",
                    platform_token_ciphertext=ciphertext,
                    platform_token_expires_at=expires_at,
                    platform_gateway_base_url=gateway_base_url,
                    created_at=now,
                    updated_at=now,
                )
                session.add(row)
            else:
                row.platform_token_ciphertext = ciphertext
                row.platform_token_expires_at = expires_at
                row.platform_gateway_base_url = gateway_base_url
                row.updated_at = now
            session.flush()
        return self.get(user_id, byok_configured=byok_configured)

    def clear_platform_access(self, user_id: str) -> None:
        with self._session() as session:
            row = session.get(SqlUserModelRouting, user_id)
            if row is None:
                return
            row.platform_token_ciphertext = None
            row.platform_token_expires_at = None
            row.platform_gateway_base_url = None
            row.updated_at = int(time.time())
            session.flush()
