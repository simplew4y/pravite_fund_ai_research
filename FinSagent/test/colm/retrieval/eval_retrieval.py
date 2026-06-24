#!/usr/bin/env python3
"""
Retrieval Evaluation Script for Multi-Agent RAG System.

Measures retrieval quality by comparing deduplicated retrieved chunks against
ground-truth evidence chunks.  Supports ablation over:
  - multi-role agent routing vs. general-only
  - query decomposition (title-summary coarse retrieval)
  - memory (cross-question session continuity)
  - retrieve_top_k / rerank_top_k

Features:
  - Concurrent evaluation with --workers N  (asyncio semaphore)
  - Incremental save: each result is appended to a .jsonl file immediately
  - Stop & resume: on restart the .jsonl is loaded and completed indices are
    skipped automatically.  Just re-run the same command.

Metrics reported per question and aggregated:
  - Total chunks retrieved
  - Precision
  - Hit Rate / Recall
  - Jaccard Index
  - Retrieval wall-clock time
"""

import argparse
import asyncio
import json
import logging
import os
import sys
import time
import threading
from datetime import datetime
import yaml
from pathlib import Path
from typing import Any, Dict, List, Set

# ------------------------------------------------------------------
# Path setup – add src/ so all project imports resolve
# ------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from agents.shared import reset_retrieval_timer, get_retrieval_time
from agents.shared import retrieve_evidence

# ------------------------------------------------------------------
# Logging
# ------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger("eval_retrieval")

EXCLUDED_CHUNK_KEYS = set()


# ===== Helpers ====================================================

DEFAULT_EVAL_SETTINGS = {
    "gt_path": str(PROJECT_ROOT / "test" / "gt" / "lotus_109_gt.json"),
    "rerank_top_k": 5,
    "retrieve_top_k": 10,
    "use_multi_role": False,
    "enable_dynamic_retrieval": False,
    "enable_ctx_decomp": False,
    "enable_memory": False,
    "stop_after_retrieval": False,
    "use_chunk_risk_calibration": False,
    "chunk_risk_model_path": None,
    "chunk_risk_penalty_mode": "percentile_rank",
    "chunk_risk_lambda": None,
    "pageindex_mode": "off",
    "pageindex_index_dir": None,
    "pageindex_top_k": None,
    "pageindex_node_top_k": None,
    "pageindex_max_chunks_per_node": 3,
    "pageindex_page_window": 0,
    "pageindex_include_node_summary": None,
    "pageindex_recency_boost": None,
    "pageindex_final_cap": None,
    "pageindex_score_multiplier": None,
    "evidence_rescue_enabled": None,
    "evidence_rescue_k": None,
    "evidence_rescue_min_score": None,
    "evidence_rescue_min_year": None,
    "answer_self_check_enabled": None,
    "answer_self_check_max_chars": None,
    "collection_name": "default",
    "workers": 1,
}

