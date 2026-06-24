#!/usr/bin/env python3
"""Create a compact manual-audit CSV from judge results and generated answers."""

from __future__ import annotations

import argparse
import csv
import json
import random
from pathlib import Path
from typing import Any


def _load(path: str) -> list[dict[str, Any]]:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(f"{path} must be a JSON list")
    return data


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--generated_answers_json", required=True)
    parser.add_argument("--judge_results_json", required=True)
    parser.add_argument("--out_csv", required=True)
    parser.add_argument("--sample_size", type=int, default=20)
    parser.add_argument("--seed", type=int, default=20260528)
    args = parser.parse_args()

    generated = {str(row.get("qid") or row.get("index")): row for row in _load(args.generated_answers_json)}
    judged = _load(args.judge_results_json)

    buckets: dict[str, list[dict[str, Any]]] = {}
    for row in judged:
        buckets.setdefault(str(row.get("judge_verdict") or "UNKNOWN"), []).append(row)

    rng = random.Random(args.seed)
    selected: list[dict[str, Any]] = []
    priority = ["INCORRECT", "PARTIAL", "CORRECT", "ERROR/UNCLEAR", "FAILURE"]
    per_bucket = max(1, args.sample_size // max(1, len([b for b in priority if buckets.get(b)])))
    for verdict in priority:
        rows = buckets.get(verdict, [])
        rng.shuffle(rows)
        selected.extend(rows[:per_bucket])

    if len(selected) < args.sample_size:
        remaining = [row for rows in buckets.values() for row in rows if row not in selected]
        rng.shuffle(remaining)
        selected.extend(remaining[: args.sample_size - len(selected)])
    selected = selected[: args.sample_size]
    selected.sort(key=lambda row: int(row.get("index") or 10**9))

    out_csv = Path(args.out_csv)
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    with open(out_csv, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "qid",
                "index",
                "judge_verdict",
                "manual_verdict",
                "manual_notes",
                "question",
                "gold_answer",
                "generated_answer",
                "judge_analysis",
            ],
        )
        writer.writeheader()
        for row in selected:
            key = str(row.get("qid") or row.get("index"))
            gen = generated.get(key, {})
            writer.writerow(
                {
                    "qid": row.get("qid"),
                    "index": row.get("index"),
                    "judge_verdict": row.get("judge_verdict"),
                    "manual_verdict": "",
                    "manual_notes": "",
                    "question": row.get("question"),
                    "gold_answer": row.get("gt_answer") or row.get("original_answer"),
                    "generated_answer": gen.get("generated_answer") or row.get("answer"),
                    "judge_analysis": row.get("judge_analysis"),
                }
            )

    print(json.dumps({"out_csv": str(out_csv), "sampled": len(selected)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
