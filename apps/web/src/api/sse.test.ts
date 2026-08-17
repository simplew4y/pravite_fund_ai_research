import { describe, expect, it } from "vitest";

import { createSseParser, parseEventData } from "./sse";

const sample = {
  sessionId: "s-1",
  sequence: 3,
  type: "assistant.message.delta",
  timestamp: "2026-08-18T00:00:00.000Z",
  operationId: null,
  payload: { text: "hi" },
};

describe("createSseParser", () => {
  it("emits data across chunk boundaries", () => {
    const seen: string[] = [];
    const parse = createSseParser((data) => seen.push(data));
    const frame = `id: 3\nevent: assistant.message.delta\ndata: ${JSON.stringify(sample)}\n\n`;
    parse(frame.slice(0, 20));
    parse(frame.slice(20));
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]!)).toMatchObject({ sequence: 3 });
  });

  it("ignores comments and handles multiple frames", () => {
    const seen: string[] = [];
    const parse = createSseParser((data) => seen.push(data));
    parse(`: ping\n\ndata: {"a":1}\n\ndata: {"b":2}\n\n`);
    expect(seen).toEqual([`{"a":1}`, `{"b":2}`]);
  });
});

describe("parseEventData", () => {
  it("parses a valid session event", () => {
    expect(parseEventData(JSON.stringify(sample))).toMatchObject({
      sessionId: "s-1",
      type: "assistant.message.delta",
    });
  });

  it("returns null for malformed data", () => {
    expect(parseEventData("not json")).toBeNull();
    expect(parseEventData(`{"sequence":-1}`)).toBeNull();
  });
});
