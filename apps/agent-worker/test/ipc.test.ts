import { EventEmitter } from "node:events";

import { FakeHarness } from "@private-fund/agent-runtime/testing";
import {
  AGENT_TOOL_PROTOCOL_VERSION,
  type AgentWorkerMessage,
} from "@private-fund/contracts";
import { describe, expect, it, vi } from "vitest";

import { installAgentWorkerIpc } from "../src/ipc.js";

class FakeChildProcess extends EventEmitter {
  readonly pid = 4242;
  connected = true;
  exitCode: number | undefined;
  readonly sent: AgentWorkerMessage[] = [];

  send(message: AgentWorkerMessage): boolean {
    this.sent.push(message);
    return true;
  }
}

describe("installAgentWorkerIpc", () => {
  it("announces readiness, parses commands, and shuts down on disconnect", async () => {
    const processRef = new FakeChildProcess();
    const harness = new FakeHarness();
    const controller = installAgentWorkerIpc({
      harness,
      workerId: "worker-test",
      processRef: processRef as unknown as NodeJS.Process,
    });

    expect(processRef.sent[0]).toEqual({
      type: "worker.ready",
      workerId: "worker-test",
    });
    expect(controller.parentToolRpc).toBeUndefined();

    processRef.emit("message", {
      type: "session.start",
      requestId: "request-start",
      sessionId: "session-1",
      projectId: "project-1",
      tenant: {
        userId: "user@example.com",
        dataNamespace: "0b2ca3f8-a4b8-4c04-b23b-f50d4bea46a7",
      },
      workspace: "/tmp/project-1",
      sessionFile: "/tmp/session-1.jsonl",
    });

    await vi.waitFor(() => {
      expect(processRef.sent).toContainEqual({
        type: "command.result",
        requestId: "request-start",
        ok: true,
      });
    });

    processRef.emit("disconnect");
    await controller.stop();

    expect(harness.hasSession("session-1")).toBe(false);
  });

  it("enables parent RPC tools only through the explicit option", async () => {
    const processRef = new FakeChildProcess();
    const controller = installAgentWorkerIpc({
      enableParentRpcTools: true,
      workerId: "worker-rpc",
      processRef: processRef as unknown as NodeJS.Process,
    });
    const parentToolRpc = controller.parentToolRpc;
    if (parentToolRpc === undefined) {
      throw new Error("Parent tool RPC was not enabled");
    }
    const pending = parentToolRpc.request({
      sessionId: "session-1",
      toolCallId: "call-1",
      tool: "job.get",
      arguments: {
        jobId: "job-1",
      },
    });
    expect(processRef.sent).toContainEqual(
      expect.objectContaining({
        type: "tool.request",
        sessionId: "session-1",
        toolCallId: "call-1",
        tool: "job.get",
      }),
    );
    const request = processRef.sent.find(
      (message) => message.type === "tool.request",
    );
    if (request === undefined || request.type !== "tool.request") {
      throw new Error("Tool request was not sent over IPC");
    }

    processRef.emit("message", {
      type: "tool.result",
      protocolVersion: AGENT_TOOL_PROTOCOL_VERSION,
      requestId: request.requestId,
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      tool: request.tool,
      ok: true,
      result: {
        jobId: "job-1",
        type: "memo.generate",
        status: "completed",
        progress: 1,
        resultSummary: "Memo created",
        error: null,
      },
    });

    await expect(pending).resolves.toEqual({
      requestId: request.requestId,
      result: {
        jobId: "job-1",
        type: "memo.generate",
        status: "completed",
        progress: 1,
        resultSummary: "Memo created",
        error: null,
      },
    });
    await controller.stop();
  });

  it("rejects an injected tool registry when the RPC switch is off", () => {
    const processRef = new FakeChildProcess();

    expect(() =>
      installAgentWorkerIpc({
        processRef: processRef as unknown as NodeJS.Process,
        piSessionFactoryOptions: {
          toolRegistry: "untrusted",
        } as never,
      }),
    ).toThrow("explicit RPC-tools switch");
    expect(processRef.sent).toEqual([]);
  });
});
