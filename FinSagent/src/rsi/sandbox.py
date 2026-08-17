"""Build a sandbox execution plan without granting shell or production permissions."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .models import CandidatePatch
from .patch_policy import validate_candidate


@dataclass(frozen=True)
class SandboxPlan:
    candidate_id: str
    workspace: str
    read_only_inputs: tuple[str, ...]
    writable_outputs: tuple[str, ...]
    network_enabled: bool
    approved_commands: tuple[tuple[str, ...], ...]


def build_sandbox_plan(candidate: CandidatePatch, workspace: str | Path) -> SandboxPlan:
    policy = validate_candidate(candidate)
    if not policy.allowed:
        raise ValueError("candidate violates mutation policy: " + "; ".join(policy.reasons))
    root = Path(workspace)
    if not root.is_absolute():
        raise ValueError("sandbox workspace must be an explicit absolute path")
    return SandboxPlan(
        candidate_id=candidate.candidate_id,
        workspace=str(root),
        read_only_inputs=("evaluation/benchmarks", "configs/eval_suites"),
        writable_outputs=("results/rsi", "artifacts/rsi"),
        network_enabled=False,
        approved_commands=(("python", "-m", "unittest"), ("python", "-m", "evaluation.rsi_benchmark.cli")),
    )
