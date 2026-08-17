import { describe, expect, it } from "vitest";
import { Type } from "typebox";

import { WhitelistedToolRegistry } from "../src/tool-registry.js";

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

describe("WhitelistedToolRegistry", () => {
  it("materializes only explicitly allowed and registered tools", async () => {
    const registry = new WhitelistedToolRegistry([
      "dataset_search",
      "source_detail",
    ]);
    registry.register({
      name: "dataset_search",
      create: (sessionContext) => ({
        name: "dataset_search",
        label: "Dataset search",
        description: "Search project evidence",
        parameters: Type.Object({
          query: Type.String(),
        }),
        execute: async (_toolCallId, params) => ({
          content: [
            {
              type: "text",
              text: `${sessionContext.projectId}:${params.query}`,
            },
          ],
          details: {},
        }),
      }),
    });

    const tools = registry.materialize(context);

    expect(tools.map((tool) => tool.name)).toEqual(["dataset_search"]);
    const result = await tools[0]?.execute(
      "call-1",
      { query: "revenue" },
      undefined,
      undefined,
      {} as never,
    );
    expect(result?.content).toEqual([
      { type: "text", text: "project-1:revenue" },
    ]);
  });

  it("rejects non-allowlisted, duplicate, and built-in tool names", () => {
    const registry = new WhitelistedToolRegistry(["dataset_search"]);
    const definition = {
      name: "dataset_search",
      label: "Dataset search",
      description: "Search project evidence",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text" as const, text: "ok" }],
        details: {},
      }),
    };

    expect(() =>
      registry.register({
        name: "source_detail",
        create: () => ({ ...definition, name: "source_detail" }),
      }),
    ).toThrow("not allowlisted");

    registry.registerDefinition(definition);
    expect(() => registry.registerDefinition(definition)).toThrow(
      "already registered",
    );
    expect(() => new WhitelistedToolRegistry(["bash"])).toThrow(
      "Built-in agent tool",
    );
  });

  it("rejects a factory that changes its registered name", () => {
    const registry = new WhitelistedToolRegistry(["dataset_search"]);
    registry.register({
      name: "dataset_search",
      create: () => ({
        name: "source_detail",
        label: "Source detail",
        description: "Read source detail",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text", text: "ok" }],
          details: {},
        }),
      }),
    });

    expect(() => registry.materialize(context)).toThrow("mismatched tool");
  });
});
