"""Standalone worker for durable private-fund valuation-model tracking jobs."""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from omnigent.server import private_fund_valuation_tracking

_PROJECT_ROOT = Path(__file__).resolve().parents[3]
_PROJECT_SRC = _PROJECT_ROOT / "src"
if str(_PROJECT_SRC) not in sys.path:
    sys.path.insert(0, str(_PROJECT_SRC))
_LOGGER = logging.getLogger(__name__)
_STOP = False


def _stop(_signum: int, _frame: Any) -> None:
    global _STOP
    _STOP = True


def _workspace_root() -> Path:
    return (
        Path(
            os.environ.get("PRIVATE_FUND_DATASET_WORKSPACE")
            or _PROJECT_ROOT / "output" / "private_fund_datasets"
        )
        .expanduser()
        .resolve()
    )


def _collection_dbs(workspace: Path) -> list[tuple[str, Path]]:
    if not workspace.is_dir():
        return []
    return sorted(
        (
            (path.parent.parent.name, path)
            for path in workspace.glob("*/meta/collection.sqlite3")
            if not path.parent.parent.name.startswith("_")
        ),
        key=lambda item: item[0],
    )


def _write_health(workspace: Path, payload: dict[str, Any]) -> None:
    workspace.mkdir(parents=True, exist_ok=True)
    health_path = workspace / ".valuation-tracking-worker.json"
    temporary = health_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(health_path)


def _load_llm_client() -> Any | None:
    enabled = os.environ.get("PRIVATE_FUND_VALUATION_USE_LLM", "1").strip().lower()
    if enabled in {"0", "false", "no", "off"}:
        return None
    try:
        from pdf_research_demo.llm import OpenAICompatibleChatClient, load_llm_config

        config_path = os.environ.get("PRIVATE_FUND_LLM_CONFIG") or None
        config = load_llm_config(config_path)
        return OpenAICompatibleChatClient(config) if config else None
    except Exception:  # noqa: BLE001
        _LOGGER.warning("valuation Agent LLM is unavailable", exc_info=True)
        return None


def run_cycle(
    workspace: Path,
    llm_client: Any | None = None,
    *,
    max_jobs_per_db: int = 2,
) -> int:
    processed = 0
    errors: list[dict[str, str]] = []
    databases = _collection_dbs(workspace)
    for dataset_id, collection_db in databases:
        try:
            private_fund_valuation_tracking.recover_stale_jobs(collection_db, dataset_id)
            # This idempotent discovery also backfills historical model versions
            # and catches imports that bypass the HTTP pipeline.
            private_fund_valuation_tracking.enqueue_model_documents(
                collection_db,
                dataset_id,
                include_history=True,
            )
            for _ in range(max_jobs_per_db):
                result = private_fund_valuation_tracking.process_next_job(
                    collection_db, dataset_id, llm_client=llm_client
                )
                if result is None:
                    break
                processed += 1
                _LOGGER.info(
                    "valuation tracking job %s for %s finished with status=%s",
                    result.get("job_id"),
                    dataset_id,
                    result.get("status"),
                )
        except Exception as exc:
            _LOGGER.exception("valuation worker failed for dataset=%s", dataset_id)
            errors.append({"dataset_id": dataset_id, "error": str(exc)})
    _write_health(
        workspace,
        {
            "status": "online",
            "pid": os.getpid(),
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "processed_jobs": processed,
            "dataset_count": len(databases),
            "analyzer_version": private_fund_valuation_tracking.VALUATION_ANALYZER_VERSION,
            "llm_enabled": llm_client is not None,
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
        default=float(os.environ.get("PRIVATE_FUND_VALUATION_POLL_SECONDS", "5")),
    )
    parser.add_argument("--max-jobs-per-db", type=int, default=2)
    args = parser.parse_args()

    logging.basicConfig(
        level=os.environ.get("PRIVATE_FUND_VALUATION_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    workspace = _workspace_root()
    llm_client = _load_llm_client()
    while not _STOP:
        processed = run_cycle(
            workspace,
            llm_client,
            max_jobs_per_db=max(1, args.max_jobs_per_db),
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
        },
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
