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
  raw: Record<string, unknown>;
}

export async function fetchTracking(projectId: string): Promise<TrackingOverview> {
  const raw = await requestJson(`/v1/projects/${projectId}/tracking`, looseRecord);
  return {
    items: pageItems(raw.items),
    alerts: pageItems(raw.alerts),
    memoVersions: pageItems(raw.memoVersions),
    raw,
  };
}

export interface ValuationOverview {
  series: Record<string, unknown>[];
  alerts: Record<string, unknown>[];
  derivedModels: Record<string, unknown>[];
  raw: Record<string, unknown>;
}

export async function fetchValuation(projectId: string): Promise<ValuationOverview> {
  const raw = await requestJson(`/v1/projects/${projectId}/valuation`, looseRecord);
  return {
    series: pageItems(raw.series),
    alerts: pageItems(raw.alerts),
    derivedModels: pageItems(raw.derivedModels),
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

export function compareMemoVersions(
  projectId: string,
  fromVersionId: string,
  toVersionId: string,
): Promise<Record<string, unknown>> {
  return requestJson(
    `/v1/projects/${projectId}/tracking/memos/compare${query({
      fromVersionId,
      toVersionId,
    })}`,
    looseRecord,
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
