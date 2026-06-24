"""LLM-driven agentic search loop.

This module implements the useful core of an agentic search loop:

1. Ask the model what to do next with a read-only tool set.
2. Execute emitted tool calls.
3. Append tool results back into the message list.
4. Continue until the model calls FinishSearch or the turn budget is reached.

The loop is standalone and can be wrapped later as a FinSagent retrieval backend.
"""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncGenerator, Dict, Iterable, List, Optional, Set

from .corpus import CorpusStore
from .prompts import (
    FAST_TOOL_SCHEMAS,
    FINISH_TOOL_NAME,
    GLOB_TOOL_NAME,
    GREP_TOOL_NAME,
    READ_TOOL_NAME,
    TOOL_SCHEMAS,
    build_system_prompt,
    build_user_prompt,
    split_system_prompt_at_dynamic_boundary,
)
from .streaming_executor import StreamingToolExecutor
from .tools import AgenticSearchTools
from .types import AgenticSearchResult, EventCallback, EvidenceItem, SearchEvent, ToolCallRecord, ToolResultRecord


AGENTIC_SEARCH_MODE_DEFAULTS: Dict[str, Dict[str, Any]] = {
    "default": {
        "max_turns": 36,
        "enforce_finish_coverage": False,
        "enforce_minimum_reliability": False,
    },
    "fast": {
        "max_turns": 12,
    },
}


def normalize_agentic_search_mode(mode: Any) -> str:
    normalized = str(mode or "default").strip().lower()
    return "fast" if normalized == "fast" else "default"


def _coerce_bool(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "y", "on"}:
            return True
        if normalized in {"false", "0", "no", "n", "off"}:
            return False
    return bool(value)


def resolve_agentic_search_config(config: Dict[str, Any] | None) -> Dict[str, Any]:
    raw_config = config if isinstance(config, dict) else {}
    mode = normalize_agentic_search_mode(raw_config.get("mode", "default"))
    resolved = {key: value for key, value in raw_config.items() if key != "mode_params"}

    mode_params = raw_config.get("mode_params")
    if isinstance(mode_params, dict):
        selected_params = mode_params.get(mode)
        if isinstance(selected_params, dict):
            resolved.update(selected_params)
    resolved["mode"] = mode
    return resolved


@dataclass
class AgenticSearchConfig:
    model: str
    base_url: Optional[str] = None
    api_key: str = "EMPTY"
    mode: str = "default"
    max_turns: Optional[int] = None
    max_tokens: int = 4096
    temperature: float = 0.0
    parallel_tool_calls: bool = True
    streaming_tool_execution: bool = True
    max_concurrent_tools: int = 10
    finalize_on_max_turns: bool = True
    enforce_finish_coverage: Optional[bool] = None
    enforce_minimum_reliability: Optional[bool] = None
    max_finish_rejections: int = 2
    system_prompt: Optional[str] = None

    def __post_init__(self) -> None:
        self.mode = normalize_agentic_search_mode(self.mode)
        mode_defaults = AGENTIC_SEARCH_MODE_DEFAULTS[self.mode]
        if self.max_turns is None:
            self.max_turns = int(mode_defaults["max_turns"])
        else:
            self.max_turns = int(self.max_turns)
        self.max_tokens = int(self.max_tokens)
        self.temperature = float(self.temperature)
        self.parallel_tool_calls = _coerce_bool(self.parallel_tool_calls, True)
        self.streaming_tool_execution = _coerce_bool(self.streaming_tool_execution, True)
        self.max_concurrent_tools = int(self.max_concurrent_tools)
        self.finalize_on_max_turns = _coerce_bool(self.finalize_on_max_turns, True)
        self.enforce_finish_coverage = _coerce_bool(
            self.enforce_finish_coverage,
            bool(mode_defaults.get("enforce_finish_coverage", False)),
        )
        self.enforce_minimum_reliability = _coerce_bool(
            self.enforce_minimum_reliability,
            bool(mode_defaults.get("enforce_minimum_reliability", False)),
        )
        self.max_finish_rejections = int(self.max_finish_rejections)

    @classmethod
    def from_agentic_search_config(
        cls,
        config: Dict[str, Any] | None,
        *,
        model: str,
        base_url: Optional[str] = None,
        api_key: str = "EMPTY",
        overrides: Optional[Dict[str, Any]] = None,
    ) -> "AgenticSearchConfig":
        resolved = resolve_agentic_search_config(config)
        if overrides:
            resolved.update({key: value for key, value in overrides.items() if value is not None})
        fields = {
            "mode",
            "max_turns",
            "max_tokens",
            "temperature",
            "parallel_tool_calls",
            "streaming_tool_execution",
            "max_concurrent_tools",
            "finalize_on_max_turns",
            "enforce_finish_coverage",
            "enforce_minimum_reliability",
            "max_finish_rejections",
            "system_prompt",
        }
        kwargs = {key: resolved[key] for key in fields if key in resolved}
        return cls(model=model, base_url=base_url, api_key=api_key, **kwargs)


class OpenAIChatClient:
    """Small adapter around an OpenAI-compatible async chat client."""

    def __init__(self, config: AgenticSearchConfig):
        from openai import AsyncOpenAI

        self.config = config
        self.client = AsyncOpenAI(
            api_key=config.api_key or os.environ.get("OPENAI_API_KEY", "EMPTY"),
            base_url=config.base_url,
        )

    async def create(self, messages: List[Dict[str, Any]], tools: List[Dict[str, Any]]) -> Any:
        return await self.client.chat.completions.create(
            model=self.config.model,
            messages=messages,
            tools=tools,
            tool_choice="auto",
            parallel_tool_calls=self.config.parallel_tool_calls,
            temperature=self.config.temperature,
            max_tokens=self.config.max_tokens,
        )

    async def stream(self, messages: List[Dict[str, Any]], tools: List[Dict[str, Any]]) -> Any:
        return await self.client.chat.completions.create(
            model=self.config.model,
            messages=messages,
            tools=tools,
            tool_choice="auto",
            parallel_tool_calls=self.config.parallel_tool_calls,
            temperature=self.config.temperature,
            max_tokens=self.config.max_tokens,
            stream=True,
        )


