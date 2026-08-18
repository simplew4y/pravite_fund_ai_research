"""Global private-fund upload routing tests."""

from __future__ import annotations

import sqlite3
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from fastapi import FastAPI, UploadFile
from fastapi.testclient import TestClient

from omnigent.server.routes import private_fund_pdf


def _project(
    dataset_id: str,
    name: str,
    *,
    company_name: str = "",
    company_ticker: str = "",
) -> None:
    private_fund_pdf._create_project_row(
        private_fund_pdf.CreateProjectRequest(
            dataset_id=dataset_id,
            name=name,
            company_name=company_name,
            company_ticker=company_ticker,
        )
    )


def _upload(filename: str, body: bytes = b"research document") -> UploadFile:
    return UploadFile(file=BytesIO(body), filename=filename)


def _classification(
    company_name: str,
    *,
    company_ticker: str = "",
    confidence: float = 0.96,
) -> SimpleNamespace:
    return SimpleNamespace(
        company_name=company_name,
        company_ticker=company_ticker,
        company_confidence=confidence,
        company_method="test",
    )


def test_filename_company_match_routes_and_indexes_one_project(
    tmp_path: Path, monkeypatch: Any
) -> None:
    monkeypatch.setattr(private_fund_pdf, "_dataset_workspace_root", lambda: tmp_path)
    monkeypatch.setenv("PRIVATE_FUND_DOCUMENT_CLASSIFIER_USE_LLM", "0")
    _project("sungrow", "阳光电源")
    batch = private_fund_pdf._create_global_upload_batch(
        [_upload("阳光电源2025年度报告.pdf")]
    )
    ingest = private_fund_pdf._private_fund_ingest_module()
    monkeypatch.setattr(ingest, "build_document_preview", lambda _path: object())
    monkeypatch.setattr(
        ingest,
        "classify_document",
        lambda *_args, **_kwargs: _classification(""),
    )

    def complete_pipeline(
        _batch_id: str, dataset_id: str, item_ids: list[str], **_kwargs: Any
    ) -> None:
        assert dataset_id == "sungrow"
        for item_id in item_ids:
            private_fund_pdf._update_global_upload_item(item_id, status="completed")

    monkeypatch.setattr(private_fund_pdf, "_run_global_upload_pipeline", complete_pipeline)

    private_fund_pdf._process_global_upload_batch(batch["batch_id"])

    result = private_fund_pdf._global_upload_batch_payload(batch["batch_id"])
    assert result is not None
    assert result["status"] == "completed"
    assert result["items"][0]["matched_dataset_id"] == "sungrow"
    assert result["items"][0]["project_match_confidence"] == 0.98
    assert (tmp_path / "_uploads" / "sungrow" / "阳光电源2025年度报告.pdf").is_file()


def test_global_upload_runs_the_real_incremental_pipeline(
    tmp_path: Path, monkeypatch: Any
) -> None:
    monkeypatch.setattr(private_fund_pdf, "_dataset_workspace_root", lambda: tmp_path)
    monkeypatch.setenv("PRIVATE_FUND_DOCUMENT_CLASSIFIER_USE_LLM", "0")
    _project("sungrow", "阳光电源")
    source = (
        "阳光电源股份有限公司\n2025年度报告\n"
        "本报告包含经营情况、财务表现、风险因素和未来业务展望。\n"
        "公司持续推进全球新能源业务，并披露资产负债和现金流情况。"
    ).encode()
    batch = private_fund_pdf._create_global_upload_batch(
        [_upload("阳光电源2025年度报告.txt", source)]
    )

    private_fund_pdf._process_global_upload_batch(batch["batch_id"])

    result = private_fund_pdf._global_upload_batch_payload(batch["batch_id"])
    assert result is not None
    assert result["status"] == "completed"
    assert result["items"][0]["status"] == "completed"
    collection_db = tmp_path / "sungrow" / "meta" / "collection.sqlite3"
    with sqlite3.connect(str(collection_db)) as conn:
        document = conn.execute(
            "SELECT status, company_name FROM documents WHERE deleted_at IS NULL"
        ).fetchone()
    assert document == ("indexed", "阳光电源股份有限公司")


