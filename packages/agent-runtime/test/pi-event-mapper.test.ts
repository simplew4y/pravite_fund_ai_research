import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { agentWorkerMessageSchema } from "@private-fund/contracts";
import { describe, expect, it } from "vitest";

import { mapPiEventToWorkerMessages } from "../src/pi-event-mapper.js";

const context = {
  sessionId: "session-1",
  operationId: "operation-1",
};

describe("mapPiEventToWorkerMessages", () => {
  it("maps assistant text deltas to the canonical worker event", () => {
    const event = {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "hello",
        partial: { role: "assistant" },
      },
    } as unknown as AgentSessionEvent;

    const messages = mapPiEventToWorkerMessages(event, context);

    expect(messages).toEqual([
      {
        type: "agent.event",
        sessionId: "session-1",
        operationId: "operation-1",
        eventType: "message.assistant.delta",
        payload: {
          delta: "hello",
          contentIndex: 0,
        },
      },
    ]);
    expect(agentWorkerMessageSchema.safeParse(messages[0]).success).toBe(true);
  });

  it("maps failed tool executions without leaking non-IPC values", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const event = {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "dataset_search",
      result: circular,
      isError: true,
    } as AgentSessionEvent;

    const messages = mapPiEventToWorkerMessages(event, context);

    expect(messages[0]?.eventType).toBe("tool.failed");
    expect(messages[0]?.payload["result"]).toEqual({
      self: "[circular]",
    });
    expect(agentWorkerMessageSchema.safeParse(messages[0]).success).toBe(true);
  });

  it("emits assistant completion and usage events", () => {
    const usage = {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    };
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        usage,
      },
    } as unknown as AgentSessionEvent;

    const messages = mapPiEventToWorkerMessages(event, context);

    expect(messages.map((message) => message.eventType)).toEqual([
      "message.assistant.completed",
      "usage.updated",
    ]);
    expect(messages[1]?.payload["usage"]).toEqual(usage);
  });
});
