"""Run a reproducible SkillOps demo benchmark from a case manifest."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from skillops.case_suite_report import build_case_suite_report, render_case_suite_markdown
from skillops.vertical_slice_runner import run_vertical_slice


DEFAULT_CASE_MANIFEST = "configs/skillops_demo_cases.json"
DEFAULT_OUT_DIR = "test/colm/retrieval/skillops_demo_benchmark_20260605"


def run_demo_benchmark(
    *,
    case_manifest: str | Path = DEFAULT_CASE_MANIFEST,
    out_dir: str | Path = DEFAULT_OUT_DIR,
    reviewer: str = "myz",
    manual_review_passed: bool = False,
    max_grep_files: int = 80,
    max_grep_anchors: int = 25,
) -> dict[str, Any]:
    manifest_path = Path(case_manifest)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    case_summaries: list[dict[str, Any]] = []
    mismatches: list[dict[str, Any]] = []
    for case in manifest.get("cases", []):
        case_id = str(case["case_id"])
        row_json = _materialize_case_row(case, out / "_case_rows")
        summary = run_vertical_slice(
            row_json=row_json,
            row_index=0 if case.get("row_overrides") else int(case.get("row_index", 0)),
            grep_roots=list(case.get("grep_roots") or []),
            out_dir=out / case_id,
            case_id=case_id,
            reviewer=reviewer,
            manual_review_passed=manual_review_passed,
            max_grep_files=max_grep_files,
            max_grep_anchors=max_grep_anchors,
        )
        expected = case.get("expected_primary_failure_type")
        if expected and summary.get("primary_failure_type") != expected:
            mismatches.append(
                {
                    "case_id": case_id,
                    "expected": expected,
                    "actual": summary.get("primary_failure_type"),
                }
            )
        summary["label"] = case.get("label", "")
        summary["expected_primary_failure_type"] = expected
        case_summaries.append(summary)

    suite_report = build_case_suite_report([out])
    suite_json = out / "skillops_demo_suite_report.json"
    suite_md = out / "skillops_demo_suite_report.md"
    suite_json.write_text(json.dumps(suite_report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    suite_md.write_text(render_case_suite_markdown(suite_report), encoding="utf-8")

    run_manifest = {
        "run_id": out.name,
        "suite_id": manifest.get("suite_id"),
        "case_manifest": str(manifest_path),
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "case_count": len(case_summaries),
        "mismatch_count": len(mismatches),
        "mismatches": mismatches,
        "case_summaries": [
            {
                "case_id": item.get("case_id"),
                "label": item.get("label"),
                "qid": item.get("qid"),
                "primary_failure_type": item.get("primary_failure_type"),
                "expected_primary_failure_type": item.get("expected_primary_failure_type"),
                "proposal_count": item.get("proposal_count"),
                "gate_decisions": item.get("gate_decisions"),
                "summary_path": str(Path(out) / str(item.get("case_id")) / f"{item.get('case_id')}_summary.json"),
            }
            for item in case_summaries
        ],
        "suite_report_json": str(suite_json),
        "suite_report_md": str(suite_md),
        "status": "pass" if not mismatches else "needs_review",
    }
    manifest_json = out / "skillops_demo_benchmark_manifest.json"
    manifest_md = out / "skillops_demo_benchmark_manifest.md"
    manifest_json.write_text(json.dumps(run_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    manifest_md.write_text(_render_run_manifest_markdown(run_manifest), encoding="utf-8")
    return run_manifest


def _materialize_case_row(case: dict[str, Any], case_row_dir: Path) -> str:
    if not case.get("row_overrides"):
        return str(case["row_json"])
    case_row_dir.mkdir(parents=True, exist_ok=True)
    source = Path(str(case["row_json"]))
    payload = json.loads(source.read_text(encoding="utf-8"))
    rows = payload if isinstance(payload, list) else [payload]
    row = dict(rows[int(case.get("row_index", 0))])
    row.update(case["row_overrides"])
    out = case_row_dir / f"{case['case_id']}_row.json"
    out.write_text(json.dumps([row], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return str(out)


def _render_run_manifest_markdown(run_manifest: dict[str, Any]) -> str:
    lines = [
        "# SkillOps Demo Benchmark Manifest",
        "",
        f"- Run ID: `{run_manifest['run_id']}`",
        f"- Suite ID: `{run_manifest.get('suite_id')}`",
        f"- Status: `{run_manifest['status']}`",
        f"- Case count: {run_manifest['case_count']}",
        f"- Expected-type mismatches: {run_manifest['mismatch_count']}",
        f"- Suite report: `{run_manifest['suite_report_md']}`",
        "",
        "## Cases",
        "",
        "| Case | Label | QID | Expected | Actual | Proposals | Gate |",
        "| --- | --- | --- | --- | --- | ---: | --- |",
    ]
    for case in run_manifest["case_summaries"]:
        gate = ", ".join(case.get("gate_decisions") or [])
        lines.append(
            "| "
            + " | ".join(
                [
                    f"`{case['case_id']}`",
                    str(case.get("label") or ""),
                    f"`{case.get('qid')}`",
                    f"`{case.get('expected_primary_failure_type')}`",
                    f"`{case.get('primary_failure_type')}`",
                    str(case.get("proposal_count")),
                    gate,
                ]
            )
            + " |"
        )
    if run_manifest["mismatches"]:
        lines.extend(["", "## Mismatches", ""])
        for mismatch in run_manifest["mismatches"]:
            lines.append(
                f"- `{mismatch['case_id']}` expected `{mismatch['expected']}`, got `{mismatch['actual']}`"
            )
    lines.extend(
        [
            "",
            "## Interpretation",
            "",
            "This benchmark is a reproducible demo suite for the SkillOps audit/evolution loop. It is not a statistical accuracy benchmark; the cross-company QA benchmark remains the accuracy evidence.",
        ]
    )
    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case_manifest", default=DEFAULT_CASE_MANIFEST)
    parser.add_argument("--out_dir", default=DEFAULT_OUT_DIR)
    parser.add_argument("--reviewer", default="myz")
    parser.add_argument("--manual_review_passed", action="store_true")
    parser.add_argument("--max_grep_files", type=int, default=80)
    parser.add_argument("--max_grep_anchors", type=int, default=25)
    args = parser.parse_args()
    run_manifest = run_demo_benchmark(
        case_manifest=args.case_manifest,
        out_dir=args.out_dir,
        reviewer=args.reviewer,
        manual_review_passed=args.manual_review_passed,
        max_grep_files=args.max_grep_files,
        max_grep_anchors=args.max_grep_anchors,
    )
    print(json.dumps(run_manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
