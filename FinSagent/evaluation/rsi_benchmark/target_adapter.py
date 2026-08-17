"""Evaluator-side adapter for invoking a target without exposing hidden fields."""

from __future__ import annotations

from typing import Any, Callable


class CallableTargetAdapter:
    def __init__(self, runner: Callable[[dict[str, Any], int, str | None], dict[str, Any]]) -> None:
        self.runner = runner

    def run(self, case: dict[str, Any], *, seed: int, candidate_id: str | None) -> dict[str, Any]:
        forbidden = {"answer_key", "ground_truth_answer", "key_points", "rubric", "judge_key"}
        leaked = forbidden.intersection(case)
        if leaked or any(key.startswith("hidden_") for key in case):
            raise ValueError(f"target case contains evaluator-only fields: {sorted(leaked)}")
        return self.runner(case, seed, candidate_id)
