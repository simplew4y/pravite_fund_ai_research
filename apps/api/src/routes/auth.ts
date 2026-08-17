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
  passwordResetSchema,
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

export function registerAuthRoutes(ctx: RouteContext): void {
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

  app.post("/auth/login", async (request, reply) => {
    disablePrivateCaching(reply);
    const cloud = requireCloudAccounts();
    const body = loginSchema.parse(request.body);
    const session = await cloud.service.login(body.email, body.password);
    setSessionCookie(reply, cloud.cipher.seal(session));
    return {
      expires_in: session.sessionExpiresAt - Math.floor(Date.now() / 1000),
      user: session.user,
    };
  });

  app.post("/auth/register/send-code", async (request, reply) => {
    disablePrivateCaching(reply);
    if (config.auth.mode !== "cloud" || !config.auth.registrationEnabled) {
      throw new DomainError(
        "Registration is disabled",
        "registration_unavailable",
        404,
      );
    }
    const cloud = requireCloudAccounts();
    const body = registrationCodeSchema.parse(request.body);
    const upstream = await cloud.service.sendRegistrationCode(body.email);
    return reply.status(upstream.status).send(upstream.payload);
  });

  app.post("/auth/password/reset/send-code", async (request, reply) => {
    disablePrivateCaching(reply);
    if (config.auth.mode !== "cloud") {
      throw new DomainError(
        "Password reset is unavailable",
        "password_reset_unavailable",
        404,
      );
    }
    const cloud = requireCloudAccounts();
    const body = registrationCodeSchema.parse(request.body);
    const upstream = await cloud.service.sendPasswordResetCode(body.email);
    return reply.status(upstream.status).send(upstream.payload);
  });

  app.post("/auth/password/reset", async (request, reply) => {
    disablePrivateCaching(reply);
    if (config.auth.mode !== "cloud") {
      throw new DomainError(
        "Password reset is unavailable",
        "password_reset_unavailable",
        404,
      );
    }
    const cloud = requireCloudAccounts();
    const body = passwordResetSchema.parse(request.body);
    const upstream = await cloud.service.resetPassword(body);
    return reply.status(upstream.status).send(upstream.payload);
  });

  app.post("/auth/register", async (request, reply) => {
    disablePrivateCaching(reply);
    if (config.auth.mode !== "cloud" || !config.auth.registrationEnabled) {
      throw new DomainError(
        "Registration is disabled",
        "registration_unavailable",
        404,
      );
    }
    const cloud = requireCloudAccounts();
    const body = registrationSchema.parse(request.body);
    const session = await cloud.service.register({
      email: body.email,
      code: body.code,
      password: body.password,
      ...(body.nick_name ? { nickName: body.nick_name } : {}),
    });
    setSessionCookie(reply, cloud.cipher.seal(session));
    return reply.status(201).send({
      expires_in: session.sessionExpiresAt - Math.floor(Date.now() / 1000),
      user: session.user,
    });
  });

  app.post("/auth/refresh", async (request, reply) => {
    disablePrivateCaching(reply);
    const { cloud, session } = readCloudSession(request);
    try {
      const refreshed = await cloud.service.refresh(session);
      setSessionCookie(reply, cloud.cipher.seal(refreshed));
      return { ok: true, user: refreshed.user };
    } catch (error) {
      if (
        error instanceof CloudAccountError &&
        error.code === "cloud_service_unavailable"
      ) {
        throw error;
      }
      clearSessionCookie(reply);
      throw new DomainError("Session expired", "not_authenticated", 401);
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    disablePrivateCaching(reply);
    const raw = request.cookies[SESSION_COOKIE];
    if (raw && dependencies.cloudAccounts) {
      const session = dependencies.cloudAccounts.cipher.open(raw);
      if (session) {
        dependencies.modelGatewayAccessIssuer?.clearForTenant({
          userId: session.user.id,
          dataNamespace: session.user.data_namespace,
        });
        await dependencies.cloudAccounts.service.logout(session).catch(() => undefined);
      }
    }
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  app.get("/auth/me", async (request, reply) => {
    disablePrivateCaching(reply);
    const { cloud, session } = readCloudSession(request);
    let verified;
    try {
      verified = await cloud.service.verify(session);
    } catch (error) {
      if (
        error instanceof CloudAccountError &&
        (error.upstreamStatus === 401 || error.upstreamStatus === 403)
      ) {
        clearSessionCookie(reply);
      }
      if (
        error instanceof CloudAccountError &&
        error.upstreamStatus === 401
      ) {
        throw new DomainError(
          "Session expired",
          "not_authenticated",
          401,
        );
      }
      throw error;
    }
    if (verified.refreshed) {
      setSessionCookie(reply, cloud.cipher.seal(verified.session));
    }
    return verified.user;
  });

  app.post("/auth/users/me/password", async (request, reply) => {
    disablePrivateCaching(reply);
    const body = passwordChangeSchema.parse(request.body);
    return proxyCloudJson(
      request,
      reply,
      "me/change-password",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      true,
    );
  });

  app.get("/v1/account/usage", (request, reply) =>
    proxyCloudJson(
      request,
      reply,
      `me/usage?${new URLSearchParams(
        request.query as Record<string, string>,
      ).toString()}`,
    ),
  );

  app.get("/v1/account/balance-records", (request, reply) =>
    proxyCloudJson(
      request,
      reply,
      `me/balance-records?${new URLSearchParams(
        request.query as Record<string, string>,
      ).toString()}`,
    ),
  );

  app.get("/v1/account/feedback", (request, reply) =>
    proxyCloudJson(
      request,
      reply,
      `feedback?${new URLSearchParams(
        request.query as Record<string, string>,
      ).toString()}`,
    ),
  );

  app.post("/v1/account/feedback", async (request, reply) => {
    const body = feedbackSchema.parse(request.body);
    return proxyCloudJson(request, reply, "feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...body,
        client_platform: body.client_platform ?? process.platform,
      }),
    });
  });

  app.get("/v1/me", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    return {
      user_id: tenant.userId,
      data_namespace: tenant.dataNamespace,
    };
  });
}
