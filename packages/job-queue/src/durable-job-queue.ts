import type { DatabaseSync } from "node:sqlite";

import {
  identifierSchema,
  jobSchema,
  jobTypeSchema,
  type JobStatus,
} from "@private-fund/contracts";
import type { Clock } from "@private-fund/core";
import {
  ConflictError,
  DomainError,
  NotFoundError,
  newId,
  systemClock,
} from "@private-fund/core";
import {
  decodeJson,
  encodeJson,
  withTransaction,
} from "@private-fund/db";

import type {
  ClaimJobInput,
  CompleteJobInput,
  DurableJob,
  EnqueueJobInput,
  EnqueueJobResult,
  FailJobInput,
  ListJobsInput,
} from "./types.js";

type SqlValue = null | number | bigint | string | Uint8Array;
type SqlRow = Record<string, SqlValue>;

const JOB_COLUMNS = `
  id,
  tenant_namespace AS tenantNamespace,
  project_id AS projectId,
  type,
  status,
  payload_json AS payloadJson,
  result_json AS resultJson,
  attempt,
  max_attempts AS maxAttempts,
  lease_owner AS leaseOwner,
  lease_expires_at AS leaseExpiresAt,
  idempotency_key AS idempotencyKey,
  available_at AS availableAt,
  created_at AS createdAt,
  started_at AS startedAt,
  updated_at AS updatedAt,
  completed_at AS completedAt,
  error
`;

function valueString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new DomainError(
      `Unexpected value in database column ${key}`,
      "corrupt_database",
      500,
    );
  }
  return value;
}

function valueNullableString(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  return valueString(row, key);
}

function valueNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number") {
    throw new DomainError(
      `Unexpected value in database column ${key}`,
      "corrupt_database",
      500,
    );
  }
  return value;
}

function mapJob(row: SqlRow): DurableJob {
  const payload = decodeJson(valueString(row, "payloadJson"));
  if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
    throw new DomainError(
      "Stored job payload is not an object",
      "corrupt_database",
      500,
    );
  }
  const resultJson = valueNullableString(row, "resultJson");
  const base = jobSchema.parse({
    id: valueString(row, "id"),
    tenantNamespace: valueString(row, "tenantNamespace"),
    projectId: valueString(row, "projectId"),
    type: valueString(row, "type"),
    status: valueString(row, "status"),
    payload,
    attempt: valueNumber(row, "attempt"),
    maxAttempts: valueNumber(row, "maxAttempts"),
    leaseOwner: valueNullableString(row, "leaseOwner"),
    leaseExpiresAt: valueNullableString(row, "leaseExpiresAt"),
    idempotencyKey: valueString(row, "idempotencyKey"),
    availableAt: valueString(row, "availableAt"),
    createdAt: valueString(row, "createdAt"),
    updatedAt: valueString(row, "updatedAt"),
    startedAt: valueNullableString(row, "startedAt"),
    completedAt: valueNullableString(row, "completedAt"),
    result: resultJson === null ? null : decodeJson(resultJson),
    error: valueNullableString(row, "error"),
  });
  return base;
}

function validateDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

export class LeaseLostError extends ConflictError {
  public constructor(jobId: string) {
    super(`Lease for job ${jobId} is no longer held`, "job_lease_lost");
    this.name = "LeaseLostError";
  }
}

export class DurableJobQueue {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {}

  public enqueue(input: EnqueueJobInput): EnqueueJobResult {
    const id = input.id ?? newId("job");
    identifierSchema.parse(id);
    identifierSchema.parse(input.projectId);
    jobTypeSchema.parse(input.type);
    jobSchema.shape.tenantNamespace.parse(input.tenantNamespace);
    const payload = jobSchema.shape.payload.parse(input.payload ?? {});
    if (
      !Number.isSafeInteger(input.maxAttempts ?? 3) ||
      (input.maxAttempts ?? 3) < 1
    ) {
      throw new RangeError("maxAttempts must be a positive integer");
    }
    if (
      input.idempotencyKey.length < 1 ||
      input.idempotencyKey.length > 500
    ) {
      throw new RangeError(
        "idempotencyKey must contain between 1 and 500 characters",
      );
    }
    const project = this.database
      .prepare(
        `SELECT 1
         FROM projects AS p
         JOIN users AS u ON u.id = p.user_id
         WHERE p.id = ? AND u.data_namespace = ?
           AND p.deleted_at IS NULL`,
      )
      .get(input.projectId, input.tenantNamespace);
    if (project === undefined) {
      throw new NotFoundError("Project");
    }

    const now = this.clock();
    const nowIso = now.toISOString();
    const availableAt = input.availableAt?.toISOString() ?? nowIso;
    const payloadJson = encodeJson(payload);
    const maxAttempts = input.maxAttempts ?? 3;
    const insert = this.database
      .prepare(
        `INSERT INTO jobs(
           id, tenant_namespace, project_id, type, status,
           payload_json, result_json, attempt, max_attempts,
           lease_owner, lease_expires_at, idempotency_key,
           available_at, created_at, started_at, updated_at,
           completed_at, error
         ) VALUES (
           ?, ?, ?, ?, 'queued',
           ?, NULL, 0, ?,
           NULL, NULL, ?,
           ?, ?, NULL, ?,
           NULL, NULL
         )
         ON CONFLICT(
           tenant_namespace, project_id, type, idempotency_key
         ) DO NOTHING`,
      )
      .run(
        id,
        input.tenantNamespace,
        input.projectId,
        input.type,
        payloadJson,
        maxAttempts,
        input.idempotencyKey,
        availableAt,
        nowIso,
        nowIso,
      );
    const job = this.getByIdempotencyKey(
      input.tenantNamespace,
      input.projectId,
      input.type,
      input.idempotencyKey,
    );
    if (
      encodeJson(job.payload) !== payloadJson ||
      job.maxAttempts !== maxAttempts
    ) {
      throw new ConflictError(
        "Idempotency key was already used with different job parameters",
        "idempotency_conflict",
      );
    }
    return { job, created: insert.changes === 1 };
  }

