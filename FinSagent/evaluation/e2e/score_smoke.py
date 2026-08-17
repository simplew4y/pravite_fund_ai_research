#!/usr/bin/env python3
"""Deterministically score the FinSagent smoke run and build client-facing showcases."""

from __future__ import annotations

import argparse
import json
import re
import statistics
from pathlib import Path
from typing import Any

import yaml


RULES: dict[str, list[list[str]]] = {
    "SMOKE_IS6_PORSCHE_001": [[r"\b3596(?:\.0+)?\b"], [r"\b1627(?:\.0(?:6\d*)?)?\b"], [r"\b2562(?:\.23\d*)?\b"]],
    "SMOKE_D4_QUALIFIED_002": [[r"30\s*%", r"30%"], [r"剔除阶段性", r"调整后"]],
    "SMOKE_IS1_R1_SEQUENCE_003": [
        [r"410\.164", r"4\.10164"], [r"801\.138", r"8\.01138"],
        [r"1470\.364", r"14\.70364"], [r"2311\.703", r"23\.11703"],
        [r"95\.3"], [r"83\.5"], [r"57\.2"],
    ],
    "SMOKE_D4_FORECAST_004": [[r"25\s*%\s*[-—至]\s*30\s*%", r"约?27\s*%"], [r"0\.1\s*元\s*/?\s*Wh", r"0\.1元/Wh"]],
    "SMOKE_IS6_PROFIT_BRIDGE_005": [[r"180\s*亿?\s*[-—至]\s*200"], [r"150\s*亿?\s*[-—至]\s*160"]],
    "SMOKE_D6_V1_PEER_006": [[r"20\.5"], [r"25\.67"], [r"30\.08"], [r"26\.3"], [r"21\.4"], [r"52\.6"], [r"33\.9"]],
    "SMOKE_VALUATION_PORSCHE_007": [[r"18\s*[xX倍]"], [r"14\s*[xX倍]"], [r"34\.05"]],
    "SMOKE_COMPANY_FACT_NVDA_008": [[r"Ross\s+Seymore"], [r"Melissa\s+Weathers"]],
    "SMOKE_DCF_HORIZON_011": [[r"10\.38"], [r"5\.812"], [r"0\.5\s*%"]],
    "SMOKE_REPORT_SUNGROW_012": [
        [r"89[,，]?000", r"89000"], [r"108[,，]?000", r"108000"], [r"132[,，]?000", r"132000"],
        [r"28\.5\s*%"], [r"27(?:\.0)?\s*%"], [r"26\.5\s*%"],
        [r"0\.095"], [r"0\.105"], [r"0\.110"], [r"145"], [r"190"],
        [r"45\s*GWh"], [r"52\s*GWh"], [r"58\s*GWh"], [r"0\.006"],
    ],
}

REFUSAL = re.compile(r"无法(?:回答|提供|确定|获取|计算)|未披露|不存在|资料没有|数据缺失|not available|not disclosed", re.IGNORECASE)


def doc_ids(result: dict[str, Any]) -> set[str]:
    values: set[str] = set()
    for chunk in result.get("retrieved_chunks") or []:
        metadata = chunk.get("metadata") or {}
        value = metadata.get("source_doc_id") or metadata.get("doc_id")
        if value:
            values.add(str(value))
    return values


