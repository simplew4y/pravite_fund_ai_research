from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import urllib.request
from pathlib import Path
from types import ModuleType
from typing import Any


def _load_runner_module() -> ModuleType:
    path = Path(__file__).parents[1] / "scripts" / "run_pi_global_agent_tests.py"
    spec = importlib.util.spec_from_file_location("pi_global_agent_batch_runner", path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _post_json(url: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return response.status, json.loads(response.read())


def test_text_and_percentile_helpers() -> None:
    runner = _load_runner_module()

    assert runner._text_from_content([{"type": "text", "text": "a"}, {"text": "b"}]) == "ab"
    assert runner._text_from_content("plain") == "plain"
    assert runner._percentile([10.0, 20.0, 30.0], 0.50) == 20.0
    assert runner._percentile([], 0.95) is None


def test_orchestration_surface_excludes_session_share() -> None:
    runner = _load_runner_module()
    names = {tool["name"] for tool in runner.ORCHESTRATION_TOOLS}

    assert "sys_agent_list" in names
    assert "sys_session_create" in names
    assert "sys_call_async" in names
    assert "sys_timer_set" in names
    assert "sys_os_read" in names
    assert "private_fund_dataset_search" in names
    assert "sys_session_share" not in names


def test_controlled_relay_denies_shell_and_serves_evidence(tmp_path: Path) -> None:
    runner = _load_runner_module()
    relay_log = tmp_path / "relay.jsonl"

    with runner.ControlledRelay(relay_log) as relay:
        status, denied = _post_json(
            f"{relay.url}/v1/sessions/test/mcp",
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "sys_os_shell",
                    "arguments": {"command": "printf forbidden"},
                },
            },
        )
        assert status == 200
        assert denied["error"]["code"] == -32000
        assert relay.state.executed("sys_os_shell") == 0

        status, evidence = _post_json(
            f"{relay.url}/v1/sessions/test/mcp",
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "private_fund_dataset_search",
                    "arguments": {"dataset_id": "fund-alpha", "query": "规模"},
                },
            },
        )
        assert status == 200
        serialized = json.dumps(evidence, ensure_ascii=False)
        assert "chunk:verified-alpha-001" in serialized
        assert "12.5" in serialized
        assert relay.state.executed("private_fund_dataset_search") == 1

        status, child = _post_json(
            f"{relay.url}/v1/sessions/test/mcp",
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "sys_session_create",
                    "arguments": {
                        "agent_id": "worker",
                        "title": "parallel-child-4",
                    },
                },
            },
        )
        assert status == 200
        assert "child-e2e-4" in json.dumps(child)

    assert relay_log.is_file()
    assert len(relay_log.read_text(encoding="utf-8").splitlines()) == 3


def test_prepare_uses_isolated_pinned_package_and_redacted_manifest(
    tmp_path: Path,
) -> None:
    runner = _load_runner_module()
    args = argparse.Namespace(
        suite="smoke",
        pi_path="/tmp/pi",
        qmd_path="",
        omnigent_extension=str(runner.DEFAULT_OMNIGENT_EXTENSION),
        base_url="http://127.0.0.1:4000/v1",
        model="qwen3-max",
        concurrency=2,
        timeout=30.0,
        duration_seconds=60,
        soak_interval=0.0,
        output_root=str(tmp_path),
        run_id="unit-test",
    )
    batch = runner.PiGlobalAgentTestRunner(args)
    batch.prepare()

    settings = json.loads((batch.agent_dir / "settings.json").read_text())
    models = json.loads((batch.agent_dir / "models.json").read_text())
    manifest = json.loads((batch.run_dir / "manifest.json").read_text())
    npm_manifest = json.loads(
        (batch.agent_dir / "npm" / "package.json").read_text()
    )

    assert settings["packages"] == ["npm:pi-memory@0.4.0"]
    assert npm_manifest["dependencies"]["pi-memory"] == "0.4.0"
    assert (
        npm_manifest["dependencies"]["@mariozechner/pi-coding-agent"]
        == "file:shims/pi-coding-agent"
    )
    assert npm_manifest["overrides"]["protobufjs"] == "7.6.5"
    assert (batch.agent_dir / "npm" / ".npmrc").read_text() == "save-exact=true\n"
    assert models["providers"]["omnigent-e2e"]["baseUrl"] == "http://127.0.0.1:4000/v1"
    assert manifest["expected_pi_version"] == "0.81.1"
    assert "api_key" not in json.dumps(manifest).lower()
    assert not (batch.agent_dir / "npm").is_symlink()
