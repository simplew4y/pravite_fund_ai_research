export const MAX_MARKET_DATA_BARS = 100_000;
export const MAX_MARKET_DATA_RANGE_DAYS = 7_305;

export interface MarketDataRequest {
  readonly ticker: string;
  readonly startDate: string;
  readonly endDate: string;
}

export interface MarketDataBar {
  readonly tradeDate: string;
  readonly open: number | null;
  readonly high: number | null;
  readonly low: number | null;
  readonly close: number;
  readonly volume: number | null;
  readonly amount: number | null;
}

export type MarketDataCacheStatus =
  | "hit"
  | "miss"
  | "bypass"
  | "unsupported";

export interface MarketDataCacheMetadata {
  readonly status: MarketDataCacheStatus;
  readonly ageMs: number | null;
}

/**
 * Units are deliberately explicit. A null value means the provider cannot
 * attest the unit; the runtime never infers it from ticker or exchange.
 */
export interface MarketDataUnits {
  readonly price: string | null;
  readonly volume: string | null;
  readonly amount: string | null;
}

/** Provider output before provider identity and as-of are normalized. */
export interface MarketDataProviderOutput {
  readonly source: string;
  readonly retrievedAt: string;
  readonly canonicalTicker: string;
  readonly providerSymbol: string;
  readonly exchange: string;
  readonly currency: string;
  readonly adjustment: "raw";
  readonly startDate: string;
  readonly endDate: string;
  readonly bars: readonly MarketDataBar[];
  readonly stale: boolean;
  readonly cache: MarketDataCacheMetadata;
  readonly units: MarketDataUnits;
  readonly timezone: string | null;
}

export interface NormalizedMarketDataResult extends MarketDataProviderOutput {
  readonly providerId: string;
  readonly asOf: string;
}

export type MarketDataCancellationCapability =
  | {
      readonly mode: "abort-signal" | "process-termination";
      readonly guaranteed: true;
    }
  | {
      readonly mode: "unsupported";
      readonly guaranteed: false;
      readonly reason: string;
    };

export type MarketDataEffects =
  | "none"
  | "isolated-artifacts"
  | "external-write";

export interface MarketDataProviderCapabilities {
  readonly cancellation: MarketDataCancellationCapability;
  readonly effects: MarketDataEffects;
}

export interface MarketDataProviderReadiness {
  readonly ready: boolean;
  readonly reason: string | null;
}

export interface MarketDataProviderContext {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
}

export interface MarketDataProviderDescriptor {
  readonly id: string;
  readonly capabilities: MarketDataProviderCapabilities;
  readiness(
    context: MarketDataProviderContext,
  ): Promise<MarketDataProviderReadiness>;
  fetch(
    request: MarketDataRequest,
    context: MarketDataProviderContext,
  ): Promise<MarketDataProviderOutput>;
  dispose?(): Promise<void> | void;
}

export interface MarketDataRunOptions {
  readonly signal?: AbortSignal;
  /** Absolute epoch milliseconds. The runtime also applies its total timeout. */
  readonly deadlineAt?: number;
  readonly providerTimeoutMs?: number;
}

export type MarketDataAttemptOutcome = "succeeded" | "failed";

export interface MarketDataAttemptDiagnostic {
  readonly providerId: string;
  readonly outcome: MarketDataAttemptOutcome;
  readonly durationMs: number;
  readonly error:
    | {
        readonly code: string;
        readonly retryable: boolean;
        readonly message: string;
      }
    | null;
}

export interface MarketDataFallbackDiagnostics {
  readonly waterfall: readonly string[];
  readonly selectedProviderId: string | null;
  readonly attempts: readonly MarketDataAttemptDiagnostic[];
  readonly totalDurationMs: number;
}

export interface MarketDataExecution {
  readonly data: NormalizedMarketDataResult;
  readonly diagnostics: MarketDataFallbackDiagnostics;
}

export interface MarketDataExecutor {
  readonly effects: MarketDataEffects;
  readonly shadowSafe: boolean;
  fetch(
    request: MarketDataRequest,
    options?: MarketDataRunOptions,
  ): Promise<MarketDataExecution>;
}

export type MarketDataShadowOutcome =
  | "match"
  | "different"
  | "shadow_failed"
  | "shadow_skipped";

/**
 * Contains comparison facts only. It intentionally does not expose shadow
 * records, so a UI-facing caller can only receive the primary execution.
 */
export interface MarketDataShadowDiagnostic {
  readonly outcome: MarketDataShadowOutcome;
  readonly primaryProviderId: string;
  readonly shadowProviderId: string | null;
  readonly sameAsOf: boolean | null;
  readonly sameBars: boolean | null;
  readonly primaryBarCount: number;
  readonly shadowBarCount: number | null;
  readonly error:
    | {
        readonly code: string;
        readonly message: string;
      }
    | null;
}
