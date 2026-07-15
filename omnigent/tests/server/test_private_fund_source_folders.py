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


def test_folder_tree_uses_classification_and_review_fallbacks(tmp_path: Path) -> None:
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

    assert folder_by_name(tree, "财务报告")["files"] == [
        {"file_name": "annual.pdf", "assignment": "auto"}
    ]
    assert folder_by_name(tree, "待复核")["files"][0]["file_name"] == "meeting.pdf"
    assert folder_by_name(tree, "待识别")["files"][0]["file_name"] == "legacy.xlsx"
    assert all(folder["file_count"] > 0 for folder in tree["folders"])


def test_custom_folder_crud_and_manual_assignment_survive_reload(tmp_path: Path) -> None:
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

    renamed = folders.rename_folder(
        db_path, "sungrow", custom["folder_id"], "重点跟踪", files
    )
    assert folder_by_name(renamed, "重点跟踪")["file_count"] == 1
    with pytest.raises(folders.SourceFolderNotEmptyError):
        folders.delete_folder(db_path, "sungrow", custom["folder_id"], files)

    restored = folders.move_file(db_path, "sungrow", "annual.pdf", None, files)
    assert folder_by_name(restored, "财务报告")["files"] == [
        {"file_name": "annual.pdf", "assignment": "auto"}
    ]
    deleted = folders.delete_folder(db_path, "sungrow", custom["folder_id"], files)
    assert all(folder["folder_id"] != custom["folder_id"] for folder in deleted["folders"])


def test_folder_guards_and_deleted_file_cleanup(tmp_path: Path) -> None:
    db_path = tmp_path / "collection.sqlite3"
    files = [source_file("model.xlsx", "valuation_model", "accepted")]
    tree = folders.create_folder(db_path, "sungrow", "模型", files)
    custom = folder_by_name(tree, "模型")

    with pytest.raises(folders.SourceFolderConflictError):
        folders.create_folder(db_path, "sungrow", "模型", files)
    with pytest.raises(folders.SourceFolderProtectedError):
        folders.delete_folder(db_path, "sungrow", "system:valuation_model", files)
    with pytest.raises(KeyError):
        folders.move_file(db_path, "sungrow", "missing.pdf", custom["folder_id"], files)

    folders.move_file(db_path, "sungrow", "model.xlsx", custom["folder_id"], files)
    folders.cleanup_file_overrides(db_path, "sungrow", ["model.xlsx"])
    reloaded = folders.get_folder_tree(db_path, "sungrow", files)
    assert folder_by_name(reloaded, "估值模型")["file_count"] == 1
    assert folder_by_name(reloaded, "模型")["file_count"] == 0


def test_creating_a_hidden_system_folder_reveals_it_without_duplication(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "collection.sqlite3"
    files = [source_file("review.pdf", "research_report", "needs_review")]
    tree = folders.create_folder(db_path, "sungrow", "已核验", files)
    custom = folder_by_name(tree, "已核验")

    moved = folders.move_file(
        db_path, "sungrow", "review.pdf", custom["folder_id"], files
    )
    assert all(folder["name"] != "待复核" for folder in moved["folders"])

    revealed = folders.create_folder(db_path, "sungrow", "待复核", files)
    review_folders = [
        folder for folder in revealed["folders"] if folder["name"] == "待复核"
    ]
    assert len(review_folders) == 1
    assert review_folders[0]["folder_id"] == "system:needs_review"
    assert review_folders[0]["file_count"] == 0

    reloaded = folders.get_folder_tree(db_path, "sungrow", files)
    assert folder_by_name(reloaded, "待复核")["file_count"] == 0
