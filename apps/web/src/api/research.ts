import {
  documentTextPreviewSchema,
  excelSourcePayloadSchema,
  pdfSourcePageSchema,
  researchDocumentVersionSchema,
  researchEvidenceTraceSchema,
  type DocumentTextPreview,
  type ExcelSourcePayload,
  type PdfSourcePage,
  type ResearchDocumentVersion,
  type ResearchEvidenceTrace,
} from "@private-fund/contracts";
import { z } from "zod";

import { query, requestJson } from "./http";

export type {
  DocumentTextPreview,
  ExcelSourcePayload,
  PdfSourcePage,
  ResearchDocumentVersion,
  ResearchEvidenceTrace,
};

/** Evidence ids contain colons (chunk:…, cell:…) — always URL-encode them. */
function evidencePath(projectId: string, evidenceId: string): string {
  return `/v1/projects/${projectId}/evidence/${encodeURIComponent(evidenceId)}`;
}

const evidenceSearchPageSchema = z
  .object({
    items: z.array(
      z.object({ evidence: researchEvidenceTraceSchema, score: z.number() }),
    ),
    total: z.number(),
    hasMore: z.boolean(),
  })
  .loose();

export type EvidenceSearchPage = z.infer<typeof evidenceSearchPageSchema>;

export function searchEvidence(
  projectId: string,
  q: string,
  limit = 20,
): Promise<EvidenceSearchPage> {
  return requestJson(
    `/v1/projects/${projectId}/evidence/search${query({ q, limit })}`,
    evidenceSearchPageSchema,
  );
}

export function fetchEvidence(
  projectId: string,
  evidenceId: string,
): Promise<ResearchEvidenceTrace> {
  return requestJson(evidencePath(projectId, evidenceId), researchEvidenceTraceSchema);
}

export function fetchPdfSourcePage(
  projectId: string,
  evidenceId: string,
  pageNumber: number,
  quote?: string,
): Promise<PdfSourcePage> {
  return requestJson(
    `${evidencePath(projectId, evidenceId)}/source/pdf/pages/${String(pageNumber)}${query(
      { quote: quote?.slice(0, 1200) },
    )}`,
    pdfSourcePageSchema,
  );
}

export function fetchExcelSource(
  projectId: string,
  evidenceId: string,
  options: { sheetName?: string; rangeRef?: string } = {},
): Promise<ExcelSourcePayload> {
  return requestJson(
    `${evidencePath(projectId, evidenceId)}/source/excel${query(options)}`,
    excelSourcePayloadSchema,
  );
}

export function evidenceDownloadUrl(projectId: string, evidenceId: string): string {
  return `${evidencePath(projectId, evidenceId)}/download`;
}

// ---- Documents ----

export function fetchDocumentTextPreview(
  projectId: string,
  documentId: string,
  versionId?: string,
): Promise<DocumentTextPreview> {
  return requestJson(
    `/v1/projects/${projectId}/documents/${documentId}/text-preview${query({ versionId })}`,
    documentTextPreviewSchema,
  );
}

function page<Schema extends z.ZodType>(item: Schema) {
  return z
    .object({
      items: z.array(item),
      total: z.number(),
      hasMore: z.boolean(),
    })
    .loose();
}

export function listDocumentVersions(
  projectId: string,
  documentId: string,
): Promise<ResearchDocumentVersion[]> {
  return requestJson(
    `/v1/projects/${projectId}/documents/${documentId}/versions${query({ limit: 100 })}`,
    page(researchDocumentVersionSchema),
  ).then((result) => result.items);
}

export function documentDownloadUrl(
  projectId: string,
  documentId: string,
  versionId?: string,
): string {
  return `/v1/projects/${projectId}/documents/${documentId}/download${query({ versionId })}`;
}
