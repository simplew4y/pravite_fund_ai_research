#!/usr/bin/env python3
"""Run the standard post-generation validation chain for PageIndex E2E runs.

The chain is intentionally split into deterministic and LLM steps:
1. deterministic numeric/table answer gate
2. optional LLM judge
3. latency/verdict summary
4. compact validation summary for reports
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[3]


def _run(cmd: list[str]) -> None:
    print("+ " + " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=PROJECT_ROOT, check=True)


def _load_json(path: Path | None) -> Any:
    if not path:
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _count_bad_judge_verdicts(verdict_counts: dict[str, int]) -> int:
    return sum(int(verdict_counts.get(key, 0)) for key in ("INCORRECT", "FAILURE", "ERROR/UNCLEAR"))


def _blocked_rows(gate_payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for row in gate_payload.get("rows") or []:
        if row.get("gate_decision") != "BLOCK":
            continue
        rows.append(
            {
                "qid": row.get("qid"),
                "index": row.get("index"),
                "rules": [issue.get("rule") for issue in row.get("numeric_audit_issues") or []],
                "reasons": row.get("reasons") or [],
                "question": row.get("question"),
            }
        )
    return rows


def _validation_status(
    gate_counts: dict[str, int],
    judge_verdict_counts: dict[str, int],
    *,
    allow_partials: bool,
) -> str:
    if int(gate_counts.get("BLOCK", 0)) > 0:
        return "BLOCKED_BY_DETERMINISTIC_GATE"
    if _count_bad_judge_verdicts(judge_verdict_counts) > 0:
        return "BLOCKED_BY_JUDGE"
    if not allow_partials and int(judge_verdict_counts.get("PARTIAL", 0)) > 0:
        return "NEEDS_COVERAGE_REPAIR"
    if int(gate_counts.get("REVIEW", 0)) > 0:
        return "NEEDS_GATE_REVIEW"
    return "PASS"


def _judge_summary_counts(judge_summary: dict[str, Any] | None) -> dict[str, int]:
    if not judge_summary:
        return {}
    overall = judge_summary.get("overall") or {}
    return dict(overall.get("verdict_counts") or {})


def _judge_score(judge_summary: dict[str, Any] | None) -> float | None:
    if not judge_summary:
        return None
    overall = judge_summary.get("overall") or {}
    value = overall.get("correctness_score")
    return float(value) if value is not None else None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--generated_answers_json", required=True)
    parser.add_argument("--out_dir", default=None)
    parser.add_argument("--input_json", default="/root/autodl-tmp/dir_myz/FinSagent/test/zeekr_colm_e2e_gt_with_key_pts_0330_for_judge.json")
    parser.add_argument("--judge_config", default=str(PROJECT_ROOT / "config" / "production_pageindex_fast.yaml"))
    parser.add_argument("--run_judge", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--judge_workers", type=int, default=1)
    parser.add_argument("--judge_reasoning_effort", default=None)
    parser.add_argument("--judge_results_json", default=None)
    parser.add_argument("--judge_summary_json", default=None)
    parser.add_argument("--baseline_judge_results_json", default=None)
    parser.add_argument("--reconstructed_table_dir", default="/root/autodl-tmp/RAG_Agent_data/Zeekr/20250729/tables")
    parser.add_argument("--allow_partials", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--fail_on_block", action=argparse.BooleanOptionalAction, default=False)
    args = parser.parse_args()

    generated_path = Path(args.generated_answers_json)
    out_dir = Path(args.out_dir) if args.out_dir else generated_path.with_suffix("").parent / f"{generated_path.stem}_validation"
    out_dir.mkdir(parents=True, exist_ok=True)

    gate_json = out_dir / "answer_gate_numeric_audit.json"
    gate_csv = out_dir / "answer_gate_numeric_audit.csv"
    gate_cmd = [
        sys.executable,
        str(PROJECT_ROOT / "test" / "colm" / "retrieval" / "apply_table_answer_gate.py"),
        "--generated_answers_json",
        str(generated_path),
        "--out_json",
        str(gate_json),
        "--out_csv",
        str(gate_csv),
    ]
    if args.reconstructed_table_dir:
        gate_cmd.extend(["--reconstructed_table_dir", args.reconstructed_table_dir])
    _run(gate_cmd)

    judge_results_path = Path(args.judge_results_json) if args.judge_results_json else None
    judge_summary_path = Path(args.judge_summary_json) if args.judge_summary_json else None
    judge_dir = out_dir / "judge"
    if args.run_judge:
        judge_cmd = [
            sys.executable,
            str(PROJECT_ROOT / "test" / "qa_llm_judge.py"),
            "--config",
            args.judge_config,
            "--input_json",
            args.input_json,
            "--generated_answers_json",
            str(generated_path),
            "--out_dir",
            str(judge_dir),
            "--workers",
            str(args.judge_workers),
        ]
        if args.judge_reasoning_effort:
            judge_cmd.extend(["--reasoning_effort", args.judge_reasoning_effort])
        _run(judge_cmd)
        judge_results_path = judge_dir / "results.json"
        judge_summary_path = judge_dir / "summary.json"

    eval_summary_json = out_dir / "eval_summary.json"
    eval_summary_csv = out_dir / "eval_summary.csv"
    summary_cmd = [
        sys.executable,
        str(PROJECT_ROOT / "test" / "colm" / "retrieval" / "summarize_eval_run.py"),
        "--generated_answers_json",
        str(generated_path),
        "--out_json",
        str(eval_summary_json),
        "--out_csv",
        str(eval_summary_csv),
    ]
    if judge_results_path:
        summary_cmd.extend(["--judge_results_json", str(judge_results_path)])
    if args.baseline_judge_results_json:
        summary_cmd.extend(["--baseline_judge_results_json", args.baseline_judge_results_json])
    _run(summary_cmd)

    gate_payload = _load_json(gate_json)
    judge_summary = _load_json(judge_summary_path) if judge_summary_path and judge_summary_path.exists() else None
    eval_summary = _load_json(eval_summary_json)
    gate_counts = dict(gate_payload.get("gate_decision_counts") or {})
    judge_verdict_counts = _judge_summary_counts(judge_summary)
    status = _validation_status(gate_counts, judge_verdict_counts, allow_partials=args.allow_partials)
    validation_summary = {
        "status": status,
        "generated_answers_json": str(generated_path),
        "out_dir": str(out_dir),
        "gate": {
            "json": str(gate_json),
            "csv": str(gate_csv),
            "decision_counts": gate_counts,
            "severity_counts": gate_payload.get("severity_counts") or {},
            "blocked_rows": _blocked_rows(gate_payload),
        },
        "judge": {
            "run_judge": args.run_judge,
            "results_json": str(judge_results_path) if judge_results_path else None,
            "summary_json": str(judge_summary_path) if judge_summary_path else None,
            "verdict_counts": judge_verdict_counts,
            "correctness_score": _judge_score(judge_summary),
        },
        "summary": {
            "json": str(eval_summary_json),
            "csv": str(eval_summary_csv),
            "time_stats": (eval_summary or {}).get("time_stats"),
            "profile_stats": (eval_summary or {}).get("profile_stats"),
        },
    }

    validation_summary_json = out_dir / "validation_summary.json"
    with open(validation_summary_json, "w", encoding="utf-8") as f:
        json.dump(validation_summary, f, ensure_ascii=False, indent=2)

    print(json.dumps({"validation_summary_json": str(validation_summary_json), **validation_summary}, ensure_ascii=False, indent=2))

    if args.fail_on_block and status != "PASS":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
