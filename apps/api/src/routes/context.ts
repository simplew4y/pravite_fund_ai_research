// Route context: the createApiApp closures extracted verbatim from app.ts.
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

export function createRouteContext(
  app: FastifyInstance,
  config: ApiConfig,
  dependencies: ApiDependencies,
) {
  function setSessionCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      // Cloud auth defaults to Secure cookies. Local plaintext development
      // against the cloud backend must opt out explicitly with
      // PRIVATE_FUND_COOKIE_SECURE=0 (browsers drop Secure cookies on http).
      secure: config.cookieSecure ?? config.auth.mode === "cloud",
      maxAge: 7 * 24 * 60 * 60,
    });
  }

  function clearSessionCookie(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure ?? config.auth.mode === "cloud",
    });
  }

  function disablePrivateCaching(reply: FastifyReply): void {
    reply.header("cache-control", "private, no-store");
  }

  function requireCloudAccounts() {
    if (!dependencies.cloudAccounts || config.auth.mode !== "cloud") {
      throw new DomainError(
        "Cloud account service is not enabled",
        "cloud_accounts_disabled",
        404,
      );
    }
    return dependencies.cloudAccounts;
  }

  function requireJobs() {
    if (!dependencies.jobs) {
      throw new DomainError(
        "Durable jobs are not enabled",
        "jobs_disabled",
        503,
      );
    }
    return dependencies.jobs;
  }

  function requireResearch() {
    if (!dependencies.research) {
      throw new DomainError(
        "Research store is not enabled",
        "research_store_disabled",
        503,
      );
    }
    return dependencies.research;
  }

  function requireSourceFolders() {
    if (!dependencies.sourceFolders) {
      throw new DomainError(
        "Source folder service is not enabled",
        "source_folders_disabled",
        503,
      );
    }
    return dependencies.sourceFolders;
  }

  function requireGlobalUploads() {
    if (!dependencies.globalUploads) {
      throw new DomainError(
        "Global upload service is not enabled",
        "global_uploads_disabled",
        503,
      );
    }
    return dependencies.globalUploads;
  }

  function requireSessionResources() {
    if (!dependencies.sessionResources) {
      throw new DomainError(
        "Session resources are not enabled",
        "session_resources_disabled",
        503,
      );
    }
    return dependencies.sessionResources;
  }

  async function sourceFolderSnapshot(
    tenant: TenantContext,
    projectId: string,
  ) {
    const service = requireSourceFolders();
    const [folders, assignments] = await Promise.all([
      service.listTree(tenant, projectId),
      service.listAssignments(tenant, projectId),
    ]);
    return { folders, assignments };
  }

  function requireWorkflow() {
    if (!dependencies.workflow) {
      throw new DomainError(
        "Project workflow service is not enabled",
        "workflow_store_disabled",
        503,
      );
    }
    return dependencies.workflow;
  }

  function requireInsights() {
    if (!dependencies.insights) {
      throw new DomainError(
        "Project insights service is not enabled",
        "insights_store_disabled",
        503,
      );
    }
    return dependencies.insights;
  }

  function readCloudSession(request: FastifyRequest) {
    const cloud = requireCloudAccounts();
    const raw = request.cookies[SESSION_COOKIE];
    const session = raw ? cloud.cipher.open(raw) : null;
    if (!session) {
      throw new DomainError("Authentication required", "not_authenticated", 401);
    }
    return { cloud, session };
  }

  async function freshCloudSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const { cloud, session } = readCloudSession(request);
    let fresh;
    try {
      fresh = await cloud.service.ensureFresh(session);
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
    if (fresh.refreshed) {
      setSessionCookie(reply, cloud.cipher.seal(fresh.session));
    }
    return {
      cloud,
      session: fresh.session,
      refreshed: fresh.refreshed,
    };
  }

  async function proxyCloudJson(
    request: FastifyRequest,
    reply: FastifyReply,
    pathName: string,
    init: RequestInit = {},
    clearOnSuccess = false,
  ) {
    disablePrivateCaching(reply);
    const fresh = await freshCloudSession(request, reply);
    let session = fresh.session;
    let upstream = await fresh.cloud.client.proxy(
      pathName,
      session.accessToken,
      init,
    );
    if (upstream.status === 401 && !fresh.refreshed) {
      try {
        session = await fresh.cloud.service.refresh(session);
      } catch (error) {
        if (
          error instanceof CloudAccountError &&
          error.code === "cloud_service_unavailable"
        ) {
          throw error;
        }
        clearSessionCookie(reply);
        throw new DomainError(
          "Session expired",
          "not_authenticated",
          401,
        );
      }
      setSessionCookie(reply, fresh.cloud.cipher.seal(session));
      upstream = await fresh.cloud.client.proxy(
        pathName,
        session.accessToken,
        init,
      );
    }
    const text = await upstream.text();
    const contentType =
      upstream.headers.get("content-type") ?? "application/json; charset=utf-8";
    if (upstream.status === 401 || upstream.status === 403) {
      clearSessionCookie(reply);
    }
    if (clearOnSuccess && upstream.ok) {
      clearSessionCookie(reply);
    }
    if (upstream.status === 204) {
      return reply.status(204).send();
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new DomainError(
        "Cloud account service returned invalid JSON",
        "invalid_cloud_response",
        502,
      );
    }
    reply.status(upstream.status).header("content-type", contentType);
    return reply.send(payload);
  }

  async function tenantFor(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<TenantContext> {
    const result = await dependencies.identityProvider.authenticate(
      request.cookies[SESSION_COOKIE],
    );
    if (result.replacementCookie) {
      setSessionCookie(reply, result.replacementCookie);
    }
    return buildTenantContext(config.dataRoot, result.identity);
  }

  async function tenantAndModelAccessFor(
    request: FastifyRequest,
    reply: FastifyReply,
    sessionId: string,
  ) {
    if (config.auth.mode === "development") {
      return {
        tenant: await tenantFor(request, reply),
        modelGatewayAccess: undefined,
      };
    }
    const issuer = dependencies.modelGatewayAccessIssuer;
    if (issuer === undefined) {
      throw new DomainError(
        "Cloud model gateway is not configured",
        "model_gateway_not_configured",
        503,
      );
    }
    const fresh = await freshCloudSession(request, reply);
    const tenant = buildTenantContext(config.dataRoot, {
      userId: fresh.session.user.id,
      dataNamespace: fresh.session.user.data_namespace,
    });
    const session = await dependencies.sessions.get(tenant, sessionId);
    if (session === null) {
      throw new DomainError("Session not found", "not_found", 404);
    }
    return {
      tenant,
      modelGatewayAccess: await issuer.issue(fresh.session.accessToken, {
        userId: tenant.userId,
        dataNamespace: tenant.dataNamespace,
        projectId: session.projectId,
        sessionId,
      }),
    };
  }

  return {
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
  };
}

export type RouteContext = ReturnType<typeof createRouteContext>;
