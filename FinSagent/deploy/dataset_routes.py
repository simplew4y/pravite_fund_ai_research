"""
Dataset registry, upload, ingest, and artifact routes.

Data model:
- Global registry: {datasets.root_dir}/datasets.sqlite3
  - datasets
  - dataset_state
- Per dataset metadata: {datasets.root_dir}/{dataset_id}/meta/collection.sqlite3
  - documents
  - chunks
  - chunk_locations
  - index_registry
  - ingest_jobs

All DB path values are stored as portable paths starting with "datasets/".
"""

from __future__ import annotations

import copy
import hashlib
import json
import logging
import os
import re
import sqlite3
import subprocess
import sys
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import yaml

import app as app_module
from fastapi import APIRouter, BackgroundTasks, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

router = APIRouter(tags=["datasets"])
logger = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_PIPELINE_DIR = REPO_ROOT / "data_pipeline"
INGEST_SCRIPT = DATA_PIPELINE_DIR / "file2chunk2data_pipeline.py"
EXCEL_PIPELINE_SCRIPT = DATA_PIPELINE_DIR / "file2chunk_excel" / "excel2chunk_pipeline.py"
EXCEL_LOAD_DATA_SCRIPT = DATA_PIPELINE_DIR / "file2chunk_excel" / "load_data.py"
EXCEL_LOAD_TABLE_SCRIPT = DATA_PIPELINE_DIR / "file2chunk_excel" / "load_table_chroma.py"
MD_PIPELINE_SCRIPT = DATA_PIPELINE_DIR / "file2chunk_md" / "md2chunk_pipeline.py"
MD_LOAD_DATA_SCRIPT = DATA_PIPELINE_DIR / "file2chunk_md" / "load_data.py"
MD_LOAD_TABLE_SCRIPT = DATA_PIPELINE_DIR / "file2chunk_md" / "load_table_chroma.py"
WORD_PIPELINE_SCRIPT = DATA_PIPELINE_DIR / "file2chunk_word" / "word2chunk_pipeline.py"
WORD_LOAD_DATA_SCRIPT = DATA_PIPELINE_DIR / "file2chunk_word" / "load_data.py"
WORD_LOAD_TABLE_SCRIPT = DATA_PIPELINE_DIR / "file2chunk_word" / "load_table_chroma.py"
CONFIG_PATH = REPO_ROOT / "config" / "production.yaml"

DATASET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{1,62}$")
SAFE_NAME_RE = re.compile(r"[^0-9A-Za-z._\-\u4e00-\u9fff]+")
DEFAULT_ROOT = "/root/autodl-tmp/dir_ljl/datasets"

DATASET_STATUS = ("empty", "indexing", "indexed", "failed", "unavailable")
DOCUMENT_STATUS = ("uploaded", "parsing", "parsed", "indexing", "indexed", "failed", "unsupported", "deleted")
JOB_STATUS = ("queued", "running", "completed", "failed", "cancelled")

RAW_FILE_TYPES = ("pdf", "word", "ppt", "excel", "md")

RAW_DIR_BY_TYPE = {
    file_type: f"0_raw/{file_type}" for file_type in RAW_FILE_TYPES
}

PROCESSED_DIR_BY_TYPE = {
    file_type: f"1_processed/{file_type}" for file_type in RAW_FILE_TYPES
}

EXTENSION_TO_TYPE = {
    ".pdf": "pdf",
    ".doc": "word",
    ".docx": "word",
    ".odt": "word",
    ".rtf": "word",
    ".ppt": "ppt",
    ".pptx": "ppt",
    ".odp": "ppt",
    ".xls": "excel",
    ".xlsx": "excel",
    ".csv": "excel",
    ".md": "md",
    ".markdown": "md",
}

MINERU_GENERATED_PDF_STEM_SUFFIXES = (
    "_layout",
    "-layout",
    "_origin",
    "-origin",
)

_jobs_lock = threading.Lock()


class DatasetCreateRequest(BaseModel):
    name: str
    dataset_id: Optional[str] = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _dataset_root_from_config(config: Optional[dict[str, Any]] = None) -> Path:
    cfg = config if config is not None else app_module.load_config()
    datasets_cfg = cfg.get("datasets") if isinstance(cfg.get("datasets"), dict) else {}
    return Path(datasets_cfg.get("root_dir") or DEFAULT_ROOT).resolve()


def _registry_db_path() -> Path:
    root = _dataset_root_from_config()
    root.mkdir(parents=True, exist_ok=True)
    return root / "datasets.sqlite3"


