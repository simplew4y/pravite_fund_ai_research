import { fileURLToPath } from "node:url";

import { createKernel, type Kernel } from "@private-fund/kernel";
import type { ControlDatabase } from "@private-fund/db";

import type { createApiApp } from "./app.js";
import { loadApiConfig, type ApiConfig } from "./config.js";
import { blobStorePlugin } from "./kernel-plugins/blob-store.js";
import { legacyApiPlugin } from "./kernel-plugins/legacy-api.js";

export interface ApiRuntime {
  readonly config: ApiConfig;
  readonly app: Awaited<ReturnType<typeof createApiApp>>;
  readonly database: ControlDatabase;
  readonly kernel: Kernel;
  close(): Promise<void>;
}

/**
 * Boot the API through the plugin kernel. Phase 0 profile:
 *   blob-store (optional, seam pilot) → legacy-api (the entire pre-kernel
 *   assembly wrapped as one plugin).
 * Teardown = kernel.stop(): reverse load order, every disposer awaited.
 */
export async function createApiRuntime(
  config: ApiConfig = loadApiConfig(),
): Promise<ApiRuntime> {
  const kernel = createKernel();
  try {
    if (config.blobStore !== undefined) {
      await kernel.use(blobStorePlugin, {
        rootDirectory: config.blobStore.rootDirectory,
        masterKey: config.blobStore.masterKey,
      });
    }
    await kernel.use(legacyApiPlugin, { config });
  } catch (error) {
    await kernel.stop().catch(() => undefined);
    throw error;
  }
  const { app, database } = kernel.get("legacyApi");
  let closed = false;
  return {
    config,
    app,
    database,
    kernel,
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await kernel.stop();
    },
  };
}

export async function runApi(): Promise<void> {
  const runtime = await createApiRuntime();
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    await runtime.close();
  };
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
  await runtime.app.listen({
    host: runtime.config.host,
    port: runtime.config.port,
  });
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isEntryPoint) {
  runApi().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
