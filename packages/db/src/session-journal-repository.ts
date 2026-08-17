import type { DatabaseSync } from "node:sqlite";

import {
  appendSessionJournalEventSchema,
  sessionJournalEventSchema,
  type AppendSessionJournalEvent,
  type SessionJournalEvent,
} from "@private-fund/contracts";
import type { Clock } from "@private-fund/core";
import {
  ConflictError,
  NotFoundError,
  canonicalJsonSha256,
  isoNow,
  newId,
  systemClock,
} from "@private-fund/core";

import { encodeJson } from "./json.js";
import type { SqlRow } from "./rows.js";
import {
  rowJson,
  rowJsonObject,
  rowNullableString,
  rowNumber,
  rowString,
} from "./rows.js";
import { withTransaction } from "./transaction.js";
import type {
  AppendSessionJournalEventInput,
  AppendSessionJournalEventResult,
  SessionJournalIntegrityReport,
  SessionJournalOutboxRecord,
} from "./types.js";

const JOURNAL_EVENT_COLUMNS = `
  session_id AS sessionId,
  sequence,
  event_id AS eventId,
  schema_version AS schemaVersion,
  type,
  timestamp,
  operation_id AS operationId,
  turn_id AS turnId,
  step_id AS stepId,
  source_kind AS sourceKind,
  source_id AS sourceId,
  source_version AS sourceVersion,
  causation_event_id AS causationEventId,
  idempotency_key AS idempotencyKey,
  classification,
  payload_json AS payloadJson,
  blob_references_json AS blobReferencesJson,
  payload_hash AS payloadHash,
  request_hash AS requestHash,
  previous_hash AS previousHash,
  event_hash AS eventHash
`;

const OUTBOX_COLUMNS = `
  o.outbox_id AS outboxId,
  u.data_namespace AS tenantNamespace,
  o.session_id AS sessionId,
  o.sequence,
  o.event_id AS eventId,
  o.created_at AS createdAt,
  o.delivered_at AS deliveredAt,
  o.attempt_count AS attemptCount,
  o.last_error AS lastError
`;

function mapJournalEvent(row: SqlRow): SessionJournalEvent {
  return sessionJournalEventSchema.parse({
    sessionId: rowString(row, "sessionId"),
    sequence: rowNumber(row, "sequence"),
    eventId: rowString(row, "eventId"),
    schemaVersion: rowNumber(row, "schemaVersion"),
    type: rowString(row, "type"),
    timestamp: rowString(row, "timestamp"),
    operationId: rowNullableString(row, "operationId"),
    turnId: rowNullableString(row, "turnId"),
    stepId: rowNullableString(row, "stepId"),
    source: {
      kind: rowString(row, "sourceKind"),
      id: rowNullableString(row, "sourceId"),
      version: rowNullableString(row, "sourceVersion"),
    },
    causationEventId: rowNullableString(row, "causationEventId"),
    idempotencyKey: rowString(row, "idempotencyKey"),
    classification: rowString(row, "classification"),
    payload: rowJsonObject(row, "payloadJson"),
    blobReferences: rowJson(row, "blobReferencesJson"),
    payloadHash: rowString(row, "payloadHash"),
    requestHash: rowString(row, "requestHash"),
    previousHash: rowNullableString(row, "previousHash"),
    eventHash: rowString(row, "eventHash"),
  });
}

function mapOutbox(row: SqlRow): SessionJournalOutboxRecord {
  return {
    outboxId: rowNumber(row, "outboxId"),
    tenantNamespace: rowString(row, "tenantNamespace"),
    sessionId: rowString(row, "sessionId"),
    sequence: rowNumber(row, "sequence"),
    eventId: rowString(row, "eventId"),
    createdAt: rowString(row, "createdAt"),
    deliveredAt: rowNullableString(row, "deliveredAt"),
    attemptCount: rowNumber(row, "attemptCount"),
    lastError: rowNullableString(row, "lastError"),
  };
}

