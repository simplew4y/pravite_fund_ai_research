import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  openControlDatabase,
  withTransaction,
} from "@private-fund/db";

import { LegacyMigrationError } from "./errors.js";
import {
  rowChecksum,
  rows,
  tableExists,
  type SqlRow,
} from "./sqlite.js";
import { stableJson, stableSha256 } from "./stable.js";
import type {
  ResolvedProjectMapping,
  TableReconciliation,
} from "./types.js";

const LEGACY_BUSINESS_JOB_TABLES = [
  {
    table: "research_equity_report_runs",
    idColumn: "run_id",
  },
  {
    table: "research_tracking_jobs",
    idColumn: "job_id",
  },
  {
    table: "valuation_tracking_jobs",
    idColumn: "job_id",
  },
] as const;

type LegacyBusinessJobTable =
  (typeof LEGACY_BUSINESS_JOB_TABLES)[number]["table"];

type CanonicalJobType =
  | "report.generate"
  | "tracking.scan"
  | "valuation.extract"
  | "valuation.compare"
  | "market.refresh";

type CanonicalJobStatus =
  | "queued"
  | "completed"
  | "failed"
  | "cancelled";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

interface CanonicalJob {
  readonly id: string;
  readonly tenantNamespace: string;
  readonly projectId: string;
  readonly type: CanonicalJobType;
  readonly status: CanonicalJobStatus;
  readonly payloadJson: string;
  readonly resultJson: string | null;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly idempotencyKey: string;
  readonly availableAt: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly error: string | null;
}

interface ExpectedReconciliation {
  readonly reconciliationId: string;
  readonly tenantNamespace: string;
  readonly projectId: string;
  readonly sourceFingerprint: string;
  readonly legacyTable: LegacyBusinessJobTable;
  readonly legacyRowId: string;
  readonly legacyStatus: string;
  readonly legacyType: string;
  readonly legacyRowSha256: string;
  readonly legacyRowJson: string;
  readonly targetJobType: CanonicalJobType | null;
  readonly canonicalJob: CanonicalJob | null;
  readonly canonicalJobImmutableSha256: string | null;
  readonly disposition: "mapped" | "audited";
  readonly reasonCode: string;
  readonly reason: string;
}

interface MappingDecision {
  readonly targetJobType: CanonicalJobType | null;
  readonly job: Omit<
    CanonicalJob,
    "id" | "tenantNamespace" | "projectId" | "idempotencyKey"
  > | null;
  readonly reasonCode: string;
  readonly reason: string;
}

interface ParsedJson {
  readonly ok: boolean;
  readonly value: JsonValue | null;
  readonly error: string | null;
}

function text(row: SqlRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function requiredText(
  row: SqlRow,
  key: string,
  table: string,
  maximum = 500,
): string {
  const value = text(row, key);
  if (
    value.length === 0 ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new LegacyMigrationError(
      `${table}.${key} is missing or invalid`,
      "legacy_schema",
    );
  }
  return value;
}

function nullableText(row: SqlRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function nonNegativeInteger(
  row: SqlRow,
  key: string,
): number | null {
  const value = row[key];
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function positiveInteger(
  row: SqlRow,
  key: string,
): number | null {
  const value = nonNegativeInteger(row, key);
  return value !== null && value > 0 ? value : null;
}

function normalizedIso(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : null;
}

function jsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(jsonValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonValue(item)]),
    );
  }
  throw new TypeError("Value is not JSON serializable");
}

function parseJson(
  row: SqlRow,
  key: string,
  requireObject = false,
): ParsedJson {
  const raw = row[key];
  if (raw === null || raw === undefined) {
    return { ok: true, value: null, error: null };
  }
  if (typeof raw !== "string") {
    return {
      ok: false,
      value: null,
      error: `${key} is not text`,
    };
  }
  try {
    const parsed = jsonValue(JSON.parse(raw) as unknown);
    if (
      requireObject &&
      (parsed === null || Array.isArray(parsed) || typeof parsed !== "object")
    ) {
      return {
        ok: false,
        value: null,
        error: `${key} is not a JSON object`,
      };
    }
    return { ok: true, value: parsed, error: null };
  } catch {
    return {
      ok: false,
      value: null,
      error: `${key} is not valid JSON`,
    };
  }
}

function comparableSourceRow(row: SqlRow): Record<string, JsonValue> {
  const comparable: Record<string, JsonValue> = {};
  for (const key of Object.keys(row).sort()) {
    const value = row[key] ?? null;
    comparable[key] =
      typeof value === "bigint"
        ? value.toString()
        : value instanceof Uint8Array
          ? Buffer.from(value).toString("base64")
          : jsonValue(value);
  }
  return comparable;
}

