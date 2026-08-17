from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from omnigent.server.routes import private_fund_pdf


@pytest.fixture
def artifact_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    workspace = tmp_path / "output" / "users" / "alice" / "private_fund_datasets"
    project = workspace / "project-a"
    (project / "memos").mkdir(parents=True)
    (project / "reports").mkdir()
    monkeypatch.setattr(private_fund_pdf, "_dataset_workspace_root", lambda: workspace)
    monkeypatch.setattr(private_fund_pdf, "_require_project_row", lambda dataset_id: object())
    return workspace, project


def test_artifact_paths_are_project_relative_and_previewable(
    artifact_workspace: tuple[Path, Path],
) -> None:
    _workspace, project = artifact_workspace
    markdown = project / "memos" / "memo-v2.md"
    markdown.write_text("# Memo", encoding="utf-8")

    descriptor = private_fund_pdf._project_artifact_descriptor("project-a", markdown)

    assert descriptor == {
        "format": "md",
        "path": "memos/memo-v2.md",
        "url": (
            "/v1/private-fund/dataset/memo/file?"
            "dataset_id=project-a&path=memos%2Fmemo-v2.md"
        ),
    }
    assert (
        private_fund_pdf._dataset_memo_artifact_path(
            "private_fund_datasets/project-a/memos/memo-v2.md"
        )
        == markdown
    )
    assert private_fund_pdf._dataset_memo_artifact_path(str(markdown)) == markdown
    assert private_fund_pdf._project_artifact_relative_path(
        "project-a", "memos/memo-v2.md"
    ) == "memos/memo-v2.md"


def test_project_storage_paths_are_relative_and_tenant_scoped(
    artifact_workspace: tuple[Path, Path], tmp_path: Path
) -> None:
    _workspace, project = artifact_workspace
    source = project / "raw" / "source.pdf"
    source.parent.mkdir()
    source.write_bytes(b"pdf")

    assert (
        private_fund_pdf._project_relative_storage_path("project-a", source)
        == "raw/source.pdf"
    )
    assert (
        private_fund_pdf._project_relative_storage_path("project-a", "raw/source.pdf")
        == "raw/source.pdf"
    )
    assert (
        private_fund_pdf._project_relative_storage_path(
            "project-a", tmp_path / "output" / "users" / "bob" / "secret.pdf"
        )
        is None
    )


@pytest.mark.parametrize(
    "raw_path,dataset_id",
    [
        ("../project-b/memos/secret.pdf", "project-a"),
        ("private_fund_datasets/project-b/memos/secret.pdf", "project-a"),
        ("raw/source.pdf", "project-a"),
    ],
)
def test_artifact_path_rejects_cross_project_and_non_artifact_paths(
    artifact_workspace: tuple[Path, Path],
    raw_path: str,
    dataset_id: str,
) -> None:
    _workspace, _project = artifact_workspace
    with pytest.raises(HTTPException) as caught:
        private_fund_pdf._dataset_memo_artifact_path(raw_path, dataset_id)
    assert caught.value.status_code == 404


def test_artifact_path_hides_other_tenant_and_blocks_symlink_escape(
    artifact_workspace: tuple[Path, Path],
    tmp_path: Path,
) -> None:
    _workspace, project = artifact_workspace
    other_tenant_file = (
        tmp_path
        / "output"
        / "users"
        / "bob"
        / "private_fund_datasets"
        / "project-a"
        / "memos"
        / "secret.pdf"
    )
    other_tenant_file.parent.mkdir(parents=True)
    other_tenant_file.write_bytes(b"secret")
    with pytest.raises(HTTPException) as cross_tenant:
        private_fund_pdf._dataset_memo_artifact_path(str(other_tenant_file), "project-a")
    assert cross_tenant.value.status_code == 404
    assert cross_tenant.value.detail == "Memo artifact not found."

    link = project / "memos" / "escaped.pdf"
    link.symlink_to(other_tenant_file)
    with pytest.raises(HTTPException) as symlink_escape:
        private_fund_pdf._dataset_memo_artifact_path("memos/escaped.pdf", "project-a")
    assert symlink_escape.value.status_code == 404
