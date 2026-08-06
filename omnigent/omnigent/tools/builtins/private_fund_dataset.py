"""Private-fund dataset tools backed by the structured SQLite pipeline."""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import unicodedata
from datetime import datetime
from html import escape
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from uuid import uuid4

from omnigent.tools.base import Tool, ToolContext

_DEFAULT_TOP_K = 5
_MAX_TOP_K = 30
_MAX_EXCERPT_CHARS = 500
_MAX_DETAIL_CONTENT_CHARS = 6000
_MAX_DETAIL_PAGE_CHARS = 3500
_MAX_CELL_ROWS = 48
_MAX_CELL_ROWS_HARD = 80
_MAX_SEARCH_PAYLOAD_CHARS = 42000
_MAX_DETAIL_PAYLOAD_CHARS = 45000
_PDF_SOURCE_HASH = "#private-fund-pdf-source"
_EXCEL_SOURCE_HASH = "#private-fund-excel-source"

_SEARCH_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "query": {
            "type": "string",
            "description": "Research question or search query.",
        },
        "dataset_id": {
            "type": "string",
            "description": "Optional dataset id. Defaults to the active dataset.",
        },
        "top_k": {
            "type": "integer",
            "description": "Maximum evidence cards to return. Defaults to 5 (max 30).",
        },
        "include_metric_facts": {
            "type": "boolean",
            "description": (
                "Search structured Excel metric facts. Default false; set true for "
                "financial metrics / model numbers."
            ),
        },
        "include_cells": {
            "type": "boolean",
            "description": "Whether to search raw Excel cells. Use sparingly.",
        },
        "compact": {
            "type": "boolean",
            "description": (
                "Return slim evidence cards (default true). Set false only when a "
                "downstream tool needs the full audit payload."
            ),
        },
        "include_expanded_terms": {
            "type": "boolean",
            "description": "Include query term expansion list. Default false.",
        },
    },
    "required": ["query"],
}

_STATUS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "dataset_id": {
            "type": "string",
            "description": "Optional dataset id. Defaults to the active dataset.",
        }
    },
}

_EQUITY_REPORT_GENERATE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "dataset_id": {"type": "string"},
        "title": {"type": "string"},
        "sector": {"type": "string"},
        "rating": {"type": "string"},
        "report_date": {"type": "string"},
        "market_snapshot": {"type": "object"},
        "financial_metrics": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "metric": {"type": "string"},
                    "values": {"type": "object"},
                },
                "required": ["metric", "values"],
            },
        },
        "sections": {
            "type": "object",
            "description": (
                "FinRobot report narratives keyed by tagline, company_overview, "
                "investment_overview, valuation_overview, risks, competitor_analysis, "
                "major_takeaways, and news_summary."
            ),
        },
        "section_evidence": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "section": {"type": "string"},
                    "evidence_ids": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["section", "evidence_ids"],
            },
        },
    },
    "required": ["title", "sections", "section_evidence"],
}

_EQUITY_REPORT_LOOKUP_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "dataset_id": {"type": "string"},
        "run_id": {
            "type": "string",
            "description": "Report run id. Omit to retrieve the latest run.",
        },
    },
}

_SOURCE_DETAIL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "evidence_id": {
            "type": "string",
            "description": "Evidence id returned by private_fund_dataset_search.",
        },
        "dataset_id": {
            "type": "string",
            "description": "Optional dataset id. Defaults to the active dataset.",
        },
        "context_radius": {
            "type": "integer",
            "description": "Rows/pages around the source to include when possible. Default 1.",
        },
        "mode": {
            "type": "string",
            "description": (
                "Response shape: auto|meta|text|excel_window|full. "
                "Default auto (text for PDF chunks, excel_window for fact/cell). "
                "Use full only when you truly need the complete payload."
            ),
        },
        "max_chars": {
            "type": "integer",
            "description": "Max characters for content/page text windows. Default 6000.",
        },
        "max_cells": {
            "type": "integer",
            "description": "Max Excel cells to return in a window. Default 48.",
        },
    },
    "required": ["evidence_id"],
}

_MEMO_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "topic": {
            "type": "string",
            "description": "Memo topic, company question, or investment angle.",
        },
        "dataset_id": {
            "type": "string",
            "description": "Optional dataset id. Defaults to the active dataset.",
        },
        "sections": {
            "type": "array",
            "description": "Optional section names or section query strings.",
            "items": {"type": "string"},
        },
        "instructions": {
            "type": "string",
            "description": (
                "Optional user instructions for this memo, including revision requests."
            ),
        },
        "conversation_context": {
            "type": "string",
            "description": (
                "Optional concise summary of relevant chat context and key questions "
                "to incorporate."
            ),
        },
        "revision_of": {
            "type": "string",
            "description": "Optional prior memo path or identifier when revising an earlier memo.",
        },
        "memo_markdown": {
            "type": "string",
            "description": (
                "Compatibility input for assistant-authored final Memo Markdown. Prefer "
                "memo_claims for ordinary claim-based Memos; use Markdown only when the "
                "requested layout cannot be represented by structured claims. All lines still "
                "pass Citation Gate before persistence."
            ),
        },
        "memo_claims": {
            "type": "array",
            "description": (
                "Preferred structured memo contract. The service validates evidence_ids and "
                "renders source citations. Each item is one claim; do not put citation syntax "
                "inside text."
            ),
            "items": {
                "type": "object",
                "properties": {
                    "section": {"type": "string"},
                    "text": {"type": "string"},
                    "status": {
                        "type": "string",
                        "enum": ["supported", "not_covered", "needs_review"],
                    },
                    "evidence_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                },
                "required": ["section", "text", "status", "evidence_ids"],
            },
        },
        "key_questions": {
            "type": "array",
            "description": "Optional key research questions that should be reflected in the memo.",
            "items": {"type": "string"},
        },
        "top_k_per_section": {
            "type": "integer",
            "description": "Evidence units per memo section. Defaults to 5.",
        },
    },
}

_RESEARCH_CONTEXT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "dataset_id": {"type": "string", "description": "Private-fund dataset id."},
    },
}

_RESEARCH_HISTORY_COMPARE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "dataset_id": {"type": "string"},
        "mode": {"type": "string", "enum": ["memo", "item"]},
        "from_version_id": {"type": "string"},
        "to_version_id": {"type": "string"},
        "item_id": {"type": "string"},
    },
}

_RESEARCH_TRACKING_LIST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "dataset_id": {"type": "string"},
        "view": {
            "type": "string",
            "enum": ["overview", "items", "alerts", "jobs", "watch_rules", "memo_versions"],
        },
        "item_type": {
            "type": "string",
            "enum": ["thesis", "assumption", "risk", "catalyst", "metric", "question"],
        },
        "status": {"type": "string"},
        "alert_status": {
            "type": "string",
            "enum": ["new", "acknowledged", "dismissed", "snoozed"],
        },
    },
}

_RESEARCH_WATCH_UPSERT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "dataset_id": {"type": "string"},
        "rule_id": {"type": "string"},
        "name": {"type": "string"},
        "target_type": {
            "type": "string",
            "enum": ["all", "thesis", "assumption", "risk", "catalyst", "metric", "question"],
        },
        "target_item_id": {"type": "string"},
        "query": {"type": "object"},
        "min_priority": {
            "type": "string",
            "enum": ["low", "medium", "high", "critical"],
        },
        "frequency": {"type": "string"},
        "active": {"type": "boolean"},
    },
    "required": ["name", "target_type"],
}

_RESEARCH_ALERT_ACK_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "dataset_id": {"type": "string"},
        "alert_id": {"type": "string"},
        "status": {
            "type": "string",
            "enum": ["new", "acknowledged", "dismissed", "snoozed"],
        },
        "snoozed_until": {"type": "string"},
    },
    "required": ["alert_id"],
}

_RICH_CONTENT_BLOCK_SCHEMA: dict[str, Any] = {
    "oneOf": [
        {
            "type": "object",
            "properties": {
                "type": {"const": "markdown"},
                "title": {"type": "string"},
                "markdown": {"type": "string"},
            },
            "required": ["type", "markdown"],
        },
        {
            "type": "object",
            "properties": {
                "type": {"const": "metrics"},
                "title": {"type": "string"},
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string"},
                            "value": {"type": ["string", "number"]},
                            "unit": {"type": "string"},
                            "delta": {"type": "string"},
                            "sentiment": {
                                "type": "string",
                                "enum": ["positive", "negative", "neutral"],
                            },
                        },
                        "required": ["label", "value"],
                    },
                },
            },
            "required": ["type", "items"],
        },
        {
            "type": "object",
            "properties": {
                "type": {"const": "table"},
                "title": {"type": "string"},
                "columns": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "key": {"type": "string"},
                            "label": {"type": "string"},
                            "align": {"type": "string", "enum": ["left", "right"]},
                        },
                        "required": ["key", "label"],
                    },
                },
                "rows": {"type": "array", "items": {"type": "object"}},
            },
            "required": ["type", "columns", "rows"],
        },
        {
            "type": "object",
            "properties": {
                "type": {"const": "chart"},
                "title": {"type": "string"},
                "chart_type": {"type": "string", "enum": ["line", "bar"]},
                "x_key": {"type": "string"},
                "series": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "key": {"type": "string"},
                            "label": {"type": "string"},
                        },
                        "required": ["key", "label"],
                    },
                },
                "data": {"type": "array", "items": {"type": "object"}},
                "y_unit": {"type": "string"},
                "source_note": {"type": "string"},
            },
            "required": ["type", "chart_type", "x_key", "series", "data"],
        },
        {
            "type": "object",
            "properties": {
                "type": {"const": "html"},
                "title": {"type": "string"},
                "html": {
                    "type": "string",
                    "description": (
                        "Self-contained HTML. Inline CSS/JavaScript may render verified data "
                        "with native SVG/Canvas inside a no-network opaque-origin sandbox."
                    ),
                },
                "height": {"type": "integer", "minimum": 160, "maximum": 720},
            },
            "required": ["type", "html"],
        },
    ]
}
for _block_variant in _RICH_CONTENT_BLOCK_SCHEMA["oneOf"]:
    _block_variant["properties"]["evidence_ids"] = {
        "type": "array",
        "items": {"type": "string", "pattern": "^(chunk|fact|cell):"},
        "description": "Evidence IDs that directly support this presentation block.",
    }

_RESEARCH_NODE_SAVE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "dataset_id": {"type": "string", "description": "Private-fund dataset id."},
        "title": {"type": "string", "description": "Short, specific research node title."},
        "summary": {"type": "string", "description": "One-sentence node summary."},
        "content_markdown": {
            "type": "string",
            "description": (
                "Structured node body with conclusion, supporting information, uncertainty, "
                "and next questions. Preserve source citations."
            ),
        },
        "node_type": {
            "type": "string",
            "enum": [
                "insight",
                "hypothesis",
                "question",
                "risk",
                "catalyst",
                "comparison",
                "decision",
            ],
        },
        "parent_node_ids": {"type": "array", "items": {"type": "string"}},
        "evidence_ids": {"type": "array", "items": {"type": "string"}},
        "tags": {"type": "array", "items": {"type": "string"}},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        "source_response_ids": {"type": "array", "items": {"type": "string"}},
        "content_blocks": {
            "type": "array",
            "description": (
                "Optional ordered presentation blocks. Choose only formats that improve the "
                "analysis: markdown, metrics, table, legacy line/bar chart, or sandboxed HTML. "
                "For the unified chart output, save one self-contained HTML block with inline "
                "CSS/JavaScript and verified data. It may render line, bar, pie/donut, area, "
                "scatter, radar, waterfall, or heatmap visuals using native SVG/Canvas, but must "
                "not use external resources, network APIs, forms, navigation, or parent access."
            ),
            "items": _RICH_CONTENT_BLOCK_SCHEMA,
            "maxItems": 12,
        },
    },
    "required": ["title", "summary", "content_markdown"],
}


_TERM_SYNONYMS: dict[str, list[str]] = {
    "收入": ["revenue", "sales"],
    "营收": ["revenue", "sales"],
    "销售": ["revenue", "sales"],
    "毛利": ["gross profit"],
    "毛利率": ["gross margin"],
    "利润": ["profit", "net profit", "net income"],
    "净利": ["net profit", "net income"],
    "净利润": ["net profit", "net income"],
    "估值": ["valuation", "dcf", "pe", "peg"],
    "现金流": ["cash flow", "fcf", "free cash flow"],
    "储能": ["energy storage", "storage"],
    "逆变器": ["inverter", "pv inverter"],
    "光伏": ["solar", "pv"],
    "订单": ["order", "orders"],
    "出货": ["shipment", "shipments"],
    "增长": ["growth", "yoy", "cagr"],
    "风险": ["risk"],
    "催化": ["catalyst", "order", "growth"],
    "盈利": ["profit", "margin", "earnings"],
}


def _json(payload: Any, *, compact: bool = True) -> str:
    """Serialize tool payloads. Compact by default to keep MCP under token limits."""
    if compact:
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return json.dumps(payload, ensure_ascii=False, indent=2)


def _clip_text(value: Any, max_chars: int) -> str:
    text = _normalize(value)
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    if max_chars <= 3:
        return text[:max_chars]
    return text[: max_chars - 3].rstrip() + "..."


def _compact_cell_dict(cell: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "ref": cell.get("cell_ref") or cell.get("ref"),
        "r": cell.get("row_index") if cell.get("row_index") is not None else cell.get("r"),
        "c": cell.get("col_index") if cell.get("col_index") is not None else cell.get("c"),
        "v": cell.get("display_value") if cell.get("display_value") is not None else cell.get("v"),
    }
    for key in ("row_label", "col_label", "period", "unit"):
        if cell.get(key) not in (None, ""):
            out[key] = cell.get(key)
    return {k: v for k, v in out.items() if v is not None}


