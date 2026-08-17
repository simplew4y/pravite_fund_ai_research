import { createHmac } from "node:crypto";

import {
  createLocalEncryptedBlobStore,
  type LocalEncryptedBlobStore,
  type TenantEncryptionKey,
  type TenantKeyResolver,
} from "@private-fund/blob-store";
import { defineKernelPlugin, provide } from "@private-fund/kernel";

declare module "@private-fund/kernel" {
  interface KernelServices {
    blobStore: LocalEncryptedBlobStore;
  }
}

export interface BlobStorePluginConfig {
  rootDirectory: string;
  /** Master secret (>=32 bytes); per-tenant keys are HKDF-style derived. */
  masterKey: string;
}

const KEY_VERSION = "v1";

/**
 * Deterministic per-tenant key derivation from one master secret. The keyId
 * embeds the derivation version so future master-key rotation can resolve
 * historical keys.
 */
export function deriveTenantKeyResolver(masterKey: string): TenantKeyResolver {
  function derive(tenantId: string, version: string): TenantEncryptionKey {
    const key = createHmac("sha256", masterKey)
      .update(`private-fund-blob:${version}:${tenantId}`)
      .digest();
    return { keyId: `${version}:${tenantId}`, key: new Uint8Array(key) };
  }
  return {
    getActiveKey: (tenantId) => derive(tenantId, KEY_VERSION),
    getKey: (tenantId, keyId) => {
      const [version, keyTenant] = keyId.split(":", 2);
      if (!version || keyTenant !== tenantId) return null;
      return derive(tenantId, version);
    },
  };
}

/**
 * Seam pilot #1: content-addressed encrypted blob storage as a kernel
 * capability (`ctx.blobStore`). Dispose drains in-flight operations.
 */
export const blobStorePlugin = defineKernelPlugin<BlobStorePluginConfig>({
  name: "blob-store",
  provides: ["blobStore"],
  apply(ctx, config) {
    if (config.masterKey.length < 32) {
      throw new Error("blob-store master key must be at least 32 characters");
    }
    const store = createLocalEncryptedBlobStore({
      rootDirectory: config.rootDirectory,
      keyResolver: deriveTenantKeyResolver(config.masterKey),
    });
    ctx.effect(() => () => store.dispose(), "blob-store:dispose");
    provide(ctx, "blobStore", store);
  },
});
