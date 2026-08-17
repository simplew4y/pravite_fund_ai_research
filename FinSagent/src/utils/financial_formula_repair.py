"""Deterministic repairs for evidence-backed financial formula questions."""

from __future__ import annotations

import math
import re
from typing import Any, Iterable


def _norm(value: Any) -> str:
    return re.sub(r"[^0-9a-z]+", "", str(value or "").casefold())


def _question_period(question: str) -> str:
    match = re.search(r"(?:19|20)\d{2}E|[1-4]Q\d{2}|(?:19|20)\d{2}", question, re.I)
    return match.group(0).casefold() if match else ""


def _period_matches(requested: str, actual: Any) -> bool:
    actual_norm = str(actual or "").casefold().replace(" ", "")
    if not requested:
        return True
    return actual_norm == requested or actual_norm == requested.removesuffix("e")


def _number(fact: dict[str, Any]) -> float | None:
    for key in ("value", "value_numeric"):
        try:
            value = float(fact.get(key))
        except (TypeError, ValueError):
            continue
        if math.isfinite(value):
            return value
    return None


def _pick(
    facts: Iterable[dict[str, Any]],
    names: set[str],
    period: str,
) -> tuple[float, dict[str, Any]] | None:
    ranked: list[tuple[int, float, dict[str, Any]]] = []
    for fact in facts:
        name = _norm(fact.get("metric_name") or fact.get("metric") or fact.get("metric_id"))
        if name not in names:
            continue
        value = _number(fact)
        if value is None:
            continue
        actual_period = fact.get("period")
        if not _period_matches(period, actual_period):
            continue
        rank = 2 if str(actual_period or "").casefold() == period else 1
        ranked.append((rank, value, fact))
    if not ranked:
        return None
    if not period:
        distinct_periods = {
            str(item[2].get("period") or "").casefold().replace(" ", "")
            for item in ranked
            if item[2].get("period")
        }
        if len(distinct_periods) != 1:
            return None
    ranked.sort(key=lambda item: item[0], reverse=True)
    _, value, fact = ranked[0]
    return value, fact


def _source(fact: dict[str, Any]) -> str:
    return str(fact.get("source_ref") or "").strip()


def _result(answer: str, formula: str, variables: dict[str, float], facts: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "repair_applied": True,
        "repair_reason": "DETERMINISTIC_FINANCIAL_FORMULA",
        "answer": answer,
        "formula": formula,
        "variables": variables,
        "source_refs": [_source(fact) for fact in facts if _source(fact)],
    }


def repair_financial_formula_answer(
    question: str,
    answer: str,
    metric_facts: list[dict[str, Any]],
) -> dict[str, Any]:
    """Repair only recognized formulas with complete same-period operands."""
    text = str(question or "")
    lowered = text.casefold()
    period = _question_period(text)

    direct_cost_request = (
        any(term in text for term in ("营业成本", "主营业务成本"))
        or "cost of revenue" in lowered
    ) and not any(
        term in lowered
        for term in (
            "毛利", "gross profit", "gross margin", "营业利润", "operating profit",
            "净利润", "net income", "自由现金流", "free cash flow", "同比", "环比",
            "增速", "增长率", "占比", "成本率", "yoy", "qoq", "growth rate",
        )
    )
    if direct_cost_request:
        cost = _pick(metric_facts, {"cogsind", "costofgoodssold", "costofrevenue"}, period)
        if cost:
            value = abs(cost[0])
            rendered = (
                f"{period.upper()}营业成本为{value:,.2f} CNYm（百万元人民币）。"
                f"按指标展示口径取成本绝对额；模型单元格原始列示值为{cost[0]:,.2f} CNYm。"
            )
            return _result(rendered, "abs(COGS_IND)", {"COGS_IND": cost[0]}, [cost[1]])

    if "自由现金流" in text or "free cash flow" in lowered:
        ocf = _pick(metric_facts, {"cfopind", "netcashfromoperatingactivities"}, period)
        capex = _pick(metric_facts, {"capexind", "purchaseofppe", "totalcapexcny m".replace(" ", "")}, period)
        if ocf and capex:
            value = ocf[0] - abs(capex[0])
            rendered = (
                f"按正式评测口径，自由现金流 = 经营活动现金流 - 资本开支绝对值。"
                f"{period.upper()}经营活动现金流为{ocf[0]:,.2f} CNYm，资本开支绝对值为{abs(capex[0]):,.2f} CNYm，"
                f"因此自由现金流为{value:,.2f} CNYm。"
            )
            return _result(rendered, "CF_OP_IND-abs(CAPEX_IND)", {"CF_OP_IND": ocf[0], "CAPEX_IND": capex[0]}, [ocf[1], capex[1]])

    price_match = re.search(r"(?:当前价|股价)\s*([0-9]+(?:\.[0-9]+)?)", text, re.I)
    price = float(price_match.group(1)) if price_match else None
    if price is not None and ("trailing pe" in lowered or "当前价/" in text and "eps" in lowered):
        eps = _pick(metric_facts, {"epsrpind", "epsreported", "basicepscnyshare", "basiceps"}, period)
        if eps and eps[0] != 0:
            value = price / eps[0]
            rendered = f"Trailing PE = 当前价 / EPS = {price:.2f} / {eps[0]:.10g} = {value:.2f}倍。"
            return _result(rendered, "price/EPS", {"price": price, "EPS": eps[0]}, [eps[1]])

    if price is not None and any(term in lowered for term in ("pb市净率", "市净率", "bvps")):
        bps = _pick(metric_facts, {"bps", "bvps", "bookvaluepershare"}, period)
        if bps and bps[0] != 0:
            value = price / bps[0]
            rendered = f"PB = 当前价 / BVPS = {price:.2f} / {bps[0]:.10g} = {value:.2f}倍。"
            return _result(rendered, "price/BVPS", {"price": price, "BVPS": bps[0]}, [bps[1]])

    if price is not None and ("总市值" in text or "市值" in text):
        # Monetary "share capital" rows are not share counts. Only accept
        # canonical outstanding-share metrics whose values are in millions.
        shares = _pick(metric_facts, {"numsh1", "sharesoutstanding"}, period)
        if shares:
            value_m = price * shares[0]
            value_yi = value_m / 100.0
            rendered = (
                f"总市值 = 股价 × 总股本 = {price:.2f}元/股 × {shares[0]:,.6f}百万股 "
                f"= {value_m:,.2f} CNYm，即{value_yi:,.2f}亿元人民币。"
            )
            return _result(rendered, "price*shares", {"price": price, "shares_million": shares[0]}, [shares[1]])

    return {
        "repair_applied": False,
        "repair_reason": "UNSUPPORTED_OR_MISSING_OPERANDS",
        "answer": answer,
    }
