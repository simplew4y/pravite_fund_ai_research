import { describe, expect, it, vi } from "vitest";

import {
  MarketDataError,
  MarketDataProviderError,
  MarketDataWaterfall,
  createFakeMarketDataProvider,
  type MarketDataProviderDescriptor,
  type MarketDataProviderOutput,
} from "../src/index.js";
import { REQUEST, providerOutput } from "./fixtures.js";

describe("MarketDataWaterfall", () => {
  it("uses explicit waterfall order, falls back, and emits redacted diagnostics", async () => {
    const calls: string[] = [];
    const first = createFakeMarketDataProvider({
      id: "primary",
      output: providerOutput(),
      failure: () => {
        calls.push("primary");
        return new MarketDataProviderError(
          "upstream failed api_key=market-secret-value",
          { retryable: false },
        );
      },
    });
    const second = createFakeMarketDataProvider({
      id: "fallback",
      output: () => {
        calls.push("fallback");
        return providerOutput({ source: "recorded fallback" });
      },
    });
    const runtime = new MarketDataWaterfall({
      providers: [second, first],
      waterfall: ["primary", "fallback"],
    });
    await runtime.start();

    const result = await runtime.fetch(REQUEST);

    expect(calls).toEqual(["primary", "fallback"]);
    expect(result.data.providerId).toBe("fallback");
    expect(result.diagnostics.waterfall).toEqual(["primary", "fallback"]);
    expect(result.diagnostics.attempts).toMatchObject([
      {
        providerId: "primary",
        outcome: "failed",
        error: {
          retryable: false,
          message: "upstream failed api_key=[REDACTED]",
        },
      },
      { providerId: "fallback", outcome: "succeeded", error: null },
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain(
      "market-secret-value",
    );
    await runtime.dispose();
  });

  it("applies a per-provider timeout and falls back within the total deadline", async () => {
    const runtime = new MarketDataWaterfall({
      providers: [
        createFakeMarketDataProvider({
          id: "slow",
          output: providerOutput(),
          delayMs: 80,
        }),
        createFakeMarketDataProvider({
          id: "fast",
          output: providerOutput({ source: "fast fallback" }),
        }),
      ],
      waterfall: ["slow", "fast"],
      providerTimeoutMs: 10,
      totalTimeoutMs: 250,
    });
    await runtime.start();

    const result = await runtime.fetch(REQUEST);

    expect(result.data.providerId).toBe("fast");
    expect(result.diagnostics.attempts[0]).toMatchObject({
      providerId: "slow",
      error: { code: "provider_timeout", retryable: true },
    });
    await runtime.dispose();
  });

  it("distinguishes total deadline expiry from caller cancellation", async () => {
    const slow = createFakeMarketDataProvider({
      id: "slow",
      output: providerOutput(),
      delayMs: 100,
    });
    const deadlineRuntime = new MarketDataWaterfall({
      providers: [slow],
      waterfall: ["slow"],
      totalTimeoutMs: 10,
      providerTimeoutMs: 100,
    });
    await deadlineRuntime.start();
    await expect(deadlineRuntime.fetch(REQUEST)).rejects.toMatchObject({
      code: "deadline_exceeded",
      retryable: true,
    });
    await deadlineRuntime.dispose();

    const cancellationRuntime = new MarketDataWaterfall({
      providers: [slow],
      waterfall: ["slow"],
      totalTimeoutMs: 500,
      providerTimeoutMs: 250,
    });
    await cancellationRuntime.start();
    const controller = new AbortController();
    const pending = cancellationRuntime.fetch(REQUEST, {
      signal: controller.signal,
    });
    controller.abort(new Error("caller stopped"));
    await expect(pending).rejects.toMatchObject({
      code: "aborted",
      retryable: false,
    });
    await cancellationRuntime.dispose();
  });

  it("fails readiness when a provider cannot guarantee real cancellation", async () => {
    const readiness = vi.fn(async () => ({ ready: true, reason: null }));
    const unsupported: MarketDataProviderDescriptor = {
      id: "legacy-thread",
      capabilities: {
        cancellation: {
          mode: "unsupported",
          guaranteed: false,
          reason: "underlying HTTP thread cannot be interrupted",
        },
        effects: "isolated-artifacts",
      },
      readiness,
      fetch: async () => providerOutput(),
    };
    const runtime = new MarketDataWaterfall({
      providers: [unsupported],
      waterfall: ["legacy-thread"],
    });

    await expect(runtime.start()).rejects.toMatchObject({
      code: "readiness_failed",
      retryable: false,
    });
    expect(readiness).not.toHaveBeenCalled();
    expect(runtime.state).toBe("failed");
    await runtime.dispose();
  });

  it("cancels and drains readiness before provider disposal", async () => {
    const dispose = vi.fn();
    const provider: MarketDataProviderDescriptor = {
      id: "readiness-drain",
      capabilities: {
        cancellation: { mode: "abort-signal", guaranteed: true },
        effects: "none",
      },
      readiness: async ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      fetch: async () => providerOutput(),
      dispose,
    };
    const runtime = new MarketDataWaterfall({
      providers: [provider],
      waterfall: ["readiness-drain"],
      abortGraceMs: 100,
    });
    const starting = runtime.start();
    await vi.waitFor(() => expect(runtime.state).toBe("starting"));

    const stopping = runtime.dispose();
    await expect(starting).rejects.toBeInstanceOf(MarketDataError);
    await stopping;
    expect(dispose).toHaveBeenCalledOnce();
    expect(runtime.state).toBe("disposed");
  });

  it("bounds concurrency and queue length with explicit backpressure", async () => {
    const pending: Array<() => void> = [];
    const provider = controlledProvider("controlled", pending);
    const runtime = new MarketDataWaterfall({
      providers: [provider],
      waterfall: ["controlled"],
      maxConcurrent: 1,
      maxQueue: 1,
      totalTimeoutMs: 1_000,
    });
    await runtime.start();

    const first = runtime.fetch(REQUEST);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const second = runtime.fetch(REQUEST);
    await expect(runtime.fetch(REQUEST)).rejects.toMatchObject({
      code: "backpressure",
      retryable: true,
    });
    pending.shift()?.();
    await first;
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending.shift()?.();
    await second;
    await runtime.dispose();
  });

  it("drains active work before disposing providers and makes disposal idempotent", async () => {
    const pending: Array<() => void> = [];
    const dispose = vi.fn();
    const provider = controlledProvider("drained", pending, dispose);
    const runtime = new MarketDataWaterfall({
      providers: [provider],
      waterfall: ["drained"],
      drainTimeoutMs: 500,
    });
    await runtime.start();
    const execution = runtime.fetch(REQUEST);
    await vi.waitFor(() => expect(pending).toHaveLength(1));

    const stopping = runtime.dispose();
    await Promise.resolve();
    expect(dispose).not.toHaveBeenCalled();
    await expect(runtime.fetch(REQUEST)).rejects.toBeInstanceOf(MarketDataError);
    pending.shift()?.();
    await execution;
    await stopping;
    await runtime.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(runtime.state).toBe("disposed");
  });

  it("continues reverse disposal and aggregates provider cleanup failures", async () => {
    const disposeA = vi.fn(() => {
      throw new Error("dispose-a");
    });
    const disposeB = vi.fn(() => {
      throw new Error("dispose-b");
    });
    const runtime = new MarketDataWaterfall({
      providers: [
        createFakeMarketDataProvider({
          id: "a",
          output: providerOutput(),
          onDispose: disposeA,
        }),
        createFakeMarketDataProvider({
          id: "b",
          output: providerOutput(),
          onDispose: disposeB,
        }),
      ],
      waterfall: ["a", "b"],
    });
    await runtime.start();

    const failure = await runtime.dispose().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(disposeA).toHaveBeenCalledOnce();
    expect(disposeB).toHaveBeenCalledOnce();
  });
});

function controlledProvider(
  id: string,
  pending: Array<() => void>,
  dispose?: () => void,
): MarketDataProviderDescriptor {
  return {
    id,
    capabilities: {
      cancellation: { mode: "abort-signal", guaranteed: true },
      effects: "none",
    },
    readiness: async () => ({ ready: true, reason: null }),
    fetch: async (_request, { signal }): Promise<MarketDataProviderOutput> =>
      new Promise<MarketDataProviderOutput>((resolve, reject) => {
        const onAbort = (): void => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        pending.push(() => {
          signal.removeEventListener("abort", onAbort);
          resolve(providerOutput());
        });
      }),
    ...(dispose === undefined ? {} : { dispose }),
  };
}