def test_same_company_in_multiple_projects_uses_one_canonical_project(
    tmp_path: Path, monkeypatch: Any
) -> None:
    monkeypatch.setattr(private_fund_pdf, "_dataset_workspace_root", lambda: tmp_path)
    monkeypatch.setenv("PRIVATE_FUND_DOCUMENT_CLASSIFIER_USE_LLM", "0")
    _project("sungrow-main", "阳光电源主项目", company_name="阳光电源股份有限公司")
    _project("sungrow-phase-2", "阳光电源二期", company_name="阳光电源股份有限公司")
    batch = private_fund_pdf._create_global_upload_batch([_upload("2025年度报告.pdf")])
    ingest = private_fund_pdf._private_fund_ingest_module()
    monkeypatch.setattr(ingest, "build_document_preview", lambda _path: object())
    monkeypatch.setattr(
        ingest,
        "classify_document",
        lambda *_args, **_kwargs: _classification("阳光电源股份有限公司"),
    )

    def complete_pipeline(
        _batch_id: str, dataset_id: str, item_ids: list[str], **_kwargs: Any
    ) -> None:
        assert dataset_id == "sungrow-main"
        for item_id in item_ids:
            private_fund_pdf._update_global_upload_item(item_id, status="completed")

    monkeypatch.setattr(private_fund_pdf, "_run_global_upload_pipeline", complete_pipeline)
    private_fund_pdf._process_global_upload_batch(batch["batch_id"])

    completed = private_fund_pdf._global_upload_batch_payload(batch["batch_id"])
    assert completed is not None
    assert completed["status"] == "completed"
    assert completed["items"][0]["matched_dataset_id"] == "sungrow-main"


def test_filename_identity_understands_the_sample_document_names() -> None:
    examples = {
        "1783838833584_Formula+One+Group_FWONA.OQ_2025_Jun_11.xlsx": (
            "Formula One Group",
            "FWONA.OQ",
        ),
        "1783838881072_Porsche+AG_P911_p.DE_2025_Jul_30.xlsx": (
            "Porsche AG",
            "P911.DE",
        ),
        "1783838815979_NVIDIA+Corporation_NVDA.OQ_2025_Jul_15.xlsm": (
            "NVIDIA Corporation",
            "NVDA.OQ",
        ),
        "1783838864110_Horizon+Robotics_9660.HK_2025_Aug_06.xlsx": (
            "Horizon Robotics",
            "9660.HK",
        ),
        "1783838788554_HERMES+INTERNATIONAL_HRMS.PA_2025_Jun_30.xlsm": (
            "HERMES INTERNATIONAL",
            "HRMS.PA",
        ),
        "阳光电源300274近况交流会260701_原文.pdf": ("阳光电源", "300274"),
        "阳光电源-20260615.pdf": ("阳光电源", ""),
        "300274 v44.xlsx": ("", "300274"),
    }

    for filename, expected in examples.items():
        identity = private_fund_pdf._filename_global_upload_identity(filename)
        assert (identity.company_name, identity.company_ticker) == expected


def test_llm_verified_identity_overrides_a_misleading_filename() -> None:
    classification = SimpleNamespace(
        company_name="阳光电源股份有限公司",
        company_ticker="300274.SZ",
        company_confidence=0.98,
        company_method="llm_content_entity",
    )

    identity = private_fund_pdf._global_upload_identity(
        classification,
        "宁德时代300750年度报告.pdf",
    )

    assert identity.company_name == "阳光电源股份有限公司"
    assert identity.company_ticker == "300274.SZ"
    assert identity.company_confidence == 0.98


