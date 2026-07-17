import { describe, expect, it } from "vitest";
import {
  decodeForDisplay,
  decodeUnicodeEscapes,
  formatArgumentsForDisplay,
  prettyPrintForDisplay,
} from "./jsonDisplay";

describe("decodeUnicodeEscapes", () => {
  it("decodes Python ensure_ascii style sequences to Chinese", () => {
    expect(decodeUnicodeEscapes("\\u9633\\u5149\\u7535\\u6e90")).toBe("阳光电源");
  });

  it("leaves normal text unchanged", () => {
    expect(decodeUnicodeEscapes("hello 阳光")).toBe("hello 阳光");
  });
});

describe("decodeForDisplay", () => {
  it("parses nested JSON strings (MCP text payload)", () => {
    const outer = [
      {
        type: "text",
        text: JSON.stringify({
          dataset_id: "阳光电源",
          query: "业务构成",
        }),
      },
    ];
    const decoded = decodeForDisplay(outer) as Array<{ type: string; text?: unknown; dataset_id?: string }>;
    // After decode, nested JSON string becomes an object — but text field was a string
    // so it becomes the parsed object directly under the array item.
    expect(decoded[0]?.type).toBe("text");
    expect(decoded[0]).toMatchObject({
      type: "text",
      text: { dataset_id: "阳光电源", query: "业务构成" },
    });
  });

  it("decodes double-encoded unicode escapes inside nested JSON strings", () => {
    // Simulate ensure_ascii dump left as literal backslash-u sequences inside a string field.
    const nested = '{"dataset_id": "\\u9633\\u5149\\u7535\\u6e90"}';
    const outer = JSON.stringify([{ type: "text", text: nested }]);
    // outer parse once then decodeForDisplay
    const once = JSON.parse(outer) as unknown;
    const decoded = decodeForDisplay(once) as Array<{ text: { dataset_id: string } }>;
    expect(decoded[0]?.text?.dataset_id).toBe("阳光电源");
  });
});

describe("prettyPrintForDisplay", () => {
  it("pretty-prints and expands nested MCP content", () => {
    const raw = JSON.stringify([
      {
        type: "text",
        text: '{"dataset":{"dataset_id":"\\u9633\\u5149\\u7535\\u6e90"},"query":"test"}',
      },
    ]);
    const pretty = prettyPrintForDisplay(raw);
    expect(pretty).toContain("阳光电源");
    expect(pretty).not.toContain("\\u9633");
    expect(pretty).toContain("\n");
  });

  it("decodes bare unicode-escaped plain text", () => {
    expect(prettyPrintForDisplay("name=\\u9633\\u5149")).toBe("name=阳光");
  });
});

describe("formatArgumentsForDisplay", () => {
  it("shows Chinese characters in parameters JSON", () => {
    const text = formatArgumentsForDisplay({
      dataset_id: "\\u9633\\u5149\\u7535\\u6e90",
      query: "业务分部",
    });
    expect(text).toContain("阳光电源");
    expect(text).toContain("业务分部");
    expect(text).not.toContain("\\u9633");
  });
});
