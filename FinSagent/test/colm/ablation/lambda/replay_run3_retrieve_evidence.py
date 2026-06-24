#!/usr/bin/env python3

"""
Replay evidence retrieval from a previous run3 experiment and compare results.

This script re-runs evidence retrieval using saved agent configurations and sub-queries,
then compares the replayed results against the original saved evidence to detect
regressions or inconsistencies in the retrieval pipeline.

Usage:
    python replay_run3_retrieve_evidence.py <source_jsonl> [options]

Arguments:
    source_jsonl          Path to the previous run3 JSONL file

Options:
    --source-config PATH  Path to matching config YAML (default: <stem>_config.yaml)
    --output PATH         Output JSON path for comparison report
    --max-records N       Only replay first N records
    --start-idx N         1-indexed starting position (default: 1)
    --strict              Exit non-zero if any mismatch found

Examples:
    # Replay all records with default config path
    python replay_run3_retrieve_evidence.py results/run3_results.jsonl

    # Replay first 10 records with strict mode
    python replay_run3_retrieve_evidence.py results/run3_results.jsonl --max-records 10 --strict

    # Replay records 50-100
    python replay_run3_retrieve_evidence.py results/run3_results.jsonl --start-idx 50 --max-records 50
"""

import argparse
import asyncio
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

import yaml

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT / "src"))
sys.path.insert(0, str(PROJECT_ROOT / "test" / "retrieval"))

import eval_retrieval
from agents.shared import retrieve_evidence
from core.ChatService import ChatService
from core.RAGManager import RAGManager



def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "source_jsonl",
        type=Path,
        help="Path to the previous run3 JSONL file.",
    )
    parser.add_argument(
        "--source-config",
        type=Path,
        default=None,
        help="Path to the matching source config YAML. Defaults to <source_jsonl stem>_config.yaml.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Optional output JSON path for the replay comparison report.",
    )
    parser.add_argument(
        "--max-records",
        type=int,
        default=None,
        help="Only replay the first N records.",
    )
    parser.add_argument(
        "--start-idx",
        type=int,
        default=1,
        help="1-indexed starting record position inside the JSONL.",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit with non-zero status if any replay mismatch is found.",
    )
    return parser.parse_args()


