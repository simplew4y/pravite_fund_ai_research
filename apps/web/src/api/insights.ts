import { z } from "zod";

import { query, request, requestJson } from "./http";

/**
 * Memo pipeline client. The memo payloads come from the insights store and
 * are not (yet) covered by @private-fund/contracts, so we validate loosely
 * and read fields defensively. The wider pre/post-investment features
 * (valuation, tracking, workflow) were removed pending a redesign — see
 * docs/harness_plugin_refactor_plan_20260818.md.
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

export interface MemoVersionList {
  versions: Record<string, unknown>[];
  raw: Record<string, unknown>;
}

export async function fetchMemoVersions(projectId: string): Promise<MemoVersionList> {
  const raw = await requestJson(
    `/v1/projects/${projectId}/tracking/memos${query({ limit: 100 })}`,
    looseRecord,
  );
  return { versions: pageItems(raw.versions), raw };
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