function auditDecision(
  targetJobType: CanonicalJobType | null,
  reasonCode: string,
  reason: string,
): MappingDecision {
  return {
    targetJobType,
    job: null,
    reasonCode,
    reason,
  };
}

function statusFields(
  row: SqlRow,
  table: string,
): {
  readonly status: CanonicalJobStatus;
  readonly availableAt: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly reasonCode: string;
  readonly reason: string;
} | null {
  const sourceStatus = text(row, "status").toLowerCase();
  const createdAt = normalizedIso(row.created_at);
  const updatedAt = normalizedIso(row.updated_at);
  const availableAt =
    normalizedIso(row.available_at) ?? createdAt;
  const startedAt = normalizedIso(row.started_at);
  const finishedAt =
    normalizedIso(row.finished_at) ??
    normalizedIso(row.completed_at);
  if (
    createdAt === null ||
    updatedAt === null ||
    availableAt === null
  ) {
    return null;
  }
  switch (sourceStatus) {
    case "queued":
      return {
        status: "queued",
        availableAt,
        createdAt,
        startedAt,
        updatedAt,
        completedAt: null,
        reasonCode: "mapped_queued",
        reason: `${table} queued work remains queued in the canonical durable queue`,
      };
    case "running":
      return {
        status: "queued",
        availableAt,
        createdAt,
        startedAt,
        updatedAt,
        completedAt: null,
        reasonCode: "running_requeued",
        reason:
          `${table} running work was requeued because a legacy Python lease ` +
          "cannot be transferred to a TypeScript worker",
      };
    case "completed":
      return {
        status: "completed",
        availableAt,
        createdAt,
        startedAt,
        updatedAt,
        completedAt: finishedAt ?? updatedAt,
        reasonCode: "mapped_completed_history",
        reason: `${table} completed history was preserved as a terminal canonical job`,
      };
    case "failed":
      return {
        status: "failed",
        availableAt,
        createdAt,
        startedAt,
        updatedAt,
        completedAt: finishedAt ?? updatedAt,
        reasonCode: "mapped_failed_history",
        reason: `${table} failed history was preserved as a terminal canonical job`,
      };
    case "cancelled":
    case "canceled":
      return {
        status: "cancelled",
        availableAt,
        createdAt,
        startedAt,
        updatedAt,
        completedAt: finishedAt ?? updatedAt,
        reasonCode: "mapped_cancelled_history",
        reason: `${table} cancelled history was preserved as a terminal canonical job`,
      };
    default:
      return null;
  }
}

function baseTrackingDecision(
  row: SqlRow,
  table: "research_tracking_jobs" | "valuation_tracking_jobs",
): {
  readonly status: NonNullable<ReturnType<typeof statusFields>>;
  readonly payload: JsonValue;
  readonly result: JsonValue | null;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly error: string | null;
} | MappingDecision {
  const status = statusFields(row, table);
  if (status === null) {
    return auditDecision(
      null,
      "invalid_status_or_time",
      `${table} has an unknown status or a non-ISO execution timestamp`,
    );
  }
  const payload = parseJson(row, "payload_json", true);
  const result = parseJson(row, "result_json");
  const attempt = nonNegativeInteger(row, "attempt_count");
  const maxAttempts = positiveInteger(row, "max_attempts");
  if (!payload.ok || !result.ok) {
    return auditDecision(
      null,
      "invalid_json",
      `${table} cannot be executed safely: ${payload.error ?? result.error ?? "invalid JSON"}`,
    );
  }
  if (attempt === null || maxAttempts === null) {
    return auditDecision(
      null,
      "invalid_attempt_policy",
      `${table} has an invalid attempt_count or max_attempts`,
    );
  }
  if (status.status === "queued" && attempt >= maxAttempts) {
    return auditDecision(
      null,
      "exhausted_nonterminal_job",
      `${table} is nonterminal even though all attempts are exhausted`,
    );
  }
  return {
    status,
    payload: payload.value ?? {},
    result: result.value,
    attempt,
    maxAttempts,
    error: nullableText(row, "last_error"),
  };
}

function legacyEnvelope(
  mapping: ResolvedProjectMapping,
  sourceFingerprint: string,
  table: LegacyBusinessJobTable,
  rowId: string,
  sourceType: string,
  sourceStatus: string,
  payload: JsonValue,
): Record<string, JsonValue> {
  return {
    datasetId: mapping.projectId,
    legacyMigration: {
      schemaVersion: 1,
      sourceFingerprint,
      sourceTable: table,
      sourceRowId: rowId,
      sourceDatasetId: mapping.legacyDatasetId,
      sourceType,
      sourceStatus,
    },
    legacyPayload: payload,
  };
}

