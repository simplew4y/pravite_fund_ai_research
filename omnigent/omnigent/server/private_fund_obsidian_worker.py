"""Standalone worker for the private-fund Obsidian knowledge projection."""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from omnigent.server import private_fund_obsidian

_PROJECT_ROOT = Path(__file__).resolve().parents[3]
_LOGGER = logging.getLogger(__name__)
_STOP = False


def _stop(_signum: int, _frame: Any) -> None:
    global _STOP
    _STOP = True


def _workspace_root() -> Path:
    return (
        Path(
            os.environ.get("PRIVATE_FUND_DATASET_WORKSPACE")
            or _PROJECT_ROOT / "output" / "users"
        )
        .expanduser()
        .resolve()
    )


def _vault_root() -> Path:
    configured = os.environ.get("PRIVATE_FUND_OBSIDIAN_VAULT_PATH", "").strip()
    if not configured:
        raise RuntimeError(
            "PRIVATE_FUND_OBSIDIAN_VAULT_PATH is required for the Obsidian worker"
        )
    return Path(configured).expanduser().resolve()


def _collection_dbs(workspace: Path) -> list[tuple[str, str, Path]]:
    if not workspace.is_dir():
        return []
    return sorted(
        (
            (path.parents[3].name, path.parent.parent.name, path)
            for path in workspace.glob("*/private_fund_datasets/*/meta/collection.sqlite3")
            if not path.parent.parent.name.startswith("_")
        ),
        key=lambda item: (item[0], item[1]),
    )


def _write_health(workspace: Path, payload: dict[str, Any]) -> None:
    workspace.mkdir(parents=True, exist_ok=True)
    health_path = workspace / ".obsidian-projection-worker.json"
    temporary = health_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(health_path)


def run_cycle(
    workspace: Path,
    vault_root: Path,
    *,
    max_events_per_db: int = 20,
) -> int:
    processed = 0
    errors: list[dict[str, str]] = []
    conflicts = 0
    databases = _collection_dbs(workspace)
    for data_namespace, dataset_id, collection_db in databases:
        try:
            tenant_vault_root = vault_root / "users" / data_namespace
            tenant_vault_root.mkdir(parents=True, exist_ok=True)
            private_fund_obsidian.recover_stale_events(collection_db, dataset_id)
            result = private_fund_obsidian.sync_dataset(
                collection_db,
                dataset_id,
                tenant_vault_root,
                max_events=max_events_per_db,
            )
            processed += int(result["events_processed"])
            conflicts += int(result["conflicts"])
            _LOGGER.info(
                "Obsidian sync for %s processed=%s written=%s conflicts=%s",
                dataset_id,
                result["events_processed"],
                result["written"],
                result["conflicts"],
            )
        except Exception as exc:
            _LOGGER.exception("Obsidian worker failed for dataset=%s", dataset_id)
            errors.append({"dataset_id": dataset_id, "error": str(exc)})
    _write_health(
        workspace,
        {
            "status": "online",
            "pid": os.getpid(),
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "processed_events": processed,
            "conflicts": conflicts,
            "dataset_count": len(databases),
            "projector_version": private_fund_obsidian.PROJECTOR_VERSION,
            "vault_root": str(vault_root),
            "errors": errors,
        },
    )
    return processed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="Run one polling cycle and exit.")
    parser.add_argument(
        "--drain",
        action="store_true",
        help="Keep cycling without the normal delay until no queued work remains.",
    )
    parser.add_argument(
        "--poll-seconds",
        type=float,
        default=float(os.environ.get("PRIVATE_FUND_OBSIDIAN_POLL_SECONDS", "5")),
    )
    parser.add_argument("--max-events-per-db", type=int, default=20)
    args = parser.parse_args()

    logging.basicConfig(
        level=os.environ.get("PRIVATE_FUND_OBSIDIAN_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    workspace = _workspace_root()
    vault_root = _vault_root()
    while not _STOP:
        processed = run_cycle(
            workspace,
            vault_root,
            max_events_per_db=max(1, args.max_events_per_db),
        )
        if args.once or (args.drain and processed == 0):
            break
        if not args.drain:
            time.sleep(max(0.5, min(args.poll_seconds, 60.0)))
    _write_health(
        workspace,
        {
            "status": "stopped",
            "pid": os.getpid(),
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "projector_version": private_fund_obsidian.PROJECTOR_VERSION,
            "vault_root": str(vault_root),
        },
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
