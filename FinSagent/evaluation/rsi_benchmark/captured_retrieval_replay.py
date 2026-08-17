"""Replay a pure retrieval-selection candidate from sanitized debug captures.

The candidate receives only a question, pre-rerank chunks, and already-selected
chunks. Ground truth, judge output, production config, and credentials are not
part of this interface.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import time
from pathlib import Path
from typing import Any


QUESTION_KEYS = {"case_id", "question"}


def _load_function(module_path: Path, function_name: str):
    name = "rsi_retrieval_replay_" + hashlib.sha256(str(module_path).encode()).hexdigest()[:12]
    spec = importlib.util.spec_from_file_location(name, module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load candidate module: {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return getattr(module, function_name)


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def replay_captured_retrieval(
    *, captures_path: Path, questions_path: Path, module_path: Path,
    function_name: str, out_path: Path, candidate_id: str,
) -> int:
    function = _load_function(module_path, function_name)
    question_rows = _read_jsonl(questions_path)
    for row in question_rows:
        extra = set(row) - QUESTION_KEYS
        if extra:
            raise ValueError(f"question input contains forbidden fields: {sorted(extra)}")
    questions = {row["case_id"]: row["question"] for row in question_rows}
    rows = _read_jsonl(captures_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with out_path.open("x", encoding="utf-8") as handle:
        for row in rows:
            case_id = row["case_id"]
            if case_id not in questions:
                raise ValueError(f"missing question-only input for {case_id}")
            pre = row.get("pre_rerank_candidates") or []
            selected = row.get("retrieved_chunks") or []
            started = time.perf_counter()
            result = function(questions[case_id], pre, selected)
            elapsed_ms = (time.perf_counter() - started) * 1000
            output = {
                "schema_version": "rsi-captured-retrieval-replay/v1",
                "candidate_id": candidate_id,
                "case_id": case_id,
                "seed": row.get("seed"),
                "selected_chunks": result.get("selected_chunks", selected),
                "rescue_applied": bool(result.get("rescue_applied")),
                "rescue_reason": result.get("rescue_reason", ""),
                "rescued_candidate_indices": result.get("rescued_candidate_indices", []),
                "latency_ms": elapsed_ms,
                "module_sha256": hashlib.sha256(module_path.read_bytes()).hexdigest(),
            }
            handle.write(json.dumps(output, ensure_ascii=False, sort_keys=True) + "\n")
            count += 1
    os.chmod(out_path, 0o600)
    return count


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--captures", type=Path, required=True)
    parser.add_argument("--questions", type=Path, required=True)
    parser.add_argument("--module", type=Path, required=True)
    parser.add_argument("--function", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--candidate-id", required=True)
    args = parser.parse_args()
    print(replay_captured_retrieval(
        captures_path=args.captures, questions_path=args.questions,
        module_path=args.module, function_name=args.function,
        out_path=args.out, candidate_id=args.candidate_id,
    ))


if __name__ == "__main__":
    main()
