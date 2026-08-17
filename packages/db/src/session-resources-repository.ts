import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  SESSION_ATTACHMENT_MAX_COUNT,
  SESSION_ATTACHMENT_MAX_TOTAL_BYTES,
  SESSION_ATTACHMENT_MAX_UPLOAD_BYTES,
  sessionAttachmentFilenameSchema,
  sessionAttachmentMimeTypeSchema,
  sessionResourceIdSchema,
  type SessionResourceKind,
  type SessionResourceLifecycle,
  type SessionResourceLifecycleFilter,
} from "@private-fund/contracts";
import type { Clock } from "@private-fund/core";
import {
  ConflictError,
  NotFoundError,
  isoNow,
  newId,
  systemClock,
} from "@private-fund/core";

import { SessionEventsRepository } from "./session-events-repository.js";
import type { SqlRow } from "./rows.js";
import {
  rowNullableString,
  rowNumber,
  rowString,
} from "./rows.js";
import { withTransaction } from "./transaction.js";

interface SessionResourceRecordBase {
  readonly id: string;
  readonly userId: string;
  readonly tenantNamespace: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly lifecycle: SessionResourceLifecycle;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly deletedByUserId: string | null;
}

export interface SessionAttachmentRecord
  extends SessionResourceRecordBase {
  readonly kind: "attachment";
  readonly relativePath: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly referenceId: null;
  readonly referenceVersionId: null;
}

export interface SessionResearchAssetResourceRecord
  extends SessionResourceRecordBase {
  readonly kind: "research_asset";
  readonly referenceId: string;
  readonly referenceVersionId: string;
  readonly relativePath: null;
  readonly mimeType: null;
  readonly sizeBytes: null;
  readonly sha256: null;
}

export interface SessionDocumentReferenceResourceRecord
  extends SessionResourceRecordBase {
  readonly kind: "document_reference";
  readonly referenceId: string;
  readonly referenceVersionId: string;
  readonly relativePath: null;
  readonly mimeType: null;
  readonly sizeBytes: null;
  readonly sha256: null;
}

export type SessionResourceRecord =
  | SessionAttachmentRecord
  | SessionResearchAssetResourceRecord
  | SessionDocumentReferenceResourceRecord;

export interface SessionResourcePageRecord {
  readonly items: readonly SessionResourceRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
}

export interface ListSessionResourceRecordsOptions {
  readonly kind?: SessionResourceKind;
  readonly lifecycle?: SessionResourceLifecycleFilter;
  readonly limit?: number;
  readonly offset?: number;
}

