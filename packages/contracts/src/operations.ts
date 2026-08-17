import { z } from "zod";

import { identifierSchema } from "./api.js";

export const operationStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "interrupted",
]);

export const operationSchema = z.object({
  id: identifierSchema,
  sessionId: identifierSchema,
  kind: z.string().min(1).max(160),
  status: operationStatusSchema,
  idempotencyKey: z.string().min(1).max(500),
  request: z.record(z.string(), z.unknown()),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});

export type OperationStatus = z.infer<typeof operationStatusSchema>;
export type Operation = z.infer<typeof operationSchema>;
