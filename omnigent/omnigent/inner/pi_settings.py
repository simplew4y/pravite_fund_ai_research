"""Helpers for seeding a managed Pi agent dir (``PI_CODING_AGENT_DIR``).

When the pi harness runs in gateway mode it relocates Pi's agent root to a
per-session temp directory (for ``models.json``). That hides the user's global
``~/.pi/agent/settings.json`` and installed package trees. This module copies
the global settings metadata into the managed dir and symlinks install
directories so Pi's native loader still sees extensions and ``pi install``
packages — without mutating the user's home directory.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
from collections.abc import Sequence
from pathlib import Path
from typing import Any

_logger = logging.getLogger(__name__)

# Default global Pi agent root (``PI_CODING_AGENT_DIR`` when unset).
DEFAULT_PI_AGENT_DIR = Path.home() / ".pi" / "agent"

# Install / checkout trees Pi places under the agent dir. Symlinked into the
# managed dir so ``packages`` entries in settings keep resolving.
_PI_AGENT_RESOURCE_DIRS: tuple[str, ...] = ("npm", "git")

# Pi's ambient login and custom provider catalog must remain available when
# Omnigent relocates PI_CODING_AGENT_DIR. Copy (rather than symlink) them so a
# managed session can never overwrite the user's global credentials/config.
_PI_AGENT_CONFIG_FILES: tuple[str, ...] = ("auth.json", "models.json")


def _read_settings_file(path: Path) -> dict[str, Any]:
    """Load a Pi ``settings.json`` file, returning ``{}`` when absent/invalid."""
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        _logger.warning("Ignoring unreadable Pi settings at %s: %s", path, exc)
        return {}
    return raw if isinstance(raw, dict) else {}


def _deep_merge_settings(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """Merge *overlay* onto *base* using Pi's nested-object merge semantics."""
    merged = dict(base)
    for key, value in overlay.items():
        existing = merged.get(key)
        if isinstance(existing, dict) and isinstance(value, dict):
            merged[key] = _deep_merge_settings(existing, value)
        else:
            merged[key] = value
    return merged


def _symlink_agent_resource_dirs(
    managed_dir: Path,
    global_agent_dir: Path,
) -> None:
    """Symlink package install trees from *global_agent_dir* into *managed_dir*."""
    for name in _PI_AGENT_RESOURCE_DIRS:
        source = global_agent_dir / name
        if not source.is_dir():
            continue
        target = managed_dir / name
        if target.exists():
            continue
        try:
            target.symlink_to(source, target_is_directory=True)
        except OSError as exc:
            _logger.warning(
                "Could not symlink Pi agent resource %s -> %s: %s",
                target,
                source,
                exc,
            )


def _copy_agent_config_files(
    managed_dir: Path,
    global_agent_dir: Path,
) -> None:
    """Copy ambient Pi login/provider files into a new managed agent dir."""
    for name in _PI_AGENT_CONFIG_FILES:
        source = global_agent_dir / name
        target = managed_dir / name
        if not source.is_file() or target.exists():
            continue
        try:
            shutil.copy2(source, target)
        except OSError as exc:
            _logger.warning(
                "Could not copy Pi agent config %s -> %s: %s",
                source,
                target,
                exc,
            )


def _package_source(value: Any) -> str | None:
    """Return the package source from a Pi string/object package entry."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        source = value.get("source")
        return source if isinstance(source, str) else None
    return None


def _ensure_packages(settings: dict[str, Any], packages: Sequence[str]) -> None:
    """Append required Pi packages without replacing operator packages."""
    if not packages:
        return
    configured = settings.get("packages")
    if not isinstance(configured, list):
        configured = []
    existing_sources = {
        source for entry in configured if (source := _package_source(entry)) is not None
    }
    for package in packages:
        if package not in existing_sources:
            configured.append(package)
            existing_sources.add(package)
    settings["packages"] = configured


def prepare_managed_pi_agent_dir(
    managed_dir: Path,
    *,
    overlay: dict[str, Any] | None = None,
    global_agent_dir: Path | None = None,
    required_packages: Sequence[str] = (),
    isolate_resources: bool = False,
) -> None:
    """
    Seed a managed ``PI_CODING_AGENT_DIR`` with the user's global Pi settings.

    Copies (merges) ``settings.json`` from the user's global agent dir into
    *managed_dir*, preserves existing session-local settings, applies *overlay*
    (e.g. Omnigent retry policy), and normally symlinks install trees
    (``npm/``, ``git/``) so ``packages`` entries keep working. Isolated callers
    keep those trees local. Ambient ``auth.json`` and ``models.json`` are copied
    only when the managed dir does not already have them. The user's
    ``~/.pi/agent`` is never modified.

    Project-scoped ``.pi/settings.json`` at the session cwd is still read by
    Pi at runtime and overrides these global settings per Pi's normal rules.

    :param managed_dir: Per-session agent root (already contains ``models.json``).
    :param overlay: Settings merged on top of the copied global file.
    :param global_agent_dir: Override for tests; defaults to
        :data:`DEFAULT_PI_AGENT_DIR`.
    :param required_packages: Pinned packages that must be present in addition
        to operator-configured packages.
    :param isolate_resources: Keep ``npm/`` and ``git/`` local to the managed
        dir instead of symlinking the user's global install trees. Required
        when Omnigent may auto-install additional packages.
    """
    agent_root = global_agent_dir if global_agent_dir is not None else DEFAULT_PI_AGENT_DIR
    settings = _read_settings_file(agent_root / "settings.json")
    existing = _read_settings_file(managed_dir / "settings.json")
    settings = _deep_merge_settings(settings, existing)
    if overlay:
        settings = _deep_merge_settings(settings, overlay)
    _ensure_packages(settings, required_packages)

    managed_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(managed_dir, 0o700)
    _copy_agent_config_files(managed_dir, agent_root)
    settings_path = managed_dir / "settings.json"
    try:
        settings_path.write_text(
            json.dumps(settings, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    except OSError as exc:
        _logger.warning("Could not write managed Pi settings at %s: %s", settings_path, exc)
        return

    if not isolate_resources:
        _symlink_agent_resource_dirs(managed_dir, agent_root)
