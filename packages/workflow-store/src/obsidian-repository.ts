import type { DatabaseSync } from "node:sqlite";

import {
  WorkflowStoreError,
  assertOneOf,
  decodeJsonObject,
  encodeJson,
  nowIso,
  pageOptions,
  pageResult,
  requireText,
  stableId,
  toRecord,
  withTransaction,
  type JsonValue,
  type Page,
  type PageOptions,
  type SqlRow,
} from "./shared.js";

export const OBSIDIAN_OUTBOX_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
] as const;
export type ObsidianOutboxStatus = (typeof OBSIDIAN_OUTBOX_STATUSES)[number];

export const OBSIDIAN_REGISTRY_STATUSES = [
  "pending",
  "synced",
  "written",
  "unchanged",
  "conflict",
  "error",
  "failed",
  "missing",
] as const;
export type ObsidianRegistryStatus =
  (typeof OBSIDIAN_REGISTRY_STATUSES)[number];

export const DEFAULT_OBSIDIAN_PROJECTOR_VERSION =
  "private-fund-obsidian-v3.1";

export interface ObsidianOutboxEvent {
  readonly eventId: string;
  readonly datasetId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly sourceVersion: string;
  readonly eventType: string;
  readonly payload: Record<string, JsonValue>;
  readonly projectorVersion: string;
  readonly status: ObsidianOutboxStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly lockedAt: string | null;
  readonly leaseToken: string | null;
  readonly finishedAt: string | null;
  readonly result: Record<string, JsonValue> | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ObsidianRegistryEntry {
  readonly datasetId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly sourceVersion: string;
  readonly notePath: string;
  readonly contentHash: string;
  readonly managedHash: string;
  readonly syncStatus: ObsidianRegistryStatus;
  readonly lastSyncedAt: string | null;
  readonly lastError: string | null;
}

export interface EnqueueProjectionInput {
  readonly datasetId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly sourceVersion: string;
  readonly eventType?: string;
  readonly payload?: Record<string, unknown>;
  readonly projectorVersion?: string;
  readonly availableAt?: string;
  readonly maxAttempts?: number;
}

export interface UpsertRegistryInput {
  readonly datasetId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly sourceVersion: string;
  readonly notePath: string;
  readonly contentHash: string;
  readonly managedHash: string;
  readonly syncStatus: ObsidianRegistryStatus;
  readonly lastSyncedAt?: string | null;
  readonly lastError?: string | null;
  readonly replaceOtherSourceVersions?: boolean;
}

export interface CompleteProjectionInput {
  readonly registryEntries: readonly UpsertRegistryInput[];
  readonly result: Record<string, unknown>;
}

export interface ProjectionStatus {
  readonly datasetId: string;
  readonly projectorVersion: string;
  readonly events: Partial<Record<ObsidianOutboxStatus, number>>;
  readonly notes: Partial<Record<ObsidianRegistryStatus, number>>;
}

export interface ObsidianRepositoryOptions {
  readonly clock?: () => Date;
  readonly projectorVersion?: string;
  readonly retryDelaysMs?: readonly number[];
}

const DEFAULT_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;

function textColumn(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new WorkflowStoreError(`Column ${key} is not text`, "corrupt_json");
  }
  return value;
}

function optionalTextColumn(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new WorkflowStoreError(`Column ${key} is not nullable text`, "corrupt_json");
  }
  return value;
}

function integerColumn(row: SqlRow, key: string): number {
  const value = row[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new WorkflowStoreError(
      `Column ${key} is not a non-negative integer`,
      "corrupt_json",
    );
  }
  return value;
}

function validateIso(value: string, field: string): string {
  const normalized = requireText(value, field, 80);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new WorkflowStoreError(
      `${field} must be an ISO timestamp`,
      "invalid_argument",
    );
  }
  return normalized;
}

export class ObsidianRepository {
  readonly #database: DatabaseSync;
  readonly #clock: () => Date;
  readonly #projectorVersion: string;
  readonly #retryDelaysMs: readonly number[];

