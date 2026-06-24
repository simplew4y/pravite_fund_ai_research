"""Unified evidence preview for retrieval, grep anchors, and skill traces."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class RetrievalPreview:
    rank: int
    retriever: str
    score: float | None
    source: str
    page: str
    date_published: str
    snippet: str
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SkillTracePreview:
    skill_id: str
    triggered: bool
    trigger_reason: str
    output_decision: str
    supporting_source: dict[str, Any] | None = None
    audit_notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class EvidencePreview:
    preview_id: str
    qid: str
    question: str
    answer: str
    retrieval: list[RetrievalPreview]
    grep_probe: dict[str, Any]
    skill_traces: list[SkillTracePreview]
    audit_notes: list[str]
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "preview_id": self.preview_id,
            "qid": self.qid,
            "question": self.question,
            "answer": self.answer,
            "retrieval": [item.to_dict() for item in self.retrieval],
            "grep_probe": self.grep_probe,
            "skill_traces": [item.to_dict() for item in self.skill_traces],
            "audit_notes": list(self.audit_notes),
            "metadata": dict(self.metadata),
        }


def build_evidence_preview(
    row: dict[str, Any],
    *,
    grep_probe_result: dict[str, Any] | None = None,
    preview_id: str | None = None,
    top_retrieval: int = 8,
    top_grep_anchors: int = 12,
) -> EvidencePreview:
    qid = str(row.get("qid") or row.get("question_id") or row.get("index") or "unknown")
    question = str(row.get("question") or row.get("original_question") or "")
    answer = str(row.get("generated_answer") or row.get("answer") or "")
    retrieval = _build_retrieval_preview(row.get("retrieved_chunks") or [], top_retrieval)
    grep_payload = _trim_grep_probe(grep_probe_result or row.get("grep_probe") or {}, top_grep_anchors)
    skill_traces = _extract_skill_traces(row)
    audit_notes = _build_audit_notes(row, retrieval, grep_payload, skill_traces)
    return EvidencePreview(
        preview_id=preview_id or qid,
        qid=qid,
        question=question,
        answer=answer,
        retrieval=retrieval,
        grep_probe=grep_payload,
        skill_traces=skill_traces,
        audit_notes=audit_notes,
        metadata={
            "retrieved_chunk_count": row.get("retrieved_chunk_count", len(row.get("retrieved_chunks") or [])),
            "total_time": row.get("total_time"),
            "retrieval_profile": row.get("retrieval_profile_name") or row.get("retrieval_profile"),
        },
    )


def render_evidence_preview_markdown(preview: EvidencePreview) -> str:
    data = preview.to_dict()
    lines = [
        "# Evidence Preview",
        "",
        f"- Preview ID: `{preview.preview_id}`",
        f"- QID: `{preview.qid}`",
        "",
        "## Question",
        "",
        preview.question,
        "",
        "## Answer",
        "",
        _compact(preview.answer, 1200),
        "",
        "## Audit Notes",
        "",
    ]
    lines.extend(f"- {note}" for note in preview.audit_notes)
    lines.extend(["", "## Retrieval Preview", ""])
    lines.extend(["| Rank | Retriever | Score | Source | Date | Snippet |", "| ---: | --- | ---: | --- | --- | --- |"])
    for item in preview.retrieval:
        lines.append(
            "| "
            + " | ".join(
                [
                    str(item.rank),
                    _escape(item.retriever),
                    "" if item.score is None else f"{item.score:.4f}",
                    _escape(_source_label(item.source, item.page)),
                    _escape(item.date_published),
                    _escape(_compact(item.snippet, 260)),
                ]
            )
            + " |"
        )
    lines.extend(["", "## Grep Probe", ""])
    gp = data.get("grep_probe") or {}
    lines.extend(
        [
            f"- Files scanned: {gp.get('files_scanned', 0)}",
            f"- Query terms: {', '.join(gp.get('query_terms') or [])}",
            f"- Period terms: {', '.join(gp.get('period_terms') or [])}",
            f"- Metric aliases: {gp.get('metric_aliases') or {}}",
            "",
            "| Type | Text | Source | Confidence | Snippet |",
            "| --- | --- | --- | ---: | --- |",
        ]
    )
    for anchor in gp.get("anchors") or []:
        lines.append(
            "| "
            + " | ".join(
                [
                    _escape(str(anchor.get("anchor_type") or "")),
                    _escape(str(anchor.get("text") or "")),
                    _escape(_short_path(str(anchor.get("source_path") or ""))),
                    f"{float(anchor.get('confidence_hint') or 0):.2f}",
                    _escape(_compact(str(anchor.get("snippet") or ""), 220)),
                ]
            )
            + " |"
        )
    lines.extend(["", "## Skill Traces", ""])
    if not preview.skill_traces:
        lines.append("- No skill trace fields were detected in this row.")
    else:
        for trace in preview.skill_traces:
            lines.extend(
                [
                    f"### {trace.skill_id}",
                    "",
                    f"- Triggered: {trace.triggered}",
                    f"- Reason: {trace.trigger_reason}",
                    f"- Decision: {trace.output_decision}",
                    f"- Supporting source: {trace.supporting_source or {}}",
                    f"- Notes: {', '.join(trace.audit_notes)}",
                    "",
                ]
            )
    return "\n".join(lines).rstrip() + "\n"


def _build_retrieval_preview(chunks: list[dict[str, Any]], top_k: int) -> list[RetrievalPreview]:
    previews: list[RetrievalPreview] = []
    for idx, chunk in enumerate(chunks[:top_k], start=1):
        metadata = chunk.get("metadata") if isinstance(chunk.get("metadata"), dict) else {}
        previews.append(
            RetrievalPreview(
                rank=idx,
                retriever=str(chunk.get("retriever") or metadata.get("retriever") or ""),
                score=_safe_float(chunk.get("score")),
                source=str(metadata.get("filename") or metadata.get("source_file") or metadata.get("source") or ""),
                page=str(metadata.get("page_number") or metadata.get("page_idx") or ""),
                date_published=str(metadata.get("date_published") or ""),
                snippet=_compact(str(chunk.get("page_content") or chunk.get("content") or ""), 700),
                metadata={
                    key: metadata.get(key)
                    for key in ("global_id", "doc_id", "content_type", "evidence_rescue", "evidence_rescue_score")
                    if key in metadata
                },
            )
        )
    return previews


def _trim_grep_probe(grep_probe_result: dict[str, Any], top_k: int) -> dict[str, Any]:
    if not grep_probe_result:
        return {"query_terms": [], "metric_aliases": {}, "period_terms": [], "anchors": [], "files_scanned": 0}
    payload = dict(grep_probe_result)
    payload["anchors"] = list(payload.get("anchors") or [])[:top_k]
    return payload


def _extract_skill_traces(row: dict[str, Any]) -> list[SkillTracePreview]:
    traces: list[SkillTracePreview] = []
    known_repairs = [
        ("table_evidence_verifier", "table_repair"),
        ("company_profile_boundary", "profile_repair"),
        ("answer_coverage", "coverage_repair"),
        ("source_conflict", "period_source_conflict_repair"),
    ]
    for skill_id, prefix in known_repairs:
        applied_key = f"{prefix}_applied"
        reason_key = f"{prefix}_reason"
        if applied_key not in row and reason_key not in row:
            continue
        triggered = bool(row.get(applied_key))
        supporting_source = None
        if skill_id == "source_conflict":
            supporting_source = row.get("period_source_conflict_supporting_source")
        traces.append(
            SkillTracePreview(
                skill_id=skill_id,
                triggered=triggered,
                trigger_reason=str(row.get(reason_key) or ""),
                output_decision="repair_applied" if triggered else "no_action",
                supporting_source=supporting_source if isinstance(supporting_source, dict) else None,
                audit_notes=_trace_notes(row, prefix),
            )
        )
    return traces


def _trace_notes(row: dict[str, Any], prefix: str) -> list[str]:
    notes: list[str] = []
    if f"original_{prefix}_generated_answer" in row or f"original_{prefix}_answer" in row:
        notes.append("original_answer_preserved")
    if f"{prefix}_verification" in row:
        notes.append("verification_attached")
    if f"{prefix}_fact" in row:
        notes.append(f"fact={row.get(f'{prefix}_fact')}")
    return notes


def _build_audit_notes(
    row: dict[str, Any],
    retrieval: list[RetrievalPreview],
    grep_probe: dict[str, Any],
    skill_traces: list[SkillTracePreview],
) -> list[str]:
    notes = [
        f"retrieval_chunks_previewed={len(retrieval)}",
        f"grep_anchors_previewed={len(grep_probe.get('anchors') or [])}",
    ]
    triggered = [trace.skill_id for trace in skill_traces if trace.triggered]
    if triggered:
        notes.append(f"triggered_skills={', '.join(triggered)}")
    if row.get("original_period_conflict_generated_answer"):
        notes.append("period/source conflict repair preserved original answer for audit")
    return notes


def _source_label(source: str, page: str) -> str:
    return f"{source} p.{page}" if page else source


def _short_path(path: str) -> str:
    parts = path.replace("\\", "/").split("/")
    return "/".join(parts[-3:]) if len(parts) > 3 else path


def _safe_float(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


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
    parser.add_argument("--grep_json", default=None)
    parser.add_argument("--row_index", type=int, default=0)
    parser.add_argument("--preview_id", default=None)
    parser.add_argument("--out_json", required=True)
    parser.add_argument("--out_md", required=True)
    args = parser.parse_args()

    rows = json.loads(Path(args.row_json).read_text(encoding="utf-8"))
    row = rows[args.row_index] if isinstance(rows, list) else rows
    grep_result = json.loads(Path(args.grep_json).read_text(encoding="utf-8")) if args.grep_json else None
    preview = build_evidence_preview(row, grep_probe_result=grep_result, preview_id=args.preview_id)
    out_json = Path(args.out_json)
    out_md = Path(args.out_md)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(preview.to_dict(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    out_md.write_text(render_evidence_preview_markdown(preview), encoding="utf-8")
    print(out_json)
    print(out_md)


if __name__ == "__main__":
    main()

