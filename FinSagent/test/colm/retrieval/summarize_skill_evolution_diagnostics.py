#!/usr/bin/env python3
"""Summarize rotating diagnostic runs for skill evolution.

The report is intentionally diagnostic-first. Without judge results it does
not claim correctness; it only identifies deterministic gate problems,
uncertain answers, and buckets that need judge or human review.
"""

from __future__ import annotations

import argparse
import csv
import json
import statistics
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any


UNCERTAINTY_MARKERS = (
    "not disclosed",
    "cannot determine",
    "cannot confirm",
    "unknown",
    "not provided",
    "insufficient information",
    "\u672a\u62ab\u9732",
    "\u6ca1\u6709\u62ab\u9732",
    "\u65e0\u6cd5\u786e\u8ba4",
    "\u65e0\u6cd5\u786e\u5b9a",
    "\u4e0d\u80fd\u786e\u5b9a",
    "\u4e0d\u77e5\u9053",
    "\u4fe1\u606f\u4e0d\u8db3",
)


def _load_json(path: str | None) -> Any:
    if not path:
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def _as_rows(payload: Any, *, rows_key: str | None = None) -> list[dict[str, Any]]:
    if payload is None:
        return []
    if rows_key and isinstance(payload, dict):
        payload = payload.get(rows_key)
    if not isinstance(payload, list):
        raise ValueError("Expected a JSON list")
    return [row for row in payload if isinstance(row, dict)]


def _row_key(row: dict[str, Any]) -> str:
    qid = str(row.get("qid") or "").strip()
    if qid:
        return f"qid:{qid}"
    index = row.get("index")
    if index is not None:
        return f"index:{index}"
    question = " ".join(str(row.get("question") or row.get("original_question") or "").split())
    return f"question:{question}"