class SessionManagerChatClient:
    """Adapter for the existing FinSagent SessionManager."""

    def __init__(self, session_manager: Any, config: AgenticSearchConfig):
        self.session_manager = session_manager
        self.config = config

    async def create(self, messages: List[Dict[str, Any]], tools: List[Dict[str, Any]]) -> Any:
        return await self.session_manager.async_llm.chat.completions.create(
            model=self.config.model,
            messages=messages,
            tools=tools,
            tool_choice="auto",
            parallel_tool_calls=self.config.parallel_tool_calls,
            temperature=self.config.temperature,
            max_tokens=self.config.max_tokens,
        )

    async def stream(self, messages: List[Dict[str, Any]], tools: List[Dict[str, Any]]) -> Any:
        return await self.session_manager.async_llm.chat.completions.create(
            model=self.config.model,
            messages=messages,
            tools=tools,
            tool_choice="auto",
            parallel_tool_calls=self.config.parallel_tool_calls,
            temperature=self.config.temperature,
            max_tokens=self.config.max_tokens,
            stream=True,
        )


@dataclass
class StreamedToolCall:
    index: int
    tool_call_id: str = ""
    name: str = ""
    arguments_buffer: str = ""
    parsed_arguments: Optional[Dict[str, Any]] = None
    started: bool = False

    @property
    def stable_tool_call_id(self) -> str:
        return self.tool_call_id or f"call_{self.index}"

    def to_assistant_tool_call(self) -> Dict[str, Any]:
        arguments = self.parsed_arguments if self.parsed_arguments is not None else {}
        return {
            "id": self.stable_tool_call_id,
            "type": "function",
            "function": {
                "name": self.name,
                "arguments": json.dumps(arguments, ensure_ascii=False),
            },
        }


