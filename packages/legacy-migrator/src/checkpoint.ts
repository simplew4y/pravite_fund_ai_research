import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { prepareDestinationDirectory } from "./path-policy.js";
import { stableJson } from "./stable.js";
import type { MigrationPhase, PhaseReport } from "./types.js";

export class MigrationCheckpointStore implements Disposable {
  readonly #database: DatabaseSync;

  public constructor(
    filename: string,
    destinationDataRoot: string,
  ) {
    prepareDestinationDirectory(path.dirname(filename), destinationDataRoot);
    this.#database = new DatabaseSync(filename, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      timeout: 30_000,
    });
    this.#database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA trusted_schema=OFF;
      CREATE TABLE IF NOT EXISTS legacy_migration_checkpoints (
        mapping_key TEXT NOT NULL,
        phase TEXT NOT NULL
          CHECK (phase IN ('control', 'files', 'research', 'workflow', 'reconcile')),
        source_fingerprint TEXT NOT NULL,
        config_sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        report_json TEXT CHECK (report_json IS NULL OR json_valid(report_json)),
        error TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (mapping_key, phase)
      ) STRICT, WITHOUT ROWID;
    `);
  }

  public start(
    mappingKey: string,
    phase: MigrationPhase,
    sourceFingerprint: string,
    configSha256: string,
    timestamp: string,
  ): number {
    const row = this.#database
      .prepare(
        `SELECT attempt FROM legacy_migration_checkpoints
         WHERE mapping_key=? AND phase=?`,
      )
      .get(mappingKey, phase);
    const attempt = Number(row?.attempt ?? 0) + 1;
    this.#database
      .prepare(
        `INSERT INTO legacy_migration_checkpoints(
           mapping_key, phase, source_fingerprint, config_sha256, status,
           attempt, report_json, error, started_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, 'running', ?, NULL, NULL, ?, ?, NULL)
         ON CONFLICT(mapping_key, phase) DO UPDATE SET
           source_fingerprint=excluded.source_fingerprint,
           config_sha256=excluded.config_sha256,
           status='running',
           attempt=excluded.attempt,
           report_json=NULL,
           error=NULL,
           started_at=excluded.started_at,
           updated_at=excluded.updated_at,
           completed_at=NULL`,
      )
      .run(
        mappingKey,
        phase,
        sourceFingerprint,
        configSha256,
        attempt,
        timestamp,
        timestamp,
      );
    return attempt;
  }

  public findCompleted(
    mappingKey: string,
    phase: MigrationPhase,
    sourceFingerprint: string,
    configSha256: string,
  ): PhaseReport | null {
    const row = this.#database
      .prepare(
        `SELECT report_json
         FROM legacy_migration_checkpoints
         WHERE mapping_key=? AND phase=?
           AND source_fingerprint=? AND config_sha256=?
           AND status='completed'`,
      )
      .get(mappingKey, phase, sourceFingerprint, configSha256);
    if (typeof row?.report_json !== "string") return null;
    try {
      const report = JSON.parse(row.report_json) as Partial<PhaseReport>;
      if (
        report.phase !== phase ||
        report.status !== "completed" ||
        typeof report.attempt !== "number" ||
        !Array.isArray(report.tables) ||
        !Array.isArray(report.files)
      ) {
        return null;
      }
      return report as PhaseReport;
    } catch {
      return null;
    }
  }

  public complete(
    mappingKey: string,
    report: PhaseReport,
  ): void {
    this.#database
      .prepare(
        `UPDATE legacy_migration_checkpoints
         SET status='completed', report_json=?, error=NULL,
             updated_at=?, completed_at=?
         WHERE mapping_key=? AND phase=?`,
      )
      .run(
        stableJson(report),
        report.completedAt,
        report.completedAt,
        mappingKey,
        report.phase,
      );
  }

  public fail(
    mappingKey: string,
    report: PhaseReport,
  ): void {
    this.#database
      .prepare(
        `UPDATE legacy_migration_checkpoints
         SET status='failed', report_json=?, error=?,
             updated_at=?, completed_at=?
         WHERE mapping_key=? AND phase=?`,
      )
      .run(
        stableJson(report),
        report.error,
        report.completedAt,
        report.completedAt,
        mappingKey,
        report.phase,
      );
  }

  public close(): void {
    if (this.#database.isOpen) this.#database.close();
  }

  public [Symbol.dispose](): void {
    this.close();
  }
}
