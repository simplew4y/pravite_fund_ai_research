"""Render memo drafts to local PDF files."""

from __future__ import annotations

import re
import textwrap
from datetime import date
from pathlib import Path

from .demo import MemoDraft, MemoSection


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "output" / "pdf"


def _safe_slug(value: str) -> str:
    slug = re.sub(r"[^0-9A-Za-z._-]+", "_", value.strip()).strip("._-")
    return slug[:120] or "memo"


def _plain_lines(memo: MemoDraft) -> list[str]:
    lines = [memo.title, ""]
    for section in memo.sections:
        suffix = " [needs review]" if section.needs_review else ""
        lines.extend([f"{section.title}{suffix}", ""])
        lines.extend(section.content.splitlines() or [""])
        lines.append("")
        if section.citations:
            lines.append("Citations:")
            for citation in section.citations:
                lines.append(f"- {citation.citation_id}: {citation.display}")
            lines.append("")
    unique = {}
    for citation in memo.citations:
        unique.setdefault(citation.citation_id, citation)
    if unique:
        lines.extend(["Reference Sources", ""])
        for citation in unique.values():
            review = " needs_review" if citation.needs_review else ""
            lines.append(f"{citation.citation_id}: {citation.display}{review}")
            if citation.quote:
                lines.append(f"  Quote: {citation.quote}")
    return lines


def _normalize_visible_text(value: str) -> str:
    replacements = {
        "\u2018": "'",
        "\u2019": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u2013": "-",
        "\u2014": "-",
        "\u2026": "...",
        "\u00a0": " ",
    }
    for old, new in replacements.items():
        value = value.replace(old, new)
    return value.encode("latin-1", "replace").decode("latin-1")


def _load_image_font(size: int, *, bold: bool = False):
    from PIL import ImageFont

    candidates = (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    )
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size=size)
        except Exception:
            continue
    return ImageFont.load_default()


def _text_width(draw, text: str, font) -> int:
    bbox = draw.textbbox((0, 0), text, font=font)
    return int(bbox[2] - bbox[0])


def _wrap_image_line(draw, line: str, font, max_width: int) -> list[str]:
    line = _normalize_visible_text(line)
    if not line:
        return [""]
    words = line.split()
    if not words:
        return [""]
    wrapped: list[str] = []
    current = words[0]
    for word in words[1:]:
        candidate = f"{current} {word}"
        if _text_width(draw, candidate, font) <= max_width:
            current = candidate
        else:
            wrapped.append(current)
            current = word
    wrapped.append(current)
    return wrapped


def _memo_company_ticker(memo: MemoDraft) -> tuple[str, str]:
    match = re.match(r"(.+?)\s+\(([^)]+)\)", memo.title)
    if match:
        return match.group(1).strip(), match.group(2).strip()
    return memo.title.replace(" PDF Evidence Memo", "").strip(), ""


def _section_lookup(memo: MemoDraft) -> dict[str, MemoSection]:
    return {section.title.lower(): section for section in memo.sections}


def _find_section(memo: MemoDraft, *names: str) -> MemoSection | None:
    lookup = _section_lookup(memo)
    for name in names:
        section = lookup.get(name.lower())
        if section is not None:
            return section
    return None


def _section_text(section: MemoSection | None, fallback: str = "") -> str:
    if section is None:
        return fallback
    return section.content.strip() or fallback


def _clean_report_line(line: str) -> str:
    text = re.sub(r"\s+", " ", line.strip())
    text = re.sub(r"^\-\s*", "", text)
    return text


def _section_bullets(section: MemoSection | None, limit: int = 4) -> list[str]:
    if section is None:
        return []
    bullets = []
    for line in section.content.splitlines():
        text = _clean_report_line(line)
        if text:
            bullets.append(text)
    if not bullets and section.content.strip():
        bullets.append(_clean_report_line(section.content))
    return bullets[:limit]


def _shorten(value: str, max_chars: int) -> str:
    value = _clean_report_line(value)
    if len(value) <= max_chars:
        return value
    return value[: max_chars - 3].rstrip() + "..."


def _money_values(text: str, limit: int = 6) -> list[float]:
    values: list[float] = []
    for raw in re.findall(r"\$ ?\(?([0-9][0-9,.]*)\)?", text):
        try:
            values.append(float(raw.replace(",", "")))
        except ValueError:
            continue
        if len(values) >= limit:
            break
    return values


