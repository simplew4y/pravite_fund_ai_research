import { describe, expect, it, vi } from "vitest";

import type { ComputeResponse } from "@private-fund/contracts";
import {
  ComputeProjectionError,
  type ComputeResultProjectorPort,
} from "@private-fund/compute-projector";
import type { DurableJob } from "@private-fund/job-queue";

import { JobWorker, type JobQueuePort } from "../src/worker.js";

function durableJob(): DurableJob {
  return {
    id: "job-1",
    tenantNamespace: "00000000-0000-4000-8000-000000000001",
    projectId: "project-1",
    type: "document.ingest",
    status: "running",
    payload: {
      inputPath: "/tmp/input.pdf",
      outputDirectory: "/tmp/output",
    },
    attempt: 1,
    maxAttempts: 3,
    leaseOwner: "worker-1",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    idempotencyKey: "ingest-1",
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    availableAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: null,
  };
}

function queueWith(job: DurableJob | null): JobQueuePort & {
  claim: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
} {
  return {
    claim: vi.fn(() => job),
    heartbeat: vi.fn(() => {
      if (job === null) {
        throw new Error("no job");
      }
      return job;
    }),
    complete: vi.fn(() => {
      if (job === null) {
        throw new Error("no job");
      }
      return job;
    }),
    fail: vi.fn(() => {
      if (job === null) {
        throw new Error("no job");
      }
      return job;
    }),
  };
}

const completed: ComputeResponse = {
  protocolVersion: 1,
  requestId: "request-1",
  status: "completed",
  recordsFile: "records.ndjson",
  artifacts: [],
  metrics: {},
  error: null,
};

function successfulProjector(): ComputeResultProjectorPort & {
  project: ReturnType<typeof vi.fn>;
} {
  return {
    project: vi.fn(async () => ({
      kind: "document" as const,
      documentVersionId: "version-1",
      evidenceCount: 1,
      status: "indexed" as const,
      recordsBytes: 10,
      recordsChecksum: `sha256:${"0".repeat(64)}`,
    })),
  };
}

describe("JobWorker", () => {
  it("completes a claimed compute job", async () => {
    const queue = queueWith(durableJob());
    const executor = { execute: vi.fn(async () => completed) };
    const projector = successfulProjector();
    const worker = new JobWorker(queue, executor, projector, {
      workerId: "worker-1",
      leaseDurationMs: 60_000,
    });
    expect(await worker.runOnce()).toBe(true);
    expect(projector.project).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1" }),
      completed,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(queue.complete).toHaveBeenCalledWith({
      jobId: "job-1",
      workerId: "worker-1",
      result: completed,
    });
    expect(queue.fail).not.toHaveBeenCalled();
  });

  it("returns false when no work is available", async () => {
    const queue = queueWith(null);
    const executor = { execute: vi.fn(async () => completed) };
    const projector = successfulProjector();
    const worker = new JobWorker(queue, executor, projector, {
      workerId: "worker-1",
    });
    expect(await worker.runOnce()).toBe(false);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(projector.project).not.toHaveBeenCalled();
  });

  it("records executor failures for durable retry", async () => {
    const queue = queueWith(durableJob());
    const executor = {
      execute: vi.fn(async () => {
        throw new Error("transient");
      }),
    };
    const worker = new JobWorker(queue, executor, successfulProjector(), {
      workerId: "worker-1",
      retryBaseDelayMs: 10,
    });
    expect(await worker.runOnce()).toBe(true);
    expect(queue.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1",
        workerId: "worker-1",
        retry: true,
      }),
    );
  });

  it("does not complete when durable projection fails", async () => {
    const queue = queueWith(durableJob());
    const executor = { execute: vi.fn(async () => completed) };
    const projector = {
      project: vi.fn(async () => {
        throw new ComputeProjectionError(
          "record mismatch",
          "projection_integrity_mismatch",
          false,
        );
      }),
    };
    const worker = new JobWorker(queue, executor, projector, {
      workerId: "worker-1",
    });

    expect(await worker.runOnce()).toBe(true);
    expect(queue.complete).not.toHaveBeenCalled();
    expect(queue.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1",
        retry: false,
      }),
    );
  });

  it("fails closed when no durable projection handler is registered", async () => {
    const queue = queueWith(durableJob());
    const executor = { execute: vi.fn(async () => completed) };
    const projector: ComputeResultProjectorPort = {
      project: vi.fn(async () => ({
        kind: "deferred" as const,
        jobType: "document.ingest" as const,
        reason: "no_registered_handler" as const,
      })),
    };
    const worker = new JobWorker(queue, executor, projector, {
      workerId: "worker-1",
    });

    expect(await worker.runOnce()).toBe(true);
    expect(queue.complete).not.toHaveBeenCalled();
    expect(queue.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1",
        retry: false,
        error: expect.stringContaining(
          "No compute projection handler is registered",
        ),
      }),
    );
  });
});
