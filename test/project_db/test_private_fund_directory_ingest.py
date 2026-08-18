from __future__ import annotations

import importlib
import json
import sqlite3
import sys
from pathlib import Path

import fitz
import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
PIPELINE_DIR = REPO_ROOT / "FinSagent" / "data_pipeline"
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

ingest = importlib.import_module("private_fund_directory_ingest")


DATASET_ID = "pipeline-regression"


def test_period_parser_rejects_year_like_fragments_inside_financial_values() -> None:
    assert ingest._period_from_label("2025") == "2025"
    assert ingest._period_from_label("2026E") == "2026E"
    assert ingest._period_from_label("FY 2027") == "FY 2027"
    assert ingest._period_from_label("1Q26") == "1Q26"
    assert ingest._period_from_label("Q1-23") == "Q1-23"
    assert ingest._period_from_label("4Q 23") == "4Q 23"
    assert ingest._period_from_label("2083") == ""
    assert ingest._period_from_label("12068.32666") == ""
    assert ingest._period_from_label("0.207812345") == ""


def _write_pdf(path: Path, *lines: str) -> None:
    """Write a deterministic one-page PDF, replacing an older fixture safely."""

    temporary = path.with_name(f".{path.name}.tmp.pdf")
    document = fitz.open()
    page = document.new_page()
    if lines:
        y = 72.0
        for line in lines:
            page.insert_text((72.0, y), line, fontsize=11)
            y += 18.0
    else:
        # A visible page with no text layer models an image-only/scanned PDF.
        page.draw_rect(
            fitz.Rect(72.0, 72.0, 420.0, 520.0),
            color=(0.1, 0.1, 0.1),
            fill=(0.9, 0.9, 0.9),
        )
    document.save(temporary)
    document.close()
    temporary.replace(path)


def _write_mixed_text_pdf(path: Path) -> None:
    """Write one image-only page followed by one short text-layer page."""

    document = fitz.open()
    scan_page = document.new_page()
    scan_page.draw_rect(
        fitz.Rect(72.0, 72.0, 420.0, 520.0),
        color=(0.1, 0.1, 0.1),
        fill=(0.9, 0.9, 0.9),
    )
    text_page = document.new_page()
    text_page.insert_text(
        (72.0, 72.0),
        "MIXED_SCAN_MARKER revenue outlook, margins, cash flow, valuation, catalysts, and risks.",
        fontsize=11,
    )
    document.save(path)
    document.close()


def _run(source: Path, workspace: Path, *, reset: bool = False):
    source.mkdir(parents=True, exist_ok=True)
    return ingest.ingest_directory(
        directory_path=source,
        workspace_root=workspace,
        dataset_id=DATASET_ID,
        dataset_name="Pipeline regression",
        reset=reset,
    )


def _connect(result) -> sqlite3.Connection:
    connection = sqlite3.connect(result.collection_db_path)
    connection.row_factory = sqlite3.Row
    return connection


def _only_document(connection: sqlite3.Connection) -> sqlite3.Row:
    rows = connection.execute("SELECT * FROM documents ORDER BY version_no").fetchall()
    assert len(rows) == 1
    return rows[0]


def test_text_pdf_is_indexed_with_page_and_location_provenance(tmp_path: Path) -> None:
    source = tmp_path / "source"
    workspace = tmp_path / "workspace"
    source.mkdir()
    marker = "TEXT_PDF_MARKER revenue grew while cash flow and margins remained resilient."
    _write_pdf(
        source / "research.pdf",
        marker,
        "Management also discussed demand, pricing, competition, and execution risks.",
    )

    result = _run(source, workspace)

    assert result.status == "completed"
    assert result.supported_file_count == 1
    assert result.documents[0].status == "indexed"
    assert result.documents[0].chunk_count >= 2
    with _connect(result) as connection:
        document = _only_document(connection)
        assert document["status"] == "indexed"
        assert document["is_current"] == 1
        assert document["deleted_at"] is None
        assert document["parser_name"]
        page = connection.execute(
            "SELECT * FROM pdf_pages WHERE doc_id = ?", (document["doc_id"],)
        ).fetchone()
        assert page is not None
        assert marker in page["text"]
        chunk = connection.execute(
            """
            SELECT c.chunk_id, c.content, l.page_start, l.page_end, l.display_text
            FROM chunks c
            JOIN chunk_locations l ON l.chunk_id = c.chunk_id
            WHERE c.doc_id = ? AND c.content_type = 'pdf_page' AND c.content LIKE ?
            """,
            (document["doc_id"], f"%{marker}%"),
        ).fetchone()
        assert chunk is not None
        assert chunk["page_start"] == 1
        assert chunk["page_end"] == 1
        assert chunk["display_text"] == "research.pdf p.1"


