"""Build a deterministic fresh holdout while keeping answers evaluator-side."""

from __future__ import annotations

import hashlib
from typing import Any, Iterable


def build_holdout(cases: Iterable[dict[str, Any]], *, ratio: float = 0.2, salt: str = "rsi-holdout-v1") -> tuple[list[dict], list[dict]]:
    if not 0.0 < ratio < 1.0:
        raise ValueError("ratio must be between 0 and 1")
    ranked = sorted(cases, key=lambda row: hashlib.sha256(f"{salt}:{row['case_id']}".encode()).hexdigest())
    holdout_count = max(1, round(len(ranked) * ratio)) if ranked else 0
    holdout = ranked[:holdout_count]
    development = ranked[holdout_count:]
    return development, holdout
