"""Headless cc-haha CLI executor for Omnigent conversations.

The desktop build ships cc-haha as a Bun-compiled Windows executable.  One
``--print --output-format stream-json`` process is launched per turn and the
cc-haha transcript is translated into Omnigent executor events.  Conversation
state remains owned by cc-haha and is resumed with its stable session UUID.

Omnigent tools are exposed through the existing Claude-native MCP relay.  This
keeps private-fund policy, tool dispatch, and event rendering in Omnigent while
leaving cc-haha's own orchestration and default prompt intact.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import shutil
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from typing import Any

from omnigent.claude_native_bridge import (
    build_mcp_config,
    prepare_bridge_dir,
    start_tool_relay,
)
from omnigent.inner.executor import (
    EnqueuedContent,
    Executor,
    ExecutorConfig,
    ExecutorError,
    ExecutorEvent,
    Message,
    TextChunk,
    ToolSpec,
    TurnComplete,
)
from omnigent.inner.native_attachments import materialize_attachment

_logger = logging.getLogger(__name__)

_STREAM_LIMIT = 16 * 1024 * 1024
_STDERR_LIMIT = 16 * 1024
_LOOPBACK_NO_PROXY = ("127.0.0.1", "localhost", "::1")
ToolExecutor = Callable[[str, dict[str, Any]], Awaitable[Any]]


def _truthy(value: str | None) -> bool:
    return bool(value and value.strip().lower() in {"1", "true", "yes", "on"})


def _with_loopback_no_proxy(value: str | None) -> str:
    entries = [item.strip() for item in (value or "").split(",") if item.strip()]
    existing = {item.lower() for item in entries}
    entries.extend(item for item in _LOOPBACK_NO_PROXY if item.lower() not in existing)
    return ",".join(entries)


def _content_to_text(content: Any, attachment_dir: Path) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    attachments: list[str] = []
    text_parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type in {"text", "input_text"} and isinstance(block.get("text"), str):
            text_parts.append(block["text"])
        elif block_type in {"input_image", "input_file"}:
            path = materialize_attachment(block, attachment_dir)
            if path is not None:
                attachments.append(f"[Attached: {path}]")
    return "\n\n".join([*attachments, *text_parts])


def _latest_user_text(messages: list[Message], attachment_dir: Path) -> str:
    for message in reversed(messages):
        if message.get("role") == "user":
            return _content_to_text(message.get("content"), attachment_dir)
    return ""


def _assistant_text(payload: dict[str, Any]) -> list[str]:
    if payload.get("type") != "assistant":
        return []
    message = payload.get("message")
    if not isinstance(message, dict):
        return []
    content = message.get("content")
    if isinstance(content, str):
        return [content] if content else []
    if not isinstance(content, list):
        return []
    return [
        block["text"]
        for block in content
        if isinstance(block, dict)
        and block.get("type") == "text"
        and isinstance(block.get("text"), str)
        and block["text"]
    ]


def _usage_from_result(payload: dict[str, Any]) -> dict[str, Any] | None:
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return None
    normalized: dict[str, Any] = {}
    for source, target in (
        ("input_tokens", "input_tokens"),
        ("output_tokens", "output_tokens"),
        ("cache_read_input_tokens", "cache_read_input_tokens"),
        ("cache_creation_input_tokens", "cache_creation_input_tokens"),
    ):
        value = usage.get(source)
        if isinstance(value, int) and not isinstance(value, bool):
            normalized[target] = value
    if "input_tokens" in normalized or "output_tokens" in normalized:
        normalized["total_tokens"] = normalized.get("input_tokens", 0) + normalized.get(
            "output_tokens", 0
        )
    return normalized or None


def _final_response_text(result_text: str | None, last_assistant_text: str | None) -> str | None:
    """Choose the authoritative final text from a cc-haha stream."""
    return result_text or last_assistant_text


def _result_error_text(payload: dict[str, Any]) -> str | None:
    """Return cc-haha's useful error detail instead of its protocol subtype."""
    subtype = str(payload.get("subtype") or "unknown").strip()
    if subtype == "success" and payload.get("is_error") is not True:
        return None

    errors = payload.get("errors")
    if isinstance(errors, list):
        detail = "; ".join(str(item).strip() for item in errors if str(item).strip())
        if detail:
            return detail

    # cc-haha reports API failures as subtype=success/is_error=true and puts
    # the actionable provider message in result.
    result = payload.get("result")
    if isinstance(result, str) and result.strip():
        return result.strip()
    return f"cc-haha result: {subtype}"


