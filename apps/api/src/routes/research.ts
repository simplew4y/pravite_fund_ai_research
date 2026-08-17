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

export function registerResearchRoutes(ctx: RouteContext): void {
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

  app.get<{
    Params: { projectId: string };
    Querystring: { limit?: string; offset?: string };
  }>("/v1/projects/:projectId/documents", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const projectId = parseIdentifier(request.params.projectId, "project id");
    const page = paginationQuerySchema.parse(request.query);
    return requireResearch().listDocuments(
      tenant,
      projectId,
      page,
    );
  });

  app.post<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/documents/register",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const input = registerDocumentVersionRequestSchema.parse(request.body);
      const result = await requireResearch().registerDocument(
        tenant,
        projectId,
        input,
      );
      return reply.status(result.created ? 201 : 200).send(result);
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/assets/context",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      return requireResearch().assetContext(tenant, projectId);
    },
  );

  app.put<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/assets/context",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const input = updateResearchAssetContextRequestSchema.parse(
        request.body,
      );
      return requireResearch().updateAssetContext(
        tenant,
        projectId,
        input,
      );
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/assets/delete",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const input = deleteResearchAssetsRequestSchema.parse(request.body);
      return requireResearch().deleteAssets(tenant, projectId, input);
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/documents/upload",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      if (!request.isMultipart()) {
        throw new DomainError(
          "Expected multipart/form-data",
          "multipart_required",
          415,
        );
      }

      const uploads = [];
      for await (const part of request.files({
        limits: {
          fileSize: MAX_UPLOAD_BYTES,
          files: MAX_PROJECT_UPLOAD_FILES,
          parts: MAX_PROJECT_UPLOAD_FILES,
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
        const uploaded = await requireResearch().uploadDocument(
          tenant,
          projectId,
          {
            filename: part.filename,
            mimeType: part.mimetype || null,
            contents: part.file,
          },
        );
        if (part.file.truncated) {
          throw new DomainError(
            `Uploaded file exceeds ${String(MAX_UPLOAD_BYTES)} bytes`,
            "upload_too_large",
            413,
          );
        }
        uploads.push(uploaded);
      }
      if (uploads.length === 0) {
        throw new DomainError(
          "At least one file is required",
          "empty_upload",
          400,
        );
      }
      return reply.status(202).send({ uploads });
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/documents/delete",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const input = deleteResearchDocumentsRequestSchema.parse(
        request.body,
      );
      return requireResearch().removeDocuments(
        tenant,
        projectId,
        input,
      );
    },
  );

  app.get<{
    Params: { projectId: string; documentId: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    "/v1/projects/:projectId/documents/:documentId/versions",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const documentId = parseIdentifier(
        request.params.documentId,
        "document id",
      );
      const page = paginationQuerySchema.parse(request.query);
      return requireResearch().documentVersions(
        tenant,
        projectId,
        documentId,
        page,
      );
    },
  );

  type DocumentFileRoute = {
    Params: { projectId: string; documentId: string };
    Querystring: { versionId?: string };
  };
  const serveDocumentFile =
    (disposition: "inline" | "attachment") =>
    async (
      request: FastifyRequest<DocumentFileRoute>,
      reply: FastifyReply,
    ) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const documentId = parseIdentifier(
        request.params.documentId,
        "document id",
      );
      const query = documentFileQuerySchema.parse(request.query);
      return sendOpenedFile(
        request,
        reply,
        requireResearch().openDocumentFile(
          tenant,
          projectId,
          documentId,
          query.versionId,
        ),
        disposition,
      );
    };
  app.get<DocumentFileRoute>(
    "/v1/projects/:projectId/documents/:documentId/preview",
    serveDocumentFile("inline"),
  );
  app.get<DocumentFileRoute>(
    "/v1/projects/:projectId/documents/:documentId/text-preview",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const documentId = parseIdentifier(
        request.params.documentId,
        "document id",
      );
      const query = documentTextPreviewQuerySchema.parse(request.query);
      reply.header("cache-control", "private, no-store");
      reply.header("x-content-type-options", "nosniff");
      return requireResearch().documentTextPreview(
        tenant,
        projectId,
        documentId,
        query.versionId,
      );
    },
  );
  app.get<DocumentFileRoute>(
    "/v1/projects/:projectId/documents/:documentId/download",
    serveDocumentFile("attachment"),
  );

  app.patch<{
    Params: { projectId: string; assetId: string };
  }>("/v1/projects/:projectId/assets/:assetId", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const projectId = parseIdentifier(
      request.params.projectId,
      "project id",
    );
    const assetId = parseIdentifier(request.params.assetId, "asset id");
    const input = updateResearchAssetLifecycleRequestSchema.parse(
      request.body,
    );
    return requireResearch().updateAssetLifecycle(
      tenant,
      projectId,
      assetId,
      input,
    );
  });

  app.delete<{
    Params: { projectId: string; assetId: string };
  }>("/v1/projects/:projectId/assets/:assetId", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const projectId = parseIdentifier(
      request.params.projectId,
      "project id",
    );
    const assetId = parseIdentifier(request.params.assetId, "asset id");
    return requireResearch().deleteAssets(tenant, projectId, {
      assetIds: [assetId],
    });
  });

  app.delete<{
    Params: { projectId: string; documentId: string };
  }>(
    "/v1/projects/:projectId/documents/:documentId",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const documentId = parseIdentifier(
        request.params.documentId,
        "document id",
      );
      const document = await requireResearch().removeDocument(
        tenant,
        projectId,
        documentId,
      );
      if (document === null) {
        throw new DomainError("Document not found", "not_found", 404);
      }
      return document;
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/source-folders",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      return sourceFolderSnapshot(tenant, projectId);
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/source-folders",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const input = createSourceFolderRequestSchema.parse(request.body);
      const result = await requireSourceFolders().create(
        tenant,
        projectId,
        input,
      );
      return reply
        .status(result.created ? 201 : 200)
        .send(await sourceFolderSnapshot(tenant, projectId));
    },
  );

  app.patch<{
    Params: { projectId: string; folderId: string };
  }>(
    "/v1/projects/:projectId/source-folders/:folderId",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const folderId = parseSourceFolderIdentifier(request.params.folderId);
      const input = updateSourceFolderRequestSchema.parse(request.body);
      await requireSourceFolders().update(
        tenant,
        projectId,
        folderId,
        input,
      );
      return sourceFolderSnapshot(tenant, projectId);
    },
  );

  app.delete<{
    Params: { projectId: string; folderId: string };
  }>(
    "/v1/projects/:projectId/source-folders/:folderId",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const folderId = parseSourceFolderIdentifier(request.params.folderId);
      await requireSourceFolders().remove(tenant, projectId, folderId);
      return sourceFolderSnapshot(tenant, projectId);
    },
  );

  app.post<{
    Params: { projectId: string; folderId: string };
  }>(
    "/v1/projects/:projectId/source-folders/:folderId/documents",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const folderId = parseSourceFolderIdentifier(request.params.folderId);
      const input = assignSourceFolderDocumentRequestSchema.parse(
        request.body,
      );
      const result = await requireSourceFolders().assignDocument(
        tenant,
        projectId,
        folderId,
        input,
      );
      return reply
        .status(result.created ? 201 : 200)
        .send(await sourceFolderSnapshot(tenant, projectId));
    },
  );

  app.delete<{
    Params: {
      projectId: string;
      folderId: string;
      documentId: string;
    };
  }>(
    "/v1/projects/:projectId/source-folders/:folderId/documents/:documentId",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const folderId = parseSourceFolderIdentifier(request.params.folderId);
      const documentId = parseIdentifier(
        request.params.documentId,
        "document id",
      );
      await requireSourceFolders().unassignDocument(
        tenant,
        projectId,
        folderId,
        documentId,
      );
      return sourceFolderSnapshot(tenant, projectId);
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: {
      q?: string;
      kinds?: string;
      limit?: string;
      offset?: string;
      include_historical?: string;
    };
  }>("/v1/projects/:projectId/evidence/search", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const projectId = parseIdentifier(request.params.projectId, "project id");
    const query = evidenceSearchQuerySchema.parse(request.query);
    const kinds =
      query.kinds === undefined
        ? undefined
        : query.kinds
            .split(",")
            .map((kind) => researchEvidenceKindSchema.parse(kind.trim()));
    return requireResearch().searchEvidence(tenant, projectId, {
      query: query.q,
      ...(kinds === undefined ? {} : { kinds }),
      limit: query.limit,
      offset: query.offset,
      includeHistorical:
        query.include_historical === "1" ||
        query.include_historical === "true",
    });
  });

  app.get<{
    Params: { projectId: string; evidenceId: string };
  }>(
    "/v1/projects/:projectId/evidence/:evidenceId",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const parsedEvidenceId = evidenceIdSchema.safeParse(
        request.params.evidenceId,
      );
      if (!parsedEvidenceId.success) {
        throw new DomainError(
          "Invalid evidence id",
          "invalid_identifier",
          400,
        );
      }
      const evidence = await requireResearch().evidence(
        tenant,
        projectId,
        parsedEvidenceId.data,
      );
      if (evidence === null) {
        throw new DomainError("Evidence not found", "not_found", 404);
      }
      return evidence;
    },
  );

  type EvidenceFileRoute = {
    Params: { projectId: string; evidenceId: string };
  };
  const serveEvidenceFile =
    (disposition: "inline" | "attachment") =>
    async (
      request: FastifyRequest<EvidenceFileRoute>,
      reply: FastifyReply,
    ) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const parsedEvidenceId = evidenceIdSchema.safeParse(
        request.params.evidenceId,
      );
      if (!parsedEvidenceId.success) {
        throw new DomainError(
          "Invalid evidence id",
          "invalid_identifier",
          400,
        );
      }
      return sendOpenedFile(
        request,
        reply,
        requireResearch().openEvidenceFile(
          tenant,
          projectId,
          parsedEvidenceId.data,
        ),
        disposition,
      );
    };
  app.get<EvidenceFileRoute>(
    "/v1/projects/:projectId/evidence/:evidenceId/preview",
    serveEvidenceFile("inline"),
  );
  app.get<EvidenceFileRoute>(
    "/v1/projects/:projectId/evidence/:evidenceId/download",
    serveEvidenceFile("attachment"),
  );

  app.get<{
    Params: { projectId: string; evidenceId: string };
    Querystring: {
      sheetName?: string;
      rangeRef?: string;
      windowRow?: string;
      windowColumn?: string;
    };
  }>(
    "/v1/projects/:projectId/evidence/:evidenceId/source/excel",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const evidenceId = parseEvidenceIdentifier(
        request.params.evidenceId,
      );
      const query = excelSourceQuerySchema.parse(request.query);
      return requireResearch().excelSource(
        tenant,
        projectId,
        evidenceId,
        query,
      );
    },
  );

  app.get<{
    Params: {
      projectId: string;
      evidenceId: string;
      pageNumber: string;
    };
    Querystring: { quote?: string };
  }>(
    "/v1/projects/:projectId/evidence/:evidenceId/source/pdf/pages/:pageNumber",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const evidenceId = parseEvidenceIdentifier(
        request.params.evidenceId,
      );
      const pageNumber = pdfPageNumberSchema.parse(
        request.params.pageNumber,
      );
      const query = pdfSourcePageQuerySchema.parse(request.query);
      return requireResearch().pdfSourcePage(
        tenant,
        projectId,
        evidenceId,
        pageNumber,
        query,
      );
    },
  );

  app.get<{
    Params: {
      projectId: string;
      evidenceId: string;
      pageNumber: string;
    };
  }>(
    "/v1/projects/:projectId/evidence/:evidenceId/source/pdf/pages/:pageNumber/image",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const evidenceId = parseEvidenceIdentifier(
        request.params.evidenceId,
      );
      const pageNumber = pdfPageNumberSchema.parse(
        request.params.pageNumber,
      );
      return sendOpenedFile(
        request,
        reply,
        requireResearch().openPdfSourcePageImage(
          tenant,
          projectId,
          evidenceId,
          pageNumber,
        ),
        "inline",
      );
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { limit?: string; offset?: string };
  }>("/v1/projects/:projectId/assets", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const projectId = parseIdentifier(request.params.projectId, "project id");
    const page = paginationQuerySchema.parse(request.query);
    return requireResearch().listAssets(tenant, projectId, page);
  });

  app.post<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/assets",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const input = saveResearchAssetRequestSchema.parse(request.body);
      const result = await requireResearch().saveAsset(
        tenant,
        projectId,
        input,
      );
      return reply.status(result.created ? 201 : 200).send(result);
    },
  );

  app.get<{
    Params: { projectId: string; assetId: string };
  }>("/v1/projects/:projectId/assets/:assetId", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const projectId = parseIdentifier(request.params.projectId, "project id");
    const assetId = parseIdentifier(request.params.assetId, "asset id");
    const asset = await requireResearch().asset(
      tenant,
      projectId,
      assetId,
    );
    if (asset === null) {
      throw new DomainError("Research asset not found", "not_found", 404);
    }
    return asset;
  });

  app.get<{
    Params: { projectId: string; assetId: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    "/v1/projects/:projectId/assets/:assetId/versions",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const assetId = parseIdentifier(request.params.assetId, "asset id");
      const page = paginationQuerySchema.parse(request.query);
      return requireResearch().assetVersions(
        tenant,
        projectId,
        assetId,
        page,
      );
    },
  );

}
