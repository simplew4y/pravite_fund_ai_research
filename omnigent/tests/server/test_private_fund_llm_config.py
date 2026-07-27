import stat
from pathlib import Path

import httpx
import pytest
import yaml
from fastapi import FastAPI

from omnigent.server import private_fund_llm_config as llm
from omnigent.server.routes.private_fund_llm_config import (
    create_private_fund_llm_config_router,
)


def test_legacy_config_is_inferred_and_masked_without_exposing_key() -> None:
    raw = {
        "llm_model_name": "qwen-plus",
        "llm_base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "llm_api_key": "sk-bab1234567890d2",
    }

    public = llm.public_config(raw)

    assert public == {
        "preset": "dashscope",
        "provider": "dashscope",
        "baseUrl": raw["llm_base_url"],
        "model": "qwen-plus",
        "hasApiKey": True,
        "maskedApiKey": "sk-bab*****************d2",
        "configured": True,
    }
    assert raw["llm_api_key"] not in str(public)


def test_validate_candidate_keeps_existing_key_when_input_is_blank() -> None:
    current = llm.RuntimeLlmConfig(
        preset="deepseek",
        provider="deepseek",
        base_url="https://api.deepseek.com/v1",
        model="deepseek-chat",
        api_key="sk-existing",
    )

    candidate = llm.validate_candidate(
        {
            "preset": "openai",
            "baseUrl": "https://api.openai.com/v1",
            "model": "gpt-test",
            "apiKey": "",
        },
        current,
    )

    assert candidate.api_key == "sk-existing"
    assert candidate.provider == "openai"


def test_save_is_atomic_private_and_preserves_unrelated_fields(tmp_path: Path) -> None:
    path = tmp_path / "production.yaml"
    path.write_text("unrelated: keep\nllm_api_key: old\n", encoding="utf-8")
    config = llm.RuntimeLlmConfig(
        preset="deepseek",
        provider="deepseek",
        base_url="https://api.deepseek.com/v1",
        model="deepseek-chat",
        api_key="sk-new",
    )

    llm.save_runtime_config(config, path)
    saved = yaml.safe_load(path.read_text(encoding="utf-8"))

    assert saved["unrelated"] == "keep"
    assert saved["llm_api_key"] == "sk-new"
    assert saved["llm_provider_preset"] == "deepseek"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_generated_config_has_stable_and_revision_aliases(tmp_path: Path) -> None:
    config = llm.RuntimeLlmConfig(
        preset="custom",
        provider="custom_openai",
        base_url="https://models.example.test/v1",
        model="research-model",
        api_key="sk-secret",
    )
    rendered, revision = llm.render_litellm_config(config)
    parsed = yaml.safe_load(rendered)
    aliases = {entry["model_name"] for entry in parsed["model_list"]}

    assert llm.LOCAL_MODEL_ALIAS in aliases
    assert revision in aliases
    assert "claude-sonnet-4-6" in aliases
    assert "claude-haiku-4-5-20251001" in aliases
    assert all(
        entry["litellm_params"]["api_base"] == config.base_url for entry in parsed["model_list"]
    )
    assert all(
        entry["litellm_params"]["model"] == "custom_openai/research-model"
        for entry in parsed["model_list"]
    )


def test_unconfigured_runtime_still_generates_placeholder_proxy_config() -> None:
    rendered, _ = llm.render_litellm_config(
        llm.RuntimeLlmConfig(
            preset="custom",
            provider="custom_openai",
            base_url="",
            model="",
            api_key="",
        )
    )
    parsed = yaml.safe_load(rendered)
    stable = next(
        entry for entry in parsed["model_list"] if entry["model_name"] == llm.LOCAL_MODEL_ALIAS
    )

    assert stable["litellm_params"]["api_base"] == "http://127.0.0.1:9/v1"
    assert stable["litellm_params"]["model"] == "openai/not-configured"


def test_restore_file_reinstates_previous_contents_and_mode(tmp_path: Path) -> None:
    path = tmp_path / "config.yaml"
    path.write_text("before\n", encoding="utf-8")
    path.chmod(0o640)
    snapshot = llm.snapshot_file(path)
    path.write_text("after\n", encoding="utf-8")

    llm.restore_file(path, snapshot)

    assert path.read_text(encoding="utf-8") == "before\n"
    assert stat.S_IMODE(path.stat().st_mode) == 0o640


