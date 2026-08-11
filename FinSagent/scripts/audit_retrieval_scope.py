#!/usr/bin/env python3
"""Audit SQLite/Chroma document boundaries without modifying either store."""
from __future__ import annotations

import argparse
import json
import sqlite3
import unicodedata
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


def _normalize(value: Any) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).casefold().strip()


def _metadata_company_mismatch(
    metadata: dict[str, Any], authoritative: dict[str, dict[str, str]]
) -> str:
    source_doc_id = str(metadata.get("source_doc_id") or "")
    expected = authoritative.get(source_doc_id)
    if not expected:
        return ""
    actual_company = str(metadata.get("company_name") or metadata.get("company") or "")
    expected_company = str(expected.get("company_name") or "")
    if expected_company and _normalize(actual_company) != _normalize(expected_company):
        return f"{source_doc_id}: company={actual_company!r} expected={expected_company!r}"
    actual_ticker = str(metadata.get("ticker") or metadata.get("company_ticker") or "")
    expected_ticker = str(expected.get("company_ticker") or "")
    if expected_ticker and _normalize(actual_ticker) != _normalize(expected_ticker):
        return f"{source_doc_id}: ticker={actual_ticker!r} expected={expected_ticker!r}"
    return ""


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
        expected_main_ids = chunk_ids
        expected_table_ids = {
            str(row["chunk_id"])
            for row in chunk_rows
            if str(row["content_type"] or "") in {
                "excel_region_summary", "excel_sheet_summary", "excel_workbook_summary"
            }
        }
        companies = Counter(
            str(row.get("company_name") or row.get("company_ticker") or "<unknown>")
            for row in documents
        )
        mismatched_dataset_rows = sum(
            1
            for row in chunk_rows
            if dataset_ids and str(row["dataset_id"] or "") not in dataset_ids
        )
        duplicate_chunk_hashes = []
        if "content_hash" in _columns(conn, "chunks"):
            duplicate_chunk_hashes = [
                {
                    "content_hash": str(row[0]),
                    "document_count": int(row[1]),
                    "chunk_count": int(row[2]),
                    "doc_ids": str(row[3] or "").split(","),
                }
                for row in conn.execute(
                    """
                    SELECT content_hash, COUNT(DISTINCT doc_id), COUNT(*),
                           GROUP_CONCAT(DISTINCT doc_id)
                    FROM chunks
                    WHERE COALESCE(content_hash, '') <> ''
                    GROUP BY content_hash
                    HAVING COUNT(DISTINCT doc_id) > 1
                    ORDER BY COUNT(DISTINCT doc_id) DESC, content_hash
                    """
                )
            ]
        duplicate_documents: dict[str, list[dict[str, Any]]] = {}
        for field in ("checksum", "logical_doc_id", "original_filename"):
            if field not in document_columns:
                continue
            groups: dict[str, list[str]] = {}
            for row in documents:
                value = str(row.get(field) or "").strip()
                if value:
                    groups.setdefault(value, []).append(str(row.get("doc_id") or ""))
            duplicate_documents[field] = [
                {"value": value, "doc_ids": sorted(ids), "document_count": len(ids)}
                for value, ids in sorted(groups.items())
                if len(ids) > 1
            ]
        return {
            "document_ids": sorted(doc_ids),
            "dataset_ids": sorted(dataset_ids),
            "companies": dict(sorted(companies.items())),
            "table_counts": table_counts,
            "orphan_doc_ids": orphan_doc_ids,
            "mismatched_chunk_dataset_rows": mismatched_dataset_rows,
            "cross_document_duplicate_content_hashes": duplicate_chunk_hashes,
            "duplicate_documents": duplicate_documents,
            "document_metadata": {
                str(row.get("doc_id")): {
                    "dataset_id": str(row.get("dataset_id") or ""),
                    "company_name": str(row.get("company_name") or ""),
                    "company_ticker": str(row.get("company_ticker") or ""),
                }
                for row in documents
                if row.get("doc_id")
            },
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
    authoritative = sqlite_report["document_metadata"]
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
        company_mismatches = sorted(
            mismatch
            for metadata in metadatas
            if (mismatch := _metadata_company_mismatch(metadata or {}, authoritative))
        )

        if missing_source:
            errors.append(f"{component}: {missing_source} records lack source_doc_id")
        if foreign_source_ids:
            errors.append(f"{component}: foreign source_doc_ids={foreign_source_ids}")
        if missing_dataset:
            warnings.append(f"{component}: {missing_dataset} records lack dataset_id metadata")
        if foreign_dataset_ids:
            errors.append(f"{component}: foreign dataset_ids={foreign_dataset_ids}")
        if company_mismatches:
            errors.append(f"{component}: company/ticker metadata mismatches={company_mismatches}")

        vector_ids = set(ids)
        metadata_by_id = {
            vector_id: (metadata or {})
            for vector_id, metadata in zip(ids, metadatas)
        }
        if component == "chroma":
            expected_ids = set(sqlite_report["expected_main_ids"])
        elif component == "table_chroma":
            expected_ids = set(sqlite_report["expected_table_ids"])
        else:
            expected_ids = set()

        missing_vector_ids = sorted(expected_ids - vector_ids)
        allowed_derived_types = {
            "chroma": {"table"},
            "table_chroma": {"table"},
            "ts_chroma": {"document_title"},
        }[component]
        derived_vector_ids = {
            vector_id
            for vector_id in vector_ids - expected_ids
            if str(metadata_by_id.get(vector_id, {}).get("content_type") or "")
            in allowed_derived_types
        }
        extra_vector_ids = sorted(vector_ids - expected_ids - derived_vector_ids)
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
            "company_metadata_mismatches": company_mismatches,
            "missing_vector_id_count": len(missing_vector_ids),
            "extra_vector_id_count": len(extra_vector_ids),
            "derived_vector_id_count": len(derived_vector_ids),
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
    if sqlite_report["cross_document_duplicate_content_hashes"]:
        errors.append(
            "sqlite chunks: "
            f"{len(sqlite_report['cross_document_duplicate_content_hashes'])} content hashes "
            "occur across multiple companies/documents"
        )
    duplicate_document_groups = sum(
        len(groups) for groups in sqlite_report["duplicate_documents"].values()
    )
    if duplicate_document_groups:
        errors.append(
            f"sqlite documents: {duplicate_document_groups} duplicate active-document groups"
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
