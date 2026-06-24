#!/usr/bin/env python3
"""Apply narrow deterministic repairs for supported table-derived answers."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from utils.table_answer_repair import load_reconstructed_table_chunks, repair_table_answer


def _answer(row: dict[str, Any]) -> str:
    return str(row.get("generated_answer") or row.get("answer") or "")


def _question(row: dict[str, Any]) -> str:
    return str(row.get("question") or row.get("original_question") or "")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--generated_answers_json", required=True)
    parser.add_argument("--out_json", required=True)
    parser.add_argument(
        "--canonicalize_supported",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Rewrite supported table-fact answers into deterministic fact-only form even when verifier already passes.",
    )
    parser.add_argument("--reconstructed_table_dir", default=None)
    args = parser.parse_args()

    with open(args.generated_answers_json, encoding="utf-8") as f:
        rows = json.load(f)
    if not isinstance(rows, list):
        raise ValueError("generated_answers_json must be a JSON list")

    repaired_rows = []
    applied = 0
    fallback_table_chunks = load_reconstructed_table_chunks(args.reconstructed_table_dir)
    for row in rows:
        repaired = repair_table_answer(
            _question(row),
            _answer(row),
            row.get("retrieved_chunks") or [],
            canonicalize_supported=args.canonicalize_supported,
            fallback_table_chunks=fallback_table_chunks,
        )
        out = dict(row)
        out["original_generated_answer"] = _answer(row)
        out["generated_answer"] = repaired["answer"]
        out["answer"] = repaired["answer"]
        if isinstance(out.get("final_answer"), dict):
            out["final_answer"] = dict(out["final_answer"])
            out["final_answer"]["answer"] = repaired["answer"]
        out["table_repair_applied"] = repaired["repair_applied"]
        out["table_repair_reason"] = repaired["repair_reason"]
        out["table_repair_verification"] = repaired.get("verification")
        out["table_repair_pre_verification"] = repaired.get("pre_repair_verification")
        out["quant_skill_hints"] = repaired.get("quant_skill_hints") or []
        if repaired["repair_applied"]:
            applied += 1
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
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
