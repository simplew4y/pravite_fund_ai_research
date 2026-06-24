#!/usr/bin/env python3
"""Summarize generation, judge, and latency/cost proxy metrics for eval runs."""

from __future__ import annotations

import argparse
import csv
import json
import statistics
from pathlib import Path
from typing import Any


def _load_json(path: str | None) -> Any:
    if not path:
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    values = sorted(values)
    if len(values) == 1:
        return values[0]
    pos = (len(values) - 1) * pct
    lower = int(pos)
    upper = min(lower + 1, len(values) - 1)
    weight = pos - lower
    return values[lower] * (1 - weight) + values[upper] * weight


def _time_stats(rows: list[dict[str, Any]]) -> dict[str, Any]:
    values = [float(row.get("total_time")) for row in rows if row.get("total_time") is not None]
    if not values:
        return {"count": 0}
    return {
        "count": len(values),
        "total_seconds": round(sum(values), 3),
        "avg_seconds": round(statistics.mean(values), 3),
        "p50_seconds": round(_percentile(values, 0.50) or 0.0, 3),
        "p90_seconds": round(_percentile(values, 0.90) or 0.0, 3),
        "p95_seconds": round(_percentile(values, 0.95) or 0.0, 3),
        "max_seconds": round(max(values), 3),
    }


def _avg_field(rows: list[dict[str, Any]], field: str) -> float | None:
    values = [float(row.get(field)) for row in rows if row.get(field) is not None]
    return round(statistics.mean(values), 3) if values else None


def _profile_stats(rows: list[dict[str, Any]]) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        profile = str(row.get("retrieval_profile_name") or "unknown")
        grouped.setdefault(profile, []).append(row)
    return {
        profile: {
            "row_count": len(profile_rows),
            "time_stats": _time_stats(profile_rows),
            "avg_retrieved_chunk_count": _avg_field(profile_rows, "retrieved_chunk_count"),
            "avg_pre_rerank_candidate_count": _avg_field(profile_rows, "pre_rerank_candidate_count"),
        }
        for profile, profile_rows in sorted(grouped.items())
    }


def _judge_by_qid(judge_results: list[dict[str, Any]] | None) -> dict[str, dict[str, Any]]:
    if not judge_results:
        return {}
    return {str(row.get("qid") or row.get("index")): row for row in judge_results}


def _row_key(row: dict[str, Any]) -> str:
    return str(row.get("qid") or row.get("index"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--generated_answers_json", required=True)
    parser.add_argument("--judge_results_json", default=None)
    parser.add_argument("--baseline_judge_results_json", default=None)
    parser.add_argument("--out_json", required=True)
    parser.add_argument("--out_csv", default=None)
    args = parser.parse_args()

    rows = _load_json(args.generated_answers_json)
    judge_results = _load_json(args.judge_results_json)
    baseline_results = _load_json(args.baseline_judge_results_json)
    if not isinstance(rows, list):
        raise ValueError("generated_answers_json must be a JSON list")
    if judge_results is not None and not isinstance(judge_results, list):
        raise ValueError("judge_results_json must be a JSON list")

    judge_map = _judge_by_qid(judge_results)
    baseline_map = _judge_by_qid(baseline_results if isinstance(baseline_results, list) else None)

    verdict_counts: dict[str, int] = {}
    deltas: dict[str, int] = {"improved": 0, "same": 0, "regressed": 0, "unknown": 0}
    rank = {"CORRECT": 3, "PARTIAL": 2, "INCORRECT": 1, "FAILURE": 0, "ERROR/UNCLEAR": 0}
    detail_rows = []
    for row in rows:
        key = _row_key(row)
        judge = judge_map.get(key, {})
        verdict = judge.get("judge_verdict")
        if verdict:
            verdict_counts[verdict] = verdict_counts.get(verdict, 0) + 1
        baseline_verdict = baseline_map.get(key, {}).get("judge_verdict")
        if verdict and baseline_verdict:
            diff = rank.get(verdict, 0) - rank.get(baseline_verdict, 0)
            if diff > 0:
                deltas["improved"] += 1
            elif diff < 0:
                deltas["regressed"] += 1
            else:
                deltas["same"] += 1
        elif baseline_map:
            deltas["unknown"] += 1
        detail_rows.append(
            {
                "qid": row.get("qid"),
                "index": row.get("index"),
                "total_time": row.get("total_time"),
                "retrieved_chunk_count": row.get("retrieved_chunk_count"),
                "pre_rerank_candidate_count": row.get("pre_rerank_candidate_count"),
                "verdict": verdict,
                "baseline_verdict": baseline_verdict,
                "retrieval_profile_name": row.get("retrieval_profile_name"),
                "retrieval_profile_reason": row.get("retrieval_profile_reason"),
                "question": row.get("question") or row.get("original_question"),
            }
        )

    payload = {
        "generated_answers_json": args.generated_answers_json,
        "judge_results_json": args.judge_results_json,
        "baseline_judge_results_json": args.baseline_judge_results_json,
        "row_count": len(rows),
        "time_stats": _time_stats(rows),
        "avg_retrieved_chunk_count": _avg_field(rows, "retrieved_chunk_count"),
        "avg_pre_rerank_candidate_count": _avg_field(rows, "pre_rerank_candidate_count"),
        "profile_stats": _profile_stats(rows),
        "verdict_counts": verdict_counts,
        "baseline_deltas": deltas if baseline_map else {},
    }

    out_json = Path(args.out_json)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    out_csv = Path(args.out_csv) if args.out_csv else out_json.with_suffix(".csv")
    with open(out_csv, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(detail_rows[0].keys()) if detail_rows else ["qid"])
        writer.writeheader()
        writer.writerows(detail_rows)

    print(json.dumps({"out_json": str(out_json), "out_csv": str(out_csv), **payload}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