function semanticRequest(
  input: AppendSessionJournalEvent,
  payloadHash: string,
): Record<string, unknown> {
  return {
    schemaVersion: input.schemaVersion,
    type: input.type,
    operationId: input.operationId,
    turnId: input.turnId,
    stepId: input.stepId,
    source: input.source,
    causationEventId: input.causationEventId,
    classification: input.classification,
    payloadHash,
    blobReferences: input.blobReferences,
  };
}

export function computeSessionJournalRequestHash(
  input: AppendSessionJournalEvent,
  payloadHash = canonicalJsonSha256(input.payload),
): string {
  return canonicalJsonSha256(semanticRequest(input, payloadHash));
}

export function computeSessionJournalEventHash(
  event: Omit<SessionJournalEvent, "eventHash">,
): string {
  return canonicalJsonSha256(event);
}

export class SessionJournalRepository {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {}

  public appendForTenant(
    tenantNamespace: string,
    rawInput: AppendSessionJournalEventInput,
  ): AppendSessionJournalEventResult {
    const input = appendSessionJournalEventSchema.parse(rawInput);
    const payloadHash = canonicalJsonSha256(input.payload);
    const requestHash = computeSessionJournalRequestHash(input, payloadHash);

    return withTransaction(this.database, () => {
      this.requireSession(tenantNamespace, input.sessionId);

      const existing = this.database
        .prepare(
          `SELECT ${JOURNAL_EVENT_COLUMNS}
           FROM session_journal_events
           WHERE session_id = ? AND idempotency_key = ?`,
        )
        .get(input.sessionId, input.idempotencyKey);
      if (existing !== undefined) {
        const event = mapJournalEvent(existing);
        if (event.requestHash !== requestHash) {
          throw new ConflictError(
            "Session Journal idempotency key was reused with different content",
            "journal_idempotency_conflict",
          );
        }
        return { event, created: false };
      }

      if (input.operationId !== null) {
        const operation = this.database
          .prepare(
            `SELECT 1 FROM operations
             WHERE id = ? AND session_id = ?`,
          )
          .get(input.operationId, input.sessionId);
        if (operation === undefined) {
          throw new ConflictError(
            "Journal operation does not belong to the Session",
            "journal_operation_mismatch",
          );
        }
      }

      if (input.causationEventId !== null) {
        const cause = this.database
          .prepare(
            `SELECT 1 FROM session_journal_events
             WHERE session_id = ? AND event_id = ?`,
          )
          .get(input.sessionId, input.causationEventId);
        if (cause === undefined) {
          throw new ConflictError(
            "Journal causation event does not exist in the Session",
            "journal_causation_missing",
          );
        }
      }

      const timestamp = input.timestamp ?? isoNow(this.clock);
      this.database
        .prepare(
          `INSERT OR IGNORE INTO session_journal_heads(
             session_id, last_sequence, last_event_hash, updated_at
           ) VALUES (?, 0, NULL, ?)`,
        )
        .run(input.sessionId, timestamp);
      const head = this.database
        .prepare(
          `SELECT last_sequence AS lastSequence,
                  last_event_hash AS lastEventHash
           FROM session_journal_heads
           WHERE session_id = ?`,
        )
        .get(input.sessionId);
      if (head === undefined) {
        throw new Error("Session Journal head disappeared");
      }

      const sequence = Number(head.lastSequence) + 1;
      const previousHash =
        head.lastEventHash === null ? null : String(head.lastEventHash);
      const eventId = input.eventId ?? newId("event");
      const duplicateEventId = this.database
        .prepare(
          `SELECT 1 FROM session_journal_events
           WHERE session_id = ? AND event_id = ?`,
        )
        .get(input.sessionId, eventId);
      if (duplicateEventId !== undefined) {
        throw new ConflictError(
          "Session Journal event ID already exists",
          "journal_event_id_conflict",
        );
      }

      const eventWithoutHash: Omit<SessionJournalEvent, "eventHash"> = {
        eventId,
        sessionId: input.sessionId,
        sequence,
        schemaVersion: input.schemaVersion,
        type: input.type,
        timestamp,
        operationId: input.operationId,
        turnId: input.turnId,
        stepId: input.stepId,
        source: input.source,
        causationEventId: input.causationEventId,
        idempotencyKey: input.idempotencyKey,
        classification: input.classification,
        payload: input.payload,
        blobReferences: input.blobReferences,
        payloadHash,
        requestHash,
        previousHash,
      };
      const event = sessionJournalEventSchema.parse({
        ...eventWithoutHash,
        eventHash: computeSessionJournalEventHash(eventWithoutHash),
      });

      this.database
        .prepare(
          `INSERT INTO session_journal_events(
             session_id, sequence, event_id, schema_version, type, timestamp,
             operation_id, turn_id, step_id, source_kind, source_id,
             source_version, causation_event_id, idempotency_key,
             classification, payload_json, blob_references_json, payload_hash,
             request_hash, previous_hash, event_hash
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.sessionId,
          event.sequence,
          event.eventId,
          event.schemaVersion,
          event.type,
          event.timestamp,
          event.operationId,
          event.turnId,
          event.stepId,
          event.source.kind,
          event.source.id,
          event.source.version,
          event.causationEventId,
          event.idempotencyKey,
          event.classification,
          encodeJson(event.payload),
          encodeJson(event.blobReferences),
          event.payloadHash,
          event.requestHash,
          event.previousHash,
          event.eventHash,
        );
      this.database
        .prepare(
          `INSERT INTO session_journal_outbox(
             session_id, sequence, event_id, created_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(event.sessionId, event.sequence, event.eventId, event.timestamp);

      const stored = this.database
        .prepare(
          `SELECT ${JOURNAL_EVENT_COLUMNS}
           FROM session_journal_events
           WHERE session_id = ? AND sequence = ?`,
        )
        .get(event.sessionId, event.sequence);
      if (stored === undefined) {
        throw new Error("Appended Session Journal event disappeared");
      }
      return { event: mapJournalEvent(stored), created: true };
    });
  }

  public replayForTenant(
    tenantNamespace: string,
    sessionId: string,
    afterSequence = 0,
    limit = 1_000,
  ): SessionJournalEvent[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RangeError("afterSequence must be a non-negative integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
      throw new RangeError("limit must contain between 1 and 5000 events");
    }
    this.requireSession(tenantNamespace, sessionId);
    return this.database
      .prepare(
        `SELECT ${JOURNAL_EVENT_COLUMNS}
         FROM session_journal_events
         WHERE session_id = ? AND sequence > ?
         ORDER BY sequence
         LIMIT ?`,
      )
      .all(sessionId, afterSequence, limit)
      .map(mapJournalEvent);
  }

  public listPendingOutbox(limit = 100): SessionJournalOutboxRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("limit must contain between 1 and 1000 records");
    }
    return this.database
      .prepare(
        `SELECT ${OUTBOX_COLUMNS}
         FROM session_journal_outbox AS o
         JOIN sessions AS s ON s.id = o.session_id
         JOIN users AS u ON u.id = s.user_id
         WHERE o.delivered_at IS NULL
         ORDER BY o.outbox_id
         LIMIT ?`,
      )
      .all(limit)
      .map(mapOutbox);
  }

