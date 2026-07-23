#!/usr/bin/env python3
"""Run a reproducible LongMemEval-S pilot against native Pi memory.

The runner evaluates two conditions on the same stratified question sample:

* ``memory``: the official haystack sessions are stored as isolated Markdown
  memory, indexed by qmd, and queried through Pi's ``memory_search`` tool.
* ``baseline``: the same Pi/model answers with an empty memory directory.

This is a retrieval-and-answering benchmark. It deliberately does not claim to
measure whether the model would autonomously decide which facts to remember
while replaying every original conversation turn.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from omnigent.pi_native_memory import PI_CLI_VERSION, prepare_pi_memory_package_manifest

REPO_ROOT = Path(__file__).resolve().parents[2]
PROVIDER_ID = "omnigent-longmemeval"
DEFAULT_QUESTION_TYPES = (
    "single-session-user",
    "single-session-assistant",
    "single-session-preference",
    "multi-session",
    "knowledge-update",
    "temporal-reasoning",
)
OFFICIAL_DATASET_URL = (
    "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/"
    "resolve/main/longmemeval_s_cleaned.json"
)
OFFICIAL_REPO_URL = "https://github.com/xiaowu0162/LongMemEval"


@dataclass
class PiOutcome:
    returncode: int
    duration_ms: float
    answer: str
    search_calls: int
    search_result_text: str
    input_tokens: int
    output_tokens: int
    total_tokens: int
    timed_out: bool
    stdout_path: str
    stderr_path: str


@dataclass
class BenchmarkResult:
    question_id: str
    question_type: str
    condition: str
    question: str
    reference_answer: str
    hypothesis: str
    correct: bool
    judge_raw: str
    lexical_match: bool
    answer_session_ids: list[str]
    retrieval_hit: bool | None
    search_calls: int
    returncode: int
    timed_out: bool
    duration_ms: float
    input_tokens: int
    output_tokens: int
    total_tokens: int
    history_sessions: int
    history_chars: int
    stdout_path: str
    stderr_path: str


def _json_dump(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _append_jsonl(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False) + "\n")


def _safe_name(value: str, *, max_length: int = 120) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-")
    return (cleaned or "item")[:max_length]


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(str(block.get("text", "")))
    return "\n".join(part for part in parts if part)


def _normalize_answer(value: Any) -> str:
    text = str(value).casefold()
    return re.sub(r"[\W_]+", "", text, flags=re.UNICODE)


def _normalize_session_identity(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value).casefold())


def lexical_answer_match(reference: Any, hypothesis: str) -> bool:
    expected = _normalize_answer(reference)
    actual = _normalize_answer(hypothesis)
    if not expected or not actual:
        return False
    return expected in actual or actual in expected


def percentile(values: Iterable[float], percentile_value: float) -> float | None:
    ordered = sorted(float(value) for value in values)
    if not ordered:
        return None
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * percentile_value
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def select_stratified_questions(
    dataset: list[dict[str, Any]],
    question_types: Iterable[str],
    samples_per_type: int,
    seed: int,
) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    for question_type in question_types:
        candidates = [item for item in dataset if item.get("question_type") == question_type]
        ranked = sorted(
            candidates,
            key=lambda item: hashlib.sha256(
                f"{seed}:{item.get('question_id', '')}".encode()
            ).hexdigest(),
        )
        if len(ranked) < samples_per_type:
            raise ValueError(
                f"Question type {question_type!r} has only {len(ranked)} items; "
                f"requested {samples_per_type}."
            )
        selected.extend(ranked[:samples_per_type])
    return selected


def render_session_markdown(
    question_id: str,
    session_id: str,
    session_date: str,
    messages: list[dict[str, Any]],
) -> str:
    lines = [
        "# 📝 LongMemEval Session",
        "",
        f"- 📝 Question corpus ID: `{question_id}`",
        f"- 📝 Session ID: `{session_id}`",
        f"- 📝 Timestamp: `{session_date}`",
        "",
        "## 📝 Transcript",
        "",
    ]
    for message in messages:
        role = str(message.get("role", "unknown")).upper()
        content = _content_text(message.get("content"))
        lines.extend((f"### 📝 {role}", "", content.strip(), ""))
    return "\n".join(lines).rstrip() + "\n"


def materialize_history(
    item: dict[str, Any],
    memory_dir: Path,
) -> tuple[int, int]:
    sessions_dir = memory_dir / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    session_ids = list(item.get("haystack_session_ids") or [])
    session_dates = list(item.get("haystack_dates") or [])
    sessions = list(item.get("haystack_sessions") or [])
    if not (len(session_ids) == len(session_dates) == len(sessions)):
        raise ValueError(
            f"Mismatched history fields for {item.get('question_id')}: "
            f"{len(session_ids)} ids, {len(session_dates)} dates, "
            f"{len(sessions)} sessions"
        )
    total_chars = 0
    for index, (session_id, session_date, messages) in enumerate(
        zip(session_ids, session_dates, sessions, strict=True)
    ):
        rendered = render_session_markdown(
            str(item["question_id"]),
            str(session_id),
            str(session_date),
            list(messages),
        )
        total_chars += len(rendered)
        filename = f"{index:04d}-{_safe_name(str(session_id))}.md"
        (sessions_dir / filename).write_text(rendered, encoding="utf-8")
    return len(sessions), total_chars


def _run_command(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    timeout: float,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def prepare_qmd(
    qmd_path: Path,
    memory_dir: Path,
    sample_dir: Path,
) -> tuple[dict[str, str], dict[str, Any]]:
    qmd_env = dict(os.environ)
    qmd_env["PATH"] = os.pathsep.join((str(qmd_path.parent), qmd_env.get("PATH", "")))
    qmd_env["QMD_CONFIG_DIR"] = str(sample_dir / "qmd-config")
    qmd_env["XDG_CACHE_HOME"] = str(sample_dir / "qmd-cache")
    qmd_env["QMD_FORCE_CPU"] = "1"
    collection = _run_command(
        [
            str(qmd_path),
            "collection",
            "add",
            str(memory_dir),
            "--name",
            "pi-memory",
        ],
        cwd=REPO_ROOT,
        env=qmd_env,
        timeout=60,
    )
    if collection.returncode != 0:
        raise RuntimeError(
            f"qmd collection add failed: {collection.stderr.strip() or collection.stdout.strip()}"
        )
    started = time.perf_counter()
    update = _run_command(
        [str(qmd_path), "update"],
        cwd=REPO_ROOT,
        env=qmd_env,
        timeout=180,
    )
    index_duration_ms = (time.perf_counter() - started) * 1000
    if update.returncode != 0:
        raise RuntimeError(f"qmd update failed: {update.stderr.strip() or update.stdout.strip()}")
    status = _run_command(
        [str(qmd_path), "collection", "list", "--json"],
        cwd=REPO_ROOT,
        env=qmd_env,
        timeout=30,
    )
    return qmd_env, {
        "index_duration_ms": index_duration_ms,
        "collection_stdout": collection.stdout.strip(),
        "update_stdout": update.stdout.strip(),
        "status_stdout": status.stdout.strip(),
    }


def prepare_agent_dir(
    agent_dir: Path,
    *,
    base_url: str,
    api_key_env: str,
    reader_model: str,
) -> None:
    agent_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    settings = {"packages": ["npm:pi-memory@0.4.0"]}
    models = {
        "providers": {
            PROVIDER_ID: {
                "api": "openai-completions",
                "apiKey": f"${{{api_key_env}}}",
                "authHeader": True,
                "baseUrl": base_url,
                "compat": {
                    "supportsDeveloperRole": False,
                    "supportsReasoningEffort": False,
                },
                "models": [
                    {
                        "id": reader_model,
                        "name": reader_model,
                        "reasoning": False,
                        "input": ["text"],
                        "cost": {
                            "input": 0,
                            "output": 0,
                            "cacheRead": 0,
                            "cacheWrite": 0,
                        },
                        "contextWindow": 131072,
                        "maxTokens": 4096,
                    }
                ],
            }
        }
    }
    _json_dump(agent_dir / "settings.json", settings)
    _json_dump(agent_dir / "models.json", models)
    _json_dump(agent_dir / "auth.json", {})
    prepare_pi_memory_package_manifest(agent_dir)
    for filename in ("settings.json", "models.json", "auth.json"):
        os.chmod(agent_dir / filename, 0o600)


def build_memory_prompt(
    item: dict[str, Any],
    *,
    search_mode: str,
    search_limit: int,
    max_searches: int,
) -> str:
    return (
        "You are being evaluated on long-term conversational memory. "
        f"Use memory_search with mode={json.dumps(search_mode)}, "
        f"limit={search_limit}, and a concise query derived from the question. "
        f"You may call memory_search at most {max_searches} times if you need to "
        "refine the query. Base the answer only on retrieved memory. "
        "Answer with one short sentence and no explanation. If the memory does "
        "not contain enough information, answer exactly: I don't know.\n\n"
        f"Question date: {item.get('question_date', '')}\n"
        f"Question: {item.get('question', '')}"
    )


def build_baseline_prompt(item: dict[str, Any]) -> str:
    return (
        "You are being evaluated on long-term conversational memory, but no "
        "conversation history is available in this condition. Answer with one "
        "short sentence and no explanation. If the information is unavailable, "
        "answer exactly: I don't know.\n\n"
        f"Question date: {item.get('question_date', '')}\n"
        f"Question: {item.get('question', '')}"
    )


def _parse_events(stdout: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            events.append(item)
    return events


def _last_agent_messages(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for event in reversed(events):
        if event.get("type") == "agent_end" and isinstance(event.get("messages"), list):
            return [item for item in event["messages"] if isinstance(item, dict)]
    return []


def _assistant_answer(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") != "assistant":
            continue
        text = _content_text(message.get("content")).strip()
        if text:
            return text
    return ""


def _usage_from_messages(messages: list[dict[str, Any]]) -> tuple[int, int, int]:
    input_tokens = 0
    output_tokens = 0
    for message in messages:
        if message.get("role") != "assistant":
            continue
        usage = message.get("usage")
        if not isinstance(usage, dict):
            continue
        input_tokens += int(usage.get("input") or 0)
        output_tokens += int(usage.get("output") or 0)
    return input_tokens, output_tokens, input_tokens + output_tokens


def _search_results_from_messages(
    messages: list[dict[str, Any]],
) -> tuple[int, str]:
    results: list[str] = []
    calls = 0
    for message in messages:
        if message.get("role") == "assistant":
            content = message.get("content")
            if isinstance(content, list):
                for block in content:
                    if (
                        isinstance(block, dict)
                        and block.get("type") == "toolCall"
                        and block.get("name") == "memory_search"
                    ):
                        calls += 1
        if message.get("role") == "toolResult" and message.get("toolName") == "memory_search":
            text = _content_text(message.get("content"))
            if text:
                results.append(text)
            details = message.get("details")
            if details is not None:
                results.append(json.dumps(details, ensure_ascii=False))
    return calls, "\n".join(results)


def run_pi(
    *,
    pi_path: Path,
    agent_dir: Path,
    session_dir: Path,
    memory_dir: Path,
    qmd_env: dict[str, str] | None,
    reader_model: str,
    prompt: str,
    output_prefix: Path,
    timeout: float,
) -> PiOutcome:
    env = dict(os.environ)
    if qmd_env:
        env.update(qmd_env)
    env.update(
        {
            "PI_CODING_AGENT_DIR": str(agent_dir),
            "PI_CODING_AGENT_SESSION_DIR": str(session_dir),
            "PI_MEMORY_DIR": str(memory_dir),
            "PI_MEMORY_SNAPSHOT": "stable",
            "PI_MEMORY_QMD_UPDATE": "manual" if qmd_env else "off",
            "PI_SKIP_VERSION_CHECK": "1",
            "PI_TELEMETRY": "0",
        }
    )
    command = [
        str(pi_path),
        "--mode",
        "json",
        "--no-session",
        "--no-context-files",
        "--no-skills",
        "--no-prompt-templates",
        "--provider",
        PROVIDER_ID,
        "--model",
        reader_model,
        "--thinking",
        "off",
        "--no-builtin-tools",
        prompt,
    ]
    started = time.perf_counter()
    timed_out = False
    try:
        process = subprocess.run(
            command,
            cwd=REPO_ROOT,
            env=env,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        returncode = process.returncode
        stdout = process.stdout
        stderr = process.stderr
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        returncode = 124
        stdout = exc.stdout if isinstance(exc.stdout, str) else ""
        stderr = exc.stderr if isinstance(exc.stderr, str) else ""
    duration_ms = (time.perf_counter() - started) * 1000
    stdout_path = output_prefix.with_suffix(".stdout.jsonl")
    stderr_path = output_prefix.with_suffix(".stderr.txt")
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    stdout_path.write_text(stdout, encoding="utf-8")
    stderr_path.write_text(stderr, encoding="utf-8")
    events = _parse_events(stdout)
    messages = _last_agent_messages(events)
    answer = _assistant_answer(messages)
    input_tokens, output_tokens, total_tokens = _usage_from_messages(messages)
    search_calls, search_result_text = _search_results_from_messages(messages)
    return PiOutcome(
        returncode=returncode,
        duration_ms=duration_ms,
        answer=answer,
        search_calls=search_calls,
        search_result_text=search_result_text,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
        timed_out=timed_out,
        stdout_path=str(stdout_path),
        stderr_path=str(stderr_path),
    )


def official_judge_prompt(item: dict[str, Any], hypothesis: str) -> str:
    task = str(item["question_type"])
    question = str(item["question"])
    answer = str(item["answer"])
    abstention = "_abs" in str(item["question_id"])
    if abstention:
        return (
            "I will give you an unanswerable question, an explanation, and a "
            "response from a model. Please answer yes if the model correctly "
            "identifies the question as unanswerable. The model could say that "
            "the information is incomplete, or some other information is given "
            "but the asked information is not.\n\n"
            f"Question: {question}\n\nExplanation: {answer}\n\n"
            f"Model Response: {hypothesis}\n\n"
            "Does the model correctly identify the question as unanswerable? "
            "Answer yes or no only."
        )
    if task in {"single-session-user", "single-session-assistant", "multi-session"}:
        rubric = (
            "Please answer yes if the response contains the correct answer. "
            "Otherwise, answer no. If the response is equivalent to the correct "
            "answer or contains all the intermediate steps to get the correct "
            "answer, you should also answer yes. If the response only contains "
            "a subset of the information required by the answer, answer no."
        )
    elif task == "temporal-reasoning":
        rubric = (
            "Please answer yes if the response contains the correct answer. "
            "Otherwise, answer no. Equivalent answers are correct. Do not "
            "penalize off-by-one errors for a number of days, weeks, or months."
        )
    elif task == "knowledge-update":
        rubric = (
            "Please answer yes if the response contains the correct answer. "
            "Otherwise, answer no. If previous information is also present, "
            "consider it correct as long as the updated required answer appears."
        )
    elif task == "single-session-preference":
        rubric = (
            "Please answer yes if the response satisfies the desired personalized "
            "response. The response need not reflect every rubric point; it is "
            "correct if it recalls and uses the user's personal information."
        )
    else:
        raise ValueError(f"Unsupported LongMemEval question type: {task}")
    label = "Rubric" if task == "single-session-preference" else "Correct Answer"
    return (
        "I will give you a question, a correct answer or rubric, and a response "
        f"from a model. {rubric}\n\nQuestion: {question}\n\n"
        f"{label}: {answer}\n\nModel Response: {hypothesis}\n\n"
        "Is the model response correct? Answer yes or no only."
    )


def _post_json(
    url: str,
    payload: dict[str, Any],
    *,
    api_key: str,
    timeout: float,
    attempts: int = 4,
) -> dict[str, Any]:
    body = json.dumps(payload).encode()
    last_error: Exception | None = None
    for attempt in range(attempts):
        request = urllib.request.Request(
            url,
            data=body,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                parsed = json.loads(response.read().decode())
                if not isinstance(parsed, dict):
                    raise ValueError("Judge response was not an object")
                return parsed
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
            last_error = exc
            if isinstance(exc, urllib.error.HTTPError) and exc.code < 500 and exc.code != 429:
                break
            time.sleep(min(8.0, 2.0**attempt))
    raise RuntimeError(f"Judge request failed after {attempts} attempts: {last_error}")


def judge_answer(
    item: dict[str, Any],
    hypothesis: str,
    *,
    base_url: str,
    api_key: str,
    judge_model: str,
    timeout: float,
) -> tuple[bool, str]:
    response = _post_json(
        base_url.rstrip("/") + "/chat/completions",
        {
            "model": judge_model,
            "messages": [
                {
                    "role": "user",
                    "content": official_judge_prompt(item, hypothesis),
                }
            ],
            "temperature": 0,
            "max_tokens": 16,
        },
        api_key=api_key,
        timeout=timeout,
    )
    choices = response.get("choices")
    raw = ""
    if isinstance(choices, list) and choices:
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        if isinstance(message, dict):
            raw = str(message.get("content") or "").strip()
    return raw.casefold().startswith("yes"), raw


def _condition_metrics(results: list[BenchmarkResult]) -> dict[str, Any]:
    if not results:
        return {}
    durations = [result.duration_ms for result in results]
    token_counts = [result.total_tokens for result in results]
    return {
        "questions": len(results),
        "correct": sum(result.correct for result in results),
        "accuracy": sum(result.correct for result in results) / len(results),
        "lexical_matches": sum(result.lexical_match for result in results),
        "success_rate": sum(result.returncode == 0 and not result.timed_out for result in results)
        / len(results),
        "latency_ms": {
            "mean": statistics.fmean(durations),
            "p50": percentile(durations, 0.50),
            "p95": percentile(durations, 0.95),
        },
        "tokens": {
            "total": sum(token_counts),
            "mean": statistics.fmean(token_counts),
            "p50": percentile(token_counts, 0.50),
            "p95": percentile(token_counts, 0.95),
            "input": sum(result.input_tokens for result in results),
            "output": sum(result.output_tokens for result in results),
        },
    }


def aggregate_results(
    results: list[BenchmarkResult],
    index_metrics: list[dict[str, Any]],
) -> dict[str, Any]:
    by_condition: dict[str, list[BenchmarkResult]] = defaultdict(list)
    by_category: dict[str, dict[str, list[BenchmarkResult]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for result in results:
        by_condition[result.condition].append(result)
        by_category[result.question_type][result.condition].append(result)
    memory_results = by_condition.get("memory", [])
    baseline_results = by_condition.get("baseline", [])
    retrieval_results = [result for result in memory_results if result.retrieval_hit is not None]
    retrieval_hits = [result for result in retrieval_results if result.retrieval_hit]
    retrieval_misses = [result for result in retrieval_results if not result.retrieval_hit]
    answerable_memory = [
        result for result in memory_results if not result.question_id.endswith("_abs")
    ]
    abstention_memory = [
        result for result in memory_results if result.question_id.endswith("_abs")
    ]
    answerable_baseline = [
        result for result in baseline_results if not result.question_id.endswith("_abs")
    ]
    abstention_baseline = [
        result for result in baseline_results if result.question_id.endswith("_abs")
    ]
    memory_metrics = _condition_metrics(memory_results)
    baseline_metrics = _condition_metrics(baseline_results)
    mean_latency_delta = memory_metrics.get("latency_ms", {}).get(
        "mean", 0
    ) - baseline_metrics.get("latency_ms", {}).get("mean", 0)
    mean_token_delta = memory_metrics.get("tokens", {}).get("mean", 0) - baseline_metrics.get(
        "tokens", {}
    ).get("mean", 0)
    return {
        "conditions": {
            "memory": memory_metrics,
            "baseline": baseline_metrics,
        },
        "accuracy_lift": (memory_metrics.get("accuracy", 0) - baseline_metrics.get("accuracy", 0)),
        "answerability": {
            "answerable": {
                "memory": _condition_metrics(answerable_memory),
                "baseline": _condition_metrics(answerable_baseline),
            },
            "abstention": {
                "memory": _condition_metrics(abstention_memory),
                "baseline": _condition_metrics(abstention_baseline),
            },
        },
        "overhead": {
            "mean_latency_ms_delta": mean_latency_delta,
            "mean_latency_ratio": (
                mean_latency_delta / baseline_metrics["latency_ms"]["mean"]
                if baseline_metrics and baseline_metrics["latency_ms"]["mean"]
                else None
            ),
            "mean_tokens_delta": mean_token_delta,
            "mean_tokens_ratio": (
                mean_token_delta / baseline_metrics["tokens"]["mean"]
                if baseline_metrics and baseline_metrics["tokens"]["mean"]
                else None
            ),
            "total_tokens_delta": (
                memory_metrics.get("tokens", {}).get("total", 0)
                - baseline_metrics.get("tokens", {}).get("total", 0)
            ),
        },
        "retrieval": {
            "questions": len(retrieval_results),
            "answer_session_hits": len(retrieval_hits),
            "answer_session_hit_rate": (
                len(retrieval_hits) / len(retrieval_results) if retrieval_results else None
            ),
            "correct_given_hit": (
                sum(result.correct for result in retrieval_hits) / len(retrieval_hits)
                if retrieval_hits
                else None
            ),
            "correct_given_miss": (
                sum(result.correct for result in retrieval_misses) / len(retrieval_misses)
                if retrieval_misses
                else None
            ),
            "tool_compliance_rate": (
                sum(result.search_calls > 0 for result in memory_results) / len(memory_results)
                if memory_results
                else None
            ),
            "mean_search_calls": (
                statistics.fmean(result.search_calls for result in memory_results)
                if memory_results
                else None
            ),
        },
        "indexing": {
            "samples": len(index_metrics),
            "qmd_update_duration_ms_total": sum(
                float(item["index_duration_ms"]) for item in index_metrics
            ),
            "qmd_update_duration_ms_mean": (
                statistics.fmean(float(item["index_duration_ms"]) for item in index_metrics)
                if index_metrics
                else None
            ),
        },
        "history": {
            "sessions_total": sum(result.history_sessions for result in memory_results),
            "sessions_mean": (
                statistics.fmean(result.history_sessions for result in memory_results)
                if memory_results
                else None
            ),
            "characters_total": sum(result.history_chars for result in memory_results),
            "characters_mean": (
                statistics.fmean(result.history_chars for result in memory_results)
                if memory_results
                else None
            ),
        },
        "categories": {
            category: {
                condition: _condition_metrics(category_results)
                for condition, category_results in conditions.items()
            }
            for category, conditions in sorted(by_category.items())
        },
    }


def _format_percent(value: Any) -> str:
    return "n/a" if value is None else f"{float(value):.1%}"


def render_report(
    manifest: dict[str, Any],
    aggregate: dict[str, Any],
) -> str:
    memory = aggregate["conditions"]["memory"]
    baseline = aggregate["conditions"]["baseline"]
    retrieval = aggregate["retrieval"]
    overhead = aggregate["overhead"]
    answerable = aggregate["answerability"]["answerable"]
    abstention = aggregate["answerability"]["abstention"]
    run_duration = datetime.fromisoformat(manifest["completed_at"]) - datetime.fromisoformat(
        manifest["started_at"]
    )
    lines = [
        "# 📝 Pi Memory LongMemEval-S Pilot Report",
        "",
        "## 📝 Scope",
        "",
        f"- 📝 Run ID: `{manifest['run_id']}`",
        f"- 📝 Questions: {manifest['question_count']} stratified questions; "
        "each answered once with memory and once with an empty-memory baseline.",
        f"- 📝 Reader: `{manifest['reader_model']}`; judge: `{manifest['judge_model']}`.",
        f"- 📝 Search: `{manifest['search_mode']}` with limit "
        f"{manifest['search_limit']} and at most {manifest['max_searches']} calls.",
        f"- 📝 Wall-clock duration: {run_duration.total_seconds() / 60:.2f} minutes.",
        "- 📝 This pilot measures retrieval plus answering over pre-materialized "
        "official histories. It does not measure autonomous memory selection.",
        "",
        "## 📝 Headline Results",
        "",
        "| Metric | Memory | Baseline |",
        "| --- | ---: | ---: |",
        f"| Accuracy | {memory['accuracy']:.1%} | {baseline['accuracy']:.1%} |",
        f"| Correct | {memory['correct']}/{memory['questions']} | "
        f"{baseline['correct']}/{baseline['questions']} |",
        f"| P50 latency | {memory['latency_ms']['p50'] / 1000:.2f}s | "
        f"{baseline['latency_ms']['p50'] / 1000:.2f}s |",
        f"| P95 latency | {memory['latency_ms']['p95'] / 1000:.2f}s | "
        f"{baseline['latency_ms']['p95'] / 1000:.2f}s |",
        f"| Mean tokens | {memory['tokens']['mean']:.0f} | {baseline['tokens']['mean']:.0f} |",
        "",
        f"- 📝 Accuracy lift: {aggregate['accuracy_lift']:+.1%}.",
        "- 📝 Answerable accuracy: "
        f"{_format_percent(answerable['memory'].get('accuracy'))} with memory versus "
        f"{_format_percent(answerable['baseline'].get('accuracy'))} baseline; "
        "abstention accuracy: "
        f"{_format_percent(abstention['memory'].get('accuracy'))} versus "
        f"{_format_percent(abstention['baseline'].get('accuracy'))}.",
        "- 📝 Answer-session retrieval hit rate: "
        f"{_format_percent(retrieval['answer_session_hit_rate'])}.",
        "- 📝 Correct given a retrieval hit: "
        f"{_format_percent(retrieval['correct_given_hit'])}; correct given a miss: "
        f"{_format_percent(retrieval['correct_given_miss'])}.",
        "- 📝 memory_search compliance: "
        f"{_format_percent(retrieval['tool_compliance_rate'])}; "
        f"mean calls {retrieval['mean_search_calls']:.2f}.",
        f"- 📝 Mean latency overhead: {overhead['mean_latency_ms_delta'] / 1000:+.2f}s "
        f"({overhead['mean_latency_ratio']:+.1%}); mean token overhead: "
        f"{overhead['mean_tokens_delta']:+.0f} ({overhead['mean_tokens_ratio']:+.1%}).",
        "",
        "## 📝 Category Accuracy",
        "",
        "| Category | Memory | Baseline |",
        "| --- | ---: | ---: |",
    ]
    for category, conditions in aggregate["categories"].items():
        category_memory = conditions.get("memory", {})
        category_baseline = conditions.get("baseline", {})
        lines.append(
            f"| `{category}` | {category_memory.get('accuracy', 0):.1%} | "
            f"{category_baseline.get('accuracy', 0):.1%} |"
        )
    lines.extend(
        (
            "",
            "## 📝 Interpretation Boundary",
            "",
            "- 📝 This is a deterministic stratified pilot, not the official "
            "500-question leaderboard run.",
            "- 📝 The judge prompt follows the official LongMemEval task rubrics, "
            "but uses the locally configured judge model rather than GPT-4o.",
            "- 📝 Retrieval hit checks whether an official answer-session ID "
            "appeared in a native memory_search tool result.",
            "",
            "## 📝 Sources",
            "",
            f"- 📝 Official repository: {OFFICIAL_REPO_URL}",
            f"- 📝 Official cleaned dataset: {OFFICIAL_DATASET_URL}",
            "",
        )
    )
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run a native Pi memory LongMemEval-S stratified pilot."
    )
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--pi-path", required=True)
    parser.add_argument("--qmd-path", required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:4000/v1")
    parser.add_argument("--reader-model", default="qwen3-max")
    parser.add_argument("--judge-model", default="gpt-5.6-sol")
    parser.add_argument(
        "--api-key-env",
        default="OMNIGENT_BENCHMARK_API_KEY",
        help="Environment variable containing the local proxy API key.",
    )
    parser.add_argument("--samples-per-type", type=int, default=5)
    parser.add_argument(
        "--question-types",
        default=",".join(DEFAULT_QUESTION_TYPES),
        help="Comma-separated LongMemEval question types.",
    )
    parser.add_argument("--seed", type=int, default=20260724)
    parser.add_argument(
        "--search-mode",
        choices=("keyword", "semantic", "deep"),
        default="keyword",
    )
    parser.add_argument("--search-limit", type=int, default=10)
    parser.add_argument("--max-searches", type=int, default=3)
    parser.add_argument("--timeout", type=float, default=180)
    parser.add_argument("--judge-timeout", type=float, default=90)
    parser.add_argument(
        "--output-root",
        default=str(REPO_ROOT / "output" / "pi_memory_longmemeval_runs"),
    )
    parser.add_argument("--run-id", default=None)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.samples_per_type <= 0:
        print("--samples-per-type must be positive", file=sys.stderr)
        return 2
    if args.search_limit <= 0 or args.max_searches <= 0:
        print("--search-limit and --max-searches must be positive", file=sys.stderr)
        return 2
    dataset_path = Path(args.dataset).expanduser().resolve()
    pi_path = Path(args.pi_path).expanduser().resolve()
    qmd_path = Path(args.qmd_path).expanduser().resolve()
    for label, path in (
        ("dataset", dataset_path),
        ("Pi executable", pi_path),
        ("qmd executable", qmd_path),
    ):
        if not path.is_file():
            print(f"{label} not found: {path}", file=sys.stderr)
            return 2
    api_key = os.environ.get(args.api_key_env, "").strip()
    if not api_key:
        print(
            f"Set {args.api_key_env} to the local proxy API key.",
            file=sys.stderr,
        )
        return 2
    question_types = tuple(item.strip() for item in args.question_types.split(",") if item.strip())
    run_id = args.run_id or (datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
    run_dir = Path(args.output_root).expanduser().resolve() / run_id
    run_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    results_path = run_dir / "results.jsonl"
    agent_dir = run_dir / "pi-agent"
    session_dir = run_dir / "pi-sessions"
    prepare_agent_dir(
        agent_dir,
        base_url=args.base_url,
        api_key_env=args.api_key_env,
        reader_model=args.reader_model,
    )
    dataset = json.loads(dataset_path.read_text(encoding="utf-8"))
    if not isinstance(dataset, list):
        raise ValueError("LongMemEval dataset must be a JSON array")
    selected = select_stratified_questions(
        dataset,
        question_types,
        args.samples_per_type,
        args.seed,
    )
    manifest = {
        "run_id": run_id,
        "started_at": datetime.now().astimezone().isoformat(),
        "git_commit": subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            check=False,
        ).stdout.strip(),
        "dataset": str(dataset_path),
        "dataset_sha256": hashlib.sha256(dataset_path.read_bytes()).hexdigest(),
        "dataset_url": OFFICIAL_DATASET_URL,
        "official_repo": OFFICIAL_REPO_URL,
        "pi_path": str(pi_path),
        "expected_pi_version": PI_CLI_VERSION,
        "qmd_path": str(qmd_path),
        "base_url": args.base_url,
        "reader_model": args.reader_model,
        "judge_model": args.judge_model,
        "question_types": question_types,
        "samples_per_type": args.samples_per_type,
        "question_count": len(selected),
        "seed": args.seed,
        "search_mode": args.search_mode,
        "search_limit": args.search_limit,
        "max_searches": args.max_searches,
        "selection": [
            {
                "question_id": item["question_id"],
                "question_type": item["question_type"],
            }
            for item in selected
        ],
    }
    _json_dump(run_dir / "manifest.json", manifest)
    results: list[BenchmarkResult] = []
    index_metrics: list[dict[str, Any]] = []
    for sequence, item in enumerate(selected, start=1):
        question_id = str(item["question_id"])
        question_type = str(item["question_type"])
        sample_dir = run_dir / "samples" / f"{sequence:03d}-{_safe_name(question_id)}"
        memory_dir = sample_dir / "memory"
        baseline_memory_dir = sample_dir / "baseline-memory"
        baseline_memory_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        history_sessions, history_chars = materialize_history(item, memory_dir)
        qmd_env, qmd_details = prepare_qmd(qmd_path, memory_dir, sample_dir)
        qmd_details.update(
            {
                "question_id": question_id,
                "question_type": question_type,
                "history_sessions": history_sessions,
                "history_chars": history_chars,
            }
        )
        index_metrics.append(qmd_details)
        _json_dump(sample_dir / "index.json", qmd_details)

        for condition in ("baseline", "memory"):
            print(
                f"[{sequence:02d}/{len(selected):02d}] {question_type} {question_id} {condition}",
                flush=True,
            )
            if condition == "memory":
                prompt = build_memory_prompt(
                    item,
                    search_mode=args.search_mode,
                    search_limit=args.search_limit,
                    max_searches=args.max_searches,
                )
                condition_memory_dir = memory_dir
                condition_qmd_env = qmd_env
            else:
                prompt = build_baseline_prompt(item)
                condition_memory_dir = baseline_memory_dir
                condition_qmd_env = None
            outcome = run_pi(
                pi_path=pi_path,
                agent_dir=agent_dir,
                session_dir=session_dir,
                memory_dir=condition_memory_dir,
                qmd_env=condition_qmd_env,
                reader_model=args.reader_model,
                prompt=prompt,
                output_prefix=sample_dir / condition,
                timeout=args.timeout,
            )
            try:
                correct, judge_raw = judge_answer(
                    item,
                    outcome.answer,
                    base_url=args.base_url,
                    api_key=api_key,
                    judge_model=args.judge_model,
                    timeout=args.judge_timeout,
                )
            except (KeyError, RuntimeError, ValueError) as exc:
                correct = False
                judge_raw = f"JUDGE_ERROR: {exc}"
            answer_session_ids = [str(value) for value in item.get("answer_session_ids") or []]
            retrieval_hit = None
            if condition == "memory":
                normalized_search_results = _normalize_session_identity(outcome.search_result_text)
                retrieval_hit = bool(answer_session_ids) and any(
                    _normalize_session_identity(session_id) in normalized_search_results
                    for session_id in answer_session_ids
                )
            result = BenchmarkResult(
                question_id=question_id,
                question_type=question_type,
                condition=condition,
                question=str(item["question"]),
                reference_answer=str(item["answer"]),
                hypothesis=outcome.answer,
                correct=correct,
                judge_raw=judge_raw,
                lexical_match=lexical_answer_match(
                    item["answer"],
                    outcome.answer,
                ),
                answer_session_ids=answer_session_ids,
                retrieval_hit=retrieval_hit,
                search_calls=outcome.search_calls,
                returncode=outcome.returncode,
                timed_out=outcome.timed_out,
                duration_ms=outcome.duration_ms,
                input_tokens=outcome.input_tokens,
                output_tokens=outcome.output_tokens,
                total_tokens=outcome.total_tokens,
                history_sessions=history_sessions,
                history_chars=history_chars,
                stdout_path=outcome.stdout_path,
                stderr_path=outcome.stderr_path,
            )
            results.append(result)
            _append_jsonl(results_path, asdict(result))
            print(
                f"  correct={correct} retrieval_hit={retrieval_hit} "
                f"searches={outcome.search_calls} "
                f"latency={outcome.duration_ms / 1000:.2f}s "
                f"tokens={outcome.total_tokens}",
                flush=True,
            )
    aggregate = aggregate_results(results, index_metrics)
    manifest["completed_at"] = datetime.now().astimezone().isoformat()
    _json_dump(run_dir / "manifest.json", manifest)
    _json_dump(run_dir / "summary.json", aggregate)
    (run_dir / "report.md").write_text(
        render_report(manifest, aggregate),
        encoding="utf-8",
    )
    print(json.dumps(aggregate, ensure_ascii=False, indent=2), flush=True)
    print(f"Results: {run_dir}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