def _map_rows(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {_row_key(row): row for row in rows}


def _answer(row: dict[str, Any]) -> str:
    return str(row.get("generated_answer") or row.get("answer") or "")


def _question(row: dict[str, Any], candidate: dict[str, Any] | None = None) -> str:
    return str(
        row.get("question")
        or row.get("original_question")
        or (candidate or {}).get("question")
        or ""
    )


def _is_uncertain(answer: str) -> bool:
    lowered = answer.lower()
    return any(marker in lowered for marker in UNCERTAINTY_MARKERS)


def _safe_float(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _classify_without_judge(
    risk_bucket: str,
    generated: dict[str, Any],
    gate: dict[str, Any] | None,
) -> tuple[str, str]:
    answer = _answer(generated)
    gate_decision = str((gate or {}).get("gate_decision") or "NOT_RUN")
    verifier = str((gate or {}).get("verifier_status") or "NOT_RUN")
    if gate_decision in {"BLOCK", "REVIEW"}:
        return "deterministic_table_gate", "Inspect deterministic verifier result before promotion."
    if not answer.strip():
        return "generation_empty", "Rerun generation or inspect runtime logs."
    if _is_uncertain(answer):
        return "abstention_or_evidence_gap", "Inspect retrieved evidence; this may be a desired abstention."
    if risk_bucket == "table_verification":
        if verifier == "PASS":
            return "table_verified_needs_judge", "Table facts pass; use judge or human spot check."
        if verifier == "NO_TABLE_FACTS":
            return "table_uncovered_by_verifier", "Add a table fact type only if the pattern recurs across filings."
        return "table_needs_review", "Review table verifier status."
    if risk_bucket == "period_control":
        return "period_control_needs_judge", "Judge or inspect date evidence before changing cutoff rules."
    if risk_bucket == "coverage":
        return "coverage_needs_judge", "Judge or human audit key-point coverage before adding coverage repair."
    if risk_bucket == "fact_registry":
        return "fact_registry_needs_review", "Defer to fact registry only if the missing fact is stable and reusable."
    return "needs_judge_or_human", "Run judge or human audit before proposing a skill."


def _classify_with_judge(
    risk_bucket: str,
    generated: dict[str, Any],
    gate: dict[str, Any] | None,
    judge: dict[str, Any],
) -> tuple[str, str]:
    verdict = str(judge.get("judge_verdict") or "").upper()
    if verdict == "CORRECT":
        return "passed_judge", "No skill action; keep as validation evidence."
    gate_decision = str((gate or {}).get("gate_decision") or "NOT_RUN")
    if gate_decision in {"BLOCK", "REVIEW"}:
        return "deterministic_table_gate", "Fix deterministic table issue if it is a true positive."
    if _is_uncertain(_answer(generated)):
        return "abstention_or_evidence_gap", "Check whether abstention is correct or evidence was missed."
    if verdict == "PARTIAL":
        return f"{risk_bucket or 'general'}_partial", "Consider narrow repair only if missing key point is recurring."
    if verdict in {"INCORRECT", "FAILURE", "ERROR/UNCLEAR"}:
        return f"{risk_bucket or 'general'}_failure", "Inspect evidence path and add a skill only for repeated structural failures."
    return "judge_unclear", "Manual review recommended."


def _summarize_times(rows: list[dict[str, Any]]) -> dict[str, Any]:
    values = [v for v in (_safe_float(row.get("total_time")) for row in rows) if v is not None]
    if not values:
        return {}
    return {
        "count": len(values),
        "mean_sec": round(statistics.mean(values), 3),
        "median_sec": round(statistics.median(values), 3),
        "min_sec": round(min(values), 3),
        "max_sec": round(max(values), 3),
    }


def _build_summary(
    candidates: list[dict[str, Any]],
    generated_rows: list[dict[str, Any]],
    gate_rows: list[dict[str, Any]],
    judge_rows: list[dict[str, Any]],
    name: str,
) -> dict[str, Any]:
    candidate_by_key = _map_rows(candidates)
    gate_by_key = _map_rows(gate_rows)
    judge_by_key = _map_rows(judge_rows)
    generated_by_key = _map_rows(generated_rows)

    per_row: list[dict[str, Any]] = []
    for row in generated_rows:
        key = _row_key(row)
        candidate = candidate_by_key.get(key, {})
        gate = gate_by_key.get(key)
        judge = judge_by_key.get(key)
        risk_bucket = str(candidate.get("risk_bucket") or row.get("risk_bucket") or "unknown")
        if judge:
            bucket, next_action = _classify_with_judge(risk_bucket, row, gate, judge)
        else:
            bucket, next_action = _classify_without_judge(risk_bucket, row, gate)
        per_row.append(
            {
                "key": key,
                "qid": row.get("qid") or candidate.get("qid"),
                "index": row.get("index") or candidate.get("index"),
                "question": _question(row, candidate),
                "risk_bucket": risk_bucket,
                "bucket_reasons": candidate.get("bucket_reasons") or row.get("bucket_reasons") or [],
                "generated_answer_present": bool(_answer(row).strip()),
                "answer_uncertain": _is_uncertain(_answer(row)),
                "answer_preview": _answer(row).replace("\n", " ")[:360],
                "table_repair_applied": bool(row.get("table_repair_applied")),
                "table_repair_reason": row.get("table_repair_reason"),
                "retrieval_profile_name": row.get("retrieval_profile_name"),
                "retrieved_chunk_count": row.get("retrieved_chunk_count"),
                "total_time": row.get("total_time"),
                "gate_decision": (gate or {}).get("gate_decision", "NOT_RUN"),
                "verifier_status": (gate or {}).get("verifier_status", "NOT_RUN"),
                "gate_scope": (gate or {}).get("gate_scope", "NOT_RUN"),
                "fact_types": (gate or {}).get("fact_types", []),
                "judge_verdict": (judge or {}).get("judge_verdict", "NOT_RUN"),
                "kp_coverage_ratio": (judge or {}).get("kp_coverage_ratio"),
                "failure_bucket": bucket,
                "next_action": next_action,
            }
        )

    missing_generated = []
    for key, candidate in candidate_by_key.items():
        if key not in generated_by_key:
            missing_generated.append(
                {
                    "key": key,
                    "qid": candidate.get("qid"),
                    "index": candidate.get("index"),
                    "risk_bucket": candidate.get("risk_bucket"),
                    "question": candidate.get("question"),
                }
            )

    def count(field: str) -> dict[str, int]:
        return dict(Counter(str(row.get(field) or "") for row in per_row))

    candidate_skill_backlog = []
    for bucket, bucket_count in Counter(row["failure_bucket"] for row in per_row).most_common():
        if bucket in {"passed_judge", "table_verified_needs_judge", "needs_judge_or_human"}:
            continue
        candidate_skill_backlog.append(
            {
                "bucket": bucket,
                "count": bucket_count,
                "example_qids": [str(row.get("qid")) for row in per_row if row["failure_bucket"] == bucket][:5],
                "recommended_boundary": _bucket_boundary(bucket),
            }
        )

    return {
        "name": name,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "row_count": len(per_row),
        "candidate_count": len(candidates),
        "missing_generated_count": len(missing_generated),
        "has_judge": bool(judge_rows),
        "counts": {
            "risk_bucket": count("risk_bucket"),
            "gate_decision": count("gate_decision"),
            "verifier_status": count("verifier_status"),
            "judge_verdict": count("judge_verdict"),
            "failure_bucket": count("failure_bucket"),
            "table_repair_applied": dict(Counter(str(row.get("table_repair_applied")) for row in per_row)),
            "answer_uncertain": dict(Counter(str(row.get("answer_uncertain")) for row in per_row)),
        },
        "time_stats": _summarize_times(generated_rows),
        "candidate_skill_backlog": candidate_skill_backlog,
        "missing_generated": missing_generated,
        "rows": per_row,
    }


def _bucket_boundary(bucket: str) -> str:
    if bucket.startswith("coverage"):
        return "Do not add a repair unless judge or human review confirms a recurring missing key point."
    if bucket.startswith("period_control"):
        return "Keep cutoff trigger-based; do not globally tighten date filtering from one case."
    if bucket.startswith("table"):
        return "Only add structurally detectable table fact types; avoid answer-text patches."
    if bucket.startswith("fact_registry"):
        return "Treat as late-stage custom registry work, not a generic retrieval fix."
    if bucket == "abstention_or_evidence_gap":
        return "Check whether abstention is correct; prefer saying unknown over hallucinating."
    if bucket == "deterministic_table_gate":
        return "Inspect false positive risk before using it as a promotion blocker."
    return "Manual review before any skill proposal."


def _render_markdown(summary: dict[str, Any]) -> str:
    lines = [
        f"# Skill Evolution Diagnostic Summary: {summary.get('name')}",
        "",
        f"Generated: {summary.get('generated_at')}",
        f"Rows generated: {summary.get('row_count')} / candidates: {summary.get('candidate_count')}",
        f"Missing generated: {summary.get('missing_generated_count')}",
        f"Judge included: {summary.get('has_judge')}",
        "",
        "## Interpretation",
        "",
    ]
    if not summary.get("has_judge"):
        lines.extend(
            [
                "- This is not a correctness score. It is a risk-routing report for new diagnostic questions.",
                "- Buckets ending in `needs_judge` need LLM judge or human spot check before becoming skill work.",
                "- Deterministic gate problems and repeated abstentions are the only immediate engineering signals here.",
            ]
        )
    else:
        lines.append("- Judge verdicts are included, but skill promotion still requires protected and cross-company gates.")

    lines.extend(["", "## Counts", ""])
    for group, counts in dict(summary.get("counts") or {}).items():
        rendered = ", ".join(f"{key}={value}" for key, value in sorted(dict(counts).items()))
        lines.append(f"- {group}: {rendered or 'none'}")

    time_stats = summary.get("time_stats") or {}
    if time_stats:
        lines.extend(["", "## Runtime", ""])
        lines.append(
            "- "
            + ", ".join(f"{key}={value}" for key, value in time_stats.items())
        )

    backlog = list(summary.get("candidate_skill_backlog") or [])
    lines.extend(["", "## Candidate Skill Backlog", ""])
    if not backlog:
        lines.append("- None yet. Run judge or human audit for no-signal rows.")
    else:
        lines.extend(["| bucket | count | examples | boundary |", "| --- | ---: | --- | --- |"])
        for item in backlog:
            lines.append(
                f"| {item.get('bucket')} | {item.get('count')} | "
                f"{', '.join(item.get('example_qids') or [])} | {item.get('recommended_boundary')} |"
            )

    lines.extend(
        [
            "",
            "## Per-Row Routing",
            "",
            "| qid | index | risk | gate | verifier | judge | bucket | next action | question |",
            "| --- | ---: | --- | --- | --- | --- | --- | --- | --- |",
        ]
    )
    for row in summary.get("rows") or []:
        question = str(row.get("question") or "").replace("|", "\\|")
        lines.append(
            f"| {row.get('qid')} | {row.get('index')} | {row.get('risk_bucket')} | "
            f"{row.get('gate_decision')} | {row.get('verifier_status')} | {row.get('judge_verdict')} | "
            f"{row.get('failure_bucket')} | {row.get('next_action')} | {question} |"
        )
    lines.append("")
    return "\n".join(lines)


def _write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "qid",
        "index",
        "risk_bucket",
        "gate_decision",
        "verifier_status",
        "judge_verdict",
        "failure_bucket",
        "answer_uncertain",
        "table_repair_applied",
        "total_time",
        "next_action",
        "question",
        "answer_preview",
    ]
    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field) for field in fields})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--generated_answers_json", required=True)
    parser.add_argument("--candidate_set_json", default=None)
    parser.add_argument("--gate_json", default=None)
    parser.add_argument("--judge_results_json", default=None)
    parser.add_argument("--name", default="rotating_diagnostic")
    parser.add_argument("--out_dir", required=True)
    args = parser.parse_args()

    generated_rows = _as_rows(_load_json(args.generated_answers_json))
    candidate_rows = _as_rows(_load_json(args.candidate_set_json)) if args.candidate_set_json else generated_rows
    gate_rows = _as_rows(_load_json(args.gate_json), rows_key="rows") if args.gate_json else []
    judge_rows = _as_rows(_load_json(args.judge_results_json)) if args.judge_results_json else []

    summary = _build_summary(
        candidates=candidate_rows,
        generated_rows=generated_rows,
        gate_rows=gate_rows,
        judge_rows=judge_rows,
        name=args.name,
    )
    out_dir = Path(args.out_dir)
    summary_path = out_dir / "skill_evolution_diagnostic_summary.json"
    report_path = out_dir / "SKILL_EVOLUTION_DIAGNOSTIC_SUMMARY.md"
    csv_path = out_dir / "skill_evolution_diagnostic_rows.csv"
    _write_json(summary_path, summary)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(_render_markdown(summary), encoding="utf-8")
    _write_csv(csv_path, summary["rows"])
    print(
        json.dumps(
            {
                "summary": str(summary_path),
                "report": str(report_path),
                "csv": str(csv_path),
                "row_count": summary["row_count"],
                "counts": summary["counts"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
