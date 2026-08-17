import { describe, expect, it } from "vitest";

import { FakeHarness } from "../src/testing/fake-harness.js";

const startInput = {
  sessionId: "session-1",
  projectId: "project-1",
  tenant: {
    userId: "user@example.com",
    dataNamespace: "0b2ca3f8-a4b8-4c04-b23b-f50d4bea46a7",
  },
  workspace: "/tmp/project-1",
  sessionFile: "/tmp/session-1.jsonl",
};

describe("FakeHarness", () => {
  it("supports deterministic prompt completion and event injection", async () => {
    const harness = new FakeHarness({ autoCompletePrompts: false });
    const events: unknown[] = [];
    await harness.start(startInput, (event) => events.push(event));
    const handle = await harness.prompt({
      sessionId: "session-1",
      operationId: "operation-1",
      content: "Analyze",
    });

    harness.emit("session-1", "message.assistant.delta", {
      delta: "A",
    });
    harness.completePrompt("session-1");
    await handle.completion;

    expect(events).toEqual([
      expect.objectContaining({
        operationId: "operation-1",
        eventType: "message.assistant.delta",
      }),
    ]);
    expect(harness.activeOperationId("session-1")).toBeNull();
  });
});
