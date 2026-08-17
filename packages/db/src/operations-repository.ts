import type { DatabaseSync } from "node:sqlite";

import { identifierSchema } from "@private-fund/contracts";
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
  rowString,
} from "./rows.js";
import type {
  CreateOperationResult,
  OperationRecord,
  OperationStatus,
} from "./types.js";

export interface CreateOperationInput {
  readonly id?: string;
  readonly sessionId: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly request?: Record<string, unknown>;
}

const OPERATION_COLUMNS = `
  o.id,
  o.session_id AS sessionId,
  o.kind,
  o.status,
  o.idempotency_key AS idempotencyKey,
  o.request_json AS requestJson,
  o.result_json AS resultJson,
  o.error,
  o.created_at AS createdAt,
  o.started_at AS startedAt,
  o.completed_at AS completedAt,
  o.updated_at AS updatedAt
`;

function mapOperation(row: SqlRow): OperationRecord {
  const resultJson = rowNullableString(row, "resultJson");
  return {
    id: rowString(row, "id"),
    sessionId: rowString(row, "sessionId"),
    kind: rowString(row, "kind"),
    status: rowString(row, "status") as OperationStatus,
    idempotencyKey: rowString(row, "idempotencyKey"),
    request: decodeJsonObject(rowString(row, "requestJson")),
    result: resultJson === null ? null : decodeJson(resultJson),
    error: rowNullableString(row, "error"),
    createdAt: rowString(row, "createdAt"),
    startedAt: rowNullableString(row, "startedAt"),
    completedAt: rowNullableString(row, "completedAt"),
    updatedAt: rowString(row, "updatedAt"),
  };
}

export class OperationsRepository {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {}

  public createForTenant(
    tenantNamespace: string,
    input: CreateOperationInput,
  ): CreateOperationResult {
    const id = input.id ?? newId("operation");
    identifierSchema.parse(id);
    identifierSchema.parse(input.sessionId);
    if (input.kind.length < 1 || input.kind.length > 160) {
      throw new RangeError("Operation kind must contain between 1 and 160 characters");
    }
    if (
      input.idempotencyKey.length < 1 ||
      input.idempotencyKey.length > 500
    ) {
      throw new RangeError(
        "idempotencyKey must contain between 1 and 500 characters",
      );
    }
    const request = input.request ?? {};
    if (
      request === null ||
      Array.isArray(request) ||
      typeof request !== "object"
    ) {
      throw new DomainError(
        "Operation request must be a JSON object",
        "invalid_operation_request",
      );
    }
    const session = this.database
      .prepare(
        `SELECT 1
         FROM sessions AS s
         JOIN users AS u ON u.id = s.user_id
         WHERE s.id = ? AND u.data_namespace = ?`,
      )
      .get(input.sessionId, tenantNamespace);
    if (session === undefined) {
      throw new NotFoundError("Session");
    }

    const requestJson = encodeJson(request);
    const now = isoNow(this.clock);
    const result = this.database
      .prepare(
        `INSERT INTO operations(
           id, session_id, kind, status, idempotency_key,
           request_json, result_json, error,
           created_at, started_at, completed_at, updated_at
         ) VALUES (?, ?, ?, 'queued', ?, ?, NULL, NULL, ?, NULL, NULL, ?)
         ON CONFLICT(session_id, idempotency_key) DO NOTHING`,
      )
      .run(
        id,
        input.sessionId,
        input.kind,
        input.idempotencyKey,
        requestJson,
        now,
        now,
      );

    const operation = this.getByIdempotencyKeyForTenant(
      tenantNamespace,
      input.sessionId,
      input.idempotencyKey,
    );
    if (
      operation.kind !== input.kind ||
      encodeJson(operation.request) !== requestJson
    ) {
      throw new ConflictError(
        "Idempotency key was already used for a different operation",
        "idempotency_conflict",
      );
    }
    return { operation, created: result.changes === 1 };
  }

  public getForTenant(
    tenantNamespace: string,
    operationId: string,
  ): OperationRecord {
    const row = this.database
      .prepare(
        `SELECT ${OPERATION_COLUMNS}
         FROM operations AS o
         JOIN sessions AS s ON s.id = o.session_id
         JOIN users AS u ON u.id = s.user_id
         WHERE o.id = ? AND u.data_namespace = ?`,
      )
      .get(operationId, tenantNamespace);
    if (row === undefined) {
      throw new NotFoundError("Operation");
    }
    return mapOperation(row);
  }

