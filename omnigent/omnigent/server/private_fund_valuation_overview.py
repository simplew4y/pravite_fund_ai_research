# ruff: noqa: E501  -- embedded HTML/CSS is intentionally kept legible in source.
"""Deterministic three-statement extraction and HTML valuation-model overview.

The ingest pipeline already persists workbook, sheet, cell, region, and metric
facts.  This module consumes those immutable facts; it never reopens, executes,
or mutates the source workbook.  The resulting JSON is intended for later
visualizations, while the companion HTML is a self-contained, script-free
overview that can be rendered in a sandboxed iframe.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import unicodedata
from datetime import datetime, timezone
from html import escape
from typing import Any

VALUATION_OVERVIEW_VERSION = "valuation-overview-v1"
STATEMENT_LABELS = {
    "income_statement": "利润表",
    "balance_sheet": "资产负债表",
    "cash_flow": "现金流量表",
}
STATEMENT_COLORS = {
    "income_statement": "#176B5B",
    "balance_sheet": "#3F5F8F",
    "cash_flow": "#9A6A2F",
}
_STATEMENT_ORDER = tuple(STATEMENT_LABELS)

_ROW_STATEMENT_TERMS: dict[str, tuple[str, ...]] = {
    "cash_flow": (
        "cash from operating",
        "cash flow from operating",
        "cash generated from operations",
        "net cash provided by operating",
        "cash from investing",
        "cash flow from investing",
        "cash from financing",
        "cash flow from financing",
        "capital expenditure",
        "free cash flow",
        "change in working capital",
        "operating cash flow",
        "经营活动现金流",
        "投资活动现金流",
        "筹资活动现金流",
        "自由现金流",
        "资本开支",
    ),
    "balance_sheet": (
        "total assets",
        "total liabilities",
        "shareholders equity",
        "shareholder equity",
        "total equity",
        "cash and cash equivalents",
        "accounts receivable",
        "trade receivable",
        "inventories",
        "inventory",
        "current assets",
        "non current assets",
        "current liabilities",
        "non current liabilities",
        "short term debt",
        "long term debt",
        "net debt",
        "总资产",
        "总负债",
        "股东权益",
        "所有者权益",
        "货币资金",
        "应收账款",
        "存货",
        "流动资产",
        "流动负债",
        "长期借款",
        "短期借款",
        "净债务",
    ),
    "income_statement": (
        "revenue",
        "sales",
        "turnover",
        "cost of goods sold",
        "cogs",
        "gross profit",
        "gross margin",
        "ebitda",
        "ebit",
        "operating profit",
        "operating income",
        "profit before tax",
        "net profit",
        "net income",
        "earnings per share",
        "eps",
        "营业收入",
        "营业成本",
        "毛利润",
        "毛利率",
        "营业利润",
        "利润总额",
        "净利润",
        "归母净利润",
        "每股收益",
    ),
}

_ROW_PRIORITY: dict[str, tuple[tuple[str, tuple[str, ...]], ...]] = {
    "income_statement": (
        ("revenue", ("revenue", "sales", "turnover", "营业收入")),
        ("gross_profit", ("gross profit", "毛利润", "毛利")),
        ("gross_margin", ("gross margin", "毛利率")),
        ("ebitda", ("ebitda",)),
        ("ebit", ("ebit", "operating profit", "operating income", "营业利润")),
        ("net_profit", ("net profit", "net income", "归母净利润", "净利润")),
        ("eps", ("earnings per share", "eps", "每股收益")),
    ),
    "balance_sheet": (
        ("cash", ("cash and cash equivalents", "cash & equivalents", "货币资金")),
        ("receivables", ("accounts receivable", "trade receivable", "应收账款")),
        ("inventory", ("inventories", "inventory", "存货")),
        ("total_assets", ("total assets", "总资产")),
        ("debt", ("total debt", "borrowings", "有息负债", "借款")),
        ("net_debt", ("net debt", "净债务", "net cash", "净现金")),
        ("total_liabilities", ("total liabilities", "总负债")),
        ("equity", ("total equity", "shareholders equity", "所有者权益", "股东权益")),
    ),
    "cash_flow": (
        (
            "operating_cash_flow",
            (
                "cash from operating",
                "cash flow from operating",
                "net cash provided by operating",
                "operating cash flow",
                "经营活动现金流",
            ),
        ),
        ("capex", ("capital expenditure", "capex", "资本开支", "资本支出")),
        ("free_cash_flow", ("free cash flow", "fcf", "自由现金流")),
        ("investing_cash_flow", ("cash from investing", "投资活动现金流")),
        ("financing_cash_flow", ("cash from financing", "筹资活动现金流")),
        ("ending_cash", ("ending cash", "cash at end", "期末现金")),
    ),
}

_KEY_METRIC_ORDER = (
    "target_price",
    "upside_downside",
    "enterprise_value",
    "equity_value",
    "wacc",
    "terminal_growth",
    "revenue",
    "net_profit",
    "free_cash_flow",
    "eps",
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _digest(*parts: Any, length: int = 24) -> str:
    payload = "\0".join(str(part or "") for part in parts)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:length]


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _decode(value: Any, default: Any) -> Any:
    if value in (None, ""):
        return default
    try:
        return json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return default


def _normalize(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    text = text.replace("&", " and ").replace("_", " ").replace("/", " ")
    text = re.sub(r"[^a-z0-9%㐀-鿿]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _safe_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
        ).fetchone()
        is not None
    )


def _cell_row(cell_ref: Any) -> int:
    match = re.search(r"(\d+)$", str(cell_ref or ""))
    return int(match.group(1)) if match else 0


def _cell_col(cell_ref: Any) -> int:
    match = re.match(r"([A-Za-z]+)", str(cell_ref or ""))
    if not match:
        return 0
    value = 0
    for char in match.group(1).upper():
        value = value * 26 + ord(char) - 64
    return value


def _period_token(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().upper()
    text = re.sub(r"\s+", " ", text)
    patterns = (
        r"20\d{2}[AEFP]?",
        r"FY ?20\d{2}",
        r"FY ?\d{2}",
        r"[1-4]Q ?(?:20)?\d{2}",
        r"(?:20)?\d{2} ?[1-4]Q",
    )
    return text if any(re.fullmatch(pattern, text) for pattern in patterns) else ""


def _statement_anchor(value: Any) -> str:
    text = _normalize(value)
    if not text:
        return ""
    if (
        text
        in {
            "income statement",
            "income statements",
            "profit and loss",
            "p and l",
            "利润表",
            "损益表",
        }
        or "statement of operations" in text
    ):
        return "income_statement"
    if (
        text in {"balance sheet", "balance sheets", "资产负债表"}
        or "statement of financial position" in text
    ):
        return "balance_sheet"
    if text in {
        "cash flow",
        "cash flows",
        "cash flow statement",
        "cash flow statements",
        "statement of cash flows",
        "现金流量表",
    }:
        return "cash_flow"
    return ""


def _sheet_statement(sheet_name: Any) -> str:
    text = _normalize(sheet_name)
    compact = text.replace(" ", "")
    if text in {
        "is",
        "pl",
        "p and l",
        "income statement",
        "income statements",
        "利润表",
        "损益表",
    }:
        return "income_statement"
    if text in {"bs", "balance sheet", "balance sheets", "资产负债表"}:
        return "balance_sheet"
    if text in {
        "cf",
        "cfs",
        "cash flow",
        "cash flow statement",
        "cash flow statements",
        "现金流量表",
    }:
        return "cash_flow"
    if compact in {"incomestatement", "balancesheet", "cashflowstatement", "cashflowstatements"}:
        return {
            "incomestatement": "income_statement",
            "balancesheet": "balance_sheet",
            "cashflowstatement": "cash_flow",
            "cashflowstatements": "cash_flow",
        }[compact]
    return ""


def _row_statement(metric_name: Any) -> str:
    text = _normalize(metric_name)
    for statement_type in ("cash_flow", "balance_sheet", "income_statement"):
        if any(term in text for term in _ROW_STATEMENT_TERMS[statement_type]):
            return statement_type
    return ""


def _period_sort_key(value: Any) -> tuple[int, int, int, str]:
    text = _normalize(value).upper()
    year_match = re.search(r"(19|20)\d{2}", text)
    year = int(year_match.group(0)) if year_match else -1
    quarter_match = re.search(r"(?:Q([1-4])|([1-4])Q)", text)
    quarter = int(quarter_match.group(1) or quarter_match.group(2)) if quarter_match else 5
    forecast = 1 if re.search(r"(?:E|F|P)$", text) else 0
    return year, quarter, forecast, text


def _metric_profile(statement_type: str, label: Any) -> tuple[str, int] | None:
    text = _normalize(label)
    for rank, (metric_key, terms) in enumerate(_ROW_PRIORITY[statement_type]):
        if any(term in text for term in terms):
            return metric_key, rank
    return None


def _load_anchors(conn: sqlite3.Connection, doc_id: str) -> dict[str, list[tuple[int, str]]]:
    if not _table_exists(conn, "excel_cells"):
        return {}
    anchors: dict[str, list[tuple[int, str]]] = {}
    rows = conn.execute(
        """
        SELECT sheet_name, row_index, display_value, raw_value
        FROM excel_cells WHERE doc_id=? AND is_formula=0
        ORDER BY sheet_name, row_index, col_index
        """,
        (doc_id,),
    ).fetchall()
    for row in rows:
        statement_type = _statement_anchor(row["display_value"] or row["raw_value"])
        if statement_type:
            anchors.setdefault(str(row["sheet_name"]), []).append(
                (int(row["row_index"] or 0), statement_type)
            )
    return anchors


def _load_period_axes(conn: sqlite3.Connection, doc_id: str) -> dict[str, dict[int, str]]:
    if not _table_exists(conn, "excel_cells"):
        return {}
    candidates: dict[tuple[str, int], dict[int, str]] = {}
    rows = conn.execute(
        """
        SELECT sheet_name, row_index, col_index, display_value, raw_value
        FROM excel_cells WHERE doc_id=?
        ORDER BY sheet_name, row_index, col_index
        """,
        (doc_id,),
    ).fetchall()
    for row in rows:
        period = _period_token(row["display_value"] or row["raw_value"])
        if period:
            candidates.setdefault((str(row["sheet_name"]), int(row["row_index"] or 0)), {})[
                int(row["col_index"] or 0)
            ] = period
    axes: dict[str, dict[int, str]] = {}
    sheet_names = {sheet_name for sheet_name, _ in candidates}
    for sheet_name in sheet_names:
        sheet_rows = [
            (row_index, axis)
            for (candidate_sheet, row_index), axis in candidates.items()
            if candidate_sheet == sheet_name
        ]
        if not sheet_rows:
            continue
        _, axis = max(sheet_rows, key=lambda item: (len(item[1]), -item[0]))
        if len(axis) >= 2:
            axes[sheet_name] = axis
    return axes


def _statement_for_fact(
    *, sheet_name: str, row_index: int, metric_name: str, anchors: dict[str, list[tuple[int, str]]]
) -> str:
    direct = _sheet_statement(sheet_name)
    if direct:
        return direct
    preceding = [item for item in anchors.get(sheet_name, []) if item[0] <= row_index]
    if preceding:
        return max(preceding, key=lambda item: item[0])[1]
    return _row_statement(metric_name)


def _extract_statement_tables(
    conn: sqlite3.Connection, doc_id: str
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if not _table_exists(conn, "metric_facts"):
        return [], {"fact_count": 0, "review_required_count": 0}
    anchors = _load_anchors(conn, doc_id)
    period_axes = _load_period_axes(conn, doc_id)
    sheet_roles = (
        {
            str(row["sheet_name"]): str(row["sheet_role"] or "")
            for row in conn.execute(
                "SELECT sheet_name, sheet_role FROM excel_sheets WHERE doc_id=?",
                (doc_id,),
            )
        }
        if _table_exists(conn, "excel_sheets")
        else {}
    )
    facts = conn.execute(
        """
        SELECT fact_id, metric_name, period, value_text, value_numeric, unit,
               sheet_name, cell_ref, source_range, confidence, quality_status
        FROM metric_facts
        WHERE doc_id=? AND value_numeric IS NOT NULL AND COALESCE(period,'')<>''
          AND COALESCE(quality_status,'review_required')<>'rejected'
        ORDER BY sheet_name, cell_ref, fact_id
        """,
        (doc_id,),
    ).fetchall()
    groups: dict[tuple[str, str, str], dict[str, Any]] = {}
    review_required_count = 0
    for fact in facts:
        sheet_name = str(fact["sheet_name"] or "")
        normalized_sheet_name = _normalize(sheet_name)
        if sheet_roles.get(sheet_name) == "raw_upload" or any(
            marker in normalized_sheet_name
            for marker in ("upload", "download", "raw data", "bloomberg", "fdscache")
        ):
            continue
        row_index = _cell_row(fact["cell_ref"])
        statement_type = _statement_for_fact(
            sheet_name=sheet_name,
            row_index=row_index,
            metric_name=str(fact["metric_name"] or ""),
            anchors=anchors,
        )
        if not statement_type:
            continue
        quality_status = str(fact["quality_status"] or "review_required")
        if quality_status != "candidate_complete":
            review_required_count += 1
        metric_name = str(fact["metric_name"] or "未命名指标").strip()
        key = (statement_type, sheet_name, _normalize(metric_name))
        group = groups.setdefault(
            key,
            {
                "statement_type": statement_type,
                "sheet_name": sheet_name,
                "authoritative_sheet": bool(
                    _sheet_statement(sheet_name) or anchors.get(sheet_name)
                ),
                "metric_name": metric_name,
                "row_index": row_index,
                "unit": str(fact["unit"] or ""),
                "values": {},
            },
        )
        group["row_index"] = min(int(group["row_index"] or row_index), row_index)
        period = str(fact["period"] or "").strip()
        if _sheet_statement(sheet_name) or anchors.get(sheet_name):
            period = period_axes.get(sheet_name, {}).get(_cell_col(fact["cell_ref"]), period)
        candidate = {
            "period": period,
            "value": _safe_float(fact["value_numeric"]),
            "value_text": str(fact["value_text"] or ""),
            "evidence_id": f"fact:{fact['fact_id']}",
            "source": str(fact["source_range"] or f"{fact['sheet_name']}!{fact['cell_ref']}"),
            "quality_status": quality_status,
            "confidence": float(fact["confidence"] or 0.5),
        }
        current = group["values"].get(period)
        score = candidate["confidence"] + (1.0 if quality_status == "candidate_complete" else 0.0)
        current_score = (
            float(current["confidence"])
            + (1.0 if current["quality_status"] == "candidate_complete" else 0.0)
            if current
            else -1.0
        )
        if current is None or score > current_score:
            group["values"][period] = candidate

    by_statement_sheet: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for group in groups.values():
        by_statement_sheet.setdefault(
            (str(group["statement_type"]), str(group["sheet_name"])), []
        ).append(group)

    tables: list[dict[str, Any]] = []
    for statement_type in _STATEMENT_ORDER:
        candidates = [
            (sheet_name, rows)
            for (kind, sheet_name), rows in by_statement_sheet.items()
            if kind == statement_type
        ]
        if not candidates:
            continue
        sheet_name, rows = max(
            candidates,
            key=lambda item: (
                100_000 if any(bool(row.get("authoritative_sheet")) for row in item[1]) else 0,
                sum(len(row["values"]) for row in item[1]),
                len(item[1]),
            ),
        )
        periods = sorted(
            {period for row in rows for period in row["values"]}, key=_period_sort_key
        )[-10:]
        ranked = sorted(
            rows,
            key=lambda row: (
                (_metric_profile(statement_type, row["metric_name"]) or ("", 999))[1],
                -len(row["values"]),
                row["row_index"],
            ),
        )
        selected = sorted(ranked[:16], key=lambda row: row["row_index"])
        output_rows: list[dict[str, Any]] = []
        for row in selected:
            profile = _metric_profile(statement_type, row["metric_name"])
            values = [row["values"].get(period) for period in periods]
            output_rows.append(
                {
                    "metric_key": profile[0] if profile else "",
                    "metric_name": row["metric_name"],
                    "unit": row["unit"],
                    "row_index": row["row_index"],
                    "values": values,
                }
            )
        source_refs = sorted(
            {
                value["source"]
                for row in output_rows
                for value in row["values"]
                if value is not None
            }
        )
        tables.append(
            {
                "statement_type": statement_type,
                "title": STATEMENT_LABELS[statement_type],
                "sheet_name": sheet_name,
                "periods": periods,
                "rows": output_rows,
                "source_refs": source_refs[:20],
            }
        )
    return tables, {
        "fact_count": len(facts),
        "review_required_count": review_required_count,
    }


def _build_trends(tables: list[dict[str, Any]]) -> list[dict[str, Any]]:
    selected: dict[str, dict[str, Any]] = {}
    for table in tables:
        for row in table["rows"]:
            metric_key = str(row.get("metric_key") or "")
            values = [value for value in row["values"] if value is not None]
            if not metric_key or len(values) < 2:
                continue
            candidate = {
                "metric_key": metric_key,
                "label": row["metric_name"],
                "statement_type": table["statement_type"],
                "unit": row["unit"],
                "sheet_name": table["sheet_name"],
                "values": [
                    {
                        "period": value["period"],
                        "value": value["value"],
                        "evidence_id": value["evidence_id"],
                        "source": value["source"],
                    }
                    for value in values
                ],
            }
            current = selected.get(metric_key)
            if current is None or len(candidate["values"]) > len(current["values"]):
                selected[metric_key] = candidate
    preferred = [
        "revenue",
        "gross_profit",
        "gross_margin",
        "ebitda",
        "net_profit",
        "operating_cash_flow",
        "free_cash_flow",
        "capex",
        "total_assets",
        "net_debt",
    ]
    ordered = [selected[key] for key in preferred if key in selected]
    return ordered[:6]


def _key_metrics(conn: sqlite3.Connection, model_version_id: str) -> list[dict[str, Any]]:
    required = {"valuation_model_nodes", "valuation_model_node_values"}
    if not all(_table_exists(conn, table) for table in required):
        return []
    rows = conn.execute(
        """
        SELECT n.metric_key, n.display_name, n.period, n.node_kind,
               v.value_numeric, v.value_text, v.unit, v.evidence_id,
               v.sheet_name, v.cell_ref, v.confidence
        FROM valuation_model_node_values v
        JOIN valuation_model_nodes n ON n.node_id=v.node_id
        WHERE v.model_version_id=?
        ORDER BY n.metric_key, n.period, v.confidence DESC
        """,
        (model_version_id,),
    ).fetchall()
    by_metric: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        by_metric.setdefault(str(row["metric_key"]), []).append(row)
    metrics: list[dict[str, Any]] = []
    for metric_key in _KEY_METRIC_ORDER:
        candidates = by_metric.get(metric_key) or []
        if not candidates:
            continue
        row = max(
            candidates,
            key=lambda item: (
                _period_sort_key(item["period"]),
                float(item["confidence"] or 0.5),
            ),
        )
        metrics.append(
            {
                "metric_key": metric_key,
                "label": str(row["display_name"] or metric_key),
                "period": str(row["period"] or ""),
                "value_numeric": _safe_float(row["value_numeric"]),
                "value_text": str(row["value_text"] or ""),
                "unit": str(row["unit"] or ""),
                "evidence_id": str(row["evidence_id"] or ""),
                "source": f"{row['sheet_name']}!{row['cell_ref']}",
            }
        )
        if len(metrics) >= 6:
            break
    return metrics


def build_overview_data(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    series: dict[str, Any],
    version: dict[str, Any],
) -> dict[str, Any]:
    tables, extraction = _extract_statement_tables(conn, str(version["doc_id"]))
    trends = _build_trends(tables)
    key_metrics = _key_metrics(conn, str(version["model_version_id"]))
    detected = [table["statement_type"] for table in tables]
    missing = [item for item in _STATEMENT_ORDER if item not in detected]
    periods = sorted(
        {period for table in tables for period in table["periods"]}, key=_period_sort_key
    )
    quality_flags: list[str] = []
    if missing:
        quality_flags.append("missing_statements")
    if not trends:
        quality_flags.append("trend_series_missing")
    if extraction["review_required_count"]:
        quality_flags.append("facts_require_review")
    if not periods:
        quality_flags.append("period_axis_missing")
    return {
        "schema_version": 1,
        "overview_version": VALUATION_OVERVIEW_VERSION,
        "dataset_id": dataset_id,
        "series_id": str(series["series_id"]),
        "model_version_id": str(version["model_version_id"]),
        "model_version_no": int(version.get("document_version_no") or 0),
        "model_name": str(series.get("name") or "估值模型"),
        "company_name": str(series.get("company_name") or ""),
        "company_ticker": str(series.get("company_ticker") or ""),
        "model_type": str(version.get("model_type") or series.get("model_type") or ""),
        "original_filename": str(version.get("original_filename") or ""),
        "generated_at": _now_iso(),
        "summary": {
            "detected_statements": detected,
            "missing_statements": missing,
            "statement_count": len(detected),
            "trend_count": len(trends),
            "key_metric_count": len(key_metrics),
            "period_start": periods[0] if periods else "",
            "period_end": periods[-1] if periods else "",
            "periods": periods,
            "fact_count": extraction["fact_count"],
            "review_required_count": extraction["review_required_count"],
            "quality_flags": quality_flags,
        },
        "key_metrics": key_metrics,
        "trends": trends,
        "statements": tables,
    }


def _format_number(value: Any, unit: str = "") -> str:
    number = _safe_float(value)
    if number is None:
        return "—"
    if unit == "%":
        normalized = number * 100 if abs(number) <= 2 else number
        return f"{normalized:,.1f}%"
    magnitude = abs(number)
    if magnitude >= 1_000:
        return f"{number:,.0f}"
    if magnitude >= 10:
        return f"{number:,.1f}"
    return f"{number:,.2f}"


def _metric_value(metric: dict[str, Any]) -> str:
    if metric.get("value_numeric") is not None:
        return _format_number(metric["value_numeric"], str(metric.get("unit") or ""))
    return str(metric.get("value_text") or "—")


def _trend_svg(trend: dict[str, Any]) -> str:
    values = [item for item in trend["values"] if _safe_float(item.get("value")) is not None]
    if len(values) < 2:
        return ""
    numbers = [float(item["value"]) for item in values]
    low, high = min(numbers), max(numbers)
    span = high - low or max(abs(high), 1.0)
    width, height = 640.0, 210.0
    left, right, top, bottom = 34.0, 18.0, 20.0, 42.0
    plot_width, plot_height = width - left - right, height - top - bottom
    points: list[tuple[float, float]] = []
    for index, number in enumerate(numbers):
        x = left + (plot_width * index / max(1, len(numbers) - 1))
        y = top + ((high - number) / span) * plot_height
        points.append((x, y))
    color = STATEMENT_COLORS.get(str(trend.get("statement_type")), "#176B5B")
    polyline = " ".join(f"{x:.1f},{y:.1f}" for x, y in points)
    area = f"{left:.1f},{top + plot_height:.1f} {polyline} {left + plot_width:.1f},{top + plot_height:.1f}"
    circles = "".join(
        f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3.5"><title>{escape(str(item["period"]))}: {escape(_format_number(item["value"], str(trend.get("unit") or "")))}</title></circle>'
        for (x, y), item in zip(points, values, strict=True)
    )
    labels = "".join(
        f'<text x="{x:.1f}" y="190" text-anchor="middle">{escape(str(item["period"]))}</text>'
        for index, ((x, _), item) in enumerate(zip(points, values, strict=True))
        if len(values) <= 7 or index in {0, len(values) - 1} or index % 2 == 0
    )
    return (
        f'<svg viewBox="0 0 {int(width)} {int(height)}" role="img" '
        f'aria-label="{escape(str(trend["label"]))} 趋势">'
        '<line class="axis" x1="34" y1="168" x2="622" y2="168" />'
        f'<polygon class="area" style="fill:{color}" points="{area}" />'
        f'<polyline class="trend-line" style="stroke:{color}" points="{polyline}" />'
        f'<g class="points" style="fill:{color}">{circles}</g>'
        f'<g class="x-labels">{labels}</g>'
        f'<text class="range-label" x="34" y="14">高 {_format_number(high, str(trend.get("unit") or ""))}</text>'
        f'<text class="range-label" x="622" y="164" text-anchor="end">低 {_format_number(low, str(trend.get("unit") or ""))}</text>'
        "</svg>"
    )


def render_overview_html(overview: dict[str, Any]) -> str:
    summary = overview["summary"]
    coverage = "".join(
        (
            f'<span class="coverage ok"><span>✓</span>{escape(STATEMENT_LABELS[item])}</span>'
            if item in summary["detected_statements"]
            else f'<span class="coverage missing"><span>–</span>{escape(STATEMENT_LABELS[item])}</span>'
        )
        for item in _STATEMENT_ORDER
    )
    metric_cards = "".join(
        f'<article class="metric-card"><p>{escape(str(metric["label"]))}</p>'
        f"<strong>{escape(_metric_value(metric))}</strong>"
        f"<small>{escape(str(metric.get('period') or '当前'))} · {escape(str(metric.get('source') or ''))}</small></article>"
        for metric in overview["key_metrics"]
    )
    if not metric_cards:
        metric_cards = '<article class="empty-card">尚未从模型中稳定识别目标价、WACC 等关键估值输出。</article>'
    trend_cards = "".join(
        f'<article class="chart-card"><div class="card-heading"><div><p>{escape(STATEMENT_LABELS.get(trend["statement_type"], "趋势"))}</p>'
        f"<h3>{escape(str(trend['label']))}</h3></div><span>{escape(str(trend.get('unit') or '原表口径'))}</span></div>"
        f"{_trend_svg(trend)}<footer>{escape(str(trend['sheet_name']))} · {len(trend['values'])} 个期间</footer></article>"
        for trend in overview["trends"]
    )
    if not trend_cards:
        trend_cards = (
            '<article class="empty-card">未找到至少两个期间的连续指标，暂不绘制趋势。</article>'
        )

    statement_cards: list[str] = []
    for table in overview["statements"]:
        head = "".join(f"<th>{escape(str(period))}</th>" for period in table["periods"])
        body_rows = []
        for row in table["rows"]:
            values = "".join(
                f"<td>{escape(_format_number(value['value'], str(row.get('unit') or ''))) if value else '—'}</td>"
                for value in row["values"]
            )
            body_rows.append(
                f"<tr><th><span>{escape(str(row['metric_name']))}</span>"
                f"<small>{escape(str(row.get('unit') or ''))}</small></th>{values}</tr>"
            )
        statement_cards.append(
            f'<article class="statement-card"><div class="statement-heading"><div><p>KEY TABLE</p>'
            f"<h2>{escape(str(table['title']))}</h2></div><span>{escape(str(table['sheet_name']))}</span></div>"
            f'<div class="table-scroll"><table><thead><tr><th>指标</th>{head}</tr></thead>'
            f"<tbody>{''.join(body_rows)}</tbody></table></div>"
            f"<footer>已提取 {len(table['rows'])} 行 · {len(table['periods'])} 个期间 · 数值可回溯到原始单元格</footer></article>"
        )
    if not statement_cards:
        statement_cards.append(
            '<article class="empty-card">三表尚未稳定识别。模型可能使用非标准命名，或入库事实缺少期间标签。</article>'
        )

    quality_note = (
        f"{summary['review_required_count']} 条候选事实需要复核"
        if summary["review_required_count"]
        else "已提取事实均通过当前确定性完整性检查"
    )
    period_text = (
        f"{summary['period_start']} – {summary['period_end']}"
        if summary["period_start"] and summary["period_end"]
        else "期间待识别"
    )
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <title>{escape(str(overview["model_name"]))} · 估值模型总览</title>
  <style>
    :root {{ color-scheme: light dark; --bg:#f5f6f3; --panel:#fffefb; --ink:#202421; --muted:#66706a; --line:#dde2dd; --accent:#176b5b; --soft:#eaf4ef; }}
    * {{ box-sizing:border-box }}
    html,body {{ margin:0; min-height:100%; background:var(--bg); color:var(--ink); font:13px/1.5 Inter,"Noto Sans SC",system-ui,-apple-system,sans-serif }}
    body {{ padding:24px }} main {{ width:min(1440px,100%); margin:auto }}
    header.hero {{ display:flex; justify-content:space-between; gap:24px; align-items:flex-end; padding:24px; border:1px solid var(--line); border-radius:18px; background:var(--panel) }}
    .eyebrow,.card-heading p,.statement-heading p {{ margin:0 0 6px; color:var(--accent); font-size:10px; font-weight:700; letter-spacing:.16em }}
    h1 {{ margin:0; font-size:clamp(22px,3vw,36px); letter-spacing:-.035em }} .subtitle {{ margin:8px 0 0; color:var(--muted) }}
    .hero-meta {{ text-align:right; color:var(--muted); font-size:11px }} .hero-meta strong {{ display:block; color:var(--ink); font-size:13px }}
    .coverage-row {{ display:flex; flex-wrap:wrap; gap:8px; margin:16px 0 }} .coverage {{ display:inline-flex; gap:6px; align-items:center; padding:6px 10px; border:1px solid var(--line); border-radius:999px; background:var(--panel); color:var(--muted); font-size:11px }}
    .coverage.ok {{ border-color:#b9d8c8; background:var(--soft); color:#135a4d }} .coverage.missing {{ border-style:dashed }}
    .metric-grid,.chart-grid {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px }}
    .metric-card,.chart-card,.statement-card,.empty-card {{ border:1px solid var(--line); border-radius:16px; background:var(--panel) }}
    .metric-card {{ padding:16px }} .metric-card p {{ margin:0; color:var(--muted); font-size:11px }} .metric-card strong {{ display:block; margin-top:8px; font-size:24px; letter-spacing:-.025em }} .metric-card small {{ display:block; margin-top:5px; overflow:hidden; color:var(--muted); text-overflow:ellipsis; white-space:nowrap }}
    section {{ margin-top:28px }} section>h2 {{ margin:0 0 12px; font-size:15px }}
    .chart-card {{ padding:16px }} .card-heading,.statement-heading {{ display:flex; justify-content:space-between; gap:16px; align-items:flex-start }} .card-heading h3,.statement-heading h2 {{ margin:0; font-size:15px }} .card-heading>span,.statement-heading>span {{ max-width:45%; overflow:hidden; color:var(--muted); font-size:10px; text-overflow:ellipsis; white-space:nowrap }}
    svg {{ display:block; width:100%; height:auto; margin-top:8px }} .axis {{ stroke:var(--line) }} .area {{ opacity:.10 }} .trend-line {{ fill:none; stroke-width:3; stroke-linecap:round; stroke-linejoin:round }} .points circle {{ stroke:var(--panel); stroke-width:2 }} .x-labels,.range-label {{ fill:var(--muted); font-size:9px }}
    .chart-card footer,.statement-card footer {{ margin-top:8px; color:var(--muted); font-size:10px }}
    .statements {{ display:grid; gap:16px }} .statement-card {{ padding:18px }} .table-scroll {{ overflow:auto; margin-top:14px; border:1px solid var(--line); border-radius:10px }}
    table {{ width:100%; min-width:760px; border-collapse:collapse; font-variant-numeric:tabular-nums }} th,td {{ padding:9px 10px; border-bottom:1px solid var(--line); text-align:right; white-space:nowrap }} thead th {{ position:sticky; top:0; background:var(--soft); color:var(--muted); font-size:10px }} th:first-child {{ position:sticky; left:0; z-index:1; min-width:190px; background:var(--panel); text-align:left }} thead th:first-child {{ z-index:2; background:var(--soft) }} tbody th span {{ display:block }} tbody th small {{ color:var(--muted); font-weight:400 }} tbody tr:last-child th,tbody tr:last-child td {{ border-bottom:0 }}
    .empty-card {{ padding:24px; color:var(--muted); text-align:center }} .audit {{ margin-top:20px; padding:14px 16px; border-left:3px solid var(--accent); background:var(--soft); color:var(--muted); font-size:11px }}
    @media (prefers-color-scheme:dark) {{ :root {{ --bg:#191c19; --panel:#222622; --ink:#f1f3ef; --muted:#abb4ad; --line:#394039; --accent:#88c5aa; --soft:#243a31 }} .coverage.ok {{ color:#b8e5d2; border-color:#416755 }} }}
    @media (max-width:720px) {{ body {{ padding:12px }} header.hero {{ align-items:flex-start; flex-direction:column }} .hero-meta {{ text-align:left }} }}
  </style>
</head>
<body>
<main>
  <header class="hero"><div><p class="eyebrow">VALUATION MODEL OVERVIEW</p><h1>{escape(str(overview["model_name"]))}</h1><p class="subtitle">{escape(str(overview.get("company_name") or "公司待识别"))} {escape(str(overview.get("company_ticker") or ""))} · v{overview["model_version_no"]} · {escape(str(overview.get("model_type") or "估值模型"))}</p></div><div class="hero-meta"><strong>{escape(str(overview["original_filename"]))}</strong><span>{escape(period_text)} · {summary["fact_count"]} 条候选事实</span></div></header>
  <div class="coverage-row">{coverage}</div>
  <div class="metric-grid">{metric_cards}</div>
  <section><h2>核心走势</h2><div class="chart-grid">{trend_cards}</div></section>
  <section><h2>关键财务表</h2><div class="statements">{"".join(statement_cards)}</div></section>
  <div class="audit">{escape(quality_note)}。本页仅展示已入库的结构化事实，不执行宏、外链、公式重算，也不改写原始工作簿。</div>
</main>
</body>
</html>"""


