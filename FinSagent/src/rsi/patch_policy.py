"""Mutation whitelist and immutable-boundary enforcement."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Iterable

from .models import CandidatePatch, MutationLevel


@dataclass(frozen=True)
class PolicyResult:
    allowed: bool
    reasons: tuple[str, ...]
    requires_human_approval: bool


DEFAULT_ALLOWED_ROOTS = {
    MutationLevel.PARAMETER: ("configs/rsi/candidates/",),
    MutationLevel.PROMPT: ("src/agents/",),
    MutationLevel.SKILL: ("src/utils/", "src/skillops/", "src/rsi/candidate_skills/"),
    MutationLevel.MEMORY_POLICY: ("src/memory/", "configs/rsi/memory/"),
    MutationLevel.WORKFLOW: ("src/core/",),
}

FORBIDDEN_PREFIXES = (
    ".git/",
    "evaluation/",
    "test/",
    "configs/eval_suites/",
    "configs/skill_cards/",
    "config/production.yaml",
    "data/",
    "ygdy_data/",
    "test_real_data/",
)

FORBIDDEN_CONTENT_MARKERS = (
    "ground_truth_answer",
    "hidden_answer",
    "judge_key",
    "evaluator_secret",
    "disable_safety",
    "bypass_permission",
)


def normalize_repo_path(value: str) -> str:
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"path must be repository-relative without traversal: {value}")
    return str(path)


def validate_candidate(
    candidate: CandidatePatch,
    *,
    allowed_roots: dict[MutationLevel, Iterable[str]] | None = None,
) -> PolicyResult:
    roots = allowed_roots or DEFAULT_ALLOWED_ROOTS
    reasons: list[str] = []
    for raw_path in candidate.target_paths:
        try:
            path = normalize_repo_path(raw_path)
        except ValueError as error:
            reasons.append(str(error))
            continue
        if any(path == prefix.rstrip("/") or path.startswith(prefix) for prefix in FORBIDDEN_PREFIXES):
            reasons.append(f"immutable or forbidden target: {path}")
            continue
        allowed = tuple(str(root) for root in roots.get(candidate.mutation_level, ()))
        if not any(path == root.rstrip("/") or path.startswith(root) for root in allowed):
            reasons.append(f"L{int(candidate.mutation_level)} cannot mutate {path}")
    serialized = str(candidate.patch_payload).casefold()
    for marker in FORBIDDEN_CONTENT_MARKERS:
        if marker in serialized:
            reasons.append(f"forbidden content marker: {marker}")
    approval = candidate.requires_human_approval or candidate.mutation_level >= MutationLevel.WORKFLOW
    return PolicyResult(not reasons, tuple(reasons), approval)
