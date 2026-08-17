import { describe, expect, it } from "vitest";

import { buildToolDefinitions, deriveMessages } from "./runtime.js";

describe("deriveMessages", () => {
  it("rebuilds model context from durable events", () => {
    const messages = deriveMessages(
      [
        { type: "session.created", payload: {} },
        { type: "message.user", payload: { content: "问题一" } },
        {
          type: "message.assistant.completed",
          payload: {
            message: { role: "assistant", content: [{ type: "text", text: "答案一" }] },
          },
        },
        { type: "tool.completed", payload: { toolName: "evidence.search" } },
        { type: "message.user", payload: { content: "问题二" } },
      ],
      "SYS",
    );
    expect(messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "问题一" },
      { role: "assistant", content: "答案一" },
      { role: "user", content: "问题二" },
    ]);
  });

  it("compaction summary replaces prior turns", () => {
    const messages = deriveMessages(
      [
        { type: "message.user", payload: { content: "老问题" } },
        { type: "compaction.completed", payload: { summary: "此前讨论了估值。" } },
        { type: "message.user", payload: { content: "新问题" } },
      ],
      "SYS",
    );
    expect(messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(messages[1]!.content).toContain("此前讨论了估值。");
    expect(messages[messages.length - 1]).toEqual({
      role: "user",
      content: "新问题",
    });
  });
});

describe("buildToolDefinitions", () => {
  it("exposes the compiled tool registry as OpenAI functions", () => {
    const tools = buildToolDefinitions();
    const names = tools.map((tool) => tool.function.name);
    expect(names).toContain("evidence__search");
    expect(names).toContain("workspace__read");
    for (const tool of tools) {
      expect(tool.function.description.length).toBeGreaterThan(8);
      expect(tool.function.parameters).toHaveProperty("type");
    }
  });
});
