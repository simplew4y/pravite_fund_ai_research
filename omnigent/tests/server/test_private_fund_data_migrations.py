from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from omnigent.server import private_fund_data_migrations as migrations
from omnigent.server import private_fund_tracking


def _legacy_collection(data_root: Path) -> Path:
    collection = (
        data_root
        / "users"
        / "namespace-1"
        / "private_fund_datasets"
        / "sungrow"
        / "meta"
        / "collection.sqlite3"
    )
    collection.parent.mkdir(parents=True)
    with sqlite3.connect(collection) as conn:
        conn.row_factory = sqlite3.Row
        migrations._load_collection_schema_ensurer()(conn)
        private_fund_tracking.ensure_tracking_schema(conn, "sungrow")
        conn.execute(
            """
            INSERT INTO research_items
                (item_id, dataset_id, item_type, canonical_key, title, status,
                 current_version_no, current_version_id, first_seen_at, last_seen_at,
                 created_at, updated_at)
            VALUES ('legacy-risk', 'sungrow', 'risk', 'legacy-risk', '海外订单风险',
                    'active', 1, 'legacy-risk-v1', '2026-01-01', '2026-01-01',
                    '2026-01-01', '2026-01-01')
            """
        )
        conn.execute(
            """
            INSERT INTO research_item_versions
                (item_version_id, item_id, version_no, observed_at, source_type,
                 source_id, content, metadata_json, created_at)
            VALUES ('legacy-risk-v1', 'legacy-risk', 1, '2026-01-01', 'document',
                    'doc-legacy', '海外订单可能延期并影响收入确认。',
                    '{"extractor_version":"research-tracking-v1"}', '2026-01-01')
            """
        )
        conn.commit()
    return collection


def test_migration_marks_legacy_tracking_and_is_idempotent(tmp_path: Path) -> None:
    data_root = tmp_path / "data"
    collection = _legacy_collection(data_root)
    manifest_path = data_root / "data-manifest.json"
    backup_root = data_root / "backups"

    first = migrations.run_data_migrations(
        data_root=data_root,
        backup_root=backup_root,
        manifest_path=manifest_path,
        app_version="0.2.1",
    )
    second = migrations.run_data_migrations(
        data_root=data_root,
        backup_root=backup_root,
        manifest_path=manifest_path,
        app_version="0.2.1",
    )

    assert first["migrationStatus"] == "succeeded"
    assert second["databases"][0]["status"] == "current"
    assert len(list(backup_root.rglob("collection.sqlite3"))) == 1
    with sqlite3.connect(collection) as conn:
        metadata = json.loads(
            conn.execute(
                """
                SELECT metadata_json FROM research_item_versions
                WHERE item_version_id='legacy-risk-v1'
                """
            ).fetchone()[0]
        )
        assert metadata["quality_status"] == "needs_review"
        assert metadata["legacy_schema_version"] == "0.1.1"
        assert metadata["requires_rebuild"] is True
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM workbench_schema_migrations WHERE to_version='0.2.1'"
            ).fetchone()[0]
            == 4
        )
    overview = private_fund_tracking.tracking_overview(collection, "sungrow")
    assert overview["rebuild_required"] is True
    assert overview["legacy_item_count"] == 1
    assert [item["item_id"] for item in overview["items"]] == ["legacy-risk"]
    assert overview["alerts"] == []


def test_migration_refuses_data_newer_than_application(tmp_path: Path) -> None:
    data_root = tmp_path / "data"
    collection = _legacy_collection(data_root)
    migrations.run_data_migrations(
        data_root=data_root,
        backup_root=data_root / "backups",
        manifest_path=data_root / "data-manifest.json",
    )
    with sqlite3.connect(collection) as conn:
        conn.execute(
            """
            UPDATE workbench_schema_migrations SET to_version='9.0.0'
            WHERE component='collection_core'
            """
        )
        conn.commit()

    with pytest.raises(migrations.DataVersionTooNew):
        migrations.run_data_migrations(
            data_root=data_root,
            backup_root=data_root / "backups",
            manifest_path=data_root / "data-manifest.json",
        )


def test_migration_failure_restores_database_without_replace(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data_root = tmp_path / "data"
    collection = _legacy_collection(data_root)

    def fail_after_write(conn: sqlite3.Connection, dataset_id: str) -> None:
        del dataset_id
        conn.execute(
            "UPDATE research_item_versions SET content='should be rolled back' "
            "WHERE item_version_id='legacy-risk-v1'"
        )
        raise RuntimeError("synthetic migration failure")

    monkeypatch.setattr(migrations, "_migrate_source_folders", fail_after_write)

    with pytest.raises(RuntimeError, match="synthetic migration failure"):
        migrations.run_data_migrations(
            data_root=data_root,
            backup_root=data_root / "backups",
            manifest_path=data_root / "data-manifest.json",
        )

    with sqlite3.connect(collection) as conn:
        content = conn.execute(
            "SELECT content FROM research_item_versions WHERE item_version_id='legacy-risk-v1'"
        ).fetchone()[0]
    assert content == "海外订单可能延期并影响收入确认。"
    assert not collection.with_name(".collection.sqlite3.restore.tmp").exists()
