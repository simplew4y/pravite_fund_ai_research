"""Versioned, deterministic migrations for private-fund user data."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from omnigent.product_release import (
    database_target_version,
    legacy_data_baseline,
    product_release,
    product_version,
)

MIGRATION_TABLE = "workbench_schema_migrations"
MIGRATION_COMPONENTS = (
    "collection_core",
    "document_taxonomy",
    "risk_catalyst_tracking",
    "valuation_tracking",
)
_BASE_MIGRATION_CHECKSUM = hashlib.sha256(
    b"private-fund-data-migration:0.1.1:0.2.1:v1"
).hexdigest()
_RISK_CATALYST_RESET_CHECKSUM = hashlib.sha256(
    b"private-fund-data-migration:risk-catalyst:0.1.1:0.2.1:discard-v2"
).hexdigest()
_COMPONENT_CHECKSUMS = {
    component: (
        _RISK_CATALYST_RESET_CHECKSUM
        if component == "risk_catalyst_tracking"
        else _BASE_MIGRATION_CHECKSUM
    )
    for component in MIGRATION_COMPONENTS
}
_STARTUP_MIGRATION_COMPLETED = False


class MigrationError(RuntimeError):
    pass


class DataVersionTooNew(MigrationError):
    pass


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _version_tuple(value: str) -> tuple[int, int, int]:
    parts = value.strip().split(".")
    if len(parts) != 3 or any(not part.isdigit() for part in parts):
        raise MigrationError(f"invalid data version: {value!r}")
    return tuple(int(part) for part in parts)  # type: ignore[return-value]


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


@contextmanager
def _migration_lock(lock_path: Path, *, stale_after_seconds: int = 1800) -> Iterator[None]:
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    while True:
        try:
            descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.write(descriptor, f"{os.getpid()}\n{time.time()}\n".encode())
            os.close(descriptor)
            break
        except FileExistsError:
            try:
                stale = time.time() - lock_path.stat().st_mtime > stale_after_seconds
            except FileNotFoundError:
                continue
            if stale:
                lock_path.unlink(missing_ok=True)
                continue
            raise MigrationError(f"another data migration is running: {lock_path}") from None
    try:
        yield
    finally:
        lock_path.unlink(missing_ok=True)


def discover_collection_databases(data_root: Path) -> list[Path]:
    root = data_root.expanduser().resolve()
    if not root.exists():
        return []
    matches: set[Path] = set()
    if root.name == "collection.sqlite3" and root.is_file():
        return [root]
    for candidate in root.rglob("collection.sqlite3"):
        if "backups" in candidate.parts or candidate.parent.name != "meta":
            continue
        matches.add(candidate.resolve())
    return sorted(matches)


def _ensure_migration_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {MIGRATION_TABLE} (
            migration_id TEXT PRIMARY KEY,
            component TEXT NOT NULL,
            from_version TEXT NOT NULL,
            to_version TEXT NOT NULL,
            applied_at TEXT NOT NULL,
            app_version TEXT NOT NULL,
            checksum TEXT NOT NULL
        )
        """
    )


