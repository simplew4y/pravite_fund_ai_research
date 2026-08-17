import { z } from "zod";

import { identifierSchema } from "./api.js";

export const trackingItemTypeSchema = z.enum([
  "thesis",
  "assumption",
  "risk",
  "catalyst",
  "metric",
  "question",
]);

export const trackingAlertStatusSchema = z.enum([
  "new",
  "acknowledged",
  "dismissed",
  "snoozed",
]);

export const trackingPrioritySchema = z.enum([
  "low",
  "medium",
  "high",
  "critical",
]);

export const trackingPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listTrackingItemsQuerySchema = trackingPageQuerySchema.extend({
  itemType: trackingItemTypeSchema.optional(),
  status: z.string().trim().min(1).max(100).optional(),
});

export const listTrackingAlertsQuerySchema = trackingPageQuerySchema.extend({
  status: trackingAlertStatusSchema.optional(),
});

export const listMemoVersionsQuerySchema = trackingPageQuerySchema.extend({
  seriesId: identifierSchema.optional(),
});

export const compareMemoVersionsQuerySchema = z
  .object({
    fromVersionId: identifierSchema,
    toVersionId: identifierSchema,
  })
  .strict();

export const createTrackingWatchRuleRequestSchema = z
  .object({
    ruleId: identifierSchema.optional(),
    name: z.string().trim().min(1).max(500),
    targetType: trackingItemTypeSchema.or(z.literal("all")),
    targetItemId: identifierSchema.nullable().optional(),
    query: z.record(z.string(), z.unknown()).default({}),
    minPriority: trackingPrioritySchema.default("medium"),
    frequency: z.string().trim().min(1).max(100).default("on_ingest"),
    active: z.boolean().default(true),
  })
  .strict();

export const updateTrackingWatchRuleRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(500).optional(),
    targetType: trackingItemTypeSchema.or(z.literal("all")).optional(),
    targetItemId: identifierSchema.nullable().optional(),
    query: z.record(z.string(), z.unknown()).optional(),
    minPriority: trackingPrioritySchema.optional(),
    frequency: z.string().trim().min(1).max(100).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one watch-rule field is required",
  });

export const transitionTrackingAlertRequestSchema = z
  .object({
    status: trackingAlertStatusSchema,
    snoozedUntil: z.iso.datetime().nullable().optional(),
  })
  .strict();

export const runTrackingScanRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(500),
    includeHistory: z.boolean().default(false),
  })
  .strict();

export const generateMemoRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(500),
    instruction: z.string().trim().min(1).max(20_000),
    topic: z.string().trim().min(1).max(500).optional(),
    title: z.string().trim().min(1).max(500).optional(),
    evidenceIds: z.array(z.string().min(3).max(240)).max(1_000).optional(),
  })
  .strict();

export type TrackingItemType = z.infer<typeof trackingItemTypeSchema>;
export type TrackingAlertStatus = z.infer<typeof trackingAlertStatusSchema>;
export type TrackingPriority = z.infer<typeof trackingPrioritySchema>;
export type TrackingPageQuery = z.infer<typeof trackingPageQuerySchema>;
export type ListTrackingItemsQuery = z.infer<
  typeof listTrackingItemsQuerySchema
>;
export type ListTrackingAlertsQuery = z.infer<
  typeof listTrackingAlertsQuerySchema
>;
export type ListMemoVersionsQuery = z.infer<
  typeof listMemoVersionsQuerySchema
>;
export type CompareMemoVersionsQuery = z.infer<
  typeof compareMemoVersionsQuerySchema
>;
export type CreateTrackingWatchRuleRequest = z.infer<
  typeof createTrackingWatchRuleRequestSchema
>;
export type UpdateTrackingWatchRuleRequest = z.infer<
  typeof updateTrackingWatchRuleRequestSchema
>;
export type TransitionTrackingAlertRequest = z.infer<
  typeof transitionTrackingAlertRequestSchema
>;
export type RunTrackingScanRequest = z.infer<
  typeof runTrackingScanRequestSchema
>;
export type GenerateMemoRequest = z.infer<
  typeof generateMemoRequestSchema
>;
export const memoArtifactFormatSchema = z.enum([
  "markdown",
  "html",
  "pdf",
]);

export const memoArtifactQuerySchema = z
  .object({
    format: memoArtifactFormatSchema.optional(),
  })
  .strict();

export type MemoArtifactFormat = z.infer<
  typeof memoArtifactFormatSchema
>;
export type MemoArtifactQuery = z.infer<typeof memoArtifactQuerySchema>;
