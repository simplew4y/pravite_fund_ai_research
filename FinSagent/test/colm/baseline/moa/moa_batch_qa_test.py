#!/usr/bin/env python3
import argparse
import asyncio
import json
import logging
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

import yaml

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parents[2]
SRC_DIR = PROJECT_ROOT / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.append(str(SRC_DIR))

EXPERIMENT_NAME = os.environ.get("EXPERIMENT_NAME", "moa_baseline")
MAX_WORKERS = max(1, int(os.environ.get("MOA_MAX_WORKERS", "8")))
COLLECTION_NAME = os.environ.get("MOA_COLLECTION", "zeekr")
MODE = "moa_baseline"
EXCLUDED_CHUNK_KEYS = set()

LOG_DIR = PROJECT_ROOT / "pe_logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / f"{EXPERIMENT_NAME}.log"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger("moa_batch_qa_test")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--config",
        type=str,
        default=str(PROJECT_ROOT / "config" / "production.yaml"),
    )
    parser.add_argument("--input", type=str, default=None)
    parser.add_argument("--output", type=str, default=None)
    parser.add_argument("--output_dir", type=str, default=None)
    parser.add_argument("--run_name", type=str, default=None)
    parser.add_argument("--topk", type=int, default=None)
    parser.add_argument("--rerank_topk", type=int, default=None)
    parser.add_argument("--workers", type=int, default=None)
    parser.add_argument("--persist_directory", type=str, default=None)
    parser.add_argument("--collection_name", type=str, default=None)
    return parser.parse_args()


def load_config(config_path: str) -> Optional[Dict[str, Any]]:
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f)
    except Exception as e:
        logger.error(f"Failed to load config: {e}")
        return None


def _extract_gt_chunks(item: Dict[str, Any]) -> List[str]:
    content = item.get("content")
    if isinstance(content, list):
        return [chunk for chunk in content if isinstance(chunk, str) and chunk.strip()]
    positives = item.get("positives") or []
    return [
        positive.get("chunk", "")
        for positive in positives
        if isinstance(positive, dict) and positive.get("chunk")
    ]


def load_questions(path: Path) -> List[Dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, list):
            raise ValueError("Question file must be a list")
        questions = [
            {
                "idx": idx,
                "original_question": item.get("question") or item.get("original_question") or item.get("text") or "",
                "original_answer": item.get("answer", ""),
                "ground_truth_chunks": _extract_gt_chunks(item),
            }
            for idx, item in enumerate(data, start=1)
            if isinstance(item, dict)
        ]
        logger.info(f"Loaded {len(questions)} questions from {path}")
        return questions
    except Exception as e:
        logger.error(f"Failed to load questions: {e}")
        return []


def _normalise(text: str) -> str:
    return " ".join((text or "").split()).strip().lower()


def compute_metrics(retrieved_texts: List[str], gt_texts: List[str]) -> Dict[str, float]:
    norm_retrieved = [_normalise(text) for text in retrieved_texts if _normalise(text)]
    norm_gt = [_normalise(text) for text in gt_texts if _normalise(text)]

    gt_hit = set()
    for gt_idx, gt_text in enumerate(norm_gt):
        for retrieved_text in norm_retrieved:
            if gt_text in retrieved_text or retrieved_text in gt_text:
                gt_hit.add(gt_idx)
                break

    retrieved_hit = set()
    for retrieved_idx, retrieved_text in enumerate(norm_retrieved):
        for gt_text in norm_gt:
            if gt_text in retrieved_text or retrieved_text in gt_text:
                retrieved_hit.add(retrieved_idx)
                break

    total_retrieved = len(norm_retrieved)
    total_gt = len(norm_gt)
    hits = len(gt_hit)
    precision = len(retrieved_hit) / total_retrieved if total_retrieved else 0.0
    recall = hits / total_gt if total_gt else 0.0
    union = total_retrieved + total_gt - hits
    jaccard = hits / union if union else 0.0

    return {
        "total_retrieved": total_retrieved,
        "total_gt": total_gt,
        "hits": hits,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "jaccard": round(jaccard, 4),
    }


