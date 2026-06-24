"""Rule-based failure explanation over evidence previews and run rows."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from diagnosis.failure_taxonomy import normalize_failure_type


_FUTURE_LEAKAGE_MARKERS = (
    "H20",
    "2026财年",
    "fiscal year 2026",
    "April 9, 2025",
    "2025年4月9日",
    "$4.5 billion",
    "45亿美元",
    "substantially excluded",
    "实质上",
)
_NUMERIC_QUESTION_TERMS = (
    "revenue",
    "gross margin",
    "gross profit",
    "net loss",
    "cash",
    "收入",
    "毛利",
    "毛利率",
    "亏损",
    "现金",
)


@dataclass(frozen=True)
class FailureSignal:
    failure_type: str
    severity: str
    evidence: str
    rationale: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class FailureReport:
    qid: str
    question: str
    primary_failure_type: str
    confidence: float
    signals: list[FailureSignal]
    suggested_next_action: str
    audit_notes: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "qid": self.qid,
            "question": self.question,
            "primary_failure_type": self.primary_failure_type,
            "confidence": self.confidence,
            "signals": [signal.to_dict() for signal in self.signals],
            "suggested_next_action": self.suggested_next_action,
            "audit_notes": list(self.audit_notes),
            "metadata": dict(self.metadata),
        }


def explain_failure(row: dict[str, Any], preview: dict[str, Any] | None = None) -> FailureReport:
    preview = preview or {}
    qid = str(row.get("qid") or preview.get("qid") or row.get("question_id") or row.get("index") or "unknown")
    question = str(row.get("question") or preview.get("question") or "")
    answer = str(row.get("generated_answer") or row.get("answer") or preview.get("answer") or "")
    original_period_answer = str(row.get("original_period_conflict_generated_answer") or "")
    signals: list[FailureSignal] = []

    signals.extend(_skill_trace_signals(row, preview))
    signals.extend(_period_conflict_signals(question, answer, original_period_answer, preview))
    signals.extend(_retrieval_quality_signals(question, preview))
    signals.extend(_metric_alias_signals(question, preview))
    signals.extend(_coverage_signals(row, answer))

    if not signals:
        return FailureReport(
            qid=qid,
            question=question,
            primary_failure_type="no_failure_detected",
            confidence=0.65,
            signals=[],
            suggested_next_action="No failure-class signal detected by the rule-based explainer. Use this as a success/control preview.",
            audit_notes=["rule_based_explainer", "no_triggered_failure_signals"],
            metadata=_metadata(row, preview),
        )

    primary = _choose_primary(signals)
    return FailureReport(
        qid=qid,
        question=question,
        primary_failure_type=primary.failure_type,
        confidence=_confidence(signals),
        signals=signals,
        suggested_next_action=_suggest_action(primary.failure_type),
        audit_notes=["rule_based_explainer", f"signals={len(signals)}"],
        metadata=_metadata(row, preview),
    )


def render_failure_report_markdown(report: FailureReport) -> str:
    lines = [
        "# Failure Diagnosis Report",
        "",
        f"- QID: `{report.qid}`",
        f"- Primary failure type: `{report.primary_failure_type}`",
        f"- Confidence: {report.confidence:.2f}",
        "",
        "## Question",
        "",
        report.question,
        "",
        "## Suggested Next Action",
        "",
        report.suggested_next_action,
        "",
        "## Signals",
        "",
    ]
    if not report.signals:
        lines.append("- No failure signals detected.")
    else:
        lines.extend(["| Type | Severity | Evidence | Rationale |", "| --- | --- | --- | --- |"])
        for signal in report.signals:
            lines.append(
                "| "
                + " | ".join(
                    [
                        f"`{signal.failure_type}`",
                        signal.severity,
                        _escape(_compact(signal.evidence, 180)),
                        _escape(_compact(signal.rationale, 220)),
                    ]
                )
                + " |"
            )
    lines.extend(["", "## Audit Notes", ""])
    lines.extend(f"- {note}" for note in report.audit_notes)
    return "\n".join(lines).rstrip() + "\n"


def _skill_trace_signals(row: dict[str, Any], preview: dict[str, Any]) -> list[FailureSignal]:
    signals: list[FailureSignal] = []
    traces = list(preview.get("skill_traces") or [])
    for trace in traces:
        if not trace.get("triggered"):
            continue
        skill_id = str(trace.get("skill_id") or "")
        if skill_id == "source_conflict":
            signals.append(
                _signal(
                    "source_conflict",
                    "high",
                    str(trace.get("supporting_source") or {}),
                    "source_conflict skill trace triggered, indicating conflicting retrieved source periods or interpretations.",
                )
            )
            signals.append(
                _signal(
                    "period_mismatch",
                    "high",
                    str(trace.get("trigger_reason") or ""),
                    "The repair reason indicates a period/source conflict for a period-specific question.",
                )
            )
        elif skill_id == "table_evidence_verifier":
            signals.append(
                _signal("table_alignment_error", "medium", str(trace), "Table verifier or repair trace triggered.")
            )
        elif skill_id == "answer_coverage":
            signals.append(
                _signal("answer_coverage_failure", "medium", str(trace), "Answer coverage repair trace triggered.")
            )
        elif skill_id == "company_profile_boundary":
            signals.append(
                _signal("profile_boundary_error", "medium", str(trace), "Profile boundary repair trace triggered.")
            )
    if row.get("period_source_conflict_repair_applied"):
        signals.append(
            _signal(
                "source_conflict",
                "high",
                str(row.get("period_source_conflict_supporting_source") or {}),
                "Run row indicates period_source_conflict repair was applied.",
            )
        )
    return signals


def _period_conflict_signals(
    question: str,
    answer: str,
    original_period_answer: str,
    preview: dict[str, Any],
) -> list[FailureSignal]:
    signals: list[FailureSignal] = []
    inspected_answer = original_period_answer or answer
    if "2025" in question and any(marker.lower() in inspected_answer.lower() for marker in _FUTURE_LEAKAGE_MARKERS):
        signals.append(
            _signal(
                "period_mismatch",
                "high",
                _matched_markers(inspected_answer, _FUTURE_LEAKAGE_MARKERS),
                "A 2025-period question is associated with later H20/FY2026/April 2025 disclosure markers.",
            )
        )
    retrieval = preview.get("retrieval") or []
    later_sources = [
        item
        for item in retrieval[:5]
        if str(item.get("date_published") or "") > "2025-01-26" and "2025" in question
    ]
    if later_sources and ("2025财年" in question or "fiscal year 2025" in question.lower() or "2025" in question):
        signals.append(
            _signal(
                "wrong_source",
                "medium",
                ", ".join(str(item.get("source") or "") for item in later_sources[:3]),
                "Top retrieval preview contains later filings that may conflict with the requested period framing.",
            )
        )
    return signals


def _retrieval_quality_signals(question: str, preview: dict[str, Any]) -> list[FailureSignal]:
    retrieval = preview.get("retrieval") or []
    grep_anchors = ((preview.get("grep_probe") or {}).get("anchors") or [])
    if not retrieval and grep_anchors:
        return [
            _signal(
                "retrieval_miss",
                "high",
                f"grep_anchors={len(grep_anchors)}",
                "Grep found lexical anchors but retrieval preview is empty.",
            )
        ]
    if retrieval:
        question_company = _company_hint(question)
        wrong_company_sources = [
            item
            for item in retrieval[:8]
            if question_company and _looks_wrong_company_source(str(item.get("source") or ""), question_company)
        ]
        if len(wrong_company_sources) >= 2:
            return [
                _signal(
                    "wrong_source",
                    "medium",
                    ", ".join(str(item.get("source") or "") for item in wrong_company_sources[:3]),
                    "Retrieval preview includes sources from a different company corpus.",
                )
            ]
    return []


def _metric_alias_signals(question: str, preview: dict[str, Any]) -> list[FailureSignal]:
    text = question.lower()
    asks_metric = any(term.lower() in text for term in _NUMERIC_QUESTION_TERMS)
    metric_aliases = (preview.get("grep_probe") or {}).get("metric_aliases") or {}
    if asks_metric and not metric_aliases:
        return [
            _signal(
                "metric_alias_error",
                "low",
                "metric_aliases={}",
                "Question appears metric-bearing but grep probe did not identify a metric alias family.",
            )
        ]
    return []


def _coverage_signals(row: dict[str, Any], answer: str) -> list[FailureSignal]:
    if row.get("coverage_repair_applied"):
        return [
            _signal(
                "answer_coverage_failure",
                "medium",
                str(row.get("coverage_repair_fact") or row.get("coverage_repair_reason") or ""),
                "Coverage repair was applied, indicating the original answer missed a required key point.",
            )
        ]
    key_points = row.get("key_points") if isinstance(row.get("key_points"), list) else []
    if key_points and answer:
        missing = [kp for kp in key_points if not _loose_contains(answer, str(kp))]
        if len(missing) >= max(2, len(key_points) // 2 + 1):
            return [
                _signal(
                    "answer_coverage_failure",
                    "low",
                    "; ".join(str(item) for item in missing[:3]),
                    "Several key-point strings are not loosely visible in the generated answer.",
                )
            ]
    return []


def _choose_primary(signals: list[FailureSignal]) -> FailureSignal:
    severity_rank = {"high": 3, "medium": 2, "low": 1}
    priority = {
        "source_conflict": 9,
        "period_mismatch": 8,
        "wrong_source": 7,
        "table_alignment_error": 6,
        "retrieval_miss": 5,
        "metric_alias_error": 4,
        "answer_coverage_failure": 3,
        "profile_boundary_error": 2,
    }
    return sorted(
        signals,
        key=lambda signal: (severity_rank.get(signal.severity, 0), priority.get(signal.failure_type, 0)),
        reverse=True,
    )[0]


def _confidence(signals: list[FailureSignal]) -> float:
    severity_score = sum({"high": 0.22, "medium": 0.14, "low": 0.08}.get(signal.severity, 0.05) for signal in signals)
    return min(0.95, 0.55 + severity_score)


def _suggest_action(failure_type: str) -> str:
    actions = {
        "source_conflict": "Keep or generalize period-aware source arbitration; verify that period-compatible evidence is present before repair.",
        "period_mismatch": "Apply date cutoff / period-aware retrieval and inspect later-period leakage markers.",
        "wrong_source": "Check filing metadata, company corpus boundaries, and source precedence.",
        "table_alignment_error": "Run deterministic table verifier and inspect row/column/unit alignment.",
        "retrieval_miss": "Use grep anchors to identify missed evidence and test evidence rescue retrieval.",
        "metric_alias_error": "Add or review metric alias patterns for this company and filing vocabulary.",
        "answer_coverage_failure": "Compare answer against key points and consider a guarded coverage skill proposal.",
        "profile_boundary_error": "Move stable profile assumptions into reviewed company profile metadata with explicit scope.",
    }
    return actions.get(failure_type, "No targeted action available.")


def _metadata(row: dict[str, Any], preview: dict[str, Any]) -> dict[str, Any]:
    return {
        "preview_id": preview.get("preview_id"),
        "retrieved_chunk_count": row.get("retrieved_chunk_count") or (preview.get("metadata") or {}).get("retrieved_chunk_count"),
        "grep_anchor_count": len(((preview.get("grep_probe") or {}).get("anchors") or [])),
        "skill_trace_count": len(preview.get("skill_traces") or []),
    }


def _signal(failure_type: str, severity: str, evidence: str, rationale: str) -> FailureSignal:
    return FailureSignal(normalize_failure_type(failure_type), severity, evidence, rationale)


def _matched_markers(text: str, markers: tuple[str, ...]) -> str:
    lowered = text.lower()
    return ", ".join(marker for marker in markers if marker.lower() in lowered)


def _company_hint(question: str) -> str:
    lowered = question.lower()
    for company in ("lotus", "nvidia", "zeekr", "极氪"):
        if company in lowered or company in question:
            return "zeekr" if company == "极氪" else company
    return ""


def _looks_wrong_company_source(source: str, company: str) -> bool:
    lowered = source.lower()
    known = {"lotus", "nvidia", "zeekr"}
    mentioned = {item for item in known if item in lowered}
    return bool(mentioned and company not in mentioned)


def _loose_contains(answer: str, key_point: str) -> bool:
    answer_tokens = set(re.findall(r"[a-zA-Z0-9]+", answer.lower()))
    kp_tokens = [token for token in re.findall(r"[a-zA-Z0-9]+", key_point.lower()) if len(token) > 2]
    if not kp_tokens:
        return True
    overlap = sum(1 for token in kp_tokens if token in answer_tokens)
    return overlap / max(1, len(kp_tokens)) >= 0.55


def _compact(value: str, max_chars: int) -> str:
    text = re.sub(r"\s+", " ", value or "").strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3].rstrip() + "..."


def _escape(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--row_json", required=True)
    parser.add_argument("--preview_json", required=True)
    parser.add_argument("--row_index", type=int, default=0)
    parser.add_argument("--out_json", required=True)
    parser.add_argument("--out_md", required=True)
    args = parser.parse_args()

    rows = json.loads(Path(args.row_json).read_text(encoding="utf-8"))
    row = rows[args.row_index] if isinstance(rows, list) else rows
    preview = json.loads(Path(args.preview_json).read_text(encoding="utf-8"))
    report = explain_failure(row, preview)
    out_json = Path(args.out_json)
    out_md = Path(args.out_md)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(report.to_dict(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    out_md.write_text(render_failure_report_markdown(report), encoding="utf-8")
    print(out_json)
    print(out_md)


if __name__ == "__main__":
    main()

