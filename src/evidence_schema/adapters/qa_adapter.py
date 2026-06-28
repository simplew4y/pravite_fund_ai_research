"""QA messages -> qa_message evidence (runtime / research-memory side).

Expected parsed block (a qa_messages row from research memory):
    {
      "session_id": "session_001",     # or "session"
      "message_id": "msg_002",         # or "msg_id" / "id"
      "role": "assistant",             # user | assistant | system | tool
      "content": "FY2024 毛利率承压。",  # or "text" / "body"
      "created_at": "2026-01-01T00:00:05Z",  # optional, or "timestamp"
      "citation_ids": ["cit_demo"],    # optional, top-level in real qa_messages
      "metadata_json": {}              # optional, or "metadata"
    }

In the real lzx_memo `qa_messages` table `citation_ids` is a top-level
column; older/synthetic blocks may still nest it under
`metadata_json.citation_ids`. Both are accepted, with the top-level value
taking precedence.

QA evidence usually has no file_name; it is traced through session_id /
message_id kept in location_json. Upstream field names are not finalized,
so each field is read through a set of aliases (see ASSUMPTIONS in
test/evidence_schema/README.md).
"""

from __future__ import annotations

from typing import Any

from ..schema import Evidence, EvidenceLocation, EvidenceType
from .base import AdapterContext, BaseEvidenceAdapter, pick


class QaEvidenceAdapter(BaseEvidenceAdapter):
    evidence_type = EvidenceType.QA_MESSAGE.value

    def adapt(
        self,
        parsed_blocks: list[dict[str, Any]],
        ctx: AdapterContext,
    ) -> list[Evidence]:
        evidences: list[Evidence] = []
        for block in parsed_blocks:
            text = (pick(block, "content", "text", "body", default="") or "").strip()
            if not text:
                continue
            location_json: dict[str, Any] = {}
            session_id = pick(block, "session_id", "session")
            if session_id:
                location_json["session_id"] = session_id
            message_id = pick(block, "message_id", "msg_id", "id")
            if message_id:
                location_json["message_id"] = message_id
            role = pick(block, "role", default="assistant")
            if role:
                location_json["role"] = role
            location = EvidenceLocation(
                evidence_id="",
                file_name=pick(block, "file", "file_name") or ctx.file_name,
                location_json=location_json,
            )
            metadata: dict[str, Any] = {}
            created = pick(block, "created_at", "timestamp")
            if created:
                metadata["created_at"] = created
            source_meta = pick(block, "metadata_json", "metadata")
            if isinstance(source_meta, dict):
                metadata.update(source_meta)
            citation_ids = pick(block, "citation_ids")
            if citation_ids is not None:
                metadata["citation_ids"] = citation_ids
            evidences.append(
                self._build_evidence(ctx, text, location, metadata=metadata)
            )
        return evidences
