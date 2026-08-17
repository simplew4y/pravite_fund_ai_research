import { z } from "zod";

import { identifierSchema } from "./api.js";

export const jobTypeSchema = z.enum([
  "document.ingest",
  "memo.generate",
  "report.generate",
  "tracking.scan",
  "valuation.extract",
  "valuation.compare",
  "valuation.derive",
  "market.refresh",
  "obsidian.project",
]);

export const jobStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const jobSchema = z.object({
  id: identifierSchema,
  tenantNamespace: z.uuid(),
  projectId: identifierSchema,
  type: jobTypeSchema,
  status: jobStatusSchema,
  payload: z.record(z.string(), z.unknown()),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  leaseOwner: z.string().nullable(),
  leaseExpiresAt: z.iso.datetime().nullable(),
  idempotencyKey: z.string().min(1).max(500),
  availableAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
});

export const enqueueJobRequestSchema = z.object({
  projectId: identifierSchema,
  type: jobTypeSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().min(1).max(500),
  maxAttempts: z.number().int().min(1).max(20).default(3),
});

export const listJobsQuerySchema = z.object({
  projectId: identifierSchema.optional(),
  type: jobTypeSchema.optional(),
  status: jobStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1_000).default(100),
});

export type JobType = z.infer<typeof jobTypeSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type Job = z.infer<typeof jobSchema>;
export type EnqueueJobRequest = z.infer<typeof enqueueJobRequestSchema>;
export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;
