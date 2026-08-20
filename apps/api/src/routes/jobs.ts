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
  compactSessionRequestSchema,
  compareMemoVersionsQuerySchema,
  compareValuationVersionsQuerySchema,
  createTrackingWatchRuleRequestSchema,
  createValuationAgentAnalysisRequestSchema,
  createValuationWatchRuleRequestSchema,
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
  listJobsQuerySchema,
  listGlobalUploadBatchesQuerySchema,
  listGlobalUploadItemsQuerySchema,
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
  sendMessageRequestSchema,
  sessionResourceIdSchema,
  SESSION_ATTACHMENT_MAX_UPLOAD_BYTES,
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
import {
  SESSION_COOKIE,
  MAX_UPLOAD_BYTES,
  MAX_PROJECT_UPLOAD_FILES,
  MAX_GLOBAL_UPLOAD_FILES,
  loginSchema,
  registrationCodeSchema,
  registrationSchema,
  passwordChangeSchema,
  feedbackSchema,
  paginationQuerySchema,
  evidenceSearchQuerySchema,
  pdfPageNumberSchema,
  routeGlobalUploadBodySchema,
  parseIdentifier,
  parseSourceFolderIdentifier,
  parseGlobalUploadBatchIdentifier,
  parseGlobalUploadItemIdentifier,
  parseSessionResourceIdentifier,
  parseEvidenceIdentifier,
  idempotencyKey,
  sendOpenedFile,
} from "./shared.js";
import type { RouteContext } from "./context.js";

export function registerJobRoutes(ctx: RouteContext): void {
  const {
    app,
    config,
    dependencies,
    setSessionCookie,
    clearSessionCookie,
    disablePrivateCaching,
    requireCloudAccounts,
    requireJobs,
    requireResearch,
    requireSourceFolders,
    requireGlobalUploads,
    requireSessionResources,
    sourceFolderSnapshot,
    requireInsights,
    readCloudSession,
    freshCloudSession,
    proxyCloudJson,
    tenantFor,
    tenantAndModelAccessFor,
  } = ctx;
  void app; void config; void dependencies;
  void setSessionCookie; void clearSessionCookie; void disablePrivateCaching;
  void requireCloudAccounts; void requireJobs; void requireResearch;
  void requireSourceFolders; void requireGlobalUploads; void requireSessionResources;
  void sourceFolderSnapshot; void requireInsights;
  void readCloudSession; void freshCloudSession; void proxyCloudJson;
  void tenantFor; void tenantAndModelAccessFor;

  app.get("/v1/jobs", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const query = listJobsQuerySchema.parse(request.query);
    return {
      jobs: await requireJobs().list(tenant, query),
    };
  });

  app.post("/v1/jobs", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const input = enqueueJobRequestSchema.parse(request.body);
    const result = await requireJobs().enqueue(tenant, input);
    return reply.status(result.created ? 201 : 200).send(result);
  });

  app.get<{ Params: { jobId: string } }>(
    "/v1/jobs/:jobId",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const jobId = parseIdentifier(request.params.jobId, "job id");
      const job = await requireJobs().get(tenant, jobId);
      if (job === null) {
        throw new DomainError("Job not found", "not_found", 404);
      }
      return job;
    },
  );

  app.post<{ Params: { jobId: string } }>(
    "/v1/jobs/:jobId/cancel",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const jobId = parseIdentifier(request.params.jobId, "job id");
      const job = await requireJobs().cancel(tenant, jobId);
      if (job === null) {
        throw new DomainError("Job not found", "not_found", 404);
      }
      return job;
    },
  );
}
