from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "run_pi_memory_longmemeval.py"
SPEC = importlib.util.spec_from_file_location("pi_memory_longmemeval", SCRIPT_PATH)
assert SPEC and SPEC.loader
benchmark = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = benchmark
SPEC.loader.exec_module(benchmark)


def test_select_stratified_questions_is_deterministic() -> None:
    dataset = [
        {
            "question_id": f"{question_type}-{index}",
            "question_type": question_type,
        }
        for question_type in ("a", "b")
        for index in range(5)
    ]

    first = benchmark.select_stratified_questions(dataset, ("a", "b"), 2, 7)
    second = benchmark.select_stratified_questions(dataset, ("a", "b"), 2, 7)

    assert [item["question_id"] for item in first] == [item["question_id"] for item in second]
    assert [item["question_type"] for item in first] == ["a", "a", "b", "b"]


def test_lexical_answer_match_normalizes_punctuation() -> None:
    assert benchmark.lexical_answer_match(
        "Business Administration",
        "I graduated with a Business-Administration degree.",
    )
    assert not benchmark.lexical_answer_match(
        "Business Administration",
        "I don't know.",
    )


def test_session_identity_normalizes_dataset_and_qmd_separators() -> None:
    answer_session_id = "answer_sharegpt_2kpncbX_13"
    qmd_path = "qmd://pi-memory/sessions/0040-answer-sharegpt-2kpncbX-13.md"

    assert benchmark._normalize_session_identity(
        answer_session_id
    ) in benchmark._normalize_session_identity(qmd_path)


def test_render_session_markdown_preserves_identity_and_content() -> None:
    rendered = benchmark.render_session_markdown(
        "question-1",
        "answer_session_7",
        "2024/01/02 10:00",
        [
            {"role": "user", "content": "My favorite color is teal."},
            {
                "role": "assistant",
                "content": [{"type": "text", "text": "I will remember that."}],
            },
        ],
    )

    assert rendered.startswith("# 📝 LongMemEval Session")
    assert "answer_session_7" in rendered
    assert "My favorite color is teal." in rendered
    assert "I will remember that." in rendered


def test_parse_agent_messages_extracts_usage_and_search_results() -> None:
    messages = [
        {
            "role": "assistant",
            "content": [
                {
                    "type": "toolCall",
                    "name": "memory_search",
                    "arguments": {"query": "favorite color"},
                }
            ],
            "usage": {"input": 100, "output": 20},
        },
        {
            "role": "toolResult",
            "toolName": "memory_search",
            "content": [
                {
                    "type": "text",
                    "text": "qmd://pi-memory/sessions/answer_session_7.md",
                }
            ],
            "details": {"mode": "keyword"},
        },
        {
            "role": "assistant",
            "content": [{"type": "text", "text": "Teal."}],
            "usage": {"input": 140, "output": 5},
        },
    ]

    assert benchmark._assistant_answer(messages) == "Teal."
    assert benchmark._usage_from_messages(messages) == (240, 25, 265)
    calls, result_text = benchmark._search_results_from_messages(messages)
    assert calls == 1
    assert "answer_session_7" in result_text


def test_percentile_interpolates_values() -> None:
    assert benchmark.percentile([1, 2, 3, 4], 0.5) == 2.5
    assert benchmark.percentile([], 0.95) is None


def test_aggregate_results_reports_retrieval_and_overhead() -> None:
    common = {
        "question_type": "single-session-user",
        "question": "What is my favorite color?",
        "reference_answer": "teal",
        "judge_raw": "Yes",
        "lexical_match": True,
        "answer_session_ids": ["answer_session_7"],
        "search_calls": 1,
        "returncode": 0,
        "timed_out": False,
        "input_tokens": 90,
        "output_tokens": 10,
        "history_sessions": 4,
        "history_chars": 1000,
        "stdout_path": "stdout.jsonl",
        "stderr_path": "stderr.txt",
    }
    results = [
        benchmark.BenchmarkResult(
            **common,
            question_id="answerable",
            condition="memory",
            hypothesis="Teal.",
            correct=True,
            retrieval_hit=True,
            duration_ms=1500,
            total_tokens=100,
        ),
        benchmark.BenchmarkResult(
            **common,
            question_id="answerable",
            condition="baseline",
            hypothesis="I don't know.",
            correct=False,
            retrieval_hit=None,
            duration_ms=1000,
            total_tokens=50,
        ),
    ]

    aggregate = benchmark.aggregate_results(
        results,
        [{"index_duration_ms": 25}],
    )

    assert aggregate["accuracy_lift"] == 1
    assert aggregate["retrieval"]["answer_session_hit_rate"] == 1
    assert aggregate["retrieval"]["correct_given_hit"] == 1
    assert aggregate["overhead"]["mean_latency_ms_delta"] == 500
    assert aggregate["overhead"]["mean_tokens_delta"] == 50
    assert aggregate["history"]["sessions_total"] == 4
    assert aggregate["indexing"]["qmd_update_duration_ms_total"] == 25
    manifest = {
        "run_id": "test",
        "question_count": 1,
        "reader_model": "reader",
        "judge_model": "judge",
        "search_mode": "keyword",
        "search_limit": 10,
        "max_searches": 3,
        "started_at": "2026-07-24T00:00:00+08:00",
        "completed_at": "2026-07-24T00:01:00+08:00",
    }
    report = benchmark.render_report(manifest, aggregate)
    assert "abstention accuracy: n/a versus n/a" in report
    assert "correct given a miss: n/a" in report


def test_prepare_agent_dir_references_api_key_environment_variable(
    tmp_path: Path,
) -> None:
    agent_dir = tmp_path / "agent"
    benchmark.prepare_agent_dir(
        agent_dir,
        base_url="http://127.0.0.1:4000/v1",
        api_key_env="TEST_BENCHMARK_API_KEY",
        reader_model="reader",
    )

    models = benchmark.json.loads((agent_dir / "models.json").read_text(encoding="utf-8"))
    provider = models["providers"][benchmark.PROVIDER_ID]

    assert provider["apiKey"] == "${TEST_BENCHMARK_API_KEY}"