def _overview_payload(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    payload = dict(row)
    payload["overview"] = _decode(payload.pop("overview_json", None), {})
    return payload


def ensure_model_overview(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    series: dict[str, Any],
    version: dict[str, Any],
) -> dict[str, Any]:
    existing = conn.execute(
        """
        SELECT * FROM valuation_model_overviews
        WHERE model_version_id=? AND overview_version=?
        """,
        (version["model_version_id"], VALUATION_OVERVIEW_VERSION),
    ).fetchone()
    if existing is not None:
        return _overview_payload(existing)
    overview = build_overview_data(conn, dataset_id=dataset_id, series=series, version=version)
    html = render_overview_html(overview)
    overview_id = f"vmo_{_digest(version['model_version_id'], VALUATION_OVERVIEW_VERSION)}"
    conn.execute(
        """
        INSERT OR IGNORE INTO valuation_model_overviews
            (overview_id, dataset_id, series_id, model_version_id, doc_id,
             status, overview_json, html, overview_version, created_at)
        VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)
        """,
        (
            overview_id,
            dataset_id,
            series["series_id"],
            version["model_version_id"],
            version["doc_id"],
            _json(overview),
            html,
            VALUATION_OVERVIEW_VERSION,
            overview["generated_at"],
        ),
    )
    row = conn.execute(
        """
        SELECT * FROM valuation_model_overviews
        WHERE model_version_id=? AND overview_version=?
        """,
        (version["model_version_id"], VALUATION_OVERVIEW_VERSION),
    ).fetchone()
    if row is None:
        raise RuntimeError("failed to persist valuation-model overview")
    return _overview_payload(row)
