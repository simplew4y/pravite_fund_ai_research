"""Deterministic atom/citation/scope judge adapter for RSI experiments."""

from __future__ import annotations

from typing import Any, Callable

from rsi.models import MetricVector


class CallableJudgeAdapter:
    def __init__(self, scorer: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]) -> None:
        self.scorer = scorer

    def score(self, case: dict[str, Any], target_output: dict[str, Any]) -> MetricVector:
        raw = self.scorer(case, target_output)
        return MetricVector(
            success=float(raw.get("success", 0.0)),
            atomic_correctness=float(raw.get("atomic_correctness", 0.0)),
            citation_support=float(raw.get("citation_support", 0.0)),
            scope_control=float(raw.get("scope_control", 0.0)),
            refusal_quality=float(raw.get("refusal_quality", 0.0)),
            latency_ms=float(raw.get("latency_ms", target_output.get("latency_ms", 0.0))),
            cost_units=float(raw.get("cost_units", target_output.get("cost_units", 0.0))),
            critical_error_count=int(raw.get("critical_error_count", 0)),
            trigger_true_positive=int(raw.get("trigger_true_positive", 0)),
            trigger_false_positive=int(raw.get("trigger_false_positive", 0)),
            mechanism_attributed=bool(raw.get("mechanism_attributed", False)),
        )
