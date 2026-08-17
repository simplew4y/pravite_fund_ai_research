import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type {
  BaselineCoverage,
  ResolvedProjectMapping,
} from "./types.js";
import { LegacyMigrationError } from "./errors.js";
import { stableJson, stableSha256 } from "./stable.js";
import { tableExists } from "./sqlite.js";

export interface MigrationManifestPayload {
  readonly schemaVersion: 1;
  readonly mappingKey: string;
  readonly legacyNamespace: string;
  readonly legacyDatasetId: string;
  readonly userId: string;
  readonly dataNamespace: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly companyName: string | null;
  readonly ticker: string | null;
  readonly sourceFingerprint: string;
  readonly configSha256: string;
  readonly baselineSha256: string;
}

export interface MigrationManifest {
  readonly payload: MigrationManifestPayload;
  readonly sha256: string;
}

export function createMigrationManifest(
  mapping: ResolvedProjectMapping,
  sourceFingerprint: string,
  configSha256: string,
  baseline: BaselineCoverage,
): MigrationManifest {
  const payload: MigrationManifestPayload = {
    schemaVersion: 1,
    mappingKey: mapping.mappingKey,
    legacyNamespace: mapping.legacyNamespace,
    legacyDatasetId: mapping.legacyDatasetId,
    userId: mapping.userId,
    dataNamespace: mapping.dataNamespace,
    projectId: mapping.projectId,
    projectName: mapping.name,
    companyName: mapping.companyName,
    ticker: mapping.ticker,
    sourceFingerprint,
    configSha256,
    baselineSha256: baseline.sha256,
  };
  return { payload, sha256: stableSha256(payload) };
}

export function writeMigrationManifest(
  database: DatabaseSync,
  manifest: MigrationManifest,
  createdAt: string,
): void {
  if (tableExists(database, "legacy_migration_manifest")) {
    throw new LegacyMigrationError(
      "The legacy source unexpectedly contains a migration manifest table",
      "source_conflict",
    );
  }
  database.exec(`
    CREATE TABLE legacy_migration_manifest (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      manifest_sha256 TEXT NOT NULL UNIQUE,
      manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
      mapping_key TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      config_sha256 TEXT NOT NULL,
      baseline_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
  `);
  database
    .prepare(
      `INSERT INTO legacy_migration_manifest(
         singleton, manifest_sha256, manifest_json, mapping_key,
         source_fingerprint, config_sha256, baseline_sha256, created_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      manifest.sha256,
      stableJson(manifest.payload),
      manifest.payload.mappingKey,
      manifest.payload.sourceFingerprint,
      manifest.payload.configSha256,
      manifest.payload.baselineSha256,
      createdAt,
    );
}

export function readMigrationManifest(
  database: DatabaseSync,
): MigrationManifest | null {
  if (!tableExists(database, "legacy_migration_manifest")) return null;
  const row = database
    .prepare(
      `SELECT manifest_sha256, manifest_json
       FROM legacy_migration_manifest
       WHERE singleton=1`,
    )
    .get();
  if (
    typeof row?.manifest_sha256 !== "string" ||
    typeof row.manifest_json !== "string"
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(
      row.manifest_json,
    ) as MigrationManifestPayload;
    return { payload, sha256: row.manifest_sha256 };
  } catch {
    return null;
  }
}

export function assertDestinationManifest(
  filename: string,
  expected: MigrationManifest,
): "missing" | "matching" {
  if (!existsSync(filename)) return "missing";
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(filename, {
      allowExtension: false,
      readOnly: true,
      timeout: 5_000,
    });
    database.exec("PRAGMA query_only=ON");
    const actual = readMigrationManifest(database);
    if (
      actual === null ||
      actual.sha256 !== expected.sha256 ||
      stableJson(actual.payload) !== stableJson(expected.payload)
    ) {
      throw new LegacyMigrationError(
        `Existing destination has no matching migration manifest: ${filename}`,
        "destination_conflict",
      );
    }
    return "matching";
  } catch (error) {
    if (error instanceof LegacyMigrationError) throw error;
    throw new LegacyMigrationError(
      `Cannot verify existing destination database: ${filename}`,
      "destination_conflict",
      { cause: error },
    );
  } finally {
    database?.close();
  }
}

