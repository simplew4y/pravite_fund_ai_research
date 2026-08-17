from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class SourceDocument:
    document_id: str
    remote_path: str
    pages: tuple[str, ...] = ()
    source_file: str = ""

    def to_dict(self, public: bool = False) -> dict[str, Any]:
        value = asdict(self)
        value["pages"] = list(self.pages)
        if public:
            value.pop("remote_path", None)
        return value


@dataclass(frozen=True)
class ClaimRubric:
    claim_id: str
    dataset: str
    question: str
    expected_answer: str
    entities: tuple[str, ...]
    capability: str
    source_documents: tuple[SourceDocument, ...]
    visibility: str
    metadata: dict[str, Any]

    def to_dict(self, hidden: bool = True) -> dict[str, Any]:
        value = asdict(self)
        value["entities"] = list(self.entities)
        value["source_documents"] = [doc.to_dict(public=not hidden) for doc in self.source_documents]
        if not hidden:
            value.pop("expected_answer", None)
        return value


@dataclass(frozen=True)
class ResearchTask:
    task_id: str
    title: str
    objective: str
    entities: tuple[str, ...]
    as_of_date: str
    audience: str
    required_sections: tuple[str, ...]
    research_requirements: tuple[str, ...]
    source_document_ids: tuple[str, ...]
    claim_ids: tuple[str, ...]
    visibility: str
    evaluation_split: str
    deliverable: str = "markdown_research_report"

    def to_dict(self, hidden: bool = False) -> dict[str, Any]:
        value = asdict(self)
        for field in ("entities", "required_sections", "research_requirements", "source_document_ids", "claim_ids"):
            value[field] = list(value[field])
        if not hidden:
            value.pop("claim_ids", None)
        return value
