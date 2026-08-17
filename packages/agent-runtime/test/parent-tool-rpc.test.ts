import {
  AGENT_TOOL_PROTOCOL_VERSION,
  type AgentToolRequestMessage,
} from "@private-fund/contracts";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  ParentToolRpcAbortedError,
  ParentToolRpcProtocolError,
  ParentToolRpcRemoteError,
  ParentToolRpcTimeoutError,
} from "../src/parent-tool-rpc.js";
import { FakeParentToolRpc } from "../src/testing/fake-parent-tool-rpc.js";

function idFactory(): () => string {
  let index = 0;
  return () => {
    index += 1;
    return `request-${index}`;
  };
}

function workspaceListResult(name: string) {
  return {
    items: [
      {
        resourceId: `resource-${name}`,
        name,
        kind: "document",
        version: "version-1",
        size: 100,
        updatedAt: "2026-07-30T12:00:00.000Z",
      },
    ],
    nextCursor: null,
  };
}

function requestWorkspaceList(fake: FakeParentToolRpc, toolCallId: string) {
  return fake.client.request({
    sessionId: "session-1",
    toolCallId,
    tool: "workspace.list",
    arguments: {
      collection: "sources",
      limit: 20,
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ParentToolRpcClient", () => {
  it("correlates concurrent out-of-order results", async () => {
    const fake = new FakeParentToolRpc({
      requestIdFactory: idFactory(),
    });
    const first = requestWorkspaceList(fake, "call-1");
    const second = requestWorkspaceList(fake, "call-2");

    expect(fake.requests.map((request) => request.requestId)).toEqual([
      "request-1",
      "request-2",
    ]);

    fake.respondSuccess("request-2", workspaceListResult("Second"));
    fake.respondSuccess("request-1", workspaceListResult("First"));

    await expect(first).resolves.toEqual({
      requestId: "request-1",
      result: workspaceListResult("First"),
    });
    await expect(second).resolves.toEqual({
      requestId: "request-2",
      result: workspaceListResult("Second"),
    });
    expect(fake.client.pendingCount).toBe(0);
  });

  it("times out, emits cancellation, ignores a late result, and recovers", async () => {
    vi.useFakeTimers();
    const fake = new FakeParentToolRpc({
      timeoutMs: 50,
      requestIdFactory: idFactory(),
      now: () => Date.now(),
    });
    const first = requestWorkspaceList(fake, "call-1");
    const firstTimedOut = expect(first).rejects.toBeInstanceOf(
      ParentToolRpcTimeoutError,
    );

    await vi.advanceTimersByTimeAsync(50);
    await firstTimedOut;
    expect(fake.cancellations).toEqual([
      expect.objectContaining({
        requestId: "request-1",
        reason: "timeout",
      }),
    ]);
    expect(
      fake.respondSuccess("request-1", workspaceListResult("Late")),
    ).toBe("unknown");

    const second = requestWorkspaceList(fake, "call-2");
    fake.respondSuccess("request-2", workspaceListResult("Recovered"));
    await expect(second).resolves.toEqual({
      requestId: "request-2",
      result: workspaceListResult("Recovered"),
    });
  });

  it("cancels an aborted request and removes its listener", async () => {
    const fake = new FakeParentToolRpc({
      requestIdFactory: idFactory(),
    });
    const controller = new AbortController();
    const pending = fake.client.request({
      sessionId: "session-1",
      toolCallId: "call-1",
      tool: "evidence.search",
      arguments: {
        query: "revenue",
      },
      signal: controller.signal,
    });
    const aborted = expect(pending).rejects.toBeInstanceOf(
      ParentToolRpcAbortedError,
    );

    controller.abort();

    await aborted;
    expect(fake.cancellations[0]).toEqual(
      expect.objectContaining({
        requestId: "request-1",
        reason: "aborted",
      }),
    );
    expect(fake.client.pendingCount).toBe(0);
  });

  it("does not settle a request from a correlation-mismatched response", async () => {
    const fake = new FakeParentToolRpc({
      requestIdFactory: idFactory(),
    });
    const pending = requestWorkspaceList(fake, "call-1");

    expect(() =>
      fake.respondSuccess(
        "request-1",
        workspaceListResult("Malicious"),
        { sessionId: "session-other" },
      ),
    ).toThrow(ParentToolRpcProtocolError);
    expect(fake.client.pendingCount).toBe(1);

    fake.respondSuccess("request-1", workspaceListResult("Valid"));
    await expect(pending).resolves.toEqual({
      requestId: "request-1",
      result: workspaceListResult("Valid"),
    });
  });

  it("rejects malformed and over-limit parent payloads without settling", async () => {
    const fake = new FakeParentToolRpc({
      requestIdFactory: idFactory(),
      maxWireBytes: 1_024,
    });
    const pending = requestWorkspaceList(fake, "call-1");
    const request = fake.requestAt(0);

    expect(() =>
      fake.handleRawResult({
        type: "tool.result",
        protocolVersion: AGENT_TOOL_PROTOCOL_VERSION,
        requestId: request.requestId,
        sessionId: request.sessionId,
        toolCallId: request.toolCallId,
        tool: request.tool,
        ok: true,
        result: {
          items: [],
          nextCursor: null,
          path: "/unauthorized",
        },
      }),
    ).toThrow(ParentToolRpcProtocolError);
    expect(() =>
      fake.handleRawResult({
        type: "tool.result",
        protocolVersion: AGENT_TOOL_PROTOCOL_VERSION,
        requestId: request.requestId,
        sessionId: request.sessionId,
        toolCallId: request.toolCallId,
        tool: request.tool,
        ok: true,
        result: {
          items: [],
          nextCursor: "x".repeat(2_000),
        },
      }),
    ).toThrow(ParentToolRpcProtocolError);
    expect(fake.client.pendingCount).toBe(1);

    fake.respondSuccess("request-1", workspaceListResult("Valid"));
    await pending;
  });

  it("propagates structured remote errors", async () => {
    const fake = new FakeParentToolRpc({
      requestIdFactory: idFactory(),
    });
    const pending = fake.client.request({
      sessionId: "session-1",
      toolCallId: "call-1",
      tool: "job.get",
      arguments: {
        jobId: "job-1",
      },
    });
    const remoteError = expect(pending).rejects.toMatchObject({
      name: ParentToolRpcRemoteError.name,
      code: "forbidden",
      retryable: false,
    });

    fake.respondError("request-1", {
      code: "forbidden",
      message: "Job is not authorized for this session",
      retryable: false,
    });

    await remoteError;
  });

  it("cleans every pending request during worker shutdown", async () => {
    const fake = new FakeParentToolRpc({
      requestIdFactory: idFactory(),
    });
    const first = requestWorkspaceList(fake, "call-1");
    const second = requestWorkspaceList(fake, "call-2");
    const firstCancelled = expect(first).rejects.toMatchObject({
      reason: "worker_shutdown",
    });
    const secondCancelled = expect(second).rejects.toMatchObject({
      reason: "worker_shutdown",
    });

    fake.client.shutdown();

    await Promise.all([firstCancelled, secondCancelled]);
    expect(fake.client.pendingCount).toBe(0);
    expect(fake.cancellations.map((entry) => entry.reason)).toEqual([
      "worker_shutdown",
      "worker_shutdown",
    ]);
  });

  it("validates child arguments before emitting a request", async () => {
    const fake = new FakeParentToolRpc({
      requestIdFactory: idFactory(),
    });

    expect(() =>
      fake.client.request({
        sessionId: "session-1",
        toolCallId: "call-1",
        tool: "workspace.read",
        arguments: {
          resourceId: "resource-1",
          path: "../../etc/passwd",
        },
      }),
    ).toThrow();
    expect(fake.requests).toEqual([]);
  });
});
