from __future__ import annotations

import io
import json
import sqlite3
from pathlib import Path

import pytest
from starlette.datastructures import UploadFile

from omnigent.server.routes import private_fund_pdf
from omnigent.tools.builtins.private_fund_dataset import _DatasetStore


def test_same_name_upload_replaces_logical_source_instead_of_forking_filename(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    target = uploads / "report.pdf"
    target.write_bytes(b"old version")
    registry = tmp_path / "datasets.sqlite3"
    with sqlite3.connect(registry) as conn:
        conn.execute(
            """
            CREATE TABLE datasets (
                dataset_id TEXT PRIMARY KEY, status TEXT, source_dir TEXT,
                file_count INTEGER, updated_at TEXT
            )
            """
        )
        conn.execute("INSERT INTO datasets VALUES ('demo', 'completed', '', 1, '')")

    monkeypatch.setattr(private_fund_pdf, "_require_project_row", lambda _dataset_id: {})
    monkeypatch.setattr(private_fund_pdf, "_seed_uploads_from_raw", lambda _dataset_id: uploads)
    monkeypatch.setattr(
        private_fund_pdf,
        "_connect_global_registry",
        lambda *_args, **_kwargs: sqlite3.connect(registry),
    )
    monkeypatch.setattr(
        private_fund_pdf,
        "_project_payload",
        lambda _row: {"dataset_id": "demo"},
    )
    uploaded = UploadFile(filename="report.pdf", file=io.BytesIO(b"new version"))

    payload = private_fund_pdf._save_uploaded_project_files("demo", [uploaded])

    assert target.read_bytes() == b"new version"
    assert list(uploads.glob("report_*.pdf")) == []
    assert payload["files"][0]["name"] == "report.pdf"
    assert payload["files"][0]["replaced"] is True
    with sqlite3.connect(registry) as conn:
        assert (
            conn.execute("SELECT status FROM datasets WHERE dataset_id = 'demo'").fetchone()[0]
            == "draft"
        )


def test_delete_project_source_preserves_raw_version_evidence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    uploads = tmp_path / "uploads"
    raw = tmp_path / "dataset" / "raw"
    raw.mkdir(parents=True)
    historical = raw / "report.pdf"
    historical.write_bytes(b"immutable historical version")
    registry = tmp_path / "datasets.sqlite3"
    with sqlite3.connect(registry) as conn:
        conn.execute(
            """
            CREATE TABLE datasets (
                dataset_id TEXT PRIMARY KEY, status TEXT, source_dir TEXT,
                file_count INTEGER, updated_at TEXT
            )
            """
        )
        conn.execute("INSERT INTO datasets VALUES ('demo', 'completed', '', 1, '')")

    monkeypatch.setattr(private_fund_pdf, "_require_project_row", lambda _dataset_id: {})
    monkeypatch.setattr(private_fund_pdf, "_project_uploads_dir", lambda *_args: uploads)
    monkeypatch.setattr(
        private_fund_pdf,
        "_project_dataset_root",
        lambda *_args: tmp_path / "dataset",
    )
    monkeypatch.setattr(
        private_fund_pdf,
        "_connect_global_registry",
        lambda *_args, **_kwargs: sqlite3.connect(registry),
    )
    monkeypatch.setattr(
        private_fund_pdf,
        "_project_payload",
        lambda _row: {"dataset_id": "demo"},
    )
    monkeypatch.setattr(private_fund_pdf, "_project_files_payload", lambda _dataset_id: [])
    router = private_fund_pdf.create_private_fund_pdf_router()
    endpoint = next(
        route.endpoint
        for route in router.routes
        if route.path == "/private-fund/projects/{dataset_id}/files/{file_name}"
    )

    endpoint("demo", "report.pdf")

    assert historical.read_bytes() == b"immutable historical version"
    assert not (uploads / "report.pdf").exists()
    assert (uploads / private_fund_pdf.PROJECT_UPLOADS_MARKER).is_file()
    with sqlite3.connect(registry) as conn:
        assert conn.execute(
            "SELECT status, file_count FROM datasets WHERE dataset_id = 'demo'"
        ).fetchone() == ("draft", 0)


def test_delete_project_removes_managed_workspace_and_clears_active_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = tmp_path / "datasets"
    monkeypatch.setattr(private_fund_pdf, "_dataset_workspace_root", lambda: workspace)
    project = private_fund_pdf._create_project_row(
        private_fund_pdf.CreateProjectRequest(name="Demo", dataset_id="demo")
    )
    dataset_root = Path(project["dataset_root"])
    uploads_dir = Path(project["uploads_dir"])
    # Project payload hydration may already initialize the collection DB parent.
    (dataset_root / "meta").mkdir(parents=True, exist_ok=True)
    (dataset_root / "meta" / "collection.sqlite3").touch()
    (uploads_dir / "report.pdf").write_bytes(b"source")
    private_fund_pdf._set_active_dataset("demo")

    payload = private_fund_pdf._delete_project("demo")

    assert payload == {"deleted_dataset_id": "demo"}
    assert not dataset_root.exists()
    assert not uploads_dir.exists()
    with private_fund_pdf._connect_global_registry(workspace) as conn:
        assert conn.execute("SELECT 1 FROM datasets WHERE dataset_id='demo'").fetchone() is None
        assert (
            conn.execute("SELECT active_dataset_id FROM dataset_state WHERE id=1").fetchone()[0]
            is None
        )


def _make_store(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    migrated: bool,
) -> tuple[_DatasetStore, Path]:
    workspace = tmp_path / "datasets"
    dataset_root = workspace / "demo"
    collection_db = dataset_root / "meta" / "collection.sqlite3"
    collection_db.parent.mkdir(parents=True)
    global_db = workspace / "datasets.sqlite3"

    with sqlite3.connect(global_db) as conn:
        conn.executescript(
            """
            CREATE TABLE datasets (
                dataset_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                status TEXT NOT NULL,
                source_dir TEXT,
                dataset_root TEXT NOT NULL,
                company_name TEXT,
                company_ticker TEXT,
                file_count INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                metadata_json TEXT
            );
            CREATE TABLE dataset_state (
                id INTEGER PRIMARY KEY,
                active_dataset_id TEXT,
                updated_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            "INSERT INTO datasets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "demo",
                "Demo dataset",
                "completed",
                str(tmp_path / "sources"),
                str(dataset_root),
                "Demo Co",
                "000001",
                2,
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z",
                json.dumps({"collection_db_path": str(collection_db)}),
            ),
        )
        conn.execute("INSERT INTO dataset_state VALUES (1, 'demo', '2026-01-01T00:00:00Z')")

    migration_columns = (
        """
        source_relpath TEXT,
        logical_doc_id TEXT,
        version_no INTEGER,
        supersedes_doc_id TEXT,
        is_current INTEGER,
    """
        if migrated
        else ""
    )
    location_columns = (
        """
        slide_start INTEGER,
        slide_end INTEGER,
        heading_path TEXT,
    """
        if migrated
        else ""
    )
    with sqlite3.connect(collection_db) as conn:
        conn.executescript(
            f"""
            CREATE TABLE documents (
                doc_id TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL,
                {migration_columns}
                original_filename TEXT NOT NULL,
                file_type TEXT,
                doc_type TEXT,
                stored_path TEXT,
                status TEXT,
                chunk_count INTEGER,
                error_message TEXT,
                deleted_at TEXT
            );
            CREATE TABLE chunks (
                chunk_id TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL,
                doc_id TEXT NOT NULL,
                chunk_index INTEGER,
                content TEXT,
                content_type TEXT,
                title_path TEXT,
                summary TEXT,
                source_ref TEXT,
                metadata_json TEXT
            );
            CREATE TABLE chunk_locations (
                location_id TEXT PRIMARY KEY,
                chunk_id TEXT NOT NULL,
                doc_id TEXT NOT NULL,
                location_index INTEGER,
                page_start INTEGER,
                page_end INTEGER,
                page_numbers_json TEXT,
                {location_columns}
                sheet_name TEXT,
                cell_range TEXT,
                bbox_json TEXT,
                display_text TEXT
            );
            CREATE TABLE pdf_pages (
                doc_id TEXT, page_number INTEGER, text TEXT, char_count INTEGER,
                word_count INTEGER, extraction_method TEXT, bbox_json TEXT
            );
            CREATE TABLE excel_workbooks (doc_id TEXT);
            CREATE TABLE excel_sheets (doc_id TEXT);
            CREATE TABLE excel_regions (doc_id TEXT);
            CREATE TABLE excel_cells (doc_id TEXT);
            CREATE TABLE metric_facts (doc_id TEXT);
            CREATE TABLE index_registry (
                dataset_id TEXT, index_type TEXT, index_path TEXT,
                source_chunk_count INTEGER, status TEXT, built_at TEXT,
                error_message TEXT
            );
            CREATE TABLE ingest_jobs (
                job_id TEXT, job_type TEXT, status TEXT, file_count INTEGER,
                message TEXT, started_at TEXT, finished_at TEXT, created_at TEXT
            );
            """
        )

    monkeypatch.setenv("PRIVATE_FUND_DATASET_WORKSPACE", str(workspace))
    return _DatasetStore(tmp_path), collection_db


def test_pdf_source_prefers_historical_evidence_over_same_name_current_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, collection_db = _make_store(tmp_path, monkeypatch, migrated=True)
    current_pdf = tmp_path / "raw" / "report.pdf"
    historical_pdf = tmp_path / "raw" / "report_v1.pdf"
    current_pdf.parent.mkdir(parents=True)
    current_pdf.write_bytes(b"%PDF-1.4 current")
    historical_pdf.write_bytes(b"%PDF-1.4 historical")

    with sqlite3.connect(collection_db) as conn:
        conn.executemany(
            """
            INSERT INTO documents (
                doc_id, dataset_id, source_relpath, logical_doc_id, version_no,
                supersedes_doc_id, is_current, original_filename, file_type,
                doc_type, stored_path, status, chunk_count, error_message, deleted_at
            ) VALUES (?, 'demo', ?, 'report-logical', ?, ?, ?, 'report.pdf', 'pdf',
                      'report', ?, ?, 1, NULL, ?)
            """,
            [
                (
                    "report-current",
                    "reports/report.pdf",
                    2,
                    "report-old",
                    1,
                    str(current_pdf),
                    "indexed",
                    None,
                ),
                (
                    "report-old",
                    "reports/report.pdf",
                    1,
                    None,
                    0,
                    str(historical_pdf),
                    "superseded",
                    "2026-01-02T00:00:00Z",
                ),
            ],
        )
        conn.execute(
            """
            INSERT INTO chunks (
                chunk_id, dataset_id, doc_id, chunk_index, content, content_type,
                title_path, summary, source_ref, metadata_json
            ) VALUES ('report-old-chunk', 'demo', 'report-old', 1, 'Historical evidence',
                      'pdf_page', 'Report > page 1', NULL, 'report.pdf p.1', '{}')
            """
        )

    def fail_name_lookup(*_args: object, **_kwargs: object) -> None:
        pytest.fail("pdf_name lookup must not run when evidence_id is present")

    monkeypatch.setattr(private_fund_pdf, "_dataset_pdf_path_by_name", fail_name_lookup)
    route_workspace = object.__new__(private_fund_pdf._PrivateFundPdfWorkspace)

    resolved = route_workspace.source_pdf_path(
        pdf_name="report.pdf",
        evidence_id="chunk:report-old-chunk",
        dataset_id="demo",
    )

    assert resolved == historical_pdf.resolve()


def test_old_schema_filters_deleted_documents_and_payloads(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, collection_db = _make_store(tmp_path, monkeypatch, migrated=False)
    with sqlite3.connect(collection_db) as conn:
        conn.executemany(
            "INSERT INTO documents VALUES (?, 'demo', ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    "active-doc",
                    "notes.md",
                    "md",
                    "research_note",
                    "/raw/notes.md",
                    "indexed",
                    1,
                    None,
                    None,
                ),
                (
                    "deleted-doc",
                    "old.pdf",
                    "pdf",
                    "report",
                    "/raw/old.pdf",
                    "superseded",
                    1,
                    None,
                    "2026-01-02T00:00:00Z",
                ),
            ],
        )
        conn.executemany(
            "INSERT INTO chunks VALUES (?, 'demo', ?, 1, ?, ?, ?, NULL, ?, '{}')",
            [
                (
                    "active-chunk",
                    "active-doc",
                    "Active summary",
                    "markdown_document_summary",
                    "Notes",
                    "notes.md",
                ),
                (
                    "deleted-chunk",
                    "deleted-doc",
                    "retiredsecret",
                    "pdf_document_summary",
                    "Old",
                    "old.pdf p.1",
                ),
            ],
        )
        conn.executemany(
            """
            INSERT INTO chunk_locations VALUES (
                ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?
            )
            """,
            [
                ("active-location", "active-chunk", "active-doc", "notes.md"),
                ("deleted-location", "deleted-chunk", "deleted-doc", "old.pdf p.1"),
            ],
        )

    status = store.status()
    assert status["counts"]["documents"] == 1
    assert status["counts"]["chunks"] == 1
    assert status["counts"]["chunk_locations"] == 1
    assert [row["doc_id"] for row in status["documents"]] == ["active-doc"]

    fallback = store.search(query="retiredsecret", include_metric_facts=False)
    assert [item["evidence_id"] for item in fallback["evidence"]] == ["chunk:active-chunk"]
    assert fallback["evidence"][0]["source"]["source_url"] is None
    historical = store.source_detail(evidence_id="chunk:deleted-chunk")
    assert historical["content"] == "retiredsecret"
    assert historical["document"]["is_historical"] is True
    assert historical["document"]["deleted_at"] == "2026-01-02T00:00:00Z"


def test_generic_sources_preserve_provenance_without_false_viewer_links(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, collection_db = _make_store(tmp_path, monkeypatch, migrated=True)
    with sqlite3.connect(collection_db) as conn:
        conn.executemany(
            """
            INSERT INTO documents VALUES (
                ?, 'demo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
            """,
            [
                (
                    "deck-current",
                    "quarterly/deck.pptx",
                    "deck-logical",
                    2,
                    "deck-old",
                    1,
                    "deck.pptx",
                    "pptx",
                    "presentation",
                    "/raw/deck.pptx",
                    "indexed",
                    1,
                    None,
                    None,
                ),
                (
                    "deck-old",
                    "quarterly/deck.pptx",
                    "deck-logical",
                    1,
                    None,
                    0,
                    "deck.pptx",
                    "pptx",
                    "presentation",
                    "/raw/deck-old.pptx",
                    "superseded",
                    1,
                    None,
                    None,
                ),
                (
                    "csv-current",
                    "tables/data.csv",
                    "csv-logical",
                    1,
                    None,
                    1,
                    "data.csv",
                    "csv",
                    "table",
                    "/raw/data.csv",
                    "indexed",
                    1,
                    None,
                    None,
                ),
            ],
        )
        conn.executemany(
            "INSERT INTO chunks VALUES (?, 'demo', ?, 1, ?, ?, ?, NULL, ?, '{}')",
            [
                (
                    "deck-chunk",
                    "deck-current",
                    "forecastneedle",
                    "pptx_slide",
                    "Deck > Outlook",
                    "deck.pptx slides 2-3",
                ),
                (
                    "deck-old-chunk",
                    "deck-old",
                    "forecastneedle retired",
                    "pptx_slide",
                    "Deck > Old",
                    "deck.pptx slide 1",
                ),
                (
                    "csv-chunk",
                    "csv-current",
                    "marginkey",
                    "csv_rows",
                    "Data > rows 2-3",
                    "data.csv A2:B3",
                ),
            ],
        )
        conn.executemany(
            """
            INSERT INTO chunk_locations VALUES (
                ?, ?, ?, 0, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?
            )
            """,
            [
                (
                    "deck-location",
                    "deck-chunk",
                    "deck-current",
                    2,
                    3,
                    "Deck > Outlook",
                    None,
                    None,
                    "deck.pptx slides 2-3",
                ),
                (
                    "deck-old-location",
                    "deck-old-chunk",
                    "deck-old",
                    1,
                    1,
                    "Deck > Old",
                    None,
                    None,
                    "deck.pptx slide 1",
                ),
                (
                    "csv-location",
                    "csv-chunk",
                    "csv-current",
                    None,
                    None,
                    "Data > rows 2-3",
                    "data",
                    "A2:B3",
                    "data.csv rows 2-3",
                ),
            ],
        )

    deck = store.search(query="forecastneedle", include_metric_facts=False)["evidence"]
    assert [item["evidence_id"] for item in deck] == ["chunk:deck-chunk"]
    assert deck[0]["citation"] == "quarterly/deck.pptx slides 2-3"
    assert deck[0]["document"]["filename"] == "quarterly/deck.pptx"
    assert deck[0]["source"]["slide_start"] == 2
    assert deck[0]["source"]["slide_end"] == 3
    assert deck[0]["source"]["heading_path"] == "Deck > Outlook"
    assert deck[0]["source"]["source_url"] is None

    csv_evidence = store.search(query="marginkey", include_metric_facts=False)["evidence"][0]
    assert csv_evidence["citation"] == "tables/data.csv rows 2-3"
    assert csv_evidence["source"]["sheet_name"] == "data"
    assert csv_evidence["source"]["cell_range"] == "A2:B3"
    assert csv_evidence["source"]["source_url"] is None

    detail = store.source_detail(evidence_id="chunk:deck-chunk")
    assert detail["source"]["slide_start"] == 2
    assert detail["source"]["heading_path"] == "Deck > Outlook"
