#!/usr/bin/env python3
"""Shared helpers for the standalone Markdown semantic chunk pipeline."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SUPPORTED_EXTENSIONS = {".md", ".markdown"}
DEFAULT_DOC_TYPE = "research_note"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_supported_file(path: str | Path) -> Path:
    file_path = Path(path).expanduser().resolve()
    if not file_path.is_file():
        raise FileNotFoundError(f"Markdown file not found: {file_path}")
    if file_path.suffix.lower() not in SUPPORTED_EXTENSIONS:
        supported = ", ".join(sorted(SUPPORTED_EXTENSIONS))
        raise ValueError(f"Unsupported Markdown type {file_path.suffix!r}; supported: {supported}")
    return file_path


def read_text(path: str | Path) -> str:
    return Path(path).read_text(encoding="utf-8", errors="replace")


def load_json(path: str | Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def dump_json(data: Any, path: str | Path) -> None:
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_stem(path: str | Path) -> str:
    stem = Path(path).stem.strip()
    stem = re.sub(r"[^0-9A-Za-z._\-\u4e00-\u9fff]+", "_", stem)
    return stem[:120] or "markdown"


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def relative_datasets_path(path: str | Path) -> str:
    resolved = Path(path).resolve()
    parts = resolved.parts
    if "datasets" in parts:
        idx = parts.index("datasets")
        return "/".join(parts[idx:])
    return str(resolved)


def connect_collection(dataset_root: str | Path) -> sqlite3.Connection:
    db_path = Path(dataset_root).resolve() / "meta" / "collection.sqlite3"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    ensure_collection_schema(conn)
    return conn


def ensure_collection_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS documents (
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

        CREATE TABLE IF NOT EXISTS chunks (
            chunk_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            content TEXT NOT NULL,
            content_type TEXT NOT NULL,
            title_path TEXT,
            summary TEXT,
            token_count INTEGER,
            content_hash TEXT NOT NULL,
            prev_chunk_id TEXT,
            next_chunk_id TEXT,
            source_ref TEXT,
            metadata_json TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chunk_locations (
            location_id TEXT PRIMARY KEY,
            chunk_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            location_index INTEGER NOT NULL DEFAULT 0,
            page_start INTEGER,
            page_end INTEGER,
            page_numbers_json TEXT,
            slide_start INTEGER,
            slide_end INTEGER,
            sheet_name TEXT,
            cell_range TEXT,
            heading_path TEXT,
            bbox_json TEXT,
            source_refs_json TEXT,
            display_text TEXT NOT NULL,
            metadata_json TEXT
        );
        """
    )
    conn.commit()


def title_path_text(value: Any) -> str:
    if isinstance(value, list):
        return " > ".join(str(item) for item in value if str(item).strip())
    return str(value or "")


