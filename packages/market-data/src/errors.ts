export type MarketDataErrorCode =
  | "invalid_request"
  | "provider_invalid_data"
  | "provider_failure"
  | "provider_timeout"
  | "provider_unavailable"
  | "recording_not_found"
  | "deadline_exceeded"
  | "aborted"
  | "backpressure"
  | "not_ready"
  | "readiness_failed"
  | "disposed"
  | "providers_exhausted";

export interface MarketDataErrorOptions {
  readonly code: MarketDataErrorCode;
  readonly retryable: boolean;
  readonly fallbackEligible: boolean;
  readonly providerId?: string;
  readonly cause?: unknown;
}

const SECRET_ASSIGNMENT =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\b(\s*[:=]\s*)([^\s,;]+)/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const URL_CREDENTIALS = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const COMMON_SECRET_TOKEN = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g;
const MAX_SAFE_MESSAGE = 500;

export function redactMarketDataMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  const redacted = raw
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(SECRET_ASSIGNMENT, (_match, key: string, separator: string) =>
      `${key}${separator}[REDACTED]`,
    )
    .replace(URL_CREDENTIALS, "$1[REDACTED]@")
    .replace(COMMON_SECRET_TOKEN, "[REDACTED]");
  return redacted.length <= MAX_SAFE_MESSAGE
    ? redacted
    : `${redacted.slice(0, MAX_SAFE_MESSAGE)}…`;
}

export class MarketDataError extends Error {
  public readonly code: MarketDataErrorCode;
  public readonly retryable: boolean;
  public readonly fallbackEligible: boolean;
  public readonly providerId: string | undefined;

  public constructor(message: string, options: MarketDataErrorOptions) {
    const safeCause =
      options.cause === undefined
        ? undefined
        : new Error(redactMarketDataMessage(options.cause));
    super(
      redactMarketDataMessage(message),
      safeCause === undefined ? undefined : { cause: safeCause },
    );
    this.name = "MarketDataError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.fallbackEligible = options.fallbackEligible;
    this.providerId = options.providerId;
  }
}

export class MarketDataProviderError extends MarketDataError {
  public constructor(
    message: string,
    options: {
      readonly code?:
        | "provider_failure"
        | "provider_unavailable"
        | "provider_invalid_data";
      readonly retryable: boolean;
      readonly cause?: unknown;
    },
  ) {
    super(message, {
      code: options.code ?? "provider_failure",
      retryable: options.retryable,
      fallbackEligible: true,
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = "MarketDataProviderError";
  }
}

export class MarketDataWaterfallError extends AggregateError {
  public readonly code = "providers_exhausted" as const;
  public readonly retryable: boolean;

  public constructor(
    errors: readonly MarketDataError[],
    public readonly diagnostics: import("./contracts.js").MarketDataFallbackDiagnostics,
  ) {
    super(errors, "All market-data providers failed");
    this.name = "MarketDataWaterfallError";
    this.retryable = errors.some(({ retryable }) => retryable);
  }
}
