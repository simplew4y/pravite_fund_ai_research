import type {
  MarketDataBar,
  MarketDataProviderOutput,
  MarketDataRequest,
} from "../src/index.js";

export const REQUEST: MarketDataRequest = Object.freeze({
  ticker: "600519.SH",
  startDate: "2026-07-27",
  endDate: "2026-07-29",
});

export const DEFAULT_BARS: readonly MarketDataBar[] = Object.freeze([
  Object.freeze({
    tradeDate: "2026-07-27",
    open: 1_400,
    high: 1_430,
    low: 1_390,
    close: 1_420,
    volume: 10_000,
    amount: 14_100_000,
  }),
  Object.freeze({
    tradeDate: "2026-07-29",
    open: 1_420,
    high: 1_455,
    low: 1_410,
    close: 1_448,
    volume: 12_000,
    amount: 17_280_000,
  }),
]);

export function providerOutput(
  overrides: Partial<MarketDataProviderOutput> = {},
): MarketDataProviderOutput {
  return {
    source: "golden offline fixture",
    retrievedAt: "2026-07-30T00:00:00Z",
    canonicalTicker: "600519.SH",
    providerSymbol: "600519",
    exchange: "SH",
    currency: "CNY",
    adjustment: "raw",
    startDate: REQUEST.startDate,
    endDate: REQUEST.endDate,
    bars: DEFAULT_BARS,
    stale: false,
    cache: { status: "miss", ageMs: null },
    units: { price: "CNY", volume: null, amount: "CNY" },
    timezone: null,
    ...overrides,
  };
}