function trackingDecision(
  row: SqlRow,
  mapping: ResolvedProjectMapping,
  sourceFingerprint: string,
): MappingDecision {
  const table = "research_tracking_jobs";
  const rowId = requiredText(row, "job_id", table);
  const sourceType = requiredText(row, "job_type", table, 160);
  if (sourceType === "memo_version_created") {
    return auditDecision(
      "tracking.scan",
      "unsupported_memo_tracking_semantics",
      "The canonical tracking.scan executor scans Evidence-backed documents and cannot replay a legacy memo-unit scan without changing provenance",
    );
  }
  if (
    sourceType !== "document_ingested" &&
    sourceType !== "manual_scan" &&
    sourceType !== "scheduled_scan"
  ) {
    return auditDecision(
      null,
      "unknown_job_type",
      `Unknown research tracking job type: ${sourceType}`,
    );
  }
  const base = baseTrackingDecision(row, table);
  if ("job" in base) {
    return {
      ...base,
      targetJobType: "tracking.scan",
    };
  }
  return {
    targetJobType: "tracking.scan",
    job: {
      type: "tracking.scan",
      status: base.status.status,
      payloadJson: stableJson({
        ...legacyEnvelope(
          mapping,
          sourceFingerprint,
          table,
          rowId,
          sourceType,
          text(row, "status"),
          base.payload,
        ),
        action: "scan",
        includeHistory: false,
        legacySourceId: requiredText(row, "source_id", table),
        legacyExecutorVersion: requiredText(
          row,
          "extractor_version",
          table,
          160,
        ),
        legacyPriority: nonNegativeInteger(row, "priority") ?? 100,
      }),
      resultJson:
        base.result === null ? null : stableJson(base.result),
      attempt: base.attempt,
      maxAttempts: base.maxAttempts,
      availableAt: base.status.availableAt,
      createdAt: base.status.createdAt,
      startedAt: base.status.startedAt,
      updatedAt: base.status.updatedAt,
      completedAt: base.status.completedAt,
      error: base.error,
    },
    reasonCode: base.status.reasonCode,
    reason: base.status.reason,
  };
}

function destinationDocument(
  destination: DatabaseSync,
  versionId: string,
): {
  readonly documentId: string;
  readonly storedPath: string;
  readonly originalFilename: string;
} | null {
  if (!tableExists(destination, "document_versions")) return null;
  const row = destination
    .prepare(
      `SELECT document_id, stored_path, original_filename
       FROM document_versions
       WHERE id=?`,
    )
    .get(versionId);
  if (
    typeof row?.document_id !== "string" ||
    typeof row.stored_path !== "string" ||
    typeof row.original_filename !== "string"
  ) {
    return null;
  }
  return {
    documentId: row.document_id,
    storedPath: row.stored_path,
    originalFilename: row.original_filename,
  };
}

