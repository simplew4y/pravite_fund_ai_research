import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { reconcileLegacyAgentRuns } from "./agent-run-reconciliation.js";
import { WORKFLOW_DOMAIN_TABLES } from "./domain-tables.js";
import { LegacyMigrationError } from "./errors.js";
import type {
  LegacyFilePlan,
  SourceInspection,
} from "./source.js";
import {
  primaryKeyColumns,
  rowChecksum,
  rows,
  tableColumns,
  tableExists,
  type SqlRow,
} from "./sqlite.js";
import type {
  ResolvedProjectMapping,
  TableReconciliation,
} from "./types.js";

const WORKFLOW_JSON_COLUMNS = [
  ["research_memo_versions", "document_versions_json", []],
  ["research_memo_versions", "input_json", {}],
  ["research_memo_sections", "evidence_ids_json", []],
  ["research_item_versions", "metadata_json", {}],
  ["research_tracking_observations", "evidence_ids_json", []],
  ["research_tracking_observations", "extracted_json", {}],
  ["research_change_events", "details_json", {}],
  ["research_watch_rules", "query_json", {}],
  ["research_alerts", "evidence_ids_json", []],
  ["valuation_model_node_values", "metadata_json", {}],
  ["valuation_model_changes", "old_value_json", {}],
  ["valuation_model_changes", "new_value_json", {}],
  ["valuation_model_changes", "evidence_ids_json", []],
  ["valuation_analysis_versions", "analysis_json", {}],
  ["valuation_metric_model_values", "evidence_ids_json", []],
  ["valuation_metric_manual_overrides", "evidence_ids_json", []],
  ["valuation_market_snapshots", "raw_json", {}],
  ["valuation_metric_actual_values", "metadata_json", {}],
  ["valuation_metric_comparisons", "evidence_ids_json", []],
  ["valuation_watch_rules", "change_types_json", []],
  ["valuation_alerts", "evidence_ids_json", []],
  ["valuation_agent_analyses", "analysis_json", {}],
  ["valuation_agent_analyses", "planner_json", {}],
  ["valuation_agent_analyses", "evidence_ids_json", []],
  ["valuation_derived_models", "applied_changes_json", []],
  ["valuation_derived_models", "skipped_changes_json", []],
  ["research_node_versions", "input_manifest_json", {}],
  ["research_node_versions", "structured_output_json", {}],
  ["research_report_versions", "node_versions_json", {}],
  ["research_report_versions", "document_versions_json", []],
  ["obsidian_sync_outbox", "payload_json", {}],
  ["obsidian_sync_outbox", "result_json", {}],
] as const;

const NULLABLE_JSON_COLUMNS = new Set([
  "research_node_versions.structured_output_json",
  "obsidian_sync_outbox.result_json",
]);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeRelpath(value: string): string {
  const components = value
    .normalize("NFKC")
    .replaceAll("\\", "/")
    .split("/")
    .filter((component) => component.length > 0 && component !== ".");
  return components.join("/") || "document";
}

function normalizedJsonValue(
  table: string,
  column: string,
  value: unknown,
): unknown {
  const descriptor = WORKFLOW_JSON_COLUMNS.find(
    ([candidateTable, candidateColumn]) =>
      candidateTable === table && candidateColumn === column,
  );
  if (descriptor === undefined) return value;
  if (
    value === null &&
    NULLABLE_JSON_COLUMNS.has(`${table}.${column}`)
  ) {
    return null;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      const expectsArray = Array.isArray(descriptor[2]);
      if (
        (expectsArray && Array.isArray(parsed)) ||
        (!expectsArray &&
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed))
      ) {
        return value;
      }
    } catch {
      // The workflow migration quarantines and replaces this value.
    }
  }
  return JSON.stringify(descriptor[2]);
}

