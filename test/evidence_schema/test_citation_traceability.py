"""citation -> evidence -> location -> document -> version -> original file."""

from __future__ import annotations

from evidence_schema import (
    AdapterContext,
    Document,
    DocumentVersion,
    InMemoryEvidenceRepository,
    PdfEvidenceAdapter,
    build_citation,
    normalize_many,
)


def _ingest(repo, version_id, file_path, blocks):
    """Ingest one version of a doc; return its evidence list."""
    repo.add_version(
        DocumentVersion(
            version_id=version_id,
            doc_id="doc_001",
            file_path=file_path,
            checksum=version_id,
        )
    )
    ctx = AdapterContext(
        doc_id="doc_001",
        version_id=version_id,
        file_name="Zeekr_2024_AR.pdf",
        project_id="zeekr_project",
    )
    evidences = normalize_many(PdfEvidenceAdapter().adapt(blocks, ctx))
    for ev in evidences:
        repo.add_evidence(ev)
    return evidences


def test_citation_traces_back_to_original_file(pdf_blocks):
    repo = InMemoryEvidenceRepository()
    repo.add_document(
        Document(doc_id="doc_001", file_name="Zeekr_2024_AR.pdf", current_version_id="ver_001")
    )
    evidences = _ingest(repo, "ver_001", "/data/v1/Zeekr_2024_AR.pdf", pdf_blocks)

    citation = build_citation(
        evidences[0],
        source_type="qa_answer",
        source_id="msg_002",
        claim="FY2024 毛利率承压主要来自价格竞争。",
        quote="gross margin decreased primarily due to product mix and pricing pressure",
        reason="支持毛利率承压判断",
    )
    repo.add_citation(citation)

    trace = repo.trace_citation(citation.citation_id)
    assert trace["evidence"].evidence_id == evidences[0].evidence_id
    assert trace["location"].page_no == 42
    assert trace["document"].doc_id == "doc_001"
    assert trace["version"].version_id == "ver_001"
    assert trace["original_file"] == "/data/v1/Zeekr_2024_AR.pdf"
    assert citation.display == "Zeekr_2024_AR.pdf, p.42, Management Discussion"


def test_new_version_does_not_break_old_citation(pdf_blocks):
    repo = InMemoryEvidenceRepository()
    repo.add_document(Document(doc_id="doc_001", file_name="Zeekr_2024_AR.pdf"))

    v1 = _ingest(repo, "ver_001", "/data/v1/Zeekr_2024_AR.pdf", pdf_blocks)
    old_citation = build_citation(v1[0], source_type="qa_answer", source_id="msg_002")
    repo.add_citation(old_citation)

    # a new file version is ingested later
    v2 = _ingest(repo, "ver_002", "/data/v2/Zeekr_2024_AR.pdf", pdf_blocks)

    # evidence ids differ per version; old id is unchanged and still resolves
    assert v1[0].evidence_id != v2[0].evidence_id
    trace = repo.trace_citation(old_citation.citation_id)
    assert trace["evidence"].evidence_id == v1[0].evidence_id
    assert trace["version"].version_id == "ver_001"
    assert trace["original_file"] == "/data/v1/Zeekr_2024_AR.pdf"