class CCHahaExecutor(Executor):
    """Run the cc-haha CLI headlessly while preserving its agent loop."""

    def __init__(
        self,
        *,
        binary_path: str = "claude-haha",
        cwd: str | None = None,
        model: str | None = None,
        bundle_dir: str | None = None,
        private_fund_prompt_file: str | None = None,
        permission_mode: str = "bypassPermissions",
    ) -> None:
        self._binary_path = binary_path
        self._cwd = cwd
        self._model = model
        self._bundle_dir = bundle_dir
        self._private_fund_prompt_file = private_fund_prompt_file
        self._permission_mode = permission_mode
        self._session_id = str(uuid.uuid4())
        self._started = False
        self._active_process: asyncio.subprocess.Process | None = None
        self._tool_executor: ToolExecutor | None = None
        self._bridge_dir: Path | None = None

    def handles_tools_internally(self) -> bool:
        return True

    def supports_streaming(self) -> bool:
        return True

    def supports_tool_calling(self) -> bool:
        return True

    def _resolved_binary(self) -> str | None:
        explicit = Path(self._binary_path)
        if explicit.exists():
            return str(explicit)
        return shutil.which(self._binary_path)

    def _workspace(self) -> Path:
        raw = self._cwd or os.getcwd()
        return Path(raw).expanduser().resolve(strict=False)

    def _prepare_bridge(self) -> Path:
        bridge_dir = prepare_bridge_dir(
            f"cc-haha-{self._session_id}",
            workspace=self._workspace(),
        )
        self._bridge_dir = bridge_dir
        return bridge_dir

    def _write_combined_prompt(self, bridge_dir: Path, system_prompt: str) -> Path | None:
        parts: list[str] = []
        prompt_path = self._private_fund_prompt_file
        if prompt_path:
            source = Path(prompt_path)
            try:
                text = source.read_text(encoding="utf-8").strip()
            except OSError as exc:
                _logger.warning("cc-haha prompt file unavailable (%s): %s", source, exc)
            else:
                if text:
                    parts.append(text)
        if system_prompt.strip():
            parts.append(system_prompt.strip())
        if not parts:
            return None
        target = bridge_dir / "omnigent-system-prompt.md"
        target.write_text("\n\n".join(parts) + "\n", encoding="utf-8")
        return target

    def _build_argv(
        self,
        *,
        binary: str,
        prompt: str,
        bridge_dir: Path,
        system_prompt: str,
        model_override: str | None,
    ) -> list[str]:
        args = [
            binary,
            "--print",
            "--output-format",
            "stream-json",
            "--verbose",
            "--mcp-config",
            json.dumps(build_mcp_config(bridge_dir), separators=(",", ":")),
            "--permission-mode",
            self._permission_mode,
        ]
        if _truthy(os.environ.get("HARNESS_CC_HAHA_STRICT_MCP")):
            args.append("--strict-mcp-config")
        if self._started:
            args.extend(["--resume", self._session_id])
        else:
            args.extend(["--session-id", self._session_id])
        model = model_override or self._model
        if model:
            args.extend(["--model", model])
        if self._bundle_dir and Path(self._bundle_dir).exists():
            args.extend(["--plugin-dir", self._bundle_dir])
        prompt_file = self._write_combined_prompt(bridge_dir, system_prompt)
        if prompt_file is not None:
            args.extend(["--append-system-prompt-file", str(prompt_file)])
        args.append(prompt)
        return args

    def _build_env(self) -> dict[str, str]:
        env = os.environ.copy()
        # The desktop route intentionally authenticates its local LiteLLM
        # endpoint with ANTHROPIC_AUTH_TOKEN.  An inherited empty API key can
        # otherwise take precedence in Claude-compatible clients.
        if not env.get("ANTHROPIC_API_KEY"):
            env.pop("ANTHROPIC_API_KEY", None)
        env.setdefault("DISABLE_TELEMETRY", "1")
        env.setdefault("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
        env.setdefault("API_TIMEOUT_MS", "3000000")
        # The bundled headless CLI is a regular --print process rather than an
        # --sdk-url session. Bound only its MCP startup wait so a stalled local
        # bridge cannot leave the Omnigent turn in Working forever. The MCP
        # connection continues in the background after this deadline.
        env.setdefault("CC_HAHA_DESKTOP_AWAIT_MCP", "1")
        env.setdefault("CC_HAHA_DESKTOP_AWAIT_MCP_TIMEOUT_MS", "15000")
        no_proxy = _with_loopback_no_proxy(env.get("NO_PROXY") or env.get("no_proxy"))
        env["NO_PROXY"] = no_proxy
        env["no_proxy"] = no_proxy
        return env

    async def run_turn(
        self,
        messages: list[Message],
        tools: list[ToolSpec],
        system_prompt: str,
        config: ExecutorConfig | None = None,
    ) -> AsyncIterator[ExecutorEvent]:
        binary = self._resolved_binary()
        if binary is None:
            yield ExecutorError(
                message=(
                    f"cc-haha executable {self._binary_path!r} was not found. "
                    "Reinstall the desktop package or set HARNESS_CC_HAHA_PATH."
                )
            )
            return
        if self._tool_executor is None and tools:
            yield ExecutorError(message="cc-haha MCP relay is not connected to Omnigent")
            return

        bridge_dir = self._prepare_bridge()
        prompt = _latest_user_text(messages, bridge_dir / "attachments")
        if not prompt:
            yield TurnComplete(response=None)
            return

        relay = None
        if tools and self._tool_executor is not None:
            relay = start_tool_relay(
                bridge_dir=bridge_dir,
                tools=tools,
                tool_executor=self._tool_executor,
                loop=asyncio.get_running_loop(),
            )

        argv = self._build_argv(
            binary=binary,
            prompt=prompt,
            bridge_dir=bridge_dir,
            system_prompt=system_prompt,
            model_override=config.model if config is not None else None,
        )
        env = self._build_env()
        stderr_buf = bytearray()
        last_assistant_text: str | None = None
        result_usage: dict[str, Any] | None = None
        result_text: str | None = None
        result_error: str | None = None
        process: asyncio.subprocess.Process | None = None
        started_at = time.monotonic()
        try:
            process = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(self._workspace()),
                env=env,
                limit=_STREAM_LIMIT,
            )
            self._active_process = process
            assert process.stdout is not None
            assert process.stderr is not None

            async def _drain_stderr() -> None:
                while True:
                    chunk = await process.stderr.read(4096)
                    if not chunk:
                        return
                    stderr_buf.extend(chunk)
                    if len(stderr_buf) > _STDERR_LIMIT:
                        del stderr_buf[:-_STDERR_LIMIT]

            stderr_task = asyncio.create_task(_drain_stderr())
            try:
                async for raw_line in process.stdout:
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if not line:
                        continue
                    try:
                        payload = json.loads(line)
                    except json.JSONDecodeError:
                        _logger.debug("cc-haha non-JSON stdout: %s", line[:300])
                        continue
                    if not isinstance(payload, dict):
                        continue
                    assistant_parts = _assistant_text(payload)
                    if assistant_parts:
                        # Assistant events can be pre-tool narration or a
                        # partial snapshot. The result event carries cc-haha's
                        # authoritative final response, so do not commit these
                        # intermediate strings to the Omnigent transcript.
                        last_assistant_text = "".join(assistant_parts)
                    if payload.get("type") == "result":
                        result_usage = _usage_from_result(payload) or result_usage
                        raw_result = payload.get("result")
                        if isinstance(raw_result, str) and raw_result:
                            result_text = raw_result
                        result_error = _result_error_text(payload) or result_error
            finally:
                await stderr_task
            returncode = await process.wait()
            self._started = self._started or returncode == 0
        except asyncio.CancelledError:
            if process is not None and process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.terminate()
            raise
        except OSError as exc:
            yield ExecutorError(message=f"could not start cc-haha: {exc}")
            return
        finally:
            self._active_process = None
            if process is not None and process.returncode is None:
                try:
                    await asyncio.wait_for(process.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    with contextlib.suppress(ProcessLookupError):
                        process.kill()
                    with contextlib.suppress(Exception):
                        await process.wait()
            if relay is not None:
                await asyncio.to_thread(relay.close)

        stderr_text = stderr_buf.decode("utf-8", errors="replace").strip()
        if result_error:
            yield ExecutorError(message=result_error, retryable=False)
            return
        if process is not None and process.returncode not in (None, 0):
            elapsed_ms = (time.monotonic() - started_at) * 1000
            detail = stderr_text[-1000:] or "no stderr output"
            yield ExecutorError(
                message=(
                    f"cc-haha exited with code {process.returncode} after "
                    f"{elapsed_ms:.0f}ms: {detail}"
                ),
                retryable=False,
            )
            return
        response = _final_response_text(result_text, last_assistant_text)
        if response:
            yield TextChunk(text=response)
        yield TurnComplete(response=response, usage=result_usage)

    async def close_session(self, session_key: str) -> None:
        del session_key
        self._started = False

    async def interrupt_session(self, session_key: str) -> bool:
        del session_key
        process = self._active_process
        if process is None or process.returncode is not None:
            return False
        with contextlib.suppress(ProcessLookupError):
            process.terminate()
            return True
        return False

    async def enqueue_session_message(
        self,
        session_key: str,
        content: EnqueuedContent,
    ) -> bool:
        del session_key, content
        return False
