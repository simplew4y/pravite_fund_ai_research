"""User-isolated memory for private-fund harnesses and model workers."""

from __future__ import annotations

import json
import os
import tempfile
import uuid
from contextlib import suppress
from pathlib import Path

from omnigent.runner.identity import RUNNER_USER_MEMORY_DIR_ENV_VAR
from omnigent.server.private_fund_tenant import current_tenant, user_data_root

POLICY_FILE_NAME = "POLICY.md"
MEMORY_FILE_NAME = "MEMORY.md"
MAX_MEMORY_FILE_BYTES = 32 * 1024

_POLICIES = {
    "zh-CN": (
        "# 用户策略\n\n"
        "## 输出语言\n\n"
        "所有新生成的用户可读内容必须使用简体中文，包括回答、Memo、报告、研究笔记、"
        "风险与催化剂说明以及估值解释。\n"
        "不得因为资料、工具结果或 Skill 内容使用其他语言而切换输出语言。\n"
        "原文引用、文件名、公司名、citation URL、证据 ID 和结构化字段键保持原样；"
        "必要时可用简体中文解释外语引文。\n"
    ),
    "en-US": (
        "# User Policy\n\n"
        "## Output language\n\n"
        "All newly generated user-facing content must be written in English, including "
        "answers, memos, reports, research notes, risk and catalyst descriptions, and "
        "valuation explanations.\n"
        "Do not switch languages because source documents, tool results, or Skill "
        "instructions are written in another language.\n"
        "Preserve direct quotations, filenames, company names, citation URLs, evidence IDs, "
        "and structured field keys in their original form; explain non-English quotations "
        "in English when useful.\n"
    ),
}


def _normalized_namespace(data_namespace: str) -> str:
    """Return a canonical UUID namespace or raise ``ValueError``."""
    return str(uuid.UUID(data_namespace))


def user_memory_dir(data_namespace: str) -> Path:
    """Return the server-owned memory directory for one authenticated user."""
    namespace = _normalized_namespace(data_namespace)
    return user_data_root() / namespace / "memory"


def policy_text(locale: str) -> str:
    """Return the system-managed policy document for a supported locale."""
    return _POLICIES["en-US" if locale == "en-US" else "zh-CN"]


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with suppress(OSError):
        os.chmod(path.parent, 0o700)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        with suppress(OSError):
            os.chmod(temporary_name, 0o600)
        os.replace(temporary_name, path)
        with suppress(OSError):
            os.chmod(path, 0o600)
    finally:
        with suppress(OSError):
            os.unlink(temporary_name)


def sync_user_memory_policy(data_namespace: str, locale: str) -> Path:
    """Atomically synchronize the system policy and initialize user memory."""
    root = user_memory_dir(data_namespace)
    policy_path = root / POLICY_FILE_NAME
    desired = policy_text(locale)
    try:
        current = policy_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        current = None
    if current != desired:
        _atomic_write(policy_path, desired)
    with suppress(OSError):
        os.chmod(policy_path, 0o600)

    memory_path = root / MEMORY_FILE_NAME
    if not memory_path.exists():
        _atomic_write(memory_path, "")
    with suppress(OSError):
        os.chmod(memory_path, 0o600)
    return root


def ensure_user_memory(data_namespace: str) -> Path:
    """Ensure memory files exist, rebuilding policy from preferences if needed."""
    from omnigent.server.private_fund_locale import read_user_locale

    return sync_user_memory_policy(data_namespace, read_user_locale(data_namespace))


def _read_limited_utf8(path: Path) -> str:
    try:
        size = path.stat().st_size
    except OSError:
        return ""
    if size < 0 or size > MAX_MEMORY_FILE_BYTES:
        return ""
    try:
        return path.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError):
        return ""


def read_memory_from_dir(memory_dir: Path) -> str:
    """Read and merge only the two recognized memory files from a trusted directory."""
    root = memory_dir.resolve()
    policy = _read_limited_utf8(root / POLICY_FILE_NAME)
    if not policy:
        try:
            _normalized_namespace(root.parent.name)
            preferences = json.loads(
                (root.parent / "settings" / "preferences.json").read_text(encoding="utf-8")
            )
            locale = preferences.get("preferred_locale") if isinstance(preferences, dict) else None
            policy = policy_text(str(locale))
            _atomic_write(root / POLICY_FILE_NAME, policy)
        except (OSError, UnicodeError, ValueError, TypeError, json.JSONDecodeError):
            policy = policy_text("zh-CN")
    memory = _read_limited_utf8(root / MEMORY_FILE_NAME)
    parts: list[str] = []
    if policy:
        parts.append(f"<user-policy>\n{policy}\n</user-policy>")
    if memory:
        parts.append(f"<user-memory>\n{memory}\n</user-memory>")
    return "\n\n".join(parts)


def read_user_memory(data_namespace: str) -> str:
    """Read one user's current policy and long-term memory."""
    return read_memory_from_dir(ensure_user_memory(data_namespace))


def read_current_user_memory(*, fallback_locale: str = "zh-CN") -> str:
    """Read memory for the bound tenant or trusted Runner environment."""
    tenant = current_tenant()
    if tenant is not None:
        try:
            return read_user_memory(tenant.data_namespace)
        except ValueError:
            return f"<user-policy>\n{policy_text(fallback_locale).strip()}\n</user-policy>"
    configured = os.environ.get(RUNNER_USER_MEMORY_DIR_ENV_VAR)
    if configured:
        return read_memory_from_dir(Path(configured))
    return f"<user-policy>\n{policy_text(fallback_locale).strip()}\n</user-policy>"
