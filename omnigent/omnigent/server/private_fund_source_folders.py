"""Persistent logical folders for private-fund source documents."""

from __future__ import annotations

import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


SYSTEM_FOLDERS: tuple[tuple[str, str], ...] = (
    ("financial_report", "财务报告"),
    ("earnings_release", "业绩公告"),
    ("meeting_minutes", "会议纪要"),
    ("valuation_model", "估值模型"),
    ("research_report", "研究报告"),
    ("investor_presentation", "投资者材料"),
    ("regulatory_announcement", "监管公告"),
    ("financial_dataset", "财务数据"),
    ("company_material", "公司资料"),
    ("other", "其他资料"),
    ("needs_review", "待复核"),
    ("unknown", "待识别"),
)
SYSTEM_FOLDER_KEYS = {key for key, _name in SYSTEM_FOLDERS}


class SourceFolderConflictError(ValueError):
    """Raised when a folder name already exists in the project."""


class SourceFolderNotEmptyError(ValueError):
    """Raised when deleting a custom folder that still contains files."""


class SourceFolderProtectedError(ValueError):
    """Raised when deleting a system-managed folder."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    ensure_schema(conn)
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS source_folders (
            dataset_id TEXT NOT NULL,
            folder_id TEXT NOT NULL,
            folder_kind TEXT NOT NULL,
            classification_key TEXT,
            name TEXT NOT NULL COLLATE NOCASE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            is_pinned INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (dataset_id, folder_id),
            UNIQUE (dataset_id, name),
            UNIQUE (dataset_id, classification_key)
        );

        CREATE TABLE IF NOT EXISTS source_folder_file_overrides (
            dataset_id TEXT NOT NULL,
            file_name TEXT NOT NULL,
            folder_id TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (dataset_id, file_name),
            FOREIGN KEY (dataset_id, folder_id)
                REFERENCES source_folders(dataset_id, folder_id)
                ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_source_folder_overrides_folder
        ON source_folder_file_overrides(dataset_id, folder_id);
        """
    )
    columns = {
        str(row["name"])
        for row in conn.execute("PRAGMA table_info(source_folders)").fetchall()
    }
    if "is_pinned" not in columns:
        conn.execute(
            "ALTER TABLE source_folders ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0"
        )
        conn.commit()


def _validate_folder_name(value: str) -> str:
    name = value.strip()
    if not name:
        raise ValueError("Folder name is required.")
    if len(name) > 40:
        raise ValueError("Folder name must be 40 characters or fewer.")
    if "/" in name or "\\" in name or name in {".", ".."}:
        raise ValueError("Folder name contains unsupported path characters.")
    return name


def _ensure_system_folders(conn: sqlite3.Connection, dataset_id: str) -> None:
    now = _now_iso()
    for sort_order, (key, name) in enumerate(SYSTEM_FOLDERS):
        conn.execute(
            """
            INSERT OR IGNORE INTO source_folders (
                dataset_id, folder_id, folder_kind, classification_key,
                name, sort_order, created_at, updated_at
            ) VALUES (?, ?, 'system', ?, ?, ?, ?, ?)
            """,
            (dataset_id, f"system:{key}", key, name, sort_order, now, now),
        )
    conn.commit()


def _automatic_folder_key(file: dict[str, Any]) -> str:
    status = str(file.get("classification_status") or "pending").strip().lower()
    doc_type = str(file.get("doc_type") or "unknown").strip().lower()
    if status in {"pending", ""} or doc_type in {"", "unknown"}:
        return "unknown"
    if status in {"needs_review", "company_conflict"}:
        return "needs_review"
    return doc_type if doc_type in SYSTEM_FOLDER_KEYS else "other"


