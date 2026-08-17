import type {
  ComputeRequest,
  ComputeResponse,
  ComputeWorkerHealth,
} from "@private-fund/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  MarketDataWaterfall,
  createLegacyComputeMarketProvider,
  type LegacyComputeMarketCodec,
  type LegacyComputeTransport,
} from "../src/index.js";
import { REQUEST, providerOutput } from "./fixtures.js";

const HEALTH: ComputeWorkerHealth = {
  protocolVersion: 1,
  status: "ok",
  worker: "private-fund-compute-worker",
  pythonVersion: "3.12.1",
  implementedOperations: ["fetch_market_data"],
  contractOperations: ["fetch_market_data"],
  capabilities: {
    extract_document: {
      extensions: [".txt"],
      recordsMediaType: "application/x-ndjson",
      boundedExtraction: true,
    },
    fetch_market_data: {
      providers: ["fixture", "akshare"],
      akshareOptional: true,
    },
  },
  dependencies: { akshare: true },
};

const COMPUTE_REQUEST: ComputeRequest = {
  protocolVersion: 1,
  requestId: "request-1",
  jobId: "job-1",
  operation: "fetch_market_data",
  inputPath: "/isolated/request.json",
  outputDirectory: "/isolated/output",
  options: {
    provider: "akshare",
    ticker: REQUEST.ticker,
    startDate: REQUEST.startDate,
    endDate: REQUEST.endDate,
  },
};

const COMPUTE_RESPONSE: ComputeResponse = {
  protocolVersion: 1,
  requestId: "request-1",
  status: "completed",
  recordsFile: "market-records.ndjson",
  artifacts: [],
  metrics: { provider: "akshare", adjustment: "raw" },
  error: null,
};

describe("legacy compute market adapter", () => {
  it("depends on public compute contracts and requires explicit cancellation attestation", async () => {
    const health = vi.fn(async () => HEALTH);
    const execute = vi.fn(async () => COMPUTE_RESPONSE);
    const decodeResponse = vi.fn(async () =>
      providerOutput({ source: "legacy AKShare" }),
    );
    const transport: LegacyComputeTransport = { health, execute };
    const codec: LegacyComputeMarketCodec = {
      createRequest: async () => COMPUTE_REQUEST,
      decodeResponse,
    };
    const provider = createLegacyComputeMarketProvider({
      id: "legacy-akshare",
      legacyProvider: "akshare",
      transport,
      codec,
      cancellation: { mode: "process-termination", guaranteed: true },
    });
    const runtime = new MarketDataWaterfall({
      providers: [provider],
      waterfall: ["legacy-akshare"],
    });
    expect(runtime.effects).toBe("isolated-artifacts");
    expect(runtime.shadowSafe).toBe(false);
    await runtime.start();

    const result = await runtime.fetch(REQUEST);

    expect(result.data).toMatchObject({
      providerId: "legacy-akshare",
      source: "legacy AKShare",
    });
    expect(health).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      COMPUTE_REQUEST,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(decodeResponse).toHaveBeenCalledOnce();
    await runtime.dispose();
  });

  it("fails readiness instead of claiming unsupported HTTP/thread cancellation", async () => {
    const health = vi.fn(async () => HEALTH);
    const provider = createLegacyComputeMarketProvider({
      id: "legacy-unsafe",
      legacyProvider: "akshare",
      transport: {
        health,
        execute: async () => COMPUTE_RESPONSE,
      },
      codec: {
        createRequest: async () => COMPUTE_REQUEST,
        decodeResponse: async () => providerOutput(),
      },
      cancellation: {
        mode: "unsupported",
        guaranteed: false,
        reason: "AKShare HTTP call may outlive AbortSignal",
      },
    });
    const runtime = new MarketDataWaterfall({
      providers: [provider],
      waterfall: ["legacy-unsafe"],
    });

    await expect(runtime.start()).rejects.toMatchObject({
      code: "readiness_failed",
      retryable: false,
    });
    expect(health).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it("rejects a codec request that is not bound through public options", async () => {
    const execute = vi.fn(async () => COMPUTE_RESPONSE);
    const provider = createLegacyComputeMarketProvider({
      id: "legacy-mismatch",
      legacyProvider: "akshare",
      transport: { health: async () => HEALTH, execute },
      codec: {
        createRequest: async () => ({
          ...COMPUTE_REQUEST,
          options: { ...COMPUTE_REQUEST.options, ticker: "000001.SZ" },
        }),
        decodeResponse: async () => providerOutput(),
      },
      cancellation: { mode: "process-termination", guaranteed: true },
    });
    const runtime = new MarketDataWaterfall({
      providers: [provider],
      waterfall: ["legacy-mismatch"],
    });
    await runtime.start();

    const failure = await runtime.fetch(REQUEST).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "providers_exhausted" });
    expect(execute).not.toHaveBeenCalled();
    await runtime.dispose();
  });
});
