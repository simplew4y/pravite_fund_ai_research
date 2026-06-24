#!/usr/bin/env python3
"""
Evaluation script for Preview vs Non-Preview modes
Saves all middle histories including sub-queries, draft answers, preview answers, and retrieved chunks
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
from pathlib import Path
from typing import Any, Dict, List, Set

import yaml

# Path setup
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "src"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler()],
)
logger = logging.getLogger("eval_preview_modes")


def load_config(config_path: str) -> Dict[str, Any]:
    with open(config_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_ground_truth(gt_path: str, require_evidence: bool = True) -> List[Dict[str, Any]]:
    with open(gt_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    valid = []
    for item in data:
        # Original format: content field with list of text chunks
        content = item.get("content")
        if content:
            normalized_item = dict(item)
            normalized_item["content"] = content if isinstance(content, list) else [content]
            valid.append(normalized_item)
            continue
        
        # Original format: positives field with dicts containing chunk
        if not content:
            positives = item.get("positives") or []
            content = [
                positive.get("chunk", "")
                for positive in positives
                if isinstance(positive, dict) and positive.get("chunk")
            ]
            question = item.get("question") or item.get("original_question") or ""
        # When evidence identification is required, keep only items with GT chunks.
        # Otherwise (answer-only mode), keep any item with a non-empty question.
        if require_evidence:
            if not content:
                    continue
        else:
            if not question:
                continue
        normalized_item = dict(item)
        normalized_item["content"] = content or []
        valid.append(normalized_item)
        continue
        
        # New NVIDIA format: answer field as reference (fallback content)
        # This is used when neither content nor positives are available
        answer = item.get("answer")
        if answer:
            normalized_item = dict(item)
            # Use answer as content for retrieval metrics
            normalized_item["content"] = [answer] if isinstance(answer, str) else answer
            valid.append(normalized_item)
            continue
    
    logger.info(
        f"Loaded {len(valid)} GT entries from {gt_path} "
        f"(require_evidence={require_evidence})"
    )
    return valid


def _normalise(text: str) -> str:
    return " ".join(text.split()).strip().lower()


def compute_metrics(retrieved_texts: List[str], gt_texts: List[str]) -> Dict[str, float]:
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


class ResultWriter:
    """Thread-safe JSONL writer with resume support."""
    
    def __init__(self, jsonl_path: Path):
        self._path = jsonl_path
        self._lock = threading.Lock()
        self._completed_indices: Set[int] = set()
        self._results: List[Dict[str, Any]] = []
        
        if self._path.exists():
            with open(self._path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        record = json.loads(line)
                        self._results.append(record)
                        if self._is_successful_record(record):
                            self._completed_indices.add(record["idx"])
                    except json.JSONDecodeError:
                        continue
            if self._completed_indices:
                logger.info(f"[RESUME] Loaded {len(self._completed_indices)} completed results")
    
    @staticmethod
    def _is_successful_record(record: Dict[str, Any]) -> bool:
        return "idx" in record and "error" not in record
    
    @property
    def completed_indices(self) -> Set[int]:
        return set(self._completed_indices)
    
    def is_done(self, idx: int) -> bool:
        return idx in self._completed_indices
    
    def all_results(self) -> List[Dict[str, Any]]:
        deduped: Dict[int, Dict[str, Any]] = {}
        non_indexed: List[Dict[str, Any]] = []
        for record in self._results:
            idx = record.get("idx")
            if idx is None:
                non_indexed.append(record)
                continue
            deduped[idx] = record
        return [deduped[idx] for idx in sorted(deduped)] + non_indexed
    
    def append(self, result: Dict[str, Any]) -> None:
        with self._lock:
            self._results.append(result)
            if self._is_successful_record(result):
                self._completed_indices.add(result["idx"])
            with open(self._path, "a", encoding="utf-8") as f:
                f.write(json.dumps(result, ensure_ascii=False) + "\n")


def _sanitize_chunk(chunk: Dict[str, Any]) -> Dict[str, Any]:
    """Extract essential chunk info"""
    return {
        "page_content": chunk.get("page_content", ""),
        "metadata": {
            "doc_id": chunk.get("metadata", {}).get("doc_id", ""),
            "filename": chunk.get("metadata", {}).get("filename", ""),
            "page": chunk.get("metadata", {}).get("page", ""),
        }
    }


def _extract_agent_details(agent_outputs: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Extract detailed agent information including sub-queries, draft answers, and chunks"""
    details = []
    for agent_name, payload in agent_outputs.items():
        if not isinstance(payload, dict):
            continue
        
        # Extract evidence chunks
        chunks = []
        for evidence in payload.get("evidence", []) or []:
            if isinstance(evidence, dict):
                for chunk in evidence.get("chunks", []) or []:
                    if isinstance(chunk, dict):
                        chunks.append(_sanitize_chunk(chunk))
        
        detail = {
            "agent": agent_name,
            "sub_queries": payload.get("sub_queries", []),
            "rewritten_question": payload.get("rewritten_question", ""),
            "draft_answer": payload.get("draft_answer", ""),
            "assumptions": payload.get("assumptions", []),
            "risks": payload.get("risks", []),
            "chunks": chunks,
            "evidence_count": len(chunks),
        }
        details.append(detail)
    return details

