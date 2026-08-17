import { z } from "zod";

import { identifierSchema } from "./api.js";
import { sessionEventTypeSchema } from "./events.js";

export const SESSION_JOURNAL_SCHEMA_VERSION = 1 as const;

export const sha256HexSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/);

export const payloadClassificationSchema = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
]);

export const sessionEventSourceKindSchema = z.enum([
  "user",
  "system",
  "agent",
  "model",
  "tool",
  "subagent",
  "context",
  "runtime",
  "migration",
]);

export const sessionEventSourceSchema = z
  .object({
    kind: sessionEventSourceKindSchema,
    id: identifierSchema.nullable().default(null),
    version: z.string().min(1).max(200).nullable().default(null),
  })
  .strict();

export const journalBlobReferenceSchema = z
  .object({
    blobId: identifierSchema,
    sha256: sha256HexSchema,
    sizeBytes: z.number().int().nonnegative(),
    mimeType: z.string().min(1).max(255),
    classification: payloadClassificationSchema,
  })
  .strict();

const sessionJournalSemanticFields = {
  sessionId: identifierSchema,
  schemaVersion: z.literal(SESSION_JOURNAL_SCHEMA_VERSION),
  type: sessionEventTypeSchema,
  operationId: identifierSchema.nullable(),
  turnId: identifierSchema.nullable(),
  stepId: identifierSchema.nullable(),
  source: sessionEventSourceSchema,
  causationEventId: identifierSchema.nullable(),
  idempotencyKey: identifierSchema,
  classification: payloadClassificationSchema,
  payload: z.record(z.string(), z.unknown()),
  blobReferences: z.array(journalBlobReferenceSchema).max(1_000),
} as const;

export const appendSessionJournalEventSchema = z
  .object({
    ...sessionJournalSemanticFields,
    schemaVersion: z
      .literal(SESSION_JOURNAL_SCHEMA_VERSION)
      .default(SESSION_JOURNAL_SCHEMA_VERSION),
    eventId: identifierSchema.optional(),
    timestamp: z.iso.datetime().optional(),
    operationId: identifierSchema.nullable().default(null),
    turnId: identifierSchema.nullable().default(null),
    stepId: identifierSchema.nullable().default(null),
    source: sessionEventSourceSchema.default({
      kind: "runtime",
      id: null,
      version: null,
    }),
    causationEventId: identifierSchema.nullable().default(null),
    classification: payloadClassificationSchema.default("internal"),
    blobReferences: z.array(journalBlobReferenceSchema).max(1_000).default([]),
  })
  .strict();

export const sessionJournalEventSchema = z
  .object({
    ...sessionJournalSemanticFields,
    eventId: identifierSchema,
    sequence: z.number().int().positive(),
    timestamp: z.iso.datetime(),
    payloadHash: sha256HexSchema,
    requestHash: sha256HexSchema,
    previousHash: sha256HexSchema.nullable(),
    eventHash: sha256HexSchema,
  })
  .strict();

export type PayloadClassification = z.infer<
  typeof payloadClassificationSchema
>;
export type SessionEventSourceKind = z.infer<
  typeof sessionEventSourceKindSchema
>;
export type SessionEventSource = z.infer<typeof sessionEventSourceSchema>;
export type JournalBlobReference = z.infer<
  typeof journalBlobReferenceSchema
>;
export type AppendSessionJournalEvent = z.infer<
  typeof appendSessionJournalEventSchema
>;
export type SessionJournalEvent = z.infer<
  typeof sessionJournalEventSchema
>;