  public constructor(
    database: DatabaseSync,
    options: ObsidianRepositoryOptions = {},
  ) {
    this.#database = database;
    this.#clock = options.clock ?? (() => new Date());
    this.#projectorVersion = requireText(
      options.projectorVersion ?? DEFAULT_OBSIDIAN_PROJECTOR_VERSION,
      "projectorVersion",
      240,
    );
    const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    if (
      delays.length === 0 ||
      delays.some(
        (delay) =>
          !Number.isSafeInteger(delay) || delay < 0 || delay > 86_400_000,
      )
    ) {
      throw new WorkflowStoreError(
        "retryDelaysMs requires one or more integer delays between 0 and one day",
        "invalid_argument",
      );
    }
    this.#retryDelaysMs = [...delays];
  }

  /**
   * Enqueue in the caller's DatabaseSync transaction. If a transaction is
   * already open, withTransaction uses a savepoint and never commits it.
   */
  public enqueue(input: EnqueueProjectionInput): ObsidianOutboxEvent {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const entityType = requireText(input.entityType, "entityType", 120);
    const entityId = requireText(input.entityId, "entityId", 240);
    const sourceVersion = requireText(
      input.sourceVersion,
      "sourceVersion",
      240,
    );
    const eventType = requireText(input.eventType ?? "upsert", "eventType", 80);
    const projectorVersion = requireText(
      input.projectorVersion ?? this.#projectorVersion,
      "projectorVersion",
      240,
    );
    const payloadJson = encodeJson(input.payload ?? {});
    const maxAttempts = input.maxAttempts ?? 4;
    if (
      !Number.isSafeInteger(maxAttempts) ||
      maxAttempts < 1 ||
      maxAttempts > 100
    ) {
      throw new WorkflowStoreError(
        "maxAttempts must be an integer from 1 to 100",
        "invalid_argument",
      );
    }
    const eventId = stableId(
      "ose",
      datasetId,
      entityType,
      entityId,
      sourceVersion,
      eventType,
      projectorVersion,
    );
    return withTransaction(this.#database, () => {
      const existing = this.#database
        .prepare(
          `SELECT * FROM obsidian_sync_outbox
           WHERE event_id=?
              OR (
                dataset_id=? AND entity_type=? AND entity_id=?
                AND source_version=? AND event_type=? AND projector_version=?
              )
           ORDER BY CASE WHEN event_id=? THEN 0 ELSE 1 END
           LIMIT 1`,
        )
        .get(
          eventId,
          datasetId,
          entityType,
          entityId,
          sourceVersion,
          eventType,
          projectorVersion,
          eventId,
        );
      if (existing !== undefined) {
        const event = this.#mapEvent(toRecord(existing));
        if (
          encodeJson(event.payload) !== payloadJson ||
          event.maxAttempts !== maxAttempts
        ) {
          throw new WorkflowStoreError(
            "The projection identity was reused with a different payload or retry policy",
            "conflict",
          );
        }
        return event;
      }
      const now = this.#now();
      const availableAt =
        input.availableAt === undefined
          ? now
          : validateIso(input.availableAt, "availableAt");
      this.#database
        .prepare(
          `INSERT INTO obsidian_sync_outbox
             (event_id, dataset_id, entity_type, entity_id, source_version,
              event_type, payload_json, projector_version, status,
              attempt_count, max_attempts, available_at, locked_at,
              finished_at, result_json, last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, NULL, NULL,
                   NULL, NULL, ?, ?)`,
        )
        .run(
          eventId,
          datasetId,
          entityType,
          entityId,
          sourceVersion,
          eventType,
          payloadJson,
          projectorVersion,
          maxAttempts,
          availableAt,
          now,
          now,
        );
      return this.getEvent(eventId);
    });
  }

  public reconcileDataset(datasetId: string): number {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    return withTransaction(this.#database, () => {
      const before = integerColumn(
        toRecord(
          this.#database
            .prepare(
              `SELECT COUNT(*) AS count FROM obsidian_sync_outbox
               WHERE dataset_id=? AND projector_version=?`,
            )
            .get(normalizedDatasetId, this.#projectorVersion),
        ),
        "count",
      );
      if (this.#tableExists("research_memo_series")) {
        for (const raw of this.#database
          .prepare(
            `SELECT series_id, current_version_no FROM research_memo_series
             WHERE dataset_id=? AND current_version_no>0`,
          )
          .all(normalizedDatasetId)) {
          const row = toRecord(raw);
          this.enqueue({
            datasetId: normalizedDatasetId,
            entityType: "memo-series",
            entityId: textColumn(row, "series_id"),
            sourceVersion: String(integerColumn(row, "current_version_no")),
          });
        }
      }
      if (this.#tableExists("valuation_model_series")) {
        for (const raw of this.#database
          .prepare(
            `SELECT series_id, current_version_no FROM valuation_model_series
             WHERE dataset_id=? AND current_version_no>0`,
          )
          .all(normalizedDatasetId)) {
          const row = toRecord(raw);
          this.enqueue({
            datasetId: normalizedDatasetId,
            entityType: "valuation-series",
            entityId: textColumn(row, "series_id"),
            sourceVersion: String(integerColumn(row, "current_version_no")),
          });
        }
      }
      if (this.#tableExists("valuation_agent_analyses")) {
        for (const raw of this.#database
          .prepare(
            `SELECT analysis_id, series_id, updated_at
             FROM valuation_agent_analyses
             WHERE dataset_id=? AND status IN ('completed', 'failed')`,
          )
          .all(normalizedDatasetId)) {
          const row = toRecord(raw);
          this.enqueue({
            datasetId: normalizedDatasetId,
            entityType: "valuation-analysis",
            entityId: textColumn(row, "analysis_id"),
            sourceVersion: textColumn(row, "updated_at"),
            payload: { seriesId: textColumn(row, "series_id") },
          });
        }
      }
      if (this.#tableExists("valuation_derived_models")) {
        for (const raw of this.#database
          .prepare(
            `SELECT derived_model_id, series_id, checksum, resource_status,
                    resource_doc_id, resource_error
             FROM valuation_derived_models WHERE dataset_id=?`,
          )
          .all(normalizedDatasetId)) {
          const row = toRecord(raw);
          this.enqueue({
            datasetId: normalizedDatasetId,
            entityType: "valuation-derived",
            entityId: textColumn(row, "derived_model_id"),
            sourceVersion: stableId(
              "projection",
              row.checksum,
              row.resource_status,
              row.resource_doc_id,
              row.resource_error,
            ),
            payload: { seriesId: textColumn(row, "series_id") },
          });
        }
      }
      const after = integerColumn(
        toRecord(
          this.#database
            .prepare(
              `SELECT COUNT(*) AS count FROM obsidian_sync_outbox
               WHERE dataset_id=? AND projector_version=?`,
            )
            .get(normalizedDatasetId, this.#projectorVersion),
        ),
        "count",
      );
      return after - before;
    });
  }

  public getEvent(eventId: string): ObsidianOutboxEvent {
    const id = requireText(eventId, "eventId", 240);
    const row = this.#database
      .prepare("SELECT * FROM obsidian_sync_outbox WHERE event_id=?")
      .get(id);
    if (row === undefined) {
      throw new WorkflowStoreError(
        `Obsidian event ${id} was not found`,
        "not_found",
      );
    }
    return this.#mapEvent(toRecord(row));
  }

  /**
   * Assert ownership of a running outbox delivery.
   *
   * Filesystem projectors use this immediately before an atomic rename.  The
   * final authority check still happens in completeProjection(), which commits
   * every registry mutation and the outbox completion in one fenced SQLite
   * transaction.
   */
  public assertEventLease(
    eventId: string,
    leaseToken: string,
  ): ObsidianOutboxEvent {
    const id = requireText(eventId, "eventId", 240);
    const expectedLeaseToken = requireText(leaseToken, "leaseToken", 240);
    const event = this.getEvent(id);
    if (
      event.status !== "running" ||
      event.leaseToken !== expectedLeaseToken
    ) {
      throw new WorkflowStoreError(
        "The outbox lease is no longer owned by this worker",
        "conflict",
      );
    }
    return event;
  }

  #tableExists(table: string): boolean {
    return (
      this.#database
        .prepare(
          `SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?`,
        )
        .get(table) !== undefined
    );
  }

  public claimNext(input: {
    readonly datasetId: string;
    readonly projectorVersion?: string;
    readonly availableAt?: string;
  }): ObsidianOutboxEvent | null {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const projectorVersion = requireText(
      input.projectorVersion ?? this.#projectorVersion,
      "projectorVersion",
      240,
    );
    const claimTime =
      input.availableAt === undefined
        ? this.#now()
        : validateIso(input.availableAt, "availableAt");
    return withTransaction(this.#database, () => {
      const row = this.#database
        .prepare(
          `SELECT candidate.event_id
           FROM obsidian_sync_outbox AS candidate
           WHERE candidate.dataset_id=?
             AND candidate.projector_version=?
             AND candidate.status='queued'
             AND candidate.available_at<=?
             AND NOT EXISTS (
               SELECT 1 FROM obsidian_sync_outbox AS active
               WHERE active.dataset_id=candidate.dataset_id
                 AND active.entity_type=candidate.entity_type
                 AND active.entity_id=candidate.entity_id
                 AND active.status='running'
             )
           ORDER BY candidate.available_at, candidate.created_at,
                    candidate.event_id
           LIMIT 1`,
        )
        .get(datasetId, projectorVersion, claimTime);
      if (row === undefined) {
        return null;
      }
      const eventId = textColumn(toRecord(row), "event_id");
      const nextAttempt =
        this.getEvent(eventId).attemptCount + 1;
      const leaseToken = stableId(
        "lease",
        eventId,
        nextAttempt,
        claimTime,
      );
      const result = this.#database
        .prepare(
          `UPDATE obsidian_sync_outbox
           SET status='running', attempt_count=attempt_count+1,
               locked_at=?, lease_token=?, updated_at=?
           WHERE event_id=? AND status='queued' AND available_at<=?`,
        )
        .run(claimTime, leaseToken, claimTime, eventId, claimTime);
      if (result.changes !== 1) {
        return null;
      }
      return this.getEvent(eventId);
    });
  }

  public completeEvent(
    eventId: string,
    leaseToken: string,
    result: Record<string, unknown>,
  ): ObsidianOutboxEvent {
    const id = requireText(eventId, "eventId", 240);
    const expectedLeaseToken = requireText(leaseToken, "leaseToken", 240);
    const resultJson = encodeJson(result);
    return withTransaction(this.#database, () => {
      const event = this.getEvent(id);
      if (event.leaseToken !== expectedLeaseToken) {
        throw new WorkflowStoreError(
          "The outbox lease is no longer owned by this worker",
          "conflict",
        );
      }
      if (event.status === "completed") {
        if (encodeJson(event.result ?? {}) !== resultJson) {
          throw new WorkflowStoreError(
            "A completed outbox event cannot be overwritten",
            "conflict",
          );
        }
        return event;
      }
      if (event.status !== "running") {
        throw new WorkflowStoreError(
          `Event cannot complete from ${event.status}`,
          "invalid_state",
        );
      }
      const now = this.#now();
      const update = this.#database
        .prepare(
          `UPDATE obsidian_sync_outbox
           SET status='completed', result_json=?, finished_at=?, locked_at=NULL,
               last_error=NULL, updated_at=?
           WHERE event_id=? AND status='running' AND lease_token=?`,
        )
        .run(resultJson, now, now, id, expectedLeaseToken);
      if (update.changes !== 1) {
        throw new WorkflowStoreError(
          "The outbox lease was lost before completion",
          "conflict",
        );
      }
      return this.getEvent(id);
    });
  }

  /**
   * Atomically publish projection registry state and complete the outbox
   * delivery under the same lease fence.  This prevents a stale filesystem
   * worker from committing registry rows after its lease was recovered.
   */
  public completeProjection(
    eventId: string,
    leaseToken: string,
    input: CompleteProjectionInput,
  ): ObsidianOutboxEvent {
    const id = requireText(eventId, "eventId", 240);
    const expectedLeaseToken = requireText(leaseToken, "leaseToken", 240);
    if (!Array.isArray(input.registryEntries)) {
      throw new WorkflowStoreError(
        "registryEntries must be an array",
        "invalid_argument",
      );
    }
    return withTransaction(this.#database, () => {
      const event = this.getEvent(id);
      if (event.status === "completed") {
        return this.completeEvent(id, expectedLeaseToken, input.result);
      }
      this.assertEventLease(id, expectedLeaseToken);
      for (const entry of input.registryEntries) {
        if (entry.datasetId !== event.datasetId) {
          throw new WorkflowStoreError(
            "Projection registry entries must belong to the outbox dataset",
            "conflict",
          );
        }
        this.upsertRegistry(entry);
      }
      return this.completeEvent(id, expectedLeaseToken, input.result);
    });
  }

  public failEvent(
    eventId: string,
    leaseToken: string,
    error: string,
    options: {
      readonly terminal?: boolean;
      readonly availableAt?: string;
    } = {},
  ): ObsidianOutboxEvent {
    const id = requireText(eventId, "eventId", 240);
    const expectedLeaseToken = requireText(leaseToken, "leaseToken", 240);
    const errorMessage = requireText(error, "error", 20_000);
    return withTransaction(this.#database, () => {
      const event = this.getEvent(id);
      if (event.leaseToken !== expectedLeaseToken) {
        throw new WorkflowStoreError(
          "The outbox lease is no longer owned by this worker",
          "conflict",
        );
      }
      if (event.status !== "running") {
        throw new WorkflowStoreError(
          `Event cannot fail from ${event.status}`,
          "invalid_state",
        );
      }
      const exhausted =
        options.terminal === true ||
        event.attemptCount >= event.maxAttempts;
      const status: ObsidianOutboxStatus = exhausted ? "failed" : "queued";
      const nowDate = this.#clock();
      const now = nowIso(nowDate);
      const availableAt =
        options.availableAt === undefined
          ? exhausted
            ? event.availableAt
            : new Date(
                nowDate.getTime() + this.#retryDelay(event.attemptCount),
              ).toISOString()
          : validateIso(options.availableAt, "availableAt");
      const update = this.#database
        .prepare(
          `UPDATE obsidian_sync_outbox
           SET status=?, available_at=?, locked_at=NULL, lease_token=NULL,
               finished_at=?,
               last_error=?, updated_at=?
           WHERE event_id=? AND status='running' AND lease_token=?`,
        )
        .run(
          status,
          availableAt,
          exhausted ? now : null,
          errorMessage,
          now,
          id,
          expectedLeaseToken,
        );
      if (update.changes !== 1) {
        throw new WorkflowStoreError(
          "The outbox lease was lost before failure handling completed",
          "conflict",
        );
      }
      return this.getEvent(id);
    });
  }

  public recoverStaleEvents(input: {
    readonly datasetId: string;
    readonly staleBefore: string;
    readonly availableAt?: string;
  }): number {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const staleBefore = validateIso(input.staleBefore, "staleBefore");
    const availableAt =
      input.availableAt === undefined
        ? this.#now()
        : validateIso(input.availableAt, "availableAt");
    return withTransaction(this.#database, () => {
      const rows = this.#database
        .prepare(
          `SELECT event_id, attempt_count, max_attempts
           FROM obsidian_sync_outbox
           WHERE dataset_id=? AND status='running' AND locked_at<?`,
        )
        .all(datasetId, staleBefore);
      const now = this.#now();
      const update = this.#database.prepare(
        `UPDATE obsidian_sync_outbox
         SET status=?, locked_at=NULL, available_at=?, finished_at=?,
             lease_token=NULL,
             last_error=COALESCE(last_error, 'worker lease expired'),
             updated_at=?
         WHERE event_id=? AND status='running'`,
      );
      let recovered = 0;
      for (const row of rows) {
        const record = toRecord(row);
        const exhausted =
          integerColumn(record, "attempt_count") >=
          integerColumn(record, "max_attempts");
        const result = update.run(
          exhausted ? "failed" : "queued",
          availableAt,
          exhausted ? now : null,
          now,
          textColumn(record, "event_id"),
        );
        recovered += Number(result.changes);
      }
      return recovered;
    });
  }

  public listEvents(
    options: PageOptions & {
      readonly datasetId?: string;
      readonly status?: ObsidianOutboxStatus;
      readonly entityType?: string;
      readonly projectorVersion?: string;
    } = {},
  ): Page<ObsidianOutboxEvent> {
    const page = pageOptions(options);
    const predicates: string[] = [];
    const parameters: (number | string)[] = [];
    if (options.datasetId !== undefined) {
      predicates.push("dataset_id=?");
      parameters.push(requireText(options.datasetId, "datasetId", 240));
    }
    if (options.status !== undefined) {
      assertOneOf(options.status, OBSIDIAN_OUTBOX_STATUSES, "status");
      predicates.push("status=?");
      parameters.push(options.status);
    }
    if (options.entityType !== undefined) {
      predicates.push("entity_type=?");
      parameters.push(requireText(options.entityType, "entityType", 120));
    }
    if (options.projectorVersion !== undefined) {
      predicates.push("projector_version=?");
      parameters.push(
        requireText(options.projectorVersion, "projectorVersion", 240),
      );
    }
    const where =
      predicates.length === 0 ? "" : `WHERE ${predicates.join(" AND ")}`;
    const count = toRecord(
      this.#database
        .prepare(`SELECT COUNT(*) AS count FROM obsidian_sync_outbox ${where}`)
        .get(...parameters),
    );
    const rows = this.#database
      .prepare(
        `SELECT * FROM obsidian_sync_outbox ${where}
         ORDER BY created_at DESC, event_id LIMIT ? OFFSET ?`,
      )
      .all(...parameters, page.limit, page.offset);
    return pageResult(
      rows.map((row) => this.#mapEvent(toRecord(row))),
      integerColumn(count, "count"),
      page,
    );
  }

  public upsertRegistry(input: UpsertRegistryInput): ObsidianRegistryEntry {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const entityType = requireText(input.entityType, "entityType", 120);
    const entityId = requireText(input.entityId, "entityId", 240);
    const sourceVersion = requireText(
      input.sourceVersion,
      "sourceVersion",
      240,
    );
    const notePath = this.#normalizeNotePath(input.notePath);
    const contentHash = requireText(input.contentHash, "contentHash", 240);
    const managedHash = requireText(input.managedHash, "managedHash", 240);
    assertOneOf(input.syncStatus, OBSIDIAN_REGISTRY_STATUSES, "syncStatus");
    return withTransaction(this.#database, () => {
      const pathOwner = this.#database
        .prepare(
          `SELECT dataset_id, entity_type, entity_id, source_version
           FROM obsidian_note_registry WHERE note_path=?`,
        )
        .get(notePath);
      if (pathOwner !== undefined) {
        const owner = toRecord(pathOwner);
        const sameEntity =
          textColumn(owner, "dataset_id") === datasetId &&
          textColumn(owner, "entity_type") === entityType &&
          textColumn(owner, "entity_id") === entityId;
        const sameSourceVersion =
          textColumn(owner, "source_version") === sourceVersion;
        if (
          !sameEntity ||
          (!sameSourceVersion && !(input.replaceOtherSourceVersions ?? true))
        ) {
          throw new WorkflowStoreError(
            `Note path ${notePath} is registered to another source`,
            "conflict",
          );
        }
      }
      if (input.replaceOtherSourceVersions ?? true) {
        this.#database
          .prepare(
            `DELETE FROM obsidian_note_registry
             WHERE dataset_id=? AND entity_type=? AND entity_id=?
               AND source_version<>?`,
          )
          .run(datasetId, entityType, entityId, sourceVersion);
      }
      const lastSyncedAt =
        input.lastSyncedAt === undefined
          ? this.#now()
          : input.lastSyncedAt === null
            ? null
            : validateIso(input.lastSyncedAt, "lastSyncedAt");
      const lastError =
        input.lastError === undefined || input.lastError === null
          ? null
          : requireText(input.lastError, "lastError", 20_000);
      this.#database
        .prepare(
          `INSERT INTO obsidian_note_registry
             (dataset_id, entity_type, entity_id, source_version, note_path,
              content_hash, managed_hash, sync_status, last_synced_at, last_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(dataset_id, entity_type, entity_id, source_version)
           DO UPDATE SET
             note_path=excluded.note_path,
             content_hash=excluded.content_hash,
             managed_hash=excluded.managed_hash,
             sync_status=excluded.sync_status,
             last_synced_at=excluded.last_synced_at,
             last_error=excluded.last_error`,
        )
        .run(
          datasetId,
          entityType,
          entityId,
          sourceVersion,
          notePath,
          contentHash,
          managedHash,
          input.syncStatus,
          lastSyncedAt,
          lastError,
        );
      return this.getRegistryEntry({
        datasetId,
        entityType,
        entityId,
        sourceVersion,
      });
    });
  }

  public getRegistryEntry(input: {
    readonly datasetId: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly sourceVersion: string;
  }): ObsidianRegistryEntry {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const entityType = requireText(input.entityType, "entityType", 120);
    const entityId = requireText(input.entityId, "entityId", 240);
    const sourceVersion = requireText(
      input.sourceVersion,
      "sourceVersion",
      240,
    );
    const row = this.#database
      .prepare(
        `SELECT * FROM obsidian_note_registry
         WHERE dataset_id=? AND entity_type=? AND entity_id=? AND source_version=?`,
      )
      .get(datasetId, entityType, entityId, sourceVersion);
    if (row === undefined) {
      throw new WorkflowStoreError(
        "Obsidian registry entry was not found",
        "not_found",
      );
    }
    return this.#mapRegistry(toRecord(row));
  }

  public findRegistryByPath(notePath: string): ObsidianRegistryEntry | null {
    const path = this.#normalizeNotePath(notePath);
    const row = this.#database
      .prepare("SELECT * FROM obsidian_note_registry WHERE note_path=?")
      .get(path);
    return row === undefined ? null : this.#mapRegistry(toRecord(row));
  }

  public listRegistry(
    options: PageOptions & {
      readonly datasetId?: string;
      readonly entityType?: string;
      readonly entityId?: string;
      readonly syncStatus?: ObsidianRegistryStatus;
    } = {},
  ): Page<ObsidianRegistryEntry> {
    const page = pageOptions(options);
    const predicates: string[] = [];
    const parameters: (number | string)[] = [];
    if (options.datasetId !== undefined) {
      predicates.push("dataset_id=?");
      parameters.push(requireText(options.datasetId, "datasetId", 240));
    }
    if (options.entityType !== undefined) {
      predicates.push("entity_type=?");
      parameters.push(requireText(options.entityType, "entityType", 120));
    }
    if (options.entityId !== undefined) {
      predicates.push("entity_id=?");
      parameters.push(requireText(options.entityId, "entityId", 240));
    }
    if (options.syncStatus !== undefined) {
      assertOneOf(
        options.syncStatus,
        OBSIDIAN_REGISTRY_STATUSES,
        "syncStatus",
      );
      predicates.push("sync_status=?");
      parameters.push(options.syncStatus);
    }
    const where =
      predicates.length === 0 ? "" : `WHERE ${predicates.join(" AND ")}`;
    const count = toRecord(
      this.#database
        .prepare(`SELECT COUNT(*) AS count FROM obsidian_note_registry ${where}`)
        .get(...parameters),
    );
    const rows = this.#database
      .prepare(
        `SELECT * FROM obsidian_note_registry ${where}
         ORDER BY dataset_id, entity_type, entity_id, source_version
         LIMIT ? OFFSET ?`,
      )
      .all(...parameters, page.limit, page.offset);
    return pageResult(
      rows.map((row) => this.#mapRegistry(toRecord(row))),
      integerColumn(count, "count"),
      page,
    );
  }

  public deleteRegistryEntry(input: {
    readonly datasetId: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly sourceVersion: string;
  }): boolean {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const entityType = requireText(input.entityType, "entityType", 120);
    const entityId = requireText(input.entityId, "entityId", 240);
    const sourceVersion = requireText(
      input.sourceVersion,
      "sourceVersion",
      240,
    );
    return withTransaction(this.#database, () => {
      const result = this.#database
        .prepare(
          `DELETE FROM obsidian_note_registry
           WHERE dataset_id=? AND entity_type=? AND entity_id=? AND source_version=?`,
        )
        .run(datasetId, entityType, entityId, sourceVersion);
      return result.changes > 0;
    });
  }

  public projectionStatus(
    datasetId: string,
    projectorVersion = this.#projectorVersion,
  ): ProjectionStatus {
    const dataset = requireText(datasetId, "datasetId", 240);
    const projector = requireText(
      projectorVersion,
      "projectorVersion",
      240,
    );
    const eventRows = this.#database
      .prepare(
        `SELECT status, COUNT(*) AS count FROM obsidian_sync_outbox
         WHERE dataset_id=? AND projector_version=? GROUP BY status`,
      )
      .all(dataset, projector);
    const registryRows = this.#database
      .prepare(
        `SELECT sync_status, COUNT(*) AS count FROM obsidian_note_registry
         WHERE dataset_id=? GROUP BY sync_status`,
      )
      .all(dataset);
    const events: Partial<Record<ObsidianOutboxStatus, number>> = {};
    for (const row of eventRows) {
      const record = toRecord(row);
      const status = textColumn(record, "status");
      assertOneOf(status, OBSIDIAN_OUTBOX_STATUSES, "stored outbox status");
      events[status] = integerColumn(record, "count");
    }
    const notes: Partial<Record<ObsidianRegistryStatus, number>> = {};
    for (const row of registryRows) {
      const record = toRecord(row);
      const status = textColumn(record, "sync_status");
      assertOneOf(status, OBSIDIAN_REGISTRY_STATUSES, "stored registry status");
      notes[status] = integerColumn(record, "count");
    }
    return {
      datasetId: dataset,
      projectorVersion: projector,
      events,
      notes,
    };
  }

  #now(): string {
    return nowIso(this.#clock());
  }

  #retryDelay(attemptCount: number): number {
    const index = Math.min(
      Math.max(0, attemptCount - 1),
      this.#retryDelaysMs.length - 1,
    );
    const delay = this.#retryDelaysMs[index];
    if (delay === undefined) {
      throw new WorkflowStoreError(
        "Retry schedule is empty",
        "invalid_state",
      );
    }
    return delay;
  }

  #mapEvent(row: SqlRow): ObsidianOutboxEvent {
    const status = textColumn(row, "status");
    assertOneOf(status, OBSIDIAN_OUTBOX_STATUSES, "stored outbox status");
    const resultJson = optionalTextColumn(row, "result_json");
    return {
      eventId: textColumn(row, "event_id"),
      datasetId: textColumn(row, "dataset_id"),
      entityType: textColumn(row, "entity_type"),
      entityId: textColumn(row, "entity_id"),
      sourceVersion: textColumn(row, "source_version"),
      eventType: textColumn(row, "event_type"),
      payload: decodeJsonObject(textColumn(row, "payload_json")),
      projectorVersion: textColumn(row, "projector_version"),
      status,
      attemptCount: integerColumn(row, "attempt_count"),
      maxAttempts: integerColumn(row, "max_attempts"),
      availableAt: textColumn(row, "available_at"),
      lockedAt: optionalTextColumn(row, "locked_at"),
      leaseToken: optionalTextColumn(row, "lease_token"),
      finishedAt: optionalTextColumn(row, "finished_at"),
      result: resultJson === null ? null : decodeJsonObject(resultJson),
      lastError: optionalTextColumn(row, "last_error"),
      createdAt: textColumn(row, "created_at"),
      updatedAt: textColumn(row, "updated_at"),
    };
  }

  #mapRegistry(row: SqlRow): ObsidianRegistryEntry {
    const syncStatus = textColumn(row, "sync_status");
    assertOneOf(
      syncStatus,
      OBSIDIAN_REGISTRY_STATUSES,
      "stored registry status",
    );
    return {
      datasetId: textColumn(row, "dataset_id"),
      entityType: textColumn(row, "entity_type"),
      entityId: textColumn(row, "entity_id"),
      sourceVersion: textColumn(row, "source_version"),
      notePath: textColumn(row, "note_path"),
      contentHash: textColumn(row, "content_hash"),
      managedHash: textColumn(row, "managed_hash"),
      syncStatus,
      lastSyncedAt: optionalTextColumn(row, "last_synced_at"),
      lastError: optionalTextColumn(row, "last_error"),
    };
  }

  #normalizeNotePath(value: string): string {
    const path = requireText(value, "notePath", 1_000).replaceAll("\\", "/");
    if (
      path.startsWith("/") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new WorkflowStoreError(
        "notePath must be a safe vault-relative path",
        "invalid_argument",
      );
    }
    return path;
  }
}
