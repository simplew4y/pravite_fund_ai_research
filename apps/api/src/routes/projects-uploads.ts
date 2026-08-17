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

export function registerProjectAndUploadRoutes(ctx: RouteContext): void {
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
    requireWorkflow,
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
  void sourceFolderSnapshot; void requireWorkflow; void requireInsights;
  void readCloudSession; void freshCloudSession; void proxyCloudJson;
  void tenantFor; void tenantAndModelAccessFor;

  app.get("/v1/projects", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    return { projects: await dependencies.projects.list(tenant) };
  });

  app.post("/v1/projects", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const input = createProjectRequestSchema.parse(request.body);
    return reply
      .status(201)
      .send(await dependencies.projects.create(tenant, input));
  });

  app.get<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(request.params.projectId, "project id");
      const project = await dependencies.projects.get(tenant, projectId);
      if (!project) {
        throw new DomainError("Project not found", "not_found", 404);
      }
      return project;
    },
  );

  app.delete<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(request.params.projectId, "project id");
      if (!(await dependencies.projects.remove(tenant, projectId))) {
        throw new DomainError("Project not found", "not_found", 404);
      }
      return reply.status(204).send();
    },
  );

  app.post("/v1/uploads", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    if (!request.isMultipart()) {
      throw new DomainError(
        "Expected multipart/form-data",
        "multipart_required",
        415,
      );
    }
    const requestIdempotencyKey = idempotencyKey(request);
    async function* files() {
      for await (const part of request.files({
        limits: {
          fileSize: MAX_UPLOAD_BYTES,
          files: MAX_GLOBAL_UPLOAD_FILES,
          parts: MAX_GLOBAL_UPLOAD_FILES,
        },
      })) {
        if (part.fieldname !== "file" && part.fieldname !== "files") {
          part.file.resume();
          throw new DomainError(
            "Upload file field must be named file or files",
            "invalid_upload_field",
            400,
          );
        }
        yield {
          filename: part.filename,
          mimeType: part.mimetype || null,
          contents: part.file,
        };
        if (part.file.truncated) {
          throw new DomainError(
            `Uploaded file exceeds ${String(MAX_UPLOAD_BYTES)} bytes`,
            "upload_too_large",
            413,
          );
        }
      }
    }
    const batch = await requireGlobalUploads().create(tenant, {
      idempotencyKey: requestIdempotencyKey,
      files: files(),
    });
    return reply.status(202).send({ batch });
  });

  app.get<{
    Querystring: {
      status?: string;
      limit?: string;
      offset?: string;
    };
  }>("/v1/uploads/batches", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const query = listGlobalUploadBatchesQuerySchema.parse(request.query);
    return requireGlobalUploads().listBatches(tenant, query);
  });

  app.get<{ Params: { batchId: string } }>(
    "/v1/uploads/batches/:batchId",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const batchId = parseGlobalUploadBatchIdentifier(
        request.params.batchId,
      );
      return {
        batch: await requireGlobalUploads().getBatch(tenant, batchId),
      };
    },
  );

  app.get<{
    Querystring: {
      batchId?: string;
      status?: string;
      projectId?: string;
      limit?: string;
      offset?: string;
    };
  }>("/v1/uploads/items", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const query = listGlobalUploadItemsQuerySchema.parse(request.query);
    return requireGlobalUploads().listItems(tenant, query);
  });

  app.post<{
    Params: { itemId: string };
  }>("/v1/uploads/items/:itemId/route", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const itemId = parseGlobalUploadItemIdentifier(
      request.params.itemId,
    );
    const input = routeGlobalUploadBodySchema.parse(request.body);
    return {
      batch: await requireGlobalUploads().routeItem(
        tenant,
        itemId,
        input,
      ),
    };
  });

}
