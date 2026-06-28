"""Word parsed blocks -> word_section evidence.

Expected parsed block (produced by a Word parser such as python-docx):
    {
      "heading_path": ["管理层问答", "毛利率"],  # or "headings"
      "paragraph_no": 18,                       # or "paragraph"
      "text": "毛利率短期承压，主要来自价格竞争。",
      "labels": ["观点"],          # 观点/风险/待办 抽取, optional, or "label"
      "block_type": "paragraph"   # optional
    }

heading_path is kept in location_json so render_citation_display can show
"管理层问答 > 毛利率"; the last heading is also mirrored into location.heading.

Upstream field names are not finalized, so each field is read through a set
of aliases (see ASSUMPTIONS in test/evidence_schema/README.md).
"""

from __future__ import annotations

from typing import Any

from ..schema import Evidence, EvidenceLocation, EvidenceType
from .base import AdapterContext, BaseEvidenceAdapter, pick


class WordEvidenceAdapter(BaseEvidenceAdapter):
    evidence_type = EvidenceType.WORD_SECTION.value

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
            heading_path = pick(block, "heading_path", "headings") or []
            location_json: dict[str, Any] = {}
            if heading_path:
                location_json["heading_path"] = heading_path
            location = EvidenceLocation(
                evidence_id="",
                file_name=pick(block, "file", "file_name") or ctx.file_name,
                heading=heading_path[-1] if heading_path else pick(block, "heading"),
                paragraph_no=pick(block, "paragraph_no", "paragraph"),
                location_json=location_json,
            )
            metadata: dict[str, Any] = {}
            labels = pick(block, "labels", "label")
            if labels:
                metadata["labels"] = labels
            block_type = pick(block, "block_type")
            if block_type:
                metadata["block_type"] = block_type
            evidences.append(
                self._build_evidence(ctx, text, location, metadata=metadata)
            )
        return evidences
