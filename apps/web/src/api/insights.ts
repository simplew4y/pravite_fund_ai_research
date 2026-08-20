import { z } from "zod";

import { query, request, requestJson } from "./http";

/**
 * The tracking/valuation overview payloads are produced by the insights store
 * and are not (yet) covered by @private-fund/contracts, so we validate the
 * envelope loosely and read fields defensively.
 */
const looseRecord = z.record(z.string(), z.unknown());
const looseList = z.array(looseRecord);

function pageItems(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return looseList.parse(value);
  if (value !== null && typeof value === "object" && "items" in value) {
    return looseList.parse((value as { items: unknown }).items);
  }
  return [];
}

export interface TrackingOverview {
  items: Record<string, unknown>[];
  alerts: Record<string, unknown>[];
  memoVersions: Record<string, unknown>[];
  watchRules: Record<string, unknown>[];
  raw: Record<string, unknown>;
}

export async function fetchTracking(projectId: string): Promise<TrackingOverview> {
  const raw = await requestJson(`/v1/projects/${projectId}/tracking`, looseRecord);
  return {
    items: pageItems(raw.items),
    alerts: pageItems(raw.alerts),
    memoVersions: pageItems(raw.memoVersions),
    watchRules: pageItems(raw.watchRules),
    raw,
  };
}

export interface ValuationOverview {
  series: Record<string, unknown>[];
  alerts: Record<string, unknown>[];
  derivedModels: Record<string, unknown>[];
  analyses: Record<string, unknown>[];
  watchRules: Record<string, unknown>[];
  raw: Record<string, unknown>;
}

export async function fetchValuation(projectId: string): Promise<ValuationOverview> {
  const raw = await requestJson(`/v1/projects/${projectId}/valuation`, looseRecord);
  return {
    series: pageItems(raw.series),
    alerts: pageItems(raw.alerts),
    derivedModels: pageItems(raw.derivedModels),
    analyses: pageItems(raw.analyses),
    watchRules: pageItems(raw.watchRules),
    raw,
  };
}

export function runTracking(projectId: string): Promise<unknown> {
  return requestJson(`/v1/projects/${projectId}/tracking/run`, z.unknown(), {
    method: "POST",
    body: { idempotencyKey: `tracking-${crypto.randomUUID()}` },
  });
}

export function runValuation(projectId: string): Promise<unknown> {
  return requestJson(`/v1/projects/${projectId}/valuation/run`, z.unknown(), {
    method: "POST",
    body: { idempotencyKey: `valuation-${crypto.randomUUID()}` },
  });
}

export async function transitionTrackingAlert(
  projectId: string,
  alertId: string,
  status: string,
): Promise<void> {
  await request(`/v1/projects/${projectId}/tracking/alerts/${alertId}`, {
    method: "PATCH",
    body: { status },
  });
}

const memoSectionChangeSchema = z
  .object({
    sectionKey: z.string(),
    title: z.string().default(""),
    changeType: z.enum(["added", "changed", "not_mentioned", "unchanged"]),
    similarity: z.number().default(0),
    oldContent: z.string().default(""),
    newContent: z.string().default(""),
  })
  .loose();

export type MemoSectionChange = z.infer<typeof memoSectionChangeSchema>;

const memoComparisonSchema = z
  .object({
    fromVersion: looseRecord,
    toVersion: looseRecord,
    sectionChanges: z.array(memoSectionChangeSchema).default([]),
    itemChanges: looseList.default([]),
  })
  .loose();

export type MemoComparison = z.infer<typeof memoComparisonSchema>;

export function compareMemoVersions(
  projectId: string,
  fromVersionId: string,
  toVersionId: string,
): Promise<MemoComparison> {
  return requestJson(
    `/v1/projects/${projectId}/tracking/memos/compare${query({
      fromVersionId,
      toVersionId,
    })}`,
    memoComparisonSchema,
  );
}

export function generateMemo(
  projectId: string,
  instruction: string,
  topic?: string,
): Promise<unknown> {
  return requestJson(`/v1/projects/${projectId}/tracking/memos`, z.unknown(), {
    method: "POST",
    body: {
      idempotencyKey: `memo-${crypto.randomUUID()}`,
      instruction,
      ...(topic ? { topic } : {}),
    },
  });
}

const itemTimelineSchema = z
  .object({
    item: looseRecord,
    versions: looseList.default([]),
    changes: looseList.default([]),
    observations: looseList.default([]),
  })
  .loose();

export type ItemTimeline = z.infer<typeof itemTimelineSchema>;

