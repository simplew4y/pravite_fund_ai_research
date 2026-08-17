import type {
  ComputeRequest,
  ComputeResponse,
  ComputeWorkerHealth,
} from "@private-fund/contracts";

import {
  type MarketDataCancellationCapability,
  type MarketDataProviderDescriptor,
  type MarketDataProviderOutput,
  type MarketDataRequest,
} from "./contracts.js";
import { MarketDataError } from "./errors.js";

export interface LegacyComputeExecutionOptions {
  readonly signal: AbortSignal;
}

/** Public transport shape; no concrete ComputeClient implementation is used. */
export interface LegacyComputeTransport {
  health(execution: LegacyComputeExecutionOptions): Promise<ComputeWorkerHealth>;
  execute(
    request: ComputeRequest,
    execution: LegacyComputeExecutionOptions,
  ): Promise<ComputeResponse>;
  dispose?(): Promise<void> | void;
}

/**
 * Codec owns descriptor/artifact translation at the compatibility boundary.
 * Its request must bind market fields in ComputeRequest.options so the adapter
 * can verify it without reading implementation-specific files.
 */
export interface LegacyComputeMarketCodec {
  createRequest(
    request: MarketDataRequest,
    context: LegacyComputeExecutionOptions,
  ): Promise<ComputeRequest>;
  decodeResponse(
    marketRequest: MarketDataRequest,
    request: ComputeRequest,
    response: ComputeResponse,
    context: LegacyComputeExecutionOptions,
  ): Promise<MarketDataProviderOutput>;
  dispose?(): Promise<void> | void;
}

export interface LegacyComputeMarketProviderOptions {
  readonly id: string;
  readonly legacyProvider: "fixture" | "akshare";
  readonly transport: LegacyComputeTransport;
  readonly codec: LegacyComputeMarketCodec;
  /** Must be attested by the bridge; unsupported fails runtime readiness. */
  readonly cancellation: MarketDataCancellationCapability;
}

/**
 * Compatibility adapter only. Its isolated artifact writes make it ineligible
 * for shadow execution even though it does not write primary application data.
 */
export function createLegacyComputeMarketProvider(
  options: LegacyComputeMarketProviderOptions,
): MarketDataProviderDescriptor {
  return {
    id: options.id,
    capabilities: {
      cancellation: options.cancellation,
      effects: "isolated-artifacts",
    },
    readiness: async ({ signal }) => {
      if (!options.cancellation.guaranteed) {
        return { ready: false, reason: options.cancellation.reason };
      }
      const health = await options.transport.health({ signal });
      if (
        health.status !== "ok" ||
        !health.implementedOperations.includes("fetch_market_data") ||
        !health.capabilities.fetch_market_data.providers.includes(
          options.legacyProvider,
        )
      ) {
        return {
          ready: false,
          reason: "Legacy compute worker does not advertise the requested market provider",
        };
      }
      if (
        options.legacyProvider === "akshare" &&
        health.dependencies.akshare !== true
      ) {
        return {
          ready: false,
          reason: "Legacy compute worker reports AKShare unavailable",
        };
      }
      return { ready: true, reason: null };
    },
    fetch: async (marketRequest, { signal }) => {
      const request = await options.codec.createRequest(marketRequest, { signal });
      validateLegacyRequest(request, marketRequest, options.legacyProvider);
      const response = await options.transport.execute(request, { signal });
      if (response.requestId !== request.requestId) {
        throw legacyFailure("Legacy compute response requestId mismatch", false);
      }
      if (response.status === "failed") {
        const errorCode = response.metrics.errorCode;
        throw legacyFailure(
          response.error ?? "Legacy compute market request failed",
          legacyRetryable(errorCode),
        );
      }
      if (
        response.error !== null ||
        response.metrics.provider !== options.legacyProvider ||
        response.metrics.adjustment !== "raw"
      ) {
        throw legacyFailure(
          "Legacy compute response did not attest provider/raw adjustment",
          false,
        );
      }
      return options.codec.decodeResponse(
        marketRequest,
        request,
        response,
        { signal },
      );
    },
    dispose: async () => {
      const errors: unknown[] = [];
      try {
        await options.codec.dispose?.();
      } catch (error) {
        errors.push(error);
      }
      try {
        await options.transport.dispose?.();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Legacy compute adapter cleanup failed");
      }
    },
  };
}

function validateLegacyRequest(
  request: ComputeRequest,
  marketRequest: MarketDataRequest,
  legacyProvider: "fixture" | "akshare",
): void {
  if (request.operation !== "fetch_market_data") {
    throw legacyFailure(
      "Legacy codec produced a non-market compute operation",
      false,
    );
  }
  if (
    request.options.provider !== legacyProvider ||
    request.options.ticker !== marketRequest.ticker ||
    request.options.startDate !== marketRequest.startDate ||
    request.options.endDate !== marketRequest.endDate
  ) {
    throw legacyFailure(
      "Legacy compute request options are not bound to the market request",
      false,
    );
  }
}

function legacyRetryable(errorCode: unknown): boolean {
  return (
    errorCode === "compute_failed" ||
    errorCode === "worker_error" ||
    errorCode === "dependency_unavailable" ||
    errorCode === "provider_network_error"
  );
}

function legacyFailure(message: string, retryable: boolean): MarketDataError {
  return new MarketDataError(message, {
    code: retryable ? "provider_unavailable" : "provider_failure",
    retryable,
    fallbackEligible: true,
  });
}
