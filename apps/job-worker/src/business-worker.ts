import { setTimeout as delay } from "node:timers/promises";

import type {
  ClaimJobInput,
  CompleteJobInput,
  DurableJob,
  FailJobInput,
} from "@private-fund/job-queue";

import {
  BUSINESS_JOB_TYPES,
  BusinessJobError,
  type BusinessExecutionOptions,
  type BusinessJob,
} from "./business-job-executor.js";

export interface BusinessQueuePort {
  claim(input: ClaimJobInput): DurableJob | null;
  heartbeat(
    jobId: string,
    workerId: string,
    leaseDurationMs?: number,
  ): DurableJob;
  complete(input: CompleteJobInput): DurableJob;
  fail(input: FailJobInput): DurableJob;
}

export interface BusinessExecutorPort {
  execute(
    job: BusinessJob,
    execution?: BusinessExecutionOptions,
  ): Promise<Record<string, unknown>>;
}

export interface BusinessJobWorkerOptions {
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
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return result;
}

function errorMessage(error: unknown): string {
  return (
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error)
  ).slice(0, 20_000);
}

export class BusinessJobWorker {
  readonly #workerId: string;
  readonly #pollIntervalMs: number;
  readonly #leaseDurationMs: number;
  readonly #retryBaseDelayMs: number;
  readonly #onError: (error: unknown, job: DurableJob | null) => void;
  #running = false;

  public constructor(
    private readonly queue: BusinessQueuePort,
    private readonly executor: BusinessExecutorPort,
    options: BusinessJobWorkerOptions,
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
      throw new Error("BusinessJobWorker is already running");
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
            if (!signal?.aborted) throw error;
          }
        }
      }
    } finally {
      this.#running = false;
    }
  }

  public async runOnce(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    const job = this.queue.claim({
      workerId: this.#workerId,
      types: BUSINESS_JOB_TYPES,
      leaseDurationMs: this.#leaseDurationMs,
    });
    if (job === null) return false;

    const operationAbort = new AbortController();
    const onOuterAbort = (): void => operationAbort.abort();
    signal?.addEventListener("abort", onOuterAbort, { once: true });
    let heartbeatFailure: unknown;
    const heartbeat = setInterval(() => {
      if (heartbeatFailure !== undefined) return;
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
    }, Math.max(100, Math.floor(this.#leaseDurationMs / 3)));
    heartbeat.unref();

    try {
      const result = await this.executor.execute(job, {
        signal: operationAbort.signal,
      });
      if (heartbeatFailure !== undefined) throw heartbeatFailure;
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
      if (signal?.aborted) return true;
      this.#onError(error, job);
      this.queue.fail({
        jobId: job.id,
        workerId: this.#workerId,
        error: errorMessage(error),
        retry:
          !(error instanceof BusinessJobError) || error.retryable,
        retryDelayMs: Math.min(
          this.#retryBaseDelayMs *
            2 ** Math.max(0, job.attempt - 1),
          5 * 60_000,
        ),
      });
    } finally {
      clearInterval(heartbeat);
      signal?.removeEventListener("abort", onOuterAbort);
    }
    return true;
  }
}