export interface CreateSessionAttachmentRecordInput {
  readonly id: string;
  readonly filename: string;
  readonly relativePath: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface CreateSessionTypedResourceRecordInput {
  readonly id?: string;
  readonly name: string;
  readonly referenceId: string;
  readonly referenceVersionId: string;
}

export interface CreateSessionTypedResourceRecordResult {
  readonly resource:
    | SessionResearchAssetResourceRecord
    | SessionDocumentReferenceResourceRecord;
  readonly created: boolean;
}

export interface SessionAttachmentUsage {
  readonly count: number;
  readonly totalBytes: number;
}

export interface DeletedSessionResources {
  readonly deletedCount: number;
  readonly deletedAt: string;
}

const RESOURCE_COLUMNS = `
  sr.id,
  s.user_id AS userId,
  u.data_namespace AS tenantNamespace,
  sr.session_id AS sessionId,
  s.project_id AS projectId,
  sr.kind,
  sr.lifecycle,
  sr.name,
  sr.reference_id AS referenceId,
  sr.reference_version_id AS referenceVersionId,
  sr.relative_path AS relativePath,
  sr.mime_type AS mimeType,
  sr.size_bytes AS sizeBytes,
  sr.sha256,
  sr.created_at AS createdAt,
  sr.updated_at AS updatedAt,
  sr.deleted_at AS deletedAt,
  sr.deleted_by_user_id AS deletedByUserId
`;

function corruptResource(message: string): never {
  throw new Error(`Stored session resource is invalid: ${message}`);
}

function mapResource(row: SqlRow): SessionResourceRecord {
  const base = {
    id: rowString(row, "id"),
    userId: rowString(row, "userId"),
    tenantNamespace: rowString(row, "tenantNamespace"),
    sessionId: rowString(row, "sessionId"),
    projectId: rowString(row, "projectId"),
    lifecycle: rowString(
      row,
      "lifecycle",
    ) as SessionResourceLifecycle,
    name: rowString(row, "name"),
    createdAt: rowString(row, "createdAt"),
    updatedAt: rowString(row, "updatedAt"),
    deletedAt: rowNullableString(row, "deletedAt"),
    deletedByUserId: rowNullableString(row, "deletedByUserId"),
  };
  const kind = rowString(row, "kind");
  const referenceId = rowNullableString(row, "referenceId");
  const referenceVersionId = rowNullableString(
    row,
    "referenceVersionId",
  );
  const relativePath = rowNullableString(row, "relativePath");
  const mimeType = rowNullableString(row, "mimeType");
  const sha256 = rowNullableString(row, "sha256");

  if (kind === "attachment") {
    if (
      referenceId !== null ||
      referenceVersionId !== null ||
      relativePath === null ||
      mimeType === null ||
      sha256 === null
    ) {
      return corruptResource("attachment payload columns do not agree");
    }
    return {
      ...base,
      kind,
      relativePath,
      mimeType,
      sizeBytes: rowNumber(row, "sizeBytes"),
      sha256,
      referenceId: null,
      referenceVersionId: null,
    };
  }
  if (kind === "research_asset" || kind === "document_reference") {
    if (
      referenceId === null ||
      referenceVersionId === null ||
      relativePath !== null ||
      mimeType !== null ||
      row.sizeBytes !== null ||
      sha256 !== null
    ) {
      return corruptResource("typed reference payload columns do not agree");
    }
    return {
      ...base,
      kind,
      referenceId,
      referenceVersionId,
      relativePath: null,
      mimeType: null,
      sizeBytes: null,
      sha256: null,
    };
  }
  return corruptResource(`unknown kind ${kind}`);
}

function pageValues(
  options: ListSessionResourceRecordsOptions,
): { limit: number; offset: number } {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new RangeError("limit must contain between 1 and 200 rows");
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("offset must be a non-negative integer");
  }
  return { limit, offset };
}

function assertKind(
  kind: SessionResourceKind | undefined,
): SessionResourceKind | undefined {
  if (
    kind !== undefined &&
    kind !== "attachment" &&
    kind !== "research_asset" &&
    kind !== "document_reference"
  ) {
    throw new RangeError("Unknown session resource kind");
  }
  return kind;
}

function assertLifecycleFilter(
  lifecycle: SessionResourceLifecycleFilter | undefined,
): SessionResourceLifecycleFilter {
  const value = lifecycle ?? "active";
  if (value !== "active" && value !== "deleted" && value !== "all") {
    throw new RangeError("Unknown session resource lifecycle");
  }
  return value;
}

function normalizeName(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > 500) {
    throw new RangeError(
      "Session resource name must contain between 1 and 500 characters",
    );
  }
  return normalized;
}

function assertReferenceId(value: string, field: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(normalized)
  ) {
    throw new RangeError(`${field} is invalid`);
  }
  return normalized;
}

function assertSha256(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new RangeError("sha256 must be a 64-character hexadecimal digest");
  }
  return normalized;
}