def test_ingest_persists_controlled_business_type_and_company_detection(tmp_path: Path) -> None:
    source = tmp_path / "source"
    workspace = tmp_path / "workspace"
    source.mkdir()
    _write_pdf(
        source / "tesla-2025-annual-report.pdf",
        "Tesla Inc",
        "2025 Annual Report",
        "Auditor's Report",
        "Consolidated Balance Sheet",
        "Consolidated Statements of Operations and Cash Flows",
    )

    result = _run(source, workspace)

    assert result.status == "completed"
    assert result.documents[0].doc_type == "financial_valuation_data"
    assert result.documents[0].doc_subtype == "annual_report"
    assert result.documents[0].classification_status == "accepted"
    with _connect(result) as connection:
        document = _only_document(connection)
        assert document["doc_type"] == "financial_valuation_data"
        assert document["doc_subtype"] == "annual_report"
        assert document["doc_type_confidence"] >= 0.9
        assert document["classification_status"] == "accepted"
        assert document["classification_taxonomy_version"] == (
            "private_fund_document_taxonomy_v2"
        )
        assert document["classifier_version"] == "hybrid_rules_llm_v3"
        assert document["company_name"] == "Tesla Inc"
        metadata = json.loads(document["classification_metadata_json"])
        assert metadata["doc_type"] == "financial_valuation_data"
        assert metadata["evidence"]


