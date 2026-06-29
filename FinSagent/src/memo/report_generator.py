#!/usr/bin/env python
# coding: utf-8
"""
FinSagent Memo / Report Generator
=================================
Uses FinSagent's RAG + LLM to retrieve evidence and generate text sections,
then renders the final report using FinRobot's professional HTML template.

Data flow:
  1. Retrieve evidence from FinSagent RAG for each section topic
  2. Generate text sections (tagline, company_overview, investment_overview,
     valuation_overview, risks, competitor_analysis, major_takeaways, news_summary)
     using FinSagent's LLM (OpenAI-compatible, configured in production.yaml)
  3. Render the final HTML report using FinRobot's professional template
  4. Save HTML to disk and return the path
"""
from __future__ import annotations

import os
import sys
import json
import uuid
import asyncio
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

# ── FinRobot template path ───────────────────────────────────────────────────
_FINROBOT_EQUITY_SRC = Path(
    "/root/autodl-tmp/dir_jcl/FinRobot/finrobot_equity/core/src"
)
sys.path.insert(0, str(_FINROBOT_EQUITY_SRC))

from modules.html_template_professional import (  # noqa: E402
    render_professional_html_report,
    _derive_rating,
    get_rating_color_class,
    _markdown_to_html,
    format_key_figures_html,
    format_risks_to_html,
    format_takeaways_to_html,
    format_sensitivity_analysis_html_professional,
    format_catalyst_analysis_html_professional,
    format_retail_sentiment_html_professional,
    format_enhanced_news_html_professional,
    format_valuation_breakdown_html,
    format_advanced_charts_html_professional,
)


# ── Section definitions ──────────────────────────────────────────────────────
# Each section: (key, retrieval_query_template, prompt_template)
# The retrieval query is used to fetch evidence from RAG.
# The prompt is sent to the LLM with the retrieved evidence to generate text.

SECTION_DEFINITIONS = [
    {
        "key": "tagline",
        "retrieval_query": "{company_name} investment thesis key catalysts outlook",
        "prompt": (
            "You are a senior equity research analyst. Based on the following evidence about {company_name} ({ticker}), "
            "write a concise investment thesis tagline (2-3 sentences, max 80 words) that captures the core investment argument.\n\n"
            "Evidence:\n{evidence}\n\n"
            "Write only the tagline text, no headers or labels."
        ),
    },
    {
        "key": "company_overview",
        "retrieval_query": "{company_name} company overview business model products services market position",
        "prompt": (
            "You are a senior equity research analyst. Based on the following evidence about {company_name} ({ticker}), "
            "write a comprehensive company overview (300-500 words) covering:\n"
            "- Business description and main products/services\n"
            "- Market position and competitive advantages\n"
            "- Key operating segments\n"
            "- Recent strategic developments\n\n"
            "Use markdown formatting (## for subheadings, ** for emphasis, - for bullet points).\n"
            "Cite specific data points from the evidence where possible.\n\n"
            "Evidence:\n{evidence}\n\n"
            "Write only the company overview content, no headers or labels."
        ),
    },
    {
        "key": "investment_overview",
        "retrieval_query": "{company_name} investment thesis growth drivers competitive advantages financial performance",
        "prompt": (
            "You are a senior equity research analyst. Based on the following evidence about {company_name} ({ticker}), "
            "write a detailed investment overview (300-500 words) covering:\n"
            "- Key investment thesis points\n"
            "- Growth drivers and market opportunities\n"
            "- Competitive positioning and moat\n"
            "- Financial performance highlights\n"
            "- Strategic initiatives and outlook\n\n"
            "Use markdown formatting. Cite specific data from evidence.\n\n"
            "Evidence:\n{evidence}\n\n"
            "Write only the investment overview content, no headers or labels."
        ),
    },
    {
        "key": "valuation_overview",
        "retrieval_query": "{company_name} valuation metrics PE EV EBITDA DCF target price peer comparison",
        "prompt": (
            "You are a senior equity research analyst. Based on the following evidence about {company_name} ({ticker}), "
            "write a valuation analysis section (300-500 words) covering:\n"
            "- Current valuation metrics (P/E, EV/EBITDA, P/B, etc.)\n"
            "- Peer comparison and relative valuation\n"
            "- DCF or other valuation methodology if data available\n"
            "- Target price assessment\n"
            "- Valuation risks and sensitivities\n\n"
            "Use markdown formatting. Cite specific numbers from evidence.\n\n"
            "Evidence:\n{evidence}\n\n"
            "Write only the valuation overview content, no headers or labels."
        ),
    },
    {
        "key": "risks",
        "retrieval_query": "{company_name} risk factors challenges threats regulatory competition macroeconomic",
        "prompt": (
            "You are a senior equity research analyst. Based on the following evidence about {company_name} ({ticker}), "
            "write a comprehensive risk factors section (300-500 words). Cover:\n"
            "- Business and operational risks\n"
            "- Financial risks (leverage, liquidity, currency)\n"
            "- Regulatory and legal risks\n"
            "- Competitive and market risks\n"
            "- Macroeconomic and geopolitical risks\n\n"
            "Use markdown bullet points (- ) for each risk factor with a brief explanation.\n"
            "Cite specific evidence where possible.\n\n"
            "Evidence:\n{evidence}\n\n"
            "Write only the risk factors content, no headers or labels."
        ),
    },
    {
        "key": "competitor_analysis",
        "retrieval_query": "{company_name} competitors peer comparison market share competitive landscape industry",
        "prompt": (
            "You are a senior equity research analyst. Based on the following evidence about {company_name} ({ticker}), "
            "write a competitive landscape analysis (300-500 words) covering:\n"
            "- Key competitors and their positioning\n"
            "- Market share dynamics\n"
            "- Competitive advantages and disadvantages\n"
            "- Industry trends affecting competition\n\n"
            "Use markdown formatting. Cite specific data from evidence.\n\n"
            "Evidence:\n{evidence}\n\n"
            "Write only the competitor analysis content, no headers or labels."
        ),
    },
    {
        "key": "major_takeaways",
        "retrieval_query": "{company_name} financial performance revenue growth EBITDA margin earnings key metrics",
        "prompt": (
            "You are a senior equity research analyst. Based on the following evidence about {company_name} ({ticker}), "
            "write key takeaways (200-400 words) summarizing:\n"
            "- Revenue growth trends\n"
            "- Profitability and margin dynamics\n"
            "- Balance sheet strength\n"
            "- Key forward-looking points\n\n"
            "Format as bullet points with bold headers:\n"
            "- **Revenue Growth**: ...\n- **Profitability**: ...\n- **Balance Sheet**: ...\n- **Outlook**: ...\n\n"
            "Evidence:\n{evidence}\n\n"
            "Write only the takeaways content, no headers or labels."
        ),
    },
    {
        "key": "news_summary",
        "retrieval_query": "{company_name} recent news events announcements developments latest",
        "prompt": (
            "You are a senior equity research analyst. Based on the following evidence about {company_name} ({ticker}), "
            "write a recent news and events summary (200-400 words) covering:\n"
            "- Major recent announcements and developments\n"
            "- Earnings releases and guidance updates\n"
            "- Strategic initiatives and partnerships\n"
            "- Regulatory or legal developments\n\n"
            "Use markdown formatting. Cite specific events with dates if available.\n\n"
            "Evidence:\n{evidence}\n\n"
            "Write only the news summary content, no headers or labels."
        ),
    },
]


