from core.AgenticRAG import (
    _has_explicit_year,
    _is_finance_domain_question,
    _is_nonlegal_version_comparison,
)


def test_quarter_shorthand_counts_as_explicit_period() -> None:
    assert _has_explicit_year("阳光电源1Q24和1Q23单季营业收入") is True
    assert _has_explicit_year("compare Q1-2024 revenue") is True


def test_financial_question_for_unlisted_company_is_in_domain() -> None:
    assert _is_finance_domain_question("阳光电源剔除阶段性影响后的实际毛利率是多少") is True
    assert _is_finance_domain_question("今天天气怎么样") is False


def test_business_draft_comparison_is_not_misclassified_as_legal() -> None:
    assert _is_nonlegal_version_comparison("对比初稿与修订版的SST批量销售时间") is True
    assert _is_nonlegal_version_comparison("对比合同初稿与修订版的违约条款") is False
