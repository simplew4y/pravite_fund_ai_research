#!/usr/bin/env python3
"""Apply the deterministic table answer gate to generated QA rows."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from utils.table_answer_gate import gate_table_answer
from utils.table_answer_repair import load_reconstructed_table_chunks


def _answer(row: dict[str, Any]) -> str:
    return str(row.get("generated_answer") or row.get("answer") or "")


def _question(row: dict[str, Any]) -> str:
    return str(row.get("question") or row.get("original_question") or "")


def _bump(counts: dict[str, int], key: str) -> None:
    counts[key] = counts.get(key, 0) + 1


def _compact_missing(missing: list[dict[str, Any]]) -> str:
    values = []
    for check in missing:
        label = str(check.get("label") or "")
        value = str(check.get("value") or "")
        unit = str(check.get("unit") or "")
        values.append(" ".join(part for part in (label, value, unit) if part))
    return " | ".join(values)


def _compact_numeric_issues(issues: list[dict[str, Any]]) -> str:
    values = []
    for issue in issues:
        rule = str(issue.get("rule") or "")
        severity = str(issue.get("severity") or "")
        action = str(issue.get("action") or "")
        reason = str(issue.get("reason") or "")
        values.append(" / ".join(part for part in (rule, severity, action, reason) if part))
    return " | ".join(values)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--generated_answers_json", required=True)
    parser.add_argument("--out_json", required=True)
    parser.add_argument("--out_csv", default=None)
    parser.add_argument("--reconstructed_table_dir", default=None)
    args = parser.parse_args()

    with open(args.generated_answers_json, encoding="utf-8") as f:
        rows = json.load(f)
    if not isinstance(rows, list):
        raise ValueError("generated_answers_json must be a JSON list")

    results: list[dict[str, Any]] = []
    decision_counts: dict[str, int] = {}
    status_counts: dict[str, int] = {}
    severity_counts: dict[str, int] = {}
    scope_counts: dict[str, int] = {}
    fallback_table_chunks = load_reconstructed_table_chunks(args.reconstructed_table_dir)

    for row in rows:
        result = gate_table_answer(
            _question(row),
            _answer(row),
            row.get("retrieved_chunks") or [],
            fallback_table_chunks=fallback_table_chunks,
        )
        _bump(decision_counts, str(result["gate_decision"]))
        _bump(status_counts, str(result["verifier_status"]))
        _bump(severity_counts, str(result["severity"]))
        _bump(scope_counts, str(result["gate_scope"]))
        results.append(
            {
                "qid": row.get("qid"),
                "index": row.get("index"),
                "question": _question(row),
                "answer": _answer(row),
                **result,
            }
        )

    payload = {
        "input": args.generated_answers_json,
        "row_count": len(results),
        "gate_decision_counts": decision_counts,
        "verifier_status_counts": status_counts,
        "severity_counts": severity_counts,
        "scope_counts": scope_counts,
        "rows": results,
    }

    out_json = Path(args.out_json)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    out_csv = Path(args.out_csv) if args.out_csv else out_json.with_suffix(".csv")
    with open(out_csv, "w", encoding="utf-8", newline="") as f:
        fieldnames = [
            "qid",
            "index",
            "gate_decision",
            "severity",
            "gate_scope",
            "verifier_status",
            "fact_types",
            "fact_count",
            "required_count",
            "missing_required_count",
            "present_required_count",
            "missing_required",
            "numeric_audit_issues",
            "reasons",
            "question",
        ]
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in results:
            writer.writerow(
                {
                    "qid": row.get("qid"),
                    "index": row.get("index"),
                    "gate_decision": row.get("gate_decision"),
                    "severity": row.get("severity"),
                    "gate_scope": row.get("gate_scope"),
                    "verifier_status": row.get("verifier_status"),
                    "fact_types": "|".join(row.get("fact_types") or []),
                    "fact_count": row.get("fact_count"),
                    "required_count": row.get("required_count"),
                    "missing_required_count": row.get("missing_required_count"),
                    "present_required_count": row.get("present_required_count"),
                    "missing_required": _compact_missing(row.get("missing_required") or []),
                    "numeric_audit_issues": _compact_numeric_issues(row.get("numeric_audit_issues") or []),
                    "reasons": " | ".join(row.get("reasons") or []),
                    "question": row.get("question"),
                }
            )

    print(
        json.dumps(
            {
                "out_json": str(out_json),
                "out_csv": str(out_csv),
                "row_count": len(results),
                "gate_decision_counts": decision_counts,
                "verifier_status_counts": status_counts,
                "severity_counts": severity_counts,
                "scope_counts": scope_counts,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