  public claim(input: ClaimJobInput): DurableJob | null {
    const leaseDurationMs = validateDuration(
      input.leaseDurationMs ?? 60_000,
      "leaseDurationMs",
    );
    if (input.workerId.length === 0) {
      throw new RangeError("workerId must not be empty");
    }
    const types = input.types ?? [];
    for (const type of types) {
      jobTypeSchema.parse(type);
    }
    if (input.types !== undefined && types.length === 0) {
      return null;
    }

    return withTransaction(this.database, () => {
      const now = this.clock();
      const nowIso = now.toISOString();
      this.requeueExpiredInternal(nowIso);

      const typeClause =
        types.length === 0
          ? ""
          : ` AND type IN (${types.map(() => "?").join(", ")})`;
      const candidate = this.database
        .prepare(
          `SELECT id
           FROM jobs
           WHERE status = 'queued'
             AND available_at <= ?
             AND attempt < max_attempts
             ${typeClause}
           ORDER BY available_at, created_at, id
           LIMIT 1`,
        )
        .get(nowIso, ...types);
      if (candidate === undefined) {
        return null;
      }

      const jobId = valueString(candidate, "id");
      const leaseExpiresAt = new Date(
        now.getTime() + leaseDurationMs,
      ).toISOString();
      const update = this.database
        .prepare(
          `UPDATE jobs
           SET status = 'running',
               attempt = attempt + 1,
               lease_owner = ?,
               lease_expires_at = ?,
               started_at = COALESCE(started_at, ?),
               updated_at = ?,
               error = NULL
           WHERE id = ? AND status = 'queued' AND available_at <= ?`,
        )
        .run(
          input.workerId,
          leaseExpiresAt,
          nowIso,
          nowIso,
          jobId,
          nowIso,
        );
      if (update.changes !== 1) {
        throw new ConflictError(
          "Job changed while being claimed",
          "concurrent_job_claim",
        );
      }
      return this.getInternal(jobId);
    });
  }

  public heartbeat(
    jobId: string,
    workerId: string,
    leaseDurationMs = 60_000,
  ): DurableJob {
    validateDuration(leaseDurationMs, "leaseDurationMs");
    const now = this.clock();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(
      now.getTime() + leaseDurationMs,
    ).toISOString();
    const update = this.database
      .prepare(
        `UPDATE jobs
         SET lease_expires_at = ?, updated_at = ?
         WHERE id = ?
           AND status = 'running'
           AND lease_owner = ?
           AND lease_expires_at > ?`,
      )
      .run(leaseExpiresAt, nowIso, jobId, workerId, nowIso);
    if (update.changes !== 1) {
      throw new LeaseLostError(jobId);
    }
    return this.getInternal(jobId);
  }

  public complete(input: CompleteJobInput): DurableJob {
    const resultJson = encodeJson(input.result ?? null);
    const current = this.getInternal(input.jobId);
    if (current.status === "completed") {
      if (encodeJson(current.result) !== resultJson) {
        throw new ConflictError(
          "Completed job already has a different result",
          "idempotency_conflict",
        );
      }
      return current;
    }

    const nowIso = this.clock().toISOString();
    const update = this.database
      .prepare(
        `UPDATE jobs
         SET status = 'completed',
             result_json = ?,
             lease_owner = NULL,
             lease_expires_at = NULL,
             completed_at = ?,
             updated_at = ?,
             error = NULL
         WHERE id = ?
           AND status = 'running'
           AND lease_owner = ?
           AND lease_expires_at > ?`,
      )
      .run(
        resultJson,
        nowIso,
        nowIso,
        input.jobId,
        input.workerId,
        nowIso,
      );
    if (update.changes !== 1) {
      throw new LeaseLostError(input.jobId);
    }
    return this.getInternal(input.jobId);
  }

