from retrieval_control.policy import classify_query_type, decide_retrieval_policy


def _metric(*, high_confidence: bool) -> dict:
    return {
        "type": "dci_metric",
        "high_confidence": high_confidence,
        "chunks": [{"page_content": "net profit", "metadata": {}}],
    }


def test_high_confidence_single_fact_can_skip_rag() -> None:
    policy = decide_retrieval_policy(
        original_question="保时捷 2024 年归母净利润是多少？",
        agent="quant",
        metric_result=_metric(high_confidence=True),
        keyword_result=None,
        mode="evidence_fusion",
    )

    assert policy.query_type == "single_fact"
    assert policy.run_rag is False
    assert policy.retain_metric_dci is True


def test_low_confidence_dci_is_retained_and_triggers_rag() -> None:
    policy = decide_retrieval_policy(
        original_question="保时捷 2024 年归母净利润是多少？",
        agent="quant",
        metric_result=_metric(high_confidence=False),
        keyword_result={"chunks": [{"page_content": "profit", "metadata": {}}]},
        mode="evidence_fusion",
    )

    assert policy.run_rag is True
    assert policy.retain_metric_dci is True
    assert policy.retain_keyword_dci is True
    assert "LOW_CONFIDENCE_DCI_RETAINED" in policy.reason_codes


def test_report_always_requires_rag_even_with_high_confidence_dci() -> None:
    policy = decide_retrieval_policy(
        original_question="基于现有数据生成一份保时捷深度研报",
        agent="market_researcher",
        metric_result=_metric(high_confidence=True),
        keyword_result=None,
        mode="evidence_fusion",
    )

    assert policy.query_type == "research_report"
    assert policy.run_rag is True
    assert policy.rag_required is True
    assert policy.require_text_evidence is True


def test_analysis_requires_rag() -> None:
    assert classify_query_type("分析保时捷盈利能力和主要风险") == "analysis"


def test_calculation_supplements_even_high_confidence_single_metric() -> None:
    policy = decide_retrieval_policy(
        original_question="保时捷 2024 年净利润同比增长率是多少？",
        agent="quant",
        metric_result=_metric(high_confidence=True),
        keyword_result=None,
        mode="evidence_fusion",
    )

    assert policy.query_type == "financial_calculation"
    assert policy.run_rag is True
    assert policy.require_table_evidence is True


def test_dci_only_retains_evidence_without_rag() -> None:
    policy = decide_retrieval_policy(
        original_question="保时捷净利润",
        agent="quant",
        metric_result=_metric(high_confidence=False),
        keyword_result=None,
        mode="dci_only",
    )

    assert policy.run_rag is False
    assert policy.retain_metric_dci is True
