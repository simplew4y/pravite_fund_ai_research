"""Render a unified, human-readable citation string per evidence type.

Target formats (docs/evidence_schema_design.md section 8):
  PDF:      Zeekr_2024_AR.pdf, p.42, Management Discussion
  PPT:      Investor_Day.pptx, slide 12
  Word:     meeting_minutes.docx, 管理层问答 > 毛利率, paragraph 18
  Excel:    Zeekr_valuation_model.xlsx, DCF!E12, formula = E11/E10
  Markdown: zeekr_profitability.md, #毛利率趋势
  QA:       session_001, assistant message msg_002
  Memo:     memo_001, section 核心观点
"""

from __future__ import annotations

from typing import Optional

from .schema import Evidence, EvidenceLocation, EvidenceType


def _join(parts: list[str]) -> str:
    return ", ".join(p for p in parts if p)


def _pdf(loc: EvidenceLocation) -> str:
    parts = [loc.file_name]
    if loc.page_no is not None:
        parts.append(f"p.{loc.page_no}")
    if loc.section:
        parts.append(loc.section)
    return _join(parts)


def _ppt(loc: EvidenceLocation) -> str:
    parts = [loc.file_name]
    if loc.slide_no is not None:
        parts.append(f"slide {loc.slide_no}")
    if loc.shape_id:
        parts.append(loc.shape_id)
    return _join(parts)


def _word(loc: EvidenceLocation) -> str:
    heading_path = loc.location_json.get("heading_path") if loc.location_json else None
    heading = " > ".join(heading_path) if heading_path else (loc.heading or loc.section or "")
    parts = [loc.file_name, heading]
    if loc.paragraph_no is not None:
        parts.append(f"paragraph {loc.paragraph_no}")
    return _join(parts)


def _excel(loc: EvidenceLocation) -> str:
    parts = [loc.file_name]
    if loc.sheet_name and loc.cell:
        parts.append(f"{loc.sheet_name}!{loc.cell}")
    elif loc.sheet_name and loc.cell_range:
        parts.append(f"{loc.sheet_name}!{loc.cell_range}")
    elif loc.sheet_name:
        parts.append(loc.sheet_name)
    if loc.formula:
        parts.append(f"formula = {loc.formula.lstrip('=')}")
    return _join(parts)


def _markdown(loc: EvidenceLocation) -> str:
    heading = loc.heading or loc.section or ""
    tag = f"#{heading}" if heading else ""
    return _join([loc.file_name, tag])


def _qa(loc: EvidenceLocation) -> str:
    lj = loc.location_json or {}
    session = lj.get("session_id", "")
    message = lj.get("message_id", "")
    role = lj.get("role", "assistant")
    tail = f"{role} message {message}" if message else ""
    return _join([session, tail])


def _memo(loc: EvidenceLocation) -> str:
    lj = loc.location_json or {}
    memo_id = lj.get("memo_id", "")
    section = lj.get("section_id", "") or loc.section or ""
    tail = f"section {section}" if section else ""
    return _join([memo_id, tail])


_RENDERERS = {
    EvidenceType.PDF_PAGE_SECTION.value: _pdf,
    EvidenceType.PPT_SLIDE.value: _ppt,
    EvidenceType.WORD_SECTION.value: _word,
    EvidenceType.EXCEL_CELL.value: _excel,
    EvidenceType.MARKDOWN_BLOCK.value: _markdown,
    EvidenceType.QA_MESSAGE.value: _qa,
    EvidenceType.MEMO_SECTION.value: _memo,
}


def render_citation_display(
    evidence: Evidence,
    location: Optional[EvidenceLocation] = None,
) -> str:
    """Render a human-readable citation string for an evidence.

    Falls back to the file name (or evidence_id) when the type is unknown or
    no location is available, so a citation can always show *something*.
    """
    loc = location or evidence.location
    if loc is None:
        return evidence.evidence_id
    renderer = _RENDERERS.get(evidence.evidence_type)
    if renderer is None:
        return loc.file_name or evidence.evidence_id
    return renderer(loc) or loc.file_name or evidence.evidence_id
