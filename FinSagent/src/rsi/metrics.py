"""Paired metrics, deterministic bootstrap confidence intervals, and slices."""

from __future__ import annotations

import math
import random
from collections import defaultdict
from typing import Callable, Iterable

from .models import MetricVector, PairedObservation


METRIC_FIELDS = (
    "success",
    "atomic_correctness",
    "citation_support",
    "scope_control",
    "refusal_quality",
    "latency_ms",
    "cost_units",
)


def mean(values: Iterable[float]) -> float:
    rows = list(values)
    return sum(rows) / len(rows) if rows else 0.0


def percentile(values: list[float], quantile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = (len(ordered) - 1) * quantile
    lower = math.floor(index)
    upper = math.ceil(index)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] * (upper - index) + ordered[upper] * (index - lower)


def paired_delta(rows: list[PairedObservation], field: str) -> float:
    if field not in METRIC_FIELDS:
        raise ValueError(f"unsupported metric: {field}")
    return mean(float(getattr(row.candidate, field)) - float(getattr(row.baseline, field)) for row in rows)


def bootstrap_paired_ci(
    rows: list[PairedObservation],
    field: str,
    *,
    samples: int = 2000,
    confidence: float = 0.95,
    seed: int = 20260817,
) -> tuple[float, float]:
    if not rows:
        return 0.0, 0.0
    rng = random.Random(seed)
    deltas = [float(getattr(row.candidate, field)) - float(getattr(row.baseline, field)) for row in rows]
    draws = [mean(deltas[rng.randrange(len(deltas))] for _ in deltas) for _ in range(samples)]
    alpha = (1.0 - confidence) / 2.0
    return percentile(draws, alpha), percentile(draws, 1.0 - alpha)


def summarize(rows: list[PairedObservation], *, bootstrap_samples: int = 2000) -> dict:
    summary: dict = {"observation_count": len(rows), "metrics": {}}
    for field in METRIC_FIELDS:
        lower, upper = bootstrap_paired_ci(rows, field, samples=bootstrap_samples)
        summary["metrics"][field] = {
            "baseline_mean": mean(float(getattr(row.baseline, field)) for row in rows),
            "candidate_mean": mean(float(getattr(row.candidate, field)) for row in rows),
            "paired_delta": paired_delta(rows, field),
            "ci95": [lower, upper],
            "baseline_p95": percentile([float(getattr(row.baseline, field)) for row in rows], 0.95),
            "candidate_p95": percentile([float(getattr(row.candidate, field)) for row in rows], 0.95),
        }
    summary["critical_error_count"] = sum(row.candidate.critical_error_count for row in rows)
    summary["trigger_false_positive_count"] = sum(row.candidate.trigger_false_positive for row in rows)
    summary["trigger_true_positive_count"] = sum(row.candidate.trigger_true_positive for row in rows)
    summary["mechanism_attribution_rate"] = mean(float(row.candidate.mechanism_attributed) for row in rows)
    by_suite: dict[str, list[PairedObservation]] = defaultdict(list)
    by_capability: dict[str, list[PairedObservation]] = defaultdict(list)
    for row in rows:
        by_suite[row.suite].append(row)
        by_capability[row.capability].append(row)
    summary["slices"] = {
        "suite": {key: _slice(value, bootstrap_samples) for key, value in sorted(by_suite.items())},
        "capability": {key: _slice(value, bootstrap_samples) for key, value in sorted(by_capability.items())},
    }
    return summary


def _slice(rows: list[PairedObservation], bootstrap_samples: int) -> dict:
    success_ci = bootstrap_paired_ci(rows, "success", samples=bootstrap_samples)
    return {
        "count": len(rows),
        "success_delta": paired_delta(rows, "success"),
        "success_ci95": list(success_ci),
        "atomic_correctness_delta": paired_delta(rows, "atomic_correctness"),
        "citation_support_delta": paired_delta(rows, "citation_support"),
        "scope_control_delta": paired_delta(rows, "scope_control"),
        "refusal_quality_delta": paired_delta(rows, "refusal_quality"),
        "critical_error_count": sum(row.candidate.critical_error_count for row in rows),
    }
