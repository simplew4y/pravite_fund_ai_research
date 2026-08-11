from __future__ import annotations

import importlib.util
import sqlite3
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[2] / "FinSagent" / "scripts" / "audit_retrieval_scope.py"
SPEC = importlib.util.spec_from_file_location("audit_retrieval_scope", SCRIPT)
assert SPEC and SPEC.loader
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


def test_company_metadata_mismatch_is_detected() -> None:
    authoritative = {
        "doc-nvidia": {"company_name": "NVIDIA Corp", "company_ticker": "NVDA"}
    }
    assert audit._metadata_company_mismatch(
        {"source_doc_id": "doc-nvidia", "company_name": "Lotus Technology", "ticker": "LOT"},
        authoritative,
    )
    assert not audit._metadata_company_mismatch(
        {"source_doc_id": "doc-nvidia", "company_name": "NVIDIA Corp", "ticker": "NVDA"},
        authoritative,
    )


def test_sqlite_audit_reports_orphans_and_cross_document_duplicate_chunks(tmp_path: Path) -> None:
    db = tmp_path / "collection.sqlite3"
    with sqlite3.connect(db) as conn:
        conn.executescript(
            """
            CREATE TABLE documents (
                doc_id TEXT PRIMARY KEY, dataset_id TEXT, company_name TEXT,
                company_ticker TEXT, is_current INTEGER, lifecycle_state TEXT,
                deleted_at TEXT, status TEXT, checksum TEXT, logical_doc_id TEXT,
                original_filename TEXT
            );
            CREATE TABLE chunks (
                chunk_id TEXT PRIMARY KEY, doc_id TEXT, dataset_id TEXT,
                content_type TEXT, content_hash TEXT
            );
            CREATE TABLE metric_facts (fact_id TEXT PRIMARY KEY, doc_id TEXT);
            INSERT INTO documents VALUES
                ('doc-a', 'formal', 'Company A', 'A', 1, 'active', NULL, 'indexed',
                 'same-checksum', 'logical-a', 'a.xlsx'),
                ('doc-b', 'formal', 'Company B', 'B', 1, 'active', NULL, 'indexed',
                 'same-checksum', 'logical-b', 'b.xlsx');
            INSERT INTO chunks VALUES
                ('chunk-a', 'doc-a', 'formal', 'excel_region_summary', 'same-template'),
                ('chunk-b', 'doc-b', 'formal', 'excel_region_summary', 'same-template'),
                ('chunk-orphan', 'doc-missing', 'formal', 'text', 'unique');
            INSERT INTO metric_facts VALUES ('fact-orphan', 'doc-missing');
            """
        )
    report = audit.audit_sqlite(db)
    assert report["orphan_doc_ids"]["chunks"] == ["doc-missing"]
    assert report["orphan_doc_ids"]["metric_facts"] == ["doc-missing"]
    assert report["cross_document_duplicate_content_hashes"][0]["content_hash"] == "same-template"
    assert report["duplicate_documents"]["checksum"] == [
        {
            "value": "same-checksum",
            "doc_ids": ["doc-a", "doc-b"],
            "document_count": 2,
        }
    ]
    assert report["duplicate_documents"]["logical_doc_id"] == []
    assert report["duplicate_documents"]["original_filename"] == []
