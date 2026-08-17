import { z } from "zod";

import { identifierSchema } from "./api.js";

export const valuationMaterialitySchema = z.enum([
  "low",
  "medium",
  "high",
  "critical",
]);

export const valuationAlertStatusSchema = z.enum([
  "new",
  "acknowledged",
  "dismissed",
  "snoozed",
]);

export const valuationPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listValuationAlertsQuerySchema = valuationPageQuerySchema.extend({
  status: valuationAlertStatusSchema.optional(),
  seriesId: identifierSchema.optional(),
  alertType: z.string().trim().min(1).max(120).optional(),
});

export const listValuationResourcesQuerySchema =
  valuationPageQuerySchema.extend({
    seriesId: identifierSchema.optional(),
  });

export const compareValuationVersionsQuerySchema = z
  .object({
    fromVersionId: identifierSchema,
    toVersionId: identifierSchema,
  })
  .strict();

export const runValuationTrackingRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(500),
    includeHistory: z.boolean().default(true),
    refreshMarket: z.boolean().default(true),
  })
  .strict();

export const createValuationWatchRuleRequestSchema = z
  .object({
    ruleId: identifierSchema.optional(),
    idempotencyKey: z.string().trim().min(1).max(500).optional(),
    seriesId: identifierSchema.nullable().optional(),
    name: z.string().trim().min(1).max(500),
    minMateriality: valuationMaterialitySchema.default("medium"),
    changeTypes: z
      .array(z.string().trim().min(1).max(120))
      .max(100)
      .default([]),
    active: z.boolean().default(true),
  })
  .strict();

export const updateValuationWatchRuleRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(500).optional(),
    minMateriality: valuationMaterialitySchema.optional(),
    changeTypes: z
      .array(z.string().trim().min(1).max(120))
      .max(100)
      .optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one valuation watch-rule field is required",
  });

export const transitionValuationAlertRequestSchema = z
  .object({
    status: valuationAlertStatusSchema,
    snoozedUntil: z.iso.datetime().nullable().optional(),
  })
  .strict();

export const createValuationAgentAnalysisRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(500),
    baseModelVersionId: identifierSchema,
    comparisonModelVersionId: identifierSchema.nullable().optional(),
    focus: z.string().trim().max(2_000).default(""),
    agentVersion: z.string().trim().min(1).max(120).default("pi-agent-v1"),
  })
  .strict();

export const deriveValuationModelRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(500),
  })
  .strict();

export const addDerivedModelToResourcesRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(500),
  })
  .strict();

export type ValuationMateriality = z.infer<
  typeof valuationMaterialitySchema
>;
export type ValuationAlertStatus = z.infer<
  typeof valuationAlertStatusSchema
>;
export type ValuationPageQuery = z.infer<typeof valuationPageQuerySchema>;
export type ListValuationAlertsQuery = z.infer<
  typeof listValuationAlertsQuerySchema
>;
export type ListValuationResourcesQuery = z.infer<
  typeof listValuationResourcesQuerySchema
>;
export type CompareValuationVersionsQuery = z.infer<
  typeof compareValuationVersionsQuerySchema
>;
export type RunValuationTrackingRequest = z.infer<
  typeof runValuationTrackingRequestSchema
>;
export type CreateValuationWatchRuleRequest = z.infer<
  typeof createValuationWatchRuleRequestSchema
>;
export type UpdateValuationWatchRuleRequest = z.infer<
  typeof updateValuationWatchRuleRequestSchema
>;
export type TransitionValuationAlertRequest = z.infer<
  typeof transitionValuationAlertRequestSchema
>;
export type CreateValuationAgentAnalysisRequest = z.infer<
  typeof createValuationAgentAnalysisRequestSchema
>;
export type DeriveValuationModelRequest = z.infer<
  typeof deriveValuationModelRequestSchema
>;
export type AddDerivedModelToResourcesRequest = z.infer<
  typeof addDerivedModelToResourcesRequestSchema
>;
