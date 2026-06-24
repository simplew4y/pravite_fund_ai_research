#!/usr/bin/env python3
"""Long-cycle auto-promotion risk baselines for SkillOps.

The experiment compares three automatic promotion policies:

- naive: every candidate that fixes its targeted positive case is promoted.
- self_review_proxy: the candidate is promoted only if a lightweight automatic
  reviewer sees core company/year/period/evidence guards.
- static_guarded: the candidate is promoted only if it passes a fixed regression
  suite with target positives, already-correct noops, scope negatives, and
  cross-company negatives.

It does not mutate the production registry or pipeline. It writes a risk report
that can be used as a paper ablation against the governed SkillOps gate without
relying on a deliberately weak strawman baseline.
"""

from __future__ import annotations

import argparse
import json
import random
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import sys

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from utils.profile_fact_repair import repair_profile_answer


BASELINE_MODES = ("naive", "self_review_proxy", "static_guarded")


ZEEKR_ANNUAL_NET_LOSS_EVIDENCE = (
    "For the year ended December 31, 2024, Net loss was (5,790,649) RMB thousand "
    "and (793,315) US$ thousand. For 2023, Net loss was (8,264,191) RMB thousand. "
    "The company stated that net loss narrowed by 29.9% year over year."
)

NVIDIA_ANNUAL_DIRECT_CUSTOMER_EVIDENCE = (
    "Sales to direct Customers A, B and C represented 12%, 11% and 11% of total revenue, "
    "respectively, for fiscal year 2025, all of which were primarily attributable to the "
    "Compute & Networking segment."
)


@dataclass(frozen=True)
class Case:
    case_id: str
    skill: str
    role: str
    question: str
    answer: str
    evidence: str
    should_change: bool


@dataclass(frozen=True)
class CandidatePolicy:
    candidate_id: str
    skill: str
    require_company: bool
    require_year: bool
    require_full_year_scope: bool
    require_evidence: bool
    preserve_correct_answer: bool
    reject_attributable_scope: bool = True