def load_yaml(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def load_jsonl(path: Path) -> List[Dict[str, Any]]:
    records: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            payload = json.loads(line)
            if not isinstance(payload, dict):
                raise ValueError(f"Expected dict JSON object at {path}:{line_no}")
            records.append(payload)
    return records


def resolve_source_config_path(source_jsonl: Path, explicit_config: Path | None) -> Path:
    if explicit_config is not None:
        return explicit_config
    if source_jsonl.name.endswith(".jsonl"):
        return source_jsonl.with_name(source_jsonl.stem + "_config.yaml")
    return source_jsonl.with_suffix(source_jsonl.suffix + "_config.yaml")


def select_records(records: List[Dict[str, Any]], start_idx: int, max_records: int | None) -> List[Dict[str, Any]]:
    if start_idx < 1:
        raise ValueError("--start-idx must be >= 1")
    selected = records[start_idx - 1 :]
    if max_records is not None:
        selected = selected[:max_records]
    return selected


def build_service(config: Dict[str, Any]) -> ChatService:
    eval_retrieval._reset_rag_manager_singleton()
    collection_name = config.get("collection_name") or "default"
    retrieve_top_k = int(config.get("retrieve_top_k") or 10)
    rerank_top_k = int(config.get("rerank_top_k") or config.get("rerank_topk") or 5)
    rag_manager = RAGManager(config, collections={collection_name: retrieve_top_k})
    return ChatService(config=config, rag_manager=rag_manager, rerank_topk=rerank_top_k)


def extract_activated_agents(record: Dict[str, Any], agent_outputs: Dict[str, Any], question: str) -> List[str]:
    pre_run_activated_agents = record.get("activated_agents", []) or []
    if pre_run_activated_agents:
        return [
            agent_name
            for agent_name in pre_run_activated_agents
            if agent_name in agent_outputs and ((agent_outputs.get(agent_name, {}) or {}).get("sub_queries", []) or [question])
        ]
    return [
        agent_name
        for agent_name, payload in agent_outputs.items()
        if (payload.get("sub_queries", []) or [question])
    ]


def sanitize_evidence_list(evidences: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [eval_retrieval._sanitize_evidence_payload(evidence) for evidence in evidences]


def first_mismatch_index(left: List[Any], right: List[Any]) -> int | None:
    for idx, (left_item, right_item) in enumerate(zip(left, right)):
        if left_item != right_item:
            return idx
    if len(left) != len(right):
        return min(len(left), len(right))
    return None


def compare_evidence(saved_evidence: Dict[str, Any], replay_evidence: Dict[str, Any]) -> Dict[str, Any]:
    saved_source_ids = saved_evidence.get("source_ids", []) or []
    replay_source_ids = replay_evidence.get("source_ids", []) or []
    saved_pre_source_ids = saved_evidence.get("pre_rerank_source_ids", []) or []
    replay_pre_source_ids = replay_evidence.get("pre_rerank_source_ids", []) or []

    final_source_ids_identical = saved_source_ids == replay_source_ids
    pre_rerank_source_ids_identical = saved_pre_source_ids == replay_pre_source_ids
    final_chunk_payload_identical = (saved_evidence.get("chunks", []) or []) == (replay_evidence.get("chunks", []) or [])
    pre_rerank_chunk_payload_identical = (saved_evidence.get("pre_rerank_chunks", []) or []) == (replay_evidence.get("pre_rerank_chunks", []) or [])
    identical = (
        final_source_ids_identical
        and pre_rerank_source_ids_identical
        and final_chunk_payload_identical
        and pre_rerank_chunk_payload_identical
    )

    result = {
        "query": saved_evidence.get("query") or replay_evidence.get("query") or "",
        "identical": identical,
        "final_source_ids_identical": final_source_ids_identical,
        "pre_rerank_source_ids_identical": pre_rerank_source_ids_identical,
        "final_chunk_payload_identical": final_chunk_payload_identical,
        "pre_rerank_chunk_payload_identical": pre_rerank_chunk_payload_identical,
        "saved_final_count": len(saved_source_ids),
        "replay_final_count": len(replay_source_ids),
        "saved_pre_rerank_count": len(saved_pre_source_ids),
        "replay_pre_rerank_count": len(replay_pre_source_ids),
    }

    if not final_source_ids_identical:
        result["final_source_ids_first_mismatch"] = first_mismatch_index(saved_source_ids, replay_source_ids)
        result["saved_final_source_ids"] = saved_source_ids
        result["replay_final_source_ids"] = replay_source_ids
    if not pre_rerank_source_ids_identical:
        result["pre_rerank_source_ids_first_mismatch"] = first_mismatch_index(saved_pre_source_ids, replay_pre_source_ids)
        result["saved_pre_rerank_source_ids"] = saved_pre_source_ids
        result["replay_pre_rerank_source_ids"] = replay_pre_source_ids

    return result


async def replay_record(chat_service: ChatService, record: Dict[str, Any]) -> Dict[str, Any]:
    question = eval_retrieval._get_question(record)
    agent_outputs = eval_retrieval._extract_pre_run_agent_outputs(record)
    activated_agents = extract_activated_agents(record, agent_outputs, question)
    if not activated_agents:
        raise ValueError(f"Record idx={record.get('idx')} does not contain usable activated_agents/sub_queries")

    saved_agent_details = {
        detail.get("agent"): detail
        for detail in record.get("agent_details", []) or []
        if isinstance(detail, dict) and detail.get("agent")
    }

    agent_results: List[Dict[str, Any]] = []
    for agent_name in activated_agents:
        payload = agent_outputs.get(agent_name, {})
        sub_queries = payload.get("sub_queries", []) or [question]
        replay_evidences = await retrieve_evidence(
            chat_service.rag,
            sub_queries,
            datetime.now(),
            agent_name,
        )
        replay_evidences = sanitize_evidence_list(replay_evidences)
        saved_evidences = sanitize_evidence_list((saved_agent_details.get(agent_name, {}) or {}).get("evidence_chunks", []) or [])

        evidence_results: List[Dict[str, Any]] = []
        max_len = max(len(saved_evidences), len(replay_evidences))
        for evidence_idx in range(max_len):
            if evidence_idx >= len(saved_evidences):
                evidence_results.append(
                    {
                        "query": replay_evidences[evidence_idx].get("query", ""),
                        "identical": False,
                        "missing_in_saved": True,
                        "replay_final_count": len(replay_evidences[evidence_idx].get("source_ids", []) or []),
                    }
                )
                continue
            if evidence_idx >= len(replay_evidences):
                evidence_results.append(
                    {
                        "query": saved_evidences[evidence_idx].get("query", ""),
                        "identical": False,
                        "missing_in_replay": True,
                        "saved_final_count": len(saved_evidences[evidence_idx].get("source_ids", []) or []),
                    }
                )
                continue
            evidence_results.append(compare_evidence(saved_evidences[evidence_idx], replay_evidences[evidence_idx]))

        agent_identical = all(item.get("identical", False) for item in evidence_results)
        agent_results.append(
            {
                "agent": agent_name,
                "sub_queries": sub_queries,
                "saved_evidence_count": len(saved_evidences),
                "replay_evidence_count": len(replay_evidences),
                "identical": agent_identical,
                "evidence_results": evidence_results,
            }
        )

    record_identical = all(agent_result.get("identical", False) for agent_result in agent_results)
    return {
        "idx": record.get("idx"),
        "question": question,
        "activated_agents": activated_agents,
        "identical": record_identical,
        "agent_results": agent_results,
    }


async def async_main() -> int:
    args = parse_args()
    source_jsonl = args.source_jsonl.resolve()
    source_config = resolve_source_config_path(source_jsonl, args.source_config.resolve() if args.source_config else None)
    output_path = args.output.resolve() if args.output else source_jsonl.with_name(source_jsonl.stem + "_replay_compare.json")

    if not source_jsonl.exists():
        raise FileNotFoundError(f"Missing source JSONL: {source_jsonl}")
    if not source_config.exists():
        raise FileNotFoundError(f"Missing source config: {source_config}")

    config = load_yaml(source_config)
    records = load_jsonl(source_jsonl)
    selected_records = select_records(records, args.start_idx, args.max_records)
    chat_service = build_service(config)
    comparisons: List[Dict[str, Any]] = []
    identical_records = 0
    mismatched_records = 0
    identical_agents = 0
    mismatched_agents = 0
    identical_evidences = 0
    mismatched_evidences = 0

    total = len(selected_records)
    for position, record in enumerate(selected_records, 1):
        idx = record.get("idx", args.start_idx + position - 1)
        question = eval_retrieval._get_question(record)
        print(f"[{position}/{total}] idx={idx} replaying {question}")
        comparison = await replay_record(chat_service, record)
        comparisons.append(comparison)
        if comparison["identical"]:
            identical_records += 1
        else:
            mismatched_records += 1

        for agent_result in comparison["agent_results"]:
            if agent_result["identical"]:
                identical_agents += 1
            else:
                mismatched_agents += 1
            for evidence_result in agent_result["evidence_results"]:
                if evidence_result.get("identical", False):
                    identical_evidences += 1
                else:
                    mismatched_evidences += 1

    summary = {
        "source_jsonl": str(source_jsonl),
        "source_config": str(source_config),
        "records_total": len(records),
        "records_compared": len(selected_records),
        "identical_records": identical_records,
        "mismatched_records": mismatched_records,
        "identical_agents": identical_agents,
        "mismatched_agents": mismatched_agents,
        "identical_evidences": identical_evidences,
        "mismatched_evidences": mismatched_evidences,
        "comparisons": comparisons,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print("=" * 70)
    print(f"records_compared      : {summary['records_compared']}")
    print(f"identical_records     : {identical_records}")
    print(f"mismatched_records    : {mismatched_records}")
    print(f"identical_agents      : {identical_agents}")
    print(f"mismatched_agents     : {mismatched_agents}")
    print(f"identical_evidences   : {identical_evidences}")
    print(f"mismatched_evidences  : {mismatched_evidences}")
    print(f"report                : {output_path}")
    print("=" * 70)

    if args.strict and mismatched_records > 0:
        return 1
    return 0


def main() -> int:
    return asyncio.run(async_main())


if __name__ == "__main__":
    raise SystemExit(main())
