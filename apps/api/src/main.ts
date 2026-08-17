import { fileURLToPath } from "node:url";

import { createKernel, type Kernel } from "@private-fund/kernel";
import type { ControlDatabase } from "@private-fund/db";

import type { createApiApp } from "./app.js";
import { loadApiConfig, type ApiConfig } from "./config.js";
import { agentRuntimePlugin } from "./kernel-plugins/agent-runtime.js";
import { blobStorePlugin } from "./kernel-plugins/blob-store.js";
import { controlDbPlugin } from "./kernel-plugins/db.js";
import {
  insightsPlugin,
  projectsJobsPlugin,
  researchPlugin,
  sessionsPlugin,
  uploadsPlugin,
} from "./kernel-plugins/domain-services.js";
import { apiHttpPlugin } from "./kernel-plugins/http.js";
import { identityPlugin } from "./kernel-plugins/identity.js";
import { researchStoresPlugin } from "./kernel-plugins/research-stores.js";

export interface ApiRuntime {
  readonly config: ApiConfig;
  readonly app: Awaited<ReturnType<typeof createApiApp>>;
  readonly database: ControlDatabase;
  readonly kernel: Kernel;
  close(): Promise<void>;
}

/**
 * The api profile. Load order = reverse dispose order, so teardown mirrors
 * the historical close chain (fastify → sessions → agent worker →
 * research stores → db):
 *
 *   control-db → research-stores → agent-runtime → [blob-store] →
 *   projects-jobs → research → uploads → insights → identity →
 *   sessions → api-http
 */
export async function createApiRuntime(
  config: ApiConfig = loadApiConfig(),
): Promise<ApiRuntime> {
  const kernel = createKernel();
  try {
    await kernel.use(controlDbPlugin, { path: config.controlDatabase });
    await kernel.use(researchStoresPlugin);
    await kernel.use(agentRuntimePlugin, { config });
    if (config.blobStore !== undefined) {
      await kernel.use(blobStorePlugin, {
        rootDirectory: config.blobStore.rootDirectory,
        masterKey: config.blobStore.masterKey,
      });
    }
    await kernel.use(projectsJobsPlugin);
    await kernel.use(researchPlugin, { config });
    await kernel.use(uploadsPlugin);
    await kernel.use(insightsPlugin);
    await kernel.use(identityPlugin, { config });
    await kernel.use(sessionsPlugin, { config });
    await kernel.use(apiHttpPlugin, { config });
  } catch (error) {
    await kernel.stop().catch(() => undefined);
    throw error;
  }
  const { app, database } = kernel.get("apiHttp");
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