def _connect_registry() -> sqlite3.Connection:
    conn = sqlite3.connect(_registry_db_path(), timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def _connect_collection(dataset: dict[str, Any]) -> sqlite3.Connection:
    db_path = _dataset_abs_database(dataset)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    _ensure_collection_schema(conn)
    return conn


def _row_to_dict(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    return dict(row)


def _table_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    try:
        rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    except sqlite3.Error:
        return set()
    return {row["name"] for row in rows}


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def _slugify_dataset_id(value: str) -> str:
    slug = re.sub(r"[^0-9A-Za-z_-]+", "_", (value or "").strip()).strip("_-").lower()
    if len(slug) < 2:
        slug = f"dataset_{uuid.uuid4().hex[:8]}"
    return slug[:63]


def _generate_dataset_id() -> str:
    return f"dataset_{uuid.uuid4().hex[:8]}"


def _index_collection_name(dataset: dict[str, Any]) -> str:
    return str(dataset["dataset_id"])


def _safe_upload_basename(filename: Optional[str]) -> tuple[str, str, str]:
    base = os.path.basename(filename or "upload")
    if ".." in base or base.startswith("."):
        base = "upload"
    stem, ext = os.path.splitext(base)
    ext = ext.lower()
    file_type = EXTENSION_TO_TYPE.get(ext)
    if not file_type:
        allowed = ", ".join(sorted(EXTENSION_TO_TYPE))
        raise HTTPException(status_code=400, detail=f"暂不支持该文件格式: {filename or 'upload'}；支持: {allowed}")
    stem = SAFE_NAME_RE.sub("_", stem).strip("._-") or "upload"
    stored_name = f"{uuid.uuid4().hex[:10]}_{stem}{ext}"
    return stored_name, file_type, ext


def _reject_generated_pdf_upload(filename: Optional[str], file_type: str, ext: str) -> None:
    if file_type != "pdf" or ext != ".pdf":
        return
    original_stem = os.path.splitext(os.path.basename(filename or ""))[0].strip().lower()
    if original_stem.endswith(MINERU_GENERATED_PDF_STEM_SUFFIXES):
        raise HTTPException(
            status_code=400,
            detail=(
                "检测到上传文件像 MinerU 生成的 layout/origin PDF，"
                "这类文件会带彩色解析框，不能作为原文预览底图。请上传未经过 MinerU 解析的原始 PDF。"
            ),
        )


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _relative_path(path: Path) -> str:
    root = _dataset_root_from_config()
    resolved = path.resolve()
    try:
        return resolved.relative_to(root.parent).as_posix()
    except ValueError:
        try:
            return resolved.relative_to(root).as_posix()
        except ValueError:
            return resolved.as_posix()


def _abs_path(path_value: str | Path) -> Path:
    path = Path(path_value)
    if path.is_absolute():
        return path.resolve()
    root = _dataset_root_from_config()
    parts = path.parts
    if parts and parts[0] == root.name:
        return (root.parent / path).resolve()
    return (root / path).resolve()


def _dataset_abs_root(dataset: dict[str, Any]) -> Path:
    return (_dataset_root_from_config() / dataset["dataset_id"]).resolve()


def _dataset_abs_persist(dataset: dict[str, Any]) -> Path:
    return _dataset_abs_root(dataset) / "5_database"


def _dataset_abs_database(dataset: dict[str, Any]) -> Path:
    return _dataset_abs_root(dataset) / "meta" / "collection.sqlite3"


def _chroma_embedding_count(chroma_dir: Path) -> int:
    db_path = chroma_dir / "chroma.sqlite3"
    if not db_path.is_file():
        return 0
    try:
        conn = sqlite3.connect(db_path)
        try:
            row = conn.execute("SELECT COUNT(*) FROM embeddings").fetchone()
            return int(row[0] or 0) if row else 0
        finally:
            conn.close()
    except sqlite3.Error:
        logger.warning("无法读取 Chroma embeddings 计数: %s", db_path, exc_info=True)
        return 0


def _dir_has_nonempty_file(path: Path) -> bool:
    if not path.exists():
        return False
    try:
        return any(child.is_file() and child.stat().st_size > 0 for child in path.rglob("*"))
    except OSError:
        return False


def _status_for_persist_dir(persist_directory: Path) -> str:
    if not persist_directory.exists():
        return "unavailable"
    for name in ("chroma", "ts_chroma", "table_chroma"):
        if _chroma_embedding_count(persist_directory / name) > 0:
            return "indexed"
    for name in ("bm25_index", "pageindex"):
        if _dir_has_nonempty_file(persist_directory / name):
            return "indexed"
    return "empty"


def _ensure_registry_schema(conn: sqlite3.Connection) -> None:
    if _table_exists(conn, "datasets"):
        columns = _table_columns(conn, "datasets")
        required = {
            "dataset_id",
            "name",
            "status",
            "created_at",
            "updated_at",
        }
        if not required.issubset(columns):
            backup = f"datasets_legacy_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
            logger.warning("检测到旧 datasets schema，重命名为 %s 并创建新 registry", backup)
            conn.execute(f"ALTER TABLE datasets RENAME TO {backup}")

    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS datasets (
            dataset_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('empty', 'indexing', 'indexed', 'failed', 'unavailable')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS dataset_state (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            active_dataset_id TEXT,
            updated_at TEXT NOT NULL
        );
        """
    )
    if "updated_at" not in _table_columns(conn, "dataset_state"):
        conn.execute("ALTER TABLE dataset_state ADD COLUMN updated_at TEXT")
        conn.execute("UPDATE dataset_state SET updated_at = COALESCE(updated_at, ?)", (_now(),))
    conn.execute(
        "INSERT OR IGNORE INTO dataset_state (id, active_dataset_id, updated_at) VALUES (1, NULL, ?)",
        (_now(),),
    )
    conn.commit()


def _ensure_collection_schema(conn: sqlite3.Connection) -> None:
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
            status TEXT NOT NULL CHECK(status IN ('uploaded', 'parsing', 'parsed', 'indexing', 'indexed', 'failed', 'unsupported', 'deleted')),
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

        CREATE TABLE IF NOT EXISTS index_registry (
            index_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            index_type TEXT NOT NULL,
            collection_name TEXT,
            index_path TEXT NOT NULL,
            source_doc_ids_json TEXT,
            source_chunk_count INTEGER,
            status TEXT NOT NULL CHECK(status IN ('building', 'ready', 'failed', 'stale')),
            built_at TEXT,
            error_message TEXT,
            metadata_json TEXT
        );

        CREATE TABLE IF NOT EXISTS ingest_jobs (
            job_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            job_type TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
            doc_ids_json TEXT,
            file_count INTEGER NOT NULL DEFAULT 0,
            log_path TEXT,
            message TEXT,
            returncode INTEGER,
            created_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            metadata_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_documents_dataset_status ON documents(dataset_id, status);
        CREATE INDEX IF NOT EXISTS idx_chunks_doc_index ON chunks(doc_id, chunk_index);
        CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash);
        CREATE INDEX IF NOT EXISTS idx_locations_chunk ON chunk_locations(chunk_id);
        CREATE INDEX IF NOT EXISTS idx_ingest_jobs_dataset_created ON ingest_jobs(dataset_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_index_registry_dataset_type ON index_registry(dataset_id, index_type);
        """
    )
    conn.commit()


def init_dataset_registry(config: Optional[dict[str, Any]] = None) -> None:
    """Initialize datasets.root_dir and global registry DB. Does not scan or migrate datasets_bak."""
    root = _dataset_root_from_config(config)
    root.mkdir(parents=True, exist_ok=True)
    with _connect_registry() as conn:
        _ensure_registry_schema(conn)


def _build_dataset_record(name: str, dataset_id: str) -> dict[str, Any]:
    now = _now()
    return {
        "dataset_id": dataset_id,
        "name": name,
        "status": "empty",
        "created_at": now,
        "updated_at": now,
    }


def _ensure_dataset_dirs(dataset: dict[str, Any]) -> None:
    root = _dataset_abs_root(dataset)
    persist = _dataset_abs_persist(dataset)
    dirs = [
        *(root / RAW_DIR_BY_TYPE[file_type] for file_type in RAW_FILE_TYPES),
        *(root / PROCESSED_DIR_BY_TYPE[file_type] for file_type in RAW_FILE_TYPES),
        root / "2_final" / "pdf_v2",
        root / "3_base_final",
        root / "4_processed_table",
        persist / "chroma",
        persist / "ts_chroma",
        persist / "table_chroma",
        persist / "bm25_index",
        persist / "pageindex",
        root / "meta",
        root / "logs" / "ingest",
    ]
    for path in dirs:
        path.mkdir(parents=True, exist_ok=True)
    with _connect_collection(dataset):
        pass


def _dataset_values(dataset: dict[str, Any]) -> tuple[Any, ...]:
    return (
        dataset["dataset_id"],
        dataset["name"],
        dataset["status"],
        dataset["created_at"],
        dataset["updated_at"],
    )


def _legacy_dataset_values(dataset: dict[str, Any]) -> dict[str, Any]:
    root = _dataset_abs_root(dataset)
    persist = _dataset_abs_persist(dataset)
    return {
        **dataset,
        "collection_name": _index_collection_name(dataset),
        "root_path": _relative_path(root),
        "database_path": _relative_path(_dataset_abs_database(dataset)),
        "persist_path": _relative_path(persist),
    }


def _insert_dataset(conn: sqlite3.Connection, dataset: dict[str, Any]) -> None:
    columns = _table_columns(conn, "datasets")
    legacy_columns = {"collection_name", "root_path", "database_path", "persist_path"}
    if legacy_columns.issubset(columns):
        conn.execute(
            """
            INSERT INTO datasets (
                dataset_id, name, collection_name, root_path, database_path,
                persist_path, status, created_at, updated_at
            ) VALUES (
                :dataset_id, :name, :collection_name, :root_path, :database_path,
                :persist_path, :status, :created_at, :updated_at
            )
            """,
            _legacy_dataset_values(dataset),
        )
        return
    conn.execute(
        """
        INSERT INTO datasets (
            dataset_id, name, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        """,
        _dataset_values(dataset),
    )


def _dataset_payload(dataset: dict[str, Any]) -> dict[str, Any]:
    payload = dict(dataset)
    root = _dataset_abs_root(dataset)
    persist = _dataset_abs_persist(dataset)
    payload.update(
        {
            "collection_name": _index_collection_name(dataset),
            "root_path": _relative_path(root),
            "database_path": _relative_path(_dataset_abs_database(dataset)),
            "persist_path": _relative_path(persist),
            "raw_dir": _relative_path(root / RAW_DIR_BY_TYPE["pdf"]),
            "raw_root": _relative_path(root / "0_raw"),
            "processed_dir": _relative_path(root / "3_base_final"),
            "pageindex_index_dir": _relative_path(persist / "pageindex"),
        }
    )
    return payload


def _refresh_dataset_status(dataset: dict[str, Any], *, force: bool = False) -> dict[str, Any]:
    current = dataset.get("status")
    if not force and current == "indexing":
        return dataset
    refreshed = _status_for_persist_dir(_dataset_abs_persist(dataset))
    if current == "failed" and refreshed != "indexed" and not force:
        return dataset
    if refreshed != current:
        dataset = dict(dataset)
        dataset["status"] = refreshed
        dataset["updated_at"] = _now()
        with _connect_registry() as conn:
            conn.execute(
                "UPDATE datasets SET status = ?, updated_at = ? WHERE dataset_id = ?",
                (dataset["status"], dataset["updated_at"], dataset["dataset_id"]),
            )
            conn.commit()
    return dataset


def _set_dataset_status(dataset_id: str, status: str) -> None:
    if status not in DATASET_STATUS:
        raise ValueError(f"invalid dataset status: {status}")
    with _connect_registry() as conn:
        conn.execute(
            "UPDATE datasets SET status = ?, updated_at = ? WHERE dataset_id = ?",
            (status, _now(), dataset_id),
        )
        conn.commit()


def _require_dataset(dataset_id: str, *, refresh: bool = True) -> dict[str, Any]:
    init_dataset_registry()
    with _connect_registry() as conn:
        row = conn.execute("SELECT * FROM datasets WHERE dataset_id = ?", (dataset_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"未知数据集: {dataset_id}")
    dataset = _row_to_dict(row)
    _ensure_dataset_dirs(dataset)
    return _refresh_dataset_status(dataset) if refresh else dataset


def _normalize_active_id(active_id: Optional[str]) -> Optional[str]:
    if not active_id:
        return None
    with _connect_registry() as conn:
        exists = conn.execute("SELECT 1 FROM datasets WHERE dataset_id = ?", (active_id,)).fetchone()
        if exists:
            return active_id
        conn.execute(
            "UPDATE dataset_state SET active_dataset_id = NULL, updated_at = ? WHERE id = 1",
            (_now(),),
        )
        conn.commit()
    return None


def get_active_dataset_id() -> Optional[str]:
    init_dataset_registry()
    with _connect_registry() as conn:
        row = conn.execute("SELECT active_dataset_id FROM dataset_state WHERE id = 1").fetchone()
    return _normalize_active_id(row["active_dataset_id"] if row else None)


def get_dataset_for_chat(dataset_id: Optional[str] = None) -> dict[str, Any]:
    target = dataset_id or get_active_dataset_id()
    if not target:
        raise HTTPException(status_code=409, detail="尚未配置 active 数据集，请先创建并激活资料库")
    dataset = _require_dataset(target)
    if dataset["status"] != "indexed":
        raise HTTPException(status_code=409, detail="该数据集尚未构建索引，请先运行入库 pipeline")
    return dataset


def config_for_dataset(dataset: dict[str, Any], base_config: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    cfg = copy.deepcopy(base_config if base_config is not None else app_module.load_config())
    root = _dataset_abs_root(dataset)
    persist = _dataset_abs_persist(dataset)
    cfg["collection_name"] = _index_collection_name(dataset)
    cfg["persist_directory"] = str(persist)
    cfg["pageindex_index_dir"] = str(persist / "pageindex")
    cfg["agentic_search"] = dict(cfg.get("agentic_search") or {})
    cfg["agentic_search"]["roots"] = [str(root / "3_base_final"), str(root / RAW_DIR_BY_TYPE["pdf"])]
    cfg["datasets"] = dict(cfg.get("datasets") or {})
    cfg["datasets"]["root_dir"] = str(_dataset_root_from_config(cfg))
    return cfg


def activate_dataset_in_registry(dataset_id: str) -> dict[str, Any]:
    dataset = _require_dataset(dataset_id)
    with _connect_registry() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO dataset_state (id, active_dataset_id, updated_at) VALUES (1, ?, ?)",
            (dataset_id, _now()),
        )
        conn.commit()
    return dataset


def _write_pipeline_config(dataset: dict[str, Any], job_id: str) -> Path:
    cfg = config_for_dataset(dataset, app_module.load_config())
    path = _dataset_abs_root(dataset) / "meta" / f"{job_id}_production.yaml"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False), encoding="utf-8")
    return path


def _read_log_tail(path: Path, max_bytes: int = 3000) -> str:
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            return f.read().decode("utf-8", errors="replace")
    except OSError:
        return ""


def _doc_ids_from_job(job: sqlite3.Row | dict[str, Any]) -> list[str]:
    payload = dict(job)
    try:
        value = json.loads(payload.get("doc_ids_json") or "[]")
        return [str(x) for x in value if x]
    except Exception:
        return []


def _update_job(dataset: dict[str, Any], job_id: str, **values: Any) -> None:
    if not values:
        return
    keys = list(values.keys())
    assignments = ", ".join(f"{k} = ?" for k in keys)
    params = [values[k] for k in keys] + [job_id]
    with _connect_collection(dataset) as conn:
        conn.execute(f"UPDATE ingest_jobs SET {assignments} WHERE job_id = ?", params)
        conn.commit()


def _update_documents_status(
    dataset: dict[str, Any],
    doc_ids: list[str],
    status: str,
    *,
    error_message: Optional[str] = None,
) -> None:
    if not doc_ids:
        return
    if status not in DOCUMENT_STATUS:
        raise ValueError(f"invalid document status: {status}")
    placeholders = ",".join("?" for _ in doc_ids)
    params: list[Any] = [status, _now()]
    sql = f"UPDATE documents SET status = ?, updated_at = ?"
    if error_message is not None:
        sql += ", error_message = ?"
        params.append(error_message)
    sql += f" WHERE doc_id IN ({placeholders})"
    params.extend(doc_ids)
    with _connect_collection(dataset) as conn:
        conn.execute(sql, params)
        conn.commit()


def _document_payload(dataset: dict[str, Any], row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    item = _row_to_dict(row)
    item["file_id"] = item["doc_id"]
    item["uploaded_at"] = item["created_at"]
    item["stored_basename"] = Path(str(item.get("stored_path") or "")).name
    path = _abs_path(str(item.get("stored_path") or ""))
    try:
        stat = path.stat()
        item["size_bytes"] = stat.st_size
        item["exists_on_disk"] = True
    except OSError:
        item["size_bytes"] = item.get("file_size")
        item["exists_on_disk"] = False
    return item


def _dataset_documents(dataset: dict[str, Any]) -> list[dict[str, Any]]:
    with _connect_collection(dataset) as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM documents
            WHERE dataset_id = ? AND deleted_at IS NULL
            ORDER BY created_at DESC
            """,
            (dataset["dataset_id"],),
        ).fetchall()
    return [_document_payload(dataset, row) for row in rows]


def _dataset_stats(dataset: dict[str, Any]) -> dict[str, Any]:
    with _connect_collection(dataset) as conn:
        file_count = conn.execute(
            "SELECT COUNT(*) FROM documents WHERE dataset_id = ? AND deleted_at IS NULL",
            (dataset["dataset_id"],),
        ).fetchone()[0]
        indexed_file_count = conn.execute(
            "SELECT COUNT(*) FROM documents WHERE dataset_id = ? AND deleted_at IS NULL AND status = 'indexed'",
            (dataset["dataset_id"],),
        ).fetchone()[0]
        chunk_count = conn.execute(
            "SELECT COUNT(*) FROM chunks WHERE dataset_id = ?",
            (dataset["dataset_id"],),
        ).fetchone()[0]
        job_counts = conn.execute(
            """
            SELECT status, COUNT(*) AS n
            FROM ingest_jobs
            WHERE dataset_id = ?
            GROUP BY status
            """,
            (dataset["dataset_id"],),
        ).fetchall()
    return {
        "file_count": int(file_count or 0),
        "indexed_file_count": int(indexed_file_count or 0),
        "chunk_count": int(chunk_count or 0),
        "job_counts": {row["status"]: row["n"] for row in job_counts},
    }


def _resolve_dataset_file(dataset: dict[str, Any], file_id: str) -> dict[str, Any]:
    with _connect_collection(dataset) as conn:
        row = conn.execute(
            """
            SELECT *
            FROM documents
            WHERE dataset_id = ? AND doc_id = ? AND deleted_at IS NULL
            """,
            (dataset["dataset_id"], file_id),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="未知文件")
    item = _document_payload(dataset, row)
    path = _abs_path(item["stored_path"])
    dataset_root = _dataset_abs_root(dataset)
    try:
        path.relative_to(dataset_root)
    except ValueError:
        raise HTTPException(status_code=403, detail="文件不在当前资料库目录下")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    item["resolved_path"] = str(path)
    return item


def _load_json_artifact(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"读取产物 JSON 失败: {path.name}: {exc}") from exc


def _page_sizes_for_stem(dataset: dict[str, Any], stem: str) -> dict[int, dict[str, Any]]:
    root = _dataset_abs_root(dataset)
    processed_roots = [
        root / PROCESSED_DIR_BY_TYPE["pdf"] / stem,
        root / "1_processed_pdf" / stem,
    ]
    candidates: list[Path] = []
    for processed_root in processed_roots:
        if processed_root.exists():
            candidates.extend(sorted(processed_root.glob("**/*_middle.json")))
    middle = next((path for path in candidates if path.is_file()), None)
    if middle is None:
        return {}
    try:
        data = _load_json_artifact(middle)
    except HTTPException:
        logger.warning("读取 MinerU middle.json 失败: %s", middle, exc_info=True)
        return {}
    sizes: dict[int, dict[str, Any]] = {}
    pdf_info = data.get("pdf_info") if isinstance(data, dict) else None
    if not isinstance(pdf_info, list):
        return sizes
    for idx, page in enumerate(pdf_info):
        if not isinstance(page, dict):
            continue
        page_idx = _int_or_none(page.get("page_idx"))
        if page_idx is None:
            page_idx = idx
        page_size = page.get("page_size")
        width = height = None
        if isinstance(page_size, list) and len(page_size) >= 2:
            width, height = page_size[0], page_size[1]
        elif isinstance(page_size, dict):
            width = page_size.get("width") or page_size.get("w")
            height = page_size.get("height") or page_size.get("h")
        try:
            width = float(width)
            height = float(height)
        except (TypeError, ValueError):
            continue
        if width > 0 and height > 0:
            sizes[page_idx] = {"page_width": width, "page_height": height}
    return sizes


def _parse_json_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return []
        return parsed if isinstance(parsed, list) else []
    return []


_MINERU_CONTENT_COORD_SIZE = {"page_width": 1000.0, "page_height": 1000.0}


def _float_or_none(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _location_page_size(
    loc: dict[str, Any],
    bbox: Any,
    page_idx: int | None,
    page_sizes: dict[int, dict[str, Any]],
) -> dict[str, float]:
    explicit_width = _float_or_none(loc.get("page_width"))
    explicit_height = _float_or_none(loc.get("page_height"))
    if explicit_width and explicit_height:
        return {"page_width": explicit_width, "page_height": explicit_height}

    source_file = str(loc.get("source_file") or "").lower()
    coordinate_system = str(loc.get("coordinate_system") or "").lower()
    if (
        source_file in {"content_list", "content_list_v2"}
        or coordinate_system in {"mineru_content", "mineru_content_list", "content_list_1000"}
    ):
        return dict(_MINERU_CONTENT_COORD_SIZE)

    page_size = page_sizes.get(page_idx) if page_idx is not None else None
    if page_size:
        page_width = _float_or_none(page_size.get("page_width"))
        page_height = _float_or_none(page_size.get("page_height"))
        if page_width and page_height:
            if isinstance(bbox, list) and len(bbox) >= 4:
                x_values = [_float_or_none(bbox[0]), _float_or_none(bbox[2])]
                y_values = [_float_or_none(bbox[1]), _float_or_none(bbox[3])]
                max_x = max([x for x in x_values if x is not None], default=0)
                max_y = max([y for y in y_values if y is not None], default=0)
                # MinerU content_list bboxes are normalized to a 1000x1000 page, while
                # middle.json page_size is PDF points. If an old row lacks source_file,
                # detect the mismatch and keep the overlay in the bbox's own space.
                if max_x > page_width * 1.02 or max_y > page_height * 1.02:
                    return dict(_MINERU_CONTENT_COORD_SIZE)
            return {"page_width": page_width, "page_height": page_height}

    return dict(_MINERU_CONTENT_COORD_SIZE)


def _artifact_locations(row: sqlite3.Row | dict[str, Any], page_sizes: dict[int, dict[str, Any]]) -> list[dict[str, Any]]:
    source_locations = _parse_json_list(row["bbox_json"] if isinstance(row, sqlite3.Row) else row.get("bbox_json"))
    if not source_locations:
        page_start = row["page_start"] if isinstance(row, sqlite3.Row) else row.get("page_start")
        page = _int_or_none(page_start)
        if page is None:
            return []
        source_locations = [{"page_idx": page}]

    locations: list[dict[str, Any]] = []
    for loc in source_locations:
        if not isinstance(loc, dict):
            continue
        page_idx = _int_or_none(loc.get("page_idx"))
        bbox = loc.get("bbox")
        item = {
            "page_idx": page_idx,
            "page_number": page_idx + 1 if page_idx is not None else None,
            "bbox": bbox if isinstance(bbox, list) and len(bbox) >= 4 else None,
            "block_type": loc.get("block_type"),
            "block_index": loc.get("block_index"),
            "source_file": loc.get("source_file"),
        }
        item.update(_location_page_size(loc, item["bbox"], page_idx, page_sizes))
        locations.append(item)
    return locations


def _artifact_locations_from_item(item: dict[str, Any], page_sizes: dict[int, dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = _normalize_source_locations(item, fallback_block_type=str(item.get("type") or "table"))
    if not normalized and item.get("page_idx") is not None:
        normalized = [{"page_idx": item.get("page_idx")}]
    rows = [{"bbox_json": json.dumps(normalized, ensure_ascii=False), "page_start": item.get("page_idx")}]
    return _artifact_locations(rows[0], page_sizes)


def _stringify_title_path(value: Any) -> str:
    if isinstance(value, list):
        return " > ".join(str(x) for x in value if x is not None and str(x).strip())
    return str(value or "")


_STORAGE_PREFIX_RE = re.compile(r"^[0-9a-fA-F]{10}[_-]+")
_KNOWN_FILE_EXTENSIONS = {
    ".pdf",
    ".doc",
    ".docx",
    ".ppt",
    ".pptx",
    ".xls",
    ".xlsx",
    ".md",
}


def _strip_storage_prefix(value: Any) -> str:
    return _STORAGE_PREFIX_RE.sub("", str(value or "").strip())


def _strip_known_file_extension(value: str) -> str:
    path = Path(value)
    if path.suffix.lower() in _KNOWN_FILE_EXTENSIONS:
        return path.with_suffix("").name
    return value


def _document_display_title(doc: dict[str, Any]) -> str:
    title = _strip_storage_prefix(doc.get("title"))
    if title:
        return _strip_known_file_extension(title)
    original_filename = _strip_storage_prefix(doc.get("original_filename"))
    if original_filename:
        return _strip_known_file_extension(original_filename)
    stored_path = str(doc.get("stored_path") or "").strip()
    if stored_path:
        return _strip_known_file_extension(_strip_storage_prefix(Path(stored_path).name))
    return "document"


def _title_path_parts(value: Any) -> list[str]:
    if isinstance(value, list):
        raw_parts = value
    else:
        raw_parts = str(value or "").split(" > ")
    return [_strip_storage_prefix(part) for part in raw_parts if str(part or "").strip()]


def _normalized_chunk_title_path(
    dataset: dict[str, Any],
    doc: dict[str, Any],
    raw_title_path: Any,
    *,
    fallback_leaf: str = "",
) -> str:
    doc_title = _document_display_title(doc)
    stored_stem = _strip_storage_prefix(Path(str(doc.get("stored_path") or "")).stem)
    original_stem = _strip_storage_prefix(Path(str(doc.get("original_filename") or "")).stem)
    skipped = {
        str(dataset.get("dataset_id") or "").strip(),
        Path(str(doc.get("stored_path") or "")).stem,
        stored_stem,
        original_stem,
        doc_title,
    }

    parts: list[str] = [doc_title] if doc_title else []
    for part in _title_path_parts(raw_title_path):
        if not part or part in skipped:
            continue
        parts.append(part)
    leaf = _strip_storage_prefix(fallback_leaf)
    if leaf and leaf not in parts:
        parts.append(leaf)

    deduped: list[str] = []
    for part in parts:
        if part and part not in deduped:
            deduped.append(part)
    return " > ".join(deduped) or doc_title or leaf or "document"


def _iter_final_chunks(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        raw_items = data
    elif isinstance(data, dict):
        raw_items = data.get("chunks") or data.get("items") or data.get("data") or []
    else:
        raw_items = []
    out: list[dict[str, Any]] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        if all(key in item for key in ("start", "end", "date_published")) and not item.get("content"):
            continue
        content = str(item.get("content") or item.get("text") or "")
        if not content.strip():
            continue
        out.append(item)
    return out


def _page_value(item: dict[str, Any]) -> Optional[int]:
    value = item.get("page_number")
    if value is None:
        value = item.get("page")
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _normalize_source_locations(item: dict[str, Any], *, fallback_block_type: str = "") -> list[dict[str, Any]]:
    raw_locations = item.get("source_locations")
    if isinstance(raw_locations, str):
        try:
            raw_locations = json.loads(raw_locations)
        except json.JSONDecodeError:
            raw_locations = []
    if isinstance(raw_locations, dict):
        raw_locations = [raw_locations]
    if not isinstance(raw_locations, list):
        raw_locations = []

    if not raw_locations and item.get("bbox"):
        raw_locations = [
            {
                "page_idx": item.get("page_idx", item.get("page_number")),
                "bbox": item.get("bbox"),
                "block_type": item.get("type") or fallback_block_type,
                "block_index": item.get("original_index", item.get("source_id", item.get("id"))),
                "source_file": item.get("source_file") or "artifact",
            }
        ]

    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for loc in raw_locations:
        if not isinstance(loc, dict) or not loc.get("bbox"):
            continue
        normalized = dict(loc)
        if "page_idx" in normalized:
            normalized["page_idx"] = _int_or_none(normalized.get("page_idx"))
        if not normalized.get("block_type"):
            normalized["block_type"] = item.get("type") or fallback_block_type or None
        key = json.dumps(normalized, ensure_ascii=False, sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        out.append(normalized)
    return out


def _location_page_values(source_locations: list[dict[str, Any]], fallback_page: Optional[int]) -> list[int]:
    pages: list[int] = []
    for loc in source_locations:
        page = _int_or_none(loc.get("page_idx"))
        if page is not None and page not in pages:
            pages.append(page)
    if not pages and fallback_page is not None:
        pages.append(fallback_page)
    return pages


def _location_fields(
    source_locations: list[dict[str, Any]],
    fallback_page: Optional[int],
    fallback_display: str,
) -> dict[str, Any]:
    pages = _location_page_values(source_locations, fallback_page)
    bbox_json = json.dumps(source_locations, ensure_ascii=False) if source_locations else None
    if pages:
        page_start = min(pages)
        page_end = max(pages)
        page_numbers_json = json.dumps(pages, ensure_ascii=False)
    else:
        page_start = None
        page_end = None
        page_numbers_json = None

    display_text = fallback_display
    if source_locations:
        display_text = f"{fallback_display}; bbox_count={len(source_locations)}"

    return {
        "page_start": page_start,
        "page_end": page_end,
        "page_numbers_json": page_numbers_json,
        "bbox_json": bbox_json,
        "display_text": display_text,
    }


def _backfill_document_chunks(dataset: dict[str, Any], doc: dict[str, Any]) -> int:
    root = _dataset_abs_root(dataset)
    stem = Path(str(doc["stored_path"])).stem
    candidates = [
        root / "3_base_final" / f"{stem}.json",
        root / "2_final" / "pdf_v2" / stem / "base_final.json",
        root / "2_final" / "pdf_v2" / stem / "base_processed_chunked.json",
        root / "2_final_pdf_v2" / stem / "base_final.json",
        root / "2_final_pdf_v2" / stem / "base_processed_chunked.json",
    ]
    artifact = next((path for path in candidates if path.is_file()), None)
    if artifact is None:
        logger.warning("未找到 chunk 产物，无法回填: doc=%s stem=%s", doc["doc_id"], stem)
        return 0

    items = _iter_final_chunks(_load_json_artifact(artifact))
    now = _now()
    chunk_rows: list[dict[str, Any]] = []
    location_rows: list[dict[str, Any]] = []

    for idx, item in enumerate(items, start=1):
        content = str(item.get("content") or item.get("text") or "")
        content_hash = _sha256_text(content)
        chunk_id = _sha256_text(f"{dataset['dataset_id']}:{doc['doc_id']}:{idx}:{content_hash}")[:32]
        title_path = _normalized_chunk_title_path(
            dataset,
            doc,
            item.get("title_path") or item.get("title"),
        )
        source_ref_value = item.get("source_id", item.get("id", idx))
        source_ref = str(source_ref_value)
        page_number = _page_value(item)
        source_locations = _normalize_source_locations(item, fallback_block_type="text")
        location_fields = _location_fields(
            source_locations,
            page_number,
            f"page_number={page_number}" if page_number is not None else "document location unavailable",
        )
        content_type = "table" if str(item.get("type") or "").lower() == "table" else "text"
        chunk_rows.append(
            {
                "chunk_id": chunk_id,
                "dataset_id": dataset["dataset_id"],
                "doc_id": doc["doc_id"],
                "chunk_index": idx,
                "content": content,
                "content_type": content_type,
                "title_path": title_path,
                "summary": item.get("title_summary"),
                "token_count": len(content.split()),
                "content_hash": content_hash,
                "prev_chunk_id": None,
                "next_chunk_id": None,
                "source_ref": source_ref,
                "metadata_json": json.dumps(item, ensure_ascii=False),
                "created_at": now,
            }
        )
        location_rows.append(
            {
                "location_id": _sha256_text(f"{chunk_id}:0")[:32],
                "chunk_id": chunk_id,
                "doc_id": doc["doc_id"],
                "location_index": 0,
                "page_start": location_fields["page_start"],
                "page_end": location_fields["page_end"],
                "page_numbers_json": location_fields["page_numbers_json"],
                "slide_start": None,
                "slide_end": None,
                "sheet_name": None,
                "cell_range": None,
                "heading_path": title_path,
                "bbox_json": location_fields["bbox_json"],
                "source_refs_json": json.dumps([source_ref], ensure_ascii=False),
                "display_text": location_fields["display_text"],
                "metadata_json": json.dumps(
                    {
                        "artifact_path": _relative_path(artifact),
                        "pipeline_page_number_is_start_page": True,
                        "source_location_count": len(source_locations),
                    },
                    ensure_ascii=False,
                ),
            }
        )

    for i, row in enumerate(chunk_rows):
        row["prev_chunk_id"] = chunk_rows[i - 1]["chunk_id"] if i > 0 else None
        row["next_chunk_id"] = chunk_rows[i + 1]["chunk_id"] if i + 1 < len(chunk_rows) else None

    with _connect_collection(dataset) as conn:
        conn.execute("DELETE FROM chunk_locations WHERE doc_id = ?", (doc["doc_id"],))
        conn.execute("DELETE FROM chunks WHERE doc_id = ?", (doc["doc_id"],))
        conn.executemany(
            """
            INSERT INTO chunks (
                chunk_id, dataset_id, doc_id, chunk_index, content, content_type,
                title_path, summary, token_count, content_hash, prev_chunk_id,
                next_chunk_id, source_ref, metadata_json, created_at
            ) VALUES (
                :chunk_id, :dataset_id, :doc_id, :chunk_index, :content, :content_type,
                :title_path, :summary, :token_count, :content_hash, :prev_chunk_id,
                :next_chunk_id, :source_ref, :metadata_json, :created_at
            )
            """,
            chunk_rows,
        )
        conn.executemany(
            """
            INSERT INTO chunk_locations (
                location_id, chunk_id, doc_id, location_index, page_start, page_end,
                page_numbers_json, slide_start, slide_end, sheet_name, cell_range,
                heading_path, bbox_json, source_refs_json, display_text, metadata_json
            ) VALUES (
                :location_id, :chunk_id, :doc_id, :location_index, :page_start, :page_end,
                :page_numbers_json, :slide_start, :slide_end, :sheet_name, :cell_range,
                :heading_path, :bbox_json, :source_refs_json, :display_text, :metadata_json
            )
            """,
            location_rows,
        )
        conn.execute(
            "UPDATE documents SET chunk_count = ?, updated_at = ? WHERE doc_id = ?",
            (len(chunk_rows), _now(), doc["doc_id"]),
        )
        conn.commit()
    return len(chunk_rows)


def _table_artifact_items(dataset: dict[str, Any], stem: str) -> tuple[Optional[Path], list[dict[str, Any]]]:
    table_dir = _dataset_abs_root(dataset) / "4_processed_table"
    if not table_dir.exists():
        return None, []

    exact = table_dir / f"{stem}_table_reconstructed.json"
    files = sorted(path for path in table_dir.glob(f"{stem}*") if path.is_file())
    source = exact if exact.is_file() else next((path for path in files if path.suffix.lower() == ".json"), None)
    if source is None:
        return None, []

    data = _load_json_artifact(source)
    if isinstance(data, list):
        raw_items = data
    elif isinstance(data, dict):
        raw_items = data.get("tables") or data.get("items") or data.get("data") or []
    else:
        raw_items = []
    return source, [item for item in raw_items if isinstance(item, dict)]


def _int_or_none(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _delete_table_chunks_for_doc(conn: sqlite3.Connection, doc_id: str) -> None:
    rows = conn.execute(
        "SELECT chunk_id FROM chunks WHERE doc_id = ? AND content_type LIKE '%table%'",
        (doc_id,),
    ).fetchall()
    chunk_ids = [row["chunk_id"] if isinstance(row, sqlite3.Row) else row[0] for row in rows]
    if chunk_ids:
        placeholders = ",".join("?" for _ in chunk_ids)
        conn.execute(f"DELETE FROM chunk_locations WHERE chunk_id IN ({placeholders})", chunk_ids)
    conn.execute("DELETE FROM chunks WHERE doc_id = ? AND content_type LIKE '%table%'", (doc_id,))


def _backfill_document_table_chunks(
    dataset: dict[str, Any],
    doc: dict[str, Any],
    *,
    start_index: int,
) -> int:
    stem = Path(str(doc["stored_path"])).stem
    artifact, items = _table_artifact_items(dataset, stem)
    now = _now()
    chunk_rows: list[dict[str, Any]] = []
    location_rows: list[dict[str, Any]] = []

    if artifact is not None:
        for offset, item in enumerate(items, start=0):
            content = str(item.get("content") or item.get("html") or "")
            if not content.strip():
                continue
            table_number = offset + 1
            chunk_index = start_index + len(chunk_rows)
            original_index = item.get("original_index")
            content_hash = _sha256_text(content)
            chunk_id = _sha256_text(
                f"{dataset['dataset_id']}:{doc['doc_id']}:table:{original_index or table_number}:{content_hash}"
            )[:32]
            caption = str(item.get("table_caption") or "").strip()
            title = caption or f"Table #{table_number}"
            title_path = _normalized_chunk_title_path(
                dataset,
                doc,
                None,
                fallback_leaf=title,
            )
            source_ref = f"table:{original_index if original_index is not None else table_number}"
            page_idx = _int_or_none(item.get("page_idx"))
            fallback_display = (
                f"page_idx={page_idx}; table={original_index if original_index is not None else table_number}"
                if page_idx is not None
                else f"table={original_index if original_index is not None else table_number}"
            )
            source_locations = _normalize_source_locations(item, fallback_block_type="table")
            location_fields = _location_fields(source_locations, page_idx, fallback_display)
            metadata = {
                **item,
                "artifact_path": _relative_path(artifact),
                "content_type": "table",
                "human_page_number": page_idx + 1 if page_idx is not None else None,
            }
            chunk_rows.append(
                {
                    "chunk_id": chunk_id,
                    "dataset_id": dataset["dataset_id"],
                    "doc_id": doc["doc_id"],
                    "chunk_index": chunk_index,
                    "content": content,
                    "content_type": "table",
                    "title_path": title_path,
                    "summary": item.get("summary") or caption,
                    "token_count": len(content.split()),
                    "content_hash": content_hash,
                    "prev_chunk_id": None,
                    "next_chunk_id": None,
                    "source_ref": source_ref,
                    "metadata_json": json.dumps(metadata, ensure_ascii=False),
                    "created_at": now,
                }
            )
            location_rows.append(
                {
                    "location_id": _sha256_text(f"{chunk_id}:0")[:32],
                    "chunk_id": chunk_id,
                    "doc_id": doc["doc_id"],
                    "location_index": 0,
                    "page_start": location_fields["page_start"],
                    "page_end": location_fields["page_end"],
                    "page_numbers_json": location_fields["page_numbers_json"],
                    "slide_start": None,
                    "slide_end": None,
                    "sheet_name": None,
                    "cell_range": None,
                    "heading_path": title_path,
                    "bbox_json": location_fields["bbox_json"],
                    "source_refs_json": json.dumps([source_ref], ensure_ascii=False),
                    "display_text": location_fields["display_text"],
                    "metadata_json": json.dumps(
                        {
                            "artifact_path": _relative_path(artifact),
                            "original_index": original_index,
                            "table_caption": caption,
                            "table_footnote": item.get("table_footnote") or "",
                            "pipeline_page_idx_is_zero_based": True,
                            "source_location_count": len(source_locations),
                        },
                        ensure_ascii=False,
                    ),
                }
            )

    for i, row in enumerate(chunk_rows):
        row["prev_chunk_id"] = chunk_rows[i - 1]["chunk_id"] if i > 0 else None
        row["next_chunk_id"] = chunk_rows[i + 1]["chunk_id"] if i + 1 < len(chunk_rows) else None

    with _connect_collection(dataset) as conn:
        _delete_table_chunks_for_doc(conn, doc["doc_id"])
        if chunk_rows:
            conn.executemany(
                """
                INSERT INTO chunks (
                    chunk_id, dataset_id, doc_id, chunk_index, content, content_type,
                    title_path, summary, token_count, content_hash, prev_chunk_id,
                    next_chunk_id, source_ref, metadata_json, created_at
                ) VALUES (
                    :chunk_id, :dataset_id, :doc_id, :chunk_index, :content, :content_type,
                    :title_path, :summary, :token_count, :content_hash, :prev_chunk_id,
                    :next_chunk_id, :source_ref, :metadata_json, :created_at
                )
                """,
                chunk_rows,
            )
            conn.executemany(
                """
                INSERT INTO chunk_locations (
                    location_id, chunk_id, doc_id, location_index, page_start, page_end,
                    page_numbers_json, slide_start, slide_end, sheet_name, cell_range,
                    heading_path, bbox_json, source_refs_json, display_text, metadata_json
                ) VALUES (
                    :location_id, :chunk_id, :doc_id, :location_index, :page_start, :page_end,
                    :page_numbers_json, :slide_start, :slide_end, :sheet_name, :cell_range,
                    :heading_path, :bbox_json, :source_refs_json, :display_text, :metadata_json
                )
                """,
                location_rows,
            )
        total = conn.execute("SELECT COUNT(*) FROM chunks WHERE doc_id = ?", (doc["doc_id"],)).fetchone()[0]
        conn.execute(
            "UPDATE documents SET chunk_count = ?, updated_at = ? WHERE doc_id = ?",
            (int(total or 0), _now(), doc["doc_id"]),
        )
        conn.commit()
    return len(chunk_rows)


def _index_path_ready(index_type: str, path: Path) -> bool:
    if index_type in ("chroma", "ts_chroma", "table_chroma"):
        return _chroma_embedding_count(path) > 0
    return _dir_has_nonempty_file(path)


def _sync_index_registry(
    dataset: dict[str, Any],
    doc_ids: list[str],
    *,
    text_chunk_count: int,
    table_chunk_count: int,
) -> None:
    persist = _dataset_abs_persist(dataset)
    collection_name = _index_collection_name(dataset)
    indexes = {
        "chroma": persist / "chroma",
        "ts_chroma": persist / "ts_chroma",
        "table_chroma": persist / "table_chroma",
        "bm25": persist / "bm25_index" / collection_name,
        "pageindex": persist / "pageindex",
    }
    now = _now()
    rows = []
    for index_type, path in indexes.items():
        source_chunk_count = table_chunk_count if index_type == "table_chroma" else text_chunk_count
        rows.append(
            {
                "index_id": f"{dataset['dataset_id']}:{index_type}",
                "dataset_id": dataset["dataset_id"],
                "index_type": index_type,
                "collection_name": collection_name,
                "index_path": _relative_path(path),
                "source_doc_ids_json": json.dumps(doc_ids, ensure_ascii=False),
                "source_chunk_count": source_chunk_count,
                "status": "ready" if _index_path_ready(index_type, path) else "stale",
                "built_at": now,
                "error_message": None,
                "metadata_json": None,
            }
        )
    with _connect_collection(dataset) as conn:
        conn.executemany(
            """
            INSERT INTO index_registry (
                index_id, dataset_id, index_type, collection_name, index_path,
                source_doc_ids_json, source_chunk_count, status, built_at,
                error_message, metadata_json
            ) VALUES (
                :index_id, :dataset_id, :index_type, :collection_name, :index_path,
                :source_doc_ids_json, :source_chunk_count, :status, :built_at,
                :error_message, :metadata_json
            )
            ON CONFLICT(index_id) DO UPDATE SET
                collection_name = excluded.collection_name,
                index_path = excluded.index_path,
                source_doc_ids_json = excluded.source_doc_ids_json,
                source_chunk_count = excluded.source_chunk_count,
                status = excluded.status,
                built_at = excluded.built_at,
                error_message = excluded.error_message,
                metadata_json = excluded.metadata_json
            """,
            rows,
        )
        conn.commit()


def _sync_pipeline_outputs(dataset: dict[str, Any], doc_ids: list[str], *, mark_status: str) -> int:
    if not doc_ids:
        return 0
    placeholders = ",".join("?" for _ in doc_ids)
    with _connect_collection(dataset) as conn:
        docs = conn.execute(
            f"SELECT * FROM documents WHERE doc_id IN ({placeholders}) AND file_type = 'pdf'",
            doc_ids,
        ).fetchall()
    total_text_chunks = 0
    total_table_chunks = 0
    failed_docs: list[str] = []
    for row in docs:
        doc = _row_to_dict(row)
        try:
            text_count = _backfill_document_chunks(dataset, doc)
            table_count = _backfill_document_table_chunks(dataset, doc, start_index=text_count + 1)
            total_text_chunks += text_count
            total_table_chunks += table_count
            if text_count + table_count == 0:
                failed_docs.append(doc["doc_id"])
        except Exception:
            logger.exception("回填 chunks 失败: dataset=%s doc=%s", dataset["dataset_id"], doc["doc_id"])
            failed_docs.append(doc["doc_id"])

    successful_doc_ids = [row["doc_id"] for row in docs if row["doc_id"] not in set(failed_docs)]
    if successful_doc_ids:
        _update_documents_status(dataset, successful_doc_ids, mark_status)
    if failed_docs:
        _update_documents_status(dataset, failed_docs, "failed", error_message="pipeline 完成但未能回填 chunks")
    _sync_index_registry(
        dataset,
        doc_ids,
        text_chunk_count=total_text_chunks,
        table_chunk_count=total_table_chunks,
    )
    return total_text_chunks + total_table_chunks


def _sync_partial_pipeline_outputs_after_failure(
    dataset: dict[str, Any],
    doc_ids: list[str],
    *,
    skip_load: bool,
) -> tuple[dict[str, Any], int, Optional[str]]:
    """Best-effort sync for pipelines that failed after writing usable indexes."""
    refreshed = _refresh_dataset_status(dataset, force=True)
    doc_status = "indexed" if refreshed["status"] == "indexed" and not skip_load else "parsed"
    try:
        chunk_count = _sync_pipeline_outputs(refreshed, doc_ids, mark_status=doc_status)
        return _refresh_dataset_status(refreshed, force=True), chunk_count, None
    except Exception as exc:
        logger.exception(
            "[dataset ingest] partial output sync failed: dataset=%s docs=%s",
            dataset.get("dataset_id"),
            doc_ids,
        )
        return refreshed, 0, str(exc)


def _job_with_files(dataset: dict[str, Any], row: sqlite3.Row) -> dict[str, Any]:
    job = _row_to_dict(row)
    doc_ids = _doc_ids_from_job(job)
    if not doc_ids:
        job["files"] = []
        return job
    placeholders = ",".join("?" for _ in doc_ids)
    with _connect_collection(dataset) as conn:
        docs = conn.execute(
            f"SELECT * FROM documents WHERE doc_id IN ({placeholders}) ORDER BY created_at ASC",
            doc_ids,
        ).fetchall()
    job["files"] = [_document_payload(dataset, doc) for doc in docs]
    return job


def _ingest_env(log_file: str) -> dict[str, str]:
    env = os.environ.copy()
    env["INGEST_LOG_FILE"] = log_file
    env["PYTHONPATH"] = (
        str(REPO_ROOT / "src")
        + os.pathsep
        + str(DATA_PIPELINE_DIR)
        + os.pathsep
        + env.get("PYTHONPATH", "")
    )
    return env


def _run_logged_command(
    *,
    job_id: str,
    label: str,
    cmd: list[str],
    log_f: Any,
    env: dict[str, str],
) -> int:
    logger.info("[dataset ingest %s] [%s] %s", job_id, label, " ".join(cmd))
    log_f.write(f"\n{'=' * 80}\n[{label}] started at {_now()}\n")
    log_f.write("CMD: " + " ".join(cmd) + "\n\n")
    log_f.flush()
    proc = subprocess.run(
        cmd,
        cwd=str(REPO_ROOT),
        env=env,
        stdout=log_f,
        stderr=subprocess.STDOUT,
        timeout=None,
    )
    log_f.write(f"\n[{label}] finished at {_now()} returncode={proc.returncode}\n")
    log_f.flush()
    return int(proc.returncode)


def _doc_abs_path(doc: dict[str, Any]) -> Path:
    return _abs_path(str(doc["stored_path"]))


def _chunk_count_for_docs(dataset: dict[str, Any], doc_ids: list[str]) -> int:
    if not doc_ids:
        return 0
    placeholders = ",".join("?" for _ in doc_ids)
    with _connect_collection(dataset) as conn:
        row = conn.execute(
            f"SELECT COUNT(*) FROM chunks WHERE doc_id IN ({placeholders})",
            doc_ids,
        ).fetchone()
    return int((row[0] if row else 0) or 0)


def _reload_chat_after_index(dataset_id: str, reason: str) -> str:
    try:
        did_reload = app_module.reload_chat_stack_after_dataset_ingest(dataset_id, reason)
        return "已热重载，可直接检索。" if did_reload else "当前 active dataset 未热重载或已关闭自动热重载。"
    except Exception as reload_exc:
        logger.exception("[dataset ingest] 热重载失败: %s", reason)
        return f"热重载失败：{reload_exc!s}。请重启 API 后再检索。"


def _run_pdf_ingest_batch(
    *,
    job_id: str,
    dataset_id: str,
    pdf_paths: list[str],
    doc_ids: list[str],
    config_path: str,
    extra_args: list[str],
    log_f: Any,
    env: dict[str, str],
    skip_load: bool,
) -> tuple[int, list[str], list[str]]:
    if not doc_ids:
        return 0, [], []
    cmd: list[str] = [sys.executable, str(INGEST_SCRIPT), "--config", config_path]
    for path in pdf_paths:
        cmd += ["--pdf", path]
    cmd += extra_args
    code = _run_logged_command(job_id=job_id, label="PDF batch", cmd=cmd, log_f=log_f, env=env)

    dataset = _require_dataset(dataset_id, refresh=False)
    if code == 0:
        refreshed = _refresh_dataset_status(dataset, force=True)
        doc_status = "indexed" if refreshed["status"] == "indexed" and not skip_load else "parsed"
        chunk_count = _sync_pipeline_outputs(refreshed, doc_ids, mark_status=doc_status)
        return chunk_count, [], []

    refreshed, chunk_count, sync_error = _sync_partial_pipeline_outputs_after_failure(
        dataset,
        doc_ids,
        skip_load=skip_load,
    )
    if chunk_count > 0 and refreshed["status"] == "indexed":
        warning = f"PDF batch 非零退出 code={code}，但已同步 {chunk_count} 个可用 chunk。"
        if sync_error:
            warning += f" partial sync warning: {sync_error}"
        return chunk_count, [], [warning]

    tail = _read_log_tail(Path(log_f.name))
    error = f"PDF batch 失败 code={code}。错误尾部：\n{tail}"
    if sync_error:
        error += f"\nPartial output sync failed: {sync_error}"
    _update_documents_status(dataset, doc_ids, "failed", error_message=error)
    return 0, [error], []


def _run_semantic_file_batch(
    *,
    job_id: str,
    dataset: dict[str, Any],
    docs: list[dict[str, Any]],
    file_type: str,
    pipeline_script: Path,
    load_data_script: Path,
    load_table_script: Path,
    input_arg: str,
    default_doc_type: str,
    log_f: Any,
    env: dict[str, str],
    skip_load: bool,
    skip_load_table: bool,
    enable_word_image_ocr: bool,
    mineru_bin: str,
) -> tuple[int, list[str], list[str]]:
    if not docs:
        return 0, [], []
    missing = [
        str(path)
        for path in (pipeline_script, load_data_script, load_table_script)
        if not path.is_file()
    ]
    if missing:
        message = f"{file_type} pipeline 缺少脚本: {', '.join(missing)}"
        _update_documents_status(dataset, [doc["doc_id"] for doc in docs], "failed", error_message=message)
        return 0, [message], []

    dataset_root = _dataset_abs_root(dataset)
    collection_name = _index_collection_name(dataset)
    success_doc_ids: list[str] = []
    errors: list[str] = []
    warnings: list[str] = []

    for doc in docs:
        doc_id = str(doc["doc_id"])
        doc_type = str(doc.get("doc_type") or default_doc_type)
        cmd = [
            sys.executable,
            str(pipeline_script),
            input_arg,
            str(_doc_abs_path(doc)),
            "--dataset-root",
            str(dataset_root),
            "--dataset-id",
            str(dataset["dataset_id"]),
            "--doc-id",
            doc_id,
            "--doc-type",
            doc_type,
            "--write-db",
        ]
        if file_type == "word" and enable_word_image_ocr:
            cmd.append("--enable-image-ocr")
            if mineru_bin:
                cmd += ["--mineru-bin", mineru_bin]
        code = _run_logged_command(
            job_id=job_id,
            label=f"{file_type.upper()} parse {doc.get('original_filename') or doc_id}",
            cmd=cmd,
            log_f=log_f,
            env=env,
        )
        if code == 0:
            success_doc_ids.append(doc_id)
        else:
            error = f"{file_type} parse failed: {doc.get('original_filename') or doc_id} code={code}"
            errors.append(error)
            _update_documents_status(dataset, [doc_id], "failed", error_message=error)

    if not success_doc_ids:
        return 0, errors, warnings

    if skip_load:
        _update_documents_status(dataset, success_doc_ids, "parsed")
        return _chunk_count_for_docs(dataset, success_doc_ids), errors, warnings

    load_data_cmd = [
        sys.executable,
        str(load_data_script),
        "--config",
        str(CONFIG_PATH),
        "--dataset-root",
        str(dataset_root),
        "--collection",
        collection_name,
    ]
    code = _run_logged_command(
        job_id=job_id,
        label=f"{file_type.upper()} load_data",
        cmd=load_data_cmd,
        log_f=log_f,
        env=env,
    )
    if code != 0:
        error = f"{file_type} load_data failed code={code}"
        errors.append(error)
        _update_documents_status(dataset, success_doc_ids, "failed", error_message=error)
        return _chunk_count_for_docs(dataset, success_doc_ids), errors, warnings

    if not skip_load_table:
        load_table_cmd = [
            sys.executable,
            str(load_table_script),
            "--config",
            str(CONFIG_PATH),
            "--dataset-root",
            str(dataset_root),
            "--collection",
            collection_name,
        ]
        code = _run_logged_command(
            job_id=job_id,
            label=f"{file_type.upper()} load_table_chroma",
            cmd=load_table_cmd,
            log_f=log_f,
            env=env,
        )
        if code != 0:
            error = f"{file_type} load_table_chroma failed code={code}"
            errors.append(error)
            _update_documents_status(dataset, success_doc_ids, "failed", error_message=error)
            return _chunk_count_for_docs(dataset, success_doc_ids), errors, warnings

    _update_documents_status(dataset, success_doc_ids, "indexed")
    return _chunk_count_for_docs(dataset, success_doc_ids), errors, warnings


def _ingest_subprocess_worker(
    *,
    job_id: str,
    dataset_id: str,
    pdf_paths: list[str],
    pdf_doc_ids: list[str],
    word_docs: list[dict[str, Any]],
    excel_docs: list[dict[str, Any]],
    md_docs: list[dict[str, Any]],
    config_path: str,
    extra_args: list[str],
    log_file: str,
    skip_load: bool,
    skip_load_table: bool,
    enable_word_image_ocr: bool,
    mineru_bin: str,
) -> None:
    dataset = _require_dataset(dataset_id, refresh=False)
    process_doc_ids = [
        *pdf_doc_ids,
        *(str(doc["doc_id"]) for doc in word_docs),
        *(str(doc["doc_id"]) for doc in excel_docs),
        *(str(doc["doc_id"]) for doc in md_docs),
    ]
    _update_job(
        dataset,
        job_id,
        status="running",
        started_at=_now(),
        log_path=_relative_path(Path(log_file)),
        message="pipeline 运行中",
    )
    _update_documents_status(dataset, process_doc_ids, "parsing")
    _set_dataset_status(dataset_id, "indexing")

    env = _ingest_env(log_file)
    log_path = Path(log_file)
    errors: list[str] = []
    warnings: list[str] = []
    total_chunks = 0
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "w", encoding="utf-8") as log_f:
            log_f.write(f"{'=' * 80}\n[dataset ingest {job_id}] started at {_now()}\n")
            log_f.write(
                "Batches: "
                f"pdf={len(pdf_doc_ids)}, word={len(word_docs)}, excel={len(excel_docs)}, md={len(md_docs)}, "
                f"skip_load={skip_load}, skip_load_table={skip_load_table}\n"
            )
            log_f.flush()

            pdf_chunks, pdf_errors, pdf_warnings = _run_pdf_ingest_batch(
                job_id=job_id,
                dataset_id=dataset_id,
                pdf_paths=pdf_paths,
                doc_ids=pdf_doc_ids,
                config_path=config_path,
                extra_args=extra_args,
                log_f=log_f,
                env=env,
                skip_load=skip_load,
            )
            total_chunks += pdf_chunks
            errors.extend(pdf_errors)
            warnings.extend(pdf_warnings)

            dataset = _require_dataset(dataset_id, refresh=False)
            word_chunks, word_errors, word_warnings = _run_semantic_file_batch(
                job_id=job_id,
                dataset=dataset,
                docs=word_docs,
                file_type="word",
                pipeline_script=WORD_PIPELINE_SCRIPT,
                load_data_script=WORD_LOAD_DATA_SCRIPT,
                load_table_script=WORD_LOAD_TABLE_SCRIPT,
                input_arg="--file",
                default_doc_type="research_report",
                log_f=log_f,
                env=env,
                skip_load=skip_load,
                skip_load_table=skip_load_table,
                enable_word_image_ocr=enable_word_image_ocr,
                mineru_bin=mineru_bin,
            )
            total_chunks += word_chunks
            errors.extend(word_errors)
            warnings.extend(word_warnings)

            dataset = _require_dataset(dataset_id, refresh=False)
            excel_chunks, excel_errors, excel_warnings = _run_semantic_file_batch(
                job_id=job_id,
                dataset=dataset,
                docs=excel_docs,
                file_type="excel",
                pipeline_script=EXCEL_PIPELINE_SCRIPT,
                load_data_script=EXCEL_LOAD_DATA_SCRIPT,
                load_table_script=EXCEL_LOAD_TABLE_SCRIPT,
                input_arg="--excel",
                default_doc_type="valuation_model",
                log_f=log_f,
                env=env,
                skip_load=skip_load,
                skip_load_table=skip_load_table,
                enable_word_image_ocr=False,
                mineru_bin="",
            )
            total_chunks += excel_chunks
            errors.extend(excel_errors)
            warnings.extend(excel_warnings)

            dataset = _require_dataset(dataset_id, refresh=False)
            md_chunks, md_errors, md_warnings = _run_semantic_file_batch(
                job_id=job_id,
                dataset=dataset,
                docs=md_docs,
                file_type="md",
                pipeline_script=MD_PIPELINE_SCRIPT,
                load_data_script=MD_LOAD_DATA_SCRIPT,
                load_table_script=MD_LOAD_TABLE_SCRIPT,
                input_arg="--file",
                default_doc_type="research_note",
                log_f=log_f,
                env=env,
                skip_load=skip_load,
                skip_load_table=skip_load_table,
                enable_word_image_ocr=False,
                mineru_bin="",
            )
            total_chunks += md_chunks
            errors.extend(md_errors)
            warnings.extend(md_warnings)

        dataset = _require_dataset(dataset_id, refresh=False)
        refreshed = _refresh_dataset_status(dataset, force=True)
        if refreshed["status"] == "indexed" and not skip_load:
            warnings.append(_reload_chat_after_index(dataset_id, f"dataset ingest job_id={job_id}"))
        elif not errors:
            refreshed = _refresh_dataset_status(refreshed, force=True)

        if errors and refreshed["status"] != "indexed":
            _set_dataset_status(dataset_id, "failed")
            refreshed = _require_dataset(dataset_id, refresh=False)

        status = "failed" if errors else "completed"
        message_parts = [f"pipeline 已完成，回填/登记 {total_chunks} 个 chunk。"]
        if warnings:
            message_parts.append("Warnings: " + " | ".join(warnings[:5]))
        if errors:
            message_parts.append("Errors: " + " | ".join(errors[:5]))
        _update_job(
            refreshed,
            job_id,
            status=status,
            message="\n".join(message_parts),
            returncode=1 if errors else 0,
            finished_at=_now(),
            log_path=_relative_path(log_path),
        )
    except Exception as exc:
        logger.exception("[dataset ingest %s] failed", job_id)
        dataset = _require_dataset(dataset_id, refresh=False)
        _update_documents_status(dataset, process_doc_ids, "failed", error_message=str(exc))
        refreshed = _refresh_dataset_status(dataset, force=True)
        if refreshed["status"] != "indexed":
            _set_dataset_status(dataset_id, "failed")
        _update_job(
            dataset,
            job_id,
            status="failed",
            message=str(exc),
            finished_at=_now(),
            log_path=_relative_path(log_path),
        )


def _chunks_for_document(
    dataset: dict[str, Any],
    doc_id: str,
    max_chunks: int,
    page_sizes: Optional[dict[int, dict[str, Any]]] = None,
) -> dict[str, Any]:
    page_sizes = page_sizes or {}
    with _connect_collection(dataset) as conn:
        total = conn.execute(
            "SELECT COUNT(*) FROM chunks WHERE doc_id = ? AND (content_type IS NULL OR content_type NOT LIKE '%table%')",
            (doc_id,),
        ).fetchone()[0]
        rows = conn.execute(
            """
            SELECT c.*, l.page_start, l.page_end, l.page_numbers_json,
                   l.bbox_json, l.display_text
            FROM chunks c
            LEFT JOIN chunk_locations l
              ON l.chunk_id = c.chunk_id AND l.location_index = 0
            WHERE c.doc_id = ? AND (c.content_type IS NULL OR c.content_type NOT LIKE '%table%')
            ORDER BY c.chunk_index ASC
            LIMIT ?
            """,
            (doc_id, max_chunks),
        ).fetchall()
    items = []
    for row in rows:
        title = row["title_path"] or f"Chunk #{row['chunk_index']}"
        items.append(
            {
                "index": row["chunk_index"],
                "id": row["chunk_id"],
                "page_number": row["page_start"],
                "page_end": row["page_end"],
                "type": row["content_type"],
                "title": title,
                "title_summary": row["summary"],
                "content": row["content"],
                "source_ref": row["source_ref"],
                "display_text": row["display_text"],
                "locations": _artifact_locations(row, page_sizes),
            }
        )
    return {
        "available": bool(total),
        "total": int(total or 0),
        "items": items,
        "truncated": int(total or 0) > len(items),
    }


def _tables_for_document(
    dataset: dict[str, Any],
    doc_id: str,
    max_tables: int,
    page_sizes: Optional[dict[int, dict[str, Any]]] = None,
) -> dict[str, Any]:
    page_sizes = page_sizes or {}
    with _connect_collection(dataset) as conn:
        total = conn.execute(
            "SELECT COUNT(*) FROM chunks WHERE doc_id = ? AND content_type LIKE '%table%'",
            (doc_id,),
        ).fetchone()[0]
        rows = conn.execute(
            """
            SELECT c.*, l.page_start, l.page_end, l.page_numbers_json,
                   l.bbox_json, l.display_text
            FROM chunks c
            LEFT JOIN chunk_locations l
              ON l.chunk_id = c.chunk_id AND l.location_index = 0
            WHERE c.doc_id = ? AND c.content_type LIKE '%table%'
            ORDER BY c.chunk_index ASC
            LIMIT ?
            """,
            (doc_id, max_tables),
        ).fetchall()

    items = []
    for idx, row in enumerate(rows, start=1):
        try:
            metadata = json.loads(row["metadata_json"] or "{}")
        except json.JSONDecodeError:
            metadata = {}
        page_idx = metadata.get("page_idx", row["page_start"])
        page_number = metadata.get("human_page_number")
        if page_number is None and row["page_start"] is not None:
            page_number = int(row["page_start"]) + 1
        items.append(
            {
                "index": idx,
                "id": row["chunk_id"],
                "type": row["content_type"] or "table",
                "summary": row["summary"] or "",
                "content": row["content"],
                "page_idx": page_idx,
                "page_number": page_number,
                "caption": metadata.get("table_caption") or "",
                "footnote": metadata.get("table_footnote") or "",
                "original_index": metadata.get("original_index"),
                "source_ref": row["source_ref"],
                "display_text": row["display_text"],
                "locations": _artifact_locations(row, page_sizes),
            }
        )
    return {
        "available": bool(total),
        "files": [],
        "items": items,
        "total": int(total or 0),
        "truncated": int(total or 0) > len(items),
    }


def _pageindex_artifacts_for_file(dataset: dict[str, Any], stem: str) -> dict[str, Any]:
    index_dir = _dataset_abs_persist(dataset) / "pageindex"
    if not index_dir.exists():
        return {"available": False, "files": [], "structure": []}

    files = sorted(path for path in index_dir.glob(f"{stem}*") if path.is_file())
    exact = index_dir / f"{stem}_structure.json"
    source = exact if exact.is_file() else next((path for path in files if path.suffix.lower() == ".json"), None)
    manifest = [{"name": path.name, "size_bytes": path.stat().st_size if path.exists() else None} for path in files[:50]]
    if source is None:
        return {"available": False, "files": manifest, "structure": []}

    data = _load_json_artifact(source)
    if isinstance(data, dict):
        structure = data.get("structure") if isinstance(data.get("structure"), list) else []
        doc_name = data.get("doc_name")
        doc_description = data.get("doc_description")
    elif isinstance(data, list):
        structure = data
        doc_name = source.name
        doc_description = ""
    else:
        structure = []
        doc_name = source.name
        doc_description = ""

    nodes = []
    for idx, node in enumerate(structure[:200], start=1):
        if not isinstance(node, dict):
            continue
        nodes.append(
            {
                "index": idx,
                "node_id": node.get("node_id"),
                "title": node.get("title"),
                "start_index": node.get("start_index"),
                "end_index": node.get("end_index"),
                "summary": node.get("summary"),
            }
        )
    return {
        "available": True,
        "doc_name": doc_name,
        "doc_description": doc_description,
        "files": manifest,
        "structure": nodes,
        "total_nodes": len(structure),
        "truncated": len(structure) > len(nodes),
    }


def _table_artifacts_for_file(
    dataset: dict[str, Any],
    stem: str,
    max_tables: int,
    page_sizes: Optional[dict[int, dict[str, Any]]] = None,
) -> dict[str, Any]:
    page_sizes = page_sizes or {}
    table_dir = _dataset_abs_root(dataset) / "4_processed_table"
    if not table_dir.exists():
        return {"available": False, "files": [], "items": [], "total": 0, "truncated": False}

    files = sorted(path for path in table_dir.glob(f"{stem}*") if path.is_file())
    exact = table_dir / f"{stem}_table_reconstructed.json"
    source = exact if exact.is_file() else next((path for path in files if path.suffix.lower() == ".json"), None)
    manifest = [{"name": path.name, "size_bytes": path.stat().st_size if path.exists() else None} for path in files[:50]]
    if source is None:
        return {"available": False, "files": manifest, "items": [], "total": 0, "truncated": False}

    data = _load_json_artifact(source)
    if isinstance(data, list):
        raw_items = data
    elif isinstance(data, dict):
        raw_items = data.get("tables") or data.get("items") or data.get("data") or []
    else:
        raw_items = []

    items = []
    for idx, item in enumerate(raw_items[:max_tables], start=1):
        if not isinstance(item, dict):
            continue
        content = str(item.get("content") or item.get("html") or "")
        if not content.strip():
            continue
        page_idx = item.get("page_idx")
        try:
            page_number = int(page_idx) + 1 if page_idx is not None else None
        except (TypeError, ValueError):
            page_number = None
        items.append(
            {
                "index": idx,
                "type": item.get("type") or "table",
                "summary": item.get("summary") or "",
                "content": content,
                "page_idx": page_idx,
                "page_number": page_number,
                "caption": item.get("table_caption") or "",
                "footnote": item.get("table_footnote") or "",
                "original_index": item.get("original_index"),
                "locations": _artifact_locations_from_item(item, page_sizes),
            }
        )

    total = len(raw_items)
    return {
        "available": bool(total),
        "files": manifest,
        "items": items,
        "total": total,
        "truncated": total > len(items),
    }


@router.get("/datasets")
async def list_datasets():
    init_dataset_registry()
    with _connect_registry() as conn:
        rows = conn.execute("SELECT * FROM datasets ORDER BY created_at ASC").fetchall()
        active = conn.execute("SELECT active_dataset_id FROM dataset_state WHERE id = 1").fetchone()
    active_id = _normalize_active_id(active["active_dataset_id"] if active else None)
    datasets = []
    for row in rows:
        dataset = _refresh_dataset_status(_row_to_dict(row))
        payload = _dataset_payload(dataset)
        payload["stats"] = _dataset_stats(dataset)
        datasets.append(payload)
    return {
        "active_dataset_id": active_id,
        "datasets": datasets,
        "root_dir": str(_dataset_root_from_config()),
    }


@router.post("/datasets", status_code=201)
async def create_dataset(body: DatasetCreateRequest):
    init_dataset_registry()
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name 不能为空")
    with _connect_registry() as conn:
        for _ in range(20):
            dataset_id = _generate_dataset_id()
            if not conn.execute("SELECT 1 FROM datasets WHERE dataset_id = ?", (dataset_id,)).fetchone():
                break
        else:
            raise HTTPException(status_code=500, detail="failed to generate dataset_id")
        dataset = _build_dataset_record(name, dataset_id)
        _ensure_dataset_dirs(dataset)
        _insert_dataset(conn, dataset)
        active = conn.execute("SELECT active_dataset_id FROM dataset_state WHERE id = 1").fetchone()
        if not active or not active["active_dataset_id"]:
            conn.execute(
                "INSERT OR REPLACE INTO dataset_state (id, active_dataset_id, updated_at) VALUES (1, ?, ?)",
                (dataset_id, _now()),
            )
        conn.commit()
    return _dataset_payload(dataset)


@router.get("/datasets/{dataset_id}")
async def get_dataset(dataset_id: str):
    dataset = _require_dataset(dataset_id)
    payload = _dataset_payload(dataset)
    payload["stats"] = _dataset_stats(dataset)
    return payload


@router.post("/datasets/{dataset_id}/activate")
async def activate_dataset(dataset_id: str):
    dataset = activate_dataset_in_registry(dataset_id)
    return {"active_dataset_id": dataset_id, "dataset": _dataset_payload(dataset)}


@router.get("/datasets/{dataset_id}/files")
async def list_dataset_files(dataset_id: str):
    dataset = _require_dataset(dataset_id)
    return {"dataset_id": dataset_id, "files": _dataset_documents(dataset)}


@router.get("/datasets/{dataset_id}/files/{file_id}/pdf")
async def get_dataset_file_pdf(dataset_id: str, file_id: str):
    dataset = _require_dataset(dataset_id)
    item = _resolve_dataset_file(dataset, file_id)
    if item.get("file_type") != "pdf":
        raise HTTPException(status_code=400, detail="该文件不是 PDF")
    path = Path(item["resolved_path"])
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=item.get("original_filename") or path.name,
    )


@router.get("/datasets/{dataset_id}/files/{file_id}/artifacts")
async def get_dataset_file_artifacts(
    dataset_id: str,
    file_id: str,
    max_chunks: int = Query(80, ge=1, le=500),
    max_tables: int = Query(50, ge=1, le=200),
):
    dataset = _require_dataset(dataset_id)
    item = _resolve_dataset_file(dataset, file_id)
    stem = Path(item["resolved_path"]).stem
    page_sizes = _page_sizes_for_stem(dataset, stem)
    tables = _tables_for_document(dataset, item["doc_id"], max_tables, page_sizes)
    if not tables["available"]:
        tables = _table_artifacts_for_file(dataset, stem, max_tables, page_sizes)
    return {
        "dataset_id": dataset_id,
        "file": {
            "file_id": file_id,
            "doc_id": item.get("doc_id"),
            "original_filename": item.get("original_filename"),
            "stored_path": item.get("stored_path"),
            "file_type": item.get("file_type"),
            "stem": stem,
        },
        "chunks": _chunks_for_document(dataset, item["doc_id"], max_chunks, page_sizes),
        "pageindex": _pageindex_artifacts_for_file(dataset, stem),
        "tables": tables,
    }


@router.get("/datasets/{dataset_id}/jobs")
async def list_dataset_jobs(
    dataset_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
):
    dataset = _require_dataset(dataset_id)
    offset = (page - 1) * page_size
    with _connect_collection(dataset) as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM ingest_jobs
            WHERE dataset_id = ?
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            (dataset_id, page_size + 1, offset),
        ).fetchall()
    has_more = len(rows) > page_size
    jobs = [_job_with_files(dataset, row) for row in rows[:page_size]]
    return {
        "dataset_id": dataset_id,
        "jobs": jobs,
        "page": page,
        "page_size": page_size,
        "has_more": has_more,
    }


@router.get("/datasets/{dataset_id}/jobs/{job_id}")
async def get_dataset_job(dataset_id: str, job_id: str):
    dataset = _require_dataset(dataset_id)
    with _connect_collection(dataset) as conn:
        row = conn.execute(
            "SELECT * FROM ingest_jobs WHERE dataset_id = ? AND job_id = ?",
            (dataset_id, job_id),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="未知 job_id")
    return _job_with_files(dataset, row)


@router.get("/datasets/{dataset_id}/chunks")
async def list_dataset_chunks(
    dataset_id: str,
    doc_id: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    dataset = _require_dataset(dataset_id)
    offset = (page - 1) * page_size
    params: list[Any] = [dataset_id]
    where = "dataset_id = ?"
    if doc_id:
        where += " AND doc_id = ?"
        params.append(doc_id)
    with _connect_collection(dataset) as conn:
        rows = conn.execute(
            f"""
            SELECT chunk_id, dataset_id, doc_id, chunk_index, content_type,
                   title_path, summary, token_count, content_hash, prev_chunk_id,
                   next_chunk_id, source_ref, created_at
            FROM chunks
            WHERE {where}
            ORDER BY doc_id ASC, chunk_index ASC
            LIMIT ? OFFSET ?
            """,
            params + [page_size + 1, offset],
        ).fetchall()
    return {
        "dataset_id": dataset_id,
        "chunks": [_row_to_dict(row) for row in rows[:page_size]],
        "page": page,
        "page_size": page_size,
        "has_more": len(rows) > page_size,
    }


@router.get("/datasets/{dataset_id}/indexes")
async def list_dataset_indexes(dataset_id: str):
    dataset = _require_dataset(dataset_id)
    with _connect_collection(dataset) as conn:
        rows = conn.execute(
            "SELECT * FROM index_registry WHERE dataset_id = ? ORDER BY index_type ASC",
            (dataset_id,),
        ).fetchall()
    return {"dataset_id": dataset_id, "indexes": [_row_to_dict(row) for row in rows]}


@router.post("/datasets/{dataset_id}/upload", status_code=201)
async def upload_dataset_files(
    dataset_id: str,
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(..., description="PDF/Word/PPT/Excel/Markdown 文件"),
    company_name: str = Query("", description="公司名；省略则使用资料库名称"),
    doc_type: str = Query("", description="文档类型，如 财报/公告/研报/纪要/估值模型"),
    source_type: str = Query("unknown", description="company_public | market_public | client_internal | generated | unknown"),
    source_name: str = Query("", description="来源名称"),
    company_ticker: str = Query("", description="股票代码"),
    document_date: str = Query("", description="文档日期"),
    mineru_bin: str = Query("", description="mineru 可执行文件绝对路径；空则使用 production.yaml 或脚本默认值"),
    skip_mineru: bool = Query(False, description="已存在 mineru 输出时跳过"),
    skip_file2chunk: bool = Query(False, description="已有 base_final 时跳过 file2chunk"),
    skip_process_table: bool = Query(False, description="跳过 Step 3 process_table；默认不跳过"),
    skip_load: bool = Query(False, description="只生成 JSON，不写向量库"),
    skip_load_table: bool = Query(False, description="跳过 Step 5 load_table_chroma"),
    skip_pageindex: bool = Query(False, description="跳过 Step 6 PageIndex 构建"),
    enable_word_image_ocr: bool = Query(False, description="Word 解析时对内嵌图片启用 MinerU OCR"),
    reset_persist: bool = Query(False, description="入库前删除该 dataset 的 persist_directory（慎用）"),
):
    if not files:
        raise HTTPException(status_code=400, detail="未提供任何文件")

    dataset = _require_dataset(dataset_id)
    _ensure_dataset_dirs(dataset)

    max_bytes = int(os.environ.get("INGEST_MAX_UPLOAD_MB", "200")) * 1024 * 1024
    job_id = uuid.uuid4().hex[:16]
    created_at = _now()
    saved_docs: list[dict[str, Any]] = []
    pdf_paths: list[str] = []
    pdf_doc_ids: list[str] = []
    word_docs: list[dict[str, Any]] = []
    excel_docs: list[dict[str, Any]] = []
    md_docs: list[dict[str, Any]] = []
    unsupported_docs: list[dict[str, Any]] = []

    for item in files:
        body = await item.read()
        if not body:
            raise HTTPException(status_code=400, detail=f"空文件: {item.filename}")
        if len(body) > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"{item.filename} 超过单文件限制 {max_bytes // (1024 * 1024)} MB",
            )

        stored_name, file_type, ext = _safe_upload_basename(item.filename)
        _reject_generated_pdf_upload(item.filename, file_type, ext)
        raw_dir = RAW_DIR_BY_TYPE[file_type]
        target_path = _dataset_abs_root(dataset) / raw_dir / stored_name
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_bytes(body)
        doc_id = uuid.uuid4().hex
        original_filename = item.filename or f"upload{ext}"
        title = os.path.splitext(os.path.basename(original_filename))[0] or original_filename
        status = "uploaded"
        doc = {
            "doc_id": doc_id,
            "dataset_id": dataset_id,
            "title": title,
            "original_filename": original_filename,
            "stored_path": _relative_path(target_path),
            "file_type": file_type,
            "doc_type": doc_type.strip() or None,
            "source_type": source_type.strip() or "unknown",
            "source_name": source_name.strip() or None,
            "company_name": company_name.strip() or None,
            "company_ticker": company_ticker.strip() or None,
            "document_date": document_date.strip() or None,
            "checksum": _sha256_bytes(body),
            "file_size": len(body),
            "status": status,
            "chunk_count": 0,
            "error_message": None,
            "metadata_json": json.dumps(
                {
                    "content_type": item.content_type,
                    "stored_basename": stored_name,
                    "extension": ext,
                    "parser_reserved": file_type != "pdf",
                },
                ensure_ascii=False,
            ),
            "created_at": created_at,
            "updated_at": created_at,
            "deleted_at": None,
        }
        saved_docs.append(doc)
        if file_type == "pdf":
            pdf_paths.append(str(target_path.resolve()))
            pdf_doc_ids.append(doc_id)
        elif file_type == "word" and ext == ".docx":
            word_docs.append(doc)
        elif file_type == "excel" and ext in {".xlsx", ".xlsm"}:
            excel_docs.append(doc)
        elif file_type == "md":
            md_docs.append(doc)
        else:
            unsupported_docs.append(doc)

    has_pdf = bool(pdf_paths)
    has_word = bool(word_docs)
    has_excel = bool(excel_docs)
    has_md = bool(md_docs)
    has_processable = has_pdf or has_word or has_excel or has_md
    missing_scripts: list[str] = []
    if has_pdf and not INGEST_SCRIPT.is_file():
        missing_scripts.append(str(INGEST_SCRIPT))
    if has_word:
        missing_scripts.extend(
            str(path)
            for path in (WORD_PIPELINE_SCRIPT, WORD_LOAD_DATA_SCRIPT, WORD_LOAD_TABLE_SCRIPT)
            if not path.is_file()
        )
    if has_excel:
        missing_scripts.extend(
            str(path)
            for path in (EXCEL_PIPELINE_SCRIPT, EXCEL_LOAD_DATA_SCRIPT, EXCEL_LOAD_TABLE_SCRIPT)
            if not path.is_file()
        )
    if has_md:
        missing_scripts.extend(
            str(path)
            for path in (MD_PIPELINE_SCRIPT, MD_LOAD_DATA_SCRIPT, MD_LOAD_TABLE_SCRIPT)
            if not path.is_file()
        )
    if missing_scripts:
        raise HTTPException(status_code=500, detail=f"未找到入库脚本: {', '.join(missing_scripts)}")

    pipeline_config: Optional[Path] = None
    log_file = _dataset_abs_root(dataset) / "logs" / "ingest" / f"{job_id}.log"
    job_status = "queued" if has_processable else "completed"
    job_type = "index" if has_processable else "upload"
    message = (
        f"已保存 {len(saved_docs)} 个文件；将按类型顺序解析："
        f"PDF {len(pdf_doc_ids)} 个、Word {len(word_docs)} 个、Excel {len(excel_docs)} 个、Markdown {len(md_docs)} 个。"
        f"另有 {len(unsupported_docs)} 个文件暂未接入主流程。"
        if has_processable
        else f"已保存 {len(saved_docs)} 个文件；这些格式暂未接入主流程，仅完成登记。"
    )

    extra: list[str] = []
    cfg = app_module.load_config()
    mb = (mineru_bin or "").strip() or (str(cfg.get("mineru_bin") or "")).strip()
    if has_pdf:
        pipeline_config = _write_pipeline_config(dataset, job_id)
        extra.extend(["--company-name", (company_name.strip() or dataset["name"])])
        if mb:
            extra.extend(["--mineru-bin", mb])
        if skip_mineru:
            extra.append("--skip-mineru")
        if skip_file2chunk:
            extra.append("--skip-file2chunk")
        if skip_process_table:
            extra.append("--skip-process-table")
        if skip_load:
            extra.append("--skip-load")
        if skip_load_table:
            extra.append("--skip-load-table")
        if skip_pageindex:
            extra.append("--skip-pageindex")
        if reset_persist:
            extra.append("--reset-persist")

    with _jobs_lock:
        with _connect_collection(dataset) as conn:
            conn.executemany(
                """
                INSERT INTO documents (
                    doc_id, dataset_id, title, original_filename, stored_path,
                    file_type, doc_type, source_type, source_name, company_name,
                    company_ticker, document_date, checksum, file_size, status,
                    chunk_count, error_message, metadata_json, created_at,
                    updated_at, deleted_at
                ) VALUES (
                    :doc_id, :dataset_id, :title, :original_filename, :stored_path,
                    :file_type, :doc_type, :source_type, :source_name, :company_name,
                    :company_ticker, :document_date, :checksum, :file_size, :status,
                    :chunk_count, :error_message, :metadata_json, :created_at,
                    :updated_at, :deleted_at
                )
                """,
                saved_docs,
            )
            conn.execute(
                """
                INSERT INTO ingest_jobs (
                    job_id, dataset_id, job_type, status, doc_ids_json, file_count,
                    log_path, message, returncode, created_at, started_at,
                    finished_at, metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    dataset_id,
                    job_type,
                    job_status,
                    json.dumps([doc["doc_id"] for doc in saved_docs], ensure_ascii=False),
                    len(saved_docs),
                    _relative_path(log_file),
                    message,
                    0 if not has_pdf else None,
                    created_at,
                    None,
                    created_at if not has_pdf else None,
                    json.dumps(
                        {
                            "pdf_doc_ids": pdf_doc_ids,
                            "word_doc_ids": [doc["doc_id"] for doc in word_docs],
                            "excel_doc_ids": [doc["doc_id"] for doc in excel_docs],
                            "md_doc_ids": [doc["doc_id"] for doc in md_docs],
                            "unsupported_doc_ids": [doc["doc_id"] for doc in unsupported_docs],
                            "skip_process_table": skip_process_table,
                            "skip_load": skip_load,
                            "skip_load_table": skip_load_table,
                            "skip_pageindex": skip_pageindex,
                            "enable_word_image_ocr": enable_word_image_ocr,
                        },
                        ensure_ascii=False,
                    ),
                ),
            )
            conn.commit()

    if has_processable:
        process_doc_ids = [
            *pdf_doc_ids,
            *(doc["doc_id"] for doc in word_docs),
            *(doc["doc_id"] for doc in excel_docs),
            *(doc["doc_id"] for doc in md_docs),
        ]
        _update_documents_status(dataset, process_doc_ids, "indexing")
        _set_dataset_status(dataset_id, "indexing")
        background_tasks.add_task(
            _ingest_subprocess_worker,
            job_id=job_id,
            dataset_id=dataset_id,
            pdf_paths=pdf_paths,
            pdf_doc_ids=pdf_doc_ids,
            word_docs=word_docs,
            excel_docs=excel_docs,
            md_docs=md_docs,
            config_path=str(pipeline_config or CONFIG_PATH),
            extra_args=extra,
            log_file=str(log_file.resolve()),
            skip_load=skip_load,
            skip_load_table=skip_load_table,
            enable_word_image_ocr=enable_word_image_ocr,
            mineru_bin=mb,
        )

    response_files = [_document_payload(dataset, doc) for doc in saved_docs]
    return {
        "job_id": job_id,
        "dataset_id": dataset_id,
        "status": job_status,
        "file_count": len(saved_docs),
        "batch_counts": {
            "pdf": len(pdf_doc_ids),
            "word": len(word_docs),
            "excel": len(excel_docs),
            "md": len(md_docs),
            "unsupported": len(unsupported_docs),
        },
        "files": response_files,
        "log_file": _relative_path(log_file),
        "message": message,
    }