function valuationDecision(
  row: SqlRow,
  mapping: ResolvedProjectMapping,
  sourceFingerprint: string,
  destination: DatabaseSync,
): MappingDecision {
  const table = "valuation_tracking_jobs";
  const rowId = requiredText(row, "job_id", table);
  const sourceType = requiredText(row, "job_type", table, 160);
  const sourceStatus = text(row, "status").toLowerCase();
  const targetType =
    sourceType === "model_version_ingested"
      ? "valuation.extract"
      : sourceType === "agent_analysis"
        ? "valuation.compare"
        : sourceType === "market_data_refresh"
          ? "market.refresh"
          : null;
  if (sourceType === "valuation_context_refresh") {
    return auditDecision(
      null,
      "unsupported_aggregate_refresh",
      "Legacy valuation_context_refresh combines market, metric, card and impact operations; no single canonical job has equivalent semantics",
    );
  }
  if (targetType === null) {
    return auditDecision(
      null,
      "unknown_job_type",
      `Unknown valuation tracking job type: ${sourceType}`,
    );
  }
  if (
    sourceType === "market_data_refresh" &&
    (sourceStatus === "queued" || sourceStatus === "running")
  ) {
    return auditDecision(
      targetType,
      "requires_series_fanout",
      "A pending legacy dataset-wide market refresh must be explicitly fanned out to ticker-scoped canonical market.refresh jobs",
    );
  }
  const base = baseTrackingDecision(row, table);
  if ("job" in base) {
    return {
      ...base,
      targetJobType: targetType,
    };
  }
  const envelope = legacyEnvelope(
    mapping,
    sourceFingerprint,
    table,
    rowId,
    sourceType,
    text(row, "status"),
    base.payload,
  );
  const legacyExecution = {
    legacySourceId: requiredText(row, "source_id", table),
    legacyExecutorVersion: requiredText(
      row,
      "analyzer_version",
      table,
      160,
    ),
    legacyPriority: nonNegativeInteger(row, "priority") ?? 100,
  } satisfies Record<string, JsonValue>;
  let payload: Record<string, JsonValue>;
  if (sourceType === "model_version_ingested") {
    const versionId = requiredText(row, "source_id", table, 160);
    const document = destinationDocument(destination, versionId);
    if (document === null) {
      return auditDecision(
        targetType,
        "unresolved_document_version",
        `Legacy valuation source ${versionId} does not resolve to a canonical document version`,
      );
    }
    const extension = path.extname(document.originalFilename).toLowerCase();
    if (![".xlsx", ".xlsm", ".xltx", ".xltm"].includes(extension)) {
      return auditDecision(
        targetType,
        "unsupported_valuation_source",
        `Legacy valuation source ${versionId} is not a supported workbook`,
      );
    }
    const inputPath = path.isAbsolute(document.storedPath)
      ? document.storedPath
      : path.join(mapping.destinationProjectRoot, document.storedPath);
    if (
      (base.status.status === "queued" || sourceStatus === "running") &&
      !existsSync(inputPath)
    ) {
      return auditDecision(
        targetType,
        "missing_valuation_source",
        `Legacy valuation source ${versionId} has no migrated workbook bytes`,
      );
    }
    payload = {
      ...envelope,
      ...legacyExecution,
      action: "extract",
      documentId: document.documentId,
      documentVersionId: versionId,
      inputPath,
      outputDirectory: path.join(
        mapping.destinationProjectRoot,
        "data",
        "jobs",
        `legacy-valuation-extract-${stableSha256(rowId).slice(0, 24)}`,
      ),
      computeOperation: "extract_workbook",
      options: {
        documentId: document.documentId,
        documentVersionId: versionId,
        includeHistory: true,
      },
    };
  } else if (sourceType === "agent_analysis") {
    const analysisId = requiredText(row, "source_id", table, 160);
    const analysis = tableExists(destination, "valuation_agent_analyses")
      ? destination
          .prepare(
            `SELECT series_id, base_model_version_id,
                    comparison_model_version_id, focus, agent_version
             FROM valuation_agent_analyses
             WHERE analysis_id=? AND dataset_id=?`,
          )
          .get(analysisId, mapping.projectId)
      : undefined;
    if (analysis === undefined) {
      return auditDecision(
        targetType,
        "unresolved_agent_analysis",
        `Legacy valuation analysis ${analysisId} does not resolve in the canonical project`,
      );
    }
    payload = {
      ...envelope,
      ...legacyExecution,
      action: "agent_analysis",
      analysisId,
      seriesId: String(analysis.series_id),
      baseModelVersionId: String(analysis.base_model_version_id),
      comparisonModelVersionId:
        analysis.comparison_model_version_id === null
          ? null
          : String(analysis.comparison_model_version_id),
      focus: String(analysis.focus),
      agentVersion: String(analysis.agent_version),
    };
  } else {
    payload = {
      ...envelope,
      ...legacyExecution,
      action: "legacy_completed_refresh",
      sourceId: requiredText(row, "source_id", table),
    };
  }
  return {
    targetJobType: targetType,
    job: {
      type: targetType,
      status: base.status.status,
      payloadJson: stableJson(payload),
      resultJson:
        base.result === null ? null : stableJson(base.result),
      attempt: base.attempt,
      maxAttempts: base.maxAttempts,
      availableAt: base.status.availableAt,
      createdAt: base.status.createdAt,
      startedAt: base.status.startedAt,
      updatedAt: base.status.updatedAt,
      completedAt: base.status.completedAt,
      error: base.error,
    },
    reasonCode: base.status.reasonCode,
    reason: base.status.reason,
  };
}

