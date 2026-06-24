#!/usr/bin/env python3
"""Build rotating diagnostic and blind-holdout candidates for skill evolution.

This helps avoid overfitting the skill library to the same old failures. The
script selects unseen questions from a GT file, using simple risk-bucket
heuristics and excluding rows that already appeared in prior result files.
"""

from __future__ import annotations

import argparse
import json
import random
import re
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any


DEFAULT_ZEEKR_GT = "/root/autodl-tmp/dir_myz/FinSagent/test/zeekr_colm_e2e_gt_with_key_pts_0330_for_judge.json"
DEFAULT_EXCLUDE_RESULTS = [
    "test/colm/retrieval/subquery_cap2_small30_20260530/standard_validation_coverage_v1_judge/judge/results.json",
    "test/colm/retrieval/holdout20_cap2_20260531/standard_validation_coverage_v1_judge/judge/results.json",
]


BUCKET_PATTERNS: dict[str, tuple[str, ...]] = {
    "period_control": (
        "2022",
        "2023",
        "2024",
        "2025",
        "q1",
        "q2",
        "q3",
        "q4",
        "quarter",
        "relationship",
        "ipo",
        "listing",
        "covid",
        "policy",
        "tariff",
        "merger",
        "structuring",
        "history",
        "timeline",
        "财年",
        "季度",
        "二季度",
        "四季度",
        "政策",
        "上市",
        "关系",
    ),
    "table_verification": (
        "cash",
        "revenue",
        "income",
        "expense",
        "r&d",
        "gross",
        "margin",
        "volume",
        "deliver",
        "sales",
        "contribution",
        "balance",
        "assets",
        "liabilities",
        "shares",
        "ads",
        "price",
        "percentage",
        "现金",
        "收入",
        "费用",
        "研发",
        "销量",
        "销售",
        "余额",
        "股",
        "定价",
        "占比",
    ),
    "fact_registry": (
        "product",
        "portfolio",
        "matrix",
        "board",
        "director",
        "factory",
        "manufactur",
        "power",
        "availability",
        "employee",
        "subsidiary",
        "shareholder",
        "structure",
        "model",
        "产品",
        "矩阵",
        "董事",
        "工厂",
        "生产",
        "员工",
        "股东",
        "车型",
    ),
    "coverage": (
        "risk",
        "risks",
        "pipeline",
        "plan",
        "strategy",
        "impact",
        "how did",
        "what sequence",
        "describe",
        "explain",
        "风险",
        "影响",
        "管线",
        "战略",
        "解释",
        "描述",
    ),
    "evidence_sufficiency": (
        "whether",
        "is there",
        "any",
        "claim",
        "support",
        "available",
        "disclosed",
        "是否",
        "有没有",
        "支持",
        "披露",
    ),
}


def normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def load_rows(path: Path) -> list[dict[str, Any]]:
    with open(path, encoding="utf-8") as f:
        payload = json.load(f)
    if not isinstance(payload, list):
        raise ValueError(f"Expected JSON list: {path}")
    return [row for row in payload if isinstance(row, dict)]


def row_id(row: dict[str, Any]) -> str:
    if row.get("index") is not None:
        return f"index:{row.get('index')}"
    if row.get("qid") is not None:
        return f"qid:{row.get('qid')}"
    question = normalize_text(row.get("question") or row.get("original_question"))
    return f"question:{question}"


def display_id(row: dict[str, Any]) -> str:
    if row.get("qid") is not None:
        return str(row.get("qid"))
    if row.get("index") is not None:
        return f"idx_{row.get('index')}"
    return row_id(row)


def excluded_ids(paths: list[Path]) -> set[str]:
    out: set[str] = set()
    for path in paths:
        if not path.exists():
            continue
        for row in load_rows(path):
            out.add(row_id(row))
    return out


def classify_question(row: dict[str, Any]) -> tuple[str, list[str]]:
    question = normalize_text(row.get("question") or row.get("original_question")).lower()
    key_points = row.get("key_points") or row.get("gt_keypoints") or []
    keypoint_count = len(key_points) if isinstance(key_points, list) else 0
    scores: Counter[str] = Counter()
    reasons: defaultdict[str, list[str]] = defaultdict(list)
    for bucket, patterns in BUCKET_PATTERNS.items():
        for pattern in patterns:
            if pattern.lower() in question:
                scores[bucket] += 1
                if len(reasons[bucket]) < 3:
                    reasons[bucket].append(pattern)
    if keypoint_count >= 4:
        scores["coverage"] += 2
        reasons["coverage"].append(f"{keypoint_count} keypoints")
    if re.search(r"\d", question):
        scores["table_verification"] += 1
        reasons["table_verification"].append("numeric token")
    if not scores:
        return "general", []
    priority = ["period_control", "table_verification", "fact_registry", "coverage", "evidence_sufficiency"]
    bucket = sorted(scores, key=lambda item: (-scores[item], priority.index(item) if item in priority else 99))[0]
    return bucket, reasons[bucket]


def build_pool(gt_rows: list[dict[str, Any]], excluded: set[str]) -> list[dict[str, Any]]:
    pool: list[dict[str, Any]] = []
    for position, row in enumerate(gt_rows, start=1):
        if row_id(row) in excluded:
            continue
        bucket, reasons = classify_question(row)
        item = {
            "position": position,
            "index": row.get("index"),
            "qid": row.get("qid"),
            "question": normalize_text(row.get("question") or row.get("original_question")),
            "risk_bucket": bucket,
            "bucket_reasons": reasons,
            "keypoint_count": len(row.get("key_points") or []) if isinstance(row.get("key_points"), list) else None,
        }
        pool.append(item)
    return pool


