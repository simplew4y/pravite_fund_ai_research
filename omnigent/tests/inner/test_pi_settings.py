"""Tests for managed Pi agent dir seeding (extensions / packages)."""

from __future__ import annotations

import json
from pathlib import Path

from omnigent.inner.pi_settings import prepare_managed_pi_agent_dir


def test_prepare_managed_pi_agent_dir_copies_settings_and_symlinks_npm(
    tmp_path: Path,
) -> None:
    """Gateway managed dir gets global settings metadata and npm install tree."""
    global_agent = tmp_path / "global-agent"
    global_agent.mkdir()
    (global_agent / "settings.json").write_text(
        json.dumps(
            {
                "extensions": ["/tmp/my-ext.ts"],
                "packages": ["npm:@foo/bar"],
            }
        ),
        encoding="utf-8",
    )
    npm_dir = global_agent / "npm" / "foo"
    npm_dir.mkdir(parents=True)

    managed = tmp_path / "managed"
    managed.mkdir()
    (managed / "models.json").write_text("{}", encoding="utf-8")

    prepare_managed_pi_agent_dir(
        managed,
        overlay={"retry": {"maxRetries": 5}},
        global_agent_dir=global_agent,
    )

    written = json.loads((managed / "settings.json").read_text(encoding="utf-8"))
    assert written["extensions"] == ["/tmp/my-ext.ts"]
    assert written["packages"] == ["npm:@foo/bar"]
    assert written["retry"] == {"maxRetries": 5}
    assert (managed / "npm").is_symlink()
    assert (managed / "npm").resolve() == (global_agent / "npm").resolve()


def test_prepare_managed_pi_agent_dir_empty_global_writes_overlay_only(
    tmp_path: Path,
) -> None:
    """Missing global settings still writes the Omnigent overlay."""
    global_agent = tmp_path / "empty-global"
    global_agent.mkdir()
    managed = tmp_path / "managed"
    managed.mkdir()

    prepare_managed_pi_agent_dir(
        managed,
        overlay={"retry": {"enabled": True}},
        global_agent_dir=global_agent,
    )

    written = json.loads((managed / "settings.json").read_text(encoding="utf-8"))
    assert written == {"retry": {"enabled": True}}


def test_prepare_managed_pi_agent_dir_deep_merges_nested_overlay(tmp_path: Path) -> None:
    """Nested settings (e.g. compaction) merge like Pi project overrides."""
    global_agent = tmp_path / "global-agent"
    global_agent.mkdir()
    (global_agent / "settings.json").write_text(
        json.dumps({"compaction": {"enabled": True, "reserveTokens": 16384}}),
        encoding="utf-8",
    )
    managed = tmp_path / "managed"
    managed.mkdir()

    prepare_managed_pi_agent_dir(
        managed,
        overlay={"compaction": {"reserveTokens": 8192}},
        global_agent_dir=global_agent,
    )

    written = json.loads((managed / "settings.json").read_text(encoding="utf-8"))
    assert written["compaction"] == {
        "enabled": True,
        "reserveTokens": 8192,
    }


def test_prepare_managed_pi_agent_dir_preserves_settings_and_requires_package(
    tmp_path: Path,
) -> None:
    """Required packages append without replacing global or session settings."""
    global_agent = tmp_path / "global-agent"
    global_agent.mkdir()
    (global_agent / "npm").mkdir()
    (global_agent / "settings.json").write_text(
        json.dumps(
            {
                "packages": [
                    "npm:@team/global-tools",
                    {"source": "npm:pi-memory@0.4.0", "skills": []},
                ]
            }
        ),
        encoding="utf-8",
    )
    managed = tmp_path / "managed"
    managed.mkdir()
    (managed / "settings.json").write_text(
        json.dumps({"theme": "light"}),
        encoding="utf-8",
    )

    prepare_managed_pi_agent_dir(
        managed,
        global_agent_dir=global_agent,
        required_packages=("npm:pi-memory@0.4.0",),
        isolate_resources=True,
    )

    written = json.loads((managed / "settings.json").read_text(encoding="utf-8"))
    assert written["theme"] == "light"
    assert written["packages"] == [
        "npm:@team/global-tools",
        {"source": "npm:pi-memory@0.4.0", "skills": []},
    ]
    assert not (managed / "npm").exists()


def test_prepare_managed_pi_agent_dir_copies_ambient_config_once(tmp_path: Path) -> None:
    """Managed Pi keeps ambient login/models without overwriting local state."""
    global_agent = tmp_path / "global-agent"
    global_agent.mkdir()
    (global_agent / "auth.json").write_text('{"token":"ambient"}', encoding="utf-8")
    (global_agent / "models.json").write_text('{"providers":{"ambient":{}}}', encoding="utf-8")
    managed = tmp_path / "managed"
    managed.mkdir()
    (managed / "auth.json").write_text('{"token":"session"}', encoding="utf-8")

    prepare_managed_pi_agent_dir(
        managed,
        global_agent_dir=global_agent,
    )

    assert json.loads((managed / "auth.json").read_text(encoding="utf-8")) == {"token": "session"}
    assert json.loads((managed / "models.json").read_text(encoding="utf-8")) == {
        "providers": {"ambient": {}}
    }
