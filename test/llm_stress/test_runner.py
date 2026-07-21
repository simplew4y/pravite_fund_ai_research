from __future__ import annotations

from llm_stress.runner import (
    build_summary,
    extract_json_object,
    load_jsonl,
    percentile,
    score_content,
    score_tool_trace,
)


def test_percentile_interpolates_and_handles_empty() -> None:
    assert percentile([], 0.95) is None
    assert percentile([10], 0.95) == 10
    assert percentile([1, 2, 3, 4], 0.5) == 2.5


def test_extract_json_object_accepts_fence_but_rejects_prose() -> None:
    assert extract_json_object('```json\n{"ok": true}\n```') == {"ok": True}
    assert extract_json_object('说明：{"ok": true}') is None


def test_score_content_checks_json_contract_and_nonce() -> None:
    case = {
        "expect": {
            "json": True,
            "exact_json_keys": ["company", "rating", "request_nonce"],
            "json_values": {"company": "星河", "rating": "观察"},
            "no_reasoning": True,
        }
    }
    result = score_content(
        '{"company":"星河","rating":"观察","request_nonce":"abc"}',
        case,
        "abc",
    )
    assert result["passed"] is True


def test_score_content_checks_structured_citation_claim_contract() -> None:
    case = {
        "expect": {
            "json": True,
            "exact_json_keys": ["claims", "request_nonce"],
            "claim_contract": {
                "required_evidence_ids": ["fact:alpha"],
                "allowed_evidence_ids": ["fact:alpha"],
            },
        }
    }
    result = score_content(
        """{
          "claims": [{
            "claim_id": "claim-1",
            "text": "收入同比增长17.4%。",
            "status": "supported",
            "evidence_ids": ["fact:alpha"]
          }],
          "request_nonce": "abc"
        }""",
        case,
        "abc",
    )

    assert result["passed"] is True


def test_score_content_rejects_invented_structured_claim_evidence() -> None:
    case = {
        "expect": {
            "json": True,
            "claim_contract": {
                "required_evidence_ids": ["fact:alpha"],
                "allowed_evidence_ids": ["fact:alpha"],
            },
        }
    }
    result = score_content(
        """{
          "claims": [{
            "claim_id": "claim-1",
            "text": "收入同比增长99%。 [fact:invented]",
            "status": "supported",
            "evidence_ids": ["fact:invented"]
          }],
          "request_nonce": "abc"
        }""",
        case,
        "abc",
    )

    assert result["passed"] is False
    assert "claim_required_evidence" in result["failed_checks"]
    assert "claim_evidence_allowlist" in result["failed_checks"]
    assert "claim_text_without_citation_syntax" in result["failed_checks"]


def test_score_content_detects_foreign_nonce_and_bad_citation() -> None:
    case = {
        "expect": {
            "required_evidence_ids": ["fact:alpha"],
            "allowed_evidence_ids": ["fact:alpha"],
            "min_citations": 1,
        }
    }
    result = score_content(
        "17.4% [fact:beta] [request:mine] [request:other]", case, "mine"
    )
    assert result["passed"] is False
    assert "no_foreign_nonce" in result["failed_checks"]
    assert "required_citations" in result["failed_checks"]
    assert "citation_allowlist" in result["failed_checks"]


def test_score_tool_trace_checks_order_and_partial_arguments() -> None:
    case = {
        "expected_tools": ["search", "detail"],
        "expected_args": [{"dataset_id": "d1"}, {"evidence_id": "chunk:1"}],
    }
    trace = {
        "calls": [
            {"name": "search", "arguments": {"dataset_id": "d1", "top_k": 3}},
            {"name": "detail", "arguments": {"evidence_id": "chunk:1"}},
        ]
    }
    assert score_tool_trace(trace, case)["passed"] is True


def test_score_tool_trace_aligns_arguments_after_allowed_extra_call() -> None:
    case = {
        "expected_tools": ["search", "detail"],
        "expected_args": [{"dataset_id": "d1"}, {"evidence_id": "chunk:1"}],
        "tool_sequence_mode": "ordered",
        "allowed_extra_tools": ["status"],
    }
    trace = {
        "calls": [
            {"name": "status", "arguments": {"dataset_id": "d1"}},
            {"name": "search", "arguments": {"dataset_id": "d1", "top_k": 3}},
            {"name": "detail", "arguments": {"evidence_id": "chunk:1"}},
        ]
    }

    result = score_tool_trace(trace, case)

    assert result["passed"] is True
    assert result["matched_call_indexes"] == [1, 2]


def test_score_tool_trace_rejects_unexpected_extra_call() -> None:
    case = {
        "expected_tools": ["search", "detail"],
        "expected_args": [{"dataset_id": "d1"}, {"evidence_id": "chunk:1"}],
        "tool_sequence_mode": "ordered",
        "allowed_extra_tools": ["status"],
    }
    trace = {
        "calls": [
            {"name": "search", "arguments": {"dataset_id": "d1"}},
            {"name": "unrelated", "arguments": {}},
            {"name": "detail", "arguments": {"evidence_id": "chunk:1"}},
        ]
    }

    result = score_tool_trace(trace, case)

    assert result["passed"] is False
    assert result["failed_checks"] == ["tool_sequence"]


def test_build_summary_marks_tool_parser_as_blocked() -> None:
    result = {
        "target": "proxy",
        "concurrency": 1,
        "category": "instruction_following",
        "status": "success",
        "total_latency_ms": 100,
        "started_epoch": 1.0,
        "ended_epoch": 1.1,
        "usage": {"total_tokens": 10},
        "evaluation": {
            "passed": True,
            "score": 1.0,
            "checks": [
                {"name": "no_foreign_nonce", "passed": True},
                {"name": "no_reasoning_leak", "passed": True},
            ],
        },
    }
    summary = build_summary(
        [result],
        [],
        [{"tool_capability": {"status": "BLOCKED"}}],
        1.0,
        2.0,
    )
    tool_gate = next(gate for gate in summary["gates"] if gate["name"] == "tool_call_accuracy")
    assert tool_gate["status"] == "BLOCKED"


def test_shipped_jsonl_cases_are_valid(tmp_path) -> None:
    path = tmp_path / "cases.jsonl"
    path.write_text('{"id":"one"}\n{"id":"two"}\n', encoding="utf-8")
    assert [row["id"] for row in load_jsonl(path)] == ["one", "two"]
