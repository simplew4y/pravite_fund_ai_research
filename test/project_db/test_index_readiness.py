from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import chromadb
import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[2] / "FinSagent"
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from utils.index_readiness import (  # noqa: E402
    MANIFEST_NAME,
    source_fingerprint,
    validate_index_bundle,
)


def _source_db(path: Path, dataset_id: str) -> Path:
    path.parent.mkdir(parents=True)
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE documents (
          doc_id TEXT PRIMARY KEY, dataset_id TEXT, checksum TEXT,
          chunk_count INTEGER, status TEXT, lifecycle_state TEXT
        );
        CREATE TABLE chunks (chunk_id TEXT PRIMARY KEY, dataset_id TEXT);
        CREATE TABLE excel_cells (cell_id TEXT PRIMARY KEY, dataset_id TEXT);
        CREATE TABLE metric_facts (fact_id TEXT PRIMARY KEY, dataset_id TEXT);
        """
    )
    conn.execute(
        "INSERT INTO documents VALUES (?,?,?,?,?,?)",
        ("doc-1", dataset_id, "sha-1", 1, "indexed", "active"),
    )
    conn.execute("INSERT INTO chunks VALUES (?,?)", ("chunk-1", dataset_id))
    conn.commit()
    conn.close()
    return path


def _component(path: Path, collection: str, item_id: str) -> None:
    client = chromadb.PersistentClient(path=str(path))
    client.create_collection(collection).add(
        ids=[item_id], documents=[item_id], embeddings=[[1.0, 0.0]]
    )


def _ready_bundle(root: Path, dataset_id: str, source_db: Path) -> None:
    _component(root / "chroma", dataset_id, "main-1")
    _component(root / "table_chroma", dataset_id, "table-1")
    _component(root / "ts_chroma", dataset_id, "title-1")
    bm25 = root / "bm25_index" / dataset_id
    bm25.mkdir(parents=True)
    (bm25 / "params.index.json").write_text("{}", encoding="utf-8")
    (bm25 / "corpus.jsonl").write_text('{"id":0,"text":"main-1"}\n', encoding="utf-8")
    (root / MANIFEST_NAME).write_text(
        json.dumps({
            "schema_version": 1,
            "status": "ready",
            "dataset_id": dataset_id,
            "source_fingerprint": source_fingerprint(source_db, dataset_id),
            "counts": {"main": 1, "table": 1, "title": 1, "bm25": 1},
        }),
        encoding="utf-8",
    )


def test_missing_bundle_is_rejected_without_creating_database(tmp_path: Path) -> None:
    target = tmp_path / "missing"
    report = validate_index_bundle(target, "demo")
    assert not report.ready
    assert not target.exists()
    assert all(count == 0 for count in report.counts.values())


def test_complete_bundle_is_ready_and_reusable(tmp_path: Path) -> None:
    source = _source_db(tmp_path / "meta" / "collection.sqlite3", "demo")
    target = tmp_path / "vector_store"
    _ready_bundle(target, "demo", source)
    report = validate_index_bundle(target, "demo", source_db=source)
    assert report.ready, report.errors
    assert report.counts == {"main": 1, "table": 1, "title": 1, "bm25": 1}


def test_source_change_makes_existing_bundle_stale(tmp_path: Path) -> None:
    source = _source_db(tmp_path / "meta" / "collection.sqlite3", "demo")
    target = tmp_path / "vector_store"
    _ready_bundle(target, "demo", source)
    conn = sqlite3.connect(source)
    conn.execute("INSERT INTO chunks VALUES (?,?)", ("chunk-2", "demo"))
    conn.commit()
    conn.close()
    report = validate_index_bundle(target, "demo", source_db=source)
    assert not report.ready
    assert "canonical SQLite changed after indexes were built" in report.errors


def test_rag_manager_strict_startup_does_not_create_missing_chroma(tmp_path: Path) -> None:
    from core.RAGManager import RAGManager

    target = tmp_path / "vector_store"
    RAGManager._instance = None
    with pytest.raises(RuntimeError, match="retrieval index is not ready"):
        RAGManager(
            {
                "persist_directory": str(target),
                "embeddings_model_name": "must-not-be-loaded",
                "embedding_backend": "huggingface",
                "index_readiness_required": True,
                "index_manifest_required": True,
            },
            {"demo": 5},
        )
    assert not target.exists()
    RAGManager._instance = None
