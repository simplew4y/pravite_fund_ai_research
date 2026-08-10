from __future__ import annotations

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


def test_migration_discards_legacy_tracking_and_is_idempotent(tmp_path: Path) -> None:
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
        assert conn.execute("SELECT COUNT(*) FROM research_items").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM research_item_versions").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM research_tracking_jobs").fetchone()[0] == 0
        assert (
            conn.execute(
                """
                SELECT COUNT(*) FROM research_watch_rules
                WHERE dataset_id='sungrow' AND target_type IN ('risk', 'catalyst')
                """
            ).fetchone()[0]
            == 2
        )
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM workbench_schema_migrations WHERE to_version='0.2.1'"
            ).fetchone()[0]
            == 4
        )
    overview = private_fund_tracking.tracking_overview(collection, "sungrow")
    assert overview["rebuild_required"] is False
    assert overview["legacy_item_count"] == 0
    assert overview["items"] == []
    assert overview["alerts"] == []
    assert first["databases"][0]["discardedLegacyTracking"] == {
        "items": 1,
        "versions": 1,
        "alerts": 0,
        "jobs": 0,
        "rules": 2,
    }


def test_existing_v1_migration_is_reapplied_for_destructive_tracking_reset(
    tmp_path: Path,
) -> None:
    data_root = tmp_path / "data"
    collection = _legacy_collection(data_root)
    with sqlite3.connect(collection) as conn:
        migrations._ensure_migration_table(conn)
        for component in migrations.MIGRATION_COMPONENTS:
            conn.execute(
                f"""
                INSERT INTO {migrations.MIGRATION_TABLE}
                    (migration_id, component, from_version, to_version, applied_at,
                     app_version, checksum)
                VALUES (?, ?, '0.1.1', '0.2.1', '2026-01-01', '0.2.1', ?)
                """,
                (
                    f"legacy-{component}",
                    component,
                    migrations._BASE_MIGRATION_CHECKSUM,
                ),
            )
        conn.commit()

    result = migrations.run_data_migrations(
        data_root=data_root,
        backup_root=data_root / "backups",
        manifest_path=data_root / "data-manifest.json",
        app_version="0.2.1",
    )

    assert result["databases"][0]["status"] == "migrated"
    assert result["databases"][0]["discardedLegacyTracking"]["items"] == 1
    assert result["databases"][0]["backup"].endswith(
        "collection.before-risk-reset-v2.sqlite3"
    )
    with sqlite3.connect(collection) as conn:
        assert conn.execute("SELECT COUNT(*) FROM research_items").fetchone()[0] == 0
        rows = conn.execute(
            f"""
            SELECT component, checksum FROM {migrations.MIGRATION_TABLE}
            ORDER BY applied_at, rowid
            """
        ).fetchall()
    assert len(rows) == 5
    assert rows[-1] == (
        "risk_catalyst_tracking",
        migrations._RISK_CATALYST_RESET_CHECKSUM,
    )


def test_tracking_reset_preserves_other_research_items_and_memos(tmp_path: Path) -> None:
    data_root = tmp_path / "data"
    collection = _legacy_collection(data_root)
    with sqlite3.connect(collection) as conn:
        conn.execute(
            """
            INSERT INTO research_items
                (item_id, dataset_id, item_type, canonical_key, title, status,
                 current_version_no, current_version_id, first_seen_at, last_seen_at,
                 created_at, updated_at)
            VALUES ('thesis-1', 'sungrow', 'thesis', 'thesis-1', '核心投资逻辑',
                    'active', 1, 'thesis-1-v1', '2026-01-01', '2026-01-01',
                    '2026-01-01', '2026-01-01')
            """
        )
        conn.execute(
            """
            INSERT INTO research_item_versions
                (item_version_id, item_id, version_no, observed_at, source_type,
                 source_id, content, created_at)
            VALUES ('thesis-1-v1', 'thesis-1', 1, '2026-01-01', 'memo',
                    'memo-v1', '逆变器龙头地位稳固。', '2026-01-01')
            """
        )
        conn.execute(
            """
            INSERT INTO research_memo_series
                (series_id, dataset_id, series_key, topic, title,
                 current_version_no, created_at, updated_at)
            VALUES ('memo-series-1', 'sungrow', '综合投研', '综合投研', '综合投研',
                    1, '2026-01-01', '2026-01-01')
            """
        )
        conn.execute(
            """
            INSERT INTO research_memo_versions
                (memo_version_id, series_id, version_no, as_of_date, source_type,
                 status, document_versions_json, input_json, content_hash, created_at)
            VALUES ('memo-v1', 'memo-series-1', 1, '2026-01-01', 'agent_generated',
                    'completed', '[]', '{}', 'memo-hash', '2026-01-01')
            """
        )
        conn.commit()

    migrations.run_data_migrations(
        data_root=data_root,
        backup_root=data_root / "backups",
        manifest_path=data_root / "data-manifest.json",
    )

    with sqlite3.connect(collection) as conn:
        assert conn.execute(
            "SELECT item_type FROM research_items ORDER BY item_id"
        ).fetchall() == [("thesis",)]
        assert conn.execute(
            "SELECT item_version_id FROM research_item_versions ORDER BY item_version_id"
        ).fetchall() == [("thesis-1-v1",)]
        assert conn.execute(
            "SELECT memo_version_id FROM research_memo_versions"
        ).fetchall() == [("memo-v1",)]


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
