"""PDF parsed blocks -> pdf_page_section evidence.

Expected parsed block (produced by a PDF parser such as mineru, not here):
    {
      "page_no": 42,                # or "page" / "page_index"
      "section": "Management Discussion",
      "text": "The gross margin decreased primarily due to ...",
      "bbox": [10, 120, 580, 720],
      "paragraph_no": 18,           # or "paragraph"
      "block_type": "paragraph"
    }

Upstream field names are not finalized, so each field is read through a set
of aliases (see ASSUMPTIONS in test/evidence_schema/README.md).
"""

from __future__ import annotations

from typing import Any

from ..schema import Evidence, EvidenceLocation, EvidenceType
from .base import AdapterContext, BaseEvidenceAdapter, pick


class PdfEvidenceAdapter(BaseEvidenceAdapter):
    evidence_type = EvidenceType.PDF_PAGE_SECTION.value

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
                file_name=pick(block, "file_name", "file") or ctx.file_name,
                page_no=pick(block, "page_no", "page", "page_index"),
                section=pick(block, "section"),
                paragraph_no=pick(block, "paragraph_no", "paragraph"),
                bbox_json=pick(block, "bbox", "bbox_json"),
            )
            metadata: dict[str, Any] = {}
            block_type = pick(block, "block_type")
            if block_type:
                metadata["block_type"] = block_type
            evidences.append(
                self._build_evidence(ctx, text, location, metadata=metadata)
            )
        return evidences