  public markOutboxDelivered(outboxId: number): boolean {
    if (!Number.isSafeInteger(outboxId) || outboxId < 1) {
      throw new RangeError("outboxId must be a positive integer");
    }
    const timestamp = isoNow(this.clock);
    const result = this.database
      .prepare(
        `UPDATE session_journal_outbox
         SET delivered_at = ?, last_error = NULL
         WHERE outbox_id = ? AND delivered_at IS NULL`,
      )
      .run(timestamp, outboxId);
    return result.changes === 1;
  }

  public recordOutboxFailure(outboxId: number, error: string): boolean {
    if (!Number.isSafeInteger(outboxId) || outboxId < 1) {
      throw new RangeError("outboxId must be a positive integer");
    }
    const result = this.database
      .prepare(
        `UPDATE session_journal_outbox
         SET attempt_count = attempt_count + 1,
             last_error = ?
         WHERE outbox_id = ? AND delivered_at IS NULL`,
      )
      .run(error.slice(0, 4_000), outboxId);
    return result.changes === 1;
  }

  public verifyIntegrityForTenant(
    tenantNamespace: string,
    sessionId: string,
  ): SessionJournalIntegrityReport {
    this.requireSession(tenantNamespace, sessionId);
    const rows = this.database
      .prepare(
        `SELECT ${JOURNAL_EVENT_COLUMNS}
         FROM session_journal_events
         WHERE session_id = ?
         ORDER BY sequence`,
      )
      .all(sessionId);

    let previousHash: string | null = null;
    let expectedSequence = 1;
    for (const row of rows) {
      const event = mapJournalEvent(row);
      if (event.sequence !== expectedSequence) {
        return {
          valid: false,
          eventCount: rows.length,
          checkedThroughSequence: expectedSequence - 1,
          lastEventHash: previousHash,
          issue: `sequence_gap:${String(expectedSequence)}:${String(event.sequence)}`,
        };
      }
      if (event.previousHash !== previousHash) {
        return {
          valid: false,
          eventCount: rows.length,
          checkedThroughSequence: expectedSequence - 1,
          lastEventHash: previousHash,
          issue: `previous_hash_mismatch:${String(event.sequence)}`,
        };
      }
      if (canonicalJsonSha256(event.payload) !== event.payloadHash) {
        return {
          valid: false,
          eventCount: rows.length,
          checkedThroughSequence: expectedSequence - 1,
          lastEventHash: previousHash,
          issue: `payload_hash_mismatch:${String(event.sequence)}`,
        };
      }
      const appendInput = appendSessionJournalEventSchema.parse({
        sessionId: event.sessionId,
        schemaVersion: event.schemaVersion,
        eventId: event.eventId,
        timestamp: event.timestamp,
        type: event.type,
        operationId: event.operationId,
        turnId: event.turnId,
        stepId: event.stepId,
        source: event.source,
        causationEventId: event.causationEventId,
        idempotencyKey: event.idempotencyKey,
        classification: event.classification,
        payload: event.payload,
        blobReferences: event.blobReferences,
      });
      if (
        computeSessionJournalRequestHash(appendInput, event.payloadHash) !==
        event.requestHash
      ) {
        return {
          valid: false,
          eventCount: rows.length,
          checkedThroughSequence: expectedSequence - 1,
          lastEventHash: previousHash,
          issue: `request_hash_mismatch:${String(event.sequence)}`,
        };
      }
      const { eventHash: _eventHash, ...withoutHash } = event;
      if (computeSessionJournalEventHash(withoutHash) !== event.eventHash) {
        return {
          valid: false,
          eventCount: rows.length,
          checkedThroughSequence: expectedSequence - 1,
          lastEventHash: previousHash,
          issue: `event_hash_mismatch:${String(event.sequence)}`,
        };
      }
      previousHash = event.eventHash;
      expectedSequence += 1;
    }

    const head = this.database
      .prepare(
        `SELECT last_sequence AS lastSequence,
                last_event_hash AS lastEventHash
         FROM session_journal_heads
         WHERE session_id = ?`,
      )
      .get(sessionId);
    if (
      head !== undefined &&
      (Number(head.lastSequence) !== rows.length ||
        (head.lastEventHash === null ? null : String(head.lastEventHash)) !==
          previousHash)
    ) {
      return {
        valid: false,
        eventCount: rows.length,
        checkedThroughSequence: expectedSequence - 1,
        lastEventHash: previousHash,
        issue: "head_mismatch",
      };
    }
    return {
      valid: true,
      eventCount: rows.length,
      checkedThroughSequence: expectedSequence - 1,
      lastEventHash: previousHash,
      issue: null,
    };
  }

  private requireSession(tenantNamespace: string, sessionId: string): void {
    const session = this.database
      .prepare(
        `SELECT 1
         FROM sessions AS s
         JOIN users AS u ON u.id = s.user_id
         JOIN projects AS p
           ON p.id = s.project_id AND p.user_id = s.user_id
         WHERE s.id = ? AND u.data_namespace = ?
           AND s.deleted_at IS NULL
           AND p.deleted_at IS NULL`,
      )
      .get(sessionId, tenantNamespace);
    if (session === undefined) {
      throw new NotFoundError("Session");
    }
  }
}
