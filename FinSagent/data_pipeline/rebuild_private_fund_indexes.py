#!/usr/bin/env python3
"""Build Chroma, table Chroma, title-summary Chroma and BM25 from collection.sqlite3.

The private-fund directory ingester deliberately stops after writing canonical
SQLite chunks/cells.  This command performs the missing retrieval-index sync.
It builds into a sibling staging directory and only swaps it into place after
all index invariants pass.
"""

from __future__ import annotations

import argparse
import fcntl
import gc
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import time
import uuid
from collections import defaultdict
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import yaml
from langchain_chroma import Chroma
from langchain_core.documents import Document


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from utils.index_readiness import (  # noqa: E402
    MANIFEST_NAME,
    MANIFEST_SCHEMA_VERSION,
    source_fingerprint,
    validate_index_bundle,
)


TABLE_CONTENT_TYPES = {
    "excel_region_summary",
    "excel_sheet_summary",
    "excel_workbook_summary",
}
BUILDER_VERSION = "private-fund-index-bundle-v2"


def _scalar(value: Any) -> str | int | float | bool:
    if value is None:
        return ""
    if isinstance(value, (str, int, float, bool)):
        return value
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _metadata(row: sqlite3.Row, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    raw = json.loads(row["metadata_json"] or "{}")
    values = {
        **raw,
        "doc_id": row["chunk_id"],
        "chunk_id": row["chunk_id"],
        "source_doc_id": row["doc_id"],
        "dataset_id": row["dataset_id"],
        "filename": row["original_filename"],
        "source_ref": row["source_ref"] or row["original_filename"],
        "content_type": row["content_type"],
        "date_published": row["document_date"] or "",
        "company_name": row["company_name"] or "",
        "company_ticker": row["company_ticker"] or "",
        "prev_chunk_id": row["prev_chunk_id"] or "",
        "next_chunk_id": row["next_chunk_id"] or "",
        "global_id": int(row["global_id"]),
    }
    if extra:
        values.update(extra)
    return {str(key): _scalar(value) for key, value in values.items()}


def _batched(rows: list[Any], size: int) -> Iterable[list[Any]]:
    for index in range(0, len(rows), size):
        yield rows[index : index + size]


def _canonical_documents(conn: sqlite3.Connection) -> list[Document]:
    sql = """
        SELECT c.*, d.original_filename, d.document_date, d.company_name,
               d.company_ticker,
               ROW_NUMBER() OVER (ORDER BY d.original_filename, c.chunk_index) - 1 AS global_id
        FROM chunks c
        JOIN documents d ON d.doc_id = c.doc_id
        WHERE d.status = 'indexed' AND d.lifecycle_state = 'active'
        ORDER BY d.original_filename, c.chunk_index
    """
    return [
        Document(page_content=row["content"], metadata=_metadata(row))
        for row in conn.execute(sql)
        if str(row["content"] or "").strip()
    ]


def _table_row_documents(conn: sqlite3.Connection, dataset_id: str) -> list[Document]:
    sql = """
        SELECT ec.*, d.original_filename, d.document_date, d.company_name,
               d.company_ticker
        FROM excel_cells ec
        JOIN documents d ON d.doc_id = ec.doc_id
        WHERE d.status = 'indexed' AND d.lifecycle_state = 'active'
          AND COALESCE(ec.display_value, ec.raw_value, ec.cached_value, '') <> ''
        ORDER BY d.original_filename, ec.sheet_name, ec.row_index, ec.col_index
    """
    groups: dict[tuple[str, str, int], list[sqlite3.Row]] = defaultdict(list)
    for row in conn.execute(sql):
        groups[(row["doc_id"], row["sheet_name"], int(row["row_index"]))].append(row)

    documents: list[Document] = []
    for (source_doc_id, sheet_name, row_index), cells in groups.items():
        # vLLM enforces the model context on every input.  A fixed cell count is
        # insufficient because formulas vary from a few bytes to hundreds of
        # bytes, so split on both cell count and a conservative character cap.
        row_label = next((str(c["row_label"]) for c in cells if c["row_label"]), "")
        header = [
            f"Excel table row: {cells[0]['original_filename']} | {sheet_name} | row {row_index}",
            f"Row label: {row_label}" if row_label else "Row label: (not supplied)",
        ]
        encoded_cells: list[tuple[sqlite3.Row, str]] = []
        for cell in cells:
            value = cell["display_value"] or cell["cached_value"] or cell["raw_value"] or ""
            descriptors = [f"cell={cell['cell_ref']}", f"value={value}"]
            for key, label in (("col_label", "column"), ("period", "period"), ("unit", "unit")):
                if cell[key]:
                    descriptors.append(f"{label}={cell[key]}")
            if cell["formula"]:
                descriptors.append(f"formula={cell['formula']}")
            encoded_cells.append((cell, " | ".join(descriptors)))

        parts: list[list[tuple[sqlite3.Row, str]]] = []
        current: list[tuple[sqlite3.Row, str]] = []
        current_chars = sum(len(line) + 1 for line in header)
        for item in encoded_cells:
            line_chars = len(item[1]) + 1
            if current and (len(current) >= 28 or current_chars + line_chars > 6000):
                parts.append(current)
                current = []
                current_chars = sum(len(line) + 1 for line in header)
            current.append(item)
            current_chars += line_chars
        if current:
            parts.append(current)

        for part_no, encoded_part in enumerate(parts, start=1):
            part = [item[0] for item in encoded_part]
            first = part[0]
            lines = [*header, *(item[1] for item in encoded_part)]
            content = "\n".join(lines)
            chunk_id = hashlib.sha256(
                f"{dataset_id}\0{source_doc_id}\0{sheet_name}\0{row_index}\0{part_no}\0{content}".encode()
            ).hexdigest()
            documents.append(
                Document(
                    page_content=content,
                    metadata={
                        "doc_id": chunk_id,
                        "chunk_id": chunk_id,
                        "source_doc_id": source_doc_id,
                        "dataset_id": dataset_id,
                        "filename": first["original_filename"],
                        "source_ref": f"{first['original_filename']} {sheet_name}!row {row_index}",
                        "content_type": "table",
                        "sheet_name": sheet_name,
                        "row_index": row_index,
                        "row_label": row_label,
                        "cell_range": f"{part[0]['cell_ref']}:{part[-1]['cell_ref']}",
                        "date_published": first["document_date"] or "",
                        "company_name": first["company_name"] or "",
                        "company_ticker": first["company_ticker"] or "",
                        "global_id": len(documents),
                    },
                )
            )
    return documents


def _title_documents(conn: sqlite3.Connection, dataset_id: str) -> list[Document]:
    documents: list[Document] = []
    for row in conn.execute(
        """
        SELECT doc_id, original_filename, title, doc_type, doc_subtype,
               company_name, company_ticker, document_date
        FROM documents
        WHERE status='indexed' AND lifecycle_state='active'
        ORDER BY original_filename
        """
    ):
        content = " | ".join(
            str(value) for value in (
                row["title"], row["original_filename"], row["company_name"],
                row["company_ticker"], row["doc_type"], row["doc_subtype"],
                row["document_date"],
            ) if value
        )
        chunk_id = hashlib.sha256(f"title\0{dataset_id}\0{row['doc_id']}".encode()).hexdigest()
        documents.append(Document(page_content=content, metadata={
            "doc_id": chunk_id,
            "chunk_id": chunk_id,
            "source_doc_id": row["doc_id"],
            "dataset_id": dataset_id,
            "filename": row["original_filename"],
            "content_type": "document_title",
            "date_published": row["document_date"] or "",
            "company_name": row["company_name"] or "",
            "company_ticker": row["company_ticker"] or "",
        }))
    return documents


def _add(collection: Chroma, documents: list[Document], batch_size: int) -> None:
    for batch in _batched(documents, batch_size):
        collection.add_texts(
            texts=[doc.page_content for doc in batch],
            metadatas=[doc.metadata for doc in batch],
            ids=[str(doc.metadata["doc_id"]) for doc in batch],
        )


def _count(path: Path, collection: str) -> int:
    db = sqlite3.connect(path / "chroma.sqlite3")
    try:
        value = db.execute(
            """
            SELECT COUNT(*) FROM embeddings e
            JOIN segments s ON s.id=e.segment_id
            JOIN collections c ON c.id=s.collection
            WHERE c.name=?
            """,
            (collection,),
        ).fetchone()[0]
    finally:
        db.close()
    return int(value)


def _register(conn: sqlite3.Connection, dataset_id: str, index_type: str,
              path: str, count: int) -> None:
    now = datetime.now(timezone.utc).isoformat()
    index_id = hashlib.sha256(f"{dataset_id}\0{index_type}".encode()).hexdigest()[:40]
    conn.execute(
        """
        INSERT OR REPLACE INTO index_registry (
          index_id,dataset_id,index_type,collection_name,index_path,
          source_doc_ids_json,source_chunk_count,status,built_at,error_message,metadata_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        """,
        (index_id, dataset_id, index_type, dataset_id, path, "[]", count,
         "ready", now, None, json.dumps({"builder": Path(__file__).name}, ensure_ascii=False)),
    )


@contextmanager
def _build_lock(dataset_root: Path, timeout_seconds: float):
    lock_path = dataset_root / ".index-build.lock"
    lock_path.touch(exist_ok=True)
    stream = lock_path.open("r+")
    deadline = time.monotonic() + timeout_seconds
    try:
        while True:
            try:
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"another index build holds {lock_path}")
                time.sleep(0.2)
        yield
    finally:
        fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        stream.close()


