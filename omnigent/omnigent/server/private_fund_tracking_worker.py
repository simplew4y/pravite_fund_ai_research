"""Standalone durable worker for private-fund research tracking jobs."""

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

from omnigent.server import private_fund_tracking

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
            os.environ.get("PRIVATE_FUND_DATASET_WORKSPACE") or _PROJECT_ROOT / "output" / "users"
        )
        .expanduser()
        .resolve()
    )


def _collection_dbs(workspace: Path) -> list[tuple[str, str, Path]]:
    pairs = []
    if not workspace.is_dir():
        return pairs
    for path in workspace.glob("*/private_fund_datasets/*/meta/collection.sqlite3"):
        dataset_id = path.parent.parent.name
        data_namespace = path.parents[3].name
        if dataset_id.startswith("_"):
            continue
        pairs.append((data_namespace, dataset_id, path))
    return sorted(pairs, key=lambda item: (item[0], item[1]))


def _load_llm_client(data_namespace: str, dataset_id: str) -> Any | None:
    enabled = os.environ.get("PRIVATE_FUND_TRACKING_USE_LLM", "1").strip().lower()
    if enabled in {"0", "false", "no", "off"}:
        return None
    try:
        from pdf_research_demo.llm import LLMConfig, OpenAICompatibleChatClient

        from omnigent.server.accounts_store import SqlAlchemyAccountStore
        from omnigent.server.user_llm_gateway import issue_user_llm_token

        data_dir = Path(os.environ.get("OMNIGENT_DATA_DIR") or Path.home() / ".omnigent")
        store = SqlAlchemyAccountStore(f"sqlite:///{data_dir / 'chat.db'}")
        user_id = store.get_user_id_by_data_namespace(data_namespace)
        if not user_id:
            return None
        gateway = os.environ.get(
            "OMNIGENT_INTERNAL_LLM_GATEWAY_URL",
            "http://127.0.0.1:6767/internal/private-fund/llm",
        ).rstrip("/")
        config = LLMConfig(
            model_name="private-fund-default",
            base_url=f"{gateway}/v1",
            api_key=issue_user_llm_token(user_id, f"tracking:{dataset_id}"),
            timeout_seconds=600,
            source="user-scoped local gateway",
        )
        return OpenAICompatibleChatClient(config)
    except Exception:  # noqa: BLE001 - worker must degrade to deterministic extraction
        _LOGGER.warning(
            "tracking LLM is unavailable; using deterministic extraction", exc_info=True
        )
        return None


def _write_health(workspace: Path, payload: dict[str, Any]) -> None:
    workspace.mkdir(parents=True, exist_ok=True)
    health_path = workspace / ".research-tracking-worker.json"
    temporary = health_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(health_path)


def run_cycle(workspace: Path, llm_client: Any | None, *, max_jobs_per_db: int = 5) -> int:
    processed = 0
    errors: list[dict[str, str]] = []
    llm_available = llm_client is not None
    for data_namespace, dataset_id, collection_db in _collection_dbs(workspace):
        try:
            from omnigent.server.private_fund_tenant import bind_tenant_namespace

            with bind_tenant_namespace(data_namespace):
                dataset_llm_client = llm_client or _load_llm_client(data_namespace, dataset_id)
                llm_available = llm_available or dataset_llm_client is not None
                private_fund_tracking.recover_stale_jobs(collection_db, dataset_id)
                # Reconcile the current document snapshot every cycle so imports that
                # bypass the Omnigent HTTP pipeline still emit idempotent ingest jobs.
                private_fund_tracking.enqueue_current_documents(collection_db, dataset_id)
                # Extractor upgrades must also rebuild the current Memo baseline;
                # enqueue_job remains idempotent for an unchanged extractor version.
                private_fund_tracking.enqueue_current_memo_versions(collection_db, dataset_id)
                private_fund_tracking.enqueue_scheduled_scan(collection_db, dataset_id)
                for _ in range(max_jobs_per_db):
                    result = private_fund_tracking.process_next_job(
                        collection_db,
                        dataset_id,
                        llm_client=dataset_llm_client,
                    )
                    if result is None:
                        break
                    processed += 1
                    _LOGGER.info(
                        "tracking job %s for %s finished with status=%s",
                        result.get("job_id"),
                        dataset_id,
                        result.get("status"),
                    )
        except Exception as exc:
            _LOGGER.exception("tracking worker failed for dataset=%s", dataset_id)
            errors.append({"dataset_id": dataset_id, "error": str(exc)})
    _write_health(
        workspace,
        {
            "status": "online",
            "pid": os.getpid(),
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "processed_jobs": processed,
            "dataset_count": len(_collection_dbs(workspace)),
            "llm_enabled": llm_available,
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
        help="Keep cycling without the normal poll delay until no queued work remains.",
    )
    parser.add_argument(
        "--poll-seconds",
        type=float,
        default=float(os.environ.get("PRIVATE_FUND_TRACKING_POLL_SECONDS", "5")),
    )
    parser.add_argument("--max-jobs-per-db", type=int, default=5)
    args = parser.parse_args()

    logging.basicConfig(
        level=os.environ.get("PRIVATE_FUND_TRACKING_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    workspace = _workspace_root()
    llm_client = None
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
