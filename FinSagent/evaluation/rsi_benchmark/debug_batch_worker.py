"""Run FinSagent debug queries in one isolated process without hidden rubrics."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import random
import sys
import time
from pathlib import Path
from typing import Any

import yaml


def load_target_questions(path: Path) -> list[dict[str, Any]]:
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    forbidden = {"rubric", "ground_truth_answer", "key_points", "answer_key", "evidence_refs", "provenance"}
    for row in rows:
        leaked = forbidden.intersection(row)
        if leaked or any(key.startswith("hidden_") for key in row):
            raise ValueError(f"target input contains evaluator fields: {sorted(leaked)}")
        if not row.get("case_id") or not row.get("question"):
            raise ValueError("each target row requires case_id and question")
    return rows


def append_jsonl(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def apply_retrieval_overrides(
    config: dict[str, Any], *, persist_directory: str = "", collection_name: str = "",
) -> dict[str, Any]:
    resolved = dict(config)
    if persist_directory:
        resolved["persist_directory"] = str(Path(persist_directory).resolve())
    if collection_name:
        resolved["collection_name"] = collection_name
    return resolved


async def run(args: argparse.Namespace) -> None:
    repo = Path(args.repo).resolve()
    sys.path.insert(0, str(repo / "src"))
    from core.ChatService import ChatService
    from core.RAGManager import RAGManager

    config_path = Path(args.config).resolve()
    config = apply_retrieval_overrides(
        yaml.safe_load(config_path.read_text(encoding="utf-8")),
        persist_directory=args.persist_directory,
        collection_name=args.collection_name,
    )
    state_dir = Path(args.state_dir).resolve()
    state_dir.mkdir(parents=True, exist_ok=True)
    config["session_history_db"] = str(state_dir / "sessions.sqlite3")
    config["enable_title_summaries"] = False
    config["_rsi_capture_skill_replay_inputs"] = True
    os.environ["ENABLE_TITLE_SUMMARIES"] = "0"
    questions = load_target_questions(Path(args.questions))
    if args.max_cases:
        questions = questions[: args.max_cases]
    seeds = [int(value) for value in args.seeds.split(",") if value.strip()]
    rag_manager = RAGManager(config, collections={config["collection_name"]: 10})
    service = ChatService(config=config, rag_manager=rag_manager, rerank_topk=int(args.rerank_topk))
    config_hash = hashlib.sha256(config_path.read_bytes()).hexdigest()

    for question in questions:
        for seed in seeds:
            random.seed(seed)
            try:
                import numpy as np
                np.random.seed(seed)
            except Exception:
                pass
            session_id = f"rsi-{args.arm}-{question['case_id']}-{seed}"
            started = time.perf_counter()
            result = await service.generate_response_debug_async(
                question=str(question["question"]), session_id=session_id, stop_after_retrieval=False,
            )
            elapsed = time.perf_counter() - started
            append_jsonl(Path(args.out), {
                "schema_version": "rsi-full-agent-target-output/v1",
                "arm": args.arm,
                "candidate_id": args.candidate_id if args.arm == "candidate" else None,
                "case_id": question["case_id"],
                "seed": seed,
                "answer": result.get("answer", ""),
                "activated_agents": result.get("activated_agents", []),
                "routing_reason": result.get("routing_reason", ""),
                "retrieved_chunks": result.get("retrieved_chunks", []),
                "pre_rerank_candidates": result.get("pre_rerank_candidates", []),
                "agent_outputs": result.get("agent_outputs", {}),
                "skill_traces": result.get("skill_traces", []),
                "skill_replay_inputs": result.get("skill_replay_inputs", []),
                "total_time": result.get("total_time", elapsed),
                "wall_time": elapsed,
                "error": result.get("error"),
                "config_sha256": config_hash,
            })


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--questions", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--arm", choices=("baseline", "candidate"), required=True)
    parser.add_argument("--candidate-id", default="")
    parser.add_argument("--seeds", default="11,29,47")
    parser.add_argument("--max-cases", type=int, default=0)
    parser.add_argument("--rerank-topk", type=int, default=5)
    parser.add_argument("--persist-directory", default="")
    parser.add_argument("--collection-name", default="")
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()
