import { z } from "zod";

import { identifierSchema } from "./api.js";
import {
  payloadClassificationSchema,
  sha256HexSchema,
} from "./journal.js";

export const MODEL_REQUEST_SCHEMA_VERSION = 1 as const;
export const MODEL_STREAM_SCHEMA_VERSION = 1 as const;

export const modelSourceKindSchema = z.enum([
  "system_prompt",
  "user_message",
  "session_event",
  "business_snapshot",
  "tool_schema",
  "tool_result",
  "compaction",
  "injected_context",
  "static_configuration",
]);

export const modelSourceOriginSchema = z
  .object({
    kind: modelSourceKindSchema,
    id: identifierSchema,
    version: z.string().min(1).max(200).nullable().default(null),
    sequence: z.number().int().nonnegative().nullable().default(null),
  })
  .strict();

export const modelSourceManifestEntrySchema = z
  .object({
    sourceId: identifierSchema,
    origin: modelSourceOriginSchema,
    classification: payloadClassificationSchema,
    required: z.boolean(),
    contentHash: sha256HexSchema,
    sizeBytes: z.number().int().nonnegative(),
    /** JSON Pointer locations in the exact provider-bound body. */
    bodyPointers: z
      .array(z.string().regex(/^(?:|(?:\/(?:[^~/]|~[01])*)+)$/))
      .min(1)
      .max(1_000),
  })
  .strict();

const FORBIDDEN_SECRET_KEYS = new Set([
  "authorization",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "password",
  "secret",
  "credentials",
  "cookie",
  "setcookie",
]);

function normalizedSensitiveKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function findForbiddenSecretKey(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
): string | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  if (seen.has(value)) {
    return `${path} (cyclic value)`;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const found = findForbiddenSecretKey(
          value[index],
          `${path}/${String(index)}`,
          seen,
        );
        if (found !== null) {
          return found;
        }
      }
      return null;
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        return `${path} (symbol-keyed property)`;
      }
      const nextPath = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      if (FORBIDDEN_SECRET_KEYS.has(normalizedSensitiveKey(key))) {
        return nextPath;
      }
      const found = findForbiddenSecretKey(
        (value as Record<string, unknown>)[key],
        nextPath,
        seen,
      );
      if (found !== null) {
        return found;
      }
    }
    return null;
  } finally {
    seen.delete(value);
  }
}

export const modelRequestBodySchema = z
  .record(z.string(), z.unknown())
  .superRefine((body, context) => {
    const forbidden = findForbiddenSecretKey(body, "", new WeakSet());
    if (forbidden !== null) {
      context.addIssue({
        code: "custom",
        message: `Model request body contains a forbidden secret field at ${forbidden}`,
      });
    }
  });

const modelRequestSemanticFields = {
  schemaVersion: z.literal(MODEL_REQUEST_SCHEMA_VERSION),
  requestId: identifierSchema,
  sessionId: identifierSchema,
  /** Null for maintenance calls (e.g. compaction) that own no operation. */
  operationId: identifierSchema.nullable(),
  turnId: identifierSchema,
  stepId: identifierSchema,
  providerId: identifierSchema,
  model: z.string().min(1).max(200),
  compilerVersion: z.string().min(1).max(200),
  journalThroughSequence: z.number().int().nonnegative(),
  body: modelRequestBodySchema,
  sourceManifest: z.array(modelSourceManifestEntrySchema).min(1).max(10_000),
} as const;

export const modelRequestDraftSchema = z
  .object(modelRequestSemanticFields)
  .strict();

export const modelRequestSnapshotSchema = z
  .object({
    ...modelRequestSemanticFields,
    bodyHash: sha256HexSchema,
    requestHash: sha256HexSchema,
  })
  .strict();

export const modelStreamChannelSchema = z.enum(["text", "reasoning"]);

export const modelProviderEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      schemaVersion: z.literal(MODEL_STREAM_SCHEMA_VERSION),
      type: z.literal("delta"),
      channel: modelStreamChannelSchema,
      delta: z.string().min(1),
      contentIndex: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(MODEL_STREAM_SCHEMA_VERSION),
      type: z.literal("tool_call"),
      toolCallId: identifierSchema,
      name: z.string().min(1).max(200),
      arguments: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(MODEL_STREAM_SCHEMA_VERSION),
      type: z.literal("usage"),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      cacheReadTokens: z.number().int().nonnegative().default(0),
      cacheWriteTokens: z.number().int().nonnegative().default(0),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(MODEL_STREAM_SCHEMA_VERSION),
      type: z.literal("final"),
      finishReason: z.string().min(1).max(100),
      responseModel: z.string().min(1).max(200).nullable().default(null),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(MODEL_STREAM_SCHEMA_VERSION),
      type: z.literal("error"),
      code: z.string().min(1).max(160),
      message: z.string().min(1).max(4_000),
      retryable: z.boolean(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(MODEL_STREAM_SCHEMA_VERSION),
      type: z.literal("aborted"),
      reason: z.enum(["cancelled", "timeout", "shutdown"]),
    })
    .strict(),
]);

export type ModelSourceKind = z.infer<typeof modelSourceKindSchema>;
export type ModelSourceOrigin = z.infer<typeof modelSourceOriginSchema>;
export type ModelSourceManifestEntry = z.infer<
  typeof modelSourceManifestEntrySchema
>;
export type ModelRequestDraft = z.infer<typeof modelRequestDraftSchema>;
export type ModelRequestSnapshot = z.infer<typeof modelRequestSnapshotSchema>;
export type ModelStreamChannel = z.infer<typeof modelStreamChannelSchema>;
export type ModelProviderEvent = z.infer<typeof modelProviderEventSchema>;
