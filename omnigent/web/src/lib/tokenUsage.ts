import type { ModelUsage } from "./types";

export interface TokenUsageBreakdown {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
}

function nonNegative(value: number | null | undefined): number | null {
  return value == null || !Number.isFinite(value) ? null : Math.max(0, value);
}

export function summarizeModelTokenUsage(
  usageByModel: Record<string, ModelUsage> | null | undefined,
): TokenUsageBreakdown {
  const totals: TokenUsageBreakdown = {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
  };

  for (const usage of Object.values(usageByModel ?? {})) {
    const input = nonNegative(usage.inputTokens);
    const output = nonNegative(usage.outputTokens);
    const cacheRead = nonNegative(usage.cacheReadInputTokens);
    const cacheCreation = nonNegative(usage.cacheCreationInputTokens);
    const components = [input, output, cacheRead, cacheCreation];
    const componentTotal = components.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    const resolvedTotal =
      nonNegative(usage.totalTokens) ??
      (components.some((value) => value !== null) ? componentTotal : null);

    if (input !== null) totals.inputTokens = (totals.inputTokens ?? 0) + input;
    if (output !== null) totals.outputTokens = (totals.outputTokens ?? 0) + output;
    if (cacheRead !== null) {
      totals.cacheReadInputTokens = (totals.cacheReadInputTokens ?? 0) + cacheRead;
    }
    if (cacheCreation !== null) {
      totals.cacheCreationInputTokens = (totals.cacheCreationInputTokens ?? 0) + cacheCreation;
    }
    if (resolvedTotal !== null) totals.totalTokens = (totals.totalTokens ?? 0) + resolvedTotal;
  }

  return totals;
}

export function cachedTokenCount(usage: TokenUsageBreakdown): number | null {
  if (usage.cacheReadInputTokens == null && usage.cacheCreationInputTokens == null) return null;
  return (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
}

export function formatTokenCount(tokens: number | null | undefined): string {
  if (tokens == null || !Number.isFinite(tokens)) return "—";
  const value = Math.max(0, tokens);
  const compact = (divisor: number, suffix: string) => {
    const scaled = value / divisor;
    const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
    return `${Number(scaled.toFixed(digits))}${suffix}`;
  };
  if (value >= 1_000_000_000) return compact(1_000_000_000, "B");
  if (value >= 1_000_000) return compact(1_000_000, "M");
  if (value >= 1_000) return compact(1_000, "K");
  return Math.round(value).toLocaleString();
}
