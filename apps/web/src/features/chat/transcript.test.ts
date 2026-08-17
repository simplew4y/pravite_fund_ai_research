import type { SessionEvent } from "@private-fund/contracts";
import { describe, expect, it } from "vitest";

import { emptyTranscript, reduceAll } from "./transcript";

let sequence = 0;

function event(type: string, payload: Record<string, unknown>): SessionEvent {
  sequence += 1;
  return {
    sessionId: "s-1",
    sequence,
    type,
    timestamp: "2026-08-18T00:00:00.000Z",
    operationId: "op-1",
    payload,
  };
}

describe("reduceTranscript", () => {
  it("folds a full turn into user + assistant messages", () => {
    const result = reduceAll(emptyTranscript, [
      event("message.user", {
        message: { role: "user", content: [{ type: "text", text: "集采影响？" }] },
      }),
      event("message.thinking.delta", { delta: "先定位品种" }),
      event("tool.started", { toolCallId: "t1", toolName: "corpus.search" }),
      event("tool.completed", { toolCallId: "t1", toolName: "corpus.search", isError: false }),
      event("message.assistant.delta", { delta: "毛利率下行 " }),
      event("message.assistant.delta", { delta: "1.8–3.4pp" }),
      event("message.assistant.completed", {
        message: { role: "assistant", content: [{ type: "text", text: "毛利率下行 1.8–3.4pp" }] },
      }),
      event("operation.completed", {}),
    ]);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({ kind: "user", text: "集采影响？" });
    expect(result.messages[1]).toMatchObject({
      kind: "assistant",
      text: "毛利率下行 1.8–3.4pp",
      thinking: "先定位品种",
      completed: true,
    });
    expect(result.messages[1]!.tools).toEqual([
      { toolCallId: "t1", toolName: "corpus.search", status: "completed" },
    ]);
    expect(result.running).toBe(false);
    expect(result.lastSequence).toBe(sequence);
  });

  it("ignores duplicate sequences on replay", () => {
    const first = event("message.assistant.delta", { delta: "a" });
    const state = reduceAll(emptyTranscript, [first, first]);
    expect(state.messages[0]!.text).toBe("a");
  });

  it("marks failed tools", () => {
    const state = reduceAll(emptyTranscript, [
      event("tool.started", { toolCallId: "t2", toolName: "excel.read" }),
      event("tool.failed", { toolCallId: "t2", toolName: "excel.read", isError: true }),
    ]);
    expect(state.messages[0]!.tools[0]).toMatchObject({ status: "failed" });
  });

  it("renders user messages written by the control plane ({content})", () => {
    // apps/api writes {content, clientMessageId}; the agent loop writes {message}.
    const state = reduceAll(emptyTranscript, [
      event("message.user", {
        content: "集采影响？",
        clientMessageId: "msg-1",
      }),
    ]);
    expect(state.messages[0]).toMatchObject({ kind: "user", text: "集采影响？" });
  });

  it("surfaces turn failures and tool failure detail", () => {
    const state = reduceAll(emptyTranscript, [
      event("tool.started", { toolCallId: "t9", toolName: "evidence.search" }),
      event("tool.failed", {
        toolCallId: "t9",
        toolName: "evidence.search",
        result: { error: "index missing" },
        isError: true,
      }),
      event("operation.failed", { error: "Model endpoint returned 402" }),
    ]);
    expect(state.messages[0]!.tools[0]).toMatchObject({
      status: "failed",
      error: "index missing",
    });
    expect(state.error).toBe("Model endpoint returned 402");
    expect(state.running).toBe(false);
  });
});
