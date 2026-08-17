"""Run the real RAG retrieval stack from a credential-free candidate worktree."""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
from datetime import datetime
from pathlib import Path

import yaml


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--questions", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--persist-directory", required=True)
    parser.add_argument("--collection-name", required=True)
    parser.add_argument("--seeds", default="11,29,47")
    parser.add_argument("--rerank-topk", type=int, default=5)
    parser.add_argument("--max-cases", type=int, default=0)
    parser.add_argument("--enable-exact-rescue", action="store_true")
    args = parser.parse_args()

    repo = args.repo.resolve()
    sys.path.insert(0, str(repo / "src"))
    from core.RAG import RAG
    from core.RAGManager import RAGManager
    from utils.vllm_reranker import VLLMReranker

    config = yaml.safe_load(args.config.read_text(encoding="utf-8"))
    forbidden = [key for key in config if any(term in key.lower() for term in ("api_key", "secret", "token", "password", "credential"))]
    if forbidden:
        raise ValueError(f"sanitized config contains forbidden credential keys: {forbidden}")
    config.update({
        "persist_directory": str(Path(args.persist_directory).resolve()),
        "collection_name": args.collection_name,
        "retrieval_scope_required": False,
        "retrieval_mode": "rag_only",
        "datasets": {},
        "exact_date_numeric_rescue_enabled": bool(args.enable_exact_rescue),
    })
    manager = RAGManager(config, collections={args.collection_name: 10})
    reranker = VLLMReranker(
        endpoint_url=config.get("reranker_vllm_url", "http://127.0.0.1:5432/rerank"),
        model_name=config.get("rerank_model"),
        timeout_seconds=float(config.get("reranker_timeout_seconds", 60)),
        api_key=None,
        max_retries=int(config.get("reranker_vllm_max_retries", 2)),
        retry_backoff_seconds=float(config.get("reranker_vllm_retry_backoff_seconds", 0.5)),
        score_transform=config.get("reranker_vllm_score_transform", "logit"),
    )
    rag = RAG(manager, reranker, None, args.rerank_topk, collection_name=args.collection_name)
    questions = [json.loads(line) for line in args.questions.read_text(encoding="utf-8").splitlines() if line.strip()]
    if args.max_cases:
        questions = questions[: args.max_cases]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        for row in questions:
            if set(row) - {"case_id", "question"}:
                raise ValueError("question file is not question-only")
            for seed_text in args.seeds.split(","):
                seed = int(seed_text)
                random.seed(seed)
                result = rag.retrieve(row["question"], datetime.now(), agent="company_researcher")
                handle.write(json.dumps({
                    "schema_version": "rsi-retrieval-stack-output/v1",
                    "arm": "candidate" if args.enable_exact_rescue else "baseline",
                    "candidate_id": "cand-exact-date-numeric-rescue-l4-v1" if args.enable_exact_rescue else None,
                    "case_id": row["case_id"], "seed": seed, "answer": "",
                    "retrieved_chunks": result["final_chunks"],
                    "pre_rerank_candidates": result["pre_rerank_chunks"],
                }, ensure_ascii=False, sort_keys=True) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
    print(len(questions) * len(args.seeds.split(",")))


if __name__ == "__main__":
    main()
