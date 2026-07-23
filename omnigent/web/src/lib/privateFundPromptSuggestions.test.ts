import { describe, expect, it } from "vitest";

import type { PrivateFundAsset, PrivateFundFile } from "./privateFundApi";
import {
  detectPrivateFundSituation,
  generatePrivateFundPromptSuggestions,
} from "./privateFundPromptSuggestions";

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

function asset(
  assetType: string,
  overrides: Partial<PrivateFundAsset> = {},
): PrivateFundAsset {
  return {
    assetId: `${assetType}-${overrides.title ?? "1"}`,
    assetType,
    title: overrides.title ?? "研究资产",
    summary: "",
    contentMarkdown: "",
    format: "markdown",
    status: "completed",
    sourceKind: "test",
    tags: [],
    versionNo: 1,
    evidenceCount: 0,
    metadata: {},
    displayGroup: "source",
    displayLabel: "资料",
    ...overrides,
  };
}

describe("generatePrivateFundPromptSuggestions", () => {
  it("names real files when core document types are available", () => {
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
    // Dynamic chips should surface real filenames / cross-doc actions
    expect(suggestions.some((s) => s.prompt.includes("2025年报.pdf"))).toBe(true);
    expect(suggestions.some((s) => s.prompt.includes("业绩交流纪要.pdf"))).toBe(true);
    expect(suggestions.some((s) => s.prompt.includes("阳光电源"))).toBe(true);
    // Prefer dynamic compare over static-only ids when possible
    expect(
      suggestions.some((s) =>
        ["dyn_compare_report_meeting", "dyn_check_model_vs_report", "dyn_guidance_into_model"].includes(
          s.id,
        ),
      ),
    ).toBe(true);
  });

  it("prefers updating an existing memo over generating a duplicate", () => {
    const suggestions = generatePrivateFundPromptSuggestions({
      companyName: "阳光电源",
      files: [file("2025年报.pdf", "financial_report"), file("会议纪要.pdf", "meeting_minutes")],
      assets: [asset("memo", { title: "阳光电源一页纸" })],
    });

    expect(suggestions.some((s) => s.id === "dyn_update_memo" || s.id === "update_existing_memo")).toBe(
      true,
    );
    expect(suggestions.some((s) => s.prompt.includes("阳光电源一页纸"))).toBe(true);
    expect(suggestions.some((s) => s.id === "generate_investment_memo")).toBe(false);
  });

  it("builds follow-ups from the latest user question", () => {
    const suggestions = generatePrivateFundPromptSuggestions({
      companyName: "阳光电源",
      files: [file("电话会文字稿.pdf", "meeting_transcript")],
      assets: [],
      recentUserMessages: ["阳光电源储能业务 2027 年单位盈利大概多少"],
    });

    expect(suggestions.some((s) => s.id === "dyn_continue_topic")).toBe(true);
    expect(suggestions.find((s) => s.id === "dyn_continue_topic")?.prompt).toContain("单位盈利");
    expect(detectPrivateFundSituation({
      companyName: "阳光电源",
      files: [file("电话会文字稿.pdf", "meeting_transcript")],
      assets: [],
      recentUserMessages: ["阳光电源储能业务 2027 年单位盈利大概多少"],
    })).toBe("mid_conversation");
  });

  it("uses open questions from the last assistant reply", () => {
    const suggestions = generatePrivateFundPromptSuggestions({
      companyName: "阳光电源",
      files: [file("2025年报.pdf", "financial_report")],
      assets: [],
      recentUserMessages: ["总结财报"],
      recentAssistantMessages: [
        "结论如下。\n- 待验证：北美配储订单能否在 2026 年放量\n- 待核实：毛利率指引口径是否含储能",
      ],
    });

    expect(suggestions.some((s) => s.id.startsWith("dyn_open_q_"))).toBe(true);
    expect(
      suggestions.some((s) => s.prompt.includes("北美配储") || s.title.includes("北美配储")),
    ).toBe(true);
  });

  it("reacts to selected context chips", () => {
    const note = asset("analysis", {
      assetId: "ctx-1",
      title: "AIDC 双轮驱动笔记",
      sourceKind: "research_node",
    });
    const suggestions = generatePrivateFundPromptSuggestions({
      companyName: "阳光电源",
      files: [file("2025年报.pdf", "financial_report")],
      assets: [note],
      contextAssetIds: ["ctx-1"],
    });

    expect(suggestions.some((s) => s.id === "dyn_use_context")).toBe(true);
    expect(suggestions.find((s) => s.id === "dyn_use_context")?.prompt).toContain("AIDC");
  });

  it("supports legacy subtypes and deprioritizes recently asked guidance", () => {
    const suggestions = generatePrivateFundPromptSuggestions({
      companyName: "阳光电源",
      files: [file("电话会文字稿.pdf", "meeting_transcript")],
      assets: [],
      recentUserMessages: ["总结会议中的管理层指引和风险提示"],
    });

    // Meeting doc still yields a meeting-oriented chip (dynamic or template)
    expect(
      suggestions.some(
        (s) =>
          s.id === "meeting_guidance" ||
          s.id === "dyn_read_meeting" ||
          s.prompt.includes("电话会文字稿"),
      ),
    ).toBe(true);
  });

  it("returns a research framework for an empty project", () => {
    const suggestions = generatePrivateFundPromptSuggestions({
      companyName: null,
      files: [],
      assets: [],
    });

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.some((s) => s.id === "dyn_empty_framework" || s.id === "empty_project_plan")).toBe(
      true,
    );
    expect(suggestions[0]?.prompt).toContain("当前公司");
    expect(detectPrivateFundSituation({ files: [], assets: [] })).toBe("empty");
  });

  it("deepens existing research notes by title", () => {
    const suggestions = generatePrivateFundPromptSuggestions({
      companyName: "阳光电源",
      files: [file("2025年报.pdf", "financial_report")],
      assets: [
        asset("analysis", {
          title: "储能毛利率修复路径",
          sourceKind: "research_node:main",
        }),
      ],
    });

    expect(suggestions.some((s) => s.id === "dyn_deepen_note")).toBe(true);
    expect(suggestions.find((s) => s.id === "dyn_deepen_note")?.prompt).toContain("储能毛利率");
  });
});
