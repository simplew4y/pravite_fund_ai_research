import sqlite3
from pathlib import Path

import pytest

from omnigent.server import private_fund_source_folders as folders


def source_file(
    name: str,
    doc_type: str = "unknown",
    classification_status: str = "pending",
) -> dict[str, str]:
    return {
        "name": name,
        "doc_type": doc_type,
        "classification_status": classification_status,
    }


def folder_by_name(tree: dict, name: str) -> dict:
    return next(folder for folder in tree["folders"] if folder["name"] == name)


def test_folder_tree_lazily_creates_only_required_classification_folders(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "collection.sqlite3"
    tree = folders.get_folder_tree(
        db_path,
        "sungrow",
        [
            source_file("annual.pdf", "financial_report", "accepted"),
            source_file("meeting.pdf", "meeting_minutes", "needs_review"),
            source_file("legacy.xlsx"),
        ],
    )

    assert {folder["name"] for folder in tree["folders"]} == {
        "财务报告",
        "待复核",
        "待识别",
    }
    assert folder_by_name(tree, "财务报告")["files"] == [
        {"file_name": "annual.pdf", "assignment": "auto"}
    ]
    assert folder_by_name(tree, "待复核")["files"][0]["file_name"] == "meeting.pdf"
    assert folder_by_name(tree, "待识别")["files"][0]["file_name"] == "legacy.xlsx"


def test_folder_crud_and_manual_assignment_survive_reload(tmp_path: Path) -> None:
    db_path = tmp_path / "collection.sqlite3"
    files = [source_file("annual.pdf", "financial_report", "accepted")]

    created = folders.create_folder(db_path, "sungrow", "核心资料", files)
    custom = folder_by_name(created, "核心资料")
    moved = folders.move_file(db_path, "sungrow", "annual.pdf", custom["folder_id"], files)
    assert folder_by_name(moved, "核心资料")["files"] == [
        {"file_name": "annual.pdf", "assignment": "manual"}
    ]

    reloaded = folders.get_folder_tree(db_path, "sungrow", files)
    assert folder_by_name(reloaded, "核心资料")["file_count"] == 1

    renamed = folders.rename_folder(db_path, "sungrow", custom["folder_id"], "重点跟踪", files)
    assert folder_by_name(renamed, "重点跟踪")["file_count"] == 1
    with pytest.raises(folders.SourceFolderNotEmptyError):
        folders.delete_folder(db_path, "sungrow", custom["folder_id"], files)

    restored = folders.move_file(db_path, "sungrow", "annual.pdf", None, files)
    assert folder_by_name(restored, "财务报告")["files"] == [
        {"file_name": "annual.pdf", "assignment": "auto"}
    ]
    assert folder_by_name(restored, "重点跟踪")["file_count"] == 0
    deleted = folders.delete_folder(db_path, "sungrow", custom["folder_id"], files)
    assert all(folder["folder_id"] != custom["folder_id"] for folder in deleted["folders"])


def test_empty_folders_persist_and_all_empty_folders_can_be_deleted(tmp_path: Path) -> None:
    db_path = tmp_path / "collection.sqlite3"
    files = [source_file("model.xlsx", "valuation_model", "accepted")]
    tree = folders.get_folder_tree(db_path, "sungrow", files)
    model_folder = folder_by_name(tree, "估值模型")

    custom_tree = folders.create_folder(db_path, "sungrow", "归档", files)
    archive_folder = folder_by_name(custom_tree, "归档")
    folders.move_file(db_path, "sungrow", "model.xlsx", archive_folder["folder_id"], files)

    reloaded = folders.get_folder_tree(db_path, "sungrow", files)
    assert folder_by_name(reloaded, "估值模型")["file_count"] == 0
    deleted = folders.delete_folder(db_path, "sungrow", model_folder["folder_id"], files)
    assert all(folder["name"] != "估值模型" for folder in deleted["folders"])


def test_renaming_auto_folder_detaches_future_classification(tmp_path: Path) -> None:
    db_path = tmp_path / "collection.sqlite3"
    first_files = [source_file("model-v1.xlsx", "valuation_model", "accepted")]
    initial = folders.get_folder_tree(db_path, "sungrow", first_files)
    original_folder = folder_by_name(initial, "估值模型")

    renamed = folders.rename_folder(
        db_path,
        "sungrow",
        original_folder["folder_id"],
        "其他模型",
        first_files,
    )
    assert folder_by_name(renamed, "其他模型")["files"] == [
        {"file_name": "model-v1.xlsx", "assignment": "manual"}
    ]

    all_files = [
        *first_files,
        source_file("model-v2.xlsx", "valuation_model", "accepted"),
    ]
    reloaded = folders.get_folder_tree(db_path, "sungrow", all_files)
    assert folder_by_name(reloaded, "其他模型")["files"] == [
        {"file_name": "model-v1.xlsx", "assignment": "manual"}
    ]
    assert folder_by_name(reloaded, "估值模型")["files"] == [
        {"file_name": "model-v2.xlsx", "assignment": "auto"}
    ]
    assert folder_by_name(reloaded, "估值模型")["folder_id"] != original_folder["folder_id"]


def test_auto_assignment_tracks_pipeline_classification_but_manual_move_does_not(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "collection.sqlite3"
    pending = [source_file("document.pdf")]
    initial = folders.get_folder_tree(db_path, "sungrow", pending)
    assert folder_by_name(initial, "待识别")["file_count"] == 1

    classified = [source_file("document.pdf", "research_report", "accepted")]
    updated = folders.get_folder_tree(db_path, "sungrow", classified)
    assert folder_by_name(updated, "待识别")["file_count"] == 0
    assert folder_by_name(updated, "研究报告")["file_count"] == 1

    custom_tree = folders.create_folder(db_path, "sungrow", "人工归档", classified)
    custom = folder_by_name(custom_tree, "人工归档")
    folders.move_file(db_path, "sungrow", "document.pdf", custom["folder_id"], classified)
    changed_again = [source_file("document.pdf", "meeting_minutes", "accepted")]
    reloaded = folders.get_folder_tree(db_path, "sungrow", changed_again)
    assert folder_by_name(reloaded, "人工归档")["file_count"] == 1


def test_legacy_fixed_folders_and_overrides_migrate_without_losing_moves(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "collection.sqlite3"
    with sqlite3.connect(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE source_folders (
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
            CREATE TABLE source_folder_file_overrides (
                dataset_id TEXT NOT NULL,
                file_name TEXT NOT NULL,
                folder_id TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (dataset_id, file_name),
                FOREIGN KEY (dataset_id, folder_id)
                    REFERENCES source_folders(dataset_id, folder_id) ON DELETE CASCADE
            );
            """
        )
        rows = [
            ("system:meeting_minutes", "meeting_minutes", "会议纪要", 0),
            ("system:valuation_model", "valuation_model", "估值模型", 0),
            ("system:unknown", "unknown", "待识别", 0),
            ("system:needs_review", "needs_review", "待复核", 1),
        ]
        conn.executemany(
            """
            INSERT INTO source_folders (
                dataset_id, folder_id, folder_kind, classification_key,
                name, is_pinned, created_at, updated_at
            ) VALUES ('sungrow', ?, 'system', ?, ?, ?, 'now', 'now')
            """,
            rows,
        )
        conn.execute(
            """
            INSERT INTO source_folder_file_overrides
            VALUES ('sungrow', 'model.xlsx', 'system:meeting_minutes', 'now')
            """
        )

    files = [source_file("model.xlsx", "valuation_model", "accepted")]
    migrated = folders.get_folder_tree(db_path, "sungrow", files)
    assert folder_by_name(migrated, "会议纪要")["files"] == [
        {"file_name": "model.xlsx", "assignment": "manual"}
    ]
    assert folder_by_name(migrated, "待复核")["file_count"] == 0
    assert all(folder["name"] not in {"估值模型", "待识别"} for folder in migrated["folders"])

    with sqlite3.connect(db_path) as conn:
        assert (
            conn.execute(
                "SELECT 1 FROM sqlite_master WHERE name = 'source_folder_file_overrides'"
            ).fetchone()
            is None
        )
        assignment = conn.execute(
            """
            SELECT folder_id, assignment_source
            FROM source_folder_file_assignments
            WHERE dataset_id = 'sungrow' AND file_name = 'model.xlsx'
            """
        ).fetchone()
        folder_columns = {row[1] for row in conn.execute("PRAGMA table_info(source_folders)")}
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    assert assignment[0].startswith("folder_")
    assert assignment[1] == "manual"
    assert "is_pinned" not in folder_columns
    assert "sort_order" not in folder_columns