function reportDecision(
  row: SqlRow,
  mapping: ResolvedProjectMapping,
  sourceFingerprint: string,
): MappingDecision {
  const table = "research_equity_report_runs";
  const rowId = requiredText(row, "run_id", table);
  const sourceStatus = requiredText(row, "status", table, 100).toLowerCase();
  if (sourceStatus === "rendering") {
    return auditDecision(
      "report.generate",
      "unrecoverable_legacy_render",
      "A reserved legacy FinRobot render has no immutable canonical Markdown input, so it cannot be resumed as report.generate",
    );
  }
  if (sourceStatus !== "completed" && sourceStatus !== "failed") {
    return auditDecision(
      "report.generate",
      "unknown_status",
      `Unknown equity report run status: ${sourceStatus}`,
    );
  }
  const request = parseJson(row, "request_json", true);
  const reportPackage = parseJson(row, "report_package_json");
  const artifactManifest = parseJson(row, "artifact_manifest_json");
  if (!request.ok || !reportPackage.ok || !artifactManifest.ok) {
    return auditDecision(
      "report.generate",
      "invalid_json",
      `Equity report history contains invalid JSON: ${
        request.error ?? reportPackage.error ?? artifactManifest.error ?? ""
      }`,
    );
  }
  const createdAt = normalizedIso(row.created_at);
  const updatedAt = normalizedIso(row.updated_at);
  const completedAt =
    normalizedIso(row.completed_at) ?? updatedAt;
  if (
    createdAt === null ||
    updatedAt === null ||
    completedAt === null
  ) {
    return auditDecision(
      "report.generate",
      "invalid_time",
      "Equity report history contains a non-ISO execution timestamp",
    );
  }
  const result =
    sourceStatus === "completed"
      ? {
          reportPackage: reportPackage.value,
          artifactManifest: artifactManifest.value,
          renderEngine: nullableText(row, "render_engine"),
        }
      : null;
  return {
    targetJobType: "report.generate",
    job: {
      type: "report.generate",
      status: sourceStatus,
      payloadJson: stableJson({
        ...legacyEnvelope(
          mapping,
          sourceFingerprint,
          table,
          rowId,
          "finrobot_equity_report",
          text(row, "status"),
          request.value ?? {},
        ),
        sourceKind: "legacy-equity-report-history",
        workflowId: requiredText(row, "workflow_id", table, 160),
        reportId: requiredText(row, "report_id", table, 160),
        reportVersionId: requiredText(
          row,
          "report_version_id",
          table,
          160,
        ),
        versionNo: nonNegativeInteger(row, "version_no") ?? 0,
        title: requiredText(row, "title", table, 500),
      }),
      resultJson: result === null ? null : stableJson(result),
      attempt: 1,
      maxAttempts: 1,
      availableAt: createdAt,
      createdAt,
      startedAt: createdAt,
      updatedAt,
      completedAt,
      error: nullableText(row, "error"),
    },
    reasonCode:
      sourceStatus === "completed"
        ? "mapped_completed_history"
        : "mapped_failed_history",
    reason:
      `Legacy equity report ${sourceStatus} history was preserved as a ` +
      "terminal canonical report.generate job; it will not invoke the old renderer",
  };
}

function immutableJobComparable(
  job: CanonicalJob,
): Record<string, JsonValue> {
  return {
    id: job.id,
    tenantNamespace: job.tenantNamespace,
    projectId: job.projectId,
    type: job.type,
    payloadJson: job.payloadJson,
    maxAttempts: job.maxAttempts,
    idempotencyKey: job.idempotencyKey,
    createdAt: job.createdAt,
  };
}

function canonicalIdentity(
  mapping: ResolvedProjectMapping,
  table: LegacyBusinessJobTable,
  rowId: string,
): {
  readonly jobId: string;
  readonly idempotencyKey: string;
  readonly reconciliationId: string;
} {
  const digest = stableSha256([
    mapping.dataNamespace,
    mapping.projectId,
    table,
    rowId,
  ]);
  return {
    jobId: `job_lbj_${digest.slice(0, 32)}`,
    idempotencyKey: `legacy-business-job-v1:${table}:${digest}`,
    reconciliationId: `lbj_${digest.slice(0, 32)}`,
  };
}

