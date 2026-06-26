"""PDF parsed blocks -> pdf_page_section evidence.

Expected parsed block (produced by a PDF parser such as mineru, not here):
    {
      "page_no": 42,
      "section": "Management Discussion",
      "text": "The gross margin decreased primarily due to ...",
      "bbox": [10, 120, 580, 720],
      "paragraph_no": 18,
      "block_type": "paragraph"
    }
"""

from __future__ import annotations

from typing import Any

from ..schema import Evidence, EvidenceLocation, EvidenceType
from .base import AdapterContext, BaseEvidenceAdapter


class PdfEvidenceAdapter(BaseEvidenceAdapter):
    evidence_type = EvidenceType.PDF_PAGE_SECTION.value

    def adapt(
        self,
        parsed_blocks: list[dict[str, Any]],
        ctx: AdapterContext,
    ) -> list[Evidence]:
        evidences: list[Evidence] = []
        for block in parsed_blocks:
            text = (block.get("text") or "").strip()
            if not text:
                continue
            location = EvidenceLocation(
                evidence_id="",
                file_name=block.get("file_name") or ctx.file_name,
                page_no=block.get("page_no"),
                section=block.get("section"),
                paragraph_no=block.get("paragraph_no"),
                bbox_json=block.get("bbox"),
            )
            metadata: dict[str, Any] = {}
            if block.get("block_type"):
                metadata["block_type"] = block["block_type"]
            evidences.append(
                self._build_evidence(ctx, text, location, metadata=metadata)
            )
        return evidences
