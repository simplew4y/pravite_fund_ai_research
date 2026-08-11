#!/usr/bin/env python3
"""Score Skill trigger decisions against formal case expectations."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import yaml


def formula_expected(case: dict) -> bool:
    metrics = set(case.get("metric_ids", []))
    return bool(metrics & {"IS2", "CF3", "V2", "V3", "V7"})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--cases", required=True)
    parser.add_argument("--combo-config", required=True)
    parser.add_argument("--combo-id", default="C2")
    args = parser.parse_args()

    run_dir = Path(args.run_dir)
    cases_payload = json.loads(Path(args.cases).read_text())
    cases = {item["case_id"]: item for item in cases_payload["cases"]}
    combo = yaml.safe_load(Path(args.combo_config).read_text())["combos"][args.combo_id]
    allowed = list(combo["allow"])
    raw_files = sorted((run_dir / "raw_outputs").glob("**/*.json"))

    rows = []
    per_skill = {skill: {"tp": 0, "fp": 0, "fn": 0, "tn": 0, "mismatches": []} for skill in allowed}
    applied_answers = []
    for raw_path in raw_files:
        payload = json.loads(raw_path.read_text())
        cid = payload["case"]["case_id"]
        case = cases[cid]
        traces = payload.get("result", {}).get("skill_traces", [])
        actual = {trace["skill_id"] for trace in traces if trace.get("triggered")}
        expected = set(case.get("expected_skills", [])) & set(allowed)
        if formula_expected(case):
            expected.add("financial_formula_verifier")
        for trace in traces:
            if trace.get("triggered") and trace.get("answer"):
                applied_answers.append({
                    "case_id": cid,
                    "skill_id": trace["skill_id"],
                    "answer": trace["answer"],
                    "trace": trace.get("trace", {}),
                })
        for skill in allowed:
            want, got = skill in expected, skill in actual
            bucket = "tp" if want and got else "fp" if got else "fn" if want else "tn"
            per_skill[skill][bucket] += 1
            if want != got:
                per_skill[skill]["mismatches"].append({"case_id": cid, "expected": want, "triggered": got})
        rows.append({
            "case_id": cid,
            "expected": sorted(expected),
            "triggered": sorted(actual),
            "unexpected": sorted(actual - expected),
            "missed": sorted(expected - actual),
        })

    summary = {}
    totals = {"tp": 0, "fp": 0, "fn": 0, "tn": 0}
    for skill, counts in per_skill.items():
        for key in totals:
            totals[key] += counts[key]
        precision = counts["tp"] / (counts["tp"] + counts["fp"]) if counts["tp"] + counts["fp"] else 1.0
        recall = counts["tp"] / (counts["tp"] + counts["fn"]) if counts["tp"] + counts["fn"] else 1.0
        accuracy = (counts["tp"] + counts["tn"]) / len(rows)
        summary[skill] = {**counts, "precision": precision, "recall": recall, "accuracy": accuracy}
    micro_precision = totals["tp"] / (totals["tp"] + totals["fp"]) if totals["tp"] + totals["fp"] else 1.0
    micro_recall = totals["tp"] / (totals["tp"] + totals["fn"]) if totals["tp"] + totals["fn"] else 1.0
    micro_accuracy = (totals["tp"] + totals["tn"]) / sum(totals.values())
    output = {
        "run_dir": str(run_dir),
        "combo_id": args.combo_id,
        "cases": len(rows),
        "allowed_skills": allowed,
        "micro": {**totals, "precision": micro_precision, "recall": micro_recall, "accuracy": micro_accuracy},
        "per_skill": summary,
        "answer_repair_count": len(applied_answers),
        "answer_repairs": applied_answers,
        "case_rows": rows,
        "expectation_note": "Case expected_skills labels plus deterministic formula expectation for CF3/V2/V3/V7.",
    }
    score_dir = run_dir / "scorecards"
    score_dir.mkdir(parents=True, exist_ok=True)
    json_path = score_dir / "skill_trigger_scorecard.json"
    json_path.write_text(json.dumps(output, ensure_ascii=False, indent=2))

    md = [
        f"# {args.combo_id} Skill 触发评分",
        "",
        f"样本：{len(rows)}；micro precision={micro_precision:.1%}，recall={micro_recall:.1%}，accuracy={micro_accuracy:.1%}。",
        "",
        "| Skill | TP | FP | FN | TN | Precision | Recall | Accuracy |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for skill, item in summary.items():
        md.append(
            f"| {skill} | {item['tp']} | {item['fp']} | {item['fn']} | {item['tn']} | "
            f"{item['precision']:.1%} | {item['recall']:.1%} | {item['accuracy']:.1%} |"
        )
    md += ["", f"实际覆盖最终答案的确定性 repair：{len(applied_answers)} 次。", ""]
    for item in applied_answers:
        md.append(f"- {item['case_id']} · {item['skill_id']}：{item['answer']}")
    (score_dir / "skill_trigger_scorecard.md").write_text("\n".join(md))
    print(json.dumps({"json": str(json_path), "micro": output["micro"], "answer_repair_count": len(applied_answers)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
