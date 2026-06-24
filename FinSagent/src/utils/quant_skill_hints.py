"""Lightweight financial-calculation skill hints.

These hints are intentionally not a fact source. They only describe the
calculation/normalization skill that should be considered after evidence has
already been retrieved from filings or verified table facts.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class QuantSkillHint:
    skill_id: str
    category: str
    formula: str
    use_when: str
    pitfalls: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


QUANT_SKILL_HINTS: tuple[QuantSkillHint, ...] = (
    QuantSkillHint(
        skill_id="yoy_growth",
        category="growth_metrics",
        formula="(current_period_value - prior_year_same_period_value) / prior_year_same_period_value",
        use_when="A question asks for, or a benchmark expects, year-over-year change for the same fiscal period.",
        pitfalls=(
            "Compare to the same fiscal quarter or year, not the immediately preceding period.",
            "Avoid growth calculations when the base is zero or sign-flipped unless the answer states the caveat.",
        ),
    ),
    QuantSkillHint(
        skill_id="qoq_growth",
        category="growth_metrics",
        formula="(current_quarter_value - previous_quarter_value) / previous_quarter_value",
        use_when="A quarterly question needs sequential quarter-over-quarter context.",
        pitfalls=(
            "Do not confuse quarter-over-quarter growth with year-over-year growth.",
            "Seasonality can make QoQ changes less comparable than YoY changes.",
        ),
    ),
    QuantSkillHint(
        skill_id="gross_margin",
        category="profitability_metrics",
        formula="gross_profit / revenue",
        use_when="A question asks for gross margin or gross-profitability level.",
        pitfalls=(
            "Prefer a company-disclosed gross margin when present.",
            "Do not answer gross profit amount with only a gross margin percentage.",
        ),
    ),
    QuantSkillHint(
        skill_id="unit_conversion",
        category="time_and_unit_normalization_rules",
        formula="billions * 1000 = millions; millions / 1000 = billions",
        use_when="A table or answer mixes RMB thousands, RMB millions, RMB yi, US$ thousands, or US$ millions.",
        pitfalls=(
            "Confirm the source unit before converting.",
            "State rounded conversions when the reporting unit changes.",
        ),
    ),
)


def select_quant_skill_hints(question: str, *, max_hints: int = 3) -> list[dict[str, Any]]:
    text = (question or "").lower()
    selected: list[QuantSkillHint] = []

    if any(term in text for term in ("yoy", "year-over-year", "year over year", "同比")):
        selected.append(_hint("yoy_growth"))
    if any(term in text for term in ("qoq", "quarter-over-quarter", "quarter over quarter", "环比")):
        selected.append(_hint("qoq_growth"))
    if any(term in text for term in ("quarter", "q1", "q2", "q3", "q4", "季度", "一季度", "二季度", "三季度", "四季度")):
        selected.extend([_hint("yoy_growth"), _hint("qoq_growth")])
    if any(term in text for term in ("gross margin", "毛利率", "毛利水平")):
        selected.append(_hint("gross_margin"))
    if any(term in text for term in ("million", "billion", "thousand", "亿元", "百万", "千万", "us$", "美元", "人民币")):
        selected.append(_hint("unit_conversion"))

    deduped: list[QuantSkillHint] = []
    seen: set[str] = set()
    for item in selected:
        if item.skill_id in seen:
            continue
        seen.add(item.skill_id)
        deduped.append(item)
        if len(deduped) >= max_hints:
            break
    return [item.to_dict() for item in deduped]


def _hint(skill_id: str) -> QuantSkillHint:
    for hint in QUANT_SKILL_HINTS:
        if hint.skill_id == skill_id:
            return hint
    raise KeyError(skill_id)
