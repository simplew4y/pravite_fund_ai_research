import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { LegacyMigrationError } from "./errors.js";
import {
  isPathWithin,
  requireExistingPathWithin,
  safeComponent,
} from "./path-policy.js";
import {
  rowChecksum,
  rows,
  tableColumns,
  tableExists,
} from "./sqlite.js";
import { stableSha256 } from "./stable.js";
import type {
  FileReconciliation,
  ResolvedProjectMapping,
} from "./types.js";

export interface LegacyFilePlan extends FileReconciliation {
  readonly expectedLegacyChecksum: string | null;
}

export interface SourceInspection {
  readonly sourceFingerprint: string;
  readonly tableChecksums: ReadonlyMap<
    string,
    { readonly rows: number; readonly checksum: string }
  >;
  readonly filePlans: readonly LegacyFilePlan[];
}

export function openLegacyDatabase(filename: string): DatabaseSync {
  const database = new DatabaseSync(filename, {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: false,
    readOnly: true,
    timeout: 30_000,
  });
  database.exec("PRAGMA query_only=ON");
  database.exec("PRAGMA trusted_schema=OFF");
  database.exec("BEGIN");
  return database;
}

export function closeLegacyDatabase(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } finally {
    database.close();
  }
}

export function sha256File(filename: string): string {
  const hash = createHash("sha256");
  const descriptor = openSync(filename, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const length = readSync(descriptor, buffer, 0, buffer.length, null);
      if (length === 0) break;
      hash.update(buffer.subarray(0, length));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function resolveStoredSource(
  mapping: ResolvedProjectMapping,
  row: Record<string, unknown>,
): string | null {
  const stored = nullableString(row.stored_path);
  const originalFilename = nullableString(row.original_filename);
  const candidates = [
    stored === null
      ? null
      : path.isAbsolute(stored)
        ? stored
        : path.join(mapping.legacyProjectRoot, stored),
    originalFilename === null
      ? null
      : path.join(mapping.legacyProjectRoot, "raw", originalFilename),
  ].filter((candidate): candidate is string => candidate !== null);
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (existsSync(resolved)) return resolved;
  }
  return null;
}

function metadataOnlyAllowed(row: Record<string, unknown>): boolean {
  const status = nullableString(row.status)?.toLowerCase() ?? "";
  const lifecycle =
    nullableString(row.lifecycle_state)?.toLowerCase() ?? "active";
  return (
    row.deleted_at !== null && row.deleted_at !== undefined ||
    ["removed", "superseded", "failed_attempt"].includes(lifecycle) ||
    ["failed", "superseded", "removed"].includes(status)
  );
}

function filePlans(
  database: DatabaseSync,
  mapping: ResolvedProjectMapping,
  legacyRoot: string,
): readonly LegacyFilePlan[] {
  if (!tableExists(database, "documents")) return [];
  const columns = new Set(
    tableColumns(database, "documents").map((column) => column.name),
  );
  if (!columns.has("doc_id")) {
    throw new LegacyMigrationError(
      `${mapping.mappingKey}: legacy documents table has no doc_id`,
      "legacy_schema",
    );
  }
  const plans: LegacyFilePlan[] = [];
  for (const raw of database.prepare('SELECT * FROM "documents"').all()) {
    const row = raw as Record<string, unknown>;
    const versionId = String(row.doc_id ?? "");
    if (!versionId) {
      throw new LegacyMigrationError(
        `${mapping.mappingKey}: document row has an empty doc_id`,
        "legacy_schema",
      );
    }
    const source = resolveStoredSource(mapping, row);
    const metadataRelative = path.posix.join(
      "sources",
      "legacy",
      safeComponent(mapping.legacyDatasetId),
      safeComponent(versionId),
      "metadata-only",
    );
    if (source === null) {
      if (!metadataOnlyAllowed(row)) {
        throw new LegacyMigrationError(
          `${mapping.mappingKey}: active document ${versionId} has no readable stored file`,
          "source_conflict",
        );
      }
      plans.push({
        legacyDocumentVersionId: versionId,
        sourcePath: null,
        destinationPath: null,
        destinationRelativePath: metadataRelative,
        size: 0,
        sha256: null,
        expectedLegacyChecksum: nullableString(row.checksum),
        status: "metadata-only",
      });
      continue;
    }
    const real = requireExistingPathWithin(
      source,
      legacyRoot,
      `stored file for ${mapping.mappingKey}/${versionId}`,
    );
    if (!lstatSync(real).isFile()) {
      throw new LegacyMigrationError(
        `${mapping.mappingKey}: stored path for ${versionId} is not a regular file`,
        "source_conflict",
      );
    }
    const digest = sha256File(real);
    const expected = nullableString(row.checksum);
    if (
      expected !== null &&
      /^[0-9a-f]{64}$/iu.test(expected) &&
      expected.toLowerCase() !== digest
    ) {
      throw new LegacyMigrationError(
        `${mapping.mappingKey}: checksum mismatch for ${versionId}`,
        "source_conflict",
      );
    }
    const filename = safeComponent(
      nullableString(row.original_filename) ?? path.basename(real),
    );
    const relative = path.posix.join(
      "sources",
      "legacy",
      safeComponent(mapping.legacyDatasetId),
      safeComponent(versionId),
      filename,
    );
    plans.push({
      legacyDocumentVersionId: versionId,
      sourcePath: real,
      destinationPath: path.join(
        mapping.destinationProjectRoot,
        ...relative.split("/"),
      ),
      destinationRelativePath: relative,
      size: statSync(real).size,
      sha256: digest,
      expectedLegacyChecksum: expected,
      status: "planned",
    });
  }
  return plans.sort((left, right) =>
    left.legacyDocumentVersionId.localeCompare(
      right.legacyDocumentVersionId,
    ),
  );
}

function validateDatasetScope(
  database: DatabaseSync,
  mapping: ResolvedProjectMapping,
): void {
  const tables = database
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type='table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all()
    .map((row) => String(row.name));
  for (const table of tables) {
    if (
      !tableColumns(database, table).some(
        (column) => column.name === "dataset_id",
      )
    ) {
      continue;
    }
    const unexpected = database
      .prepare(
        `SELECT DISTINCT dataset_id
         FROM "${table.replaceAll('"', '""')}"
         WHERE dataset_id IS NOT NULL AND CAST(dataset_id AS TEXT) <> ?`,
      )
      .all(mapping.legacyDatasetId)
      .map((row) => String(row.dataset_id));
    if (unexpected.length > 0) {
      throw new LegacyMigrationError(
        `${mapping.mappingKey}: table ${table} contains foreign dataset IDs: ${unexpected.join(", ")}`,
        "mapping_required",
      );
    }
  }
}

export function inspectSource(
  database: DatabaseSync,
  mapping: ResolvedProjectMapping,
  legacyRoot: string,
): SourceInspection {
  validateDatasetScope(database, mapping);
  const tableChecksums = new Map<
    string,
    { rows: number; checksum: string }
  >();
  const tableNames = database
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type='table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all()
    .map((row) => String(row.name));
  for (const table of tableNames) {
    const sourceRows = rows(database, table);
    tableChecksums.set(table, {
      rows: sourceRows.length,
      checksum: rowChecksum(sourceRows),
    });
  }
  const plannedFiles = filePlans(database, mapping, legacyRoot);
  const sourceFingerprint = stableSha256({
    mappingKey: mapping.mappingKey,
    tables: Object.fromEntries(tableChecksums),
    files: plannedFiles.map((file) => ({
      id: file.legacyDocumentVersionId,
      size: file.size,
      sha256: file.sha256,
    })),
  });
  return {
    sourceFingerprint,
    tableChecksums,
    filePlans: plannedFiles,
  };
}
