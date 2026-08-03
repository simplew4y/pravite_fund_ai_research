#!/usr/bin/env python3
"""SQLite chunks -> Chroma via LangChain add_texts (no _collection.add)."""
import json, logging, sqlite3, time
from pathlib import Path
from typing import Any, Dict, Union

logger = logging.getLogger("chroma_bridge")
TABLE_CONTENT_TYPES = {"excel_sheet_summary", "excel_region_summary", "table_extracted"}
DEFAULT_BATCH_SIZE = 10


def _connect(db_path: Union[str, Path]) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_cursor_column(conn: sqlite3.Connection) -> None:
    orig = conn.row_factory
    conn.row_factory = sqlite3.Row
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(chunks)").fetchall()}
    conn.row_factory = orig
    if "chroma_synced_at" not in cols:
        conn.execute("ALTER TABLE chunks ADD COLUMN chroma_synced_at TEXT")
        conn.commit()


def _safe_meta(r: dict) -> dict:
    """Build Chroma-safe metadata (str/int/float/bool values only)."""
    SKIP = {"chunk_id", "content", "created_at", "summary", "token_count",
            "content_hash", "prev_chunk_id", "next_chunk_id", "chroma_synced_at"}
    meta = {}
    for k, v in r.items():
        if k in SKIP: continue
        if k == "chunk_index": meta[k] = int(v); continue
        if isinstance(v, (str, int, float, bool)) and v is not None:
            meta[k] = v
    # _materialize_bundle looks up by doc_id in Chroma — use chunk_id as doc_id.
    # Keep the SQLite document id separately for dataset/company filtering.
    meta["doc_id"] = r["chunk_id"]
    meta["source_doc_id"] = r.get("source_doc_id") or r.get("doc_id") or ""
    if r.get("source_company_name"):
        meta["company_name"] = r["source_company_name"]
    if r.get("source_ticker"):
        meta["ticker"] = r["source_ticker"]
    if r.get("source_filename"):
        meta["filename"] = r["source_filename"]
    # EnsembleRetriever _expand_ids expects these
    meta["prev_chunk_id"] = r.get("prev_chunk_id") or ""
    meta["next_chunk_id"] = r.get("next_chunk_id") or ""
    mj = r.get("metadata_json")
    if mj:
        try:
            extra = json.loads(mj) if isinstance(mj, str) else mj
            if isinstance(extra, dict):
                for ek, ev in extra.items():
                    if isinstance(ev, (str, int, float, bool)) and not isinstance(ev, (list, dict)):
                        meta[ek] = ev
        except: pass
    return meta


def sync_chunks_to_chroma(
    rag_manager: Any,
    collection_db_path: Union[str, Path],
    collection_name: str = "default",
    batch_size: int = DEFAULT_BATCH_SIZE,
    sync_all: bool = False,
    dataset_id: str = "",
) -> Dict[str, int]:
    db_path = Path(collection_db_path).expanduser().resolve()
    if not db_path.is_file():
        raise FileNotFoundError("Collection DB not found: {}".format(db_path))
    if collection_name not in rag_manager._collections:
        raise ValueError("Unknown collection: {} (have: {})".format(
            collection_name, list(rag_manager._collections)))

    chroma, _, table_chroma = rag_manager._collections[collection_name]
    conn = _connect(db_path)
    _ensure_cursor_column(conn)

    documents_cols = {r["name"] for r in conn.execute("PRAGMA table_info(documents)").fetchall()}
    joined_fields = []
    field_candidates = (
        (("company_name",), "source_company_name"),
        (("company_ticker", "ticker"), "source_ticker"),
        (("original_filename", "filename", "source_name"), "source_filename"),
    )
    for candidates, alias in field_candidates:
        column = next((value for value in candidates if value in documents_cols), None)
        if column:
            joined_fields.append(f"d.{column} AS {alias}")
    extra_select = (", " + ", ".join(joined_fields)) if joined_fields else ""
    pending_clause = "" if sync_all else "WHERE c.chroma_synced_at IS NULL"
    rows = [dict(r) for r in conn.execute(
        f"SELECT c.*, c.doc_id AS source_doc_id{extra_select} "
        f"FROM chunks c LEFT JOIN documents d ON d.doc_id = c.doc_id "
        f"{pending_clause} ORDER BY c.doc_id, c.chunk_index").fetchall()]
    if not rows:
        logger.info("No unsynced chunks found"); conn.close()
        return {"text_chunks": 0, "table_chunks": 0}

    logger.info("Found %d unsynced chunks", len(rows))
    text_chunks = 0; table_chunks = 0
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    synced_ids = []

    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        t_texts, t_metas, t_ids = [], [], []
        tb_texts, tb_metas, tb_ids = [], [], []
        for r in batch:
            meta = _safe_meta(r)
            if dataset_id:
                meta["dataset_id"] = dataset_id
            ctype = str(r.get("content_type", "") or "")
            is_table = any(t in ctype for t in TABLE_CONTENT_TYPES)
            if is_table and table_chroma is not None:
                tb_texts.append(str(r["content"] or ""))
                table_meta = dict(meta)
                table_meta["content"] = str(r["content"] or "")
                tb_metas.append(table_meta); tb_ids.append(r["chunk_id"])
            else:
                t_texts.append(str(r["content"] or ""))
                t_metas.append(meta); t_ids.append(r["chunk_id"])
            synced_ids.append(r["chunk_id"])
        if t_texts:
            chroma.add_texts(texts=t_texts, metadatas=t_metas, ids=t_ids)
            text_chunks += len(t_texts)
        if tb_texts and table_chroma is not None:
            table_chroma.add_texts(texts=tb_texts, metadatas=tb_metas, ids=tb_ids)
            table_chunks += len(tb_texts)

    p = ",".join("?" for _ in synced_ids)
    conn.execute("UPDATE chunks SET chroma_synced_at = ? WHERE chunk_id IN ({})".format(p),
                 (now_iso, *synced_ids))
    conn.commit(); conn.close()

    # Force retriever rebuild on next query
    if synced_ids:
        logger.info("Clearing RAGManager singleton to rebuild retriever")
        RagMgr = type(rag_manager)
        RagMgr._instance = None

    logger.info("Synced %d text + %d table chunks", text_chunks, table_chunks)
    return {"text_chunks": text_chunks, "table_chunks": table_chunks}
