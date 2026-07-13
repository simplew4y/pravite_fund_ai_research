"""Runner-local dispatch tests for structured private-fund dataset tools."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx

from omnigent.runner.tool_dispatch import (
    _ALL_LOCAL_TOOLS,
    _NATIVE_RELAY_BUILTIN_TOOLS,
    _execute_private_fund_dataset_tool,
    execute_tool,
    should_dispatch_locally,
)
from omnigent.tools.base import Tool, ToolContext


class _CaptureStatusTool(Tool):
    """Tiny status-tool stand-in that records its runtime context."""

    seen_context: ToolContext | None = None

    @classmethod
    def name(cls) -> str:
        return "private_fund_dataset_status"

    @classmethod
    def description(cls) -> str:
        return "capture runtime context"

    def get_schema(self) -> dict[str, object]:
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": {"type": "object", "properties": {}},
            },
        }

    def invoke(self, arguments: str, ctx: ToolContext) -> str:
        type(self).seen_context = ctx
        return json.dumps({"arguments": json.loads(arguments)})


def test_private_fund_tools_are_runner_local_and_native_relayable() -> None:
    """SDK and declared native agents share the structured research surface."""
    for name in (
        "private_fund_dataset_status",
        "private_fund_dataset_search",
        "private_fund_source_detail",
        "private_fund_dataset_memo",
        "private_fund_equity_report_generate",
        "private_fund_equity_report_status",
        "private_fund_equity_report_get",
        "private_fund_research_context",
        "private_fund_research_node_save",
    ):
        assert name in _ALL_LOCAL_TOOLS
        assert should_dispatch_locally(name) is True
        assert name in _NATIVE_RELAY_BUILTIN_TOOLS


def test_private_fund_dispatch_uses_selected_session_workspace(tmp_path: Path) -> None:
    """Dataset tools receive the project workspace selected by the session."""
    _CaptureStatusTool.seen_context = None
    spec = SimpleNamespace(
        name="qwen-research",
        tools=SimpleNamespace(builtins=[SimpleNamespace(name="private_fund_dataset_status")]),
    )
    with patch(
        "omnigent.tools.builtins.private_fund_dataset.build_private_fund_dataset_tools",
        return_value=[_CaptureStatusTool()],
    ):
        output = asyncio.run(
            _execute_private_fund_dataset_tool(
                "private_fund_dataset_status",
                '{"dataset_id":"fund-a"}',
                conversation_id="conv_qwen",
                task_id=None,
                agent_id="ag_qwen",
                agent_spec=spec,
                runner_workspace=tmp_path,
            )
        )
    assert json.loads(output) == {"arguments": {"dataset_id": "fund-a"}}
    assert _CaptureStatusTool.seen_context == ToolContext(
        task_id="conv_qwen",
        agent_id="ag_qwen",
        workspace=tmp_path,
        conversation_id="conv_qwen",
    )


def test_private_fund_dispatch_binds_workspace_and_dataset_from_session(tmp_path: Path) -> None:
    """Server-stored project identity overrides global active-dataset state."""
    _CaptureStatusTool.seen_context = None
    bound_workspace = tmp_path / "fund-b"
    spec = SimpleNamespace(
        name="qwen-research",
        tools=SimpleNamespace(builtins=[SimpleNamespace(name="private_fund_dataset_status")]),
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/sessions/conv_qwen"
        return httpx.Response(
            200,
            json={
                "workspace": str(bound_workspace),
                "labels": {"private_fund.dataset_id": "fund-b"},
            },
        )

    async def run() -> str:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="http://test"
        ) as client:
            with patch(
                "omnigent.tools.builtins.private_fund_dataset.build_private_fund_dataset_tools",
                return_value=[_CaptureStatusTool()],
            ):
                return await execute_tool(
                    tool_name="private_fund_dataset_status",
                    arguments='{"dataset_id":"wrong-project"}',
                    conversation_id="conv_qwen",
                    task_id=None,
                    agent_id="ag_qwen",
                    agent_spec=spec,
                    runner_workspace=tmp_path / "global-runner",
                    server_client=client,
                )

    output = asyncio.run(run())
    assert json.loads(output) == {"arguments": {"dataset_id": "fund-b"}}
    assert _CaptureStatusTool.seen_context is not None
    assert _CaptureStatusTool.seen_context.workspace == bound_workspace.resolve()


def test_private_fund_dispatch_rejects_an_undeclared_tool(tmp_path: Path) -> None:
    """A forged action-required event cannot invoke the memo writer."""
    output = asyncio.run(
        _execute_private_fund_dataset_tool(
            "private_fund_dataset_memo",
            '{"topic":"forged"}',
            conversation_id="conv_qwen",
            task_id=None,
            agent_id="ag_qwen",
            agent_spec=SimpleNamespace(name="qwen-research", tools=SimpleNamespace(builtins=[])),
            runner_workspace=tmp_path,
        )
    )
    assert "not declared" in output


def test_private_fund_dispatch_rejects_a_session_without_project_label(tmp_path: Path) -> None:
    """Project tools fail closed instead of falling back to global active state."""
    spec = SimpleNamespace(
        name="qwen-research",
        tools=SimpleNamespace(builtins=[SimpleNamespace(name="private_fund_dataset_status")]),
    )

    async def run() -> str:
        transport = httpx.MockTransport(
            lambda request: httpx.Response(200, json={"workspace": str(tmp_path), "labels": {}})
        )
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await _execute_private_fund_dataset_tool(
                "private_fund_dataset_status",
                '{"dataset_id":"global-active"}',
                conversation_id="conv_unbound",
                task_id=None,
                agent_id="ag_qwen",
                agent_spec=spec,
                runner_workspace=tmp_path,
                server_client=client,
            )

    assert "not bound" in asyncio.run(run())
