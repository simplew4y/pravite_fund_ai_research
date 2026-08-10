from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from omnigent.db.utils import get_or_create_engine
from omnigent.server.accounts_store import SqlAlchemyAccountStore
from omnigent.server.passwords import hash_password
from omnigent.server.private_fund_tenant import (
    bind_tenant_job_payload,
    build_tenant_context,
    current_tenant,
    tenant_job_payload,
)
from omnigent.server.user_llm_config_store import UserLlmConfig, UserLlmConfigStore
from omnigent.server.user_llm_gateway import (
    _install_anthropic_usage_only_chunk_compatibility,
    _provider_error_status,
    create_user_llm_gateway_router,
    issue_user_llm_token,
)
from omnigent.server.user_model_routing_store import UserModelRoutingStore


@pytest.fixture
def account_db(tmp_path: Path) -> tuple[str, SqlAlchemyAccountStore]:
    db_url = f"sqlite:///{tmp_path / 'accounts.db'}"
    get_or_create_engine(db_url)
    store = SqlAlchemyAccountStore(db_url)
    store.create_user_with_password("alice@example.com", hash_password("password123"))
    store.create_user_with_password("bob@example.com", hash_password("password123"))
    return db_url, store


def test_namespaces_and_background_context_are_isolated(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    account_db: tuple[str, SqlAlchemyAccountStore],
) -> None:
    _db_url, store = account_db
    monkeypatch.setattr(
        "omnigent.server.private_fund_tenant.project_root",
        lambda: tmp_path,
    )
    alice = build_tenant_context("alice@example.com", store)
    bob = build_tenant_context("bob@example.com", store)

    assert alice.data_namespace != bob.data_namespace
    assert alice.dataset_root != bob.dataset_root
    assert alice.dataset_root.is_relative_to(tmp_path / "output" / "users")
    assert bob.knowledge_base_root.is_relative_to(tmp_path / "output" / "users")

    payload = {
        "_tenant": {
            "user_id": alice.user_id,
            "data_namespace": alice.data_namespace,
        }
    }
    assert current_tenant() is None
    with bind_tenant_job_payload(payload):
        assert current_tenant() == alice
        assert tenant_job_payload() == payload["_tenant"]
    assert current_tenant() is None


def test_tenant_root_can_be_redirected_to_desktop_user_data(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    account_db: tuple[str, SqlAlchemyAccountStore],
) -> None:
    _db_url, store = account_db
    desktop_root = tmp_path / "app-data" / "users"
    monkeypatch.setenv("PRIVATE_FUND_USER_DATA_ROOT", str(desktop_root))

    tenant = build_tenant_context("alice@example.com", store)

    assert tenant.user_root.parent == desktop_root.resolve()
    assert tenant.dataset_root == tenant.user_root / "private_fund_datasets"


def test_user_model_keys_are_encrypted_and_gateway_forces_saved_model(
    monkeypatch: pytest.MonkeyPatch,
    account_db: tuple[str, SqlAlchemyAccountStore],
) -> None:
    db_url, _store = account_db
    master_key = bytes(range(32))
    monkeypatch.setenv("OMNIGENT_USER_SECRETS_KEY", master_key.hex())
    configs = UserLlmConfigStore(db_url, master_key=master_key)
    configs.save(
        "alice@example.com",
        UserLlmConfig(
            preset="custom",
            provider="openai",
            base_url="https://models.example.test/v1",
            model="research-model",
            api_key="sk-alice-secret-value",
        ),
    )

    sqlite_path = Path(db_url.removeprefix("sqlite:///"))
    with sqlite3.connect(sqlite_path) as conn:
        ciphertext = conn.execute(
            "SELECT api_key_ciphertext FROM user_llm_configs WHERE user_id = ?",
            ("alice@example.com",),
        ).fetchone()[0]
    assert "sk-alice-secret-value" not in ciphertext
    assert configs.get("alice@example.com").api_key == "sk-alice-secret-value"

    captured: dict[str, object] = {}

    async def fake_completion(**kwargs: object) -> dict[str, object]:
        captured.update(kwargs)
        return {
            "id": "response-1",
            "choices": [{"message": {"role": "assistant", "content": "ok"}}],
        }

    monkeypatch.setattr("litellm.acompletion", fake_completion)
    app = FastAPI()
    app.include_router(
        create_user_llm_gateway_router(db_url),
        prefix="/internal/private-fund/llm",
    )
    token = issue_user_llm_token("alice@example.com", "conv-1")
    with TestClient(app) as client:
        response = client.post(
            "/internal/private-fund/llm/v1/chat/completions",
            headers={"authorization": f"Bearer {token}"},
            json={
                "model": "attacker-controlled-model",
                "messages": [{"role": "user", "content": "hello"}],
                "thinking": {"type": "disabled"},
            },
        )

    assert response.status_code == 200
    assert captured["model"] == "openai/research-model"
    assert captured["api_base"] == "https://models.example.test/v1"
    assert captured["api_key"] == "sk-alice-secret-value"


