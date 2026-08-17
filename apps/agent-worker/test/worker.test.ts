import {
  ParentToolRpcClient,
} from "@private-fund/agent-runtime";
import { FakeHarness } from "@private-fund/agent-runtime/testing";
import {
  AGENT_TOOL_PROTOCOL_VERSION,
  type AgentWorkerMessage,
} from "@private-fund/contracts";
import { describe, expect, it, vi } from "vitest";

import { AgentWorkerCommandProcessor } from "../src/worker.js";

const tenant = {
  userId: "user@example.com",
  dataNamespace: "0b2ca3f8-a4b8-4c04-b23b-f50d4bea46a7",
};

function startCommand() {
  return {
    type: "session.start" as const,
    requestId: "request-start",
    sessionId: "session-1",
    projectId: "project-1",
    tenant,
    workspace: "/tmp/project-1",
    sessionFile: "/tmp/session-1.jsonl",
  };
}

describe("AgentWorkerCommandProcessor", () => {
  it("runs the full session lifecycle and acknowledges before interrupt event", async () => {
    const harness = new FakeHarness({ autoCompletePrompts: false });
    const messages: AgentWorkerMessage[] = [];
    const processor = new AgentWorkerCommandProcessor(harness, (message) =>
      messages.push(message),
    );

    await processor.handle(startCommand());
    await processor.handle({
      type: "session.prompt",
      requestId: "request-prompt",
      sessionId: "session-1",
      operationId: "operation-1",
      content: "Analyze revenue",
    });
    harness.emit("session-1", "message.assistant.delta", {
      delta: "Revenue",
    });
    await processor.handle({
      type: "session.steer",
      requestId: "request-steer",
      sessionId: "session-1",
      content: "Focus on recurring revenue",
    });
    await processor.handle({
      type: "session.interrupt",
      requestId: "request-interrupt",
      sessionId: "session-1",
    });
    await processor.handle({
      type: "session.dispose",
      requestId: "request-dispose",
      sessionId: "session-1",
    });

    expect(
      messages.filter((message) => message.type === "command.result"),
    ).toEqual([
      { type: "command.result", requestId: "request-start", ok: true },
      { type: "command.result", requestId: "request-prompt", ok: true },
      { type: "command.result", requestId: "request-steer", ok: true },
      { type: "command.result", requestId: "request-interrupt", ok: true },
      { type: "command.result", requestId: "request-dispose", ok: true },
    ]);
    const interruptAcknowledgementIndex = messages.findIndex(
      (message) =>
        message.type === "command.result" &&
        message.requestId === "request-interrupt",
    );
    const interruptEventIndex = messages.findIndex(
      (message) =>
        message.type === "agent.event" &&
        message.eventType === "operation.interrupted",
    );
    expect(interruptEventIndex).toBeGreaterThan(
      interruptAcknowledgementIndex,
    );
    expect(harness.hasSession("session-1")).toBe(false);
  });

  it("reports asynchronous prompt failures as operation events", async () => {
    const harness = new FakeHarness({ autoCompletePrompts: false });
    const messages: AgentWorkerMessage[] = [];
    const modelToken = `pfm_${"w".repeat(48)}`;
    const processor = new AgentWorkerCommandProcessor(harness, (message) =>
      messages.push(message),
    );

    await processor.handle(startCommand());
    await processor.handle({
      type: "session.prompt",
      requestId: "request-prompt",
      sessionId: "session-1",
      operationId: "operation-1",
      content: "Analyze",
    });
    harness.failPrompt(
      "session-1",
      new Error(
        `402 insufficient_available_balance Bearer ${modelToken}`,
      ),
    );

    await vi.waitFor(() => {
      expect(messages).toContainEqual({
        type: "agent.event",
        sessionId: "session-1",
        operationId: "operation-1",
        eventType: "operation.failed",
        payload: {
          error: "402 insufficient_available_balance Bearer [REDACTED]",
        },
      });
    });
    const failures = messages.filter(
      (message) =>
        message.type === "agent.event" &&
        message.eventType === "operation.failed",
    );
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures)).not.toContain(modelToken);
  });

  it("acknowledges explicit session compaction without blocking on completion", async () => {
    const harness = new FakeHarness();
    const messages: AgentWorkerMessage[] = [];
    const processor = new AgentWorkerCommandProcessor(harness, (message) =>
      messages.push(message),
    );

    await processor.handle(startCommand());
    await processor.handle({
      type: "session.compact",
      requestId: "request-compact",
      sessionId: "session-1",
      customInstructions: "Retain cited evidence",
    });

    expect(harness.calls).toContainEqual({
      type: "compact",
      sessionId: "session-1",
      customInstructions: "Retain cited evidence",
    });
    expect(messages).toContainEqual({
      type: "command.result",
      requestId: "request-compact",
      ok: true,
    });
  });

  it("rejects malformed commands without invoking the harness", async () => {
    const harness = new FakeHarness();
    const messages: AgentWorkerMessage[] = [];
    const processor = new AgentWorkerCommandProcessor(harness, (message) =>
      messages.push(message),
    );

    await processor.handle({
      type: "session.prompt",
      requestId: "request-invalid",
    });

    expect(harness.calls).toEqual([]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(
      expect.objectContaining({
        type: "worker.error",
      }),
    );
  });

  it("settles a correlated parent tool result without command acknowledgement", async () => {
    const harness = new FakeHarness();
    const messages: AgentWorkerMessage[] = [];
    const parentToolRpc = new ParentToolRpcClient({
      requestIdFactory: () => "tool-request-1",
      send: (message) => messages.push(message),
    });
    const processor = new AgentWorkerCommandProcessor(
      harness,
      (message) => messages.push(message),
      parentToolRpc,
    );
    const pending = parentToolRpc.request({
      sessionId: "session-1",
      toolCallId: "call-1",
      tool: "job.get",
      arguments: {
        jobId: "job-1",
      },
    });

    await processor.handle({
      type: "tool.result",
      protocolVersion: AGENT_TOOL_PROTOCOL_VERSION,
      requestId: "tool-request-1",
      sessionId: "session-1",
      toolCallId: "call-1",
      tool: "job.get",
      ok: true,
      result: {
        jobId: "job-1",
        type: "memo.generate",
        status: "running",
        progress: 0.5,
        resultSummary: null,
        error: null,
      },
    });

    await expect(pending).resolves.toEqual({
      requestId: "tool-request-1",
      result: {
        jobId: "job-1",
        type: "memo.generate",
        status: "running",
        progress: 0.5,
        resultSummary: null,
        error: null,
      },
    });
    expect(
      messages.some(
        (message) =>
          message.type === "command.result" &&
          message.requestId === "tool-request-1",
      ),
    ).toBe(false);
  });

  it("reports a malicious correlation mismatch and keeps the request pending", async () => {
    const harness = new FakeHarness();
    const messages: AgentWorkerMessage[] = [];
    const parentToolRpc = new ParentToolRpcClient({
      requestIdFactory: () => "tool-request-1",
      send: (message) => messages.push(message),
    });
    const processor = new AgentWorkerCommandProcessor(
      harness,
      (message) => messages.push(message),
      parentToolRpc,
    );
    const pending = parentToolRpc.request({
      sessionId: "session-1",
      toolCallId: "call-1",
      tool: "job.get",
      arguments: {
        jobId: "job-1",
      },
    });

    await processor.handle({
      type: "tool.result",
      protocolVersion: AGENT_TOOL_PROTOCOL_VERSION,
      requestId: "tool-request-1",
      sessionId: "session-other",
      toolCallId: "call-1",
      tool: "job.get",
      ok: true,
      result: {
        jobId: "job-1",
        type: "memo.generate",
        status: "running",
        progress: 0.5,
        resultSummary: null,
        error: null,
      },
    });

    expect(parentToolRpc.pendingCount).toBe(1);
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "worker.error",
        error: expect.stringContaining("correlation mismatch"),
      }),
    );

    await processor.handle({
      type: "tool.result",
      protocolVersion: AGENT_TOOL_PROTOCOL_VERSION,
      requestId: "tool-request-1",
      sessionId: "session-1",
      toolCallId: "call-1",
      tool: "job.get",
      ok: true,
      result: {
        jobId: "job-1",
        type: "memo.generate",
        status: "completed",
        progress: 1,
        resultSummary: "Done",
        error: null,
      },
    });
    await pending;
  });

  it("cancels pending parent RPC calls when a session is disposed", async () => {
    const harness = new FakeHarness();
    const messages: AgentWorkerMessage[] = [];
    const parentToolRpc = new ParentToolRpcClient({
      requestIdFactory: () => "tool-request-1",
      send: (message) => messages.push(message),
    });
    const processor = new AgentWorkerCommandProcessor(
      harness,
      (message) => messages.push(message),
      parentToolRpc,
    );
    await processor.handle(startCommand());
    const pending = parentToolRpc.request({
      sessionId: "session-1",
      toolCallId: "call-1",
      tool: "evidence.get",
      arguments: {
        evidenceIds: ["evidence-1"],
      },
    });
    const cancelled = expect(pending).rejects.toMatchObject({
      reason: "session_disposed",
    });

    await processor.handle({
      type: "session.dispose",
      requestId: "request-dispose",
      sessionId: "session-1",
    });

    await cancelled;
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "tool.cancel",
        requestId: "tool-request-1",
        reason: "session_disposed",
      }),
    );
  });
});
