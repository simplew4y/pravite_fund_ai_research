import { describe, expect, it, vi } from "vitest";

import {
  MarketDataError,
  MarketDataProviderError,
  MarketDataShadowComparator,
  MarketDataWaterfall,
  createFakeMarketDataProvider,
  createRecordedMarketDataProvider,
  marketDataRecordingKey,
  redactMarketDataMessage,
  type MarketDataExecution,
  type MarketDataExecutor,
  type MarketDataShadowDiagnostic,
} from "../src/index.js";
import { REQUEST, providerOutput } from "./fixtures.js";

describe("recorded and shadow market-data providers", () => {
  it("replays exact source, stale, cache, unit, and timezone metadata without writes", async () => {
    const recordedOutput = providerOutput({
      source: "recorded production response",
      stale: true,
      cache: { status: "hit", ageMs: 86_400_000 },
      units: { price: "CNY", volume: "shares", amount: "CNY" },
      timezone: "Asia/Shanghai",
    });
    const recordings = new Map([
      [marketDataRecordingKey(REQUEST), recordedOutput],
    ]);
    const provider = createRecordedMarketDataProvider({
      id: "recorded",
      recordings,
    });
    const runtime = new MarketDataWaterfall({
      providers: [provider],
      waterfall: ["recorded"],
    });
    expect(provider.capabilities.effects).toBe("none");
    await runtime.start();

    const result = await runtime.fetch(REQUEST);

    expect(result.data).toMatchObject({
      source: "recorded production response",
      stale: true,
      cache: { status: "hit", ageMs: 86_400_000 },
      units: { price: "CNY", volume: "shares", amount: "CNY" },
      timezone: "Asia/Shanghai",
    });
    expect(recordings.size).toBe(1);
    await runtime.dispose();
  });

  it("returns the exact primary execution and exposes only comparison diagnostics", async () => {
    const primaryExecution = execution("primary", 1_448);
    const shadowExecution = execution("shadow", 1_447);
    const primary: MarketDataExecutor = {
      effects: "none",
      shadowSafe: true,
      fetch: vi.fn(async () => primaryExecution),
    };
    const shadow: MarketDataExecutor = {
      effects: "none",
      shadowSafe: true,
      fetch: vi.fn(async () => shadowExecution),
    };
    const observed: MarketDataShadowDiagnostic[] = [];
    const comparator = new MarketDataShadowComparator({
      primary,
      shadow,
      onDiagnostic: (diagnostic) => {
        observed.push(diagnostic);
        expect(Object.isFrozen(diagnostic)).toBe(true);
      },
    });

    const returned = await comparator.fetch(REQUEST);

    expect(returned).toBe(primaryExecution);
    expect(Object.keys(returned)).toEqual(["data", "diagnostics"]);
    expect(returned.data.providerId).toBe("primary");
    expect(JSON.stringify(returned)).not.toContain("shadow");
    expect(observed).toEqual([
      expect.objectContaining({
        outcome: "different",
        primaryProviderId: "primary",
        shadowProviderId: "shadow",
        sameAsOf: true,
        sameBars: false,
      }),
    ]);
  });

  it("never changes primary success when shadow or diagnostic observation fails", async () => {
    const primaryExecution = execution("primary", 1_448);
    const diagnostics: MarketDataShadowDiagnostic[] = [];
    const comparator = new MarketDataShadowComparator({
      primary: executor(primaryExecution),
      shadow: {
        effects: "none",
        shadowSafe: true,
        fetch: async () => {
          throw new MarketDataProviderError(
            "shadow failed token=super-secret-token",
            { retryable: true },
          );
        },
      },
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
        throw new Error("observer unavailable");
      },
    });

    await expect(comparator.fetch(REQUEST)).resolves.toBe(primaryExecution);
    expect(diagnostics[0]).toMatchObject({
      outcome: "shadow_failed",
      error: {
        code: "provider_failure",
        message: "shadow failed token=[REDACTED]",
      },
    });
  });

  it("refuses any shadow executor that may create artifacts or external writes", () => {
    expect(
      () =>
        new MarketDataShadowComparator({
          primary: executor(execution("primary", 1_448)),
          shadow: {
            effects: "isolated-artifacts",
            shadowSafe: false,
            fetch: async () => execution("legacy", 1_448),
          },
        }),
    ).toThrowError(expect.objectContaining({ code: "readiness_failed" }));
  });
});

describe("market-data secret redaction", () => {
  it("redacts bearer tokens, assignments, URL credentials, and common key tokens", () => {
    const raw =
      "Bearer abc.def api_key=plain-secret https://user:pass@example.test sk-abcdefghijklmnop";
    const safe = redactMarketDataMessage(raw);
    expect(safe).not.toContain("abc.def");
    expect(safe).not.toContain("plain-secret");
    expect(safe).not.toContain("user:pass");
    expect(safe).not.toContain("sk-abcdefghijklmnop");
    expect(safe).toContain("[REDACTED]");
  });

  it("keeps recording misses structured and eligible for fallback", async () => {
    const recorded = createRecordedMarketDataProvider({
      id: "recorded",
      recordings: new Map(),
    });
    const fallback = createFakeMarketDataProvider({
      id: "fake",
      output: providerOutput(),
    });
    const runtime = new MarketDataWaterfall({
      providers: [recorded, fallback],
      waterfall: ["recorded", "fake"],
    });
    await runtime.start();
    const result = await runtime.fetch(REQUEST);
    expect(result.diagnostics.attempts[0]).toMatchObject({
      error: { code: "recording_not_found", retryable: false },
    });
    expect(result.data.providerId).toBe("fake");
    await runtime.dispose();
  });
});

function executor(executionValue: MarketDataExecution): MarketDataExecutor {
  return {
    effects: "none",
    shadowSafe: true,
    fetch: async () => executionValue,
  };
}

function execution(providerId: string, latestClose: number): MarketDataExecution {
  const output = providerOutput({
    bars: providerOutput().bars.map((bar, index) =>
      index === providerOutput().bars.length - 1
        ? { ...bar, close: latestClose }
        : bar,
    ),
  });
  return Object.freeze({
    data: Object.freeze({
      ...output,
      providerId,
      asOf: "2026-07-29",
    }),
    diagnostics: Object.freeze({
      waterfall: Object.freeze([providerId]),
      selectedProviderId: providerId,
      attempts: Object.freeze([]),
      totalDurationMs: 0,
    }),
  });
}