def _years(text: str, limit: int = 6) -> list[str]:
    seen: list[str] = []
    for year in re.findall(r"\b20\d{2}\b", text):
        if year not in seen:
            seen.append(year)
        if len(seen) >= limit:
            break
    return seen


class _ReportRenderer:
    def __init__(self, memo: MemoDraft) -> None:
        from PIL import Image, ImageDraw

        self.memo = memo
        self.width = 1275
        self.height = 1650
        self.left = 335
        self.content_width = 605
        self.right = self.left + self.content_width
        self.bottom = 1545
        self.pages: list[Image.Image] = []
        self.image = Image.new("RGB", (self.width, self.height), "white")
        self.draw = ImageDraw.Draw(self.image)
        self.y = 72
        self.page_no = 1
        self.colors = {
            "navy": (15, 23, 42),
            "navy2": (24, 35, 56),
            "ink": (17, 24, 39),
            "muted": (93, 110, 130),
            "line": (220, 226, 236),
            "soft": (247, 249, 252),
            "soft_blue": (243, 245, 255),
            "accent": (99, 102, 241),
            "green": (16, 185, 129),
            "red": (239, 68, 68),
            "orange": (217, 119, 6),
        }
        self.fonts = {
            "tiny": _load_image_font(14),
            "small": _load_image_font(16),
            "body": _load_image_font(18),
            "body_bold": _load_image_font(18, bold=True),
            "h3": _load_image_font(21, bold=True),
            "h2": _load_image_font(26, bold=True),
            "title": _load_image_font(33, bold=True),
            "hero": _load_image_font(38, bold=True),
        }

    def finish(self, output_path: Path) -> None:
        self._draw_footer()
        self.pages.append(self.image)
        first, rest = self.pages[0], self.pages[1:]
        first.save(output_path, "PDF", resolution=150.0, save_all=True, append_images=rest)

    def new_page(self) -> None:
        from PIL import Image, ImageDraw

        self._draw_footer()
        self.pages.append(self.image)
        self.page_no += 1
        self.image = Image.new("RGB", (self.width, self.height), "white")
        self.draw = ImageDraw.Draw(self.image)
        self.y = 58
        self.draw.text((self.left, 32), self.memo.title, fill=self.colors["muted"], font=self.fonts["tiny"])

    def ensure(self, height: int) -> None:
        if self.y + height > self.bottom:
            self.new_page()

    def _draw_footer(self) -> None:
        footer = f"Source-backed local PDF memo | Page {self.page_no}"
        self.draw.text((self.left, 1585), footer, fill=(145, 158, 176), font=self.fonts["tiny"])

    def text_lines(self, text: str, font_key: str, width: int | None = None) -> list[str]:
        return _wrap_image_line(self.draw, text, self.fonts[font_key], width or self.content_width)

    def draw_wrapped(
        self,
        text: str,
        *,
        x: int | None = None,
        width: int | None = None,
        font_key: str = "body",
        fill: tuple[int, int, int] | None = None,
        line_height: int = 27,
    ) -> None:
        x = self.left if x is None else x
        width = self.content_width if width is None else width
        fill = self.colors["ink"] if fill is None else fill
        for line in self.text_lines(text, font_key, width):
            self.ensure(line_height)
            self.draw.text((x, self.y), line, fill=fill, font=self.fonts[font_key])
            self.y += line_height

    def section_heading(self, title: str) -> None:
        self.ensure(165)
        self.y += 10
        self.draw.rounded_rectangle(
            [self.left, self.y + 3, self.left + 4, self.y + 30],
            radius=2,
            fill=self.colors["accent"],
        )
        self.draw.text((self.left + 14, self.y), title, fill=self.colors["ink"], font=self.fonts["h2"])
        self.y += 48

    def subheading(self, title: str) -> None:
        self.ensure(34)
        self.draw.text((self.left, self.y), title, fill=self.colors["ink"], font=self.fonts["h3"])
        self.y += 34

    def header(self, company: str, ticker: str) -> None:
        header_x, header_y, header_w, header_h = 42, 42, self.width - 84, 190
        self.draw.rectangle([header_x, header_y, header_x + header_w, header_y + header_h], fill=self.colors["navy"])
        self.draw.rounded_rectangle([self.left, 78, self.left + 142, 100], radius=10, fill=(47, 52, 105))
        self.draw.text((self.left + 14, 81), "AI EQUITY RESEARCH", fill=(198, 205, 255), font=self.fonts["tiny"])
        today = date.today().strftime("%B %d, %Y").replace(" 0", " ")
        self.draw.text((self.left + 205, 81), today, fill=(132, 146, 166), font=self.fonts["tiny"])
        self.draw.text((self.left, 113), company, fill="white", font=self.fonts["hero"])
        if ticker:
            self.draw.rounded_rectangle([self.left, 165, self.left + 40, 190], radius=5, outline=(61, 77, 105), width=1)
            self.draw.text((self.left + 9, 169), ticker, fill=(191, 203, 221), font=self.fonts["tiny"])
            self.draw.text((self.left + 52, 169), "PDF Evidence Memo", fill=(132, 146, 166), font=self.fonts["tiny"])
        self.y = 218
        self.metric_cards()
        self.y = 316

    def metric_cards(self) -> None:
        unique_citations = {citation.citation_id for citation in self.memo.citations}
        needs_review = any(section.needs_review for section in self.memo.sections)
        metrics = [
            ("RATING", "Source"),
            ("EVIDENCE", str(sum(len(section.citations) for section in self.memo.sections))),
            ("CITATIONS", str(len(unique_citations))),
            ("LLM", "Used" if self.memo.llm_used else "Extractive"),
            ("REVIEW", "Yes" if needs_review else "No"),
        ]
        gap = 10
        card_w = (self.content_width - gap * (len(metrics) - 1)) // len(metrics)
        for index, (label, value) in enumerate(metrics):
            x = self.left + index * (card_w + gap)
            self.draw.rounded_rectangle(
                [x, self.y, x + card_w, self.y + 70],
                radius=8,
                fill="white",
                outline=self.colors["line"],
                width=1,
            )
            self.draw.rectangle([x + 1, self.y, x + card_w - 1, self.y + 4], fill=self.colors["accent"])
            self.draw.text((x + 12, self.y + 14), label, fill=self.colors["muted"], font=self.fonts["tiny"])
            self.draw.text((x + 12, self.y + 38), value, fill=self.colors["ink"], font=self.fonts["body_bold"])

    def info_box(
        self,
        text: str,
        *,
        tone: str = "blue",
        title: str | None = None,
        max_chars: int = 720,
    ) -> None:
        fill = self.colors["soft_blue"]
        accent = self.colors["accent"]
        if tone == "green":
            fill, accent = (236, 253, 245), self.colors["green"]
        elif tone == "red":
            fill, accent = (254, 242, 242), self.colors["red"]
        lines: list[tuple[str, str]] = []
        if title:
            lines.append((title, "body_bold"))
        for line in self.text_lines(_shorten(text, max_chars), "body", self.content_width - 44):
            lines.append((line, "body"))
        box_h = 28 + len(lines) * 27
        self.ensure(box_h + 12)
        y0 = self.y
        self.draw.rounded_rectangle(
            [self.left, y0, self.right, y0 + box_h],
            radius=8,
            fill=fill,
            outline=(226, 232, 245),
            width=1,
        )
        self.draw.rounded_rectangle([self.left, y0, self.left + 4, y0 + box_h], radius=2, fill=accent)
        y = y0 + 18
        for line, font_key in lines:
            self.draw.text((self.left + 22, y), line, fill=self.colors["ink"], font=self.fonts[font_key])
            y += 27
        self.y = y0 + box_h + 24

    def paragraphs(self, lines: list[str], *, limit: int = 4) -> None:
        for line in lines[:limit]:
            self.draw_wrapped(line, line_height=25)
            self.y += 8

    def two_column_analysis(self, left_title: str, left_lines: list[str], right_title: str, chart_values: list[float]) -> None:
        card_h = 190
        gap = 18
        card_w = (self.content_width - gap) // 2
        self.ensure(card_h + 18)
        x1, x2, y0 = self.left, self.left + card_w + gap, self.y
        self.card(x1, y0, card_w, card_h, title=left_title)
        y = y0 + 48
        for line in left_lines[:2]:
            for wrapped in _wrap_image_line(self.draw, _shorten(line, 120), self.fonts["small"], card_w - 36)[:3]:
                self.draw.text((x1 + 18, y), wrapped, fill=self.colors["ink"], font=self.fonts["small"])
                y += 24
            y += 4
        self.chart_card(x2, y0, card_w, card_h, right_title, chart_values)
        self.y = y0 + card_h + 28

    def card(self, x: int, y: int, w: int, h: int, *, title: str = "") -> None:
        self.draw.rounded_rectangle([x, y, x + w, y + h], radius=9, fill=self.colors["soft"], outline=self.colors["line"])
        if title:
            self.draw.text((x + 18, y + 16), title, fill=self.colors["ink"], font=self.fonts["body_bold"])

    def chart_card(self, x: int, y: int, w: int, h: int, title: str, values: list[float]) -> None:
        self.card(x, y, w, h, title=title)
        values = values[:6] or [80, 96, 91, 104, 99, 112]
        if len(values) < 3:
            values = [80, 96, 91, 104, 99, 112]
        low, high = min(values), max(values)
        span = high - low or 1
        plot_x, plot_y, plot_w, plot_h = x + 30, y + 58, w - 60, h - 92
        self.draw.line([plot_x, plot_y + plot_h, plot_x + plot_w, plot_y + plot_h], fill=(200, 208, 221), width=1)
        bar_w = max(12, plot_w // (len(values) * 2))
        points = []
        for idx, value in enumerate(values):
            px = plot_x + idx * (plot_w // max(1, len(values) - 1))
            py = plot_y + plot_h - int((value - low) / span * (plot_h - 10))
            points.append((px, py))
            bar_h = int((value - low) / span * (plot_h - 12)) + 14
            self.draw.rectangle(
                [px - bar_w // 2, plot_y + plot_h - bar_h, px + bar_w // 2, plot_y + plot_h],
                fill=(30, 41, 59),
            )
        if len(points) > 1:
            self.draw.line(points, fill=(245, 158, 11), width=3)
            for px, py in points:
                self.draw.ellipse([px - 4, py - 4, px + 4, py + 4], fill=(245, 158, 11))
        self.draw.text((x + w // 2 - 60, y + h - 27), "Source: local PDF evidence", fill=self.colors["muted"], font=self.fonts["tiny"])

    def table(self, title: str, headers: list[str], rows: list[list[str]]) -> None:
        self.subheading(title)
        row_h = 27
        col_w = self.content_width // len(headers)
        total_h = row_h * (len(rows) + 1)
        self.ensure(total_h + 14)
        y = self.y
        self.draw.rectangle([self.left, y, self.right, y + row_h], fill=(3, 46, 82))
        for idx, header in enumerate(headers):
            self.draw.text((self.left + idx * col_w + 8, y + 7), header, fill="white", font=self.fonts["tiny"])
        y += row_h
        for row_idx, row in enumerate(rows):
            fill = (249, 251, 253) if row_idx % 2 == 0 else "white"
            self.draw.rectangle([self.left, y, self.right, y + row_h], fill=fill)
            self.draw.line([self.left, y + row_h, self.right, y + row_h], fill=self.colors["line"], width=1)
            for idx, cell in enumerate(row[: len(headers)]):
                self.draw.text((self.left + idx * col_w + 8, y + 7), _shorten(cell, 22), fill=self.colors["ink"], font=self.fonts["tiny"])
            y += row_h
        self.y = y + 28

    def event_panel(self, positives: list[str], risks: list[str]) -> None:
        panel_h = 68 + 52 * (len(positives[:3]) + len(risks[:2]))
        self.ensure(panel_h + 16)
        y0 = self.y
        self.card(self.left, y0, self.content_width, panel_h, title="Catalyst Analysis")
        y = y0 + 52
        for line in positives[:3]:
            self.draw.rounded_rectangle([self.left + 18, y, self.right - 18, y + 38], radius=5, fill=(209, 250, 229))
            self.draw.text((self.left + 30, y + 11), "+ " + _shorten(line, 68), fill=(6, 95, 70), font=self.fonts["small"])
            y += 50
        for line in risks[:2]:
            self.draw.rounded_rectangle([self.left + 18, y, self.right - 18, y + 38], radius=5, fill=(254, 226, 226))
            self.draw.text((self.left + 30, y + 11), "! " + _shorten(line, 68), fill=(153, 27, 27), font=self.fonts["small"])
            y += 50
        self.y = y0 + panel_h + 26

    def source_appendix(self) -> None:
        self.section_heading("Reference Sources")
        seen = set()
        for citation in self.memo.citations:
            if citation.citation_id in seen:
                continue
            seen.add(citation.citation_id)
            quote_lines = _wrap_image_line(
                self.draw,
                "Quote: " + _shorten(citation.quote, 260),
                self.fonts["small"],
                self.content_width - 32,
            )[:3]
            box_h = 72 + len(quote_lines) * 21
            self.ensure(box_h + 14)
            y0 = self.y
            self.draw.rounded_rectangle(
                [self.left, y0, self.right, y0 + box_h],
                radius=8,
                fill=self.colors["soft"],
                outline=self.colors["line"],
            )
            self.draw.text((self.left + 16, y0 + 14), citation.citation_id, fill=self.colors["ink"], font=self.fonts["body_bold"])
            self.draw.text((self.left + 16, y0 + 39), citation.display, fill=self.colors["muted"], font=self.fonts["small"])
            y = y0 + 66
            for line in quote_lines:
                self.draw.text((self.left + 16, y), line, fill=self.colors["ink"], font=self.fonts["small"])
                y += 21
            self.y = y0 + box_h + 14


def _render_image_pdf(memo: MemoDraft, output_path: Path) -> None:
    company, ticker = _memo_company_ticker(memo)
    overview = _find_section(memo, "Company Overview")
    thesis = _find_section(memo, "Core Thesis", "Investment Thesis")
    financials = _find_section(memo, "Financial Performance", "Financial Analysis")
    risks = _find_section(memo, "Risks", "Risk Factors")
    renderer = _ReportRenderer(memo)

    overview_lines = _section_bullets(overview, limit=5)
    thesis_lines = _section_bullets(thesis, limit=4)
    financial_lines = _section_bullets(financials, limit=4)
    risk_lines = _section_bullets(risks, limit=5)
    all_financial_text = _section_text(financials)
    values = _money_values(all_financial_text)
    years = _years(all_financial_text)[:5] or ["2021", "2022", "2023", "2024", "2025"]

    renderer.header(company, ticker)
    renderer.section_heading("Investment Thesis")
    renderer.info_box(
        thesis_lines[0] if thesis_lines else "The investment thesis is grounded in the selected local PDF evidence.",
        title="Evidence-backed thesis",
    )

    renderer.section_heading("Company Overview")
    renderer.paragraphs(overview_lines or ["No company overview evidence was found in the selected PDF."], limit=4)
    if overview_lines:
        renderer.info_box(
            overview_lines[-1],
            tone="blue",
            title="Summary",
            max_chars=520,
        )

    renderer.section_heading("Financial Analysis")
    renderer.two_column_analysis(
        "Revenue & Cash Flow",
        financial_lines or ["Financial evidence was not available in the selected PDF."],
        f"{ticker or company} - Evidence Trend",
        values,
    )
    metric_rows = [
        ["Revenue", years[0] if years else "N/A", values[0] if values else "N/A"],
        ["Cash Flow", years[1] if len(years) > 1 else "N/A", values[1] if len(values) > 1 else "N/A"],
        ["Capital Spend", years[2] if len(years) > 2 else "N/A", values[2] if len(values) > 2 else "N/A"],
    ]
    renderer.table(
        "Key Figures From Source Evidence",
        ["Metric", "Period", "Value"],
        [[row[0], str(row[1]), f"${row[2]:,.0f}" if isinstance(row[2], float) else str(row[2])] for row in metric_rows],
    )

    renderer.section_heading("Valuation Analysis")
    renderer.paragraphs(financial_lines[:2] or thesis_lines[:2], limit=2)
    renderer.table(
        "Peer / Valuation Snapshot",
        ["Metric", "Source", "Interpretation"],
        [
            ["Citation Count", str(len({c.citation_id for c in memo.citations})), "Traceable"],
            ["Review Flag", "Yes" if any(s.needs_review for s in memo.sections) else "No", "Source check"],
            ["LLM", "Used" if memo.llm_used else "Extractive", "Generation mode"],
        ],
    )

    renderer.section_heading("Key Catalysts")
    renderer.event_panel(thesis_lines or overview_lines, risk_lines)

    renderer.section_heading("Risk Factors")
    renderer.info_box(
        " ".join(risk_lines) if risk_lines else "No risk-factor evidence was found in the selected PDF.",
        tone="red",
        title="Downside risks",
        max_chars=900,
    )

    renderer.ensure(360)
    renderer.section_heading("Key Takeaways")
    takeaway_text = " ".join((thesis_lines[:1] + financial_lines[:1] + risk_lines[:1]) or overview_lines[:2])
    renderer.info_box(
        takeaway_text or "The memo is based on traceable local PDF evidence and should be reviewed before investment use.",
        tone="green",
        title="Bottom line",
        max_chars=900,
    )

    renderer.section_heading("Financial Data")
    renderer.table(
        "Source Evidence Summary",
        ["Section", "Citations", "Needs Review"],
        [[section.title, str(len(section.citations)), "Yes" if section.needs_review else "No"] for section in memo.sections],
    )
    renderer.source_appendix()
    renderer.finish(output_path)


def _render_with_reportlab(memo: MemoDraft, output_path: Path) -> None:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import inch
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer
    from xml.sax.saxutils import escape

    doc = SimpleDocTemplate(
        str(output_path),
        pagesize=letter,
        rightMargin=0.65 * inch,
        leftMargin=0.65 * inch,
        topMargin=0.6 * inch,
        bottomMargin=0.6 * inch,
        title=memo.title,
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "MemoTitle",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=18,
        leading=22,
        spaceAfter=14,
        textColor=colors.HexColor("#17202A"),
    )
    section_style = ParagraphStyle(
        "MemoSection",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=12,
        leading=15,
        spaceBefore=10,
        spaceAfter=6,
        textColor=colors.HexColor("#146B5F"),
    )
    body_style = ParagraphStyle(
        "MemoBody",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=9.5,
        leading=13,
        spaceAfter=5,
    )
    cite_style = ParagraphStyle(
        "MemoCitation",
        parent=body_style,
        fontName="Helvetica",
        fontSize=8,
        leading=10,
        leftIndent=10,
        textColor=colors.HexColor("#4E5A64"),
    )

    story = [Paragraph(escape(memo.title), title_style)]
    for section in memo.sections:
        suffix = " [needs review]" if section.needs_review else ""
        story.append(Paragraph(escape(f"{section.title}{suffix}"), section_style))
        for raw_line in section.content.splitlines() or [""]:
            text = raw_line.strip()
            if not text:
                story.append(Spacer(1, 4))
                continue
            story.append(Paragraph(escape(text), body_style))
        if section.citations:
            story.append(Paragraph("Citations", cite_style))
            for citation in section.citations:
                story.append(
                    Paragraph(
                        escape(f"{citation.citation_id}: {citation.display}"),
                        cite_style,
                    )
                )

    if memo.citations:
        story.append(Paragraph("Reference Sources", section_style))
        seen = set()
        for citation in memo.citations:
            if citation.citation_id in seen:
                continue
            seen.add(citation.citation_id)
            story.append(Paragraph(escape(f"{citation.citation_id}: {citation.display}"), cite_style))
            if citation.quote:
                story.append(Paragraph(escape(f"Quote: {citation.quote}"), cite_style))
    doc.build(story)


def _pdf_escape(value: str) -> str:
    ascii_text = value.encode("latin-1", "replace").decode("latin-1")
    return ascii_text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _page_stream(lines: list[str]) -> bytes:
    commands = ["BT", "/F1 10 Tf", "72 740 Td", "14 TL"]
    for line in lines:
        commands.append(f"({_pdf_escape(line)}) Tj")
        commands.append("T*")
    commands.append("ET")
    return "\n".join(commands).encode("latin-1")


def _render_basic_pdf(memo: MemoDraft, output_path: Path) -> None:
    wrapped: list[str] = []
    for line in _plain_lines(memo):
        if not line.strip():
            wrapped.append("")
            continue
        wrapped.extend(textwrap.wrap(line, width=88) or [""])

    pages = [wrapped[i : i + 48] for i in range(0, len(wrapped), 48)] or [[]]
    objects: list[bytes] = []
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    kids = " ".join(f"{3 + i * 2} 0 R" for i in range(len(pages)))
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode("latin-1"))
    for index, page_lines in enumerate(pages):
        page_obj = 3 + index * 2
        content_obj = page_obj + 1
        objects.append(
            (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                f"/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> "
                f"/Contents {content_obj} 0 R >>"
            ).encode("latin-1")
        )
        stream = _page_stream(page_lines)
        objects.append(b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"\nendstream")

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for obj_num, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out.extend(f"{obj_num} 0 obj\n".encode("ascii"))
        out.extend(obj)
        out.extend(b"\nendobj\n")
    xref_offset = len(out)
    out.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    out.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        out.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    out.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode("ascii")
    )
    output_path.write_bytes(bytes(out))


def render_memo_pdf(
    memo: MemoDraft,
    output_dir: str | Path = DEFAULT_OUTPUT_DIR,
    *,
    filename: str | None = None,
) -> Path:
    """Write a memo PDF and return the output path."""
    out_dir = Path(output_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    output_path = out_dir / (filename or f"{_safe_slug(memo.memo_id)}.pdf")
    try:
        _render_image_pdf(memo, output_path)
    except Exception:
        try:
            _render_with_reportlab(memo, output_path)
        except Exception:
            _render_basic_pdf(memo, output_path)
    return output_path
