import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createKernel } from "@private-fund/kernel";
import { afterEach, describe, expect, it } from "vitest";

import { blobStorePlugin, deriveTenantKeyResolver } from "./blob-store.js";

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

describe("modelGatewayPlugin", () => {
  it("memoizes per-tenant gateways and disposes them on stop", async () => {
    const { modelGatewayPlugin } = await import("./model-gateway.js");
    const kernel = createKernel();
    const journalTenants: string[] = [];
    await kernel.use(modelGatewayPlugin, {
      provider: {
        id: "fake-provider",
        // eslint-disable-next-line @typescript-eslint/require-await
        stream: async function* () {
          yield {};
        } as never,
      },
      createJournal: (tenantNamespace) => {
        journalTenants.push(tenantNamespace);
        return {
          commitRequest: async () => ({
            eventId: "event-1",
            sequence: 1,
            created: true,
          }),
          commitProviderEvent: async () => undefined,
        };
      },
    });
    const capability = kernel.get("modelGateway");
    const alpha = capability.forTenant("ns-a");
    expect(capability.forTenant("ns-a")).toBe(alpha);
    capability.forTenant("ns-b");
    expect(journalTenants).toEqual(["ns-a", "ns-b"]);
    await kernel.stop();
  });
});
