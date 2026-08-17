"""Strict JSON private judge with no score-bearing parser fallback."""

from __future__ import annotations

import argparse
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import yaml
from openai import OpenAI


STATUSES = {"PRESENT", "PARTIAL", "MISSING", "INCORRECT"}
VERDICTS = {"CORRECT", "PARTIAL", "INCORRECT", "FAILURE"}
DIMENSIONS = ("coverage", "reasoning", "factual_consistency", "clarity", "analytical_depth")


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def extract_json_object(text: str) -> dict[str, Any]:
    cleaned = re.sub(r"<think>.*?(?:</think>|$)", "", text or "", flags=re.DOTALL | re.IGNORECASE).strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE)
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("judge response has no JSON object")
    value = json.loads(cleaned[start:end + 1])
    if not isinstance(value, dict):
        raise ValueError("judge response root must be an object")
    return value


def validate_judgment(value: dict[str, Any], key_point_count: int) -> dict[str, Any]:
    items = value.get("key_points")
    if not isinstance(items, list) or len(items) != key_point_count:
        raise ValueError(f"expected {key_point_count} key-point judgments")
    normalized_items = []
    for expected_index, item in enumerate(items, 1):
        if not isinstance(item, dict) or int(item.get("index", -1)) != expected_index:
            raise ValueError("key-point indices must be consecutive and 1-based")
        status = str(item.get("status") or "").upper()
        if status not in STATUSES:
            raise ValueError(f"invalid key-point status: {status}")
        normalized_items.append({
            "index": expected_index, "status": status,
            "reason": str(item.get("reason") or "")[:1000],
        })
    verdict = str(value.get("verdict") or "").upper()
    if verdict not in VERDICTS:
        raise ValueError(f"invalid verdict: {verdict}")
    if verdict == "CORRECT" and any(item["status"] != "PRESENT" for item in normalized_items):
        raise ValueError("CORRECT requires every key point to be PRESENT")
    scores = value.get("scores")
    if not isinstance(scores, dict):
        raise ValueError("scores must be an object")
    normalized_scores = {}
    for dimension in DIMENSIONS:
        score = int(scores.get(dimension, 0))
        if score < 1 or score > 5:
            raise ValueError(f"invalid {dimension} score")
        normalized_scores[dimension] = score
    present = sum(item["status"] == "PRESENT" for item in normalized_items)
    partial = sum(item["status"] == "PARTIAL" for item in normalized_items)
    return {
        "analysis": str(value.get("analysis") or "")[:4000],
        "key_points": normalized_items,
        "key_point_coverage": (present + 0.5 * partial) / max(1, key_point_count),
        "scores": normalized_scores,
        "primary_error": str(value.get("primary_error") or "NONE")[:100],
        "critical_errors": [str(x)[:500] for x in value.get("critical_errors", [])],
        "verdict": verdict,
        "passed": verdict == "CORRECT",
    }


def build_messages(row: dict[str, Any]) -> list[dict[str, str]]:
    key_points = row["key_points"]
    schema = {
        "analysis": "concise explanation",
        "key_points": [{"index": 1, "status": "PRESENT|PARTIAL|MISSING|INCORRECT", "reason": "why"}],
        "scores": {name: "integer 1-5" for name in DIMENSIONS},
        "primary_error": "NONE|retrieval_miss|scope_failure|context_loss|reasoning_error|factual_error|refusal_error",
        "critical_errors": [],
        "verdict": "CORRECT|PARTIAL|INCORRECT|FAILURE",
    }
    system = (
        "You are a strict financial QA evaluator. Use only the supplied reference answer and key points. "
        "Judge each key point independently. CORRECT requires every key point PRESENT and no critical error. "
        "Every score must be an integer from 1 through 5; never use 0-1 proportions or decimals. "
        "FAILURE means refusal, irrelevant, or empty. Return exactly one JSON object and no markdown. /no_think"
    )
    user = json.dumps({
        "question": row["question"],
        "reference_answer": row["ground_truth_answer"],
        "key_points": [{"index": i, "text": text} for i, text in enumerate(key_points, 1)],
        "generated_answer": row["generated_answer"],
        "required_json_shape": schema,
    }, ensure_ascii=False)
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def call_judge(row: dict[str, Any], config: dict[str, Any]) -> str:
    client = OpenAI(base_url=config.get("llm_base_url"), api_key=config["llm_api_key"], max_retries=3)
    response = client.chat.completions.create(
        model=config["llm_model_name"], messages=build_messages(row),
        max_tokens=3072, temperature=0, top_p=1,
        response_format={"type": "json_object"},
        extra_body={
            "thinking": {"type": "disabled"},
            "chat_template_kwargs": {"enable_thinking": False},
        },
    )
    return response.choices[0].message.content or ""


def prepare_rows(judge_key: Path, generated_answers: Path) -> list[dict[str, Any]]:
    keys = {str(row["qid"]): row for row in load_jsonl(judge_key)}
    generated = {str(row["qid"]): row for row in load_jsonl(generated_answers)}
    if set(keys) != set(generated):
        raise ValueError("judge key and generated-answer qids must match exactly")
    return [{
        "qid": qid,
        "question": keys[qid]["question"],
        "ground_truth_answer": keys[qid]["ground_truth_answer"],
        "key_points": keys[qid]["key_points"],
        "generated_answer": generated[qid]["answer"],
    } for qid in sorted(keys)]


def write_private(path: Path, value: Any) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def run(args: argparse.Namespace) -> dict[str, Any]:
    rows = prepare_rows(args.judge_key, args.generated_answers)
    config = yaml.safe_load(args.config.read_text(encoding="utf-8"))
    args.out_dir.mkdir(parents=True, exist_ok=False, mode=0o700)
    os.chmod(args.out_dir, 0o700)
    results: list[dict[str, Any]] = []
    raw_rows: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        future_map = {pool.submit(call_judge, row, config): row for row in rows}
        for future in as_completed(future_map):
            row = future_map[future]
            try:
                raw = future.result()
                raw_rows.append({"qid": row["qid"], "raw_response": raw})
                judgment = validate_judgment(extract_json_object(raw), len(row["key_points"]))
                results.append({"qid": row["qid"], "status": "valid", **judgment})
            except Exception as exc:
                results.append({"qid": row["qid"], "status": "evaluator_error", "error_type": type(exc).__name__, "error": str(exc)[:1000]})
                if not any(item["qid"] == row["qid"] for item in raw_rows):
                    raw_rows.append({"qid": row["qid"], "raw_response": ""})
    results.sort(key=lambda row: row["qid"])
    raw_rows.sort(key=lambda row: row["qid"])
    valid = [row for row in results if row["status"] == "valid"]
    summary = {
        "schema_version": "rsi-strict-private-judge/v1",
        "row_count": len(results), "valid_count": len(valid),
        "evaluator_error_count": len(results) - len(valid),
        "pass_count": sum(row.get("passed", False) for row in valid),
        "pass_rate_valid": sum(row.get("passed", False) for row in valid) / max(1, len(valid)),
        "mean_key_point_coverage_valid": sum(row.get("key_point_coverage", 0) for row in valid) / max(1, len(valid)),
        "official_score_eligible": len(valid) == len(results),
    }
    write_private(args.out_dir / "results.private.json", results)
    write_private(args.out_dir / "raw_responses.private.json", raw_rows)
    write_private(args.out_dir / "summary.json", summary)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--judge-key", type=Path, required=True)
    parser.add_argument("--generated-answers", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=1)
    print(json.dumps(run(parser.parse_args()), indent=2))


if __name__ == "__main__":
    main()
