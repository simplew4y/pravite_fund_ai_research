import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  createGlobalUploadBatchRequestSchema,
  globalUploadAuditEventSchema,
  globalUploadAuditIdSchema,
  globalUploadBatchDetailSchema,
  globalUploadBatchIdSchema,
  globalUploadBatchPageSchema,
  globalUploadBatchSchema,
  globalUploadItemIdSchema,
  globalUploadItemPageSchema,
  globalUploadItemSchema,
  listGlobalUploadAuditQuerySchema,
  listGlobalUploadBatchesQuerySchema,
  listGlobalUploadItemsQuerySchema,
  routeGlobalUploadItemRequestSchema,
  transitionGlobalUploadBatchRequestSchema,
  transitionGlobalUploadItemRequestSchema,
  type CreateGlobalUploadBatchRequest,
  type GlobalUploadAuditEvent,
  type GlobalUploadAuditPage,
  type GlobalUploadBatch,
  type GlobalUploadBatchDetail,
  type GlobalUploadBatchPage,
  type GlobalUploadBatchStatus,
  type GlobalUploadItem,
  type GlobalUploadItemPage,
  type GlobalUploadItemStatus,
  type GlobalUploadProjectCandidate,
  type ListGlobalUploadAuditQuery,
  type ListGlobalUploadBatchesQuery,
  type ListGlobalUploadItemsQuery,
  type RouteGlobalUploadItemRequest,
  type TransitionGlobalUploadBatchRequest,
  type TransitionGlobalUploadItemRequest,
} from "@private-fund/contracts";
import type { Clock } from "@private-fund/core";
import {
  ConflictError,
  DomainError,
  NotFoundError,
  isoNow,
  newId,
  systemClock,
} from "@private-fund/core";

import {
  decodeJson,
  decodeJsonObject,
  encodeJson,
} from "./json.js";
import type { SqlRow } from "./rows.js";
import {
  rowNullableString,
  rowNumber,
  rowString,
} from "./rows.js";
import { withTransaction } from "./transaction.js";
import { UsersRepository } from "./users-repository.js";

const BATCH_CREATED_ACTION = "upload.batch.created";
const BATCH_TRANSITIONED_ACTION = "upload.batch.transitioned";
const ITEM_TRANSITIONED_ACTION = "upload.item.transitioned";
const ITEM_ROUTED_ACTION = "upload.item.routed";

const BATCH_COLUMNS = `
  b.id AS batchId,
  b.tenant_namespace AS tenantNamespace,
  b.status,
  b.file_count AS fileCount,
  b.message,
  b.idempotency_key AS idempotencyKey,
  b.created_at AS createdAt,
  b.updated_at AS updatedAt,
  b.finished_at AS finishedAt
`;

const ITEM_COLUMNS = `
  i.id AS itemId,
  i.batch_id AS batchId,
  i.tenant_namespace AS tenantNamespace,
  i.original_filename AS originalFilename,
  i.staged_relative_path AS stagedRelativePath,
  i.file_type AS fileType,
  i.mime_type AS mimeType,
  i.file_size AS fileSize,
  i.sha256,
  i.status,
  i.company_name AS companyName,
  i.ticker,
  i.company_confidence AS companyConfidence,
  i.company_detection_method AS companyDetectionMethod,
  i.target_project_id AS targetProjectId,
  i.route_confidence AS routeConfidence,
  i.route_method AS routeMethod,
  i.candidate_projects_json AS candidateProjectsJson,
  i.pipeline_job_id AS pipelineJobId,
  i.document_id AS documentId,
  i.error_message AS errorMessage,
  i.created_at AS createdAt,
  i.updated_at AS updatedAt,
  i.finished_at AS finishedAt
`;

const AUDIT_COLUMNS = `
  a.id AS auditId,
  a.tenant_namespace AS tenantNamespace,
  a.batch_id AS batchId,
  a.item_id AS itemId,
  a.action,
  a.from_status AS fromStatus,
  a.to_status AS toStatus,
  a.project_id AS projectId,
  a.actor_id AS actorId,
  a.idempotency_key AS idempotencyKey,
  a.request_hash AS requestHash,
  a.details_json AS detailsJson,
  a.created_at AS createdAt
`;

const ITEM_TRANSITIONS: Readonly<
  Record<GlobalUploadItemStatus, readonly GlobalUploadItemStatus[]>
