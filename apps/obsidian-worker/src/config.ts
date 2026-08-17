import path from "node:path";

import { DEFAULT_OBSIDIAN_PROJECTOR_VERSION } from "@private-fund/workflow-store";

export interface ObsidianWorkerConfig {
  readonly dataRoot: string;
  readonly controlDatabase: string;
  readonly managedRootRelative: string;
  readonly projectorVersion: string;
  readonly pollIntervalMs: number;
  readonly reconcileIntervalMs: number;
  readonly staleLeaseMs: number;
  readonly maxDrainEvents: number;
  readonly maxAttempts: number;
  readonly maxNoteBytes: number;
  readonly healthHost: string;
  readonly healthPort: number;
}

function integer(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${name} must be an integer from ${String(minimum)} to ${String(maximum)}`,
    );
  }
  return value;
}

function text(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
  maxLength = 1_000,
): string {
  const value = environment[name] ?? fallback;
  if (
    value.length === 0 ||
    value.length > maxLength ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new Error(`${name} contains invalid text`);
  }
  return value;
}

export function loadObsidianWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): ObsidianWorkerConfig {
  const dataRoot = path.resolve(
    workingDirectory,
    text(
      environment,
      "PRIVATE_FUND_DATA_ROOT",
      "output/ts-platform",
      8_000,
    ),
  );
  return {
    dataRoot,
    controlDatabase: path.resolve(
      workingDirectory,
      text(
        environment,
        "PRIVATE_FUND_CONTROL_DB",
        path.join(dataRoot, "control.sqlite3"),
        8_000,
      ),
    ),
    managedRootRelative: text(
      environment,
      "PRIVATE_FUND_OBSIDIAN_MANAGED_ROOT",
      "obsidian/managed",
    ),
    projectorVersion: text(
      environment,
      "PRIVATE_FUND_OBSIDIAN_PROJECTOR_VERSION",
      DEFAULT_OBSIDIAN_PROJECTOR_VERSION,
      240,
    ),
    pollIntervalMs: integer(
      environment,
      "PRIVATE_FUND_OBSIDIAN_POLL_INTERVAL_MS",
      1_000,
      10,
      60_000,
    ),
    reconcileIntervalMs: integer(
      environment,
      "PRIVATE_FUND_OBSIDIAN_RECONCILE_INTERVAL_MS",
      30_000,
      100,
      86_400_000,
    ),
    staleLeaseMs: integer(
      environment,
      "PRIVATE_FUND_OBSIDIAN_STALE_LEASE_MS",
      5 * 60_000,
      1_000,
      86_400_000,
    ),
    maxDrainEvents: integer(
      environment,
      "PRIVATE_FUND_OBSIDIAN_MAX_DRAIN_EVENTS",
      100,
      1,
      10_000,
    ),
    maxAttempts: integer(
      environment,
      "PRIVATE_FUND_OBSIDIAN_MAX_ATTEMPTS",
      4,
      1,
      100,
    ),
    maxNoteBytes: integer(
      environment,
      "PRIVATE_FUND_OBSIDIAN_MAX_NOTE_BYTES",
      8 * 1024 * 1024,
      1_024,
      256 * 1024 * 1024,
    ),
    healthHost: text(
      environment,
      "PRIVATE_FUND_OBSIDIAN_HEALTH_HOST",
      "127.0.0.1",
      255,
    ),
    healthPort: integer(
      environment,
      "PRIVATE_FUND_OBSIDIAN_HEALTH_PORT",
      6791,
      0,
      65_535,
    ),
  };
}
