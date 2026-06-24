#!/usr/bin/env python3
"""Fast regression checks for profile precedence skills.

This runner is intentionally deterministic and LLM-free. It verifies that the
profile layer can replace legacy answer fallbacks with scoped engineering
skills, while avoiding over-triggering on already-correct or wrong-scope cases.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from utils.profile_fact_repair import repair_profile_answer


ZEEKR_ANNUAL_NET_LOSS_EVIDENCE = """
For the year ended December 31, 2024, Net loss was (5,790,649) RMB thousand
and (793,315) US$ thousand. For 2023, Net loss was (8,264,191) RMB thousand.
The company stated that net loss narrowed by 29.9% year over year.
"""

NVIDIA_ANNUAL_DIRECT_CUSTOMER_EVIDENCE = """
Sales to direct Customers A, B and C represented 12%, 11% and 11% of total
revenue, respectively, for fiscal year 2025, all of which were primarily
attributable to the Compute & Networking segment.
<table><tr><td rowspan="2"></td><td colspan="2">Year Ended</td></tr>
<tr><td>Jan 26, 2025</td><td>Jan 28, 2024</td></tr>
<tr><td>Direct Customer A</td><td>12 %</td><td>*</td></tr>
<tr><td>Direct Customer B</td><td>11 %</td><td>13 %</td></tr>
<tr><td>Direct Customer C</td><td>11 %</td><td>*</td></tr></table>
"""


CASES: list[dict[str, Any]] = [
    {
        "case_id": "zeekr_annual_net_loss_conflict_positive",
        "question": "What was Zeekr's full-year 2024 net profit or net loss?",
        "answer": (
            "Zeekr has two disclosed 2024 net-loss values: RMB 6,423,570 thousand "
            "and RMB 5,790,649 thousand, so the value remains unclear."
        ),
        "evidence_chunks": [{"page_content": ZEEKR_ANNUAL_NET_LOSS_EVIDENCE}],
        "expect_repair_applied": True,
        "expect_skill_type": "annual_net_loss_statement_precedence",
        "require_answer_contains": ["5,790.649", "8,264.191", "29.9%"],
        "forbid_answer_contains": ["remains unclear"],
    },
    {
        "case_id": "zeekr_annual_net_loss_correct_noop",
        "question": "What was Zeekr's full-year 2024 net profit or net loss?",
        "answer": (
            "Zeekr reported a 2024 net loss of RMB 5,790.649 million "
            "(US$793.3 million), narrowing 29.9% from 2023."
        ),
        "evidence_chunks": [],
        "expect_repair_applied": False,
        "expect_applied_by": "skill_check",
        "expect_answer_unchanged": True,
    },
    {
        "case_id": "zeekr_annual_net_loss_missing_evidence_noop",
        "question": "What was Zeekr's full-year 2024 net profit or net loss?",
        "answer": (
            "Zeekr has conflicting 2024 net-loss values, including RMB 6,423,570 "
            "thousand, and the annual net-loss line is not shown here."
        ),
        "evidence_chunks": [{"page_content": "Only attributable shareholder-loss snippets are available."}],
        "expect_repair_applied": False,
        "expect_applied_by": "legacy_fallback_disabled",
        "expect_answer_unchanged": True,
    },
    {
        "case_id": "nvidia_fy2025_direct_customer_conflict_positive",
        "question": "For fiscal year 2025, which NVIDIA direct customers contributed more than 10% of revenue?",
        "answer": (
            "NVIDIA did not disclose any direct customer contributing 10% or more "
            "of total revenue for fiscal year 2025; only one indirect customer crossed the threshold."
        ),
        "evidence_chunks": [{"page_content": NVIDIA_ANNUAL_DIRECT_CUSTOMER_EVIDENCE}],
        "expect_repair_applied": True,
        "expect_skill_type": "annual_direct_customer_table_precedence",
        "require_answer_contains": ["Direct Customer A", "12%", "Direct Customer B", "11%", "Direct Customer C"],
        "forbid_answer_contains": ["did not disclose any direct customer"],
    },
    {
        "case_id": "nvidia_fy2025_direct_customer_correct_noop",
        "question": "For fiscal year 2025, which NVIDIA direct customers contributed more than 10% of revenue?",
        "answer": (
            "For fiscal year 2025, Direct Customer A represented 12% of revenue, "
            "Direct Customer B represented 11%, and Direct Customer C represented 11%."
        ),
        "evidence_chunks": [],
        "expect_repair_applied": False,
        "expect_applied_by": "skill_check",
        "expect_answer_unchanged": True,
    },
    {
        "case_id": "nvidia_q1_direct_customer_scope_negative",
        "question": "For the first quarter of fiscal year 2025, which NVIDIA direct customers exceeded 10% of revenue?",
        "answer": (
            "For the first quarter of fiscal year 2025, Customer A represented 13% "
            "and Customer B represented 11% of revenue."
        ),
        "evidence_chunks": [{"page_content": NVIDIA_ANNUAL_DIRECT_CUSTOMER_EVIDENCE}],
        "expect_repair_applied": False,
        "expect_applied_by": None,
        "expect_answer_unchanged": True,
    },
]


def _run_case(case: dict[str, Any]) -> dict[str, Any]:
    result = repair_profile_answer(
        case["question"],
        case["answer"],
        case.get("evidence_chunks") or [],
        allow_legacy_answer_fallback=False,
    )
    failures: list[str] = []
    answer = str(result.get("answer") or "")
    fact = result.get("profile_fact") or {}

    if bool(result.get("repair_applied")) != bool(case["expect_repair_applied"]):
        failures.append(
            f"repair_applied expected {case['expect_repair_applied']} got {result.get('repair_applied')}"
        )

    expected_skill_type = case.get("expect_skill_type")
    if expected_skill_type and fact.get("skill_type") != expected_skill_type:
        failures.append(f"skill_type expected {expected_skill_type} got {fact.get('skill_type')}")

    if "expect_applied_by" in case and fact.get("applied_by") != case.get("expect_applied_by"):
        failures.append(f"applied_by expected {case.get('expect_applied_by')} got {fact.get('applied_by')}")

    if case.get("expect_answer_unchanged") and answer != case["answer"]:
        failures.append("answer changed unexpectedly")

    for needle in case.get("require_answer_contains") or []:
        if needle not in answer:
            failures.append(f"answer missing required text: {needle}")

    lowered = answer.lower()
    for needle in case.get("forbid_answer_contains") or []:
        if needle.lower() in lowered:
            failures.append(f"answer contains forbidden text: {needle}")

    return {
        "case_id": case["case_id"],
        "passed": not failures,
        "failures": failures,
        "repair_applied": result.get("repair_applied"),
        "repair_reason": result.get("repair_reason"),
        "applied_by": fact.get("applied_by"),
        "skill_type": fact.get("skill_type"),
        "answer": answer,
    }


def _write_markdown(report: dict[str, Any], path: Path) -> None:
    lines = [
        "# Profile Precedence Regression Report",
        "",
        f"Suite: `{report['suite_id']}`",
        f"Status: `{report['status']}`",
        f"Passed: {report['passed_count']} / {report['case_count']}",
        "",
        "| Case | Passed | Repair | Skill | Reason |",
        "|---|---:|---:|---|---|",
    ]
    for row in report["cases"]:
        lines.append(
            "| {case_id} | {passed} | {repair_applied} | {skill_type} | {reason} |".format(
                case_id=row["case_id"],
                passed="yes" if row["passed"] else "no",
                repair_applied="yes" if row["repair_applied"] else "no",
                skill_type=row.get("skill_type") or "",
                reason=(row.get("repair_reason") or "").replace("|", "/"),
            )
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out_dir", default="test/colm/retrieval/profile_precedence_regression_20260609")
    parser.add_argument("--suite_id", default="profile_precedence_short_v1")
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    rows = [_run_case(case) for case in CASES]
    passed_count = sum(1 for row in rows if row["passed"])
    report = {
        "suite_id": args.suite_id,
        "status": "PASS" if passed_count == len(rows) else "FAIL",
        "case_count": len(rows),
        "passed_count": passed_count,
        "cases": rows,
    }

    json_path = out_dir / "profile_precedence_regression_summary.json"
    md_path = out_dir / "PROFILE_PRECEDENCE_REGRESSION_REPORT.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    _write_markdown(report, md_path)
    print(json.dumps({"summary_json": str(json_path), "report_md": str(md_path), **report}, ensure_ascii=False, indent=2))
    if report["status"] != "PASS":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
