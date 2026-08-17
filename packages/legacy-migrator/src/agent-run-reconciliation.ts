import type { DatabaseSync } from "node:sqlite";

import { LegacyMigrationError } from "./errors.js";
import {
  rows,
  tableExists,
  type SqlRow,
} from "./sqlite.js";
import { stableJson, stableSha256 } from "./stable.js";
import type {
  ResolvedProjectMapping,
  TableReconciliation,
} from "./types.js";

const AGENT_RUN_MAPPINGS = [
  {
    legacyTable: "valuation_impact_agent_runs",
    idColumn: "run_id",
    targetJobType: "valuation.compare",
  },
  {
    legacyTable: "valuation_metric_agent_extractions",
    idColumn: "extraction_id",
    targetJobType: "valuation.extract",
  },
] as const;

interface ExpectedReconciliation {
  readonly reconciliationId: string;
  readonly datasetId: string;
  readonly legacyTable: string;
  readonly legacyRunId: string;
  readonly legacyStatus: string;
  readonly targetJobType: string;
  readonly sourceFingerprint: string;
  readonly legacyRowSha256: string;
  readonly legacyPayloadJson: string;
  readonly reason: string;
}

function requiredText(
  row: SqlRow,
  key: string,
  table: string,
): string {
  const value = row[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LegacyMigrationError(
      `${table}.${key} is missing; the Agent run cannot be reconciled`,
      "legacy_schema",
    );
  }
  return value;
}

function comparableRow(
  row: SqlRow,
  mapping: ResolvedProjectMapping,
): Record<string, null | number | string> {
  const result: Record<string, null | number | string> = {};
  for (const key of Object.keys(row).sort()) {
    const value = row[key] ?? null;
    if (typeof value === "bigint") {
      result[key] = value.toString();
    } else if (value instanceof Uint8Array) {
      result[key] = Buffer.from(value).toString("base64");
    } else {
      result[key] = value;
    }
  }
  if (Object.hasOwn(result, "dataset_id")) {
    result.dataset_id = mapping.projectId;
  }
  return result;
}

function expectedRows(
  source: DatabaseSync,
  mapping: ResolvedProjectMapping,
  sourceFingerprint: string,
): readonly ExpectedReconciliation[] {
  const result: ExpectedReconciliation[] = [];
  for (const descriptor of AGENT_RUN_MAPPINGS) {
    if (!tableExists(source, descriptor.legacyTable)) continue;
    for (const row of rows(source, descriptor.legacyTable)) {
      const legacyRunId = requiredText(
        row,
        descriptor.idColumn,
        descriptor.legacyTable,
      );
      const legacyStatus = requiredText(
        row,
        "status",
        descriptor.legacyTable,
      );
      const payload = stableJson(comparableRow(row, mapping));
      const legacyRowSha256 = stableSha256(payload);
      result.push({
        reconciliationId: `lar_${stableSha256([
          descriptor.legacyTable,
          legacyRunId,
        ]).slice(0, 32)}`,
        datasetId: mapping.projectId,
        legacyTable: descriptor.legacyTable,
        legacyRunId,
        legacyStatus,
        targetJobType: descriptor.targetJobType,
        sourceFingerprint,
        legacyRowSha256,
        legacyPayloadJson: payload,
        reason:
          `Legacy Python Agent execution is not a control-plane ${descriptor.targetJobType} job; ` +
          "the raw row is preserved and quarantined until an explicit recomputation creates a real job",
      });
    }
  }
  return result.sort((left, right) =>
    `${left.legacyTable}\0${left.legacyRunId}`.localeCompare(
      `${right.legacyTable}\0${right.legacyRunId}`,
    ),
  );
}

