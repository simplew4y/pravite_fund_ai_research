"""Conservative promotion policy; style scores cannot offset critical errors."""

from __future__ import annotations

from typing import Any

from .models import CandidatePatch, PromotionDecision


DEFAULT_POLICY = {
    "version": "promotion-policy/v1",
    "fresh_success_delta_min": 0.03,
    "fresh_success_ci_lower_min": 0.0,
    "protected_success_delta_min": -0.01,
    "citation_support_delta_min": 0.0,
    "scope_control_delta_min": 0.0,
    "atomic_correctness_delta_min": 0.0,
    "refusal_quality_delta_min": 0.0,
    "latency_relative_max": 0.15,
    "cost_relative_max": 0.20,
    "mechanism_attribution_min": 0.80,
    "critical_error_max": 0,
    "trigger_false_positive_max": 0,
}


def decide_promotion(candidate: CandidatePatch, summary: dict[str, Any], policy: dict[str, Any] | None = None) -> PromotionDecision:
    policy = {**DEFAULT_POLICY, **(policy or {})}
    reasons: list[str] = []
    metrics = summary.get("metrics", {})
    suites = summary.get("slices", {}).get("suite", {})
    fresh = suites.get("fresh_internal") or suites.get("targeted") or {}
    protected = suites.get("protected") or {}
    success = metrics.get("success", {})

    if int(summary.get("critical_error_count", 0)) > int(policy["critical_error_max"]):
        reasons.append("critical errors exceed policy")
    if int(summary.get("trigger_false_positive_count", 0)) > int(policy["trigger_false_positive_max"]):
        reasons.append("negative/no-op trigger false positives exceed policy")
    fresh_delta = float(fresh.get("success_delta", success.get("paired_delta", 0.0)))
    if fresh_delta < float(policy["fresh_success_delta_min"]):
        reasons.append("fresh/targeted success gain below minimum")
    ci_lower = float((fresh.get("success_ci95") or success.get("ci95") or [0.0])[0])
    if ci_lower < float(policy["fresh_success_ci_lower_min"]):
        reasons.append("success gain confidence interval crosses policy floor")
    if protected and float(protected.get("success_delta", 0.0)) < float(policy["protected_success_delta_min"]):
        reasons.append("protected-set regression exceeds tolerance")
    for field, threshold_name in (
        ("atomic_correctness", "atomic_correctness_delta_min"),
        ("citation_support", "citation_support_delta_min"),
        ("scope_control", "scope_control_delta_min"),
        ("refusal_quality", "refusal_quality_delta_min"),
    ):
        if float(metrics.get(field, {}).get("paired_delta", 0.0)) < float(policy[threshold_name]):
            reasons.append(f"{field} regressed")
    for field, threshold_name in (("latency_ms", "latency_relative_max"), ("cost_units", "cost_relative_max")):
        metric = metrics.get(field, {})
        baseline = float(metric.get("baseline_p95" if field == "latency_ms" else "baseline_mean", 0.0))
        candidate_value = float(metric.get("candidate_p95" if field == "latency_ms" else "candidate_mean", 0.0))
        if baseline > 0 and (candidate_value - baseline) / baseline > float(policy[threshold_name]):
            reasons.append(f"{field} overhead exceeds budget")
    if float(summary.get("mechanism_attribution_rate", 0.0)) < float(policy["mechanism_attribution_min"]):
        reasons.append("mechanism attribution rate below minimum")

    decision = "rejected" if reasons else "eligible_for_human_review"
    return PromotionDecision(
        candidate_id=candidate.candidate_id,
        decision=decision,
        reasons=tuple(reasons or ["all automated gates passed; explicit human approval remains required"]),
        metrics=summary,
        policy_version=str(policy["version"]),
        requires_human_approval=True,
    )