def _compact_search_evidence(item: dict[str, Any]) -> dict[str, Any]:
    """Project a full evidence unit into an agent-friendly card."""
    excerpt = item.get("excerpt") or item.get("summary") or ""
    if not isinstance(excerpt, str):
        excerpt = str(excerpt)
    card: dict[str, Any] = {
        "evidence_id": item.get("evidence_id"),
        "evidence_type": item.get("evidence_type"),
        "score": item.get("score"),
        "content_type": item.get("content_type"),
        "citation": item.get("citation"),
        "markdown_citation": item.get("markdown_citation"),
        "excerpt": _clip_text(excerpt, _MAX_EXCERPT_CHARS),
    }
    if item.get("title_path"):
        card["title_path"] = item.get("title_path")
    source = item.get("source") or {}
    locator: dict[str, Any] = {}
    for key in (
        "page_start",
        "page_end",
        "sheet_name",
        "cell_range",
        "slide_start",
        "slide_end",
        "heading_path",
        "source_url",
    ):
        if source.get(key) not in (None, ""):
            locator[key] = source.get(key)
    if locator:
        card["locator"] = locator
    document = item.get("document") or {}
    filename = document.get("filename") or document.get("original_filename")
    if filename:
        card["filename"] = filename
    metric = item.get("metric")
    if isinstance(metric, dict) and metric:
        card["metric"] = {
            key: metric.get(key)
            for key in ("name", "period", "value_text", "value_numeric", "unit")
            if metric.get(key) not in (None, "")
        }
    return {k: v for k, v in card.items() if v is not None}


def _project_search_for_agent(
    result: dict[str, Any],
    *,
    compact: bool = True,
    include_expanded_terms: bool = False,
) -> dict[str, Any]:
    dataset = result.get("dataset") or {}
    evidence = list(result.get("evidence") or [])
    if compact:
        evidence = [_compact_search_evidence(item) for item in evidence]
    payload: dict[str, Any] = {
        "dataset": {
            "dataset_id": dataset.get("dataset_id"),
            "name": dataset.get("name"),
            "company_name": dataset.get("company_name") or "",
            "company_ticker": dataset.get("company_ticker") or "",
        },
        "query": result.get("query"),
        "evidence": evidence,
        "evidence_count": len(evidence),
        "evidence_fusion": result.get("evidence_fusion")
        or {"enabled": False, "available": False},
        "answer_contract": result.get("answer_contract")
        or (
            "Answer only from returned evidence. Cite each material claim with "
            "markdown_citation when present, otherwise citation."
        ),
        "hint": (
            "When evidence_fusion.available is true, use its fused DCI + scoped RAG context. "
            "Compact evidence cards provide citations; for more text/table context call "
            "private_fund_source_detail(evidence_id, mode='text'|'excel_window'|'meta'). "
            "Set include_metric_facts=true when you need Excel metric facts."
        ),
    }
    if include_expanded_terms and result.get("expanded_terms"):
        payload["expanded_terms"] = result.get("expanded_terms")
    return _enforce_payload_budget(payload, _MAX_SEARCH_PAYLOAD_CHARS)


def _slim_dataset_ref(info: Any) -> dict[str, Any]:
    if not isinstance(info, dict):
        return {"dataset_id": info}
    return {
        "dataset_id": info.get("dataset_id"),
        "name": info.get("name"),
        "company_name": info.get("company_name") or "",
        "company_ticker": info.get("company_ticker") or "",
    }


