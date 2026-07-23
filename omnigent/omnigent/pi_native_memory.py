"""Project-scoped durable memory wiring for native Pi sessions."""

from __future__ import annotations

import hashlib
import os
import re
from collections.abc import Mapping
from pathlib import Path

# Pin the package because Pi extensions execute with the same host authority as
# the Pi process. A floating third-party extension would make every new session
# an implicit code update.
PI_MEMORY_PACKAGE = "npm:pi-memory@0.4.0"
PI_MEMORY_DIR_ENV_VAR = "PI_MEMORY_DIR"
PI_MEMORY_SNAPSHOT_ENV_VAR = "PI_MEMORY_SNAPSHOT"
OMNIGENT_PI_MEMORY_DIR_ENV_VAR = "OMNIGENT_PI_MEMORY_DIR"

_DEFAULT_SNAPSHOT_MODE = "stable"
_MEMORY_ROOT = Path.home() / ".omnigent" / "pi-memory"
_SLUG_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _git_repository_identity(workspace: Path) -> tuple[str, Path] | None:
    """Return ``(repository_name, common_git_dir)`` for *workspace*.

    Resolving the common git directory makes a repository and all of its
    worktrees share one operational memory instead of fragmenting memory by
    checkout path.
    """
    resolved = workspace.expanduser().resolve()
    candidates = (resolved, *resolved.parents)
    for project_root in candidates:
        dot_git = project_root / ".git"
        if dot_git.is_dir():
            return project_root.name, dot_git.resolve()
        if not dot_git.is_file():
            continue
        try:
            first_line = dot_git.read_text(encoding="utf-8").splitlines()[0]
        except (OSError, IndexError):
            continue
        prefix = "gitdir:"
        if not first_line.lower().startswith(prefix):
            continue
        git_dir = Path(first_line[len(prefix) :].strip())
        if not git_dir.is_absolute():
            git_dir = project_root / git_dir
        git_dir = git_dir.resolve()
        common_dir_file = git_dir / "commondir"
        if common_dir_file.is_file():
            try:
                common_dir = Path(common_dir_file.read_text(encoding="utf-8").strip())
                if not common_dir.is_absolute():
                    common_dir = git_dir / common_dir
                git_dir = common_dir.resolve()
            except OSError:
                pass
        repository_name = git_dir.parent.name if git_dir.name == ".git" else project_root.name
        return repository_name, git_dir
    return None


def pi_memory_dir_for_workspace(
    workspace: Path,
    *,
    env: Mapping[str, str] | None = None,
    memory_root: Path | None = None,
) -> Path:
    """Resolve the durable Pi memory directory for *workspace*.

    ``OMNIGENT_PI_MEMORY_DIR`` is the Omnigent-specific override;
    ``PI_MEMORY_DIR`` remains compatible with direct pi-memory configuration.
    Either can point to a single cross-project memory or a mounted remote
    volume. Otherwise, memory is isolated per Git repository (shared by all
    worktrees); non-Git workspaces are isolated by their resolved path.
    """
    env = os.environ if env is None else env
    override = env.get(OMNIGENT_PI_MEMORY_DIR_ENV_VAR, "").strip()
    if not override:
        override = env.get(PI_MEMORY_DIR_ENV_VAR, "").strip()
    if override:
        configured = Path(override).expanduser()
        if not configured.is_absolute():
            configured = workspace / configured
        return configured.resolve()

    resolved_workspace = workspace.expanduser().resolve()
    repository = _git_repository_identity(resolved_workspace)
    if repository is None:
        display_name = resolved_workspace.name or "workspace"
        identity = resolved_workspace
    else:
        display_name, identity = repository
    slug = _SLUG_RE.sub("-", display_name).strip("-._") or "workspace"
    digest = hashlib.sha256(str(identity).encode("utf-8")).hexdigest()[:16]
    root = _MEMORY_ROOT if memory_root is None else memory_root
    return root.expanduser().resolve() / f"{slug}-{digest}"


def prepare_pi_memory_env(
    workspace: Path,
    *,
    env: Mapping[str, str] | None = None,
    memory_root: Path | None = None,
) -> dict[str, str]:
    """Create the workspace memory directory and return Pi launch variables."""
    env = os.environ if env is None else env
    memory_dir = pi_memory_dir_for_workspace(
        workspace,
        env=env,
        memory_root=memory_root,
    )
    has_override = bool(
        env.get(OMNIGENT_PI_MEMORY_DIR_ENV_VAR, "").strip()
        or env.get(PI_MEMORY_DIR_ENV_VAR, "").strip()
    )
    if not has_override:
        memory_dir.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(memory_dir.parent, 0o700)
    memory_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(memory_dir, 0o700)
    snapshot_mode = env.get(PI_MEMORY_SNAPSHOT_ENV_VAR, "").strip()
    if snapshot_mode not in {"stable", "per-turn"}:
        snapshot_mode = _DEFAULT_SNAPSHOT_MODE
    return {
        PI_MEMORY_DIR_ENV_VAR: str(memory_dir),
        PI_MEMORY_SNAPSHOT_ENV_VAR: snapshot_mode,
    }
