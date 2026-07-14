"""Project-level private-fund token usage aggregation tests."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, cast

from fastapi import FastAPI
from fastapi.testclient import TestClient

from omnigent.entities.conversation import Conversation
from omnigent.entities.pagination import PagedList
from omnigent.server.routes import private_fund_pdf
from omnigent.stores.conversation_store import ConversationStore


def _conversation(conversation_id: str, dataset_id: str | None) -> Conversation:
    labels = (
        {private_fund_pdf.PRIVATE_FUND_PROJECT_LABEL_ID: dataset_id}
        if dataset_id is not None
        else {}
    )
    return Conversation(
        id=conversation_id,
        created_at=1,
        updated_at=1,
        root_conversation_id=conversation_id,
        agent_id="ag_test",
        labels=labels,
    )


class _FakeConversationStore:
    def __init__(self, rows: list[Conversation]) -> None:
        self.rows = rows
        self.accessible_by: str | None = None

    def list_conversations(self, **kwargs: Any) -> PagedList[Conversation]:
        self.accessible_by = kwargs.get("accessible_by")
        assert kwargs["kind"] == "default"
        assert kwargs["include_archived"] is True
        return PagedList(
            data=self.rows,
            first_id=self.rows[0].id if self.rows else None,
            last_id=self.rows[-1].id if self.rows else None,
            has_more=False,
        )


def test_project_usage_filters_dataset_and_uses_subtree_totals(monkeypatch: Any) -> None:
    rows = [
        _conversation("conv_a", "fund-a"),
        _conversation("conv_b", "fund-b"),
        _conversation("conv_unscoped", None),
    ]
    store = _FakeConversationStore(rows)
    usage = {
        "conv_a": {
            "input_tokens": 100,
            "output_tokens": 20,
            "cache_read_input_tokens": 30,
            "total_tokens": 150,
            "total_cost_usd": 0.12,
        },
        "conv_b": {"input_tokens": 40, "output_tokens": 10},
    }
    calls: list[str] = []

    def fake_load(
        conversation_id: str,
        _store: ConversationStore,
        *,
        include_archived: bool = False,
    ) -> dict[str, Any]:
        assert include_archived is True
        calls.append(conversation_id)
        return usage.get(conversation_id, {})

    monkeypatch.setattr(private_fund_pdf, "load_session_usage", fake_load)

    result = private_fund_pdf._project_token_usage_by_dataset(
        cast(ConversationStore, store),
        accessible_by="alice@example.com",
    )

    assert store.accessible_by == "alice@example.com"
    assert calls == ["conv_a", "conv_b"]
    assert result["fund-a"] == {
        "dataset_id": "fund-a",
        "session_count": 1,
        "sessions_with_token_usage": 1,
        "sessions_with_total_tokens": 1,
        "sessions_with_cost": 1,
        "input_tokens": 100,
        "output_tokens": 20,
        "total_tokens": 150,
        "cache_read_input_tokens": 30,
        "cache_creation_input_tokens": None,
        "total_cost_usd": 0.12,
    }
    assert result["fund-b"]["total_tokens"] is None
    assert result["fund-b"]["sessions_with_token_usage"] == 1
    assert result["fund-b"]["sessions_with_total_tokens"] == 0


def test_project_usage_distinguishes_cost_only_from_token_usage() -> None:
    summary = private_fund_pdf._empty_project_token_usage("fund-a")

    private_fund_pdf._add_usage_to_project_summary(summary, {"total_cost_usd": 0.0})

    assert summary["session_count"] == 1
    assert summary["sessions_with_token_usage"] == 0
    assert summary["sessions_with_total_tokens"] == 0
    assert summary["sessions_with_cost"] == 1
    assert summary["total_tokens"] is None
    assert summary["total_cost_usd"] == 0.0


def test_project_pipeline_defaults_to_non_destructive_ingest() -> None:
    assert private_fund_pdf.RunProjectPipelineRequest().reset is False


def test_project_index_is_ready_when_pipeline_completed_with_warnings() -> None:
    assert private_fund_pdf._project_index_ready("completed", 1) is True
    assert private_fund_pdf._project_index_ready("completed_with_warnings", 1) is True
    assert private_fund_pdf._project_index_ready("failed", 1) is False
    assert private_fund_pdf._project_index_ready("completed_with_warnings", 0) is False


def test_project_uploads_accept_supported_research_document_formats() -> None:
    expected = {
        ".pdf",
        ".xlsx",
        ".xlsm",
        ".docx",
        ".pptx",
        ".csv",
        ".md",
        ".markdown",
        ".txt",
    }
    assert expected == private_fund_pdf.SUPPORTED_PROJECT_UPLOAD_SUFFIXES


def test_project_files_expose_business_classification(
    tmp_path: Path, monkeypatch: Any
) -> None:
    uploads = tmp_path / "_uploads" / "fund-a"
    uploads.mkdir(parents=True)
    source = uploads / "annual-report.pdf"
    source.write_bytes(b"pdf placeholder")
    collection_db = tmp_path / "fund-a" / "meta" / "collection.sqlite3"
    collection_db.parent.mkdir(parents=True)
    with sqlite3.connect(str(collection_db)) as conn:
        conn.execute(
            """
            CREATE TABLE documents (
                doc_id TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL,
                title TEXT,
                original_filename TEXT,
                stored_path TEXT,
                file_type TEXT,
                file_size INTEGER,
                status TEXT,
                chunk_count INTEGER,
                error_message TEXT,
                created_at TEXT,
                updated_at TEXT,
                deleted_at TEXT,
                doc_type TEXT,
                doc_subtype TEXT,
                doc_type_confidence REAL,
                classification_status TEXT,
                classification_method TEXT,
                company_name TEXT,
                company_ticker TEXT,
                company_confidence REAL
            )
            """
        )
        conn.execute(
            """
            INSERT INTO documents VALUES (
                'doc-1', 'fund-a', 'Annual report', 'annual-report.pdf', ?, 'pdf', 15,
                'indexed', 8, NULL, '2026-07-14', '2026-07-14', NULL,
                'financial_report', 'annual_report', 0.97, 'accepted', 'rules',
                'Sungrow Power Supply Co., Ltd.', '300274.SZ', 0.96
            )
            """,
            (str(tmp_path / "fund-a" / "raw" / "annual-report.pdf"),),
        )

    monkeypatch.setattr(private_fund_pdf, "_dataset_workspace_root", lambda: tmp_path)

    files = private_fund_pdf._project_files_payload("fund-a")

    assert len(files) == 1
    assert files[0]["doc_type"] == "financial_report"
    assert files[0]["doc_subtype"] == "annual_report"
    assert files[0]["doc_type_confidence"] == 0.97
    assert files[0]["classification_status"] == "accepted"
    assert files[0]["company_name"] == "Sungrow Power Supply Co., Ltd."
    assert files[0]["company_ticker"] == "300274.SZ"

    catalog = private_fund_pdf._project_assets_payload("fund-a")
    document_asset = next(
        asset for asset in catalog["assets"] if asset["asset_type"] == "document"
    )
    assert document_asset["metadata"]["doc_type"] == "financial_report"
    assert document_asset["metadata"]["doc_subtype"] == "annual_report"
    assert document_asset["metadata"]["doc_type_confidence"] == 0.97


def test_project_stats_exclude_deleted_documents_and_their_chunks(
    tmp_path: Path, monkeypatch: Any
) -> None:
    collection_db = tmp_path / "fund-a" / "meta" / "collection.sqlite3"
    collection_db.parent.mkdir(parents=True)
    with sqlite3.connect(str(collection_db)) as conn:
        conn.executescript(
            """
            CREATE TABLE documents (
                doc_id TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL,
                status TEXT NOT NULL,
                deleted_at TEXT
            );
            CREATE TABLE chunks (
                chunk_id TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL,
                doc_id TEXT NOT NULL
            );
            CREATE TABLE index_registry (dataset_id TEXT NOT NULL);
            INSERT INTO documents VALUES ('live', 'fund-a', 'indexed', NULL);
            INSERT INTO documents VALUES ('failed', 'fund-a', 'failed', NULL);
            INSERT INTO documents VALUES ('deleted', 'fund-a', 'indexed', '2026-07-10');
            INSERT INTO chunks VALUES ('live-1', 'fund-a', 'live');
            INSERT INTO chunks VALUES ('live-2', 'fund-a', 'live');
            INSERT INTO chunks VALUES ('deleted-1', 'fund-a', 'deleted');
            INSERT INTO index_registry VALUES ('fund-a');
            """
        )

    monkeypatch.setattr(private_fund_pdf, "_dataset_workspace_root", lambda: tmp_path)

    assert private_fund_pdf._project_index_stats("fund-a") == {
        "document_count": 2,
        "indexed_document_count": 1,
        "failed_document_count": 1,
        "chunk_count": 2,
        "index_count": 1,
    }


def test_pipeline_job_get_falls_back_to_persisted_ingest_job(
    tmp_path: Any, monkeypatch: Any
) -> None:
    collection_db = tmp_path / "fund-a" / "meta" / "collection.sqlite3"
    collection_db.parent.mkdir(parents=True)
    with sqlite3.connect(str(collection_db)) as conn:
        conn.execute(
            """
            CREATE TABLE ingest_jobs (
                job_id TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL,
                job_type TEXT NOT NULL,
                status TEXT NOT NULL,
                file_count INTEGER NOT NULL,
                message TEXT,
                returncode INTEGER,
                created_at TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT,
                metadata_json TEXT
            )
            """
        )
        conn.execute(
            """
            INSERT INTO ingest_jobs (
                job_id, dataset_id, job_type, status, file_count, message,
                returncode, created_at, started_at, finished_at, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "persisted-job",
                "fund-a",
                "private_fund_directory",
                "completed",
                3,
                "Ingested successfully.",
                0,
                "2026-07-10T00:00:00+00:00",
                "2026-07-10T00:00:01+00:00",
                "2026-07-10T00:00:02+00:00",
                "{}",
            ),
        )

    monkeypatch.setattr(private_fund_pdf, "_dataset_workspace_root", lambda: tmp_path)
    app = FastAPI()
    app.include_router(
        private_fund_pdf.create_private_fund_pdf_router(workspace=cast(Any, object())),
        prefix="/v1",
    )

    response = TestClient(app).get("/v1/private-fund/pipeline-jobs/persisted-job")

    assert response.status_code == 200
    assert response.json()["job"] == {
        "job_id": "persisted-job",
        "dataset_id": "fund-a",
        "job_type": "private_fund_directory",
        "status": "completed",
        "file_count": 3,
        "message": "Ingested successfully.",
        "returncode": 0,
        "created_at": "2026-07-10T00:00:00+00:00",
        "started_at": "2026-07-10T00:00:01+00:00",
        "finished_at": "2026-07-10T00:00:02+00:00",
        "metadata_json": "{}",
    }