> = {
  uploaded: ["identifying", "failed"],
  identifying: ["needs_review", "routing", "failed"],
  needs_review: ["routing", "failed"],
  routing: [
    "routed",
    "indexing",
    "needs_review",
    "duplicate",
    "failed",
  ],
  routed: ["indexing", "needs_review", "duplicate", "failed"],
  indexing: [
    "completed",
    "completed_with_warnings",
    "needs_review",
    "failed",
  ],
  completed: [],
  completed_with_warnings: [],
  duplicate: [],
  failed: ["identifying", "routing"],
};

const BATCH_TRANSITIONS: Readonly<
  Record<GlobalUploadBatchStatus, readonly GlobalUploadBatchStatus[]>
> = {
  queued: ["identifying", "failed"],
  identifying: [
    "routing",
    "needs_review",
    "completed_with_errors",
    "failed",
  ],
  routing: ["indexing", "needs_review", "completed_with_errors", "failed"],
  indexing: [
    "needs_review",
    "completed",
    "completed_with_errors",
    "failed",
  ],
  needs_review: [
    "routing",
    "indexing",
    "completed_with_errors",
    "failed",
  ],
  completed: [],
  completed_with_errors: ["routing", "indexing"],
  failed: ["identifying", "routing"],
};

const ITEM_FINISHED_STATUSES = new Set<GlobalUploadItemStatus>([
  "completed",
  "completed_with_warnings",
  "duplicate",
  "failed",
]);

const ITEM_PROJECT_STATUSES = new Set<GlobalUploadItemStatus>([
  "routing",
  "routed",
  "indexing",
  "completed",
  "completed_with_warnings",
  "duplicate",
]);

const BATCH_FINISHED_STATUSES = new Set<GlobalUploadBatchStatus>([
  "completed",
  "completed_with_errors",
  "failed",
]);

export interface CreateGlobalUploadBatchResult {
  readonly batch: GlobalUploadBatchDetail;
  readonly created: boolean;
}

type BatchListInput = Partial<ListGlobalUploadBatchesQuery>;
type ItemListInput = Partial<ListGlobalUploadItemsQuery>;
type AuditListInput = Partial<ListGlobalUploadAuditQuery>;

function requestHash(value: unknown): string {
  return createHash("sha256").update(encodeJson(value)).digest("hex");
}

function mapBatch(row: SqlRow): GlobalUploadBatch {
  return globalUploadBatchSchema.parse({
    batchId: rowString(row, "batchId"),
    tenantNamespace: rowString(row, "tenantNamespace"),
    status: rowString(row, "status"),
    fileCount: rowNumber(row, "fileCount"),
    message: rowString(row, "message"),
    idempotencyKey: rowString(row, "idempotencyKey"),
    createdAt: rowString(row, "createdAt"),
    updatedAt: rowString(row, "updatedAt"),
    finishedAt: rowNullableString(row, "finishedAt"),
  });
}

function mapItem(row: SqlRow): GlobalUploadItem {
  return globalUploadItemSchema.parse({
    itemId: rowString(row, "itemId"),
    batchId: rowString(row, "batchId"),
    tenantNamespace: rowString(row, "tenantNamespace"),
    originalFilename: rowString(row, "originalFilename"),
    stagedRelativePath: rowString(row, "stagedRelativePath"),
    fileType: rowString(row, "fileType"),
    mimeType: rowString(row, "mimeType"),
    fileSize: rowNumber(row, "fileSize"),
    sha256: rowString(row, "sha256"),
    status: rowString(row, "status"),
    companyName: rowNullableString(row, "companyName"),
    ticker: rowNullableString(row, "ticker"),
    companyConfidence: rowNumber(row, "companyConfidence"),
    companyDetectionMethod: rowNullableString(
      row,
      "companyDetectionMethod",
    ),
    targetProjectId: rowNullableString(row, "targetProjectId"),
    routeConfidence: rowNumber(row, "routeConfidence"),
    routeMethod: rowNullableString(row, "routeMethod"),
    candidateProjects: decodeJson(rowString(row, "candidateProjectsJson")),
    pipelineJobId: rowNullableString(row, "pipelineJobId"),
    documentId: rowNullableString(row, "documentId"),
    errorMessage: rowNullableString(row, "errorMessage"),
    createdAt: rowString(row, "createdAt"),
    updatedAt: rowString(row, "updatedAt"),
    finishedAt: rowNullableString(row, "finishedAt"),
  });
}