function expectedRows(
  source: DatabaseSync,
  destination: DatabaseSync,
  mapping: ResolvedProjectMapping,
  sourceFingerprint: string,
): readonly ExpectedReconciliation[] {
  const expected: ExpectedReconciliation[] = [];
  for (const descriptor of LEGACY_BUSINESS_JOB_TABLES) {
    if (!tableExists(source, descriptor.table)) continue;
    for (const row of rows(source, descriptor.table)) {
      const rowId = requiredText(
        row,
        descriptor.idColumn,
        descriptor.table,
      );
      const datasetId = requiredText(
        row,
        "dataset_id",
        descriptor.table,
        160,
      );
      if (datasetId !== mapping.legacyDatasetId) {
        throw new LegacyMigrationError(
          `${descriptor.table}.${rowId} belongs to unexpected dataset ${datasetId}`,
          "source_conflict",
        );
      }
      const legacyStatus = requiredText(
        row,
        "status",
        descriptor.table,
        100,
      );
      const legacyType =
        descriptor.table === "research_equity_report_runs"
          ? "finrobot_equity_report"
          : requiredText(row, "job_type", descriptor.table, 160);
      const legacyRowJson = stableJson(comparableSourceRow(row));
      const decision =
        descriptor.table === "research_tracking_jobs"
          ? trackingDecision(row, mapping, sourceFingerprint)
          : descriptor.table === "valuation_tracking_jobs"
            ? valuationDecision(
                row,
                mapping,
                sourceFingerprint,
                destination,
              )
            : reportDecision(row, mapping, sourceFingerprint);
      const identity = canonicalIdentity(
        mapping,
        descriptor.table,
        rowId,
      );
      const canonicalJob =
        decision.job === null
          ? null
          : {
              ...decision.job,
              id: identity.jobId,
              tenantNamespace: mapping.dataNamespace,
              projectId: mapping.projectId,
              idempotencyKey: identity.idempotencyKey,
            };
      expected.push({
        reconciliationId: identity.reconciliationId,
        tenantNamespace: mapping.dataNamespace,
        projectId: mapping.projectId,
        sourceFingerprint,
        legacyTable: descriptor.table,
        legacyRowId: rowId,
        legacyStatus,
        legacyType,
        legacyRowSha256: stableSha256(legacyRowJson),
        legacyRowJson,
        targetJobType: decision.targetJobType,
        canonicalJob,
        canonicalJobImmutableSha256:
          canonicalJob === null
            ? null
            : stableSha256(immutableJobComparable(canonicalJob)),
        disposition: canonicalJob === null ? "audited" : "mapped",
        reasonCode: decision.reasonCode,
        reason: decision.reason,
      });
    }
  }
  return expected.sort((left, right) =>
    `${left.legacyTable}\0${left.legacyRowId}`.localeCompare(
      `${right.legacyTable}\0${right.legacyRowId}`,
    ),
  );
}

function reconciliationComparable(
  row: ExpectedReconciliation,
): Record<string, JsonValue> {
  return {
    reconciliationId: row.reconciliationId,
    tenantNamespace: row.tenantNamespace,
    projectId: row.projectId,
    sourceFingerprint: row.sourceFingerprint,
    legacyTable: row.legacyTable,
    legacyRowId: row.legacyRowId,
    legacyStatus: row.legacyStatus,
    legacyType: row.legacyType,
    legacyRowSha256: row.legacyRowSha256,
    legacyRowJson: row.legacyRowJson,
    targetJobType: row.targetJobType,
    canonicalJobId: row.canonicalJob?.id ?? null,
    canonicalJobImmutableSha256:
      row.canonicalJobImmutableSha256,
    disposition: row.disposition,
    reasonCode: row.reasonCode,
    reason: row.reason,
  };
}

function actualRows(
  control: DatabaseSync,
  mapping: ResolvedProjectMapping,
): readonly Record<string, JsonValue>[] {
  if (!tableExists(control, "legacy_business_job_reconciliation")) {
    return [];
  }
  return control
    .prepare(
      `SELECT reconciliation_id, tenant_namespace, project_id,
              source_fingerprint, legacy_table, legacy_row_id,
              legacy_status, legacy_type, legacy_row_sha256,
              legacy_row_json, target_job_type, canonical_job_id,
              canonical_job_immutable_sha256, disposition, reason_code,
              reason
       FROM legacy_business_job_reconciliation
       WHERE tenant_namespace=? AND project_id=?
       ORDER BY legacy_table, legacy_row_id`,
    )
    .all(mapping.dataNamespace, mapping.projectId)
    .map((row) => ({
      reconciliationId: String(row.reconciliation_id),
      tenantNamespace: String(row.tenant_namespace),
      projectId: String(row.project_id),
      sourceFingerprint: String(row.source_fingerprint),
      legacyTable: String(row.legacy_table),
      legacyRowId: String(row.legacy_row_id),
      legacyStatus: String(row.legacy_status),
      legacyType: String(row.legacy_type),
      legacyRowSha256: String(row.legacy_row_sha256),
      legacyRowJson: String(row.legacy_row_json),
      targetJobType:
        row.target_job_type === null
          ? null
          : String(row.target_job_type),
      canonicalJobId:
        row.canonical_job_id === null
          ? null
          : String(row.canonical_job_id),
      canonicalJobImmutableSha256:
        row.canonical_job_immutable_sha256 === null
          ? null
          : String(row.canonical_job_immutable_sha256),
      disposition: String(row.disposition),
      reasonCode: String(row.reason_code),
      reason: String(row.reason),
    }));
}

