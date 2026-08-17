"""Paired baseline/candidate runner with strict target/evaluator separation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Iterable, Protocol

from .metrics import summarize
from .models import MetricVector, PairedObservation


class TargetAdapter(Protocol):
    def run(self, case: dict[str, Any], *, seed: int, candidate_id: str | None) -> dict[str, Any]: ...


class JudgeAdapter(Protocol):
    def score(self, case: dict[str, Any], target_output: dict[str, Any]) -> MetricVector: ...


@dataclass(frozen=True)
class ExperimentResult:
    candidate_id: str
    observations: tuple[PairedObservation, ...]
    summary: dict[str, Any]


def run_paired_experiment(
    *,
    candidate_id: str,
    cases: Iterable[dict[str, Any]],
    seeds: Iterable[int],
    target: TargetAdapter,
    judge: JudgeAdapter,
    bootstrap_samples: int = 2000,
) -> ExperimentResult:
    observations: list[PairedObservation] = []
    for case in cases:
        target_case = _target_view(case)
        for seed in seeds:
            baseline_output = target.run(target_case, seed=seed, candidate_id=None)
            candidate_output = target.run(target_case, seed=seed, candidate_id=candidate_id)
            baseline_metric = judge.score(case, baseline_output)
            candidate_metric = judge.score(case, candidate_output)
            observations.append(PairedObservation(
                case_id=str(case["case_id"]),
                seed=int(seed),
                suite=str(case.get("suite") or "targeted"),
                capability=str(case.get("capability") or "unknown"),
                baseline=baseline_metric,
                candidate=candidate_metric,
            ))
    return ExperimentResult(candidate_id, tuple(observations), summarize(observations, bootstrap_samples=bootstrap_samples))


def _target_view(case: dict[str, Any]) -> dict[str, Any]:
    """Keep hidden judge material outside the target adapter by construction."""
    hidden = {"answer_key", "ground_truth_answer", "key_points", "rubric", "hidden", "judge_key"}
    return {key: value for key, value in case.items() if key not in hidden and not key.startswith("hidden_")}
