"""Per-user locale persistence for the private-fund workbench."""

from __future__ import annotations

import json
import os
import time
import uuid
from contextlib import suppress
from pathlib import Path
from typing import Any, Literal

from omnigent.server.private_fund_tenant import project_root

AppLocale = Literal["zh-CN", "en-US"]
DEFAULT_APP_LOCALE: AppLocale = "zh-CN"
SUPPORTED_APP_LOCALES = frozenset({"zh-CN", "en-US"})


def normalize_app_locale(value: Any) -> AppLocale:
    if value == "en-US":
        return "en-US"
    return DEFAULT_APP_LOCALE


def _preferences_path(data_namespace: str) -> Path:
    namespace = str(uuid.UUID(data_namespace))
    return (
        project_root()
        / "output"
        / "users"
        / namespace
        / "settings"
        / "preferences.json"
    )


def write_user_locale(data_namespace: str, locale: AppLocale | str) -> Path:
    normalized = normalize_app_locale(locale)
    path = _preferences_path(data_namespace)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(
            {
                "preferred_locale": normalized,
                "updated_at": int(time.time()),
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    with suppress(OSError):
        os.chmod(temporary, 0o600)
    os.replace(temporary, path)
    from omnigent.server.private_fund_memory import sync_user_memory_policy

    sync_user_memory_policy(data_namespace, normalized)
    return path


def read_user_locale(data_namespace: str) -> AppLocale:
    path = _preferences_path(data_namespace)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return DEFAULT_APP_LOCALE
    return normalize_app_locale(data.get("preferred_locale") if isinstance(data, dict) else None)
