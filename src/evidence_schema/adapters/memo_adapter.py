"""Memo sections -> memo_section evidence (a memo can itself be cited).

Expected parsed block (a memo_sections row):
    {
      "memo_id": "memo_001",          # or "memo"
      "section_id": "thesis",         # or "section"
      "heading": "核心观点",            # or "title"
      "content": "极氪具备规模化降本能力。",  # or "text"
      "section_type": "thesis"        # optional
    }

memo_id / section_id go into location_json so the evidence traces back to
which memo/section; the human heading is mirrored into location.heading /
location.section. The produced Evidence is directly consumable by
build_citation(). Upstream field names are not finalized, so each field is
read through a set of aliases (see ASSUMPTIONS in test/evidence_schema/README.md).
"""

from __future__ import annotations

from typing import Any

from ..schema import Evidence, EvidenceLocation, EvidenceType
from .base import AdapterContext, BaseEvidenceAdapter, pick


class MemoEvidenceAdapter(BaseEvidenceAdapter):
    evidence_type = EvidenceType.MEMO_SECTION.value

    def adapt(
        self,
        parsed_blocks: list[dict[str, Any]],
        ctx: AdapterContext,
    ) -> list[Evidence]:
        evidences: list[Evidence] = []
        for block in parsed_blocks:
            text = (pick(block, "content", "text", default="") or "").strip()
            if not text:
                continue
            location_json: dict[str, Any] = {}
            memo_id = pick(block, "memo_id", "memo") or ctx.doc_id
            if memo_id:
                location_json["memo_id"] = memo_id
            section_id = pick(block, "section_id", "section")
            if section_id:
                location_json["section_id"] = section_id
            heading = pick(block, "heading", "title")
            location = EvidenceLocation(
                evidence_id="",
                file_name=pick(block, "file", "file_name") or ctx.file_name,
                heading=heading,
                section=heading,
                location_json=location_json,
            )
            metadata: dict[str, Any] = {}
            section_type = pick(block, "section_type")
            if section_type:
                metadata["section_type"] = section_type
            evidences.append(
                self._build_evidence(ctx, text, location, metadata=metadata)
            )
        return evidences