CASES: list[Case] = [
    Case(
        case_id="zeekr_target_conflict",
        skill="annual_net_loss_statement_precedence",
        role="target_positive",
        question="What was Zeekr's full-year 2024 net profit or net loss?",
        answer="Zeekr has two disclosed values, RMB 6,423,570 thousand and RMB 5,790,649 thousand, so it is unclear.",
        evidence=ZEEKR_ANNUAL_NET_LOSS_EVIDENCE,
        should_change=True,
    ),
    Case(
        case_id="zeekr_correct_noop",
        skill="annual_net_loss_statement_precedence",
        role="protected_noop",
        question="What was Zeekr's full-year 2024 net profit or net loss?",
        answer="Zeekr reported a 2024 net loss of RMB 5,790.649 million (US$793.3 million), narrowing 29.9% from 2023.",
        evidence="",
        should_change=False,
    ),
    Case(
        case_id="zeekr_correct_with_evidence_noop",
        skill="annual_net_loss_statement_precedence",
        role="protected_noop",
        question="What was Zeekr's full-year 2024 net profit or net loss?",
        answer="Zeekr reported a 2024 net loss of RMB 5,790.649 million (US$793.3 million), narrowing 29.9% from 2023.",
        evidence=ZEEKR_ANNUAL_NET_LOSS_EVIDENCE,
        should_change=False,
    ),
    Case(
        case_id="zeekr_missing_evidence_negative",
        skill="annual_net_loss_statement_precedence",
        role="scope_negative",
        question="What was Zeekr's full-year 2024 net profit or net loss?",
        answer="Zeekr has conflicting 2024 values, and this snippet does not show the annual net-loss line.",
        evidence="Only a shareholder-attributable loss snippet is available.",
        should_change=False,
    ),
    Case(
        case_id="zeekr_attributable_scope_negative",
        skill="annual_net_loss_statement_precedence",
        role="scope_negative",
        question="What was Zeekr's 2024 net loss attributable to shareholders?",
        answer="The shareholder-attributable loss was RMB 6,423,570 thousand.",
        evidence=ZEEKR_ANNUAL_NET_LOSS_EVIDENCE,
        should_change=False,
    ),
    Case(
        case_id="zeekr_full_year_attributable_scope_negative",
        skill="annual_net_loss_statement_precedence",
        role="scope_negative",
        question="What was Zeekr's full-year 2024 net loss attributable to ordinary shareholders?",
        answer="The full-year shareholder-attributable loss was RMB 6,423,570 thousand.",
        evidence=ZEEKR_ANNUAL_NET_LOSS_EVIDENCE,
        should_change=False,
    ),
    Case(
        case_id="lotus_company_negative",
        skill="annual_net_loss_statement_precedence",
        role="cross_company_negative",
        question="What was Lotus Technology's full-year 2024 net loss?",
        answer="Lotus reported a different company-specific net loss; Zeekr evidence should not apply.",
        evidence=ZEEKR_ANNUAL_NET_LOSS_EVIDENCE,
        should_change=False,
    ),
    Case(
        case_id="nvidia_target_conflict",
        skill="annual_direct_customer_table_precedence",
        role="target_positive",
        question="For fiscal year 2025, which NVIDIA direct customers contributed more than 10% of revenue?",
        answer="NVIDIA did not disclose any direct customer contributing 10% or more in fiscal year 2025.",
        evidence=NVIDIA_ANNUAL_DIRECT_CUSTOMER_EVIDENCE,
        should_change=True,
    ),
    Case(
        case_id="nvidia_correct_noop",
        skill="annual_direct_customer_table_precedence",
        role="protected_noop",
        question="For fiscal year 2025, which NVIDIA direct customers contributed more than 10% of revenue?",
        answer="Direct Customer A represented 12%, Direct Customer B represented 11%, and Direct Customer C represented 11%.",
        evidence="",
        should_change=False,
    ),
    Case(
        case_id="nvidia_correct_with_evidence_noop",
        skill="annual_direct_customer_table_precedence",
        role="protected_noop",
        question="For fiscal year 2025, which NVIDIA direct customers contributed more than 10% of revenue?",
        answer="Direct Customer A represented 12%, Direct Customer B represented 11%, and Direct Customer C represented 11%.",
        evidence=NVIDIA_ANNUAL_DIRECT_CUSTOMER_EVIDENCE,
        should_change=False,
    ),
    Case(
        case_id="nvidia_q1_scope_negative",
        skill="annual_direct_customer_table_precedence",
        role="scope_negative",
        question="For the first quarter of fiscal year 2025, which NVIDIA direct customers exceeded 10% of revenue?",
        answer="For Q1 fiscal 2025, Customer A represented 13% and Customer B represented 11%.",
        evidence=NVIDIA_ANNUAL_DIRECT_CUSTOMER_EVIDENCE,
        should_change=False,
    ),
    Case(
        case_id="nvidia_first_half_scope_negative",
        skill="annual_direct_customer_table_precedence",
        role="scope_negative",
        question="For the first half of fiscal year 2025, which NVIDIA direct customers exceeded 10% of revenue?",
        answer="For the first half of fiscal year 2025, the direct customer percentages differed from the annual table.",
        evidence=NVIDIA_ANNUAL_DIRECT_CUSTOMER_EVIDENCE,
        should_change=False,
    ),
    Case(
        case_id="nvidia_fy2024_year_negative",
        skill="annual_direct_customer_table_precedence",
        role="scope_negative",
        question="For fiscal year 2024, which NVIDIA direct customers contributed more than 10% of revenue?",
        answer="Fiscal year 2024 should use the FY2024 customer concentration table, not FY2025.",
        evidence=NVIDIA_ANNUAL_DIRECT_CUSTOMER_EVIDENCE,
        should_change=False,
    ),
    Case(
        case_id="amd_company_negative",
        skill="annual_direct_customer_table_precedence",
        role="cross_company_negative",
        question="For fiscal year 2025, which AMD direct customers contributed more than 10% of revenue?",
        answer="AMD evidence is not NVIDIA evidence.",
        evidence=NVIDIA_ANNUAL_DIRECT_CUSTOMER_EVIDENCE,
        should_change=False,
    ),
]