async def evaluate_non_preview(chat_service, question: str, session_id: str, 
                                gt_chunks: List[str], idx: int, stop_after_retrieval: bool = False,
                                identify_evidence: bool = True) -> Dict[str, Any]:
    """Evaluate non-preview mode and capture all histories"""
    
    t0 = time.time()
    
    try:
        # Use debug async to get full details
        debug_result = await chat_service.generate_response_debug_async(
            question=question,
            session_id=session_id,
            stop_after_retrieval=stop_after_retrieval,
        )
        
        elapsed = time.time() - t0
        
        agent_outputs = debug_result.get("agent_outputs", {})
        activated_agents = debug_result.get("activated_agents", [])
        retrieved_chunks = debug_result.get("retrieved_chunks", [])
        all_chunks = [_sanitize_chunk(chunk) for chunk in retrieved_chunks]
        
        # Compute metrics (only when evidence identification is requested)
        if identify_evidence:
            retrieved_texts = [c.get("page_content", "") for c in retrieved_chunks if c.get("page_content")]
            metrics = compute_metrics(retrieved_texts, gt_chunks)
        else:
            metrics = {}
        metrics["total_time"] = debug_result.get("total_time", round(elapsed, 3))
        metrics["time_to_first_response"] = debug_result.get("time_to_first_response", 0.0)
        
        # Build result with full history
        result = {
            "idx": idx,
            "question": question,
            "mode": "non_preview",
            "answer": debug_result.get("answer", ""),
            "activated_agents": activated_agents,
            "routing_reason": debug_result.get("routing_reason", ""),
            "evidence_spread": debug_result.get("evidence_spread", ""),
            "agent_details": _extract_agent_details(agent_outputs),
            "retrieved_chunks": all_chunks,
            "total_retrieved": len(all_chunks),
            **metrics,
        }
        
        return result
        
    except Exception as exc:
        logger.error(f"[idx={idx}] Non-preview FAILED: {exc}")
        return {
            "idx": idx,
            "question": question,
            "mode": "non_preview",
            "error": str(exc),
        }


async def evaluate_preview(chat_service, question: str, session_id: str,
                           gt_chunks: List[str], idx: int,
                           identify_evidence: bool = True) -> Dict[str, Any]:
    """Evaluate preview mode using the new debug API that returns all details in one call"""
    
    try:
        # Use the new debug API that returns both preliminary and comprehensive in one dict
        debug_result = await chat_service.generate_response_with_preview_debug(
            question=question,
            session_id=session_id,
        )
        
        agent_outputs = debug_result.get("agent_outputs", {})
        retrieved_chunks = debug_result.get("retrieved_chunks", [])
        all_chunks = [_sanitize_chunk(chunk) for chunk in retrieved_chunks]
        
        # Compute metrics (only when evidence identification is requested)
        if identify_evidence:
            retrieved_texts = [c.get("page_content", "") for c in retrieved_chunks if c.get("page_content")]
            metrics = compute_metrics(retrieved_texts, gt_chunks)
        else:
            metrics = {}
        metrics["total_time"] = debug_result.get("total_time", 0)
        metrics["preliminary_time"] = debug_result.get("preliminary_time")
        metrics["comprehensive_time"] = debug_result.get("comprehensive_time")
        metrics["time_to_first_response"] = debug_result.get("time_to_first_response")
        
        # Build result with full history
        result = {
            "idx": idx,
            "question": question,
            "mode": "preview",
            "preliminary_draft": debug_result.get("preliminary_draft", ""),
            "final_answer": debug_result.get("final_answer", ""),
            "answer": debug_result.get("answer", ""),
            "activated_agents": debug_result.get("selected_agents", []),
            "routing_reason": debug_result.get("routing_reason", ""),
            "agent_details": _extract_agent_details(agent_outputs),
            "retrieved_chunks": all_chunks,
            "total_retrieved": len(all_chunks),
            **metrics,
        }
        
        return result
        
    except Exception as exc:
        logger.error(f"[idx={idx}] Preview FAILED: {exc}")
        return {
            "idx": idx,
            "question": question,
            "mode": "preview",
            "error": str(exc),
        }


