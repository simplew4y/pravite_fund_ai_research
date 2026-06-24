"""Run the SkillOps vertical slice for one existing QA run row."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from diagnosis.failure_explainer import explain_failure, render_failure_report_markdown
from diagnosis.skill_candidate_generator import generate_skill_candidate_proposals, render_proposals_markdown
from grep.grep_probe import grep_probe
from preview.evidence_preview import build_evidence_preview, render_evidence_preview_markdown
from skillops.gate_runner import render_gate_report, run_regression_gate

try:
    import yaml
except Exception:  # pragma: no cover
    yaml = None


def run_vertical_slice(
    *,
    row_json: str | Path,
    row_index: int,
    grep_roots: list[str],
    out_dir: str | Path,
    case_id: str,
    eval_summary: dict[str, Any] | None = None,
    reviewer: str = "myz",
    manual_review_passed: bool = False,
    max_grep_files: int = 80,
    max_grep_anchors: int = 25,
) -> dict[str, Any]:
    rows = json.loads(Path(row_json).read_text(encoding="utf-8"))
    row = rows[row_index] if isinstance(rows, list) else rows
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    question = str(row.get("question") or row.get("original_question") or "")
    grep_result = grep_probe(
        question,
        grep_roots,
        metadata={"case_id": case_id},
        max_files=max_grep_files,
        max_anchors=max_grep_anchors,
    )
    grep_json = out / f"{case_id}_grep_probe.json"
    grep_json.write_text(json.dumps(grep_result.to_dict(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    preview = build_evidence_preview(row, grep_probe_result=grep_result.to_dict(), preview_id=case_id)
    preview_json = out / f"{case_id}_evidence_preview.json"
    preview_md = out / f"{case_id}_evidence_preview.md"
    preview_json.write_text(json.dumps(preview.to_dict(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    preview_md.write_text(render_evidence_preview_markdown(preview), encoding="utf-8")

    failure_report = explain_failure(row, preview.to_dict())
    failure_json = out / f"{case_id}_failure_report.json"
    failure_md = out / f"{case_id}_failure_report.md"
    failure_json.write_text(json.dumps(failure_report.to_dict(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    failure_md.write_text(render_failure_report_markdown(failure_report), encoding="utf-8")

    proposals = generate_skill_candidate_proposals(failure_report.to_dict(), source_failure_report=str(failure_json))
    proposal_yaml = out / f"{case_id}_skill_candidates.yaml"
    proposal_md = out / f"{case_id}_skill_candidates.md"
    _write_yaml(proposal_yaml, {"proposals": [proposal.to_dict() for proposal in proposals]})
    proposal_md.write_text(render_proposals_markdown(proposals), encoding="utf-8")

    gate_eval = eval_summary or _default_eval_summary(case_id, failure_report.to_dict())
    gate_eval_json = out / f"{case_id}_gate_eval_summary.json"
    gate_eval_json.write_text(json.dumps(gate_eval, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    gate_decisions = run_regression_gate(
        {"proposals": [proposal.to_dict() for proposal in proposals]},
        gate_eval,
        reviewer=reviewer,
        manual_review_passed=manual_review_passed,
    )
    gate_yaml = out / f"{case_id}_gate_decisions.yaml"
    gate_md = out / f"{case_id}_gate_decisions.md"
    _write_yaml(gate_yaml, {"decisions": [decision.to_dict() for decision in gate_decisions]})
    gate_md.write_text(render_gate_report(gate_decisions), encoding="utf-8")

    summary = {
        "case_id": case_id,
        "qid": preview.qid,
        "question": question,
        "primary_failure_type": failure_report.primary_failure_type,
        "failure_confidence": failure_report.confidence,
        "proposal_count": len(proposals),
        "gate_decisions": [decision.decision for decision in gate_decisions],
        "artifacts": {
            "grep_probe_json": str(grep_json),
            "evidence_preview_json": str(preview_json),
            "evidence_preview_md": str(preview_md),
            "failure_report_json": str(failure_json),
            "failure_report_md": str(failure_md),
            "skill_candidates_yaml": str(proposal_yaml),
            "skill_candidates_md": str(proposal_md),
            "gate_eval_summary_json": str(gate_eval_json),
            "gate_decisions_yaml": str(gate_yaml),
            "gate_decisions_md": str(gate_md),
        },
    }
    summary_json = out / f"{case_id}_summary.json"
    summary_md = out / f"{case_id}_summary.md"
    summary_json.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    summary_md.write_text(_render_case_summary(summary), encoding="utf-8")
    return summary


def _default_eval_summary(case_id: str, failure_report: dict[str, Any]) -> dict[str, Any]:
    no_failure = failure_report.get("primary_failure_type") == "no_failure_detected"
    return {
        "eval_summary_id": f"{case_id}_default_gate_eval",
        "protected_sets_passed": no_failure,
        "regression_count": 0,
        "manual_review_status": "not_yet_reviewed" if not no_failure else "not_applicable",
        "suite_status": {
            "targeted_short": "not_run",
            "core_protected": "pass" if no_failure else "not_run",
            "cross_company_guard": "not_run",
            "failure_bank": "not_run",
            "manual_review": "not_applicable" if no_failure else "pending",
        },
        "notes": "Default runner eval summary. Replace with protected-set results before approving implementation.",
        "per_candidate": {},
    }


def _render_case_summary(summary: dict[str, Any]) -> str:
    lines = [
        "# SkillOps Vertical Slice Case Summary",
        "",
        f"- Case ID: `{summary['case_id']}`",
        f"- QID: `{summary['qid']}`",
        f"- Primary failure type: `{summary['primary_failure_type']}`",
        f"- Failure confidence: {summary['failure_confidence']:.2f}",
        f"- Proposal count: {summary['proposal_count']}",
        f"- Gate decisions: {summary['gate_decisions']}",
        "",
        "## Question",
        "",
        summary["question"],
        "",
        "## Artifacts",
        "",
    ]
    for name, path in summary["artifacts"].items():
        lines.append(f"- {name}: `{path}`")
    return "\n".join(lines).rstrip() + "\n"


def _load_eval_summary(path: str | None) -> dict[str, Any] | None:
    if not path:
        return None
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    if p.suffix.lower() == ".json" or yaml is None:
        return json.loads(text)
    payload = yaml.safe_load(text)
    if not isinstance(payload, dict):
        raise ValueError(f"{path}: expected mapping")
    return payload


def _write_yaml(path: Path, payload: dict[str, Any]) -> None:
    if yaml is None:
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    else:
        path.write_text(yaml.safe_dump(payload, allow_unicode=True, sort_keys=False), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--row_json", required=True)
    parser.add_argument("--row_index", type=int, default=0)
    parser.add_argument("--grep_root", action="append", required=True)
    parser.add_argument("--out_dir", required=True)
    parser.add_argument("--case_id", required=True)
    parser.add_argument("--eval_summary", default=None)
    parser.add_argument("--reviewer", default="myz")
    parser.add_argument("--manual_review_passed", action="store_true")
    parser.add_argument("--max_grep_files", type=int, default=80)
    parser.add_argument("--max_grep_anchors", type=int, default=25)
    args = parser.parse_args()
    summary = run_vertical_slice(
        row_json=args.row_json,
        row_index=args.row_index,
        grep_roots=args.grep_root,
        out_dir=args.out_dir,
        case_id=args.case_id,
        eval_summary=_load_eval_summary(args.eval_summary),
        reviewer=args.reviewer,
        manual_review_passed=args.manual_review_passed,
        max_grep_files=args.max_grep_files,
        max_grep_anchors=args.max_grep_anchors,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
