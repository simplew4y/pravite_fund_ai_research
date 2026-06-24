#!/usr/bin/env python3
"""Profile latency and retrieval-volume signals for an E2E answer JSON."""

import argparse
import json
import math
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


def _num(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    k = (len(ordered) - 1) * percentile / 100.0
    floor = math.floor(k)
    ceil = math.ceil(k)
    if floor == ceil:
        return ordered[int(k)]
    return ordered[floor] * (ceil - k) + ordered[ceil] * (k - floor)


def _stats(values: list[float]) -> dict[str, Any]:
    if not values:
        return {"count": 0}
    return {
        "count": len(values),
        "total": round(sum(values), 3),
        "avg": round(statistics.mean(values), 3),
        "p50": round(_percentile(values, 50) or 0.0, 3),
        "p90": round(_percentile(values, 90) or 0.0, 3),
        "p95": round(_percentile(values, 95) or 0.0, 3),
        "max": round(max(values), 3),
    }


def _corr(left: list[float], right: list[float]) -> float | None:
    if len(left) != len(right) or len(left) < 2:
        return None
    mean_left = statistics.mean(left)
    mean_right = statistics.mean(right)
    left_delta = [value - mean_left for value in left]
    right_delta = [value - mean_right for value in right]
    denom = (sum(value * value for value in left_delta) * sum(value * value for value in right_delta)) ** 0.5
    if not denom:
        return None
    return round(sum(a * b for a, b in zip(left_delta, right_delta)) / denom, 3)


def _load_judge_verdicts(path: str | None) -> dict[str, str]:
    if not path:
        return {}
    with open(path, encoding="utf-8") as f:
        rows = json.load(f)
    verdicts: dict[str, str] = {}
    for row in rows:
        key = str(row.get("qid") or row.get("index") or "")
        if key:
            verdicts[key] = str(row.get("judge_verdict") or row.get("verdict") or "")
    return verdicts


def _row_key(row: dict[str, Any]) -> str:
    return str(row.get("qid") or row.get("index") or "")


def _summarize_group(rows: list[dict[str, Any]]) -> dict[str, Any]:
    times = [_num(row.get("total_time")) for row in rows]
    candidates = [_num(row.get("pre_rerank_candidate_count")) for row in rows]
    chunks = [_num(row.get("retrieved_chunk_count")) for row in rows]
    agents = [len(row.get("activated_agents") or []) for row in rows]
    return {
        "row_count": len(rows),
        "time": _stats(times),
        "avg_pre_rerank_candidates": round(statistics.mean(candidates), 3) if candidates else None,
        "avg_retrieved_chunks": round(statistics.mean(chunks), 3) if chunks else None,
        "avg_agent_count": round(statistics.mean(agents), 3) if agents else None,
    }


def build_profile(rows: list[dict[str, Any]], judge_verdicts: dict[str, str], top_n: int) -> dict[str, Any]:
    times = [_num(row.get("total_time")) for row in rows]
    candidates = [_num(row.get("pre_rerank_candidate_count")) for row in rows]
    chunks = [_num(row.get("retrieved_chunk_count")) for row in rows]
    agent_counts = [len(row.get("activated_agents") or []) for row in rows]

    groups: dict[str, dict[str, Any]] = {}
    group_defs = {
        "coverage_repaired": lambda row: bool(row.get("coverage_repair_applied")),
        "not_coverage_repaired": lambda row: not bool(row.get("coverage_repair_applied")),
        "table_repaired": lambda row: bool(row.get("table_repair_applied")),
        "not_table_repaired": lambda row: not bool(row.get("table_repair_applied")),
        "multi_agent": lambda row: len(row.get("activated_agents") or []) >= 2,
        "single_agent": lambda row: len(row.get("activated_agents") or []) <= 1,
        "pre_rerank_candidates_ge_250": lambda row: _int(row.get("pre_rerank_candidate_count")) >= 250,
        "pre_rerank_candidates_lt_250": lambda row: _int(row.get("pre_rerank_candidate_count")) < 250,
        "retrieved_chunks_ge_40": lambda row: _int(row.get("retrieved_chunk_count")) >= 40,
        "retrieved_chunks_lt_40": lambda row: _int(row.get("retrieved_chunk_count")) < 40,
    }
    for name, predicate in group_defs.items():
        matching = [row for row in rows if predicate(row)]
        if matching:
            groups[name] = _summarize_group(matching)

    by_profile: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_profile[str(row.get("retrieval_profile_name") or "unknown")].append(row)

    top_slow = []
    for row in sorted(rows, key=lambda item: _num(item.get("total_time")), reverse=True)[:top_n]:
        key = _row_key(row)
        top_slow.append(
            {
                "index": row.get("index"),
                "qid": row.get("qid"),
                "question": row.get("question"),
                "total_time": row.get("total_time"),
                "retrieved_chunk_count": row.get("retrieved_chunk_count"),
                "pre_rerank_candidate_count": row.get("pre_rerank_candidate_count"),
                "activated_agents": row.get("activated_agents") or [],
                "retrieval_profile_name": row.get("retrieval_profile_name"),
                "judge_verdict": judge_verdicts.get(key),
            }
        )

    return {
        "row_count": len(rows),
        "time": _stats(times),
        "avg_pre_rerank_candidates": round(statistics.mean(candidates), 3) if candidates else None,
        "avg_retrieved_chunks": round(statistics.mean(chunks), 3) if chunks else None,
        "avg_agent_count": round(statistics.mean(agent_counts), 3) if agent_counts else None,
        "correlations": {
            "time_vs_pre_rerank_candidates": _corr(times, candidates),
            "time_vs_retrieved_chunks": _corr(times, chunks),
            "time_vs_agent_count": _corr(times, agent_counts),
        },
        "agent_count_distribution": dict(Counter(agent_counts)),
        "retrieval_profile_groups": {name: _summarize_group(group_rows) for name, group_rows in by_profile.items()},
        "groups": groups,
        "top_slow": top_slow,
    }


def write_markdown(profile: dict[str, Any], output_path: Path) -> None:
    lines = [
        "# Latency Profile",
        "",
        "## Summary",
        "",
        f"- rows: {profile['row_count']}",
        f"- total seconds: {profile['time'].get('total')}",
        f"- avg seconds: {profile['time'].get('avg')}",
        f"- p50/p90/p95/max seconds: {profile['time'].get('p50')} / {profile['time'].get('p90')} / {profile['time'].get('p95')} / {profile['time'].get('max')}",
        f"- avg pre-rerank candidates: {profile.get('avg_pre_rerank_candidates')}",
        f"- avg retrieved chunks: {profile.get('avg_retrieved_chunks')}",
        f"- avg agent count: {profile.get('avg_agent_count')}",
        "",
        "## Correlations",
        "",
    ]
    for name, value in profile["correlations"].items():
        lines.append(f"- {name}: {value}")
    lines.extend(["", "## Groups", ""])
    for name, group in profile["groups"].items():
        time_stats = group["time"]
        lines.append(
            f"- {name}: n={group['row_count']}, avg={time_stats.get('avg')}s, "
            f"p90={time_stats.get('p90')}s, avg_chunks={group.get('avg_retrieved_chunks')}, "
            f"avg_candidates={group.get('avg_pre_rerank_candidates')}, avg_agents={group.get('avg_agent_count')}"
        )
    lines.extend(["", "## Top Slow Rows", ""])
    for row in profile["top_slow"]:
        agents = ",".join(row["activated_agents"])
        lines.append(
            f"- index={row['index']} qid={row['qid']} time={row['total_time']}s "
            f"chunks={row['retrieved_chunk_count']} candidates={row['pre_rerank_candidate_count']} "
            f"agents={agents} verdict={row.get('judge_verdict') or ''} question={row.get('question')}"
        )
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--generated_answers_json", required=True)
    parser.add_argument("--judge_results_json", default=None)
    parser.add_argument("--out_json", required=True)
    parser.add_argument("--out_md", required=True)
    parser.add_argument("--top_n", type=int, default=10)
    args = parser.parse_args()

    with open(args.generated_answers_json, encoding="utf-8") as f:
        rows = json.load(f)
    if not isinstance(rows, list):
        raise ValueError("generated_answers_json must contain a JSON list")

    profile = build_profile(rows, _load_judge_verdicts(args.judge_results_json), args.top_n)
    out_json = Path(args.out_json)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding="utf-8")
    write_markdown(profile, Path(args.out_md))
    print(json.dumps({"out_json": str(out_json), "out_md": args.out_md, "row_count": len(rows)}, indent=2))


if __name__ == "__main__":
    main()
