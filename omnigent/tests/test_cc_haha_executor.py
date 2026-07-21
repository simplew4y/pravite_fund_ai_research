from __future__ import annotations

import json
from pathlib import Path

from omnigent.inner.cc_haha_executor import (
    CCHahaExecutor,
    _assistant_text,
    _final_response_text,
    _result_error_text,
    _usage_from_result,
    _with_loopback_no_proxy,
)
from omnigent.model_override import harness_supports_model_override
from omnigent.runtime.harnesses import _HARNESS_MODULES
from omnigent.spec._omnigent_compat import OMNIGENT_HARNESSES


def test_assistant_text_keeps_only_user_visible_text() -> None:
    payload = {
        "type": "assistant",
        "message": {
            "content": [
                {"type": "thinking", "thinking": "hidden"},
                {"type": "tool_use", "name": "Search", "input": {}},
                {"type": "text", "text": "final answer"},
            ]
        },
    }

    assert _assistant_text(payload) == ["final answer"]


def test_usage_from_result_normalizes_totals() -> None:
    usage = _usage_from_result(
        {
            "usage": {
                "input_tokens": 12,
                "output_tokens": 7,
                "cache_read_input_tokens": 3,
            }
        }
    )

    assert usage == {
        "input_tokens": 12,
        "output_tokens": 7,
        "cache_read_input_tokens": 3,
        "total_tokens": 19,
    }


def test_result_text_replaces_partial_or_intermediate_assistant_text() -> None:
    assert (
        _final_response_text("完整的最终回答", "让我先检索私")
        == "完整的最终回答"
    )


def test_last_assistant_text_is_fallback_when_result_has_no_text() -> None:
    assert _final_response_text(None, "最终回答") == "最终回答"


def test_success_result_is_not_an_error() -> None:
    assert _result_error_text({"subtype": "success", "is_error": False}) is None


def test_api_error_uses_result_detail() -> None:
    assert (
        _result_error_text(
            {
                "subtype": "success",
                "is_error": True,
                "result": "Authentication failed for model provider",
            }
        )
        == "Authentication failed for model provider"
    )


def test_cc_haha_is_registered_and_valid_for_agent_specs() -> None:
    assert "cc-haha" in OMNIGENT_HARNESSES
    assert _HARNESS_MODULES["cc-haha"] == "omnigent.inner.cc_haha_harness"
    assert harness_supports_model_override("cc-haha") is True


def test_build_argv_uses_session_then_resume_and_mcp(tmp_path) -> None:
    executor = CCHahaExecutor(binary_path="claude-haha", cwd=str(tmp_path))
    bridge_dir = tmp_path / "bridge"
    bridge_dir.mkdir()

    first = executor._build_argv(
        binary="claude-haha",
        prompt="hello",
        bridge_dir=bridge_dir,
        system_prompt="private fund rules",
        model_override="qwen3-max",
    )

    assert "--session-id" in first
    assert "--resume" not in first
    assert "--verbose" in first
    assert first[-1] == "hello"
    assert first[first.index("--model") + 1] == "qwen3-max"
    mcp = json.loads(first[first.index("--mcp-config") + 1])
    assert "omnigent" in mcp["mcpServers"]
    prompt_file = first[first.index("--append-system-prompt-file") + 1]
    assert "private fund rules" in Path(prompt_file).read_text(encoding="utf-8")

    executor._started = True
    resumed = executor._build_argv(
        binary="claude-haha",
        prompt="again",
        bridge_dir=bridge_dir,
        system_prompt="",
        model_override=None,
    )
    assert "--resume" in resumed
    assert "--session-id" not in resumed


def test_build_env_bounds_only_mcp_startup_wait(monkeypatch) -> None:
    monkeypatch.delenv("CC_HAHA_DESKTOP_AWAIT_MCP", raising=False)
    monkeypatch.delenv("CC_HAHA_DESKTOP_AWAIT_MCP_TIMEOUT_MS", raising=False)

    env = CCHahaExecutor()._build_env()

    assert env["CC_HAHA_DESKTOP_AWAIT_MCP"] == "1"
    assert env["CC_HAHA_DESKTOP_AWAIT_MCP_TIMEOUT_MS"] == "15000"
    assert env["API_TIMEOUT_MS"] == "3000000"


def test_build_env_preserves_explicit_mcp_startup_timeout(monkeypatch) -> None:
    monkeypatch.setenv("CC_HAHA_DESKTOP_AWAIT_MCP", "1")
    monkeypatch.setenv("CC_HAHA_DESKTOP_AWAIT_MCP_TIMEOUT_MS", "30000")

    env = CCHahaExecutor()._build_env()

    assert env["CC_HAHA_DESKTOP_AWAIT_MCP_TIMEOUT_MS"] == "30000"


def test_build_env_bypasses_system_proxy_for_local_services(monkeypatch) -> None:
    monkeypatch.setenv("NO_PROXY", "internal.example")
    monkeypatch.delenv("no_proxy", raising=False)

    env = CCHahaExecutor()._build_env()

    assert env["NO_PROXY"] == "internal.example,127.0.0.1,localhost,::1"
    assert env["no_proxy"] == env["NO_PROXY"]


def test_loopback_no_proxy_does_not_duplicate_entries() -> None:
    assert _with_loopback_no_proxy("localhost,127.0.0.1,::1") == (
        "localhost,127.0.0.1,::1"
    )
