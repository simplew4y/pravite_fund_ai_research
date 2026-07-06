import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from pdf_research_demo import PdfResearchDemo
from pdf_research_demo.memo_pdf import render_memo_pdf


@pytest.fixture
def sample_pdf_pair(tmp_path: Path) -> tuple[Path, Path]:
    pdf = tmp_path / "sample_10k.pdf"
    pdf.write_bytes(b"%PDF-1.4\n% demo fixture\n")
    text = tmp_path / "sample_10k.txt"
    text.write_text(
        "\n".join(
            [
                "Tesla designs and manufactures electric vehicles and energy storage products.",
                "",
                "Robotaxi service was launched in June 2025 and uses the company's FSD capabilities.",
                "\f",
                "Risk factors include competition, regulatory uncertainty, supply constraints and demand volatility.",
                "",
                "Revenue increased while operating cash flow and capital expenditures remained important to liquidity.",
            ]
        ),
        encoding="utf-8",
    )
    return pdf, text


def test_pdf_qa_returns_citation_and_trace(sample_pdf_pair: tuple[Path, Path]) -> None:
    pdf, text = sample_pdf_pair
    demo = PdfResearchDemo()
    demo.ingest_pdf(pdf, text)

    result = demo.answer_question("What does the PDF say about Robotaxi and FSD?")

    assert result.needs_review is False
    assert result.citations
    assert result.citations[0].evidence_id.startswith("ev_")
    trace = demo.trace_citation(result.citations[0].citation_id)
    assert trace["citation"].citation_id == result.citations[0].citation_id
    assert trace["evidence"].evidence_id == result.citations[0].evidence_id
    assert trace["document"].file_name == "sample_10k.pdf"
    assert trace["version"].file_path == str(pdf.resolve())
    assert trace["location"].page_no == 1
    assert trace["original_file"] == str(pdf.resolve())


def test_chinese_investment_question_expands_to_pdf_evidence(sample_pdf_pair: tuple[Path, Path]) -> None:
    pdf, text = sample_pdf_pair
    demo = PdfResearchDemo()
    demo.ingest_pdf(pdf, text)

    result = demo.answer_question("概括特斯拉当前的核心投资逻辑")

    assert result.needs_review is False
    assert result.citations
    assert any("Robotaxi" in citation.quote or "energy" in citation.quote for citation in result.citations)


def test_pdf_memo_sections_have_traceable_citations(sample_pdf_pair: tuple[Path, Path]) -> None:
    pdf, text = sample_pdf_pair
    demo = PdfResearchDemo()
    demo.ingest_pdf(pdf, text)

    memo = demo.generate_memo("Tesla, Inc.", "TSLA")

    assert memo.sections
    assert any(not section.needs_review for section in memo.sections)
    assert memo.citations
    markdown = memo.to_markdown()
    assert "Tesla, Inc. (TSLA) PDF Evidence Memo" in markdown
    assert "Citations:" in markdown
    for citation in memo.citations:
        trace = demo.trace_citation(citation.citation_id)
        assert trace["evidence"].evidence_id == citation.evidence_id
        assert trace["location"].file_name == "sample_10k.pdf"


def test_native_pdf_ingestion_without_text_cache(tmp_path: Path) -> None:
    reportlab = pytest.importorskip("reportlab")
    assert reportlab
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas

    pdf = tmp_path / "native_10k.pdf"
    writer = canvas.Canvas(str(pdf), pagesize=letter)
    writer.drawString(72, 720, "Tesla designs and manufactures electric vehicles and energy storage products.")
    writer.drawString(72, 700, "Robotaxi service uses the company's FSD capabilities in the local PDF evidence.")
    writer.showPage()
    writer.drawString(72, 720, "Risk factors include competition, regulatory uncertainty and demand volatility.")
    writer.save()

    demo = PdfResearchDemo()
    document = demo.ingest_pdf(pdf)
    result = demo.answer_question("What does the PDF say about Robotaxi and FSD?")

    assert document.file_name == "native_10k.pdf"
    assert len(demo.store.evidence) >= 2
    assert result.citations
    assert result.citations[0].display.startswith("native_10k.pdf, p.1")


def test_memo_can_render_to_pdf(sample_pdf_pair: tuple[Path, Path], tmp_path: Path) -> None:
    pdf, text = sample_pdf_pair
    demo = PdfResearchDemo()
    demo.ingest_pdf(pdf, text)

    memo = demo.generate_memo("Tesla, Inc.", "TSLA")
    output = render_memo_pdf(memo, tmp_path)

    assert output.is_file()
    assert output.read_bytes().startswith(b"%PDF-")