  public fail(input: FailJobInput): DurableJob {
    const current = this.getInternal(input.jobId);
    const retry = (input.retry ?? true) && current.attempt < current.maxAttempts;
    const retryDelayMs = input.retryDelayMs ?? 0;
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
      throw new RangeError("retryDelayMs must be a non-negative integer");
    }
    const now = this.clock();
    const nowIso = now.toISOString();
    const availableAt = new Date(now.getTime() + retryDelayMs).toISOString();
    const target: JobStatus = retry ? "queued" : "failed";
    const update = this.database
      .prepare(
        `UPDATE jobs
         SET status = ?,
             lease_owner = NULL,
             lease_expires_at = NULL,
             available_at = ?,
             completed_at = ?,
             updated_at = ?,
             error = ?
         WHERE id = ?
           AND status = 'running'
           AND lease_owner = ?
           AND lease_expires_at > ?`,
      )
      .run(
        target,
        availableAt,
        retry ? null : nowIso,
        nowIso,
        input.error,
        input.jobId,
        input.workerId,
        nowIso,
      );
    if (update.changes !== 1) {
      throw new LeaseLostError(input.jobId);
    }
    return this.getInternal(input.jobId);
  }

  public cancelForTenant(
    tenantNamespace: string,
    jobId: string,
  ): DurableJob {
    const current = this.getForTenant(tenantNamespace, jobId);
    if (current.status === "cancelled") {
      return current;
    }
    if (current.status === "completed" || current.status === "failed") {
      throw new ConflictError(
        `Cannot cancel a ${current.status} job`,
        "invalid_job_transition",
      );
    }
    const nowIso = this.clock().toISOString();
    const update = this.database
      .prepare(
        `UPDATE jobs
         SET status = 'cancelled',
             lease_owner = NULL,
             lease_expires_at = NULL,
             completed_at = ?,
             updated_at = ?
         WHERE id = ? AND tenant_namespace = ? AND status IN ('queued', 'running')`,
      )
      .run(nowIso, nowIso, jobId, tenantNamespace);
    if (update.changes !== 1) {
      throw new ConflictError(
        "Job changed while being cancelled",
        "concurrent_job_update",
      );
    }
    return this.getForTenant(tenantNamespace, jobId);
  }

  public getForTenant(
    tenantNamespace: string,
    jobId: string,
  ): DurableJob {
    const row = this.database
      .prepare(
        `SELECT ${JOB_COLUMNS}
         FROM jobs
         WHERE id = ? AND tenant_namespace = ?`,
      )
      .get(jobId, tenantNamespace);
    if (row === undefined) {
      throw new NotFoundError("Job");
    }
    return mapJob(row);
  }

  public listForTenant(
    tenantNamespace: string,
    input: ListJobsInput = {},
  ): DurableJob[] {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("limit must contain between 1 and 1000 jobs");
    }
    const clauses = ["tenant_namespace = ?"];
    const parameters: (string | number)[] = [tenantNamespace];
    if (input.projectId !== undefined) {
      clauses.push("project_id = ?");
      parameters.push(input.projectId);
    }
    if (input.status !== undefined) {
      clauses.push("status = ?");
      parameters.push(input.status);
    }
    if (input.type !== undefined) {
      jobTypeSchema.parse(input.type);
      clauses.push("type = ?");
      parameters.push(input.type);
    }
    parameters.push(limit);

    return this.database
      .prepare(
        `SELECT ${JOB_COLUMNS}
         FROM jobs
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, id
         LIMIT ?`,
      )
      .all(...parameters)
      .map(mapJob);
  }

  public requeueExpired(): number {
    return withTransaction(this.database, () =>
      this.requeueExpiredInternal(this.clock().toISOString()),
    );
  }

  private getByIdempotencyKey(
    tenantNamespace: string,
    projectId: string,
    type: string,
    idempotencyKey: string,
  ): DurableJob {
    const row = this.database
      .prepare(
        `SELECT ${JOB_COLUMNS}
         FROM jobs
         WHERE tenant_namespace = ?
           AND project_id = ?
           AND type = ?
           AND idempotency_key = ?`,
      )
      .get(tenantNamespace, projectId, type, idempotencyKey);
    if (row === undefined) {
      throw new Error("Enqueued job disappeared");
    }
    return mapJob(row);
  }

  private getInternal(jobId: string): DurableJob {
    const row = this.database
      .prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`)
      .get(jobId);
    if (row === undefined) {
      throw new NotFoundError("Job");
    }
    return mapJob(row);
  }

  private requeueExpiredInternal(nowIso: string): number {
    const exhausted = this.database
      .prepare(
        `UPDATE jobs
         SET status = 'failed',
             lease_owner = NULL,
             lease_expires_at = NULL,
             completed_at = ?,
             updated_at = ?,
             error = COALESCE(error, 'Worker lease expired')
         WHERE status = 'running'
           AND lease_expires_at <= ?
           AND attempt >= max_attempts`,
      )
      .run(nowIso, nowIso, nowIso);
    const retryable = this.database
      .prepare(
        `UPDATE jobs
         SET status = 'queued',
             lease_owner = NULL,
             lease_expires_at = NULL,
             available_at = ?,
             updated_at = ?,
             error = COALESCE(error, 'Worker lease expired')
         WHERE status = 'running'
           AND lease_expires_at <= ?
           AND attempt < max_attempts`,
      )
      .run(nowIso, nowIso, nowIso);
    return Number(exhausted.changes) + Number(retryable.changes);
  }
}
