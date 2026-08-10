from __future__ import annotations

import sqlite3
from pathlib import Path

from omnigent.server.routes import private_fund_pdf


def _build_excel_source_db(path: Path) -> sqlite3.Row:
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        conn.executescript(
            """
            CREATE TABLE documents (
                doc_id TEXT PRIMARY KEY,
                original_filename TEXT,
                stored_path TEXT
            );
            CREATE TABLE excel_sheets (
                doc_id TEXT,
                sheet_index INTEGER,
                sheet_name TEXT,
                sheet_role TEXT,
                used_range TEXT,
                row_count INTEGER,
                col_count INTEGER,
                non_empty_cell_count INTEGER,
                formula_count INTEGER,
                formula_density REAL,
                summary TEXT
            );
            CREATE TABLE excel_regions (
                doc_id TEXT,
                sheet_name TEXT,
                region_index INTEGER,
                region_type TEXT,
                cell_range TEXT,
                row_count INTEGER,
                col_count INTEGER,
                non_empty_cell_count INTEGER,
                formula_count INTEGER,
                summary TEXT
            );
            CREATE TABLE excel_cells (
                doc_id TEXT,
                sheet_name TEXT,
                cell_ref TEXT,
                row_index INTEGER,
                col_index INTEGER,
                display_value TEXT,
                raw_value TEXT,
                numeric_value REAL,
                formula TEXT,
                cached_value TEXT,
                number_format TEXT,
                row_label TEXT,
                col_label TEXT,
                period TEXT,
                unit TEXT,
                is_formula INTEGER
            );
            """
        )
        conn.execute(
            "INSERT INTO documents VALUES (?, ?, ?)",
            ("doc-1", "large-model.xlsx", "/dataset/raw/large-model.xlsx"),
        )
        conn.execute(
            "INSERT INTO excel_sheets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("doc-1", 1, "Supply relation", "data", "A1:AK213", 213, 37, 3, 0, 0.0, "summary"),
        )
        conn.executemany(
            "INSERT INTO excel_cells VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    "doc-1",
                    "Supply relation",
                    "A1",
                    1,
                    1,
                    "Header",
                    "Header",
                    None,
                    None,
                    None,
                    "General",
                    "",
                    "",
                    "",
                    "",
                    0,
                ),
                (
                    "doc-1",
                    "Supply relation",
                    "AK213",
                    213,
                    37,
                    "Tail",
                    "Tail",
                    None,
                    None,
                    None,
                    "General",
                    "",
                    "",
                    "",
                    "",
                    0,
                ),
                (
                    "doc-1",
                    "Supply relation",
                    "B220",
                    220,
                    2,
                    "Nearby",
                    "Nearby",
                    None,
                    None,
                    None,
                    "General",
                    "",
                    "",
                    "",
                    "",
                    0,
                ),
            ],
        )
        conn.commit()
        return conn.execute("SELECT * FROM documents WHERE doc_id = 'doc-1'").fetchone()


def test_large_excel_source_range_is_windowed_and_navigable(tmp_path, monkeypatch) -> None:
    db_path = tmp_path / "collection.sqlite3"
    document = _build_excel_source_db(db_path)
    monkeypatch.setattr(
        private_fund_pdf,
        "_dataset_document_by_name",
        lambda *_args, **_kwargs: (document, db_path, "dataset-1"),
    )

    first = private_fund_pdf._excel_workbook_source(
        "large-model.xlsx",
        sheet_name="'Supply   relation'",
        range_ref="A1:AK213",
        dataset_id="dataset-1",
    )
    assert first["requested_range_ref"] == "A1:AK213"
    assert first["range_ref"] == "A1:AK108"
    assert first["window"]["truncated"] is True
    assert first["window"]["next_row_start"] == 109
    assert [cell["cell_ref"] for cell in first["cells"]] == ["A1"]
    assert first["total_non_empty_cell_count"] == 2

    second = private_fund_pdf._excel_workbook_source(
        "large-model.xlsx",
        sheet_name="Supply relation",
        range_ref="A1:AK213",
        dataset_id="dataset-1",
        window_row=109,
    )
    assert second["range_ref"] == "A109:AK213"
    assert second["row_min"] == first["window"]["next_row_start"]
    assert [cell["cell_ref"] for cell in second["cells"]] == ["AK213"]
    assert second["window"]["next_row_start"] is None


def test_empty_excel_source_range_reports_nearby_cells(tmp_path, monkeypatch) -> None:
    db_path = tmp_path / "collection.sqlite3"
    document = _build_excel_source_db(db_path)
    monkeypatch.setattr(
        private_fund_pdf,
        "_dataset_document_by_name",
        lambda *_args, **_kwargs: (document, db_path, "dataset-1"),
    )

    payload = private_fund_pdf._excel_workbook_source(
        "large-model.xlsx",
        sheet_name="Supply relation",
        range_ref="A214:C219",
        dataset_id="dataset-1",
    )

    assert payload["cells"] == []
    assert payload["empty_reason"] == "requested_range_empty"
    assert [cell["cell_ref"] for cell in payload["nearby_cells"]] == ["B220"]


def test_dataset_document_lookup_accepts_legacy_excel_type_and_filename_case(
    tmp_path, monkeypatch
) -> None:
    db_path = tmp_path / "collection.sqlite3"
    with sqlite3.connect(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE documents (
                doc_id TEXT PRIMARY KEY,
                original_filename TEXT,
                source_name TEXT,
                title TEXT,
                stored_path TEXT,
                file_type TEXT,
                deleted_at TEXT
            );
            """
        )
        conn.execute(
            "INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, NULL)",
            (
                "doc-legacy",
                "300274 V44.XLSX",
                "300274 V44.XLSX",
                "300274 V44",
                "/dataset/raw/300274 V44.XLSX",
                ".excel",
            ),
        )
        conn.commit()

    monkeypatch.setattr(
        private_fund_pdf,
        "_active_collection_db",
        lambda _dataset_id=None: (db_path, "300274"),
    )

    result = private_fund_pdf._dataset_document_by_name(
        "300274 v44.xlsx", "300274", file_types=private_fund_pdf.EXCEL_FILE_TYPES
    )

    assert result is not None
    assert result[0]["doc_id"] == "doc-legacy"
