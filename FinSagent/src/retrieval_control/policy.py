"""Deterministic initial policy for retaining DCI and deciding RAG execution."""

from __future__ import annotations

import re
from typing import Any

from retrieval_control.models import RetrievalPolicy


_REPORT_PATTERNS = (
    r"研报", r"研究报告", r"投资报告", r"投资备忘录", r"备忘录", r"尽调",
    r"公司分析", r"行业分析", r"估值报告", r"深度报告", r"完整报告",
    r"research\s+report", r"investment\s+memo", r"due\s+diligence",
    r"equity\s+research", r"initiation\s+report", r"company\s+report",
)

_ANALYSIS_PATTERNS = (
    r"投资逻辑", r"核心逻辑", r"风险", r"催化剂", r"原因", r"为什么",
    r"趋势", r"展望", r"竞争格局", r"商业模式", r"管理层", r"战略",
    r"综合分析", r"对比分析", r"估值分析", r"盈利能力分析",
    r"investment\s+thesis", r"risk\s+analysis", r"outlook", r"trend",
    r"competitive\s+landscape", r"business\s+model", r"management\s+commentary",
    r"why\b", r"drivers?\b", r"analy[sz]e", r"analysis\b",
)

_CALCULATION_PATTERNS = (
    r"同比", r"环比", r"百分点", r"增长率", r"变化率", r"占比", r"计算",
    r"yoy", r"qoq", r"percentage\s+points?", r"growth\s+rate", r"calculate",
)

_EXPLICIT_TABLE_PATTERNS = (
    r"excel", r"表格", r"单元格", r"工作表", r"sheet\b", r"cell\b",
)


def classify_query_type(question: str) -> str:
    text = str(question or "").casefold()
    if _matches_any(text, _REPORT_PATTERNS):
        return "research_report"
    if _matches_any(text, _ANALYSIS_PATTERNS):
        return "analysis"
    if _matches_any(text, _CALCULATION_PATTERNS):
        return "financial_calculation"
    return "single_fact"


def decide_retrieval_policy(
    *,
    original_question: str,
    agent: str,
    metric_result: dict[str, Any] | None,
    keyword_result: dict[str, Any] | None,
    mode: str,
) -> RetrievalPolicy:
    """Retain every DCI hit; confidence only controls whether RAG must also run."""
    query_type = classify_query_type(original_question)
    metric_high_confidence = bool(metric_result and metric_result.get("high_confidence"))
    metric_hit = bool(metric_result and metric_result.get("chunks"))
    keyword_hit = bool(keyword_result and keyword_result.get("chunks"))

    if mode == "dci_only":
        return RetrievalPolicy(
            mode=mode,
            query_type=query_type,
            run_rag=False,
            reason_codes=("DCI_ONLY",),
        )

    if mode != "evidence_fusion":
        return RetrievalPolicy(
            mode=mode,
            query_type=query_type,
            run_rag=not metric_high_confidence,
            reason_codes=("LEGACY_MODE",),
        )

    if query_type == "research_report":
        return RetrievalPolicy(
            mode=mode,
            query_type=query_type,
            run_rag=True,
            rag_required=True,
            require_table_evidence=metric_hit,
            require_text_evidence=True,
            reason_codes=("REPORT_REQUIRES_RAG",),
        )

    if query_type == "analysis":
        return RetrievalPolicy(
            mode=mode,
            query_type=query_type,
            run_rag=True,
            rag_required=True,
            require_text_evidence=True,
            reason_codes=("ANALYSIS_REQUIRES_RAG",),
        )

    if query_type == "financial_calculation":
        return RetrievalPolicy(
            mode=mode,
            query_type=query_type,
            # A single high-confidence metric hit does not prove that every
            # calculation operand is present and comparable. Until an explicit
            # operand-completeness contract is available, supplement with RAG.
            run_rag=True,
            require_table_evidence=True,
            reason_codes=("CALCULATION_OPERANDS_NOT_CONFIRMED",),
        )

    if _matches_any(str(original_question or "").casefold(), _EXPLICIT_TABLE_PATTERNS):
        return RetrievalPolicy(
            mode=mode,
            query_type=query_type,
            run_rag=True,
            require_table_evidence=True,
            reason_codes=("EXPLICIT_TABLE_EVIDENCE_REQUEST",),
        )

    if metric_high_confidence:
        return RetrievalPolicy(
            mode=mode,
            query_type=query_type,
            run_rag=False,
            reason_codes=("HIGH_CONFIDENCE_DCI_SINGLE_FACT",),
        )

    reasons: list[str] = []
    if metric_hit:
        reasons.append("LOW_CONFIDENCE_DCI_RETAINED")
    else:
        reasons.append("NO_METRIC_DCI")
    if keyword_hit:
        reasons.append("KEYWORD_EVIDENCE_RETAINED")
    return RetrievalPolicy(
        mode=mode,
        query_type=query_type,
        run_rag=True,
        reason_codes=tuple(reasons),
    )


def _matches_any(text: str, patterns: tuple[str, ...]) -> bool:
    return any(re.search(pattern, text, flags=re.IGNORECASE) for pattern in patterns)
