"""Tests for project-scoped native Pi memory wiring."""

from __future__ import annotations

import stat
from pathlib import Path

from omnigent.pi_native_memory import (
    OMNIGENT_PI_MEMORY_DIR_ENV_VAR,
    PI_MEMORY_DIR_ENV_VAR,
    PI_MEMORY_SNAPSHOT_ENV_VAR,
    pi_memory_dir_for_workspace,
    prepare_pi_memory_env,
)


def test_git_repository_and_worktree_share_memory_dir(tmp_path: Path) -> None:
    """A repository and its linked worktree resolve to one durable memory."""
    repository = tmp_path / "fund-research"
    common_git_dir = repository / ".git"
    common_git_dir.mkdir(parents=True)

    worktree = tmp_path / "research-branch"
    worktree.mkdir()
    worktree_git_dir = common_git_dir / "worktrees" / "research-branch"
    worktree_git_dir.mkdir(parents=True)
    (worktree / ".git").write_text(
        f"gitdir: {worktree_git_dir}\n",
        encoding="utf-8",
    )
    (worktree_git_dir / "commondir").write_text("../..\n", encoding="utf-8")

    memory_root = tmp_path / "memory"
    from_repository = pi_memory_dir_for_workspace(
        repository,
        env={},
        memory_root=memory_root,
    )
    from_worktree = pi_memory_dir_for_workspace(
        worktree,
        env={},
        memory_root=memory_root,
    )

    assert from_worktree == from_repository
    assert from_repository.name.startswith("fund-research-")


def test_non_git_workspaces_are_isolated(tmp_path: Path) -> None:
    """Unrelated directories never share the default operational memory."""
    first = tmp_path / "fund-a"
    second = tmp_path / "fund-b"
    first.mkdir()
    second.mkdir()

    first_dir = pi_memory_dir_for_workspace(first, env={}, memory_root=tmp_path / "memory")
    second_dir = pi_memory_dir_for_workspace(second, env={}, memory_root=tmp_path / "memory")

    assert first_dir != second_dir


def test_explicit_memory_dir_override_supports_relative_paths(tmp_path: Path) -> None:
    """Operators can deliberately opt into a shared/mounted memory directory."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    resolved = pi_memory_dir_for_workspace(
        workspace,
        env={OMNIGENT_PI_MEMORY_DIR_ENV_VAR: ".state/pi-memory"},
        memory_root=tmp_path / "ignored",
    )

    assert resolved == (workspace / ".state" / "pi-memory").resolve()


def test_pi_memory_native_override_remains_compatible(tmp_path: Path) -> None:
    """An existing pi-memory setup is not replaced by Omnigent defaults."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    resolved = pi_memory_dir_for_workspace(
        workspace,
        env={PI_MEMORY_DIR_ENV_VAR: str(tmp_path / "shared-memory")},
        memory_root=tmp_path / "ignored",
    )

    assert resolved == (tmp_path / "shared-memory").resolve()


def test_prepare_memory_env_creates_owner_only_dir_and_stable_snapshot(
    tmp_path: Path,
) -> None:
    """The launch env is deterministic and the memory directory is private."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    launch_env = prepare_pi_memory_env(
        workspace,
        env={},
        memory_root=tmp_path / "memory",
    )

    memory_dir = Path(launch_env[PI_MEMORY_DIR_ENV_VAR])
    assert memory_dir.is_dir()
    assert stat.S_IMODE(memory_dir.parent.stat().st_mode) == 0o700
    assert stat.S_IMODE(memory_dir.stat().st_mode) == 0o700
    assert launch_env[PI_MEMORY_SNAPSHOT_ENV_VAR] == "stable"


def test_prepare_memory_env_respects_valid_snapshot_mode(tmp_path: Path) -> None:
    """Pi's per-turn mode remains available as an explicit operator choice."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    launch_env = prepare_pi_memory_env(
        workspace,
        env={PI_MEMORY_SNAPSHOT_ENV_VAR: "per-turn"},
        memory_root=tmp_path / "memory",
    )

    assert launch_env[PI_MEMORY_SNAPSHOT_ENV_VAR] == "per-turn"
