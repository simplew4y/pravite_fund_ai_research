"""Run regression gates over SkillOps candidate proposals."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from skillops.gate import GateDecision, decide_candidate

try:
    import yaml
except Exception:  # pragma: no cover
    yaml = None


def run_regression_gate(
    proposals_payload: dict[str, Any],
    eval_summary: dict[str, Any],
    *,
    reviewer: str,
    manual_review_passed: bool = False,
) -> list[GateDecision]:
    proposals = list(proposals_payload.get("proposals") or [])
    decisions: list[GateDecision] = []
    per_candidate_eval = eval_summary.get("per_candidate") if isinstance(eval_summary.get("per_candidate"), dict) else {}
    default_eval = {key: value for key, value in eval_summary.items() if key != "per_candidate"}
    for proposal in proposals:
        candidate_id = str(proposal.get("candidate_id") or proposal.get("candidate_skill_name") or "unknown")
        candidate_eval = dict(default_eval)
        candidate_eval.update(per_candidate_eval.get(candidate_id, {}))
        decisions.append(
            decide_candidate(
                candidate_id=candidate_id,
                reviewer=reviewer,
                eval_summary=candidate_eval,
                manual_review_passed=manual_review_passed,
            )
        )
    return decisions


def render_gate_report(decisions: list[GateDecision], *, title: str = "Staging/Promotion Gate Report") -> str:
    lines = ["# " + title, ""]
    if not decisions:
        lines.extend(
            [
                "No candidate proposals were provided to the regression gate.",
                "",
                "This is expected for success/control cases where no failure-driven proposal was generated.",
            ]
        )
        return "\n".join(lines).rstrip() + "\n"

    counts: dict[str, int] = {}
    for decision in decisions:
        counts[decision.decision] = counts.get(decision.decision, 0) + 1
    lines.extend(
        [
            "## Summary",
            "",
            f"- Decisions: {counts}",
            "",
            "| Candidate | Decision | Rationale | Targeted Short | Profile Precedence | Core Protected | Cross-Company Guard | Failure Bank | Manual Review | Followups |",
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ]
    )
    for decision in decisions:
        eval_summary = decision.eval_summary
        suite_status = _suite_status(eval_summary)
        lines.append(
            "| "
            + " | ".join(
                [
                    f"`{decision.candidate_id}`",
                    f"`{decision.decision}`",
                    _escape(decision.rationale),
                    _escape(suite_status["targeted_short"]),
                    _escape(suite_status["profile_precedence"]),
                    _escape(suite_status["core_protected"]),
                    _escape(suite_status["cross_company_guard"]),
                    _escape(suite_status["failure_bank"]),
                    _escape(suite_status["manual_review"]),
                    _escape("; ".join(decision.required_followups)),
                ]
            )
            + " |"
        )
    lines.extend(["", "## Candidate Details", ""])
    for decision in decisions:
        lines.extend(
            [
                f"### {decision.candidate_id}",
                "",
                f"- Reviewer: {decision.reviewer}",
                f"- Decision: `{decision.decision}`",
                f"- Rationale: {decision.rationale}",
                f"- Required followups: {', '.join(decision.required_followups) if decision.required_followups else 'None'}",
                "- Eval summary:",
                "",
                "```json",
                json.dumps(decision.eval_summary, ensure_ascii=False, indent=2),
                "```",
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"


def _load_structured(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json" or yaml is None:
        return json.loads(text)
    payload = yaml.safe_load(text)
    if not isinstance(payload, dict):
        raise ValueError(f"{path}: expected mapping")
    return payload


def _suite_status(eval_summary: dict[str, Any]) -> dict[str, str]:
    suite_status = eval_summary.get("suite_status") if isinstance(eval_summary.get("suite_status"), dict) else {}
    manual = suite_status.get("manual_review") if isinstance(suite_status.get("manual_review"), str) else None
    if not manual:
        manual = eval_summary.get("manual_review_status")
    if not manual:
        manual = "pass" if eval_summary.get("manual_review_passed") else "pending"
    return {
        "targeted_short": str(suite_status.get("targeted_short") or eval_summary.get("targeted_short") or "not_run"),
        "profile_precedence": str(
            suite_status.get("profile_precedence") or eval_summary.get("profile_precedence_status") or "not_run"
        ),
        "core_protected": str(suite_status.get("core_protected") or ("pass" if eval_summary.get("protected_sets_passed") else "not_run")),
        "cross_company_guard": str(suite_status.get("cross_company_guard") or eval_summary.get("cross_company_guard") or "not_run"),
        "failure_bank": str(suite_status.get("failure_bank") or eval_summary.get("failure_bank") or "not_run"),
        "manual_review": manual,
    }


def _write_yaml(path: Path, payload: dict[str, Any]) -> None:
    if yaml is None:
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    else:
        path.write_text(yaml.safe_dump(payload, allow_unicode=True, sort_keys=False), encoding="utf-8")


def _escape(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")


def _merge_profile_precedence_summary(eval_summary: dict[str, Any], summary_path: Path | None) -> dict[str, Any]:
    if not summary_path:
        return eval_summary
    payload = _load_structured(summary_path)
    status = str(payload.get("status") or "UNKNOWN").lower()
    suite_status = dict(eval_summary.get("suite_status") or {})
    suite_status["profile_precedence"] = "pass" if status == "pass" else "fail"
    merged = dict(eval_summary)
    merged["suite_status"] = suite_status
    merged["profile_precedence"] = {
        "summary_json": str(summary_path),
        "status": payload.get("status"),
        "passed_count": payload.get("passed_count"),
        "case_count": payload.get("case_count"),
        "failed_cases": [
            row.get("case_id")
            for row in payload.get("cases") or []
            if isinstance(row, dict) and not row.get("passed")
        ],
    }
    return merged


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--proposals_yaml", required=True)
    parser.add_argument("--eval_summary", required=True)
    parser.add_argument("--reviewer", default="myz")
    parser.add_argument("--manual_review_passed", action="store_true")
    parser.add_argument("--profile_precedence_summary", default=None)
    parser.add_argument("--out_yaml", required=True)
    parser.add_argument("--out_md", required=True)
    args = parser.parse_args()

    proposals = _load_structured(Path(args.proposals_yaml))
    eval_summary = _load_structured(Path(args.eval_summary))
    eval_summary = _merge_profile_precedence_summary(
        eval_summary,
        Path(args.profile_precedence_summary) if args.profile_precedence_summary else None,
    )
    decisions = run_regression_gate(
        proposals,
        eval_summary,
        reviewer=args.reviewer,
        manual_review_passed=args.manual_review_passed,
    )
    payload = {"decisions": [decision.to_dict() for decision in decisions]}
    out_yaml = Path(args.out_yaml)
    out_md = Path(args.out_md)
    out_yaml.parent.mkdir(parents=True, exist_ok=True)
    out_md.parent.mkdir(parents=True, exist_ok=True)
    _write_yaml(out_yaml, payload)
    out_md.write_text(render_gate_report(decisions), encoding="utf-8")
    print(out_yaml)
    print(out_md)
    print(f"decisions={len(decisions)}")


if __name__ == "__main__":
    main()
