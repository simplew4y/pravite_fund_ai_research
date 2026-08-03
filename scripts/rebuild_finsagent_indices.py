#!/usr/bin/env python3
"""Rebuild one isolated FinSagent Chroma/BM25 collection per dataset."""
from __future__ import annotations

import argparse
import os
import shutil
import sqlite3
import sys
from pathlib import Path

import yaml

PROJECT_ROOT = Path(__file__).resolve().parents[1]
FINSAGENT_ROOT = PROJECT_ROOT / "FinSagent"
sys.path[:0] = [str(FINSAGENT_ROOT / "src"), str(FINSAGENT_ROOT), str(PROJECT_ROOT / "src")]

from core.RAGManager import RAGManager
from data_ingestion.chroma_bridge import TABLE_CONTENT_TYPES, sync_chunks_to_chroma
from langchain_core.documents import Document
from utils.bm25Retriever import BM25Retriever, load_from_chroma_and_save


def _reset_manager() -> None:
    RAGManager._instance = None
    RAGManager._config = None
    RAGManager._collections = {}
    RAGManager._retrievers = []
    RAGManager._embedding_lock = None


def _delete_collection_if_present(path: Path, name: str) -> None:
    import chromadb

    client = chromadb.PersistentClient(path=str(path))
    if name in {_collection_name(collection) for collection in client.list_collections()}:
        client.delete_collection(name)


def _collection_name(collection: object) -> str:
    """Support both pre-0.6 Collection objects and 0.6+ string names."""
    if isinstance(collection, str):
        return collection
    return str(collection.name)


def rebuild(config: dict, dataset: str, replace: bool) -> dict:
    db_path = Path(config["datasets"]["root_dir"]) / dataset / "meta" / "collection.sqlite3"
    if not db_path.is_file():
        raise FileNotFoundError(db_path)
    persist = Path(config["persist_directory"])

    with sqlite3.connect(db_path) as conn:
        expected_total = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        table_like = " OR ".join("content_type LIKE ?" for _ in TABLE_CONTENT_TYPES)
        expected_tables = conn.execute(
            f"SELECT COUNT(*) FROM chunks WHERE {table_like}",
            tuple(f"%{value}%" for value in TABLE_CONTENT_TYPES),
        ).fetchone()[0]
    expected_text = expected_total - expected_tables

    existing = []
    import chromadb
    for subdir in ("chroma", "table_chroma", "ts_chroma"):
        path = persist / subdir
        path.mkdir(parents=True, exist_ok=True)
        client = chromadb.PersistentClient(path=str(path))
        if dataset in {_collection_name(collection) for collection in client.list_collections()}:
            existing.append(subdir)
    if existing and not replace:
        raise RuntimeError(f"Collection {dataset!r} already exists in {existing}; pass --replace")
    if replace:
        for subdir in ("chroma", "table_chroma", "ts_chroma"):
            _delete_collection_if_present(persist / subdir, dataset)
        bm25_dir = persist / "bm25_index" / dataset
        if bm25_dir.exists():
            shutil.rmtree(bm25_dir)

    _reset_manager()
    dataset_config = dict(config)
    dataset_config["collection_name"] = dataset
    dataset_config["datasets"] = dict(config["datasets"], active_dataset=dataset)
    manager = RAGManager(dataset_config, collections={dataset: 1})
    sync_result = sync_chunks_to_chroma(
        manager, db_path, collection_name=dataset, batch_size=64,
        sync_all=True, dataset_id=dataset,
    )

    chroma, _, table_chroma = manager._collections[dataset]
    text_count = chroma._collection.count()
    table_count = table_chroma._collection.count() if table_chroma is not None else 0
    if (text_count, table_count) != (expected_text, expected_tables):
        raise RuntimeError(
            f"Count mismatch for {dataset}: got text/table={text_count}/{table_count}, "
            f"expected={expected_text}/{expected_tables}"
        )

    raw = chroma.get(include=["documents", "metadatas"])
    documents = [
        Document(page_content=text, metadata=metadata)
        for text, metadata in zip(raw.get("documents") or [], raw.get("metadatas") or [])
    ]
    if documents and any(not doc.metadata.get("source_doc_id") for doc in documents):
        raise RuntimeError(f"Collection {dataset} contains rows without source_doc_id")
    bm25_dir = persist / "bm25_index" / dataset
    bm25_dir.mkdir(parents=True, exist_ok=True)
    load_from_chroma_and_save(documents, str(bm25_dir))
    bm25_count = BM25Retriever(str(bm25_dir), allow_missing_index=False).doc_len if documents else 0
    if bm25_count != text_count:
        raise RuntimeError(f"BM25 count mismatch for {dataset}: {bm25_count} != {text_count}")

    _reset_manager()
    return {
        "dataset": dataset, "sqlite_chunks": expected_total,
        "text_chunks": text_count, "table_chunks": table_count,
        "bm25_chunks": bm25_count, **sync_result,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=str(FINSAGENT_ROOT / "config" / "production.yaml"))
    parser.add_argument("--datasets", nargs="+", required=True)
    parser.add_argument("--replace", action="store_true")
    args = parser.parse_args()
    with open(args.config, encoding="utf-8") as handle:
        config = yaml.safe_load(handle)
    for dataset in args.datasets:
        print(rebuild(config, dataset, args.replace), flush=True)


if __name__ == "__main__":
    main()
