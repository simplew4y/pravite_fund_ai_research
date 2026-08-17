import {
  MAX_MARKET_DATA_BARS,
  MAX_MARKET_DATA_RANGE_DAYS,
  type MarketDataBar,
  type MarketDataCacheMetadata,
  type MarketDataProviderOutput,
  type MarketDataRequest,
  type MarketDataUnits,
  type NormalizedMarketDataResult,
} from "./contracts.js";
import { MarketDataError } from "./errors.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeMarketDataRequest(
  request: MarketDataRequest,
): MarketDataRequest {
  const ticker = boundedText(request.ticker, "ticker", 100, "invalid_request");
  const startDate = validDate(request.startDate, "startDate", "invalid_request");
  const endDate = validDate(request.endDate, "endDate", "invalid_request");
  const start = epochDay(startDate);
  const end = epochDay(endDate);
  if (end < start) {
    invalidRequest("endDate must not precede startDate");
  }
  if (end - start > MAX_MARKET_DATA_RANGE_DAYS) {
    invalidRequest(
      `Market date range may not exceed ${MAX_MARKET_DATA_RANGE_DAYS} days`,
    );
  }
  return Object.freeze({ ticker, startDate, endDate });
}

export function normalizeMarketDataResult(
  providerId: string,
  request: MarketDataRequest,
  output: MarketDataProviderOutput,
): NormalizedMarketDataResult {
  const normalizedRequest = normalizeMarketDataRequest(request);
  const id = boundedText(
    providerId,
    "providerId",
    200,
    "provider_invalid_data",
  );
  if (typeof output !== "object" || output === null) {
    invalidProviderData(id, "Provider result must be an object");
  }
  const startDate = validDate(
    output.startDate,
    "result.startDate",
    "provider_invalid_data",
    id,
  );
  const endDate = validDate(
    output.endDate,
    "result.endDate",
    "provider_invalid_data",
    id,
  );
  if (
    startDate !== normalizedRequest.startDate ||
    endDate !== normalizedRequest.endDate
  ) {
    invalidProviderData(id, "Provider result date range does not match request");
  }
  if (output.adjustment !== "raw") {
    invalidProviderData(id, "Only raw market prices are currently supported");
  }
  if (!Array.isArray(output.bars)) {
    invalidProviderData(id, "Provider result bars must be an array");
  }
  if (output.bars.length > MAX_MARKET_DATA_BARS) {
    invalidProviderData(
      id,
      `Provider result exceeds ${MAX_MARKET_DATA_BARS} bars`,
    );
  }
  const seenDates = new Set<string>();
  const bars = output.bars.map((bar, index) => {
    const normalized = normalizeBar(id, bar, index);
    if (
      normalized.tradeDate < normalizedRequest.startDate ||
      normalized.tradeDate > normalizedRequest.endDate
    ) {
      invalidProviderData(
        id,
        `Bar ${index} tradeDate is outside the requested range`,
      );
    }
    if (seenDates.has(normalized.tradeDate)) {
      invalidProviderData(
        id,
        `Provider returned duplicate tradeDate ${normalized.tradeDate}`,
      );
    }
    seenDates.add(normalized.tradeDate);
    return normalized;
  });
  bars.sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));

  const stale = output.stale;
  if (typeof stale !== "boolean") {
    invalidProviderData(id, "Provider result stale must be boolean");
  }
  const cache = normalizeCache(id, output.cache);
  const units = normalizeUnits(id, output.units);
  const timezone = normalizeTimezone(id, output.timezone);
  const result = {
    providerId: id,
    source: boundedText(
      output.source,
      "result.source",
      2_000,
      "provider_invalid_data",
      id,
    ),
    retrievedAt: boundedText(
      output.retrievedAt,
      "result.retrievedAt",
      100,
      "provider_invalid_data",
      id,
    ),
    canonicalTicker: boundedText(
      output.canonicalTicker,
      "result.canonicalTicker",
      100,
      "provider_invalid_data",
      id,
    ),
    providerSymbol: boundedText(
      output.providerSymbol,
      "result.providerSymbol",
      100,
      "provider_invalid_data",
      id,
    ),
    exchange: boundedText(
      output.exchange,
      "result.exchange",
      100,
      "provider_invalid_data",
      id,
    ),
    currency: boundedText(
      output.currency,
      "result.currency",
      20,
      "provider_invalid_data",
      id,
    ),
    adjustment: "raw" as const,
    startDate,
    endDate,
    bars: Object.freeze(bars),
    asOf: bars.at(-1)?.tradeDate ?? endDate,
    stale,
    cache,
    units,
    timezone,
  };
  return Object.freeze(result);
}