def _write_manifest(
    stage_path: Path,
    dataset_id: str,
    sqlite_path: Path,
    fingerprint: str,
    counts: dict[str, int],
) -> dict[str, Any]:
    manifest = {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "builder_version": BUILDER_VERSION,
        "status": "ready",
        "dataset_id": dataset_id,
        "collection_name": dataset_id,
        "source_database": str(sqlite_path),
        "source_fingerprint": fingerprint,
        "built_at": datetime.now(timezone.utc).isoformat(),
        "counts": counts,
        "components": {
            "main": {"path": "chroma", "collection": dataset_id},
            "table": {"path": "table_chroma", "collection": dataset_id},
            "title": {"path": "ts_chroma", "collection": dataset_id},
            "bm25": {"path": f"bm25_index/{dataset_id}"},
        },
    }
    temporary = stage_path / f".{MANIFEST_NAME}.tmp"
    temporary.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    os.replace(temporary, stage_path / MANIFEST_NAME)
    return manifest


def _publish(stage_path: Path, final_path: Path) -> Path | None:
    """Publish a validated directory, restoring the old one on swap failure."""
    backup_path = None
    if final_path.exists() or final_path.is_symlink():
        backup_path = final_path.with_name(
            f"{final_path.name}.backup-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-"
            f"{uuid.uuid4().hex[:8]}"
        )
        os.replace(final_path, backup_path)
    try:
        os.replace(stage_path, final_path)
    except Exception:
        if backup_path is not None and not final_path.exists():
            os.replace(backup_path, final_path)
        raise
    return backup_path


