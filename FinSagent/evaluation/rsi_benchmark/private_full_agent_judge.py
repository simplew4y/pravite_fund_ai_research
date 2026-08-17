"""Build private judge inputs by joining hidden rubrics after target execution."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Iterable


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _write_private_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def build_private_judge_inputs(
    private_cases: Path, target_outputs: Path, private_out_dir: Path,
) -> dict[str, Any]:
    """Join by case_id; hidden content never enters the target-output directory."""
    private_out_dir.mkdir(parents=True, exist_ok=False, mode=0o700)
    os.chmod(private_out_dir, 0o700)
    cases = _load_jsonl(private_cases)
    outputs = _load_jsonl(target_outputs)
    case_map = {str(row["case_id"]): row for row in cases}
    if len(case_map) != len(cases):
        raise ValueError("duplicate case_id in private evaluator")

    judge_rows: list[dict[str, Any]] = []
    generated_rows: list[dict[str, Any]] = []
    seen = set()
    for output in outputs:
        case_id = str(output.get("case_id") or "")
        seed = int(output.get("seed"))
        identity = (case_id, seed)
        if not case_id or case_id not in case_map:
            raise ValueError(f"target output case is not in private evaluator: {case_id}")
        if identity in seen:
            raise ValueError(f"duplicate target output: {identity}")
        seen.add(identity)
        case = case_map[case_id]
        rubric = case["rubric"]
        qid = f"{case_id}::seed::{seed}"
        judge_rows.append({
            "qid": qid,
            "case_id": case_id,
            "seed": seed,
            "question": case["target"]["question"],
            "ground_truth_answer": rubric["ground_truth_answer"],
            "key_points": rubric["key_points"],
            "diagnostic_meta": {
                "suite": case["suite"],
                "capability": case["capability"],
                "company": case["company"],
                "critical_errors": rubric.get("critical_errors", []),
                "expected_period_markers": rubric.get("expected_period_markers", []),
                "expected_skill_trigger": rubric.get("expected_skill_trigger"),
            },
        })
        generated_rows.append({
            "qid": qid,
            "case_id": case_id,
            "seed": seed,
            "question": case["target"]["question"],
            "answer": str(output.get("answer") or ""),
            "diagnostic_meta": {
                "arm": output.get("arm"),
                "candidate_id": output.get("candidate_id"),
                "activated_agents": output.get("activated_agents", []),
                "skill_traces": output.get("skill_traces", []),
                "target_error": output.get("error"),
            },
        })

    judge_path = private_out_dir / "judge_key.private.jsonl"
    generated_path = private_out_dir / "generated_answers.private.jsonl"
    _write_private_jsonl(judge_path, judge_rows)
    _write_private_jsonl(generated_path, generated_rows)
    manifest = {
        "schema_version": "rsi-private-full-agent-judge-input/v1",
        "row_count": len(judge_rows),
        "judge_key_sha256": hashlib.sha256(judge_path.read_bytes()).hexdigest(),
        "generated_answers_sha256": hashlib.sha256(generated_path.read_bytes()).hexdigest(),
        "join_key": "case_id+seed",
    }
    manifest_path = private_out_dir / "manifest.json"
    fd = os.open(manifest_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")
    return {**manifest, "judge_key": str(judge_path), "generated_answers": str(generated_path)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--private-cases", type=Path, required=True)
    parser.add_argument("--target-outputs", type=Path, required=True)
    parser.add_argument("--private-out-dir", type=Path, required=True)
    print(json.dumps(build_private_judge_inputs(**vars(parser.parse_args())), indent=2))


if __name__ == "__main__":
    main()
