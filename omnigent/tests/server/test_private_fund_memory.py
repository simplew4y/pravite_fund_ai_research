from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest

from omnigent.server import private_fund_memory
from omnigent.server.private_fund_locale import write_user_locale


def _namespace(seed: int) -> str:
    return f"00000000-0000-0000-0000-{seed:012d}"


def test_locale_write_creates_isolated_owner_only_memory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(private_fund_memory, "project_root", lambda: tmp_path)
    monkeypatch.setattr("omnigent.server.private_fund_locale.project_root", lambda: tmp_path)

    english = _namespace(1)
    chinese = _namespace(2)
    write_user_locale(english, "en-US")
    write_user_locale(chinese, "zh-CN")

    english_root = private_fund_memory.user_memory_dir(english)
    chinese_root = private_fund_memory.user_memory_dir(chinese)
    assert "must be written in English" in (english_root / "POLICY.md").read_text()
    assert "必须使用简体中文" in (chinese_root / "POLICY.md").read_text()
    assert (english_root / "MEMORY.md").read_text() == ""
    assert stat.S_IMODE(english_root.stat().st_mode) == 0o700
    assert stat.S_IMODE((english_root / "POLICY.md").stat().st_mode) == 0o600
    assert english_root != chinese_root


def test_memory_reader_rebuilds_corrupt_policy_and_ignores_oversized_memory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(private_fund_memory, "project_root", lambda: tmp_path)
    monkeypatch.setattr("omnigent.server.private_fund_locale.project_root", lambda: tmp_path)
    namespace = _namespace(3)
    write_user_locale(namespace, "en-US")
    root = private_fund_memory.user_memory_dir(namespace)
    (root / "POLICY.md").write_bytes(b"\xff\xfe")
    (root / "MEMORY.md").write_text(
        "x" * (private_fund_memory.MAX_MEMORY_FILE_BYTES + 1), encoding="utf-8"
    )

    context = private_fund_memory.read_memory_from_dir(root)

    assert "must be written in English" in context
    assert "x" * 100 not in context
    assert (root / "POLICY.md").read_text(encoding="utf-8").startswith("# User Policy")


def test_memory_reader_includes_optional_long_term_memory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(private_fund_memory, "project_root", lambda: tmp_path)
    monkeypatch.setattr("omnigent.server.private_fund_locale.project_root", lambda: tmp_path)
    namespace = _namespace(4)
    write_user_locale(namespace, "zh-CN")
    root = private_fund_memory.user_memory_dir(namespace)
    (root / "MEMORY.md").write_text("偏好先给结论。\n", encoding="utf-8")

    context = private_fund_memory.read_user_memory(namespace)

    assert "<user-policy>" in context
    assert "<user-memory>\n偏好先给结论。\n</user-memory>" in context


def test_user_memory_rejects_non_uuid_namespace(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        private_fund_memory.user_memory_dir("../../other-user")


def test_policy_recovery_defaults_to_chinese_when_preferences_are_invalid(tmp_path: Path) -> None:
    root = tmp_path / _namespace(5) / "memory"
    root.mkdir(parents=True)
    settings = root.parent / "settings"
    settings.mkdir()
    (settings / "preferences.json").write_text(json.dumps({"preferred_locale": "xx"}))

    context = private_fund_memory.read_memory_from_dir(root)

    assert "必须使用简体中文" in context
