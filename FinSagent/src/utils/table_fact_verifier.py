"""Deterministic checks for table-derived QA facts.

This module is deliberately lightweight. It does not try to replace the LLM;
it extracts a small set of high-risk table facts and verifies whether the final
answer preserves those exact numbers.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, asdict
from html.parser import HTMLParser
from typing import Any, Iterable


class HTMLTableRowsParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.rows: list[list[str]] = []
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "tr":
            self._row = []
        elif tag in {"td", "th"} and self._row is not None:
            self._cell = []
        elif tag == "br" and self._cell is not None:
            self._cell.append(" ")

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"td", "th"} and self._row is not None and self._cell is not None:
            self._row.append(" ".join("".join(self._cell).split()))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if any(cell for cell in self._row):
                self.rows.append(self._row)
            self._row = None


@dataclass
class TableFact:
    fact_type: str
    label: str
    value: str
    unit: str = ""
    source: str = ""
    page: Any = None
    confidence: str = "high"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def parse_table_rows(html: str) -> list[list[str]]:
    parser = HTMLTableRowsParser()
    parser.feed(html or "")
    return parser.rows


def normalize_number_text(value: str) -> str:
    return re.sub(r"[^0-9.\-]", "", value or "")


def parse_accounting_number(value: str) -> float | None:
    text = (value or "").replace(",", "").replace("\u2014", "").strip()
    if not text or text in {"-", "--"}:
        return None
    negative = text.startswith("(") and text.endswith(")")
    text = text.strip("()")
    match = re.search(r"-?\d+(?:\.\d+)?", text)
    if not match:
        return None
    parsed = float(match.group(0))
    return -parsed if negative else parsed


def _answer_number_candidates(answer: str, fact_unit: str) -> list[float]:
    """Extract numeric candidates in the same rough unit as the table fact.

    Table facts from SEC tables are often in thousands, while generated
    answers may say "RMB 3,068 million", "RMB 3.068 billion", or "30.68亿元".
    This helper keeps exact matching as the primary path and only adds obvious
    scale conversions for thousand-unit facts.
    """

    candidates: list[float] = []
    text = answer or ""
    unit_lower = (fact_unit or "").lower()
    for match in re.finditer(r"-?\d[\d,]*(?:\.\d+)?", text):
        raw = match.group(0)
        value = parse_accounting_number(raw)
        if value is None:
            continue
        prefix = text[max(0, match.start() - 4) : match.start()]
        suffix = text[match.end() : match.end() + 4]
        if "(" in prefix and ")" in suffix:
            value = -abs(value)
        candidates.append(value)
        if "thousands" in unit_lower:
            following_for_units = text[match.end() : match.end() + 24].lower()
            if "\u4ebf" in following_for_units[:8]:
                candidates.append(value * 100000.0)
            if "\u767e\u4e07" in following_for_units:
                candidates.append(value * 1000.0)
            if "\u4e07" in following_for_units[:8] and "\u4ebf" not in following_for_units[:8]:
                candidates.append(value * 10.0)
        if "thousands" not in unit_lower:
            following = text[match.end() : match.end() + 24].lower()
            if "million" in unit_lower:
                if "\u4ebf" in following[:8] or "äº¿" in following[:4]:
                    candidates.append(value * 100.0)
                if "billion" in following:
                    candidates.append(value * 1000.0)
            continue
        following = text[match.end() : match.end() + 24].lower()
        if "亿元" in following or "亿" in following[:4]:
            candidates.append(value * 100000.0)
        if "million" in following or "百万元" in following:
            candidates.append(value * 1000.0)
        if "billion" in following:
            candidates.append(value * 1000000.0)
    return candidates


def _fact_value_present_in_answer(fact: "TableFact", answer: str) -> bool:
    expected_number = parse_accounting_number(fact.value)
    if (fact.unit or "").strip() == "%" and expected_number is not None:
        return _percent_fact_value_present(answer, expected_number)

    expected = normalize_number_text(fact.value)
    answer_compact = normalize_number_text(answer)
    if expected and expected in answer_compact:
        return True

    if expected_number is None:
        return False
    for candidate in _answer_number_candidates(answer, fact.unit):
        tolerance = max(1.0, abs(expected_number) * 0.002)
        if abs(candidate - expected_number) <= tolerance:
            return True
    return False


def _percent_fact_value_present(answer: str, expected_number: float) -> bool:
    for match in re.finditer(r"-?\d[\d,]*(?:\.\d+)?", answer or ""):
        candidate = parse_accounting_number(match.group(0))
        if candidate is None:
            continue
        tolerance = max(0.05, abs(expected_number) * 0.002)
        if abs(candidate - expected_number) <= tolerance:
            return True
    return False


def _table_chunks(chunks: Iterable[dict[str, Any]]) -> Iterable[dict[str, Any]]:
    for chunk in chunks or []:
        metadata = chunk.get("metadata") or {}
        content = chunk.get("page_content", "") or ""
        looks_like_table = "<table" in content.lower() or "<tr" in content.lower()
        if (
            chunk.get("retriever") == "Table"
            or metadata.get("content_type") == "table"
            or metadata.get("table_index") is not None
            or looks_like_table
        ):
            yield chunk


def _row_by_label(rows: list[list[str]], *labels: str) -> list[str] | None:
    needles = tuple(label.lower() for label in labels)
    for row in rows:
        if row and any(needle in row[0].lower() for needle in needles):
            return row
    return None


def _question_years(question: str) -> list[int]:
    return sorted({int(year) for year in re.findall(r"(20\d{2}|19\d{2})", question or "")})


def _question_quarters(question: str) -> set[str]:
    text = (question or "").lower()
    quarters = set()
    aliases = {
        "Q1": ("q1", "first quarter", "1st quarter", "\u4e00\u5b63\u5ea6"),
        "Q2": ("q2", "second quarter", "2nd quarter", "\u4e8c\u5b63\u5ea6"),
        "Q3": ("q3", "third quarter", "3rd quarter", "\u4e09\u5b63\u5ea6"),
        "Q4": ("q4", "fourth quarter", "4th quarter", "\u56db\u5b63\u5ea6"),
    }
    for quarter, patterns in aliases.items():
        if any(pattern in text for pattern in patterns):
            quarters.add(quarter)
    return quarters


def _is_numeric_fact_value(value: str) -> bool:
    text = (value or "").strip()
    if not text:
        return False
    if re.search(r"[A-Za-z]", text) and not re.search(r"[%(),.\d]", text):
        return False
    if re.search(r"\bQ[1-4]\b", text, flags=re.IGNORECASE):
        return False
    return parse_accounting_number(text) is not None


def _is_estimated_range_value(value: str) -> bool:
    text = (value or "").strip()
    if not text:
        return False
    if "~" in text or "\u223c" in text:
        return True
    return bool(re.search(r"\d\s*[\u2012\u2013\u2014-]\s*\d", text))


def _cell_matches_period(cell: str, target_year: int | None, quarters: set[str]) -> bool:
    compact = (cell or "").lower().replace(" ", "")
    if target_year and str(target_year) not in compact:
        return False
    if quarters:
        quarter_aliases = {
            "Q1": ("q1", "firstquarter", "1stquarter", "march31"),
            "Q2": ("q2", "secondquarter", "2ndquarter", "june30"),
            "Q3": ("q3", "thirdquarter", "3rdquarter", "september30"),
            "Q4": ("q4", "fourthquarter", "4thquarter", "december31"),
        }
        return any(any(alias in compact for alias in quarter_aliases[quarter]) for quarter in quarters)
    return target_year is None or str(target_year) in compact


def _period_indices(rows: list[list[str]], target_year: int | None, quarters: set[str]) -> list[int]:
    indices: list[int] = []
    if target_year is None and not quarters:
        return indices
    for row in rows[:4]:
        for idx, cell in enumerate(row):
            if idx == 0:
                continue
            if _cell_matches_period(cell, target_year, quarters):
                indices.append(idx)
    return list(dict.fromkeys(indices))


def _asks_annual(question: str) -> bool:
    text = (question or "").lower()
    return any(term in text for term in ("full year", "full-year", "fy", "annual", "yearly", "\u5168\u5e74", "\u5e74\u5ea6"))


def _cell_matches_annual(cell: str, target_year: int | None) -> bool:
    if target_year is None:
        return False
    compact = (cell or "").lower().replace(" ", "")
    if str(target_year) not in compact:
        return False
    if re.search(r"q[1-4]", compact):
        return False
    return "fy" in compact or "fullyear" in compact or compact == str(target_year)


def _source(chunk: dict[str, Any]) -> tuple[str, Any]:
    metadata = chunk.get("metadata") or {}
    return str(metadata.get("source_file") or metadata.get("doc_id") or ""), metadata.get("page_idx")


def detect_table_facts(question: str, chunks: list[dict[str, Any]]) -> list[TableFact]:
    question_lower = (question or "").lower()
    facts: list[TableFact] = []
    if _asks_delivery_volume(question_lower):
        delivery_facts = _detect_delivery_facts(question, chunks)
        conflict_facts: list[TableFact] = []
        if _asks_delivery_source_conflict(question_lower):
            conflict_facts = _detect_delivery_source_conflict_facts(question, chunks)
        if conflict_facts:
            delivery_facts = _delivery_facts_for_source_conflict(delivery_facts)
        facts.extend(delivery_facts)
        facts.extend(conflict_facts)
    if any(term in question_lower for term in ("capitalization", "paid-in capital", "accumulated deficit", "pro forma", "liabilities", "net worth")):
        facts.extend(_detect_capitalization_facts(question, chunks))
    if any(term in question_lower for term in ("gross margin", "\u6bdb\u5229\u7387")):
        facts.extend(_detect_gross_margin_facts(question, chunks))
    if _asks_service_revenue(question_lower):
        facts.extend(_detect_service_revenue_facts(question, chunks))
    if _asks_income_statement_bridge(question_lower):
        facts.extend(_detect_income_statement_bridge_facts(question, chunks))
    if _asks_revenue_stream(question_lower):
        facts.extend(_detect_revenue_stream_facts(question, chunks))
    if _asks_quarterly_revenue_breakdown(question_lower):
        facts.extend(_detect_quarterly_revenue_breakdown_facts(question, chunks))
    if _asks_quarterly_financial_metric(question_lower):
        facts.extend(_detect_quarterly_financial_metric_facts(question, chunks))
    if _asks_cost_of_revenues_mix(question_lower):
        facts.extend(_detect_cost_revenue_mix_facts(question, chunks))
    if _asks_rd_expense_mix(question_lower):
        facts.extend(_detect_rd_expense_mix_facts(question, chunks))
    if _asks_revenue_contribution(question_lower):
        facts.extend(_detect_revenue_contribution_facts(question, chunks))
    if any(term in question_lower for term in ("working capital", "working-capital", "current assets", "current liabilities")):
        facts.extend(_detect_working_capital_facts(question, chunks))
    if _asks_cash_balance(question_lower):
        facts.extend(_detect_cash_balance_facts(question, chunks))
    return facts


def _asks_service_revenue(question_lower: str) -> bool:
    has_service = any(term in question_lower for term in ("service", "services", "\u670d\u52a1"))
    has_revenue = any(term in question_lower for term in ("revenue", "revenues", "income", "\u6536\u5165", "\u8425\u6536"))
    return has_service and has_revenue


def _asks_cash_balance(question_lower: str) -> bool:
    has_cash = any(term in question_lower for term in ("cash", "\u73b0\u91d1"))
    if not has_cash:
        return False
    if any(term in question_lower for term in ("cash flow", "cash flows", "\u73b0\u91d1\u6d41")):
        return False
    return any(
        term in question_lower
        for term in (
            "balance",
            "cash equivalents",
            "restricted cash",
            "\u4f59\u989d",
            "\u7b49\u4ef7\u7269",
            "\u53d7\u9650\u73b0\u91d1",
        )
    )


def _asks_income_statement_bridge(question_lower: str) -> bool:
    has_profit_loss = "gross profit" in question_lower and "net loss" in question_lower
    has_cost_driver = any(term in question_lower for term in ("operating expense", "cost structure", "r&d", "sg&a", "widen"))
    return has_profit_loss and has_cost_driver


def _asks_revenue_stream(question_lower: str) -> bool:
    return any(term in question_lower for term in ("revenue stream", "revenue streams", "revenue mix"))


def _asks_delivery_volume(question_lower: str) -> bool:
    direct = any(term in question_lower for term in ("deliveries", "delivery", "\u9500\u91cf", "\u4ea4\u4ed8"))
    volume_breakdown = "volume" in question_lower and any(
        term in question_lower for term in ("breakdown", "monthly", "quarterly", "year", "202")
    )
    return direct or volume_breakdown


def _asks_delivery_source_conflict(question_lower: str) -> bool:
    asks_breakdown = any(term in question_lower for term in ("breakdown", "quarterly", "volume", "\u62c6\u5206", "\u660e\u7ec6"))
    asks_delivery = _asks_delivery_volume(question_lower)
    return asks_delivery and asks_breakdown and ("202" in question_lower or "19" in question_lower)


def _delivery_facts_for_source_conflict(facts: list[TableFact]) -> list[TableFact]:
    filtered: list[TableFact] = []
    for fact in facts:
        label = fact.label.lower()
        if " q3 " in f" {label} " or " q4 " in f" {label} ":
            continue
        filtered.append(fact)
    return filtered


def _asks_quarterly_revenue_breakdown(question_lower: str) -> bool:
    has_revenue = any(
        term in question_lower
        for term in ("revenue", "revenues", "sales income", "\u9500\u552e\u6536\u5165", "\u8425\u6536", "\u6536\u5165")
    )
    has_quarter = bool(_question_quarters(question_lower))
    asks_breakdown = any(
        term in question_lower
        for term in ("breakdown", "component", "source", "including", "\u5176\u4e2d", "\u62c6\u5206", "\u6784\u6210")
    )
    return (
        has_revenue
        and has_quarter
        and ("202" in question_lower or "19" in question_lower)
        and not _asks_service_revenue(question_lower)
        and asks_breakdown
    )


def _asks_quarterly_financial_metric(question_lower: str) -> bool:
    metric_terms = (
        "research and development expenses",
        "r&d expense",
        "r&d expenses",
        "vehicle sales revenue",
        "vehicle sales",
        "total revenues",
        "total revenue",
        "gross profit",
        "\u7814\u53d1\u8d39\u7528",
        "\u7814\u53d1\u652f\u51fa",
        "\u8f66\u8f86\u9500\u552e\u6536\u5165",
        "\u6c7d\u8f66\u9500\u552e\u6536\u5165",
        "\u603b\u6536\u5165",
        "\u603b\u8425\u6536",
        "\u6bdb\u5229",
    )
    has_metric = any(term in question_lower for term in metric_terms)
    return has_metric and bool(_question_quarters(question_lower)) and ("202" in question_lower or "19" in question_lower)


def _asks_revenue_contribution(question_lower: str) -> bool:
    if _asks_cost_of_revenues_mix(question_lower):
        return False
    has_contribution = any(term in question_lower for term in ("contribution", "share", "mix", "\u8d21\u732e", "\u5360\u6bd4", "\u6784\u6210"))
    has_sales = any(term in question_lower for term in ("sales", "revenue", "product", "\u9500\u552e", "\u9500\u91cf", "\u6536\u5165", "\u4ea7\u54c1"))
    return has_contribution and has_sales


def _asks_cost_of_revenues_mix(question_lower: str) -> bool:
    has_cost_revenue = any(
        term in question_lower
        for term in (
            "cost of revenues",
            "cost of revenue",
            "costs of revenues",
            "costs of revenue",
            "\u6536\u5165\u6210\u672c",
            "\u8425\u4e1a\u6210\u672c",
        )
    )
    has_mix_or_driver = any(
        term in question_lower
        for term in (
            "mix",
            "share",
            "contribution",
            "concentration",
            "driver",
            "growth",
            "\u6784\u6210",
            "\u5360\u6bd4",
            "\u9a71\u52a8",
            "\u589e\u957f",
        )
    )
    return has_cost_revenue and has_mix_or_driver


def _asks_rd_expense_mix(question_lower: str) -> bool:
    has_rd = any(
        term in question_lower
        for term in (
            "r&d",
            "research and development",
            "\u7814\u53d1\u8d39\u7528",
            "\u7814\u53d1\u652f\u51fa",
            "\u7814\u53d1\u6295\u5165",
        )
    )
    has_component = any(
        term in question_lower
        for term in (
            "outsourcing",
            "employee compensation",
            "internal employee",
            "compensation",
            "mix",
            "shift",
            "share",
            "\u5916\u5305",
            "\u5458\u5de5\u85aa\u916c",
            "\u5185\u90e8",
            "\u6784\u6210",
            "\u5360\u6bd4",
            "\u8f6c\u5411",
        )
    )
    return has_rd and has_component


def _detect_delivery_facts(question: str, chunks: list[dict[str, Any]]) -> list[TableFact]:
    years = _question_years(question)
    target_year = years[0] if years else None
    quarters = _question_quarters(question)
    asks_each_quarter = any(term in (question or "").lower() for term in ("each quarter", "quarterly", "\u5404\u5b63\u5ea6", "\u6bcf\u4e2a\u5b63\u5ea6"))
    asks_annual = _asks_annual(question)
    asks_breakdown = any(term in (question or "").lower() for term in ("breakdown", "monthly", "\u660e\u7ec6", "\u62c6\u5206"))
    if asks_breakdown and not quarters:
        asks_each_quarter = True
    if not asks_each_quarter and not quarters and not asks_annual:
        return []
    if not _asks_combined_delivery_basis(question):
        monthly_facts = _detect_monthly_delivery_facts(question, chunks, target_year, quarters, asks_each_quarter, asks_annual)
        if monthly_facts:
            return monthly_facts
    facts: list[TableFact] = []
    for chunk in _table_chunks(chunks):
        rows = parse_table_rows(chunk.get("page_content", ""))
        source, page = _source(chunk)
        for row_idx, header_row in enumerate(rows):
            if not header_row or "deliver" not in header_row[0].lower():
                continue
            if row_idx + 1 >= len(rows):
                continue
            values_row = rows[row_idx + 1]
            if values_row and values_row[0].strip():
                continue
            if asks_annual:
                for idx, cell in enumerate(header_row):
                    if idx == 0 or len(values_row) <= idx:
                        continue
                    if not _cell_matches_annual(cell, target_year):
                        continue
                    value = values_row[idx]
                    if _is_numeric_fact_value(value):
                        facts.append(TableFact("delivery", f"{target_year} full-year deliveries", value, "vehicles", source, page))
                continue
            if asks_each_quarter:
                wanted_quarters = {"Q1", "Q2", "Q3", "Q4"}
            else:
                wanted_quarters = quarters
            for idx, cell in enumerate(header_row):
                if idx == 0 or len(values_row) <= idx:
                    continue
                if not _cell_matches_period(cell, target_year, wanted_quarters):
                    continue
                value = values_row[idx]
                if not _is_numeric_fact_value(value):
                    continue
                matched_quarters = [quarter for quarter in ("Q1", "Q2", "Q3", "Q4") if _cell_matches_period(cell, target_year, {quarter})]
                quarter_label = matched_quarters[0] if matched_quarters else "/".join(sorted(wanted_quarters))
                facts.append(TableFact("delivery", f"{target_year or ''} {quarter_label} deliveries".strip(), value, "vehicles", source, page))
    return facts


def _asks_combined_delivery_basis(question: str) -> bool:
    text = (question or "").lower()
    return any(term in text for term in ("group", "combined", "including lynk", "lynk", "\u96c6\u56e2", "\u5408\u5e76", "\u9886\u514b"))


def _detect_monthly_delivery_facts(
    question: str,
    chunks: list[dict[str, Any]],
    target_year: int | None,
    quarters: set[str],
    asks_each_quarter: bool,
    asks_annual: bool,
) -> list[TableFact]:
    if target_year is None:
        return []
    month_to_quarter = {
        "january": "Q1",
        "february": "Q1",
        "march": "Q1",
        "april": "Q2",
        "may": "Q2",
        "june": "Q2",
        "july": "Q3",
        "august": "Q3",
        "september": "Q3",
        "october": "Q4",
        "november": "Q4",
        "december": "Q4",
    }
    wanted_quarters = {"Q1", "Q2", "Q3", "Q4"} if asks_each_quarter or asks_annual else quarters
    if not wanted_quarters and not asks_annual:
        return []

    for chunk in _table_chunks(chunks):
        rows = parse_table_rows(chunk.get("page_content", ""))
        if not rows or not any(row and "delivery volume" in " ".join(row).lower() for row in rows[:3]):
            continue
        by_quarter: dict[str, int] = {}
        current_year: int | None = None
        for row in rows:
            if not row:
                continue
            first = row[0].strip().lower()
            year_match = re.search(r"(20\d{2}|19\d{2})", first)
            if first.startswith("in ") and year_match:
                current_year = int(year_match.group(1))
                continue
            if current_year != target_year or len(row) < 2:
                continue
            quarter = month_to_quarter.get(first)
            if not quarter:
                continue
            value = parse_accounting_number(row[1])
            if value is None:
                continue
            by_quarter[quarter] = by_quarter.get(quarter, 0) + int(value)
        source, page = _source(chunk)
        if asks_annual and len(by_quarter) == 4:
            total = sum(by_quarter.values())
            return [TableFact("delivery", f"{target_year} full-year deliveries", f"{total:,}", "vehicles", source, page)]
        if wanted_quarters and wanted_quarters.issubset(by_quarter.keys()):
            return [
                TableFact("delivery", f"{target_year} {quarter} deliveries", f"{by_quarter[quarter]:,}", "vehicles", source, page)
                for quarter in ("Q1", "Q2", "Q3", "Q4")
                if quarter in wanted_quarters
            ]
    return []


def _detect_delivery_source_conflict_facts(question: str, chunks: list[dict[str, Any]]) -> list[TableFact]:
    years = _question_years(question)
    target_year = years[0] if years else None
    if target_year is None:
        return []
    monthly = _monthly_delivery_quarter_values(chunks, target_year)
    quarterly = _quarterly_delivery_table_values(chunks, target_year)
    if len(monthly) < 4 or not quarterly:
        return []

    conflict_quarters = [
        quarter
        for quarter in ("Q1", "Q2", "Q3", "Q4")
        if quarter in monthly
        and quarter in quarterly
        and abs(quarterly[quarter][0] - monthly[quarter][0]) > max(1000, monthly[quarter][0] * 0.1)
    ]
    if not conflict_quarters:
        return []

    # For the current SEC delivery pattern, the material downstream conflict is
    # usually in the later quarters after the reporting basis changes.
    preferred_conflicts = [quarter for quarter in ("Q3", "Q4") if quarter in conflict_quarters]
    if preferred_conflicts:
        conflict_quarters = preferred_conflicts

    first_source, first_page = next(iter(monthly.values()))[1:]
    facts = [
        TableFact(
            "delivery_source_conflict",
            f"{target_year} full-year deliveries",
            f"{sum(value for value, _source, _page in monthly.values()):,}",
            "vehicles",
            first_source,
            first_page,
            confidence="medium",
        )
    ]
    growth = _delivery_yoy_growth_from_text(question, chunks, target_year, sum(value for value, _source, _page in monthly.values()))
    if growth is not None:
        facts.append(
            TableFact(
                "delivery_source_conflict",
                f"{target_year} delivery YoY growth",
                f"{growth:.0f}",
                "%",
                first_source,
                first_page,
                confidence="medium",
            )
        )
    for quarter in conflict_quarters:
        value, source, page = quarterly[quarter]
        facts.append(
            TableFact(
                "delivery_source_conflict",
                f"{target_year} source-conflict {quarter} deliveries",
                f"{value:,}",
                "vehicles",
                source,
                page,
                confidence="medium",
            )
        )
    return facts


def _monthly_delivery_quarter_values(chunks: list[dict[str, Any]], target_year: int) -> dict[str, tuple[int, str, Any]]:
    month_to_quarter = {
        "january": "Q1",
        "february": "Q1",
        "march": "Q1",
        "april": "Q2",
        "may": "Q2",
        "june": "Q2",
        "july": "Q3",
        "august": "Q3",
        "september": "Q3",
        "october": "Q4",
        "november": "Q4",
        "december": "Q4",
    }
    for chunk in _table_chunks(chunks):
        rows = parse_table_rows(chunk.get("page_content", ""))
        if not rows or not any(row and "delivery volume" in " ".join(row).lower() for row in rows[:3]):
            continue
        current_year: int | None = None
        by_quarter: dict[str, int] = {}
        source, page = _source(chunk)
        for row in rows:
            if not row:
                continue
            first = row[0].strip().lower()
            year_match = re.search(r"(20\d{2}|19\d{2})", first)
            if year_match:
                current_year = int(year_match.group(1))
                continue
            if current_year != target_year or len(row) < 2:
                continue
            quarter = month_to_quarter.get(first)
            value = parse_accounting_number(row[1]) if quarter else None
            if quarter and value is not None:
                by_quarter[quarter] = by_quarter.get(quarter, 0) + int(value)
        if len(by_quarter) >= 4:
            return {quarter: (value, source, page) for quarter, value in by_quarter.items()}
    return {}


def _quarterly_delivery_table_values(chunks: list[dict[str, Any]], target_year: int) -> dict[str, tuple[int, str, Any]]:
    values: dict[str, tuple[int, str, Any]] = {}
    for chunk in _table_chunks(chunks):
        rows = parse_table_rows(chunk.get("page_content", ""))
        if not rows:
            continue
        source, page = _source(chunk)
        for row_idx, header in enumerate(rows[:-1]):
            header_text = " ".join(header).lower()
            if "deliver" not in header_text or str(target_year) not in header_text:
                continue
            value_row = rows[row_idx + 1]
            if value_row and value_row[0].strip().lower().startswith("deliver"):
                continue
            for idx, cell in enumerate(header):
                if idx == 0 or idx >= len(value_row):
                    continue
                if str(target_year) not in (cell or ""):
                    continue
                quarter = _quarter_from_header(cell)
                value = parse_accounting_number(value_row[idx]) if quarter else None
                if quarter and value is not None:
                    values[quarter] = (int(value), source, page)
    return values


def _delivery_yoy_growth_from_text(
    question: str,
    chunks: list[dict[str, Any]],
    target_year: int,
    target_total: int,
) -> float | None:
    text = "\n".join(str(chunk.get("page_content") or "") for chunk in chunks)
    explicit = re.search(rf"{target_total:,}[^.\n]{{0,180}}?(\d+(?:\.\d+)?)\s*%\s+(?:growth|year-over-year|increase)", text, re.IGNORECASE)
    if not explicit:
        explicit = re.search(rf"(\d+(?:\.\d+)?)\s*%[^.\n]{{0,180}}?{target_total:,}", text, re.IGNORECASE)
    if explicit:
        value = parse_accounting_number(explicit.group(1))
        if value is not None:
            return value
    compared = re.search(
        rf"Compared to\s+([\d,]+)\s+units[^.\n]{{0,220}}?delivered\s+{target_total:,}\s+units\s+.*?{target_year}",
        text,
        re.IGNORECASE,
    )
    if compared:
        previous = parse_accounting_number(compared.group(1))
        if previous:
            return (target_total / previous - 1.0) * 100.0
    return None


def _detect_capitalization_facts(question: str, chunks: list[dict[str, Any]]) -> list[TableFact]:
    candidates: list[tuple[int, list[TableFact]]] = []
    for chunk in _table_chunks(chunks):
        content = chunk.get("page_content", "")
        if "Total capitalization" not in content or "Pro Forma" not in content:
            continue
        rows = parse_table_rows(content)
        column_indices = _capitalization_column_indices(rows)
        if not column_indices:
            continue
        source, page = _source(chunk)
        facts: list[TableFact] = []
        for label in _capitalization_labels_for_question(question):
            row = _row_by_label(rows, label)
            if not row:
                continue
            for scenario in _capitalization_scenarios_for_question(question):
                for unit, idx in (column_indices.get(scenario) or {}).items():
                    if len(row) > idx and re.search(r"\d", row[idx]):
                        scenario_label = scenario.replace("_", " ")
                        facts.append(TableFact("capitalization", f"{label} {scenario_label} {unit}", row[idx], f"{unit} thousands", source, page))
        if facts:
            score = _capitalization_table_score(question, rows, content, facts)
            score += _capitalization_source_bias(question, source)
            candidates.append((score, facts))
    if not candidates:
        return []
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def _capitalization_column_indices(rows: list[list[str]]) -> dict[str, dict[str, int]]:
    max_width = max((len(row) for row in rows), default=0)
    header_text = " ".join(" ".join(row) for row in rows[:4]).lower()
    if "actual" in header_text and "pro forma" in header_text and max_width >= 5:
        indices = {
            "actual": {"RMB": 1, "US$": 2},
            "pro_forma": {"RMB": 3, "US$": 4},
        }
        if max_width >= 7 and "adjusted" in header_text:
            indices["pro_forma_as_adjusted"] = {"RMB": 5, "US$": 6}
        return indices
    return {}


def _capitalization_scenarios_for_question(question: str) -> list[str]:
    if "as adjusted" in (question or "").lower():
        return ["actual", "pro_forma_as_adjusted"]
    return ["actual", "pro_forma"]


def _capitalization_labels_for_question(question: str) -> tuple[str, ...]:
    text = (question or "").lower()
    labels: list[str] = []
    if "liabilit" in text:
        labels.extend(["Notes payable", "Amounts due to related parties", "Loans from related parties"])
        if "pro forma" in text or "as adjusted" in text:
            labels.extend(["Ordinary shares", "Additional paid-in capital"])
    if "net worth" in text or "shareholders" in text:
        labels.extend(["Total shareholders' deficit", "Total Shareholder's Equity"])
    if "related-party loan" in text or "related party loan" in text or ("related" in text and "loan" in text):
        labels.append("Loans from related parties")
    if "negative capitalization" in text or ("capitalization" in text and "accumulated deficit" in text):
        labels.extend(["Total shareholders' deficit", "Total Shareholder's Equity"])
    if "capitalization" in text:
        labels.append("Total capitalization")
    if "paid-in" in text or "line items" in text or "equity" in text:
        labels.append("Additional paid-in capital")
    if "accumulated deficit" in text or "line items" in text or "equity" in text:
        labels.extend(["Accumulated deficit", "Accumulated deficits"])
    if not labels:
        labels.extend(["Total capitalization", "Additional paid-in capital", "Accumulated deficit", "Accumulated deficits"])
    return tuple(dict.fromkeys(labels))


def _question_date_signature(question: str) -> tuple[str, str, str] | None:
    text = (question or "").lower()
    year_match = re.search(r"(20\d{2}|19\d{2})", text)
    if not year_match:
        return None
    month_match = re.search(r"\b(june|jun\.?|december|dec\.?|september|sept\.?|sep\.?|march|mar\.?)\s+(\d{1,2})", text)
    if not month_match:
        return None
    month_alias = month_match.group(1).rstrip(".")
    month = {
        "jun": "june",
        "dec": "december",
        "sept": "september",
        "sep": "september",
        "mar": "march",
    }.get(month_alias, month_alias)
    return month, month_match.group(2), year_match.group(1)


def _capitalization_table_score(question: str, rows: list[list[str]], content: str, facts: list[TableFact]) -> int:
    score = len(facts)
    signature = _question_date_signature(question)
    table_text = " ".join(" ".join(row) for row in rows[:5]).lower()
    full_text = f"{table_text} {(content or '')[:1200].lower()}"
    if signature:
        month, day, year = signature
        if month in full_text and day in full_text and year in full_text:
            score += 40
        elif "as of" in full_text and year in full_text and month not in full_text:
            score -= 10
    if "as adjusted" in (question or "").lower():
        if any("pro forma as adjusted" in fact.label for fact in facts):
            score += 25
        if any("pro forma as adjusted" in fact.label and fact.value.strip() not in {"", "\u2014", "-"} for fact in facts):
            score += 10
    return score


def _capitalization_source_bias(question: str, source: str) -> int:
    text = (question or "").lower()
    source_lower = (source or "").lower()
    if "as adjusted" not in text and "pro forma" not in text:
        return 0
    if "final prospectus" in text or "424b4" in text:
        return 3 if "424b4" in source_lower else 0
    if "liabilit" in text and "/f1_" in source_lower.replace("\\", "/"):
        return 2
    return 0


def _detect_gross_margin_facts(question: str, chunks: list[dict[str, Any]]) -> list[TableFact]:
    years = _question_years(question)
    target_year = years[0] if years else None
    quarters = _question_quarters(question)
    if target_year is None and not quarters:
        return []
    question_lower = (question or "").lower()
    asks_gross_profit = "gross profit" in question_lower or "\u6bdb\u5229" in question
    asks_gross_margin = "gross margin" in question_lower or "\u6bdb\u5229\u7387" in question
    candidates: list[tuple[int, list[TableFact]]] = []
    for chunk in _table_chunks(chunks):
        rows = parse_table_rows(chunk.get("page_content", ""))
        source, page = _source(chunk)
        chunk_facts: list[TableFact] = []
        gross_margin = _row_by_label(rows, "gross margin")
        gross_profit = _row_by_label(rows, "gross profit")
        if asks_gross_profit and asks_gross_margin and gross_profit and gross_margin and not quarters:
            columns = [
                (idx, year, unit)
                for idx, year, unit in _annual_column_candidates(rows, gross_profit, target_year)
                if idx < len(gross_profit)
                and idx < len(gross_margin)
                and year == target_year
                and ("lotus" not in question_lower or unit == "US$")
                and _is_numeric_fact_value(gross_profit[idx])
                and not _is_estimated_range_value(gross_profit[idx])
                and not _is_estimated_range_value(gross_margin[idx])
                and (parse_accounting_number(gross_profit[idx]) or 0.0) != 0.0
                and re.search(r"\d", gross_margin[idx])
            ]
            if columns:
                idx, year, unit = columns[0]
                money_unit = f"{unit} thousands" if unit in {"US$", "RMB"} else unit
                chunk_facts.append(
                    TableFact("gross_profit", f"{year} gross profit", gross_profit[idx], money_unit, source, page)
                )
                chunk_facts.append(
                    TableFact("gross_margin", f"{year} gross margin", gross_margin[idx], "%", source, page)
                )
                candidates.append((_gross_margin_source_score(question, chunk, rows, chunk_facts) + 25, chunk_facts))
                continue
            continue
        if gross_margin:
            for idx in _period_indices(rows, target_year, quarters):
                if len(gross_margin) > idx and re.search(r"\d", gross_margin[idx]):
                    chunk_facts.append(TableFact("gross_margin", f"{target_year or ''} {'/'.join(sorted(quarters))} gross margin".strip(), gross_margin[idx], "%", source, page))
        revenue = _row_by_label(rows, "total revenues")
        if not chunk_facts and revenue and gross_profit:
            for idx in _period_indices(rows, target_year, quarters):
                if len(revenue) <= idx or len(gross_profit) <= idx:
                    continue
                revenue_value = parse_accounting_number(revenue[idx])
                gross_value = parse_accounting_number(gross_profit[idx])
                if revenue_value and gross_value is not None:
                    pct = gross_value / revenue_value * 100.0
                    chunk_facts.append(TableFact("gross_margin_calc", "computed gross margin", f"{pct:.1f}", "%", source, page, confidence="medium"))
        if chunk_facts:
            candidates.append((_gross_margin_source_score(question, chunk, rows, chunk_facts), chunk_facts))
    if not candidates:
        return []
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def _gross_margin_source_score(
    question: str,
    chunk: dict[str, Any],
    rows: list[list[str]],
    facts: list[TableFact],
) -> int:
    years = _question_years(question)
    target_year = years[0] if years else None
    quarters = _question_quarters(question)
    source, _ = _source(chunk)
    content = str(chunk.get("page_content") or "")
    text = f"{source} {content[:1600]}".lower()
    score = len(facts)
    if target_year:
        source_year = _source_year(source, text)
        if source_year == target_year:
            score += 50
        elif source_year and source_year > target_year:
            score -= 45 * (source_year - target_year)
        elif source_year and source_year < target_year:
            score -= 10
    if "gross margin" in text:
        score += 5
    for quarter in quarters:
        if _quarter_text(quarter) in text or quarter.lower() in text:
            score += 8
    if target_year and any(f"{future} q" in text or f"q1 {future}" in text for future in range(target_year + 1, target_year + 3)):
        score -= 20
    header_text = " ".join(" ".join(row) for row in rows[:3]).lower()
    if target_year and re.search(rf"\b{target_year + 1}\s*q[1-4]\b", header_text):
        score -= 20
    return score


def _source_year(source: str, text: str) -> int | None:
    match = re.search(r"(20\d{2})(?:\d{4})", source or "")
    if match:
        return int(match.group(1))
    match = re.search(r"date:\s*(20\d{2})-\d{2}-\d{2}", text or "", re.IGNORECASE)
    if match:
        return int(match.group(1))
    return None


def _quarter_text(quarter: str) -> str:
    return {
        "Q1": "first quarter",
        "Q2": "second quarter",
        "Q3": "third quarter",
        "Q4": "fourth quarter",
    }.get(quarter, quarter.lower())


def _detect_working_capital_facts(question: str, chunks: list[dict[str, Any]]) -> list[TableFact]:
    years = _question_years(question)
    target_year = max(years) if years else None
    candidates: list[tuple[int, list[TableFact]]] = []
    for chunk in _table_chunks(chunks):
        content = chunk.get("page_content", "")
        rows = parse_table_rows(chunk.get("page_content", ""))
        assets = _row_by_label(rows, "total current assets")
        liabilities = _row_by_label(rows, "total current liabilities")
        if not assets or not liabilities:
            continue
        source, page = _source(chunk)
        facts: list[TableFact] = []
        columns = [
            (idx, year, unit)
            for idx, year, unit in _annual_column_candidates(rows, assets, target_year)
            if idx < len(assets)
            and idx < len(liabilities)
            and unit == "RMB"
            and _is_numeric_fact_value(assets[idx])
            and _is_numeric_fact_value(liabilities[idx])
        ]
        if target_year is not None:
            columns = [column for column in columns if column[1] == target_year]
        if columns:
            candidate_indices = [max(columns, key=lambda item: item[1] or 0)[0]]
        else:
            candidate_indices = list(range(1, min(len(assets), len(liabilities))))
        for idx in candidate_indices:
            asset_value = parse_accounting_number(assets[idx])
            liability_value = parse_accounting_number(liabilities[idx])
            if asset_value is None or liability_value is None:
                continue
            facts.append(TableFact("working_capital", "total current assets", assets[idx], "RMB thousands", source, page))
            facts.append(TableFact("working_capital", "total current liabilities", liabilities[idx], "RMB thousands", source, page))
            facts.append(TableFact("working_capital", "working capital", f"{int(asset_value - liability_value):,}", "RMB thousands", source, page))
            candidates.append((_working_capital_table_score(question, rows, content, facts), facts))
            break
    if not candidates:
        return []
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def _working_capital_table_score(question: str, rows: list[list[str]], content: str, facts: list[TableFact]) -> int:
    score = len(facts)
    signature = _question_date_signature(question)
    header_text = " ".join(" ".join(row) for row in rows[:6]).lower()
    full_text = f"{header_text} {(content or '')[:1200].lower()}"
    if signature:
        month, day, year = signature
        if month in full_text and day in full_text and year in full_text:
            score += 50
        elif year in full_text:
            score += 5
        if month != "december" and "december 31" in full_text and month not in full_text:
            score -= 30
    return score


def _detect_cash_balance_facts(question: str, chunks: list[dict[str, Any]]) -> list[TableFact]:
    years = _question_years(question)
    target_year = years[0] if years else None
    quarters = _question_quarters(question)
    candidates: list[tuple[int, list[TableFact]]] = []
    for chunk in _table_chunks(chunks):
        content = chunk.get("page_content", "")
        rows = parse_table_rows(chunk.get("page_content", ""))
        source, page = _source(chunk)
        cash_total = _row_by_label(rows, "total cash, cash equivalents and restricted cash")
        cash_and_equivalents = _row_by_label(rows, "cash and cash equivalents")
        restricted_cash = _row_by_label(rows, "restricted cash")
        if not cash_total and not (cash_and_equivalents and restricted_cash):
            continue
        data_row = cash_total or cash_and_equivalents or []
        if quarters:
            columns = _balance_sheet_period_column_candidates(rows, data_row, target_year, quarters)
        else:
            columns = _annual_column_candidates(rows, data_row, target_year)
        columns = [(idx, year, unit) for idx, year, unit in columns if unit in {"RMB", "US$"}]
        if target_year is not None:
            columns = [column for column in columns if column[1] == target_year]
        if not columns:
            continue
        best_by_unit: dict[str, tuple[int, int | None, str]] = {}
        for idx, year, unit in columns:
            best_by_unit[unit] = (idx, year, unit)
        facts: list[TableFact] = []
        for unit in ("RMB", "US$"):
            column = best_by_unit.get(unit)
            if not column:
                continue
            idx, year, _unit = column
            value: str | None = None
            if cash_total and idx < len(cash_total) and _is_numeric_fact_value(cash_total[idx]):
                value = cash_total[idx]
            elif (
                cash_and_equivalents
                and restricted_cash
                and idx < len(cash_and_equivalents)
                and idx < len(restricted_cash)
            ):
                cash_value = parse_accounting_number(cash_and_equivalents[idx])
                restricted_value = parse_accounting_number(restricted_cash[idx])
                if cash_value is not None and restricted_value is not None:
                    value = f"{int(round(cash_value + restricted_value)):,}"
            if not value:
                continue
            year_label = year or target_year or "annual"
            if quarters:
                year_label = f"{year_label} {'/'.join(sorted(quarters))}"
            facts.append(
                TableFact(
                    "cash_balance",
                    f"{year_label} total cash, cash equivalents and restricted cash {unit}",
                    value,
                    f"{unit} thousands",
                    source,
                    page,
                )
            )
        if facts:
            candidates.append((_cash_balance_table_score(question, rows, content, facts), facts))
    if not candidates:
        return []
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def _balance_sheet_period_column_candidates(
    rows: list[list[str]],
    data_row: list[str],
    target_year: int | None,
    quarters: set[str],
) -> list[tuple[int, int | None, str]]:
    if not data_row:
        return []
    quarter_end = {
        "Q1": ("march 31",),
        "Q2": ("june 30",),
        "Q3": ("september 30",),
        "Q4": ("december 31",),
    }
    wanted_dates = [date for quarter in quarters for date in quarter_end.get(quarter, ())]
    candidates: list[tuple[int, int | None, str]] = []
    for idx in range(1, len(data_row)):
        header_cells = [row[idx] for row in rows[:5] if idx < len(row)]
        header_text = " ".join(header_cells).lower()
        if target_year is not None and str(target_year) not in header_text:
            continue
        if wanted_dates and not any(date in header_text for date in wanted_dates):
            continue
        unit = "US$" if "us$" in header_text else "RMB"
        year_match = re.search(r"(20\d{2}|19\d{2})", header_text)
        year = int(year_match.group(1)) if year_match else target_year
        candidates.append((idx, year, unit))
    return candidates


def _cash_balance_table_score(question: str, rows: list[list[str]], content: str, facts: list[TableFact]) -> int:
    score = len(facts)
    target_year = (_question_years(question) or [None])[0]
    quarters = _question_quarters(question)
    header_text = " ".join(" ".join(row) for row in rows[:6]).lower()
    full_text = f"{header_text} {(content or '')[:1200].lower()}"
    if target_year and str(target_year) in full_text:
        score += 5
    quarter_end = {
        "Q1": "march 31",
        "Q2": "june 30",
        "Q3": "september 30",
        "Q4": "december 31",
    }
    for quarter in quarters:
        wanted = quarter_end.get(quarter)
        if wanted and wanted in full_text:
            score += 40
        elif quarter == "Q4" and "year ended december 31" in full_text:
            score += 30
    if "US$" in {fact.unit.split()[0] for fact in facts} and "RMB" in {fact.unit.split()[0] for fact in facts}:
        score += 5
    if quarters and "september 30" in full_text and "Q3" not in quarters:
        score -= 20
    return score


def _annual_column_candidates(rows: list[list[str]], data_row: list[str], target_year: int | None) -> list[tuple[int, int | None, str]]:
    header_rows = rows[:4]
    direct: list[tuple[int, int | None, str]] = []
    for header in header_rows:
        if len(header) != len(data_row):
            continue
        for idx, cell in enumerate(header):
            if idx == 0:
                continue
            year_match = re.search(r"(20\d{2}|19\d{2})", cell)
            if not year_match:
                continue
            unit = "US$" if "us$" in cell.lower() else "RMB"
            direct.append((idx, int(year_match.group(1)), unit))
        if direct:
            if target_year is not None and not any(year == target_year for _idx, year, _unit in direct):
                mixed = _mixed_annual_column_candidates(header_rows, header, data_row)
                if mixed:
                    return mixed
            return direct

    years: list[int] = []
    for header in header_rows:
        for cell in header:
            years.extend(int(year) for year in re.findall(r"(20\d{2}|19\d{2})", cell or ""))
        if years:
            years = list(dict.fromkeys(years))
            break
    unit_row = next((row for row in header_rows if any("rmb" in cell.lower() or "us$" in cell.lower() for cell in row)), [])
    if not years or not unit_row:
        return []

    unit_cells = [cell for cell in unit_row if "rmb" in cell.lower() or "us$" in cell.lower() or "%" in cell]
    candidates: list[tuple[int, int | None, str]] = []
    year_pos = 0
    for offset, unit_cell in enumerate(unit_cells, start=1):
        if offset >= len(data_row):
            continue
        unit_lower = unit_cell.lower()
        unit = "US$" if "us$" in unit_lower else ("%" if "%" in unit_cell else "RMB")
        if unit == "RMB" and offset > 1 and "rmb" in unit_lower:
            prev_units = [cell.lower() for cell in unit_cells[: offset - 1]]
            year_pos = min(prev_units.count("rmb"), len(years) - 1)
        elif unit == "%" and year_pos < len(years) - 1:
            # Percent columns close out a year in the compact annual tables.
            pass
        year = years[min(year_pos, len(years) - 1)]
        candidates.append((offset, year, unit))
        if unit == "%" and year_pos < len(years) - 1:
            year_pos += 1
    return candidates


def _mixed_annual_column_candidates(
    header_rows: list[list[str]],
    mixed_header: list[str],
    data_row: list[str],
) -> list[tuple[int, int | None, str]]:
    unit_positions: list[tuple[int, str]] = []
    for idx, cell in enumerate(mixed_header):
        if idx == 0 or idx >= len(data_row):
            continue
        cell_lower = (cell or "").lower()
        if "rmb" in cell_lower or "us$" in cell_lower or "%" in cell:
            unit = "US$" if "us$" in cell_lower else ("%" if "%" in cell else "RMB")
            unit_positions.append((idx, unit))
    if not unit_positions:
        return []

    direct_years: list[tuple[int, int, str]] = []
    for idx, cell in enumerate(mixed_header):
        if idx == 0 or idx >= len(data_row):
            continue
        year_match = re.search(r"(20\d{2}|19\d{2})", cell or "")
        if year_match:
            direct_years.append((idx, int(year_match.group(1)), "RMB"))

    grouped_years: list[int] = []
    for header in header_rows:
        if header is mixed_header:
            break
        for cell in header:
            grouped_years.extend(int(year) for year in re.findall(r"(20\d{2}|19\d{2})", cell or ""))
    grouped_years = list(dict.fromkeys(grouped_years))
    if not grouped_years:
        return []

    units_per_year = max(1, len(unit_positions) // len(grouped_years))
    candidates: list[tuple[int, int | None, str]] = [(idx, year, unit) for idx, year, unit in direct_years]
    for position, (idx, unit) in enumerate(unit_positions):
        year = grouped_years[min(position // units_per_year, len(grouped_years) - 1)]
        candidates.append((idx, year, unit))
    return sorted(candidates, key=lambda item: item[0])


def _detect_service_revenue_facts(question: str, chunks: list[dict[str, Any]]) -> list[TableFact]:
    years = _question_years(question)
    explicit_year = max(years) if years else None
    facts: list[TableFact] = []

    for chunk in _table_chunks(chunks):
        rows = parse_table_rows(chunk.get("page_content", ""))
        source, page = _source(chunk)
        for row in rows:
            if not row:
                continue
            label = row[0]
            label_lower = label.lower()
            if "research and development service" not in label_lower:
                continue
            if "cost of revenue" in label_lower or "cost of revenues" in label_lower or "charges from related parties" in label_lower:
                continue
            columns = [
                (idx, year, unit)
                for idx, year, unit in _annual_column_candidates(rows, row, explicit_year)
                if idx < len(row) and unit == "RMB" and _is_numeric_fact_value(row[idx])
            ]
            if not columns:
                continue
            if explicit_year is not None:
                columns = [col for col in columns if col[1] == explicit_year]
            if not columns:
                continue
            idx, year, _unit = max(columns, key=lambda item: item[1] or 0)
            year_label = year or explicit_year or "annual"
            facts.append(
                TableFact(
                    "service_revenue",
                    f"{year_label} research and development service and other services revenue",
                    row[idx],
                    "RMB thousands",
                    source,
                    page,
                )
            )
            return facts
    return facts


def _detect_income_statement_bridge_facts(question: str, chunks: list[dict[str, Any]]) -> list[TableFact]:
    years = _question_years(question)
    if len(years) < 2:
        return []
    target_years = sorted(years)[:2]
    labels = (
        "Gross profit",
        "Research and development expenses",
        "Selling, general and administrative expenses",
        "Total operating expenses",
        "Loss from operations",
        "Net loss",
    )
    candidates: list[tuple[int, list[TableFact]]] = []
    for chunk in _table_chunks(chunks):
        content = chunk.get("page_content", "")
        rows = parse_table_rows(content)
        if not all(_row_by_label(rows, label) for label in labels):
            continue
        source, page = _source(chunk)
        facts: list[TableFact] = []
        complete = True
        for label in labels:
            row = _row_by_label(rows, label)
            if not row:
                complete = False
                break
            values = _row_values_by_year(rows, row, target_years, "RMB")
            if not all(year in values for year in target_years):
                complete = False
                break
            for year in target_years:
                facts.append(TableFact("income_statement_bridge", f"{year} {label}", values[year], "RMB thousands", source, page))
        if complete and facts:
            candidates.append((_statement_table_score(rows, content, target_years, facts), facts))
    if not candidates:
        return []
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def _detect_revenue_stream_facts(question: str, chunks: list[dict[str, Any]]) -> list[TableFact]:
    years = _question_years(question)
    if not years:
        return []
    target_year = max(years)
    previous_year = target_year - 1
    labels = (
        "Vehicle sales",
        "Sales of batteries and other components",
        "Research and development service and other services",
        "Total revenues",
    )
    candidates: list[tuple[int, list[TableFact]]] = []
    for chunk in _table_chunks(chunks):
        content = chunk.get("page_content", "")
        rows = parse_table_rows(content)
        if not all(_row_by_label(rows, label) for label in labels):
            continue
        source, page = _source(chunk)
        facts: list[TableFact] = []
        complete = True
        for label in labels:
            row = _row_by_label(rows, label)
            if not row:
                complete = False
                break
            rmb_values = _row_values_by_year(rows, row, [target_year], "RMB")
            if target_year not in rmb_values:
                complete = False
                break
            facts.append(TableFact("revenue_stream", f"{target_year} {label} RMB", rmb_values[target_year], "RMB thousands", source, page))
            usd_values = _row_values_by_year(rows, row, [target_year], "US$")
            if target_year in usd_values:
                facts.append(TableFact("revenue_stream", f"{target_year} {label} US$", usd_values[target_year], "US$ thousands", source, page))
            if label in {"Vehicle sales", "Total revenues"}:
                previous_values = _row_values_by_year(rows, row, [previous_year], "RMB")
                if previous_year in previous_values:
                    facts.append(TableFact("revenue_stream", f"{previous_year} {label} RMB", previous_values[previous_year], "RMB thousands", source, page))
        if complete and facts:
            candidates.append((_statement_table_score(rows, content, [target_year], facts), facts))
    if not candidates:
        return []
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def _detect_quarterly_revenue_breakdown_facts(question: str, chunks: list[dict[str, Any]]) -> list[TableFact]:
    years = _question_years(question)
    quarters = _question_quarters(question)
    if not years or not quarters:
        return []
    target_year = max(years)
    labels = (
        ("Vehicle sales", "vehicle sales"),
        ("Sales of batteries and other components", "sales of batteries and other components"),
        ("Research and development service and other services", "research and development service and other services"),
        ("Total revenues", "total revenues"),
    )
    candidates: list[tuple[int, list[TableFact]]] = []
    for chunk in _table_chunks(chunks):
        content = chunk.get("page_content", "")
        rows = parse_table_rows(content)
        source, page = _source(chunk)
        period_indices = _rmb_period_indices(rows, target_year, quarters)
        if not period_indices:
            continue
        for idx in period_indices:
            facts: list[TableFact] = []
            complete = True
            for row_label, fact_label in labels:
                row = _row_by_label(rows, row_label)
                if not row or idx >= len(row) or not _is_numeric_fact_value(row[idx]):
                    complete = False
                    break
                value = parse_accounting_number(row[idx])
                unit = _rmb_unit_for_table(rows, content, value)
                facts.append(
                    TableFact(
                        "quarterly_revenue_breakdown",
                        f"{target_year} {_quarter_label(quarters)} {fact_label}",
                        _format_abs_number(row[idx]),
                        unit,
                        source,
                        page,
                    )
                )
            if complete and facts:
                candidates.append((_quarterly_table_score(rows, content, target_year, quarters, idx, facts), facts))
    if not candidates:
        return []
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def _detect_quarterly_financial_metric_facts(question: str, chunks: list[dict[str, Any]]) -> list[TableFact]:
    years = _question_years(question)
    quarters = _question_quarters(question)
    if not years or len(quarters) != 1:
        return []
    target_year = max(years)
    quarter = next(iter(quarters))
    metric_labels = _quarterly_metric_labels_for_question(question)
    if not metric_labels:
        return []

    candidates: list[tuple[int, list[TableFact]]] = []
    for chunk in _table_chunks(chunks):
        content = chunk.get("page_content", "")
        rows = parse_table_rows(content)
        source, page = _source(chunk)
        target_indices = _rmb_period_indices(rows, target_year, quarters)
        if not target_indices:
            continue
        for metric_label in metric_labels:
            row = _row_by_label(rows, metric_label)
            if not row:
                continue
            for idx in target_indices:
                if idx >= len(row) or not _is_numeric_fact_value(row[idx]):
                    continue
                facts = [
                    TableFact(
                        "quarterly_financial_metric",
                        f"{target_year} {quarter} {metric_label}",
                        _format_abs_number(row[idx]),
                        _rmb_unit_for_table(rows, content, parse_accounting_number(row[idx])),
                        source,
                        page,
                    )
                ]
                facts.extend(_quarterly_metric_growth_facts(rows, row, metric_label, target_year, quarter, source, page))
                us_idx = _matching_usd_period_index(rows, target_year, quarters)
                if us_idx is not None and us_idx < len(row) and _is_numeric_fact_value(row[us_idx]):
                    facts.append(
                        TableFact(
                            "quarterly_financial_metric",
                            f"{target_year} {quarter} {metric_label} US$",
                            _format_abs_number(row[us_idx]),
                            _usd_unit_for_value(parse_accounting_number(row[us_idx])),
                            source,
                            page,
                            confidence="medium",
                        )
                    )
                candidates.append((_quarterly_table_score(rows, content, target_year, quarters, idx, facts), facts))
    if not candidates:
        return []
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def _detect_revenue_contribution_facts(question: str, chunks: list[dict[str, Any]]) -> list[TableFact]:
    candidates: list[tuple[int, list[TableFact]]] = []
    for chunk in _table_chunks(chunks):
        content = chunk.get("page_content", "")
        rows = parse_table_rows(content)
        vehicle = _row_by_label(rows, "Vehicle sales")
        other = _row_by_label(rows, "Other sales and services")
        total = _row_by_label(rows, "Total revenues")
        if not vehicle or not other or not total:
            continue
        source, page = _source(chunk)
        for idx, year, quarter in _latest_rmb_period_columns(rows, total):
            if idx >= len(vehicle) or idx >= len(other) or idx >= len(total):
                continue
            vehicle_value = parse_accounting_number(vehicle[idx])
            other_value = parse_accounting_number(other[idx])
            total_value = parse_accounting_number(total[idx])
            if not vehicle_value or not other_value or not total_value:
                continue
            period = f"{year} {quarter}".strip()
            unit = _rmb_unit_for_value(total_value)
            unit = _rmb_unit_for_table(rows, content, total_value)
            vehicle_share = vehicle_value / total_value * 100.0
            other_share = other_value / total_value * 100.0
            facts = [
                TableFact("revenue_contribution", f"{period} vehicle sales revenue", _format_abs_number(vehicle[idx]), unit, source, page, confidence="medium"),
                TableFact("revenue_contribution", f"{period} other sales and services revenue", _format_abs_number(other[idx]), unit, source, page, confidence="medium"),
                TableFact("revenue_contribution", f"{period} total revenues", _format_abs_number(total[idx]), unit, source, page, confidence="medium"),
                TableFact("revenue_contribution", f"{period} vehicle sales contribution", f"{vehicle_share:.1f}", "%", source, page, confidence="medium"),
                TableFact("revenue_contribution", f"{period} other sales and services contribution", f"{other_share:.1f}", "%", source, page, confidence="medium"),
            ]
            candidates.append((_revenue_contribution_score(rows, content, year, quarter, facts), facts))
    if not candidates:
        return []
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def _detect_cost_revenue_mix_facts(question: str, chunks: list[dict[str, Any]]) -> list[TableFact]:
    target_years = _target_annual_years(question)
    if len(target_years) < 2:
        return []
    label_specs = (
        ("vehicle sales cost", ("vehicle sales", "sales of vehicle")),
        ("batteries/components cost", ("sales of batteries and other components",)),
        ("R&D service and other services cost", ("research and development service and other services",)),
    )
    candidates: list[tuple[int, list[TableFact]]] = []
    for chunk in _table_chunks(chunks):
        content = chunk.get("page_content", "")
        rows = parse_table_rows(content)
        if not _is_annual_component_mix_table(rows, content):
            continue
        if "cost of revenues" not in " ".join(" ".join(row) for row in rows[:12]).lower() and "cost of revenues" not in content.lower()[:1800]:
            continue
        source, page = _source(chunk)
        facts: list[TableFact] = []
        complete = True
        for canonical, labels in label_specs:
            row = _row_by_label_in_section(rows, "cost of revenues", labels, ("gross profit", "operating expenses", "segment profit"))
            if not row:
                complete = False
                break
            rmb_values = _row_values_by_year_abs(rows, row, target_years, "RMB")
            pct_values = _row_values_by_year_abs(rows, row, target_years, "%")
            if not all(year in rmb_values and year in pct_values for year in target_years):
                complete = False
                break
            for year in target_years:
                facts.append(TableFact("cost_revenue_mix", f"{year} {canonical}", rmb_values[year], "RMB thousands", source, page))
                facts.append(TableFact("cost_revenue_mix", f"{year} {canonical} share", pct_values[year], "%", source, page))

        total_row = _row_by_label_in_section(rows, "cost of revenues", ("total cost of revenues", "total"), ("gross profit", "operating expenses", "segment profit"))
        if complete and total_row:
            total_values = _row_values_by_year_abs(rows, total_row, target_years, "RMB")
            if all(year in total_values for year in target_years):
                for year in target_years:
                    facts.append(TableFact("cost_revenue_mix", f"{year} total cost of revenues", total_values[year], "RMB thousands", source, page))
            else:
                complete = False
        elif complete:
            complete = False

        if complete and facts:
            score = _component_mix_table_score(rows, content, target_years, facts, "cost of revenues")
            score += _source_recency_score(source)
            candidates.append((score, facts))
    if not candidates:
        return []
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def _detect_rd_expense_mix_facts(question: str, chunks: list[dict[str, Any]]) -> list[TableFact]:
    target_years = _target_annual_years(question)
    if len(target_years) < 2:
        return []
    label_specs = (
        ("outsourcing R&D expenses", ("outsourcing research and development expenses", "outsourcing r&d")),
        ("employee compensation", ("employee compensation",)),
    )
    candidates: list[tuple[int, list[TableFact]]] = []
    for chunk in _table_chunks(chunks):
        content = chunk.get("page_content", "")
        rows = parse_table_rows(content)
        if not _is_annual_component_mix_table(rows, content):
            continue
        if "research and development expenses" not in content.lower()[:1800]:
            continue
        source, page = _source(chunk)
        facts: list[TableFact] = []
        complete = True
        for canonical, labels in label_specs:
            row = _row_by_label_in_section(rows, "research and development expenses", labels, ("total", "selling, general", "operating expenses"))
            if not row:
                complete = False
                break
            rmb_values = _row_values_by_year_abs(rows, row, target_years, "RMB")
            pct_values = _row_values_by_year_abs(rows, row, target_years, "%")
            if not all(year in rmb_values and year in pct_values for year in target_years):
                complete = False
                break
            for year in target_years:
                facts.append(TableFact("rd_expense_mix", f"{year} {canonical}", rmb_values[year], "RMB thousands", source, page))
                facts.append(TableFact("rd_expense_mix", f"{year} {canonical} share", pct_values[year], "%", source, page))

        if complete and facts:
            score = _component_mix_table_score(rows, content, target_years, facts, "research and development expenses")
            score += _source_recency_score(source)
            candidates.append((score, facts))
    if not candidates:
        return []
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def _quarterly_metric_labels_for_question(question: str) -> tuple[str, ...]:
    text = (question or "").lower()
    labels: list[str] = []
    if any(term in text for term in ("research and development", "r&d", "\u7814\u53d1")):
        labels.append("Research and development expenses")
    if any(term in text for term in ("vehicle sales", "\u8f66\u8f86\u9500\u552e", "\u6c7d\u8f66\u9500\u552e")):
        labels.append("Vehicle sales")
    if any(term in text for term in ("total revenues", "total revenue", "\u603b\u6536\u5165", "\u603b\u8425\u6536")):
        labels.append("Total revenues")
    if any(term in text for term in ("gross profit", "\u6bdb\u5229")) and not any(term in text for term in ("gross margin", "\u6bdb\u5229\u7387")):
        labels.append("Gross profit")
    return tuple(labels)


def _rmb_period_indices(rows: list[list[str]], target_year: int | None, quarters: set[str]) -> list[int]:
    return [
        idx
        for idx in _period_indices(rows, target_year, quarters)
        if _column_unit(rows, idx) == "RMB" and "%" not in _column_header_text(rows, idx)
    ]


def _matching_usd_period_index(rows: list[list[str]], target_year: int | None, quarters: set[str]) -> int | None:
    for idx in _period_indices(rows, target_year, quarters):
        if _column_unit(rows, idx) == "US$":
            return idx
    return None


def _column_header_text(rows: list[list[str]], idx: int) -> str:
    return " ".join(row[idx] for row in rows[:5] if idx < len(row)).lower()


def _column_unit(rows: list[list[str]], idx: int) -> str:
    header = _column_header_text(rows, idx)
    if "us$" in header:
        return "US$"
    if "%" in header:
        return "%"
    return "RMB"


def _quarter_label(quarters: set[str]) -> str:
    return "/".join(sorted(quarters))


def _format_abs_number(value: str) -> str:
    parsed = parse_accounting_number(value)
    if parsed is None:
        return value
    parsed = abs(parsed)
    if abs(parsed - round(parsed)) < 0.05:
        return f"{int(round(parsed)):,}"
    return f"{parsed:,.1f}"


def _rmb_unit_for_value(value: float | None) -> str:
    if value is not None and abs(value) < 1_000_000:
        return "RMB millions"
    return "RMB thousands"


def _rmb_unit_for_table(rows: list[list[str]], content: str, value: float | None) -> str:
    text = f"{content or ''} {' '.join(' '.join(row) for row in rows[:8])}".lower()
    if "in thousands" in text or "thousands" in text:
        return "RMB thousands"
    if "in millions" in text or "millions" in text:
        return "RMB millions"
    return _rmb_unit_for_value(value)


def _usd_unit_for_value(value: float | None) -> str:
    if value is not None and abs(value) < 1_000_000:
        return "US$ thousands"
    return "US$"


def _quarterly_metric_growth_facts(
    rows: list[list[str]],
    row: list[str],
    metric_label: str,
    target_year: int,
    quarter: str,
    source: str,
    page: Any,
) -> list[TableFact]:
    target_idx = next(iter(_rmb_period_indices(rows, target_year, {quarter})), None)
    if target_idx is None or target_idx >= len(row):
        return []
    target_value = parse_accounting_number(row[target_idx])
    if target_value is None:
        return []
    facts: list[TableFact] = []
    comparators = [
        ("YoY growth", target_year - 1, quarter),
        ("QoQ growth", *_previous_quarter(target_year, quarter)),
    ]
    for label, year, comp_quarter in comparators:
        comp_idx = next(iter(_rmb_period_indices(rows, year, {comp_quarter})), None)
        if comp_idx is None or comp_idx >= len(row):
            continue
        comp_value = parse_accounting_number(row[comp_idx])
        if comp_value in (None, 0):
            continue
        growth = (abs(target_value) / abs(comp_value) - 1.0) * 100.0
        facts.append(
            TableFact(
                "quarterly_financial_metric",
                f"{target_year} {quarter} {metric_label} {label}",
                f"{growth:.1f}",
                "%",
                source,
                page,
                confidence="medium",
            )
        )
    return facts


def _previous_quarter(year: int, quarter: str) -> tuple[int, str]:
    order = ("Q1", "Q2", "Q3", "Q4")
    idx = order.index(quarter)
    if idx == 0:
        return year - 1, "Q4"
    return year, order[idx - 1]


def _quarterly_table_score(
    rows: list[list[str]],
    content: str,
    target_year: int,
    quarters: set[str],
    idx: int,
    facts: list[TableFact],
) -> int:
    score = len(facts)
    header_text = " ".join(" ".join(row) for row in rows[:6]).lower()
    full_text = f"{header_text} {(content or '')[:1200].lower()}"
    if str(target_year) in full_text:
        score += 10
    for quarter in quarters:
        if _cell_matches_period(_column_header_text(rows, idx), target_year, {quarter}):
            score += 20
    if "three months ended" in full_text or any("q" in _column_header_text(rows, idx) for _ in (0,)):
        score += 10
    if any(fact.unit.endswith("millions") for fact in facts):
        score += 2
    return score


def _latest_rmb_period_columns(rows: list[list[str]], data_row: list[str]) -> list[tuple[int, int, str]]:
    columns: list[tuple[int, int, str, int]] = []
    for idx in range(1, len(data_row)):
        if not _is_numeric_fact_value(data_row[idx]) or _column_unit(rows, idx) != "RMB":
            continue
        header = _column_header_text(rows, idx)
        if "%" in header or "change" in header:
            continue
        year_match = re.search(r"(20\d{2}|19\d{2})", header)
        if not year_match:
            continue
        year = int(year_match.group(1))
        quarter = _quarter_from_header(header)
        quarter_rank = {"Q1": 1, "Q2": 2, "Q3": 3, "Q4": 4}.get(quarter, 0)
        columns.append((idx, year, quarter, year * 10 + quarter_rank))
    columns.sort(key=lambda item: item[3], reverse=True)
    return [(idx, year, quarter) for idx, year, quarter, _score in columns]


def _quarter_from_header(header: str) -> str:
    compact = (header or "").lower().replace(" ", "")
    if "yearended" in compact or "fortheyearended" in compact:
        return ""
    aliases = {
        "Q1": ("q1", "march31", "mar31"),
        "Q2": ("q2", "june30", "jun30"),
        "Q3": ("q3", "september30", "sep30", "sept30"),
        "Q4": ("q4", "december31", "dec31"),
    }
    for quarter, values in aliases.items():
        if any(value in compact for value in values):
            return quarter
    return ""


def _revenue_contribution_score(rows: list[list[str]], content: str, year: int, quarter: str, facts: list[TableFact]) -> int:
    score = len(facts)
    header_text = " ".join(" ".join(row) for row in rows[:6]).lower()
    full_text = f"{header_text} {(content or '')[:1200].lower()}"
    if str(year) in full_text:
        score += 20
    score += max(0, year - 2000) * 10
    if quarter:
        score += {"Q1": 1, "Q2": 2, "Q3": 3, "Q4": 4}.get(quarter, 0)
    if "other sales and services" in full_text:
        score += 20
    if any(fact.unit.endswith("millions") for fact in facts):
        score += 5
    return score


def _row_values_by_year(rows: list[list[str]], row: list[str], years: list[int], unit: str) -> dict[int, str]:
    wanted = set(years)
    values: dict[int, str] = {}
    for idx, year, candidate_unit in _annual_column_candidates(rows, row, max(years) if years else None):
        if year not in wanted or candidate_unit != unit or idx >= len(row):
            continue
        if _is_numeric_fact_value(row[idx]):
            values[year] = row[idx]
    return values


def _target_annual_years(question: str) -> list[int]:
    years = _question_years(question)
    if len(years) >= 2:
        start, end = min(years), max(years)
        if 0 < end - start <= 5:
            return list(range(start, end + 1))
        return sorted(years)
    return years


def _row_values_by_year_abs(rows: list[list[str]], row: list[str], years: list[int], unit: str) -> dict[int, str]:
    values = _row_values_by_year(rows, row, years, unit)
    out: dict[int, str] = {}
    for year, value in values.items():
        parsed = parse_accounting_number(value)
        if parsed is None:
            continue
        if unit == "%":
            out[year] = f"{abs(parsed):.1f}".rstrip("0").rstrip(".")
        else:
            out[year] = _format_abs_number(value)
    return out


def _row_by_label_in_section(
    rows: list[list[str]],
    section_label: str,
    labels: tuple[str, ...],
    stop_labels: tuple[str, ...] = (),
) -> list[str] | None:
    section = section_label.lower()
    label_terms = tuple(label.lower() for label in labels)
    stop_terms = tuple(label.lower() for label in stop_labels)
    in_section = False
    first_match_outside_section: list[str] | None = None
    for row in rows:
        if not row:
            continue
        row_label = row[0]
        label_lower = row_label.lower()
        if section in label_lower:
            in_section = True
            if any(term in label_lower for term in label_terms):
                return row
            continue
        if in_section and stop_terms and any(term in label_lower for term in stop_terms):
            break
        if any(term in label_lower for term in label_terms):
            if in_section:
                return row
            if first_match_outside_section is None:
                first_match_outside_section = row
    return first_match_outside_section


def _component_mix_table_score(
    rows: list[list[str]],
    content: str,
    years: list[int],
    facts: list[TableFact],
    section_label: str,
) -> int:
    score = _statement_table_score(rows, content, years, facts)
    full_text = f"{' '.join(' '.join(row) for row in rows[:8]).lower()} {(content or '')[:1800].lower()}"
    if section_label in full_text:
        score += 40
    if "%" in full_text and "in thousands" in full_text:
        score += 10
    if "three months ended" in full_text or "six months ended" in full_text:
        score -= 60
    if all(str(year) in full_text for year in years):
        score += 10
    return score


def _source_recency_score(source: str) -> int:
    matches = re.findall(r"(20\d{6})", source or "")
    if not matches:
        return 0
    return int(matches[-1])


def _is_annual_component_mix_table(rows: list[list[str]], content: str) -> bool:
    scope = f"{' '.join(' '.join(row) for row in rows[:8]).lower()} {(content or '')[:1800].lower()}"
    if any(term in scope for term in ("three months ended", "six months ended", "nine months ended")):
        return False
    if "year ended december 31" in scope or "years ended december 31" in scope:
        return True
    header_years = {
        int(year)
        for row in rows[:4]
        for cell in row
        for year in re.findall(r"(20\d{2}|19\d{2})", cell or "")
    }
    has_percent_column = any("%" in cell for row in rows[:4] for cell in row)
    return len(header_years) >= 2 and has_percent_column


def _statement_table_score(rows: list[list[str]], content: str, years: list[int], facts: list[TableFact]) -> int:
    score = len(facts)
    header_text = " ".join(" ".join(row) for row in rows[:8]).lower()
    full_text = f"{header_text} {(content or '')[:1200].lower()}"
    if "year ended december 31" in full_text or "years ended december 31" in full_text:
        score += 40
    if "three months ended" in full_text or "six months ended" in full_text or "nine months ended" in full_text:
        score -= 40
    for year in years:
        if str(year) in full_text:
            score += 3
    return score


def verify_answer_against_table_facts(question: str, answer: str, chunks: list[dict[str, Any]]) -> dict[str, Any]:
    facts = detect_table_facts(question, chunks)
    checks = []
    for fact in facts:
        present = _fact_value_present_in_answer(fact, answer)
        required = _is_required_fact(question, fact)
        checks.append({**fact.to_dict(), "present_in_answer": present, "required": required})

    present_equivalent_keys = {
        _equivalent_fact_key(check)
        for check in checks
        if check.get("present_in_answer")
    }
    for check in checks:
        if _equivalent_fact_key(check) in present_equivalent_keys:
            check["present_in_answer"] = True

    required_count = sum(1 for check in checks if check.get("required", True))
    missing = sum(
        1
        for check in checks
        if check.get("required", True) and not check.get("present_in_answer")
    )
    if not facts:
        status = "NO_TABLE_FACTS"
    elif missing == 0:
        status = "PASS"
    elif missing < required_count:
        status = "WARN"
    else:
        status = "FAIL"
    return {"status": status, "facts": [fact.to_dict() for fact in facts], "checks": checks}


def _equivalent_fact_key(check: dict[str, Any]) -> tuple[str, str]:
    fact_type = str(check.get("fact_type") or "")
    label = str(check.get("label") or "")
    if fact_type == "capitalization":
        label = re.sub(r"\s+(RMB|US\$)$", "", label)
    return fact_type, label


def _is_required_fact(question: str, fact: TableFact) -> bool:
    question_lower = (question or "").lower()
    label_lower = fact.label.lower()

    if fact.fact_type == "gross_margin_calc":
        return False

    if fact.fact_type == "quarterly_financial_metric" and "us$" in label_lower:
        return any(term in question_lower for term in ("us$", "usd", "dollar", "\u7f8e\u5143", "\u7f8e\u91d1"))

    if fact.fact_type == "working_capital":
        asks_assets_or_liabilities = "current assets" in question_lower or "current liabilities" in question_lower
        if "working capital" in question_lower and not asks_assets_or_liabilities:
            return label_lower == "working capital"

    if fact.fact_type == "capitalization":
        scoped_labels = {
            "ordinary shares": ("ordinary shares", "equity"),
            "additional paid-in capital": ("paid-in capital", "additional paid-in", "equity"),
            "accumulated deficit": ("accumulated deficit", "accumulated deficits"),
            "notes payable": ("liabilit", "liabilities"),
            "amounts due to related parties": ("liabilit", "liabilities"),
            "loans from related parties": (
                "related-party loan",
                "related party loan",
                "loans from related parties",
                "loan balance",
                "liabilit",
                "liabilities",
            ),
            "total shareholders' deficit": (
                "shareholders' deficit",
                "shareholders deficit",
                "total shareholders",
                "negative capitalization",
            ),
            "total capitalization": ("total capitalization", "negative capitalization"),
        }
        matching_scopes = [
            row_label for row_label, triggers in scoped_labels.items()
            if any(trigger in question_lower for trigger in triggers)
        ]
        if matching_scopes:
            return any(row_label in label_lower for row_label in matching_scopes)

    return True
