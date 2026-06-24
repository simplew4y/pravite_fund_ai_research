"""Regression-gate data model for skill candidate promotion."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


VALID_DECISIONS = {"proposed", "rejected", "approved_for_implementation", "promoted"}


@dataclass(frozen=True)
class GateDecision:
    candidate_id: str
    decision: str
    reviewer: str
    rationale: str
    eval_summary: dict[str, Any] = field(default_factory=dict)
    required_followups: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.decision not in VALID_DECISIONS:
            raise ValueError(f"invalid gate decision: {self.decision}")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def decide_candidate(
    *,
    candidate_id: str,
    reviewer: str,
    eval_summary: dict[str, Any],
    manual_review_passed: bool,
) -> GateDecision:
    """Return a conservative candidate decision from regression results."""
    regressions = int(eval_summary.get("regression_count") or 0)
    protected_pass = bool(eval_summary.get("protected_sets_passed", False))
    suite_status = eval_summary.get("suite_status") if isinstance(eval_summary.get("suite_status"), dict) else {}
    failed_suites = [
        name
        for name, status in suite_status.items()
        if isinstance(status, str) and status.lower() in {"fail", "failed", "regression"}
    ]
    if failed_suites:
        return GateDecision(
            candidate_id=candidate_id,
            decision="rejected",
            reviewer=reviewer,
            rationale="Staging gate failed on one or more evaluation suites.",
            eval_summary=eval_summary,
            required_followups=[f"Inspect failed suites: {', '.join(failed_suites)}."],
        )
    if regressions:
        return GateDecision(
            candidate_id=candidate_id,
            decision="rejected",
            reviewer=reviewer,
            rationale="Regression gate failed on protected evaluation sets.",
            eval_summary=eval_summary,
            required_followups=["Inspect regressions before re-proposal."],
        )
    if not protected_pass or not manual_review_passed:
        return GateDecision(
            candidate_id=candidate_id,
            decision="proposed",
            reviewer=reviewer,
            rationale="Candidate remains proposed until protected-set and manual-review gates pass.",
            eval_summary=eval_summary,
            required_followups=["Complete protected-set evaluation and manual review."],
        )
    return GateDecision(
        candidate_id=candidate_id,
        decision="approved_for_implementation",
        reviewer=reviewer,
        rationale="No protected-set regressions and manual review passed.",
        eval_summary=eval_summary,
    )
