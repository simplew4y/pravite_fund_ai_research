"""Validate and normalize evidence before it is persisted / indexed.

The normalizer enforces the schema contract (docs/evidence_schema_design.md
section 10): every evidence must have doc_id, version_id, evidence_type,
content, a traceable location, and must be renderable as a display citation.
"""

from __future__ import annotations

from .display import render_citation_display
from .ids import make_location_id, now_iso
from .schema import Evidence, EvidenceLocation


class EvidenceValidationError(ValueError):
    """Raised when an evidence does not satisfy the schema contract."""


def _has_traceable_location(loc: EvidenceLocation) -> bool:
    if loc.file_name:
        return True
    lj = loc.location_json or {}
    return bool(lj.get("session_id") or lj.get("memo_id"))


def validate_evidence(evidence: Evidence) -> bool:
    """Raise EvidenceValidationError listing all problems, else return True."""
    errors: list[str] = []
    if not evidence.doc_id:
        errors.append("missing doc_id")
    if not evidence.version_id:
        errors.append("missing version_id")
    if not evidence.evidence_type:
        errors.append("missing evidence_type")
    if not (evidence.content_text or evidence.content_json):
        errors.append("missing content_text/content_json")
    if evidence.location is None:
        errors.append("missing location")
    elif not _has_traceable_location(evidence.location):
        errors.append("location is not traceable")

    display = ""
    if evidence.location is not None:
        try:
            display = render_citation_display(evidence)
        except Exception as exc:  # pragma: no cover - defensive
            errors.append(f"cannot render display: {exc}")
    if evidence.location is not None and not display:
        errors.append("empty display citation")

    if errors:
        raise EvidenceValidationError(
            f"{evidence.evidence_id or '<no id>'}: " + "; ".join(errors)
        )
    return True


def normalize_evidence(evidence: Evidence) -> Evidence:
    """Fill timestamps / location ids, then validate. Mutates and returns it."""
    ts = now_iso()
    if not evidence.created_at:
        evidence.created_at = ts
    if not evidence.updated_at:
        evidence.updated_at = evidence.created_at
    loc = evidence.location
    if loc is not None:
        if not loc.evidence_id:
            loc.evidence_id = evidence.evidence_id
        if not loc.location_id:
            loc.location_id = make_location_id(evidence.evidence_id)
        if not loc.created_at:
            loc.created_at = ts
    validate_evidence(evidence)
    return evidence


def normalize_many(evidences: list[Evidence]) -> list[Evidence]:
    return [normalize_evidence(ev) for ev in evidences]
