"""Read-only validation for a published private-fund retrieval index bundle.

This module deliberately uses Chroma's ``get_collection`` API.  The regular
LangChain Chroma constructor has get-or-create semantics and can turn a typo or
missing mount into a valid-looking, empty database.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


MANIFEST_NAME = "index_manifest.json"
MANIFEST_SCHEMA_VERSION = 1


class IndexNotReadyError(RuntimeError):
    """Raised when a retrieval bundle is absent, stale, or incomplete."""


@dataclass
class IndexReadinessReport:
    ready: bool
    persist_directory: str
    collection_name: str
    counts: dict[str, int] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    manifest: dict[str, Any] | None = None

    def require_ready(self) -> "IndexReadinessReport":
        if not self.ready:
            details = "; ".join(self.errors) or "unknown validation failure"
            raise IndexNotReadyError(
                f"retrieval index is not ready for {self.collection_name!r} at "
                f"{self.persist_directory}: {details}"
            )
        return self


def source_fingerprint(sqlite_path: str | Path, dataset_id: str) -> str:
    """Fingerprint active canonical inputs without hashing the whole SQLite file."""
    path = Path(sqlite_path).resolve()
    if not path.is_file():
        raise FileNotFoundError(path)
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        conn.row_factory = sqlite3.Row
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        required = {"documents", "chunks"}
        missing = sorted(required - tables)
        if missing:
            raise RuntimeError(f"canonical database is missing tables: {', '.join(missing)}")

        documents = [
            tuple(row)
            for row in conn.execute(
                """
                SELECT doc_id, checksum, chunk_count, status, lifecycle_state
                FROM documents
                WHERE dataset_id=? AND status='indexed' AND lifecycle_state='active'
                ORDER BY doc_id
                """,
                (dataset_id,),
            )
        ]
        counts: dict[str, int] = {}
        for table in ("chunks", "excel_cells", "metric_facts"):
            if table not in tables:
                counts[table] = 0
                continue
            counts[table] = int(
                conn.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE dataset_id=?", (dataset_id,)
                ).fetchone()[0]
            )
    finally:
        conn.close()
    payload = {
        "schema": MANIFEST_SCHEMA_VERSION,
        "dataset_id": dataset_id,
        "documents": documents,
        "counts": counts,
    }
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
    ).hexdigest()


def _collection_count(directory: Path, collection_name: str) -> int:
    if not (directory / "chroma.sqlite3").is_file():
        raise FileNotFoundError(directory / "chroma.sqlite3")
    import chromadb

    client = chromadb.PersistentClient(path=str(directory))
    # get_collection is essential: unlike get_or_create_collection it cannot
    # manufacture an empty index while merely checking readiness.
    return int(client.get_collection(collection_name).count())


def _bm25_count(directory: Path) -> int:
    params = directory / "params.index.json"
    corpus = directory / "corpus.jsonl"
    if not params.is_file() or not corpus.is_file():
        missing = [str(p.name) for p in (params, corpus) if not p.is_file()]
        raise FileNotFoundError(f"BM25 files missing: {', '.join(missing)}")
    with corpus.open("rb") as stream:
        return sum(1 for line in stream if line.strip())


def read_manifest(persist_directory: str | Path) -> dict[str, Any]:
    path = Path(persist_directory).resolve() / MANIFEST_NAME
    if not path.is_file():
        raise FileNotFoundError(path)
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("index manifest must be a JSON object")
    return value


def validate_index_bundle(
    persist_directory: str | Path,
    collection_name: str,
    *,
    source_db: str | Path | None = None,
    require_manifest: bool = True,
) -> IndexReadinessReport:
    """Validate every retrieval component without creating or mutating it."""
    persist = Path(persist_directory).resolve()
    report = IndexReadinessReport(False, str(persist), collection_name)
    manifest: dict[str, Any] | None = None
    try:
        manifest = read_manifest(persist)
        report.manifest = manifest
    except Exception as exc:
        if require_manifest:
            report.errors.append(f"manifest: {exc}")

    if manifest:
        if manifest.get("schema_version") != MANIFEST_SCHEMA_VERSION:
            report.errors.append(
                f"unsupported manifest schema_version={manifest.get('schema_version')!r}"
            )
        if manifest.get("status") != "ready":
            report.errors.append(f"manifest status is {manifest.get('status')!r}, not 'ready'")
        if manifest.get("dataset_id") != collection_name:
            report.errors.append(
                f"manifest dataset_id={manifest.get('dataset_id')!r} does not match "
                f"collection {collection_name!r}"
            )

    component_paths = {
        "main": persist / "chroma",
        "table": persist / "table_chroma",
        "title": persist / "ts_chroma",
    }
    for component, directory in component_paths.items():
        try:
            report.counts[component] = _collection_count(directory, collection_name)
        except Exception as exc:
            report.counts[component] = 0
            report.errors.append(f"{component}: {exc}")
    try:
        report.counts["bm25"] = _bm25_count(persist / "bm25_index" / collection_name)
    except Exception as exc:
        report.counts["bm25"] = 0
        report.errors.append(f"bm25: {exc}")

    for component, count in report.counts.items():
        if count <= 0:
            report.errors.append(f"{component} index is empty")

    if manifest:
        expected = manifest.get("counts") or {}
        for component, actual in report.counts.items():
            if component not in expected:
                report.errors.append(f"manifest has no count for {component}")
            elif int(expected[component]) != actual:
                report.errors.append(
                    f"{component} count mismatch: actual={actual}, manifest={expected[component]}"
                )
        if source_db is not None:
            try:
                actual_fingerprint = source_fingerprint(source_db, collection_name)
                if manifest.get("source_fingerprint") != actual_fingerprint:
                    report.errors.append("canonical SQLite changed after indexes were built")
            except Exception as exc:
                report.errors.append(f"source fingerprint: {exc}")

    report.errors = list(dict.fromkeys(report.errors))
    report.ready = not report.errors
    return report
