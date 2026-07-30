"""Configuration for the cloud-backed accounts authentication provider."""

from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlparse

from omnigent.server.accounts_config import AccountsConfig


@dataclass(frozen=True)
class CloudAccountsConfig:
    """Validated local-cookie and remote cloud service configuration."""

    accounts: AccountsConfig
    backend_url: str
    request_timeout_seconds: float
    registration_enabled: bool = True

    @property
    def cookie_secret(self) -> bytes:
        return self.accounts.cookie_secret

    @property
    def session_ttl_hours(self) -> int:
        return self.accounts.session_ttl_hours

    @property
    def base_url(self) -> str:
        return self.accounts.base_url

    @property
    def secure_cookies(self) -> bool:
        return self.accounts.secure_cookies

    @property
    def session_cookie_name(self) -> str:
        return self.accounts.session_cookie_name

    @property
    def token_cookie_name(self) -> str:
        return "__Host-pf_cloud_session" if self.secure_cookies else "pf_cloud_session"

    @staticmethod
    def from_env() -> CloudAccountsConfig:
        accounts = AccountsConfig.from_env()
        backend_url = os.environ.get("OMNIGENT_CLOUD_BACKEND_URL", "").strip().rstrip("/")
        parsed = urlparse(backend_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise RuntimeError(
                "OMNIGENT_CLOUD_BACKEND_URL must be an absolute http:// or https:// URL"
            )
        try:
            timeout = float(os.environ.get("OMNIGENT_CLOUD_REQUEST_TIMEOUT_SECONDS", "10"))
        except ValueError as exc:
            raise RuntimeError("OMNIGENT_CLOUD_REQUEST_TIMEOUT_SECONDS must be a number") from exc
        if timeout <= 0 or timeout > 120:
            raise RuntimeError("OMNIGENT_CLOUD_REQUEST_TIMEOUT_SECONDS must be between 0 and 120")
        registration_enabled = os.environ.get(
            "OMNIGENT_CLOUD_REGISTRATION_ENABLED", "1"
        ).strip().lower() not in {"0", "false", "no", "off"}
        return CloudAccountsConfig(
            accounts=accounts,
            backend_url=backend_url,
            request_timeout_seconds=timeout,
            registration_enabled=registration_enabled,
        )
