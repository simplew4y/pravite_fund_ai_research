import { z } from "zod";

import { identifierSchema } from "./api.js";

/**
 * Pi deliberately exposes more lifecycle events than the UI currently renders.
 * Keep the durable event envelope strict while allowing versioned event names to
 * pass through without losing replay data during an SDK upgrade.
 */
export const sessionEventTypeSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);

export const sessionEventSchema = z.object({
  sessionId: identifierSchema,
  sequence: z.number().int().positive(),
  type: sessionEventTypeSchema,
  timestamp: z.iso.datetime(),
  operationId: identifierSchema.nullable(),
  payload: z.record(z.string(), z.unknown()),
});

export type SessionEventType = z.infer<typeof sessionEventTypeSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