def _contains_any(text: str, needles: tuple[str, ...]) -> bool:
    lowered = text.lower()
    return any(needle.lower() in lowered for needle in needles)


def _question_has_company(case: Case, policy: CandidatePolicy) -> bool:
    if not policy.require_company:
        return True
    question = case.question.lower()
    if policy.skill == "annual_net_loss_statement_precedence":
        return "zeekr" in question or "极氪" in case.question
    return "nvidia" in question or "英伟达" in case.question


def _question_has_year(case: Case, policy: CandidatePolicy) -> bool:
    if not policy.require_year:
        return True
    return "2024" in case.question if policy.skill == "annual_net_loss_statement_precedence" else "2025" in case.question


def _question_has_full_year_scope(case: Case, policy: CandidatePolicy) -> bool:
    if not policy.require_full_year_scope:
        return True
    text = case.question.lower()
    has_full_year = _contains_any(text, ("full-year", "full year", "fiscal year", "annual", "year ended", "全年", "年度", "财年"))
    has_partial = _contains_any(
        text,
        ("quarter", "q1", "q2", "q3", "q4", "first half", "nine months", "第一季度", "第二季度", "第三季度", "第四季度", "上半年"),
    )
    return has_full_year and not has_partial


def _has_evidence(case: Case, policy: CandidatePolicy) -> bool:
    if not policy.require_evidence:
        return True
    text = case.evidence.lower()
    if policy.skill == "annual_net_loss_statement_precedence":
        return "5,790,649" in text and "8,264,191" in text
    return "direct customers a, b and c" in text and "12%, 11% and 11%" in text


def _already_correct(case: Case, policy: CandidatePolicy) -> bool:
    text = case.answer.lower()
    if policy.skill == "annual_net_loss_statement_precedence":
        return "5,790.649" in text and "29.9%" in text
    return "direct customer a" in text and "direct customer b" in text and "direct customer c" in text and "12%" in text


def apply_candidate(case: Case, policy: CandidatePolicy) -> dict[str, Any]:
    if case.skill != policy.skill:
        return {"changed": False, "answer": case.answer, "reason": "skill_not_applicable"}
    if not _question_has_company(case, policy):
        return {"changed": False, "answer": case.answer, "reason": "company_guard"}
    if not _question_has_year(case, policy):
        return {"changed": False, "answer": case.answer, "reason": "year_guard"}
    if not _question_has_full_year_scope(case, policy):
        return {"changed": False, "answer": case.answer, "reason": "scope_guard"}
    if policy.reject_attributable_scope and "attributable" in case.question.lower():
        return {"changed": False, "answer": case.answer, "reason": "attributable_scope_guard"}
    if not _has_evidence(case, policy):
        return {"changed": False, "answer": case.answer, "reason": "evidence_guard"}
    if policy.preserve_correct_answer and _already_correct(case, policy):
        return {"changed": False, "answer": case.answer, "reason": "correct_noop_guard"}

    if policy.skill == "annual_net_loss_statement_precedence":
        answer = (
            "Auto baseline repair: Zeekr full-year 2024 net loss was RMB 5,790.649 million "
            "(US$793.3 million), narrowing 29.9% from 2023."
        )
    else:
        answer = (
            "Auto baseline repair: For fiscal year 2025, Direct Customer A represented 12%, "
            "Direct Customer B represented 11%, and Direct Customer C represented 11% of NVIDIA revenue."
        )
    return {"changed": answer != case.answer, "answer": answer, "reason": "auto_repair"}


