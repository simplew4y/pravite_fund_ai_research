"""evidence location -> human-readable display citation."""

from __future__ import annotations

from evidence_schema import (
    Evidence,
    EvidenceLocation,
    EvidenceType,
    render_citation_display,
)


def _ev(evidence_type: str, location: EvidenceLocation) -> Evidence:
    return Evidence(
        evidence_id="ev_x",
        doc_id="doc_001",
        version_id="ver_001",
        evidence_type=evidence_type,
        content_text="...",
        location=location,
    )


CASES = {
    EvidenceType.PDF_PAGE_SECTION.value: (
        EvidenceLocation(
            evidence_id="ev_x",
            file_name="Zeekr_2024_AR.pdf",
            page_no=42,
            section="Management Discussion",
        ),
        "Zeekr_2024_AR.pdf, p.42, Management Discussion",
    ),
    EvidenceType.PPT_SLIDE.value: (
        EvidenceLocation(
            evidence_id="ev_x", file_name="Investor_Day.pptx", slide_no=12
        ),
        "Investor_Day.pptx, slide 12",
    ),
    EvidenceType.WORD_SECTION.value: (
        EvidenceLocation(
            evidence_id="ev_x",
            file_name="meeting_minutes.docx",
            paragraph_no=18,
            location_json={"heading_path": ["管理层问答", "毛利率"]},
        ),
        "meeting_minutes.docx, 管理层问答 > 毛利率, paragraph 18",
    ),
    EvidenceType.EXCEL_CELL.value: (
        EvidenceLocation(
            evidence_id="ev_x",
            file_name="Zeekr_valuation_model.xlsx",
            sheet_name="DCF",
            cell="E12",
            formula="=E11/E10",
        ),
        "Zeekr_valuation_model.xlsx, DCF!E12, formula = E11/E10",
    ),
    EvidenceType.MARKDOWN_BLOCK.value: (
        EvidenceLocation(
            evidence_id="ev_x",
            file_name="zeekr_profitability.md",
            heading="毛利率趋势",
        ),
        "zeekr_profitability.md, #毛利率趋势",
    ),
    EvidenceType.QA_MESSAGE.value: (
        EvidenceLocation(
            evidence_id="ev_x",
            file_name="",
            location_json={"session_id": "session_001", "message_id": "msg_002"},
        ),
        "session_001, assistant message msg_002",
    ),
    EvidenceType.MEMO_SECTION.value: (
        EvidenceLocation(
            evidence_id="ev_x",
            file_name="",
            location_json={"memo_id": "memo_001", "section_id": "核心观点"},
        ),
        "memo_001, section 核心观点",
    ),
}


def test_render_each_type(outputs_dir):
    lines = []
    for evidence_type, (location, expected) in CASES.items():
        actual = render_citation_display(_ev(evidence_type, location))
        assert actual == expected, f"{evidence_type}: {actual!r} != {expected!r}"
        lines.append(f"{evidence_type}: {actual}")
    (outputs_dir / "citation_display.txt").write_text(
        "\n".join(lines) + "\n", encoding="utf-8"
    )


def test_pdf_degrades_without_section():
    loc = EvidenceLocation(evidence_id="ev_x", file_name="a.pdf", page_no=3)
    assert render_citation_display(
        _ev(EvidenceType.PDF_PAGE_SECTION.value, loc)
    ) == "a.pdf, p.3"