def _restore_publish(final_path: Path, backup_path: Path | None) -> None:
    failed_path = final_path.with_name(f"{final_path.name}.failed-{uuid.uuid4().hex[:8]}")
    if final_path.exists():
        os.replace(final_path, failed_path)
    if backup_path is not None and backup_path.exists():
        os.replace(backup_path, final_path)
    shutil.rmtree(failed_path, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-root", required=True)
    parser.add_argument("--config", default=str(PROJECT_ROOT / "config" / "production.yaml"))
    parser.add_argument("--batch-size", type=int, default=24)
    parser.add_argument("--keep-backup", action="store_true")
    parser.add_argument("--force", action="store_true", help="rebuild even when the bundle is current")
    parser.add_argument("--check-only", action="store_true", help="validate only; never build")
    parser.add_argument("--lock-timeout", type=float, default=30.0)
    args = parser.parse_args()

    dataset_root = Path(args.dataset_root).resolve()
    dataset_id = dataset_root.name
    sqlite_path = dataset_root / "meta" / "collection.sqlite3"
    final_path = dataset_root / "vector_store"
    if not sqlite_path.is_file():
        raise FileNotFoundError(sqlite_path)

    with _build_lock(dataset_root, args.lock_timeout):
        fingerprint = source_fingerprint(sqlite_path, dataset_id)
        current = validate_index_bundle(
            final_path, dataset_id, source_db=sqlite_path, require_manifest=True
        )
        if current.ready and (current.manifest or {}).get("builder_version") != BUILDER_VERSION:
            current.ready = False
            current.errors.append(
                f"builder version changed: current={(current.manifest or {}).get('builder_version')!r}, "
                f"required={BUILDER_VERSION!r}"
            )
        if current.ready and not args.force:
            print(json.dumps({
                "status": "reused",
                "dataset_id": dataset_id,
                "source_fingerprint": fingerprint,
                "vector_store": str(final_path),
                "counts": current.counts,
            }, ensure_ascii=False, indent=2))
            return
        if args.check_only:
            print(json.dumps({
                "status": "not_ready",
                "dataset_id": dataset_id,
                "vector_store": str(final_path),
                "counts": current.counts,
                "errors": current.errors,
            }, ensure_ascii=False, indent=2))
            raise SystemExit(2)

        stage_path = dataset_root / f"vector_store.build-{os.getpid()}-{uuid.uuid4().hex[:8]}"
        stage_path.mkdir(parents=True)
        try:
            _build_and_publish(
                args=args,
                dataset_root=dataset_root,
                dataset_id=dataset_id,
                sqlite_path=sqlite_path,
                final_path=final_path,
                stage_path=stage_path,
                fingerprint=fingerprint,
            )
        finally:
            if stage_path.exists():
                shutil.rmtree(stage_path, ignore_errors=True)


def _build_and_publish(
    *,
    args: argparse.Namespace,
    dataset_root: Path,
    dataset_id: str,
    sqlite_path: Path,
    final_path: Path,
    stage_path: Path,
    fingerprint: str,
) -> None:

    # Keep validation/check-only startup cheap; these imports initialize the
    # embedding/BM25 stacks and are needed only for a real rebuild.
    from utils.bm25Retriever import load_from_chroma_and_save
    from utils.vllm_embeddings import VLLMEmbeddings

    config = yaml.safe_load(Path(args.config).read_text(encoding="utf-8"))
    embeddings = VLLMEmbeddings(
        endpoint_url=config.get("embedding_vllm_url", "http://127.0.0.1:5433/v1/embeddings"),
        model_name=config["embeddings_model_name"],
        timeout_seconds=float(config.get("embedding_timeout_seconds", 60)),
        batch_size=int(config.get("embedding_batch_size", 32)),
    )
    conn = sqlite3.connect(sqlite_path)
    conn.row_factory = sqlite3.Row
    canonical = _canonical_documents(conn)
    table_rows = _table_row_documents(conn, dataset_id)
    table_summaries = [doc for doc in canonical if doc.metadata["content_type"] in TABLE_CONTENT_TYPES]
    table_documents = [*table_summaries, *table_rows]
    main_documents = [*canonical, *table_rows]
    title_documents = _title_documents(conn, dataset_id)

    chroma = Chroma(collection_name=dataset_id, embedding_function=embeddings,
                    persist_directory=str(stage_path / "chroma"), relevance_score_fn="cosine")
    table_chroma = Chroma(collection_name=dataset_id, embedding_function=embeddings,
                          persist_directory=str(stage_path / "table_chroma"), relevance_score_fn="cosine")
    ts_chroma = Chroma(collection_name=dataset_id, embedding_function=embeddings,
                       persist_directory=str(stage_path / "ts_chroma"), relevance_score_fn="cosine")
    _add(chroma, main_documents, args.batch_size)
    _add(table_chroma, table_documents, args.batch_size)
    _add(ts_chroma, title_documents, args.batch_size)
    bm25_path = stage_path / "bm25_index" / dataset_id
    load_from_chroma_and_save(main_documents, str(bm25_path))

    counts = {
        "main": _count(stage_path / "chroma", dataset_id),
        "table": _count(stage_path / "table_chroma", dataset_id),
        "title": _count(stage_path / "ts_chroma", dataset_id),
        "bm25": len(main_documents) if (bm25_path / "params.index.json").is_file() else 0,
    }
    expected = {
        "main": len(main_documents), "table": len(table_documents),
        "title": len(title_documents), "bm25": len(main_documents),
    }
    if counts != expected or any(value <= 0 for value in counts.values()):
        raise RuntimeError(f"index invariant failed: counts={counts} expected={expected}")
    _write_manifest(stage_path, dataset_id, sqlite_path, fingerprint, counts)
    staged_report = validate_index_bundle(
        stage_path, dataset_id, source_db=sqlite_path, require_manifest=True
    )
    staged_report.require_ready()

    # Close Chroma handles before renaming their directory on Linux.
    del chroma, table_chroma, ts_chroma
    gc.collect()
    backup_path = _publish(stage_path, final_path)
    try:
        for index_type, count in counts.items():
            rel = f"vector_store/{'bm25_index/' + dataset_id if index_type == 'bm25' else index_type}"
            _register(conn, dataset_id, f"retrieval_{index_type}", rel, count)
        columns = {row[1] for row in conn.execute("PRAGMA table_info(chunks)")}
        if "chroma_synced_at" not in columns:
            conn.execute("ALTER TABLE chunks ADD COLUMN chroma_synced_at TEXT")
        conn.execute("UPDATE chunks SET chroma_synced_at=?", (datetime.now(timezone.utc).isoformat(),))
        conn.commit()
    except Exception:
        conn.rollback()
        _restore_publish(final_path, backup_path)
        raise
    finally:
        conn.close()
    if not args.keep_backup and backup_path is not None and backup_path.exists():
        shutil.rmtree(backup_path)
    print(json.dumps({
        "status": "rebuilt",
        "dataset_id": dataset_id,
        "sqlite_path": str(sqlite_path),
        "vector_store": str(final_path),
        "canonical_chunks": len(canonical),
        "table_row_chunks": len(table_rows),
        "counts": counts,
        "expected": expected,
        "source_fingerprint": fingerprint,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
