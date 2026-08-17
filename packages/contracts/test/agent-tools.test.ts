import { describe, expect, it } from "vitest";

import {
  AGENT_TOOL_PROTOCOL_VERSION,
  agentToolRequestMessageSchema,
  agentToolResultCommandSchema,
  agentWorkerCommandSchema,
  agentWorkerMessageSchema,
} from "../src/index.js";

describe("agent tool wire contracts", () => {
  it("accepts bounded logical requests without tenant or path inputs", () => {
    const request = {
      type: "tool.request",
      protocolVersion: AGENT_TOOL_PROTOCOL_VERSION,
      requestId: "request-1",
      sessionId: "session-1",
      toolCallId: "call-1",
      tool: "workspace.read",
      arguments: {
        resourceId: "resource-1",
        offset: 0,
        maxCharacters: 20_000,
      },
      deadlineAt: "2026-07-30T12:00:00.000Z",
    };

    expect(agentToolRequestMessageSchema.parse(request)).toEqual(request);
    expect(agentWorkerMessageSchema.safeParse(request).success).toBe(true);
  });

  it("rejects tenant, project, filesystem path, and unknown parameters", () => {
    const base = {
      type: "tool.request",
      protocolVersion: AGENT_TOOL_PROTOCOL_VERSION,
      requestId: "request-1",
      sessionId: "session-1",
      toolCallId: "call-1",
      tool: "workspace.read",
      deadlineAt: "2026-07-30T12:00:00.000Z",
    };

    for (const forbidden of [
      { tenant: "tenant-1" },
      { projectId: "project-1" },
      { path: "../../etc/passwd" },
      { url: "https://example.com" },
    ]) {
      expect(
        agentToolRequestMessageSchema.safeParse({
          ...base,
          arguments: {
            resourceId: "resource-1",
            ...forbidden,
          },
        }).success,
      ).toBe(false);
    }
  });

  it("validates successful results against the correlated tool schema", () => {
    const result = {
      type: "tool.result",
      protocolVersion: AGENT_TOOL_PROTOCOL_VERSION,
      requestId: "request-1",
      sessionId: "session-1",
      toolCallId: "call-1",
      tool: "workspace.list",
      ok: true,
      result: {
        items: [
          {
            resourceId: "resource-1",
            name: "Annual report",
            kind: "document",
            version: "version-1",
            size: 1024,
            updatedAt: "2026-07-30T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      },
    };

    expect(agentToolResultCommandSchema.parse(result)).toEqual(result);
    expect(agentWorkerCommandSchema.safeParse(result).success).toBe(true);
  });

  it("rejects mismatched, oversized, and ambiguous result payloads", () => {
    const base = {
      type: "tool.result",
      protocolVersion: AGENT_TOOL_PROTOCOL_VERSION,
      requestId: "request-1",
      sessionId: "session-1",
      toolCallId: "call-1",
      tool: "workspace.read",
      ok: true,
    };

    expect(
      agentToolResultCommandSchema.safeParse({
        ...base,
        result: {
          jobId: "job-1",
          status: "queued",
        },
      }).success,
    ).toBe(false);
    expect(
      agentToolResultCommandSchema.safeParse({
        ...base,
        result: {
          resourceId: "resource-1",
          name: "Document",
          content: "x".repeat(200_001),
          version: "version-1",
          mediaType: "text/plain",
          truncated: false,
          nextOffset: null,
        },
      }).success,
    ).toBe(false);
    expect(
      agentToolResultCommandSchema.safeParse({
        ...base,
        result: {
          resourceId: "resource-1",
          name: "Document",
          content: "safe",
          version: "version-1",
          mediaType: "text/plain",
          truncated: false,
          nextOffset: null,
        },
        error: {
          code: "internal",
          message: "ambiguous",
          retryable: false,
        },
      }).success,
    ).toBe(false);
  });

  it("requires structured errors for failed results", () => {
    const failed = {
      type: "tool.result",
      protocolVersion: AGENT_TOOL_PROTOCOL_VERSION,
      requestId: "request-1",
      sessionId: "session-1",
      toolCallId: "call-1",
      tool: "evidence.get",
      ok: false,
      error: {
        code: "forbidden",
        message: "Evidence does not belong to this session project",
        retryable: false,
      },
    };

    expect(agentToolResultCommandSchema.parse(failed)).toEqual(failed);
    expect(
      agentToolResultCommandSchema.safeParse({
        ...failed,
        error: undefined,
      }).success,
    ).toBe(false);
  });

  it("caps aggregate evidence output even when each item is valid", () => {
    const items = Array.from({ length: 5 }, (_, index) => ({
      evidenceId: `chunk:document-1:${index}`,
      documentId: "document-1",
      type: "chunk",
      content: "x".repeat(50_000),
      locator: {
        page: index + 1,
        sheet: null,
        cellRange: null,
        section: null,
      },
      version: "version-1",
    }));

    expect(
      agentToolResultCommandSchema.safeParse({
        type: "tool.result",
        protocolVersion: AGENT_TOOL_PROTOCOL_VERSION,
        requestId: "request-1",
        sessionId: "session-1",
        toolCallId: "call-1",
        tool: "evidence.get",
        ok: true,
        result: { items },
      }).success,
    ).toBe(false);
  });
});