def test_preclassified_upload_is_reused_without_a_second_llm_classification(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    workspace = tmp_path / "workspace"
    source.mkdir()
    source_path = source / "sungrow-report.txt"
    source_path.write_text(
        "阳光电源股份有限公司\n2025年年度报告\n合并资产负债表",
        encoding="utf-8",
    )
    supplied = ingest.DocumentClassification(
        doc_type="financial_valuation_data",
        doc_subtype="annual_report",
        confidence=0.98,
        company_name="阳光电源股份有限公司",
        company_ticker="300274.SZ",
        company_confidence=0.99,
        classification_status="accepted",
        method="hybrid_llm",
        company_method="llm_content_entity",
        evidence=["阳光电源股份有限公司", "2025年年度报告"],
    )

    def unexpected_classification(*_args, **_kwargs):
        raise AssertionError("the pipeline must reuse the unified-upload classification")

    monkeypatch.setattr(ingest, "classify_document", unexpected_classification)
    result = ingest.ingest_directory(
        directory_path=source,
        workspace_root=workspace,
        dataset_id=DATASET_ID,
        dataset_name="Sungrow research",
        company_name="阳光电源股份有限公司",
        company_ticker="300274.SZ",
        preclassifications_by_checksum={ingest.sha256_file(source_path): supplied},
    )

    assert result.status == "completed"
    assert result.documents[0].classification_method == "hybrid_llm"
    assert result.documents[0].company_name == "阳光电源股份有限公司"


def test_preclassification_is_never_reused_for_a_different_checksum(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    workspace = tmp_path / "workspace"
    source.mkdir()
    source_path = source / "same-name.txt"
    source_path.write_text("Fresh company research content", encoding="utf-8")
    stale = ingest.DocumentClassification(
        doc_type="financial_valuation_data",
        doc_subtype="annual_report",
        confidence=0.99,
        company_name="Stale Company Ltd.",
        company_confidence=0.99,
        classification_status="accepted",
        method="stale_preclassification",
    )
    fresh = ingest.DocumentClassification(
        doc_type="meeting_third_party",
        doc_subtype="internal_research_report",
        confidence=0.91,
        company_name="Fresh Company Ltd.",
        company_confidence=0.91,
        classification_status="accepted",
        method="fresh_classification",
    )
    calls = 0

    def classify_fresh(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        return fresh

    monkeypatch.setattr(ingest, "classify_document", classify_fresh)
    result = ingest.ingest_directory(
        directory_path=source,
        workspace_root=workspace,
        dataset_id=DATASET_ID,
        dataset_name="Checksum binding",
        preclassifications_by_checksum={"not-the-file-checksum": stale},
    )

    assert calls == 1
    assert result.documents[0].classification_method == "fresh_classification"
    assert result.documents[0].company_name == "Fresh Company Ltd."


def test_company_conflict_preserves_source_but_does_not_index_it(tmp_path: Path) -> None:
    source = tmp_path / "source"
    workspace = tmp_path / "workspace"
    source.mkdir()
    _write_pdf(
        source / "tesla-annual-report.pdf",
        "Tesla Corporation",
        "2025 Annual Report",
        "Auditor's Report",
        "Consolidated Balance Sheet",
    )

    result = ingest.ingest_directory(
        directory_path=source,
        workspace_root=workspace,
        dataset_id=DATASET_ID,
        dataset_name="Sungrow research",
        company_name="Sungrow Power Supply Co., Ltd.",
        company_ticker="300274.SZ",
    )

    assert result.status == "completed_with_warnings"
    assert result.documents[0].classification_status == "company_conflict"
    assert result.documents[0].status == "classification_review_required"
    assert result.documents[0].chunk_count == 0
    with _connect(result) as connection:
        document = _only_document(connection)
        assert document["company_name"] == "Tesla Corporation"
        assert document["status"] == "classification_review_required"
        assert connection.execute("SELECT COUNT(*) FROM chunks").fetchone()[0] == 0


def test_blank_pdf_needs_ocr_and_has_no_searchable_chunks(tmp_path: Path) -> None:
    source = tmp_path / "source"
    workspace = tmp_path / "workspace"
    source.mkdir()
    _write_pdf(source / "scan.pdf")

    result = _run(source, workspace)

    assert result.status == "completed_with_warnings"
    assert result.warning_count == 1
    assert result.documents[0].status == "needs_ocr"
    assert result.documents[0].chunk_count == 0
    assert "OCR required" in (result.documents[0].error_message or "")
    with _connect(result) as connection:
        document = _only_document(connection)
        assert document["status"] == "needs_ocr"
        assert document["is_current"] == 1
        assert document["deleted_at"] is None
        assert connection.execute(
            "SELECT COUNT(*) FROM chunks WHERE doc_id = ?", (document["doc_id"],)
        ).fetchone()[0] == 0
        page = connection.execute(
            "SELECT char_count, metadata_json FROM pdf_pages WHERE doc_id = ?",
            (document["doc_id"],),
        ).fetchone()
        assert page["char_count"] == 0
        metadata = json.loads(page["metadata_json"])
        assert metadata["text_quality"]["needs_ocr"] is True
        indexes = connection.execute(
            "SELECT status, source_chunk_count, built_at FROM index_registry"
        ).fetchall()
        assert indexes
        assert all(tuple(row) == ("empty", 0, None) for row in indexes)


def test_partially_scanned_pdf_does_not_silently_index_only_text_pages(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    workspace = tmp_path / "workspace"
    source.mkdir()
    _write_mixed_text_pdf(source / "mixed-scan.pdf")

    result = _run(source, workspace)

    assert result.status == "completed_with_warnings"
    assert result.documents[0].status == "needs_ocr"
    assert result.documents[0].chunk_count == 0
    quality = result.documents[0].parser_metadata["text_quality"]
    assert quality["text_page_count"] == 1
    assert quality["page_count"] == 2
    assert quality["text_page_coverage"] == 0.5


def test_unsupported_only_directory_fails_instead_of_succeeding_empty(tmp_path: Path) -> None:
    source = tmp_path / "source"
    workspace = tmp_path / "workspace"
    source.mkdir()
    (source / "legacy.xls").write_bytes(b"legacy workbook placeholder")
    (source / "archive.rtf").write_text(r"{\rtf1 unsupported}", encoding="utf-8")

    result = _run(source, workspace)

    assert result.status == "failed"
    assert result.discovered_file_count == 2
    assert result.supported_file_count == 0
    assert result.unsupported_file_count == 2
    assert result.file_count == 0
    assert {document.status for document in result.documents} == {"unsupported"}
    with _connect(result) as connection:
        assert connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 0
        job = connection.execute(
            "SELECT status, returncode FROM ingest_jobs ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
        assert tuple(job) == ("failed", 1)


def test_reset_false_reuses_identical_current_document_without_duplicates(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    workspace = tmp_path / "workspace"
    source.mkdir()
    _write_pdf(
        source / "stable.pdf",
        "IDEMPOTENT_MARKER this document contains enough stable searchable research text.",
        "A second line covers valuation, earnings, cash flow, risks, and catalysts.",
    )

    first = _run(source, workspace, reset=False)
    with _connect(first) as connection:
        first_document = _only_document(connection)
        first_doc_id = first_document["doc_id"]
        first_counts = {
            table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("documents", "pdf_pages", "chunks", "chunk_locations")
        }

    second = _run(source, workspace, reset=False)

    assert second.status == "completed"
    assert second.documents[0].reused is True
    assert second.documents[0].doc_id == first_doc_id
    assert second.documents[0].version_no == 1
    with _connect(second) as connection:
        second_document = _only_document(connection)
        assert second_document["doc_id"] == first_doc_id
        assert second_document["version_no"] == 1
        assert second_document["is_current"] == 1
        assert {
            table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("documents", "pdf_pages", "chunks", "chunk_locations")
        } == first_counts
        assert connection.execute("SELECT COUNT(*) FROM ingest_jobs").fetchone()[0] == 2


def test_same_source_path_with_new_content_creates_superseding_version(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    workspace = tmp_path / "workspace"
    source.mkdir()
    pdf = source / "changing.pdf"
    old_marker = "OLD_VERSION_MARKER original revenue outlook and valuation assumptions."
    new_marker = "NEW_VERSION_MARKER revised revenue outlook and valuation assumptions."
    _write_pdf(pdf, old_marker, "The original report also discusses cash flow and risks.")
    first = _run(source, workspace)
    first_doc_id = first.documents[0].doc_id

    _write_pdf(pdf, new_marker, "The revised report also discusses cash flow and risks.")
    second = _run(source, workspace, reset=False)

    assert second.status == "completed"
    assert second.documents[0].reused is False
    assert second.documents[0].version_no == 2
    assert second.documents[0].supersedes_doc_id == first_doc_id
    with _connect(second) as connection:
        versions = connection.execute(
            """
            SELECT * FROM documents
            WHERE source_relpath = 'changing.pdf'
            ORDER BY version_no
            """
        ).fetchall()
        assert len(versions) == 2
        old, new = versions
        assert old["logical_doc_id"] == new["logical_doc_id"]
        assert (
            old["version_no"],
            old["status"],
            old["lifecycle_state"],
            old["is_current"],
        ) == (
            1,
            "indexed",
            "superseded",
            0,
        )
        assert old["deleted_at"] is not None
        assert (
            new["version_no"],
            new["status"],
            new["lifecycle_state"],
            new["is_current"],
        ) == (
            2,
            "indexed",
            "active",
            1,
        )
        assert new["deleted_at"] is None
        assert new["supersedes_doc_id"] == old["doc_id"]
        assert connection.execute(
            "SELECT COUNT(*) FROM chunks WHERE doc_id = ? AND content LIKE ?",
            (old["doc_id"], f"%{old_marker}%"),
        ).fetchone()[0] >= 1
        assert connection.execute(
            "SELECT COUNT(*) FROM chunks WHERE doc_id = ? AND content LIKE ?",
            (new["doc_id"], f"%{new_marker}%"),
        ).fetchone()[0] >= 1
        assert connection.execute(
            """
            SELECT COUNT(*)
            FROM chunks c JOIN documents d ON d.doc_id = c.doc_id
            WHERE d.is_current = 1 AND d.deleted_at IS NULL AND c.content LIKE ?
            """,
            (f"%{old_marker}%",),
        ).fetchone()[0] == 0


def test_removed_source_document_is_no_longer_active_but_history_remains(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    workspace = tmp_path / "workspace"
    source.mkdir()
    pdf = source / "removed.pdf"
    marker = "REMOVED_MARKER historical research evidence must remain traceable after removal."
    _write_pdf(pdf, marker, "The report includes earnings, cash flow, and risk analysis.")
    first = _run(source, workspace)
    doc_id = first.documents[0].doc_id
    pdf.unlink()

    second = _run(source, workspace, reset=False)

    assert second.status == "failed"
    assert second.removed_file_count == 1
    with _connect(second) as connection:
        document = _only_document(connection)
        assert document["doc_id"] == doc_id
        assert document["status"] == "indexed"
        assert document["lifecycle_state"] == "removed"
        assert document["is_current"] == 0
        assert document["deleted_at"] is not None
        assert connection.execute(
            "SELECT COUNT(*) FROM chunks WHERE doc_id = ? AND content LIKE ?",
            (doc_id, f"%{marker}%"),
        ).fetchone()[0] >= 1
        assert connection.execute(
            """
            SELECT COUNT(*)
            FROM chunks c JOIN documents d ON d.doc_id = c.doc_id
            WHERE d.is_current = 1 AND d.deleted_at IS NULL
            """
        ).fetchone()[0] == 0
        index_rows = connection.execute(
            "SELECT source_doc_ids_json, source_chunk_count FROM index_registry"
        ).fetchall()
        assert index_rows
        assert all(json.loads(row["source_doc_ids_json"]) == [] for row in index_rows)
        assert all(row["source_chunk_count"] == 0 for row in index_rows)


def test_text_markdown_and_csv_adapters_are_ingested_with_provenance(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    workspace = tmp_path / "workspace"
    source.mkdir()
    (source / "notes.txt").write_text(
        "TXT_ADAPTER_MARKER management discussed revenue and execution risks.\n"
        "The next line covers margins and free cash flow.\n",
        encoding="utf-8",
    )
    (source / "thesis.md").write_text(
        "# Investment thesis\n\n"
        "MD_ADAPTER_MARKER growth is supported by demand and operating leverage.\n",
        encoding="utf-8",
    )
    (source / "metrics.csv").write_text(
        "metric,2025A,2026E\n"
        "CSV_ADAPTER_MARKER,100,125\n"
        "free_cash_flow,20,30\n",
        encoding="utf-8",
    )

    result = _run(source, workspace)

    assert result.status == "completed"
    assert result.supported_file_count == 3
    assert {document.file_type for document in result.documents} == {"txt", "md", "csv"}
    assert {document.status for document in result.documents} == {"indexed"}
    with _connect(result) as connection:
        documents = connection.execute(
            "SELECT doc_id, original_filename, parser_name FROM documents"
        ).fetchall()
        assert len(documents) == 3
        assert all(row["parser_name"] == "private_fund_format_adapters" for row in documents)
        content_types = {
            row[0] for row in connection.execute("SELECT DISTINCT content_type FROM chunks")
        }
        assert {"text_lines", "markdown_section", "csv_rows"} <= content_types
        for marker in ("TXT_ADAPTER_MARKER", "MD_ADAPTER_MARKER", "CSV_ADAPTER_MARKER"):
            assert connection.execute(
                "SELECT COUNT(*) FROM chunks WHERE content LIKE ?", (f"%{marker}%",)
            ).fetchone()[0] >= 1
        csv_location = connection.execute(
            """
            SELECT l.sheet_name, l.cell_range, l.metadata_json
            FROM chunk_locations l
            JOIN chunks c ON c.chunk_id = l.chunk_id
            WHERE c.content_type = 'csv_rows'
            LIMIT 1
            """
        ).fetchone()
        assert csv_location["sheet_name"] == "metrics"
        assert csv_location["cell_range"]
        assert json.loads(csv_location["metadata_json"])["row_start"] >= 1


def test_reset_forces_a_new_version_without_deleting_history_or_memos(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    workspace = tmp_path / "workspace"
    source.mkdir()
    (source / "memo-source.txt").write_text(
        "RESET_MARKER revenue, margins, cash flow, risks, and catalysts remain traceable.\n",
        encoding="utf-8",
    )

    first = _run(source, workspace)
    memo_path = Path(first.dataset_root) / "memos" / "long-term-report.md"
    memo_path.parent.mkdir(parents=True)
    memo_path.write_text("# Historical report\n", encoding="utf-8")

    second = _run(source, workspace, reset=True)

    assert second.status == "completed"
    assert second.documents[0].reused is False
    assert second.documents[0].version_no == 2
    assert second.documents[0].supersedes_doc_id == first.documents[0].doc_id
    assert memo_path.read_text(encoding="utf-8") == "# Historical report\n"
    with _connect(second) as connection:
        versions = connection.execute(
            """
            SELECT version_no, status, lifecycle_state, is_current
            FROM documents ORDER BY version_no
            """
        ).fetchall()
        assert [tuple(row) for row in versions] == [
            (1, "indexed", "superseded", 0),
            (2, "indexed", "active", 1),
        ]
        assert connection.execute("SELECT COUNT(*) FROM ingest_jobs").fetchone()[0] == 2


def test_nested_workspace_and_office_lock_files_are_not_reingested(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    workspace = source / "generated" / "datasets"
    source.mkdir()
    (source / "notes.txt").write_text(
        "NESTED_WORKSPACE_MARKER demand, earnings, valuation, and risk analysis.\n",
        encoding="utf-8",
    )
    (source / "~$open-document.docx").write_bytes(b"office lock placeholder")

    first = _run(source, workspace)
    second = _run(source, workspace)

    assert first.discovered_file_count == 1
    assert second.discovered_file_count == 1
    assert second.supported_file_count == 1
    assert second.documents[0].reused is True
    with _connect(second) as connection:
        assert connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 1


def test_dangerous_source_output_overlap_is_rejected_before_state_changes(
    tmp_path: Path,
) -> None:
    source_and_workspace = tmp_path / "shared"
    source_and_workspace.mkdir()
    sibling_raw = source_and_workspace / "other-project" / "raw"
    sibling_raw.mkdir(parents=True)
    (sibling_raw / "other.txt").write_text("must not be swallowed", encoding="utf-8")

    with pytest.raises(ValueError, match="source|workspace|overlap"):
        _run(source_and_workspace, source_and_workspace)

    assert not (source_and_workspace / "datasets.sqlite3").exists()
    assert not (source_and_workspace / DATASET_ID).exists()


def test_project_uploads_directory_inside_dataset_root_remains_supported(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    uploads = workspace / DATASET_ID / "_uploads"
    uploads.mkdir(parents=True)
    (uploads / "uploaded.txt").write_text(
        "UPLOADS_MARKER revenue, margins, valuation, cash flow, catalysts, and risks.\n",
        encoding="utf-8",
    )

    result = _run(uploads, workspace)

    assert result.status == "completed"
    assert result.supported_file_count == 1
    assert result.documents[0].status == "indexed"


def test_legacy_same_name_active_documents_are_not_destructively_merged(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "legacy.sqlite3"
    with sqlite3.connect(db_path) as connection:
        connection.row_factory = sqlite3.Row
        connection.executescript(
            """
            CREATE TABLE documents (
                doc_id TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL,
                title TEXT NOT NULL,
                original_filename TEXT NOT NULL,
                stored_path TEXT NOT NULL,
                file_type TEXT NOT NULL,
                doc_type TEXT,
                source_type TEXT,
                source_name TEXT,
                company_name TEXT,
                company_ticker TEXT,
                document_date TEXT,
                checksum TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                status TEXT NOT NULL,
                chunk_count INTEGER NOT NULL DEFAULT 0,
                error_message TEXT,
                metadata_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT
            );
            """
        )
        rows = [
            (
                "legacy-a",
                DATASET_ID,
                "Report A",
                "report.pdf",
                "/legacy/a/report.pdf",
                "pdf",
                "research_note",
                "local_directory",
                "report.pdf",
                "",
                "",
                "",
                "checksum-a",
                100,
                "indexed",
                1,
                None,
                "{}",
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z",
                None,
            ),
            (
                "legacy-b",
                DATASET_ID,
                "Report B",
                "report.pdf",
                "/legacy/b/report.pdf",
                "pdf",
                "research_note",
                "local_directory",
                "report.pdf",
                "",
                "",
                "",
                "checksum-b",
                200,
                "indexed",
                1,
                None,
                "{}",
                "2026-01-02T00:00:00Z",
                "2026-01-02T00:00:00Z",
                None,
            ),
        ]
        connection.executemany(
            "INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
        ingest.ensure_collection_schema(connection)
        migrated = connection.execute(
            """
            SELECT doc_id, logical_doc_id, version_no, is_current, lifecycle_state,
                   status, deleted_at
            FROM documents
            ORDER BY doc_id
            """
        ).fetchall()

    assert len(migrated) == 2
    assert len({row["logical_doc_id"] for row in migrated}) == 2
    assert all(row["version_no"] == 1 for row in migrated)
    assert all(row["is_current"] == 1 for row in migrated)
    assert all(row["lifecycle_state"] == "active" for row in migrated)
    assert all(row["status"] == "indexed" for row in migrated)
    assert all(row["deleted_at"] is None for row in migrated)