def test_llm_company_does_not_inherit_a_conflicting_filename_ticker() -> None:
    classification = SimpleNamespace(
        company_name="阳光电源股份有限公司",
        company_ticker="",
        company_confidence=0.98,
        company_method="llm_content_entity",
    )

    identity = private_fund_pdf._global_upload_identity(
        classification,
        "宁德时代300750年度报告.pdf",
    )

    assert identity.company_name == "阳光电源股份有限公司"
    assert identity.company_ticker == ""


def test_reviewed_item_does_not_absorb_a_verified_item_in_batch_clustering() -> None:
    reviewed = private_fund_pdf._GlobalUploadIdentity(
        company_name="阳光电源股份有限公司",
        company_ticker="300274.SZ",
        requires_review=True,
    )
    verified = private_fund_pdf._GlobalUploadIdentity(
        company_name="阳光电源股份有限公司",
        company_ticker="300274.SZ",
        company_confidence=0.98,
    )
    item_a = SimpleNamespace()
    item_b = SimpleNamespace()

    groups = private_fund_pdf._cluster_global_upload_identities(
        [(item_a, reviewed), (item_b, verified)]
    )

    assert len(groups) == 2


def test_company_review_flag_prevents_automatic_project_confidence() -> None:
    classification = SimpleNamespace(
        company_name="阳光电源股份有限公司",
        company_ticker="300274.SZ",
        company_confidence=0.99,
        company_requires_review=True,
        company_method="llm_content_entity",
    )

    identity = private_fund_pdf._global_upload_identity(
        classification,
        "阳光电源300274研究资料.pdf",
    )

    assert identity.company_confidence == 0.69
    assert identity.requires_review is True


def test_company_review_flag_blocks_even_an_exact_existing_project(
    tmp_path: Path, monkeypatch: Any
) -> None:
    monkeypatch.setattr(private_fund_pdf, "_dataset_workspace_root", lambda: tmp_path)
    _project(
        "sungrow",
        "阳光电源",
        company_name="阳光电源股份有限公司",
        company_ticker="300274.SZ",
    )
    identity = private_fund_pdf._GlobalUploadIdentity(
        company_name="阳光电源股份有限公司",
        company_ticker="300274.SZ",
        company_confidence=0.69,
        ticker_confidence=0.69,
        method="llm_content_entity",
        requires_review=True,
    )

    assert private_fund_pdf._ensure_global_upload_project(identity, []) is None


def test_sample_batch_creates_six_company_projects_and_routes_all_files(
    tmp_path: Path, monkeypatch: Any
) -> None:
    monkeypatch.setattr(private_fund_pdf, "_dataset_workspace_root", lambda: tmp_path)
    monkeypatch.setenv("PRIVATE_FUND_DOCUMENT_CLASSIFIER_USE_LLM", "0")
    filenames = [
        "1783838788554_HERMES+INTERNATIONAL_HRMS.PA_2025_Jun_30.xlsm",
        "1783838815979_NVIDIA+Corporation_NVDA.OQ_2025_Jul_15.xlsm",
        "1783838833584_Formula+One+Group_FWONA.OQ_2025_Jun_11.xlsx",
        "1783838864110_Horizon+Robotics_9660.HK_2025_Aug_06.xlsx",
        "1783838881072_Porsche+AG_P911_p.DE_2025_Jul_30.xlsx",
        "300274 v44.xlsx",
        "阳光电源-20260615.pdf",
        "阳光电源300274近况交流会260701_原文.pdf",
    ]
    batch = private_fund_pdf._create_global_upload_batch(
        [_upload(filename) for filename in filenames]
    )
    ingest = private_fund_pdf._private_fund_ingest_module()
    monkeypatch.setattr(ingest, "build_document_preview", lambda path: path)

    def classify(preview: Path, **_kwargs: Any) -> SimpleNamespace:
        if "Formula+One" in preview.name:
            return _classification("Deutsche Bank Securities Inc")
        return _classification("")

    monkeypatch.setattr(ingest, "classify_document", classify)

    def complete_pipeline(
        _batch_id: str, _dataset_id: str, item_ids: list[str], **_kwargs: Any
    ) -> None:
        for item_id in item_ids:
            private_fund_pdf._update_global_upload_item(item_id, status="completed")

    monkeypatch.setattr(private_fund_pdf, "_run_global_upload_pipeline", complete_pipeline)
    private_fund_pdf._process_global_upload_batch(batch["batch_id"])

    completed = private_fund_pdf._global_upload_batch_payload(batch["batch_id"])
    assert completed is not None
    assert completed["status"] == "completed"
    assert len(completed["items"]) == 8
    assert {item["status"] for item in completed["items"]} == {"completed"}
    assert len({item["matched_dataset_id"] for item in completed["items"]}) == 6
    with private_fund_pdf._connect_global_registry() as conn:
        projects = conn.execute(
            "SELECT name, company_ticker FROM datasets ORDER BY name"
        ).fetchall()
    assert len(projects) == 6
    assert {str(row["name"]) for row in projects} == {
        "Formula One Group",
        "HERMES INTERNATIONAL",
        "Horizon Robotics",
        "NVIDIA Corporation",
        "Porsche AG",
        "阳光电源",
    }
    sungrow_items = [
        item for item in completed["items"] if item["company_name"] == "阳光电源"
    ]
    assert len(sungrow_items) == 3
    assert len({item["matched_dataset_id"] for item in sungrow_items}) == 1