def _html_table_to_text(html: str) -> str:
    """Convert an HTML table to plain-text rows for LLM consumption.
    Merges adjacent $ / number cells and produces 'label: value1 | value2' lines.
    """
    import re as _re
    # Remove thead/tbody wrappers
    html = _re.sub(r'</?(thead|tbody|table)\b[^>]*>', '', html)
    # Split into rows
    rows = _re.split(r'</?tr\b[^>]*>', html)
    lines = []
    for row in rows:
        cells = _re.findall(r'<t[dh]\b[^>]*>(.*?)</t[dh]>', row, _re.DOTALL)
        if not cells:
            continue
        # Clean cells
        cells = [_re.sub(r'<[^>]+>', '', c).strip().replace('&nbsp;', ' ').replace('&amp;', '&') for c in cells]
        # Merge "$" cells with the following number cell
        merged = []
        i = 0
        while i < len(cells):
            if cells[i] == '$' and i + 1 < len(cells):
                merged.append(f"${cells[i+1]}")
                i += 2
            else:
                merged.append(cells[i])
                i += 1
        # Skip empty rows
        merged = [c for c in merged if c]
        if merged:
            label = merged[0]
            values = merged[1:]
            if values:
                lines.append(f"{label}: {' | '.join(values)}")
            else:
                lines.append(label)
    return "\n".join(lines)


def _format_evidence_for_prompt(chunks: List[Dict[str, Any]], max_chars: int = 12000) -> str:
    """Format retrieved chunks into a text block for the LLM prompt.
    Each chunk is labeled [Evidence N] so the LLM can cite it.
    HTML table chunks are converted to plain text for better LLM comprehension.
    """
    parts = []
    total = 0
    for i, chunk in enumerate(chunks, 1):
        content = chunk.get("page_content", "")
        meta = chunk.get("metadata", {})
        source = meta.get("source_file") or meta.get("source") or "unknown"
        page = meta.get("page_idx") or meta.get("page_number") or ""
        date = meta.get("date_published") or ""
        # Convert HTML tables to readable text
        if meta.get("content_type") == "table" and "<table" in content.lower():
            content = _html_table_to_text(content)
        header = f"[Evidence {i}] Source: {source}"
        if page:
            header += f" | Page: {page}"
        if date:
            header += f" | Date: {date}"
        header += "\n"
        text = header + content.strip() + "\n"
        if total + len(text) > max_chars:
            break
        parts.append(text)
        total += len(text)
    return "\n---\n".join(parts) if parts else "No evidence retrieved."


# Suffix appended to every section prompt to enforce inline citations
_CITATION_INSTRUCTION = (
    "\n\nIMPORTANT: You MUST cite your sources inline using [1], [2], etc. "
    "after every factual claim, data point, or conclusion derived from the evidence. "
    "For example: 'NVIDIA's revenue grew 262% [1] driven by data center demand [2].' "
    "Place the citation immediately after the relevant sentence or data point. "
    "Every paragraph must contain at least one citation."
)


