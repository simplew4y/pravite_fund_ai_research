"""Materialize a policy-approved candidate in an isolated Git worktree."""

from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path

from .models import CandidatePatch
from .patch_policy import normalize_repo_path, validate_candidate


@dataclass(frozen=True)
class MaterializedCandidate:
    candidate_id: str
    base_commit: str
    worktree: str
    patch_sha256: str
    changed_paths: tuple[str, ...]

    def to_dict(self) -> dict:
        return asdict(self)


def patch_targets(patch_path: str | Path) -> tuple[str, ...]:
    targets: list[str] = []
    for line in Path(patch_path).read_text(encoding="utf-8").splitlines():
        if not line.startswith("+++ "):
            continue
        raw = line[4:].split("\t", 1)[0].strip()
        if raw == "/dev/null":
            continue
        if raw.startswith("b/"):
            raw = raw[2:]
        if raw.startswith("FinSagent/"):
            raw = raw[len("FinSagent/"):]
        targets.append(normalize_repo_path(raw))
    return tuple(dict.fromkeys(targets))


def materialize_candidate(
    *,
    repo_root: str | Path,
    baseline_ref: str,
    workspace: str | Path,
    candidate: CandidatePatch,
    patch_path: str | Path,
) -> MaterializedCandidate:
    policy = validate_candidate(candidate)
    if not policy.allowed:
        raise ValueError("candidate violates mutation policy: " + "; ".join(policy.reasons))
    repo = Path(repo_root).resolve()
    worktree = Path(workspace).resolve()
    if worktree.exists():
        raise FileExistsError(f"candidate workspace already exists: {worktree}")
    patch = Path(patch_path).resolve()
    changed_paths = patch_targets(patch)
    if set(changed_paths) != set(candidate.target_paths):
        raise ValueError(f"patch targets {changed_paths} do not match declared targets {candidate.target_paths}")
    base_commit = _run(("git", "rev-parse", baseline_ref), repo).strip()
    worktree.parent.mkdir(parents=True, exist_ok=True)
    _run(("git", "worktree", "add", "--detach", str(worktree), base_commit), repo)
    try:
        _run(("git", "apply", "--check", str(patch)), worktree)
        _run(("git", "apply", str(patch)), worktree)
    except Exception:
        _run(("git", "worktree", "remove", "--force", str(worktree)), repo, check=False)
        raise
    digest = hashlib.sha256(patch.read_bytes()).hexdigest()
    result = MaterializedCandidate(candidate.candidate_id, base_commit, str(worktree), digest, changed_paths)
    (worktree / ".rsi_candidate.json").write_text(json.dumps(result.to_dict(), indent=2) + "\n", encoding="utf-8")
    return result


def _run(command: tuple[str, ...], cwd: Path, *, check: bool = True) -> str:
    completed = subprocess.run(command, cwd=cwd, text=True, capture_output=True, check=False)
    if check and completed.returncode:
        raise RuntimeError(f"command failed ({completed.returncode}): {' '.join(command)}\n{completed.stderr}")
    return completed.stdout
