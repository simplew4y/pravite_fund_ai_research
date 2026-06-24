#!/usr/bin/env python3
import argparse
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List

from dotenv import dotenv_values
from tqdm.auto import tqdm

_ENV_PATH = Path(__file__).resolve().parent / ".env"
_ENV = dotenv_values(_ENV_PATH)

OPENAI_BASE_URL = (
    _ENV.get("LLM_BASE_URL")
    or "https://api.lkeap.cloud.tencent.com/v1"
)
OPENAI_API_KEY = (
    _ENV.get("LLM_API_KEY")
    or _ENV.get("TENCENT_API_KEY")
    or ""
)
LLM_MODEL_NAME = _ENV.get("LLM_MODEL_NAME") or "deepseek-v4-pro"


def _try_get_tokenizer():
    try:
        import tiktoken

        return tiktoken.get_encoding("cl100k_base")
    except Exception:
        return None


def _estimate_tokens(text: str) -> int:
    enc = _try_get_tokenizer()
    if enc is not None:
        try:
            return len(enc.encode(text))
        except Exception:
            pass
    return max(1, (len(text) + 3) // 4)


def _truncate_middle(text: str, max_chars: int) -> str:
    if max_chars <= 0:
        return ""
    if len(text) <= max_chars:
        return text
    marker = "\n\n...[TRUNCATED]...\n\n"
    keep = max_chars - len(marker)
    if keep <= 0:
        return text[:max_chars]
    head = keep * 7 // 10
    tail = keep - head
    return text[:head] + marker + text[-tail:]


def _truncate_text_to_tokens(text: str, max_tokens: int) -> str:
    if max_tokens <= 0:
        return ""
    enc = _try_get_tokenizer()
    if enc is not None:
        try:
            toks = enc.encode(text)
            if len(toks) <= max_tokens:
                return text
            return enc.decode(toks[:max_tokens])
        except Exception:
            pass
    return _truncate_middle(text, max_chars=max_tokens * 4)


def _apply_max_input_tokens(prompt: str, *, max_input_tokens: int) -> str:
    if max_input_tokens is None or max_input_tokens <= 0:
        return prompt

    est = _estimate_tokens(prompt)
    if est <= max_input_tokens:
        return prompt

    answer_tag = "Reference Answer:\n"
    idx = prompt.find(answer_tag)
    if idx == -1:
        return _truncate_text_to_tokens(prompt, max_input_tokens)

    prefix = prompt[: idx + len(answer_tag)]
    answer = prompt[idx + len(answer_tag) :]

    prefix_tokens = _estimate_tokens(prefix)
    remaining = max_input_tokens - prefix_tokens
    if remaining <= 0:
        return _truncate_text_to_tokens(prompt, max_input_tokens)

    return prefix + _truncate_text_to_tokens(answer, remaining)


def _is_truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y"}
    return False


def _get_reference_answer(row: Dict[str, Any]) -> str:
    return str(
        row.get("ground_truth_answer")
        or row.get("ground_truth_question")
        or row.get("answer", "")
    ).strip()


def query_model(
    prompt: str,
    model_name: str,
    reasoning_effort: str | None = None,
    max_input_tokens: int | None = None,
) -> str:
    from openai import OpenAI

    if not OPENAI_API_KEY:
        raise RuntimeError(
            "OPENAI_API_KEY (or TENCENT_API_KEY) is not set in "
            f"{_ENV_PATH}"
        )

    client = OpenAI(base_url=OPENAI_BASE_URL, api_key=OPENAI_API_KEY, max_retries=5)
    is_gpt5_family = model_name.startswith("gpt-5")

    if max_input_tokens is not None:
        prompt = _apply_max_input_tokens(prompt, max_input_tokens=max_input_tokens)

    messages = [{"role": "user", "content": prompt}]
    if is_gpt5_family:
        try:
            responses_params: Dict[str, Any] = {
                "model": model_name,
                "input": prompt,
                "max_output_tokens": 2048,
            }
            if reasoning_effort is not None:
                responses_params["reasoning"] = {"effort": reasoning_effort}
            resp = client.responses.create(**responses_params)
            text = resp.output_text
        except Exception:
            completion = client.chat.completions.create(
                model=model_name,
                messages=messages,
                max_completion_tokens=2048,
                temperature=0.2,
            )
            text = completion.choices[0].message.content or ""
    else:
        completion = client.chat.completions.create(
            model=model_name,
            messages=messages,
            max_tokens=2048,
            temperature=0.2,
        )
        text = completion.choices[0].message.content or ""

    if text:
        text = re.sub(r"<think>[\s\S]*?</think>\s*", "", text, flags=re.IGNORECASE)
    return text.strip()


def build_prompt(question: str, answer: str, max_keypoints: int) -> str:
    return (
        "You extract evaluation key points for financial QA.\n"
        "Given a question and its reference answer, write the key points that a correct answer must contain.\n"
        "Requirements:\n"
        f"- Return 1 to {max_keypoints} key points.\n"
        "- Do not force multiple key points when the reference answer expresses only one simple fact.\n"
        "- If a single key point fully captures the required answer, return only one.\n"
        "- Each key point should be short, atomic, and directly verifiable.\n"
        "- Preserve critical numbers, dates, entities, comparisons, and scope.\n"
        "- Do not add facts not supported by the reference answer.\n"
        "- Do not include explanation or markdown.\n"
        '- Output only a JSON array of strings, for example: ["...", "..."]\n\n'
        f"Question:\n{question}\n\n"
        f"Reference Answer:\n{answer}"
    )


def parse_keypoints(text: str, max_keypoints: int) -> List[str]:
    text = text.strip()
    if not text:
        return []

    candidates: List[str] = []

    try:
        obj = json.loads(text)
        if isinstance(obj, list):
            candidates = [str(x).strip() for x in obj if str(x).strip()]
    except Exception:
        match = re.search(r"\[[\s\S]*\]", text)
        if match:
            try:
                obj = json.loads(match.group(0))
                if isinstance(obj, list):
                    candidates = [str(x).strip() for x in obj if str(x).strip()]
            except Exception:
                pass

    if not candidates:
        lines = []
        for raw in text.splitlines():
            line = raw.strip()
            line = re.sub(r"^[-*]\s*", "", line)
            line = re.sub(r"^\d+[.)]\s*", "", line)
            if line:
                lines.append(line)
        candidates = lines

    deduped: List[str] = []
    seen = set()
    for kp in candidates:
        cleaned = re.sub(r"\s+", " ", kp).strip().strip('"').strip("'")
        if not cleaned:
            continue
        key = cleaned.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(cleaned)
        if len(deduped) >= max_keypoints:
            break
    return deduped


def generate_keypoints_for_row(
    row: Dict[str, Any],
    *,
    max_keypoints: int,
    reasoning_effort: str | None,
    max_input_tokens: int,
    max_retries: int,
) -> List[str]:
    question = str(row.get("question", "")).strip()
    answer = _get_reference_answer(row)
    prompt = build_prompt(question, answer, max_keypoints=max_keypoints)

    last_error = None
    for _ in range(max_retries):
        try:
            text = query_model(
                prompt,
                model_name=LLM_MODEL_NAME,
                reasoning_effort=reasoning_effort,
                max_input_tokens=max_input_tokens,
            )
            key_points = parse_keypoints(text, max_keypoints=max_keypoints)
            if key_points:
                return key_points
            last_error = RuntimeError(f"empty or unparseable key points: {text[:300]}")
        except Exception as exc:
            last_error = exc
    raise RuntimeError(str(last_error) if last_error else "unknown key point generation error")


def build_output_row(row: Dict[str, Any], index: int, key_points: List[str]) -> Dict[str, Any]:
    out = dict(row)

    qid = row.get("qid")
    if not qid:
        qid = row.get("q_id")
    if not qid and row.get("index") is not None:
        qid = f"qa_kp_{row.get('index')}"
    if not qid:
        qid = f"qa_kp_{index:06d}"

    out["qid"] = str(qid)
    out["question"] = row.get("question", "")
    out["answer"] = _get_reference_answer(row)
    out["generated_answer"] = row.get("generated_answer", "")
    out["key_points"] = key_points
    return out


def main():
    parser = argparse.ArgumentParser(description="Generate key points for QA pairs with an LLM.")
    parser.add_argument("--input_json", required=True, help="Input JSON path. Expected format: [{...}, {...}]")
    parser.add_argument("--output_json", required=True, help="Output JSON path.")
    parser.add_argument("--workers", type=int, default=8, help="Number of concurrent requests.")
    parser.add_argument("--max_keypoints", type=int, default=5, help="Maximum number of key points per sample.")
    parser.add_argument("--max_retries", type=int, default=10, help="Retry count per sample.")
    parser.add_argument(
        "--reasoning_effort",
        default="low",
        choices=["low", "medium", "high", "none"],
        help="Reasoning effort for gpt-5* deployments.",
    )
    parser.add_argument(
        "--max_input_tokens",
        type=int,
        default=32000,
        help="Maximum prompt tokens to send to the model.",
    )
    parser.add_argument("--max_examples", type=int, default=None, help="Optional limit for quick runs.")
    args = parser.parse_args()

    with open(args.input_json, "r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, list):
        raise ValueError("Input JSON must be a list of QA objects.")

    reasoning_effort = None if args.reasoning_effort == "none" else args.reasoning_effort

    tasks = []
    skipped_tool_call = 0
    skipped_invalid = 0
    failed_generations = 0

    for idx, row in enumerate(data):
        if not isinstance(row, dict):
            skipped_invalid += 1
            continue
        if _is_truthy(row.get("is_tool_call_question")):
            skipped_tool_call += 1
            continue

        question = str(row.get("question", "")).strip()
        answer = _get_reference_answer(row)
        if not question or not answer:
            skipped_invalid += 1
            continue

        tasks.append((idx, row))
        if args.max_examples is not None and len(tasks) >= args.max_examples:
            break

    results_by_index: Dict[int, Dict[str, Any]] = {}

    pbar = tqdm(total=len(tasks), desc="Generating key points", unit="qa")
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        future_to_index = {
            executor.submit(
                generate_keypoints_for_row,
                row,
                max_keypoints=args.max_keypoints,
                reasoning_effort=reasoning_effort,
                max_input_tokens=args.max_input_tokens,
                max_retries=args.max_retries,
            ): idx
            for idx, row in tasks
        }

        for future in as_completed(future_to_index):
            idx = future_to_index[future]
            row = data[idx]
            try:
                key_points = future.result()
                out_row = build_output_row(row, idx, key_points)
            except Exception as exc:
                failed_generations += 1
                qid = row.get("qid") or row.get("q_id") or row.get("index") or idx
                print(f"[FAILED] qid={qid} question={row.get('question', '')} error={exc}")
                out_row = build_output_row(row, idx, [])
                out_row["key_points_error"] = str(exc)
            results_by_index[idx] = out_row
            pbar.update(1)
    pbar.close()

    output_rows = [results_by_index[idx] for idx, _ in tasks if idx in results_by_index]

    os.makedirs(os.path.dirname(os.path.abspath(args.output_json)), exist_ok=True)
    with open(args.output_json, "w", encoding="utf-8") as f:
        json.dump(output_rows, f, ensure_ascii=False, indent=2)

    print(
        json.dumps(
            {
                "input_json": args.input_json,
                "output_json": args.output_json,
                "total_input_rows": len(data),
                "processed_rows": len(output_rows),
                "skipped_tool_call_questions": skipped_tool_call,
                "skipped_invalid_rows": skipped_invalid,
                "failed_generations": failed_generations,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
