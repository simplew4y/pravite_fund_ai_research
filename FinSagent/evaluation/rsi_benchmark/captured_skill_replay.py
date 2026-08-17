"""Replay a pure candidate Skill from baseline debug captures without credentials."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import time
from pathlib import Path
from typing import Any


def _load_function(module_path: Path, function_name: str):
    name = "rsi_captured_replay_" + hashlib.sha256(str(module_path).encode()).hexdigest()[:12]
    spec = importlib.util.spec_from_file_location(name, module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load candidate module: {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return getattr(module, function_name)


def replay_captured_skill(
    *, captures_path: Path, module_path: Path, function_name: str,
    skill_id: str, out_path: Path, candidate_id: str,
) -> int:
    function = _load_function(module_path, function_name)
    rows = [json.loads(line) for line in captures_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    out_path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with out_path.open("x", encoding="utf-8") as handle:
        for row in rows:
            captures = [x for x in row.get("skill_replay_inputs", []) if x.get("skill_id") == skill_id]
            if len(captures) != 1:
                raise ValueError(f"{row.get('case_id')}: expected exactly one {skill_id} capture")
            capture = captures[0]
            started = time.perf_counter()
            result = function(capture["question"], capture["input_answer"], capture["retrieved_chunks"])
            elapsed_ms = (time.perf_counter() - started) * 1000
            output = {
                "schema_version": "rsi-captured-skill-replay/v1",
                "candidate_id": candidate_id,
                "case_id": row["case_id"],
                "seed": row["seed"],
                "answer": result.get("answer", ""),
                "repair_applied": bool(result.get("repair_applied")),
                "repair_reason": result.get("repair_reason", ""),
                "supporting_source": result.get("supporting_source"),
                "latency_ms": elapsed_ms,
                "input_answer_sha256": hashlib.sha256(capture["input_answer"].encode()).hexdigest(),
                "module_sha256": hashlib.sha256(module_path.read_bytes()).hexdigest(),
            }
            handle.write(json.dumps(output, ensure_ascii=False, sort_keys=True) + "\n")
            count += 1
    os.chmod(out_path, 0o600)
    return count


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--captures", type=Path, required=True)
    parser.add_argument("--module", type=Path, required=True)
    parser.add_argument("--function", required=True)
    parser.add_argument("--skill-id", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--candidate-id", required=True)
    args = parser.parse_args()
    print(replay_captured_skill(
        captures_path=args.captures, module_path=args.module, function_name=args.function,
        skill_id=args.skill_id, out_path=args.out, candidate_id=args.candidate_id,
    ))


if __name__ == "__main__":
    main()