class AgenticSearchLoop:
    def __init__(
        self,
        corpus: CorpusStore,
        config: AgenticSearchConfig,
        client: Optional[Any] = None,
        event_callback: Optional[EventCallback] = None,
    ):
        self.corpus = corpus
        self.config = config
        self.client = client or OpenAIChatClient(config)
        self.tools = AgenticSearchTools(corpus)
        self.event_callback = event_callback

    def _mode(self) -> str:
        mode = str(self.config.mode or "default").strip().lower()
        return "fast" if mode == "fast" else "default"

    def _tool_schemas(self) -> List[Dict[str, Any]]:
        return FAST_TOOL_SCHEMAS if self._mode() == "fast" else TOOL_SCHEMAS

    def _build_system_prompt(self) -> str:
        if self.config.system_prompt:
            return self.config.system_prompt
        return build_system_prompt(
            model=self.config.model,
            roots=[str(root) for root in self.corpus.roots],
            max_turns=self.config.max_turns,
            mode=self._mode(),
        )

    async def astream_search(
        self,
        question: str,
        extra_context: Optional[str] = None,
    ) -> AsyncGenerator[SearchEvent, None]:
        result_events: List[SearchEvent] = []

        def emit(event: SearchEvent) -> SearchEvent:
            result_events.append(event)
            if self.event_callback:
                self.event_callback(event)
            return event

        system_prompt = self._build_system_prompt()
        system_prompt_static, system_prompt_dynamic = split_system_prompt_at_dynamic_boundary(system_prompt)
        messages: List[Dict[str, Any]] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": build_user_prompt(question, extra_context, mode=self._mode())},
        ]
        tool_schemas = self._tool_schemas()
        coverage_state: Dict[str, set[str]] = {
            "candidate_sources": set(),
            "matched_sources": set(),
            "high_signal_sources": set(),
            "high_signal_refs": set(),
            "inspected_sources": set(),
            "inspected_refs": set(),
        }
        finish_rejections = 0
        yield emit(
            SearchEvent(
                "loop_start",
                {
                    "question": question,
                    "roots": [str(r) for r in self.corpus.roots],
                    "system_prompt": system_prompt,
                    "system_prompt_static": system_prompt_static,
                    "system_prompt_dynamic": system_prompt_dynamic,
                    "tool_names": [schema["function"]["name"] for schema in tool_schemas],
                },
            )
        )

        last_iteration_had_tool_results = False
        for iteration in range(1, self.config.max_turns + 1):
            last_iteration_had_tool_results = False
            yield emit(SearchEvent("iteration_start", {"iteration": iteration}))
            if self.config.streaming_tool_execution and hasattr(self.client, "stream"):
                executor = StreamingToolExecutor(self.tools, max_concurrency=self.config.max_concurrent_tools)
                content_parts: List[str] = []
                streamed_tool_calls: Dict[int, StreamedToolCall] = {}
                streamed_tool_results: List[ToolResultRecord] = []
                finish_payload: Optional[Dict[str, Any]] = None
                finish_call_id = ""

                try:
                    stream_candidate = self.client.stream(messages, tool_schemas)
                    stream = await stream_candidate if hasattr(stream_candidate, "__await__") else stream_candidate
                    async for chunk in stream:
                        delta = self._stream_chunk_delta_to_dict(chunk)
                        content_delta = str(delta.get("content") or "")
                        if content_delta:
                            content_parts.append(content_delta)
                            yield emit(
                                SearchEvent(
                                    "assistant_delta",
                                    {
                                        "iteration": iteration,
                                        "content": content_delta,
                                    },
                                )
                            )

                        for tool_delta in delta.get("tool_calls", []) or []:
                            call_state = self._apply_tool_call_delta(streamed_tool_calls, tool_delta)
                            argument_delta = str(tool_delta.get("function", {}).get("arguments") or "")
                            yield emit(
                                SearchEvent(
                                    "tool_call_delta",
                                    {
                                        "iteration": iteration,
                                        "tool_call_id": call_state.tool_call_id,
                                        "index": call_state.index,
                                        "name": call_state.name,
                                        "argument_delta": argument_delta,
                                        "arguments_so_far": call_state.arguments_buffer,
                                    },
                                )
                            )
                            parsed_args = self._json_loads_maybe(call_state.arguments_buffer)
                            if (
                                parsed_args is None
                                or call_state.started
                                or not call_state.name
                                or not call_state.tool_call_id
                            ):
                                continue
                            call_state.parsed_arguments = parsed_args
                            call_state.started = True
                            if call_state.name == FINISH_TOOL_NAME:
                                finish_payload = parsed_args
                                finish_call_id = call_state.stable_tool_call_id
                                yield emit(
                                    SearchEvent(
                                        "tool_call",
                                        {
                                            "iteration": iteration,
                                            "tool_call_id": call_state.stable_tool_call_id,
                                            "name": FINISH_TOOL_NAME,
                                            "arguments": parsed_args,
                                            "streaming": True,
                                        },
                                    )
                                )
                            else:
                                call = ToolCallRecord(
                                    tool_call_id=call_state.stable_tool_call_id,
                                    name=call_state.name,
                                    arguments=parsed_args,
                                    note=str(parsed_args.get("public_note", "") or ""),
                                )
                                yield emit(
                                    SearchEvent(
                                        "tool_call",
                                        {
                                            "iteration": iteration,
                                            "streaming": True,
                                            **call.to_dict(),
                                        },
                                    )
                                )
                                executor.add_tool(call)

                        for tool_result in executor.get_completed_results():
                            streamed_tool_results.append(tool_result)
                            self._record_coverage_from_tool_result(coverage_state, tool_result)
                            yield emit(
                                SearchEvent(
                                    "tool_result",
                                    {
                                        "iteration": iteration,
                                        "streaming": True,
                                        **tool_result.to_dict(),
                                    },
                                )
                            )
                except Exception as exc:
                    executor.discard()
                    yield emit(
                        SearchEvent(
                            "error",
                            {
                                "iteration": iteration,
                                "type": type(exc).__name__,
                                "error": str(exc),
                            },
                        )
                    )
                    yield emit(
                        SearchEvent(
                            "final",
                            {
                                "answer": "",
                                "gaps": [f"Streaming LLM call failed: {type(exc).__name__}: {exc}"],
                                "confidence": "low",
                                "stopped_reason": "llm_error",
                            },
                        )
                    )
                    return

                for call_state in sorted(streamed_tool_calls.values(), key=lambda item: item.index):
                    if call_state.started:
                        continue
                    parsed_args = self._json_loads_maybe(call_state.arguments_buffer)
                    if parsed_args is None:
                        if not call_state.name:
                            continue
                        parsed_args = {}
                        call_state.parsed_arguments = parsed_args
                        tool_result = ToolResultRecord(
                            tool_call_id=call_state.stable_tool_call_id,
                            name=call_state.name,
                            ok=False,
                            content="<tool_error>Invalid or incomplete streamed tool arguments</tool_error>",
                            error="Invalid or incomplete streamed tool arguments",
                        )
                        streamed_tool_results.append(tool_result)
                        self._record_coverage_from_tool_result(coverage_state, tool_result)
                        yield emit(
                            SearchEvent(
                                "tool_result",
                                {
                                    "iteration": iteration,
                                    "streaming": True,
                                    **tool_result.to_dict(),
                                },
                            )
                        )
                        continue
                    if not call_state.name:
                        continue
                    call_state.parsed_arguments = parsed_args
                    call_state.started = True
                    if call_state.name == FINISH_TOOL_NAME:
                        finish_payload = parsed_args
                        finish_call_id = call_state.stable_tool_call_id
                        yield emit(
                            SearchEvent(
                                "tool_call",
                                {
                                    "iteration": iteration,
                                    "tool_call_id": call_state.stable_tool_call_id,
                                    "name": FINISH_TOOL_NAME,
                                    "arguments": parsed_args,
                                    "streaming": True,
                                },
                            )
                        )
                    else:
                        call = ToolCallRecord(
                            tool_call_id=call_state.stable_tool_call_id,
                            name=call_state.name,
                            arguments=parsed_args,
                            note=str(parsed_args.get("public_note", "") or ""),
                        )
                        yield emit(
                            SearchEvent(
                                "tool_call",
                                {
                                    "iteration": iteration,
                                    "streaming": True,
                                    **call.to_dict(),
                                },
                            )
                        )
                        executor.add_tool(call)

                for tool_result in executor.get_completed_results():
                    streamed_tool_results.append(tool_result)
                    self._record_coverage_from_tool_result(coverage_state, tool_result)
                    yield emit(
                        SearchEvent(
                            "tool_result",
                            {
                                "iteration": iteration,
                                "streaming": True,
                                **tool_result.to_dict(),
                            },
                        )
                    )
                async for tool_result in executor.get_remaining_results():
                    streamed_tool_results.append(tool_result)
                    self._record_coverage_from_tool_result(coverage_state, tool_result)
                    yield emit(
                        SearchEvent(
                            "tool_result",
                            {
                                "iteration": iteration,
                                "streaming": True,
                                **tool_result.to_dict(),
                            },
                        )
                    )

                content = "".join(content_parts)
                assistant_msg: Dict[str, Any] = {"role": "assistant", "content": content}
                if streamed_tool_calls:
                    assistant_tool_calls = [
                        call.to_assistant_tool_call()
                        for call in sorted(streamed_tool_calls.values(), key=lambda item: item.index)
                        if call.name
                    ]
                    if assistant_tool_calls:
                        assistant_msg["tool_calls"] = assistant_tool_calls
                messages.append(assistant_msg)

                if content.strip():
                    yield emit(SearchEvent("assistant_message", {"iteration": iteration, "content": content}))

                if finish_payload is not None:
                    rejection = self._validate_finish_payload(finish_payload, coverage_state)
                    if rejection and finish_rejections < self.config.max_finish_rejections:
                        finish_rejections += 1
                        for tool_result in streamed_tool_results:
                            messages.append(
                                {
                                    "role": "tool",
                                    "tool_call_id": tool_result.tool_call_id,
                                    "content": tool_result.content,
                                }
                            )
                        messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": finish_call_id or FINISH_TOOL_NAME,
                                "content": rejection,
                            }
                        )
                        yield emit(
                            SearchEvent(
                                "finish_rejected",
                                {
                                    "iteration": iteration,
                                    "reason": rejection,
                                    "rejections": finish_rejections,
                                },
                            )
                        )
                        yield emit(
                            SearchEvent(
                                "iteration_end",
                                {
                                    "iteration": iteration,
                                    "tool_calls": len(streamed_tool_calls),
                                    "streaming": True,
                                    "finish_rejected": True,
                                },
                            )
                        )
                        continue
                    finish_payload = self._with_default_coverage(finish_payload, coverage_state)
                    yield emit(SearchEvent("final", {"stopped_reason": FINISH_TOOL_NAME, **finish_payload}))
                    return

                if not streamed_tool_calls:
                    yield emit(SearchEvent("final", {"answer": content, "stopped_reason": "assistant_final"}))
                    return

                for tool_result in streamed_tool_results:
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tool_result.tool_call_id,
                            "content": tool_result.content,
                        }
                    )
                last_iteration_had_tool_results = bool(streamed_tool_results)

                yield emit(
                    SearchEvent(
                        "iteration_end",
                        {
                            "iteration": iteration,
                            "tool_calls": len(streamed_tool_calls),
                            "streaming": True,
                        },
                    )
                )
                continue

            try:
                response = await self.client.create(messages, tool_schemas)
            except Exception as exc:
                yield emit(
                    SearchEvent(
                        "error",
                        {
                            "iteration": iteration,
                            "type": type(exc).__name__,
                            "error": str(exc),
                        },
                    )
                )
                yield emit(
                    SearchEvent(
                        "final",
                        {
                            "answer": "",
                            "gaps": [f"LLM call failed: {type(exc).__name__}: {exc}"],
                            "confidence": "low",
                            "stopped_reason": "llm_error",
                        },
                    )
                )
                return
            message = response.choices[0].message
            assistant_msg = self._assistant_message_to_dict(message)
            messages.append(assistant_msg)

            content = assistant_msg.get("content") or ""
            tool_calls = assistant_msg.get("tool_calls") or []
            if content.strip():
                yield emit(SearchEvent("assistant_message", {"iteration": iteration, "content": content}))

            if not tool_calls:
                yield emit(SearchEvent("final", {"answer": content, "stopped_reason": "assistant_final"}))
                return

            finish_call_id, finish_payload = self._find_finish_tool_call(tool_calls)
            if finish_payload is not None:
                rejection = self._validate_finish_payload(finish_payload, coverage_state)
                if rejection and finish_rejections < self.config.max_finish_rejections:
                    finish_rejections += 1
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": finish_call_id or FINISH_TOOL_NAME,
                            "content": rejection,
                        }
                    )
                    for tc in tool_calls:
                        if tc.get("function", {}).get("name") == FINISH_TOOL_NAME:
                            continue
                        messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": tc.get("id", ""),
                                "content": f"<tool_error>Tool call was not executed because {FINISH_TOOL_NAME} was rejected. Continue with a new tool call if this work is still needed.</tool_error>",
                            }
                        )
                    yield emit(
                        SearchEvent(
                            "finish_rejected",
                            {
                                "iteration": iteration,
                                "reason": rejection,
                                "rejections": finish_rejections,
                            },
                        )
                    )
                    yield emit(
                        SearchEvent(
                            "iteration_end",
                            {
                                "iteration": iteration,
                                "tool_calls": len(tool_calls),
                                "finish_rejected": True,
                            },
                        )
                    )
                    continue
                yield emit(SearchEvent("tool_call", {"iteration": iteration, "name": FINISH_TOOL_NAME, "arguments": finish_payload}))
                finish_payload = self._with_default_coverage(finish_payload, coverage_state)
                yield emit(SearchEvent("final", {"stopped_reason": FINISH_TOOL_NAME, **finish_payload}))
                return

            call_records = []
            for tc in tool_calls:
                args = self._json_loads(tc["function"].get("arguments") or "{}")
                note = str(args.get("public_note", "") or "")
                call = ToolCallRecord(
                    tool_call_id=tc["id"],
                    name=tc["function"]["name"],
                    arguments=args,
                    note=note,
                )
                call_records.append(call)
                yield emit(SearchEvent("tool_call", {"iteration": iteration, **call.to_dict()}))

            if self.config.parallel_tool_calls:
                tool_results = await asyncio.gather(
                    *[
                        self.tools.execute(call.tool_call_id, call.name, call.arguments)
                        for call in call_records
                    ]
                )
            else:
                tool_results = []
                for call in call_records:
                    tool_results.append(await self.tools.execute(call.tool_call_id, call.name, call.arguments))

            for tool_result in tool_results:
                self._record_coverage_from_tool_result(coverage_state, tool_result)
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_result.tool_call_id,
                        "content": tool_result.content,
                    }
                )
                yield emit(SearchEvent("tool_result", {"iteration": iteration, **tool_result.to_dict()}))
            last_iteration_had_tool_results = bool(tool_results)

            yield emit(SearchEvent("iteration_end", {"iteration": iteration, "tool_calls": len(tool_calls)}))

        if self.config.finalize_on_max_turns and last_iteration_had_tool_results and hasattr(self.client, "create"):
            final_iteration = self.config.max_turns + 1
            yield emit(SearchEvent("iteration_start", {"iteration": final_iteration, "finalization": True}))
            try:
                response = await self.client.create(messages, self._finish_tool_schemas())
            except Exception as exc:
                yield emit(
                    SearchEvent(
                        "error",
                        {
                            "iteration": final_iteration,
                            "finalization": True,
                            "type": type(exc).__name__,
                            "error": str(exc),
                        },
                    )
                )
            else:
                message = response.choices[0].message
                assistant_msg = self._assistant_message_to_dict(message)
                content = assistant_msg.get("content") or ""
                finish_tool_calls = assistant_msg.get("tool_calls") or []
                if content.strip():
                    payload = {
                        "iteration": final_iteration,
                        "finalization": True,
                        "content": content,
                    }
                    yield emit(SearchEvent("assistant_message", payload))
                finish_payload = self._find_finish_payload(finish_tool_calls)
                if finish_payload is not None:
                    finish_payload = self._with_default_coverage(finish_payload, coverage_state)
                    yield emit(
                        SearchEvent(
                            "tool_call",
                            {
                                "iteration": final_iteration,
                                "finalization": True,
                                "name": FINISH_TOOL_NAME,
                                "arguments": finish_payload,
                            },
                        )
                    )
                    yield emit(
                        SearchEvent(
                            "final",
                            {
                                "stopped_reason": FINISH_TOOL_NAME,
                                "finalization": True,
                                **finish_payload,
                            },
                        )
                    )
                    return
                retry_messages = list(messages)
                if content.strip():
                    retry_messages.append({"role": "assistant", "content": content})
                retry_messages.append(
                    {
                        "role": "user",
                        "content": (
                            f"You did not call {FINISH_TOOL_NAME}. You must now call the "
                            f"{FINISH_TOOL_NAME} tool exactly once using only the evidence "
                            "already retrieved. Do not answer in plain text. If the evidence "
                            "is incomplete, still call the tool with a limited low-confidence "
                            "answer and list the gaps."
                        ),
                    }
                )
                retry_iteration = final_iteration + 1
                yield emit(
                    SearchEvent(
                        "finish_retry_requested",
                        {
                            "iteration": retry_iteration,
                            "previous_iteration": final_iteration,
                            "finalization": True,
                            "reason": f"{FINISH_TOOL_NAME} was not called during maxTurns finalization.",
                        },
                    )
                )
                yield emit(
                    SearchEvent(
                        "iteration_start",
                        {
                            "iteration": retry_iteration,
                            "finalization": True,
                            "retry": True,
                        },
                    )
                )
                try:
                    retry_response = await self.client.create(retry_messages, self._finish_tool_schemas())
                except Exception as exc:
                    yield emit(
                        SearchEvent(
                            "error",
                            {
                                "iteration": retry_iteration,
                                "finalization": True,
                                "retry": True,
                                "type": type(exc).__name__,
                                "error": str(exc),
                            },
                        )
                    )
                else:
                    retry_message = retry_response.choices[0].message
                    retry_assistant_msg = self._assistant_message_to_dict(retry_message)
                    retry_content = retry_assistant_msg.get("content") or ""
                    retry_tool_calls = retry_assistant_msg.get("tool_calls") or []
                    if retry_content.strip():
                        yield emit(
                            SearchEvent(
                                "assistant_message",
                                {
                                    "iteration": retry_iteration,
                                    "finalization": True,
                                    "retry": True,
                                    "content": retry_content,
                                },
                            )
                        )
                    retry_finish_payload = self._find_finish_payload(retry_tool_calls)
                    if retry_finish_payload is not None:
                        retry_finish_payload = self._with_default_coverage(retry_finish_payload, coverage_state)
                        yield emit(
                            SearchEvent(
                                "tool_call",
                                {
                                    "iteration": retry_iteration,
                                    "finalization": True,
                                    "retry": True,
                                    "name": FINISH_TOOL_NAME,
                                    "arguments": retry_finish_payload,
                                },
                            )
                        )
                        yield emit(
                            SearchEvent(
                                "final",
                                {
                                    "stopped_reason": FINISH_TOOL_NAME,
                                    "finalization": True,
                                    "retry": True,
                                    **retry_finish_payload,
                                },
                            )
                        )
                        return
                    yield emit(
                        SearchEvent(
                            "finish_retry_failed",
                            {
                                "iteration": retry_iteration,
                                "finalization": True,
                                "retry": True,
                                "reason": f"{FINISH_TOOL_NAME} was not called after retry.",
                            },
                        )
                    )

        yield emit(
            SearchEvent(
                "final",
                {
                    "answer": f"Search stopped after reaching maxTurns before {FINISH_TOOL_NAME} was called.",
                    "gaps": ["maxTurns reached"],
                    "confidence": "low",
                    "stopped_reason": "maxTurns",
                },
            )
        )

    async def arun_search(self, question: str, extra_context: Optional[str] = None) -> AgenticSearchResult:
        events: List[SearchEvent] = []
        async for event in self.astream_search(question, extra_context):
            events.append(event)

        final_event = next((e for e in reversed(events) if e.event == "final"), None)
        final_data = final_event.data if final_event else {}
        tool_calls = [
            ToolCallRecord(
                tool_call_id=e.data.get("tool_call_id", ""),
                name=e.data.get("name", ""),
                arguments=e.data.get("arguments", {}),
                note=e.data.get("note", ""),
            )
            for e in events
            if e.event == "tool_call" and e.data.get("name") != FINISH_TOOL_NAME
        ]
        tool_results = [
            ToolResultRecord(
                tool_call_id=e.data.get("tool_call_id", ""),
                name=e.data.get("name", ""),
                ok=bool(e.data.get("ok", False)),
                content=e.data.get("content", ""),
                data=e.data.get("data", {}),
                error=e.data.get("error"),
            )
            for e in events
            if e.event == "tool_result"
        ]
        evidence = [
            EvidenceItem(
                path=str(item.get("path", "")),
                quote=str(item.get("quote", "")),
                line=item.get("line"),
                page=item.get("page"),
                why_relevant=str(item.get("why_relevant", "")),
            )
            for item in final_data.get("evidence", []) or []
            if isinstance(item, dict)
        ]
        return AgenticSearchResult(
            answer=str(final_data.get("answer", "")),
            evidence=evidence,
            gaps=[str(x) for x in final_data.get("gaps", []) or []],
            coverage=final_data.get("coverage", {}) if isinstance(final_data.get("coverage", {}), dict) else {},
            confidence=str(final_data.get("confidence", "medium")),
            reliability_notes=[str(x) for x in final_data.get("reliability_notes", []) or []],
            tool_calls=tool_calls,
            tool_results=tool_results,
            events=events,
            iterations=max((e.data.get("iteration", 0) for e in events if isinstance(e.data.get("iteration", 0), int)), default=0),
            stopped_reason=str(final_data.get("stopped_reason", "completed")),
        )

    @staticmethod
    def _assistant_message_to_dict(message: Any) -> Dict[str, Any]:
        tool_calls = []
        for tc in getattr(message, "tool_calls", None) or []:
            tool_calls.append(
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    },
                }
            )
        payload: Dict[str, Any] = {
            "role": "assistant",
            "content": getattr(message, "content", None) or "",
        }
        if tool_calls:
            payload["tool_calls"] = tool_calls
        return payload

    @staticmethod
    def _json_loads(value: str) -> Dict[str, Any]:
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}

    def _find_finish_payload(self, tool_calls: Iterable[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        for tc in tool_calls:
            if tc.get("function", {}).get("name") == FINISH_TOOL_NAME:
                return self._json_loads(tc.get("function", {}).get("arguments") or "{}")
        return None

    def _find_finish_tool_call(self, tool_calls: Iterable[Dict[str, Any]]) -> tuple[str, Optional[Dict[str, Any]]]:
        for tc in tool_calls:
            if tc.get("function", {}).get("name") == FINISH_TOOL_NAME:
                return str(tc.get("id", "")), self._json_loads(tc.get("function", {}).get("arguments") or "{}")
        return "", None

    def _record_coverage_from_tool_result(self, coverage_state: Dict[str, Set[str]], result: ToolResultRecord) -> None:
        if not result.ok or not isinstance(result.data, dict):
            return
        data = result.data
        if result.name == GLOB_TOOL_NAME:
            for item in data.get("files", []) or []:
                source = self._source_name(item.get("rel_path") or item.get("path"))
                if source:
                    coverage_state["candidate_sources"].add(source)
            return

        if result.name == GREP_TOOL_NAME:
            mode = str(data.get("mode") or "")
            matched_files = int(data.get("matched_files") or 0)
            high_signal = mode == "content" or (0 < matched_files <= 5)
            for payload in (data.get("counts") or {}).values():
                if isinstance(payload, dict):
                    source = self._source_name(payload.get("rel_path"))
                    if source:
                        coverage_state["matched_sources"].add(source)
                        if high_signal:
                            coverage_state["high_signal_sources"].add(source)
            for match in data.get("matches", []) or []:
                if isinstance(match, dict):
                    source = self._source_name(match.get("rel_path") or match.get("path"))
                    if source:
                        coverage_state["matched_sources"].add(source)
                        if mode == "content":
                            coverage_state["high_signal_sources"].add(source)
                            ref = self._source_page_ref(source, match.get("page"))
                            if ref:
                                coverage_state["high_signal_refs"].add(ref)
                        elif high_signal:
                            coverage_state["high_signal_sources"].add(source)
            return

        if result.name == READ_TOOL_NAME:
            source = self._source_name(data.get("path"))
            if source:
                coverage_state["inspected_sources"].add(source)
                pages = data.get("pages") or []
                if pages:
                    for page in pages:
                        ref = self._source_page_ref(source, page)
                        if ref:
                            coverage_state["inspected_refs"].add(ref)
                else:
                    coverage_state["inspected_refs"].add(source)

    def _validate_finish_payload(self, payload: Dict[str, Any], coverage_state: Dict[str, Set[str]]) -> Optional[str]:
        if self.config.enforce_minimum_reliability:
            minimum_rejection = self._validate_minimum_finish_reliability(payload, coverage_state)
            if minimum_rejection:
                return minimum_rejection

        if not self.config.enforce_finish_coverage:
            return None

        coverage = payload.get("coverage")
        if not isinstance(coverage, dict):
            return self._finish_rejection_message(
                f"{FINISH_TOOL_NAME} is missing coverage. Include searched_patterns, inspected_sources, "
                "relevant_uninspected_sources, and stopping_rationale.",
                coverage_state,
            )

        required = ("searched_patterns", "inspected_sources", "relevant_uninspected_sources", "stopping_rationale")
        missing = [key for key in required if key not in coverage]
        if missing:
            return self._finish_rejection_message(
                f"{FINISH_TOOL_NAME}.coverage is missing required field(s): {', '.join(missing)}.",
                coverage_state,
            )

        declared_inspected = {self._source_name(item) for item in coverage.get("inspected_sources", []) or []}
        declared_uninspected = {
            self._source_name(item) for item in coverage.get("relevant_uninspected_sources", []) or []
        }
        declared_inspected.discard("")
        declared_uninspected.discard("")
        actual_inspected = coverage_state.get("inspected_sources", set())

        unsupported_inspected = [
            source
            for source in sorted(declared_inspected)
            if not self._source_is_covered(source, actual_inspected)
        ]
        if unsupported_inspected:
            shown = unsupported_inspected[:12]
            suffix = f" and {len(unsupported_inspected) - len(shown)} more" if len(unsupported_inspected) > len(shown) else ""
            return self._finish_rejection_message(
                f"{FINISH_TOOL_NAME}.coverage.inspected_sources includes sources that were not inspected with "
                f"{READ_TOOL_NAME} in this loop: {', '.join(shown)}{suffix}. Read the source context before "
                "listing it as inspected, or move it to relevant_uninspected_sources with rationale.",
                coverage_state,
            )

        unresolved = [
            source
            for source in sorted(coverage_state.get("high_signal_sources", set()))
            if not self._source_is_covered(source, actual_inspected | declared_uninspected)
        ]
        if unresolved:
            shown = unresolved[:12]
            suffix = f" and {len(unresolved) - len(shown)} more" if len(unresolved) > len(shown) else ""
            return self._finish_rejection_message(
                "High-signal searches found matched sources that are neither inspected nor listed as "
                f"relevant_uninspected_sources: {', '.join(shown)}{suffix}. Inspect the high-signal sources with "
                f"{READ_TOOL_NAME}, or list uninspected sources with rationale and lower confidence.",
                coverage_state,
            )

        unresolved_refs = [
            ref
            for ref in sorted(coverage_state.get("high_signal_refs", set()))
            if not self._ref_is_covered(ref, coverage_state.get("inspected_refs", set()), declared_uninspected)
        ]
        if unresolved_refs:
            shown = unresolved_refs[:12]
            suffix = (
                f" and {len(unresolved_refs) - len(shown)} more"
                if len(unresolved_refs) > len(shown)
                else ""
            )
            return self._finish_rejection_message(
                f"High-signal searches found matched source pages that are not covered by {READ_TOOL_NAME} and are not "
                f"listed as relevant_uninspected_sources: {', '.join(shown)}{suffix}. Read the matched pages or list "
                "the source as uninspected with rationale and lower confidence.",
                coverage_state,
            )

        confidence = str(payload.get("confidence") or "").lower()
        if confidence == "high" and declared_uninspected:
            return self._finish_rejection_message(
                "High confidence is not allowed while relevant_uninspected_sources is non-empty.",
                coverage_state,
            )
        return None

    def _validate_minimum_finish_reliability(
        self,
        payload: Dict[str, Any],
        coverage_state: Dict[str, Set[str]],
    ) -> Optional[str]:
        answer = str(payload.get("answer") or "").strip()
        evidence = payload.get("evidence")
        if not isinstance(evidence, list):
            evidence = []

        if answer and not evidence:
            return self._finish_rejection_message(
                f"{FINISH_TOOL_NAME}.answer is non-empty but evidence is empty. Include direct evidence "
                f"from {READ_TOOL_NAME} with path and quote, or give a limited low-confidence answer with gaps.",
                coverage_state,
            )

        actual_inspected = coverage_state.get("inspected_sources", set())
        evidence_sources: Set[str] = set()
        for index, item in enumerate(evidence, start=1):
            if not isinstance(item, dict):
                return self._finish_rejection_message(
                    f"{FINISH_TOOL_NAME}.evidence[{index}] must be an object with path, quote, and why_relevant.",
                    coverage_state,
                )
            path = str(item.get("path") or "").strip()
            quote = str(item.get("quote") or "").strip()
            why_relevant = str(item.get("why_relevant") or "").strip()
            if not path or not quote:
                return self._finish_rejection_message(
                    f"{FINISH_TOOL_NAME}.evidence[{index}] is missing path or quote. Final claims need exact "
                    "source text from inspected context.",
                    coverage_state,
                )
            if not why_relevant:
                return self._finish_rejection_message(
                    f"{FINISH_TOOL_NAME}.evidence[{index}] is missing why_relevant. State which claim, number, "
                    "period, basis, or input the quote supports.",
                    coverage_state,
                )
            source = self._source_name(path)
            if source:
                evidence_sources.add(source)

        unsupported_evidence = [
            source
            for source in sorted(evidence_sources)
            if not self._source_is_covered(source, actual_inspected)
        ]
        if unsupported_evidence:
            shown = unsupported_evidence[:12]
            suffix = f" and {len(unsupported_evidence) - len(shown)} more" if len(unsupported_evidence) > len(shown) else ""
            return self._finish_rejection_message(
                f"{FINISH_TOOL_NAME}.evidence cites sources that were not inspected with {READ_TOOL_NAME} "
                f"in this loop: {', '.join(shown)}{suffix}. Use {READ_TOOL_NAME} for exact source context "
                "before citing evidence.",
                coverage_state,
            )

        coverage = payload.get("coverage")
        if not isinstance(coverage, dict):
            return self._finish_rejection_message(
                f"{FINISH_TOOL_NAME} is missing coverage. Include at least inspected_sources, "
                "relevant_uninspected_sources, and stopping_rationale.",
                coverage_state,
            )

        declared_inspected = {self._source_name(item) for item in coverage.get("inspected_sources", []) or []}
        declared_uninspected = {
            self._source_name(item) for item in coverage.get("relevant_uninspected_sources", []) or []
        }
        declared_inspected.discard("")
        declared_uninspected.discard("")
        unsupported_inspected = [
            source
            for source in sorted(declared_inspected)
            if not self._source_is_covered(source, actual_inspected)
        ]
        if unsupported_inspected:
            shown = unsupported_inspected[:12]
            suffix = f" and {len(unsupported_inspected) - len(shown)} more" if len(unsupported_inspected) > len(shown) else ""
            return self._finish_rejection_message(
                f"{FINISH_TOOL_NAME}.coverage.inspected_sources includes sources that were not inspected with "
                f"{READ_TOOL_NAME} in this loop: {', '.join(shown)}{suffix}. Read the source context before "
                "listing it as inspected, or move it to relevant_uninspected_sources with rationale.",
                coverage_state,
            )

        confidence = str(payload.get("confidence") or "").lower()
        if confidence == "high" and declared_uninspected:
            return self._finish_rejection_message(
                "High confidence is not allowed while relevant_uninspected_sources is non-empty.",
                coverage_state,
            )

        return None

    def _with_default_coverage(self, payload: Dict[str, Any], coverage_state: Dict[str, Set[str]]) -> Dict[str, Any]:
        if isinstance(payload.get("coverage"), dict):
            return payload
        updated = dict(payload)
        updated["coverage"] = {
            "searched_patterns": [],
            "inspected_sources": sorted(coverage_state.get("inspected_sources", set())),
            "relevant_uninspected_sources": sorted(
                coverage_state.get("high_signal_sources", set()) - coverage_state.get("inspected_sources", set())
            ),
            "stopping_rationale": f"Coverage was reconstructed by the loop because {FINISH_TOOL_NAME} omitted coverage.",
        }
        return updated

    def _finish_rejection_message(self, reason: str, coverage_state: Dict[str, Set[str]]) -> str:
        snapshot = {
            "candidate_sources": sorted(coverage_state.get("candidate_sources", set()))[:20],
            "matched_sources": sorted(coverage_state.get("matched_sources", set()))[:20],
            "high_signal_sources": sorted(coverage_state.get("high_signal_sources", set()))[:20],
            "high_signal_refs": sorted(coverage_state.get("high_signal_refs", set()))[:20],
            "inspected_sources": sorted(coverage_state.get("inspected_sources", set()))[:20],
            "inspected_refs": sorted(coverage_state.get("inspected_refs", set()))[:20],
        }
        return (
            "<finish_rejected>\n"
            f"{reason}\n\n"
            "Coverage snapshot from executed tools:\n"
            f"{json.dumps(snapshot, ensure_ascii=False, indent=2)}\n\n"
            f"Continue searching if needed, then call {FINISH_TOOL_NAME} again with complete coverage. "
            f"When several unresolved sources can be checked independently, issue those {READ_TOOL_NAME} or {GREP_TOOL_NAME} "
            "calls together in the next assistant turn instead of one source per turn. "
            "If a matched source is not relevant, list it under relevant_uninspected_sources with a short reason "
            "instead of ignoring it.\n"
            "</finish_rejected>"
        )

    def _source_name(self, value: Any) -> str:
        if value is None:
            return ""
        text = str(value).strip()
        if not text:
            return ""
        try:
            path = Path(text)
            if path.is_absolute():
                return self.corpus.relative_path(path)
        except Exception:
            pass
        return text.replace("\\", "/")

    @staticmethod
    def _source_page_ref(source: str, page: Any) -> str:
        if not source or page in (None, ""):
            return ""
        try:
            page_number = int(page)
        except (TypeError, ValueError):
            return ""
        if page_number <= 0:
            return ""
        return f"{source}#p{page_number}"

    def _ref_is_covered(self, ref: str, inspected_refs: Set[str], uninspected_sources: Set[str]) -> bool:
        source = ref.split("#p", 1)[0]
        if ref in inspected_refs or source in inspected_refs:
            return True
        return self._source_is_covered(source, uninspected_sources)

    @staticmethod
    def _source_is_covered(source: str, refs: Set[str]) -> bool:
        source_name = Path(source).name
        for ref in refs:
            if not ref:
                continue
            if source == ref or source.endswith("/" + ref) or ref.endswith("/" + source):
                return True
            if AgenticSearchLoop._sources_are_filing_companions(source, ref):
                return True
            if source in ref or ref in source:
                return True
            if source_name and source_name == Path(ref).name:
                return True
            if source_name and source_name in ref:
                return True
        return False

    @staticmethod
    def _sources_are_filing_companions(left: str, right: str) -> bool:
        left_path = Path(str(left).replace("\\", "/").split("#", 1)[0])
        right_path = Path(str(right).replace("\\", "/").split("#", 1)[0])
        companion_exts = {".pdf", ".json"}
        if left_path.suffix.lower() not in companion_exts or right_path.suffix.lower() not in companion_exts:
            return False
        if left_path.suffix.lower() == right_path.suffix.lower():
            return False
        return left_path.stem == right_path.stem

    def _finish_tool_schemas(self) -> List[Dict[str, Any]]:
        return [schema for schema in self._tool_schemas() if schema.get("function", {}).get("name") == FINISH_TOOL_NAME]

    @staticmethod
    def _json_loads_maybe(value: str) -> Optional[Dict[str, Any]]:
        if not value.strip():
            return None
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            return None

    @staticmethod
    def _stream_chunk_delta_to_dict(chunk: Any) -> Dict[str, Any]:
        choice = (getattr(chunk, "choices", None) or [None])[0]
        if choice is None and isinstance(chunk, dict):
            choices = chunk.get("choices") or [None]
            choice = choices[0]
        delta = getattr(choice, "delta", None)
        if delta is None and isinstance(choice, dict):
            delta = choice.get("delta") or {}

        content = AgenticSearchLoop._get_attr_or_key(delta, "content")
        raw_tool_calls = AgenticSearchLoop._get_attr_or_key(delta, "tool_calls") or []
        tool_calls: List[Dict[str, Any]] = []
        for raw in raw_tool_calls:
            function = AgenticSearchLoop._get_attr_or_key(raw, "function") or {}
            tool_calls.append(
                {
                    "index": AgenticSearchLoop._get_attr_or_key(raw, "index") or 0,
                    "id": AgenticSearchLoop._get_attr_or_key(raw, "id") or "",
                    "type": AgenticSearchLoop._get_attr_or_key(raw, "type") or "function",
                    "function": {
                        "name": AgenticSearchLoop._get_attr_or_key(function, "name") or "",
                        "arguments": AgenticSearchLoop._get_attr_or_key(function, "arguments") or "",
                    },
                }
            )
        return {"content": content or "", "tool_calls": tool_calls}

    @staticmethod
    def _get_attr_or_key(value: Any, key: str) -> Any:
        if isinstance(value, dict):
            return value.get(key)
        return getattr(value, key, None)

    @staticmethod
    def _apply_tool_call_delta(
        streamed_tool_calls: Dict[int, StreamedToolCall],
        tool_delta: Dict[str, Any],
    ) -> StreamedToolCall:
        index = int(tool_delta.get("index") or 0)
        call_state = streamed_tool_calls.get(index)
        if call_state is None:
            call_state = StreamedToolCall(index=index)
            streamed_tool_calls[index] = call_state
        if tool_delta.get("id"):
            call_state.tool_call_id = str(tool_delta["id"])
        function_delta = tool_delta.get("function", {}) or {}
        if function_delta.get("name"):
            call_state.name = str(function_delta["name"])
        if function_delta.get("arguments"):
            call_state.arguments_buffer += str(function_delta["arguments"])
        return call_state


def run_search_sync(loop: AgenticSearchLoop, question: str, extra_context: Optional[str] = None) -> AgenticSearchResult:
    return asyncio.run(loop.arun_search(question, extra_context))