def _sanitize_chunk_payload(chunk: Dict[str, Any]) -> Dict[str, Any]:
    sanitized = dict(chunk)
    for key in EXCLUDED_CHUNK_KEYS:
        sanitized.pop(key, None)
    return sanitized


def _sanitize_evidence_payload(evidence: Dict[str, Any]) -> Dict[str, Any]:
    sanitized = dict(evidence)
    sanitized["chunks"] = [
        _sanitize_chunk_payload(chunk)
        for chunk in evidence.get("chunks", []) or []
        if isinstance(chunk, dict)
    ]
    sanitized["pre_rerank_chunks"] = [
        _sanitize_chunk_payload(chunk)
        for chunk in evidence.get("pre_rerank_chunks", []) or []
        if isinstance(chunk, dict)
    ]
    return sanitized


def _sanitize_evidence_list(evidences: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [
        _sanitize_evidence_payload(evidence)
        for evidence in evidences or []
        if isinstance(evidence, dict)
    ]


def _build_agent_details(
    activated_agents: List[str],
    agent_outputs: Dict[str, Any],
) -> List[Dict[str, Any]]:
    details: List[Dict[str, Any]] = []
    seen_agents: Set[str] = set()

    for agent_name in activated_agents:
        seen_agents.add(agent_name)
        payload = agent_outputs.get(agent_name, {}) if isinstance(agent_outputs, dict) else {}
        details.append(
            {
                "agent": agent_name,
                "sub_queries": payload.get("sub_queries", []),
                "evidence_chunks": _sanitize_evidence_list(payload.get("evidence", [])),
            }
        )

    if isinstance(agent_outputs, dict):
        for agent_name, payload in agent_outputs.items():
            if agent_name in seen_agents:
                continue
            details.append(
                {
                    "agent": agent_name,
                    "sub_queries": payload.get("sub_queries", []),
                    "evidence_chunks": _sanitize_evidence_list(payload.get("evidence", [])),
                }
            )

    return details


def _resolve_output_paths(args: argparse.Namespace) -> tuple[str, Path, Path, Path]:
    if args.output:
        output_json = Path(args.output)
        run_name = args.run_name or output_json.stem
        jsonl_path = output_json.with_suffix(".jsonl")
    else:
        output_dir = Path(args.output_dir) if args.output_dir else SCRIPT_DIR
        run_name = args.run_name or EXPERIMENT_NAME
        output_json = output_dir / f"{run_name}.json"
        jsonl_path = output_dir / f"{run_name}.jsonl"
    output_json.parent.mkdir(parents=True, exist_ok=True)
    return run_name, output_json, jsonl_path, output_json.parent / "_metrics.json"


class ResultWriter:
    def __init__(self, jsonl_path: Path):
        self._path = jsonl_path
        self._lock = threading.Lock()
        self._completed_indices: Set[int] = set()
        self._results: List[Dict[str, Any]] = []
        self._path.parent.mkdir(parents=True, exist_ok=True)
        if self._path.exists():
            with open(self._path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    self._results.append(record)
                    if "idx" in record:
                        self._completed_indices.add(record["idx"])

    @property
    def completed_indices(self) -> Set[int]:
        return set(self._completed_indices)

    def is_done(self, idx: int) -> bool:
        return idx in self._completed_indices

    def append(self, result: Dict[str, Any]) -> None:
        with self._lock:
            self._results.append(result)
            if "idx" in result:
                self._completed_indices.add(result["idx"])
            with open(self._path, "a", encoding="utf-8") as f:
                f.write(json.dumps(result, ensure_ascii=False) + "\n")

    def all_results(self) -> List[Dict[str, Any]]:
        with self._lock:
            return list(self._results)


def _load_metrics_file(metrics_path: Path) -> List[Dict[str, Any]]:
    if not metrics_path.exists():
        return []
    with open(metrics_path, "r", encoding="utf-8") as f:
        payload = json.load(f)
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    return []


def _upsert_metrics_summary(all_metrics: List[Dict[str, Any]], summary: Dict[str, Any]) -> bool:
    run_name = summary.get("run_name")
    if run_name is not None:
        existing_indices = [
            idx for idx, existing in enumerate(all_metrics)
            if existing.get("run_name") == run_name
        ]
        if existing_indices:
            first_idx = existing_indices[0]
            all_metrics[first_idx] = summary
            for idx in reversed(existing_indices[1:]):
                del all_metrics[idx]
            return False
    all_metrics.append(summary)
    return True


def _build_final_json_record(result: Dict[str, Any]) -> Dict[str, Any]:
    if "error" in result:
        return {
            key: result[key]
            for key in ("idx", "question", "error")
            if key in result
        }
    keep_keys = (
        "idx",
        "question",
        "original_answer",
        "answer",
        "translated_query",
        "activated_agents",
        "total_retrieved",
        "total_gt",
        "hits",
        "precision",
        "recall",
        "jaccard",
        "retrieved_chunk_count",
        "pre_rerank_candidate_count",
        "llm_call_count",
        "llm_latency_seconds",
        "moa_latency_seconds",
        "elapsed_time_seconds",
        "status",
    )
    return {key: result[key] for key in keep_keys if key in result}


def _build_run_summary(
    results: List[Dict[str, Any]],
    run_name: str,
    config: Dict[str, Any],
    max_workers: int,
    output_json: Path,
    output_jsonl: Path,
) -> Dict[str, Any]:
    valid = [result for result in results if "error" not in result]
    questions_evaluated = len(valid)
    avg = lambda key: round(sum(result.get(key, 0) for result in valid) / questions_evaluated, 4) if questions_evaluated else 0.0
    total_hits = sum(result.get("hits", 0) for result in valid)
    total_gt = sum(result.get("total_gt", 0) for result in valid)
    micro_recall = round(total_hits / total_gt, 4) if total_gt else 0.0
    return {
        "run_name": run_name,
        "mode": MODE,
        "questions_evaluated": questions_evaluated,
        "questions_total": len(results),
        "success_count": sum(1 for result in results if result.get("status") == "success"),
        "failed_count": sum(1 for result in results if result.get("status") == "failed" or "error" in result),
        "config": {
            "collection_name": config.get("collection_name"),
            "persist_directory": config.get("persist_directory"),
            "retrieve_top_k": config.get("retrieve_top_k"),
            "rerank_top_k": config.get("rerank_top_k"),
            "workers": max_workers,
            "enable_ctx_decomp": False,
            "use_chunk_risk_calibration": False,
            "config_source": config.get("config_source"),
            "output_json": str(output_json),
            "output_jsonl": str(output_jsonl),
        },
        "avg_precision": avg("precision"),
        "avg_recall": avg("recall"),
        "macro_recall": avg("recall"),
        "micro_recall": micro_recall,
        "avg_jaccard": avg("jaccard"),
        "avg_retrieved": avg("total_retrieved"),
        "avg_pre_rerank_candidates": avg("pre_rerank_candidate_count"),
        "avg_llm_call_count": avg("llm_call_count"),
        "avg_llm_latency_seconds": avg("llm_latency_seconds"),
        "avg_moa_latency_seconds": avg("moa_latency_seconds"),
        "avg_elapsed_time": avg("elapsed_time_seconds"),
    }


def _prepare_baseline_config(
    config: Dict[str, Any],
    args: argparse.Namespace,
    collection_name: str,
    collection_topk: int,
    rerank_topk: int,
) -> Dict[str, Any]:
    resolved = dict(config)
    resolved["config_source"] = str(args.config)
    resolved["collection_name"] = collection_name
    resolved["retrieve_top_k"] = collection_topk
    resolved["rerank_top_k"] = rerank_topk
    resolved["rerank_topk"] = rerank_topk
    if args.persist_directory:
        resolved["persist_directory"] = args.persist_directory
    resolved["enable_ctx_decomp"] = False
    resolved["enable_dynamic_retrieval"] = False
    resolved["use_chunk_risk_calibration"] = False
    resolved["chunk_risk_model_path"] = None
    resolved["chunk_risk_lambda"] = 0.0
    return resolved


def _reset_rag_manager_singleton() -> None:
    from core.RAGManager import RAGManager

    RAGManager._instance = None
    RAGManager._config = None
    RAGManager._collections = {}
    RAGManager._retrievers = []
    RAGManager._embedding_lock = None


def build_chat_service(
    config: Dict[str, Any],
    collection_name: str,
    collection_topk: int,
    rerank_topk: int,
):
    from core.ChatService import ChatService
    from core.RAGManager import RAGManager

    rag_manager = RAGManager(config, collections={collection_name: collection_topk})
    return ChatService(config=config, rag_manager=rag_manager, rerank_topk=rerank_topk)


async def _answer_one(chat_service, question: str, session_id: str) -> Dict[str, Any]:
    return await chat_service.generate_response_moa_async(
        question=question,
        session_id=session_id,
    )


def worker_task(
    chat_service,
    question_data: Dict[str, Any],
    position: int,
    total: int,
    run_name: str,
) -> Dict[str, Any]:
    question = question_data.get("original_question", "")
    original_answer = question_data.get("original_answer", "")
    question_idx = question_data.get("idx", position)
    session_id = f"moa_{question_idx}_{int(time.time() * 1000)}_{threading.get_ident()}"
    started_at = time.time()
    try:
        response = asyncio.run(_answer_one(chat_service, question, session_id))
        elapsed = round(time.time() - started_at, 3)
        retrieved_chunks = [
            _sanitize_chunk_payload(chunk)
            for chunk in response.get("retrieved_chunks", []) or []
            if isinstance(chunk, dict)
        ]
        pre_rerank_candidates = [
            _sanitize_chunk_payload(chunk)
            for chunk in response.get("pre_rerank_candidates", []) or []
            if isinstance(chunk, dict)
        ]
        metrics = compute_metrics(
            [chunk.get("page_content", "") for chunk in retrieved_chunks if chunk.get("page_content")],
            question_data.get("ground_truth_chunks", []),
        )
        result = {
            "idx": question_idx,
            "experiment": run_name,
            "mode": MODE,
            "question": question,
            "original_answer": original_answer,
            "answer": response.get("answer", ""),
            "activated_agents": response.get("activated_agents", []),
            "translated_query": response.get("translated_query", ""),
            "round1_answers": response.get("round1_answers", {}),
            "round2_answers": response.get("round2_answers", {}),
            "agent_details": _build_agent_details(
                response.get("activated_agents", []),
                response.get("agent_outputs", {}),
            ),
            "retrieved_chunks": retrieved_chunks,
            "retrieved_chunk_count": len(retrieved_chunks),
            "pre_rerank_candidates": pre_rerank_candidates,
            "pre_rerank_candidate_count": len(pre_rerank_candidates),
            "token_usage": response.get("token_usage", {}),
            "llm_call_count": response.get("llm_call_count", 0),
            "llm_latency_seconds": response.get("llm_latency_seconds", 0.0),
            "moa_latency_seconds": response.get("moa_latency_seconds", 0.0),
            "elapsed_time_seconds": elapsed,
            "enable_query_decompose": False,
            "use_chunk_risk_calibration": False,
            "status": "success",
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "worker_thread": threading.current_thread().name,
            "worker_position": position,
            "worker_total": total,
            **metrics,
        }
        logger.info(f"[{position}/{total}] success idx={question_idx} elapsed={elapsed}s")
        return result
    except Exception as e:
        elapsed = round(time.time() - started_at, 3)
        logger.exception(f"[{position}/{total}] failed idx={question_idx}")
        return {
            "idx": question_idx,
            "experiment": run_name,
            "mode": MODE,
            "question": question,
            "original_answer": original_answer,
            "answer": "",
            "activated_agents": [],
            "translated_query": "",
            "round1_answers": {},
            "round2_answers": {},
            "agent_details": [],
            "retrieved_chunks": [],
            "retrieved_chunk_count": 0,
            "pre_rerank_candidates": [],
            "pre_rerank_candidate_count": 0,
            "token_usage": {},
            "llm_call_count": 0,
            "llm_latency_seconds": 0.0,
            "moa_latency_seconds": 0.0,
            "elapsed_time_seconds": elapsed,
            "enable_query_decompose": False,
            "use_chunk_risk_calibration": False,
            "status": "failed",
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "worker_thread": threading.current_thread().name,
            "worker_position": position,
            "worker_total": total,
            "total_retrieved": 0,
            "total_gt": len(question_data.get("ground_truth_chunks", [])),
            "hits": 0,
            "precision": 0.0,
            "recall": 0.0,
            "jaccard": 0.0,
            "error": str(e),
        }


def main() -> None:
    args = parse_args()
    config_path = Path(args.config)

    config = load_config(config_path)
    if not config:
        raise RuntimeError(f"Unable to load {config_path}")

    input_json = Path(
        args.input
        or (PROJECT_ROOT / "test" / "gt" / "process" / "zeekr_colm_136_gt.json")
    )
    run_name, output_json, output_jsonl, metrics_path = _resolve_output_paths(args)
    collection_name = args.collection_name or COLLECTION_NAME
    collection_topk = args.topk if args.topk is not None else int(config.get("retrieve_top_k") or 10)
    rerank_topk = args.rerank_topk if args.rerank_topk is not None else int(config.get("rerank_top_k", config.get("rerank_topk") or 5))
    max_workers = max(1, args.workers if args.workers is not None else MAX_WORKERS)

    questions = load_questions(input_json)
    if not questions:
        raise RuntimeError(f"Unable to load questions from {input_json}")

    os.environ["ENABLE_TITLE_SUMMARIES"] = "0"
    resolved_config = _prepare_baseline_config(
        config,
        args,
        collection_name,
        collection_topk,
        rerank_topk,
    )
    _reset_rag_manager_singleton()
    chat_service = build_chat_service(resolved_config, collection_name, collection_topk, rerank_topk)

    writer = ResultWriter(output_jsonl)
    pending_questions = [question for question in questions if not writer.is_done(question["idx"])]

    logger.info("Run this script inside the lotusenv Conda environment")
    logger.info(f"Writing jsonl results to {output_jsonl}")
    logger.info(f"Writing final answers to {output_json}")
    logger.info(f"Using max_workers={max_workers}, collection={collection_name}, topk={collection_topk}, rerank_topk={rerank_topk}")
    logger.info("Add-on features disabled: enable_ctx_decomp=False, use_chunk_risk_calibration=False")

    completed = len(writer.completed_indices)
    if completed:
        logger.info(f"Resume detected: skipping {completed} completed questions")

    if pending_questions:
        with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="moa-worker") as executor:
            futures = {
                executor.submit(worker_task, chat_service, question_data, idx, len(questions), run_name): question_data
                for idx, question_data in enumerate(pending_questions, start=completed + 1)
            }
            for future in as_completed(futures):
                result = future.result()
                writer.append(result)
                completed += 1
                logger.info(f"Progress: {completed}/{len(questions)}")

    results_sorted = sorted(writer.all_results(), key=lambda result: result.get("idx", 0))
    final_results = [_build_final_json_record(result) for result in results_sorted]
    with open(output_json, "w", encoding="utf-8") as f:
        json.dump(final_results, f, ensure_ascii=False, indent=2)

    summary = _build_run_summary(
        results_sorted,
        run_name,
        resolved_config,
        max_workers,
        output_json,
        output_jsonl,
    )
    all_metrics = _load_metrics_file(metrics_path)
    added = _upsert_metrics_summary(all_metrics, summary)
    with open(metrics_path, "w", encoding="utf-8") as f:
        json.dump(all_metrics, f, ensure_ascii=False, indent=2)

    print(f"__SUMMARY_JSON__:{json.dumps(summary, ensure_ascii=False)}")
    logger.info(f"Results written to {output_json}")
    logger.info(f"Comparative metrics {'added' if added else 'updated'}: {metrics_path}")

    logger.info("MoA threaded batch test completed")


if __name__ == "__main__":
    main()
