import { z } from "zod";

import { identifierSchema } from "./api.js";
import { jobStatusSchema, jobTypeSchema } from "./jobs.js";

export const AGENT_TOOL_PROTOCOL_VERSION = 1 as const;
export const AGENT_TOOL_MAX_WIRE_BYTES = 1_048_576;
export const AGENT_TOOL_MAX_RESULT_TEXT = 200_000;

export const agentToolNameSchema = z.enum([
  "workspace.list",
  "workspace.read",
  "workspace.search",
  "workspace.write",
  "evidence.search",
  "evidence.get",
  "job.enqueue",
  "job.get",
]);

export const agentToolErrorCodeSchema = z.enum([
  "forbidden",
  "not_found",
  "invalid_request",
  "conflict",
  "rate_limited",
  "unavailable",
  "internal",
  "cancelled",
]);

export const workspaceCollectionSchema = z.enum([
  "sources",
  "research",
  "reports",
  "models",
]);

export const workspaceWritableCollectionSchema = z.enum([
  "research",
  "notes",
]);

export const workspaceResourceKindSchema = z.enum([
  "document",
  "folder",
  "note",
  "research_asset",
  "report",
  "model",
]);

export const agentCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._:=-]+$/);

export const workspaceListArgumentsSchema = z
  .object({
    collection: workspaceCollectionSchema,
    parentId: identifierSchema.optional(),
    cursor: agentCursorSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const workspaceReadArgumentsSchema = z
  .object({
    resourceId: identifierSchema,
    offset: z.number().int().min(0).max(10_000_000).optional(),
    maxCharacters: z.number().int().min(1).max(50_000).optional(),
  })
  .strict();

export const workspaceSearchArgumentsSchema = z
  .object({
    query: z.string().trim().min(1).max(4_000),
    collections: z
      .array(workspaceCollectionSchema)
      .min(1)
      .max(4)
      .optional(),
    cursor: agentCursorSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const workspaceWriteArgumentsSchema = z
  .object({
    collection: workspaceWritableCollectionSchema,
    resourceId: identifierSchema.optional(),
    title: z.string().trim().min(1).max(300),
    content: z.string().max(200_000),
    expectedVersion: identifierSchema.optional(),
    idempotencyKey: identifierSchema,
  })
  .strict();

export const evidenceTypeSchema = z.enum(["chunk", "fact", "cell"]);
export const evidenceIdSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[^\u0000-\u001F\u007F/\\]+$/);

export const evidenceSearchArgumentsSchema = z
  .object({
    query: z.string().trim().min(1).max(4_000),
    documentIds: z.array(identifierSchema).max(100).optional(),
    evidenceTypes: z.array(evidenceTypeSchema).min(1).max(3).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export const evidenceGetArgumentsSchema = z
  .object({
    evidenceIds: z.array(evidenceIdSchema).min(1).max(100),
  })
  .strict();

export const agentJobFormatSchema = z.enum([
  "markdown",
  "pdf",
  "xlsx",
  "json",
]);

export const jobEnqueueArgumentsSchema = z
  .object({
    type: jobTypeSchema,
    sourceIds: z.array(identifierSchema).max(100).optional(),
    instruction: z.string().trim().min(1).max(20_000).optional(),
    outputFormat: agentJobFormatSchema.optional(),
    idempotencyKey: identifierSchema,
  })
  .strict();

export const jobGetArgumentsSchema = z
  .object({
    jobId: identifierSchema,
  })
  .strict();

export const workspaceResourceSummarySchema = z
  .object({
    resourceId: identifierSchema,
    name: z.string().min(1).max(500),
    kind: workspaceResourceKindSchema,
    version: identifierSchema.nullable(),
    size: z.number().int().nonnegative().nullable(),
    updatedAt: z.iso.datetime().nullable(),
  })
  .strict();

export const workspaceListResultSchema = z
  .object({
    items: z.array(workspaceResourceSummarySchema).max(100),
    nextCursor: agentCursorSchema.nullable(),
  })
  .strict();

export const workspaceReadResultSchema = z
  .object({
    resourceId: identifierSchema,
    name: z.string().min(1).max(500),
    content: z.string().max(AGENT_TOOL_MAX_RESULT_TEXT),
    version: identifierSchema,
    mediaType: z.string().min(1).max(200).nullable(),
    truncated: z.boolean(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const workspaceSearchHitSchema = z
  .object({
    resourceId: identifierSchema,
    name: z.string().min(1).max(500),
    kind: workspaceResourceKindSchema,
    snippet: z.string().max(8_000),
    score: z.number().min(0).max(1).nullable(),
  })
  .strict();

export const workspaceSearchResultSchema = z
  .object({
    hits: z.array(workspaceSearchHitSchema).max(100),
    nextCursor: agentCursorSchema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    const characters = result.hits.reduce(
      (total, hit) => total + hit.snippet.length,
      0,
    );
    if (characters > AGENT_TOOL_MAX_RESULT_TEXT) {
      context.addIssue({
        code: "custom",
        message: `Search snippets exceed ${AGENT_TOOL_MAX_RESULT_TEXT} characters`,
        path: ["hits"],
      });
    }
  });

export const workspaceWriteResultSchema = z
  .object({
    resourceId: identifierSchema,
    version: identifierSchema,
    created: z.boolean(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const evidenceLocatorSchema = z
  .object({
    page: z.number().int().positive().nullable(),
    sheet: z.string().max(300).nullable(),
    cellRange: z.string().max(100).nullable(),
    section: z.string().max(500).nullable(),
  })
  .strict();

export const evidenceSearchHitSchema = z
  .object({
    evidenceId: evidenceIdSchema,
    documentId: identifierSchema,
    type: evidenceTypeSchema,
    excerpt: z.string().max(8_000),
    score: z.number().min(0).max(1).nullable(),
    locator: evidenceLocatorSchema,
  })
  .strict();

export const evidenceSearchResultSchema = z
  .object({
    hits: z.array(evidenceSearchHitSchema).max(50),
  })
  .strict()
  .superRefine((result, context) => {
    const characters = result.hits.reduce(
      (total, hit) => total + hit.excerpt.length,
      0,
    );
    if (characters > AGENT_TOOL_MAX_RESULT_TEXT) {
      context.addIssue({
        code: "custom",
        message: `Evidence excerpts exceed ${AGENT_TOOL_MAX_RESULT_TEXT} characters`,
        path: ["hits"],
      });
    }
  });

export const evidenceDetailSchema = z
  .object({
    evidenceId: evidenceIdSchema,
    documentId: identifierSchema,
    type: evidenceTypeSchema,
    content: z.string().max(50_000),
    locator: evidenceLocatorSchema,
    version: identifierSchema,
  })
  .strict();

export const evidenceGetResultSchema = z
  .object({
    items: z.array(evidenceDetailSchema).max(100),
  })
  .strict()
  .superRefine((result, context) => {
    const characters = result.items.reduce(
      (total, item) => total + item.content.length,
      0,
    );
    if (characters > AGENT_TOOL_MAX_RESULT_TEXT) {
      context.addIssue({
        code: "custom",
        message: `Evidence content exceeds ${AGENT_TOOL_MAX_RESULT_TEXT} characters`,
        path: ["items"],
      });
    }
  });

export const jobEnqueueResultSchema = z
  .object({
    jobId: identifierSchema,
    status: jobStatusSchema,
  })
  .strict();

export const jobGetResultSchema = z
  .object({
    jobId: identifierSchema,
    type: jobTypeSchema,
    status: jobStatusSchema,
    progress: z.number().min(0).max(1).nullable(),
    resultSummary: z.string().max(20_000).nullable(),
    error: z.string().max(4_000).nullable(),
  })
  .strict();

export const agentToolArgumentsSchemas = {
  "workspace.list": workspaceListArgumentsSchema,
  "workspace.read": workspaceReadArgumentsSchema,
  "workspace.search": workspaceSearchArgumentsSchema,
  "workspace.write": workspaceWriteArgumentsSchema,
  "evidence.search": evidenceSearchArgumentsSchema,
  "evidence.get": evidenceGetArgumentsSchema,
  "job.enqueue": jobEnqueueArgumentsSchema,
  "job.get": jobGetArgumentsSchema,
} as const;

export const agentToolResultSchemas = {
  "workspace.list": workspaceListResultSchema,
  "workspace.read": workspaceReadResultSchema,
  "workspace.search": workspaceSearchResultSchema,
  "workspace.write": workspaceWriteResultSchema,
  "evidence.search": evidenceSearchResultSchema,
  "evidence.get": evidenceGetResultSchema,
  "job.enqueue": jobEnqueueResultSchema,
  "job.get": jobGetResultSchema,
} as const;

function addNestedIssues(
  context: z.core.$RefinementCtx<unknown>,
  prefix: PropertyKey[],
  issues: readonly z.core.$ZodIssue[],
): void {
  for (const issue of issues) {
    context.addIssue({
      code: "custom",
      message: issue.message,
      path: [...prefix, ...issue.path],
    });
  }
}

/**
 * Child-to-parent tool request.
 *
 * `sessionId` is a routing key, not an authorization claim. The parent must
 * resolve the authenticated tenant and project from its own session registry.
 * Tool arguments intentionally contain no tenant, project, filesystem path,
 * URL, provider, or MCP-server fields.
 */
export const agentToolRequestMessageSchema = z
  .object({
    type: z.literal("tool.request"),
    protocolVersion: z.literal(AGENT_TOOL_PROTOCOL_VERSION),
    requestId: identifierSchema,
    sessionId: identifierSchema,
    toolCallId: identifierSchema,
    tool: agentToolNameSchema,
    arguments: z.record(z.string(), z.unknown()),
    deadlineAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((message, context) => {
    const parsed =
      agentToolArgumentsSchemas[message.tool].safeParse(message.arguments);
    if (!parsed.success) {
      addNestedIssues(context, ["arguments"], parsed.error.issues);
    }
  });

export const agentToolCancelMessageSchema = z
  .object({
    type: z.literal("tool.cancel"),
    protocolVersion: z.literal(AGENT_TOOL_PROTOCOL_VERSION),
    requestId: identifierSchema,
    sessionId: identifierSchema,
    toolCallId: identifierSchema,
    reason: z.enum([
      "timeout",
      "aborted",
      "session_disposed",
      "worker_shutdown",
    ]),
  })
  .strict();

export const agentToolRemoteErrorSchema = z
  .object({
    code: agentToolErrorCodeSchema,
    message: z.string().min(1).max(4_000),
    retryable: z.boolean(),
  })
  .strict();

export const agentToolResultCommandSchema = z
  .object({
    type: z.literal("tool.result"),
    protocolVersion: z.literal(AGENT_TOOL_PROTOCOL_VERSION),
    requestId: identifierSchema,
    sessionId: identifierSchema,
    toolCallId: identifierSchema,
    tool: agentToolNameSchema,
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: agentToolRemoteErrorSchema.optional(),
  })
  .strict()
  .superRefine((message, context) => {
    if (message.ok) {
      if (message.error !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Successful tool result cannot include error",
          path: ["error"],
        });
      }
      if (message.result === undefined) {
        context.addIssue({
          code: "custom",
          message: "Successful tool result must include result",
          path: ["result"],
        });
        return;
      }
      const parsed =
        agentToolResultSchemas[message.tool].safeParse(message.result);
      if (!parsed.success) {
        addNestedIssues(context, ["result"], parsed.error.issues);
      }
      return;
    }

    if (message.result !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Failed tool result cannot include result",
        path: ["result"],
      });
    }
    if (message.error === undefined) {
      context.addIssue({
        code: "custom",
        message: "Failed tool result must include error",
        path: ["error"],
      });
    }
  });

export type AgentToolName = z.infer<typeof agentToolNameSchema>;
export type AgentToolRequestMessage = z.infer<
  typeof agentToolRequestMessageSchema
>;
export type AgentToolCancelMessage = z.infer<
  typeof agentToolCancelMessageSchema
>;
export type AgentToolResultCommand = z.infer<
  typeof agentToolResultCommandSchema
>;
export type AgentToolRemoteError = z.infer<
  typeof agentToolRemoteErrorSchema
>;
export type WorkspaceListArguments = z.infer<
  typeof workspaceListArgumentsSchema
>;
export type WorkspaceReadArguments = z.infer<
  typeof workspaceReadArgumentsSchema
>;
export type WorkspaceSearchArguments = z.infer<
  typeof workspaceSearchArgumentsSchema
>;
export type WorkspaceWriteArguments = z.infer<
  typeof workspaceWriteArgumentsSchema
>;
export type WorkspaceResourceKind = z.infer<
  typeof workspaceResourceKindSchema
>;
export type EvidenceSearchArguments = z.infer<
  typeof evidenceSearchArgumentsSchema
>;
export type EvidenceGetArguments = z.infer<
  typeof evidenceGetArgumentsSchema
>;
export type JobEnqueueArguments = z.infer<typeof jobEnqueueArgumentsSchema>;
export type JobGetArguments = z.infer<typeof jobGetArgumentsSchema>;