export function fetchItemTimeline(
  projectId: string,
  itemId: string,
): Promise<ItemTimeline> {
  return requestJson(
    `/v1/projects/${projectId}/tracking/items/${itemId}/timeline`,
    itemTimelineSchema,
  );
}

/** Watch rules have no DELETE — deactivation is PATCH { active: false }. */
export function updateTrackingWatchRule(
  projectId: string,
  ruleId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return requestJson(
    `/v1/projects/${projectId}/tracking/watch-rules/${ruleId}`,
    looseRecord,
    { method: "PATCH", body: patch },
  );
}

export function createTrackingWatchRule(input: {
  projectId: string;
  name: string;
  targetType: string;
  minPriority?: string;
}): Promise<Record<string, unknown>> {
  return requestJson(
    `/v1/projects/${input.projectId}/tracking/watch-rules`,
    looseRecord,
    {
      method: "POST",
      body: {
        name: input.name,
        targetType: input.targetType,
        ...(input.minPriority ? { minPriority: input.minPriority } : {}),
      },
    },
  );
}

// ---- Valuation deep ----

export function listValuationVersions(
  projectId: string,
  seriesId: string,
  limit = 100,
): Promise<Record<string, unknown>[]> {
  return requestJson(
    `/v1/projects/${projectId}/valuation/series/${seriesId}/versions${query({ limit })}`,
    looseRecord,
  ).then((raw) => pageItems(raw.items ?? raw));
}

const valuationComparisonSchema = z
  .object({
    fromVersion: looseRecord,
    toVersion: looseRecord,
    changes: looseList.default([]),
  })
  .loose();

export type ValuationComparison = z.infer<typeof valuationComparisonSchema>;

export function compareValuationVersions(
  projectId: string,
  seriesId: string,
  fromVersionId: string,
  toVersionId: string,
): Promise<ValuationComparison> {
  return requestJson(
    `/v1/projects/${projectId}/valuation/series/${seriesId}/compare${query({
      fromVersionId,
      toVersionId,
    })}`,
    valuationComparisonSchema,
  );
}

export function createValuationAnalysis(
  projectId: string,
  seriesId: string,
  baseModelVersionId: string,
  comparisonModelVersionId?: string,
): Promise<Record<string, unknown>> {
  return requestJson(
    `/v1/projects/${projectId}/valuation/series/${seriesId}/analyses`,
    looseRecord,
    {
      method: "POST",
      body: {
        idempotencyKey: `analysis-${crypto.randomUUID()}`,
        baseModelVersionId,
        ...(comparisonModelVersionId ? { comparisonModelVersionId } : {}),
      },
    },
  );
}

export function deriveValuationModel(
  projectId: string,
  analysisId: string,
): Promise<Record<string, unknown>> {
  return requestJson(
    `/v1/projects/${projectId}/valuation/analyses/${analysisId}/derive`,
    looseRecord,
    { method: "POST", body: { idempotencyKey: `derive-${crypto.randomUUID()}` } },
  );
}

export function addDerivedModelToResources(
  projectId: string,
  derivedModelId: string,
): Promise<Record<string, unknown>> {
  return requestJson(
    `/v1/projects/${projectId}/valuation/derived-models/${derivedModelId}/resources`,
    looseRecord,
    { method: "POST", body: { idempotencyKey: `derived-res-${crypto.randomUUID()}` } },
  );
}

export function derivedModelDownloadUrl(
  projectId: string,
  derivedModelId: string,
): string {
  return `/v1/projects/${projectId}/valuation/derived-models/${derivedModelId}/download`;
}

export async function transitionValuationAlert(
  projectId: string,
  alertId: string,
  status: string,
): Promise<void> {
  await request(`/v1/projects/${projectId}/valuation/alerts/${alertId}`, {
    method: "PATCH",
    body: { status },
  });
}

export function updateValuationWatchRule(
  projectId: string,
  ruleId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return requestJson(
    `/v1/projects/${projectId}/valuation/watch-rules/${ruleId}`,
    looseRecord,
    { method: "PATCH", body: patch },
  );
}

export function memoPreviewUrl(projectId: string, memoVersionId: string): string {
  return `/v1/projects/${projectId}/tracking/memos/${memoVersionId}/preview`;
}

export function memoDownloadUrl(projectId: string, memoVersionId: string): string {
  return `/v1/projects/${projectId}/tracking/memos/${memoVersionId}/download`;
}

export async function addDocumentToSession(
  sessionId: string,
  documentId: string,
): Promise<void> {
  await request(`/v1/sessions/${sessionId}/resources/document-references`, {
    method: "POST",
    body: { documentId },
  });
}