function reconciliationComparable(
  value: ExpectedReconciliation,
): Record<string, string> {
  return {
    reconciliation_id: value.reconciliationId,
    dataset_id: value.datasetId,
    legacy_table: value.legacyTable,
    legacy_run_id: value.legacyRunId,
    legacy_status: value.legacyStatus,
    target_job_type: value.targetJobType,
    disposition: "quarantined",
    source_fingerprint: value.sourceFingerprint,
    legacy_row_sha256: value.legacyRowSha256,
    legacy_payload_json: value.legacyPayloadJson,
    reason: value.reason,
  };
}

function destinationComparable(
  database: DatabaseSync,
  sourceFingerprint: string,
): readonly Record<string, string>[] {
  if (!tableExists(database, "legacy_agent_run_reconciliation_manifest")) {
    return [];
  }
  return database
    .prepare(
      `SELECT reconciliation_id, dataset_id, legacy_table, legacy_run_id,
              legacy_status, target_job_type, disposition,
              source_fingerprint, legacy_row_sha256, legacy_payload_json,
              reason, control_job_id
       FROM legacy_agent_run_reconciliation_manifest
       WHERE source_fingerprint=?
       ORDER BY legacy_table, legacy_run_id`,
    )
    .all(sourceFingerprint)
    .map((row) => {
      if (row.control_job_id !== null) {
        throw new LegacyMigrationError(
          `Quarantined legacy Agent run ${String(row.legacy_run_id)} was assigned a control job without an explicit verified reconciliation`,
          "reconciliation_failed",
        );
      }
      return Object.fromEntries(
        Object.entries(row)
          .filter(([key]) => key !== "control_job_id")
          .map(([key, value]) => [key, String(value)]),
      );
    });
}

export function writeLegacyAgentRunReconciliation(
  source: DatabaseSync,
  destination: DatabaseSync,
  mapping: ResolvedProjectMapping,
  sourceFingerprint: string,
  reconciledAt: string,
): void {
  if (!tableExists(destination, "legacy_agent_run_reconciliation_manifest")) {
    throw new LegacyMigrationError(
      "Workflow store has no legacy Agent-run reconciliation schema",
      "reconciliation_failed",
    );
  }
  const statement = destination.prepare(
    `INSERT INTO legacy_agent_run_reconciliation_manifest(
       reconciliation_id, dataset_id, legacy_table, legacy_run_id,
       legacy_status, target_job_type, control_job_id, disposition,
       source_fingerprint, legacy_row_sha256, legacy_payload_json, reason,
       reconciled_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'quarantined', ?, ?, ?, ?, ?)
     ON CONFLICT(legacy_table, legacy_run_id) DO NOTHING`,
  );
  for (const expected of expectedRows(
    source,
    mapping,
    sourceFingerprint,
  )) {
    statement.run(
      expected.reconciliationId,
      expected.datasetId,
      expected.legacyTable,
      expected.legacyRunId,
      expected.legacyStatus,
      expected.targetJobType,
      expected.sourceFingerprint,
      expected.legacyRowSha256,
      expected.legacyPayloadJson,
      expected.reason,
      reconciledAt,
    );
  }
  reconcileLegacyAgentRuns(
    source,
    destination,
    mapping,
    sourceFingerprint,
  );
}

export function reconcileLegacyAgentRuns(
  source: DatabaseSync,
  destination: DatabaseSync,
  mapping: ResolvedProjectMapping,
  sourceFingerprint: string,
): TableReconciliation {
  const expected = expectedRows(source, mapping, sourceFingerprint).map(
    reconciliationComparable,
  );
  const actual = destinationComparable(destination, sourceFingerprint);
  const sourceChecksum = stableSha256(expected);
  const destinationChecksum = stableSha256(actual);
  const matched =
    expected.length === actual.length &&
    sourceChecksum === destinationChecksum;
  if (!matched) {
    throw new LegacyMigrationError(
      "Legacy Agent-run quarantine manifest does not exactly reconcile to the source",
      "reconciliation_failed",
    );
  }
  return {
    table: "@reconciliation/legacy-agent-runs",
    mode: "normalized",
    sourceRows: expected.length,
    destinationRows: actual.length,
    sourceChecksum,
    destinationChecksum,
    matched,
  };
}