def initialize_current_collection_version(
    conn: sqlite3.Connection,
    *,
    app_version: str | None = None,
) -> None:
    """Mark a newly-created collection as native to the current release."""

    target = database_target_version()
    active_app_version = app_version or product_version()
    _ensure_migration_table(conn)
    applied_at = _utc_now()
    for component in MIGRATION_COMPONENTS:
        checksum = _COMPONENT_CHECKSUMS[component]
        conn.execute(
            f"""
            INSERT OR IGNORE INTO {MIGRATION_TABLE}
                (migration_id, component, from_version, to_version, applied_at,
                 app_version, checksum)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                f"{component}:initialized:{target}:{checksum[:12]}",
                component,
                target,
                target,
                applied_at,
                active_app_version,
                checksum,
            ),
        )


def _component_state(conn: sqlite3.Connection, component: str) -> tuple[str, str | None]:
    exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (MIGRATION_TABLE,)
    ).fetchone()
    if exists is None:
        return legacy_data_baseline(), None
    row = conn.execute(
        f"""
        SELECT to_version, checksum FROM {MIGRATION_TABLE}
        WHERE component=? ORDER BY applied_at DESC, rowid DESC LIMIT 1
        """,
        (component,),
    ).fetchone()
    if row is None:
        return legacy_data_baseline(), None
    return str(row[0]), str(row[1])


def _load_collection_schema_ensurer() -> Any:
    try:
        from data_pipeline.private_fund_directory_ingest import ensure_collection_schema

        return ensure_collection_schema
    except ImportError:
        module_path = Path(__file__).resolve()
        candidates: list[Path] = []
        for ancestor in module_path.parents:
            candidates.extend(
                (
                    ancestor / "FinSagent",
                    ancestor / "project" / "FinSagent",
                )
            )
        finsagent = next(
            (path for path in candidates if (path / "data_pipeline").is_dir()),
            None,
        )
        if finsagent is None:
            searched = ", ".join(str(path) for path in candidates)
            raise MigrationError(
                f"FinSAgent data_pipeline was not found; searched: {searched}"
            ) from None
        if str(finsagent) not in sys.path:
            sys.path.insert(0, str(finsagent))
        from data_pipeline.private_fund_directory_ingest import ensure_collection_schema

        return ensure_collection_schema


def _dataset_id(conn: sqlite3.Connection, collection_db: Path) -> str:
    try:
        row = conn.execute(
            "SELECT dataset_id FROM documents WHERE dataset_id IS NOT NULL LIMIT 1"
        ).fetchone()
    except sqlite3.OperationalError:
        row = None
    return str(row[0]) if row and row[0] else collection_db.parent.parent.name


def _migrate_source_folders(conn: sqlite3.Connection, dataset_id: str) -> None:
    from omnigent.server import private_fund_source_folders

    try:
        rows = conn.execute(
            """
            SELECT original_filename, doc_type, classification_status
            FROM documents
            WHERE COALESCE(deleted_at, '')=''
            """
        ).fetchall()
    except sqlite3.OperationalError:
        rows = []
    files = [
        {
            "name": str(row["original_filename"]),
            "doc_type": row["doc_type"],
            "classification_status": row["classification_status"],
        }
        for row in rows
        if row["original_filename"]
    ]
    private_fund_source_folders._sync_assignments(conn, dataset_id, files)


def _discard_legacy_risk_catalyst_tracking(
    conn: sqlite3.Connection, dataset_id: str
) -> dict[str, int]:
    """Discard beta risk/catalyst outputs while preserving source files and Memos."""

    from omnigent.server import private_fund_tracking

    item_filter = "dataset_id=? AND item_type IN ('risk', 'catalyst')"
    item_ids = [
        str(row[0])
        for row in conn.execute(
            f"SELECT item_id FROM research_items WHERE {item_filter}",
            (dataset_id,),
        ).fetchall()
    ]
    version_count = int(
        conn.execute(
            """
            SELECT COUNT(*)
            FROM research_item_versions v
            JOIN research_items i ON i.item_id=v.item_id
            WHERE i.dataset_id=? AND i.item_type IN ('risk', 'catalyst')
            """,
            (dataset_id,),
        ).fetchone()[0]
    )
    alert_count = int(
        conn.execute(
            """
            SELECT COUNT(*)
            FROM research_alerts a
            JOIN research_items i ON i.item_id=a.item_id
            WHERE i.dataset_id=? AND i.item_type IN ('risk', 'catalyst')
            """,
            (dataset_id,),
        ).fetchone()[0]
    )
    job_count = int(
        conn.execute(
            "SELECT COUNT(*) FROM research_tracking_jobs WHERE dataset_id=?",
            (dataset_id,),
        ).fetchone()[0]
    )
    rule_count = int(
        conn.execute(
            """
            SELECT COUNT(*) FROM research_watch_rules
            WHERE dataset_id=? AND target_type IN ('risk', 'catalyst')
            """,
            (dataset_id,),
        ).fetchone()[0]
    )

    conn.execute(
        """
        DELETE FROM research_item_evidence
        WHERE item_version_id IN (
            SELECT v.item_version_id
            FROM research_item_versions v
            JOIN research_items i ON i.item_id=v.item_id
            WHERE i.dataset_id=? AND i.item_type IN ('risk', 'catalyst')
        )
        """,
        (dataset_id,),
    )
    conn.execute(
        """
        DELETE FROM research_item_relations
        WHERE from_item_id IN (
            SELECT item_id FROM research_items
            WHERE dataset_id=? AND item_type IN ('risk', 'catalyst')
        ) OR to_item_id IN (
            SELECT item_id FROM research_items
            WHERE dataset_id=? AND item_type IN ('risk', 'catalyst')
        )
        """,
        (dataset_id, dataset_id),
    )
    for table in (
        "research_alerts",
        "research_change_events",
        "research_tracking_observations",
        "research_item_versions",
    ):
        conn.execute(
            f"""
            DELETE FROM {table}
            WHERE item_id IN (
                SELECT item_id FROM research_items
                WHERE dataset_id=? AND item_type IN ('risk', 'catalyst')
            )
            """,
            (dataset_id,),
        )
    conn.execute(
        """
        DELETE FROM research_watch_rules
        WHERE dataset_id=? AND (
            target_type IN ('risk', 'catalyst')
            OR target_item_id IN (
                SELECT item_id FROM research_items
                WHERE dataset_id=? AND item_type IN ('risk', 'catalyst')
            )
        )
        """,
        (dataset_id, dataset_id),
    )
    conn.execute(
        "DELETE FROM research_tracking_jobs WHERE dataset_id=?",
        (dataset_id,),
    )
    conn.execute(
        f"DELETE FROM research_items WHERE {item_filter}",
        (dataset_id,),
    )
    private_fund_tracking._ensure_default_watch_rules(conn, dataset_id)
    return {
        "items": len(item_ids),
        "versions": version_count,
        "alerts": alert_count,
        "jobs": job_count,
        "rules": rule_count,
    }


def _backup_database(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(source) as source_conn, sqlite3.connect(destination) as backup_conn:
        source_conn.backup(backup_conn)


def _restore_database(backup: Path, target: Path) -> None:
    temporary = target.with_name(f".{target.name}.restore.tmp")
    temporary.unlink(missing_ok=True)
    last_error: Exception | None = None
    for attempt in range(5):
        try:
            target.with_name(f"{target.name}-wal").unlink(missing_ok=True)
            target.with_name(f"{target.name}-shm").unlink(missing_ok=True)
            with sqlite3.connect(backup, timeout=30) as source_conn, sqlite3.connect(
                target, timeout=30
            ) as target_conn:
                source_conn.backup(target_conn)
            return
        except (OSError, sqlite3.Error) as exc:
            last_error = exc
            time.sleep(0.2 * (attempt + 1))
    raise MigrationError(f"failed to restore {target} from {backup}: {last_error}")


def migrate_collection_database(
    collection_db: Path,
    *,
    app_version: str,
    backup_path: Path,
) -> dict[str, Any]:
    from omnigent.server import (
        private_fund_source_folders,
        private_fund_tracking,
        private_fund_valuation_tracking,
    )

    target = database_target_version()
    with sqlite3.connect(collection_db, timeout=30) as probe:
        states = {
            component: _component_state(probe, component)
            for component in MIGRATION_COMPONENTS
        }
    versions = {component: state[0] for component, state in states.items()}
    for component, current in versions.items():
        if _version_tuple(current) > _version_tuple(target):
            raise DataVersionTooNew(
                f"{collection_db}: {component} data version {current} is newer than app {target}"
            )
    pending = [
        component
        for component, (current, checksum) in states.items()
        if current != target or checksum != _COMPONENT_CHECKSUMS[component]
    ]
    if not pending:
        return {"database": str(collection_db), "status": "current", "version": target}

    risk_reset_only = pending == ["risk_catalyst_tracking"] and versions[
        "risk_catalyst_tracking"
    ] == target
    active_backup_path = (
        backup_path.with_name(f"{backup_path.stem}.before-risk-reset-v2{backup_path.suffix}")
        if risk_reset_only
        else backup_path
    )
    if not active_backup_path.exists():
        _backup_database(collection_db, active_backup_path)
    try:
        with sqlite3.connect(collection_db, timeout=30) as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout=30000")
            conn.execute("BEGIN IMMEDIATE")
            dataset_id = _dataset_id(conn, collection_db)
            _load_collection_schema_ensurer()(conn)
            private_fund_source_folders.ensure_schema(conn)
            _migrate_source_folders(conn, dataset_id)
            private_fund_tracking.ensure_tracking_schema(conn, dataset_id)
            private_fund_valuation_tracking.ensure_valuation_schema(conn, dataset_id)
            should_discard_legacy_tracking = (
                "risk_catalyst_tracking" in pending
                and versions["risk_catalyst_tracking"] == legacy_data_baseline()
                and _version_tuple(versions["risk_catalyst_tracking"])
                < _version_tuple(target)
            )
            discarded_tracking = (
                _discard_legacy_risk_catalyst_tracking(conn, dataset_id)
                if should_discard_legacy_tracking
                else {"items": 0, "versions": 0, "alerts": 0, "jobs": 0, "rules": 0}
            )
            _ensure_migration_table(conn)
            applied_at = _utc_now()
            for component in pending:
                checksum = _COMPONENT_CHECKSUMS[component]
                migration_id = (
                    f"{component}:{versions[component]}:{target}:{checksum[:12]}"
                )
                conn.execute(
                    f"""
                    INSERT OR IGNORE INTO {MIGRATION_TABLE}
                        (migration_id, component, from_version, to_version, applied_at,
                         app_version, checksum)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        migration_id,
                        component,
                        versions[component],
                        target,
                        applied_at,
                        app_version,
                        checksum,
                    ),
                )
            conn.commit()
        return {
            "database": str(collection_db),
            "status": "migrated",
            "fromVersions": versions,
            "version": target,
            "legacyTrackingItems": 0,
            "discardedLegacyTracking": discarded_tracking,
            "backup": str(active_backup_path),
        }
    except Exception:
        _restore_database(active_backup_path, collection_db)
        raise


