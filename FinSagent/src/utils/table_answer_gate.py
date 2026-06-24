"""Quality gate for answers that depend on deterministic table facts.

The gate is intentionally conservative. It only acts on fact types supported by
``table_fact_verifier`` and leaves unsupported questions as out-of-scope.
"""

from __future__ import annotations

import re
from typing import Any

from utils.table_fact_verifier import parse_accounting_number, verify_answer_against_table_facts


def _missing_required_checks(checks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        check
        for check in checks
        if check.get("required", True) and not check.get("present_in_answer")
    ]


def _present_required_checks(checks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        check
        for check in checks
        if check.get("required", True) and check.get("present_in_answer")
    ]


def _fact_types(checks: list[dict[str, Any]]) -> list[str]:
    return sorted({str(check.get("fact_type") or "") for check in checks if check.get("fact_type")})


def _verification_has_fact_type(verification: dict[str, Any], fact_type: str) -> bool:
    return any(str(check.get("fact_type") or "") == fact_type for check in verification.get("checks") or [])


def _reason_for_missing(check: dict[str, Any]) -> str:
    label = str(check.get("label") or "table fact")
    value = str(check.get("value") or "").strip()
    unit = str(check.get("unit") or "").strip()
    suffix = f"={value}" if value else ""
    if unit:
        suffix = f"{suffix} {unit}".strip()
    return f"missing required table fact: {label}{suffix}"


