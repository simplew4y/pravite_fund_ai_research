from __future__ import annotations

import json
from typing import Any

from omnigent.server import private_fund_valuation_worker as valuation_worker
from pdf_research_demo import llm as pdf_llm


class _Response:
    def __init__(self, content: str = "{}") -> None:
        self.content = content

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *_args: Any) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(
            {"choices": [{"message": {"content": self.content}}]}
        ).encode("utf-8")


def test_chat_request_sends_deepseek_thinking_toggle(monkeypatch: Any) -> None:
    captured: dict[str, Any] = {}

    def fake_urlopen(request: Any, timeout: float) -> _Response:
        captured["payload"] = json.loads(request.data.decode("utf-8"))
        captured["timeout"] = timeout
        return _Response()

    monkeypatch.setattr(pdf_llm.urllib.request, "urlopen", fake_urlopen)
    client = pdf_llm.OpenAICompatibleChatClient(
        pdf_llm.LLMConfig(
            model_name="private-fund-default",
            base_url="http://127.0.0.1:6767/internal/private-fund/llm/v1",
            api_key="test-token",
            timeout_seconds=90,
            thinking_type="disabled",
        )
    )

    assert client.chat_json([{"role": "user", "content": "Return JSON"}]) == "{}"
    assert captured["payload"]["thinking"] == {"type": "disabled"}
    assert captured["payload"]["response_format"] == {"type": "json_object"}
    assert captured["timeout"] == 90


def test_valuation_llm_timeout_defaults_to_ninety_seconds(monkeypatch: Any) -> None:
    monkeypatch.delenv("PRIVATE_FUND_VALUATION_LLM_TIMEOUT_SECONDS", raising=False)

    assert valuation_worker._valuation_llm_timeout_seconds() == 90


def test_chat_json_falls_back_to_prompt_json_when_json_mode_is_empty(
    monkeypatch: Any,
) -> None:
    payloads: list[dict[str, Any]] = []
    responses = iter([_Response(""), _Response('{"analysis_summary":"ok"}')])

    def fake_urlopen(request: Any, timeout: float) -> _Response:
        del timeout
        payloads.append(json.loads(request.data.decode("utf-8")))
        return next(responses)

    monkeypatch.setattr(pdf_llm.urllib.request, "urlopen", fake_urlopen)
    client = pdf_llm.OpenAICompatibleChatClient(
        pdf_llm.LLMConfig(
            model_name="private-fund-default",
            base_url="http://127.0.0.1:6767/internal/private-fund/llm/v1",
            api_key="test-token",
            thinking_type="disabled",
        )
    )

    raw = client.chat_json([{"role": "user", "content": "Return JSON"}])

    assert json.loads(raw) == {"analysis_summary": "ok"}
    assert payloads[0]["response_format"] == {"type": "json_object"}
    assert "response_format" not in payloads[1]
    assert payloads[1]["thinking"] == {"type": "disabled"}
