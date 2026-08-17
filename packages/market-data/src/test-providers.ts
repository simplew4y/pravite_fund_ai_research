import {
  type MarketDataProviderDescriptor,
  type MarketDataProviderOutput,
  type MarketDataProviderReadiness,
  type MarketDataRequest,
} from "./contracts.js";
import { MarketDataError, MarketDataProviderError } from "./errors.js";

type MaybePromise<T> = T | PromiseLike<T>;

export interface FakeMarketDataProviderOptions {
  readonly id: string;
  readonly output:
    | MarketDataProviderOutput
    | ((request: MarketDataRequest) => MaybePromise<MarketDataProviderOutput>);
  readonly delayMs?: number;
  readonly failure?:
    | MarketDataProviderError
    | ((request: MarketDataRequest) => MarketDataProviderError | undefined);
  readonly readiness?: MarketDataProviderReadiness;
  readonly onDispose?: () => MaybePromise<void>;
}

/** Deterministic, memory-only provider for contract and orchestration tests. */
export function createFakeMarketDataProvider(
  options: FakeMarketDataProviderOptions,
): MarketDataProviderDescriptor {
  return {
    id: options.id,
    capabilities: {
      cancellation: { mode: "abort-signal", guaranteed: true },
      effects: "none",
    },
    readiness: async ({ signal }) => {
      throwIfAborted(signal);
      return options.readiness ?? { ready: true, reason: null };
    },
    fetch: async (request, { signal }) => {
      await abortableDelay(options.delayMs ?? 0, signal);
      const failure =
        typeof options.failure === "function"
          ? options.failure(request)
          : options.failure;
      if (failure !== undefined) throw failure;
      throwIfAborted(signal);
      return typeof options.output === "function"
        ? await options.output(request)
        : options.output;
    },
    ...(options.onDispose === undefined
      ? {}
      : { dispose: async () => options.onDispose?.() }),
  };
}

export interface RecordedMarketDataProviderOptions {
  readonly id: string;
  readonly recordings: ReadonlyMap<string, MarketDataProviderOutput>;
  readonly onDispose?: () => MaybePromise<void>;
}

export function marketDataRecordingKey(request: MarketDataRequest): string {
  return `${request.ticker}\0${request.startDate}\0${request.endDate}`;
}

/** Read-only replay provider. It never creates or updates recordings. */
export function createRecordedMarketDataProvider(
  options: RecordedMarketDataProviderOptions,
): MarketDataProviderDescriptor {
  return {
    id: options.id,
    capabilities: {
      cancellation: { mode: "abort-signal", guaranteed: true },
      effects: "none",
    },
    readiness: async ({ signal }) => {
      throwIfAborted(signal);
      return { ready: true, reason: null };
    },
    fetch: async (request, { signal }) => {
      throwIfAborted(signal);
      const output = options.recordings.get(marketDataRecordingKey(request));
      if (output === undefined) {
        throw new MarketDataError("No recorded market-data response matched request", {
          code: "recording_not_found",
          retryable: false,
          fallbackEligible: true,
        });
      }
      return output;
    },
    ...(options.onDispose === undefined
      ? {}
      : { dispose: async () => options.onDispose?.() }),
  };
}

async function abortableDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new MarketDataProviderError("Fake provider delay must be non-negative", {
      code: "provider_failure",
      retryable: false,
    });
  }
  throwIfAborted(signal);
  if (delayMs === 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}
