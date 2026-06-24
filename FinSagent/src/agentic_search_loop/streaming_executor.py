"""Streaming tool executor for agentic search.

The executor implements useful streaming concurrency behavior:

1. Tools are added as soon as they are fully parsed from the model stream.
2. Concurrency-safe tools start immediately and can overlap with the still-open
   LLM stream.
3. Completed results are yielded opportunistically during streaming, then
   drained at the end of the assistant message.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import AsyncGenerator, Dict, Generator, List, Optional, Set

from .prompts import SEARCH_TOOL_NAMES
from .tools import AgenticSearchTools
from .types import ToolCallRecord, ToolResultRecord


@dataclass
class TrackedTool:
    call: ToolCallRecord
    status: str = "queued"
    is_concurrency_safe: bool = True
    task: Optional[asyncio.Task[ToolResultRecord]] = None
    result: Optional[ToolResultRecord] = None


@dataclass
class StreamingToolExecutor:
    """Execute read-only retrieval tools as soon as streamed args are complete."""

    tools: AgenticSearchTools
    max_concurrency: int = 10
    concurrency_safe_names: Set[str] = field(default_factory=lambda: set(SEARCH_TOOL_NAMES))
    _tracked: List[TrackedTool] = field(default_factory=list)
    _discarded: bool = False

    def discard(self) -> None:
        self._discarded = True
        for tracked in self._tracked:
            if tracked.task and not tracked.task.done():
                tracked.task.cancel()

    def add_tool(self, call: ToolCallRecord) -> None:
        if self._discarded:
            return
        tracked = TrackedTool(
            call=call,
            is_concurrency_safe=call.name in self.concurrency_safe_names,
        )
        self._tracked.append(tracked)
        self.process_queue()

    def process_queue(self) -> None:
        if self._discarded:
            return
        for tracked in self._tracked:
            if tracked.status != "queued":
                continue
            if not self._can_execute(tracked):
                if not tracked.is_concurrency_safe:
                    break
                continue
            self._start(tracked)

    def get_completed_results(self) -> Generator[ToolResultRecord, None, None]:
        if self._discarded:
            return
        self._collect_done_tasks()
        for tracked in self._tracked:
            if tracked.status == "yielded":
                continue
            if tracked.status == "completed" and tracked.result is not None:
                tracked.status = "yielded"
                yield tracked.result
            elif tracked.status == "executing" and not tracked.is_concurrency_safe:
                break
        self.process_queue()

    async def get_remaining_results(self) -> AsyncGenerator[ToolResultRecord, None]:
        if self._discarded:
            return
        while self.has_unfinished_tools():
            self.process_queue()
            yielded = False
            for result in self.get_completed_results():
                yielded = True
                yield result
            if yielded:
                continue

            pending = [
                tracked.task
                for tracked in self._tracked
                if tracked.status == "executing" and tracked.task is not None and not tracked.task.done()
            ]
            if not pending:
                await asyncio.sleep(0)
                continue
            await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)

        for result in self.get_completed_results():
            yield result

    def has_unfinished_tools(self) -> bool:
        return any(tracked.status != "yielded" for tracked in self._tracked)

    def _can_execute(self, candidate: TrackedTool) -> bool:
        executing = [tracked for tracked in self._tracked if tracked.status == "executing"]
        if not executing:
            return True
        if len(executing) >= max(self.max_concurrency, 1):
            return False
        return candidate.is_concurrency_safe and all(tracked.is_concurrency_safe for tracked in executing)

    def _start(self, tracked: TrackedTool) -> None:
        tracked.status = "executing"
        tracked.task = asyncio.create_task(
            self.tools.execute(
                tracked.call.tool_call_id,
                tracked.call.name,
                tracked.call.arguments,
            )
        )

    def _collect_done_tasks(self) -> None:
        for tracked in self._tracked:
            if tracked.status != "executing" or tracked.task is None or not tracked.task.done():
                continue
            try:
                tracked.result = tracked.task.result()
            except asyncio.CancelledError:
                tracked.result = ToolResultRecord(
                    tool_call_id=tracked.call.tool_call_id,
                    name=tracked.call.name,
                    ok=False,
                    content="<tool_error>Tool execution cancelled</tool_error>",
                    error="Tool execution cancelled",
                )
            except Exception as exc:
                tracked.result = ToolResultRecord(
                    tool_call_id=tracked.call.tool_call_id,
                    name=tracked.call.name,
                    ok=False,
                    content=f"<tool_error>{type(exc).__name__}: {exc}</tool_error>",
                    error=str(exc),
                )
            tracked.status = "completed"
