import { describe, expect, it } from "vitest";

import type { PrivateFundAsset, PrivateFundFile } from "./privateFundApi";
import { generatePrivateFundPromptSuggestions } from "./privateFundPromptSuggestions";

function file(
  name: string,
  docType: string | undefined,
  overrides: Partial<PrivateFundFile> = {},
): PrivateFundFile {
  return {
    name,
    fileType: name.split(".").pop() || "pdf",
    size: 1024,
    status: "indexed",
    chunkCount: 12,
    docType,
    ...overrides,
  };
}

function asset(assetType: string): PrivateFundAsset {
  return {
    assetId: `${assetType}-1`,
    assetType,
    title: "研究资产",
    summary: "",
    contentMarkdown: "",
    format: "markdown",
    status: "completed",
    sourceKind: "test",
    tags: [],
    versionNo: 1,
    evidenceCount: 0,
    metadata: {},
  };
}

describe("generatePrivateFundPromptSuggestions", () => {
  it("prioritizes cross-document questions when core document types are available", () => {
    const suggestions = generatePrivateFundPromptSuggestions({
      companyName: "阳光电源",
      files: [
        file("2025年报.pdf", "financial_report"),
        file("业绩交流纪要.pdf", "meeting_minutes"),
        file("估值模型.xlsx", "valuation_model"),
      ],
      assets: [],
    });

    expect(suggestions).toHaveLength(4);
    expect(suggestions.map((suggestion) => suggestion.id)).toEqual([
      "full_investment_view",
      "financial_meeting_compare",
      "financial_model_check",
      "generate_investment_memo",
    ]);
    expect(suggestions[0]?.prompt).toContain("阳光电源");
  });

  it("updates an existing memo instead of suggesting a duplicate", () => {
    const suggestions = generatePrivateFundPromptSuggestions({
      companyName: "阳光电源",
      files: [file("2025年报.pdf", "financial_report"), file("会议纪要.pdf", "meeting_minutes")],
      assets: [asset("memo")],
    });

    expect(suggestions.some((suggestion) => suggestion.id === "update_existing_memo")).toBe(true);
    expect(suggestions.some((suggestion) => suggestion.id === "generate_investment_memo")).toBe(
      false,
    );
  });

  it("supports legacy constrained subtypes and deprioritizes recently asked questions", () => {
    const suggestions = generatePrivateFundPromptSuggestions({
      companyName: "阳光电源",
      files: [file("电话会文字稿.pdf", "meeting_transcript")],
      assets: [],
      recentUserMessages: ["总结会议中的管理层指引和风险提示"],
    });

    expect(suggestions.some((suggestion) => suggestion.id === "meeting_guidance")).toBe(true);
    expect(suggestions[0]?.id).not.toBe("meeting_guidance");
  });

  it("returns a research framework for an empty project", () => {
    const suggestions = generatePrivateFundPromptSuggestions({
      companyName: null,
      files: [],
      assets: [],
    });

    expect(suggestions).toEqual([
      expect.objectContaining({
        id: "empty_project_plan",
        title: "制定研究框架",
      }),
    ]);
    expect(suggestions[0]?.prompt).toContain("当前公司");
  });
});