def _build_sources_list(chunks: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    """Build a list of source references from evidence chunks.
    Returns list of {index, source, page, date, snippet}.
    """
    sources = []
    for i, chunk in enumerate(chunks, 1):
        meta = chunk.get("metadata", {})
        # Try multiple source field names used across different RAG backends
        source = (
            meta.get("source_file")
            or meta.get("filename")
            or meta.get("pageindex_doc_name")
            or meta.get("doc_id")
            or meta.get("source")
            or "unknown"
        )
        # For page: try multiple field names
        page = (
            meta.get("page_idx")
            or meta.get("page_number")
            or meta.get("pageindex_node_page")
            or ""
        )
        date = (
            meta.get("date_published")
            or meta.get("published_date")
            or ""
        )
        snippet = chunk.get("page_content", "").strip()[:300]
        sources.append({
            "index": i,
            "source": source,
            "page": str(page) if page else "",
            "date": str(date) if date else "",
            "snippet": snippet,
        })
    return sources


def _process_citations(text: str, chunks: List[Dict[str, Any]]) -> tuple:
    """Post-process LLM output to convert [EN] citations to HTML footnotes.
    Returns (html_text_with_footnotes, sources_list).
    """
    sources = _build_sources_list(chunks)

    # Convert [1], [2] etc. to superscript footnote links
    # Also handle legacy [E1] format from older prompts
    def _replace_cite(m):
        raw = m.group(1)
        nums = [n.strip().lstrip("E") for n in raw.split(",") if n.strip()]
        supers = []
        for n in nums:
            n = n.strip()
            if n.isdigit():
                supers.append(f'<sup class="citation-ref" data-evidence="{n}">[{n}]</sup>')
        return "".join(supers)

    # Match [1], [2], [1,2], [1, 2] and also legacy [E1], [E1,E2]
    processed = re.sub(r'\[E?(\d+(?:\s*,\s*E?\d+)*)\]', _replace_cite, text)

    return processed, sources


async def _retrieve_evidence(
    rag: Any,
    query: str,
    query_time: datetime,
) -> List[Dict[str, Any]]:
    """Retrieve evidence chunks from RAG.
    Falls back to unranked retrieval if the reranker is unavailable.
    """
    loop = asyncio.get_running_loop()

    def _do_retrieve():
        try:
            result = rag.retrieve(query, query_time)
            if isinstance(result, dict):
                return result.get("final_chunks", [])
            if isinstance(result, (list, tuple)) and len(result) >= 2:
                return result[1]
            return []
        except Exception as e:
            logger.warning(f"Evidence retrieval failed for query '{query[:50]}...': {e}")
            # Fallback: retrieve directly from the retriever without reranking
            try:
                retriever = rag.rag_manager._retrievers[0]
                raw_chunks = retriever.invoke(query)
                # Convert to standard dict format if needed
                fallback = []
                for ch in raw_chunks[:10]:
                    if isinstance(ch, dict):
                        fallback.append(ch)
                    else:
                        # LangChain Document object
                        fallback.append({
                            "page_content": getattr(ch, "page_content", str(ch)),
                            "metadata": getattr(ch, "metadata", {}),
                        })
                logger.info(f"Fallback retrieval returned {len(fallback)} chunks (no rerank)")
                return fallback
            except Exception as e2:
                logger.error(f"Fallback retrieval also failed: {e2}")
                return []

    return await loop.run_in_executor(None, _do_retrieve)


async def _generate_section_text(
    session_manager: Any,
    prompt: str,
    max_tokens: int = 2048,
) -> tuple:
    """Generate text using the FinSagent LLM via SessionManager.
    Returns (text, token_usage_dict).
    """
    try:
        resp = await session_manager.call_llm_async(
            [{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=max_tokens,
        )
        text = resp.choices[0].message.content.strip()
        usage = {}
        if hasattr(resp, 'usage') and resp.usage:
            usage = {
                "prompt_tokens": resp.usage.prompt_tokens or 0,
                "completion_tokens": resp.usage.completion_tokens or 0,
                "total_tokens": resp.usage.total_tokens or 0,
            }
        return text, usage
    except Exception as e:
        logger.error(f"LLM text generation failed: {e}")
        return "", {}


_METRICS_EXTRACTION_PROMPT = (
    "You are a financial data extraction assistant. From the following evidence and generated analysis about {company_name} ({ticker}), "
    "extract or estimate the key financial metrics. If a metric is explicitly mentioned in the evidence, use that value. "
    "If not directly mentioned but can be reasonably estimated from the available data, provide your best estimate. "
    "Only use null if there is absolutely no relevant data to estimate the metric.\n\n"
    "Return ONLY a valid JSON object with these exact keys:\n"
    '  "share_price": most recent stock price mentioned (e.g. "$120.50")\n'
    '  "target_price": analyst target price if mentioned (e.g. "$150.00")\n'
    '  "market_cap": market capitalization (e.g. "$3.0T" or "$3000B")\n'
    '  "fwd_pe": forward P/E ratio (e.g. "35.2")\n'
    '  "pb_ratio": price-to-book ratio (e.g. "45.6")\n'
    '  "roe": return on equity (e.g. "85.2%")\n'
    '  "dividend_yield": dividend yield (e.g. "0.03%")\n'
    '  "week_52_range": 52-week price range (e.g. "$75.61 - $140.76")\n'
    '  "sector": company sector/industry (e.g. "Semiconductors")\n'
    '  "revenue_growth": most recent revenue growth rate (e.g. "262%")\n'
    '  "ebitda_margin": EBITDA margin if available (e.g. "65.3%")\n'
    '  "eps": earnings per share (e.g. "$12.30")\n\n'
    "Return ONLY the JSON object, no other text.\n\n"
    "Evidence:\n{evidence}\n\n"
    "Generated Analysis:\n{analysis}"
)


async def _extract_financial_metrics(
    session_manager: Any,
    company_name: str,
    company_ticker: str,
    all_chunks: List[Dict[str, Any]],
    sections: Dict[str, str],
) -> tuple:
    """Use LLM to extract key financial metrics from retrieved evidence and generated analysis.
    Returns (metrics_dict, token_usage_dict, prompt_text, response_text).
    """
    evidence_text = _format_evidence_for_prompt(all_chunks, max_chars=8000)
    # Combine generated section texts as additional context for metric extraction
    analysis_parts = []
    for key in ["major_takeaways", "valuation_overview", "investment_overview", "company_overview"]:
        text = sections.get(key, "")
        if text:
            analysis_parts.append(f"### {key.replace('_', ' ').title()}\n{text}")
    analysis_text = "\n\n".join(analysis_parts)[:8000]
    prompt = _METRICS_EXTRACTION_PROMPT.format(
        company_name=company_name,
        ticker=company_ticker,
        evidence=evidence_text,
        analysis=analysis_text,
    )

    try:
        resp = await session_manager.call_llm_async(
            [{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=512,
        )
        raw = resp.choices[0].message.content.strip()
        usage = {}
        if hasattr(resp, 'usage') and resp.usage:
            usage = {
                "prompt_tokens": resp.usage.prompt_tokens or 0,
                "completion_tokens": resp.usage.completion_tokens or 0,
                "total_tokens": resp.usage.total_tokens or 0,
            }
        # Strip markdown code fences if present
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw[:-3]
        raw = raw.strip()

        metrics = json.loads(raw)
        # Convert nulls to "N/A" strings
        result = {}
        for k, v in metrics.items():
            result[k] = str(v) if v is not None else "N/A"
        logger.info(f"[Memo] Extracted metrics: {result}")
        return result, usage, prompt, raw
    except json.JSONDecodeError as e:
        logger.warning(f"[Memo] Failed to parse metrics JSON: {e}\nRaw: {raw[:200]}")
        return {}, usage if 'usage' in dir() else {}, prompt, raw if 'raw' in dir() else ''
    except Exception as e:
        logger.warning(f"[Memo] Financial metrics extraction failed: {e}")
        return {}, {}, prompt, ''


# ── Generic structured-JSON extraction helper ───────────────────────────────
async def _extract_json(
    session_manager: Any,
    prompt: str,
    max_tokens: int = 1024,
) -> tuple:
    """Call the LLM and parse its response as JSON.
    Returns (parsed_obj_or_None, usage_dict, raw_text).
    """
    raw = ""
    usage = {}
    try:
        resp = await session_manager.call_llm_async(
            [{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=max_tokens,
        )
        raw = resp.choices[0].message.content.strip()
        if hasattr(resp, "usage") and resp.usage:
            usage = {
                "prompt_tokens": resp.usage.prompt_tokens or 0,
                "completion_tokens": resp.usage.completion_tokens or 0,
                "total_tokens": resp.usage.total_tokens or 0,
            }
        # Strip markdown code fences
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw[:-3]
        raw = raw.strip()
        # Extract the first JSON object/array if extra prose surrounds it
        m = re.search(r'(\{.*\}|\[.*\])', raw, re.DOTALL)
        json_str = m.group(1) if m else raw
        return json.loads(json_str), usage, raw
    except json.JSONDecodeError as e:
        logger.warning(f"[Memo] JSON parse failed: {e}\nRaw: {raw[:200]}")
        return None, usage, raw
    except Exception as e:
        logger.warning(f"[Memo] JSON extraction failed: {e}")
        return None, usage, raw


# ── Financial statements extraction ──────────────────────────────────────────
_FINANCIAL_STATEMENTS_PROMPT = (
    "You are a financial data extraction assistant. From the following evidence (drawn from "
    "{company_name} ({ticker}) SEC filings such as 10-K/10-Q/8-K), extract ALL reported financial "
    "statement line items that appear in the evidence. Prioritize the MOST RECENT annual or "
    "quarterly figures. Use ONLY numbers that actually appear in the evidence. For each line "
    "item, include the [Evidence N] number it came from as the citation.\n\n"
    "Return ONLY a valid JSON object with this exact structure:\n"
    "{{\n"
    '  "period_current": "most recent period label (e.g. \\"FY2025\\" or \\"Q2 FY2026\\")",\n'
    '  "period_prior": "prior period label (e.g. \\"FY2024\\" or \\"Q2 FY2025\\")",\n'
    '  "income_statement": [\n'
    '    {{"metric": "Revenue", "current": "$130.5B", "prior": "$60.9B", "citation": 1}},\n'
    '    {{"metric": "Cost of Revenue", "current": "...", "prior": "...", "citation": 0}},\n'
    '    {{"metric": "Gross Profit", "current": "...", "prior": "...", "citation": 2}},\n'
    '    {{"metric": "Operating Expenses", "current": "...", "prior": "...", "citation": 0}},\n'
    '    {{"metric": "Operating Income", "current": "...", "prior": "...", "citation": 0}},\n'
    '    {{"metric": "Net Income", "current": "...", "prior": "...", "citation": 0}},\n'
    '    {{"metric": "Diluted EPS", "current": "...", "prior": "...", "citation": 0}}\n'
    "  ],\n"
    '  "cash_flow": [\n'
    '    {{"metric": "Operating Cash Flow", "current": "...", "prior": "...", "citation": 0}},\n'
    '    {{"metric": "Capital Expenditures", "current": "...", "prior": "...", "citation": 0}},\n'
    '    {{"metric": "Free Cash Flow", "current": "...", "prior": "...", "citation": 0}},\n'
    '    {{"metric": "Cash & Equivalents", "current": "...", "prior": "...", "citation": 0}},\n'
    '    {{"metric": "Total Debt", "current": "...", "prior": "...", "citation": 0}},\n'
    '    {{"metric": "Stockholders Equity", "current": "...", "prior": "...", "citation": 0}}\n'
    "  ],\n"
    '  "key_ratios": {{\n'
    '    "revenue_growth": "YoY % change", "gross_margin": "gross profit / revenue %",\n'
    '    "operating_margin": "operating income / revenue %", "net_margin": "net income / revenue %",\n'
    '    "roe": "net income / stockholders equity %", "eps": "diluted EPS $",\n'
    '    "market_cap": "...", "fwd_pe": "...", "pb_ratio": "...",\n'
    '    "dividend_yield": "...", "week_52_range": "...", "share_price": "...", "target_price": "..."\n'
    "  }}\n"
    "}}\n\n"
    "IMPORTANT: Extract as many line items as the evidence supports. Look carefully for cash flow "
    "statement data (operating cash flow, capital expenditures, free cash flow), balance sheet "
    "items (cash, debt, stockholders equity), and calculated ratios (ROE = net income / "
    "stockholders equity, margins = line item / revenue, net margin = net income / revenue). "
    "Include any metric where the evidence provides a number, even if you must compute a ratio "
    "from two reported numbers. Do NOT use \"...\" or \"unknown\" as values — only put actual "
    "numbers or omit the field entirely.\n\n"
    "Omit any line item or ratio where the evidence has NO value (do not invent numbers). "
    "Set citation to the [Evidence N] integer, or 0 if unknown.\n\n"
    "Evidence:\n{evidence}"
)


async def _extract_financial_statements(
    session_manager: Any,
    company_name: str,
    company_ticker: str,
    chunks: List[Dict[str, Any]],
) -> tuple:
    """Extract structured financial statement data from evidence.
    Returns (data_dict, usage, prompt, raw).
    """
    # Prioritize chunks that contain financial-statement keywords so the LLM
    # sees the most relevant evidence even within the char budget.
    fin_keywords = (
        "revenue", "income", "gross profit", "operating", "net income", "eps",
        "cash flow", "operating cash", "free cash", "capital expend",
        "stockholders equity", "total debt", "balance sheet", "fiscal",
        "million", "billion", "$", "margin", "roe", "assets", "liabilities",
    )
    def _fin_score(chunk):
        text = (chunk.get("page_content", "") or "").lower()
        meta = chunk.get("metadata", {})
        # Table chunks contain structured financial data — give them priority
        is_table = meta.get("content_type") == "table"
        kw_score = sum(1 for kw in fin_keywords if kw in text)
        return (10 if is_table else 0) + kw_score
    sorted_chunks = sorted(chunks, key=_fin_score, reverse=True)
    evidence_text = _format_evidence_for_prompt(sorted_chunks, max_chars=25000)
    prompt = _FINANCIAL_STATEMENTS_PROMPT.format(
        company_name=company_name, ticker=company_ticker, evidence=evidence_text,
    )
    data, usage, raw = await _extract_json(session_manager, prompt, max_tokens=2000)
    return (data or {}), usage, prompt, raw


_PLACEHOLDER_VALUES = {None, "", "N/A", "null", "None", "...", "…", "—", "-", "unknown", "Unknown"}


def _is_real_value(v) -> bool:
    """True if v is a real extracted value (not a placeholder)."""
    if v is None:
        return False
    s = str(v).strip()
    return s not in _PLACEHOLDER_VALUES and s.strip(".") != ""


def _build_financial_table_html(rows: List[Dict[str, Any]], period_current: str,
                                period_prior: str) -> str:
    """Build an HTML financial table from a list of {metric, current, prior, citation}."""
    valid = [r for r in rows if _is_real_value(r.get("current"))]
    if not valid:
        return ""
    head = (
        '<table style="width:100%; border-collapse:collapse; font-size:0.85rem;">'
        '<thead><tr style="border-bottom:2px solid #e2e8f0;">'
        '<th style="text-align:left; padding:0.5rem 0.4rem; color:#64748b; font-weight:600;">Metric</th>'
        f'<th style="text-align:right; padding:0.5rem 0.4rem; color:#64748b; font-weight:600;">{period_current or "Current"}</th>'
        f'<th style="text-align:right; padding:0.5rem 0.4rem; color:#64748b; font-weight:600;">{period_prior or "Prior"}</th>'
        '</tr></thead><tbody>'
    )
    body = ""
    for r in valid:
        metric = str(r.get("metric", ""))
        cur = str(r.get("current", ""))
        pri = str(r.get("prior", "")) if r.get("prior") not in (None, "", "null") else "—"
        cit = r.get("citation", 0)
        cit_html = (f'<sup class="citation-ref" data-evidence="{cit}">[{cit}]</sup>'
                    if cit and str(cit).isdigit() and int(cit) > 0 else "")
        body += (
            '<tr style="border-bottom:1px solid #f1f5f9;">'
            f'<td style="padding:0.45rem 0.4rem; color:#334155;">{metric}{cit_html}</td>'
            f'<td style="padding:0.45rem 0.4rem; text-align:right; color:#0f172a; font-weight:600;">{cur}</td>'
            f'<td style="padding:0.45rem 0.4rem; text-align:right; color:#64748b;">{pri}</td>'
            '</tr>'
        )
    return head + body + '</tbody></table>'


# ── Catalysts extraction ─────────────────────────────────────────────────────
_CATALYST_PROMPT = (
    "You are an equity research analyst. From the following evidence about {company_name} "
    "({ticker}), identify forward-looking catalysts: product launches, management guidance, "
    "upcoming events, partnerships, capacity expansions, or regulatory milestones. Use ONLY "
    "information present in the evidence.\n\n"
    "Return ONLY a valid JSON object:\n"
    "{{\n"
    '  "summary": "1-2 sentence overview of the catalyst landscape (with [N] citations)",\n'
    '  "top_catalysts": [\n'
    '    {{"event_type": "Product Launch", "description": "...", "sentiment": "positive", '
    '"impact_level": "high", "citation": 1}},\n'
    '    {{"event_type": "Guidance", "description": "...", "sentiment": "neutral", '
    '"impact_level": "medium", "citation": 2}}\n'
    "  ]\n"
    "}}\n\n"
    "sentiment must be one of: positive, negative, neutral. impact_level one of: high, medium, low. "
    "Return 3-6 catalysts max. If no catalysts found in evidence, return "
    '{{"summary": "", "top_catalysts": []}}.\n\n'
    "Evidence:\n{evidence}"
)


async def _extract_catalysts(
    session_manager: Any, company_name: str, company_ticker: str,
    chunks: List[Dict[str, Any]],
) -> tuple:
    """Extract catalyst_analysis dict from evidence."""
    evidence_text = _format_evidence_for_prompt(chunks, max_chars=9000)
    prompt = _CATALYST_PROMPT.format(
        company_name=company_name, ticker=company_ticker, evidence=evidence_text,
    )
    data, usage, raw = await _extract_json(session_manager, prompt, max_tokens=1200)
    return (data or {}), usage, prompt, raw


# ── Sensitivity / valuation-range extraction ─────────────────────────────────
_SENSITIVITY_PROMPT = (
    "You are an equity research analyst. From the following evidence about {company_name} "
    "({ticker}), summarize the key sensitivities and risk factors that could materially affect "
    "the company's financial outlook. This includes: revenue concentration risks, margin "
    "sensitivities (pricing, supply chain, competition), customer or segment dependency, "
    "regulatory risks, and macro factors. Use ONLY the evidence.\n\n"
    "Return ONLY a valid JSON object:\n"
    "{{\n"
    '  "summary": "2-4 sentence narrative of the main sensitivities (with [N] citations)",\n'
    '  "confidence_intervals": {{\n'
    '    "Revenue Outlook": {{"low": "bear case or downside risk", "high": "bull case or upside driver"}},\n'
    '    "Margin Outlook": {{"low": "margin pressure scenario", "high": "margin expansion scenario"}}\n'
    "  }}\n"
    "}}\n\n"
    "If the evidence has no usable sensitivity information, return "
    '{{"summary": "", "confidence_intervals": {{}}}}.\n\n'
    "Evidence:\n{evidence}"
)


async def _extract_sensitivity(
    session_manager: Any, company_name: str, company_ticker: str,
    chunks: List[Dict[str, Any]],
) -> tuple:
    """Extract sensitivity_analysis dict from valuation evidence."""
    evidence_text = _format_evidence_for_prompt(chunks, max_chars=15000)
    prompt = _SENSITIVITY_PROMPT.format(
        company_name=company_name, ticker=company_ticker, evidence=evidence_text,
    )
    data, usage, raw = await _extract_json(session_manager, prompt, max_tokens=1000)
    return (data or {}), usage, prompt, raw


# ── Peer comparison extraction ───────────────────────────────────────────────
_PEER_PROMPT = (
    "You are an equity research analyst. From the following evidence about {company_name} "
    "({ticker}), identify ALL named peer/competitor companies and ANY financial comparison "
    "metrics mentioned (revenue, margins, market cap, EBITDA, EV/EBITDA, growth rates, market "
    "share). Also include peers mentioned in the compensation committee peer group or competitive "
    "landscape discussion. Use ONLY the evidence.\n\n"
    "Return ONLY a valid JSON object:\n"
    "{{\n"
    '  "peers": [\n'
    '    {{"name": "AMD", "metric": "EV/EBITDA", "value": "...", "citation": 1}},\n'
    '    {{"name": "Intel", "metric": "EBITDA Margin", "value": "...", "citation": 2}}\n'
    "  ]\n"
    "}}\n\n"
    "If a numeric value is not given for a peer, you may still list the peer with value \"—\". "
    "Return at most 8 rows. If no peers found, return {{\"peers\": []}}.\n\n"
    "Evidence:\n{evidence}"
)


async def _extract_peers(
    session_manager: Any, company_name: str, company_ticker: str,
    chunks: List[Dict[str, Any]],
) -> tuple:
    """Extract peer comparison rows from evidence."""
    peer_keywords = (
        "competitor", "peer", "comparison", "versus", "compared",
        "amd", "intel", "broadcom", "qualcomm", "marvell", "tsmc",
        "samsung", "google", "microsoft", "amazon", "oracle",
        "market share", "competitive", "landscape", "compensation committee",
    )
    def _peer_score(chunk):
        text = (chunk.get("page_content", "") or "").lower()
        return sum(1 for kw in peer_keywords if kw in text)
    sorted_chunks = sorted(chunks, key=_peer_score, reverse=True)
    evidence_text = _format_evidence_for_prompt(sorted_chunks, max_chars=20000)
    prompt = _PEER_PROMPT.format(
        company_name=company_name, ticker=company_ticker, evidence=evidence_text,
    )
    data, usage, raw = await _extract_json(session_manager, prompt, max_tokens=900)
    return (data or {}), usage, prompt, raw


def _build_peer_table_html(peers: List[Dict[str, Any]]) -> str:
    """Build an HTML peer comparison table from a list of {name, metric, value, citation}."""
    valid = [p for p in peers if p.get("name")]
    if not valid:
        return ""
    head = (
        '<table style="width:100%; border-collapse:collapse; font-size:0.85rem;">'
        '<thead><tr style="border-bottom:2px solid #e2e8f0;">'
        '<th style="text-align:left; padding:0.5rem 0.4rem; color:#64748b; font-weight:600;">Peer</th>'
        '<th style="text-align:left; padding:0.5rem 0.4rem; color:#64748b; font-weight:600;">Metric</th>'
        '<th style="text-align:right; padding:0.5rem 0.4rem; color:#64748b; font-weight:600;">Value</th>'
        '</tr></thead><tbody>'
    )
    body = ""
    for p in valid:
        name = str(p.get("name", ""))
        metric = str(p.get("metric", "—"))
        value = str(p.get("value", "—")) or "—"
        cit = p.get("citation", 0)
        cit_html = (f'<sup class="citation-ref" data-evidence="{cit}">[{cit}]</sup>'
                    if cit and str(cit).isdigit() and int(cit) > 0 else "")
        body += (
            '<tr style="border-bottom:1px solid #f1f5f9;">'
            f'<td style="padding:0.45rem 0.4rem; color:#0f172a; font-weight:600;">{name}</td>'
            f'<td style="padding:0.45rem 0.4rem; color:#334155;">{metric}{cit_html}</td>'
            f'<td style="padding:0.45rem 0.4rem; text-align:right; color:#0f172a;">{value}</td>'
            '</tr>'
        )
    return head + body + '</tbody></table>'


async def generate_report(
    company_name: str,
    company_ticker: str,
    rag: Any,
    session_manager: Any,
    config: Dict[str, Any],
    output_dir: Optional[str] = None,
    sector: str = "N/A",
    share_price: str = "N/A",
    target_price: str = "N/A",
    market_cap: str = "N/A",
    fwd_pe: str = "N/A",
    pb_ratio: str = "N/A",
    roe: str = "N/A",
    dividend_yield: str = "N/A",
    week_52_range: str = "N/A",
    progress_callback: Optional[Callable] = None,
) -> Dict[str, Any]:
    """
    Generate a full equity research report.

    Args:
        company_name: Full company name (e.g. "NVIDIA Corporation")
        company_ticker: Ticker symbol (e.g. "NVDA")
        rag: FinSagent RAG instance (or any object with .retrieve(query, time))
        session_manager: FinSagent SessionManager with call_llm_async
        config: FinSagent config dict (from production.yaml)
        output_dir: Directory to save HTML report. Defaults to FinSagent/reports/
        progress_callback: Optional async callback(event_dict) called at each step.

    Returns:
        Dict with: report_id, html_path, sections (dict of section_key -> text),
                   token_usage (list of per-step usage dicts)
    """
    report_id = uuid.uuid4().hex[:12]
    query_time = datetime.now()
    token_usage_log: List[Dict[str, Any]] = []

    async def _emit(event: Dict[str, Any]):
        if progress_callback:
            try:
                await progress_callback(event)
            except Exception:
                pass

    # Determine output directory
    if not output_dir:
        finsagent_root = Path(__file__).resolve().parents[2]
        output_dir = str(finsagent_root / "reports" / company_ticker)
    os.makedirs(output_dir, exist_ok=True)

    logger.info(f"[Memo] Starting report generation for {company_name} ({company_ticker}), report_id={report_id}")
    await _emit({"type": "start", "report_id": report_id, "company": company_name, "ticker": company_ticker,
                 "total_sections": len(SECTION_DEFINITIONS)})

    # ── Step 1: Retrieve evidence and generate each section ─────────────────
    sections: Dict[str, str] = {}
    section_sources: Dict[str, List[Dict[str, str]]] = {}
    all_chunks: List[Dict[str, Any]] = []

    for idx, sec_def in enumerate(SECTION_DEFINITIONS):
        key = sec_def["key"]
        retrieval_query = sec_def["retrieval_query"].format(
            company_name=company_name,
            ticker=company_ticker,
        )
        logger.info(f"[Memo] Retrieving evidence for section '{key}'...")
        await _emit({"type": "section_start", "section": key, "step": idx + 1,
                     "total": len(SECTION_DEFINITIONS), "phase": "retrieval"})

        chunks = await _retrieve_evidence(rag, retrieval_query, query_time)
        all_chunks.extend(chunks)
        logger.info(f"[Memo]   Retrieved {len(chunks)} chunks for '{key}'")
        await _emit({"type": "section_retrieved", "section": key, "step": idx + 1,
                     "total": len(SECTION_DEFINITIONS), "chunks": len(chunks), "phase": "generation"})

        evidence_text = _format_evidence_for_prompt(chunks)
        prompt = sec_def["prompt"].format(
            company_name=company_name,
            ticker=company_ticker,
            evidence=evidence_text,
        )
        # Only add citation instruction when there are actual evidence chunks
        if chunks:
            prompt += _CITATION_INSTRUCTION
        else:
            prompt += "\n\nNote: No evidence was retrieved for this section. Do NOT use [1], [2] style citations. Clearly state that evidence was not available."

        logger.info(f"[Memo]   Generating text for '{key}'...")
        text, usage = await _generate_section_text(session_manager, prompt)

        # Post-process: convert [EN] citations to HTML footnotes, build sources list
        processed_text, sources = _process_citations(text, chunks)
        # If no chunks were retrieved, strip any hallucinated citations
        if not chunks:
            processed_text = re.sub(r'<sup class="citation-ref"[^>]*>\[\d+\]</sup>', '', processed_text)
        section_sources[key] = sources

        if usage:
            token_usage_log.append({"section": key, **usage})
            await _emit({"type": "section_done", "section": key, "step": idx + 1,
                         "total": len(SECTION_DEFINITIONS), "chars": len(text),
                         "prompt_tokens": usage.get("prompt_tokens", 0),
                         "completion_tokens": usage.get("completion_tokens", 0),
                         "total_tokens": usage.get("total_tokens", 0),
                         "prompt": prompt, "response": text})
        else:
            await _emit({"type": "section_done", "section": key, "step": idx + 1,
                         "total": len(SECTION_DEFINITIONS), "chars": len(text),
                         "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
                         "prompt": prompt, "response": text})
        if not text:
            processed_text = f"Analysis for {company_name} is not available due to insufficient evidence."
            logger.warning(f"[Memo]   Empty text for '{key}', using fallback")

        sections[key] = processed_text
        logger.info(f"[Memo]   ✅ '{key}' generated ({len(text)} chars, {len(sources)} sources)")

    # ── Step 2: Extract financial metrics from evidence via LLM ────────────
    logger.info("[Memo] Extracting financial metrics from evidence...")
    await _emit({"type": "metrics_start", "phase": "metrics_extraction"})
    extracted, metrics_usage, metrics_prompt, metrics_response = await _extract_financial_metrics(
        session_manager, company_name, company_ticker, all_chunks, sections,
    )
    if metrics_usage:
        token_usage_log.append({"section": "metrics_extraction", **metrics_usage})
    await _emit({"type": "metrics_done",
                 "prompt_tokens": metrics_usage.get("prompt_tokens", 0),
                 "completion_tokens": metrics_usage.get("completion_tokens", 0),
                 "total_tokens": metrics_usage.get("total_tokens", 0),
                 "prompt": metrics_prompt, "response": metrics_response})

    # ── Step 2b: Extract structured financials / catalysts / sensitivity / peers ──
    # Retrieve focused evidence for financial statements and catalysts, then run
    # parallel structured extractions. All data comes from our own RAG evidence.
    logger.info("[Memo] Retrieving financial-statement and catalyst evidence...")
    await _emit({"type": "structured_start", "phase": "structured_extraction"})

    # Use the already-retrieved all_chunks for catalysts, sensitivity, and peers.
    # For financial statements, run a dedicated retrieval query targeting the
    # income statement / cash flow / balance sheet sections of 10-K/10-Q filings,
    # since the section queries pull narrative text, not financial tables.
    fin_query = (
        f"{company_name} {company_ticker} consolidated statements of income "
        "revenue cost of revenue gross profit operating expenses net income "
        "cash flow from operating activities capital expenditures free cash flow "
        "balance sheet total assets total liabilities stockholders equity total debt"
    )
    fin_focused = await _retrieve_evidence(rag, fin_query, query_time)
    fin_chunks = fin_focused + all_chunks if fin_focused else all_chunks
    catalyst_chunks = all_chunks
    sensitivity_chunks = all_chunks
    peer_chunks = all_chunks

    fin_stmt_data, fin_usage, _, fin_raw = await _extract_financial_statements(
        session_manager, company_name, company_ticker, fin_chunks,
    )
    catalyst_data, cat_usage, _, _ = await _extract_catalysts(
        session_manager, company_name, company_ticker, catalyst_chunks,
    )
    sensitivity_data, sens_usage, _, _ = await _extract_sensitivity(
        session_manager, company_name, company_ticker, sensitivity_chunks,
    )
    peer_data, peer_usage, _, _ = await _extract_peers(
        session_manager, company_name, company_ticker, peer_chunks,
    )
    for label, u in (("financial_statements", fin_usage), ("catalysts", cat_usage),
                     ("sensitivity", sens_usage), ("peers", peer_usage)):
        if u:
            token_usage_log.append({"section": label, **u})

    # Merge financial-statement key_ratios into the metric pool (filings-derived
    # ratios fill the metric cards that the market-data prompt could not).
    key_ratios = fin_stmt_data.get("key_ratios", {}) if isinstance(fin_stmt_data, dict) else {}
    for k, v in key_ratios.items():
        if _is_real_value(v) and not extracted.get(k):
            extracted[k] = v

    # Build financial statement tables from extracted line items
    period_current = fin_stmt_data.get("period_current", "Current") if isinstance(fin_stmt_data, dict) else "Current"
    period_prior = fin_stmt_data.get("period_prior", "Prior") if isinstance(fin_stmt_data, dict) else "Prior"
    income_rows = fin_stmt_data.get("income_statement", []) if isinstance(fin_stmt_data, dict) else []
    cashflow_rows = fin_stmt_data.get("cash_flow", []) if isinstance(fin_stmt_data, dict) else []
    financial_summary_table_html = _build_financial_table_html(income_rows, period_current, period_prior)
    credit_cashflow_table_html = _build_financial_table_html(cashflow_rows, period_current, period_prior)

    # Build peer comparison table
    peers = peer_data.get("peers", []) if isinstance(peer_data, dict) else []
    peer_table_html = _build_peer_table_html(peers)

    logger.info(f"[Memo] Structured extraction: income_rows={len(income_rows)}, "
                f"cashflow_rows={len(cashflow_rows)}, catalysts={len(catalyst_data.get('top_catalysts', []) if isinstance(catalyst_data, dict) else [])}, "
                f"peers={len(peers)}")
    await _emit({"type": "structured_done",
                 "income_rows": len(income_rows), "cashflow_rows": len(cashflow_rows),
                 "catalysts": len(catalyst_data.get("top_catalysts", []) if isinstance(catalyst_data, dict) else []),
                 "peers": len(peers)})

    # Merge: use extracted values where available, fall back to provided defaults
    def _metric(key: str, default: str) -> str:
        val = extracted.get(key)
        if val is None or val == "null" or val == "N/A" or val == "None":
            return default if default != "N/A" else "—"
        return str(val)

    share_price = _metric("share_price", share_price)
    target_price = _metric("target_price", target_price)
    market_cap = _metric("market_cap", market_cap)
    fwd_pe = _metric("fwd_pe", fwd_pe)
    pb_ratio = _metric("pb_ratio", pb_ratio)
    roe = _metric("roe", roe)
    dividend_yield = _metric("dividend_yield", dividend_yield)
    week_52_range = _metric("week_52_range", week_52_range)
    sector = _metric("sector", sector)

    # Build revenue key figures from extracted metrics (filings-derived)
    def _has(k):
        v = extracted.get(k)
        return v and v not in ("N/A", "None", None, "null")

    revenue_key_figures = {}
    if _has("revenue_growth"):
        revenue_key_figures["Revenue Growth (YoY)"] = extracted["revenue_growth"]
    if _has("gross_margin"):
        revenue_key_figures["Gross Margin"] = extracted["gross_margin"]
    if _has("operating_margin"):
        revenue_key_figures["Operating Margin"] = extracted["operating_margin"]
    if _has("net_margin"):
        revenue_key_figures["Net Margin"] = extracted["net_margin"]
    if _has("ebitda_margin"):
        revenue_key_figures["EBITDA Margin"] = extracted["ebitda_margin"]

    eps_key_figures = {}
    if _has("eps"):
        eps_key_figures["EPS"] = extracted["eps"]
    if _has("roe"):
        eps_key_figures["ROE"] = extracted["roe"]
    if fwd_pe != "—":
        eps_key_figures["Forward P/E"] = fwd_pe

    logger.info(f"[Memo] Metrics resolved: price={share_price}, target={target_price}, sector={sector}")

    # ── Step 3: Build report data dict for FinRobot template ────────────────
    report_date = datetime.now().strftime("%B %d, %Y")

    # Parse target price: handle ranges like "$130–$150" by taking the midpoint
    def _parse_price(s):
        if not s or s == "—":
            return None
        try:
            # Extract first number from strings like "$120.50" or "$130–$150"
            nums = re.findall(r'[\d,.]+', s.replace(',', ''))
            if nums:
                return float(nums[0])
        except (ValueError, IndexError):
            pass
        return None

    sp = _parse_price(share_price)
    tp = _parse_price(target_price)
    if sp and tp:
        rating = _derive_rating(sp, tp, "Hold")
    else:
        rating = "Hold"
    rating_color_class = get_rating_color_class(rating)

    # Build source citations from all retrieved chunks
    source_set = set()
    for chunk in all_chunks:
        meta = chunk.get("metadata", {})
        src = meta.get("source_file") or meta.get("source")
        if src:
            source_set.add(os.path.basename(src))
    data_source_text = "FinSagent RAG Evidence: " + ", ".join(sorted(source_set)) if source_set else "FinSagent RAG"

    report_data = {
        "company_name_full": company_name,
        "company_ticker": company_ticker,
        "company_name_ticker": f"{company_name} ({company_ticker})",
        "report_date": report_date,
        "sector": sector,
        "share_price": share_price,
        "target_price": target_price,
        "rating": rating,
        "rating_color_class": rating_color_class,
        "market_cap": market_cap,
        "fwd_pe": fwd_pe,
        "pb_ratio": pb_ratio,
        "roe": roe,
        "dividend_yield": dividend_yield,
        "week_52_range": week_52_range,
        "52w_range": week_52_range,

        # Text sections from LLM
        "tagline": sections.get("tagline", ""),
        "company_overview": sections.get("company_overview", ""),
        "investment_overview": sections.get("investment_overview", ""),
        "valuation_overview": sections.get("valuation_overview", ""),
        "risks": sections.get("risks", ""),
        "competitor_analysis": sections.get("competitor_analysis", ""),
        "major_takeaways": sections.get("major_takeaways", ""),
        "news_summary": sections.get("news_summary", ""),

        # Revenue/EPS analysis text (derived)
        "revenue_analysis_text": sections.get("major_takeaways", "")[:200] + "..." if len(sections.get("major_takeaways", "")) > 200 else sections.get("major_takeaways", ""),
        "eps_analysis_text": sections.get("valuation_overview", "")[:200] + "..." if len(sections.get("valuation_overview", "")) > 200 else sections.get("valuation_overview", ""),
        "revenue_key_figures": revenue_key_figures,
        "eps_key_figures": eps_key_figures,

        # Chart paths (empty — no FMP charts)
        "revenue_chart_path": "",
        "eps_pe_chart_path": "",
        "ev_ebitda_chart_path": "",

        # Tables (extracted from RAG evidence)
        "financial_summary_table_html": financial_summary_table_html or "<p class='body-text' style='color:#94a3b8; font-style:italic;'>No income-statement figures found in the retrieved evidence.</p>",
        "credit_cashflow_table_html": credit_cashflow_table_html or "<p class='body-text' style='color:#94a3b8; font-style:italic;'>No cash-flow figures found in the retrieved evidence.</p>",
        "peer_ebitda_table_html": peer_table_html or "<p class='body-text' style='color:#94a3b8; font-style:italic;'>No peer comparison data found in the retrieved evidence.</p>",
        "peer_ev_ebitda_table_html": peer_table_html or "<p class='body-text' style='color:#94a3b8; font-style:italic;'>No peer comparison data found in the retrieved evidence.</p>",
        "peer_ev_ebitda_table_html_comp": peer_table_html or "<p class='body-text' style='color:#94a3b8; font-style:italic;'>No peer comparison data found in the retrieved evidence.</p>",

        # Enhanced analysis (extracted from RAG evidence)
        "sensitivity_analysis": sensitivity_data if isinstance(sensitivity_data, dict) else {},
        "catalyst_analysis": catalyst_data if isinstance(catalyst_data, dict) else {},
        "enhanced_news": {},
        "retail_sentiment": {},
        "valuation_analysis": {},
        "technical_indicators": {
            "overall_signal": "N/A",
            "ma_signal": "N/A",
            "rsi_signal": "N/A",
            "macd_signal_label": "N/A",
            "volume_signal": "N/A",
        },
        "enhanced_charts": {},
        # Provide share_price and 52w_range so the advanced charts fallback
        # shows actual values instead of N/A for Current Price and 52W Range
        "share_price": share_price,
        "company_ticker": company_ticker,
        "52w_range": week_52_range,
        "week_52_range": week_52_range,
        "stock_price_chart_path": "",
        "technical_indicators_path": "",
        "financial_radar_path": "",
        "cash_flow_chart_path": "",

        # Meta
        "research_source": "FinSagent AI Equity Research",
        "data_source_text": data_source_text,
        "disclaimer_text": (
            "Disclaimer: This report is generated by FinSagent AI based on retrieved evidence from "
            "internal document collections. The information is for research purposes only and does "
            "not constitute investment advice. All conclusions should be independently verified."
        ),
        "analyst_names": ["FinSagent AI"],
        "analyst_emails": ["ai@finsagent.local"],
        "closing_price_date": report_date,
        "logo_image_path": "",
        "report_generated_time": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "section_sources": section_sources,
    }

    # ── Step 3: Render HTML using FinRobot professional template ────────────
    logger.info("[Memo] Rendering professional HTML report...")
    await _emit({"type": "rendering", "phase": "html_render"})
    html_content = render_professional_html_report(report_data)

    html_path = os.path.join(output_dir, f"Equity_Report_{company_ticker}_{report_id}.html")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html_content)
    logger.info(f"[Memo] ✅ Report saved to: {html_path}")

    # ── Step 4: Save metadata JSON ──────────────────────────────────────────
    meta_path = os.path.join(output_dir, f"Equity_Report_{company_ticker}_{report_id}.json")
    meta = {
        "report_id": report_id,
        "company_name": company_name,
        "company_ticker": company_ticker,
        "html_path": html_path,
        "created_at": datetime.now().isoformat(),
        "sections": sections,
        "evidence_count": len(all_chunks),
        "evidence_sources": sorted(source_set),
        "section_sources": section_sources,
        "financial_statements": fin_stmt_data if isinstance(fin_stmt_data, dict) else {},
        "catalyst_analysis": catalyst_data if isinstance(catalyst_data, dict) else {},
        "sensitivity_analysis": sensitivity_data if isinstance(sensitivity_data, dict) else {},
        "peer_comparison": peer_data if isinstance(peer_data, dict) else {},
        "key_metrics": {
            "share_price": share_price, "target_price": target_price,
            "market_cap": market_cap, "fwd_pe": fwd_pe, "pb_ratio": pb_ratio,
            "roe": roe, "dividend_yield": dividend_yield, "week_52_range": week_52_range,
        },
        "token_usage": token_usage_log,
    }
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    # Compute totals
    total_prompt = sum(u.get("prompt_tokens", 0) for u in token_usage_log)
    total_completion = sum(u.get("completion_tokens", 0) for u in token_usage_log)
    total_tokens = sum(u.get("total_tokens", 0) for u in token_usage_log)
    await _emit({"type": "complete", "html_path": html_path,
                 "total_prompt_tokens": total_prompt,
                 "total_completion_tokens": total_completion,
                 "total_tokens": total_tokens,
                 "token_usage_log": token_usage_log})

    return {
        "report_id": report_id,
        "html_path": html_path,
        "meta_path": meta_path,
        "sections": sections,
        "evidence_count": len(all_chunks),
        "evidence_sources": sorted(source_set),
        "token_usage": token_usage_log,
    }