def stratified_sample(pool: list[dict[str, Any]], n: int, seed: int) -> list[dict[str, Any]]:
    rng = random.Random(seed)
    by_bucket: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in pool:
        by_bucket[item["risk_bucket"]].append(item)
    for rows in by_bucket.values():
        rng.shuffle(rows)

    selected: list[dict[str, Any]] = []
    buckets = sorted(by_bucket, key=lambda bucket: (-len(by_bucket[bucket]), bucket))
    while len(selected) < n and buckets:
        progressed = False
        for bucket in list(buckets):
            rows = by_bucket[bucket]
            if not rows:
                buckets.remove(bucket)
                continue
            selected.append(rows.pop())
            progressed = True
            if len(selected) >= n:
                break
        if not progressed:
            break
    selected.sort(key=lambda item: (item.get("index") if item.get("index") is not None else item["position"]))
    return selected


def write_json(path: Path, rows: list[dict[str, Any]]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)


def write_markdown(
    path: Path,
    gt_path: Path,
    exclude_paths: list[Path],
    pool: list[dict[str, Any]],
    rotating: list[dict[str, Any]],
    blind: list[dict[str, Any]],
) -> None:
    lines: list[str] = []
    lines.append("# Skill Evolution Testset Refresh")
    lines.append("")
    lines.append(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append("")
    lines.append(f"GT: `{gt_path}`")
    lines.append("")
    lines.append("Excluded prior result files:")
    for exclude_path in exclude_paths:
        lines.append(f"- `{exclude_path}`")
    lines.append("")
    lines.append(f"Unseen candidate pool: {len(pool)}")
    lines.append("")
    lines.append("## Pool Distribution")
    lines.append("")
    counts = Counter(item["risk_bucket"] for item in pool)
    lines.append("| bucket | candidates |")
    lines.append("| --- | ---: |")
    for bucket, count in sorted(counts.items()):
        lines.append(f"| {bucket} | {count} |")
    lines.append("")
    lines.append("## Rotating Diagnostic Candidates")
    lines.append("")
    lines.append("Use these to discover new failure modes and generate skill proposals. They are not blind once used for skill generation.")
    lines.append("")
    lines.extend(format_rows(rotating))
    lines.append("")
    lines.append("## Blind Holdout Candidates")
    lines.append("")
    lines.append("Keep these untouched until a candidate skill passes development and regression gates.")
    lines.append("")
    lines.extend(format_rows(blind))
    lines.append("")
    lines.append("## Anti-Overfitting Rule")
    lines.append("")
    lines.append("A skill may be proposed from rotating diagnostics, but promotion requires no regression on protected sets and a final blind holdout check.")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def format_rows(rows: list[dict[str, Any]]) -> list[str]:
    lines = ["| id | index | bucket | question |", "| --- | ---: | --- | --- |"]
    for row in rows:
        question = row["question"].replace("|", "\\|")
        lines.append(f"| {display_id(row)} | {row.get('index')} | {row['risk_bucket']} | {question} |")
    return lines


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gt", default=DEFAULT_ZEEKR_GT)
    parser.add_argument("--exclude_result", action="append", default=[])
    parser.add_argument("--use_current_phase_excludes", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--rotating_n", type=int, default=20)
    parser.add_argument("--blind_n", type=int, default=20)
    parser.add_argument("--seed", type=int, default=20260602)
    parser.add_argument("--output_dir", default=None)
    args = parser.parse_args()

    gt_path = Path(args.gt)
    exclude_paths = [Path(value) for value in args.exclude_result]
    if args.use_current_phase_excludes:
        exclude_paths.extend(Path(value) for value in DEFAULT_EXCLUDE_RESULTS)
    output_dir = Path(args.output_dir) if args.output_dir else Path("test/colm/retrieval/skill_evolution_testsets")
    output_dir.mkdir(parents=True, exist_ok=True)

    gt_rows = load_rows(gt_path)
    excluded = excluded_ids(exclude_paths)
    pool = build_pool(gt_rows, excluded)
    rotating = stratified_sample(pool, args.rotating_n, args.seed)
    rotating_ids = {row_id(row) for row in rotating}
    remaining = [item for item in pool if row_id(item) not in rotating_ids]
    blind = stratified_sample(remaining, args.blind_n, args.seed + 1)

    write_json(output_dir / "unseen_pool.json", pool)
    write_json(output_dir / "rotating_diagnostic_candidates.json", rotating)
    write_json(output_dir / "blind_holdout_candidates.json", blind)
    write_markdown(output_dir / "testset_refresh_report.md", gt_path, exclude_paths, pool, rotating, blind)

    payload = {
        "gt": str(gt_path),
        "excluded_count": len(excluded),
        "pool_count": len(pool),
        "rotating_n": len(rotating),
        "blind_n": len(blind),
        "pool_distribution": dict(Counter(item["risk_bucket"] for item in pool)),
        "output_dir": str(output_dir),
    }
    with open(output_dir / "testset_refresh_summary.json", "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"Wrote {output_dir / 'testset_refresh_report.md'}")


if __name__ == "__main__":
    main()
