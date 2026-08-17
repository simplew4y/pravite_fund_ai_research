import { openControlDatabase } from "@private-fund/db";
import { fileURLToPath } from "node:url";

import { SqliteObsidianProjectCatalog } from "./catalog.js";
import { loadObsidianWorkerConfig } from "./config.js";
import { startHealthServer } from "./health-server.js";
import { ObsidianOutboxRunner } from "./runner.js";

export async function main(): Promise<void> {
  const config = loadObsidianWorkerConfig();
  const control = openControlDatabase(config.controlDatabase);
  const abort = new AbortController();
  const stop = (): void => {
    abort.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const runner = new ObsidianOutboxRunner({
    dataRoot: config.dataRoot,
    catalog: new SqliteObsidianProjectCatalog(control),
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
  let health:
    | Awaited<ReturnType<typeof startHealthServer>>
    | undefined;
  try {
    health = await startHealthServer(() => runner.health(), {
      host: config.healthHost,
      port: config.healthPort,
    });
    process.stderr.write(
      `${JSON.stringify({
        event: "obsidian_worker_ready",
        healthHost: health.host,
        healthPort: health.port,
        projectorVersion: config.projectorVersion,
      })}\n`,
    );
    await runner.run(abort.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    runner.close();
    try {
      await health?.close();
    } finally {
      control.close();
    }
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
