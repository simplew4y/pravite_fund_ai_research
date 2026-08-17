import type { DatabaseSync } from "node:sqlite";

import {
  sessionEventSchema,
  type SessionEvent,
} from "@private-fund/contracts";
import type { Clock } from "@private-fund/core";
import {
  NotFoundError,
  isoNow,
  systemClock,
} from "@private-fund/core";

import { encodeJson } from "./json.js";
import type { SqlRow } from "./rows.js";
import {
  rowNullableString,
  rowNumber,
  rowString,
  rowJsonObject,
} from "./rows.js";
import { withTransaction } from "./transaction.js";
import type { AppendSessionEventInput } from "./types.js";

function mapEvent(row: SqlRow): SessionEvent {
  return sessionEventSchema.parse({
    sessionId: rowString(row, "sessionId"),
    sequence: rowNumber(row, "sequence"),
    type: rowString(row, "type"),
    timestamp: rowString(row, "timestamp"),
    operationId: rowNullableString(row, "operationId"),
    payload: rowJsonObject(row, "payloadJson"),
  });
}

const EVENT_COLUMNS = `
  session_id AS sessionId,
  sequence,
  type,
  timestamp,
  operation_id AS operationId,
  payload_json AS payloadJson
`;

export class SessionEventsRepository {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {}

  public appendForTenant(
    tenantNamespace: string,
    input: AppendSessionEventInput,
  ): SessionEvent {
    return withTransaction(this.database, () => {
      const session = this.database
        .prepare(
          `SELECT s.last_sequence AS lastSequence
           FROM sessions AS s
           JOIN users AS u ON u.id = s.user_id
           WHERE s.id = ? AND u.data_namespace = ?`,
        )
        .get(input.sessionId, tenantNamespace);
      if (session === undefined) {
        throw new NotFoundError("Session");
      }
      const sequence = Number(session.lastSequence) + 1;
      const timestamp = input.timestamp ?? isoNow(this.clock);
      const event = sessionEventSchema.parse({
        sessionId: input.sessionId,
        sequence,
        type: input.type,
        timestamp,
        operationId: input.operationId ?? null,
        payload: input.payload,
      });
      this.database
        .prepare(
          `INSERT INTO session_events(
             session_id, sequence, type, timestamp, operation_id, payload_json
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.sessionId,
          sequence,
          event.type,
          timestamp,
          event.operationId,
          encodeJson(event.payload),
        );

      const row = this.database
        .prepare(
          `SELECT ${EVENT_COLUMNS}
           FROM session_events
           WHERE session_id = ? AND sequence = ?`,
        )
        .get(input.sessionId, sequence);
      if (row === undefined) {
        throw new Error("Appended session event disappeared");
      }
      return mapEvent(row);
    });
  }

  public replayForTenant(
    tenantNamespace: string,
    sessionId: string,
    afterSequence = 0,
    limit = 1_000,
  ): SessionEvent[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RangeError("afterSequence must be a non-negative integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
      throw new RangeError("limit must contain between 1 and 5000 events");
    }

    const session = this.database
      .prepare(
        `SELECT 1
         FROM sessions AS s
         JOIN users AS u ON u.id = s.user_id
         WHERE s.id = ? AND u.data_namespace = ?`,
      )
      .get(sessionId, tenantNamespace);
    if (session === undefined) {
      throw new NotFoundError("Session");
    }

    return this.database
      .prepare(
        `SELECT ${EVENT_COLUMNS}
         FROM session_events
         WHERE session_id = ? AND sequence > ?
         ORDER BY sequence
         LIMIT ?`,
      )
      .all(sessionId, afterSequence, limit)
      .map(mapEvent);
  }
}

export function formatSessionEventAsSse(event: SessionEvent): string {
  return [
    `id: ${String(event.sequence)}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    "",
    "",
  ].join("\n");
}
