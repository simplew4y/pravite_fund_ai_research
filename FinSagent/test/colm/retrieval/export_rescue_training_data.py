#!/usr/bin/env python3
"""Export weak labels for a future learning-based rescue scorer.

The output is intentionally simple JSONL: one row per retrieved candidate, with
query/candidate metadata and the final judge verdict for the QA. This is not a
trained model yet; it is the data contract needed before training one.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from utils.table_fact_verifier import detect_table_facts


def _load(path: str) -> list[dict[str, Any]]:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(f"{path} must be a JSON list")
    return data


def _qid(row: dict[str, Any]) -> str:
    return str(row.get("qid") or row.get("index"))


def _chunk_text(chunk: dict[str, Any]) -> str:
    metadata = chunk.get("metadata") or {}
    return " ".join(
        str(value)
        for value in [
            chunk.get("page_content", ""),
            metadata.get("caption", ""),
            metadata.get("source_file", ""),
            metadata.get("date_published", ""),
        ]
        if value
    )


def _features(question: str, chunk: dict[str, Any], include_table_fact_features: bool = False) -> dict[str, Any]:
    text = _chunk_text(chunk)
    question_terms = {token.lower() for token in re.findall(r"[A-Za-z0-9\u4e00-\u9fff]{2,}", question or "")}
    text_lower = text.lower()
    overlap = sum(1 for term in question_terms if term in text_lower)
    metadata = chunk.get("metadata") or {}
    features = {
        "retriever": chunk.get("retriever"),
        "score": chunk.get("score"),
        "content_length": len(text),
        "has_number": bool(re.search(r"\d", text)),
        "term_overlap_count": overlap,
        "source_file": metadata.get("source_file") or metadata.get("doc_id"),
        "date_published": metadata.get("date_published") or metadata.get("pageindex_doc_date"),
        "content_type": metadata.get("content_type") or ("table" if chunk.get("retriever") == "Table" else "text"),
        "evidence_rescue": bool(metadata.get("evidence_rescue")),
        "evidence_rescue_score": metadata.get("evidence_rescue_score"),
    }
    if include_table_fact_features:
        facts = detect_table_facts(question, [chunk])
        features.update(
            {
                "table_fact_count": len(facts),
                "table_fact_types": sorted({fact.fact_type for fact in facts}),
                "has_table_fact": bool(facts),
            }
        )
    return features


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--generated_answers_json", required=True)
    parser.add_argument("--judge_results_json", required=True)
    parser.add_argument("--out_jsonl", required=True)
    parser.add_argument("--use_pre_rerank", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--include_table_fact_features", action=argparse.BooleanOptionalAction, default=False)
    args = parser.parse_args()

    generated_rows = _load(args.generated_answers_json)
    judge_map = {_qid(row): row for row in _load(args.judge_results_json)}
    out_path = Path(args.out_jsonl)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    with open(out_path, "w", encoding="utf-8") as f:
        for row in generated_rows:
            key = _qid(row)
            judge = judge_map.get(key, {})
            chunks = row.get("pre_rerank_candidates") if args.use_pre_rerank else row.get("retrieved_chunks")
            for rank, chunk in enumerate(chunks or [], start=1):
                record = {
                    "qid": row.get("qid"),
                    "index": row.get("index"),
                    "question": row.get("question") or row.get("original_question"),
                    "candidate_rank": rank,
                    "judge_verdict": judge.get("judge_verdict"),
                    "kp_coverage_ratio": judge.get("kp_coverage_ratio"),
                    "candidate": _features(
                        row.get("question") or row.get("original_question") or "",
                        chunk,
                        include_table_fact_features=args.include_table_fact_features,
                    ),
                }
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
                written += 1

    print(json.dumps({"out_jsonl": str(out_path), "rows": written}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