function normalizeBar(
  providerId: string,
  bar: MarketDataBar,
  index: number,
): MarketDataBar {
  if (typeof bar !== "object" || bar === null) {
    invalidProviderData(providerId, `Bar ${index} must be an object`);
  }
  const tradeDate = validDate(
    bar.tradeDate,
    `bars[${index}].tradeDate`,
    "provider_invalid_data",
    providerId,
  );
  const open = optionalFinite(providerId, bar.open, `bars[${index}].open`);
  const high = optionalFinite(providerId, bar.high, `bars[${index}].high`);
  const low = optionalFinite(providerId, bar.low, `bars[${index}].low`);
  const close = requiredFinite(providerId, bar.close, `bars[${index}].close`);
  const volume = optionalFinite(
    providerId,
    bar.volume,
    `bars[${index}].volume`,
  );
  const amount = optionalFinite(
    providerId,
    bar.amount,
    `bars[${index}].amount`,
  );
  if ((volume !== null && volume < 0) || (amount !== null && amount < 0)) {
    invalidProviderData(providerId, `Bar ${index} volume/amount may not be negative`);
  }
  const prices = [open, high, low, close].filter(
    (value): value is number => value !== null,
  );
  if (high !== null && high < Math.max(...prices)) {
    invalidProviderData(providerId, `Bar ${index} high is inconsistent`);
  }
  if (low !== null && low > Math.min(...prices)) {
    invalidProviderData(providerId, `Bar ${index} low is inconsistent`);
  }
  return Object.freeze({ tradeDate, open, high, low, close, volume, amount });
}

function normalizeCache(
  providerId: string,
  cache: MarketDataCacheMetadata,
): MarketDataCacheMetadata {
  if (
    typeof cache !== "object" ||
    cache === null ||
    !["hit", "miss", "bypass", "unsupported"].includes(cache.status) ||
    (cache.ageMs !== null &&
      (!Number.isSafeInteger(cache.ageMs) || cache.ageMs < 0))
  ) {
    invalidProviderData(providerId, "Provider result cache metadata is invalid");
  }
  return Object.freeze({ status: cache.status, ageMs: cache.ageMs });
}

function normalizeUnits(
  providerId: string,
  units: MarketDataUnits,
): MarketDataUnits {
  if (typeof units !== "object" || units === null) {
    invalidProviderData(providerId, "Provider result units must be an object");
  }
  return Object.freeze({
    price: nullableUnit(providerId, units.price, "price"),
    volume: nullableUnit(providerId, units.volume, "volume"),
    amount: nullableUnit(providerId, units.amount, "amount"),
  });
}

function nullableUnit(
  providerId: string,
  value: string | null,
  name: string,
): string | null {
  return value === null
    ? null
    : boundedText(
        value,
        `result.units.${name}`,
        40,
        "provider_invalid_data",
        providerId,
      );
}

function normalizeTimezone(
  providerId: string,
  timezone: string | null,
): string | null {
  if (timezone === null) {
    return null;
  }
  const value = boundedText(
    timezone,
    "result.timezone",
    100,
    "provider_invalid_data",
    providerId,
  );
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
  } catch {
    invalidProviderData(providerId, "Provider result timezone is not an IANA zone");
  }
  return value;
}

function optionalFinite(
  providerId: string,
  value: number | null,
  name: string,
): number | null {
  if (value === null) {
    return null;
  }
  return requiredFinite(providerId, value, name);
}

function requiredFinite(
  providerId: string,
  value: number,
  name: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidProviderData(providerId, `${name} must be finite`);
  }
  return value;
}

function validDate(
  value: string,
  name: string,
  code: "invalid_request" | "provider_invalid_data",
  providerId?: string,
): string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    invalid(code, providerId, `${name} must be an ISO date`);
  }
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    invalid(code, providerId, `${name} must be a valid calendar date`);
  }
  return value;
}

function epochDay(value: string): number {
  return Date.parse(`${value}T00:00:00Z`) / 86_400_000;
}

function boundedText(
  value: string,
  name: string,
  maximum: number,
  code: "invalid_request" | "provider_invalid_data",
  providerId?: string,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    invalid(code, providerId, `${name} must be 1-${maximum} characters`);
  }
  return value;
}

function invalidRequest(message: string): never {
  return invalid("invalid_request", undefined, message);
}

function invalidProviderData(providerId: string, message: string): never {
  return invalid("provider_invalid_data", providerId, message);
}

function invalid(
  code: "invalid_request" | "provider_invalid_data",
  providerId: string | undefined,
  message: string,
): never {
  throw new MarketDataError(message, {
    code,
    retryable: false,
    fallbackEligible: code === "provider_invalid_data",
    ...(providerId === undefined ? {} : { providerId }),
  });
}