def run_data_migrations(
    *,
    data_root: Path,
    backup_root: Path,
    manifest_path: Path,
    app_version: str | None = None,
) -> dict[str, Any]:
    release = product_release()
    active_app_version = app_version or product_version()
    data_root = data_root.expanduser().resolve()
    backup_root = backup_root.expanduser().resolve()
    manifest_path = manifest_path.expanduser().resolve()
    lock_path = manifest_path.with_suffix(".migration.lock")
    started_at = _utc_now()
    with _migration_lock(lock_path):
        databases = discover_collection_databases(data_root)
        migration_key = f"{legacy_data_baseline()}-to-{database_target_version()}"
        migration_backup_root = backup_root / migration_key
        results: list[dict[str, Any]] = []
        try:
            for database in databases:
                try:
                    relative = database.relative_to(data_root)
                except ValueError:
                    relative = Path(database.name)
                backup_path = migration_backup_root / relative
                results.append(
                    migrate_collection_database(
                        database,
                        app_version=active_app_version,
                        backup_path=backup_path,
                    )
                )
            manifest = {
                "productVersion": active_app_version,
                "legacyDataBaseline": release["legacyDataBaseline"],
                "databaseChanged": bool(release["databaseChanged"]),
                "databaseTargetVersion": release["databaseTargetVersion"],
                "migrationStatus": "succeeded",
                "startedAt": started_at,
                "completedAt": _utc_now(),
                "dataRoot": str(data_root),
                "backupRoot": str(migration_backup_root),
                "components": {
                    component: database_target_version() for component in MIGRATION_COMPONENTS
                },
                "databases": results,
            }
            _atomic_json(manifest_path, manifest)
            return manifest
        except Exception as exc:
            failure = {
                "productVersion": active_app_version,
                "databaseTargetVersion": database_target_version(),
                "migrationStatus": "failed",
                "startedAt": started_at,
                "completedAt": _utc_now(),
                "dataRoot": str(data_root),
                "backupRoot": str(migration_backup_root),
                "error": str(exc),
                "databases": results,
            }
            _atomic_json(manifest_path, failure)
            raise


