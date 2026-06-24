#!/usr/bin/env python3
"""Apply narrow deterministic repairs for stable company-profile facts."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from utils.profile_fact_repair import repair_profile_answer


def _answer(row: dict[str, Any]) -> str:
    return str(row.get("generated_answer") or row.get("answer") or "")


def _question(row: dict[str, Any]) -> str:
    return str(row.get("question") or row.get("original_question") or "")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--generated_answers_json", required=True)
    parser.add_argument("--out_json", required=True)
    parser.add_argument("--legacy_answer_fallback", action=argparse.BooleanOptionalAction, default=True)
    args = parser.parse_args()

    with open(args.generated_answers_json, encoding="utf-8") as f:
        rows = json.load(f)
    if not isinstance(rows, list):
        raise ValueError("generated_answers_json must be a JSON list")

    repaired_rows = []
    applied = 0
    fact_counts: dict[str, int] = {}
    for row in rows:
        repaired = repair_profile_answer(
            _question(row),
            _answer(row),
            [
                *(row.get("retrieved_chunks") or []),
                *(row.get("pre_rerank_candidates") or []),
            ],
            allow_legacy_answer_fallback=args.legacy_answer_fallback,
        )
        out = dict(row)
        out["original_profile_generated_answer"] = _answer(row)
        if repaired["repair_applied"]:
            out["generated_answer"] = repaired["answer"]
            out["answer"] = repaired["answer"]
            if isinstance(out.get("final_answer"), dict):
                out["final_answer"] = dict(out["final_answer"])
                out["final_answer"]["answer"] = repaired["answer"]
            applied += 1
            fact = repaired.get("profile_fact") or {}
            fact_id = str(fact.get("fact_id") or "unknown")
            fact_counts[fact_id] = fact_counts.get(fact_id, 0) + 1
        out["profile_repair_applied"] = repaired["repair_applied"]
        out["profile_repair_reason"] = repaired["repair_reason"]
        out["profile_repair_fact"] = repaired.get("profile_fact")
        repaired_rows.append(out)

    out_json = Path(args.out_json)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(repaired_rows, f, ensure_ascii=False, indent=2)

    print(
        json.dumps(
            {
                "out_json": str(out_json),
                "row_count": len(repaired_rows),
                "repair_applied_count": applied,
                "fact_counts": fact_counts,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
