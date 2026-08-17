import { setTimeout as delay } from "node:timers/promises";

import type { ComputeResponse } from "@private-fund/contracts";
import {
  ComputeClientError,
  type ComputeExecutionOptions,
} from "@private-fund/compute-client";
import {
  ComputeProjectionError,
  type ComputeResultProjectorPort,
} from "@private-fund/compute-projector";
import type {
  ClaimJobInput,
  CompleteJobInput,
  DurableJob,
  FailJobInput,
} from "@private-fund/job-queue";

import {
  COMPUTE_BACKED_JOB_TYPES,
  ComputeJobResponseError,
  InvalidComputeJobError,
  InvalidComputeResultError,
  type ComputeJob,
} from "./compute-job-executor.js";

export interface JobQueuePort {
  claim(input: ClaimJobInput): DurableJob | null;
  heartbeat(
    jobId: string,
    workerId: string,
    leaseDurationMs?: number,
  ): DurableJob;
  complete(input: CompleteJobInput): DurableJob;
  fail(input: FailJobInput): DurableJob;
}

export interface JobExecutorPort {
  execute(
    job: ComputeJob,
    execution?: ComputeExecutionOptions,
  ): Promise<ComputeResponse>;
}

export interface JobWorkerOptions {
  readonly workerId: string;
  readonly pollIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly retryBaseDelayMs?: number;
  readonly onError?: (error: unknown, job: DurableJob | null) => void;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return resolved;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, 20_000);
  }
  return String(error).slice(0, 20_000);
}

function shouldRetry(error: unknown): boolean {
  if (error instanceof ComputeJobResponseError) {
    return error.retryable;
  }
  if (
    error instanceof InvalidComputeJobError ||
    error instanceof InvalidComputeResultError
  ) {
    return false;
  }
  if (error instanceof ComputeProjectionError) {
    return error.retryable;
  }
  if (error instanceof ComputeClientError) {
    return (
      error.code === "worker_spawn_failed" ||
      error.code === "worker_process_failed" ||
      error.code === "worker_timeout"
    );
  }
  return true;
}

export class JobWorker {
  readonly #workerId: string;
  readonly #pollIntervalMs: number;
  readonly #leaseDurationMs: number;
  readonly #retryBaseDelayMs: number;
  readonly #onError: (error: unknown, job: DurableJob | null) => void;
  #running = false;

  public constructor(
    private readonly queue: JobQueuePort,
    private readonly executor: JobExecutorPort,
    private readonly projector: ComputeResultProjectorPort,
    options: JobWorkerOptions,
  ) {
    if (!options.workerId) {
      throw new RangeError("workerId must not be empty");
    }
    this.#workerId = options.workerId;
    this.#pollIntervalMs = positiveInteger(
      options.pollIntervalMs,
      1_000,
      "pollIntervalMs",
    );
    this.#leaseDurationMs = positiveInteger(
      options.leaseDurationMs,
      60_000,
      "leaseDurationMs",
    );
    this.#retryBaseDelayMs = positiveInteger(
      options.retryBaseDelayMs,
      2_000,
      "retryBaseDelayMs",
    );
    this.#onError = options.onError ?? (() => undefined);
  }

  public async run(signal?: AbortSignal): Promise<void> {
    if (this.#running) {
      throw new Error("JobWorker is already running");
    }
    this.#running = true;
    try {
      while (!signal?.aborted) {
        let claimed = false;
        try {
          claimed = await this.runOnce(signal);
        } catch (error) {
          this.#onError(error, null);
        }
        if (!claimed && !signal?.aborted) {
          try {
            await delay(this.#pollIntervalMs, undefined, { signal });
          } catch (error) {
            if (!signal?.aborted) {
              throw error;
            }
          }
        }
      }
    } finally {
      this.#running = false;
    }
  }

  public async runOnce(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) {
      return false;
    }
    const job = this.queue.claim({
      workerId: this.#workerId,
      types: COMPUTE_BACKED_JOB_TYPES,
      leaseDurationMs: this.#leaseDurationMs,
    });
    if (job === null) {
      return false;
    }

    const operationAbort = new AbortController();
    const onOuterAbort = (): void => {
      operationAbort.abort();
    };
    signal?.addEventListener("abort", onOuterAbort, { once: true });

    let heartbeatFailure: unknown;
    const heartbeatInterval = Math.max(
      100,
      Math.floor(this.#leaseDurationMs / 3),
    );
    const heartbeat = setInterval(() => {
      if (heartbeatFailure !== undefined) {
        return;
      }
      try {
        this.queue.heartbeat(
          job.id,
          this.#workerId,
          this.#leaseDurationMs,
        );
      } catch (error) {
        heartbeatFailure = error;
        operationAbort.abort();
      }
    }, heartbeatInterval);
    heartbeat.unref();

    try {
      const result = await this.executor.execute(job, {
        signal: operationAbort.signal,
      });
      if (heartbeatFailure !== undefined) {
        throw heartbeatFailure;
      }
      const projection = await this.projector.project(job, result, {
        signal: operationAbort.signal,
      });
      if (projection.kind === "deferred") {
        throw new ComputeProjectionError(
          `No compute projection handler is registered for ${job.type}`,
          "projection_record_invalid",
          false,
        );
      }
      if (heartbeatFailure !== undefined) {
        throw heartbeatFailure;
      }
      this.queue.complete({
        jobId: job.id,
        workerId: this.#workerId,
        result,
      });
    } catch (error) {
      if (heartbeatFailure !== undefined) {
        this.#onError(heartbeatFailure, job);
        throw heartbeatFailure;
      }
      if (signal?.aborted) {
        // Leave the leased job alone. The durable queue will reclaim it after
        // lease expiry, which avoids recording a false application failure
        // during graceful process shutdown.
        return true;
      }
      this.#onError(error, job);
      const retryDelayMs = Math.min(
        this.#retryBaseDelayMs * 2 ** Math.max(0, job.attempt - 1),
        5 * 60_000,
      );
      this.queue.fail({
        jobId: job.id,
        workerId: this.#workerId,
        error: errorMessage(error),
        retry: shouldRetry(error),
        retryDelayMs,
      });
    } finally {
      clearInterval(heartbeat);
      signal?.removeEventListener("abort", onOuterAbort);
    }
    return true;
  }
}
