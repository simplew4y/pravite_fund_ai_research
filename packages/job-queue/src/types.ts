import type {
  Job,
  JobStatus,
  JobType,
} from "@private-fund/contracts";

export interface DurableJob extends Job {}

export interface EnqueueJobInput {
  readonly id?: string;
  readonly tenantNamespace: string;
  readonly projectId: string;
  readonly type: JobType;
  readonly payload?: Record<string, unknown>;
  readonly idempotencyKey: string;
  readonly maxAttempts?: number;
  readonly availableAt?: Date;
}

export interface EnqueueJobResult {
  readonly job: DurableJob;
  readonly created: boolean;
}

export interface ClaimJobInput {
  readonly workerId: string;
  readonly types?: readonly JobType[];
  readonly leaseDurationMs?: number;
}

export interface CompleteJobInput {
  readonly jobId: string;
  readonly workerId: string;
  readonly result?: unknown;
}

export interface FailJobInput {
  readonly jobId: string;
  readonly workerId: string;
  readonly error: string;
  readonly retry?: boolean;
  readonly retryDelayMs?: number;
}

export interface ListJobsInput {
  readonly projectId?: string;
  readonly status?: JobStatus;
  readonly type?: JobType;
  readonly limit?: number;
}
