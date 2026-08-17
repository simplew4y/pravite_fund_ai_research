import { afterEach, describe, expect, it } from "vitest";

import {
  ConflictError,
  NotFoundError,
} from "@private-fund/core";
import {
  createControlRepositories,
  openControlDatabase,
  type ControlDatabase,
} from "@private-fund/db";

import {
  DurableJobQueue,
  LeaseLostError,
} from "../src/index.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

describe("DurableJobQueue", () => {
  let database: ControlDatabase | undefined;
  let now: Date;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  function setup() {
    now = new Date("2026-07-30T10:00:00.000Z");
    const clock = () => new Date(now);
    database = openControlDatabase(":memory:", { clock });
    const repositories = createControlRepositories(database, clock);
    repositories.users.upsertCloudShadow({
      userId: "cloud-a",
      dataNamespace: TENANT_A,
    });
    repositories.users.upsertCloudShadow({
      userId: "cloud-b",
      dataNamespace: TENANT_B,
    });
    repositories.projects.createForTenant(TENANT_A, {
      id: "project-a",
      name: "A",
    });
    repositories.projects.createForTenant(TENANT_B, {
      id: "project-b",
      name: "B",
    });
    return new DurableJobQueue(database, clock);
  }

  function advance(milliseconds: number): void {
    now = new Date(now.getTime() + milliseconds);
  }

  it("enqueues idempotently and rejects mismatched payloads", () => {
    const queue = setup();
    const first = queue.enqueue({
      tenantNamespace: TENANT_A,
      projectId: "project-a",
      type: "document.ingest",
      idempotencyKey: "upload-1",
      payload: { path: "a.pdf", options: { pages: true } },
    });
    const duplicate = queue.enqueue({
      tenantNamespace: TENANT_A,
      projectId: "project-a",
      type: "document.ingest",
      idempotencyKey: "upload-1",
      payload: { options: { pages: true }, path: "a.pdf" },
    });
    expect(first.created).toBe(true);
    expect(first.job.status).toBe("queued");
    expect(duplicate.created).toBe(false);
    expect(duplicate.job.id).toBe(first.job.id);

    expect(() =>
      queue.enqueue({
        tenantNamespace: TENANT_A,
        projectId: "project-a",
        type: "document.ingest",
        idempotencyKey: "upload-1",
        payload: { path: "other.pdf" },
      }),
    ).toThrow(ConflictError);
  });

  it("enforces project-to-tenant ownership when enqueueing and reading", () => {
    const queue = setup();
    expect(() =>
      queue.enqueue({
        tenantNamespace: TENANT_B,
        projectId: "project-a",
        type: "tracking.scan",
        idempotencyKey: "wrong-tenant",
      }),
    ).toThrow(NotFoundError);

    const job = queue.enqueue({
      tenantNamespace: TENANT_A,
      projectId: "project-a",
      type: "tracking.scan",
      idempotencyKey: "right-tenant",
    }).job;
    expect(() => queue.getForTenant(TENANT_B, job.id)).toThrow(NotFoundError);
  });

  it("claims by type, renews a lease, and completes exactly once", () => {
    const queue = setup();
    queue.enqueue({
      tenantNamespace: TENANT_A,
      projectId: "project-a",
      type: "document.ingest",
      idempotencyKey: "document",
    });
    queue.enqueue({
      tenantNamespace: TENANT_A,
      projectId: "project-a",
      type: "memo.generate",
      idempotencyKey: "memo",
    });

    const claimed = queue.claim({
      workerId: "memo-worker",
      types: ["memo.generate"],
      leaseDurationMs: 1_000,
    });
    expect(claimed?.type).toBe("memo.generate");
    expect(claimed?.attempt).toBe(1);
    expect(claimed?.leaseOwner).toBe("memo-worker");

    advance(500);
    const renewed = queue.heartbeat(
      claimed!.id,
      "memo-worker",
      2_000,
    );
    expect(renewed.leaseExpiresAt).toBe(
      "2026-07-30T10:00:02.500Z",
    );
    const completed = queue.complete({
      jobId: claimed!.id,
      workerId: "memo-worker",
      result: { memoId: "memo-1" },
    });
    expect(completed.status).toBe("completed");
    expect(completed.result).toEqual({ memoId: "memo-1" });

    const repeated = queue.complete({
      jobId: claimed!.id,
      workerId: "memo-worker",
      result: { memoId: "memo-1" },
    });
    expect(repeated).toEqual(completed);
    expect(() =>
      queue.complete({
        jobId: claimed!.id,
        workerId: "memo-worker",
        result: { memoId: "different" },
      }),
    ).toThrow(ConflictError);
  });

  it("recovers expired leases and fails exhausted jobs", () => {
    const queue = setup();
    const job = queue.enqueue({
      tenantNamespace: TENANT_A,
      projectId: "project-a",
      type: "valuation.extract",
      idempotencyKey: "valuation",
      maxAttempts: 2,
    }).job;
    const first = queue.claim({
      workerId: "worker-1",
      leaseDurationMs: 100,
    });
    expect(first?.id).toBe(job.id);

    advance(101);
    expect(() =>
      queue.complete({
        jobId: job.id,
        workerId: "worker-1",
      }),
    ).toThrow(LeaseLostError);

    const second = queue.claim({
      workerId: "worker-2",
      leaseDurationMs: 100,
    });
    expect(second?.id).toBe(job.id);
    expect(second?.attempt).toBe(2);

    advance(101);
    expect(queue.requeueExpired()).toBe(1);
    const exhausted = queue.getForTenant(TENANT_A, job.id);
    expect(exhausted.status).toBe("failed");
    expect(exhausted.error).toBe("Worker lease expired");
    expect(queue.claim({ workerId: "worker-3" })).toBeNull();
  });

  it("supports explicit retry delays and cancellation", () => {
    const queue = setup();
    const retryJob = queue.enqueue({
      tenantNamespace: TENANT_A,
      projectId: "project-a",
      type: "market.refresh",
      idempotencyKey: "market",
      maxAttempts: 2,
    }).job;
    queue.claim({ workerId: "market-worker", leaseDurationMs: 5_000 });
    const retrying = queue.fail({
      jobId: retryJob.id,
      workerId: "market-worker",
      error: "temporary provider error",
      retryDelayMs: 1_000,
    });
    expect(retrying.status).toBe("queued");
    expect(queue.claim({ workerId: "market-worker" })).toBeNull();

    advance(1_000);
    const retried = queue.claim({
      workerId: "market-worker",
      leaseDurationMs: 5_000,
    });
    expect(retried?.attempt).toBe(2);
    const terminal = queue.fail({
      jobId: retryJob.id,
      workerId: "market-worker",
      error: "permanent provider error",
    });
    expect(terminal.status).toBe("failed");

    const cancellable = queue.enqueue({
      tenantNamespace: TENANT_A,
      projectId: "project-a",
      type: "obsidian.project",
      idempotencyKey: "projection",
    }).job;
    const cancelled = queue.cancelForTenant(TENANT_A, cancellable.id);
    expect(cancelled.status).toBe("cancelled");
    expect(queue.cancelForTenant(TENANT_A, cancellable.id)).toEqual(cancelled);
  });
});
