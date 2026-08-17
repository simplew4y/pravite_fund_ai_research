"""Privacy-preserving runtime traces for deterministic Skill repairs."""

from __future__ import annotations

import hashlib
from typing import Any, Dict, Iterable, List, Mapping, Optional


def _sha256_text(value: str) -> str:
    return hashlib.sha256((value or "").encode("utf-8")).hexdigest()


def _evidence_refs(chunks: Iterable[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    refs: List[Dict[str, Any]] = []
    seen = set()
    for chunk in chunks:
        metadata = chunk.get("metadata") or {}
        filename = (
            metadata.get("filename")
            or metadata.get("file_name")
            or metadata.get("source")
            or chunk.get("source")
        )
        page = metadata.get("page") or metadata.get("page_number") or chunk.get("page")
        source_date = metadata.get("date") or metadata.get("source_date")
        ref = {
            "filename": str(filename) if filename is not None else None,
            "page": page,
            "source_date": str(source_date) if source_date is not None else None,
        }
        key = (ref["filename"], str(ref["page"]), ref["source_date"])
        if key in seen or key == (None, "None", None):
            continue
        seen.add(key)
        refs.append(ref)
        if len(refs) >= 20:
            break
    return refs


def build_skill_trace(
    *,
    skill_id: str,
    skill_version: str,
    input_answer: str,
    output_answer: str,
    result: Optional[Mapping[str, Any]],
    evidence_chunks: Iterable[Mapping[str, Any]],
    latency_ms: float,
    error: Optional[BaseException] = None,
) -> Dict[str, Any]:
    """Build a trace without storing answer text or evidence content."""
    applied = bool(result and result.get("repair_applied")) and error is None
    reason = str((result or {}).get("repair_reason") or "")
    return {
        "schema_version": "1.0.0",
        "skill_id": skill_id,
        "skill_version": skill_version,
        "status": "failed" if error is not None else ("applied" if applied else "no_op"),
        "triggered": applied,
        "trigger_reason": reason[:500],
        "input_answer_sha256": _sha256_text(input_answer),
        "output_answer_sha256": _sha256_text(output_answer),
        "answer_changed": input_answer != output_answer,
        "evidence_refs": _evidence_refs(evidence_chunks),
        "latency_ms": round(max(0.0, latency_ms), 3),
        "error_type": type(error).__name__ if error is not None else None,
    }
