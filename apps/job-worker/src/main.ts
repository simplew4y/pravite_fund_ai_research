import { hostname } from "node:os";
import { fileURLToPath } from "node:url";

import { createPythonComputeClient } from "@private-fund/compute-client";
import { ComputeResultProjector } from "@private-fund/compute-projector";
import { controlDbPlugin } from "@private-fund/db";
import { DurableJobQueue } from "@private-fund/job-queue";
import { createKernel, defineKernelPlugin, provide } from "@private-fund/kernel";

import { ComputeJobExecutor } from "./compute-job-executor.js";
import { loadJobWorkerConfig, type JobWorkerConfig } from "./config.js";
import { TenantProjectComputePathPolicy } from "./path-policy.js";
import { JobWorker } from "./worker.js";
import { RepositoryBusinessJobExecutor } from "./business-job-executor.js";
import { BusinessJobWorker } from "./business-worker.js";
import { WorkflowComputeProjectionHandler } from "./workflow-compute-handlers.js";

export interface JobWorkerService {
  /** Resolves when both run loops exit (after abort). */
  readonly done: Promise<void>;
}

declare module "@private-fund/kernel" {
  interface KernelServices {
    jobWorker: JobWorkerService;
  }
}

function logLine(payload: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

/**
 * job-worker profile plugin: compute sidecar health check, durable job
 * queue consumers (compute + business). Dispose aborts the run loops and
 * awaits them before the control DB closes.
 */
export const jobWorkerPlugin = defineKernelPlugin<{ config: JobWorkerConfig }>({
  name: "job-worker",
  inject: ["controlDb"],
  provides: ["jobWorker"],
  async apply(ctx, { config }) {
    const compute = createPythonComputeClient({
      workerScript: config.computeWorkerEntry,
      pythonExecutable: config.pythonExecutable,
      timeoutMs: config.computeTimeoutMs,
    });
    const health = await compute.health({});
    logLine({
      event: "compute_worker_ready",
      worker: health.worker,
      dependencies: health.dependencies,
    });

    const queue = new DurableJobQueue(ctx.controlDb.database);
    const worker = new JobWorker(
      queue,
      new ComputeJobExecutor(
        compute,
        new TenantProjectComputePathPolicy(config.dataRoot),
      ),
      new ComputeResultProjector({
        dataRoot: config.dataRoot,
        maxRecordsBytes: config.projectionMaxRecordsBytes,
        maxLineBytes: config.projectionMaxLineBytes,
        maxRecords: config.projectionMaxRecords,
        handlers: [new WorkflowComputeProjectionHandler()],
      }),
      {
        workerId: `job-worker:${hostname()}:${String(process.pid)}`,
        pollIntervalMs: config.pollIntervalMs,
        leaseDurationMs: config.leaseDurationMs,
        onError: (error, job) => {
          logLine({
            event: "job_worker_error",
            jobId: job?.id ?? null,
            error:
              error instanceof Error
                ? `${error.name}: ${error.message}`
                : String(error),
          });
        },
      },
    );
    const businessWorker = new BusinessJobWorker(
      queue,
      new RepositoryBusinessJobExecutor({
        dataRoot: config.dataRoot,
        childJobs: queue,
        maxEvidenceRecords: config.businessMaxEvidenceRecords,
      }),
      {
        workerId: `business-worker:${hostname()}:${String(process.pid)}`,
        pollIntervalMs: config.pollIntervalMs,
        leaseDurationMs: config.leaseDurationMs,
        onError: (error, job) => {
          logLine({
            event: "business_worker_error",
            jobId: job?.id ?? null,
            error:
              error instanceof Error
                ? `${error.name}: ${error.message}`
                : String(error),
          });
        },
      },
    );

    const abort = new AbortController();
    const done = Promise.all([
      worker.run(abort.signal),
      businessWorker.run(abort.signal),
    ]).then(() => undefined);
    ctx.effect(
      () => async () => {
        abort.abort();
        await done.catch(() => undefined);
      },
      "job-worker:stop",
    );
    provide(ctx, "jobWorker", { done });
  },
});

export async function main(): Promise<void> {
  const config = loadJobWorkerConfig();
  const kernel = createKernel();
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void kernel.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await kernel.use(controlDbPlugin, { path: config.controlDatabase });
    await kernel.use(jobWorkerPlugin, { config });
    await kernel.get("jobWorker").done;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await kernel.stop().catch(() => undefined);
  }
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  main().catch((error: unknown) => {
    logLine({
      event: "job_worker_fatal",
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    });
    process.exitCode = 1;
  });
}
