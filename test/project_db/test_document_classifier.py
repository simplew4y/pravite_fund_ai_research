from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
PIPELINE_DIR = REPO_ROOT / "FinSagent" / "data_pipeline"
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

classifier = importlib.import_module("document_classifier")


class _FakeChatClient:
    def __init__(self, payload: dict[str, object] | str) -> None:
        self.payload = payload
        self.calls: list[list[dict[str, str]]] = []

    def chat(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str:
        assert max_tokens == classifier.LLM_CLASSIFICATION_MAX_TOKENS
        assert temperature == 0.0
        self.calls.append(messages)
        return self.payload if isinstance(self.payload, str) else json.dumps(self.payload, ensure_ascii=False)


def test_financial_report_uses_controlled_type_and_project_company() -> None:
    preview = classifier.DocumentPreview(
        filename="阳光电源2024年年度报告.pdf",
        file_type="pdf",
        text=(
            "阳光电源股份有限公司\n"
            "2024年年度报告\n"
            "审计报告\n"
            "合并资产负债表\n"
        ),
    )

    result = classifier.classify_document(
        preview,
        expected_company="阳光电源股份有限公司",
        expected_ticker="300274.SZ",
    )

    assert result.doc_type == "financial_valuation_data"
    assert result.doc_subtype == "annual_report"
    assert result.confidence >= 0.9
    assert result.classification_status == "accepted"
    assert result.company_name == "阳光电源股份有限公司"
    assert result.company_ticker == "300274.SZ"
    assert result.company_method == "project_company_match"


def test_meeting_minutes_are_not_reduced_to_pdf_file_type() -> None:
    preview = classifier.DocumentPreview(
        filename="20260701交流纪要.pdf",
        file_type="pdf",
        text="调研纪要\n参会人员：公司管理层、机构投资者\n交流要点及问答环节如下。",
    )

    result = classifier.classify_document(preview)

    assert result.doc_type == "meeting_third_party"
    assert result.doc_subtype == "research_meeting"
    assert result.classification_status == "accepted"


def test_excel_structure_can_identify_a_dcf_valuation_model() -> None:
    preview = classifier.DocumentPreview(
        filename="300274 model.xlsx",
        file_type="xlsx",
        text="DCF assumptions WACC terminal value target price sensitivity analysis",
        sheet_names=("Assumptions", "DCF", "Comps", "Sensitivity"),
        metadata={"formula_count": 42, "preview_value_count": 180},
    )

    result = classifier.classify_document(preview)

    assert result.doc_type == "financial_valuation_data"
    assert result.doc_subtype == "dcf_model"
    assert result.confidence >= 0.9


def test_ambiguous_document_uses_llm_but_validates_the_taxonomy() -> None:
    preview = classifier.DocumentPreview(
        filename="document.pdf",
        file_type="pdf",
        text=(
            "Sungrow Power Supply Co., Ltd. research update. "
            "A discussion of demand, margins, channel inventory and next year's outlook."
        ),
    )
    llm = _FakeChatClient(
        {
            "taxonomy_version": classifier.TAXONOMY_VERSION,
            "doc_type": "meeting_third_party",
            "doc_subtype": "internal_research_report",
            "confidence": 0.91,
            "company_name": "Sungrow Power Supply Co., Ltd.",
            "company_ticker": "300274.SZ",
            "company_confidence": 0.86,
            "evidence": ["The document states an internal investment view."],
            "requires_review": False,
        }
    )

    result = classifier.classify_document(preview, llm_client=llm)

    assert len(llm.calls) == 1
    assert result.method == "hybrid_llm"
    assert result.doc_type == "meeting_third_party"
    assert result.doc_subtype == "internal_research_report"
    assert result.classification_status == "accepted"
    assert result.company_name == "Sungrow Power Supply Co., Ltd."


def test_ungrounded_llm_company_is_kept_for_review_but_cannot_auto_route() -> None:
    preview = classifier.DocumentPreview(
        filename="anonymous-notes.pdf",
        file_type="pdf",
        text="Management discussed demand and margin trends without naming the company.",
    )
    llm = _FakeChatClient(
        {
            "taxonomy_version": classifier.TAXONOMY_VERSION,
            "doc_type": "meeting_third_party",
            "doc_subtype": "research_meeting",
            "confidence": 0.91,
            "company_name": "Imaginary Holdings Ltd.",
            "company_ticker": "FAKE",
            "company_confidence": 0.99,
            "evidence": ["Management discussed demand"],
            "requires_review": False,
        }
    )

    result = classifier.classify_document(preview, llm_client=llm, llm_policy="verify")

    assert result.company_name == "Imaginary Holdings Ltd."
    assert result.company_confidence == 0.69
    assert result.company_method == "llm_unverified_content_entity"
    assert result.company_requires_review is True
    assert result.classification_status == "needs_review"


def test_explicit_company_review_flag_prevents_high_confidence_auto_routing() -> None:
    preview = classifier.DocumentPreview(
        filename="peer-comparison.pdf",
        file_type="pdf",
        text="阳光电源股份有限公司与宁德时代新能源科技股份有限公司竞争格局比较。",
    )
    llm = _FakeChatClient(
        {
            "taxonomy_version": classifier.TAXONOMY_VERSION,
            "doc_type": "meeting_third_party",
            "doc_subtype": "broker_company_report",
            "confidence": 0.92,
            "company_name": "阳光电源股份有限公司",
            "company_ticker": "300274.SZ",
            "company_confidence": 0.98,
            "company_requires_review": True,
            "evidence": ["阳光电源股份有限公司与宁德时代新能源科技股份有限公司"],
            "requires_review": False,
        }
    )

    result = classifier.classify_document(preview, llm_client=llm, llm_policy="verify")

    assert result.company_confidence == 0.69
    assert result.company_requires_review is True
    assert result.classification_status == "needs_review"


def test_verify_policy_uses_llm_even_when_rules_are_high_confidence() -> None:
    preview = classifier.DocumentPreview(
        filename="misleading-company-2025-annual-report.pdf",
        file_type="pdf",
        text=(
            "阳光电源股份有限公司\n2025年年度报告\n"
            "证券代码：300274\n合并资产负债表"
        ),
    )
    llm = _FakeChatClient(
        {
            "taxonomy_version": classifier.TAXONOMY_VERSION,
            "doc_type": "financial_valuation_data",
            "doc_subtype": "annual_report",
            "confidence": 0.98,
            "company_name": "阳光电源股份有限公司",
            "company_ticker": "300274.SZ",
            "company_confidence": 0.99,
            "evidence": ["阳光电源股份有限公司", "2025年年度报告"],
            "requires_review": False,
        }
    )

    result = classifier.classify_document(preview, llm_client=llm, llm_policy="verify")

    assert len(llm.calls) == 1
    assert result.method == "hybrid_llm"
    assert result.company_method == "llm_content_entity"
    assert result.company_name == "阳光电源股份有限公司"


def test_llm_excerpt_is_bounded_and_keeps_high_signal_company_lines() -> None:
    preview = classifier.DocumentPreview(
        filename="document.pdf",
        file_type="pdf",
        text=(
            "generic cover\n"
            + ("ordinary narrative without useful identity\n" * 500)
            + "宁德时代新能源科技股份有限公司 证券代码 300750.SZ 年度报告\n"
            + ("appendix filler\n" * 300)
        ),
    )

    excerpt = classifier._llm_document_excerpt(preview)

    assert len(excerpt) <= classifier.MAX_LLM_PREVIEW_CHARS
    assert "宁德时代新能源科技股份有限公司" in excerpt


def test_llm_cannot_create_an_unregistered_document_type() -> None:
    preview = classifier.DocumentPreview("mystery.pdf", "pdf", "unstructured notes")
    llm = _FakeChatClient(
        {
            "doc_type": "investment_secret_file",
            "doc_subtype": "model_created_type",
            "confidence": 0.99,
            "company_name": "",
            "company_ticker": "",
            "company_confidence": 0,
            "evidence": [],
            "requires_review": False,
        }
    )

    result = classifier.classify_document(preview, llm_client=llm)

    assert result.doc_type == "other"
    assert result.classification_status == "needs_review"
    assert "unsupported doc_type" in result.llm_error


def test_llm_review_flag_is_respected_even_with_high_confidence() -> None:
    preview = classifier.DocumentPreview("ambiguous.pdf", "pdf", "management discussion")
    llm = _FakeChatClient(
        {
            "doc_type": "meeting_third_party",
            "doc_subtype": "internal_research_report",
            "confidence": 0.95,
            "company_name": "",
            "company_ticker": "",
            "company_confidence": 0,
            "evidence": ["The source does not identify its publisher."],
            "requires_review": True,
        }
    )

    result = classifier.classify_document(preview, llm_client=llm)

    assert result.doc_type == "meeting_third_party"
    assert result.confidence == 0.95
    assert result.classification_status == "needs_review"


def test_company_conflict_is_explicit_instead_of_overwriting_the_project() -> None:
    preview = classifier.DocumentPreview(
        filename="宁德时代2024年度报告.pdf",
        file_type="pdf",
        text="宁德时代新能源科技股份有限公司\n2024年度报告\n审计报告\n合并资产负债表",
    )

    result = classifier.classify_document(
        preview,
        expected_company="阳光电源股份有限公司",
        expected_ticker="300274.SZ",
    )

    assert result.company_name == "宁德时代新能源科技股份有限公司"
    assert result.company_method == "content_entity"
    assert result.classification_status == "company_conflict"


def test_taxonomy_has_exactly_three_primary_categories() -> None:
    assert classifier.DOCUMENT_TYPE_TAXONOMY["other"] == ()
    assert set(classifier.DOCUMENT_TYPE_TAXONOMY) == {
        "financial_valuation_data",
        "meeting_third_party",
        "other",
    }
    assert "dcf_model" in classifier.DOCUMENT_TYPE_TAXONOMY["financial_valuation_data"]
    assert "research_meeting" in classifier.DOCUMENT_TYPE_TAXONOMY["meeting_third_party"]