function transformSourceRow(
  table: string,
  row: SqlRow,
  mapping: ResolvedProjectMapping,
  files: ReadonlyMap<string, string>,
): SqlRow {
  const transformed: SqlRow = { ...row };
  if (
    transformed.dataset_id !== null &&
    transformed.dataset_id !== undefined
  ) {
    transformed.dataset_id = mapping.projectId;
  }
  if (table === "documents") {
    const versionId = text(transformed.doc_id);
    const relativePath = files.get(versionId);
    if (relativePath === undefined) {
      throw new LegacyMigrationError(
        `No stored_path mapping exists for ${versionId}`,
        "reconciliation_failed",
      );
    }
    transformed.stored_path = relativePath;
  }
  for (const column of Object.keys(transformed)) {
    transformed[column] = normalizedJsonValue(
      table,
      column,
      transformed[column],
    ) as SqlRow[string];
  }
  return transformed;
}

function legacyTableReport(
  source: DatabaseSync,
  destination: DatabaseSync,
  table: string,
  mapping: ResolvedProjectMapping,
  fileMap: ReadonlyMap<string, string>,
): TableReconciliation {
  const destinationTable =
    table === "documents"
      ? "legacy_documents_v0"
      : table === "source_folders"
        ? "legacy_source_folders_v0"
        : [
              "valuation_context_cards",
              "valuation_impact_cards",
              "valuation_market_price_bars",
              "valuation_price_comparisons",
            ].includes(table)
          ? `legacy_${table}_v0`
          : table;
  if (!tableExists(destination, destinationTable)) {
    throw new LegacyMigrationError(
      `Migrated database is missing source table ${destinationTable}`,
      "reconciliation_failed",
    );
  }
  const sourcePrimaryKey = primaryKeyColumns(source, table);
  const destinationPrimaryKey = primaryKeyColumns(
    destination,
    destinationTable,
  );
  if (
    sourcePrimaryKey.join("\0") !== destinationPrimaryKey.join("\0")
  ) {
    throw new LegacyMigrationError(
      `Primary key changed while migrating ${table}`,
      "reconciliation_failed",
    );
  }
  const destinationColumns = new Set(
    tableColumns(destination, destinationTable).map((column) => column.name),
  );
  const selectedColumns = tableColumns(source, table)
    .map((column) => column.name)
    .filter((column) => destinationColumns.has(column));
  if (
    selectedColumns.length !== tableColumns(source, table).length
  ) {
    throw new LegacyMigrationError(
      `Source columns were lost while migrating ${table}`,
      "reconciliation_failed",
    );
  }
  const sourceRows = rows(source, table).map((row) =>
    transformSourceRow(table, row, mapping, fileMap)
  );
  const destinationRows = rows(destination, destinationTable).map((row) =>
    Object.fromEntries(
      selectedColumns.map((column) => [column, row[column] ?? null]),
    ),
  );
  const sourceChecksum = rowChecksum(sourceRows, selectedColumns);
  const destinationChecksum = rowChecksum(
    destinationRows,
    selectedColumns,
  );
  const matched =
    sourceRows.length === destinationRows.length &&
    sourceChecksum === destinationChecksum;
  return {
    table,
    mode:
      table === "documents"
        ? "normalized"
        : WORKFLOW_DOMAIN_TABLES.has(table)
          ? "native"
          : "preserved",
    sourceRows: sourceRows.length,
    destinationRows: destinationRows.length,
    sourceChecksum,
    destinationChecksum,
    matched,
  };
}

function idsReport(
  table: string,
  expectedIds: readonly string[],
  actualIds: readonly string[],
): TableReconciliation {
  const expectedRows = [...new Set(expectedIds)]
    .sort()
    .map((id) => ({ id }));
  const actualRows = [...new Set(actualIds)]
    .sort()
    .map((id) => ({ id }));
  const sourceChecksum = rowChecksum(expectedRows);
  const destinationChecksum = rowChecksum(actualRows);
  return {
    table,
    mode: "normalized",
    sourceRows: expectedRows.length,
    destinationRows: actualRows.length,
    sourceChecksum,
    destinationChecksum,
    matched:
      expectedRows.length === actualRows.length &&
      sourceChecksum === destinationChecksum,
  };
}

const NORMALIZED_VALUATION_TABLE_KEYS = {
  valuation_context_cards: "card_id",
  valuation_impact_cards: "card_id",
  valuation_market_price_bars: "bar_id",
  valuation_price_comparisons: "price_comparison_id",
} as const;

