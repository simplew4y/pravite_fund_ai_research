#!/usr/bin/env python3
"""Prepare a checksum-verified, allowlisted source directory for clean ingest.

The command is dry-run by default.  ``--execute`` only copies approved source
files into a new staging directory; it never mutates the current SQLite,
Chroma, raw directory, or production configuration.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sqlite3
import unicodedata
from pathlib import Path
from typing import Any


def _normalize(value: Any) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).casefold().strip()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _load_documents(collection_db: Path) -> list[dict[str, Any]]:
    conn = sqlite3.connect(f"file:{collection_db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        return [
            dict(row)
            for row in conn.execute(
                """
                SELECT doc_id, dataset_id, company_name, company_ticker,
                       original_filename, stored_path, checksum, file_size
                FROM documents
                WHERE is_current = 1 AND lifecycle_state = 'active'
                  AND deleted_at IS NULL AND status = 'indexed'
                ORDER BY company_name, original_filename
                """
            )
        ]
    finally:
        conn.close()


def _selected(row: dict[str, Any], args: argparse.Namespace) -> bool:
    doc_ids = set(args.allow_doc_id)
    companies = {_normalize(value) for value in args.allow_company}
    tickers = {_normalize(value) for value in args.allow_ticker}
    return bool(
        str(row.get("doc_id") or "") in doc_ids
        or _normalize(row.get("company_name")) in companies
        or _normalize(row.get("company_ticker")) in tickers
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collection-db", required=True, type=Path)
    parser.add_argument("--allow-doc-id", action="append", default=[])
    parser.add_argument("--allow-company", action="append", default=[])
    parser.add_argument("--allow-ticker", action="append", default=[])
    parser.add_argument("--staging-source", type=Path)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()

    if not (args.allow_doc_id or args.allow_company or args.allow_ticker):
        parser.error("at least one explicit --allow-doc-id/--allow-company/--allow-ticker is required")
    if args.execute and args.staging_source is None:
        parser.error("--staging-source is required with --execute")

    documents = _load_documents(args.collection_db)
    selected = [row for row in documents if _selected(row, args)]
    excluded = [row for row in documents if not _selected(row, args)]
    if not selected:
        raise SystemExit("allowlist matched no active indexed documents")

    manifest: dict[str, Any] = {
        "mode": "execute" if args.execute else "dry-run",
        "source_collection_db": str(args.collection_db.resolve()),
        "selected": [],
        "excluded": [
            {
                "doc_id": row.get("doc_id"),
                "company_name": row.get("company_name"),
                "company_ticker": row.get("company_ticker"),
                "original_filename": row.get("original_filename"),
            }
            for row in excluded
        ],
    }

    destination = args.staging_source.resolve() if args.staging_source else None
    if args.execute:
        if destination.exists() and any(destination.iterdir()):
            raise SystemExit(f"staging directory must be absent or empty: {destination}")
        destination.mkdir(parents=True, exist_ok=True)

    used_names: set[str] = set()
    for row in selected:
        source = Path(str(row.get("stored_path") or "")).resolve()
        if not source.is_file():
            raise SystemExit(f"source file is missing for doc_id={row.get('doc_id')}: {source}")
        actual_checksum = _sha256(source)
        expected_checksum = str(row.get("checksum") or "")
        if expected_checksum and actual_checksum != expected_checksum:
            raise SystemExit(
                f"checksum mismatch for doc_id={row.get('doc_id')}: "
                f"expected={expected_checksum} actual={actual_checksum}"
            )

        filename = Path(str(row.get("original_filename") or source.name)).name
        if filename in used_names:
            filename = f"{str(row.get('doc_id'))[:12]}_{filename}"
        used_names.add(filename)
        target = destination / filename if destination else None
        if args.execute:
            shutil.copy2(source, target)

        manifest["selected"].append(
            {
                "doc_id": row.get("doc_id"),
                "dataset_id": row.get("dataset_id"),
                "company_name": row.get("company_name"),
                "company_ticker": row.get("company_ticker"),
                "original_filename": row.get("original_filename"),
                "source_path": str(source),
                "staged_path": str(target) if target else "",
                "checksum": actual_checksum,
                "file_size": source.stat().st_size,
            }
        )

    if args.execute:
        manifest_path = destination.parent / f"{destination.name}_manifest.json"
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        manifest["manifest_path"] = str(manifest_path)

    print(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