def run_startup_data_migrations() -> dict[str, Any] | None:
    """Run the same idempotent guard for direct server entry points."""

    global _STARTUP_MIGRATION_COMPLETED
    if os.environ.get("OMNIGENT_SKIP_DATA_MIGRATIONS", "").lower() in {"1", "true", "yes"}:
        return None
    if _STARTUP_MIGRATION_COMPLETED:
        return None
    repository_root = Path(__file__).resolve().parents[3]
    data_root = Path(
        os.environ.get("PRIVATE_FUND_MIGRATION_DATA_ROOT") or repository_root / "output"
    )
    backup_root = Path(
        os.environ.get("PRIVATE_FUND_MIGRATION_BACKUP_ROOT") or data_root / "backups"
    )
    manifest_path = Path(
        os.environ.get("PRIVATE_FUND_DATA_MANIFEST") or data_root / "data-manifest.json"
    )
    result = run_data_migrations(
        data_root=data_root,
        backup_root=backup_root,
        manifest_path=manifest_path,
    )
    _STARTUP_MIGRATION_COMPLETED = True
    return result


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    migrate = subparsers.add_parser("migrate", help="Migrate private-fund user data.")
    migrate.add_argument("--app-version", default=product_version())
    migrate.add_argument("--data-root", required=True, type=Path)
    migrate.add_argument("--backup-root", required=True, type=Path)
    migrate.add_argument("--manifest", required=True, type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.command == "migrate":
        manifest = run_data_migrations(
            data_root=args.data_root,
            backup_root=args.backup_root,
            manifest_path=args.manifest,
            app_version=args.app_version,
        )
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