function assertRelativeAttachmentPath(
  value: string,
  sessionId: string,
  resourceId: string,
): string {
  if (
    !value ||
    value.length > 4_000 ||
    path.posix.isAbsolute(value) ||
    value.includes("\\")
  ) {
    throw new RangeError(
      "Attachment path must be a normalized tenant-relative path",
    );
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        !segment || segment === "." || segment === "..",
    ) ||
    path.posix.normalize(value) !== value
  ) {
    throw new RangeError(
      "Attachment path must be a normalized tenant-relative path",
    );
  }
  const expectedDirectory = [
    "session-attachments",
    sessionId,
    "objects",
  ];
  if (
    segments.length !== 4 ||
    expectedDirectory.some(
      (segment, index) => segments[index] !== segment,
    ) ||
    !new RegExp(
      `^${resourceId}\\.[a-z0-9]{1,16}$`,
      "u",
    ).test(segments[3] ?? "")
  ) {
    throw new RangeError(
      "Attachment path does not match its session and opaque resource ID",
    );
  }
  return value;
}

function normalizeResourceId(value: string | undefined): string {
  return sessionResourceIdSchema.parse(value ?? newId("resource"));
}

export class SessionResourcesRepository {
  private readonly events: SessionEventsRepository;

  public constructor(
    private readonly database: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {
    this.events = new SessionEventsRepository(database, clock);
  }

  public createAttachmentForTenant(
    tenantNamespace: string,
    sessionId: string,
    input: CreateSessionAttachmentRecordInput,
  ): SessionAttachmentRecord {
    const id = normalizeResourceId(input.id);
    const filename = sessionAttachmentFilenameSchema.parse(
      input.filename.normalize("NFKC").trim(),
    );
    const mimeType = sessionAttachmentMimeTypeSchema.parse(
      input.mimeType,
    );
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 1 ||
      input.sizeBytes > SESSION_ATTACHMENT_MAX_UPLOAD_BYTES
    ) {
      throw new RangeError("Attachment size is outside the accepted range");
    }
    const sha256 = assertSha256(input.sha256);
    const relativePath = assertRelativeAttachmentPath(
      input.relativePath,
      sessionId,
      id,
    );

    return withTransaction(this.database, () => {
      const session = this.requireSession(tenantNamespace, sessionId);
      const usage = this.attachmentUsageUnchecked(sessionId);
      if (usage.count >= SESSION_ATTACHMENT_MAX_COUNT) {
        throw new ConflictError(
          `A session may have at most ${String(
            SESSION_ATTACHMENT_MAX_COUNT,
          )} active attachments`,
          "session_attachment_count_limit",
        );
      }
      if (
        usage.totalBytes + input.sizeBytes >
        SESSION_ATTACHMENT_MAX_TOTAL_BYTES
      ) {
        throw new ConflictError(
          "The session attachment storage limit has been reached",
          "session_attachment_storage_limit",
        );
      }
      const now = isoNow(this.clock);
      this.database
        .prepare(
          `INSERT INTO session_resources(
             id, session_id, kind, lifecycle, name, reference_id,
             reference_version_id, relative_path, mime_type, size_bytes,
             sha256, created_at, updated_at, deleted_at,
             deleted_by_user_id
           ) VALUES (
             ?, ?, 'attachment', 'active', ?, NULL, NULL, ?, ?, ?, ?, ?,
             ?, NULL, NULL
           )`,
        )
        .run(
          id,
          sessionId,
          filename,
          relativePath,
          mimeType,
          input.sizeBytes,
          sha256,
          now,
          now,
        );
      this.events.appendForTenant(tenantNamespace, {
        sessionId,
        type: "session.resource.created",
        timestamp: now,
        payload: {
          id,
          kind: "attachment",
          filename,
          mimeType,
          bytes: input.sizeBytes,
          sha256,
          projectId: session.projectId,
        },
      });
      return this.getAttachmentForTenant(
        tenantNamespace,
        sessionId,
        id,
      );
    });
  }

  public createResearchAssetForTenant(
    tenantNamespace: string,
    sessionId: string,
    input: CreateSessionTypedResourceRecordInput,
  ): CreateSessionTypedResourceRecordResult {
    return this.createTypedReferenceForTenant(
      tenantNamespace,
      sessionId,
      "research_asset",
      input,
    );
  }

