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
from typing import Any, Dict, List, Optional

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


def _format_evidence_for_prompt(chunks: List[Dict[str, Any]], max_chars: int = 12000) -> str:
    """Format retrieved chunks into a text block for the LLM prompt."""
    parts = []
    total = 0
    for i, chunk in enumerate(chunks, 1):
        content = chunk.get("page_content", "")
        meta = chunk.get("metadata", {})
        source = meta.get("source_file") or meta.get("source") or "unknown"
        page = meta.get("page_idx") or meta.get("page_number") or ""
        date = meta.get("date_published") or ""
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


async def _retrieve_evidence(
    rag: Any,
    query: str,
    query_time: datetime,
) -> List[Dict[str, Any]]:
    """Retrieve evidence chunks from RAG."""
    loop = asyncio.get_running_loop()

    def _do_retrieve():
        try:
            result = rag.retrieve(query, query_time)
            if isinstance(result, dict):
                return result.get("final_chunks", [])
            # legacy tuple: (context, chunks, time_info)
            if isinstance(result, (list, tuple)) and len(result) >= 2:
                return result[1]
            return []
        except Exception as e:
            logger.warning(f"Evidence retrieval failed for query '{query[:50]}...': {e}")
            return []

    return await loop.run_in_executor(None, _do_retrieve)


async def _generate_section_text(
    session_manager: Any,
    prompt: str,
    max_tokens: int = 2048,
) -> str:
    """Generate text using the FinSagent LLM via SessionManager."""
    try:
        resp = await session_manager.call_llm_async(
            [{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=max_tokens,
        )
        return resp.choices[0].message.content.strip()
    except Exception as e:
        logger.error(f"LLM text generation failed: {e}")
        return ""


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

    Returns:
        Dict with: report_id, html_path, sections (dict of section_key -> text)
    """
    report_id = uuid.uuid4().hex[:12]
    query_time = datetime.now()

    # Determine output directory
    if not output_dir:
        finsagent_root = Path(__file__).resolve().parents[2]
        output_dir = str(finsagent_root / "reports" / company_ticker)
    os.makedirs(output_dir, exist_ok=True)

    logger.info(f"[Memo] Starting report generation for {company_name} ({company_ticker}), report_id={report_id}")

    # ── Step 1: Retrieve evidence and generate each section ─────────────────
    sections: Dict[str, str] = {}
    all_chunks: List[Dict[str, Any]] = []

    for sec_def in SECTION_DEFINITIONS:
        key = sec_def["key"]
        retrieval_query = sec_def["retrieval_query"].format(
            company_name=company_name,
            ticker=company_ticker,
        )
        logger.info(f"[Memo] Retrieving evidence for section '{key}'...")

        chunks = await _retrieve_evidence(rag, retrieval_query, query_time)
        all_chunks.extend(chunks)
        logger.info(f"[Memo]   Retrieved {len(chunks)} chunks for '{key}'")

        evidence_text = _format_evidence_for_prompt(chunks)
        prompt = sec_def["prompt"].format(
            company_name=company_name,
            ticker=company_ticker,
            evidence=evidence_text,
        )

        logger.info(f"[Memo]   Generating text for '{key}'...")
        text = await _generate_section_text(session_manager, prompt)
        if not text:
            text = f"Analysis for {company_name} is not available due to insufficient evidence."
            logger.warning(f"[Memo]   Empty text for '{key}', using fallback")

        sections[key] = text
        logger.info(f"[Memo]   ✅ '{key}' generated ({len(text)} chars)")

    # ── Step 2: Build report data dict for FinRobot template ────────────────
    report_date = datetime.now().strftime("%B %d, %Y")
    rating = _derive_rating(share_price, target_price, "N/A")
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
        "eps_analysis_text": "Earnings analysis based on retrieved evidence.",
        "revenue_key_figures": {},
        "eps_key_figures": {},

        # Chart paths (empty — no FMP charts)
        "revenue_chart_path": "",
        "eps_pe_chart_path": "",
        "ev_ebitda_chart_path": "",

        # Tables (empty placeholders)
        "financial_summary_table_html": "<p class='body-text' style='color:#94a3b8; font-style:italic;'>Financial summary table not available. Refer to text analysis above.</p>",
        "credit_cashflow_table_html": "<p class='body-text' style='color:#94a3b8; font-style:italic;'>Credit & cashflow metrics not available.</p>",
        "peer_ebitda_table_html": "<p class='body-text' style='color:#94a3b8; font-style:italic;'>Peer EBITDA data not available.</p>",
        "peer_ev_ebitda_table_html": "<p class='body-text' style='color:#94a3b8; font-style:italic;'>Peer EV/EBITDA data not available.</p>",
        "peer_ev_ebitda_table_html_comp": "<p class='body-text' style='color:#94a3b8; font-style:italic;'>Peer EV/EBITDA data not available.</p>",

        # Enhanced analysis (empty)
        "sensitivity_analysis": {},
        "catalyst_analysis": {},
        "enhanced_news": {},
        "retail_sentiment": {},
        "valuation_analysis": {},
        "technical_indicators": {},
        "enhanced_charts": {},

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
    }

    # ── Step 3: Render HTML using FinRobot professional template ────────────
    logger.info("[Memo] Rendering professional HTML report...")
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
    }
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    return {
        "report_id": report_id,
        "html_path": html_path,
        "meta_path": meta_path,
        "sections": sections,
        "evidence_count": len(all_chunks),
        "evidence_sources": sorted(source_set),
    }
