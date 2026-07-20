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
    # _materialize_bundle looks up by doc_id in Chroma — use chunk_id as doc_id
    meta["doc_id"] = r["chunk_id"]
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

    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM chunks WHERE chroma_synced_at IS NULL ORDER BY doc_id, chunk_index").fetchall()]
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
            ctype = str(r.get("content_type", "") or "")
            is_table = any(t in ctype for t in TABLE_CONTENT_TYPES)
            if is_table and table_chroma is not None:
                tb_texts.append(str(r["content"] or ""))
                tb_metas.append(meta); tb_ids.append(r["chunk_id"])
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
