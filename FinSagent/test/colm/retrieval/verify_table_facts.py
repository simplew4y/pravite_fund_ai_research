#!/usr/bin/env python3
"""Run deterministic table-fact checks on generated QA rows."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from utils.table_fact_verifier import verify_answer_against_table_facts


def _answer(row: dict[str, Any]) -> str:
    return str(row.get("generated_answer") or row.get("answer") or "")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--generated_answers_json", required=True)
    parser.add_argument("--out_json", required=True)
    parser.add_argument("--out_csv", default=None)
    args = parser.parse_args()

    with open(args.generated_answers_json, encoding="utf-8") as f:
        rows = json.load(f)
    if not isinstance(rows, list):
        raise ValueError("generated_answers_json must be a JSON list")

    results = []
    status_counts: dict[str, int] = {}
    for row in rows:
        chunks = row.get("retrieved_chunks") or []
        result = verify_answer_against_table_facts(
            str(row.get("question") or row.get("original_question") or ""),
            _answer(row),
            chunks,
        )
        status = result["status"]
        status_counts[status] = status_counts.get(status, 0) + 1
        results.append(
            {
                "qid": row.get("qid"),
                "index": row.get("index"),
                "question": row.get("question") or row.get("original_question"),
                "fact_count": len(result.get("checks") or []),
                "missing_count": sum(
                    1
                    for check in result.get("checks") or []
                    if check.get("required", True) and not check.get("present_in_answer")
                ),
                **result,
            }
        )

    payload = {
        "input": args.generated_answers_json,
        "status_counts": status_counts,
        "rows": results,
    }
    out_json = Path(args.out_json)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    out_csv = Path(args.out_csv) if args.out_csv else out_json.with_suffix(".csv")
    with open(out_csv, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=["qid", "index", "status", "fact_count", "missing_count", "question"],
        )
        writer.writeheader()
        for row in results:
            writer.writerow(
                {
                    "qid": row.get("qid"),
                    "index": row.get("index"),
                    "status": row.get("status"),
                    "fact_count": row.get("fact_count"),
                    "missing_count": row.get("missing_count"),
                    "question": row.get("question"),
                }
            )

    print(
        json.dumps(
            {
                "out_json": str(out_json),
                "out_csv": str(out_csv),
                "status_counts": status_counts,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
