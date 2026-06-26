"""Unified evidence / citation / provenance data models.

Design contract (see docs/evidence_schema_design.md):
  - parsing may be per-type, but citation must be unified.
  - output (QA answer / memo section / fact) cites a citation_id, never a file.
  - citation -> evidence -> (document, version, location) -> original file.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Optional


class EvidenceType(str, Enum):
    PDF_PAGE_SECTION = "pdf_page_section"
    PPT_SLIDE = "ppt_slide"
    WORD_SECTION = "word_section"
    EXCEL_CELL = "excel_cell"
    MARKDOWN_BLOCK = "markdown_block"
    QA_MESSAGE = "qa_message"
    MEMO_SECTION = "memo_section"


class SourceType(str, Enum):
    QA_ANSWER = "qa_answer"
    QA_MESSAGE = "qa_message"
    MEMO_SECTION = "memo_section"
    PERSONAL_NOTE = "personal_note"
    FACT = "fact"


class VersionStatus(str, Enum):
    PENDING = "pending"
    PARSED = "parsed"
    FAILED = "failed"


@dataclass
class Document:
    """Stable identity of a piece of source material."""

    doc_id: str
    project_id: str = ""
    company_id: str = ""
    file_name: str = ""
    doc_type: str = ""
    source: str = ""
    document_date: str = ""
    current_version_id: str = ""
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DocumentVersion:
    """A specific file version of a document."""

    version_id: str
    doc_id: str
    file_path: str = ""
    checksum: str = ""
    version_no: int = 1
    parser_name: str = ""
    parser_version: str = ""
    ingested_at: str = ""
    status: str = VersionStatus.PARSED.value

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class EvidenceLocation:
    """Where an evidence sits inside the original file (one per evidence).

    Common fields are explicit columns; anything type-specific (shape_id,
    heading_path, tags, wikilink, ...) goes into location_json.
    """

    evidence_id: str
    location_id: str = ""
    file_name: str = ""
    page_no: Optional[int] = None
    slide_no: Optional[int] = None
    shape_id: Optional[str] = None
    sheet_name: Optional[str] = None
    cell: Optional[str] = None
    cell_range: Optional[str] = None
    formula: Optional[str] = None
    heading: Optional[str] = None
    section: Optional[str] = None
    paragraph_no: Optional[int] = None
    start_offset: Optional[int] = None
    end_offset: Optional[int] = None
    bbox_json: Optional[list[float]] = None
    location_json: dict[str, Any] = field(default_factory=dict)
    created_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Evidence:
    """The smallest citable unit. Distinct from a retrieval chunk."""

    evidence_id: str
    doc_id: str
    version_id: str
    evidence_type: str
    content_text: str = ""
    project_id: str = ""
    collection_id: str = ""
    content_json: dict[str, Any] = field(default_factory=dict)
    metadata_json: dict[str, Any] = field(default_factory=dict)
    location: Optional[EvidenceLocation] = None
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Citation:
    """A reference relation from an output to an evidence."""

    citation_id: str
    source_type: str
    source_id: str
    evidence_id: str
    doc_id: str = ""
    project_id: str = ""
    analyst_id: str = ""
    claim: str = ""
    quote: str = ""
    reason: str = ""
    display: str = ""
    created_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
