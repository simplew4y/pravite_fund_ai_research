"""Data contracts for evidence-fusion retrieval."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True)
class RetrievalPolicy:
    mode: str
    query_type: str
    retain_metric_dci: bool = True
    retain_keyword_dci: bool = True
    run_rag: bool = False
    rag_required: bool = False
    require_table_evidence: bool = False
    require_text_evidence: bool = False
    reason_codes: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["reason_codes"] = list(self.reason_codes)
        return payload


@dataclass(frozen=True)
class EvidenceConflict:
    conflict_type: str
    evidence_ids: tuple[str, ...]
    metric_name: str = ""
    period: str = ""
    preferred_evidence_id: str = ""
    resolution_status: str = "unresolved"
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["evidence_ids"] = list(self.evidence_ids)
        return payload


@dataclass
class EvidenceFusionResult:
    query: str
    context: str
    final_chunks: list[dict[str, Any]] = field(default_factory=list)
    pre_rerank_chunks: list[dict[str, Any]] = field(default_factory=list)
    time_info: list[Any] = field(default_factory=list)
    policy: RetrievalPolicy | None = None
    conflicts: list[EvidenceConflict] = field(default_factory=list)
    retrieval_trace: list[dict[str, Any]] = field(default_factory=list)
    rag_executed: bool = False
    rag_succeeded: bool = False

    def metadata(self) -> dict[str, Any]:
        return {
            "policy": self.policy.to_dict() if self.policy else {},
            "conflicts": [conflict.to_dict() for conflict in self.conflicts],
            "retrieval_trace": list(self.retrieval_trace),
            "rag_executed": self.rag_executed,
            "rag_succeeded": self.rag_succeeded,
        }