function reconcileNormalizedValuationTables(
  source: DatabaseSync,
  destination: DatabaseSync,
): readonly TableReconciliation[] {
  const reports: TableReconciliation[] = [];
  for (const [table, key] of Object.entries(
    NORMALIZED_VALUATION_TABLE_KEYS,
  )) {
    if (!tableExists(source, table)) continue;
    const sourceIds = rows(source, table).map((row) => text(row[key]));
    const canonicalIds = tableExists(destination, table)
      ? rows(destination, table).map((row) => text(row[key]))
      : [];
    const quarantinedIds = tableExists(
      destination,
      "workflow_store_legacy_row_quarantine",
    )
      ? destination
          .prepare(
            `SELECT row_key
             FROM workflow_store_legacy_row_quarantine
             WHERE table_name=?
             ORDER BY row_key`,
          )
          .all(table)
          .map((row) => String(row.row_key))
      : [];
    const canonical = new Set(canonicalIds);
    const overlap = quarantinedIds.filter((id) => canonical.has(id));
    if (overlap.length > 0) {
      throw new LegacyMigrationError(
        `${table} rows are both canonical and quarantined: ${overlap.join(", ")}`,
        "reconciliation_failed",
      );
    }
    const report = idsReport(
      `@normalized/${table}`,
      sourceIds,
      [...canonicalIds, ...quarantinedIds],
    );
    if (!report.matched) {
      throw new LegacyMigrationError(
        `Normalized valuation reconciliation failed for ${table}`,
        "reconciliation_failed",
      );
    }
    reports.push(report);
  }
  return reports;
}

function expectedDocumentIds(
  source: DatabaseSync,
  mapping: ResolvedProjectMapping,
): {
  readonly documentIds: readonly string[];
  readonly versionIds: readonly string[];
} {
  if (!tableExists(source, "documents")) {
    return { documentIds: [], versionIds: [] };
  }
  const sourceRows = rows(source, "documents").filter(
    (row) => text(row.doc_id).length > 0,
  );
  const ambiguousCounts = new Map<string, number>();
  for (const row of sourceRows) {
    if (text(row.logical_doc_id).length > 0) continue;
    const fallback = normalizeRelpath(
      text(row.source_relpath) ||
        text(row.original_filename) ||
        "document",
    );
    const key = `${mapping.projectId}\0${fallback}`;
    ambiguousCounts.set(key, (ambiguousCounts.get(key) ?? 0) + 1);
  }
  const documentIds = sourceRows.map((row) => {
    const versionId = text(row.doc_id);
    const fallback = normalizeRelpath(
      text(row.source_relpath) ||
        text(row.original_filename) ||
        versionId,
    );
    const ambiguousKey = `${mapping.projectId}\0${fallback}`;
    const existing = text(row.logical_doc_id);
    const logicalKey =
      existing ||
      ((ambiguousCounts.get(ambiguousKey) ?? 0) > 1
        ? `legacy:${mapping.projectId}:${versionId}`
        : `path:${mapping.projectId}:${fallback}`);
    return `doc_${hash(logicalKey).slice(0, 32)}`;
  });
  return {
    documentIds,
    versionIds: sourceRows.map((row) => text(row.doc_id)),
  };
}

function expectedEvidenceIds(
  source: DatabaseSync,
  versionIds: ReadonlySet<string>,
): readonly string[] {
  const result: string[] = [];
  for (const [table, idColumn, prefix] of [
    ["chunks", "chunk_id", "chunk"],
    ["metric_facts", "fact_id", "fact"],
    ["excel_cells", "cell_id", "cell"],
    ["pdf_pages", "page_id", "page"],
  ] as const) {
    if (!tableExists(source, table)) continue;
    for (const row of rows(source, table)) {
      const id = text(row[idColumn]);
      const documentVersionId = text(row.doc_id);
      if (id && versionIds.has(documentVersionId)) {
        result.push(`${prefix}:${id}`);
      }
    }
  }
  return result;
}