def _project_source_detail_for_agent(
    detail: dict[str, Any],
    *,
    mode: str = "auto",
    max_chars: int = _MAX_DETAIL_CONTENT_CHARS,
    max_cells: int = _MAX_CELL_ROWS,
) -> dict[str, Any]:
    """Shape source_detail for agent turns. Store-level callers can pass mode='full'."""
    resolved = (mode or "auto").strip().lower()
    max_chars = max(500, min(int(max_chars or _MAX_DETAIL_CONTENT_CHARS), 20000))
    max_cells = max(1, min(int(max_cells or _MAX_CELL_ROWS), _MAX_CELL_ROWS_HARD))

    evidence_id = str(detail.get("evidence_id") or "")
    if resolved == "auto":
        if evidence_id.startswith(("fact:", "cell:")) or detail.get("excel_cells") or detail.get(
            "metric"
        ):
            resolved = "excel_window"
        else:
            resolved = "text"

    if resolved == "full":
        return _cap_full_detail(detail, max_chars=max_chars, max_cells=max_cells)

    source = detail.get("source") or {}
    payload: dict[str, Any] = {
        "dataset": _slim_dataset_ref(detail.get("dataset")),
        "evidence_id": detail.get("evidence_id"),
        "citation": detail.get("citation"),
        "markdown_citation": detail.get("markdown_citation"),
        "content_type": detail.get("content_type"),
        "title_path": detail.get("title_path"),
        "mode": resolved,
    }
    locator: dict[str, Any] = {}
    for key in (
        "page_start",
        "page_end",
        "sheet_name",
        "cell_range",
        "slide_start",
        "slide_end",
        "heading_path",
        "source_url",
    ):
        if source.get(key) not in (None, ""):
            locator[key] = source.get(key)
    if locator:
        payload["locator"] = locator
    document = detail.get("document") or {}
    filename = document.get("filename") or document.get("original_filename")
    if filename:
        payload["filename"] = filename

    if isinstance(detail.get("metric"), dict):
        metric = detail["metric"]
        payload["metric"] = {
            key: metric.get(key)
            for key in (
                "name",
                "period",
                "value_text",
                "value_numeric",
                "unit",
                "formula",
                "confidence",
            )
            if metric.get(key) not in (None, "")
        }

    if resolved == "meta":
        content = detail.get("content")
        if content:
            payload["preview"] = _clip_text(content, min(400, max_chars))
            payload["content_total_chars"] = len(_normalize(content))
        if detail.get("excel_cells"):
            payload["excel_cells_available"] = len(detail["excel_cells"])
        return _enforce_payload_budget(payload, _MAX_DETAIL_PAYLOAD_CHARS)

    if resolved in {"text", "excel_window"}:
        content = detail.get("content")
        if content and resolved == "text":
            raw = _normalize(content)
            payload["content"] = _clip_text(raw, max_chars)
            payload["content_total_chars"] = len(raw)
            payload["content_truncated"] = len(raw) > len(payload["content"])
        if detail.get("pdf_pages"):
            pages = []
            page_budget = max(800, max_chars // max(1, len(detail["pdf_pages"])))
            page_budget = min(page_budget, _MAX_DETAIL_PAGE_CHARS)
            for page in detail["pdf_pages"]:
                text = _normalize(page.get("text"))
                pages.append(
                    {
                        "page_number": page.get("page_number"),
                        "text": _clip_text(text, page_budget),
                        "truncated": len(text) > page_budget,
                    }
                )
            payload["pdf_pages"] = pages
        if detail.get("cell") and resolved == "excel_window":
            payload["cell"] = (
                _compact_cell_dict(detail["cell"])
                if isinstance(detail["cell"], dict)
                else detail["cell"]
            )
        cells = detail.get("excel_cells") or []
        if cells and resolved in {"text", "excel_window"}:
            limited = cells[:max_cells]
            payload["excel_cells"] = [
                _compact_cell_dict(cell) if isinstance(cell, dict) else cell for cell in limited
            ]
            payload["excel_cells_count"] = len(cells)
            payload["excel_cells_truncated"] = len(cells) > max_cells
        if resolved == "text" and not payload.get("content") and payload.get("excel_cells"):
            payload["hint"] = "Chunk has no long text; excel_cells window included."
        return _enforce_payload_budget(payload, _MAX_DETAIL_PAYLOAD_CHARS)

    return _cap_full_detail(detail, max_chars=max_chars, max_cells=max_cells)


def _cap_full_detail(
    detail: dict[str, Any],
    *,
    max_chars: int,
    max_cells: int,
) -> dict[str, Any]:
    """Keep full-ish shape but hard-cap the heavy fields."""
    out = dict(detail)
    if isinstance(out.get("dataset"), dict):
        # Drop huge nested paths when possible but keep tests' document fields.
        pass
    content = out.get("content")
    if isinstance(content, str) and len(content) > max_chars:
        out["content"] = _clip_text(content, max_chars)
        out["content_truncated"] = True
        out["content_total_chars"] = len(content)
    if isinstance(out.get("pdf_pages"), list):
        pages = []
        for page in out["pdf_pages"]:
            if not isinstance(page, dict):
                continue
            page_copy = dict(page)
            text = _normalize(page_copy.get("text"))
            if len(text) > _MAX_DETAIL_PAGE_CHARS:
                page_copy["text"] = _clip_text(text, _MAX_DETAIL_PAGE_CHARS)
                page_copy["truncated"] = True
            pages.append(page_copy)
        out["pdf_pages"] = pages
    if isinstance(out.get("excel_cells"), list) and len(out["excel_cells"]) > max_cells:
        out["excel_cells"] = out["excel_cells"][:max_cells]
        out["excel_cells_truncated"] = True
    if isinstance(out.get("dataset"), dict) and "collection_db_path" in out["dataset"]:
        # Prefer slim dataset for agent full mode too if still over budget later.
        pass
    return _enforce_payload_budget(out, _MAX_DETAIL_PAYLOAD_CHARS)


def _enforce_payload_budget(payload: dict[str, Any], max_chars: int) -> dict[str, Any]:
    encoded = _json(payload)
    if len(encoded) <= max_chars:
        return payload
    # Progressive stripping of heavy fields.
    working = dict(payload)
    for key in ("pdf_pages", "excel_cells", "metadata", "source", "document", "expanded_terms"):
        if key in working:
            working.pop(key, None)
            working["truncated"] = True
            working["truncated_fields"] = list(
                {*list(working.get("truncated_fields") or []), key}
            )
            encoded = _json(working)
            if len(encoded) <= max_chars:
                return working
    # Last resort: keep ids/citations only.
    minimal = {
        "dataset": working.get("dataset"),
        "evidence_id": working.get("evidence_id"),
        "query": working.get("query"),
        "citation": working.get("citation"),
        "markdown_citation": working.get("markdown_citation"),
        "evidence": [
            {
                "evidence_id": item.get("evidence_id"),
                "citation": item.get("citation"),
                "markdown_citation": item.get("markdown_citation"),
                "excerpt": _clip_text(item.get("excerpt"), 200),
            }
            for item in (working.get("evidence") or [])[:5]
            if isinstance(item, dict)
        ]
        if working.get("evidence") is not None
        else None,
        "truncated": True,
        "hint": "Payload exceeded budget; re-query with smaller top_k or source_detail mode=meta.",
    }
    return {k: v for k, v in minimal.items() if v is not None}


def _decode_json(value: str | None, fallback: Any = None) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


def _markdown_link_text(value: str) -> str:
    return value.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def _source_markdown(citation: str, source_url: str | None) -> str:
    if not source_url:
        return citation
    return f"[{_markdown_link_text(citation)}]({source_url})"


def _pdf_source_url(
    *,
    filename: str,
    page_start: int,
    page_end: int | None = None,
    evidence_id: str | None = None,
) -> str:
    label = (
        f"p.{page_start}-{page_end}" if page_end and page_end != page_start else f"p.{page_start}"
    )
    params = {"page": str(page_start), "label": label, "pdf_name": filename}
    if page_end and page_end != page_start:
        params["page_end"] = str(page_end)
    if evidence_id:
        params["evidence_id"] = evidence_id
    return f"{_PDF_SOURCE_HASH}?{urlencode(params)}"


def _excel_source_url(
    *,
    workbook_name: str,
    sheet_name: str | None = None,
    range_ref: str | None = None,
) -> str:
    label = workbook_name
    if sheet_name and range_ref:
        label = f"{workbook_name} {sheet_name}!{range_ref}"
    elif sheet_name:
        label = f"{workbook_name} {sheet_name}"
    params = {"workbook_name": workbook_name, "label": label}
    if sheet_name:
        params["sheet_name"] = sheet_name
    if range_ref:
        params["range_ref"] = range_ref
    return f"{_EXCEL_SOURCE_HASH}?{urlencode(params)}"


def _memo_artifact_url(path: Path) -> str:
    return "/v1/private-fund/dataset/memo/file?" + urlencode({"path": str(path)})


def _plain_source_label(item: dict[str, Any]) -> str:
    source = item.get("source") or {}
    return str(
        item.get("citation")
        or source.get("citation")
        or source.get("display_text")
        or "local dataset"
    )


def _compact_memo_context(*values: str, max_chars: int = 1800) -> str:
    text = _normalize(" ".join(value for value in values if value))
    return text[:max_chars]


def _plain_markdown_links(markdown: str) -> str:
    return re.sub(r"\[([^\]\n]+)\]\([^)]+\)", r"\1", markdown)


def _memo_claims_to_markdown(raw_claims: list[dict[str, Any]]) -> str:
    """Render the model's structured claims into gateable Markdown."""

    grouped: dict[str, list[str]] = {}
    for raw in raw_claims:
        if not isinstance(raw, dict):
            continue
        section = _normalize(raw.get("section")) or "研究结论"
        text = _normalize(raw.get("text"))
        if not text:
            continue
        status = _normalize(raw.get("status")).lower() or "supported"
        raw_ids = raw.get("evidence_ids") or []
        evidence_ids = [
            _normalize(item)
            for item in raw_ids
            if isinstance(item, str) and _normalize(item)
        ] if isinstance(raw_ids, list) else []
        if status == "not_covered":
            line = f"- 资料未覆盖：{text}"
        elif status == "needs_review":
            line = f"- {text} **（待复核）**"
        else:
            citations = " ".join(f"[{item}]" for item in dict.fromkeys(evidence_ids))
            line = f"- {text}{f' {citations}' if citations else ''}"
        grouped.setdefault(section, []).append(line)
    lines: list[str] = []
    for section, claims in grouped.items():
        lines.extend([f"## {section}", "", *claims, ""])
    return "\n".join(lines).strip()


def _markdown_body_to_html(markdown: str) -> str:
    clean = _plain_markdown_links(markdown.strip())
    if not clean:
        return ""
    try:
        from markdown_it import MarkdownIt

        return MarkdownIt("commonmark").render(clean)
    except Exception:
        blocks = []
        for raw in clean.splitlines():
            line = raw.strip()
            if not line:
                continue
            if line.startswith("### "):
                blocks.append(f"<h3>{escape(line[4:])}</h3>")
            elif line.startswith("## "):
                blocks.append(f"<h2>{escape(line[3:])}</h2>")
            elif line.startswith("# "):
                blocks.append(f"<h1>{escape(line[2:])}</h1>")
            elif line.startswith("- "):
                blocks.append(f"<p>• {escape(line[2:])}</p>")
            else:
                blocks.append(f"<p>{escape(line)}</p>")
        return "\n".join(blocks)


def _normalize(value: Any) -> str:
    text = "" if value is None else str(value)
    text = unicodedata.normalize("NFKC", text)
    return re.sub(r"\s+", " ", text).strip()


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    """Return SQLite column names without assuming the latest ingest schema."""

    return {str(row["name"]) for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _active_document_predicate(conn: sqlite3.Connection, alias: str = "d") -> str:
    """Build the active-version predicate for both old and migrated datasets."""

    columns = _table_columns(conn, "documents")
    predicates: list[str] = []
    if "deleted_at" in columns:
        predicates.append(f"{alias}.deleted_at IS NULL")
    if "is_current" in columns:
        predicates.append(f"COALESCE({alias}.is_current, 1) = 1")
    if "lifecycle_state" in columns:
        predicates.append(f"COALESCE({alias}.lifecycle_state, 'active') = 'active'")
    return " AND ".join(predicates) or "1 = 1"


def _compatible_projection(
    conn: sqlite3.Connection,
    *,
    table: str,
    alias: str,
    columns: tuple[str, ...],
) -> str:
    """Project nullable compatibility columns that older collection DBs lack."""

    available = _table_columns(conn, table)
    return ", ".join(
        f"{alias}.{column} AS {column}" if column in available else f"NULL AS {column}"
        for column in columns
    )


def _row_value(row: sqlite3.Row, key: str, fallback: Any = None) -> Any:
    """Read an optional SQLite row field without relying on ``Row.get``."""

    try:
        return row[key]
    except (IndexError, KeyError):
        return fallback


def _document_reference_name(row: sqlite3.Row) -> str:
    """Prefer the source-relative path so recursive imports remain unambiguous."""

    return str(_row_value(row, "source_relpath") or row["original_filename"])


def _document_payload(row: sqlite3.Row) -> dict[str, Any]:
    """Return source identity plus optional version/audit fields."""

    is_current = _row_value(row, "is_current")
    deleted_at = _row_value(row, "deleted_at")
    return {
        "doc_id": row["doc_id"],
        "filename": _document_reference_name(row),
        "source_relpath": _row_value(row, "source_relpath"),
        "file_type": row["file_type"],
        "doc_type": row["doc_type"],
        "raw_path": row["stored_path"],
        "logical_doc_id": _row_value(row, "logical_doc_id"),
        "version_no": _row_value(row, "version_no"),
        "supersedes_doc_id": _row_value(row, "supersedes_doc_id"),
        "is_current": bool(is_current) if is_current is not None else None,
        "status": _row_value(row, "document_status"),
        "lifecycle_state": _row_value(row, "lifecycle_state"),
        "deleted_at": deleted_at,
        "is_historical": bool(deleted_at) or is_current == 0,
    }


_DOCUMENT_AUDIT_COLUMNS = (
    "source_relpath",
    "logical_doc_id",
    "version_no",
    "supersedes_doc_id",
    "is_current",
    "lifecycle_state",
    "deleted_at",
)


def _document_audit_projection(conn: sqlite3.Connection, alias: str = "d") -> str:
    projection = _compatible_projection(
        conn,
        table="documents",
        alias=alias,
        columns=_DOCUMENT_AUDIT_COLUMNS,
    )
    columns = _table_columns(conn, "documents")
    status = (
        f"{alias}.status AS document_status" if "status" in columns else "NULL AS document_status"
    )
    return f"{projection}, {status}"


def _parse_arguments(arguments: str) -> dict[str, Any]:
    if not arguments:
        return {}
    try:
        payload = json.loads(arguments)
    except json.JSONDecodeError as exc:
        raise ValueError(f"malformed arguments JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError("arguments must be a JSON object")
    return payload


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        item = _normalize(item).lower()
        if item and item not in seen:
            seen.add(item)
            out.append(item)
    return out


def _query_terms(query: str) -> list[str]:
    query_norm = _normalize(query).lower()
    terms: list[str] = []
    terms.extend(re.findall(r"[a-z0-9][a-z0-9._/%+-]{1,}", query_norm))
    for seq in re.findall(r"[\u4e00-\u9fff]{2,}", query_norm):
        terms.append(seq)
        if len(seq) > 4:
            for size in (2, 3, 4):
                terms.extend(seq[i : i + size] for i in range(len(seq) - size + 1))
    for cn, synonyms in _TERM_SYNONYMS.items():
        if cn in query_norm:
            terms.extend([cn, *synonyms])
    if not terms:
        terms.extend(re.findall(r"[\u4e00-\u9fff]", query_norm))
    return _dedupe(terms)


def _score_text(value: Any, terms: list[str]) -> float:
    text = _normalize(value).lower()
    if not text:
        return 0.0
    score = 0.0
    for term in terms:
        if not term:
            continue
        count = text.count(term)
        if count:
            score += min(count, 5) * max(1.0, min(len(term), 12) / 2.0)
    return score


def _best_excerpt(text: str, terms: list[str], max_chars: int = _MAX_EXCERPT_CHARS) -> str:
    clean = _normalize(text)
    if len(clean) <= max_chars:
        return clean
    lower = clean.lower()
    positions = [lower.find(term) for term in terms if term and lower.find(term) >= 0]
    if positions:
        center = min(positions)
        start = max(0, center - max_chars // 3)
    else:
        start = 0
    end = min(len(clean), start + max_chars)
    excerpt = clean[start:end].strip()
    if start > 0:
        excerpt = "..." + excerpt
    if end < len(clean):
        excerpt += "..."
    return excerpt


def _coerce_top_k(value: Any, default: int = _DEFAULT_TOP_K) -> int:
    try:
        top_k = int(value)
    except (TypeError, ValueError):
        top_k = default
    return max(1, min(_MAX_TOP_K, top_k))


def _cell_col_to_int(col: str) -> int:
    value = 0
    for ch in col.upper():
        value = value * 26 + (ord(ch) - ord("A") + 1)
    return value


def _parse_cell_ref(ref: str) -> tuple[int, int] | None:
    match = re.fullmatch(r"\$?([A-Za-z]+)\$?(\d+)", ref.strip())
    if not match:
        return None
    col, row = match.groups()
    return int(row), _cell_col_to_int(col)


def _parse_cell_range(cell_range: str) -> tuple[int, int, int, int] | None:
    if not cell_range:
        return None
    parts = [part.strip() for part in cell_range.split(":", 1)]
    first = _parse_cell_ref(parts[0])
    second = _parse_cell_ref(parts[1]) if len(parts) > 1 else first
    if first is None or second is None:
        return None
    r1, c1 = first
    r2, c2 = second
    return min(r1, r2), min(c1, c2), max(r1, r2), max(c1, c2)


def _resolve_project_root(workspace: Path | None) -> Path:
    candidates: list[Path] = []
    env_root = os.environ.get("PRIVATE_FUND_PROJECT_ROOT")
    if env_root:
        candidates.append(Path(env_root).expanduser())
    if workspace is not None:
        candidates.extend([workspace, workspace.parent, workspace.parent.parent])
    here = Path(__file__).resolve()
    candidates.extend([here.parents[4], here.parents[3], Path.cwd()])
    for candidate in candidates:
        try:
            resolved = candidate.expanduser().resolve()
        except OSError:
            continue
        if (resolved / "output" / "private_fund_datasets").exists() or (
            resolved / "FinSagent" / "data_pipeline" / "private_fund_directory_ingest.py"
        ).exists():
            return resolved
    return candidates[0].expanduser().resolve() if candidates else Path.cwd().resolve()


class _DatasetStore:
    """Small read/write facade over the private-fund SQLite dataset layout."""

    def __init__(self, workspace: Path | None) -> None:
        self.project_root = _resolve_project_root(workspace)
        bound_workspace = workspace.expanduser().resolve() if workspace else None
        if bound_workspace is not None and (
            bound_workspace / "meta" / "collection.sqlite3"
        ).exists():
            registry = bound_workspace.parent / "datasets.sqlite3"
            if not registry.exists():
                raise RuntimeError(
                    "the bound private-fund workspace has no tenant dataset registry"
                )
            self.workspace_root = bound_workspace.parent
        else:
            workspace_override = os.environ.get("PRIVATE_FUND_DATASET_WORKSPACE")
            self.workspace_root = (
                Path(workspace_override).expanduser().resolve()
                if workspace_override
                else self.project_root / "output" / "private_fund_datasets"
            )

    def _connect(self, path: Path) -> sqlite3.Connection:
        conn = sqlite3.connect(str(path), timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=10000")
        return conn

    def dataset_info(self, dataset_id: str | None = None) -> dict[str, Any]:
        global_db = self.workspace_root / "datasets.sqlite3"
        if not global_db.exists():
            raise FileNotFoundError(f"dataset registry does not exist: {global_db}")
        with self._connect(global_db) as conn:
            active_id = dataset_id
            if not active_id:
                row = conn.execute(
                    "SELECT active_dataset_id FROM dataset_state WHERE id = 1"
                ).fetchone()
                active_id = row["active_dataset_id"] if row else None
            if not active_id:
                raise RuntimeError("no active private-fund dataset is configured")
            row = conn.execute(
                "SELECT * FROM datasets WHERE dataset_id = ?",
                (active_id,),
            ).fetchone()
        if row is None:
            raise RuntimeError(f"dataset not found: {active_id}")
        metadata = _decode_json(row["metadata_json"], {}) or {}
        dataset_root = Path(row["dataset_root"]).expanduser().resolve()
        if not dataset_root.is_relative_to(self.workspace_root.resolve()):
            raise RuntimeError("dataset path escapes the current user's workspace")
        collection_db = Path(
            metadata.get("collection_db_path") or dataset_root / "meta" / "collection.sqlite3"
        ).expanduser().resolve()
        if not collection_db.is_relative_to(dataset_root):
            raise RuntimeError("collection path escapes the selected dataset")
        if not collection_db.exists():
            raise FileNotFoundError(f"collection db does not exist: {collection_db}")
        return {
            "dataset_id": row["dataset_id"],
            "name": row["name"],
            "status": row["status"],
            "source_dir": row["source_dir"],
            "dataset_root": str(dataset_root),
            "workspace_root": str(self.workspace_root),
            "collection_db_path": str(collection_db),
            "global_db_path": str(global_db),
            "company_name": row["company_name"],
            "company_ticker": row["company_ticker"],
            "file_count": row["file_count"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def status(self, dataset_id: str | None = None) -> dict[str, Any]:
        info = self.dataset_info(dataset_id)
        collection_db = Path(info["collection_db_path"])
        with self._connect(collection_db) as conn:
            active_documents = _active_document_predicate(conn)
            counts: dict[str, int] = {}
            for name in (
                "documents",
                "chunks",
                "chunk_locations",
                "pdf_pages",
                "excel_workbooks",
                "excel_sheets",
                "excel_regions",
                "excel_cells",
                "metric_facts",
                "index_registry",
            ):
                if name == "documents":
                    count_row = conn.execute(
                        f"SELECT COUNT(*) AS n FROM documents d "
                        f"WHERE d.dataset_id = ? AND {active_documents}",
                        (info["dataset_id"],),
                    ).fetchone()
                elif name == "index_registry":
                    count_row = conn.execute(
                        "SELECT COUNT(*) AS n FROM index_registry WHERE dataset_id = ?",
                        (info["dataset_id"],),
                    ).fetchone()
                else:
                    count_row = conn.execute(
                        f"SELECT COUNT(*) AS n FROM {name} payload "
                        "JOIN documents d ON d.doc_id = payload.doc_id "
                        f"WHERE d.dataset_id = ? AND {active_documents}",
                        (info["dataset_id"],),
                    ).fetchone()
                counts[name] = int(count_row["n"])
            version_projection = _compatible_projection(
                conn,
                table="documents",
                alias="d",
                columns=(
                    "source_relpath",
                    "logical_doc_id",
                    "version_no",
                    "supersedes_doc_id",
                    "is_current",
                    "lifecycle_state",
                ),
            )
            documents = [
                dict(row)
                for row in conn.execute(
                    f"""
                    SELECT d.doc_id, d.original_filename, d.file_type, d.doc_type,
                           d.status, d.chunk_count, d.error_message, d.stored_path,
                           {version_projection}
                    FROM documents d
                    WHERE d.dataset_id = ? AND {active_documents}
                    ORDER BY file_type, original_filename
                    """,
                    (info["dataset_id"],),
                ).fetchall()
            ]
            indexes = [
                dict(row)
                for row in conn.execute(
                    """
                    SELECT index_type, index_path, source_chunk_count, status, built_at,
                           error_message
                    FROM index_registry
                    ORDER BY index_type
                    """
                ).fetchall()
            ]
            latest_job = conn.execute(
                """
                SELECT job_id, job_type, status, file_count, message, started_at, finished_at
                FROM ingest_jobs
                ORDER BY COALESCE(finished_at, started_at, created_at) DESC
                LIMIT 1
                """
            ).fetchone()
        return {
            "dataset": info,
            "counts": counts,
            "documents": documents,
            "indexes": indexes,
            "latest_ingest_job": dict(latest_job) if latest_job else None,
            "source_contract": {
                "pdf": "documents + chunks + chunk_locations + pdf_pages",
                "excel": (
                    "documents + excel_sheets + excel_regions + excel_cells + "
                    "metric_facts + summary chunks"
                ),
                "evidence_id": (
                    "Use chunk:<id>, fact:<id>, or cell:<id> with "
                    "private_fund_source_detail."
                ),
                "source_links": "Use markdown_citation when producing clickable source citations.",
            },
        }

    def search(
        self,
        *,
        query: str,
        dataset_id: str | None = None,
        top_k: int = _DEFAULT_TOP_K,
        include_metric_facts: bool = False,
        include_cells: bool = False,
    ) -> dict[str, Any]:
        terms = _query_terms(query)
        info = self.dataset_info(dataset_id)
        collection_db = Path(info["collection_db_path"])
        with self._connect(collection_db) as conn:
            evidence = self._search_chunks(conn, info, query, terms)
            if include_metric_facts:
                evidence.extend(self._search_metric_facts(conn, info, query, terms))
            if include_cells:
                evidence.extend(self._search_cells(conn, info, query, terms))
            if not evidence:
                evidence = self._fallback_summary_chunks(conn, info)
        evidence.sort(key=lambda item: item.get("score", 0.0), reverse=True)
        limited = evidence[: _coerce_top_k(top_k)]
        evidence_fusion = self._fetch_evidence_fusion(
            query=query,
            dataset_id=str(info["dataset_id"]),
        )
        return {
            "dataset": {
                key: info[key]
                for key in (
                    "dataset_id",
                    "name",
                    "company_name",
                    "company_ticker",
                    "collection_db_path",
                )
            },
            "query": query,
            "expanded_terms": terms[:30],
            "evidence": limited,
            "evidence_fusion": evidence_fusion,
            "answer_contract": (
                "Use evidence_fusion.context when evidence_fusion.available=true; it retains "
                "structured DCI candidates and adds scoped semantic RAG when policy requires it. "
                "Use the evidence cards for clickable source citations and verify material facts "
                "with private_fund_source_detail. If evidence is insufficient, say so."
            ),
        }

    @staticmethod
    def _fetch_evidence_fusion(*, query: str, dataset_id: str) -> dict[str, Any]:
        endpoint = os.environ.get("FINSAGENT_EVIDENCE_FUSION_URL", "").strip()
        if not endpoint:
            return {"enabled": False, "available": False}
        try:
            timeout = max(
                1.0,
                min(180.0, float(os.environ.get("FINSAGENT_EVIDENCE_FUSION_TIMEOUT", "90"))),
            )
        except (TypeError, ValueError):
            timeout = 90.0
        payload = json.dumps(
            {
                "query": query,
                "original_question": query,
                "dataset_id": dataset_id,
                "agent": "general",
            }
        ).encode("utf-8")
        request = Request(
            endpoint,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=timeout) as response:  # noqa: S310 - admin-configured URL
                raw = response.read(_MAX_SEARCH_PAYLOAD_CHARS * 4 + 1)
            if len(raw) > _MAX_SEARCH_PAYLOAD_CHARS * 4:
                raise ValueError("Evidence Fusion response exceeded the bounded payload size")
            result = json.loads(raw.decode("utf-8"))
            if not isinstance(result, dict):
                raise ValueError("Evidence Fusion response must be an object")
            return {
                "enabled": True,
                "available": True,
                "context": str(result.get("context") or "")[:_MAX_SEARCH_PAYLOAD_CHARS],
                "retrieval_scope": result.get("retrieval_scope", {}),
                "retrieval_policy": result.get("retrieval_policy", {}),
                "evidence_conflicts": result.get("evidence_conflicts", []),
                "retrieval_trace": result.get("retrieval_trace", []),
                "rag_executed": bool(result.get("rag_executed", False)),
                "rag_succeeded": bool(result.get("rag_succeeded", False)),
            }
        except Exception as exc:
            # The Omnigent tool remains useful when the optional semantic service
            # is unavailable; local source-backed evidence is still returned.
            return {
                "enabled": True,
                "available": False,
                "error": f"{type(exc).__name__}: {exc}",
            }

    def _search_chunks(
        self,
        conn: sqlite3.Connection,
        info: dict[str, Any],
        query: str,
        terms: list[str],
    ) -> list[dict[str, Any]]:
        del query
        active_documents = _active_document_predicate(conn)
        location_projection = _compatible_projection(
            conn,
            table="chunk_locations",
            alias="l",
            columns=("slide_start", "slide_end", "heading_path"),
        )
        document_projection = _document_audit_projection(conn)
        rows = conn.execute(
            f"""
            SELECT c.chunk_id, c.content, c.content_type, c.title_path, c.summary,
                   c.source_ref, c.metadata_json, d.doc_id, d.original_filename,
                   d.file_type, d.doc_type, d.stored_path, l.page_start, l.page_end,
                   l.page_numbers_json, l.sheet_name, l.cell_range, l.bbox_json,
                   l.display_text, {location_projection}, {document_projection}
            FROM chunks c
            JOIN documents d ON d.doc_id = c.doc_id
            LEFT JOIN chunk_locations l
              ON l.chunk_id = c.chunk_id
             AND l.location_index = (
                 SELECT MIN(location_index) FROM chunk_locations WHERE chunk_id = c.chunk_id
             )
            WHERE c.dataset_id = ? AND {active_documents}
            """,
            (info["dataset_id"],),
        ).fetchall()
        evidence: list[dict[str, Any]] = []
        for row in rows:
            score = (
                _score_text(row["title_path"], terms) * 2.5
                + _score_text(row["source_ref"], terms) * 2.0
                + _score_text(row["summary"], terms) * 1.5
                + _score_text(row["content"], terms)
                + _score_text(row["original_filename"], terms) * 1.5
            )
            if score <= 0:
                continue
            evidence.append(self._chunk_evidence(row, score, terms))
        return evidence

    def _chunk_evidence(
        self,
        row: sqlite3.Row,
        score: float,
        terms: list[str],
    ) -> dict[str, Any]:
        evidence_id = f"chunk:{row['chunk_id']}"
        source = self._source_payload(row, evidence_id=evidence_id)
        return {
            "evidence_id": evidence_id,
            "evidence_type": "chunk",
            "score": round(score, 3),
            "content_type": row["content_type"],
            "title_path": row["title_path"],
            "citation": source["citation"],
            "markdown_citation": source["markdown_citation"],
            "source": source,
            "document": _document_payload(row),
            "excerpt": _best_excerpt(row["content"], terms),
            "summary": row["summary"],
            "metadata": _decode_json(row["metadata_json"], {}) or {},
        }

    def _source_payload(
        self,
        row: sqlite3.Row,
        *,
        evidence_id: str | None = None,
    ) -> dict[str, Any]:
        original_filename = str(row["original_filename"])
        filename = _document_reference_name(row)
        page_start = row["page_start"]
        page_end = row["page_end"]
        sheet_name = row["sheet_name"]
        cell_range = row["cell_range"]
        slide_start = _row_value(row, "slide_start")
        slide_end = _row_value(row, "slide_end")
        heading_path = _row_value(row, "heading_path") or _row_value(row, "title_path")
        display = row["display_text"] or row["source_ref"] or filename
        suffix = Path(original_filename).suffix.lower()
        file_type = _normalize(_row_value(row, "file_type")).lower().lstrip(".")
        is_pdf = suffix == ".pdf" or file_type in {"pdf", "application/pdf"}
        is_excel = suffix in {".xls", ".xlsx", ".xlsm"} or file_type in {
            "xls",
            "xlsx",
            "xlsm",
            "excel",
        }
        if is_pdf and page_start:
            if page_end and page_end != page_start:
                citation = f"{filename} p.{page_start}-{page_end}"
            else:
                citation = f"{filename} p.{page_start}"
        elif is_excel and sheet_name and cell_range:
            citation = f"{filename} {sheet_name}!{cell_range}"
        elif is_excel and sheet_name:
            citation = f"{filename} {sheet_name}"
        elif slide_start:
            if slide_end and slide_end != slide_start:
                citation = f"{filename} slides {slide_start}-{slide_end}"
            else:
                citation = f"{filename} slide {slide_start}"
        elif display and _normalize(display) != _normalize(filename):
            citation = str(display)
            if filename != original_filename and original_filename in citation:
                citation = citation.replace(original_filename, filename, 1)
            elif _normalize(filename).lower() not in _normalize(display).lower():
                citation = f"{filename} — {citation}"
        elif heading_path and _normalize(heading_path) != _normalize(filename):
            citation = f"{filename} — {heading_path}"
        else:
            citation = str(filename)
        source_url = None
        if is_pdf and page_start:
            source_url = _pdf_source_url(
                filename=original_filename,
                page_start=int(page_start),
                page_end=int(page_end) if page_end else None,
                evidence_id=evidence_id,
            )
        elif is_excel and sheet_name:
            source_url = _excel_source_url(
                workbook_name=original_filename,
                sheet_name=sheet_name,
                range_ref=cell_range,
            )
        return {
            "display_text": display,
            "citation": citation,
            "markdown_citation": _source_markdown(citation, source_url),
            "source_url": source_url,
            "page_start": page_start,
            "page_end": page_end,
            "page_numbers": _decode_json(row["page_numbers_json"], None),
            "slide_start": slide_start,
            "slide_end": slide_end,
            "sheet_name": sheet_name,
            "cell_range": cell_range,
            "heading_path": heading_path,
            "bbox": _decode_json(row["bbox_json"], None),
            "raw_path": row["stored_path"],
        }

    def _search_metric_facts(
        self,
        conn: sqlite3.Connection,
        info: dict[str, Any],
        query: str,
        terms: list[str],
    ) -> list[dict[str, Any]]:
        del query
        active_documents = _active_document_predicate(conn)
        document_projection = _document_audit_projection(conn)
        rows = conn.execute(
            f"""
            SELECT f.*, d.original_filename, d.file_type, d.doc_type, d.stored_path,
                   {document_projection}
            FROM metric_facts f
            JOIN documents d ON d.doc_id = f.doc_id
            WHERE f.dataset_id = ? AND {active_documents}
            """,
            (info["dataset_id"],),
        ).fetchall()
        evidence: list[dict[str, Any]] = []
        for row in rows:
            haystack = " ".join(
                _normalize(row[key])
                for key in (
                    "metric_name",
                    "metric_alias",
                    "period",
                    "value_text",
                    "unit",
                    "sheet_name",
                    "source_range",
                )
            )
            score = _score_text(haystack, terms) * 2.0 + _score_text(
                row["original_filename"], terms
            )
            if score <= 0:
                continue
            citation = f"{row['original_filename']} {row['sheet_name']}!{row['cell_ref']}"
            source_url = _excel_source_url(
                workbook_name=row["original_filename"],
                sheet_name=row["sheet_name"],
                range_ref=row["cell_ref"],
            )
            metric_line = (
                f"{row['metric_name']} | {row['period'] or 'no period'} | "
                f"{row['value_text']}{row['unit'] or ''}"
            )
            evidence.append(
                {
                    "evidence_id": f"fact:{row['fact_id']}",
                    "evidence_type": "metric_fact",
                    "score": round(score, 3),
                    "content_type": "excel_metric_fact",
                    "citation": citation,
                    "markdown_citation": _source_markdown(citation, source_url),
                    "source": {
                        "display_text": row["source_range"],
                        "citation": citation,
                        "markdown_citation": _source_markdown(citation, source_url),
                        "source_url": source_url,
                        "sheet_name": row["sheet_name"],
                        "cell_range": row["cell_ref"],
                        "raw_path": row["stored_path"],
                    },
                    "document": _document_payload(row),
                    "metric": {
                        "name": row["metric_name"],
                        "period": row["period"],
                        "value_text": row["value_text"],
                        "value_numeric": row["value_numeric"],
                        "unit": row["unit"],
                        "formula": row["formula"],
                        "confidence": row["confidence"],
                    },
                    "excerpt": metric_line,
                    "metadata": _decode_json(row["metadata_json"], {}) or {},
                }
            )
        return evidence

    def _search_cells(
        self,
        conn: sqlite3.Connection,
        info: dict[str, Any],
        query: str,
        terms: list[str],
    ) -> list[dict[str, Any]]:
        del query
        active_documents = _active_document_predicate(conn)
        document_projection = _document_audit_projection(conn)
        rows = conn.execute(
            f"""
            SELECT c.*, d.original_filename, d.file_type, d.doc_type, d.stored_path,
                   {document_projection}
            FROM excel_cells c
            JOIN documents d ON d.doc_id = c.doc_id
            WHERE c.dataset_id = ? AND {active_documents}
            """,
            (info["dataset_id"],),
        ).fetchall()
        evidence: list[dict[str, Any]] = []
        for row in rows:
            haystack = " ".join(
                _normalize(row[key])
                for key in (
                    "display_value",
                    "raw_value",
                    "row_label",
                    "col_label",
                    "period",
                    "unit",
                    "sheet_name",
                    "cell_ref",
                )
            )
            score = _score_text(haystack, terms)
            if score <= 0:
                continue
            citation = f"{row['original_filename']} {row['sheet_name']}!{row['cell_ref']}"
            source_url = _excel_source_url(
                workbook_name=row["original_filename"],
                sheet_name=row["sheet_name"],
                range_ref=row["cell_ref"],
            )
            evidence.append(
                {
                    "evidence_id": f"cell:{row['cell_id']}",
                    "evidence_type": "excel_cell",
                    "score": round(score, 3),
                    "content_type": "excel_cell",
                    "citation": citation,
                    "markdown_citation": _source_markdown(citation, source_url),
                    "source": {
                        "display_text": f"{row['sheet_name']}!{row['cell_ref']}",
                        "citation": citation,
                        "markdown_citation": _source_markdown(citation, source_url),
                        "source_url": source_url,
                        "sheet_name": row["sheet_name"],
                        "cell_range": row["cell_ref"],
                        "raw_path": row["stored_path"],
                    },
                    "document": _document_payload(row),
                    "excerpt": (
                        f"{row['row_label'] or ''} | {row['col_label'] or ''} | "
                        f"{row['display_value'] or row['raw_value'] or ''}"
                    ).strip(" |"),
                    "metadata": _decode_json(row["metadata_json"], {}) or {},
                }
            )
        return evidence

    def _fallback_summary_chunks(
        self,
        conn: sqlite3.Connection,
        info: dict[str, Any],
    ) -> list[dict[str, Any]]:
        active_documents = _active_document_predicate(conn)
        location_projection = _compatible_projection(
            conn,
            table="chunk_locations",
            alias="l",
            columns=("slide_start", "slide_end", "heading_path"),
        )
        document_projection = _document_audit_projection(conn)
        rows = conn.execute(
            f"""
            SELECT c.chunk_id, c.content, c.content_type, c.title_path, c.summary,
                   c.source_ref, c.metadata_json, d.doc_id, d.original_filename,
                   d.file_type, d.doc_type, d.stored_path, l.page_start, l.page_end,
                   l.page_numbers_json, l.sheet_name, l.cell_range, l.bbox_json,
                   l.display_text, {location_projection}, {document_projection}
            FROM chunks c
            JOIN documents d ON d.doc_id = c.doc_id
            LEFT JOIN chunk_locations l
              ON l.chunk_id = c.chunk_id
             AND l.location_index = (
                 SELECT MIN(location_index) FROM chunk_locations WHERE chunk_id = c.chunk_id
             )
            WHERE c.dataset_id = ?
              AND {active_documents}
              AND (
                  c.content_type LIKE '%_document_summary'
                  OR c.content_type IN ('excel_workbook_summary', 'excel_sheet_summary')
              )
            ORDER BY d.original_filename, c.chunk_index
            LIMIT 10
            """,
            (info["dataset_id"],),
        ).fetchall()
        return [self._chunk_evidence(row, 0.1, []) for row in rows]

    def source_detail(
        self,
        *,
        evidence_id: str,
        dataset_id: str | None = None,
        context_radius: int = 2,
        mode: str = "full",
        max_chars: int = _MAX_DETAIL_CONTENT_CHARS,
        max_cells: int = _MAX_CELL_ROWS,
    ) -> dict[str, Any]:
        info = self.dataset_info(dataset_id)
        collection_db = Path(info["collection_db_path"])
        kind, _, raw_id = evidence_id.partition(":")
        if not raw_id:
            raise ValueError("evidence_id must look like chunk:<id>, fact:<id>, or cell:<id>")
        radius = max(0, min(3, int(context_radius if context_radius is not None else 2)))
        cell_limit = max(1, min(int(max_cells or _MAX_CELL_ROWS), _MAX_CELL_ROWS_HARD))
        with self._connect(collection_db) as conn:
            if kind == "chunk":
                detail = self._chunk_detail(
                    conn, info, raw_id, radius, max_cells=cell_limit
                )
            elif kind == "fact":
                detail = self._fact_detail(
                    conn, info, raw_id, radius, max_cells=cell_limit
                )
            elif kind == "cell":
                detail = self._cell_detail(
                    conn, info, raw_id, radius, max_cells=cell_limit
                )
            else:
                raise ValueError(f"unsupported evidence type: {kind}")
        return _project_source_detail_for_agent(
            detail,
            mode=mode,
            max_chars=max_chars,
            max_cells=cell_limit,
        )

    def _chunk_detail(
        self,
        conn: sqlite3.Connection,
        info: dict[str, Any],
        chunk_id: str,
        context_radius: int,
        max_cells: int = _MAX_CELL_ROWS,
    ) -> dict[str, Any]:
        location_projection = _compatible_projection(
            conn,
            table="chunk_locations",
            alias="l",
            columns=("slide_start", "slide_end", "heading_path"),
        )
        document_projection = _document_audit_projection(conn)
        row = conn.execute(
            f"""
            SELECT c.*, d.original_filename, d.file_type, d.doc_type, d.stored_path,
                   l.page_start, l.page_end, l.page_numbers_json, l.sheet_name,
                   l.cell_range, l.bbox_json, l.display_text,
                   {location_projection}, {document_projection}
            FROM chunks c
            JOIN documents d ON d.doc_id = c.doc_id
            LEFT JOIN chunk_locations l
              ON l.chunk_id = c.chunk_id
             AND l.location_index = (
                 SELECT MIN(location_index) FROM chunk_locations WHERE chunk_id = c.chunk_id
             )
            WHERE c.chunk_id = ?
            """,
            (chunk_id,),
        ).fetchone()
        if row is None:
            raise RuntimeError(f"chunk not found: {chunk_id}")
        source = self._source_payload(row, evidence_id=f"chunk:{chunk_id}")
        detail: dict[str, Any] = {
            "dataset": info,
            "evidence_id": f"chunk:{chunk_id}",
            "citation": source["citation"],
            "markdown_citation": source["markdown_citation"],
            "source": source,
            "document": _document_payload(row),
            "content_type": row["content_type"],
            "title_path": row["title_path"],
            "content": row["content"],
            "metadata": _decode_json(row["metadata_json"], {}) or {},
        }
        if row["page_start"]:
            detail["pdf_pages"] = self._pdf_page_context(
                conn,
                row["doc_id"],
                int(row["page_start"]),
                int(row["page_end"] or row["page_start"]),
                context_radius,
            )
        if row["sheet_name"] and row["cell_range"]:
            detail["excel_cells"] = self._cells_in_range(
                conn,
                row["doc_id"],
                row["sheet_name"],
                row["cell_range"],
                max_cells=max_cells,
            )
        return detail

    def _fact_detail(
        self,
        conn: sqlite3.Connection,
        info: dict[str, Any],
        fact_id: str,
        context_radius: int,
        max_cells: int = _MAX_CELL_ROWS,
    ) -> dict[str, Any]:
        document_projection = _document_audit_projection(conn)
        row = conn.execute(
            f"""
            SELECT f.*, d.original_filename, d.file_type, d.doc_type, d.stored_path,
                   {document_projection}
            FROM metric_facts f
            JOIN documents d ON d.doc_id = f.doc_id
            WHERE f.fact_id = ?
            """,
            (fact_id,),
        ).fetchone()
        if row is None:
            raise RuntimeError(f"metric fact not found: {fact_id}")
        cell = conn.execute(
            """
            SELECT row_index, col_index FROM excel_cells
            WHERE doc_id = ? AND sheet_name = ? AND cell_ref = ?
            """,
            (row["doc_id"], row["sheet_name"], row["cell_ref"]),
        ).fetchone()
        cells: list[dict[str, Any]] = []
        if cell is not None:
            radius = max(0, min(4, context_radius))
            col_span = 5
            cells = self._cells_by_bounds(
                conn,
                row["doc_id"],
                row["sheet_name"],
                int(cell["row_index"]) - radius,
                max(1, int(cell["col_index"]) - col_span),
                int(cell["row_index"]) + radius,
                int(cell["col_index"]) + col_span,
                max_cells=max_cells,
            )
        citation = f"{row['original_filename']} {row['sheet_name']}!{row['cell_ref']}"
        source_url = _excel_source_url(
            workbook_name=row["original_filename"],
            sheet_name=row["sheet_name"],
            range_ref=row["cell_ref"],
        )
        return {
            "dataset": info,
            "evidence_id": f"fact:{fact_id}",
            "citation": citation,
            "markdown_citation": _source_markdown(citation, source_url),
            "source": {
                "display_text": row["source_range"],
                "citation": citation,
                "markdown_citation": _source_markdown(citation, source_url),
                "source_url": source_url,
                "sheet_name": row["sheet_name"],
                "cell_range": row["cell_ref"],
                "raw_path": row["stored_path"],
            },
            "document": _document_payload(row),
            "metric": {
                "name": row["metric_name"],
                "period": row["period"],
                "value_text": row["value_text"],
                "value_numeric": row["value_numeric"],
                "unit": row["unit"],
                "formula": row["formula"],
                "confidence": row["confidence"],
            },
            "excel_cells": cells,
            "metadata": _decode_json(row["metadata_json"], {}) or {},
        }

    def _cell_detail(
        self,
        conn: sqlite3.Connection,
        info: dict[str, Any],
        cell_id: str,
        context_radius: int,
        max_cells: int = _MAX_CELL_ROWS,
    ) -> dict[str, Any]:
        document_projection = _document_audit_projection(conn)
        row = conn.execute(
            f"""
            SELECT c.*, d.original_filename, d.file_type, d.doc_type, d.stored_path,
                   {document_projection}
            FROM excel_cells c
            JOIN documents d ON d.doc_id = c.doc_id
            WHERE c.cell_id = ?
            """,
            (cell_id,),
        ).fetchone()
        if row is None:
            raise RuntimeError(f"excel cell not found: {cell_id}")
        radius = max(0, min(4, context_radius))
        col_span = 5
        cells = self._cells_by_bounds(
            conn,
            row["doc_id"],
            row["sheet_name"],
            int(row["row_index"]) - radius,
            max(1, int(row["col_index"]) - col_span),
            int(row["row_index"]) + radius,
            int(row["col_index"]) + col_span,
            max_cells=max_cells,
        )
        citation = f"{row['original_filename']} {row['sheet_name']}!{row['cell_ref']}"
        source_url = _excel_source_url(
            workbook_name=row["original_filename"],
            sheet_name=row["sheet_name"],
            range_ref=row["cell_ref"],
        )
        return {
            "dataset": info,
            "evidence_id": f"cell:{cell_id}",
            "citation": citation,
            "markdown_citation": _source_markdown(citation, source_url),
            "source": {
                "display_text": f"{row['sheet_name']}!{row['cell_ref']}",
                "citation": citation,
                "markdown_citation": _source_markdown(citation, source_url),
                "source_url": source_url,
                "sheet_name": row["sheet_name"],
                "cell_range": row["cell_ref"],
                "raw_path": row["stored_path"],
            },
            "document": _document_payload(row),
            "cell": self._cell_payload(row),
            "excel_cells": cells,
            "metadata": _decode_json(row["metadata_json"], {}) or {},
        }

    def _pdf_page_context(
        self,
        conn: sqlite3.Connection,
        doc_id: str,
        page_start: int,
        page_end: int,
        context_radius: int,
    ) -> list[dict[str, Any]]:
        radius = max(0, min(3, context_radius))
        rows = conn.execute(
            """
            SELECT page_number, text, char_count, word_count, extraction_method, bbox_json
            FROM pdf_pages
            WHERE doc_id = ? AND page_number BETWEEN ? AND ?
            ORDER BY page_number
            """,
            (doc_id, max(1, page_start - radius), page_end + radius),
        ).fetchall()
        pages: list[dict[str, Any]] = []
        for row in rows:
            text = _normalize(row["text"])
            clipped = _clip_text(text, _MAX_DETAIL_PAGE_CHARS)
            pages.append(
                {
                    "page_number": row["page_number"],
                    "text": clipped,
                    "char_count": row["char_count"],
                    "word_count": row["word_count"],
                    "extraction_method": row["extraction_method"],
                    "truncated": len(text) > len(clipped),
                }
            )
        return pages

    def _cells_in_range(
        self,
        conn: sqlite3.Connection,
        doc_id: str,
        sheet_name: str,
        cell_range: str,
        max_cells: int = _MAX_CELL_ROWS,
    ) -> list[dict[str, Any]]:
        bounds = _parse_cell_range(cell_range)
        if bounds is None:
            return []
        return self._cells_by_bounds(
            conn, doc_id, sheet_name, *bounds, max_cells=max_cells
        )

    def _cells_by_bounds(
        self,
        conn: sqlite3.Connection,
        doc_id: str,
        sheet_name: str,
        row_start: int,
        col_start: int,
        row_end: int,
        col_end: int,
        max_cells: int = _MAX_CELL_ROWS,
    ) -> list[dict[str, Any]]:
        limit = max(1, min(int(max_cells or _MAX_CELL_ROWS), _MAX_CELL_ROWS_HARD))
        rows = conn.execute(
            """
            SELECT *
            FROM excel_cells
            WHERE doc_id = ?
              AND sheet_name = ?
              AND row_index BETWEEN ? AND ?
              AND col_index BETWEEN ? AND ?
            ORDER BY row_index, col_index
            LIMIT ?
            """,
            (
                doc_id,
                sheet_name,
                max(1, row_start),
                max(1, row_end),
                max(1, col_start),
                max(1, col_end),
                limit,
            ),
        ).fetchall()
        return [self._cell_payload(row) for row in rows]

    def _cell_payload(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "cell_id": row["cell_id"],
            "sheet_name": row["sheet_name"],
            "cell_ref": row["cell_ref"],
            "row_index": row["row_index"],
            "col_index": row["col_index"],
            "display_value": row["display_value"],
            "raw_value": row["raw_value"],
            "numeric_value": row["numeric_value"],
            "formula": row["formula"],
            "row_label": row["row_label"],
            "col_label": row["col_label"],
            "period": row["period"],
            "unit": row["unit"],
            "is_formula": bool(row["is_formula"]),
        }

    def generate_equity_report(
        self,
        *,
        dataset_id: str | None,
        title: str,
        report_payload: dict[str, Any],
        section_evidence: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Render and persist one evidence-backed FinRobot-aligned report."""

        from omnigent.server import private_fund_workflow
        from omnigent.tools.builtins.private_fund_finrobot_report import (
            render_finrobot_aligned_report,
        )

        info = self.dataset_info(dataset_id)
        collection_db = Path(info["collection_db_path"])
        run_id = f"eqr_{uuid4().hex}"
        reservation = private_fund_workflow.reserve_equity_report_run(
            collection_db,
            str(info["dataset_id"]),
            run_id=run_id,
            title=title.strip() or f"{info['name']} Equity Research Report",
            request={"report_payload": report_payload, "section_evidence": section_evidence},
        )
        try:
            section_payloads: list[dict[str, Any]] = []
            for section in section_evidence:
                if not isinstance(section, dict):
                    continue
                evidence: list[dict[str, Any]] = []
                for raw_id in section.get("evidence_ids") or []:
                    evidence_id = str(raw_id).strip()
                    if not re.fullmatch(r"(?:chunk|fact|cell):.+", evidence_id):
                        raise ValueError(f"invalid evidence id: {evidence_id}")
                    detail = self.source_detail(
                        evidence_id=evidence_id,
                        dataset_id=str(info["dataset_id"]),
                        context_radius=1,
                        mode="full",
                    )
                    detail["excerpt"] = str(
                        detail.get("content")
                        or detail.get("cell", {}).get("display_value")
                        or detail.get("citation")
                        or ""
                    )[:900]
                    evidence.append(detail)
                section_payloads.append(
                    {"section": str(section.get("section") or ""), "evidence": evidence}
                )
            if not any(item.get("evidence") for item in section_payloads):
                raise ValueError("at least one resolvable evidence_id is required")
            output_dir = Path(info["dataset_root"]) / "reports"
            artifacts, package = render_finrobot_aligned_report(
                project_root=self.project_root,
                info=info,
                report_payload=report_payload,
                section_payloads=section_payloads,
                output_dir=output_dir,
                run_id=run_id,
                version_no=int(reservation["version_no"]),
            )
            manifest = {
                "markdown_path": str(artifacts.markdown_path),
                "html_path": str(artifacts.html_path),
                "pdf_path": str(artifacts.pdf_path),
                "package_path": str(artifacts.package_path),
                "chart_paths": [str(path) for path in artifacts.chart_paths],
            }
            completed = private_fund_workflow.complete_equity_report_run(
                collection_db,
                run_id=run_id,
                markdown=artifacts.markdown_path.read_text(encoding="utf-8"),
                report_package=package,
                artifact_manifest=manifest,
                render_engine=artifacts.render_engine,
            )
            return self._equity_report_run_payload(completed)
        except Exception as exc:
            private_fund_workflow.fail_equity_report_run(
                collection_db, run_id=run_id, error=f"{type(exc).__name__}: {exc}"
            )
            raise

    def equity_report_run(
        self, *, dataset_id: str | None, run_id: str | None = None
    ) -> dict[str, Any]:
        from omnigent.server import private_fund_workflow

        info = self.dataset_info(dataset_id)
        run = private_fund_workflow.get_equity_report_run(
            Path(info["collection_db_path"]), str(info["dataset_id"]), run_id
        )
        return self._equity_report_run_payload(run)

    @staticmethod
    def _equity_report_run_payload(run: dict[str, Any]) -> dict[str, Any]:
        payload = dict(run)
        for key in ("request_json", "report_package_json", "artifact_manifest_json"):
            if key in payload:
                payload[key.removesuffix("_json")] = _decode_json(payload.pop(key), {})
        manifest = payload.get("artifact_manifest") or {}
        if manifest.get("html_path"):
            payload["html_url"] = _memo_artifact_url(Path(manifest["html_path"]))
        if manifest.get("pdf_path"):
            payload["pdf_url"] = _memo_artifact_url(Path(manifest["pdf_path"]))
        return payload

    def memo(
        self,
        *,
        topic: str = "",
        dataset_id: str | None = None,
        sections: list[str] | None = None,
        instructions: str = "",
        conversation_context: str = "",
        revision_of: str = "",
        memo_markdown: str = "",
        memo_claims: list[dict[str, Any]] | None = None,
        key_questions: list[str] | None = None,
        top_k_per_section: int = 5,
    ) -> dict[str, Any]:
        info = self.dataset_info(dataset_id)
        section_names = sections or [
            "核心投资逻辑",
            "业务与增长驱动",
            "财务与估值线索",
            "催化剂",
            "主要风险",
            "待跟踪问题",
        ]
        per_section = _coerce_top_k(top_k_per_section, default=5)
        clean_key_questions = [
            _normalize(item) for item in (key_questions or []) if _normalize(item)
        ]
        query_context = _compact_memo_context(
            topic,
            instructions,
            conversation_context,
            " ".join(clean_key_questions),
        )
        section_payloads: list[dict[str, Any]] = []
        for section in section_names:
            query = f"{query_context} {section}".strip() or section
            result = self.search(
                query=query,
                dataset_id=info["dataset_id"],
                top_k=per_section,
                include_metric_facts=True,
                include_cells=False,
            )
            section_payloads.append(
                {
                    "section": section,
                    "query": query,
                    "evidence": result["evidence"],
                }
            )
        memo_dir = Path(info["dataset_root"]) / "memos"
        memo_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        stem = f"private_fund_memo_{info['dataset_id']}_{stamp}"
        markdown_path = memo_dir / f"{stem}.md"
        html_path = memo_dir / f"{stem}.html"
        pdf_path = memo_dir / f"{stem}.pdf"
        citation_gate_path = memo_dir / f"{stem}.citation-gate.json"
        structured_markdown = _memo_claims_to_markdown(memo_claims or [])
        supplied_markdown = structured_markdown or memo_markdown.strip()
        citation_gate: dict[str, Any] = {
            "status": "not_applicable",
            "attempt_count": 0,
            "repaired": False,
            "needs_review": False,
            "valid_evidence_ids": [],
            "violations": [],
        }
        if supplied_markdown:
            supplied_markdown, citation_gate, citation_gate_audit = self._gate_memo_markdown(
                supplied_markdown,
                info=info,
                section_payloads=section_payloads,
            )
            citation_gate_path.write_text(
                json.dumps(citation_gate_audit, ensure_ascii=False, indent=2, default=str)
                + "\n",
                encoding="utf-8",
            )
            citation_gate_path.chmod(0o600)
            markdown_content = self._render_supplied_memo_markdown(
                info,
                topic,
                supplied_markdown,
                instructions=instructions,
                conversation_context=conversation_context,
                revision_of=revision_of,
                key_questions=clean_key_questions,
            )
            html = self._render_supplied_memo_html(
                info,
                topic,
                supplied_markdown,
                instructions=instructions,
                conversation_context=conversation_context,
                revision_of=revision_of,
                key_questions=clean_key_questions,
            )
            render_mode = (
                "assistant_supplied_structured_claims"
                if structured_markdown
                else "assistant_supplied_memo_markdown"
            )
        else:
            markdown_content = self._render_memo_markdown(
                info,
                topic,
                section_payloads,
                instructions=instructions,
                conversation_context=conversation_context,
                revision_of=revision_of,
                key_questions=clean_key_questions,
            )
            html = self._render_memo_html(
                info,
                topic,
                section_payloads,
                instructions=instructions,
                conversation_context=conversation_context,
                revision_of=revision_of,
                key_questions=clean_key_questions,
            )
            render_mode = "retrieved_evidence_draft"
        markdown_path.write_text(markdown_content, encoding="utf-8")
        html_path.write_text(html, encoding="utf-8")
        self._render_memo_pdf_from_html(html, pdf_path)
        from omnigent.server import private_fund_tracking

        memo_version = private_fund_tracking.register_memo_version(
            Path(info["collection_db_path"]),
            str(info["dataset_id"]),
            topic=topic or "综合投研",
            markdown_path=markdown_path,
            html_path=html_path,
            pdf_path=pdf_path,
            revision_of=revision_of,
            source_type="agent_generated",
            input_payload={
                "instructions": instructions,
                "conversation_context": conversation_context,
                "revision_of": revision_of,
                "key_questions": clean_key_questions,
                "has_memo_markdown": bool(memo_markdown.strip()),
                "has_memo_claims": bool(structured_markdown),
                "render_mode": render_mode,
                "citation_gate": citation_gate,
            },
            section_evidence=section_payloads,
        )
        return {
            "dataset": {
                "dataset_id": info["dataset_id"],
                "name": info["name"],
                "company_name": info["company_name"],
                "company_ticker": info["company_ticker"],
            },
            "topic": topic,
            "memo_markdown_path": str(markdown_path),
            "memo_html_path": str(html_path),
            "memo_html_url": _memo_artifact_url(html_path),
            "memo_pdf_path": str(pdf_path),
            "memo_pdf_url": _memo_artifact_url(pdf_path),
            "memo_series_id": memo_version["series_id"],
            "memo_version_id": memo_version["memo_version_id"],
            "memo_version_no": memo_version["version_no"],
            "revision_of_version_id": memo_version["revision_of_version_id"],
            "tracking_job": memo_version.get("tracking_job"),
            "citation_gate": citation_gate,
            "citation_gate_audit_path": (
                str(citation_gate_path) if supplied_markdown else None
            ),
            "sections": section_payloads,
            "inputs": {
                "instructions": instructions,
                "conversation_context": conversation_context,
                "revision_of": revision_of,
                "key_questions": clean_key_questions,
                "has_memo_markdown": bool(memo_markdown.strip()),
                "has_memo_claims": bool(structured_markdown),
            },
            "render_mode": render_mode,
            "memo_contract": (
                "This memo is generated from the structured dataset. The PDF is the user-facing "
                "artifact and uses plain source labels like file name + page or sheet/range, "
                "because PDF citations are not expected to be clickable. The assistant may refine "
                "wording in chat, but should keep source labels intact. Retrieved-evidence drafts "
                "are technical groundwork, not a finished investment memo; a finished memo should "
                "prefer assistant-authored memo_claims with exact evidence ids."
            ),
        }

    def _gate_memo_markdown(
        self,
        markdown: str,
        *,
        info: dict[str, Any],
        section_payloads: list[dict[str, Any]],
    ) -> tuple[str, dict[str, Any], dict[str, Any]]:
        """Run the shared gate before an assistant-authored memo is persisted."""

        src_path = self.project_root / "src"
        if str(src_path) not in sys.path:
            sys.path.insert(0, str(src_path))
        from pdf_research_demo.citation_gate import EvidenceCard, gate_markdown

        cards: dict[str, EvidenceCard] = {}
        for section in section_payloads:
            for item in section.get("evidence") or []:
                evidence_id = str(item.get("evidence_id") or "").strip()
                if not evidence_id:
                    continue
                source = item.get("source") or {}
                cards[evidence_id] = EvidenceCard(
                    evidence_id=evidence_id,
                    excerpt=str(item.get("excerpt") or item.get("summary") or ""),
                    markdown_citation=str(
                        item.get("markdown_citation")
                        or source.get("markdown_citation")
                        or f"[{evidence_id}]"
                    ),
                    source_label=str(
                        item.get("citation") or source.get("citation") or evidence_id
                    ),
                    dataset_id=str(info["dataset_id"]),
                    company_name=str(info.get("company_name") or ""),
                )

        def resolve(evidence_id: str) -> EvidenceCard | None:
            if not re.fullmatch(r"(?:chunk|fact|cell|page):.+", evidence_id):
                return None
            try:
                detail = self.source_detail(
                    evidence_id=evidence_id,
                    dataset_id=str(info["dataset_id"]),
                    context_radius=1,
                    mode="full",
                )
            except Exception:
                return None
            source = detail.get("source") or {}
            excerpt = str(
                detail.get("content")
                or (detail.get("cell") or {}).get("display_value")
                or (detail.get("metric") or {}).get("value_text")
                or detail.get("citation")
                or ""
            )
            return EvidenceCard(
                evidence_id=evidence_id,
                excerpt=excerpt,
                markdown_citation=str(
                    detail.get("markdown_citation")
                    or source.get("markdown_citation")
                    or f"[{evidence_id}]"
                ),
                source_label=str(
                    detail.get("citation") or source.get("citation") or evidence_id
                ),
                dataset_id=str(info["dataset_id"]),
                company_name=str(info.get("company_name") or ""),
            )

        repair_client = self._citation_repair_client()
        result = gate_markdown(
            markdown,
            evidence_cards=list(cards.values()),
            resolver=resolve,
            repair_client=repair_client,
            retry_once=repair_client is not None,
        )
        safe_audit = result.safe_audit(include_raw=False)
        full_audit = {
            **result.safe_audit(include_raw=True),
            "dataset_id": info["dataset_id"],
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "repair_enabled": repair_client is not None,
        }
        return result.markdown, safe_audit, full_audit

    def _citation_repair_client(self) -> Any | None:
        enabled = os.environ.get("PRIVATE_FUND_CITATION_GATE_RETRY", "").strip().lower()
        if enabled not in {"1", "true", "yes", "on"}:
            return None
        try:
            src_path = self.project_root / "src"
            if str(src_path) not in sys.path:
                sys.path.insert(0, str(src_path))
            from pdf_research_demo.llm import OpenAICompatibleChatClient, load_llm_config

            config = load_llm_config(
                self.project_root / "FinSagent" / "config" / "production.yaml"
            )
            return OpenAICompatibleChatClient(config) if config else None
        except Exception:
            return None

    def _render_memo_markdown(
        self,
        info: dict[str, Any],
        topic: str,
        sections: list[dict[str, Any]],
        *,
        instructions: str = "",
        conversation_context: str = "",
        revision_of: str = "",
        key_questions: list[str] | None = None,
    ) -> str:
        company = info.get("company_name") or info["name"]
        ticker = info.get("company_ticker") or ""
        lines = [
            f"# {company}{f' ({ticker})' if ticker else ''} 投研 memo 草稿",
            "",
            f"- 数据集: {info['name']} ({info['dataset_id']})",
            f"- 主题: {topic or '综合投研问题'}",
            f"- 生成时间: {datetime.now().isoformat(timespec='seconds')}",
            f"- 证据库: {info['collection_db_path']}",
            "",
            (
                "> 本 memo 基于最新 private_fund_directory_ingest pipeline 写入的"
                "结构化数据库生成。正式 PDF 中的引用使用文件名、页码、Sheet、"
                "单元格等纯文本来源标签。"
            ),
            "",
        ]
        if revision_of:
            lines.extend([f"- 修订来源: {revision_of}", ""])
        if instructions:
            lines.extend(["## 用户要求", "", instructions.strip(), ""])
        if conversation_context:
            lines.extend(["## 对话上下文摘要", "", conversation_context.strip(), ""])
        if key_questions:
            lines.extend(["## 关键问题", ""])
            lines.extend(f"- {item}" for item in key_questions)
            lines.append("")
        for section in sections:
            lines.extend([f"## {section['section']}", ""])
            evidence = section.get("evidence") or []
            if not evidence:
                lines.extend(["- 未检索到足够证据，需要人工补充。", ""])
                continue
            for item in evidence[:8]:
                excerpt = _best_excerpt(item.get("excerpt") or item.get("summary") or "", [], 360)
                citation = _plain_source_label(item)
                lines.append(f"- {excerpt}（来源：{citation}）")
            lines.append("")
        lines.extend(
            [
                "## 资料边界",
                "",
                "- 当前底稿只使用本地结构化数据集，不使用旧版直接 PDF QA / memo 链路。",
                "- 如果某个结论缺少引用，应标记为待复核，不应写成确定性结论。",
                "",
            ]
        )
        return "\n".join(lines)

    def _render_supplied_memo_markdown(
        self,
        info: dict[str, Any],
        topic: str,
        memo_markdown: str,
        *,
        instructions: str = "",
        conversation_context: str = "",
        revision_of: str = "",
        key_questions: list[str] | None = None,
    ) -> str:
        company = info.get("company_name") or info["name"]
        ticker = info.get("company_ticker") or ""
        lines = [
            f"# {company}{f' ({ticker})' if ticker else ''} 投研 memo",
            "",
            f"- 数据集: {info['name']} ({info['dataset_id']})",
            f"- 主题: {topic or '综合投研问题'}",
            f"- 生成时间: {datetime.now().isoformat(timespec='seconds')}",
            f"- 证据库: {info['collection_db_path']}",
            "",
            (
                "> 本 memo 正文由对话上下文和结构化数据集证据综合生成。"
                "文件中的引用已转为纯文本来源标签。"
            ),
            "",
        ]
        if revision_of:
            lines.extend([f"- 修订来源: {revision_of}", ""])
        if instructions:
            lines.extend(["## 用户要求", "", instructions.strip(), ""])
        if conversation_context:
            lines.extend(["## 对话上下文摘要", "", conversation_context.strip(), ""])
        if key_questions:
            lines.extend(["## 关键问题", ""])
            lines.extend(f"- {item}" for item in key_questions)
            lines.append("")
        lines.extend(["## Memo 正文", "", _plain_markdown_links(memo_markdown.strip()), ""])
        lines.extend(
            [
                "## 资料边界",
                "",
                "- PDF 中的来源为纯文本标签；需要交互式跳转时，请回到 Omnigent 聊天中的引用链接。",
                "- 缺少直接证据的判断应视为待复核假设。",
                "",
            ]
        )
        return "\n".join(lines)

    def _render_supplied_memo_html(
        self,
        info: dict[str, Any],
        topic: str,
        memo_markdown: str,
        *,
        instructions: str = "",
        conversation_context: str = "",
        revision_of: str = "",
        key_questions: list[str] | None = None,
    ) -> str:
        company = info.get("company_name") or info["name"]
        ticker = info.get("company_ticker") or ""
        title = f"{company}{f' ({ticker})' if ticker else ''} 投研 Memo"
        generated_at = datetime.now().isoformat(timespec="seconds")

        def paragraph_block(text: str) -> str:
            clean = text.strip()
            if not clean:
                return ""
            return "".join(f"<p>{escape(part)}</p>" for part in clean.splitlines() if part.strip())

        meta_rows = [
            ("数据集", f"{info['name']} ({info['dataset_id']})"),
            ("主题", topic or "综合投研问题"),
            ("生成时间", generated_at),
            ("证据库", info["collection_db_path"]),
        ]
        if revision_of:
            meta_rows.append(("修订来源", revision_of))
        html_parts = [
            "<!doctype html>",
            "<html>",
            "<head>",
            '<meta charset="utf-8">',
            f"<title>{escape(title)}</title>",
            "<style>",
            self._memo_html_css(),
            "</style>",
            "</head>",
            "<body>",
            '<main class="memo">',
            '<section class="cover">',
            '<div class="eyebrow">Private Fund Research Memo</div>',
            f"<h1>{escape(title)}</h1>",
            '<table class="meta">',
        ]
        for key, value in meta_rows:
            html_parts.append(f"<tr><th>{escape(key)}</th><td>{escape(str(value))}</td></tr>")
        html_parts.extend(["</table>", "</section>"])
        if instructions:
            html_parts.extend(
                [
                    '<section class="context">',
                    "<h2>用户要求</h2>",
                    paragraph_block(instructions),
                    "</section>",
                ]
            )
        if conversation_context:
            html_parts.extend(
                [
                    '<section class="context">',
                    "<h2>对话上下文摘要</h2>",
                    paragraph_block(conversation_context),
                    "</section>",
                ]
            )
        if key_questions:
            html_parts.extend(['<section class="context">', "<h2>关键问题</h2>", "<ul>"])
            html_parts.extend(f"<li>{escape(item)}</li>" for item in key_questions)
            html_parts.extend(["</ul>", "</section>"])
        html_parts.extend(
            [
                '<section class="memo-body">',
                _markdown_body_to_html(memo_markdown),
                "</section>",
                '<section class="boundary">',
                "<h2>资料边界</h2>",
                "<ul>",
                (
                    "<li>PDF 中的来源为纯文本标签；需要交互式跳转时，"
                    "请回到 Omnigent 聊天中的引用链接。</li>"
                ),
                "<li>缺少直接证据的判断应视为待复核假设。</li>",
                "</ul>",
                "</section>",
                "</main>",
                "</body>",
                "</html>",
            ]
        )
        return "\n".join(html_parts)

    def _render_memo_html(
        self,
        info: dict[str, Any],
        topic: str,
        sections: list[dict[str, Any]],
        *,
        instructions: str = "",
        conversation_context: str = "",
        revision_of: str = "",
        key_questions: list[str] | None = None,
    ) -> str:
        company = info.get("company_name") or info["name"]
        ticker = info.get("company_ticker") or ""
        title = f"{company}{f' ({ticker})' if ticker else ''} 投研 Memo"
        generated_at = datetime.now().isoformat(timespec="seconds")

        def paragraph_block(text: str) -> str:
            clean = text.strip()
            if not clean:
                return ""
            return "".join(f"<p>{escape(part)}</p>" for part in clean.splitlines() if part.strip())

        meta_rows = [
            ("数据集", f"{info['name']} ({info['dataset_id']})"),
            ("主题", topic or "综合投研问题"),
            ("生成时间", generated_at),
            ("证据库", info["collection_db_path"]),
        ]
        if revision_of:
            meta_rows.append(("修订来源", revision_of))
        html_parts = [
            "<!doctype html>",
            "<html>",
            "<head>",
            '<meta charset="utf-8">',
            f"<title>{escape(title)}</title>",
            "<style>",
            self._memo_html_css(),
            "</style>",
            "</head>",
            "<body>",
            '<main class="memo">',
            '<section class="cover">',
            '<div class="eyebrow">Private Fund Research Memo</div>',
            f"<h1>{escape(title)}</h1>",
            '<table class="meta">',
        ]
        for key, value in meta_rows:
            html_parts.append(f"<tr><th>{escape(key)}</th><td>{escape(str(value))}</td></tr>")
        html_parts.extend(["</table>", "</section>"])
        if instructions:
            html_parts.extend(
                [
                    '<section class="context">',
                    "<h2>用户要求</h2>",
                    paragraph_block(instructions),
                    "</section>",
                ]
            )
        if conversation_context:
            html_parts.extend(
                [
                    '<section class="context">',
                    "<h2>对话上下文摘要</h2>",
                    paragraph_block(conversation_context),
                    "</section>",
                ]
            )
        if key_questions:
            html_parts.extend(['<section class="context">', "<h2>关键问题</h2>", "<ul>"])
            html_parts.extend(f"<li>{escape(item)}</li>" for item in key_questions)
            html_parts.extend(["</ul>", "</section>"])
        for section in sections:
            html_parts.extend(["<section>", f"<h2>{escape(section['section'])}</h2>"])
            evidence = section.get("evidence") or []
            if not evidence:
                html_parts.append('<p class="needs-review">未检索到足够证据，需要人工补充。</p>')
                html_parts.append("</section>")
                continue
            html_parts.append("<ol>")
            for item in evidence[:8]:
                excerpt = _best_excerpt(item.get("excerpt") or item.get("summary") or "", [], 440)
                citation = _plain_source_label(item)
                html_parts.extend(
                    [
                        "<li>",
                        f'<div class="claim">{escape(excerpt)}</div>',
                        f'<div class="source">来源：{escape(citation)}</div>',
                        "</li>",
                    ]
                )
            html_parts.extend(["</ol>", "</section>"])
        html_parts.extend(
            [
                '<section class="boundary">',
                "<h2>资料边界</h2>",
                "<ul>",
                "<li>当前 memo 只使用本地结构化数据集，不使用旧版直接 PDF QA / memo 链路。</li>",
                (
                    "<li>PDF 中的来源为纯文本标签；需要交互式跳转时，"
                    "请回到 Omnigent 聊天中的引用链接。</li>"
                ),
                "<li>缺少直接证据的判断应视为待复核假设。</li>",
                "</ul>",
                "</section>",
                "</main>",
                "</body>",
                "</html>",
            ]
        )
        return "\n".join(html_parts)

    def _memo_html_css(self) -> str:
        return """
body {
  margin: 0;
  color: #18202f;
  background: #ffffff;
  font-family: "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC",
    "Microsoft YaHei", sans-serif;
  font-size: 13px;
  line-height: 1.62;
}
.memo {
  max-width: 780px;
  margin: 0 auto;
  padding: 34px 42px 48px;
}
.cover {
  border-bottom: 2px solid #26364f;
  margin-bottom: 24px;
  padding-bottom: 18px;
}
.eyebrow {
  color: #526072;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}
h1 {
  color: #111827;
  font-size: 28px;
  line-height: 1.25;
  margin: 8px 0 16px;
}
h2 {
  color: #14213d;
  font-size: 18px;
  line-height: 1.35;
  margin: 24px 0 10px;
  padding-bottom: 5px;
  border-bottom: 1px solid #d7dde6;
}
h3 {
  color: #20304a;
  font-size: 15px;
  line-height: 1.4;
  margin: 18px 0 8px;
}
.meta {
  border-collapse: collapse;
  width: 100%;
  font-size: 12px;
}
.meta th {
  color: #536174;
  font-weight: 700;
  text-align: left;
  width: 86px;
  padding: 4px 10px 4px 0;
  vertical-align: top;
}
.meta td {
  color: #1f2937;
  padding: 4px 0;
  word-break: break-word;
}
section {
  break-inside: auto;
}
ol, ul {
  margin: 8px 0 0 22px;
  padding: 0;
}
li {
  margin: 0 0 11px;
  padding-left: 2px;
}
.claim {
  color: #1f2937;
}
.memo-body p {
  margin: 8px 0;
}
.memo-body strong {
  color: #111827;
}
.memo-body table {
  border-collapse: collapse;
  width: 100%;
  margin: 10px 0 14px;
  font-size: 11px;
}
.memo-body th,
.memo-body td {
  border: 1px solid #d7dde6;
  padding: 5px 7px;
  vertical-align: top;
}
.memo-body th {
  background: #f1f4f8;
  color: #253247;
}
.source {
  color: #667085;
  font-size: 11px;
  margin-top: 3px;
}
.context {
  background: #f7f8fb;
  border: 1px solid #e1e6ee;
  padding: 12px 16px;
  margin: 14px 0;
}
.context h2 {
  border: 0;
  margin-top: 0;
  padding-bottom: 0;
}
.needs-review {
  color: #8a4b00;
  font-weight: 700;
}
.boundary {
  color: #384454;
  border-top: 1px solid #d7dde6;
  margin-top: 26px;
  padding-top: 4px;
}
""".strip()

    def _render_memo_pdf_from_html(self, html: str, pdf_path: Path) -> None:
        try:
            import fitz  # type: ignore[import-not-found]
        except Exception as exc:
            raise RuntimeError("PyMuPDF is required to render private-fund memo PDFs") from exc

        def rectfn(page_num: int, rect_num: int) -> tuple[Any, Any, None]:
            del page_num, rect_num
            mediabox = fitz.paper_rect("a4")
            content_rect = mediabox + (46, 44, -46, -50)  # noqa: RUF005
            return mediabox, content_rect, None

        writer = fitz.DocumentWriter(str(pdf_path))
        try:
            story = fitz.Story(html, user_css=self._memo_html_css(), em=12)
            story.write(writer, rectfn)
        finally:
            writer.close()


class _PrivateFundDatasetBaseTool(Tool):
    """Base class for private-fund dataset MCP tools."""

    def __init__(self, workspace: Path | None) -> None:
        self._workspace = workspace

    def _store(self, ctx: ToolContext) -> _DatasetStore:
        return _DatasetStore(ctx.workspace or self._workspace)

    def invoke(self, arguments: str, ctx: ToolContext) -> str:
        try:
            payload = _parse_arguments(arguments)
            result = self._invoke(payload, ctx)
            return _json(result)
        except Exception as exc:
            return _json({"error": str(exc), "tool": self.name()})

    def _invoke(self, payload: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        raise NotImplementedError


class PrivateFundDatasetStatusTool(_PrivateFundDatasetBaseTool):
    """Return active private-fund dataset status and schema counts."""

    @classmethod
    def name(cls) -> str:
        return "private_fund_dataset_status"

    @classmethod
    def description(cls) -> str:
        return (
            "Inspect the active private-fund research dataset stored by the latest "
            "SQLite pipeline."
        )

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": _STATUS_SCHEMA,
            },
        }

    def _invoke(self, payload: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        dataset_id = payload.get("dataset_id")
        return self._store(ctx).status(dataset_id if isinstance(dataset_id, str) else None)


class PrivateFundKnowledgeStatusTool(_PrivateFundDatasetBaseTool):
    """Return the durable Obsidian projection state for one dataset."""

    @classmethod
    def name(cls) -> str:
        return "private_fund_knowledge_status"

    @classmethod
    def description(cls) -> str:
        return (
            "Inspect Obsidian projection events, note registry state, conflicts, "
            "worker health, and configured Vault availability for a private-fund dataset."
        )

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": _STATUS_SCHEMA,
            },
        }

    def _invoke(self, payload: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        from omnigent.server import private_fund_obsidian

        dataset_id = payload.get("dataset_id")
        store = self._store(ctx)
        info = store.dataset_info(dataset_id if isinstance(dataset_id, str) else None)
        health_path = Path(info["workspace_root"]) / ".obsidian-projection-worker.json"
        worker_health: dict[str, Any] | None = None
        if health_path.is_file():
            worker_health = _decode_json(health_path.read_text(encoding="utf-8"), None)
        vault_path = os.environ.get("PRIVATE_FUND_OBSIDIAN_VAULT_PATH", "").strip()
        return {
            "projection": private_fund_obsidian.projection_status(
                Path(info["collection_db_path"]),
                str(info["dataset_id"]),
            ),
            "worker_health": worker_health,
            "vault": {
                "configured": bool(vault_path),
                "available": bool(vault_path and Path(vault_path).expanduser().is_dir()),
                "path": str(Path(vault_path).expanduser()) if vault_path else None,
            },
        }


class PrivateFundDatasetSearchTool(_PrivateFundDatasetBaseTool):
    """Search unified evidence units from the structured dataset."""

    @classmethod
    def name(cls) -> str:
        return "private_fund_dataset_search"

    @classmethod
    def description(cls) -> str:
        return (
            "Search source-backed evidence cards from the private-fund dataset DB "
            "(PDF chunks / optional Excel metric facts). Returns compact citations + "
            "short excerpts. Use private_fund_source_detail for fuller text/table windows. "
            "Set include_metric_facts=true for structured financial metrics."
        )

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": _SEARCH_SCHEMA,
            },
        }

    def _invoke(self, payload: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        query = payload.get("query")
        if not isinstance(query, str) or not query.strip():
            raise ValueError("query is required")
        dataset_id = payload.get("dataset_id")
        compact = payload.get("compact")
        if compact is None:
            compact = True
        include_expanded = bool(payload.get("include_expanded_terms", False))
        result = self._store(ctx).search(
            query=query,
            dataset_id=dataset_id if isinstance(dataset_id, str) else None,
            top_k=_coerce_top_k(payload.get("top_k")),
            include_metric_facts=bool(payload.get("include_metric_facts", False)),
            include_cells=bool(payload.get("include_cells", False)),
        )
        return _project_search_for_agent(
            result,
            compact=bool(compact),
            include_expanded_terms=include_expanded,
        )


class PrivateFundSourceDetailTool(_PrivateFundDatasetBaseTool):
    """Fetch full context for a returned evidence unit."""

    @classmethod
    def name(cls) -> str:
        return "private_fund_source_detail"

    @classmethod
    def description(cls) -> str:
        return (
            "Fetch a bounded window for an evidence_id from private_fund_dataset_search. "
            "Modes: auto|meta|text|excel_window|full. Prefer auto/text/excel_window; "
            "avoid full unless necessary."
        )

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": _SOURCE_DETAIL_SCHEMA,
            },
        }

    def _invoke(self, payload: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        evidence_id = payload.get("evidence_id")
        if not isinstance(evidence_id, str) or not evidence_id.strip():
            raise ValueError("evidence_id is required")
        dataset_id = payload.get("dataset_id")
        mode = payload.get("mode") or "auto"
        max_chars = payload.get("max_chars")
        max_cells = payload.get("max_cells")
        return self._store(ctx).source_detail(
            evidence_id=evidence_id,
            dataset_id=dataset_id if isinstance(dataset_id, str) else None,
            context_radius=int(
                payload.get("context_radius")
                if payload.get("context_radius") is not None
                else 1
            ),
            mode=str(mode),
            max_chars=int(max_chars) if max_chars is not None else _MAX_DETAIL_CONTENT_CHARS,
            max_cells=int(max_cells) if max_cells is not None else _MAX_CELL_ROWS,
        )


class PrivateFundDatasetMemoTool(_PrivateFundDatasetBaseTool):
    """Generate an evidence-backed memo draft from the structured dataset."""

    @classmethod
    def name(cls) -> str:
        return "private_fund_dataset_memo"

    @classmethod
    def description(cls) -> str:
        return (
            "Generate a source-backed private-fund memo draft from the latest structured "
            "dataset DB. This replaces the deprecated direct PDF memo flow."
        )

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": _MEMO_SCHEMA,
            },
        }

    def _invoke(self, payload: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        topic = payload.get("topic")
        dataset_id = payload.get("dataset_id")
        raw_sections = payload.get("sections")
        sections = [str(item) for item in raw_sections] if isinstance(raw_sections, list) else None
        raw_key_questions = payload.get("key_questions")
        key_questions = (
            [str(item) for item in raw_key_questions]
            if isinstance(raw_key_questions, list)
            else None
        )
        instructions = payload.get("instructions")
        conversation_context = payload.get("conversation_context")
        revision_of = payload.get("revision_of")
        memo_markdown = payload.get("memo_markdown")
        raw_memo_claims = payload.get("memo_claims")
        memo_claims = (
            [item for item in raw_memo_claims if isinstance(item, dict)]
            if isinstance(raw_memo_claims, list)
            else None
        )
        return self._store(ctx).memo(
            topic=topic if isinstance(topic, str) else "",
            dataset_id=dataset_id if isinstance(dataset_id, str) else None,
            sections=sections,
            instructions=instructions if isinstance(instructions, str) else "",
            conversation_context=(
                conversation_context if isinstance(conversation_context, str) else ""
            ),
            revision_of=revision_of if isinstance(revision_of, str) else "",
            memo_markdown=memo_markdown if isinstance(memo_markdown, str) else "",
            memo_claims=memo_claims,
            key_questions=key_questions,
            top_k_per_section=_coerce_top_k(payload.get("top_k_per_section"), default=5),
        )


class PrivateFundEquityReportGenerateTool(_PrivateFundDatasetBaseTool):
    """Generate the durable FinRobot-aligned equity research package."""

    @classmethod
    def name(cls) -> str:
        return "private_fund_equity_report_generate"

    @classmethod
    def description(cls) -> str:
        return (
            "Generate versioned Markdown, professional HTML, PDF, charts, and a JSON package "
            "using FinRobot's report renderer and Omnigent evidence provenance."
        )

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": _EQUITY_REPORT_GENERATE_SCHEMA,
            },
        }

    def _invoke(self, payload: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        title = str(payload.get("title") or "").strip()
        sections = payload.get("sections")
        section_evidence = payload.get("section_evidence")
        if not title:
            raise ValueError("title is required")
        if not isinstance(sections, dict):
            raise ValueError("sections must be an object")
        if not isinstance(section_evidence, list):
            raise ValueError("section_evidence must be an array")
        dataset_id = payload.get("dataset_id")
        report_payload = {
            key: payload.get(key)
            for key in (
                "sector",
                "rating",
                "report_date",
                "market_snapshot",
                "financial_metrics",
                "sections",
            )
        }
        return self._store(ctx).generate_equity_report(
            dataset_id=dataset_id if isinstance(dataset_id, str) else None,
            title=title,
            report_payload=report_payload,
            section_evidence=[item for item in section_evidence if isinstance(item, dict)],
        )


class PrivateFundEquityReportStatusTool(_PrivateFundDatasetBaseTool):
    @classmethod
    def name(cls) -> str:
        return "private_fund_equity_report_status"

    @classmethod
    def description(cls) -> str:
        return "Get status and artifact links for a FinRobot-aligned report run."

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": _EQUITY_REPORT_LOOKUP_SCHEMA,
            },
        }

    def _invoke(self, payload: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        result = self._store(ctx).equity_report_run(
            dataset_id=payload.get("dataset_id")
            if isinstance(payload.get("dataset_id"), str)
            else None,
            run_id=payload.get("run_id") if isinstance(payload.get("run_id"), str) else None,
        )
        result.pop("request", None)
        result.pop("report_package", None)
        return result


class PrivateFundEquityReportGetTool(PrivateFundEquityReportStatusTool):
    @classmethod
    def name(cls) -> str:
        return "private_fund_equity_report_get"

    @classmethod
    def description(cls) -> str:
        return "Retrieve a completed FinRobot-aligned report run and its full provenance package."

    def _invoke(self, payload: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        return self._store(ctx).equity_report_run(
            dataset_id=payload.get("dataset_id")
            if isinstance(payload.get("dataset_id"), str)
            else None,
            run_id=payload.get("run_id") if isinstance(payload.get("run_id"), str) else None,
        )


class PrivateFundResearchContextTool(_PrivateFundDatasetBaseTool):
    """Return user-selected research nodes for the next analysis turn."""

    @classmethod
    def name(cls) -> str:
        return "private_fund_research_context"

    @classmethod
    def description(cls) -> str:
        return "Read the research nodes the user selected as context for the next analysis."

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": _RESEARCH_CONTEXT_SCHEMA,
            },
        }

    def _invoke(self, payload: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        from omnigent.server import private_fund_workflow

        dataset_id = payload.get("dataset_id")
        info = self._store(ctx).dataset_info(dataset_id if isinstance(dataset_id, str) else None)
        workflow = private_fund_workflow.get_or_create_workflow(
            Path(info["collection_db_path"]), str(info["dataset_id"])
        )
        selected = set(workflow.get("context_node_ids") or [])
        selected_nodes = [node for node in workflow["nodes"] if node["node_id"] in selected]
        unverified_node_ids = [
            str(node["node_id"])
            for node in selected_nodes
            if not node.get("evidence_sources")
        ]
        return {
            "dataset_id": info["dataset_id"],
            "workflow_id": workflow["workflow"]["workflow_id"],
            "selected_nodes": selected_nodes,
            "unverified_node_ids": unverified_node_ids,
            "citation_contract": {
                "context_is_not_evidence": (
                    "Selected nodes are research context, not primary evidence. A node with no "
                    "evidence_sources must be re-verified with private_fund_dataset_search and "
                    "private_fund_source_detail before its factual claims are repeated."
                ),
                "required_output": (
                    "Use each evidence source's complete markdown_citation inline. "
                    "Never copy bare footnote markers such as [^1] from node text, "
                    "and never claim that source links "
                    "are unavailable when dataset search/source detail tools are available."
                ),
            },
        }


class PrivateFundResearchNodeSaveTool(_PrivateFundDatasetBaseTool):
    """Persist one agent-structured research node."""

    @classmethod
    def name(cls) -> str:
        return "private_fund_research_node_save"

    @classmethod
    def description(cls) -> str:
        return (
            "Save a user-requested research node after synthesizing selected chat information, "
            "selected parent nodes, dataset evidence, and uncertainty into the required structure."
        )

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": _RESEARCH_NODE_SAVE_SCHEMA,
            },
        }

    def _invoke(self, payload: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        from omnigent.server import private_fund_workflow

        dataset_id = payload.get("dataset_id")
        info = self._store(ctx).dataset_info(dataset_id if isinstance(dataset_id, str) else None)
        return private_fund_workflow.save_agent_node(
            Path(info["collection_db_path"]),
            str(info["dataset_id"]),
            title=str(payload.get("title") or ""),
            summary=str(payload.get("summary") or ""),
            content_markdown=str(payload.get("content_markdown") or ""),
            node_type=str(payload.get("node_type") or "insight"),
            parent_node_ids=[str(item) for item in payload.get("parent_node_ids") or []],
            # Pass through so workflow normalization can safely handle either a
            # real array or legacy JSON-string payload without splitting chars.
            evidence_ids=payload.get("evidence_ids"),
            tags=[str(item) for item in payload.get("tags") or []],
            confidence=str(payload.get("confidence") or "medium"),
            source_response_ids=[str(item) for item in payload.get("source_response_ids") or []],
            content_blocks=[
                item for item in payload.get("content_blocks") or [] if isinstance(item, dict)
            ],
        )


class PrivateFundResearchHistoryCompareTool(_PrivateFundDatasetBaseTool):
    """Compare two durable memo versions and their extracted research changes."""

    @classmethod
    def name(cls) -> str:
        return "private_fund_history_compare"

    @classmethod
    def description(cls) -> str:
        return (
            "Compare two memo versions section-by-section, or read the immutable version "
            "timeline of one tracked viewpoint, assumption, risk, catalyst, metric, or question."
        )

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": _RESEARCH_HISTORY_COMPARE_SCHEMA,
            },
        }

    def _invoke(self, payload: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        from omnigent.server import private_fund_tracking

        dataset_id = payload.get("dataset_id")
        info = self._store(ctx).dataset_info(dataset_id if isinstance(dataset_id, str) else None)
        item_id = str(payload.get("item_id") or "").strip()
        mode = str(payload.get("mode") or ("item" if item_id else "memo"))
        if mode == "item":
            if not item_id:
                raise ValueError("item_id is required for item history")
            return private_fund_tracking.get_item_timeline(
                Path(info["collection_db_path"]),
                str(info["dataset_id"]),
                item_id,
            )
        from_version_id = str(payload.get("from_version_id") or "").strip()
        to_version_id = str(payload.get("to_version_id") or "").strip()
        if not from_version_id or not to_version_id:
            raise ValueError("from_version_id and to_version_id are required for memo comparison")
        return private_fund_tracking.compare_memo_versions(
            Path(info["collection_db_path"]),
            str(info["dataset_id"]),
            from_version_id,
            to_version_id,
        )


class PrivateFundResearchTrackingListTool(_PrivateFundDatasetBaseTool):
    """Read current tracked viewpoints, assumptions, risks, catalysts, and alerts."""

    @classmethod
    def name(cls) -> str:
        return "private_fund_tracking_list"

    @classmethod
    def description(cls) -> str:
        return (
            "Read the durable research tracking overview or a filtered view of items, alerts, "
            "background jobs, watch rules, and memo versions."
        )

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": _RESEARCH_TRACKING_LIST_SCHEMA,
            },
        }

    def _invoke(self, payload: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        from omnigent.server import private_fund_tracking

        dataset_id = payload.get("dataset_id")
        info = self._store(ctx).dataset_info(dataset_id if isinstance(dataset_id, str) else None)
        collection_db = Path(info["collection_db_path"])
        resolved_dataset_id = str(info["dataset_id"])
        overview = private_fund_tracking.tracking_overview(
            collection_db, resolved_dataset_id
        )
        if payload.get("item_type") or payload.get("status"):
            overview["items"] = private_fund_tracking.list_items(
                collection_db,
                resolved_dataset_id,
                item_type=str(payload.get("item_type") or "") or None,
                status=str(payload.get("status") or "") or None,
            )
        if payload.get("alert_status"):
            overview["alerts"] = private_fund_tracking.list_alerts(
                collection_db,
                resolved_dataset_id,
                status=str(payload["alert_status"]),
            )
        view = str(payload.get("view") or "overview")
        if view == "overview":
            return overview
        key_by_view = {
            "items": "items",
            "alerts": "alerts",
            "jobs": "jobs",
            "watch_rules": "watch_rules",
            "memo_versions": "memo_versions",
        }
        selected_key = key_by_view.get(view)
        if selected_key is None:
            raise ValueError(f"unsupported tracking view: {view}")
        return {
            "dataset_id": resolved_dataset_id,
            selected_key: overview[selected_key],
        }


class PrivateFundResearchWatchUpsertTool(_PrivateFundDatasetBaseTool):
    """Create or update a durable tracking rule."""

    @classmethod
    def name(cls) -> str:
        return "private_fund_watch_upsert"

    @classmethod
    def description(cls) -> str:
        return "Create or update a durable watch rule for a risk, catalyst, assumption, or topic."

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": _RESEARCH_WATCH_UPSERT_SCHEMA,
            },
        }

    def _invoke(self, payload: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        from omnigent.server import private_fund_tracking

        dataset_id = payload.get("dataset_id")
        info = self._store(ctx).dataset_info(dataset_id if isinstance(dataset_id, str) else None)
        return private_fund_tracking.upsert_watch_rule(
            Path(info["collection_db_path"]),
            str(info["dataset_id"]),
            rule_id=str(payload.get("rule_id") or ""),
            name=str(payload.get("name") or ""),
            target_type=str(payload.get("target_type") or ""),
            target_item_id=str(payload.get("target_item_id") or ""),
            query=payload.get("query") if isinstance(payload.get("query"), dict) else {},
            min_priority=str(payload.get("min_priority") or "medium"),
            frequency=str(payload.get("frequency") or "on_ingest"),
            active=bool(payload.get("active", True)),
        )


class PrivateFundResearchAlertAcknowledgeTool(_PrivateFundDatasetBaseTool):
    """Acknowledge, dismiss, or snooze a durable tracking alert."""

    @classmethod
    def name(cls) -> str:
        return "private_fund_alert_acknowledge"

    @classmethod
    def description(cls) -> str:
        return "Acknowledge, dismiss, or snooze a risk/catalyst tracking alert."

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": _RESEARCH_ALERT_ACK_SCHEMA,
            },
        }

    def _invoke(self, payload: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        from omnigent.server import private_fund_tracking

        dataset_id = payload.get("dataset_id")
        info = self._store(ctx).dataset_info(dataset_id if isinstance(dataset_id, str) else None)
        return private_fund_tracking.update_alert_status(
            Path(info["collection_db_path"]),
            str(info["dataset_id"]),
            str(payload.get("alert_id") or ""),
            status=str(payload.get("status") or "acknowledged"),
            snoozed_until=str(payload.get("snoozed_until") or ""),
        )


def build_private_fund_dataset_tools(workspace: Path | None) -> list[Tool]:
    """Build local private-fund dataset tools for the Claude Native MCP bridge."""
    return [
        PrivateFundDatasetStatusTool(workspace),
        PrivateFundKnowledgeStatusTool(workspace),
        PrivateFundDatasetSearchTool(workspace),
        PrivateFundSourceDetailTool(workspace),
        PrivateFundDatasetMemoTool(workspace),
        PrivateFundEquityReportGenerateTool(workspace),
        PrivateFundEquityReportStatusTool(workspace),
        PrivateFundEquityReportGetTool(workspace),
        PrivateFundResearchContextTool(workspace),
        PrivateFundResearchNodeSaveTool(workspace),
        PrivateFundResearchHistoryCompareTool(workspace),
        PrivateFundResearchTrackingListTool(workspace),
        PrivateFundResearchWatchUpsertTool(workspace),
        PrivateFundResearchAlertAcknowledgeTool(workspace),
    ]
