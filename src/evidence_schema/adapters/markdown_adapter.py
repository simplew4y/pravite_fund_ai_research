"""Markdown / Obsidian parsed blocks -> markdown_block evidence.

Expected parsed block (produced by a Markdown / Obsidian parser):
    {
      "heading": "毛利率趋势",
      "text": "...",
      "frontmatter": {"company": "zeekr"},   # optional, or "front_matter"
      "tags": ["#估值"],                       # optional, or "tag"
      "wikilinks": ["[[Zeekr DCF]]"],          # optional, or "wiki_links" / "links"
      "block_type": "paragraph"               # optional
    }

frontmatter / tags / wikilinks are Markdown-specific, so they go into
location_json rather than getting their own columns.

Upstream field names are not finalized, so each field is read through a set
of aliases (see ASSUMPTIONS in test/evidence_schema/README.md).
"""

from __future__ import annotations

from typing import Any

from ..schema import Evidence, EvidenceLocation, EvidenceType
from .base import AdapterContext, BaseEvidenceAdapter, pick


class MarkdownEvidenceAdapter(BaseEvidenceAdapter):
    evidence_type = EvidenceType.MARKDOWN_BLOCK.value

    def adapt(
        self,
        parsed_blocks: list[dict[str, Any]],
        ctx: AdapterContext,
    ) -> list[Evidence]:
        evidences: list[Evidence] = []
        _aliases = {
            "frontmatter": ("frontmatter", "front_matter"),
            "tags": ("tags", "tag"),
            "wikilinks": ("wikilinks", "wiki_links", "links"),
        }
        for block in parsed_blocks:
            text = (pick(block, "text", "content", default="") or "").strip()
            if not text:
                continue
            location_json: dict[str, Any] = {}
            for canonical, keys in _aliases.items():
                value = pick(block, *keys)
                if value:
                    location_json[canonical] = value
            location = EvidenceLocation(
                evidence_id="",
                file_name=pick(block, "file", "file_name") or ctx.file_name,
                heading=pick(block, "heading"),
                location_json=location_json,
            )
            metadata: dict[str, Any] = {}
            block_type = pick(block, "block_type")
            if block_type:
                metadata["block_type"] = block_type
            evidences.append(
                self._build_evidence(ctx, text, location, metadata=metadata)
            )
        return evidences
