import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Clock } from "@private-fund/core";
import { systemClock } from "@private-fund/core";

import { runMigrations } from "./migrations.js";

export interface OpenControlDatabaseOptions {
  readonly readOnly?: boolean;
  readonly migrate?: boolean;
  readonly timeoutMs?: number;
  readonly clock?: Clock;
}

export type ControlDatabase = DatabaseSync;

export function openControlDatabase(
  filename: string,
  options: OpenControlDatabaseOptions = {},
): ControlDatabase {
  const readOnly = options.readOnly ?? false;
  if (!readOnly && filename !== ":memory:") {
    mkdirSync(path.dirname(path.resolve(filename)), {
      recursive: true,
      mode: 0o700,
    });
  }

  const database = new DatabaseSync(filename, {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readOnly,
    timeout: options.timeoutMs ?? 5_000,
  });

  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`PRAGMA busy_timeout = ${String(options.timeoutMs ?? 5_000)}`);

  if (!readOnly) {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec("PRAGMA trusted_schema = OFF");
    if (options.migrate ?? true) {
      runMigrations(database, options.clock ?? systemClock);
    }
  }

  return database;
}