def _folder_tree_from_connection(
    conn: sqlite3.Connection,
    dataset_id: str,
    files: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    _ensure_system_folders(conn, dataset_id)
    folder_rows = conn.execute(
        """
        SELECT dataset_id, folder_id, folder_kind, classification_key,
               name, sort_order, is_pinned, created_at, updated_at
        FROM source_folders
        WHERE dataset_id = ?
        ORDER BY CASE WHEN folder_kind = 'system' THEN 0 ELSE 1 END,
                 sort_order, created_at, name COLLATE NOCASE
        """,
        (dataset_id,),
    ).fetchall()
    overrides = {
        str(row["file_name"]): str(row["folder_id"])
        for row in conn.execute(
            """
            SELECT file_name, folder_id
            FROM source_folder_file_overrides
            WHERE dataset_id = ?
            """,
            (dataset_id,),
        ).fetchall()
    }
    folders_by_id: dict[str, dict[str, Any]] = {
        str(row["folder_id"]): {
            "folder_id": str(row["folder_id"]),
            "name": str(row["name"]),
            "kind": str(row["folder_kind"]),
            "classification_key": row["classification_key"],
            "files": [],
            "file_count": 0,
            "created_at": str(row["created_at"]),
            "updated_at": str(row["updated_at"]),
        }
        for row in folder_rows
    }
    for file in files:
        file_name = str(file.get("name") or "").strip()
        if not file_name:
            continue
        manual_folder_id = overrides.get(file_name)
        folder_id = manual_folder_id or f"system:{_automatic_folder_key(file)}"
        folder = folders_by_id.get(folder_id)
        if folder is None:
            folder_id = "system:other"
            folder = folders_by_id[folder_id]
        folder["files"].append(
            {
                "file_name": file_name,
                "assignment": "manual" if manual_folder_id else "auto",
            }
        )

    visible_folders: list[dict[str, Any]] = []
    for row in folder_rows:
        folder = folders_by_id[str(row["folder_id"])]
        folder["files"].sort(key=lambda item: item["file_name"].casefold())
        folder["file_count"] = len(folder["files"])
        if folder["kind"] == "custom" or folder["file_count"] > 0 or row["is_pinned"]:
            visible_folders.append(folder)
    return {"dataset_id": dataset_id, "folders": visible_folders}


def get_folder_tree(
    db_path: Path,
    dataset_id: str,
    files: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    with _connect(db_path) as conn:
        return _folder_tree_from_connection(conn, dataset_id, files)


def create_folder(
    db_path: Path,
    dataset_id: str,
    name: str,
    files: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    normalized_name = _validate_folder_name(name)
    with _connect(db_path) as conn:
        _ensure_system_folders(conn, dataset_id)
        now = _now_iso()
        existing = conn.execute(
            """
            SELECT folder_id, folder_kind
            FROM source_folders
            WHERE dataset_id = ? AND name = ? COLLATE NOCASE
            """,
            (dataset_id, normalized_name),
        ).fetchone()
        if existing is not None:
            if existing["folder_kind"] != "system":
                raise SourceFolderConflictError("A folder with this name already exists.")
            conn.execute(
                """
                UPDATE source_folders
                SET is_pinned = 1, updated_at = ?
                WHERE dataset_id = ? AND folder_id = ?
                """,
                (now, dataset_id, existing["folder_id"]),
            )
            conn.commit()
            return _folder_tree_from_connection(conn, dataset_id, files)
        try:
            conn.execute(
                """
                INSERT INTO source_folders (
                    dataset_id, folder_id, folder_kind, classification_key,
                    name, sort_order, created_at, updated_at
                ) VALUES (?, ?, 'custom', NULL, ?, 1000, ?, ?)
                """,
                (dataset_id, f"folder_{uuid.uuid4().hex}", normalized_name, now, now),
            )
            conn.commit()
        except sqlite3.IntegrityError as exc:
            raise SourceFolderConflictError("A folder with this name already exists.") from exc
        return _folder_tree_from_connection(conn, dataset_id, files)


def rename_folder(
    db_path: Path,
    dataset_id: str,
    folder_id: str,
    name: str,
    files: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    normalized_name = _validate_folder_name(name)
    with _connect(db_path) as conn:
        _ensure_system_folders(conn, dataset_id)
        if not conn.execute(
            "SELECT 1 FROM source_folders WHERE dataset_id = ? AND folder_id = ?",
            (dataset_id, folder_id),
        ).fetchone():
            raise KeyError(folder_id)
        try:
            conn.execute(
                """
                UPDATE source_folders
                SET name = ?,
                    is_pinned = CASE WHEN folder_kind = 'system' THEN 1 ELSE is_pinned END,
                    updated_at = ?
                WHERE dataset_id = ? AND folder_id = ?
                """,
                (normalized_name, _now_iso(), dataset_id, folder_id),
            )
            conn.commit()
        except sqlite3.IntegrityError as exc:
            raise SourceFolderConflictError("A folder with this name already exists.") from exc
        return _folder_tree_from_connection(conn, dataset_id, files)


def delete_folder(
    db_path: Path,
    dataset_id: str,
    folder_id: str,
    files: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    with _connect(db_path) as conn:
        _ensure_system_folders(conn, dataset_id)
        row = conn.execute(
            """
            SELECT folder_kind
            FROM source_folders
            WHERE dataset_id = ? AND folder_id = ?
            """,
            (dataset_id, folder_id),
        ).fetchone()
        if row is None:
            raise KeyError(folder_id)
        if row["folder_kind"] != "custom":
            raise SourceFolderProtectedError("System folders cannot be deleted.")
        if conn.execute(
            """
            SELECT 1 FROM source_folder_file_overrides
            WHERE dataset_id = ? AND folder_id = ? LIMIT 1
            """,
            (dataset_id, folder_id),
        ).fetchone():
            raise SourceFolderNotEmptyError("Move files out of the folder before deleting it.")
        conn.execute(
            "DELETE FROM source_folders WHERE dataset_id = ? AND folder_id = ?",
            (dataset_id, folder_id),
        )
        conn.commit()
        return _folder_tree_from_connection(conn, dataset_id, files)


def move_file(
    db_path: Path,
    dataset_id: str,
    file_name: str,
    folder_id: str | None,
    files: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    file_list = list(files)
    known_names = {str(file.get("name") or "") for file in file_list}
    if file_name not in known_names:
        raise KeyError(file_name)
    with _connect(db_path) as conn:
        _ensure_system_folders(conn, dataset_id)
        if folder_id is None:
            conn.execute(
                "DELETE FROM source_folder_file_overrides WHERE dataset_id = ? AND file_name = ?",
                (dataset_id, file_name),
            )
        else:
            if not conn.execute(
                "SELECT 1 FROM source_folders WHERE dataset_id = ? AND folder_id = ?",
                (dataset_id, folder_id),
            ).fetchone():
                raise KeyError(folder_id)
            conn.execute(
                """
                INSERT INTO source_folder_file_overrides (
                    dataset_id, file_name, folder_id, updated_at
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(dataset_id, file_name) DO UPDATE SET
                    folder_id = excluded.folder_id,
                    updated_at = excluded.updated_at
                """,
                (dataset_id, file_name, folder_id, _now_iso()),
            )
        conn.commit()
        return _folder_tree_from_connection(conn, dataset_id, file_list)


def cleanup_file_overrides(db_path: Path, dataset_id: str, file_names: Iterable[str]) -> None:
    names = [name for name in dict.fromkeys(file_names) if name]
    if not names or not db_path.exists():
        return
    placeholders = ",".join("?" for _name in names)
    with _connect(db_path) as conn:
        conn.execute(
            f"""
            DELETE FROM source_folder_file_overrides
            WHERE dataset_id = ? AND file_name IN ({placeholders})
            """,
            (dataset_id, *names),
        )
        conn.commit()