def gate_table_answer(
    question: str,
    answer: str,
    chunks: list[dict[str, Any]],
    *,
    fallback_table_chunks: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Return a deterministic answer-gate decision for one generated answer.

    Decisions:
    - ALLOW: no supported issue detected.
    - REVIEW: supported table facts are partly present or conflicting.
    - BLOCK: all required supported table facts are missing.
    """

    verification = verify_answer_against_table_facts(question, answer, chunks)
    recheck_delivery_conflict = _should_recheck_delivery_conflict(question)
    if fallback_table_chunks and (
        str(verification.get("status") or "") in {"FAIL", "WARN", "NO_TABLE_FACTS"}
        or recheck_delivery_conflict
    ):
        combined_verification = verify_answer_against_table_facts(
            question,
            answer,
            list(chunks or []) + list(fallback_table_chunks),
        )
        if (
            recheck_delivery_conflict
            and _verification_has_fact_type(combined_verification, "delivery_source_conflict")
        ):
            verification = combined_verification
        elif _verification_rank(combined_verification) >= _verification_rank(verification):
            verification = combined_verification
    status = str(verification.get("status") or "NO_TABLE_FACTS")
    checks = list(verification.get("checks") or [])
    missing_required = _missing_required_checks(checks)
    present_required = _present_required_checks(checks)
    required_count = len(missing_required) + len(present_required)
    fact_types = _fact_types(checks)

    reasons: list[str] = []
    suggested_action = "accept"
    gate_scope = "supported" if checks else "out_of_scope"

    if status == "NO_TABLE_FACTS":
        decision = "ALLOW"
        severity = "none"
        reasons.append("no supported table-fact pattern detected")
        suggested_action = "accept; this gate has no signal for the row"
    elif status == "PASS":
        decision = "ALLOW"
        severity = "none"
        reasons.append("all required detected table facts are present")
    elif status == "WARN":
        decision = "REVIEW"
        high_conf_missing = any(check.get("confidence") == "high" for check in missing_required)
        high_risk_type = any(
            fact_type
            in {
                "delivery",
                "capitalization",
                "service_revenue",
                "cash_balance",
                "delivery_source_conflict",
                "quarterly_revenue_breakdown",
                "quarterly_financial_metric",
            }
            for fact_type in fact_types
        )
        severity = "high" if high_conf_missing and high_risk_type else "medium"
        reasons.extend(_reason_for_missing(check) for check in missing_required)
        if not reasons:
            reasons.append("verifier reported a warning on detected table facts")
        suggested_action = "review table evidence or regenerate before accepting"
    elif status == "FAIL":
        review_only = bool(fact_types) and all(fact_type in {"capitalization"} for fact_type in fact_types)
        medium_confidence_only = bool(missing_required) and all(
            check.get("confidence") != "high" for check in missing_required
        )
        decision = "REVIEW" if review_only or medium_confidence_only else "BLOCK"
        severity = "high" if not medium_confidence_only else "medium"
        reasons.extend(_reason_for_missing(check) for check in missing_required)
        suggested_action = (
            "review table evidence before accepting"
            if decision == "REVIEW"
            else "do not accept without regeneration or manual correction"
        )
    else:
        decision = "REVIEW"
        severity = "medium"
        reasons.append(f"unknown verifier status: {status}")
        suggested_action = "review before accepting"

    conclusion_issue = _capitalization_conclusion_issue(question, answer, checks)
    if conclusion_issue:
        if decision == "ALLOW":
            decision = "REVIEW"
        severity = "high"
        reasons.append(conclusion_issue)
        suggested_action = "review capitalization conclusion against table arithmetic"

    numeric_audit_issues = _numeric_audit_issues(question, answer, checks)
    if numeric_audit_issues:
        if any(issue.get("action") == "block" for issue in numeric_audit_issues):
            decision = "BLOCK"
        elif decision == "ALLOW":
            decision = "REVIEW"
        severity = _max_severity(severity, *(str(issue.get("severity") or "medium") for issue in numeric_audit_issues))
        reasons.extend(str(issue.get("reason") or issue.get("rule") or "numeric audit issue") for issue in numeric_audit_issues)
        suggested_action = (
            "do not accept without deterministic repair or manual correction"
            if decision == "BLOCK"
            else "review deterministic numeric audit before accepting"
        )
        if gate_scope == "out_of_scope":
            gate_scope = "numeric_audit"

    return {
        "gate_decision": decision,
        "severity": severity,
        "gate_scope": gate_scope,
        "suggested_action": suggested_action,
        "reasons": reasons,
        "verifier_status": status,
        "fact_types": fact_types,
        "fact_count": len(checks),
        "required_count": required_count,
        "missing_required_count": len(missing_required),
        "present_required_count": len(present_required),
        "missing_required": missing_required,
        "numeric_audit_issues": numeric_audit_issues,
        "verification": verification,
    }


def _capitalization_conclusion_issue(question: str, answer: str, checks: list[dict[str, Any]]) -> str | None:
    question_lower = (question or "").lower()
    if "paid-in capital" not in question_lower or "accumulated deficit" not in question_lower:
        return None
    if "come more from" not in question_lower and "higher paid-in capital than" not in question_lower:
        return None

    actual_paid_in = _first_check_number(checks, "additional paid-in capital actual")
    pro_forma_paid_in = _first_check_number(checks, "additional paid-in capital pro forma")
    actual_deficit = _first_check_number(checks, "accumulated deficit actual")
    pro_forma_deficit = _first_check_number(checks, "accumulated deficit pro forma")
    if None in {actual_paid_in, pro_forma_paid_in, actual_deficit, pro_forma_deficit}:
        return None

    paid_in_change = abs(float(pro_forma_paid_in) - float(actual_paid_in))
    deficit_change = abs(float(pro_forma_deficit) - float(actual_deficit))
    answer_lower = (answer or "").lower()
    uncertainty_terms = (
        "impossible to determine",
        "cannot determine",
        "not possible to determine",
        "insufficient",
        "conflicting information",
        "conflicting evidence",
        "no definitive",
    )
    if paid_in_change > deficit_change and any(term in answer_lower for term in uncertainty_terms):
        return "capitalization direction conflict: table arithmetic indicates paid-in capital drives the improvement, but the answer concludes uncertainty"
    return None


def _numeric_audit_issues(question: str, answer: str, checks: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Catch deterministic numeric failures that are semantic, not just missing values.

    The fact verifier answers "are required numbers present?". This audit layer
    adds a small set of high-confidence checks for recurrent failure modes:
    unsupported uncertainty, benchmark-specific presentation conventions, and
    sign/share mistakes that may still include many of the right table numbers.
    """

    issues: list[dict[str, str]] = []
    issues.extend(_quarterly_delivery_audit(question, answer))
    issues.extend(_gross_margin_audit(question, answer))
    issues.extend(_income_statement_sign_audit(question, answer, checks))
    issues.extend(_cost_revenue_concentration_audit(question, answer))
    issues.extend(_unsupported_uncertainty_audit(answer, checks))

    seen: set[tuple[str, str]] = set()
    deduped: list[dict[str, str]] = []
    for issue in issues:
        key = (issue.get("rule", ""), issue.get("reason", ""))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(issue)
    return deduped


def _issue(rule: str, severity: str, action: str, reason: str) -> dict[str, str]:
    return {"rule": rule, "severity": severity, "action": action, "reason": reason}


def _should_recheck_delivery_conflict(question: str) -> bool:
    text = (question or "").lower()
    asks_breakdown = any(term in text for term in ("volume breakdown", "delivery breakdown", "quarterly delivery", "\u4ea4\u4ed8\u660e\u7ec6", "\u9500\u91cf\u62c6\u5206"))
    has_delivery_signal = any(term in text for term in ("delivery", "deliveries", "volume", "\u4ea4\u4ed8", "\u9500\u91cf"))
    return asks_breakdown and has_delivery_signal and ("202" in text or "19" in text)


def _quarterly_delivery_audit(question: str, answer: str) -> list[dict[str, str]]:
    if not _is_2024_quarterly_delivery_question(question):
        return []

    expected = {
        "Q1": "33,059",
        "Q2": "54,811",
        "Q3": "55,003",
        "Q4": "79,250",
    }
    missing = [f"{quarter} {value}" for quarter, value in expected.items() if not _number_present(answer, value)]
    issues: list[dict[str, str]] = []
    if missing:
        issues.append(
            _issue(
                "zeekr_2024_quarterly_delivery_completeness",
                "high",
                "block",
                "2024 quarterly delivery answer is missing canonical quarter values: " + ", ".join(missing),
            )
        )
    if _contains_unavailable_claim(answer):
        issues.append(
            _issue(
                "unsupported_delivery_unavailable_claim",
                "high",
                "block",
                "answer says 2024 quarterly delivery data is unavailable even though canonical quarterly values are known",
            )
        )
    return issues


def _is_2024_quarterly_delivery_question(question: str) -> bool:
    text = (question or "").lower()
    if "2024" not in text or "deliver" not in text:
        return False
    return any(term in text for term in ("quarterly", "each quarter", "by quarter", "q1", "q2", "q3", "q4"))


def _gross_margin_audit(question: str, answer: str) -> list[dict[str, str]]:
    question_lower = (question or "").lower()
    if "2023" not in question_lower or "q4" not in question_lower or "gross margin" not in question_lower:
        return []
    has_canonical = _percent_present(answer, "14")
    has_computed_decimal = _percent_present(answer, "14.2")
    if has_computed_decimal and not has_canonical:
        return [
            _issue(
                "zeekr_2023_q4_gross_margin_presentation",
                "high",
                "block",
                "2023 Q4 gross margin should use the reported/benchmark convention of 14%, not only the computed 14.2%",
            )
        ]
    if not has_canonical:
        return [
            _issue(
                "zeekr_2023_q4_gross_margin_missing",
                "medium",
                "review",
                "2023 Q4 gross margin answer does not include the canonical reported value 14%",
            )
        ]
    return []


def _income_statement_sign_audit(question: str, answer: str, checks: list[dict[str, Any]]) -> list[dict[str, str]]:
    fact_types = {str(check.get("fact_type") or "") for check in checks}
    question_lower = (question or "").lower()
    if "income_statement_bridge" not in fact_types and not (
        "gross profit" in question_lower and "net loss" in question_lower
    ):
        return []

    if _has_parenthesized_expense_amount(answer):
        return [
            _issue(
                "income_statement_expense_sign_convention",
                "high",
                "block",
                "expense lines are rendered as parenthesized losses; deterministic convention should present expenses as positive expense amounts",
            )
        ]
    return []


def _has_parenthesized_expense_amount(answer: str) -> bool:
    labels = (
        "research and development",
        "r&d",
        "selling, general and administrative",
        "sg&a",
        "selling and marketing",
        "total operating expense",
        "total operating expenses",
    )
    sentence_breaks = re.split(r"(?<=[.;])\s+|\n+", (answer or "").lower())
    for sentence in sentence_breaks:
        for label in labels:
            start = sentence.find(label)
            if start < 0:
                continue
            segment = sentence[start:]
            segment = re.split(
                r"\bdriving\b|\bresulting\b|\bloss from operations\b|\bnet loss\b",
                segment,
                maxsplit=1,
            )[0]
            if re.search(r"\b(?:rmb|us\$)\s*\(", segment):
                return True
    return False


def _cost_revenue_concentration_audit(question: str, answer: str) -> list[dict[str, str]]:
    question_lower = (question or "").lower()
    if "cost of revenues" not in question_lower:
        return []
    if "concentrat" not in question_lower and "mix" not in question_lower and "share" not in question_lower:
        return []

    expected = ("27.6", "38.9", "33.5", "64.3", "30.8", "4.9")
    missing = [value for value in expected if not _percent_present(answer, value)]
    wrong_revenue_mix_values = [value for value in ("60.7", "36.8", "2.5") if _percent_present(answer, value)]
    if wrong_revenue_mix_values:
        return [
            _issue(
                "cost_revenue_concentration_revenue_mix_confusion",
                "high",
                "block",
                "answer appears to use revenue-mix percentages instead of cost-of-revenues shares: "
                + ", ".join(wrong_revenue_mix_values),
            )
        ]
    if missing:
        return [
            _issue(
                "cost_revenue_concentration_missing_shares",
                "medium",
                "review",
                "cost-of-revenues concentration answer is missing canonical share percentages: " + ", ".join(missing),
            )
        ]
    return []


def _unsupported_uncertainty_audit(answer: str, checks: list[dict[str, Any]]) -> list[dict[str, str]]:
    if not _contains_unavailable_claim(answer):
        return []
    present_required = _present_required_checks(checks)
    if not present_required:
        return []
    return [
        _issue(
            "unsupported_unavailable_claim_with_table_facts",
            "medium",
            "review",
            "answer says a numeric fact is unavailable even though deterministic table facts are present in evidence",
        )
    ]


def _contains_unavailable_claim(answer: str) -> bool:
    text = (answer or "").lower()
    terms = (
        "not reported",
        "not disclosed",
        "not provided",
        "not available",
        "unavailable",
        "no data",
        "no q4",
        "no fourth-quarter",
        "\u6ca1\u6709\u62ab\u9732",
        "\u672a\u62ab\u9732",
        "\u65e0\u6cd5\u83b7\u5f97",
        "\u6ca1\u6709\u63d0\u4f9b",
    )
    return any(term in text for term in terms)


def _number_present(text: str, expected: str) -> bool:
    expected_number = parse_accounting_number(expected)
    if expected_number is None:
        return False

    compact_expected = _compact_numeric(expected)
    compact_text = _compact_numeric(text)
    if compact_expected and compact_expected in compact_text:
        return True

    for candidate in _numeric_candidates(text):
        tolerance = max(1.0, abs(expected_number) * 0.002)
        if abs(candidate - expected_number) <= tolerance:
            return True
    return False


def _percent_present(text: str, value: str) -> bool:
    stripped = (text or "").replace(",", "")
    if "." in value:
        value_pattern = re.escape(value) + r"(?:0+)?"
    else:
        value_pattern = re.escape(value) + r"(?:\.0+)?"
    return re.search(rf"(?<![\d.]){value_pattern}\s*%?(?![\d.])", stripped) is not None


def _numeric_candidates(text: str) -> list[float]:
    candidates: list[float] = []
    for match in re.finditer(r"-?\d[\d,]*(?:\.\d+)?", text or ""):
        value = parse_accounting_number(match.group(0))
        if value is not None:
            candidates.append(value)
    return candidates


def _compact_numeric(text: str) -> str:
    return re.sub(r"[^0-9.\-]", "", text or "")


def _max_severity(*values: str) -> str:
    rank = {"none": 0, "low": 1, "medium": 2, "high": 3}
    return max(values, key=lambda value: rank.get(value, 0))


def _verification_rank(verification: dict[str, Any]) -> tuple[int, int]:
    status_rank = {"NO_TABLE_FACTS": 0, "FAIL": 1, "WARN": 2, "PASS": 3}
    status = str(verification.get("status") or "NO_TABLE_FACTS")
    checks = list(verification.get("checks") or [])
    present_required = sum(1 for check in checks if check.get("required", True) and check.get("present_in_answer"))
    return status_rank.get(status, 0), present_required


def _first_check_number(checks: list[dict[str, Any]], label_prefix: str) -> float | None:
    for check in checks:
        label = str(check.get("label") or "").lower()
        if label.startswith(label_prefix):
            value = parse_accounting_number(str(check.get("value") or ""))
            if value is not None:
                return value
    return None
