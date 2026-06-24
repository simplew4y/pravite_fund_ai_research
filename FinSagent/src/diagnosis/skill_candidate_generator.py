"""Generate human-reviewed skill candidate proposals from failure reports."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

try:
    import yaml
except Exception:  # pragma: no cover
    yaml = None


@dataclass(frozen=True)
class SkillCandidateProposal:
    candidate_id: str
    candidate_skill_name: str
    observed_failures: list[str]
    failure_types: list[str]
    hypothesis: str
    proposed_trigger: str
    proposed_action: str
    risks: list[str]
    required_tests: list[str]
    suggested_status: str
    source_failure_report: str
    human_review_required: bool = True
    notes: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def generate_skill_candidate_proposals(
    failure_report: dict[str, Any],
    *,
    source_failure_report: str = "",
) -> list[SkillCandidateProposal]:
    primary = str(failure_report.get("primary_failure_type") or "")
    if primary in {"", "no_failure_detected"}:
        return []
    signals = list(failure_report.get("signals") or [])
    failure_types = _ordered_failure_types(primary, signals)
    proposals: list[SkillCandidateProposal] = []

    if "source_conflict" in failure_types or "period_mismatch" in failure_types:
        proposals.append(_period_source_arbitration_proposal(failure_report, source_failure_report, failure_types))

    if _has_wrong_company_source_signal(signals):
        proposals.append(_cross_company_source_guard_proposal(failure_report, source_failure_report, failure_types))

    if "table_alignment_error" in failure_types:
        proposals.append(_table_alignment_proposal(failure_report, source_failure_report, failure_types))

    if "metric_alias_error" in failure_types:
        proposals.append(_metric_alias_proposal(failure_report, source_failure_report, failure_types))

    if "answer_coverage_failure" in failure_types:
        proposals.append(_answer_coverage_proposal(failure_report, source_failure_report, failure_types))

    if "profile_boundary_error" in failure_types:
        proposals.append(_profile_boundary_proposal(failure_report, source_failure_report, failure_types))

    return _dedupe_proposals(proposals)


def render_proposals_markdown(proposals: list[SkillCandidateProposal], *, title: str = "Skill Candidate Proposals") -> str:
    lines = ["# " + title, ""]
    if not proposals:
        lines.extend(
            [
                "No skill candidate proposal was generated.",
                "",
                "This usually means the failure report is a success/control case or contains no actionable failure signal.",
            ]
        )
        return "\n".join(lines).rstrip() + "\n"

    for proposal in proposals:
        lines.extend(
            [
                f"## {proposal.candidate_skill_name}",
                "",
                f"- Candidate ID: `{proposal.candidate_id}`",
                f"- Suggested status: `{proposal.suggested_status}`",
                f"- Human review required: {proposal.human_review_required}",
                f"- Failure types: {', '.join(proposal.failure_types)}",
                "",
                "### Observed Failures",
                "",
            ]
        )
        lines.extend(f"- {_compact(item, 260)}" for item in proposal.observed_failures)
        lines.extend(
            [
                "",
                "### Hypothesis",
                "",
                proposal.hypothesis,
                "",
                "### Proposed Trigger",
                "",
                proposal.proposed_trigger,
                "",
                "### Proposed Action",
                "",
                proposal.proposed_action,
                "",
                "### Risks",
                "",
            ]
        )
        lines.extend(f"- {risk}" for risk in proposal.risks)
        lines.extend(["", "### Required Tests", ""])
        lines.extend(f"- {test}" for test in proposal.required_tests)
        if proposal.notes:
            lines.extend(["", "### Notes", "", proposal.notes])
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _period_source_arbitration_proposal(
    report: dict[str, Any],
    source_failure_report: str,
    failure_types: list[str],
) -> SkillCandidateProposal:
    qid = _qid(report)
    return SkillCandidateProposal(
        candidate_id=f"{qid}_general_period_source_arbitration",
        candidate_skill_name="general_period_source_arbitration",
        observed_failures=_signal_summaries(report, {"source_conflict", "period_mismatch", "wrong_source"}),
        failure_types=[ft for ft in failure_types if ft in {"source_conflict", "period_mismatch", "wrong_source"}],
        hypothesis=(
            "Period-specific SEC questions fail when later filings or later event disclosures are retrieved together with "
            "period-compatible filings, and the answer mixes the later evidence into the requested period."
        ),
        proposed_trigger=(
            "Question contains a fiscal/calendar period and retrieval preview contains both period-compatible sources and "
            "later-dated sources with conflict markers such as H20, new export licenses, restatements, or later inventory charges."
        ),
        proposed_action=(
            "Rank or gate answer evidence by period compatibility; require at least one period-compatible supporting span before "
            "rewriting or qualifying the answer. Preserve later disclosures as later-period context instead of letting them dominate."
        ),
        risks=[
            "May hide legitimate later restatement evidence if period compatibility is too strict.",
            "Needs company-independent period parsing before promotion.",
            "Could overfit to the NVIDIA H20 case unless tested across other source-conflict questions.",
        ],
        required_tests=[
            "NVIDIA q15 remains correct with repair trace.",
            "Lotus and Zeekr cross-company benchmark do not regress.",
            "At least three additional fiscal-period conflict probes from different filings are manually reviewed.",
            "Gate verifies later-period context is preserved when the question explicitly asks for latest status.",
        ],
        suggested_status="proposed",
        source_failure_report=source_failure_report,
        notes="This generalizes the existing narrow NVIDIA source_conflict repair into a governed skill proposal.",
        metadata={"qid": qid},
    )


def _cross_company_source_guard_proposal(
    report: dict[str, Any],
    source_failure_report: str,
    failure_types: list[str],
) -> SkillCandidateProposal:
    qid = _qid(report)
    return SkillCandidateProposal(
        candidate_id=f"{qid}_cross_company_source_guard",
        candidate_skill_name="cross_company_source_guard",
        observed_failures=_signal_summaries(report, {"wrong_source"}),
        failure_types=[ft for ft in failure_types if ft == "wrong_source"],
        hypothesis=(
            "Fallback or table retrieval can leak evidence from another company corpus when multiple company datasets coexist on the same server or config path."
        ),
        proposed_trigger=(
            "Question/company hint differs from source path, filename, or collection metadata in top retrieved chunks or table fallback chunks."
        ),
        proposed_action=(
            "Add a preview-time and retrieval-time guard that flags or filters chunks whose source company conflicts with the question company, "
            "unless explicitly requested as a cross-company comparison."
        ),
        risks=[
            "Naive path matching may block legitimate peer-comparison questions.",
            "Company aliases must be maintained in company_profiles rather than hard-coded globally.",
        ],
        required_tests=[
            "NVIDIA q15 preview no longer includes Lotus table fallback chunks.",
            "Cross-company comparison questions can opt out of the guard.",
            "Zeekr, Lotus, and NVIDIA sanity sets show no retrieval regressions.",
        ],
        suggested_status="proposed",
        source_failure_report=source_failure_report,
        notes="This candidate came from diagnosis, not manual answer reverse-engineering.",
        metadata={"qid": qid},
    )


def _table_alignment_proposal(report: dict[str, Any], source_failure_report: str, failure_types: list[str]) -> SkillCandidateProposal:
    qid = _qid(report)
    return SkillCandidateProposal(
        candidate_id=f"{qid}_table_alignment_guard",
        candidate_skill_name="table_alignment_guard",
        observed_failures=_signal_summaries(report, {"table_alignment_error"}),
        failure_types=[ft for ft in failure_types if ft == "table_alignment_error"],
        hypothesis="Numeric failures often come from using the wrong table row, column, unit, or subtotal.",
        proposed_trigger="Numeric SEC question with table evidence and verifier conflict or unsupported answer number.",
        proposed_action="Run deterministic row/column/unit verification before final answer acceptance.",
        risks=["May leave complex derived calculations unresolved.", "Requires robust table extraction quality."],
        required_tests=["No regression on protected numeric set.", "Manual review of verifier traces for at least 10 table questions."],
        suggested_status="proposed",
        source_failure_report=source_failure_report,
        metadata={"qid": qid},
    )


def _metric_alias_proposal(report: dict[str, Any], source_failure_report: str, failure_types: list[str]) -> SkillCandidateProposal:
    qid = _qid(report)
    return SkillCandidateProposal(
        candidate_id=f"{qid}_metric_alias_profile",
        candidate_skill_name="metric_alias_profile",
        observed_failures=_signal_summaries(report, {"metric_alias_error"}),
        failure_types=[ft for ft in failure_types if ft == "metric_alias_error"],
        hypothesis="Company filings use metric aliases that are not captured by generic question terms.",
        proposed_trigger="Metric-bearing question with missing or weak metric alias anchors.",
        proposed_action="Generate or update company profile metric aliases from filing headings and table labels.",
        risks=["Could over-expand aliases and retrieve semantically nearby but wrong metrics."],
        required_tests=["Alias additions improve retrieval on diagnostic examples without reducing precision on holdout metrics."],
        suggested_status="proposed",
        source_failure_report=source_failure_report,
        metadata={"qid": qid},
    )


def _answer_coverage_proposal(report: dict[str, Any], source_failure_report: str, failure_types: list[str]) -> SkillCandidateProposal:
    qid = _qid(report)
    return SkillCandidateProposal(
        candidate_id=f"{qid}_answer_coverage_guard",
        candidate_skill_name="answer_coverage_guard",
        observed_failures=_signal_summaries(report, {"answer_coverage_failure"}),
        failure_types=[ft for ft in failure_types if ft == "answer_coverage_failure"],
        hypothesis="Answers can include the core fact but omit required comparison or boundary key points.",
        proposed_trigger="Judge/key-point diff indicates missing key points while answer contains core entity/metric.",
        proposed_action="Require a coverage checklist before finalization and propose guarded coverage repair only with supporting evidence.",
        risks=["Can become answer-memorization if key points are copied into global rules."],
        required_tests=["Human review confirms added coverage is evidence-backed.", "No regression on concise-answer questions."],
        suggested_status="proposed",
        source_failure_report=source_failure_report,
        metadata={"qid": qid},
    )


def _profile_boundary_proposal(report: dict[str, Any], source_failure_report: str, failure_types: list[str]) -> SkillCandidateProposal:
    qid = _qid(report)
    return SkillCandidateProposal(
        candidate_id=f"{qid}_company_profile_boundary_guard",
        candidate_skill_name="company_profile_boundary_guard",
        observed_failures=_signal_summaries(report, {"profile_boundary_error"}),
        failure_types=[ft for ft in failure_types if ft == "profile_boundary_error"],
        hypothesis=(
            "Stable company-profile questions fail when noisy snippets or latest-event evidence cause the answer to overstate "
            "corporate structure, ownership, headquarters, or business-boundary facts."
        ),
        proposed_trigger=(
            "Question asks for corporate profile, holding structure, VIE status, headquarters, relationship boundary, or target market, "
            "and retrieval evidence is noisy or profile repair trace is triggered."
        ),
        proposed_action=(
            "Route the answer through reviewed company-profile metadata with explicit cutoff/scope, while preserving retrieved evidence "
            "and preventing global answer memorization."
        ),
        risks=[
            "Highest overfitting risk if profile facts are used as hidden answers instead of scoped metadata.",
            "Company-specific profile metadata must not leak into cross-company runs.",
            "Needs manual review for each company profile card before promotion.",
        ],
        required_tests=[
            "Profile-boundary questions pass on Zeekr protected set.",
            "Lotus and NVIDIA sanity cases do not trigger Zeekr-specific profile facts.",
            "Company profile card clearly separates aliases/metadata from answer facts.",
        ],
        suggested_status="proposed",
        source_failure_report=source_failure_report,
        notes="This proposal is intentionally scoped to audited company-profile metadata, not a global factbook.",
        metadata={"qid": qid},
    )


def _ordered_failure_types(primary: str, signals: list[dict[str, Any]]) -> list[str]:
    seen: list[str] = []
    for item in [primary, *(str(signal.get("failure_type") or "") for signal in signals)]:
        if item and item != "no_failure_detected" and item not in seen:
            seen.append(item)
    return seen


def _signal_summaries(report: dict[str, Any], selected_types: set[str]) -> list[str]:
    summaries: list[str] = []
    for signal in report.get("signals") or []:
        if str(signal.get("failure_type") or "") not in selected_types:
            continue
        summaries.append(
            f"{signal.get('failure_type')} ({signal.get('severity')}): {signal.get('rationale')} Evidence: {signal.get('evidence')}"
        )
    return summaries or [f"Primary failure type: {report.get('primary_failure_type')}"]


def _has_wrong_company_source_signal(signals: list[dict[str, Any]]) -> bool:
    for signal in signals:
        if signal.get("failure_type") != "wrong_source":
            continue
        evidence = str(signal.get("evidence") or "").lower()
        if "lotus" in evidence or "zeekr" in evidence or "nvidia" in evidence:
            return True
    return False


def _dedupe_proposals(proposals: list[SkillCandidateProposal]) -> list[SkillCandidateProposal]:
    seen: set[str] = set()
    deduped: list[SkillCandidateProposal] = []
    for proposal in proposals:
        if proposal.candidate_id in seen:
            continue
        seen.add(proposal.candidate_id)
        deduped.append(proposal)
    return deduped


def _qid(report: dict[str, Any]) -> str:
    raw = str(report.get("qid") or "unknown")
    return re.sub(r"[^A-Za-z0-9_]+", "_", raw).strip("_") or "unknown"


def _compact(value: str, max_chars: int) -> str:
    text = re.sub(r"\s+", " ", value or "").strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3].rstrip() + "..."


def _write_yaml(path: Path, proposals: list[SkillCandidateProposal]) -> None:
    payload = {"proposals": [proposal.to_dict() for proposal in proposals]}
    if yaml is None:
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    else:
        path.write_text(yaml.safe_dump(payload, allow_unicode=True, sort_keys=False), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--failure_report_json", required=True)
    parser.add_argument("--out_yaml", required=True)
    parser.add_argument("--out_md", required=True)
    args = parser.parse_args()

    report_path = Path(args.failure_report_json)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    proposals = generate_skill_candidate_proposals(report, source_failure_report=str(report_path))
    out_yaml = Path(args.out_yaml)
    out_md = Path(args.out_md)
    out_yaml.parent.mkdir(parents=True, exist_ok=True)
    out_md.parent.mkdir(parents=True, exist_ok=True)
    _write_yaml(out_yaml, proposals)
    out_md.write_text(render_proposals_markdown(proposals), encoding="utf-8")
    print(out_yaml)
    print(out_md)
    print(f"proposals={len(proposals)}")


if __name__ == "__main__":
    main()
