// Shared module-scope helpers extracted verbatim from app.ts.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { z } from "zod";

import {
  addDerivedModelToResourcesRequestSchema,
  assignSourceFolderDocumentRequestSchema,
  createSessionDocumentReferenceResourceRequestSchema,
  createSessionResearchAssetResourceRequestSchema,
  createProjectRequestSchema,
  createSessionRequestSchema,
  createSourceFolderRequestSchema,
  completeWorkflowNodeRequestSchema,
  compactSessionRequestSchema,
  compareMemoVersionsQuerySchema,
  compareValuationVersionsQuerySchema,
  createTrackingWatchRuleRequestSchema,
  createValuationAgentAnalysisRequestSchema,
  createValuationWatchRuleRequestSchema,
  createWorkflowAssumptionRequestSchema,
  createWorkflowReportRequestSchema,
  deleteResearchAssetsRequestSchema,
  deleteResearchDocumentsRequestSchema,
  deriveValuationModelRequestSchema,
  documentFileQuerySchema,
  documentTextPreviewQuerySchema,
  enqueueJobRequestSchema,
  evidenceIdSchema,
  excelSourceQuerySchema,
  forkSessionRequestSchema,
  generateMemoRequestSchema,
  globalUploadBatchIdSchema,
  globalUploadItemIdSchema,
  identifierSchema,
  initializeWorkflowRequestSchema,
  listJobsQuerySchema,
  listGlobalUploadBatchesQuerySchema,
  listGlobalUploadItemsQuerySchema,
  listWorkflowAssumptionsQuerySchema,
  listSessionAttachmentsQuerySchema,
  listSessionResourcesQuerySchema,
  listMemoVersionsQuerySchema,
  memoArtifactQuerySchema,
  pdfSourcePageQuerySchema,
  listSessionChildrenQuerySchema,
  listSessionsQuerySchema,
  listTrackingAlertsQuerySchema,
  listTrackingItemsQuerySchema,
  listValuationAlertsQuerySchema,
  listValuationResourcesQuerySchema,
  registerDocumentVersionRequestSchema,
  researchEvidenceKindSchema,
  runTrackingScanRequestSchema,
  runValuationTrackingRequestSchema,
  saveResearchAssetRequestSchema,
  selectWorkflowNodeRequestSchema,
  sendMessageRequestSchema,
  sessionResourceIdSchema,
  SESSION_ATTACHMENT_MAX_UPLOAD_BYTES,
  setWorkflowContextRequestSchema,
  startWorkflowNodeRequestSchema,
  steerSessionRequestSchema,
  sourceFolderIdSchema,
  type SessionEvent,
  trackingPageQuerySchema,
  transitionTrackingAlertRequestSchema,
  transitionValuationAlertRequestSchema,
  updateResearchAssetContextRequestSchema,
  updateResearchAssetLifecycleRequestSchema,
  updateSessionRequestSchema,
  updateSourceFolderRequestSchema,
  updateTrackingWatchRuleRequestSchema,
  updateValuationWatchRuleRequestSchema,
  valuationPageQuerySchema,
} from "@private-fund/contracts";
import {
  buildTenantContext,
  DomainError,
  type TenantContext,
} from "@private-fund/core";
import { CloudAccountError } from "@private-fund/auth";

import type { ApiConfig } from "../config.js";
import type { ApiDependencies } from "../dependencies.js";
import {
  contentDisposition,
  parseSingleByteRange,
  type OpenedFileResource,
} from "../secure-files.js";
import { writeSseComment, writeSseEvent } from "../sse.js";
import { registerWebUi } from "../web-ui.js";

export const SESSION_COOKIE = "pf_cloud_session";
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
export const MAX_PROJECT_UPLOAD_FILES = 4;
export const MAX_GLOBAL_UPLOAD_FILES = 20;

export const loginSchema = z.object({
  email: z.string().trim().pipe(z.email()),
  password: z.string().min(1).max(10_000),
});

export const registrationCodeSchema = z.object({
  email: z.string().trim().pipe(z.email()),
});

export const registrationSchema = z.object({
  email: z.string().trim().pipe(z.email()),
  code: z.string().regex(/^\d{4}$/),
  password: z.string().min(8).max(10_000),
  nick_name: z.string().trim().max(120).nullable().optional(),
});

export const passwordChangeSchema = z.object({
  old_password: z.string().min(1).max(10_000),
  new_password: z.string().min(8).max(10_000),
});

export const feedbackSchema = z.object({
  feedback_type: z.string().trim().min(1).max(32),
  title: z.string().trim().min(2).max(240),
  content: z.string().trim().min(2).max(20_000),
  rating: z.number().int().min(1).max(5).nullable().default(null),
  contact_allowed: z.boolean().default(true),
  client_platform: z.string().max(32).nullable().default(null),
  client_version: z.string().max(64).nullable().default(null),
});

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const evidenceSearchQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().min(1).max(4_000),
  kinds: z.string().max(200).optional(),
  include_historical: z
    .enum(["0", "1", "false", "true"])
    .default("0"),
});