@pytest.mark.parametrize(
    ("input_url", "expected"),
    [
        ("https://example.test/v1", "https://example.test/v1/chat/completions"),
        ("https://example.test/v1/models", "https://example.test/v1/chat/completions"),
        ("https://example.test/v1/chat/completions", "https://example.test/v1/chat/completions"),
    ],
)
def test_openai_url_normalization(input_url: str, expected: str) -> None:
    assert llm._openai_chat_url(input_url) == expected


async def test_apply_check_uses_the_anthropic_protocol_used_by_cc_haha(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request: dict[str, object] = {}

    class Response:
        is_success = True
        status_code = 200
        text = ""

        @staticmethod
        def json() -> dict[str, object]:
            return {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "text", "text": "OK"}],
            }

    class Client:
        def __init__(self, **_kwargs: object) -> None:
            pass

        async def __aenter__(self) -> "Client":
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def post(self, url: str, **kwargs: object) -> Response:
            request.update({"url": url, **kwargs})
            return Response()

    monkeypatch.setattr(llm.httpx, "AsyncClient", Client)

    result = await llm.wait_for_litellm_revision(
        "private-fund-config-test",
        base_url="http://gateway",
    )

    assert result == {"ok": True}
    assert request["url"] == "http://gateway/v1/messages?beta=true"
    assert request["json"] == {
        "model": "private-fund-config-test",
        "max_tokens": 32,
        "messages": [{"role": "user", "content": "Reply with OK only."}],
    }


async def test_apply_failure_restores_both_configuration_files(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "production.yaml"
    generated_path = tmp_path / "litellm.yaml"
    original_config = (
        "llm_model_name: old-model\n"
        "llm_base_url: https://api.deepseek.com/v1\n"
        "llm_api_key: sk-old\n"
    )
    original_generated = "model_list: []\n"
    config_path.write_text(original_config, encoding="utf-8")
    generated_path.write_text(original_generated, encoding="utf-8")
    monkeypatch.setenv("FINSAGENT_CONFIG", str(config_path))
    monkeypatch.setenv("LITELLM_CONFIG", str(generated_path))

    async def upstream_ok(_config: llm.RuntimeLlmConfig) -> dict[str, bool]:
        return {"ok": True}

    apply_attempts = 0

    async def apply_fails(
        _alias: str,
        *,
        base_url: str | None = None,
        timeout_seconds: float = 45.0,
    ) -> dict[str, object]:
        del base_url, timeout_seconds
        nonlocal apply_attempts
        apply_attempts += 1
        if apply_attempts == 1:
            return {"ok": False, "error": "apply", "detail": "reload rejected"}
        return {"ok": True}

    monkeypatch.setattr(llm, "test_upstream_config", upstream_ok)
    monkeypatch.setattr(llm, "wait_for_litellm_revision", apply_fails)
    app = FastAPI()
    app.include_router(create_private_fund_llm_config_router(), prefix="/v1")

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.put(
            "/v1/private-fund/llm-config",
            json={
                "preset": "openai",
                "baseUrl": "https://api.openai.com/v1",
                "model": "new-model",
                "apiKey": "sk-new",
            },
        )

    assert response.status_code == 200
    assert response.json()["error"] == "apply"
    assert config_path.read_text(encoding="utf-8") == original_config
    assert generated_path.read_text(encoding="utf-8") == original_generated
    assert apply_attempts == 2


async def test_save_is_rejected_while_a_response_is_running(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    upstream = pytest.fail
    monkeypatch.setattr(llm, "test_upstream_config", upstream)
    app = FastAPI()
    app.include_router(
        create_private_fund_llm_config_router(has_running_sessions=lambda: True),
        prefix="/v1",
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.put(
            "/v1/private-fund/llm-config",
            json={
                "preset": "openai",
                "baseUrl": "https://api.openai.com/v1",
                "model": "new-model",
                "apiKey": "sk-new",
            },
        )

    assert response.status_code == 200
    assert response.json()["error"] == "busy"