def score_answer(case: dict[str, Any], answer: str) -> tuple[int, int, list[bool]]:
    if case.get("must_refuse"):
        hit = bool(REFUSAL.search(answer))
        return int(hit), 1, [hit]
    groups = RULES.get(str(case["case_id"]), [])
    hits = [any(re.search(pattern, answer, re.IGNORECASE) for pattern in alternatives) for alternatives in groups]
    return sum(hits), len(hits), hits


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--combo-config", required=True)
    args = parser.parse_args()
    run_dir = Path(args.run_dir).resolve()
    combos = (yaml.safe_load(Path(args.combo_config).read_text(encoding="utf-8")) or {}).get("combos") or {}
    rows: list[dict[str, Any]] = []
    for path in sorted((run_dir / "raw_outputs").glob("*/*/*/*.json")):
        record = json.loads(path.read_text(encoding="utf-8"))
        case = record["case"]
        result = record.get("result") or {}
        answer = str(result.get("answer") or "")
        hit_count, atom_count, atom_hits = score_answer(case, answer)
        ids = doc_ids(result)
        allowed = set(map(str, case.get("allowed_doc_ids") or []))
        forbidden = set(map(str, case.get("forbidden_doc_ids") or []))
        bad = sorted(ids & forbidden)
        combo_id = str(record["combo_id"])
        enabled = set(map(str, (combos.get(combo_id) or {}).get("allow") or []))
        expected = set(map(str, case.get("expected_skills") or [])) & enabled
        traces = result.get("skill_traces") or []
        triggered = {str(t.get("skill_id")) for t in traces if t.get("triggered") or t.get("status") == "applied"}
        rows.append({
            "case_id": case["case_id"], "dataset_id": record["dataset_id"],
            "retrieval_mode": record["retrieval_mode"], "combo_id": combo_id,
            "status": record["status"], "elapsed_seconds": record["elapsed_seconds"],
            "answer": answer, "answer_atom_hits": hit_count, "answer_atom_total": atom_count,
            "answer_coverage": round(hit_count / atom_count, 4) if atom_count else None,
            "answer_pass": bool(atom_count and hit_count == atom_count), "atom_hits": atom_hits,
            "retrieved_doc_ids": sorted(ids), "forbidden_doc_ids_retrieved": bad,
            "doc_boundary_pass": not bad,
            "allowed_evidence_present": bool(ids & allowed),
            "expected_enabled_skills": sorted(expected), "triggered_skills": sorted(triggered),
            "skill_trigger_recall": round(len(expected & triggered) / len(expected), 4) if expected else None,
            "raw_path": str(path),
        })

    score_dir = run_dir / "scorecards"
    showcase_dir = run_dir / "showcase"
    score_dir.mkdir(parents=True, exist_ok=True)
    showcase_dir.mkdir(parents=True, exist_ok=True)
    (score_dir / "smoke_case_scores.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    arms: list[dict[str, Any]] = []
    keys = sorted({(r["retrieval_mode"], r["combo_id"], r["dataset_id"]) for r in rows})
    for mode, combo, dataset in keys:
        subset = [r for r in rows if (r["retrieval_mode"], r["combo_id"], r["dataset_id"]) == (mode, combo, dataset)]
        latencies = [float(r["elapsed_seconds"]) for r in subset]
        atom_hit = sum(r["answer_atom_hits"] for r in subset)
        atom_total = sum(r["answer_atom_total"] for r in subset)
        boundary_fail = sum(not r["doc_boundary_pass"] for r in subset)
        recalls = [r["skill_trigger_recall"] for r in subset if r["skill_trigger_recall"] is not None]
        arms.append({
            "retrieval_mode": mode, "combo_id": combo, "dataset_id": dataset, "cases": len(subset),
            "answer_exact_pass_rate": round(sum(r["answer_pass"] for r in subset) / len(subset), 4),
            "answer_atom_coverage": round(atom_hit / atom_total, 4) if atom_total else None,
            "doc_id_boundary_violation_rate": round(boundary_fail / len(subset), 4),
            "skill_trigger_recall": round(sum(recalls) / len(recalls), 4) if recalls else None,
            "latency_p50_seconds": round(statistics.median(latencies), 3),
            "latency_p95_seconds": round(sorted(latencies)[max(0, int(len(latencies) * 0.95 + 0.999) - 1)], 3),
        })
    (score_dir / "smoke_arm_summary.json").write_text(json.dumps(arms, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    lines = ["# Smoke E2E 横向对比（确定性评分）", "", "评分仅依据标注答案原子、保存的 source_doc_id 和 Skill trace；不以文本长度代替质量。", "",
             "| 检索 | Combo | 数据集 | 完全正确率 | 答案原子覆盖 | doc_id越界率 | Skill触发召回 | P50 | P95 |",
             "|---|---|---|---:|---:|---:|---:|---:|---:|"]
    for arm in arms:
        pct = lambda value: "N/A" if value is None else f"{value:.1%}"
        lines.append(f"| {arm['retrieval_mode']} | {arm['combo_id']} | {arm['dataset_id']} | {pct(arm['answer_exact_pass_rate'])} | {pct(arm['answer_atom_coverage'])} | {pct(arm['doc_id_boundary_violation_rate'])} | {pct(arm['skill_trigger_recall'])} | {arm['latency_p50_seconds']:.1f}s | {arm['latency_p95_seconds']:.1f}s |")
    lines.extend(["", "## 逐题原话", ""])
    for row in rows:
        lines.extend([
            f"### {row['case_id']} · {row['retrieval_mode']} / {row['combo_id']} / {row['dataset_id']}", "",
            f"- 答案覆盖：{row['answer_atom_hits']}/{row['answer_atom_total']}；doc_id 越界：{row['forbidden_doc_ids_retrieved'] or '无'}；Skill 触发召回：{row['skill_trigger_recall']}", "",
            row["answer"], "",
        ])
    (showcase_dir / "smoke_comparison.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"rows": len(rows), "arms": len(arms), "scorecards": str(score_dir), "showcase": str(showcase_dir)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
