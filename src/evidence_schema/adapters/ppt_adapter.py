"""PPT parsed blocks -> ppt_slide evidence.

Expected parsed block (produced by a PPT parser such as python-pptx):
    {
      "slide_no": 12,               # or "slide"
      "shape_id": "title 1",        # optional, or "shape"
      "text": "Zeekr targets 25% gross margin by 2026.",
      "notes": "speaker note ...",  # optional, or "note"
      "block_type": "title"         # optional
    }

Upstream field names are not finalized, so each field is read through a set
of aliases (see ASSUMPTIONS in test/evidence_schema/README.md).
"""

from __future__ import annotations

from typing import Any

from ..schema import Evidence, EvidenceLocation, EvidenceType
from .base import AdapterContext, BaseEvidenceAdapter, pick


class PptEvidenceAdapter(BaseEvidenceAdapter):
    evidence_type = EvidenceType.PPT_SLIDE.value

    def adapt(
        self,
        parsed_blocks: list[dict[str, Any]],
        ctx: AdapterContext,
    ) -> list[Evidence]:
        evidences: list[Evidence] = []
        for block in parsed_blocks:
            text = (pick(block, "text", "content", default="") or "").strip()
            if not text:
                continue
            location = EvidenceLocation(
                evidence_id="",
                file_name=pick(block, "file", "file_name") or ctx.file_name,
                slide_no=pick(block, "slide_no", "slide"),
                shape_id=pick(block, "shape_id", "shape"),
            )
            content_json: dict[str, Any] = {}
            notes = pick(block, "notes", "note")
            if notes:
                content_json["notes"] = notes
            metadata: dict[str, Any] = {}
            block_type = pick(block, "block_type")
            if block_type:
                metadata["block_type"] = block_type
            evidences.append(
                self._build_evidence(
                    ctx, text, location, content_json=content_json, metadata=metadata
                )
            )
        return evidences
