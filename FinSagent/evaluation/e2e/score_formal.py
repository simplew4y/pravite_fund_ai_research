#!/usr/bin/env python3
"""Deterministic atom, refusal, boundary, and latency scoring for formal E2E runs."""

from __future__ import annotations

import argparse
import json
import math
import re
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any


REFUSAL = re.compile(r"无法(?:回答|提供|确定|获取|计算)|未找到|未披露|数据缺失|not available|not disclosed|cannot disclose", re.I)
NUMBER = re.compile(r"(?<![A-Za-z0-9])(-?\d[\d,]*(?:\.\d+)?)\s*(亿元|百万元|百万人民币|CNYm|元/股|CNY/share|%|个百分点|倍|x|X|百万股|million shares)?")


def candidates(answer: str, unit: str) -> list[float]:
    values: list[float] = []
    for match in NUMBER.finditer(answer):
        raw, observed_unit = match.group(1), match.group(2) or ""
        try:
            value = float(raw.replace(",", ""))
        except ValueError:
            continue
        if unit == "CNYm":
            if observed_unit == "亿元": value *= 100
            elif observed_unit not in {"百万元", "百万人民币", "CNYm"}: continue
        elif unit == "%":
            if observed_unit != "%": continue
        elif unit == "ppt":
            if observed_unit not in {"个百分点", "%"}: continue
        elif unit == "x":
            if observed_unit not in {"倍", "x", "X"}: continue
        elif unit == "CNY/share":
            if observed_unit not in {"元/股", "CNY/share"}: continue
        elif unit == "million shares":
            if observed_unit not in {"百万股", "million shares"}: continue
        values.append(value)
    return values


def atom_hit(answer: str, atom: dict[str, Any]) -> bool:
    if "value" not in atom:
        text_values = atom.get("values") or []
        return bool(text_values) and all(str(value).lower() in answer.lower() for value in text_values)
    expected = float(atom["value"])
    unit = str(atom.get("unit") or "")
    tolerance = max(abs(expected) * 0.005, 0.015 if unit in {"%", "ppt", "x", "CNY/share"} else 1.0)
    return any(abs(value - expected) <= tolerance for value in candidates(answer, unit))


def ids(result: dict[str, Any]) -> set[str]:
    found: set[str] = set()
    for chunk in result.get("retrieved_chunks") or []:
        metadata = chunk.get("metadata") or {}
        value = metadata.get("source_doc_id") or metadata.get("doc_id")
        if value: found.add(str(value))
    return found


def main() -> None:
    parser = argparse.ArgumentParser(); parser.add_argument("--run-dir", required=True); args = parser.parse_args()
    run_dir = Path(args.run_dir).resolve(); rows: list[dict[str, Any]] = []
    for path in sorted((run_dir / "raw_outputs").glob("*/*/*/*.json")):
        record = json.loads(path.read_text(encoding="utf-8")); case = record["case"]
        if not case.get("formal_metric_coverage"): continue
        answer = str((record.get("result") or {}).get("answer") or "")
        atoms = case.get("answer_atoms") or []
        refusal = bool(REFUSAL.search(answer))
        hits = [atom_hit(answer, atom) for atom in atoms]
        if case.get("must_refuse"):
            hits = [refusal]
        elif refusal:
            # A required-answer case is not correct merely because the refusal
            # happens to quote a candidate equal to the labelled value.
            hits = [False for _ in hits]
        retrieved = ids(record.get("result") or {}); bad = sorted(retrieved & set(map(str, case.get("forbidden_doc_ids") or [])))
        rows.append({"case_id": case["case_id"], "metric_ids": case.get("metric_ids") or [], "dataset_id": record["dataset_id"],
                     "retrieval_mode": record["retrieval_mode"], "combo_id": record["combo_id"], "elapsed_seconds": record["elapsed_seconds"],
                     "answer_atom_hits": sum(hits), "answer_atom_total": len(hits), "answer_pass": bool(hits and all(hits)),
                     "refusal_detected": refusal, "doc_boundary_pass": not bad, "forbidden_doc_ids_retrieved": bad,
                     "answer": answer, "raw_path": str(path)})
    score_dir = run_dir / "scorecards"; score_dir.mkdir(parents=True, exist_ok=True)
    (score_dir / "formal_case_scores.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        for metric in row["metric_ids"]: grouped[(row["retrieval_mode"], row["combo_id"], metric)].append(row)
    summary: list[dict[str, Any]] = []
    for (mode, combo, metric), subset in sorted(grouped.items()):
        lat = [float(r["elapsed_seconds"]) for r in subset]
        summary.append({"retrieval_mode": mode, "combo_id": combo, "metric_id": metric, "cases": len(subset),
                        "pass_rate": round(sum(r["answer_pass"] for r in subset) / len(subset), 4),
                        "boundary_violation_rate": round(sum(not r["doc_boundary_pass"] for r in subset) / len(subset), 4),
                        "latency_p50_seconds": round(statistics.median(lat), 3),
                        "failure_case_ids": [r["case_id"] for r in subset if not r["answer_pass"]][:10]})
    (score_dir / "formal_metric_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"scored_cases": len(rows), "metrics": len(grouped), "passed": sum(r["answer_pass"] for r in rows), "score_dir": str(score_dir)}, ensure_ascii=False))


if __name__ == "__main__": main()