def governed_baseline() -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for case in CASES:
        result = repair_profile_answer(
            case.question,
            case.answer,
            [{"page_content": case.evidence}] if case.evidence else [],
            allow_legacy_answer_fallback=False,
        )
        changed = str(result.get("answer") or "") != case.answer
        rows.append(
            {
                "case_id": case.case_id,
                "role": case.role,
                "skill": case.skill,
                "expected_change": case.should_change,
                "changed": changed,
                "passed": changed == case.should_change,
                "reason": result.get("repair_reason"),
                "applied_by": (result.get("profile_fact") or {}).get("applied_by"),
            }
        )
    failures = [row for row in rows if not row["passed"]]
    return {"status": "PASS" if not failures else "FAIL", "failures": failures, "rows": rows}


def random_policy(cycle: int, rng: random.Random) -> CandidatePolicy:
    skill = rng.choice(["annual_net_loss_statement_precedence", "annual_direct_customer_table_precedence"])
    return CandidatePolicy(
        candidate_id=f"auto_cycle_{cycle:04d}_{skill}",
        skill=skill,
        require_company=rng.random() < 0.72,
        require_year=rng.random() < 0.72,
        require_full_year_scope=rng.random() < 0.60,
        require_evidence=rng.random() < 0.68,
        preserve_correct_answer=rng.random() < 0.64,
        reject_attributable_scope=(rng.random() < 0.65 if skill == "annual_net_loss_statement_precedence" else True),
    )


def targeted_passes(policy: CandidatePolicy) -> bool:
    targets = [case for case in CASES if case.skill == policy.skill and case.role == "target_positive"]
    return all(apply_candidate(case, policy)["changed"] for case in targets)


def candidate_regression_passes(policy: CandidatePolicy) -> bool:
    relevant_cases = [case for case in CASES if case.skill == policy.skill]
    for case in relevant_cases:
        result = apply_candidate(case, policy)
        if bool(result["changed"]) != case.should_change:
            return False
    return True


def self_review_proxy_passes(policy: CandidatePolicy) -> bool:
    """A stronger auto baseline: automatic review checks obvious boundary guards.

    This intentionally remains weaker than the fixed regression gate. It checks
    the candidate card, not the full protected suite, so it can still miss
    already-correct overwrite and fine-grained accounting-scope risks.
    """
    if not targeted_passes(policy):
        return False
    required_guards = (
        policy.require_company,
        policy.require_year,
        policy.require_full_year_scope,
        policy.require_evidence,
    )
    return all(required_guards)


def should_promote(policy: CandidatePolicy, mode: str) -> bool:
    if mode == "naive":
        return targeted_passes(policy)
    if mode == "self_review_proxy":
        return self_review_proxy_passes(policy)
    if mode == "static_guarded":
        return targeted_passes(policy) and candidate_regression_passes(policy)
    raise ValueError(f"Unsupported baseline mode: {mode}")