def test_platform_model_token_is_encrypted_and_gateway_never_falls_back_to_byok(
    monkeypatch: pytest.MonkeyPatch,
    account_db: tuple[str, SqlAlchemyAccountStore],
) -> None:
    db_url, _store = account_db
    master_key = bytes(range(32))
    monkeypatch.setenv("OMNIGENT_USER_SECRETS_KEY", master_key.hex())
    configs = UserLlmConfigStore(db_url, master_key=master_key)
    configs.save(
        "alice@example.com",
        UserLlmConfig(
            preset="custom",
            provider="openai",
            base_url="https://byok.example.test/v1",
            model="byok-model",
            api_key="sk-byok-secret",
        ),
    )
    routing = UserModelRoutingStore(db_url, master_key=master_key)
    routing.save_platform_access(
        "alice@example.com",
        token="pfm_platform-secret-value",
        expires_at=4_102_444_800,
        gateway_base_url="https://cloud.example.test/gateway/v1",
        byok_configured=True,
    )
    routing.set_source("alice@example.com", "platform", byok_configured=True)

    sqlite_path = Path(db_url.removeprefix("sqlite:///"))
    with sqlite3.connect(sqlite_path) as conn:
        ciphertext = conn.execute(
            "SELECT platform_token_ciphertext FROM user_model_routing WHERE user_id = ?",
            ("alice@example.com",),
        ).fetchone()[0]
    assert "pfm_platform-secret-value" not in ciphertext

    captured: dict[str, object] = {}

    async def fake_completion(**kwargs: object) -> dict[str, object]:
        captured.update(kwargs)
        return {
            "id": "response-platform",
            "choices": [{"message": {"role": "assistant", "content": "ok"}}],
        }

    monkeypatch.setattr("litellm.acompletion", fake_completion)
    app = FastAPI()
    app.include_router(create_user_llm_gateway_router(db_url), prefix="/llm")
    token = issue_user_llm_token("alice@example.com", "conv-platform")
    with TestClient(app) as client:
        response = client.post(
            "/llm/v1/chat/completions",
            headers={"authorization": f"Bearer {token}"},
            json={
                "model": "ignored",
                "messages": [{"role": "user", "content": "hello"}],
                "max_tokens": 32_000,
            },
        )

    assert response.status_code == 200
    assert captured["model"] == "custom_openai/private-fund-default"
    assert captured["api_base"] == "https://cloud.example.test/gateway/v1"
    assert captured["api_key"] == "pfm_platform-secret-value"
    assert captured["max_tokens"] == 32000

    routing.clear_platform_access("alice@example.com")
    captured.clear()
    with TestClient(app) as client:
        expired = client.post(
            "/llm/v1/chat/completions",
            headers={"authorization": f"Bearer {token}"},
            json={"model": "ignored", "messages": [{"role": "user", "content": "again"}]},
        )
    assert expired.status_code == 409
    assert captured == {}


def test_platform_insufficient_balance_mentions_active_requests() -> None:
    error = RuntimeError("insufficient_available_balance")
    error.status_code = 402  # type: ignore[attr-defined]

    status, detail = _provider_error_status(error, "platform")

    assert status == 402
    assert detail == "当前可用额度不足，请等待正在进行的模型请求完成或补充余额。"


async def test_gateway_preserves_openai_usage_only_stream_chunk() -> None:
    """DashScope's final empty-choices usage chunk survives adaptation."""
    from litellm.llms.anthropic.experimental_pass_through.adapters.streaming_iterator import (
        AnthropicStreamWrapper,
    )
    from litellm.types.utils import Delta, ModelResponseStream, StreamingChoices

    async def completion_stream():
        yield ModelResponseStream(
            model="qwen3-max",
            choices=[StreamingChoices(delta=Delta(content="ok"))],
        )
        yield ModelResponseStream(
            model="qwen3-max",
            choices=[StreamingChoices(finish_reason="stop")],
        )
        yield ModelResponseStream(
            model="qwen3-max",
            choices=[],
            usage={
                "prompt_tokens": 12,
                "completion_tokens": 3,
                "total_tokens": 15,
            },
        )

    _install_anthropic_usage_only_chunk_compatibility()
    stream = AnthropicStreamWrapper(completion_stream(), model="qwen3-max")
    events = [event async for event in stream]

    usage_events = [
        event for event in events if event.get("type") == "message_delta" and event.get("usage")
    ]
    assert usage_events
    assert usage_events[-1]["usage"]["input_tokens"] == 12
    assert usage_events[-1]["usage"]["output_tokens"] == 3
    assert events[-1]["type"] == "message_stop"
