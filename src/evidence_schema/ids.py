"""Stable, reproducible ID and timestamp helpers for evidence schema.

evidence_id / citation_id are derived deterministically from content so that
re-ingesting the same file version yields the same id, and a new file version
produces a new evidence_id without breaking old citations.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any


def now_iso() -> str:
    """UTC timestamp in a stable, sortable ISO-8601 form."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _canonical(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _digest(payload: str) -> str:
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


def make_evidence_id(
    doc_id: str,
    version_id: str,
    evidence_type: str,
    location: dict[str, Any] | None = None,
) -> str:
    """Deterministic evidence id.

    Bound to (doc_id, version_id, evidence_type, location). It does NOT depend
    on ingestion time, so the id is stable and version-invariant.
    """
    payload = _canonical([doc_id, version_id, evidence_type, location or {}])
    return f"ev_{_digest(payload)}"


def make_location_id(evidence_id: str) -> str:
    """One location per evidence; id is derived from the evidence id."""
    return f"loc_{_digest(evidence_id)}"


def make_citation_id(
    source_type: str,
    source_id: str,
    evidence_id: str,
    claim: str = "",
) -> str:
    """Deterministic citation id for a given (source, evidence, claim)."""
    payload = _canonical([source_type, source_id, evidence_id, claim])
    return f"cit_{_digest(payload)}"
