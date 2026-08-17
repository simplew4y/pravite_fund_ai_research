import { hostname } from "node:os";
import { fileURLToPath } from "node:url";

import { createPythonComputeClient } from "@private-fund/compute-client";
import { ComputeResultProjector } from "@private-fund/compute-projector";
import { openControlDatabase } from "@private-fund/db";
import { DurableJobQueue } from "@private-fund/job-queue";

import { ComputeJobExecutor } from "./compute-job-executor.js";
import { loadJobWorkerConfig } from "./config.js";
import { TenantProjectComputePathPolicy } from "./path-policy.js";
import { JobWorker } from "./worker.js";
import { RepositoryBusinessJobExecutor } from "./business-job-executor.js";
import { BusinessJobWorker } from "./business-worker.js";
import { WorkflowComputeProjectionHandler } from "./workflow-compute-handlers.js";

export async function main(): Promise<void> {
  const config = loadJobWorkerConfig();
  const database = openControlDatabase(config.controlDatabase);
  const abort = new AbortController();
  const stop = (): void => {
    abort.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    const compute = createPythonComputeClient({
      workerScript: config.computeWorkerEntry,
      pythonExecutable: config.pythonExecutable,
      timeoutMs: config.computeTimeoutMs,
    });
    const health = await compute.health({ signal: abort.signal });
    process.stderr.write(
      `${JSON.stringify({
        event: "compute_worker_ready",
        worker: health.worker,
        dependencies: health.dependencies,
      })}\n`,
    );

    const queue = new DurableJobQueue(database);
    const executor = new ComputeJobExecutor(
      compute,
      new TenantProjectComputePathPolicy(config.dataRoot),
    );
    const projector = new ComputeResultProjector({
      dataRoot: config.dataRoot,
      maxRecordsBytes: config.projectionMaxRecordsBytes,
      maxLineBytes: config.projectionMaxLineBytes,
      maxRecords: config.projectionMaxRecords,
      handlers: [new WorkflowComputeProjectionHandler()],
    });
    const worker = new JobWorker(queue, executor, projector, {
      workerId: `job-worker:${hostname()}:${String(process.pid)}`,
      pollIntervalMs: config.pollIntervalMs,
      leaseDurationMs: config.leaseDurationMs,
      onError: (error, job) => {
        process.stderr.write(
          `${JSON.stringify({
            event: "job_worker_error",
            jobId: job?.id ?? null,
            error:
              error instanceof Error
                ? `${error.name}: ${error.message}`
                : String(error),
          })}\n`,
        );
      },
    });
    const businessExecutor = new RepositoryBusinessJobExecutor({
      dataRoot: config.dataRoot,
      childJobs: queue,
      maxEvidenceRecords: config.businessMaxEvidenceRecords,
    });
    const businessWorker = new BusinessJobWorker(
      queue,
      businessExecutor,
      {
        workerId: `business-worker:${hostname()}:${String(process.pid)}`,
        pollIntervalMs: config.pollIntervalMs,
        leaseDurationMs: config.leaseDurationMs,
        onError: (error, job) => {
          process.stderr.write(
            `${JSON.stringify({
              event: "business_worker_error",
              jobId: job?.id ?? null,
              error:
                error instanceof Error
                  ? `${error.name}: ${error.message}`
                  : String(error),
            })}\n`,
          );
        },
      },
    );
    await Promise.all([
      worker.run(abort.signal),
      businessWorker.run(abort.signal),
    ]);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    database.close();
  }
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        event: "job_worker_fatal",
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error),
      })}\n`,
    );
    process.exitCode = 1;
  });
}
