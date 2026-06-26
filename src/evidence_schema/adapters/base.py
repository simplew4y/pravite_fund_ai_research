"""Adapter interface: parsed blocks (per file type) -> unified Evidence list.

Each parser only produces typed `parsed_blocks`. Each adapter turns those
blocks into unified Evidence objects. The normalizer then validates them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..ids import make_evidence_id, make_location_id, now_iso
from ..schema import Evidence, EvidenceLocation


@dataclass
class AdapterContext:
    """Stable identity + shared metadata injected by the ingest pipeline."""

    doc_id: str
    version_id: str
    file_name: str = ""
    project_id: str = ""
    collection_id: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)


class BaseEvidenceAdapter:
    """Base class for per-type evidence adapters."""

    evidence_type: str = ""

    def adapt(
        self,
        parsed_blocks: list[dict[str, Any]],
        ctx: AdapterContext,
    ) -> list[Evidence]:
        raise NotImplementedError

    def _build_evidence(
        self,
        ctx: AdapterContext,
        content_text: str,
        location: EvidenceLocation,
        content_json: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> Evidence:
        """Assemble a fully-linked Evidence + EvidenceLocation with stable ids."""
        loc_dict = location.to_dict()
        loc_dict.pop("evidence_id", None)
        loc_dict.pop("location_id", None)
        loc_dict.pop("created_at", None)
        evidence_id = make_evidence_id(
            ctx.doc_id, ctx.version_id, self.evidence_type, loc_dict
        )
        location.evidence_id = evidence_id
        location.location_id = make_location_id(evidence_id)
        location.file_name = location.file_name or ctx.file_name
        location.created_at = now_iso()

        meta = dict(ctx.metadata)
        if metadata:
            meta.update(metadata)
        ts = now_iso()
        return Evidence(
            evidence_id=evidence_id,
            doc_id=ctx.doc_id,
            version_id=ctx.version_id,
            evidence_type=self.evidence_type,
            content_text=content_text,
            project_id=ctx.project_id,
            collection_id=ctx.collection_id,
            content_json=content_json or {},
            metadata_json=meta,
            location=location,
            created_at=ts,
            updated_at=ts,
        )
