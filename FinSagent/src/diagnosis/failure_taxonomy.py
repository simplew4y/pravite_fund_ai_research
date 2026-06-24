"""Failure taxonomy constants for SEC QA diagnosis."""

from __future__ import annotations

FAILURE_TYPES = {
    "retrieval_miss",
    "wrong_source",
    "period_mismatch",
    "table_alignment_error",
    "metric_alias_error",
    "answer_coverage_failure",
    "source_conflict",
    "profile_boundary_error",
}


def normalize_failure_type(value: str) -> str:
    if value not in FAILURE_TYPES:
        raise ValueError(f"unknown failure type: {value}")
    return value

