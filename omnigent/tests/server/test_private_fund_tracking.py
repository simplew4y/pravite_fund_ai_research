from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, cast

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from omnigent.server import private_fund_tracking, private_fund_tracking_worker
from omnigent.server.routes import private_fund_pdf


def _collection_db(tmp_path: Path) -> Path:
    path = tmp_path / "demo" / "meta" / "collection.sqlite3"
    path.parent.mkdir(parents=True)
    with sqlite3.connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE documents (
                doc_id TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL,
                logical_doc_id TEXT,
                version_no INTEGER,
                supersedes_doc_id TEXT,
                is_current INTEGER,
                lifecycle_state TEXT,
                original_filename TEXT,
                document_date TEXT,
                checksum TEXT,
                doc_type TEXT,
                deleted_at TEXT
            );
            CREATE TABLE chunks (
                chunk_id TEXT PRIMARY KEY,
                dataset_id TEXT,
                doc_id TEXT,
                chunk_index INTEGER,
                content TEXT
            );
            CREATE TABLE metric_facts (
                fact_id TEXT PRIMARY KEY,
                doc_id TEXT,
                metric_name TEXT,
                period TEXT,
                value_text TEXT,
                value_numeric REAL,
                unit TEXT,
                quality_status TEXT
            );
            INSERT INTO documents VALUES
                ('doc-v1', 'demo', 'meeting', 1, NULL, 1, 'active',
                 '2026Q2交流纪要.pdf', '2026-07-01', 'a', 'meeting_minutes', NULL);
            INSERT INTO chunks VALUES
                ('risk-1', 'demo', 'doc-v1', 0,
                 '海外订单存在延期风险，可能影响2026年收入确认。'),
                ('catalyst-1', 'demo', 'doc-v1', 1,
                 '新产品预计在2026年9月发布，可能成为订单增长催化剂。'),
                ('assumption-1', 'demo', 'doc-v1', 2,
                 '估值模型采用3.5%的risk free rate和7.8%的WACC假设。');
            """
        )
    return path


def test_document_event_creates_versioned_items_and_deduplicated_alerts(tmp_path: Path) -> None:
    collection_db = _collection_db(tmp_path)

    jobs = private_fund_tracking.enqueue_current_documents(collection_db, "demo")
    completed = private_fund_tracking.process_next_job(collection_db, "demo")

    assert len(jobs) == 1
    assert completed is not None
    assert completed["status"] == "completed"
    assert completed["result"]["candidate_count"] == 3

    items = private_fund_tracking.list_items(collection_db, "demo")
    assert {item["item_type"] for item in items} == {"risk", "catalyst", "assumption"}
    assert all(item["current_version_no"] == 1 for item in items)
    assert len(private_fund_tracking.list_alerts(collection_db, "demo")) == 2

    # The same document/extractor pair is idempotent and cannot emit duplicates.
    again = private_fund_tracking.enqueue_current_documents(collection_db, "demo")
    assert again[0]["job_id"] == jobs[0]["job_id"]
    assert again[0]["status"] == "completed"
    assert private_fund_tracking.process_next_job(collection_db, "demo") is None
    assert len(private_fund_tracking.list_alerts(collection_db, "demo")) == 2


def test_new_document_version_updates_existing_risk_instead_of_creating_duplicate(
    tmp_path: Path,
) -> None:
    collection_db = _collection_db(tmp_path)
    private_fund_tracking.enqueue_current_documents(collection_db, "demo")
    private_fund_tracking.process_next_job(collection_db, "demo")

    with sqlite3.connect(collection_db) as conn:
        conn.execute("UPDATE documents SET is_current=0 WHERE doc_id='doc-v1'")
        conn.execute(
            """
            INSERT INTO documents VALUES
                ('doc-v2', 'demo', 'meeting', 2, 'doc-v1', 1, 'active',
                 '2026Q3交流纪要.pdf', '2026-08-01', 'b', 'meeting_minutes', NULL)
            """
        )
        conn.execute(
            """
            INSERT INTO chunks VALUES
                ('risk-2', 'demo', 'doc-v2', 0,
                 '海外订单存在延期风险，可能显著影响2026年收入确认。')
            """
        )
        conn.commit()

    private_fund_tracking.enqueue_current_documents(collection_db, "demo")
    private_fund_tracking.process_next_job(collection_db, "demo")

    risks = private_fund_tracking.list_items(collection_db, "demo", item_type="risk")
    assert len(risks) == 1
    assert risks[0]["current_version_no"] == 2
    timeline = private_fund_tracking.get_item_timeline(collection_db, "demo", risks[0]["item_id"])
    assert [version["version_no"] for version in timeline["versions"]] == [1, 2]
    assert timeline["changes"][-1]["change_type"] == "content_changed"


def test_manual_scan_rechecks_current_documents_without_duplicate_versions(tmp_path: Path) -> None:
    collection_db = _collection_db(tmp_path)
    private_fund_tracking.enqueue_current_documents(collection_db, "demo")
    private_fund_tracking.process_next_job(collection_db, "demo")

    queued = private_fund_tracking.enqueue_manual_scan(collection_db, "demo")
    completed = private_fund_tracking.process_next_job(collection_db, "demo")

    assert queued["payload"]["document_ids"] == ["doc-v1"]
    assert completed is not None
    assert completed["job_id"] == queued["job_id"]
    assert completed["result"]["candidate_count"] == 3
    assert all(
        item["current_version_no"] == 1
        for item in private_fund_tracking.list_items(collection_db, "demo")
    )
    assert len(private_fund_tracking.list_alerts(collection_db, "demo")) == 2


def test_memo_artifacts_are_grouped_into_versions_and_comparable(tmp_path: Path) -> None:
    collection_db = _collection_db(tmp_path)
    memo_dir = tmp_path / "demo" / "memos"
    memo_dir.mkdir()
    first_md = memo_dir / "memo_v1.md"
    first_html = memo_dir / "memo_v1.html"
    first_pdf = memo_dir / "memo_v1.pdf"
    first_md.write_text("# Demo\n\n## 主要风险\n\n订单延期可能影响收入。", encoding="utf-8")
    first_html.write_text("<h1>Demo</h1>", encoding="utf-8")
    first_pdf.write_bytes(b"%PDF-1.4")
    first = private_fund_tracking.register_memo_version(
        collection_db,
        "demo",
        topic="订单与交付",
        markdown_path=first_md,
        html_path=first_html,
        pdf_path=first_pdf,
        section_evidence=[{"section": "主要风险", "evidence": [{"evidence_id": "chunk:risk-1"}]}],
        enqueue=False,
    )

    second_md = memo_dir / "memo_v2.md"
    second_md.write_text(
        "# Demo\n\n## 主要风险\n\n订单延期风险显著上升。\n\n## 催化剂\n\n九月发布新产品。",
        encoding="utf-8",
    )
    second = private_fund_tracking.register_memo_version(
        collection_db,
        "demo",
        topic="订单与交付更新",
        markdown_path=second_md,
        revision_of=first["memo_version_id"],
        section_evidence=[
            {"section": "主要风险", "evidence": [{"evidence_id": "chunk:risk-1"}]},
            {"section": "催化剂", "evidence": [{"evidence_id": "chunk:catalyst-1"}]},
        ],
        enqueue=False,
    )

    assert second["version_no"] == 2
    assert second["series_id"] == first["series_id"]
    assert second["revision_of_version_id"] == first["memo_version_id"]
    assert second["markdown_path"] == str(second_md)
    assert first["html_path"] == str(first_html)
    assert first["pdf_path"] == str(first_pdf)

    comparison = private_fund_tracking.compare_memo_versions(
        collection_db,
        "demo",
        first["memo_version_id"],
        second["memo_version_id"],
    )
    changes = {item["title"]: item["change_type"] for item in comparison["section_changes"]}
    assert changes["主要风险"] == "changed"
    assert changes["催化剂"] == "added"


def test_alert_lifecycle_and_watch_rule_are_persistent(tmp_path: Path) -> None:
    collection_db = _collection_db(tmp_path)
    private_fund_tracking.enqueue_current_documents(collection_db, "demo")
    private_fund_tracking.process_next_job(collection_db, "demo")
    alert = private_fund_tracking.list_alerts(collection_db, "demo")[0]

    updated = private_fund_tracking.update_alert_status(
        collection_db,
        "demo",
        alert["alert_id"],
        status="acknowledged",
    )
    assert updated["status"] == "acknowledged"
    assert len(private_fund_tracking.list_watch_rules(collection_db, "demo")) == 2

    custom = private_fund_tracking.upsert_watch_rule(
        collection_db,
        "demo",
        name="只看高影响风险",
        target_type="risk",
        min_priority="high",
        frequency="daily",
    )
    assert custom["target_type"] == "risk"
    assert custom["min_priority"] == "high"

    snoozed = private_fund_tracking.update_alert_status(
        collection_db,
        "demo",
        alert["alert_id"],
        status="snoozed",
        snoozed_until="2020-01-01T00:00:00+00:00",
    )
    assert snoozed["status"] == "snoozed"
    private_fund_tracking.enqueue_scheduled_scan(collection_db, "demo")
    scan = private_fund_tracking.process_next_job(collection_db, "demo")
    assert scan is not None
    assert scan["result"]["alerts_reopened"] == 1
    refreshed = next(
        item
        for item in private_fund_tracking.list_alerts(collection_db, "demo")
        if item["alert_id"] == alert["alert_id"]
    )
    assert refreshed["status"] == "new"


def test_watch_rule_keyword_query_filters_alerts(tmp_path: Path) -> None:
    collection_db = _collection_db(tmp_path)
    matching = private_fund_tracking.upsert_watch_rule(
        collection_db,
        "demo",
        name="海外风险",
        target_type="risk",
        min_priority="low",
        query={"keywords": ["海外"]},
    )
    nonmatching = private_fund_tracking.upsert_watch_rule(
        collection_db,
        "demo",
        name="供应链风险",
        target_type="risk",
        min_priority="low",
        query={"keywords": ["供应链"]},
    )

    private_fund_tracking.enqueue_current_documents(collection_db, "demo")
    private_fund_tracking.process_next_job(collection_db, "demo")
    rule_ids = {
        alert["rule_id"] for alert in private_fund_tracking.list_alerts(collection_db, "demo")
    }

    assert matching["rule_id"] in rule_ids
    assert nonmatching["rule_id"] not in rule_ids


def test_tracking_http_api_exposes_async_jobs_and_alert_lifecycle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    collection_db = _collection_db(tmp_path)
    private_fund_tracking.enqueue_current_documents(collection_db, "demo")
    private_fund_tracking.process_next_job(collection_db, "demo")
    alert = private_fund_tracking.list_alerts(collection_db, "demo")[0]

    monkeypatch.setattr(
        private_fund_pdf,
        "_require_project_row",
        lambda dataset_id: {"dataset_id": dataset_id},
    )
    monkeypatch.setattr(
        private_fund_pdf,
        "_collection_db_path",
        lambda dataset_id: collection_db,
    )
    monkeypatch.setattr(
        private_fund_pdf,
        "_project_dataset_root",
        lambda dataset_id: tmp_path / "demo",
    )
    app = FastAPI()
    app.include_router(
        private_fund_pdf.create_private_fund_pdf_router(workspace=cast(Any, object())),
        prefix="/v1",
    )
    client = TestClient(app)

    overview = client.get("/v1/private-fund/projects/demo/tracking")
    assert overview.status_code == 200
    assert overview.json()["counts"] == {"assumption": 1, "catalyst": 1, "risk": 1}
    assert overview.json()["unread_alert_count"] == 2

    queued = client.post("/v1/private-fund/projects/demo/tracking/run")
    assert queued.status_code == 202
    assert queued.json()["job"]["status"] == "queued"
    job_id = queued.json()["job"]["job_id"]
    fetched = client.get(f"/v1/private-fund/projects/demo/tracking/jobs/{job_id}")
    assert fetched.status_code == 200
    assert fetched.json()["job"]["job_id"] == job_id

    acknowledged = client.patch(
        f"/v1/private-fund/projects/demo/alerts/{alert['alert_id']}",
        json={"status": "acknowledged"},
    )
    assert acknowledged.status_code == 200
    assert acknowledged.json()["alert"]["status"] == "acknowledged"

    rules = client.get("/v1/private-fund/projects/demo/watch-rules")
    assert rules.status_code == 200
    assert len(rules.json()["watch_rules"]) == 2


def test_standalone_worker_discovers_dataset_and_drains_queue(tmp_path: Path) -> None:
    collection_db = _collection_db(tmp_path)

    processed = private_fund_tracking_worker.run_cycle(tmp_path, None)

    assert processed >= 1
    jobs = private_fund_tracking.list_jobs(collection_db, "demo")
    assert all(job["status"] == "completed" for job in jobs)
    health = (tmp_path / ".research-tracking-worker.json").read_text(encoding="utf-8")
    assert '"status": "online"' in health
    assert '"dataset_count": 1' in health


def test_stale_worker_leases_are_requeued_or_exhausted(tmp_path: Path) -> None:
    collection_db = _collection_db(tmp_path)
    first = private_fund_tracking.enqueue_job(
        collection_db,
        "demo",
        job_type="manual_scan",
        source_id="stale-retry",
    )
    second = private_fund_tracking.enqueue_job(
        collection_db,
        "demo",
        job_type="manual_scan",
        source_id="stale-exhausted",
    )
    with sqlite3.connect(collection_db) as conn:
        conn.execute(
            """
            UPDATE research_tracking_jobs
            SET status='running', attempt_count=1, locked_at='2020-01-01T00:00:00+00:00'
            WHERE job_id=?
            """,
            (first["job_id"],),
        )
        conn.execute(
            """
            UPDATE research_tracking_jobs
            SET status='running', attempt_count=max_attempts,
                locked_at='2020-01-01T00:00:00+00:00'
            WHERE job_id=?
            """,
            (second["job_id"],),
        )
        conn.commit()

    recovered = private_fund_tracking.recover_stale_jobs(collection_db, "demo")
    by_id = {job["job_id"]: job for job in private_fund_tracking.list_jobs(collection_db, "demo")}

    assert recovered == 2
    assert by_id[first["job_id"]]["status"] == "queued"
    assert by_id[second["job_id"]]["status"] == "failed"
    assert by_id[second["job_id"]]["finished_at"] is not None