async def run_evaluation(args: argparse.Namespace) -> List[Dict[str, Any]]:
    """Run evaluation for a single mode."""
    
    config = load_config(args.config_path)
    
    # Update config with CLI args
    config["persist_directory"] = args.persist_directory or config.get("persist_directory")
    config["collection_name"] = args.collection_name or config.get("collection_name")
    config["rerank_top_k"] = args.rerank_top_k or config.get("rerank_top_k", 5)
    config["retrieve_top_k"] = args.retrieve_top_k or config.get("retrieve_top_k", 10)
    
    # Run4 config: multi-role + ctx decomp
    config["use_multi_role"] = args.use_multi_role
    config["enable_ctx_decomp"] = args.enable_ctx_decomp
    config["enable_memory"] = args.enable_memory

    config["use_chunk_risk_calibration"] = args.use_chunk_risk_calibration
    
    logger.info(f"[config] run4 settings: use_multi_role={args.use_multi_role}, "
                f"enable_ctx_decomp={args.enable_ctx_decomp}, "
                f"enable_memory={args.enable_memory}, "
                f"use_chunk_risk_calibration={args.use_chunk_risk_calibration}")
    
    gt_data = load_ground_truth(args.gt_path, require_evidence=args.identify_evidence)
    if not gt_data:
        logger.error("No valid ground-truth entries; aborting.")
        return []
    
    # Initialize services
    from core.ChatService import ChatService
    from core.RAGManager import RAGManager
    
    # Apply experimental knobs like eval_retrieval.py
    os.environ["ENABLE_TITLE_SUMMARIES"] = "1" if args.enable_ctx_decomp else "0"
    
    if args.enable_memory:
        logger.info("[config] Memory enabled – session continuity across questions")
        if args.workers > 1:
            logger.warning("[config] Memory mode forces --workers=1 (sequential) to preserve chat history order")
            args.workers = 1
    else:
        logger.info("[config] Memory disabled – each question uses a fresh session")
    
    rag_manager = RAGManager(config, collections={config["collection_name"]: config["retrieve_top_k"]})
    chat_service = ChatService(
        config=config,
        rag_manager=rag_manager,
        rerank_topk=config["rerank_top_k"],
    )
    
    # If NOT multi-role, force the orchestrator to select only "general"
    if not args.use_multi_role:
        import core.AgenticRAG as _arag

        _orig_llm_route = _arag._llm_route

        def _general_only_route(question, history, session_manager, has_preliminary=False):
            decision = _orig_llm_route(
                question, history, session_manager, has_preliminary,
            )
            if decision.get("off_topic"):
                return decision
            forced = dict(decision)
            forced["selected_agents"] = ["general"]
            forced["reason"] = "forced_general_only"
            return forced

        _arag._llm_route = _general_only_route
        logger.info("[config] Routing overridden → general agent only")
    
    # Setup output
    out_dir = Path(args.output_dir) / args.mode
    out_dir.mkdir(parents=True, exist_ok=True)
    
    result_writer = ResultWriter(out_dir / f"{args.run_name}.jsonl")
    
    total = len(gt_data)
    workers = args.workers
    semaphore = asyncio.Semaphore(workers)
    
    async def _eval_one(idx: int, item: Dict[str, Any]) -> None:
        """Evaluate one question in the selected mode"""
        question = item.get("question") or item.get("original_question") or ""
        gt_chunks = item.get("content", [])
        
        async with semaphore:
            if result_writer.is_done(idx):
                logger.info(f"[{idx}/{total}] Skipping {args.mode}: already completed")
                return

            if args.mode == "non_preview":
                logger.info(f"[{idx}/{total}] Running NON-PREVIEW: {question[:50]}...")
                session_id = f"eval_non_preview_{idx}_{int(time.time()*1000)}"
                result = await evaluate_non_preview(chat_service, question, session_id, gt_chunks, idx,
                                                     stop_after_retrieval=args.stop_after_retrieval,
                                                     identify_evidence=args.identify_evidence)
                result_writer.append(result)
                if args.identify_evidence:
                    logger.info(f"[{idx}/{total}] Non-preview complete: P={result.get('precision', 0):.3f} R={result.get('recall', 0):.3f}")
                else:
                    logger.info(f"[{idx}/{total}] Non-preview complete (answer-only): t={result.get('total_time', 0):.2f}s")
            else:
                logger.info(f"[{idx}/{total}] Running PREVIEW: {question[:50]}...")
                session_id = f"eval_preview_{idx}_{int(time.time()*1000)}"
                result = await evaluate_preview(chat_service, question, session_id, gt_chunks, idx,
                                                identify_evidence=args.identify_evidence)
                result_writer.append(result)
                if args.identify_evidence:
                    logger.info(f"[{idx}/{total}] Preview complete: P={result.get('precision', 0):.3f} R={result.get('recall', 0):.3f}")
                else:
                    logger.info(f"[{idx}/{total}] Preview complete (answer-only): t={result.get('total_time', 0):.2f}s")
    
    # Run evaluations
    if args.enable_memory:
        # Sequential for memory mode
        for idx, item in enumerate(gt_data, 1):
            await _eval_one(idx, item)
    else:
        tasks = [_eval_one(idx, item) for idx, item in enumerate(gt_data, 1)]
        await asyncio.gather(*tasks)
    
    return result_writer.all_results()


