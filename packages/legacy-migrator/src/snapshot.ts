import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { LegacyMigrationError } from "./errors.js";
import { prepareDestinationDirectory } from "./path-policy.js";
import type {
  LegacyFilePlan,
  SourceInspection,
} from "./source.js";
import {
  cloneTables,
  quoteIdentifier,
  rowChecksum,
  rows,
  tableColumns,
} from "./sqlite.js";
import type { ResolvedProjectMapping } from "./types.js";

function fsyncFile(filename: string): void {
  const descriptor = openSync(filename, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(dirname: string): void {
  const descriptor = openSync(dirname, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export async function createConsistentSnapshot(
  source: DatabaseSync,
  stagingPath: string,
  sourcePath?: string,
): Promise<"backup" | "serialize" | "vacuum-into" | "schema-copy"> {
  if (existsSync(stagingPath)) {
    throw new LegacyMigrationError(
      `Refusing to overwrite staging database ${stagingPath}`,
      "destination_conflict",
    );
  }
  const sqliteModule = await import("node:sqlite");
  const maybeBackup = Reflect.get(sqliteModule, "backup") as
    | ((
        database: DatabaseSync,
        filename: string,
        options?: { readonly rate?: number },
      ) => Promise<number>)
    | undefined;
  if (typeof maybeBackup === "function") {
    await maybeBackup(source, stagingPath, { rate: 256 });
    fsyncFile(stagingPath);
    return "backup";
  }

  const maybeSerialize = Reflect.get(source, "serialize") as
    | (() => Uint8Array)
    | undefined;
  if (typeof maybeSerialize === "function") {
    /*
     * Some Node 22 builds expose serialize before its type declaration. The
     * bytes come from the same pinned read transaction.
     */
    writeFileSync(stagingPath, maybeSerialize.call(source), {
      flag: "wx",
      mode: 0o600,
    });
    fsyncFile(stagingPath);
    return "serialize";
  }

  if (sourcePath !== undefined) {
    /*
     * VACUUM INTO is a single consistent SQLite snapshot and leaves the source
     * contents unchanged. Verification below the caller compares it with the
     * already-pinned inspection transaction, so a concurrent source change
     * fails closed instead of publishing a mixed snapshot.
     */
    let vacuumSource: DatabaseSync | undefined;
    try {
      vacuumSource = new DatabaseSync(sourcePath, {
        allowExtension: false,
        timeout: 30_000,
      });
      const literal = stagingPath.replaceAll("'", "''");
      vacuumSource.exec(`VACUUM main INTO '${literal}'`);
      fsyncFile(stagingPath);
      return "vacuum-into";
    } catch {
      rmSync(stagingPath, { force: true });
    } finally {
      vacuumSource?.close();
    }
  }

  /*
   * Portable Node 22 fallback. It copies verbatim CREATE TABLE statements and
   * their rows while the source read transaction is pinned; cloneTables also
   * restores explicit indexes and triggers. This path never reconstructs a
   * loose schema from column affinity.
   */
  const staging = new DatabaseSync(stagingPath, {
    allowExtension: false,
    enableForeignKeyConstraints: false,
    timeout: 30_000,
  });
  try {
    const tableKinds = new Map(
      source
        .prepare("PRAGMA table_list")
        .all()
        .filter((row) => row.schema === "main")
        .map((row) => [String(row.name), String(row.type)]),
    );
    const tables = source
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type='table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all()
      .map((row) => String(row.name))
      .filter((table) => tableKinds.get(table) !== "shadow");
    staging.exec("PRAGMA foreign_keys=OFF");
    staging.exec("BEGIN IMMEDIATE");
    try {
      cloneTables(source, staging, tables);
      for (const row of source
        .prepare(
          `SELECT sql FROM sqlite_schema
           WHERE type='view' AND sql IS NOT NULL
           ORDER BY name`,
        )
        .all()) {
        if (typeof row.sql === "string") staging.exec(row.sql);
      }
      staging.exec("COMMIT");
    } catch (error) {
      staging.exec("ROLLBACK");
      throw error;
    }
  } finally {
    staging.close();
  }
  fsyncFile(stagingPath);
  return "schema-copy";
}

export function verifySnapshot(
  source: DatabaseSync,
  staging: DatabaseSync,
  inspection: SourceInspection,
): void {
  const integrity = staging.prepare("PRAGMA integrity_check").get();
  if (integrity?.integrity_check !== "ok") {
    throw new LegacyMigrationError(
      "SQLite staging snapshot failed integrity_check",
      "reconciliation_failed",
    );
  }
  for (const [table, expected] of inspection.tableChecksums) {
    const sourceSchema = source
      .prepare(
        `SELECT sql FROM sqlite_schema
         WHERE type='table' AND name=?`,
      )
      .get(table)?.sql;
    const stagingSchema = staging
      .prepare(
        `SELECT sql FROM sqlite_schema
         WHERE type='table' AND name=?`,
      )
      .get(table)?.sql;
    if (
      typeof sourceSchema !== "string" ||
      stagingSchema !== sourceSchema
    ) {
      throw new LegacyMigrationError(
        `Staging snapshot did not preserve schema for ${table}`,
        "reconciliation_failed",
      );
    }
    const stagingRows = rows(staging, table);
    if (
      stagingRows.length !== expected.rows ||
      rowChecksum(stagingRows) !== expected.checksum
    ) {
      throw new LegacyMigrationError(
        `Staging snapshot did not preserve rows for ${table}`,
        "reconciliation_failed",
      );
    }
  }
}

export function rewriteStagingIdentity(
  database: DatabaseSync,
  mapping: ResolvedProjectMapping,
  filePlans: readonly LegacyFilePlan[],
): void {
  const tables = database
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type='table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all()
    .map((row) => String(row.name));
  const plans = new Map(
    filePlans.map((plan) => [
      plan.legacyDocumentVersionId,
      plan.destinationRelativePath,
    ]),
  );
  database.exec("PRAGMA foreign_keys=OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const table of tables) {
      if (
        tableColumns(database, table).some(
          (column) => column.name === "dataset_id",
        )
      ) {
        const result = database
          .prepare(
            `UPDATE ${quoteIdentifier(table)}
             SET dataset_id=?
             WHERE dataset_id IS NOT NULL
               AND CAST(dataset_id AS TEXT)=?`,
          )
          .run(mapping.projectId, mapping.legacyDatasetId);
        const foreign = database
          .prepare(
            `SELECT 1
             FROM ${quoteIdentifier(table)}
             WHERE dataset_id IS NOT NULL
               AND CAST(dataset_id AS TEXT)<>?
             LIMIT 1`,
          )
          .get(mapping.projectId);
        if (foreign !== undefined) {
          throw new LegacyMigrationError(
            `Staging table ${table} contains an unmapped dataset identity`,
            "mapping_required",
          );
        }
        void result;
      }
    }
    if (tables.includes("documents")) {
      const documentColumns = new Set(
        tableColumns(database, "documents").map((column) => column.name),
      );
      if (
        !documentColumns.has("doc_id") ||
        !documentColumns.has("stored_path")
      ) {
        throw new LegacyMigrationError(
          "Legacy documents schema cannot be rewritten safely",
          "legacy_schema",
        );
      }
      for (const [versionId, relativePath] of plans) {
        const result = database
          .prepare(
            `UPDATE documents SET stored_path=? WHERE doc_id=?`,
          )
          .run(relativePath, versionId);
        if (Number(result.changes) !== 1) {
          throw new LegacyMigrationError(
            `Cannot rewrite stored_path for ${versionId}`,
            "reconciliation_failed",
          );
        }
      }
      const count = Number(
        database.prepare("SELECT COUNT(*) AS count FROM documents").get()?.count ??
          0,
      );
      if (count !== plans.size) {
        throw new LegacyMigrationError(
          "Not every legacy document has a deterministic file plan",
          "reconciliation_failed",
        );
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
}

export function prepareStagingPath(
  mapping: ResolvedProjectMapping,
  destinationDataRoot: string,
  nonce: string,
): string {
  const stagingDirectory = prepareDestinationDirectory(
    path.join(
      path.dirname(mapping.destinationResearchDatabase),
      ".migration-staging",
    ),
    destinationDataRoot,
  );
  return path.join(stagingDirectory, `research-${nonce}.sqlite3`);
}

export function makeDatabasePublishable(
  database: DatabaseSync,
  filename: string,
): void {
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  database.exec("PRAGMA journal_mode=DELETE");
  database.exec("PRAGMA synchronous=FULL");
  database.close();
  rmSync(`${filename}-wal`, { force: true });
  rmSync(`${filename}-shm`, { force: true });
  fsyncFile(filename);
}

export function publishDatabaseWithoutOverwrite(
  stagingPath: string,
  destinationPath: string,
  destinationDataRoot: string,
): void {
  const destinationDirectory = prepareDestinationDirectory(
    path.dirname(destinationPath),
    destinationDataRoot,
  );
  try {
    linkSync(stagingPath, destinationPath);
  } catch (error) {
    throw new LegacyMigrationError(
      `Refusing to overwrite destination database ${destinationPath}`,
      "destination_conflict",
      { cause: error },
    );
  }
  fsyncDirectory(destinationDirectory);
  rmSync(stagingPath, { force: true });
}
