"""Persist paired baseline/candidate results and promotion recommendations."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

from rsi.experiment import JudgeAdapter, TargetAdapter, run_paired_experiment
from rsi.models import CandidatePatch
from rsi.promotion import decide_promotion


def compare_candidate(
    candidate: CandidatePatch,
    cases: Iterable[dict[str, Any]],
    *,
    target: TargetAdapter,
    judge: JudgeAdapter,
    seeds: Iterable[int] = (11, 29, 47),
    out_dir: str | Path | None = None,
) -> dict[str, Any]:
    result = run_paired_experiment(candidate_id=candidate.candidate_id, cases=cases, seeds=seeds, target=target, judge=judge)
    decision = decide_promotion(candidate, result.summary)
    payload = {
        "schema_version": "rsi-paired-experiment/v1",
        "candidate": candidate.to_dict(),
        "summary": result.summary,
        "promotion_decision": decision.to_dict(),
        "observations": [row.to_dict() for row in result.observations],
    }
    if out_dir is not None:
        destination = Path(out_dir)
        destination.mkdir(parents=True, exist_ok=True)
        (destination / f"{candidate.candidate_id}.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    return payload
