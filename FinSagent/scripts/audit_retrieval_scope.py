#!/usr/bin/env python3
"""Audit SQLite/Chroma document boundaries without modifying either store."""
from __future__ import annotations

import argparse
import json
import sqlite3
from collections import Counter
from pathlib import Path
from typing import Any


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})")}


def _active_document_sql(columns: set[str]) -> str:
    clauses = []
    if "is_current" in columns:
        clauses.append("is_current = 1")
    if "lifecycle_state" in columns:
        clauses.append("lifecycle_state = 'active'")
    if "deleted_at" in columns:
        clauses.append("deleted_at IS NULL")
    if "status" in columns:
        clauses.append("status = 'indexed'")
    return " WHERE " + " AND ".join(clauses) if clauses else ""


def audit_sqlite(collection_db: Path) -> dict[str, Any]:
    conn = sqlite3.connect(f"file:{collection_db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        document_columns = _columns(conn, "documents")
        rows = conn.execute(
            "SELECT * FROM documents" + _active_document_sql(document_columns)
        ).fetchall()
        documents = [dict(row) for row in rows]
        doc_ids = {str(row.get("doc_id") or "") for row in documents}
        doc_ids.discard("")
        dataset_ids = {str(row.get("dataset_id") or "") for row in documents}
        dataset_ids.discard("")

        table_counts: dict[str, int] = {}
        orphan_doc_ids: dict[str, list[str]] = {}
        for table in ("chunks", "metric_facts"):
            if not _columns(conn, table):
                continue
            table_counts[table] = int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            referenced = {
                str(row[0])
                for row in conn.execute(f"SELECT DISTINCT doc_id FROM {table}")
                if row[0]
            }
            orphan_doc_ids[table] = sorted(referenced - doc_ids)

        chunk_rows = conn.execute(
            "SELECT chunk_id, doc_id, dataset_id, content_type FROM chunks"
        ).fetchall()
        chunk_ids = {str(row["chunk_id"]) for row in chunk_rows}
        expected_main_ids = {
            str(row["chunk_id"])
            for row in chunk_rows
            if str(row["content_type"] or "") == "excel_workbook_summary"
        }
        expected_table_ids = chunk_ids - expected_main_ids
        companies = Counter(
            str(row.get("company_name") or row.get("company_ticker") or "<unknown>")
            for row in documents
        )
        mismatched_dataset_rows = sum(
            1
            for row in chunk_rows
            if dataset_ids and str(row["dataset_id"] or "") not in dataset_ids
        )
        return {
            "document_ids": sorted(doc_ids),
            "dataset_ids": sorted(dataset_ids),
            "companies": dict(sorted(companies.items())),
            "table_counts": table_counts,
            "orphan_doc_ids": orphan_doc_ids,
            "mismatched_chunk_dataset_rows": mismatched_dataset_rows,
            "chunk_ids": chunk_ids,
            "expected_main_ids": expected_main_ids,
            "expected_table_ids": expected_table_ids,
        }
    finally:
        conn.close()


def audit_chroma(
    persist_directory: Path,
    collection_name: str,
    sqlite_report: dict[str, Any],
) -> tuple[dict[str, Any], list[str], list[str]]:
    import chromadb

    allowed_doc_ids = set(sqlite_report["document_ids"])
    allowed_dataset_ids = set(sqlite_report["dataset_ids"])
    components: dict[str, Any] = {}
    errors: list[str] = []
    warnings: list[str] = []

    for component in ("chroma", "ts_chroma", "table_chroma"):
        path = persist_directory / component
        try:
            collection = chromadb.PersistentClient(path=str(path)).get_collection(collection_name)
        except Exception as exc:
            errors.append(f"{component}: collection unavailable: {exc}")
            continue

        payload = collection.get(include=["metadatas"])
        ids = [str(value) for value in payload.get("ids") or []]
        metadatas = payload.get("metadatas") or []
        source_ids = [str((metadata or {}).get("source_doc_id") or "") for metadata in metadatas]
        dataset_ids = [str((metadata or {}).get("dataset_id") or "") for metadata in metadatas]
        missing_source = sum(not value for value in source_ids)
        missing_dataset = sum(not value for value in dataset_ids)
        foreign_source_ids = sorted({value for value in source_ids if value and value not in allowed_doc_ids})
        foreign_dataset_ids = sorted({value for value in dataset_ids if value and value not in allowed_dataset_ids})

        if missing_source:
            errors.append(f"{component}: {missing_source} records lack source_doc_id")
        if foreign_source_ids:
            errors.append(f"{component}: foreign source_doc_ids={foreign_source_ids}")
        if missing_dataset:
            warnings.append(f"{component}: {missing_dataset} records lack dataset_id metadata")
        if foreign_dataset_ids:
            errors.append(f"{component}: foreign dataset_ids={foreign_dataset_ids}")

        vector_ids = set(ids)
        if component == "chroma":
            expected_ids = set(sqlite_report["expected_main_ids"])
        elif component == "table_chroma":
            expected_ids = set(sqlite_report["expected_table_ids"])
        else:
            expected_ids = set()

        missing_vector_ids = sorted(expected_ids - vector_ids)
        extra_vector_ids = sorted(vector_ids - expected_ids) if component != "ts_chroma" else []
        if missing_vector_ids:
            errors.append(f"{component}: {len(missing_vector_ids)} SQLite chunks are missing")
        if extra_vector_ids:
            errors.append(f"{component}: {len(extra_vector_ids)} vector ids are absent from SQLite")

        components[component] = {
            "count": collection.count(),
            "source_doc_counts": dict(sorted(Counter(source_ids).items())),
            "missing_source_doc_id": missing_source,
            "missing_dataset_id": missing_dataset,
            "foreign_source_doc_ids": foreign_source_ids,
            "foreign_dataset_ids": foreign_dataset_ids,
            "missing_vector_id_count": len(missing_vector_ids),
            "extra_vector_id_count": len(extra_vector_ids),
        }

    return components, errors, warnings


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collection-db", required=True, type=Path)
    parser.add_argument("--persist-directory", required=True, type=Path)
    parser.add_argument("--collection-name", required=True)
    parser.add_argument("--strict-metadata", action="store_true")
    args = parser.parse_args()

    sqlite_report = audit_sqlite(args.collection_db)
    components, errors, warnings = audit_chroma(
        args.persist_directory,
        args.collection_name,
        sqlite_report,
    )
    for table, orphan_ids in sqlite_report["orphan_doc_ids"].items():
        if orphan_ids:
            errors.append(f"sqlite {table}: orphan doc_ids={orphan_ids}")
    if sqlite_report["mismatched_chunk_dataset_rows"]:
        errors.append(
            "sqlite chunks: "
            f"{sqlite_report['mismatched_chunk_dataset_rows']} rows have an unexpected dataset_id"
        )

    report = {
        "status": "failed" if errors or (args.strict_metadata and warnings) else "passed",
        "sqlite": {
            key: value
            for key, value in sqlite_report.items()
            if key not in {"chunk_ids", "expected_main_ids", "expected_table_ids"}
        },
        "chroma": components,
        "errors": errors,
        "warnings": warnings,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    if errors or (args.strict_metadata and warnings):
        raise SystemExit(2)


if __name__ == "__main__":
    main()