def test_identical_file_is_deduplicated_in_target_project(
    tmp_path: Path, monkeypatch: Any
) -> None:
    monkeypatch.setattr(private_fund_pdf, "_dataset_workspace_root", lambda: tmp_path)
    _project("sungrow", "阳光电源")
    target = tmp_path / "_uploads" / "sungrow" / "annual.pdf"
    target.write_bytes(b"same content")
    batch = private_fund_pdf._create_global_upload_batch(
        [_upload("annual.pdf", b"same content")]
    )
    item_id = batch["items"][0]["item_id"]

    needs_pipeline = private_fund_pdf._route_global_upload_item(
        item_id, "sungrow", match_method="manual"
    )

    assert needs_pipeline is False
    item = private_fund_pdf._global_upload_item_row(item_id)
    assert item is not None
    assert item["status"] == "duplicate"
    assert target.read_bytes() == b"same content"


def test_global_and_project_scoped_upload_endpoints_coexist(
    tmp_path: Path, monkeypatch: Any
) -> None:
    monkeypatch.setattr(private_fund_pdf, "_dataset_workspace_root", lambda: tmp_path)
    monkeypatch.setattr(private_fund_pdf, "_process_global_upload_batch", lambda _batch_id: None)
    monkeypatch.setattr(
        private_fund_pdf,
        "_queue_project_pipeline_job",
        lambda dataset_id, background_tasks, request=None: {
            "job_id": "auto-pipeline",
            "dataset_id": dataset_id,
            "status": "queued",
        },
    )
    _project("sungrow", "阳光电源")
    app = FastAPI()
    app.include_router(private_fund_pdf.create_private_fund_pdf_router(), prefix="/v1")
    client = TestClient(app)

    global_response = client.post(
        "/v1/private-fund/uploads",
        files={"files": ("global.pdf", b"global", "application/pdf")},
    )
    project_response = client.post(
        "/v1/private-fund/projects/sungrow/files",
        files={"files": ("project.pdf", b"project", "application/pdf")},
    )

    assert global_response.status_code == 202
    assert global_response.json()["batch"]["items"][0]["file_name"] == "global.pdf"
    assert project_response.status_code == 200
    assert project_response.json()["files"][0]["name"] == "project.pdf"
    assert project_response.json()["job"]["job_id"] == "auto-pipeline"
    assert (tmp_path / "_uploads" / "sungrow" / "project.pdf").is_file()
    assert list((tmp_path / "_inbox").glob("*/file_*.pdf"))
