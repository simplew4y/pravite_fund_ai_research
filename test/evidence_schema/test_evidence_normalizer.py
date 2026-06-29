"""parsed blocks -> unified, validated evidence."""

from __future__ import annotations

import pytest

from evidence_schema import (
    AdapterContext,
    Evidence,
    EvidenceLocation,
    EvidenceValidationError,
    MarkdownEvidenceAdapter,
    PdfEvidenceAdapter,
    PptEvidenceAdapter,
    WordEvidenceAdapter,
    normalize_evidence,
    normalize_many,
    render_citation_display,
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


def _ctx_for(file_name: str):
    return AdapterContext(
        doc_id="doc_001", version_id="ver_001", file_name=file_name
    )


def test_ppt_blocks_become_unified_evidence(ppt_blocks):
    ctx = _ctx_for("Investor_Day.pptx")
    evidences = normalize_many(PptEvidenceAdapter().adapt(ppt_blocks, ctx))
    assert len(evidences) == 2  # blank slide dropped
    e = next(e for e in evidences if e.location.slide_no == 12)
    assert e.evidence_type == "ppt_slide"
    assert e.content_json["notes"].startswith("Driven by scale")
    assert render_citation_display(e) == "Investor_Day.pptx, slide 12"


def test_word_blocks_keep_heading_path_and_labels(word_blocks):
    ctx = _ctx_for("meeting_minutes.docx")
    evidences = normalize_many(WordEvidenceAdapter().adapt(word_blocks, ctx))
    assert len(evidences) == 2  # blank paragraph dropped
    e = next(e for e in evidences if e.location.paragraph_no == 18)
    assert e.evidence_type == "word_section"
    assert e.location.location_json["heading_path"] == ["管理层问答", "毛利率"]
    assert e.metadata_json["labels"] == ["观点"]
    assert (
        render_citation_display(e)
        == "meeting_minutes.docx, 管理层问答 > 毛利率, paragraph 18"
    )


def test_markdown_blocks_keep_obsidian_fields(markdown_blocks):
    ctx = _ctx_for("zeekr_profitability.md")
    evidences = normalize_many(MarkdownEvidenceAdapter().adapt(markdown_blocks, ctx))
    assert len(evidences) == 2  # empty block dropped
    e = next(e for e in evidences if e.location.heading == "毛利率趋势")
    assert e.evidence_type == "markdown_block"
    assert e.location.location_json["tags"] == ["#估值", "#毛利率"]
    assert e.location.location_json["frontmatter"] == {"company": "zeekr"}
    assert e.location.location_json["wikilinks"] == ["[[Zeekr DCF]]"]
    assert render_citation_display(e) == "zeekr_profitability.md, #毛利率趋势"


# --- field alias contract tests (upstream field names not finalized) ---------


def test_pdf_page_alias_maps_to_page_no():
    ctx = _ctx_for("a.pdf")
    block = {"page": 7, "section": "MD&A", "text": "gross margin fell"}
    e = normalize_many(PdfEvidenceAdapter().adapt([block], ctx))[0]
    assert e.location.page_no == 7
    assert render_citation_display(e) == "a.pdf, p.7, MD&A"


def test_ppt_slide_alias_maps_to_slide_no():
    ctx = _ctx_for("d.pptx")
    block = {"slide": 5, "text": "25% gross margin target", "note": "scale effects"}
    e = normalize_many(PptEvidenceAdapter().adapt([block], ctx))[0]
    assert e.location.slide_no == 5
    assert e.content_json["notes"] == "scale effects"
    assert render_citation_display(e) == "d.pptx, slide 5"


def test_word_heading_and_paragraph_aliases():
    ctx = _ctx_for("m.docx")
    block = {"headings": ["管理层问答", "毛利率"], "paragraph": 18, "text": "承压"}
    e = normalize_many(WordEvidenceAdapter().adapt([block], ctx))[0]
    assert e.location.paragraph_no == 18
    assert e.location.location_json["heading_path"] == ["管理层问答", "毛利率"]
    assert render_citation_display(e) == "m.docx, 管理层问答 > 毛利率, paragraph 18"


def test_markdown_alias_fields():
    ctx = _ctx_for("z.md")
    block = {
        "heading": "毛利率趋势",
        "text": "...",
        "front_matter": {"company": "zeekr"},
        "tag": ["#估值"],
        "links": ["[[Zeekr DCF]]"],
    }
    e = normalize_many(MarkdownEvidenceAdapter().adapt([block], ctx))[0]
    assert e.location.location_json["frontmatter"] == {"company": "zeekr"}
    assert e.location.location_json["tags"] == ["#估值"]
    assert e.location.location_json["wikilinks"] == ["[[Zeekr DCF]]"]
    assert render_citation_display(e) == "z.md, #毛利率趋势"
