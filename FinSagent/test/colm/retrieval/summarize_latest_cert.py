#!/usr/bin/env python3
"""Summarize a latest-certificate run directory."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any


def _load(path: Path) -> Any:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run_dir", required=True)
    parser.add_argument("--generated_name", default="small30_targeted_repair.json")
    parser.add_argument("--judge_dir", default="judge_targeted_repair")
    parser.add_argument("--gate_name", default="answer_gate_targeted_repair.json")
    args = parser.parse_args()

    base = Path(args.run_dir)
    rows = _load(base / args.generated_name)
    judge_results = _load(base / args.judge_dir / "results.json")
    gate = _load(base / args.gate_name)
    by_qid = {row.get("qid"): row for row in rows}

    verdict_counts = Counter(row.get("judge_verdict") for row in judge_results)
    error_groups = Counter(
        row.get("error_primary_group") or "unknown"
        for row in judge_results
        if row.get("judge_verdict") != "CORRECT"
    )
    non_allow = [row for row in gate.get("rows", []) if row.get("gate_decision") != "ALLOW"]

    not_correct = []
    for result in judge_results:
        if result.get("judge_verdict") == "CORRECT":
            continue
        qid = result.get("qid")
        generated = by_qid.get(qid, {})
        not_correct.append(
            {
                "qid": qid,
                "index": result.get("index"),
                "verdict": result.get("judge_verdict"),
                "question": generated.get("question"),
                "error_primary_group": result.get("error_primary_group"),
                "error_primary_subtype": result.get("error_primary_subtype"),
                "analysis_short": (result.get("judge_analysis") or "")[:700],
                "answer_short": (generated.get("generated_answer") or generated.get("answer") or "")[:700],
            }
        )

    summary = {
        "run_dir": str(base),
        "generated_answers_json": str(base / args.generated_name),
        "judge_summary_json": str(base / args.judge_dir / "summary.json"),
        "gate_json": str(base / args.gate_name),
        "verdict_counts": dict(verdict_counts),
        "gate_decision_counts": gate.get("gate_decision_counts"),
        "verifier_status_counts": gate.get("verifier_status_counts"),
        "non_allow_gate_rows": [
            {
                "qid": row.get("qid"),
                "index": row.get("index"),
                "decision": row.get("gate_decision"),
                "status": row.get("verifier_status"),
                "fact_types": row.get("fact_types"),
                "reasons": row.get("reasons"),
            }
            for row in non_allow
        ],
        "table_repair_applied_count": sum(1 for row in rows if row.get("table_repair_applied")),
        "not_correct_count": len(not_correct),
        "error_primary_group_counts": dict(error_groups),
        "not_correct_rows": not_correct,
    }

    out_json = base / "latest_cert_small30_failure_summary.json"
    out_md = base / "latest_cert_small30_failure_summary.md"
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    lines = [
        "# Latest Small30 Certificate Attempt - Failure Summary",
        "",
        f"Run: `{base}`",
        "",
        "## Result",
        "",
        f"- Judge: {dict(verdict_counts)}",
        f"- Gate: {gate.get('gate_decision_counts')}",
        f"- Table repairs applied: {summary['table_repair_applied_count']}",
        "",
        "## Decision",
        "",
        "Do not expand this configuration to large100 yet. The small30 certificate attempt is not strong enough.",
        "",
        "## Blocking Gate Rows",
        "",
    ]
    if non_allow:
        for row in non_allow:
            lines.append(
                f"- {row.get('qid')} / index {row.get('index')}: "
                f"{row.get('gate_decision')} {row.get('verifier_status')} "
                f"{row.get('fact_types')} - {row.get('reasons')}"
            )
    else:
        lines.append("- None")
    lines.extend(["", "## Not-Correct Rows", ""])
    for item in not_correct:
        lines.append(f"- {item['qid']} / index {item['index']} / {item['verdict']}: {item['question']}")
        lines.append(f"  - Analysis: {item['analysis_short']}")
    out_md.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(
        json.dumps(
            {
                "summary_json": str(out_json),
                "summary_md": str(out_md),
                "verdict_counts": dict(verdict_counts),
                "gate_decision_counts": gate.get("gate_decision_counts"),
                "non_allow": len(non_allow),
                "not_correct": len(not_correct),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
