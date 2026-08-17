import { fileURLToPath } from "node:url";

import { controlDbPlugin } from "@private-fund/db";
import { createKernel, defineKernelPlugin, provide } from "@private-fund/kernel";

import { SqliteObsidianProjectCatalog } from "./catalog.js";
import {
  loadObsidianWorkerConfig,
  type ObsidianWorkerConfig,
} from "./config.js";
import { startHealthServer } from "./health-server.js";
import { ObsidianOutboxRunner } from "./runner.js";

export interface ObsidianWorkerService {
  /** Resolves when the outbox run loop exits (after abort). */
  readonly done: Promise<void>;
}

declare module "@private-fund/kernel" {
  interface KernelServices {
    obsidianWorker: ObsidianWorkerService;
  }
}

/**
 * obsidian-worker profile plugin: outbox projector run loop + health
 * server. Dispose stops admission (health), aborts the loop, awaits it,
 * then closes the runner — all before the control DB closes.
 */
export const obsidianWorkerPlugin = defineKernelPlugin<{
  config: ObsidianWorkerConfig;
}>({
  name: "obsidian-worker",
  inject: ["controlDb"],
  provides: ["obsidianWorker"],
  async apply(ctx, { config }) {
    const runner = new ObsidianOutboxRunner({
      dataRoot: config.dataRoot,
      catalog: new SqliteObsidianProjectCatalog(ctx.controlDb.database),
      managedRootRelative: config.managedRootRelative,
      projectorVersion: config.projectorVersion,
      pollIntervalMs: config.pollIntervalMs,
      reconcileIntervalMs: config.reconcileIntervalMs,
      staleLeaseMs: config.staleLeaseMs,
      maxDrainEvents: config.maxDrainEvents,
      maxAttempts: config.maxAttempts,
      maxNoteBytes: config.maxNoteBytes,
      onEvent: (event) => {
        process.stderr.write(`${JSON.stringify(event)}\n`);
      },
    });
    ctx.effect(
      () => () => {
        runner.close();
      },
      "obsidian-worker:runner-close",
    );

    const health = await startHealthServer(() => runner.health(), {
      host: config.healthHost,
      port: config.healthPort,
    });
    ctx.effect(() => () => health.close(), "obsidian-worker:health-close");
    process.stderr.write(
      `${JSON.stringify({
        event: "obsidian_worker_ready",
        healthHost: health.host,
        healthPort: health.port,
        projectorVersion: config.projectorVersion,
      })}\n`,
    );

    const abort = new AbortController();
    const done = runner.run(abort.signal).then(() => undefined);
    ctx.effect(
      () => async () => {
        abort.abort();
        await done.catch(() => undefined);
      },
      "obsidian-worker:stop",
    );
    provide(ctx, "obsidianWorker", { done });
  },
});

export async function main(): Promise<void> {
  const config = loadObsidianWorkerConfig();
  const kernel = createKernel();
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void kernel.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await kernel.use(controlDbPlugin, { path: config.controlDatabase });
    await kernel.use(obsidianWorkerPlugin, { config });
    await kernel.get("obsidianWorker").done;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await kernel.stop().catch(() => undefined);
  }
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        event: "obsidian_worker_fatal",
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error),
      })}\n`,
    );
    process.exitCode = 1;
  });
}
