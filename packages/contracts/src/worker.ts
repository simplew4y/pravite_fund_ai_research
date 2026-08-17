import { z } from "zod";

import { identifierSchema, tenantIdentitySchema } from "./api.js";
import {
  agentToolCancelMessageSchema,
  agentToolRequestMessageSchema,
  agentToolResultCommandSchema,
} from "./agent-tools.js";

const modelGatewayBaseUrlSchema = z
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  }, "Model gateway base URL must be a credential-free HTTPS URL");

export const modelGatewayAccessSchema = z
  .object({
    leaseId: identifierSchema,
    generation: z.number().int().positive(),
    providerId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    accessToken: z
      .string()
      .min(16)
      .max(16_384)
      .regex(/^pfm_[^\s]+$/),
    expiresAt: z.string().datetime({ offset: true }),
    gatewayBaseUrl: modelGatewayBaseUrlSchema,
    model: z
      .object({
        id: z.string().trim().min(1).max(200),
        name: z.string().trim().min(1).max(300),
        contextWindow: z.number().int().min(1_024).max(10_000_000),
        maxTokens: z.number().int().positive().max(1_000_000),
      })
      .strict(),
    binding: z
      .object({
        userId: identifierSchema,
        dataNamespace: z.uuid(),
        projectId: identifierSchema,
        sessionId: identifierSchema,
      })
      .strict(),
  })
  .strict();

export const agentWorkerCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.start"),
    requestId: identifierSchema,
    sessionId: identifierSchema,
    projectId: identifierSchema,
    tenant: tenantIdentitySchema,
    workspace: z.string().min(1),
    sessionFile: z.string().min(1),
    model: z.string().optional(),
    modelGatewayAccess: modelGatewayAccessSchema.optional(),
  }),
  z.object({
    type: z.literal("session.prompt"),
    requestId: identifierSchema,
    sessionId: identifierSchema,
    operationId: identifierSchema,
    content: z.string().min(1),
  }),
  z.object({
    type: z.literal("session.steer"),
    requestId: identifierSchema,
    sessionId: identifierSchema,
    content: z.string().min(1),
  }),
  z.object({
    type: z.literal("session.interrupt"),
    requestId: identifierSchema,
    sessionId: identifierSchema,
  }),
  z.object({
    type: z.literal("session.compact"),
    requestId: identifierSchema,
    sessionId: identifierSchema,
    customInstructions: z.string().min(1).max(20_000).optional(),
  }),
  z.object({
    type: z.literal("session.dispose"),
    requestId: identifierSchema,
    sessionId: identifierSchema,
  }),
  agentToolResultCommandSchema,
]);

export const agentWorkerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("worker.ready"),
    workerId: identifierSchema,
  }),
  z.object({
    type: z.literal("command.result"),
    requestId: identifierSchema,
    ok: z.boolean(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("agent.event"),
    sessionId: identifierSchema,
    operationId: identifierSchema.nullable(),
    eventType: z.string(),
    payload: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("worker.error"),
    sessionId: identifierSchema.optional(),
    error: z.string(),
  }),
  agentToolRequestMessageSchema,
  agentToolCancelMessageSchema,
]);

export const computeOperationSchema = z.enum([
  "extract_pdf",
  "extract_document",
  "render_pdf_page",
  "extract_workbook",
  "derive_workbook",
  "fetch_market_data",
  "render_report",
]);

export const computeWorkerHealthSchema = z.object({
  protocolVersion: z.literal(1),
  status: z.literal("ok"),
  worker: z.string().min(1),
  pythonVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  implementedOperations: z.array(computeOperationSchema),
  contractOperations: z.array(computeOperationSchema),
  capabilities: z.object({
    extract_document: z.object({
      extensions: z.array(
        z.enum([".csv", ".docx", ".markdown", ".md", ".pptx", ".txt"]),
      ),
      recordsMediaType: z.literal("application/x-ndjson"),
      boundedExtraction: z.literal(true),
    }),
    fetch_market_data: z.object({
      providers: z.array(z.enum(["fixture", "akshare"])),
      akshareOptional: z.literal(true),
    }),
  }),
  dependencies: z.record(z.string(), z.boolean()),
});

export const computeRequestSchema = z.object({
  protocolVersion: z.literal(1),
  requestId: identifierSchema,
  jobId: identifierSchema,
  operation: computeOperationSchema,
  inputPath: z.string().min(1).max(32_768),
  outputDirectory: z.string().min(1).max(32_768),
  options: z.record(z.string(), z.unknown()).default({}),
});

export const computeResponseSchema = z.object({
  protocolVersion: z.literal(1),
  requestId: identifierSchema,
  status: z.enum(["completed", "failed"]),
  recordsFile: z.string().nullable(),
  artifacts: z.array(
    z.object({
      path: z.string(),
      mediaType: z.string(),
      checksum: z.string(),
      size: z.number().int().nonnegative(),
    }),
  ),
  metrics: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
});

export type AgentWorkerCommand = z.infer<typeof agentWorkerCommandSchema>;
export type AgentWorkerMessage = z.infer<typeof agentWorkerMessageSchema>;
export type ModelGatewayAccess = z.infer<typeof modelGatewayAccessSchema>;
export type ComputeOperation = z.infer<typeof computeOperationSchema>;
export type ComputeWorkerHealth = z.infer<typeof computeWorkerHealthSchema>;
export type ComputeRequest = z.infer<typeof computeRequestSchema>;
export type ComputeResponse = z.infer<typeof computeResponseSchema>;
