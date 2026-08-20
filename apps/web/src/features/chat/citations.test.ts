import { describe, expect, it } from "vitest";

import { dedupeCitations, extractToolCitations, splitCitationTokens } from "./citations";

describe("extractToolCitations", () => {
  it("maps evidence.search hits and evidence.get items", () => {
    expect(
      extractToolCitations("evidence.search", {
        hits: [
          { evidenceId: "chunk:a", excerpt: "毛利率下行 1.8pp", score: 0.92 },
          { evidenceId: "fact:b" },
        ],
      }),
    ).toEqual([
      { evidenceId: "chunk:a", excerpt: "毛利率下行 1.8pp" },
      { evidenceId: "fact:b", excerpt: "" },
    ]);

    expect(
      extractToolCitations("evidence.get", {
        items: [{ evidenceId: "chunk:c", content: "x".repeat(300) }],
      }),
    ).toEqual([{ evidenceId: "chunk:c", excerpt: "x".repeat(200) }]);
  });

  it("returns [] for other tools and malformed payloads", () => {
    expect(extractToolCitations("corpus.search", { hits: [{ evidenceId: "a" }] })).toEqual([]);
    expect(extractToolCitations("evidence.search", null)).toEqual([]);
    expect(extractToolCitations("evidence.search", "oops")).toEqual([]);
    expect(extractToolCitations("evidence.search", { hits: "oops" })).toEqual([]);
    expect(
      extractToolCitations("evidence.search", { hits: [{ evidenceId: 42 }, null, ["a"]] }),
    ).toEqual([]);
    expect(extractToolCitations("evidence.get", { items: [{ content: "缺 id" }] })).toEqual([]);
  });
});

describe("dedupeCitations", () => {
  it("drops later duplicates and keeps first-seen order", () => {
    expect(
      dedupeCitations([
        { evidenceId: "a", excerpt: "first" },
        { evidenceId: "b", excerpt: "" },
        { evidenceId: "a", excerpt: "second" },
      ]),
    ).toEqual([
      { evidenceId: "a", excerpt: "first" },
      { evidenceId: "b", excerpt: "" },
    ]);
  });
});

describe("splitCitationTokens", () => {
  it("splits leading, trailing and adjacent tokens, leaving other text intact", () => {
    expect(splitCitationTokens("[chunk:a-1] 见年报 [fact:b_2][cell:c.3]")).toEqual([
      { type: "citation", evidenceId: "chunk:a-1" },
      { type: "text", value: " 见年报 " },
      { type: "citation", evidenceId: "fact:b_2" },
      { type: "citation", evidenceId: "cell:c.3" },
    ]);
    expect(splitCitationTokens("无引用文本")).toEqual([{ type: "text", value: "无引用文本" }]);
    expect(splitCitationTokens("见 [foo:x] 附录")).toEqual([
      { type: "text", value: "见 [foo:x] 附录" },
    ]);
    expect(splitCitationTokens("")).toEqual([]);
  });
});
