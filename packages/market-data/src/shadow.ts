import {
  type MarketDataBar,
  type MarketDataExecution,
  type MarketDataExecutor,
  type MarketDataRequest,
  type MarketDataRunOptions,
  type MarketDataShadowDiagnostic,
} from "./contracts.js";
import {
  MarketDataError,
  redactMarketDataMessage,
} from "./errors.js";

type MaybePromise<T> = T | PromiseLike<T>;

export interface MarketDataShadowComparatorOptions {
  readonly primary: MarketDataExecutor;
  readonly shadow: MarketDataExecutor;
  readonly onDiagnostic?: (
    diagnostic: MarketDataShadowDiagnostic,
  ) => MaybePromise<void>;
}

/**
 * Read-only comparator: it accepts no writer or persistence callback, requires
 * a side-effect-free shadow executor, and returns the exact primary execution.
 */
export class MarketDataShadowComparator implements MarketDataExecutor {
  public readonly effects;
  public readonly shadowSafe = false;

  public constructor(
    private readonly options: MarketDataShadowComparatorOptions,
  ) {
    if (!options.shadow.shadowSafe || options.shadow.effects !== "none") {
      throw new MarketDataError(
        "Shadow market-data executor must attest effects=none",
        {
          code: "readiness_failed",
          retryable: false,
          fallbackEligible: false,
        },
      );
    }
    this.effects = options.primary.effects;
  }

  public async fetch(
    request: MarketDataRequest,
    options: MarketDataRunOptions = {},
  ): Promise<MarketDataExecution> {
    const primary = await this.options.primary.fetch(request, options);
    if (options.signal?.aborted) {
      await this.#observe({
        outcome: "shadow_skipped",
        primaryProviderId: primary.data.providerId,
        shadowProviderId: null,
        sameAsOf: null,
        sameBars: null,
        primaryBarCount: primary.data.bars.length,
        shadowBarCount: null,
        error: null,
      });
      return primary;
    }
    try {
      const shadow = await this.options.shadow.fetch(request, options);
      const sameAsOf = primary.data.asOf === shadow.data.asOf;
      const sameBars = barsEqual(primary.data.bars, shadow.data.bars);
      await this.#observe({
        outcome: sameAsOf && sameBars ? "match" : "different",
        primaryProviderId: primary.data.providerId,
        shadowProviderId: shadow.data.providerId,
        sameAsOf,
        sameBars,
        primaryBarCount: primary.data.bars.length,
        shadowBarCount: shadow.data.bars.length,
        error: null,
      });
    } catch (error) {
      await this.#observe({
        outcome: "shadow_failed",
        primaryProviderId: primary.data.providerId,
        shadowProviderId: null,
        sameAsOf: null,
        sameBars: null,
        primaryBarCount: primary.data.bars.length,
        shadowBarCount: null,
        error: {
          code: errorCode(error),
          message: redactMarketDataMessage(error),
        },
      });
    }
    return primary;
  }

  async #observe(diagnostic: MarketDataShadowDiagnostic): Promise<void> {
    if (this.options.onDiagnostic === undefined) return;
    try {
      await this.options.onDiagnostic(deepFreezeDiagnostic(diagnostic));
    } catch {
      // Observability must never change the primary result or failure semantics.
    }
  }
}

function barsEqual(
  left: readonly MarketDataBar[],
  right: readonly MarketDataBar[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((bar, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      bar.tradeDate === other.tradeDate &&
      bar.open === other.open &&
      bar.high === other.high &&
      bar.low === other.low &&
      bar.close === other.close &&
      bar.volume === other.volume &&
      bar.amount === other.amount
    );
  });
}

function errorCode(error: unknown): string {
  return error instanceof MarketDataError ? error.code : "provider_failure";
}

function deepFreezeDiagnostic(
  diagnostic: MarketDataShadowDiagnostic,
): MarketDataShadowDiagnostic {
  if (diagnostic.error !== null) Object.freeze(diagnostic.error);
  return Object.freeze(diagnostic);
}
