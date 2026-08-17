import type { DurableJob } from "@private-fund/job-queue";
import { describe, expect, it, vi } from "vitest";

import {
  BusinessJobError,
  type BusinessJob,
} from "../src/business-job-executor.js";
import {
  BusinessJobWorker,
  type BusinessQueuePort,
} from "../src/business-worker.js";

function queuedJob(): DurableJob {
  const now = new Date().toISOString();
  return {
    id: "job-business-1",
    tenantNamespace: "00000000-0000-4000-8000-000000000031",
    projectId: "project-1",
    type: "tracking.scan",
    status: "running",
    payload: { datasetId: "project-1" },
    attempt: 1,
    maxAttempts: 3,
    leaseOwner: "business-worker",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    idempotencyKey: "scan-1",
    availableAt: now,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
    result: null,
    error: null,
  };
}

function queue(job: DurableJob): BusinessQueuePort & {
  readonly complete: ReturnType<typeof vi.fn>;
  readonly fail: ReturnType<typeof vi.fn>;
} {
  return {
    claim: vi.fn(() => job),
    heartbeat: vi.fn(() => job),
    complete: vi.fn(() => ({ ...job, status: "completed" })),
    fail: vi.fn(() => ({ ...job, status: "failed" })),
  };
}

describe("BusinessJobWorker", () => {
  it("completes only after the business transaction returns", async () => {
    const job = queuedJob();
    const value = queue(job);
    const executor = {
      execute: vi.fn(async (_job: BusinessJob) => ({
        kind: "tracking.scan",
        createdVersions: 1,
      })),
    };
    const worker = new BusinessJobWorker(value, executor, {
      workerId: "business-worker",
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(value.complete).toHaveBeenCalledWith({
      jobId: job.id,
      workerId: "business-worker",
      result: {
        kind: "tracking.scan",
        createdVersions: 1,
      },
    });
    expect(value.fail).not.toHaveBeenCalled();
  });

  it("does not retry invalid business data", async () => {
    const job = queuedJob();
    const value = queue(job);
    const executor = {
      execute: vi.fn(async () => {
        throw new BusinessJobError(
          "bad scope",
          "invalid_business_job",
          false,
        );
      }),
    };
    const worker = new BusinessJobWorker(value, executor, {
      workerId: "business-worker",
    });

    await worker.runOnce();
    expect(value.complete).not.toHaveBeenCalled();
    expect(value.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.id,
        workerId: "business-worker",
        retry: false,
      }),
    );
  });
});