export const pdfPageNumberSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(1_000_000);

export const routeGlobalUploadBodySchema = z
  .object({
    projectId: identifierSchema,
    idempotencyKey: z.string().trim().min(1).max(500),
  })
  .strict();

export function parseIdentifier(value: unknown, label: string): string {
  const parsed = identifierSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError(`Invalid ${label}`, "invalid_identifier", 400);
  }
  return parsed.data;
}

export function parseSourceFolderIdentifier(value: unknown): string {
  const parsed = sourceFolderIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError(
      "Invalid source folder id",
      "invalid_identifier",
      400,
    );
  }
  return parsed.data;
}

export function parseGlobalUploadBatchIdentifier(value: unknown): string {
  const parsed = globalUploadBatchIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError(
      "Invalid global upload batch id",
      "invalid_identifier",
      400,
    );
  }
  return parsed.data;
}

export function parseGlobalUploadItemIdentifier(value: unknown): string {
  const parsed = globalUploadItemIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError(
      "Invalid global upload item id",
      "invalid_identifier",
      400,
    );
  }
  return parsed.data;
}

export function parseSessionResourceIdentifier(value: unknown): string {
  const parsed = sessionResourceIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError(
      "Invalid session resource id",
      "invalid_identifier",
      400,
    );
  }
  return parsed.data;
}

export function parseEvidenceIdentifier(value: unknown): string {
  const parsed = evidenceIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError(
      "Invalid evidence id",
      "invalid_identifier",
      400,
    );
  }
  return parsed.data;
}

export function idempotencyKey(request: FastifyRequest): string {
  const raw = request.headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value.trim().length === 0) {
    throw new DomainError(
      "Idempotency-Key header is required",
      "idempotency_key_required",
      400,
    );
  }
  const parsed = z.string().trim().min(1).max(500).safeParse(value);
  if (!parsed.success) {
    throw new DomainError(
      "Idempotency-Key header is invalid",
      "invalid_idempotency_key",
      400,
    );
  }
  return parsed.data;
}

export async function sendOpenedFile(
  request: FastifyRequest,
  reply: FastifyReply,
  resourcePromise: Promise<OpenedFileResource>,
  disposition: "inline" | "attachment",
): Promise<FastifyReply> {
  const resource = await resourcePromise;
  try {
    const ifNoneMatch = request.headers["if-none-match"];
    const normalizedIfNoneMatch = Array.isArray(ifNoneMatch)
      ? ifNoneMatch[0]
      : ifNoneMatch;
    if (normalizedIfNoneMatch === resource.etag) {
      await resource.handle.close();
      return reply
        .header("etag", resource.etag)
        .status(304)
        .send();
    }

    const rawRange = request.headers.range;
    const rangeHeader = Array.isArray(rawRange)
      ? rawRange[0]
      : rawRange;
    const rawIfRange = request.headers["if-range"];
    const ifRange = Array.isArray(rawIfRange)
      ? rawIfRange[0]
      : rawIfRange;
    let range = null;
    if (
      rangeHeader !== undefined &&
      (ifRange === undefined ||
        ifRange === resource.etag ||
        ifRange === resource.lastModified)
    ) {
      try {
        range = parseSingleByteRange(rangeHeader, resource.size);
      } catch (error) {
        reply.header("content-range", `bytes */${String(resource.size)}`);
        throw error;
      }
    }

    const contentLength =
      range === null
        ? resource.size
        : range.end - range.start + 1;
    reply
      .header("accept-ranges", "bytes")
      .header("cache-control", "private, no-store")
      .header(
        "content-disposition",
        contentDisposition(disposition, resource.filename),
      )
      .header("content-length", String(contentLength))
      .header("content-type", resource.mimeType)
      .header("cross-origin-resource-policy", "same-origin")
      .header("etag", resource.etag)
      .header("last-modified", resource.lastModified)
      .header("x-content-type-options", "nosniff");
    if (
      disposition === "inline" &&
      resource.mimeType.toLowerCase().startsWith("text/html")
    ) {
      reply.header("content-security-policy", "sandbox");
    }
    if (range !== null) {
      reply
        .status(206)
        .header(
          "content-range",
          `bytes ${String(range.start)}-${String(range.end)}/${String(
            resource.size,
          )}`,
        );
    }
    if (request.method === "HEAD") {
      await resource.handle.close();
      return reply.send();
    }
    const stream = resource.handle.createReadStream({
      ...(range === null
        ? {}
        : { start: range.start, end: range.end }),
      autoClose: true,
    });
    stream.once("error", () => {
      void resource.handle.close().catch(() => undefined);
    });
    return reply.send(stream);
  } catch (error) {
    await resource.handle.close().catch(() => undefined);
    throw error;
  }
}
