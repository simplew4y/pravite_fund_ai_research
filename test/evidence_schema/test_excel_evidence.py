"""Excel evidence keeps core sheet / cell / range / value / formula.

upstream_cells and number_format are optional enhancements: present them
when the source provides them, but never require them.
"""

from __future__ import annotations

from evidence_schema import (
    AdapterContext,
    ExcelEvidenceAdapter,
    normalize_many,
    render_citation_display,
)


def _ctx():
    return AdapterContext(
        doc_id="doc_excel_001",
        version_id="ver_excel_001",
        file_name="Zeekr_valuation_model.xlsx",
        project_id="zeekr_project",
        collection_id="company_collection",
        metadata={"doc_type": "excel_model"},
    )


def test_excel_cell_keeps_sheet_cell_value_formula(excel_blocks):
    evidences = normalize_many(ExcelEvidenceAdapter().adapt(excel_blocks, _ctx()))
    by_cell = {e.location.cell: e for e in evidences}

    e12 = by_cell["E12"]
    assert e12.evidence_type == "excel_cell"
    assert e12.location.sheet_name == "DCF"
    assert e12.location.cell == "E12"
    assert e12.location.cell_range == "B10:H20"
    assert e12.location.formula == "=E11/E10"
    assert e12.content_json["value"] == "16.5%"


def test_excel_content_text_and_display(excel_blocks):
    evidences = normalize_many(ExcelEvidenceAdapter().adapt(excel_blocks, _ctx()))
    e12 = next(e for e in evidences if e.location.cell == "E12")
    assert "DCF!E12 = 16.5%" in e12.content_text
    assert "formula = E11/E10" in e12.content_text
    assert (
        render_citation_display(e12)
        == "Zeekr_valuation_model.xlsx, DCF!E12, formula = E11/E10"
    )


def test_excel_answers_target_price_questions(excel_blocks):
    """Acceptance: where is it, what is the formula (core, always present)."""
    evidences = normalize_many(ExcelEvidenceAdapter().adapt(excel_blocks, _ctx()))
    e12 = next(e for e in evidences if e.location.cell == "E12")
    # where: sheet/cell
    assert (e12.location.sheet_name, e12.location.cell) == ("DCF", "E12")
    # what value / formula
    assert e12.content_json["value"] == "16.5%"
    assert e12.location.formula == "=E11/E10"


def test_excel_optional_enhancements_when_present(excel_blocks):
    """upstream_cells is only asserted when the source actually provides it."""
    evidences = normalize_many(ExcelEvidenceAdapter().adapt(excel_blocks, _ctx()))
    e12 = next(e for e in evidences if e.location.cell == "E12")
    upstream = e12.content_json.get("upstream_cells")
    if upstream is not None:
        assert set(upstream) == {"E10", "E11"}


def test_excel_canonical_block_file_field_and_no_enhancements():
    """Matches the retrieval-time canonical dict: uses `file`, no upstream."""
    block = {
        "file": "Tesla_valuation_model.xlsx",
        "sheet": "DCF",
        "range": "B10:H20",
        "cell": "E12",
        "value": "16.5%",
        "formula": "=E11/E10",
    }
    e12 = normalize_many(ExcelEvidenceAdapter().adapt([block], _ctx()))[0]
    # `file` is honored over the AdapterContext file_name
    assert e12.location.file_name == "Tesla_valuation_model.xlsx"
    # core fields preserved
    assert e12.location.cell_range == "B10:H20"
    assert e12.location.formula == "=E11/E10"
    assert e12.content_json["value"] == "16.5%"
    # absent optional enhancements -> keys simply not present, still valid
    assert "upstream_cells" not in e12.content_json
    assert "number_format" not in e12.content_json


def test_excel_file_and_file_name_are_interchangeable():
    """Upstream may emit `file` or `file_name`; both must resolve identically."""
    base = {
        "sheet": "DCF",
        "range": "B10:H20",
        "cell": "E12",
        "value": "16.5%",
        "formula": "=E11/E10",
    }
    with_file = ExcelEvidenceAdapter().adapt([{**base, "file": "m.xlsx"}], _ctx())[0]
    with_file_name = ExcelEvidenceAdapter().adapt(
        [{**base, "file_name": "m.xlsx"}], _ctx()
    )[0]
    assert with_file.location.file_name == "m.xlsx"
    assert with_file_name.location.file_name == "m.xlsx"
    # same logical cell -> same deterministic evidence_id regardless of alias
    assert with_file.evidence_id == with_file_name.evidence_id


def test_excel_core_field_aliases_resolve():
    """`sheet_name` / `cell_range` aliases map onto the canonical fields."""
    block = {
        "file_name": "m.xlsx",
        "sheet_name": "DCF",
        "cell_range": "B10:H20",
        "cell": "E12",
        "value": "16.5%",
        "formula": "=E11/E10",
    }
    e12 = normalize_many(ExcelEvidenceAdapter().adapt([block], _ctx()))[0]
    assert e12.location.sheet_name == "DCF"
    assert e12.location.cell_range == "B10:H20"
    assert render_citation_display(e12) == "m.xlsx, DCF!E12, formula = E11/E10"


def test_excel_upstream_cells_never_required():
    """A minimal block without upstream_cells/number_format still validates."""
    block = {"file": "m.xlsx", "sheet": "DCF", "cell": "E12", "value": "1"}
    e12 = normalize_many(ExcelEvidenceAdapter().adapt([block], _ctx()))[0]
    assert "upstream_cells" not in e12.content_json
    assert e12.content_json["value"] == "1"