export function reconcileNormalizedResearch(
  source: DatabaseSync,
  destination: DatabaseSync,
  mapping: ResolvedProjectMapping,
): readonly TableReconciliation[] {
  const expected = expectedDocumentIds(source, mapping);
  const versionSet = new Set(expected.versionIds);
  const reports = [
    idsReport(
      "@normalized/documents",
      expected.documentIds,
      tableExists(destination, "documents")
        ? rows(destination, "documents").map((row) => text(row.id))
        : [],
    ),
    idsReport(
      "@normalized/document_versions",
      expected.versionIds,
      tableExists(destination, "document_versions")
        ? rows(destination, "document_versions").map((row) => text(row.id))
        : [],
    ),
    idsReport(
      "@normalized/evidence",
      expectedEvidenceIds(source, versionSet),
      tableExists(destination, "evidence")
        ? rows(destination, "evidence").map((row) =>
            text(row.evidence_id)
          )
        : [],
    ),
  ];
  for (const report of reports) {
    if (!report.matched) {
      throw new LegacyMigrationError(
        `Normalized reconciliation failed for ${report.table}`,
        "reconciliation_failed",
      );
    }
  }
  return reports;
}

export function reconcileMigratedDatabase(
  source: DatabaseSync,
  destination: DatabaseSync,
  mapping: ResolvedProjectMapping,
  inspection: SourceInspection,
): readonly TableReconciliation[] {
  const integrity = destination.prepare("PRAGMA integrity_check").get();
  if (integrity?.integrity_check !== "ok") {
    throw new LegacyMigrationError(
      "Migrated database failed integrity_check",
      "reconciliation_failed",
    );
  }
  const fileMap = new Map(
    inspection.filePlans.map((plan) => [
      plan.legacyDocumentVersionId,
      plan.destinationRelativePath,
    ]),
  );
  const reports = [...inspection.tableChecksums.keys()]
    .sort()
    .map((table) =>
      legacyTableReport(
        source,
        destination,
        table,
        mapping,
        fileMap,
      )
    );
  reports.push(
    ...reconcileNormalizedResearch(source, destination, mapping),
    ...reconcileNormalizedValuationTables(source, destination),
    reconcileLegacyAgentRuns(
      source,
      destination,
      mapping,
      inspection.sourceFingerprint,
    ),
  );
  for (const report of reports) {
    if (!report.matched) {
      throw new LegacyMigrationError(
        `Table reconciliation failed for ${report.table}`,
        "reconciliation_failed",
      );
    }
  }
  const tables = destination
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all()
    .map((row) => String(row.name));
  for (const table of tables) {
    if (
      !tableColumns(destination, table).some(
        (column) => column.name === "dataset_id",
      )
    ) {
      continue;
    }
    const foreign = destination
      .prepare(
        `SELECT 1 FROM "${table.replaceAll('"', '""')}"
         WHERE dataset_id IS NOT NULL
           AND CAST(dataset_id AS TEXT)<>?
         LIMIT 1`,
      )
      .get(mapping.projectId);
    if (foreign !== undefined) {
      throw new LegacyMigrationError(
        `Migrated table ${table} escapes project tenant scope`,
        "reconciliation_failed",
      );
    }
  }
  return reports;
}

export function workflowPhaseTables(
  reports: readonly TableReconciliation[],
): readonly TableReconciliation[] {
  return reports.filter((report) => report.mode === "native");
}

export function researchPhaseTables(
  reports: readonly TableReconciliation[],
): readonly TableReconciliation[] {
  return reports.filter(
    (report) =>
      report.mode === "normalized" ||
      (report.mode === "preserved" && report.table === "documents"),
  );
}

export function plannedTableReports(
  inspection: SourceInspection,
): readonly TableReconciliation[] {
  return [...inspection.tableChecksums.entries()].map(
    ([table, value]) => ({
      table,
      mode:
        table === "documents"
          ? "normalized"
          : WORKFLOW_DOMAIN_TABLES.has(table)
            ? "native"
            : "preserved",
      sourceRows: value.rows,
      destinationRows: 0,
      sourceChecksum: value.checksum,
      destinationChecksum: "",
      matched: false,
    }),
  );
}
