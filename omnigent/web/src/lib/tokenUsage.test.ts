import { describe, expect, it } from "vitest";
import { cachedTokenCount, formatTokenCount, summarizeModelTokenUsage } from "./tokenUsage";

describe("token usage summaries", () => {
  it("sums model buckets without double counting cache into input", () => {
    const summary = summarizeModelTokenUsage({
      modelA: {
        inputTokens: 1_000,
        outputTokens: 200,
        totalTokens: 1_700,
        cacheReadInputTokens: 400,
        cacheCreationInputTokens: 100,
        totalCostUsd: 0.1,
      },
      modelB: {
        inputTokens: 500,
        outputTokens: 100,
        totalTokens: 600,
        cacheReadInputTokens: null,
        cacheCreationInputTokens: null,
        totalCostUsd: null,
      },
    });

    expect(summary).toEqual({
      inputTokens: 1_500,
      outputTokens: 300,
      totalTokens: 2_300,
      cacheReadInputTokens: 400,
      cacheCreationInputTokens: 100,
    });
    expect(cachedTokenCount(summary)).toBe(500);
  });

  it("falls back to component totals and keeps missing usage unknown", () => {
    expect(
      summarizeModelTokenUsage({
        modelA: {
          inputTokens: 800,
          outputTokens: 200,
          totalTokens: null,
          cacheReadInputTokens: null,
          cacheCreationInputTokens: null,
          totalCostUsd: null,
        },
      }).totalTokens,
    ).toBe(1_000);
    expect(summarizeModelTokenUsage(null).totalTokens).toBeNull();
  });

  it("formats compact token totals", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(12_400)).toBe("12.4K");
    expect(formatTokenCount(2_500_000)).toBe("2.5M");
    expect(formatTokenCount(null)).toBe("—");
  });
});
