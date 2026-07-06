"""Shared PDF evidence and citation models for the minimum demo."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True)
class Document:
    doc_id: str
    file_name: str
    file_path: str
    doc_type: str = "pdf"
    checksum: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class DocumentVersion:
    version_id: str
    doc_id: str
    file_path: str
    checksum: str
    parser_name: str
    version_no: int = 1

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class EvidenceLocation:
    file_name: str
    file_path: str
    page_no: int
    paragraph_no: int = 0

    def display(self) -> str:
        suffix = f", paragraph {self.paragraph_no}" if self.paragraph_no else ""
        return f"{self.file_name}, p.{self.page_no}{suffix}"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Evidence:
    evidence_id: str
    doc_id: str
    version_id: str
    evidence_type: str
    content_text: str
    location: EvidenceLocation
    metadata: dict[str, Any] = field(default_factory=dict)

    def display(self) -> str:
        return self.location.display()

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Citation:
    citation_id: str
    source_type: str
    source_id: str
    evidence_id: str
    doc_id: str
    claim: str
    quote: str
    display: str
    needs_review: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