function storedImmutableJob(
  control: DatabaseSync,
  jobId: string,
): Record<string, JsonValue> | null {
  const row = control
    .prepare(
      `SELECT id, tenant_namespace, project_id, type, payload_json,
              max_attempts, idempotency_key, created_at
       FROM jobs WHERE id=?`,
    )
    .get(jobId);
  if (row === undefined) return null;
  return {
    id: String(row.id),
    tenantNamespace: String(row.tenant_namespace),
    projectId: String(row.project_id),
    type: String(row.type),
    payloadJson: String(row.payload_json),
    maxAttempts: Number(row.max_attempts),
    idempotencyKey: String(row.idempotency_key),
    createdAt: String(row.created_at),
  };
}

function assertMappedJobs(
  control: DatabaseSync,
  expected: readonly ExpectedReconciliation[],
): void {
  for (const row of expected) {
    if (row.canonicalJob === null) continue;
    const actual = storedImmutableJob(control, row.canonicalJob.id);
    if (
      actual === null ||
      stableSha256(actual) !== row.canonicalJobImmutableSha256
    ) {
      throw new LegacyMigrationError(
        `Canonical job ${row.canonicalJob.id} no longer matches ${row.legacyTable}.${row.legacyRowId}`,
        "reconciliation_failed",
      );
    }
  }
}

function reports(
  source: DatabaseSync,
  expected: readonly ExpectedReconciliation[],
  actual: readonly Record<string, JsonValue>[],
): readonly TableReconciliation[] {
  const result: TableReconciliation[] = [];
  for (const descriptor of LEGACY_BUSINESS_JOB_TABLES) {
    if (!tableExists(source, descriptor.table)) continue;
    const sourceComparable = expected
      .filter((row) => row.legacyTable === descriptor.table)
      .map(reconciliationComparable);
    const destinationComparable = actual.filter(
      (row) => row.legacyTable === descriptor.table,
    );
    const sourceChecksum = stableSha256(sourceComparable);
    const destinationChecksum = stableSha256(destinationComparable);
    const matched =
      sourceComparable.length === destinationComparable.length &&
      sourceChecksum === destinationChecksum;
    if (!matched) {
      throw new LegacyMigrationError(
        `Canonical business-job reconciliation failed for ${descriptor.table}`,
        "reconciliation_failed",
      );
    }
    result.push({
      table: `@control/${descriptor.table}`,
      mode: "normalized",
      sourceRows: sourceComparable.length,
      destinationRows: destinationComparable.length,
      sourceChecksum,
      destinationChecksum,
      matched,
    });
  }
  return result;
}

function reconcileExpected(
  source: DatabaseSync,
  control: DatabaseSync,
  mapping: ResolvedProjectMapping,
  expected: readonly ExpectedReconciliation[],
): readonly TableReconciliation[] {
  const actual = actualRows(control, mapping);
  const expectedComparable = expected.map(reconciliationComparable);
  if (
    actual.length !== expectedComparable.length ||
    stableSha256(actual) !== stableSha256(expectedComparable)
  ) {
    throw new LegacyMigrationError(
      "Control-plane business-job reconciliation does not exactly match the legacy source",
      "reconciliation_failed",
    );
  }
  assertMappedJobs(control, expected);
  return reports(source, expected, actual);
}

function insertCanonicalJob(
  control: DatabaseSync,
  job: CanonicalJob,
): void {
  const existingById = storedImmutableJob(control, job.id);
  const existingByIdempotency = control
    .prepare(
      `SELECT id
       FROM jobs
       WHERE tenant_namespace=? AND project_id=? AND type=?
         AND idempotency_key=?`,
    )
    .get(
      job.tenantNamespace,
      job.projectId,
      job.type,
      job.idempotencyKey,
    );
  if (
    existingById !== null ||
    existingByIdempotency !== undefined
  ) {
    if (
      existingById === null ||
      stableSha256(existingById) !==
        stableSha256(immutableJobComparable(job)) ||
      String(existingByIdempotency?.id ?? "") !== job.id
    ) {
      throw new LegacyMigrationError(
        `Canonical job identity conflicts with ${job.id}`,
        "destination_conflict",
      );
    }
    return;
  }
  control
    .prepare(
      `INSERT INTO jobs(
         id, tenant_namespace, project_id, type, status, payload_json,
         result_json, attempt, max_attempts, lease_owner,
         lease_expires_at, idempotency_key, available_at, created_at,
         started_at, updated_at, completed_at, error
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?
       )`,
    )
    .run(
      job.id,
      job.tenantNamespace,
      job.projectId,
      job.type,
      job.status,
      job.payloadJson,
      job.resultJson,
      job.attempt,
      job.maxAttempts,
      job.idempotencyKey,
      job.availableAt,
      job.createdAt,
      job.startedAt,
      job.updatedAt,
      job.completedAt,
      job.error,
    );
}

