"""Traceability repository interface + an in-memory implementation.

The abstract interface is what Project DB (collection.db) will implement once
the SQLite schema is aligned (see README alignment items). The in-memory
implementation backs the unit tests so the evidence module is testable today
without depending on the final DB DDL.
"""

from __future__ import annotations

from typing import Any, Optional

from .display import render_citation_display
from .ids import make_citation_id, now_iso
from .schema import Citation, Document, DocumentVersion, Evidence


def build_citation(
    evidence: Evidence,
    source_type: str,
    source_id: str,
    *,
    project_id: str = "",
    analyst_id: str = "",
    claim: str = "",
    quote: str = "",
    reason: str = "",
) -> Citation:
    """Create a Citation pointing at an evidence, with display pre-rendered."""
    citation_id = make_citation_id(source_type, source_id, evidence.evidence_id, claim)
    return Citation(
        citation_id=citation_id,
        source_type=source_type,
        source_id=source_id,
        evidence_id=evidence.evidence_id,
        doc_id=evidence.doc_id,
        project_id=project_id or evidence.project_id,
        analyst_id=analyst_id,
        claim=claim,
        quote=quote,
        reason=reason,
        display=render_citation_display(evidence),
        created_at=now_iso(),
    )


class EvidenceRepository:
    """Read interface for the citation -> original file trace chain."""

    def get_document(self, doc_id: str) -> Optional[Document]:
        raise NotImplementedError

    def get_version(self, version_id: str) -> Optional[DocumentVersion]:
        raise NotImplementedError

    def get_evidence(self, evidence_id: str) -> Optional[Evidence]:
        raise NotImplementedError

    def get_citation(self, citation_id: str) -> Optional[Citation]:
        raise NotImplementedError

    def trace_citation(self, citation_id: str) -> dict[str, Any]:
        """citation -> evidence -> location -> document -> version -> file."""
        citation = self.get_citation(citation_id)
        if citation is None:
            return {}
        evidence = self.get_evidence(citation.evidence_id)
        document = self.get_document(evidence.doc_id) if evidence else None
        version = self.get_version(evidence.version_id) if evidence else None
        original_file = ""
        if version and version.file_path:
            original_file = version.file_path
        elif evidence and evidence.location:
            original_file = evidence.location.file_name
        return {
            "citation": citation,
            "evidence": evidence,
            "location": evidence.location if evidence else None,
            "document": document,
            "version": version,
            "original_file": original_file,
        }


class InMemoryEvidenceRepository(EvidenceRepository):
    """Dict-backed repository for tests and demos."""

    def __init__(self) -> None:
        self.documents: dict[str, Document] = {}
        self.versions: dict[str, DocumentVersion] = {}
        self.evidences: dict[str, Evidence] = {}
        self.citations: dict[str, Citation] = {}

    def add_document(self, document: Document) -> None:
        self.documents[document.doc_id] = document

    def add_version(self, version: DocumentVersion) -> None:
        self.versions[version.version_id] = version

    def add_evidence(self, evidence: Evidence) -> None:
        self.evidences[evidence.evidence_id] = evidence

    def add_citation(self, citation: Citation) -> None:
        self.citations[citation.citation_id] = citation

    def get_document(self, doc_id: str) -> Optional[Document]:
        return self.documents.get(doc_id)

    def get_version(self, version_id: str) -> Optional[DocumentVersion]:
        return self.versions.get(version_id)

    def get_evidence(self, evidence_id: str) -> Optional[Evidence]:
        return self.evidences.get(evidence_id)

    def get_citation(self, citation_id: str) -> Optional[Citation]:
        return self.citations.get(citation_id)
