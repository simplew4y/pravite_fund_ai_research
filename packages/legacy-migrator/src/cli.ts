#!/usr/bin/env node

import path from "node:path";

import {
  loadMigrationConfig,
  runLegacyMigration,
} from "./orchestrator.js";
import { LegacyMigrationError, errorMessage } from "./errors.js";

interface CliArguments {
  readonly configPath: string;
  readonly dryRun: boolean;
  readonly reportPath: string | null;
}

function usage(): string {
  return [
    "Usage: private-fund-legacy-migrate --config <mapping.json> [options]",
    "",
    "Options:",
    "  --dry-run          Validate and plan without writing any destination file",
    "  --report <path>     Override reportPath from the config",
    "  --help              Show this help",
  ].join("\n");
}

function parseArguments(argv: readonly string[]): CliArguments {
  let configPath: string | null = null;
  let reportPath: string | null = null;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--config" || argument === "--report") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`${argument} requires a path`);
      }
      if (argument === "--config") configPath = path.resolve(value);
      else reportPath = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (configPath === null) {
    throw new Error("--config is required");
  }
  return { configPath, dryRun, reportPath };
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const loaded = loadMigrationConfig(arguments_.configPath);
  const config = {
    ...loaded,
    ...(arguments_.dryRun ? { dryRun: true } : {}),
    ...(arguments_.reportPath === null
      ? {}
      : { reportPath: arguments_.reportPath }),
  };
  const result = await runLegacyMigration(config);
  process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  if (result.report.status === "failed") process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      status: "failed",
      code:
        error instanceof LegacyMigrationError
          ? error.code
          : "migration_error",
      error: errorMessage(error),
    })}\n`,
  );
  process.exitCode = 1;
}

