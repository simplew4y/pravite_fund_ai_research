"""FinRobot-aligned rendering for evidence-backed private-fund reports.

This module deliberately reuses FinRobot's professional HTML renderer while
keeping Omnigent's dataset, evidence, and versioning models authoritative.
FinRobot's web subprocess orchestration is not imported.
"""

from __future__ import annotations

import importlib.util
import json
import re
from dataclasses import dataclass
from datetime import datetime
from html import escape
from pathlib import Path
from types import ModuleType
from typing import Any

FINROBOT_SECTION_KEYS = (
    "tagline",
    "company_overview",
    "investment_overview",
    "valuation_overview",
    "risks",
    "competitor_analysis",
    "major_takeaways",
    "news_summary",
)


@dataclass(frozen=True)
class FinRobotReportArtifacts:
    """Durable output paths and renderer metadata for one report version."""

    markdown_path: Path
    html_path: Path
    pdf_path: Path
    package_path: Path
    chart_paths: tuple[Path, ...]
    render_engine: str = "finrobot_html_template_professional+fitz_story"


def _load_module(path: Path, name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load FinRobot module: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _finrobot_modules_dir(project_root: Path) -> Path:
    modules_dir = project_root / "finrobot" / "finrobot_equity" / "core" / "src" / "modules"
    if not (modules_dir / "html_template_professional.py").is_file():
        raise FileNotFoundError(
            "FinRobot professional renderer is missing at "
            f"{modules_dir / 'html_template_professional.py'}"
        )
    return modules_dir


def _plain_text(value: Any, *, max_chars: int = 80_000) -> str:
    return str(value or "").strip()[:max_chars]


def _source_label(item: dict[str, Any]) -> str:
    source = item.get("source") if isinstance(item.get("source"), dict) else {}
    return str(
        item.get("citation")
        or source.get("citation")
        or source.get("display_text")
        or item.get("evidence_id")
        or "local dataset"
    )


def collect_evidence_index(section_payloads: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Deduplicate retrieved evidence while preserving first-use order."""

    evidence: list[dict[str, str]] = []
    seen: set[str] = set()
    for section in section_payloads:
        for item in section.get("evidence") or []:
            if not isinstance(item, dict):
                continue
            evidence_id = str(item.get("evidence_id") or item.get("id") or "")
            identity = evidence_id or _source_label(item)
            if not identity or identity in seen:
                continue
            seen.add(identity)
            evidence.append(
                {
                    "evidence_id": evidence_id,
                    "citation": _source_label(item),
                    "excerpt": _plain_text(
                        item.get("excerpt") or item.get("summary"), max_chars=700
                    ),
                }
            )
    return evidence


def _metric_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = payload.get("financial_metrics")
    if not isinstance(rows, list):
        return []
    return [row for row in rows[:80] if isinstance(row, dict) and row.get("metric")]


def _metric_table_html(rows: list[dict[str, Any]]) -> str:
    periods: list[str] = []
    for row in rows:
        values = row.get("values")
        if isinstance(values, dict):
            for period in values:
                if str(period) not in periods:
                    periods.append(str(period))
    if not rows or not periods:
        return '<p class="body-text">Financial summary not available.</p>'
    cells = ['<table class="data-table"><thead><tr><th>Metric</th>']
    cells.extend(f"<th>{escape(period)}</th>" for period in periods)
    cells.append("</tr></thead><tbody>")
    for row in rows:
        cells.append(f"<tr><td>{escape(str(row['metric']))}</td>")
        values = row.get("values") if isinstance(row.get("values"), dict) else {}
        cells.extend(f"<td>{escape(str(values.get(period, 'N/A')))}</td>" for period in periods)
        cells.append("</tr>")
    cells.append("</tbody></table>")
    return "".join(cells)


def _analysis_dataframe(rows: list[dict[str, Any]]) -> Any:
    """Return FinRobot's expected DataFrame, importing pandas lazily."""

    if not rows:
        return None
    try:
        import pandas as pd
    except ImportError as exc:  # pragma: no cover - dependency gate is explicit.
        raise RuntimeError("pandas is required for FinRobot-aligned report charts") from exc
    records = []
    for row in rows:
        record = {"metrics": str(row["metric"])}
        values = row.get("values") if isinstance(row.get("values"), dict) else {}
        record.update({str(period): value for period, value in values.items()})
        records.append(record)
    return pd.DataFrame(records)


def _generate_charts(
    project_root: Path,
    rows: list[dict[str, Any]],
    output_dir: Path,
    ticker: str,
) -> tuple[dict[str, str], tuple[Path, ...]]:
    analysis_df = _analysis_dataframe(rows)
    if analysis_df is None or analysis_df.empty:
        return {}, ()
    modules_dir = _finrobot_modules_dir(project_root)
    chart_module = _load_module(modules_dir / "chart_generator.py", "omnigent_finrobot_charts")
    chart_dir = output_dir / "charts"
    chart_dir.mkdir(parents=True, exist_ok=True)
    chart_specs = (
        (
            "revenue_chart_path",
            "generate_revenue_ebitda_chart",
            chart_dir / "revenue_ebitda.png",
        ),
        ("eps_pe_chart_path", "generate_eps_pe_chart", chart_dir / "eps_pe.png"),
    )
    chart_values: dict[str, str] = {}
    written: list[Path] = []
    for key, function_name, output_path in chart_specs:
        function = getattr(chart_module, function_name)
        image = function(analysis_df, str(output_path), ticker)
        if image:
            chart_values[key] = str(image)
            if output_path.exists():
                written.append(output_path)
    return chart_values, tuple(written)


def _evidence_appendix_html(evidence: list[dict[str, str]]) -> str:
    rows = []
    for index, item in enumerate(evidence, start=1):
        rows.append(
            "<tr>"
            f"<td>{index}</td>"
            f"<td>{escape(item['citation'])}</td>"
            f"<td>{escape(item['evidence_id'])}</td>"
            f"<td>{escape(item['excerpt'])}</td>"
            "</tr>"
        )
    body = "".join(rows) or '<tr><td colspan="4">No verified evidence supplied.</td></tr>'
    return (
        '<section id="evidence-index" class="mb-10 page-break">'
        '<h2 class="section-title">Evidence Index</h2>'
        '<table class="data-table"><thead><tr>'
        "<th>#</th><th>Source</th><th>Evidence ID</th><th>Excerpt</th>"
        f"</tr></thead><tbody>{body}</tbody></table></section>"
    )


def _offline_css() -> str:
    """Small utility fallback because artifacts are previewed with scripts disabled."""

    return """
<style id="omnigent-offline-finrobot-css">
  .grid { display: grid; } .grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .grid-cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .gap-4 { gap: 1rem; } .gap-6 { gap: 1.5rem; } .mb-4 { margin-bottom: 1rem; }
  .mb-6 { margin-bottom: 1.5rem; } .mb-10 { margin-bottom: 2.5rem; }
  img { max-width: 100%; height: auto; } @page { size: A4; margin: 13mm; }
  @media (max-width: 800px) { .grid-cols-2, .grid-cols-4 { grid-template-columns: 1fr; } }
</style>
""".strip()


def _render_pdf_from_html(html: str, pdf_path: Path) -> None:
    try:
        import fitz
    except ImportError as exc:  # pragma: no cover - base dependency.
        raise RuntimeError("PyMuPDF is required to render the aligned report PDF") from exc

    def rectfn(page_num: int, rect_num: int) -> tuple[Any, Any, None]:
        del page_num, rect_num
        mediabox = fitz.paper_rect("a4")
        content_rect = fitz.Rect(
            mediabox.x0 + 36,
            mediabox.y0 + 34,
            mediabox.x1 - 36,
            mediabox.y1 - 40,
        )
        return mediabox, content_rect, None

    writer = fitz.DocumentWriter(str(pdf_path))
    try:
        fitz.Story(html, em=11).write(writer, rectfn)
    finally:
        writer.close()


def _markdown_report(
    info: dict[str, Any],
    payload: dict[str, Any],
    evidence: list[dict[str, str]],
    *,
    run_id: str,
    version_no: int,
) -> str:
    company = info.get("company_name") or info["name"]
    ticker = info.get("company_ticker") or ""
    sections = payload.get("sections") if isinstance(payload.get("sections"), dict) else {}
    lines = [
        f"# 📝 {company}{f' ({ticker})' if ticker else ''} Equity Research Report",
        "",
        f"- Report run: {run_id}",
        f"- Version: {version_no}",
        f"- Dataset: {info['name']} ({info['dataset_id']})",
        f"- Generated: {datetime.now().isoformat(timespec='seconds')}",
        "- Renderer: FinRobot professional report adapter",
        "",
    ]
    for key in FINROBOT_SECTION_KEYS:
        text = _plain_text(sections.get(key))
        if text:
            lines.extend([f"## {key.replace('_', ' ').title()}", "", text, ""])
    lines.extend(["## Evidence Index", ""])
    for index, item in enumerate(evidence, start=1):
        lines.append(
            f"{index}. {item['citation']} "
            f"[{item['evidence_id'] or 'unresolved'}] - {item['excerpt']}"
        )
    lines.extend(
        [
            "",
            "## Data Boundary",
            "",
            "Claims without a resolvable evidence ID remain unverified and must not be "
            "treated as investment facts.",
            "",
        ]
    )
    return "\n".join(lines)


def render_finrobot_aligned_report(
    *,
    project_root: Path,
    info: dict[str, Any],
    report_payload: dict[str, Any],
    section_payloads: list[dict[str, Any]],
    output_dir: Path,
    run_id: str,
    version_no: int,
) -> tuple[FinRobotReportArtifacts, dict[str, Any]]:
    """Render one evidence-backed report using FinRobot's professional template."""

    modules_dir = _finrobot_modules_dir(project_root)
    html_module = _load_module(
        modules_dir / "html_template_professional.py",
        "omnigent_finrobot_html_template",
    )
    renderer = html_module.render_professional_html_report
    output_dir.mkdir(parents=True, exist_ok=True)
    ticker = str(info.get("company_ticker") or info["dataset_id"])
    company = str(info.get("company_name") or info["name"])
    rows = _metric_rows(report_payload)
    chart_values, chart_paths = _generate_charts(project_root, rows, output_dir, ticker)
    evidence = collect_evidence_index(section_payloads)
    sections = (
        report_payload.get("sections") if isinstance(report_payload.get("sections"), dict) else {}
    )
    market = (
        report_payload.get("market_snapshot")
        if isinstance(report_payload.get("market_snapshot"), dict)
        else {}
    )
    report_data: dict[str, Any] = {
        "company_name_full": company,
        "company_ticker": ticker,
        "sector": str(report_payload.get("sector") or "N/A"),
        "report_date": str(report_payload.get("report_date") or datetime.now().strftime("%B %Y")),
        "rating": str(report_payload.get("rating") or "N/A"),
        "share_price": str(market.get("share_price") or "N/A"),
        "target_price": str(market.get("target_price") or "N/A"),
        "market_cap": str(market.get("market_cap") or "N/A"),
        "fwd_pe": str(market.get("fwd_pe") or "N/A"),
        "pb_ratio": str(market.get("pb_ratio") or "N/A"),
        "roe": str(market.get("roe") or "N/A"),
        "dividend_yield": str(market.get("dividend_yield") or "N/A"),
        "52w_range": str(market.get("week_52_range") or "N/A"),
        "financial_summary_table_html": _metric_table_html(rows),
        "data_source_text": f"Omnigent dataset {info['dataset_id']} with file-level provenance",
        "research_source": "Omnigent + AI4Finance FinRobot",
        "disclaimer_text": (
            "For research use only. Claims without resolvable evidence remain unverified and "
            "do not constitute investment advice."
        ),
        **{key: _plain_text(sections.get(key)) for key in FINROBOT_SECTION_KEYS},
        **chart_values,
    }
    html = str(renderer(report_data))
    html = html.replace("</head>", f"{_offline_css()}</head>", 1)
    html = re.sub(r"<script[^>]*src=\"https://cdn\.tailwindcss\.com\"[^>]*></script>", "", html)
    html = re.sub(r"<link[^>]*fonts\.googleapis\.com[^>]*>", "", html)
    html = html.replace("</body>", f"{_evidence_appendix_html(evidence)}</body>", 1)

    stem = f"finrobot_equity_report_{info['dataset_id']}_v{version_no}_{run_id[-8:]}"
    markdown_path = output_dir / f"{stem}.md"
    html_path = output_dir / f"{stem}.html"
    pdf_path = output_dir / f"{stem}.pdf"
    package_path = output_dir / f"{stem}.json"
    markdown = _markdown_report(
        info, report_payload, evidence, run_id=run_id, version_no=version_no
    )
    package = {
        "schema_version": 1,
        "run_id": run_id,
        "version_no": version_no,
        "dataset": info,
        "report_payload": report_payload,
        "report_data": report_data,
        "evidence_index": evidence,
        "render_engine": "finrobot_html_template_professional+fitz_story",
    }
    markdown_path.write_text(markdown, encoding="utf-8")
    html_path.write_text(html, encoding="utf-8")
    package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2), encoding="utf-8")
    _render_pdf_from_html(html, pdf_path)
    artifacts = FinRobotReportArtifacts(
        markdown_path=markdown_path,
        html_path=html_path,
        pdf_path=pdf_path,
        package_path=package_path,
        chart_paths=chart_paths,
    )
    return artifacts, package
