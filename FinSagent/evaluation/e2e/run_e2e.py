#!/usr/bin/env python3
"""Run one reproducible FinSagent E2E arm and persist every first-party output."""

from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import json
import os
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml


PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

DEFAULT_OUTPUT_ROOT = Path("/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs")
VALID_RETRIEVAL_MODES = {"dci_only", "rag_only", "evidence_fusion"}
SECRET_KEYS = {"api_key", "bearer_token", "finnhub_api_key", "llm_api_key", "r1_online_appkey"}
LEGACY_REPAIR_FLAGS = (
    "skill_repair_coverage_enabled",
    "skill_repair_period_conflict_enabled",
    "skill_repair_profile_enabled",
    "skill_repair_table_enabled",
)


def _load_yaml(path: Path) -> dict[str, Any]:
    payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path}: expected a mapping")
    return payload


def _load_cases(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = payload.get("cases") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise ValueError(f"{path}: expected a list or {{'cases': [...]}}")
    return [dict(row) for row in rows]


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(item) for item in value]
    if hasattr(value, "to_dict"):
        return _jsonable(value.to_dict())
    if hasattr(value, "model_dump"):
        return _jsonable(value.model_dump())
    return str(value)


def _atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(_jsonable(payload), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def _redact(value: Any, key: str = "") -> Any:
    if key.lower() in SECRET_KEYS or key.lower().endswith(("_api_key", "_appkey", "_token")):
        return "<redacted>"
    if isinstance(value, dict):
        return {str(k): _redact(v, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _prepare_indexes(dataset_root: Path, config_path: Path) -> dict[str, Any]:
    """Reuse or atomically rebuild the complete retrieval bundle once per arm."""
    command = [
        sys.executable,
        str(PROJECT_ROOT / "data_pipeline" / "prepare_private_fund_dataset.py"),
        "--dataset-root", str(dataset_root),
        "--config", str(config_path),
    ]
    completed = subprocess.run(
        command,
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        details = (completed.stderr or completed.stdout or "").strip()[-4000:]
        raise RuntimeError(
            f"dataset index preparation failed (code={completed.returncode}): {details}"
        )
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"dataset index preparation returned invalid JSON: {completed.stdout[-2000:]!r}"
        ) from exc


def _build_config(
    base: dict[str, Any],
    *,
    combo: dict[str, Any],
    combo_id: str,
    retrieval_mode: str,
    dataset_id: str,
    run_dir: Path,
) -> dict[str, Any]:
    config = copy.deepcopy(base)
    datasets = dict(config.get("datasets") or {})
    dataset_root = Path(str(datasets["root_dir"])) / dataset_id
    datasets["active_dataset"] = dataset_id
    config["datasets"] = datasets
    config["collection_name"] = dataset_id
    config["persist_directory"] = str(dataset_root / "vector_store")
    config["retrieval_mode"] = retrieval_mode
    config["enable_memory"] = False
    config["session_history_db"] = str(run_dir / "logs" / f"sessions_{dataset_id}_{retrieval_mode}_{combo_id}.sqlite3")
    agentic_search = dict(config.get("agentic_search") or {})
    agentic_search["roots"] = [str(dataset_root / "raw")]
    config["agentic_search"] = agentic_search
    for flag in LEGACY_REPAIR_FLAGS:
        config[flag] = False

    skill_config = copy.deepcopy(config.get("skills") or {})
    skill_config["runtime_enabled"] = bool(combo.get("runtime_enabled", combo_id != "C0"))
    skill_config["execution_mode"] = str(combo.get("execution_mode") or "prompt_active")
    skill_config["expose_debug_trace"] = True
    skill_config["promoted_only"] = False
    skill_config["allow"] = list(combo.get("allow") or [])
    execution = dict(skill_config.get("execution") or {})
    execution["max_skills_per_request"] = 8
    skill_config["execution"] = execution
    config["skills"] = skill_config
    return config


def _source_doc_ids(chunks: list[dict[str, Any]]) -> list[str]:
    values: set[str] = set()
    for chunk in chunks:
        metadata = chunk.get("metadata") if isinstance(chunk, dict) else {}
        metadata = metadata if isinstance(metadata, dict) else {}
        doc_id = metadata.get("source_doc_id") or metadata.get("doc_id")
        if doc_id:
            values.add(str(doc_id))
    return sorted(values)


def _render_answer_markdown(record: dict[str, Any]) -> str:
    result = record.get("result") or {}
    traces = result.get("skill_traces") or []
    chunks = result.get("retrieved_chunks") or []
    lines = [
        f"# {record['case']['case_id']}",
        "",
        f"- Dataset: `{record['dataset_id']}`",
        f"- Retrieval: `{record['retrieval_mode']}`",
        f"- Combo: `{record['combo_id']}`",
        f"- Status: `{record['status']}`",
        f"- Elapsed: `{record['elapsed_seconds']}` seconds",
        f"- Retrieved source doc_ids: `{', '.join(_source_doc_ids(chunks))}`",
        "",
        "## Question",
        "",
        str(record["case"].get("question") or ""),
        "",
        "## Model answer",
        "",
        str(result.get("answer") or ""),
        "",
        "## Skill traces",
        "",
    ]
    if traces:
        for trace in traces:
            trace = trace if isinstance(trace, dict) else {"value": trace}
            lines.append(
                f"- `{trace.get('skill_id', '')}`: status=`{trace.get('status', '')}`, "
                f"phase=`{trace.get('phase', '')}`, applied=`{trace.get('applied', '')}`"
            )
    else:
        lines.append("- None")
    lines.extend(["", "## Ground truth", "", "```json", json.dumps(record["case"].get("answer_atoms") or [], ensure_ascii=False, indent=2), "```", ""])
    return "\n".join(lines)


async def _run(args: argparse.Namespace) -> None:
    if args.retrieval_mode not in VALID_RETRIEVAL_MODES:
        raise ValueError(f"unsupported retrieval mode: {args.retrieval_mode}")
    base_path = Path(args.base_config).resolve()
    combo_path = Path(args.combo_config).resolve()
    case_path = Path(args.cases).resolve()
    output_root = Path(args.output_root).resolve()
    if Path(args.run_id).name != args.run_id or args.run_id in {"", ".", ".."}:
        raise ValueError("run-id must be one safe path segment")
    run_dir = output_root / "runs" / args.run_id

    combos = _load_yaml(combo_path).get("combos") or {}
    if args.combo_id not in combos:
        raise KeyError(f"unknown combo: {args.combo_id}")
    combo = dict(combos[args.combo_id] or {})
    if len(combo.get("allow") or []) > 8:
        raise ValueError(f"{args.combo_id}: more than 8 skills")

    selected = [row for row in _load_cases(case_path) if str(row.get("dataset_id")) == args.dataset_id]
    requested_ids = {item for item in (args.case_ids or "").split(",") if item}
    if requested_ids:
        selected = [row for row in selected if str(row.get("case_id")) in requested_ids]
    if args.limit:
        selected = selected[: args.limit]
    if not selected:
        raise ValueError(f"no cases selected for dataset={args.dataset_id}")
    for case in selected:
        case_id = str(case.get("case_id") or "")
        if Path(case_id).name != case_id or case_id in {"", ".", ".."}:
            raise ValueError(f"unsafe case_id: {case_id!r}")

    base_config = _load_yaml(base_path)
    dataset_root = Path(str((base_config.get("datasets") or {})["root_dir"])) / args.dataset_id
    index_preparation = (
        {"status": "skipped"}
        if args.skip_index_prepare
        else _prepare_indexes(dataset_root.resolve(), base_path)
    )
    config = _build_config(
        base_config,
        combo=combo,
        combo_id=args.combo_id,
        retrieval_mode=args.retrieval_mode,
        dataset_id=args.dataset_id,
        run_dir=run_dir,
    )
    arm = Path(args.retrieval_mode) / args.combo_id / args.dataset_id
    raw_dir = run_dir / "raw_outputs" / arm
    answer_dir = run_dir / "answer_markdown" / arm
    evidence_dir = run_dir / "evidence" / arm
    log_dir = run_dir / "logs"
    for path in (raw_dir, answer_dir, evidence_dir, log_dir, run_dir / "config"):
        path.mkdir(parents=True, exist_ok=True)

    manifest = {
        "run_id": args.run_id,
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "project_root": str(PROJECT_ROOT),
        "base_config": str(base_path),
        "base_config_sha256": _sha256(base_path),
        "combo_config": str(combo_path),
        "combo_config_sha256": _sha256(combo_path),
        "cases": str(case_path),
        "cases_sha256": _sha256(case_path),
        "dataset_id": args.dataset_id,
        "retrieval_mode": args.retrieval_mode,
        "combo_id": args.combo_id,
        "combo": combo,
        "case_ids": [row.get("case_id") for row in selected],
        "model": config.get("llm_model_name"),
        "llm_base_url": config.get("llm_base_url"),
        "index_preparation": index_preparation,
    }
    _atomic_write_json(run_dir / "manifest.json", manifest)
    _atomic_write_json(run_dir / "config" / f"{args.dataset_id}_{args.retrieval_mode}_{args.combo_id}.json", _redact(config))

    pending_case_ids = {
        str(case["case_id"])
        for case in selected
        if args.overwrite or not (raw_dir / f"{case['case_id']}.json").exists()
    }
    chat_service = None
    rag_manager = None
    if pending_case_ids:
        from core.ChatService import ChatService
        from core.RAGManager import RAGManager

        RAGManager._instance = None
        rag_manager = RAGManager(config, collections={config["collection_name"]: int(config.get("retrieve_top_k", 10))})
        chat_service = ChatService(config=config, rag_manager=rag_manager, rerank_topk=int(config.get("rerank_top_k", 10)))
        runtime_status = chat_service.skill_runtime.status()
    else:
        runtime_status = {"status": "skipped_no_pending_cases", "load_errors": []}
    _atomic_write_json(run_dir / "config" / f"skill_status_{args.dataset_id}_{args.retrieval_mode}_{args.combo_id}.json", runtime_status)
    if runtime_status.get("load_errors"):
        raise RuntimeError(f"skill discovery errors: {runtime_status['load_errors']}")

    progress_path = run_dir / "progress.jsonl"
    elapsed_values: list[float] = []
    succeeded = 0
    failed = 0
    for index, case in enumerate(selected, 1):
        case_id = str(case["case_id"])
        raw_path = raw_dir / f"{case_id}.json"
        if raw_path.exists() and not args.overwrite:
            existing = json.loads(raw_path.read_text(encoding="utf-8"))
            existing_status = str(existing.get("status") or "error")
            existing_elapsed = float(existing.get("elapsed_seconds") or 0.0)
            elapsed_values.append(existing_elapsed)
            succeeded += int(existing_status == "success")
            failed += int(existing_status != "success")
            print(f"[{index}/{len(selected)}] SKIP {case_id} (exists)", flush=True)
            continue
        print(f"[{index}/{len(selected)}] START {case_id}: {case.get('question', '')[:80]}", flush=True)
        started = time.time()
        try:
            if chat_service is None or rag_manager is None:
                raise RuntimeError("E2E runtime was not initialized for a pending case")
            # E2E cases may declare a stricter document boundary than the
            # company-level resolver. Apply it to both shared config objects
            # before each request so DCI and RAG use the same fail-closed scope.
            case_allowed_doc_ids = [str(value) for value in (case.get("allowed_doc_ids") or []) if value]
            config["retrieval_scope_allowed_doc_ids"] = case_allowed_doc_ids
            rag_manager._config["retrieval_scope_allowed_doc_ids"] = case_allowed_doc_ids
            chat_service.config["retrieval_scope_allowed_doc_ids"] = case_allowed_doc_ids
            result = await asyncio.wait_for(
                chat_service.generate_response_debug_async(
                    question=str(case["question"]),
                    session_id=f"{args.run_id}_{args.retrieval_mode}_{args.combo_id}_{case_id}_{int(started * 1000)}",
                ),
                timeout=float(args.timeout),
            )
            status = "error" if result.get("error") else "success"
            error = result.get("error")
        except Exception as exc:
            result = {"answer": "", "error": f"{type(exc).__name__}: {exc}", "retrieved_chunks": [], "skill_traces": []}
            status = "error"
            error = result["error"]
        elapsed = round(time.time() - started, 3)
        elapsed_values.append(elapsed)
        succeeded += int(status == "success")
        failed += int(status != "success")
        record = {
            "case": case,
            "dataset_id": args.dataset_id,
            "retrieval_mode": args.retrieval_mode,
            "combo_id": args.combo_id,
            "status": status,
            "error": error,
            "elapsed_seconds": elapsed,
            "started_at_utc": datetime.fromtimestamp(started, timezone.utc).isoformat(),
            "finished_at_utc": datetime.now(timezone.utc).isoformat(),
            "result": result,
        }
        _atomic_write_json(raw_path, record)
        (answer_dir / f"{case_id}.md").write_text(_render_answer_markdown(record), encoding="utf-8")
        _atomic_write_json(
            evidence_dir / f"{case_id}.json",
            {
                "case_id": case_id,
                "allowed_doc_ids": case.get("allowed_doc_ids") or [],
                "forbidden_doc_ids": case.get("forbidden_doc_ids") or [],
                "retrieved_source_doc_ids": _source_doc_ids(result.get("retrieved_chunks") or []),
                "retrieved_chunks": result.get("retrieved_chunks") or [],
                "pre_rerank_candidates": result.get("pre_rerank_candidates") or [],
                "retrieval_decisions": result.get("retrieval_decisions") or [],
                "skill_traces": result.get("skill_traces") or [],
            },
        )
        with progress_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"case_id": case_id, "status": status, "elapsed_seconds": elapsed, "arm": str(arm)}, ensure_ascii=False) + "\n")
        print(f"[{index}/{len(selected)}] DONE {case_id} status={status} elapsed={elapsed:.1f}s", flush=True)

    summary = {
        "run_id": args.run_id,
        "dataset_id": args.dataset_id,
        "retrieval_mode": args.retrieval_mode,
        "combo_id": args.combo_id,
        "selected": len(selected),
        "succeeded": succeeded,
        "failed": failed,
        "latency_p50_seconds": round(statistics.median(elapsed_values), 3) if elapsed_values else None,
        "latency_max_seconds": max(elapsed_values) if elapsed_values else None,
        "completed_at_utc": datetime.now(timezone.utc).isoformat(),
    }
    _atomic_write_json(run_dir / "scorecards" / f"run_summary_{args.dataset_id}_{args.retrieval_mode}_{args.combo_id}.json", summary)
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    if failed:
        raise SystemExit(1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", required=True)
    parser.add_argument("--base-config", default=str(PROJECT_ROOT / "config" / "production.yaml"))
    parser.add_argument("--combo-config", default=str(PROJECT_ROOT / "evaluation" / "e2e" / "skill_combos.yaml"))
    parser.add_argument("--output-root", default=str(DEFAULT_OUTPUT_ROOT))
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--dataset-id", required=True)
    parser.add_argument("--retrieval-mode", required=True, choices=sorted(VALID_RETRIEVAL_MODES))
    parser.add_argument("--combo-id", required=True)
    parser.add_argument("--case-ids", default="")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--timeout", type=float, default=600.0)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument(
        "--skip-index-prepare",
        action="store_true",
        help="skip the default reuse-or-atomic-rebuild dataset index preparation",
    )
    args = parser.parse_args()
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
