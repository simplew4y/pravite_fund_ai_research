#!/usr/bin/env python
# coding: utf-8
"""
Markdown Exporter — exports a memo to a markdown file.

Output path:
  analyst_space/markdown_memory/memos/{memo_id}.md
"""
from __future__ import annotations

import json
import logging
import re
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT_DIR = str(_REPO_ROOT / "analyst_space" / "markdown_memory" / "memos")


def _strip_html(text: str) -> str:
    """Remove HTML tags and convert <sup> citations to [N] format."""
    # Convert <sup class="citation-ref" ...>[N]</sup> to [N]
    text = re.sub(r'<sup[^>]*>\[(\d+)\]</sup>', r'[\1]', text)
    # Convert <br> to newline
    text = re.sub(r'<br\s*/?>', '\n', text)
    # Convert <p> to double newline
    text = re.sub(r'</p>', '\n\n', text)
    text = re.sub(r'<p[^>]*>', '', text)
    # Convert <strong> to **
    text = re.sub(r'<strong[^>]*>', '**', text)
    text = re.sub(r'</strong>', '**', text)
    # Convert <em> to *
    text = re.sub(r'<em[^>]*>', '*', text)
    text = re.sub(r'</em>', '*', text)
    # Convert <h2> to ##
    text = re.sub(r'<h2[^>]*>', '## ', text)
    text = re.sub(r'</h2>', '\n', text)
    text = re.sub(r'<h3[^>]*>', '### ', text)
    text = re.sub(r'</h3>', '\n', text)
    # Convert <li> to -
    text = re.sub(r'<li[^>]*>', '- ', text)
    text = re.sub(r'</li>', '\n', text)
    # Remove remaining HTML tags
    text = re.sub(r'<[^>]+>', '', text)
    # Clean up extra whitespace
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def export_memo_to_markdown(
    memo_id: str,
    company_name: str,
    company_ticker: str,
    sections: Dict[str, str],
    section_sources: Dict[str, List[Dict[str, Any]]],
    financial_statements: Optional[Dict] = None,
    catalyst_analysis: Optional[Dict] = None,
    sensitivity_analysis: Optional[Dict] = None,
    peer_comparison: Optional[Dict] = None,
    key_metrics: Optional[Dict] = None,
    evidence_sources: Optional[List[str]] = None,
    output_dir: str = DEFAULT_OUTPUT_DIR,
) -> str:
    """Export a memo to a markdown file.

    Returns the path to the generated markdown file.
    """
    os.makedirs(output_dir, exist_ok=True)

    lines: List[str] = []
    lines.append(f"# {company_name} ({company_ticker}) — Coverage Memo")
    lines.append("")
    lines.append(f"> **Memo ID**: `{memo_id}`")
    lines.append(f"> **Generated**: {__import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append("")

    # Key metrics summary
    if key_metrics:
        lines.append("## Key Metrics")
        lines.append("")
        for k, v in key_metrics.items():
            if v and str(v) not in ("N/A", "—", "None", "unknown"):
                label = k.replace("_", " ").title()
                lines.append(f"- **{label}**: {v}")
        lines.append("")

    # Tagline
    tagline = sections.get("tagline", "")
    if tagline.strip():
        lines.append("## Investment Thesis")
        lines.append("")
        lines.append(_strip_html(tagline))
        lines.append("")

    # Section order matching the design doc
    section_titles = {
        "company_overview": "公司概况",
        "investment_overview": "核心观点",
        "major_takeaways": "财务表现",
        "valuation_overview": "估值假设摘要",
        "risks": "风险",
        "news_summary": "近期动态",
        "competitor_analysis": "竞争格局",
    }

    for key, title in section_titles.items():
        content = sections.get(key, "")
        if not content.strip():
            continue
        lines.append(f"## {title}")
        lines.append("")
        lines.append(_strip_html(content))
        lines.append("")

        # Add citations
        sources = section_sources.get(key, [])
        if sources:
            lines.append("**引用来源:**")
            for s in sources:
                idx = s.get("index", "")
                src = s.get("source", "unknown")
                page = s.get("page", "")
                snippet = s.get("snippet", "")
                display = f"[{idx}] {Path(src).name}"
                if page:
                    display += f" p.{page}"
                if snippet:
                    display += f' — "{snippet[:80]}"'
                lines.append(f"- {display}")
            lines.append("")

    # Catalysts
    if catalyst_analysis and catalyst_analysis.get("top_catalysts"):
        lines.append("## 催化剂")
        lines.append("")
        summary = catalyst_analysis.get("summary", "")
        if summary:
            lines.append(_strip_html(summary))
            lines.append("")
        for cat in catalyst_analysis["top_catalysts"]:
            event = cat.get("event_type", "")
            desc = cat.get("description", "")
            sentiment = cat.get("sentiment", "")
            impact = cat.get("impact_level", "")
            cit = cat.get("citation", "")
            cit_str = f" [{cit}]" if cit else ""
            lines.append(f"- **{event}** ({sentiment}, {impact}): {desc}{cit_str}")
        lines.append("")

    # Sensitivity
    if sensitivity_analysis and sensitivity_analysis.get("summary"):
        lines.append("## 敏感度分析")
        lines.append("")
        lines.append(_strip_html(sensitivity_analysis.get("summary", "")))
        lines.append("")
        cis = sensitivity_analysis.get("confidence_intervals", {})
        for label, vals in cis.items():
            low = vals.get("low", "")
            high = vals.get("high", "")
            lines.append(f"- **{label}**: Low = {low} | High = {high}")
        lines.append("")

    # Financial statements
    if financial_statements:
        fs = financial_statements
        lines.append("## 财务报表数据")
        lines.append("")
        period_cur = fs.get("period_current", "Current")
        period_pri = fs.get("period_prior", "Prior")
        income = fs.get("income_statement", [])
        if income:
            lines.append(f"| Metric | {period_cur} | {period_pri} |")
            lines.append("|--------|----------|----------|")
            for r in income:
                metric = r.get("metric", "")
                cur = r.get("current", "—")
                pri = r.get("prior", "—")
                lines.append(f"| {metric} | {cur} | {pri} |")
            lines.append("")
        cashflow = fs.get("cash_flow", [])
        if cashflow:
            lines.append("### Cash Flow")
            lines.append(f"| Metric | {period_cur} | {period_pri} |")
            lines.append("|--------|----------|----------|")
            for r in cashflow:
                metric = r.get("metric", "")
                cur = r.get("current", "—")
                pri = r.get("prior", "—")
                lines.append(f"| {metric} | {cur} | {pri} |")
            lines.append("")
        ratios = fs.get("key_ratios", {})
        if ratios:
            lines.append("### Key Ratios")
            lines.append("")
            for k, v in ratios.items():
                if v and str(v) not in ("N/A", "—", "None", "unknown", ""):
                    label = k.replace("_", " ").title()
                    lines.append(f"- **{label}**: {v}")
            lines.append("")

    # Peer comparison
    if peer_comparison and peer_comparison.get("peers"):
        lines.append("## 同行对比")
        lines.append("")
        for p in peer_comparison["peers"]:
            name = p.get("name", "")
            metric = p.get("metric", "—")
            value = p.get("value", "—")
            lines.append(f"- **{name}**: {metric} = {value}")
        lines.append("")

    # Sources
    if evidence_sources:
        lines.append("## 引用来源")
        lines.append("")
        for i, src in enumerate(evidence_sources, 1):
            lines.append(f"[{i}] {src}")
        lines.append("")

    # Write file
    md_path = os.path.join(output_dir, f"{memo_id}.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    logger.info(f"[MarkdownExporter] Memo exported to {md_path}")
    return md_path
