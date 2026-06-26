"""parsed blocks -> unified, validated evidence."""

from __future__ import annotations

import pytest

from evidence_schema import (
    AdapterContext,
    Evidence,
    EvidenceLocation,
    EvidenceValidationError,
    PdfEvidenceAdapter,
    normalize_evidence,
    normalize_many,
    validate_evidence,
)


def _ctx():
    return AdapterContext(
        doc_id="doc_001",
        version_id="ver_001",
        file_name="Zeekr_2024_AR.pdf",
        project_id="zeekr_project",
        collection_id="company_collection",
        metadata={"doc_type": "annual_report", "parser": "mineru"},
    )


def test_pdf_blocks_become_unified_evidence(pdf_blocks):
    evidences = normalize_many(PdfEvidenceAdapter().adapt(pdf_blocks, _ctx()))
    # the blank-text block is dropped
    assert len(evidences) == 2
    ev = evidences[0]
    assert ev.evidence_id.startswith("ev_")
    assert ev.doc_id == "doc_001"
    assert ev.version_id == "ver_001"
    assert ev.evidence_type == "pdf_page_section"
    assert ev.content_text
    assert ev.created_at and ev.updated_at
    assert ev.metadata_json["doc_type"] == "annual_report"
    assert ev.location is not None
    assert ev.location.file_name == "Zeekr_2024_AR.pdf"
    assert ev.location.evidence_id == ev.evidence_id
    assert ev.location.location_id.startswith("loc_")


def test_evidence_id_is_deterministic(pdf_blocks):
    first = PdfEvidenceAdapter().adapt(pdf_blocks, _ctx())
    second = PdfEvidenceAdapter().adapt(pdf_blocks, _ctx())
    assert [e.evidence_id for e in first] == [e.evidence_id for e in second]


def test_validation_requires_doc_and_version():
    bad = Evidence(
        evidence_id="ev_x",
        doc_id="",
        version_id="",
        evidence_type="pdf_page_section",
        content_text="x",
        location=EvidenceLocation(evidence_id="ev_x", file_name="a.pdf"),
    )
    with pytest.raises(EvidenceValidationError) as exc:
        validate_evidence(bad)
    assert "missing doc_id" in str(exc.value)
    assert "missing version_id" in str(exc.value)


def test_validation_requires_location():
    bad = Evidence(
        evidence_id="ev_y",
        doc_id="doc_001",
        version_id="ver_001",
        evidence_type="pdf_page_section",
        content_text="x",
        location=None,
    )
    with pytest.raises(EvidenceValidationError):
        normalize_evidence(bad)
