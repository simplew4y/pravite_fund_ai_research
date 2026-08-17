import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import {
  PARENT_RPC_TOOL_NAMES,
  createParentRpcToolRegistry,
  parentRpcToolParameterSchemas,
} from "../src/parent-rpc-tools.js";
import { FakeParentToolRpc } from "../src/testing/fake-parent-tool-rpc.js";

const context = {
  sessionId: "session-1",
  projectId: "project-1",
  tenant: {
    userId: "user@example.com",
    dataNamespace: "0b2ca3f8-a4b8-4c04-b23b-f50d4bea46a7",
  },
  workspace: "/tmp/project-1",
  sessionFile: "/tmp/session-1.jsonl",
};

describe("parent RPC Pi tools", () => {
  it("registers exactly the eight logical tools", () => {
    const fake = new FakeParentToolRpc();
    const registry = createParentRpcToolRegistry(fake.client);

    expect(registry.getAllowedNames()).toEqual(PARENT_RPC_TOOL_NAMES);
    expect(registry.getRegisteredNames()).toEqual(PARENT_RPC_TOOL_NAMES);
    expect(
      registry.materialize(context).map((tool) => tool.name),
    ).toEqual(PARENT_RPC_TOOL_NAMES);
  });

  it("uses closed TypeBox schemas with length and item limits", () => {
    expect(
      Value.Check(parentRpcToolParameterSchemas["workspace.read"], {
        resourceId: "resource-1",
        maxCharacters: 50_000,
      }),
    ).toBe(true);
    expect(
      Value.Check(parentRpcToolParameterSchemas["workspace.read"], {
        resourceId: "resource-1",
        path: "/tmp/private",
      }),
    ).toBe(false);
    expect(
      Value.Check(parentRpcToolParameterSchemas["workspace.list"], {
        collection: "sources",
        cursor: "../../private",
      }),
    ).toBe(false);
    expect(
      Value.Check(parentRpcToolParameterSchemas["evidence.get"], {
        evidenceIds: ["cell:doc-1:Sheet 1!$A$1"],
      }),
    ).toBe(true);
    expect(
      Value.Check(parentRpcToolParameterSchemas["evidence.get"], {
        evidenceIds: ["../../etc/passwd"],
      }),
    ).toBe(false);
    expect(
      Value.Check(parentRpcToolParameterSchemas["evidence.get"], {
        evidenceIds: Array.from(
          { length: 101 },
          (_, index) => `evidence-${index}`,
        ),
      }),
    ).toBe(false);
    expect(
      Value.Check(parentRpcToolParameterSchemas["workspace.write"], {
        collection: "research",
        title: "Note",
        content: "x".repeat(200_001),
        idempotencyKey: "write-1",
      }),
    ).toBe(false);
  });

  it("forwards a tool call through parent RPC and returns bounded JSON", async () => {
    const fake = new FakeParentToolRpc({
      requestIdFactory: () => "request-1",
    });
    const registry = createParentRpcToolRegistry(fake.client);
    const tool = registry
      .materialize(context)
      .find((candidate) => candidate.name === "workspace.list");
    if (tool === undefined) {
      throw new Error("workspace.list tool was not registered");
    }

    const execution = tool.execute(
      "call-1",
      { collection: "sources", limit: 10 },
      undefined,
      undefined,
      {} as never,
    );
    expect(fake.requestAt(0)).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        toolCallId: "call-1",
        tool: "workspace.list",
        arguments: {
          collection: "sources",
          limit: 10,
        },
      }),
    );
    fake.respondSuccess("request-1", {
      items: [],
      nextCursor: null,
    });

    await expect(execution).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"items":[],"nextCursor":null}',
        },
      ],
      details: {
        requestId: "request-1",
        tool: "workspace.list",
      },
    });
  });
});