function insertReconciliation(
  control: DatabaseSync,
  row: ExpectedReconciliation,
  reconciledAt: string,
): void {
  control
    .prepare(
      `INSERT INTO legacy_business_job_reconciliation(
         reconciliation_id, tenant_namespace, project_id,
         source_fingerprint, legacy_table, legacy_row_id, legacy_status,
         legacy_type, legacy_row_sha256, legacy_row_json, target_job_type,
         canonical_job_id, canonical_job_immutable_sha256, disposition,
         reason_code, reason, reconciled_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(
         tenant_namespace, project_id, legacy_table, legacy_row_id
       ) DO NOTHING`,
    )
    .run(
      row.reconciliationId,
      row.tenantNamespace,
      row.projectId,
      row.sourceFingerprint,
      row.legacyTable,
      row.legacyRowId,
      row.legacyStatus,
      row.legacyType,
      row.legacyRowSha256,
      row.legacyRowJson,
      row.targetJobType,
      row.canonicalJob?.id ?? null,
      row.canonicalJobImmutableSha256,
      row.disposition,
      row.reasonCode,
      row.reason,
      reconciledAt,
    );
}

function openDestinationReadOnly(filename: string): DatabaseSync {
  const database = new DatabaseSync(filename, {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    readOnly: true,
    timeout: 30_000,
  });
  database.exec("PRAGMA query_only=ON");
  database.exec("PRAGMA trusted_schema=OFF");
  return database;
}

export function migrateLegacyBusinessJobs(
  source: DatabaseSync,
  controlDatabase: string,
  mapping: ResolvedProjectMapping,
  sourceFingerprint: string,
  reconciledAt: string,
): readonly TableReconciliation[] {
  const destination = openDestinationReadOnly(
    mapping.destinationResearchDatabase,
  );
  const control = openControlDatabase(controlDatabase, {
    migrate: true,
    timeoutMs: 30_000,
  });
  try {
    const expected = expectedRows(
      source,
      destination,
      mapping,
      sourceFingerprint,
    );
    withTransaction(control, () => {
      for (const row of expected) {
        if (row.canonicalJob !== null) {
          insertCanonicalJob(control, row.canonicalJob);
        }
        insertReconciliation(control, row, reconciledAt);
      }
      reconcileExpected(source, control, mapping, expected);
    });
    return reconcileExpected(source, control, mapping, expected);
  } catch (error) {
    if (error instanceof LegacyMigrationError) throw error;
    throw new LegacyMigrationError(
      `Cannot migrate legacy business jobs for ${mapping.mappingKey}`,
      "destination_conflict",
      { cause: error },
    );
  } finally {
    control.close();
    destination.close();
  }
}

export function reconcileLegacyBusinessJobs(
  source: DatabaseSync,
  controlDatabase: string,
  mapping: ResolvedProjectMapping,
  sourceFingerprint: string,
): readonly TableReconciliation[] {
  const destination = openDestinationReadOnly(
    mapping.destinationResearchDatabase,
  );
  const control = openControlDatabase(controlDatabase, {
    readOnly: true,
    migrate: false,
    timeoutMs: 30_000,
  });
  try {
    const expected = expectedRows(
      source,
      destination,
      mapping,
      sourceFingerprint,
    );
    return reconcileExpected(source, control, mapping, expected);
  } finally {
    control.close();
    destination.close();
  }
}

export function plannedLegacyBusinessJobReports(
  source: DatabaseSync,
): readonly TableReconciliation[] {
  return LEGACY_BUSINESS_JOB_TABLES.flatMap((descriptor) => {
    if (!tableExists(source, descriptor.table)) return [];
    const sourceRows = rows(source, descriptor.table);
    return [
      {
        table: `@control/${descriptor.table}`,
        mode: "normalized" as const,
        sourceRows: sourceRows.length,
        destinationRows: 0,
        sourceChecksum: rowChecksum(sourceRows),
        destinationChecksum: "",
        matched: false,
      },
    ];
  });
}
