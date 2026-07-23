#!/usr/bin/env python3
"""Bridge: read chunks from private_fund_directory_ingest SQLite → incremental Chroma write.

Usage:
    from data_ingestion.chroma_bridge import sync_chunks_to_chroma
    sync_chunks_to_chroma(rag_manager, collection_db_path, collection_name="default")

This reads chunks from collection.sqlite3 that haven't been synced yet
(those without a chroma_synced_at timestamp), writes them to Chroma, and
marks them as synced.
"""

import json
import logging
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

logger = logging.getLogger("chroma_bridge")

# ── Content types that should go to table_chroma ──
TABLE_CONTENT_TYPES = {
    "excel_sheet_summary",
    "excel_region_summary",
    "table_extracted",
}

DEFAULT_BATCH_SIZE = 64


def _connect(db_path: Union[str, Path]) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_cursor_column(conn: sqlite3.Connection) -> None:
    """Add chroma_synced_at column if it doesn't exist yet."""
    # Set row_factory temporarily if not set
    orig_factory = conn.row_factory
    conn.row_factory = sqlite3.Row
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(chunks)").fetchall()}
    conn.row_factory = orig_factory
    if "chroma_synced_at" not in cols:
        conn.execute("ALTER TABLE chunks ADD COLUMN chroma_synced_at TEXT")
        conn.commit()
        logger.info("Added chroma_synced_at column to chunks table")


def _build_metadata(row: sqlite3.Row) -> dict:
    """Build Chroma metadata dict from a chunks row."""
    metadata = {"doc_id": row["doc_id"], "chunk_index": row["chunk_index"],
                 "source_ref": row["source_ref"] or "",
                 "title_path": row["title_path"] or "",
                 "chunk_id": row["chunk_id"]}
    meta_json = row["metadata_json"]
    if meta_json:
        try:
            extra = json.loads(meta_json)
            metadata.update(extra)
        except (json.JSONDecodeError, TypeError):
            pass
    return metadata


def sync_chunks_to_chroma(
    rag_manager: Any,
    collection_db_path: Union[str, Path],
    collection_name: str = "default",
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> Dict[str, int]:
    """Read unsynced chunks from SQLite and write to Chroma.

    Args:
        rag_manager: RAGManager instance with Chroma collections.
        collection_db_path: Path to collection.sqlite3.
        collection_name: Which collection to write to.
        batch_size: Chroma write batch size.

    Returns:
        {"text_chunks": N, "table_chunks": N}
    """
    db_path = Path(collection_db_path).expanduser().resolve()
    if not db_path.is_file():
        raise FileNotFoundError(f"Collection DB not found: {db_path}")

    if collection_name not in rag_manager._collections:
        raise ValueError(f"Unknown collection: {collection_name} (have: {list(rag_manager._collections)})")

    chroma, _, table_chroma = rag_manager._collections[collection_name]

    conn = _connect(db_path)
    _ensure_cursor_column(conn)

    # Read unsynced chunks
    rows = conn.execute(
        "SELECT * FROM chunks WHERE chroma_synced_at IS NULL ORDER BY doc_id, chunk_index"
    ).fetchall()

    if not rows:
        logger.info("No unsynced chunks found")
        conn.close()
        return {"text_chunks": 0, "table_chunks": 0}

    logger.info("Found %d unsynced chunks", len(rows))

    text_chunks = 0
    table_chunks = 0
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # Process in batches
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        text_texts, text_metadatas, text_ids = [], [], []
        table_texts, table_metadatas, table_ids = [], [], []
        synced_chunk_ids = []

        for row in batch:
            content_type = (row["content_type"] or "text").lower()
            content = row["content"] or ""
            chunk_id = row["chunk_id"]
            metadata = _build_metadata(row)

            is_table = any(ct in content_type for ct in TABLE_CONTENT_TYPES)
            if is_table and table_chroma is not None:
                table_texts.append(content)
                table_metadatas.append(metadata)
                table_ids.append(chunk_id)
            else:
                text_texts.append(content)
                text_metadatas.append(metadata)
                text_ids.append(chunk_id)

            synced_chunk_ids.append(chunk_id)

        # Write to Chroma
        if text_ids:
            chroma._collection.add(
                ids=text_ids,
                documents=text_texts,
                metadatas=text_metadatas,
            )
            text_chunks += len(text_ids)

        if table_ids and table_chroma is not None:
            table_chroma._collection.add(
                ids=table_ids,
                documents=table_texts,
                metadatas=table_metadatas,
            )
            table_chunks += len(table_ids)

        # Mark as synced
        placeholders = ",".join("?" for _ in synced_chunk_ids)
        conn.execute(
            f"UPDATE chunks SET chroma_synced_at = ? WHERE chunk_id IN ({placeholders})",
            (now_iso, *synced_chunk_ids),
        )
        conn.commit()

    conn.close()
    logger.info("Synced %d text + %d table chunks to Chroma", text_chunks, table_chunks)
    return {"text_chunks": text_chunks, "table_chunks": table_chunks}