def evaluate_active_policies(policies: list[CandidatePolicy]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for case in CASES:
        changed_by: str | None = None
        reason = "no_candidate_triggered"
        answer = case.answer
        for policy in policies:
            result = apply_candidate(case, policy)
            if result["changed"]:
                changed_by = policy.candidate_id
                reason = result["reason"]
                answer = result["answer"]
                break
        changed = answer != case.answer
        rows.append(
            {
                "case_id": case.case_id,
                "role": case.role,
                "skill": case.skill,
                "expected_change": case.should_change,
                "changed": changed,
                "passed": changed == case.should_change,
                "changed_by": changed_by,
                "reason": reason,
            }
        )
    false_triggers = [row for row in rows if not row["expected_change"] and row["changed"]]
    missed_targets = [row for row in rows if row["expected_change"] and not row["changed"]]
    return {
        "rows": rows,
        "false_trigger_count": len(false_triggers),
        "missed_target_count": len(missed_targets),
        "risk_count": len(false_triggers) + len(missed_targets),
        "false_triggers": false_triggers,
        "missed_targets": missed_targets,
    }


def run_auto_baseline(cycles: int, seed: int, mode: str) -> dict[str, Any]:
    rng = random.Random(seed)
    active: list[CandidatePolicy] = []
    cycle_rows: list[dict[str, Any]] = []
    first_false_trigger_cycle: int | None = None
    for cycle in range(1, cycles + 1):
        policy = random_policy(cycle, rng)
        auto_promoted = should_promote(policy, mode)
        if auto_promoted:
            active.append(policy)
        evaluation = evaluate_active_policies(active)
        if first_false_trigger_cycle is None and evaluation["false_trigger_count"]:
            first_false_trigger_cycle = cycle
        cycle_rows.append(
            {
                "cycle": cycle,
                "mode": mode,
                "candidate": asdict(policy),
                "auto_promoted": auto_promoted,
                "active_policy_count": len(active),
                "risk_count": evaluation["risk_count"],
                "false_trigger_count": evaluation["false_trigger_count"],
                "missed_target_count": evaluation["missed_target_count"],
                "false_trigger_case_ids": [row["case_id"] for row in evaluation["false_triggers"]],
            }
        )
    final_eval = evaluate_active_policies(active)
    return {
        "mode": mode,
        "cycles": cycles,
        "seed": seed,
        "auto_promoted_count": len(active),
        "first_risk_cycle": first_false_trigger_cycle,
        "first_false_trigger_cycle": first_false_trigger_cycle,
        "final_risk_count": final_eval["risk_count"],
        "final_false_trigger_count": final_eval["false_trigger_count"],
        "final_missed_target_count": final_eval["missed_target_count"],
        "final_false_triggers": final_eval["false_triggers"],
        "active_policies": [asdict(policy) for policy in active],
        "cycle_rows": cycle_rows,
    }


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def write_markdown(path: Path, summary: dict[str, Any]) -> None:
    baselines = summary["auto_baselines"]
    governed = summary["governed_baseline"]
    lines = [
        "# Auto-Promotion Risk Baselines",
        "",
        "This is a controlled long-cycle comparison of automatic skill-promotion policies.",
        "It does not mutate production code or the live skill registry.",
        "",
        "## Summary",
        "",
        "| baseline | cycles | auto-promoted | first false-trigger cycle | final false triggers | missed targets |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for mode in baselines:
        auto = baselines[mode]
        lines.append(
            f"| {mode} | {auto['cycles']} | {auto['auto_promoted_count']} | "
            f"{auto['first_risk_cycle']} | {auto['final_false_trigger_count']} | "
            f"{auto['final_missed_target_count']} |"
        )
    lines.extend(
        [
            "",
            f"- governed SkillOps baseline status on the same cases: {governed['status']}",
            "",
            "## Baseline Definitions",
            "",
            "- `naive`: promote any candidate that fixes its local target case.",
            "- `self_review_proxy`: promote only when an automatic card-level reviewer sees company, year, period, and evidence guards.",
            "- `static_guarded`: promote only when the candidate passes a fixed target/noop/scope/cross-company regression suite.",
            "- `governed SkillOps`: run the real profile repair with legacy fallback disabled; production promotion still requires human review.",
            "",
        ]
    )
    for mode in baselines:
        auto = baselines[mode]
        lines.extend(
            [
                f"## Final False Triggers: {mode}",
                "",
            ]
        )
        if not auto["final_false_triggers"]:
            lines.append("- None")
        else:
            lines.extend(["| case | role | skill | changed by |", "|---|---|---|---|"])
            for row in auto["final_false_triggers"]:
                lines.append(f"| {row['case_id']} | {row['role']} | {row['skill']} | {row['changed_by']} |")
        lines.append("")
    lines.extend(
        [
            "## Interpretation",
            "",
            "- The naive baseline is a lower-bound risk demonstration, not the only comparator.",
            "- The self-review proxy is stronger because it adds automatic card-level guard checks, but it can still miss protected noops and subtle accounting-scope boundaries.",
            "- The static-guarded baseline shows what fixed automatic regression can prevent before human review.",
            "- The governed SkillOps baseline is the proposed workflow: automatic proposal and testing, with human-controlled promotion.",
            "",
        ]
    )
    path.write_text("\n".join(lines), encoding="utf-8")


def write_legacy_markdown(path: Path, summary: dict[str, Any]) -> None:
    auto = summary["auto_baselines"]["naive"]
    governed = summary["governed_baseline"]
    lines = [
        "# Auto-Promotion Risk Baseline",
        "",
        "This legacy single-baseline view reports the naive policy only: targeted pass implies auto-promotion.",
        "Use `AUTO_PROMOTION_RISK_BASELINES_REPORT.md` for the fair multi-baseline comparison.",
        "",
        "## Summary",
        "",
        f"- cycles: {auto['cycles']}",
        f"- auto-promoted candidates: {auto['auto_promoted_count']}",
        f"- first false-trigger cycle: {auto['first_false_trigger_cycle']}",
        f"- final false triggers: {auto['final_false_trigger_count']}",
        f"- governed baseline status on the same cases: {governed['status']}",
        "",
        "## Final False Triggers",
        "",
    ]
    if not auto["final_false_triggers"]:
        lines.append("- None")
    else:
        lines.extend(["| case | role | skill | changed by |", "|---|---|---|---|"])
        for row in auto["final_false_triggers"]:
            lines.append(f"| {row['case_id']} | {row['role']} | {row['skill']} | {row['changed_by']} |")
    lines.extend(
        [
            "",
            "## Interpretation",
            "",
            "- Auto baseline optimizes local targeted repair only.",
            "- Risk is counted when a promoted candidate changes a scope-negative, cross-company-negative, or already-correct case.",
            "- The governed SkillOps baseline runs the real profile repair with legacy fallback disabled on the same cases.",
            "- This experiment supports the need for negative scope tests, cross-company guards, evidence sufficiency, and human review.",
            "",
        ]
    )
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cycles", type=int, default=200)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--modes", nargs="+", choices=BASELINE_MODES, default=list(BASELINE_MODES))
    parser.add_argument("--out_dir", default="test/colm/retrieval/auto_promotion_risk_baseline_20260609")
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    baselines = {mode: run_auto_baseline(args.cycles, args.seed, mode) for mode in args.modes}
    governed = governed_baseline()
    summary = {"auto_baselines": baselines, "governed_baseline": governed}
    (out_dir / "auto_promotion_risk_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    for mode, auto in baselines.items():
        write_jsonl(out_dir / f"auto_promotion_cycles_{mode}.jsonl", auto["cycle_rows"])
    if "naive" in baselines:
        write_jsonl(out_dir / "auto_promotion_cycles.jsonl", baselines["naive"]["cycle_rows"])
        write_legacy_markdown(out_dir / "AUTO_PROMOTION_RISK_BASELINE_REPORT.md", summary)
    write_markdown(out_dir / "AUTO_PROMOTION_RISK_BASELINES_REPORT.md", summary)
    print(
        json.dumps(
            {
                "out_dir": str(out_dir),
                "cycles": args.cycles,
                "baselines": {
                    mode: {
                        "auto_promoted_count": auto["auto_promoted_count"],
                        "first_false_trigger_cycle": auto["first_false_trigger_cycle"],
                        "final_false_trigger_count": auto["final_false_trigger_count"],
                        "final_missed_target_count": auto["final_missed_target_count"],
                    }
                    for mode, auto in baselines.items()
                },
                "governed_status": governed["status"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    if governed["status"] != "PASS":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
