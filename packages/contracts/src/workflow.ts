import { z } from "zod";

import { evidenceIdSchema } from "./agent-tools.js";
import { identifierSchema } from "./api.js";

export const initializeWorkflowRequestSchema = z
  .object({
    workflowType: z
      .literal("agentic_research_graph_v2")
      .default("agentic_research_graph_v2"),
  })
  .strict();

export const selectWorkflowNodeRequestSchema = z
  .object({
    nodeId: identifierSchema.nullable(),
  })
  .strict();

export const setWorkflowContextRequestSchema = z
  .object({
    nodeIds: z.array(identifierSchema).max(100),
  })
  .strict();

export const startWorkflowNodeRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(500).optional(),
    inputManifest: z.record(z.string(), z.unknown()).default({}),
    promptSnapshot: z.string().max(200_000).nullable().optional(),
    modelName: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

export const completeWorkflowNodeRequestSchema = z
  .object({
    nodeVersionId: identifierSchema.optional(),
    outputMarkdown: z.string().min(1).max(1_000_000),
    structuredOutput: z.record(z.string(), z.unknown()).default({}),
    evidenceIds: z.array(evidenceIdSchema).max(10_000).default([]),
    sourceResponseId: identifierSchema.nullable().optional(),
    modelName: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

export const createWorkflowAssumptionRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(500),
    content: z.string().trim().min(1).max(100_000),
    sourceResponseId: identifierSchema.nullable().optional(),
    evidenceIds: z.array(evidenceIdSchema).max(1_000).default([]),
  })
  .strict();

export const workflowAssumptionStatusSchema = z.enum([
  "active",
  "resolved",
  "dismissed",
]);

export const listWorkflowAssumptionsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    status: workflowAssumptionStatusSchema.optional(),
  })
  .strict();

export const createWorkflowReportRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(500),
    reportType: z.string().trim().min(1).max(120).default("investment_report"),
    title: z.string().trim().min(1).max(500),
    markdown: z.string().min(1).max(2_000_000).optional(),
    nodeVersions: z.record(z.string(), z.unknown()).optional(),
    documentVersions: z.array(z.unknown()).max(10_000).optional(),
  })
  .strict();

export type InitializeWorkflowRequest = z.infer<
  typeof initializeWorkflowRequestSchema
>;
export type SelectWorkflowNodeRequest = z.infer<
  typeof selectWorkflowNodeRequestSchema
>;
export type SetWorkflowContextRequest = z.infer<
  typeof setWorkflowContextRequestSchema
>;
export type StartWorkflowNodeRequest = z.infer<
  typeof startWorkflowNodeRequestSchema
>;
export type CompleteWorkflowNodeRequest = z.infer<
  typeof completeWorkflowNodeRequestSchema
>;
export type CreateWorkflowAssumptionRequest = z.infer<
  typeof createWorkflowAssumptionRequestSchema
>;
export type WorkflowAssumptionStatus = z.infer<
  typeof workflowAssumptionStatusSchema
>;
export type ListWorkflowAssumptionsQuery = z.infer<
  typeof listWorkflowAssumptionsQuerySchema
>;
export type CreateWorkflowReportRequest = z.infer<
  typeof createWorkflowReportRequestSchema
>;
