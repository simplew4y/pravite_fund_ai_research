#!/usr/bin/env python3
"""Build a first-pass SEC QA skill-evolution report from judge results.

This is intentionally conservative: it does not edit the QA system or generate
rules to auto-merge. It turns evaluated failures into skill proposals that can
be regression-tested and reviewed before becoming part of the pipeline.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


DEFAULT_RUNS = {
    "zeekr_small30_cap2": "test/colm/retrieval/subquery_cap2_small30_20260530/standard_validation_coverage_v1_judge/judge/results.json",
    "zeekr_diagnostic_holdout20": "test/colm/retrieval/holdout20_cap2_20260531/standard_validation_coverage_v1_judge/judge/results.json",
    "nvidia_mini10_sanity": "test/colm/retrieval/nvidia_mini10_cap2_20260601/judge/results.json",
}


@dataclass(frozen=True)
class SkillDefinition:
    name: str
    status: str
    description: str
    intuitive: str
    proposal: str
    regression_gate: str


SKILLS: dict[str, SkillDefinition] = {
    "period_control": SkillDefinition(
        name="Period Control Skill",
        status="existing / extend",
        description="Control filing dates, fiscal periods, and event timelines so historical questions do not absorb later disclosures.",
        intuitive="Ask 2024 questions with 2024-appropriate evidence, not with facts learned from later filings.",
        proposal="Strengthen period extraction, source-date filtering, and period-specific backfill for policy/event questions.",
        regression_gate="No new future-leakage errors on Zeekr diagnostic holdout or NVIDIA sanity; small30 stays green.",
    ),
    "table_verification": SkillDefinition(
        name="Table Verification Skill",
        status="existing / extend",
        description="Verify numeric answers against structured table facts, including row, column, unit, currency, and period.",
        intuitive="Do not let the LLM eyeball financial tables alone; make the program check the number.",
        proposal="Expand recurring metric coverage for cash, revenue, R&D, volume, customer share, and unit conversion.",
        regression_gate="Numeric/table failures are blocked or corrected without increasing false blocks on small30.",
    ),
    "fact_registry": SkillDefinition(
        name="Narrow Fact Registry Skill",
        status="candidate",
        description="Store high-frequency stable facts with source filing, source date, and applicability window.",
        intuitive="Keep a small sourced notebook for facts the system repeatedly confuses, not a giant hand-written encyclopedia.",
        proposal="Create candidate fact entries only for repeated stable facts: products, board, manufacturing, company structure.",
        regression_gate="Fact candidates improve diagnostic cases and do not override period-specific evidence.",
    ),
    "coverage": SkillDefinition(
        name="Coverage Skill",
        status="existing / extend",
        description="Check whether multi-key-point answers cover all required dimensions before final output.",
        intuitive="If the answer is directionally right but misses two required bullets, ask for evidence and fill the gap.",
        proposal="Generate per-question coverage checklists from key points or question type, then trigger rescue when missing.",
        regression_gate="PARTIAL rows improve without adding contradictions or excessive verbosity.",
    ),
    "source_conflict": SkillDefinition(
        name="Source Priority / Conflict Resolver Skill",
        status="candidate",
        description="Resolve conflicts between filings, later updates, summaries, tables, and narrative sections.",
        intuitive="When two filings disagree, prefer the source that matches the question's date and metric.",
        proposal="Add explicit source-priority rules by question type: target-period filing > later filing; table > summary for numeric values.",
        regression_gate="Reduces contradiction/timeline failures and does not suppress valid later-period questions.",
    ),
    "evidence_sufficiency": SkillDefinition(
        name="Evidence Sufficiency Skill",
        status="candidate",
        description="Detect when retrieved evidence is insufficient and choose a conservative answer instead of hallucinating.",
        intuitive="If the evidence is not enough, say what cannot be confirmed rather than filling the blank.",
        proposal="Score evidence coverage before and after generation; require support for each critical key point.",
        regression_gate="Fewer unsupported claims; no drop on cases where evidence is actually sufficient.",
    ),
    "rescue_ranking": SkillDefinition(
        name="Rescue Ranking Skill",
        status="trained / optional",
        description="Use a learned scorer to prioritize evidence-rescue candidates.",
        intuitive="When rescuing evidence, sort the likely useful pages above noisy pages.",
        proposal="Keep as optional until E2E holdout shows stable improvement over rule rescue.",
        regression_gate="Improves diagnostic retrieval quality with no small30 regression and acceptable latency.",
    ),
    "cost_control": SkillDefinition(
        name="Cost Control Skill",
        status="existing",
        description="Keep retrieval and agent work bounded while preserving answer quality.",
        intuitive="More context is not always better; keep the useful evidence and drop the noisy excess.",
        proposal="Use the current cap2 profile as the freeze baseline; only widen budgets for routed high-risk cases.",
        regression_gate="Latency remains near the frozen baseline unless a high-risk route justifies extra cost.",
    ),
}


KEYWORDS: dict[str, tuple[str, ...]] = {
    "period_control": (
        "2022",
        "2023",
        "2024",
        "2025",
        "2026",
        "fiscal",
        "quarter",
        "q1",
        "q2",
        "q3",
        "q4",
        "period",
        "timeline",
        "date",
        "merger",
        "ipo",
        "listing",
        "covid",
        "policy",
        "tariff",
        "export",
        "h20",
        "future",
        "later",
        "subsequent",
        "relationship",
        "geely",
        "control",
        "regulation",
        "许可证",
        "出口",
        "财年",
        "季度",
        "政策",
        "上市",
        "时间",
    ),
    "table_verification": (
        "cash",
        "balance",
        "revenue",
        "r&d",
        "expense",
        "volume",
        "breakdown",
        "delivery",
        "deliveries",
        "ads",
        "price",
        "million",
        "billion",
        "rmb",
        "usd",
        "percentage",
        "numeric",
        "unit",
        "table",
        "现金",
        "收入",
        "研发",
        "费用",
        "销量",
        "余额",
        "定价",
        "规模",
    ),
    "fact_registry": (
        "product",
        "portfolio",
        "matrix",
        "board",
        "director",
        "manufactured",
        "factory",
        "zeekr power",
        "availability",
        "employee",
        "geely",
        "relationship",
        "structure",
        "subsidiary",
        "产品",
        "矩阵",
        "董事",
        "生产",
        "工厂",
        "员工",
        "构成",
    ),
    "coverage": (
        "missing",
        "omits",
        "fails to mention",
        "does not mention",
        "partial",
        "key point",
        "pipeline",
        "risk",
        "risks",
        "global availability",
        "contribution",
        "漏",
        "未提及",
        "风险",
        "管线",
    ),
    "source_conflict": (
        "contradict",
        "conflict",
        "version",
        "future-effective",
        "source",
        "filing",
        "definitive",
        "announced",
        "completed",
        "current",
        "whereas",
        "instead",
        "冲突",
        "矛盾",
        "披露",
        "文件",
        "版本",
    ),
    "evidence_sufficiency": (
        "not disclosed",
        "not available",
        "not contain",
        "insufficient",
        "cannot determine",
        "cannot confirm",
        "unavailable",
        "unclear",
        "未披露",
        "无法确认",
        "无法确定",
        "没有",
        "不清楚",
    ),
}


def normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def verdict_of(row: dict[str, Any]) -> str:
    return normalize_text(row.get("judge_verdict") or row.get("verdict") or "UNKNOWN").upper()


def id_of(row: dict[str, Any]) -> str:
    if row.get("qid") is not None:
        return str(row.get("qid"))
    if row.get("index") is not None:
        return f"idx_{row.get('index')}"
    question = normalize_text(row.get("question") or row.get("original_question"))
    return question[:80] or "unknown"


def parse_run_arg(value: str) -> tuple[str, Path]:
    if "=" not in value:
        path = Path(value)
        return path.parent.name or path.stem, path
    name, raw_path = value.split("=", 1)
    name = name.strip()
    if not name:
        raise ValueError(f"Run name is empty in {value!r}")
    return name, Path(raw_path.strip())


def load_rows(path: Path) -> list[dict[str, Any]]:
    with open(path, encoding="utf-8") as f:
        rows = json.load(f)
    if not isinstance(rows, list):
        raise ValueError(f"Judge results must be a JSON list: {path}")
    return [row for row in rows if isinstance(row, dict)]


def classify_failure(row: dict[str, Any]) -> list[str]:
    question = normalize_text(row.get("question") or row.get("original_question"))
    analysis = normalize_text(row.get("judge_analysis") or row.get("analysis"))
    answer = normalize_text(row.get("answer") or row.get("generated_answer"))
    gt = normalize_text(row.get("gt_answer") or row.get("original_answer"))
    subtype = " ".join(
        [
            normalize_text(row.get("error_primary_group")),
            normalize_text(row.get("error_primary_subtype")),
            " ".join(str(item) for item in row.get("error_secondary_subtypes") or []),
        ]
    )
    text = " ".join([question, analysis, answer[:1200], gt[:1200], subtype]).lower()
    question_text = question.lower()
    verdict = verdict_of(row)

    scores: Counter[str] = Counter()
    for skill, keywords in KEYWORDS.items():
        if skill == "source_conflict":
            continue
        for keyword in keywords:
            if keyword.lower() in text:
                scores[skill] += 1

    question_boosts: dict[str, tuple[str, ...]] = {
        "fact_registry": (
            "product matrix",
            "product portfolio",
            "产品矩阵",
            "board",
            "董事会",
            "director",
            "manufactured",
            "manufacturing",
            "生产",
            "factory",
            "zeekr power",
            "global availability",
            "availability",
            "employees",
            "员工",
        ),
        "table_verification": (
            "cash balance",
            "现金余额",
            "revenue",
            "销售收入",
            "收入",
            "r&d",
            "研发费用",
            "expense",
            "volume breakdown",
            "销量",
            "contribution",
            "贡献度",
            "ipo的规模",
            "pricing",
            "定价",
        ),
        "period_control": (
            "geely and zeekr",
            "relationship",
            "ipo",
            "covid",
            "policy",
            "tariff",
            "export",
            "出口管制",
            "corporate structuring",
            "march and april",
            "q1",
            "q2",
            "q3",
            "q4",
            "二季度",
            "四季度",
        ),
        "coverage": (
            "major risks",
            "risks",
            "product pipeline",
            "pipeline",
            "plan for ice",
            "不同的产品销量贡献度",
        ),
    }
    for skill, keywords in question_boosts.items():
        if any(keyword in question_text for keyword in keywords):
            scores[skill] += 7 if skill in {"fact_registry", "table_verification"} else 5
    if "global availability" in question_text:
        scores["fact_registry"] += 8

    if verdict == "PARTIAL" or int(row.get("kp_missing") or 0) > 0:
        scores["coverage"] += 5
    analysis_text = analysis.lower()
    conflict_phrases = (
        "directly contradict",
        "contradicts",
        "contradiction",
        "conflicts with",
        "whereas",
        "instead",
        "wrong",
    )
    has_source_conflict = int(row.get("kp_incorrect") or 0) > 0 or any(
        phrase in analysis_text for phrase in conflict_phrases
    )
    if has_source_conflict:
        scores["source_conflict"] += 4
    if re.search(r"\b\d{4}\b|q[1-4]|quarter|fiscal|财年|季度", question_text):
        scores["period_control"] += 1
    if re.search(r"\b\d+(?:\.\d+)?\s*(?:%|million|billion|rmb|usd)\b", text):
        scores["table_verification"] += 1
    if "not contain" in text or "not available" in text or "无法" in text:
        scores["evidence_sufficiency"] += 2

    if not scores:
        return ["evidence_sufficiency"]

    max_score = max(scores.values())
    selected = [skill for skill, score in scores.items() if score >= max(2, max_score - 2)]
    if scores.get("source_conflict", 0) >= max(4, max_score - 2) and "source_conflict" not in selected:
        selected.append("source_conflict")

    # Keep reports readable: each case should point to the primary few skills.
    priority = [
        "period_control",
        "table_verification",
        "fact_registry",
        "coverage",
        "source_conflict",
        "evidence_sufficiency",
        "rescue_ranking",
        "cost_control",
    ]
    selected = sorted(set(selected), key=lambda skill: (-scores[skill], priority.index(skill)))
    return selected[:3]


def compact_case(row: dict[str, Any], run_name: str) -> dict[str, Any]:
    skills = classify_failure(row)
    return {
        "run": run_name,
        "qid": row.get("qid"),
        "index": row.get("index"),
        "question": normalize_text(row.get("question") or row.get("original_question")),
        "verdict": verdict_of(row),
        "kp_matched": row.get("kp_matched"),
        "kp_partial": row.get("kp_partial"),
        "kp_missing": row.get("kp_missing"),
        "kp_incorrect": row.get("kp_incorrect"),
        "kp_coverage_ratio": row.get("kp_coverage_ratio"),
        "skills": skills,
        "primary_skill": skills[0] if skills else "evidence_sufficiency",
        "judge_analysis": normalize_text(row.get("judge_analysis"))[:900],
        "answer_excerpt": normalize_text(row.get("answer") or row.get("generated_answer"))[:500],
        "gt_excerpt": normalize_text(row.get("gt_answer") or row.get("original_answer"))[:500],
    }


def summarize_runs(run_paths: dict[str, Path]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    summary: dict[str, Any] = {"runs": {}, "skill_counts": {}, "skill_case_counts": {}}
    cases: list[dict[str, Any]] = []
    skill_counter: Counter[str] = Counter()
    skill_case_counter: Counter[str] = Counter()

    for run_name, path in run_paths.items():
        rows = load_rows(path)
        verdict_counts = Counter(verdict_of(row) for row in rows)
        failures = [row for row in rows if verdict_of(row) != "CORRECT"]
        run_cases = [compact_case(row, run_name) for row in failures]
        cases.extend(run_cases)
        for case in run_cases:
            skill_case_counter[case["primary_skill"]] += 1
            for skill in case["skills"]:
                skill_counter[skill] += 1

        summary["runs"][run_name] = {
            "path": str(path),
            "total": len(rows),
            "verdict_counts": dict(verdict_counts),
            "failure_count": len(failures),
            "failure_rate": round(len(failures) / len(rows), 4) if rows else None,
        }

    summary["skill_counts"] = dict(skill_counter)
    summary["skill_case_counts"] = dict(skill_case_counter)
    return summary, cases


def write_cases_csv(path: Path, cases: list[dict[str, Any]]) -> None:
    fields = [
        "run",
        "qid",
        "index",
        "verdict",
        "primary_skill",
        "skills",
        "kp_matched",
        "kp_partial",
        "kp_missing",
        "kp_incorrect",
        "kp_coverage_ratio",
        "question",
        "judge_analysis",
        "answer_excerpt",
        "gt_excerpt",
    ]
    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for case in cases:
            row = dict(case)
            row["skills"] = ";".join(case.get("skills") or [])
            writer.writerow({field: row.get(field) for field in fields})


def representative_cases(cases: list[dict[str, Any]], skill: str, limit: int = 4) -> list[dict[str, Any]]:
    selected = [case for case in cases if skill in (case.get("skills") or [])]
    selected.sort(key=lambda case: (case.get("run") or "", str(case.get("qid") or case.get("index") or "")))
    return selected[:limit]


def write_markdown(path: Path, summary: dict[str, Any], cases: list[dict[str, Any]]) -> None:
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    lines: list[str] = []
    lines.append("# SEC QA Skill Evolution MVP Report")
    lines.append("")
    lines.append(f"Generated: {now}")
    lines.append("")
    lines.append("## Scope")
    lines.append("")
    lines.append(
        "This MVP converts judge failures into candidate SEC QA pipeline skills. "
        "It does not auto-edit code or auto-merge rules; proposals must pass regression gates first."
    )
    lines.append("")
    lines.append("## Runs")
    lines.append("")
    lines.append("| run | total | verdicts | failures |")
    lines.append("| --- | ---: | --- | ---: |")
    for run_name, run in summary["runs"].items():
        verdicts = ", ".join(f"{key}={value}" for key, value in sorted(run["verdict_counts"].items()))
        lines.append(f"| {run_name} | {run['total']} | {verdicts} | {run['failure_count']} |")
    lines.append("")
    lines.append("## Skill Buckets")
    lines.append("")
    lines.append("| skill | status | primary cases | all linked cases | intuitive meaning |")
    lines.append("| --- | --- | ---: | ---: | --- |")
    primary_counts = Counter(case["primary_skill"] for case in cases)
    linked_counts = Counter()
    for case in cases:
        for skill in case.get("skills") or []:
            linked_counts[skill] += 1
    for skill, definition in SKILLS.items():
        if primary_counts.get(skill, 0) == 0 and linked_counts.get(skill, 0) == 0:
            continue
        lines.append(
            f"| {definition.name} | {definition.status} | {primary_counts.get(skill, 0)} | "
            f"{linked_counts.get(skill, 0)} | {definition.intuitive} |"
        )
    lines.append("")
    lines.append("## Candidate Skill Proposals")
    for skill, definition in SKILLS.items():
        reps = representative_cases(cases, skill)
        if not reps:
            continue
        lines.append("")
        lines.append(f"### {definition.name}")
        lines.append("")
        lines.append(f"- Status: {definition.status}")
        lines.append(f"- What it handles: {definition.description}")
        lines.append(f"- Proposal: {definition.proposal}")
        lines.append(f"- Regression gate: {definition.regression_gate}")
        lines.append("- Representative cases:")
        for case in reps:
            qid = case.get("qid") or f"idx_{case.get('index')}"
            question = case.get("question")
            verdict = case.get("verdict")
            lines.append(f"  - `{case['run']}` `{qid}` {verdict}: {question}")
    lines.append("")
    lines.append("## Recommended Loop")
    lines.append("")
    lines.append("1. Run evaluation on frozen small set, diagnostic set, and cross-company sanity set.")
    lines.append("2. Cluster failures into the skill buckets above.")
    lines.append("3. Generate a skill proposal instead of directly patching answers.")
    lines.append("4. Run regression gates: no small30 regression, diagnostic improvement, cross-company no regression, latency bounded.")
    lines.append("5. Promote the skill to the library only after gate pass and human review.")
    lines.append("")
    lines.append("## Current Interpretation")
    lines.append("")
    lines.append(
        "The current failures are concentrated in period control, stable facts, numeric/table verification, "
        "coverage, and source-conflict handling. This supports targeted skill evolution over another large "
        "retrieval-architecture rewrite."
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--judge_result",
        action="append",
        default=[],
        help="Judge results as NAME=PATH. Can be repeated.",
    )
    parser.add_argument(
        "--use_current_phase_defaults",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Use current small30, holdout20, and NVIDIA mini10 result paths.",
    )
    parser.add_argument(
        "--output_dir",
        default=None,
        help="Directory for skill_evolution_summary.json, failure_cases.csv, and skill_proposals.md.",
    )
    args = parser.parse_args()

    run_paths: dict[str, Path] = {}
    if args.use_current_phase_defaults:
        run_paths.update({name: Path(path) for name, path in DEFAULT_RUNS.items()})
    for value in args.judge_result:
        name, path = parse_run_arg(value)
        run_paths[name] = path
    if not run_paths:
        raise SystemExit("Provide --judge_result NAME=PATH or --use_current_phase_defaults.")

    missing = [str(path) for path in run_paths.values() if not path.exists()]
    if missing:
        raise FileNotFoundError("Missing judge result files: " + ", ".join(missing))

    if args.output_dir:
        output_dir = Path(args.output_dir)
    else:
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_dir = Path("test/colm/retrieval") / f"skill_evolution_mvp_{stamp}"
    output_dir.mkdir(parents=True, exist_ok=True)

    summary, cases = summarize_runs(run_paths)
    summary["case_count"] = len(cases)
    summary["output_dir"] = str(output_dir)

    with open(output_dir / "skill_evolution_summary.json", "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    write_cases_csv(output_dir / "failure_cases.csv", cases)
    write_markdown(output_dir / "skill_proposals.md", summary, cases)

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"Wrote {output_dir / 'skill_proposals.md'}")


if __name__ == "__main__":
    main()