def write_chunks_to_db(
    *,
    dataset_root: Path,
    dataset_id: str,
    doc_id: str,
    doc_type: str,
    chunks: list[dict[str, Any]],
) -> None:
    now = now_iso()
    chunk_rows: list[dict[str, Any]] = []
    location_rows: list[dict[str, Any]] = []
    chunk_ids: list[str] = []
    for idx, chunk in enumerate(chunks, start=1):
        content = str(chunk.get("content") or "")
        source_ref = str(chunk.get("source_ref") or "")
        content_hash = chunk.get("content_hash") or sha256_text(content)
        chunk_id = sha256_text(f"{doc_id}\0{idx}\0{source_ref}\0{content_hash}")[:40]
        chunk_ids.append(chunk_id)
        title_text = title_path_text(chunk.get("title_path") or chunk.get("title"))
        metadata = dict(chunk.get("metadata") or {})
        metadata.update({"source": "file2chunk_md", "source_locations": chunk.get("source_locations") or []})
        chunk_rows.append(
            {
                "chunk_id": chunk_id,
                "dataset_id": dataset_id,
                "doc_id": doc_id,
                "chunk_index": idx,
                "content": content,
                "content_type": chunk.get("content_type") or "markdown_section",
                "title_path": title_text,
                "summary": chunk.get("summary") or None,
                "token_count": len(content.split()),
                "content_hash": content_hash,
                "prev_chunk_id": None,
                "next_chunk_id": None,
                "source_ref": source_ref or None,
                "metadata_json": json.dumps(metadata, ensure_ascii=False),
                "created_at": now,
            }
        )
        locations = chunk.get("source_locations") or [{"display_text": source_ref or title_text}]
        for loc_idx, loc in enumerate(locations):
            heading = title_path_text(loc.get("heading_path") or chunk.get("title_path"))
            line_start = loc.get("line_start")
            line_end = loc.get("line_end")
            display = loc.get("display_text") or (
                f"lines {line_start}-{line_end}" if line_start and line_end else source_ref or title_text
            )
            location_rows.append(
                {
                    "location_id": sha256_text(f"{chunk_id}\0{loc_idx}\0{display}")[:40],
                    "chunk_id": chunk_id,
                    "doc_id": doc_id,
                    "location_index": loc_idx,
                    "page_start": None,
                    "page_end": None,
                    "page_numbers_json": None,
                    "slide_start": None,
                    "slide_end": None,
                    "sheet_name": None,
                    "cell_range": None,
                    "heading_path": heading,
                    "bbox_json": None,
                    "source_refs_json": json.dumps([display], ensure_ascii=False),
                    "display_text": display,
                    "metadata_json": json.dumps(loc, ensure_ascii=False),
                }
            )
    for idx, row in enumerate(chunk_rows):
        row["prev_chunk_id"] = chunk_ids[idx - 1] if idx > 0 else None
        row["next_chunk_id"] = chunk_ids[idx + 1] if idx + 1 < len(chunk_ids) else None

    with connect_collection(dataset_root) as conn:
        doc = conn.execute("SELECT doc_id FROM documents WHERE doc_id = ?", (doc_id,)).fetchone()
        if doc is None:
            raise ValueError(f"document not found in collection.sqlite3: {doc_id}")
        conn.execute("DELETE FROM chunk_locations WHERE doc_id = ?", (doc_id,))
        conn.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
        if chunk_rows:
            conn.executemany(
                """
                INSERT INTO chunks (
                    chunk_id, dataset_id, doc_id, chunk_index, content,
                    content_type, title_path, summary, token_count, content_hash,
                    prev_chunk_id, next_chunk_id, source_ref, metadata_json, created_at
                ) VALUES (
                    :chunk_id, :dataset_id, :doc_id, :chunk_index, :content,
                    :content_type, :title_path, :summary, :token_count, :content_hash,
                    :prev_chunk_id, :next_chunk_id, :source_ref, :metadata_json, :created_at
                )
                """,
                chunk_rows,
            )
            conn.executemany(
                """
                INSERT INTO chunk_locations (
                    location_id, chunk_id, doc_id, location_index, page_start,
                    page_end, page_numbers_json, slide_start, slide_end,
                    sheet_name, cell_range, heading_path, bbox_json,
                    source_refs_json, display_text, metadata_json
                ) VALUES (
                    :location_id, :chunk_id, :doc_id, :location_index, :page_start,
                    :page_end, :page_numbers_json, :slide_start, :slide_end,
                    :sheet_name, :cell_range, :heading_path, :bbox_json,
                    :source_refs_json, :display_text, :metadata_json
                )
                """,
                location_rows,
            )
        conn.execute(
            "UPDATE documents SET doc_type = ?, status = 'parsed', chunk_count = ?, error_message = NULL, updated_at = ? WHERE doc_id = ?",
            (doc_type, len(chunk_rows), now_iso(), doc_id),
        )
        conn.commit()


def update_document_failure(dataset_root: str | Path, doc_id: str, message: str) -> None:
    try:
        with connect_collection(dataset_root) as conn:
            conn.execute(
                "UPDATE documents SET status = 'failed', error_message = ?, updated_at = ? WHERE doc_id = ?",
                (message[:4000], now_iso(), doc_id),
            )
            conn.commit()
    except sqlite3.Error:
        return
