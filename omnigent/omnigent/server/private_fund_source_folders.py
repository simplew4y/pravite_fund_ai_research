"""Persistent filesystem-like folders for private-fund source documents."""

from __future__ import annotations

import sqlite3
import uuid
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 2

DOCUMENT_TYPE_FOLDER_NAMES: dict[str, str] = {
    "financial_report": "财务报告",
    "earnings_release": "业绩公告",
    "meeting_minutes": "会议纪要",
    "valuation_model": "估值模型",
    "research_report": "研究报告",
    "investor_presentation": "投资者材料",
    "regulatory_announcement": "监管公告",
    "financial_dataset": "财务数据",
    "company_material": "公司资料",
    "other": "其他资料",
}

# Kept only to migrate databases created by the original fixed-folder model.
LEGACY_SYSTEM_FOLDER_NAMES: dict[str, str] = {
    **DOCUMENT_TYPE_FOLDER_NAMES,
    "needs_review": "待复核",
    "unknown": "待识别",
}


class SourceFolderConflictError(ValueError):
    """Raised when a folder name already exists in the project."""


class SourceFolderNotEmptyError(ValueError):
    """Raised when deleting a folder that still contains files."""


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
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (dataset_id, folder_id),
            UNIQUE (dataset_id, name),
            UNIQUE (dataset_id, classification_key)
        );

        CREATE TABLE IF NOT EXISTS source_folder_file_assignments (
            dataset_id TEXT NOT NULL,
            file_name TEXT NOT NULL,
            folder_id TEXT NOT NULL,
            assignment_source TEXT NOT NULL,
            classification_key TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (dataset_id, file_name),
            FOREIGN KEY (dataset_id, folder_id)
                REFERENCES source_folders(dataset_id, folder_id)
                ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_source_folder_assignments_folder
        ON source_folder_file_assignments(dataset_id, folder_id);

        CREATE TABLE IF NOT EXISTS source_folder_schema_versions (
            dataset_id TEXT PRIMARY KEY,
            schema_version INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        );
        """
    )


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table_name,),
        ).fetchone()
        is not None
    )


def _validate_folder_name(value: str) -> str:
    name = value.strip()
    if not name:
        raise ValueError("Folder name is required.")
    if len(name) > 40:
        raise ValueError("Folder name must be 40 characters or fewer.")
    if "/" in name or "\\" in name or name in {".", ".."}:
        raise ValueError("Folder name contains unsupported path characters.")
    return name


def _classification_target(file: dict[str, Any]) -> tuple[str, str]:
    status = str(file.get("classification_status") or "pending").strip().lower()
    doc_type = str(file.get("doc_type") or "unknown").strip().lower()
    if status in {"pending", ""} or doc_type in {"", "unknown"}:
        return "status:unknown", "待识别"
    if status in {"needs_review", "company_conflict"}:
        return "status:needs_review", "待复核"
    name = DOCUMENT_TYPE_FOLDER_NAMES.get(doc_type)
    if name is None:
        name = doc_type.replace("_", " ").strip() or "其他资料"
        name = name[:40]
    return f"doc_type:{doc_type}", name


def _legacy_automatic_key(file: dict[str, Any]) -> str:
    status = str(file.get("classification_status") or "pending").strip().lower()
    doc_type = str(file.get("doc_type") or "unknown").strip().lower()
    if status in {"pending", ""} or doc_type in {"", "unknown"}:
        return "unknown"
    if status in {"needs_review", "company_conflict"}:
        return "needs_review"
    return doc_type if doc_type in LEGACY_SYSTEM_FOLDER_NAMES else "other"


def _available_folder_name(
    conn: sqlite3.Connection,
    dataset_id: str,
    preferred_name: str,
) -> str:
    existing = {
        str(row["name"]).casefold()
        for row in conn.execute(
            "SELECT name FROM source_folders WHERE dataset_id = ?",
            (dataset_id,),
        )
    }
    if preferred_name.casefold() not in existing:
        return preferred_name
    index = 2
    while True:
        suffix = f"（自动 {index}）"
        candidate = f"{preferred_name[: 40 - len(suffix)]}{suffix}"
        if candidate.casefold() not in existing:
            return candidate
        index += 1


def _create_folder_row(
    conn: sqlite3.Connection,
    dataset_id: str,
    name: str,
    *,
    kind: str,
    classification_key: str | None,
) -> str:
    now = _now_iso()
    folder_id = f"folder_{uuid.uuid4().hex}"
    conn.execute(
        """
        INSERT INTO source_folders (
            dataset_id, folder_id, folder_kind, classification_key,
            name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (dataset_id, folder_id, kind, classification_key, name, now, now),
    )
    return folder_id


def _normalize_legacy_folder_ids(conn: sqlite3.Connection, dataset_id: str) -> None:
    """Replace semantic ``system:*`` IDs with opaque filesystem folder IDs."""
    rows = conn.execute(
        """
        SELECT folder_id, folder_kind, classification_key, name, created_at, updated_at
        FROM source_folders
        WHERE dataset_id = ? AND folder_id LIKE 'system:%'
        """,
        (dataset_id,),
    ).fetchall()
    for row in rows:
        old_folder_id = str(row["folder_id"])
        new_folder_id = f"folder_{uuid.uuid4().hex}"
        original_name = str(row["name"])
        temporary_name = f"__migrating_{uuid.uuid4().hex[:16]}"
        conn.execute(
            """
            UPDATE source_folders
            SET name = ?, classification_key = NULL
            WHERE dataset_id = ? AND folder_id = ?
            """,
            (temporary_name, dataset_id, old_folder_id),
        )
        conn.execute(
            """
            INSERT INTO source_folders (
                dataset_id, folder_id, folder_kind, classification_key,
                name, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                dataset_id,
                new_folder_id,
                row["folder_kind"],
                row["classification_key"],
                original_name,
                row["created_at"],
                row["updated_at"],
            ),
        )
        conn.execute(
            """
            UPDATE source_folder_file_assignments
            SET folder_id = ?
            WHERE dataset_id = ? AND folder_id = ?
            """,
            (new_folder_id, dataset_id, old_folder_id),
        )
        conn.execute(
            "DELETE FROM source_folders WHERE dataset_id = ? AND folder_id = ?",
            (dataset_id, old_folder_id),
        )
    if rows:
        conn.commit()


def _remove_legacy_folder_columns(conn: sqlite3.Connection) -> None:
    """Rebuild v1 folder tables without ``is_pinned`` or ``sort_order``."""
    columns = {
        str(row["name"]) for row in conn.execute("PRAGMA table_info(source_folders)").fetchall()
    }
    if not columns.intersection({"is_pinned", "sort_order"}):
        return

    conn.commit()
    conn.execute("PRAGMA foreign_keys=OFF")
    try:
        conn.executescript(
            """
            BEGIN IMMEDIATE;

            CREATE TABLE source_folders_v2 (
                dataset_id TEXT NOT NULL,
                folder_id TEXT NOT NULL,
                folder_kind TEXT NOT NULL,
                classification_key TEXT,
                name TEXT NOT NULL COLLATE NOCASE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (dataset_id, folder_id),
                UNIQUE (dataset_id, name),
                UNIQUE (dataset_id, classification_key)
            );
            INSERT INTO source_folders_v2 (
                dataset_id, folder_id, folder_kind, classification_key,
                name, created_at, updated_at
            )
            SELECT dataset_id, folder_id, folder_kind, classification_key,
                   name, created_at, updated_at
            FROM source_folders;

            CREATE TABLE source_folder_file_assignments_v2 (
                dataset_id TEXT NOT NULL,
                file_name TEXT NOT NULL,
                folder_id TEXT NOT NULL,
                assignment_source TEXT NOT NULL,
                classification_key TEXT,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (dataset_id, file_name),
                FOREIGN KEY (dataset_id, folder_id)
                    REFERENCES source_folders_v2(dataset_id, folder_id)
                    ON DELETE CASCADE
            );
            INSERT INTO source_folder_file_assignments_v2 (
                dataset_id, file_name, folder_id, assignment_source,
                classification_key, updated_at
            )
            SELECT dataset_id, file_name, folder_id, assignment_source,
                   classification_key, updated_at
            FROM source_folder_file_assignments;

            DROP TABLE source_folder_file_assignments;
            DROP TABLE source_folders;
            ALTER TABLE source_folders_v2 RENAME TO source_folders;
            ALTER TABLE source_folder_file_assignments_v2
                RENAME TO source_folder_file_assignments;
            CREATE INDEX idx_source_folder_assignments_folder
                ON source_folder_file_assignments(dataset_id, folder_id);

            COMMIT;
            """
        )
    except sqlite3.Error:
        if conn.in_transaction:
            conn.rollback()
        raise
    finally:
        conn.execute("PRAGMA foreign_keys=ON")


def _ensure_classification_folder(
    conn: sqlite3.Connection,
    dataset_id: str,
    classification_key: str,
    preferred_name: str,
) -> str:
    row = conn.execute(
        """
        SELECT folder_id
        FROM source_folders
        WHERE dataset_id = ? AND classification_key = ?
        """,
        (dataset_id, classification_key),
    ).fetchone()
    if row is not None:
        return str(row["folder_id"])
    return _create_folder_row(
        conn,
        dataset_id,
        _available_folder_name(conn, dataset_id, preferred_name),
        kind="auto",
        classification_key=classification_key,
    )


def _upsert_assignment(
    conn: sqlite3.Connection,
    dataset_id: str,
    file_name: str,
    folder_id: str,
    assignment_source: str,
    classification_key: str,
) -> None:
    conn.execute(
        """
        INSERT INTO source_folder_file_assignments (
            dataset_id, file_name, folder_id, assignment_source,
            classification_key, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(dataset_id, file_name) DO UPDATE SET
            folder_id = excluded.folder_id,
            assignment_source = excluded.assignment_source,
            classification_key = excluded.classification_key,
            updated_at = excluded.updated_at
        """,
        (
            dataset_id,
            file_name,
            folder_id,
            assignment_source,
            classification_key,
            _now_iso(),
        ),
    )


def _legacy_folder_target(classification_key: str) -> tuple[str, str]:
    if classification_key == "needs_review":
        return "status:needs_review", "待复核"
    if classification_key == "unknown":
        return "status:unknown", "待识别"
    return (
        f"doc_type:{classification_key}",
        DOCUMENT_TYPE_FOLDER_NAMES.get(classification_key, classification_key.replace("_", " ")),
    )


def _migrate_legacy_model(
    conn: sqlite3.Connection,
    dataset_id: str,
    files: list[dict[str, Any]],
) -> None:
    version_row = conn.execute(
        "SELECT schema_version FROM source_folder_schema_versions WHERE dataset_id = ?",
        (dataset_id,),
    ).fetchone()
    if version_row is not None and int(version_row["schema_version"]) >= SCHEMA_VERSION:
        return

    legacy_overrides: dict[str, str] = {}
    if _table_exists(conn, "source_folder_file_overrides"):
        legacy_overrides = {
            str(row["file_name"]): str(row["folder_id"])
            for row in conn.execute(
                """
                SELECT file_name, folder_id
                FROM source_folder_file_overrides
                WHERE dataset_id = ?
                """,
                (dataset_id,),
            )
        }

    folder_rows = conn.execute(
        "SELECT * FROM source_folders WHERE dataset_id = ?",
        (dataset_id,),
    ).fetchall()
    folder_ids = {str(row["folder_id"]) for row in folder_rows}
    for file in files:
        file_name = str(file.get("name") or "").strip()
        if not file_name:
            continue
        classification_key, preferred_name = _classification_target(file)
        manual_folder_id = legacy_overrides.get(file_name)
        if manual_folder_id in folder_ids:
            folder_id = manual_folder_id
            assignment_source = "manual"
        else:
            legacy_folder_id = f"system:{_legacy_automatic_key(file)}"
            if legacy_folder_id in folder_ids:
                folder_id = legacy_folder_id
            else:
                folder_id = _ensure_classification_folder(
                    conn, dataset_id, classification_key, preferred_name
                )
                folder_ids.add(folder_id)
            assignment_source = "auto"
        _upsert_assignment(
            conn,
            dataset_id,
            file_name,
            folder_id,
            assignment_source,
            classification_key,
        )

    columns = {
        str(row["name"]) for row in conn.execute("PRAGMA table_info(source_folders)").fetchall()
    }
    pinned_expression = "is_pinned" if "is_pinned" in columns else "0 AS is_pinned"
    legacy_rows = conn.execute(
        f"""
        SELECT folder_id, folder_kind, classification_key, name, {pinned_expression}
        FROM source_folders
        WHERE dataset_id = ?
        """,
        (dataset_id,),
    ).fetchall()
    for row in legacy_rows:
        if str(row["folder_kind"]) != "system":
            continue
        folder_id = str(row["folder_id"])
        assignment_count = int(
            conn.execute(
                """
                SELECT COUNT(*)
                FROM source_folder_file_assignments
                WHERE dataset_id = ? AND folder_id = ?
                """,
                (dataset_id, folder_id),
            ).fetchone()[0]
        )
        legacy_key = str(row["classification_key"] or "")
        canonical_name = LEGACY_SYSTEM_FOLDER_NAMES.get(legacy_key, "")
        unchanged_system_name = bool(canonical_name and str(row["name"]) == canonical_name)
        if assignment_count and unchanged_system_name:
            next_key, _name = _legacy_folder_target(legacy_key)
            conn.execute(
                """
                UPDATE source_folders
                SET folder_kind = 'auto', classification_key = ?, updated_at = ?
                WHERE dataset_id = ? AND folder_id = ?
                """,
                (next_key, _now_iso(), dataset_id, folder_id),
            )
        elif assignment_count:
            conn.execute(
                """
                UPDATE source_folders
                SET folder_kind = 'custom', classification_key = NULL, updated_at = ?
                WHERE dataset_id = ? AND folder_id = ?
                """,
                (_now_iso(), dataset_id, folder_id),
            )
            conn.execute(
                """
                UPDATE source_folder_file_assignments
                SET assignment_source = 'manual', updated_at = ?
                WHERE dataset_id = ? AND folder_id = ?
                """,
                (_now_iso(), dataset_id, folder_id),
            )
        elif bool(row["is_pinned"]):
            conn.execute(
                """
                UPDATE source_folders
                SET folder_kind = 'custom', classification_key = NULL, updated_at = ?
                WHERE dataset_id = ? AND folder_id = ?
                """,
                (_now_iso(), dataset_id, folder_id),
            )
        else:
            conn.execute(
                "DELETE FROM source_folders WHERE dataset_id = ? AND folder_id = ?",
                (dataset_id, folder_id),
            )

    if _table_exists(conn, "source_folder_file_overrides"):
        conn.execute("DROP TABLE source_folder_file_overrides")
    conn.execute(
        """
        INSERT INTO source_folder_schema_versions (dataset_id, schema_version, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(dataset_id) DO UPDATE SET
            schema_version = excluded.schema_version,
            updated_at = excluded.updated_at
        """,
        (dataset_id, SCHEMA_VERSION, _now_iso()),
    )
    conn.commit()


def _sync_assignments(
    conn: sqlite3.Connection,
    dataset_id: str,
    files: list[dict[str, Any]],
) -> None:
    _migrate_legacy_model(conn, dataset_id, files)
    _normalize_legacy_folder_ids(conn, dataset_id)
    _remove_legacy_folder_columns(conn)
    file_by_name = {
        str(file.get("name") or "").strip(): file
        for file in files
        if str(file.get("name") or "").strip()
    }
    if file_by_name:
        placeholders = ",".join("?" for _name in file_by_name)
        conn.execute(
            f"""
            DELETE FROM source_folder_file_assignments
            WHERE dataset_id = ? AND file_name NOT IN ({placeholders})
            """,
            (dataset_id, *file_by_name),
        )
    else:
        conn.execute(
            "DELETE FROM source_folder_file_assignments WHERE dataset_id = ?",
            (dataset_id,),
        )

    assignments = {
        str(row["file_name"]): row
        for row in conn.execute(
            """
            SELECT file_name, folder_id, assignment_source, classification_key
            FROM source_folder_file_assignments
            WHERE dataset_id = ?
            """,
            (dataset_id,),
        )
    }
    for file_name, file in file_by_name.items():
        classification_key, preferred_name = _classification_target(file)
        assignment = assignments.get(file_name)
        needs_auto_assignment = assignment is None or (
            str(assignment["assignment_source"]) == "auto"
            and str(assignment["classification_key"] or "") != classification_key
        )
        if not needs_auto_assignment:
            continue
        folder_id = _ensure_classification_folder(
            conn, dataset_id, classification_key, preferred_name
        )
        _upsert_assignment(
            conn,
            dataset_id,
            file_name,
            folder_id,
            "auto",
            classification_key,
        )
    conn.commit()


def _folder_tree_from_connection(
    conn: sqlite3.Connection,
    dataset_id: str,
    files: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    file_list = list(files)
    _sync_assignments(conn, dataset_id, file_list)
    folder_rows = conn.execute(
        """
        SELECT dataset_id, folder_id, folder_kind, classification_key,
               name, created_at, updated_at
        FROM source_folders
        WHERE dataset_id = ?
        ORDER BY name COLLATE NOCASE, created_at
        """,
        (dataset_id,),
    ).fetchall()
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
    for row in conn.execute(
        """
        SELECT file_name, folder_id, assignment_source
        FROM source_folder_file_assignments
        WHERE dataset_id = ?
        ORDER BY file_name COLLATE NOCASE
        """,
        (dataset_id,),
    ):
        folder = folders_by_id.get(str(row["folder_id"]))
        if folder is None:
            continue
        folder["files"].append(
            {
                "file_name": str(row["file_name"]),
                "assignment": str(row["assignment_source"]),
            }
        )
    for folder in folders_by_id.values():
        folder["file_count"] = len(folder["files"])
    return {"dataset_id": dataset_id, "folders": list(folders_by_id.values())}


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
    file_list = list(files)
    with _connect(db_path) as conn:
        _sync_assignments(conn, dataset_id, file_list)
        if conn.execute(
            "SELECT 1 FROM source_folders WHERE dataset_id = ? AND name = ? COLLATE NOCASE",
            (dataset_id, normalized_name),
        ).fetchone():
            raise SourceFolderConflictError("A folder with this name already exists.")
        _create_folder_row(
            conn,
            dataset_id,
            normalized_name,
            kind="custom",
            classification_key=None,
        )
        conn.commit()
        return _folder_tree_from_connection(conn, dataset_id, file_list)


def rename_folder(
    db_path: Path,
    dataset_id: str,
    folder_id: str,
    name: str,
    files: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    normalized_name = _validate_folder_name(name)
    file_list = list(files)
    with _connect(db_path) as conn:
        _sync_assignments(conn, dataset_id, file_list)
        row = conn.execute(
            """
            SELECT name
            FROM source_folders
            WHERE dataset_id = ? AND folder_id = ?
            """,
            (dataset_id, folder_id),
        ).fetchone()
        if row is None:
            raise KeyError(folder_id)
        if str(row["name"]) == normalized_name:
            return _folder_tree_from_connection(conn, dataset_id, file_list)
        try:
            conn.execute(
                """
                UPDATE source_folders
                SET name = ?, folder_kind = 'custom', classification_key = NULL,
                    updated_at = ?
                WHERE dataset_id = ? AND folder_id = ?
                """,
                (normalized_name, _now_iso(), dataset_id, folder_id),
            )
            conn.execute(
                """
                UPDATE source_folder_file_assignments
                SET assignment_source = 'manual', updated_at = ?
                WHERE dataset_id = ? AND folder_id = ?
                """,
                (_now_iso(), dataset_id, folder_id),
            )
            conn.commit()
        except sqlite3.IntegrityError as exc:
            raise SourceFolderConflictError("A folder with this name already exists.") from exc
        return _folder_tree_from_connection(conn, dataset_id, file_list)


def delete_folder(
    db_path: Path,
    dataset_id: str,
    folder_id: str,
    files: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    file_list = list(files)
    with _connect(db_path) as conn:
        _sync_assignments(conn, dataset_id, file_list)
        if not conn.execute(
            "SELECT 1 FROM source_folders WHERE dataset_id = ? AND folder_id = ?",
            (dataset_id, folder_id),
        ).fetchone():
            raise KeyError(folder_id)
        if conn.execute(
            """
            SELECT 1 FROM source_folder_file_assignments
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
        return _folder_tree_from_connection(conn, dataset_id, file_list)


def move_file(
    db_path: Path,
    dataset_id: str,
    file_name: str,
    folder_id: str | None,
    files: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    file_list = list(files)
    file_by_name = {str(file.get("name") or ""): file for file in file_list}
    file = file_by_name.get(file_name)
    if file is None:
        raise KeyError(file_name)
    with _connect(db_path) as conn:
        _sync_assignments(conn, dataset_id, file_list)
        classification_key, preferred_name = _classification_target(file)
        assignment_source = "manual"
        if folder_id is None:
            folder_id = _ensure_classification_folder(
                conn, dataset_id, classification_key, preferred_name
            )
            assignment_source = "auto"
        elif not conn.execute(
            "SELECT 1 FROM source_folders WHERE dataset_id = ? AND folder_id = ?",
            (dataset_id, folder_id),
        ).fetchone():
            raise KeyError(folder_id)
        _upsert_assignment(
            conn,
            dataset_id,
            file_name,
            folder_id,
            assignment_source,
            classification_key,
        )
        conn.commit()
        return _folder_tree_from_connection(conn, dataset_id, file_list)


def cleanup_file_assignments(
    db_path: Path,
    dataset_id: str,
    file_names: Iterable[str],
) -> None:
    """Delete persisted assignments for removed source files."""
    names = [name for name in dict.fromkeys(file_names) if name]
    if not names or not db_path.exists():
        return
    placeholders = ",".join("?" for _name in names)
    with _connect(db_path) as conn:
        conn.execute(
            f"""
            DELETE FROM source_folder_file_assignments
            WHERE dataset_id = ? AND file_name IN ({placeholders})
            """,
            (dataset_id, *names),
        )
        if _table_exists(conn, "source_folder_file_overrides"):
            conn.execute(
                f"""
                DELETE FROM source_folder_file_overrides
                WHERE dataset_id = ? AND file_name IN ({placeholders})
                """,
                (dataset_id, *names),
            )
        conn.commit()
