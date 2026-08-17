import { describe, expect, it } from "vitest";

import {
  MarketDataError,
  normalizeMarketDataRequest,
  normalizeMarketDataResult,
} from "../src/index.js";
import { REQUEST, providerOutput } from "./fixtures.js";

describe("market-data normalization", () => {
  it("sorts existing raw bar fields and preserves provenance/freshness metadata", () => {
    const output = providerOutput({
      source: "AKShare stock_zh_a_hist (Eastmoney)",
      stale: true,
      cache: { status: "hit", ageMs: 2_000 },
      units: { price: "CNY", volume: null, amount: "CNY" },
      timezone: "Asia/Shanghai",
      bars: [...providerOutput().bars].reverse(),
    });

    const result = normalizeMarketDataResult("recorded-akshare", REQUEST, output);

    expect(result.providerId).toBe("recorded-akshare");
    expect(result.source).toBe("AKShare stock_zh_a_hist (Eastmoney)");
    expect(result.asOf).toBe("2026-07-29");
    expect(result.bars.map(({ tradeDate }) => tradeDate)).toEqual([
      "2026-07-27",
      "2026-07-29",
    ]);
    expect(result.stale).toBe(true);
    expect(result.cache).toEqual({ status: "hit", ageMs: 2_000 });
    expect(result.units).toEqual({
      price: "CNY",
      volume: null,
      amount: "CNY",
    });
    expect(result.timezone).toBe("Asia/Shanghai");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.bars)).toBe(true);
  });

  it("uses the requested end date as asOf for an empty normalized result", () => {
    const result = normalizeMarketDataResult(
      "empty",
      REQUEST,
      providerOutput({ bars: [] }),
    );
    expect(result.asOf).toBe(REQUEST.endDate);
  });

  it("rejects invalid requests and inconsistent provider bars", () => {
    expect(() =>
      normalizeMarketDataRequest({
        ...REQUEST,
        startDate: "2026-02-30",
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_request" }));

    expect(() =>
      normalizeMarketDataResult(
        "invalid",
        REQUEST,
        providerOutput({
          bars: [
            {
              tradeDate: "2026-07-27",
              open: 10,
              high: 9,
              low: 8,
              close: 10,
              volume: 1,
              amount: 1,
            },
          ],
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "provider_invalid_data" }),
    );

    try {
      normalizeMarketDataResult(
        "duplicate",
        REQUEST,
        providerOutput({
          bars: [providerOutput().bars[0]!, providerOutput().bars[0]!],
        }),
      );
      throw new Error("expected normalization failure");
    } catch (error) {
      expect(error).toBeInstanceOf(MarketDataError);
      expect(error).toMatchObject({
        code: "provider_invalid_data",
        fallbackEligible: true,
        retryable: false,
      });
    }
  });
});
