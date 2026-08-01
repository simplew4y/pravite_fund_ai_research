"""Encrypted persistence for per-user upstream model configuration."""

from __future__ import annotations

import base64
import os
import time
from dataclasses import dataclass

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from omnigent.db.db_models import SqlUserLlmConfig
from omnigent.db.utils import get_or_create_engine, make_managed_session_maker


@dataclass(frozen=True)
class UserLlmConfig:
    preset: str
    provider: str
    base_url: str
    model: str
    api_key: str

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.model and self.api_key)


def master_key_from_env() -> bytes:
    raw = os.environ.get("OMNIGENT_USER_SECRETS_KEY", "").strip()
    if not raw:
        raise RuntimeError("OMNIGENT_USER_SECRETS_KEY is required in multi-user mode")
    try:
        key = bytes.fromhex(raw)
    except ValueError:
        try:
            key = base64.urlsafe_b64decode(raw.encode("ascii"))
        except Exception as exc:
            raise RuntimeError("OMNIGENT_USER_SECRETS_KEY must be hex or base64") from exc
    if len(key) != 32:
        raise RuntimeError("OMNIGENT_USER_SECRETS_KEY must decode to exactly 32 bytes")
    return key


class UserLlmConfigStore:
    def __init__(self, storage_location: str, master_key: bytes | None = None) -> None:
        self._engine = get_or_create_engine(storage_location)
        self._session = make_managed_session_maker(self._engine)
        self._aes = AESGCM(master_key or master_key_from_env())

    @staticmethod
    def _aad(user_id: str) -> bytes:
        return f"omnigent:user-llm-config:{user_id}".encode()

    def _encrypt(self, user_id: str, api_key: str) -> str:
        nonce = os.urandom(12)
        encrypted = self._aes.encrypt(nonce, api_key.encode("utf-8"), self._aad(user_id))
        return base64.urlsafe_b64encode(nonce + encrypted).decode("ascii")

    def _decrypt(self, user_id: str, ciphertext: str) -> str:
        raw = base64.urlsafe_b64decode(ciphertext.encode("ascii"))
        return self._aes.decrypt(raw[:12], raw[12:], self._aad(user_id)).decode("utf-8")

    def get(self, user_id: str) -> UserLlmConfig | None:
        with self._session() as session:
            row = session.get(SqlUserLlmConfig, user_id)
            if row is None:
                return None
            return UserLlmConfig(
                preset=row.preset,
                provider=row.provider,
                base_url=row.base_url,
                model=row.model,
                api_key=self._decrypt(user_id, row.api_key_ciphertext),
            )

    def save(self, user_id: str, config: UserLlmConfig) -> UserLlmConfig:
        now = int(time.time())
        encrypted = self._encrypt(user_id, config.api_key)
        with self._session() as session:
            row = session.get(SqlUserLlmConfig, user_id)
            if row is None:
                row = SqlUserLlmConfig(
                    user_id=user_id,
                    preset=config.preset,
                    provider=config.provider,
                    base_url=config.base_url,
                    model=config.model,
                    api_key_ciphertext=encrypted,
                    created_at=now,
                    updated_at=now,
                )
                session.add(row)
            else:
                row.preset = config.preset
                row.provider = config.provider
                row.base_url = config.base_url
                row.model = config.model
                row.api_key_ciphertext = encrypted
                row.updated_at = now
            session.flush()
        return config
