"""Tests for runner-local timer tool dispatch."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from omnigent.runner.tool_dispatch import execute_tool


class _TimerPostRecorder:
    """
    ``httpx.MockTransport`` handler that records timer wake POSTs.

    The ``posts`` attribute stores dictionaries with ``url``,
    ``method``, ``json``, and ``headers`` keys, e.g.
    ``{"url": "/v1/sessions/...", "method": "POST"}``.
    """

    def __init__(self) -> None:
        """Initialize an empty call log."""
        self.posts: list[dict[str, Any]] = []
        self.post_seen = asyncio.Event()

    async def __call__(
        self,
        request: httpx.Request,
    ) -> httpx.Response:
        """
        Record a timer wake request and return an accepted response.

        :param request: HTTPX request, e.g. POST to
            ``"/v1/sessions/conv_x/events"``.
        :returns: HTTP 202 response matching the session event endpoint.
        """
        self.posts.append(
            {
                "url": request.url.path,
                "method": request.method,
                "json": json.loads(request.content),
                "headers": dict(request.headers),
            }
        )
        self.post_seen.set()
        return httpx.Response(202, json={"queued": True})


@pytest.mark.asyncio
async def test_timer_firing_posts_hidden_meta_message() -> None:
    """
    Timer firings wake the agent but stay hidden from user-facing UI.

    The timer POST must remain a ``role="user"`` message so the
    sessions event path starts or steers the next turn. Marking it
    ``is_meta=True`` is what makes existing web/TUI transcript
    rendering skip the synthetic ``[System: timer ... fired]`` row.
    """
    recorder = _TimerPostRecorder()
    transport = httpx.MockTransport(recorder)

    async with httpx.AsyncClient(transport=transport, base_url="http://server") as server_client:
        output = await execute_tool(
            tool_name="sys_timer_set",
            arguments=json.dumps({"seconds": 0, "note": "check build"}),
            conversation_id="conv_parent",
            server_client=server_client,
        )

        result = json.loads(output)
        assert result["status"] == "scheduled"
        assert isinstance(result["timer_id"], str)

        await asyncio.wait_for(recorder.post_seen.wait(), timeout=1.0)

    # A non-repeating timer should produce exactly one wake POST:
    # zero means the firing never reached AP, more than one means it
    # accidentally behaved like a repeating timer.
    assert len(recorder.posts) == 1
    post = recorder.posts[0]
    assert post["method"] == "POST"
    assert post["url"] == "/v1/sessions/conv_parent/events"
    payload = post["json"]
    assert payload == {
        "type": "message",
        "data": {
            "role": "user",
            "is_meta": True,
            "content": [
                {
                    "type": "input_text",
                    "text": f"[System: timer {result['timer_id']} fired]\nnote: 'check build'",
                }
            ],
        },
    }


@pytest.mark.asyncio
async def test_repeating_timer_cancel_stops_future_firings() -> None:
    """A repeating timer stops immediately after a same-session cancel."""
    recorder = _TimerPostRecorder()
    transport = httpx.MockTransport(recorder)

    async with httpx.AsyncClient(transport=transport, base_url="http://server") as server_client:
        output = await execute_tool(
            tool_name="sys_timer_set",
            arguments=json.dumps({"seconds": 0.05, "repeat": True, "note": "repeat"}),
            conversation_id="conv_repeat",
            server_client=server_client,
        )
        result = json.loads(output)
        await asyncio.wait_for(recorder.post_seen.wait(), timeout=1.0)

        cancelled = json.loads(
            await execute_tool(
                tool_name="sys_timer_cancel",
                arguments=json.dumps({"timer_id": result["timer_id"]}),
                conversation_id="conv_repeat",
                server_client=server_client,
            )
        )
        count_at_cancel = len(recorder.posts)
        await asyncio.sleep(0.15)

    assert cancelled == {"timer_id": result["timer_id"], "status": "cancelled"}
    assert count_at_cancel == 1
    assert len(recorder.posts) == count_at_cancel


@pytest.mark.asyncio
async def test_timer_cancel_is_scoped_to_owning_session() -> None:
    """One session cannot cancel another session's active timer."""
    recorder = _TimerPostRecorder()
    transport = httpx.MockTransport(recorder)

    async with httpx.AsyncClient(transport=transport, base_url="http://server") as server_client:
        output = await execute_tool(
            tool_name="sys_timer_set",
            arguments=json.dumps({"seconds": 30, "repeat": False}),
            conversation_id="conv_owner",
            server_client=server_client,
        )
        timer_id = json.loads(output)["timer_id"]

        wrong_session = json.loads(
            await execute_tool(
                tool_name="sys_timer_cancel",
                arguments=json.dumps({"timer_id": timer_id}),
                conversation_id="conv_other",
                server_client=server_client,
            )
        )
        owner = json.loads(
            await execute_tool(
                tool_name="sys_timer_cancel",
                arguments=json.dumps({"timer_id": timer_id}),
                conversation_id="conv_owner",
                server_client=server_client,
            )
        )

    assert wrong_session == {"timer_id": timer_id, "status": "not_found"}
    assert owner == {"timer_id": timer_id, "status": "cancelled"}
    assert recorder.posts == []


@pytest.mark.asyncio
async def test_completed_one_shot_timer_cannot_fire_or_cancel_twice() -> None:
    """A one-shot timer unregisters after its single hidden wake event."""
    recorder = _TimerPostRecorder()
    transport = httpx.MockTransport(recorder)

    async with httpx.AsyncClient(transport=transport, base_url="http://server") as server_client:
        output = await execute_tool(
            tool_name="sys_timer_set",
            arguments=json.dumps({"seconds": 0, "note": "once"}),
            conversation_id="conv_once",
            server_client=server_client,
        )
        timer_id = json.loads(output)["timer_id"]
        await asyncio.wait_for(recorder.post_seen.wait(), timeout=1.0)
        await asyncio.sleep(0.05)
        cancelled = json.loads(
            await execute_tool(
                tool_name="sys_timer_cancel",
                arguments=json.dumps({"timer_id": timer_id}),
                conversation_id="conv_once",
                server_client=server_client,
            )
        )

    assert len(recorder.posts) == 1
    assert cancelled == {"timer_id": timer_id, "status": "not_found"}
