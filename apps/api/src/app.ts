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

import type { ApiConfig } from "./config.js";
import type { ApiDependencies } from "./dependencies.js";
import {
  contentDisposition,
  parseSingleByteRange,
  type OpenedFileResource,
} from "./secure-files.js";
import { writeSseComment, writeSseEvent } from "./sse.js";
import { registerWebUi } from "./web-ui.js";
import { createRouteContext } from "./routes/context.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerProjectAndUploadRoutes } from "./routes/projects-uploads.js";
import { registerResearchRoutes } from "./routes/research.js";
import { registerInsightsRoutes } from "./routes/insights.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { MAX_GLOBAL_UPLOAD_FILES, MAX_UPLOAD_BYTES } from "./routes/shared.js";

export async function createApiApp(
  config: ApiConfig,
  dependencies: ApiDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: {
        paths: [
          "req.headers.cookie",
          "req.headers.authorization",
          "body.password",
          "body.old_password",
          "body.new_password",
        ],
        censor: "[redacted]",
      },
    },
    bodyLimit: 10 * 1024 * 1024,
    requestTimeout: 300_000,
  });
  await app.register(cookie);
  await app.register(multipart, {
    limits: {
      fieldNameSize: 100,
      fieldSize: 1,
      fields: 0,
      fileSize: MAX_UPLOAD_BYTES,
      files: MAX_GLOBAL_UPLOAD_FILES,
      parts: MAX_GLOBAL_UPLOAD_FILES,
    },
    throwFileSizeLimit: true,
  });

  const routeContext = createRouteContext(app, config, dependencies);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) {
      return reply
        .status(error.statusCode)
        .send({ error: error.code, message: error.message });
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "ZodError"
    ) {
      return reply
        .status(400)
        .send({ error: "invalid_request", message: "Request validation failed" });
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      const code =
        "code" in error && typeof error.code === "string"
          ? error.code.toLowerCase()
          : "invalid_request";
      return reply.status(error.statusCode).send({
        error: code,
        message:
          "message" in error && typeof error.message === "string"
            ? error.message
            : "Request validation failed",
      });
    }
    app.log.error(error);
    return reply
      .status(500)
      .send({ error: "internal_error", message: "Internal server error" });
  });


  app.get("/health", async () => ({
    status: "ok",
    service: "private-fund-ts-api",
    version: "0.1.0",
  }));

  app.get("/v1/info", async () => ({
    auth_mode: config.auth.mode,
    accounts_enabled: config.auth.mode === "cloud",
    cloud_accounts_enabled: config.auth.mode === "cloud",
    login_url: config.auth.mode === "cloud" ? "/login" : null,
    needs_setup: false,
    registration_mode:
      config.auth.mode === "cloud" && config.auth.registrationEnabled
        ? "open"
        : null,
    databricks_features: false,
    managed_sandboxes_enabled: false,
    sandbox_provider: null,
    server_version: "0.1.0",
    smart_routing_enabled: false,
    llm_configuration_enabled: false,
    pi_sdk_harness: true,
    durable_jobs: dependencies.jobs !== undefined,
    research_store: dependencies.research !== undefined,
    insights_store: dependencies.insights !== undefined,
    legacy_omnigent_required: false,
  }));

  registerAuthRoutes(routeContext);
  registerProjectAndUploadRoutes(routeContext);
  registerResearchRoutes(routeContext);
  registerInsightsRoutes(routeContext);
  registerSessionRoutes(routeContext);
  registerJobRoutes(routeContext);

  if (config.webRoot !== undefined) {
    await registerWebUi(app, config.webRoot);
  }

  return app;
}
