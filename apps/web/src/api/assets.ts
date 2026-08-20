import {
  researchAssetSchema,
  researchAssetVersionSchema,
  sourceFolderAssignmentSchema,
  sourceFolderTreeEntrySchema,
  type ResearchAsset,
  type ResearchAssetVersion,
  type SourceFolderAssignment,
  type SourceFolderTreeEntry,
} from "@private-fund/contracts";
import { z } from "zod";

import { query, request, requestJson } from "./http";

export type {
  ResearchAsset,
  ResearchAssetVersion,
  SourceFolderAssignment,
  SourceFolderTreeEntry,
};

const assetPageSchema = z
  .object({ items: z.array(researchAssetSchema), total: z.number() })
  .loose();

export function listAssets(projectId: string, limit = 100): Promise<ResearchAsset[]> {
  return requestJson(
    `/v1/projects/${projectId}/assets${query({ limit })}`,
    assetPageSchema,
  ).then((result) => result.items);
}

const assetDetailSchema = z
  .object({
    asset: researchAssetSchema,
    version: researchAssetVersionSchema.nullable(),
  })
  .loose();

export type AssetDetail = z.infer<typeof assetDetailSchema>;

export function fetchAsset(projectId: string, assetId: string): Promise<AssetDetail> {
  return requestJson(`/v1/projects/${projectId}/assets/${assetId}`, assetDetailSchema);
}

export async function deleteAssets(
  projectId: string,
  assetIds: string[],
): Promise<void> {
  await request(`/v1/projects/${projectId}/assets/delete`, {
    method: "POST",
    body: { assetIds },
  });
}

export async function addAssetToSession(
  sessionId: string,
  assetId: string,
): Promise<void> {
  await request(`/v1/sessions/${sessionId}/resources/research-assets`, {
    method: "POST",
    body: { assetId },
  });
}

// ---- Source folders ----

const folderSnapshotSchema = z
  .object({
    folders: z.array(sourceFolderTreeEntrySchema),
    assignments: z.array(sourceFolderAssignmentSchema),
  })
  .loose();

export type SourceFolderSnapshot = z.infer<typeof folderSnapshotSchema>;

export function fetchSourceFolders(projectId: string): Promise<SourceFolderSnapshot> {
  return requestJson(`/v1/projects/${projectId}/source-folders`, folderSnapshotSchema);
}

export function createSourceFolder(
  projectId: string,
  name: string,
): Promise<SourceFolderSnapshot> {
  return requestJson(`/v1/projects/${projectId}/source-folders`, folderSnapshotSchema, {
    method: "POST",
    body: { name },
  });
}

export function deleteSourceFolder(
  projectId: string,
  folderId: string,
): Promise<SourceFolderSnapshot> {
  return requestJson(
    `/v1/projects/${projectId}/source-folders/${folderId}`,
    folderSnapshotSchema,
    { method: "DELETE" },
  );
}

export function assignDocumentToFolder(
  projectId: string,
  folderId: string,
  documentId: string,
): Promise<SourceFolderSnapshot> {
  return requestJson(
    `/v1/projects/${projectId}/source-folders/${folderId}/documents`,
    folderSnapshotSchema,
    { method: "POST", body: { documentId } },
  );
}

export function unassignDocumentFromFolder(
  projectId: string,
  folderId: string,
  documentId: string,
): Promise<SourceFolderSnapshot> {
  return requestJson(
    `/v1/projects/${projectId}/source-folders/${folderId}/documents/${documentId}`,
    folderSnapshotSchema,
    { method: "DELETE" },
  );
}