def load_config(config_path: str = None) -> Dict[str, Any]:
    if config_path is None:
        config_path = str(PROJECT_ROOT / "config" / "production.yaml")
    with open(config_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def _resolve_eval_settings(
    args: argparse.Namespace,
    config: Dict[str, Any],
) -> Dict[str, Any]:
    resolved = dict(DEFAULT_EVAL_SETTINGS)
    resolved["persist_directory"] = config.get("persist_directory")
    resolved["gt_path"] = config.get("gt_path", resolved["gt_path"])
    resolved["retrieve_top_k"] = config.get("retrieve_top_k", resolved["retrieve_top_k"])
    resolved["rerank_top_k"] = config.get("rerank_top_k", config.get("rerank_topk", resolved["rerank_top_k"]))
    resolved["collection_name"] = config.get("collection_name", resolved["collection_name"])
    resolved["workers"] = config.get("workers", resolved["workers"])
    resolved["use_multi_role"] = config.get("use_multi_role", resolved["use_multi_role"])
    resolved["enable_dynamic_retrieval"] = config.get("enable_dynamic_retrieval", resolved["enable_dynamic_retrieval"])
    resolved["enable_ctx_decomp"] = config.get("enable_ctx_decomp", resolved["enable_ctx_decomp"])
    resolved["enable_memory"] = config.get("enable_memory", resolved["enable_memory"])
    resolved["stop_after_retrieval"] = config.get("stop_after_retrieval", resolved["stop_after_retrieval"])
    resolved["use_chunk_risk_calibration"] = config.get("use_chunk_risk_calibration", resolved["use_chunk_risk_calibration"])
    resolved["chunk_risk_model_path"] = config.get("chunk_risk_model_path", resolved["chunk_risk_model_path"])
    resolved["chunk_risk_penalty_mode"] = config.get("chunk_risk_penalty_mode", resolved["chunk_risk_penalty_mode"])
    resolved["chunk_risk_lambda"] = config.get("chunk_risk_lambda", resolved["chunk_risk_lambda"])
    resolved["pageindex_mode"] = config.get("pageindex_mode", resolved["pageindex_mode"])
    resolved["pageindex_index_dir"] = config.get("pageindex_index_dir", resolved["pageindex_index_dir"])
    resolved["pageindex_top_k"] = config.get("pageindex_top_k", resolved["pageindex_top_k"])
    resolved["pageindex_node_top_k"] = config.get("pageindex_node_top_k", resolved["pageindex_node_top_k"])
    resolved["pageindex_max_chunks_per_node"] = config.get(
        "pageindex_max_chunks_per_node",
        resolved["pageindex_max_chunks_per_node"],
    )
    resolved["pageindex_page_window"] = config.get("pageindex_page_window", resolved["pageindex_page_window"])
    resolved["pageindex_include_node_summary"] = config.get(
        "pageindex_include_node_summary",
        resolved["pageindex_include_node_summary"],
    )
    resolved["pageindex_recency_boost"] = config.get(
        "pageindex_recency_boost",
        resolved["pageindex_recency_boost"],
    )
    resolved["pageindex_final_cap"] = config.get("pageindex_final_cap", resolved["pageindex_final_cap"])
    resolved["pageindex_score_multiplier"] = config.get(
        "pageindex_score_multiplier",
        resolved["pageindex_score_multiplier"],
    )
    resolved["evidence_rescue_enabled"] = config.get(
        "evidence_rescue_enabled",
        resolved["evidence_rescue_enabled"],
    )
    resolved["evidence_rescue_k"] = config.get("evidence_rescue_k", resolved["evidence_rescue_k"])
    resolved["evidence_rescue_min_score"] = config.get(
        "evidence_rescue_min_score",
        resolved["evidence_rescue_min_score"],
    )
    resolved["evidence_rescue_min_year"] = config.get(
        "evidence_rescue_min_year",
        resolved["evidence_rescue_min_year"],
    )
    resolved["answer_self_check_enabled"] = config.get(
        "answer_self_check_enabled",
        resolved["answer_self_check_enabled"],
    )
    resolved["answer_self_check_max_chars"] = config.get(
        "answer_self_check_max_chars",
        resolved["answer_self_check_max_chars"],
    )

    cli_overrides = {}
    for key in (
        "gt_path",
        "rerank_top_k",
        "retrieve_top_k",
        "persist_directory",
        "collection_name",
        "workers",
        "use_multi_role",
        "enable_dynamic_retrieval",
        "enable_ctx_decomp",
        "enable_memory",
        "stop_after_retrieval",
        "use_chunk_risk_calibration",
        "chunk_risk_model_path",
        "chunk_risk_penalty_mode",
        "chunk_risk_lambda",
        "pageindex_mode",
        "pageindex_index_dir",
        "pageindex_top_k",
        "pageindex_node_top_k",
        "pageindex_max_chunks_per_node",
        "pageindex_page_window",
        "pageindex_include_node_summary",
        "pageindex_recency_boost",
        "pageindex_final_cap",
        "pageindex_score_multiplier",
        "evidence_rescue_enabled",
        "evidence_rescue_k",
        "evidence_rescue_min_score",
        "evidence_rescue_min_year",
        "answer_self_check_enabled",
        "answer_self_check_max_chars",
    ):
        value = getattr(args, key)
        if value is not None:
            cli_overrides[key] = value

    resolved.update(cli_overrides)

    config["gt_path"] = resolved["gt_path"]
    config["persist_directory"] = resolved["persist_directory"]
    config["collection_name"] = resolved["collection_name"]
    config["retrieve_top_k"] = resolved["retrieve_top_k"]
    config["rerank_top_k"] = resolved["rerank_top_k"]
    config["rerank_topk"] = resolved["rerank_top_k"]
    config["table_lookup_jsonl"] = args.table_lookup_jsonl
    config["workers"] = resolved["workers"]
    config["use_multi_role"] = resolved["use_multi_role"]
    config["enable_dynamic_retrieval"] = resolved["enable_dynamic_retrieval"]
    config["enable_ctx_decomp"] = resolved["enable_ctx_decomp"]
    config["stop_after_retrieval"] = resolved["stop_after_retrieval"]
    config["enable_memory"] = resolved["enable_memory"]
    config["use_chunk_risk_calibration"] = resolved["use_chunk_risk_calibration"]
    config["chunk_risk_model_path"] = resolved["chunk_risk_model_path"]
    config["chunk_risk_penalty_mode"] = resolved["chunk_risk_penalty_mode"]
    config["chunk_risk_lambda"] = resolved["chunk_risk_lambda"]
    config["pageindex_mode"] = resolved["pageindex_mode"]
    config["pageindex_index_dir"] = resolved["pageindex_index_dir"]
    config["pageindex_top_k"] = resolved["pageindex_top_k"] or resolved["retrieve_top_k"]
    config["pageindex_node_top_k"] = resolved["pageindex_node_top_k"] or resolved["retrieve_top_k"]
    config["pageindex_max_chunks_per_node"] = resolved["pageindex_max_chunks_per_node"]
    config["pageindex_page_window"] = resolved["pageindex_page_window"]
    config["pageindex_include_node_summary"] = resolved["pageindex_include_node_summary"]
    config["pageindex_recency_boost"] = resolved["pageindex_recency_boost"]
    config["pageindex_final_cap"] = resolved["pageindex_final_cap"]
    config["pageindex_score_multiplier"] = resolved["pageindex_score_multiplier"]
    config["evidence_rescue_enabled"] = resolved["evidence_rescue_enabled"]
    config["evidence_rescue_k"] = resolved["evidence_rescue_k"]
    config["evidence_rescue_min_score"] = resolved["evidence_rescue_min_score"]
    config["evidence_rescue_min_year"] = resolved["evidence_rescue_min_year"]
    config["answer_self_check_enabled"] = resolved["answer_self_check_enabled"]
    config["answer_self_check_max_chars"] = resolved["answer_self_check_max_chars"]

    args.gt_path = resolved["gt_path"]
    args.rerank_top_k = resolved["rerank_top_k"]
    args.retrieve_top_k = resolved["retrieve_top_k"]
    args.use_multi_role = resolved["use_multi_role"]
    args.enable_dynamic_retrieval = resolved["enable_dynamic_retrieval"]
    args.enable_ctx_decomp = resolved["enable_ctx_decomp"]
    args.enable_memory = resolved["enable_memory"]
    args.stop_after_retrieval = resolved["stop_after_retrieval"]
    args.collection_name = resolved["collection_name"]
    args.workers = resolved["workers"]
    args.persist_directory = resolved["persist_directory"]
    args.use_chunk_risk_calibration = resolved["use_chunk_risk_calibration"]
    args.chunk_risk_model_path = resolved["chunk_risk_model_path"]
    args.chunk_risk_penalty_mode = resolved["chunk_risk_penalty_mode"]
    args.chunk_risk_lambda = resolved["chunk_risk_lambda"]
    args.pageindex_mode = resolved["pageindex_mode"]
    args.pageindex_index_dir = resolved["pageindex_index_dir"]
    args.pageindex_top_k = resolved["pageindex_top_k"] or resolved["retrieve_top_k"]
    args.pageindex_node_top_k = resolved["pageindex_node_top_k"] or resolved["retrieve_top_k"]
    args.pageindex_max_chunks_per_node = resolved["pageindex_max_chunks_per_node"]
    args.pageindex_page_window = resolved["pageindex_page_window"]
    args.pageindex_include_node_summary = resolved["pageindex_include_node_summary"]
    args.pageindex_recency_boost = resolved["pageindex_recency_boost"]
    args.pageindex_final_cap = resolved["pageindex_final_cap"]
    args.pageindex_score_multiplier = resolved["pageindex_score_multiplier"]
    args.evidence_rescue_enabled = resolved["evidence_rescue_enabled"]
    args.evidence_rescue_k = resolved["evidence_rescue_k"]
    args.evidence_rescue_min_score = resolved["evidence_rescue_min_score"]
    args.evidence_rescue_min_year = resolved["evidence_rescue_min_year"]
    args.answer_self_check_enabled = resolved["answer_self_check_enabled"]
    args.answer_self_check_max_chars = resolved["answer_self_check_max_chars"]

    return resolved


def _build_run_config_payload(
    config: Dict[str, Any],
    args: argparse.Namespace,
) -> Dict[str, Any]:
    payload = dict(config)
    payload["run_name"] = args.run_name
    payload["gt_path"] = args.gt_path
    payload["output_dir"] = args.output_dir
    payload["collection_name"] = args.collection_name
    payload["persist_directory"] = args.persist_directory
    payload["retrieve_top_k"] = args.retrieve_top_k
    payload["rerank_top_k"] = args.rerank_top_k
    payload["rerank_topk"] = args.rerank_top_k
    payload["workers"] = args.workers
    payload["use_multi_role"] = args.use_multi_role
    payload["enable_dynamic_retrieval"] = args.enable_dynamic_retrieval
    payload["enable_ctx_decomp"] = args.enable_ctx_decomp
    payload["stop_after_retrieval"] = args.stop_after_retrieval
    payload["enable_memory"] = args.enable_memory
    payload["use_chunk_risk_calibration"] = args.use_chunk_risk_calibration
    payload["chunk_risk_model_path"] = args.chunk_risk_model_path
    payload["chunk_risk_penalty_mode"] = args.chunk_risk_penalty_mode
    payload["chunk_risk_lambda"] = args.chunk_risk_lambda
    payload["pageindex_mode"] = args.pageindex_mode
    payload["pageindex_index_dir"] = args.pageindex_index_dir
    payload["pageindex_top_k"] = args.pageindex_top_k
    payload["pageindex_node_top_k"] = args.pageindex_node_top_k
    payload["pageindex_max_chunks_per_node"] = args.pageindex_max_chunks_per_node
    payload["pageindex_page_window"] = args.pageindex_page_window
    payload["pageindex_include_node_summary"] = args.pageindex_include_node_summary
    payload["pageindex_recency_boost"] = args.pageindex_recency_boost
    payload["pageindex_final_cap"] = args.pageindex_final_cap
    payload["pageindex_score_multiplier"] = args.pageindex_score_multiplier
    payload["evidence_rescue_enabled"] = args.evidence_rescue_enabled
    payload["evidence_rescue_k"] = args.evidence_rescue_k
    payload["evidence_rescue_min_score"] = args.evidence_rescue_min_score
    payload["evidence_rescue_min_year"] = args.evidence_rescue_min_year
    payload["answer_self_check_enabled"] = args.answer_self_check_enabled
    payload["answer_self_check_max_chars"] = args.answer_self_check_max_chars
    payload["pre_run_jsonl"] = args.pre_run_jsonl
    payload["table_lookup_jsonl"] = args.table_lookup_jsonl
    payload["config_source"] = args.config_path or str(PROJECT_ROOT / "config" / "production.yaml")
    return payload


def _save_run_config(
    out_dir: Path,
    config: Dict[str, Any],
    args: argparse.Namespace,
) -> Path:
    run_config_path = out_dir / f"{args.run_name}_config.yaml"
    with open(run_config_path, "w", encoding="utf-8") as f:
        yaml.safe_dump(
            _build_run_config_payload(config, args),
            f,
            sort_keys=False,
            allow_unicode=True,
        )
    return run_config_path


def load_ground_truth(gt_path: str) -> List[Dict[str, Any]]:
    """Load ground truth JSON.  Each entry must have a ``content`` list."""
    with open(gt_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    valid: List[Dict[str, Any]] = []
    content_count = 0
    positives_count = 0

    for item in data:
        content = item.get("content")
        if not content:
            positives = item.get("positives") or []
            content = [
                positive.get("chunk", "")
                for positive in positives
                if isinstance(positive, dict) and positive.get("chunk")
            ]
            if content:
                positives_count += 1
        else:
            content_count += 1

        if content:
            normalized_item = dict(item)
            normalized_item["content"] = content
            valid.append(normalized_item)

    logger.info(
        f"Loaded {len(valid)}/{len(data)} GT entries from {gt_path} "
        f"(content={content_count}, positives_fallback={positives_count})"
    )
    return valid


def load_jsonl_records(jsonl_path: str) -> List[Dict[str, Any]]:
    """Load newline-delimited JSON records from a .jsonl file."""
    records: List[Dict[str, Any]] = []
    with open(jsonl_path, "r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSONL at {jsonl_path}:{line_no}: {exc}") from exc
            if isinstance(payload, dict):
                records.append(payload)
    logger.info(f"Loaded {len(records)} pre-run records from {jsonl_path}")
    return records


def _get_question(item: Dict[str, Any]) -> str:
    """Extract question text from GT entry, supporting different GT formats."""
    return (
        item.get("question")
        or item.get("original_question")
        or item.get("text")
        or ""
    )


def _normalise(text: str) -> str:
    """Light normalisation for fuzzy chunk comparison."""
    return " ".join(text.split()).strip().lower()


def compute_metrics(
    retrieved_texts: List[str],
    gt_texts: List[str],
) -> Dict[str, float]:
    """
    Compare retrieved chunk texts against ground-truth evidence texts.

    Uses normalised substring matching: a retrieved chunk *hits* a GT chunk if
    either one is a substring of the other (handles minor formatting diffs).
    """
    norm_retrieved = [_normalise(t) for t in retrieved_texts]
    norm_gt = [_normalise(t) for t in gt_texts]

    gt_hit = set()
    for gi, g in enumerate(norm_gt):
        for r in norm_retrieved:
            if g in r or r in g:
                gt_hit.add(gi)
                break

    ret_hit = set()
    for ri, r in enumerate(norm_retrieved):
        for g in norm_gt:
            if g in r or r in g:
                ret_hit.add(ri)
                break

    n_retrieved = len(norm_retrieved)
    n_gt = len(norm_gt)
    hits = len(gt_hit)

    precision = len(ret_hit) / n_retrieved if n_retrieved else 0.0
    recall = hits / n_gt if n_gt else 0.0
    union = n_retrieved + n_gt - hits
    jaccard = hits / union if union else 0.0

    return {
        "total_retrieved": n_retrieved,
        "total_gt": n_gt,
        "hits": hits,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "jaccard": round(jaccard, 4),
    }


def _reset_rag_manager_singleton():
    """Reset the RAGManager singleton so a new config/persist_directory takes effect."""
    from core.RAGManager import RAGManager
    RAGManager._instance = None
    RAGManager._config = None
    RAGManager._collections = {}
    RAGManager._retrievers = []
    RAGManager._retriever_lock = None


def _build_agent_details(
    activated_agents: List[str],
    agent_outputs: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """Build a JSON-serializable per-agent debug payload."""
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


def _extract_pre_run_agent_outputs(record: Dict[str, Any]) -> Dict[str, Any]:
    agent_outputs = record.get("agent_outputs")
    if isinstance(agent_outputs, dict) and agent_outputs:
        return agent_outputs

    extracted: Dict[str, Any] = {}
    for detail in record.get("agent_details", []) or []:
        if not isinstance(detail, dict):
            continue
        agent_name = detail.get("agent")
        if not agent_name:
            continue
        extracted[agent_name] = {
            "agent": agent_name,
            "rewritten_question": record.get("question", ""),
            "sub_queries": detail.get("sub_queries", []) or [],
            "evidence": detail.get("evidence_chunks", []) or [],
            "tool_results": {},
            "draft_answer": "",
            "assumptions": [],
            "risks": [],
        }
    return extracted


def _build_pre_run_lookup(records: List[Dict[str, Any]]) -> Dict[tuple, Dict[str, Any]]:
    lookup: Dict[tuple, Dict[str, Any]] = {}
    for record in records:
        idx = record.get("idx")
        question = record.get("question") or ""
        key = (idx, _normalise(question))
        if idx is not None:
            lookup[key] = record
    return lookup


def _get_pre_run_record(
    lookup: Dict[tuple, Dict[str, Any]],
    idx: int,
    question: str,
) -> Dict[str, Any] | None:
    return lookup.get((idx, _normalise(question)))


def _flatten_retrieved_chunks_from_agent_outputs(agent_outputs: Dict[str, Any]) -> List[Dict[str, Any]]:
    seen_contents: Set[str] = set()
    retrieved_chunks: List[Dict[str, Any]] = []

    for payload in agent_outputs.values():
        if not isinstance(payload, dict):
            continue
        for evidence in payload.get("evidence", []) or []:
            if not isinstance(evidence, dict):
                continue
            for chunk in evidence.get("chunks", []) or []:
                if not isinstance(chunk, dict):
                    continue
                sanitized_chunk = _sanitize_chunk_payload(chunk)
                page_content = sanitized_chunk.get("page_content", "")
                dedupe_key = page_content or json.dumps(sanitized_chunk, ensure_ascii=False, sort_keys=True)
                if dedupe_key in seen_contents:
                    continue
                seen_contents.add(dedupe_key)
                retrieved_chunks.append(sanitized_chunk)

    return retrieved_chunks


# ===== JSONL incremental persistence =================================

class ResultWriter:
    """Thread-safe JSONL writer with resume support."""

    def __init__(self, jsonl_path: Path):
        self._path = jsonl_path
        self._lock = threading.Lock()
        self._completed_indices: Set[int] = set()
        self._results: List[Dict[str, Any]] = []

        # Load existing results for resume
        if self._path.exists():
            with open(self._path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        record = json.loads(line)
                        self._results.append(record)
                        if "idx" in record:
                            self._completed_indices.add(record["idx"])
                    except json.JSONDecodeError:
                        continue
            if self._completed_indices:
                logger.info(
                    f"[RESUME] Loaded {len(self._completed_indices)} completed results "
                    f"from {self._path}  (indices: {sorted(self._completed_indices)[:10]}{'...' if len(self._completed_indices) > 10 else ''})"
                )

    @property
    def completed_indices(self) -> Set[int]:
        return set(self._completed_indices)

    def is_done(self, idx: int) -> bool:
        return idx in self._completed_indices

    def append(self, result: Dict[str, Any]) -> None:
        """Append one result; flush to disk immediately."""
        with self._lock:
            self._results.append(result)
            if "idx" in result:
                self._completed_indices.add(result["idx"])
            with open(self._path, "a", encoding="utf-8") as f:
                f.write(json.dumps(result, ensure_ascii=False) + "\n")

    def all_results(self) -> List[Dict[str, Any]]:
        with self._lock:
            return list(self._results)


# ===== Main evaluation loop =======================================

async def run_evaluation(args: argparse.Namespace) -> List[Dict[str, Any]]:
    """Run the full evaluation and return per-question results."""

    config = load_config(args.config_path)
    _resolve_eval_settings(args, config)

    pre_run_lookup: Dict[tuple, Dict[str, Any]] = {}
    if args.pre_run_jsonl:
        pre_run_records = load_jsonl_records(args.pre_run_jsonl)
        pre_run_lookup = _build_pre_run_lookup(pre_run_records)

    gt_data = load_ground_truth(args.gt_path)
    if not gt_data:
        logger.error("No valid ground-truth entries; aborting.")
        return []

    # ── Apply experimental knobs ─────────────────────────────────────
    os.environ["ENABLE_TITLE_SUMMARIES"] = "1" if args.enable_ctx_decomp else "0"

    if args.enable_memory:
        logger.info("[config] Memory enabled – session continuity across questions")
        if args.workers > 1:
            logger.warning("[config] Memory mode forces --workers=1 (sequential) to preserve chat history order")
            args.workers = 1
    else:
        logger.info("[config] Memory disabled – each question uses a fresh session")

    # ── Initialise services ──────────────────────────────────────────
    _reset_rag_manager_singleton()

    from core.ChatService import ChatService
    from core.RAGManager import RAGManager

    rerank_top_k = args.rerank_top_k
    collection_name = args.collection_name
    workers = args.workers

    logger.info(f"[config] retrieve_top_k={args.retrieve_top_k}  rerank_top_k={rerank_top_k}  workers={workers}  "
                f"use_multi_role={args.use_multi_role}  "
                f"enable_dynamic_retrieval={args.enable_dynamic_retrieval}  "
                f"enable_ctx_decomp={args.enable_ctx_decomp}  "
                f"use_chunk_risk_calibration={args.use_chunk_risk_calibration}  "
                f"chunk_risk_penalty_mode={args.chunk_risk_penalty_mode}  "
                f"chunk_risk_model_path={args.chunk_risk_model_path}  "
                f"chunk_risk_lambda={args.chunk_risk_lambda}  "
                f"pageindex_mode={args.pageindex_mode}  "
                f"pageindex_index_dir={args.pageindex_index_dir}  "
                f"pageindex_top_k={args.pageindex_top_k}  "
                f"pageindex_node_top_k={args.pageindex_node_top_k}  "
                f"pageindex_max_chunks_per_node={args.pageindex_max_chunks_per_node}  "
                f"pageindex_page_window={args.pageindex_page_window}  "
                f"pageindex_include_node_summary={args.pageindex_include_node_summary}  "
                f"pageindex_recency_boost={args.pageindex_recency_boost}  "
                f"pageindex_final_cap={args.pageindex_final_cap}  "
                f"pageindex_score_multiplier={args.pageindex_score_multiplier}  "
                f"evidence_rescue_enabled={args.evidence_rescue_enabled}  "
                f"evidence_rescue_k={args.evidence_rescue_k}  "
                f"evidence_rescue_min_score={args.evidence_rescue_min_score}  "
                f"evidence_rescue_min_year={args.evidence_rescue_min_year}  "
                f"answer_self_check_enabled={args.answer_self_check_enabled}  "
                f"answer_self_check_max_chars={args.answer_self_check_max_chars}  "
                f"stop_after_retrieval={args.stop_after_retrieval}  "
                f"enable_memory={args.enable_memory}  "
                f"pre_run_jsonl={args.pre_run_jsonl}  "
                f"table_lookup_jsonl={args.table_lookup_jsonl}  "
                f"collection={collection_name}  "
                f"persist_directory={config['persist_directory']}")

    rag_manager = RAGManager(config, collections={collection_name: args.retrieve_top_k})
    chat_service = ChatService(
        config=config,
        rag_manager=rag_manager,
        rerank_topk=rerank_top_k,
    )

    # If NOT multi-role, force the orchestrator to select only "general"
    if not args.use_multi_role:
        import core.AgenticRAG as _arag

        _orig_llm_route = _arag._llm_route

        def _general_only_route(question, history, session_manager, *route_args, **route_kwargs):
            decision = _orig_llm_route(
                question,
                history,
                session_manager,
                *route_args,
                **route_kwargs,
            )
            if decision.get("off_topic"):
                return decision
            forced = dict(decision)
            forced["selected_agents"] = ["general"]
            forced["reason"] = "forced_general_only"
            return forced

        _arag._llm_route = _general_only_route
        logger.info("[config] Routing overridden → general agent only")

    # ── Resolve output path for JSONL writer ─────────────────────────
    out_dir = Path(args.output_dir) if args.output_dir else (PROJECT_ROOT / "test" / "retrieval" / "experiment_default")
    out_dir.mkdir(parents=True, exist_ok=True)
    run_config_path = _save_run_config(out_dir, config, args)
    args.saved_config_path = str(run_config_path)
    logger.info(f"[config] Saved run config to: {run_config_path}")
    jsonl_path = out_dir / f"{args.run_name}.jsonl"
    writer = ResultWriter(jsonl_path)

    skipped = len(writer.completed_indices)
    if skipped:
        logger.info(f"[RESUME] Will skip {skipped} already-completed questions")

    # ── Shared session for memory mode ───────────────────────────────
    shared_session_id = f"eval_retrieval_memory_{int(time.time() * 1000)}" if args.enable_memory else None

    total = len(gt_data)
    semaphore = asyncio.Semaphore(workers)
    progress_lock = threading.Lock()
    progress = {"done": skipped, "total": total}

    async def _eval_one(idx: int, item: Dict[str, Any]) -> None:
        """Evaluate a single GT item (respects semaphore)."""
        if writer.is_done(idx):
            return

        question = _get_question(item)
        gt_chunks = item["content"]
        session_id = shared_session_id if args.enable_memory else f"eval_retrieval_{idx}_{int(time.time() * 1000)}"
        pre_run_record = _get_pre_run_record(pre_run_lookup, idx, question) if pre_run_lookup else None

        async with semaphore:
            # Global retrieval timer is only accurate in sequential mode;
            # with workers>1 we fall back to wall-clock total_time.
            if workers == 1:
                reset_retrieval_timer()
            t0 = time.time()

            try:
                if pre_run_record is not None:
                    agent_outputs = _extract_pre_run_agent_outputs(pre_run_record)
                    pre_run_activated_agents = pre_run_record.get("activated_agents", []) or []
                    if pre_run_activated_agents:
                        activated_agents = [
                            agent_name
                            for agent_name in pre_run_activated_agents
                            if agent_name in agent_outputs and ((agent_outputs.get(agent_name, {}) or {}).get("sub_queries", []) or [question])
                        ]
                    else:
                        activated_agents = [
                            agent_name
                            for agent_name, payload in agent_outputs.items()
                            if (payload.get("sub_queries", []) or [question])
                        ]

                    if not activated_agents:
                        raise ValueError(
                            f"Pre-run record idx={idx} does not contain usable agent sub-queries"
                        )

                    retrieved_agent_outputs: Dict[str, Any] = {}
                    for agent_name in activated_agents:
                        payload = agent_outputs.get(agent_name, {})
                        sub_queries = payload.get("sub_queries", []) or [question]
                        evidences = await retrieve_evidence(
                            chat_service.rag,
                            sub_queries,
                            datetime.now(),
                            agent_name,
                        )
                        retrieved_agent_outputs[agent_name] = {
                            "agent": agent_name,
                            "rewritten_question": payload.get("rewritten_question", question),
                            "sub_queries": sub_queries,
                            "evidence": evidences,
                            "tool_results": {},
                            "draft_answer": "",
                            "assumptions": [],
                            "risks": [],
                        }

                    debug_result = {
                        "answer": "",
                        "activated_agents": activated_agents,
                        "retrieved_chunks": _flatten_retrieved_chunks_from_agent_outputs(retrieved_agent_outputs),
                        "agent_outputs": retrieved_agent_outputs,
                        "routing_reason": pre_run_record.get("routing_reason", "pre_run_sub_queries"),
                        "query_scope": pre_run_record.get("query_scope", ""),
                        "evidence_spread": pre_run_record.get("evidence_spread", ""),
                        "enable_dynamic_retrieval": False,
                        "enable_query_decompose": False,
                    }
                else:
                    debug_result = await chat_service.generate_response_debug_async(
                        question=question,
                        session_id=session_id,
                        stop_after_retrieval=args.stop_after_retrieval,
                    )

                answer = debug_result.get("answer", "")
                activated_agents = debug_result.get("activated_agents", [])
                retrieved_chunks = debug_result.get("retrieved_chunks", [])
                agent_outputs = debug_result.get("agent_outputs", {})
                agent_details = _build_agent_details(activated_agents, agent_outputs)
                elapsed = time.time() - t0
                retrieval_time = get_retrieval_time() if workers == 1 else elapsed

                retrieved_texts = [c.get("page_content", "") for c in retrieved_chunks if c.get("page_content")]
                metrics = compute_metrics(retrieved_texts, gt_chunks)
                metrics["retrieval_time"] = round(retrieval_time, 3)
                metrics["total_time"] = round(elapsed, 3)
                metrics["activated_agents"] = activated_agents
                metrics["agent_details"] = agent_details
                metrics["question"] = question
                metrics["answer"] = answer
                metrics["idx"] = idx
                metrics["routing_reason"] = debug_result.get("routing_reason", "")
                metrics["query_scope"] = debug_result.get("query_scope", "")
                metrics["evidence_spread"] = debug_result.get("evidence_spread", "")
                metrics["enable_dynamic_retrieval"] = debug_result.get("enable_dynamic_retrieval", args.enable_dynamic_retrieval)
                metrics["enable_query_decompose"] = debug_result.get("enable_query_decompose", args.enable_ctx_decomp)

                writer.append(metrics)

                with progress_lock:
                    progress["done"] += 1
                    done = progress["done"]

                logger.info(
                    f"  [{done}/{total}] idx={idx}  Retrieved={metrics['total_retrieved']}  "
                    f"Hits={metrics['hits']}  P={metrics['precision']}  R={metrics['recall']}  "
                    f"J={metrics['jaccard']}  t_retr={metrics['retrieval_time']}s"
                )

            except Exception as exc:
                elapsed = time.time() - t0
                logger.error(f"  [idx={idx}] FAILED ({elapsed:.1f}s): {exc}", exc_info=True)
                error_result = {
                    "question": question,
                    "idx": idx,
                    "error": str(exc),
                }
                writer.append(error_result)

                with progress_lock:
                    progress["done"] += 1

    # ── Launch concurrent tasks ──────────────────────────────────────
    logger.info(f"[eval] Starting evaluation: {total} questions, {workers} worker(s), "
                f"{skipped} already done")

    if args.enable_memory:
        # Sequential for memory mode (chat history depends on order)
        for idx, item in enumerate(gt_data, 1):
            await _eval_one(idx, item)
    else:
        tasks = [_eval_one(idx, item) for idx, item in enumerate(gt_data, 1)]
        await asyncio.gather(*tasks)

    return writer.all_results()


def print_summary(results: List[Dict[str, Any]], args: argparse.Namespace):
    """Print aggregated metrics to stdout."""
    valid = [r for r in results if "error" not in r]
    n = len(valid)
    if n == 0:
        print("No valid results to summarise.")
        return

    avg = lambda key: sum(r[key] for r in valid) / n

    macro_recall = avg("recall")
    total_hits = sum(r["hits"] for r in valid)
    total_gt = sum(r["total_gt"] for r in valid)
    micro_recall = total_hits / total_gt if total_gt else 0.0

    sep = "=" * 70
    print(f"\n{sep}")
    print("RETRIEVAL EVALUATION SUMMARY")
    print(sep)
    print(f"  Questions evaluated : {n} / {len(results)}")
    print(f"  retrieve_top_k     : {args.retrieve_top_k}")
    print(f"  rerank_top_k       : {args.rerank_top_k}")
    print(f"  workers            : {args.workers}")
    print(f"  use_multi_role     : {args.use_multi_role}")
    print(f"  enable_dynamic_retrieval: {args.enable_dynamic_retrieval}")
    print(f"  enable_ctx_decomp  : {args.enable_ctx_decomp}")
    print(f"  stop_after_retrieval: {args.stop_after_retrieval}")
    print(f"  enable_memory      : {args.enable_memory}")
    print(f"  pageindex_mode     : {args.pageindex_mode}")
    print(f"  pageindex_index_dir: {args.pageindex_index_dir}")
    print(f"  pageindex_node_sum : {args.pageindex_include_node_summary}")
    print(f"  pageindex_recency  : {args.pageindex_recency_boost}")
    print(f"  pageindex_final_cap: {args.pageindex_final_cap}")
    print(f"  pageindex_score_mul: {args.pageindex_score_multiplier}")
    print(f"  evidence_rescue    : {args.evidence_rescue_enabled}")
    print(f"  answer_self_check  : {args.answer_self_check_enabled}")
    print(f"  collection         : {args.collection_name}")
    print(f"  persist_directory  : {args.persist_directory}")
    print(f"  saved_config       : {getattr(args, 'saved_config_path', 'N/A')}")
    print("-" * 70)
    print(f"  Avg Precision      : {avg('precision'):.4f}")
    print(f"  Macro Recall       : {macro_recall:.4f}")
    print(f"  Micro Recall       : {micro_recall:.4f}")
    print(f"  Avg Jaccard        : {avg('jaccard'):.4f}")
    print(f"  Avg Retrieved      : {avg('total_retrieved'):.1f}")
    print(f"  Avg Retrieval Time : {avg('retrieval_time'):.3f}s")
    print(f"  Avg Total Time     : {avg('total_time'):.3f}s")
    print(sep)


# ===== Entry point ================================================

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Evaluate retrieval quality of the multi-agent RAG system.",
    )
    p.add_argument(
        "--gt_path",
        type=str,
        default=None,
        help="Path to ground-truth JSON file with 'content' evidence lists.",
    )
    p.add_argument(
        "--output_dir",
        type=str,
        default=None,
        help="Directory for this experiment's results (e.g. test/colm/retrieval/experiment_<ts>).",
    )
    p.add_argument(
        "--use_multi_role",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Enable multi-role agent routing (default: general agent only).",
    )
    p.add_argument(
        "--enable_dynamic_retrieval",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Let the orchestrator dynamically choose query decomposition per query.",
    )
    p.add_argument(
        "--rerank_top_k",
        type=int,
        default=None,
        help="Number of chunks to keep after reranking per agent (default: 5).",
    )
    p.add_argument(
        "--retrieve_top_k",
        type=int,
        default=None,
        help="Number of chunks to keep for each path retriever (default: 10)"
    )
    p.add_argument(
        "--enable_ctx_decomp",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Enable context-aware query decomposition via title-summary retrieval.",
    )
    p.add_argument(
        "--enable_memory",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Enable memory: use a shared session so chat_history accumulates across questions.",
    )
    p.add_argument(
        "--stop_after_retrieval",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Stop after retrieval and rerank, skipping tool use and answer generation.",
    )
    p.add_argument(
        "--run_name",
        type=str,
        default=None,
        help="Human-readable label for this run (used in output filename).",
    )
    p.add_argument(
        "--persist_directory",
        type=str,
        default=None,
        help="Override persist_directory in config (path to the chroma database root).",
    )
    p.add_argument(
        "--collection_name",
        type=str,
        default=None,
        help="ChromaDB collection name to use (default: 'default').",
    )
    p.add_argument(
        "--config_path",
        type=str,
        default=None,
        help="Path to YAML config file (default: config/production.yaml).",
    )
    p.add_argument(
        "--workers",
        type=int,
        default=None,
        help="Number of concurrent evaluation workers (default: 1). "
             "Memory mode forces workers=1.",
    )
    p.add_argument(
        "--pre_run_jsonl",
        type=str,
        default=None,
        help="Optional path to a pre-run .jsonl file whose saved agent sub-queries will be reused directly for retrieval, skipping orchestrator and rewrite LLM calls.",
    )
    p.add_argument(
        "--table_lookup_jsonl",
        type=str,
        default=None,
        help="Optional path to a lookup .jsonl file used only for additional table retrieval in shared retrieval helpers.",
    )
    p.add_argument(
        "--use_chunk_risk_calibration",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Apply chunk-risk model penalties after reranker scoring.",
    )
    p.add_argument(
        "--chunk_risk_model_path",
        type=str,
        default=None,
        help="Path to the trained chunk risk model bundle (.pkl).",
    )
    p.add_argument(
        "--chunk_risk_penalty_mode",
        type=str,
        default=None,
        help="Chunk risk penalty mode to apply in reranking.",
    )
    p.add_argument(
        "--chunk_risk_lambda",
        type=float,
        default=None,
        help="Override the lambda used for chunk-risk penalties.",
    )
    p.add_argument(
        "--pageindex_mode",
        type=str,
        choices=["off", "replace_bm25", "hybrid"],
        default=None,
        help="PageIndex retrieval mode: off=baseline, replace_bm25=skip BM25 and use PageIndex, hybrid=BM25+PageIndex.",
    )
    p.add_argument(
        "--pageindex_index_dir",
        type=str,
        default=None,
        help="Directory containing pre-built PageIndex tree JSON files.",
    )
    p.add_argument(
        "--pageindex_top_k",
        type=int,
        default=None,
        help="Number of PageIndex nodes/page ranges to retrieve per query.",
    )
    p.add_argument(
        "--pageindex_node_top_k",
        type=int,
        default=None,
        help="Number of PageIndex tree nodes to consider before materializing chunks.",
    )
    p.add_argument(
        "--pageindex_max_chunks_per_node",
        type=int,
        default=None,
        help="Maximum number of existing chunks to materialize from each selected PageIndex node.",
    )
    p.add_argument(
        "--pageindex_page_window",
        type=int,
        default=None,
        help="Extra page window around each PageIndex node range when matching existing chunks.",
    )
    p.add_argument(
        "--pageindex_include_node_summary",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Prefix materialized PageIndex chunks with their structural node summary.",
    )
    p.add_argument(
        "--pageindex_recency_boost",
        type=float,
        default=None,
        help="Optional score boost favoring newer PageIndex documents before node materialization.",
    )
    p.add_argument(
        "--pageindex_final_cap",
        type=int,
        default=None,
        help="Maximum number of PageIndex text chunks allowed in final reranked context.",
    )
    p.add_argument(
        "--pageindex_score_multiplier",
        type=float,
        default=None,
        help="Optional multiplier applied to PageIndex reranker scores before source capping.",
    )
    p.add_argument(
        "--evidence_rescue_enabled",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Prepend a few recent numeric candidates if rerank drops them from final evidence.",
    )
    p.add_argument(
        "--evidence_rescue_k",
        type=int,
        default=None,
        help="Maximum number of rescued evidence chunks to prepend.",
    )
    p.add_argument(
        "--evidence_rescue_min_score",
        type=float,
        default=None,
        help="Minimum lexical/recency rescue score.",
    )
    p.add_argument(
        "--evidence_rescue_min_year",
        type=int,
        default=None,
        help="Minimum document year for rescue candidates.",
    )
    p.add_argument(
        "--answer_self_check_enabled",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Run an additional evidence verifier rewrite pass before returning draft answers.",
    )
    p.add_argument(
        "--answer_self_check_max_chars",
        type=int,
        default=None,
        help="Maximum evidence/tool characters sent to the answer self-check pass.",
    )
    return p.parse_args()


def _build_run_summary(results: List[Dict[str, Any]], args: argparse.Namespace) -> Dict[str, Any]:
    """Build a compact summary dict suitable for _metrics.json."""
    valid = [r for r in results if "error" not in r]
    n = len(valid)
    avg = lambda key: round(sum(r[key] for r in valid) / n, 4) if n else 0.0

    macro_recall = avg("recall")
    total_hits = sum(r["hits"] for r in valid)
    total_gt = sum(r["total_gt"] for r in valid)
    micro_recall = round(total_hits / total_gt, 4) if total_gt else 0.0

    return {
        "run_name": args.run_name,
        "questions_evaluated": n,
        "questions_total": len(results),
        "config": {
            "retrieve_top_k": args.retrieve_top_k,
            "rerank_top_k": args.rerank_top_k,
            "workers": args.workers,
            "use_multi_role": args.use_multi_role,
            "enable_dynamic_retrieval": args.enable_dynamic_retrieval,
            "enable_ctx_decomp": args.enable_ctx_decomp,
            "use_chunk_risk_calibration": args.use_chunk_risk_calibration,
            "chunk_risk_model_path": args.chunk_risk_model_path,
            "chunk_risk_penalty_mode": args.chunk_risk_penalty_mode,
            "chunk_risk_lambda": args.chunk_risk_lambda,
            "pageindex_mode": args.pageindex_mode,
            "pageindex_index_dir": args.pageindex_index_dir,
            "pageindex_top_k": args.pageindex_top_k,
            "pageindex_node_top_k": args.pageindex_node_top_k,
            "pageindex_max_chunks_per_node": args.pageindex_max_chunks_per_node,
            "pageindex_page_window": args.pageindex_page_window,
            "pageindex_final_cap": args.pageindex_final_cap,
            "pageindex_score_multiplier": args.pageindex_score_multiplier,
            "evidence_rescue_enabled": args.evidence_rescue_enabled,
            "evidence_rescue_k": args.evidence_rescue_k,
            "evidence_rescue_min_score": args.evidence_rescue_min_score,
            "evidence_rescue_min_year": args.evidence_rescue_min_year,
            "answer_self_check_enabled": args.answer_self_check_enabled,
            "answer_self_check_max_chars": args.answer_self_check_max_chars,
            "stop_after_retrieval": args.stop_after_retrieval,
            "enable_memory": args.enable_memory,
            "collection_name": args.collection_name,
            "persist_directory": args.persist_directory,
            "pre_run_jsonl": args.pre_run_jsonl,
            "table_lookup_jsonl": args.table_lookup_jsonl,
            "saved_config_path": getattr(args, "saved_config_path", None),
        },
        "avg_precision": avg("precision"),
        "avg_recall": macro_recall,
        "macro_recall": macro_recall,
        "micro_recall": micro_recall,
        "avg_jaccard": avg("jaccard"),
        "avg_retrieved": avg("total_retrieved"),
        "avg_retrieval_time": avg("retrieval_time"),
        "avg_total_time": avg("total_time"),
    }


def _build_final_json_record(result: Dict[str, Any]) -> Dict[str, Any]:
    """Keep only the final evaluation result fields for the consolidated JSON."""
    if "error" in result:
        return {
            key: result[key]
            for key in ("idx", "question", "error")
            if key in result
        }

    keep_keys = (
        "idx",
        "question",
        "answer",
        "routing_reason",
        "query_scope",
        "evidence_spread",
        "enable_dynamic_retrieval",
        "enable_query_decompose",
        "total_retrieved",
        "total_gt",
        "hits",
        "precision",
        "recall",
        "jaccard",
        "retrieval_time",
        "total_time",
    )
    return {key: result[key] for key in keep_keys if key in result}


def _load_metrics_file(metrics_path: Path) -> List[Dict[str, Any]]:
    if not metrics_path.exists():
        return []

    with open(metrics_path, "r", encoding="utf-8") as f:
        payload = json.load(f)

    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]

    logger.warning(f"Unexpected metrics payload format in {metrics_path}; resetting to empty list")
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


def main():
    args = parse_args()
    resolved_config = load_config(args.config_path)
    _resolve_eval_settings(args, resolved_config)

    # Derive run_name for output
    if args.run_name is None:
        parts = ["retrieval_eval"]
        if args.use_multi_role:
            parts.append("multi")
        if args.enable_dynamic_retrieval:
            parts.append("dynamic")
        if args.enable_ctx_decomp:
            parts.append("decomp")
        if args.use_chunk_risk_calibration:
            parts.append(f"chunkrisk-{args.chunk_risk_penalty_mode or 'on'}")
        if args.pageindex_mode and args.pageindex_mode != "off":
            parts.append(f"pageindex-{args.pageindex_mode}")
        if args.enable_memory:
            parts.append("memory")
        parts.append(f"ret{args.retrieve_top_k}")
        parts.append(f"rer{args.rerank_top_k}")
        args.run_name = "_".join(parts)

    # Resolve output directory
    if args.output_dir is None:
        ts = time.strftime("%Y%m%d_%H%M%S")
        out_dir = PROJECT_ROOT / "test" / "retrieval" / f"experiment_{ts}"
    else:
        out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Pass output_dir into args so run_evaluation can use it
    args.output_dir = str(out_dir)

    output_path = out_dir / f"{args.run_name}.json"

    results = asyncio.run(run_evaluation(args))

    # Consolidate into final JSON (sorted by idx for readability)
    results_sorted = sorted(results, key=lambda r: r.get("idx", 0))
    final_results = [_build_final_json_record(r) for r in results_sorted]
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(final_results, f, ensure_ascii=False, indent=2)
    logger.info(f"Results written to {output_path}")

    print_summary(results_sorted, args)

    # Emit machine-readable summary on a tagged line so the bash script can
    # collect it into _metrics.json.
    summary = _build_run_summary(results_sorted, args)
    print(f"__SUMMARY_JSON__:{json.dumps(summary, ensure_ascii=False)}")

    # Also append this run's summary into the experiment-level _metrics.json
    metrics_path = out_dir / "_metrics.json"
    all_metrics = _load_metrics_file(metrics_path)
    added = _upsert_metrics_summary(all_metrics, summary)
    with open(metrics_path, "w", encoding="utf-8") as f:
        json.dump(all_metrics, f, ensure_ascii=False, indent=2)
    action = "added" if added else "updated"
    logger.info(f"Comparative metrics {action}: {metrics_path}")


if __name__ == "__main__":
    main()