  public createDocumentReferenceForTenant(
    tenantNamespace: string,
    sessionId: string,
    input: CreateSessionTypedResourceRecordInput,
  ): CreateSessionTypedResourceRecordResult {
    return this.createTypedReferenceForTenant(
      tenantNamespace,
      sessionId,
      "document_reference",
      input,
    );
  }

  public findForTenant(
    tenantNamespace: string,
    sessionId: string,
    resourceId: string,
    includeDeleted = false,
  ): SessionResourceRecord | null {
    const deletedClause = includeDeleted
      ? ""
      : " AND sr.lifecycle = 'active'";
    const row = this.database
      .prepare(
        `SELECT ${RESOURCE_COLUMNS}
         FROM session_resources AS sr
         JOIN sessions AS s ON s.id = sr.session_id
         JOIN users AS u ON u.id = s.user_id
         WHERE u.data_namespace = ? AND s.deleted_at IS NULL
           AND sr.session_id = ? AND sr.id = ?${deletedClause}`,
      )
      .get(tenantNamespace, sessionId, resourceId);
    return row === undefined ? null : mapResource(row);
  }

  public getForTenant(
    tenantNamespace: string,
    sessionId: string,
    resourceId: string,
    includeDeleted = false,
  ): SessionResourceRecord {
    const resource = this.findForTenant(
      tenantNamespace,
      sessionId,
      resourceId,
      includeDeleted,
    );
    if (resource === null) {
      throw new NotFoundError("Session resource");
    }
    return resource;
  }

  public findAttachmentForTenant(
    tenantNamespace: string,
    sessionId: string,
    attachmentId: string,
    includeDeleted = false,
  ): SessionAttachmentRecord | null {
    const resource = this.findForTenant(
      tenantNamespace,
      sessionId,
      attachmentId,
      includeDeleted,
    );
    return resource?.kind === "attachment" ? resource : null;
  }

  public getAttachmentForTenant(
    tenantNamespace: string,
    sessionId: string,
    attachmentId: string,
    includeDeleted = false,
  ): SessionAttachmentRecord {
    const attachment = this.findAttachmentForTenant(
      tenantNamespace,
      sessionId,
      attachmentId,
      includeDeleted,
    );
    if (attachment === null) {
      throw new NotFoundError("Session attachment");
    }
    return attachment;
  }

