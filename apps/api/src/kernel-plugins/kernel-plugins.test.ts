import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createKernel } from "@private-fund/kernel";
import {
  createFakeMarketDataProvider,
  type MarketDataProviderOutput,
  type MarketDataRequest,
} from "@private-fund/market-data";
import { afterEach, describe, expect, it } from "vitest";

import { blobStorePlugin, deriveTenantKeyResolver } from "./blob-store.js";
import { marketDataPlugin } from "./market-data.js";

const MASTER_KEY = "0123456789abcdef0123456789abcdef";

let tempRoot: string | null = null;

afterEach(() => {
  if (tempRoot !== null) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

describe("deriveTenantKeyResolver", () => {
  it("derives stable 32-byte tenant keys and resolves by keyId", async () => {
    const resolver = deriveTenantKeyResolver(MASTER_KEY);
    const active = await resolver.getActiveKey("tenant-a");
    expect(active.key).toHaveLength(32);
    const resolved = await resolver.getKey("tenant-a", active.keyId);
    expect(resolved?.key).toEqual(active.key);
    const other = await resolver.getActiveKey("tenant-b");
    expect(other.key).not.toEqual(active.key);
    expect(await resolver.getKey("tenant-b", active.keyId)).toBeNull();
  });
});

describe("blobStorePlugin", () => {
  it("provides ctx.blobStore with round-trip put/read and clean dispose", async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "pf-blob-"));
    const kernel = createKernel();
    await kernel.use(blobStorePlugin, {
      rootDirectory: path.join(tempRoot, "blobs"),
      masterKey: MASTER_KEY,
    });
    const store = kernel.get("blobStore");
    const payload = new TextEncoder().encode("journal payload");
    const reference = await store.put({
      tenantId: "tenant-a",
      source: payload,
      mimeType: "text/plain",
      classification: "internal",
    });
    const read = await store.read({ tenantId: "tenant-a", reference });
    expect(new TextDecoder().decode(read.bytes)).toBe("journal payload");
    await kernel.stop();
    await expect(
      store.put({
        tenantId: "tenant-a",
        source: payload,
        mimeType: "text/plain",
        classification: "internal",
      }),
    ).rejects.toThrow();
  });

  it("rejects short master keys", async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "pf-blob-"));
    const kernel = createKernel();
    await expect(
      kernel.use(blobStorePlugin, {
        rootDirectory: path.join(tempRoot, "blobs"),
        masterKey: "short",
      }),
    ).rejects.toThrow(/master key/);
    await kernel.stop();
  });
});

describe("marketDataPlugin", () => {
  const request: MarketDataRequest = {
    ticker: "600276.SH",
    startDate: "2026-08-01",
    endDate: "2026-08-15",
  };

  const output: MarketDataProviderOutput = {
    source: "fake-a",
    retrievedAt: "2026-08-18T00:00:00.000Z",
    canonicalTicker: "600276.SH",
    providerSymbol: "600276",
    exchange: "SSE",
    currency: "CNY",
    adjustment: "raw",
    startDate: "2026-08-01",
    endDate: "2026-08-15",
    stale: false,
    cache: { status: "miss", ageMs: null },
    units: { price: "CNY", volume: "shares", amount: "CNY" },
    timezone: "Asia/Shanghai",
    bars: [
      {
        tradeDate: "2026-08-15",
        open: 48,
        high: 49,
        low: 47.5,
        close: 48.62,
        volume: 1000,
        amount: null,
      },
    ],
  };

  it("provides ctx.marketData with waterfall execution and awaited dispose", async () => {
    const kernel = createKernel();
    let disposed = false;
    const provider = createFakeMarketDataProvider({
      id: "fake-a",
      output,
      onDispose: () => {
        disposed = true;
      },
    });
    await kernel.use(marketDataPlugin, {
      providers: [provider],
      waterfall: ["fake-a"],
      totalTimeoutMs: 2_000,
    });
    const executor = kernel.get("marketData");
    const execution = await executor.fetch(request);
    expect(execution.data.bars[0]?.close).toBe(48.62);
    await kernel.stop();
    expect(disposed).toBe(true);
    await expect(executor.fetch(request)).rejects.toThrow();
  });
});