  public getByIdempotencyKeyForTenant(
    tenantNamespace: string,
    sessionId: string,
    idempotencyKey: string,
  ): OperationRecord {
    const row = this.database
      .prepare(
        `SELECT ${OPERATION_COLUMNS}
         FROM operations AS o
         JOIN sessions AS s ON s.id = o.session_id
         JOIN users AS u ON u.id = s.user_id
         WHERE o.session_id = ?
           AND o.idempotency_key = ?
           AND u.data_namespace = ?`,
      )
      .get(sessionId, idempotencyKey, tenantNamespace);
    if (row === undefined) {
      throw new NotFoundError("Operation");
    }
    return mapOperation(row);
  }

  public listForSession(
    tenantNamespace: string,
    sessionId: string,
  ): OperationRecord[] {
    return this.database
      .prepare(
        `SELECT ${OPERATION_COLUMNS}
         FROM operations AS o
         JOIN sessions AS s ON s.id = o.session_id
         JOIN users AS u ON u.id = s.user_id
         WHERE o.session_id = ? AND u.data_namespace = ?
         ORDER BY o.created_at, o.id`,
      )
      .all(sessionId, tenantNamespace)
      .map(mapOperation);
  }

  public markRunningForTenant(
    tenantNamespace: string,
    operationId: string,
  ): OperationRecord {
    return this.transition(
      tenantNamespace,
      operationId,
      "running",
      undefined,
      null,
    );
  }

  public completeForTenant(
    tenantNamespace: string,
    operationId: string,
    result: unknown,
  ): OperationRecord {
    return this.transition(
      tenantNamespace,
      operationId,
      "completed",
      result,
      null,
    );
  }

  public failForTenant(
    tenantNamespace: string,
    operationId: string,
    error: string,
  ): OperationRecord {
    return this.transition(
      tenantNamespace,
      operationId,
      "failed",
      undefined,
      error,
    );
  }

  public interruptForTenant(
    tenantNamespace: string,
    operationId: string,
    error: string | null = null,
  ): OperationRecord {
    return this.transition(
      tenantNamespace,
      operationId,
      "interrupted",
      undefined,
      error,
    );
  }

  private transition(
    tenantNamespace: string,
    operationId: string,
    target: OperationStatus,
    result: unknown,
    error: string | null,
  ): OperationRecord {
    const current = this.getForTenant(tenantNamespace, operationId);
    if (current.status === target) {
      if (
        target === "completed" &&
        encodeJson(current.result) !== encodeJson(result)
      ) {
        throw new ConflictError(
          "Completed operation already has a different result",
          "idempotency_conflict",
        );
      }
      if (
        (target === "failed" || target === "interrupted") &&
        current.error !== error
      ) {
        throw new ConflictError(
          "Terminal operation already has a different error",
          "idempotency_conflict",
        );
      }
      return current;
    }
    const allowed =
      target === "running"
        ? current.status === "queued"
        : current.status === "queued" || current.status === "running";
    if (!allowed) {
      throw new ConflictError(
        `Operation cannot transition from ${current.status} to ${target}`,
        "invalid_operation_transition",
      );
    }

    const now = isoNow(this.clock);
    const terminal =
      target === "completed" ||
      target === "failed" ||
      target === "interrupted";
    const resultJson =
      result === undefined ? null : encodeJson(result);
    const update = this.database
      .prepare(
        `UPDATE operations
         SET status = ?,
             result_json = ?,
             error = ?,
             started_at = CASE
               WHEN ? = 'running' THEN COALESCE(started_at, ?)
               ELSE started_at
             END,
             completed_at = CASE WHEN ? THEN ? ELSE NULL END,
             updated_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(
        target,
        resultJson,
        error,
        target,
        now,
        terminal ? 1 : 0,
        now,
        now,
        operationId,
        current.status,
      );
    if (update.changes !== 1) {
      throw new ConflictError(
        "Operation changed concurrently",
        "concurrent_operation_update",
      );
    }
    return this.getForTenant(tenantNamespace, operationId);
  }
}
