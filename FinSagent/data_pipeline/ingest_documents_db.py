"""数据集绑定的入库文档 SQLite 登记表（每个上传 PDF 一行）。"""

from __future__ import annotations

import logging
import os
import sqlite3
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def resolve_db_path(dataset_root: Path) -> Path:
    """``INGEST_DOCUMENTS_DB`` 优先，否则 ``{dataset_root}/meta/ingest_documents.db``。"""
    override = (os.environ.get("INGEST_DOCUMENTS_DB") or "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return (Path(dataset_root).resolve() / "meta" / "ingest_documents.db").resolve()


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dataset_documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT NOT NULL,
            original_filename TEXT NOT NULL,
            stored_basename TEXT NOT NULL,
            stored_path TEXT NOT NULL,
            status TEXT NOT NULL,
            collection_name TEXT,
            uploaded_at TEXT NOT NULL,
            returncode INTEGER,
            message TEXT,
            log_file TEXT
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_dataset_documents_job_id ON dataset_documents(job_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_dataset_documents_status ON dataset_documents(status)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_dataset_documents_uploaded_at ON dataset_documents(uploaded_at DESC)"
    )
    conn.commit()


def insert_document_rows(db_path: Path | str, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30.0)
    try:
        ensure_schema(conn)
        conn.executemany(
            """
            INSERT INTO dataset_documents (
                job_id, original_filename, stored_basename, stored_path,
                status, collection_name, uploaded_at, returncode, message, log_file
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    r["job_id"],
                    r["original_filename"],
                    r["stored_basename"],
                    r["stored_path"],
                    r["status"],
                    r.get("collection_name"),
                    r["uploaded_at"],
                    r.get("returncode"),
                    r.get("message"),
                    r.get("log_file"),
                )
                for r in rows
            ],
        )
        conn.commit()
    finally:
        conn.close()


def update_job_documents(
    db_path: Path | str,
    job_id: str,
    status: str,
    message: str | None,
    returncode: int | None,
) -> None:
    conn = sqlite3.connect(str(db_path), timeout=30.0)
    try:
        ensure_schema(conn)
        conn.execute(
            """
            UPDATE dataset_documents
            SET status = ?, message = ?, returncode = ?
            WHERE job_id = ?
            """,
            (status, message, returncode, job_id),
        )
        conn.commit()
    finally:
        conn.close()


def fetch_recent_jobs_page(
    db_path: Path | str, page_size: int, offset: int
) -> tuple[list[dict[str, Any]], bool]:
    """分页聚合入库任务（按 ``MAX(uploaded_at)`` 倒序）。多取一行用于 ``has_more``。"""
    path = Path(db_path)
    if not path.is_file():
        return [], False

    fetch_limit = page_size + 1
    conn = sqlite3.connect(str(path), timeout=30.0)
    try:
        ensure_schema(conn)
        cur = conn.execute(
            """
            SELECT job_id FROM dataset_documents
            GROUP BY job_id
            ORDER BY MAX(uploaded_at) DESC
            LIMIT ? OFFSET ?
            """,
            (fetch_limit, offset),
        )
        job_ids_raw = [r[0] for r in cur.fetchall()]
        has_more = len(job_ids_raw) > page_size
        job_ids = job_ids_raw[:page_size]
        if not job_ids:
            return [], False

        placeholders = ",".join("?" * len(job_ids))
        cur = conn.execute(
            f"""
            SELECT job_id, original_filename, stored_basename, stored_path,
                   status, collection_name, uploaded_at, returncode, message, log_file
            FROM dataset_documents
            WHERE job_id IN ({placeholders})
            ORDER BY id ASC
            """,
            job_ids,
        )
        rows = cur.fetchall()
    finally:
        conn.close()

    by_job: dict[str, list[tuple[Any, ...]]] = {jid: [] for jid in job_ids}
    for r in rows:
        jid = r[0]
        if jid in by_job:
            by_job[jid].append(r)

    out: list[dict[str, Any]] = []
    for jid in job_ids:
        file_rows = by_job[jid]
        if not file_rows:
            continue
        files: list[dict[str, Any]] = []
        uploaded_ats: list[str] = []
        for r in file_rows:
            (
                _jid,
                original_filename,
                stored_basename,
                stored_path,
                status,
                collection_name,
                uploaded_at,
                _rc,
                _msg,
                _lf,
            ) = r
            files.append(
                {
                    "original_filename": original_filename,
                    "stored_basename": stored_basename,
                    "stored_path": stored_path,
                    "uploaded_at": uploaded_at,
                    "status": status,
                }
            )
            uploaded_ats.append(uploaded_at)

        last = file_rows[-1]
        job_status = last[4]
        statuses = {fr[4] for fr in file_rows}
        if len(statuses) > 1:
            logger.warning("job %s has inconsistent row statuses in list: %s", jid, statuses)

        out.append(
            {
                "job_id": jid,
                "status": job_status,
                "collection_name": file_rows[0][5],
                "created_at": min(uploaded_ats),
                "log_file": file_rows[0][9],
                "message": last[8],
                "returncode": last[7],
                "file_count": len(files),
                "saved_paths": [f["stored_path"] for f in files],
                "files": files,
            }
        )
    return out, has_more


def fetch_job_snapshot(db_path: Path | str, job_id: str) -> dict[str, Any] | None:
    """从登记表聚合为与内存 ``_ingest_jobs`` 相近的结构；无记录返回 None。"""
    conn = sqlite3.connect(str(db_path), timeout=30.0)
    try:
        ensure_schema(conn)
        cur = conn.execute(
            """
            SELECT stored_path, uploaded_at, log_file, status, message, returncode
            FROM dataset_documents
            WHERE job_id = ?
            ORDER BY id ASC
            """,
            (job_id,),
        )
        fetched = cur.fetchall()
    finally:
        conn.close()

    if not fetched:
        return None

    saved_paths = [row[0] for row in fetched]
    uploaded_ats = [row[1] for row in fetched]
    log_files = [row[2] for row in fetched]
    statuses = {row[3] for row in fetched}
    status = fetched[0][3]
    if len(statuses) > 1:
        logger.warning("job %s has inconsistent row statuses: %s", job_id, statuses)

    message = fetched[-1][4]
    returncode = fetched[-1][5]

    return {
        "status": status,
        "saved_paths": saved_paths,
        "file_count": len(saved_paths),
        "created_at": min(uploaded_ats),
        "log_file": log_files[0] if log_files else None,
        "message": message,
        "returncode": returncode,
    }


def try_update_job_documents(
    db_path: Path | str,
    job_id: str,
    status: str,
    message: str | None,
    returncode: int | None,
) -> None:
    """UPDATE 失败仅打日志，不抛。"""
    try:
        update_job_documents(db_path, job_id, status, message, returncode)
    except Exception:
        logger.exception("dataset_documents UPDATE failed job_id=%s", job_id)


def try_insert_document_rows(db_path: Path | str, rows: list[dict[str, Any]]) -> None:
    """INSERT 失败仅打日志，不抛。"""
    try:
        insert_document_rows(db_path, rows)
    except Exception:
        logger.exception("dataset_documents INSERT failed (job may still run)")