  public listForTenant(
    tenantNamespace: string,
    sessionId: string,
    options: ListSessionResourceRecordsOptions = {},
  ): SessionResourcePageRecord {
    this.requireSession(tenantNamespace, sessionId);
    const { limit, offset } = pageValues(options);
    const kind = assertKind(options.kind);
    const lifecycle = assertLifecycleFilter(options.lifecycle);
    const clauses = ["u.data_namespace = ?", "s.deleted_at IS NULL"];
    const parameters: (number | string)[] = [tenantNamespace];
    if (kind !== undefined) {
      clauses.push("sr.kind = ?");
      parameters.push(kind);
    }
    if (lifecycle !== "all") {
      clauses.push("sr.lifecycle = ?");
      parameters.push(lifecycle);
    }
    clauses.push("sr.session_id = ?");
    parameters.push(sessionId);
    const where = ` WHERE ${clauses.join(" AND ")}`;
    const total = Number(
      this.database
        .prepare(
          `SELECT COUNT(*) AS total
           FROM session_resources AS sr
           JOIN sessions AS s ON s.id = sr.session_id
           JOIN users AS u ON u.id = s.user_id${where}`,
        )
        .get(...parameters)?.total ?? 0,
    );
    const items = this.database
      .prepare(
        `SELECT ${RESOURCE_COLUMNS}
         FROM session_resources AS sr
         JOIN sessions AS s ON s.id = sr.session_id
         JOIN users AS u ON u.id = s.user_id${where}
         ORDER BY sr.created_at DESC, sr.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...parameters, limit, offset)
      .map(mapResource);
    return {
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
  }

  public listAttachmentsForTenant(
    tenantNamespace: string,
    sessionId: string,
    options: Omit<ListSessionResourceRecordsOptions, "kind"> = {},
  ): SessionResourcePageRecord & {
    readonly items: readonly SessionAttachmentRecord[];
  } {
    const page = this.listForTenant(tenantNamespace, sessionId, {
      ...options,
      kind: "attachment",
    });
    return {
      ...page,
      items: page.items.map((item) => {
        if (item.kind !== "attachment") {
          return corruptResource("attachment list returned another kind");
        }
        return item;
      }),
    };
  }

  public attachmentUsageForTenant(
    tenantNamespace: string,
    sessionId: string,
  ): SessionAttachmentUsage {
    this.requireSession(tenantNamespace, sessionId);
    return this.attachmentUsageUnchecked(sessionId);
  }

  public markDeletedForTenant(
    tenantNamespace: string,
    sessionId: string,
    resourceId: string,
  ): SessionResourceRecord {
    return withTransaction(this.database, () => {
      const resource = this.getForTenant(
        tenantNamespace,
        sessionId,
        resourceId,
      );
      const now = isoNow(this.clock);
      const result = this.database
        .prepare(
          `UPDATE session_resources
           SET lifecycle = 'deleted', updated_at = ?, deleted_at = ?,
               deleted_by_user_id = ?
           WHERE id = ? AND session_id = ? AND lifecycle = 'active'`,
        )
        .run(
          now,
          now,
          resource.userId,
          resourceId,
          sessionId,
        );
      if (result.changes !== 1) {
        throw new NotFoundError("Session resource");
      }
      this.events.appendForTenant(tenantNamespace, {
        sessionId,
        type: "session.resource.deleted",
        timestamp: now,
        payload: {
          id: resource.id,
          kind: resource.kind,
          projectId: resource.projectId,
        },
      });
      return this.getForTenant(
        tenantNamespace,
        sessionId,
        resourceId,
        true,
      );
    });
  }

  public markAttachmentDeletedForTenant(
    tenantNamespace: string,
    sessionId: string,
    attachmentId: string,
  ): SessionAttachmentRecord {
    const current = this.getAttachmentForTenant(
      tenantNamespace,
      sessionId,
      attachmentId,
    );
    const deleted = this.markDeletedForTenant(
      tenantNamespace,
      sessionId,
      current.id,
    );
    if (deleted.kind !== "attachment") {
      return corruptResource("deleted attachment changed kind");
    }
    return deleted;
  }

  public markAllDeletedForTenant(
    tenantNamespace: string,
    sessionId: string,
  ): DeletedSessionResources {
    return withTransaction(this.database, () => {
      const session = this.requireSession(tenantNamespace, sessionId);
      const active = this.listAllActiveUnchecked(sessionId);
      const now = isoNow(this.clock);
      const result = this.database
        .prepare(
          `UPDATE session_resources
           SET lifecycle = 'deleted', updated_at = ?, deleted_at = ?,
               deleted_by_user_id = ?
           WHERE session_id = ? AND lifecycle = 'active'`,
        )
        .run(now, now, session.userId, sessionId);
      for (const resource of active) {
        this.events.appendForTenant(tenantNamespace, {
          sessionId,
          type: "session.resource.deleted",
          timestamp: now,
          payload: {
            id: resource.id,
            kind: resource.kind,
            projectId: session.projectId,
            cleanup: true,
          },
        });
      }
      if (result.changes !== active.length) {
        throw new ConflictError(
          "Session resources changed during cleanup",
          "session_resource_cleanup_conflict",
        );
      }
      return {
        deletedCount: result.changes,
        deletedAt: now,
      };
    });
  }

  private createTypedReferenceForTenant(
    tenantNamespace: string,
    sessionId: string,
    kind: "research_asset" | "document_reference",
    input: CreateSessionTypedResourceRecordInput,
  ): CreateSessionTypedResourceRecordResult {
    const id = normalizeResourceId(input.id);
    const name = normalizeName(input.name);
    const referenceId = assertReferenceId(
      input.referenceId,
      "referenceId",
    );
    const referenceVersionId = assertReferenceId(
      input.referenceVersionId,
      "referenceVersionId",
    );
    return withTransaction(this.database, () => {
      const session = this.requireSession(tenantNamespace, sessionId);
      const duplicate = this.database
        .prepare(
          `SELECT ${RESOURCE_COLUMNS}
           FROM session_resources AS sr
           JOIN sessions AS s ON s.id = sr.session_id
           JOIN users AS u ON u.id = s.user_id
           WHERE u.data_namespace = ? AND sr.session_id = ?
             AND sr.kind = ? AND sr.lifecycle = 'active'
             AND sr.reference_id = ? AND sr.reference_version_id = ?`,
        )
        .get(
          tenantNamespace,
          sessionId,
          kind,
          referenceId,
          referenceVersionId,
        );
      if (duplicate !== undefined) {
        const resource = mapResource(duplicate);
        if (
          resource.kind !== "research_asset" &&
          resource.kind !== "document_reference"
        ) {
          return corruptResource("typed duplicate is not a typed reference");
        }
        return { resource, created: false };
      }
      const now = isoNow(this.clock);
      this.database
        .prepare(
          `INSERT INTO session_resources(
             id, session_id, kind, lifecycle, name, reference_id,
             reference_version_id, relative_path, mime_type, size_bytes,
             sha256, created_at, updated_at, deleted_at,
             deleted_by_user_id
           ) VALUES (
             ?, ?, ?, 'active', ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?,
             NULL, NULL
           )`,
        )
        .run(
          id,
          sessionId,
          kind,
          name,
          referenceId,
          referenceVersionId,
          now,
          now,
        );
      this.events.appendForTenant(tenantNamespace, {
        sessionId,
        type: "session.resource.created",
        timestamp: now,
        payload: {
          id,
          kind,
          referenceId,
          referenceVersionId,
          projectId: session.projectId,
        },
      });
      const resource = this.getForTenant(
        tenantNamespace,
        sessionId,
        id,
      );
      if (
        resource.kind !== "research_asset" &&
        resource.kind !== "document_reference"
      ) {
        return corruptResource("created typed reference changed kind");
      }
      return { resource, created: true };
    });
  }

  private requireSession(
    tenantNamespace: string,
    sessionId: string,
  ): {
    readonly userId: string;
    readonly projectId: string;
  } {
    const row = this.database
      .prepare(
        `SELECT s.user_id AS userId, s.project_id AS projectId
         FROM sessions AS s
         JOIN users AS u ON u.id = s.user_id
         WHERE s.id = ? AND u.data_namespace = ?
           AND s.deleted_at IS NULL`,
      )
      .get(sessionId, tenantNamespace);
    if (row === undefined) {
      throw new NotFoundError("Session");
    }
    return {
      userId: String(row.userId),
      projectId: String(row.projectId),
    };
  }

  private attachmentUsageUnchecked(
    sessionId: string,
  ): SessionAttachmentUsage {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS totalBytes
         FROM session_resources
         WHERE session_id = ? AND kind = 'attachment'
           AND lifecycle = 'active'`,
      )
      .get(sessionId);
    return {
      count: Number(row?.count ?? 0),
      totalBytes: Number(row?.totalBytes ?? 0),
    };
  }

  private listAllActiveUnchecked(
    sessionId: string,
  ): SessionResourceRecord[] {
    return this.database
      .prepare(
        `SELECT ${RESOURCE_COLUMNS}
         FROM session_resources AS sr
         JOIN sessions AS s ON s.id = sr.session_id
         JOIN users AS u ON u.id = s.user_id
         WHERE sr.session_id = ? AND sr.lifecycle = 'active'
         ORDER BY sr.created_at, sr.id`,
      )
      .all(sessionId)
      .map(mapResource);
  }
}
