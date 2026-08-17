import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Clock } from "@private-fund/core";
import {
  ForbiddenError,
  assertPathWithin,
  systemClock,
} from "@private-fund/core";

import {
  runProjectMigrations,
  type RunProjectMigrationsOptions,
} from "./migrations.js";
import type { SearchBackend } from "./types.js";

export interface OpenProjectDatabaseOptions
  extends RunProjectMigrationsOptions {
  readonly projectRoot: string;
  readonly databasePath: string;
  readonly timeoutMs?: number;
}

export class ProjectDatabase implements Disposable {
  public constructor(
    public readonly connection: DatabaseSync,
    public readonly databasePath: string,
    public readonly projectRoot: string | null,
    public readonly searchBackend: SearchBackend,
  ) {}

  public close(): void {
    if (this.connection.isOpen) {
      this.connection.close();
    }
  }

  public [Symbol.dispose](): void {
    this.close();
  }
}

export function resolveProjectDatabasePath(
  projectRoot: string,
  suppliedDatabasePath: string,
): string {
  if (!projectRoot.trim() || !suppliedDatabasePath.trim()) {
    throw new ForbiddenError("Project root and database path are required");
  }
  const requestedRoot = path.resolve(projectRoot);
  mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
  const realRoot = realpathSync(requestedRoot);
  const lexicalDatabase = path.isAbsolute(suppliedDatabasePath)
    ? path.resolve(suppliedDatabasePath)
    : path.resolve(requestedRoot, suppliedDatabasePath);
  assertPathWithin(lexicalDatabase, requestedRoot);
  const requestedDatabase = path.resolve(
    realRoot,
    path.relative(requestedRoot, lexicalDatabase),
  );
  assertPathWithin(requestedDatabase, realRoot);

  const requestedParent = path.dirname(requestedDatabase);
  mkdirSync(requestedParent, { recursive: true, mode: 0o700 });
  const realParent = realpathSync(requestedParent);
  assertPathWithin(realParent, realRoot);

  if (existsSync(requestedDatabase)) {
    if (lstatSync(requestedDatabase).isSymbolicLink()) {
      throw new ForbiddenError("Project database path must not be a symbolic link");
    }
    assertPathWithin(realpathSync(requestedDatabase), realRoot);
  }
  return path.join(realParent, path.basename(requestedDatabase));
}

function configureConnection(
  database: DatabaseSync,
  timeoutMs: number,
): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`PRAGMA busy_timeout = ${String(timeoutMs)}`);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec("PRAGMA trusted_schema = OFF");
}

export function openProjectDatabase(
  options: OpenProjectDatabaseOptions,
): ProjectDatabase {
  const databasePath = resolveProjectDatabasePath(
    options.projectRoot,
    options.databasePath,
  );
  const timeoutMs = options.timeoutMs ?? 10_000;
  const connection = new DatabaseSync(databasePath, {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    timeout: timeoutMs,
  });
  try {
    configureConnection(connection, timeoutMs);
    const migration = runProjectMigrations(connection, options);
    return new ProjectDatabase(
      connection,
      databasePath,
      realpathSync(path.resolve(options.projectRoot)),
      migration.searchBackend,
    );
  } catch (error) {
    connection.close();
    throw error;
  }
}

export interface OpenInMemoryProjectDatabaseOptions {
  readonly clock?: Clock;
  readonly preferredSearchBackend?: "auto" | "deterministic";
}

export function openInMemoryProjectDatabase(
  options: OpenInMemoryProjectDatabaseOptions = {},
): ProjectDatabase {
  const connection = new DatabaseSync(":memory:", {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    timeout: 10_000,
  });
  configureConnection(connection, 10_000);
  const migration = runProjectMigrations(connection, {
    clock: options.clock ?? systemClock,
    preferredSearchBackend: options.preferredSearchBackend ?? "auto",
  });
  return new ProjectDatabase(
    connection,
    ":memory:",
    null,
    migration.searchBackend,
  );
}