function mapAudit(row: SqlRow): GlobalUploadAuditEvent {
  return globalUploadAuditEventSchema.parse({
    auditId: rowString(row, "auditId"),
    tenantNamespace: rowString(row, "tenantNamespace"),
    batchId: rowString(row, "batchId"),
    itemId: rowNullableString(row, "itemId"),
    action: rowString(row, "action"),
    fromStatus: rowNullableString(row, "fromStatus"),
    toStatus: rowNullableString(row, "toStatus"),
    projectId: rowNullableString(row, "projectId"),
    actorId: rowNullableString(row, "actorId"),
    idempotencyKey: rowString(row, "idempotencyKey"),
    requestHash: rowString(row, "requestHash"),
    details: decodeJsonObject(rowString(row, "detailsJson")),
    createdAt: rowString(row, "createdAt"),
  });
}

function assertItemTransition(
  current: GlobalUploadItemStatus,
  target: GlobalUploadItemStatus,
): void {
  if (
    current !== target &&
    !ITEM_TRANSITIONS[current].includes(target)
  ) {
    throw new ConflictError(
      `Upload item cannot transition from ${current} to ${target}`,
      "invalid_upload_item_status_transition",
    );
  }
}

function assertBatchTransition(
  current: GlobalUploadBatchStatus,
  target: GlobalUploadBatchStatus,
): void {
  if (
    current !== target &&
    !BATCH_TRANSITIONS[current].includes(target)
  ) {
    throw new ConflictError(
      `Upload batch cannot transition from ${current} to ${target}`,
      "invalid_upload_batch_status_transition",
    );
  }
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function pageResult<T>(
  items: T[],
  total: number,
  limit: number,
  offset: number,
) {
  return {
    items,
    total,
    limit,
    offset,
    hasMore: offset + items.length < total,
  };
}

export class UploadsRepository {
  private readonly users: UsersRepository;

  public constructor(
    private readonly database: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {
    this.users = new UsersRepository(database, clock);
  }

  public createBatchForTenant(
    tenantNamespace: string,
    input: CreateGlobalUploadBatchRequest,
  ): CreateGlobalUploadBatchResult {
    const parsed = createGlobalUploadBatchRequestSchema.parse(input);
    this.users.getByNamespace(tenantNamespace);
    const hash = requestHash({
      actorId: parsed.actorId ?? null,
      items: parsed.items,
    });

    return withTransaction(this.database, () => {
      const existing = this.database
        .prepare(
          `SELECT id, request_hash AS requestHash
           FROM upload_batches
           WHERE tenant_namespace = ? AND idempotency_key = ?`,
        )
        .get(tenantNamespace, parsed.idempotencyKey);
      if (existing !== undefined) {
        if (rowString(existing, "requestHash") !== hash) {
          throw new ConflictError(
            "Idempotency key was already used for a different upload batch",
            "idempotency_conflict",
          );
        }
        return {
          batch: this.getBatchForTenant(
            tenantNamespace,
            rowString(existing, "id"),
          ),
          created: false,
        };
      }

      const batchId = newId("upb");
      globalUploadBatchIdSchema.parse(batchId);
      const now = isoNow(this.clock);
      this.database
        .prepare(
          `INSERT INTO upload_batches(
             id,
             tenant_namespace,
             status,
             file_count,
             message,
             idempotency_key,
             request_hash,
             created_at,
             updated_at,
             finished_at
           ) VALUES (?, ?, 'queued', 0, '', ?, ?, ?, ?, NULL)`,
        )
        .run(
          batchId,
          tenantNamespace,
          parsed.idempotencyKey,
          hash,
          now,
          now,
        );

      const insertItem = this.database.prepare(
        `INSERT INTO upload_items(
           id,
           batch_id,
           tenant_namespace,
           original_filename,
           staged_relative_path,
           file_type,
           mime_type,
           file_size,
           sha256,
           status,
           company_name,
           ticker,
           company_confidence,
           company_detection_method,
           target_project_id,
           route_confidence,
           route_method,
           candidate_projects_json,
           pipeline_job_id,
           document_id,
           error_message,
           created_at,
           updated_at,
           finished_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded',
           NULL, NULL, 0, NULL, NULL, 0, NULL, '[]',
           NULL, NULL, NULL, ?, ?, NULL
         )`,
      );
      for (const item of parsed.items) {
        const itemId = newId("upi");
        globalUploadItemIdSchema.parse(itemId);
        insertItem.run(
          itemId,
          batchId,
          tenantNamespace,
          item.originalFilename,
          item.stagedRelativePath,
          item.fileType,
          item.mimeType,
          item.fileSize,
          item.sha256,
          now,
          now,
        );
      }

      this.appendAudit({
        tenantNamespace,
        batchId,
        itemId: null,
        action: BATCH_CREATED_ACTION,
        fromStatus: null,
        toStatus: "queued",
        projectId: null,
        actorId: parsed.actorId ?? null,
        idempotencyKey: parsed.idempotencyKey,
        hash,
        details: {
          fileCount: parsed.items.length,
          totalBytes: parsed.items.reduce(
            (total, item) => total + item.fileSize,
            0,
          ),
        },
        createdAt: now,
      });

      return {
        batch: this.getBatchForTenant(tenantNamespace, batchId),
        created: true,
      };
    });
  }

  public getBatchForTenant(
    tenantNamespace: string,
    batchId: string,
  ): GlobalUploadBatchDetail {
    globalUploadBatchIdSchema.parse(batchId);
    const row = this.database
      .prepare(
        `SELECT ${BATCH_COLUMNS}
         FROM upload_batches AS b
         WHERE b.id = ? AND b.tenant_namespace = ?`,
      )
      .get(batchId, tenantNamespace);
    if (row === undefined) {
      throw new NotFoundError("Upload batch");
    }
    const batch = mapBatch(row);
    const items = this.database
      .prepare(
        `SELECT ${ITEM_COLUMNS}
         FROM upload_items AS i
         WHERE i.batch_id = ? AND i.tenant_namespace = ?
         ORDER BY i.created_at, i.id`,
      )
      .all(batchId, tenantNamespace)
      .map(mapItem);
    const counts: Partial<Record<GlobalUploadItemStatus, number>> = {};
    for (const item of items) {
      counts[item.status] = (counts[item.status] ?? 0) + 1;
    }
    return globalUploadBatchDetailSchema.parse({
      ...batch,
      counts,
      items,
    });
  }

  public getItemForTenant(
    tenantNamespace: string,
    itemId: string,
  ): GlobalUploadItem {
    globalUploadItemIdSchema.parse(itemId);
    const row = this.database
      .prepare(
        `SELECT ${ITEM_COLUMNS}
         FROM upload_items AS i
         WHERE i.id = ? AND i.tenant_namespace = ?`,
      )
      .get(itemId, tenantNamespace);
    if (row === undefined) {
      throw new NotFoundError("Upload item");
    }
    return mapItem(row);
  }

  public getAuditForTenant(
    tenantNamespace: string,
    auditId: string,
  ): GlobalUploadAuditEvent {
    globalUploadAuditIdSchema.parse(auditId);
    const row = this.database
      .prepare(
        `SELECT ${AUDIT_COLUMNS}
         FROM upload_audit_events AS a
         WHERE a.id = ? AND a.tenant_namespace = ?`,
      )
      .get(auditId, tenantNamespace);
    if (row === undefined) {
      throw new NotFoundError("Upload audit event");
    }
    return mapAudit(row);
  }

  public listBatchesForTenant(
    tenantNamespace: string,
    query: BatchListInput = {},
  ): GlobalUploadBatchPage {
    const parsed = listGlobalUploadBatchesQuerySchema.parse(query);
    const conditions = ["b.tenant_namespace = ?"];
    const parameters: Array<number | string> = [tenantNamespace];
    if (parsed.status !== undefined) {
      conditions.push("b.status = ?");
      parameters.push(parsed.status);
    }
    const where = conditions.join(" AND ");
    const totalRow = this.database
      .prepare(
        `SELECT count(*) AS total
         FROM upload_batches AS b
         WHERE ${where}`,
      )
      .get(...parameters);
    if (totalRow === undefined) {
      throw new DomainError(
        "Failed to count upload batches",
        "corrupt_database",
        500,
      );
    }
    const items = this.database
      .prepare(
        `SELECT ${BATCH_COLUMNS}
         FROM upload_batches AS b
         WHERE ${where}
         ORDER BY b.updated_at DESC, b.created_at DESC, b.id
         LIMIT ? OFFSET ?`,
      )
      .all(...parameters, parsed.limit, parsed.offset)
      .map(mapBatch);
    return globalUploadBatchPageSchema.parse(
      pageResult(
        items,
        rowNumber(totalRow, "total"),
        parsed.limit,
        parsed.offset,
      ),
    );
  }

  public listItemsForTenant(
    tenantNamespace: string,
    query: ItemListInput = {},
  ): GlobalUploadItemPage {
    const parsed = listGlobalUploadItemsQuerySchema.parse(query);
    const conditions = ["i.tenant_namespace = ?"];
    const parameters: Array<number | string> = [tenantNamespace];
    if (parsed.batchId !== undefined) {
      conditions.push("i.batch_id = ?");
      parameters.push(parsed.batchId);
    }
    if (parsed.status !== undefined) {
      conditions.push("i.status = ?");
      parameters.push(parsed.status);
    }
    if (parsed.projectId !== undefined) {
      conditions.push("i.target_project_id = ?");
      parameters.push(parsed.projectId);
    }
    const where = conditions.join(" AND ");
    const totalRow = this.database
      .prepare(
        `SELECT count(*) AS total
         FROM upload_items AS i
         WHERE ${where}`,
      )
      .get(...parameters);
    if (totalRow === undefined) {
      throw new DomainError(
        "Failed to count upload items",
        "corrupt_database",
        500,
      );
    }
    const items = this.database
      .prepare(
        `SELECT ${ITEM_COLUMNS}
         FROM upload_items AS i
         WHERE ${where}
         ORDER BY i.updated_at DESC, i.created_at DESC, i.id
         LIMIT ? OFFSET ?`,
      )
      .all(...parameters, parsed.limit, parsed.offset)
      .map(mapItem);
    return globalUploadItemPageSchema.parse(
      pageResult(
        items,
        rowNumber(totalRow, "total"),
        parsed.limit,
        parsed.offset,
      ),
    );
  }

  public listAuditForTenant(
    tenantNamespace: string,
    query: AuditListInput = {},
  ): GlobalUploadAuditPage {
    const parsed = listGlobalUploadAuditQuerySchema.parse(query);
    const conditions = ["a.tenant_namespace = ?"];
    const parameters: Array<number | string> = [tenantNamespace];
    if (parsed.batchId !== undefined) {
      conditions.push("a.batch_id = ?");
      parameters.push(parsed.batchId);
    }
    if (parsed.itemId !== undefined) {
      conditions.push("a.item_id = ?");
      parameters.push(parsed.itemId);
    }
    const where = conditions.join(" AND ");
    const totalRow = this.database
      .prepare(
        `SELECT count(*) AS total
         FROM upload_audit_events AS a
         WHERE ${where}`,
      )
      .get(...parameters);
    if (totalRow === undefined) {
      throw new DomainError(
        "Failed to count upload audit events",
        "corrupt_database",
        500,
      );
    }
    const items = this.database
      .prepare(
        `SELECT ${AUDIT_COLUMNS}
         FROM upload_audit_events AS a
         WHERE ${where}
         ORDER BY a.created_at DESC, a.id
         LIMIT ? OFFSET ?`,
      )
      .all(...parameters, parsed.limit, parsed.offset)
      .map(mapAudit);
    return {
      items,
      total: rowNumber(totalRow, "total"),
      limit: parsed.limit,
      offset: parsed.offset,
      hasMore:
        parsed.offset + items.length < rowNumber(totalRow, "total"),
    };
  }

  public transitionBatchForTenant(
    tenantNamespace: string,
    batchId: string,
    input: TransitionGlobalUploadBatchRequest,
  ): GlobalUploadBatchDetail {
    globalUploadBatchIdSchema.parse(batchId);
    const parsed = transitionGlobalUploadBatchRequestSchema.parse(input);
    const hash = requestHash({
      actorId: parsed.actorId ?? null,
      batchId,
      message: parsed.message,
      status: parsed.status,
    });

    return withTransaction(this.database, () => {
      const replay = this.findAuditByIdempotency(
        tenantNamespace,
        BATCH_TRANSITIONED_ACTION,
        parsed.idempotencyKey,
      );
      if (replay !== null) {
        this.assertIdempotentReplay(replay, hash);
        return this.getBatchForTenant(tenantNamespace, batchId);
      }

      const current = this.getBatchForTenant(tenantNamespace, batchId);
      assertBatchTransition(current.status, parsed.status);
      this.assertBatchCanFinish(
        tenantNamespace,
        batchId,
        parsed.status,
      );
      const now = isoNow(this.clock);
      const finishedAt = BATCH_FINISHED_STATUSES.has(parsed.status)
        ? now
        : null;
      this.database
        .prepare(
          `UPDATE upload_batches
           SET status = ?,
               message = ?,
               updated_at = ?,
               finished_at = ?
           WHERE id = ? AND tenant_namespace = ?`,
        )
        .run(
          parsed.status,
          parsed.message,
          now,
          finishedAt,
          batchId,
          tenantNamespace,
        );
      this.appendAudit({
        tenantNamespace,
        batchId,
        itemId: null,
        action: BATCH_TRANSITIONED_ACTION,
        fromStatus: current.status,
        toStatus: parsed.status,
        projectId: null,
        actorId: parsed.actorId ?? null,
        idempotencyKey: parsed.idempotencyKey,
        hash,
        details: { message: parsed.message },
        createdAt: now,
      });
      return this.getBatchForTenant(tenantNamespace, batchId);
    });
  }

  public transitionItemForTenant(
    tenantNamespace: string,
    itemId: string,
    input: TransitionGlobalUploadItemRequest,
  ): GlobalUploadItem {
    globalUploadItemIdSchema.parse(itemId);
    const parsed = transitionGlobalUploadItemRequestSchema.parse(input);
    const hash = requestHash({
      ...parsed,
      actorId: parsed.actorId ?? null,
      itemId,
    });

    return withTransaction(this.database, () => {
      const replay = this.findAuditByIdempotency(
        tenantNamespace,
        ITEM_TRANSITIONED_ACTION,
        parsed.idempotencyKey,
      );
      if (replay !== null) {
        this.assertIdempotentReplay(replay, hash);
        return this.getItemForTenant(tenantNamespace, itemId);
      }

      const current = this.getItemForTenant(tenantNamespace, itemId);
      assertItemTransition(current.status, parsed.status);
      const candidateProjects = hasOwn(parsed, "candidateProjects")
        ? (parsed.candidateProjects ?? [])
        : current.candidateProjects;
      const targetProjectId = hasOwn(parsed, "targetProjectId")
        ? (parsed.targetProjectId ?? null)
        : current.targetProjectId;
      const pipelineJobId = hasOwn(parsed, "pipelineJobId")
        ? (parsed.pipelineJobId ?? null)
        : current.pipelineJobId;
      const documentId = hasOwn(parsed, "documentId")
        ? (parsed.documentId ?? null)
        : current.documentId;

      this.validateProjectAssociations(
        tenantNamespace,
        candidateProjects,
        targetProjectId,
      );
      if (
        ITEM_PROJECT_STATUSES.has(parsed.status) &&
        targetProjectId === null
      ) {
        throw new ConflictError(
          `${parsed.status} upload items require a target project`,
          "upload_project_required",
        );
      }
      this.validateJobAssociation(
        tenantNamespace,
        pipelineJobId,
        targetProjectId,
      );
      if (documentId !== null && targetProjectId === null) {
        throw new ConflictError(
          "A document association requires a target project",
          "upload_document_project_required",
        );
      }

      const companyName = hasOwn(parsed, "companyName")
        ? (parsed.companyName ?? null)
        : current.companyName;
      const ticker = hasOwn(parsed, "ticker")
        ? (parsed.ticker ?? null)
        : current.ticker;
      const companyConfidence =
        parsed.companyConfidence ?? current.companyConfidence;
      const companyDetectionMethod = hasOwn(
        parsed,
        "companyDetectionMethod",
      )
        ? (parsed.companyDetectionMethod ?? null)
        : current.companyDetectionMethod;
      const routeConfidence =
        parsed.routeConfidence ?? current.routeConfidence;
      const routeMethod = hasOwn(parsed, "routeMethod")
        ? (parsed.routeMethod ?? null)
        : current.routeMethod;
      const errorMessage =
        parsed.status === "failed"
          ? (parsed.errorMessage ?? null)
          : hasOwn(parsed, "errorMessage")
            ? (parsed.errorMessage ?? null)
            : null;
      const now = isoNow(this.clock);
      const finishedAt = ITEM_FINISHED_STATUSES.has(parsed.status)
        ? now
        : null;

      this.database
        .prepare(
          `UPDATE upload_items
           SET status = ?,
               company_name = ?,
               ticker = ?,
               company_confidence = ?,
               company_detection_method = ?,
               target_project_id = ?,
               route_confidence = ?,
               route_method = ?,
               candidate_projects_json = ?,
               pipeline_job_id = ?,
               document_id = ?,
               error_message = ?,
               updated_at = ?,
               finished_at = ?
           WHERE id = ? AND tenant_namespace = ?`,
        )
        .run(
          parsed.status,
          companyName,
          ticker,
          companyConfidence,
          companyDetectionMethod,
          targetProjectId,
          routeConfidence,
          routeMethod,
          encodeJson(candidateProjects),
          pipelineJobId,
          documentId,
          errorMessage,
          now,
          finishedAt,
          itemId,
          tenantNamespace,
        );
      this.touchBatch(current.batchId, tenantNamespace, now);
      this.appendAudit({
        tenantNamespace,
        batchId: current.batchId,
        itemId,
        action: ITEM_TRANSITIONED_ACTION,
        fromStatus: current.status,
        toStatus: parsed.status,
        projectId: targetProjectId,
        actorId: parsed.actorId ?? null,
        idempotencyKey: parsed.idempotencyKey,
        hash,
        details: {
          candidateProjects,
          companyConfidence,
          companyDetectionMethod,
          companyName,
          documentId,
          errorMessage,
          pipelineJobId,
          routeConfidence,
          routeMethod,
          targetProjectId,
          ticker,
        },
        createdAt: now,
      });
      return this.getItemForTenant(tenantNamespace, itemId);
    });
  }

  public routeItemForTenant(
    tenantNamespace: string,
    itemId: string,
    input: RouteGlobalUploadItemRequest,
  ): GlobalUploadItem {
    globalUploadItemIdSchema.parse(itemId);
    const parsed = routeGlobalUploadItemRequestSchema.parse(input);
    const hash = requestHash({
      actorId: parsed.actorId ?? null,
      itemId,
      projectId: parsed.projectId,
    });

    return withTransaction(this.database, () => {
      const replay = this.findAuditByIdempotency(
        tenantNamespace,
        ITEM_ROUTED_ACTION,
        parsed.idempotencyKey,
      );
      if (replay !== null) {
        this.assertIdempotentReplay(replay, hash);
        return this.getItemForTenant(tenantNamespace, itemId);
      }

      const current = this.getItemForTenant(tenantNamespace, itemId);
      if (
        current.status !== "needs_review" &&
        current.status !== "failed"
      ) {
        throw new ConflictError(
          "Only needs_review or failed upload items can be routed manually",
          "upload_item_not_routable",
        );
      }
      this.ensureProjectForTenant(tenantNamespace, parsed.projectId);
      const now = isoNow(this.clock);
      this.database
        .prepare(
          `UPDATE upload_items
           SET status = 'routing',
               target_project_id = ?,
               route_confidence = 1,
               route_method = 'manual',
               pipeline_job_id = NULL,
               document_id = NULL,
               error_message = NULL,
               updated_at = ?,
               finished_at = NULL
           WHERE id = ? AND tenant_namespace = ?`,
        )
        .run(parsed.projectId, now, itemId, tenantNamespace);

      const batch = this.getBatchForTenant(
        tenantNamespace,
        current.batchId,
      );
      const batchTarget = this.advanceBatchForManualRoute(
        tenantNamespace,
        current.batchId,
        batch.status,
        now,
      );

      this.appendAudit({
        tenantNamespace,
        batchId: current.batchId,
        itemId,
        action: ITEM_ROUTED_ACTION,
        fromStatus: current.status,
        toStatus: "routing",
        projectId: parsed.projectId,
        actorId: parsed.actorId ?? null,
        idempotencyKey: parsed.idempotencyKey,
        hash,
        details: {
          batchFromStatus: batch.status,
          batchToStatus: batchTarget,
          previousProjectId: current.targetProjectId,
          projectId: parsed.projectId,
        },
        createdAt: now,
      });
      return this.getItemForTenant(tenantNamespace, itemId);
    });
  }

  private findAuditByIdempotency(
    tenantNamespace: string,
    action: string,
    idempotencyKey: string,
  ): GlobalUploadAuditEvent | null {
    const row = this.database
      .prepare(
        `SELECT ${AUDIT_COLUMNS}
         FROM upload_audit_events AS a
         WHERE a.tenant_namespace = ?
           AND a.action = ?
           AND a.idempotency_key = ?`,
      )
      .get(tenantNamespace, action, idempotencyKey);
    return row === undefined ? null : mapAudit(row);
  }

  private assertIdempotentReplay(
    audit: GlobalUploadAuditEvent,
    hash: string,
  ): void {
    if (audit.requestHash !== hash) {
      throw new ConflictError(
        "Idempotency key was already used for a different upload mutation",
        "idempotency_conflict",
      );
    }
  }

  private ensureProjectForTenant(
    tenantNamespace: string,
    projectId: string,
  ): void {
    const row = this.database
      .prepare(
        `SELECT 1
         FROM projects AS p
         JOIN users AS u ON u.id = p.user_id
         WHERE p.id = ? AND u.data_namespace = ?`,
      )
      .get(projectId, tenantNamespace);
    if (row === undefined) {
      throw new NotFoundError("Project");
    }
  }

  private validateProjectAssociations(
    tenantNamespace: string,
    candidates: readonly GlobalUploadProjectCandidate[],
    targetProjectId: string | null,
  ): void {
    if (targetProjectId !== null) {
      this.ensureProjectForTenant(tenantNamespace, targetProjectId);
    }
    const checked = new Set<string>();
    for (const candidate of candidates) {
      if (!checked.has(candidate.projectId)) {
        this.ensureProjectForTenant(
          tenantNamespace,
          candidate.projectId,
        );
        checked.add(candidate.projectId);
      }
    }
  }

  private validateJobAssociation(
    tenantNamespace: string,
    jobId: string | null,
    targetProjectId: string | null,
  ): void {
    if (jobId === null) {
      return;
    }
    if (targetProjectId === null) {
      throw new ConflictError(
        "A pipeline job association requires a target project",
        "upload_job_project_required",
      );
    }
    const row = this.database
      .prepare(
        `SELECT 1
         FROM jobs
         WHERE id = ?
           AND tenant_namespace = ?
           AND project_id = ?`,
      )
      .get(jobId, tenantNamespace, targetProjectId);
    if (row === undefined) {
      throw new NotFoundError("Pipeline job");
    }
  }

  private assertBatchCanFinish(
    tenantNamespace: string,
    batchId: string,
    status: GlobalUploadBatchStatus,
  ): void {
    if (status !== "completed" && status !== "completed_with_errors") {
      return;
    }
    const disallowed =
      status === "completed"
        ? ["completed", "completed_with_warnings", "duplicate"]
        : [
            "completed",
            "completed_with_warnings",
            "duplicate",
            "failed",
          ];
    const placeholders = disallowed.map(() => "?").join(", ");
    const row = this.database
      .prepare(
        `SELECT count(*) AS pending
         FROM upload_items
         WHERE tenant_namespace = ?
           AND batch_id = ?
           AND status NOT IN (${placeholders})`,
      )
      .get(tenantNamespace, batchId, ...disallowed);
    if (row === undefined || rowNumber(row, "pending") !== 0) {
      throw new ConflictError(
        `Upload batch cannot become ${status} while items are active`,
        "upload_batch_has_active_items",
      );
    }
  }

  private advanceBatchForManualRoute(
    tenantNamespace: string,
    batchId: string,
    current: GlobalUploadBatchStatus,
    timestamp: string,
  ): GlobalUploadBatchStatus {
    let transitions: readonly GlobalUploadBatchStatus[];
    switch (current) {
      case "queued":
        transitions = ["identifying", "routing", "indexing"];
        break;
      case "identifying":
        transitions = ["routing", "indexing"];
        break;
      case "routing":
        transitions = ["indexing"];
        break;
      case "failed":
        transitions = ["routing", "indexing"];
        break;
      case "needs_review":
      case "completed_with_errors":
        transitions = ["indexing"];
        break;
      case "indexing":
        transitions = [];
        break;
      case "completed":
        throw new ConflictError(
          "A completed upload batch cannot contain a routable item",
          "upload_batch_not_routable",
        );
      default:
        transitions = [];
    }
    if (transitions.length === 0) {
      this.touchBatch(batchId, tenantNamespace, timestamp);
      return current;
    }
    const update = this.database.prepare(
      `UPDATE upload_batches
       SET status = ?,
           message = '',
           updated_at = ?,
           finished_at = NULL
       WHERE id = ? AND tenant_namespace = ?`,
    );
    for (const status of transitions) {
      update.run(status, timestamp, batchId, tenantNamespace);
    }
    return transitions.at(-1)!;
  }

  private touchBatch(
    batchId: string,
    tenantNamespace: string,
    timestamp: string,
  ): void {
    this.database
      .prepare(
        `UPDATE upload_batches
         SET updated_at = max(updated_at, ?)
         WHERE id = ? AND tenant_namespace = ?`,
      )
      .run(timestamp, batchId, tenantNamespace);
  }

  private appendAudit(input: {
    readonly tenantNamespace: string;
    readonly batchId: string;
    readonly itemId: string | null;
    readonly action: string;
    readonly fromStatus: string | null;
    readonly toStatus: string | null;
    readonly projectId: string | null;
    readonly actorId: string | null;
    readonly idempotencyKey: string;
    readonly hash: string;
    readonly details: Record<string, unknown>;
    readonly createdAt: string;
  }): GlobalUploadAuditEvent {
    const auditId = newId("upa");
    globalUploadAuditIdSchema.parse(auditId);
    this.database
      .prepare(
        `INSERT INTO upload_audit_events(
           id,
           tenant_namespace,
           batch_id,
           item_id,
           action,
           from_status,
           to_status,
           project_id,
           actor_id,
           idempotency_key,
           request_hash,
           details_json,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        auditId,
        input.tenantNamespace,
        input.batchId,
        input.itemId,
        input.action,
        input.fromStatus,
        input.toStatus,
        input.projectId,
        input.actorId,
        input.idempotencyKey,
        input.hash,
        encodeJson(input.details),
        input.createdAt,
      );
    return this.getAuditForTenant(input.tenantNamespace, auditId);
  }
}