def print_summary(mode: str, results: List[Dict[str, Any]]):
    """Print summary for a single mode."""
    
    def _avg(results, key):
        valid = [r[key] for r in results if key in r and "error" not in r]
        return sum(valid) / len(valid) if valid else 0.0
    
    def _count_errors(results):
        return sum(1 for r in results if "error" in r)
    
    sep = "=" * 70
    print(f"\n{sep}")
    print(f"{mode.upper()} EVALUATION SUMMARY")
    print(sep)
    print(f"\n📊 {mode.upper()} MODE:")
    print(f"  Questions evaluated : {len(results) - _count_errors(results)}")
    print(f"  Errors             : {_count_errors(results)}")
    has_metrics = any("precision" in r for r in results if "error" not in r)
    if has_metrics:
        print(f"  Avg Precision      : {_avg(results, 'precision'):.4f}")
        print(f"  Avg Recall         : {_avg(results, 'recall'):.4f}")
        print(f"  Avg Jaccard        : {_avg(results, 'jaccard'):.4f}")
    else:
        print("  Retrieval metrics  : skipped (--identify_evidence false)")
    print(f"  Avg Retrieved      : {_avg(results, 'total_retrieved'):.1f}")
    print(f"  Avg Total Time     : {_avg(results, 'total_time'):.3f}s")
    print(f"  Avg Time to First  : {_avg(results, 'time_to_first_response'):.3f}s")
    
    print(f"\n{sep}")


def main():
    PROJECT_ROOT = Path(__file__).resolve().parent.parent
    
    parser = argparse.ArgumentParser(description="Evaluate Preview vs Non-Preview modes")
    parser.add_argument("--mode", type=str, choices=["non_preview", "preview"], required=True,
                        help="Run exactly one mode per invocation")
    parser.add_argument("--gt_path", type=str, 
                        default="/root/autodl-tmp/dir_lzx/FinSagent_bf/test/nvidia_sec_questions_40_2025_general.json",
                        help="Ground truth JSON path")
    parser.add_argument("--config_path", type=str, default=str(PROJECT_ROOT / "config" / "production.yaml"))
    parser.add_argument("--output_dir", type=str,
                        default="/root/autodl-tmp/dir_lzx/FinSagent_bf/test/nvidia_expriments",
                        help="Output directory")
    parser.add_argument("--run_name", type=str, default="nvidia_run1", help="Run name")
    parser.add_argument("--persist_directory", type=str, 
                        default=None)
    parser.add_argument("--collection_name", type=str, default=None)
    parser.add_argument("--rerank_top_k", type=int, default=5)
    parser.add_argument("--retrieve_top_k", type=int, default=10)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--use_multi_role", type=lambda x: x.lower() in ('true', '1', 'yes'), default=True,
                        help="Enable multi-role agent routing (run4)")
    parser.add_argument("--enable_ctx_decomp", type=lambda x: x.lower() in ('true', '1', 'yes'), default=True,
                        help="Enable context decomposition (run4)")
    parser.add_argument("--enable_memory", type=lambda x: x.lower() in ('true', '1', 'yes'), default=False,
                        help="Enable memory for session continuity")
    parser.add_argument("--use_chunk_risk_calibration", type=lambda x: x.lower() in ('true', '1', 'yes'), default=False,
                        help="Enable chunk risk calibration")
    parser.add_argument("--stop_after_retrieval", type=lambda x: x.lower() in ('true', '1', 'yes'), default=False,
                        help="Stop after retrieval and rerank, skipping tool use and answer generation")
    parser.add_argument("--identify_evidence", type=lambda x: x.lower() in ('true', '1', 'yes'), default=False,
                        help="If true, compute retrieval metrics (precision/recall/jaccard) against GT chunks. "
                             "If false, skip those metrics and only generate the answer (use this when the GT "
                             "file has no real evidence chunks).")
    args = parser.parse_args()

    print(args)
    
    results = asyncio.run(run_evaluation(args))
    print_summary(args.mode, results)


if __name__ == "__main__":
    main()
