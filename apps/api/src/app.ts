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

import type { ApiConfig } from "./config.js";
import type { ApiDependencies } from "./dependencies.js";
import {
  contentDisposition,
  parseSingleByteRange,
  type OpenedFileResource,
} from "./secure-files.js";
import { writeSseComment, writeSseEvent } from "./sse.js";
import { registerWebUi } from "./web-ui.js";

const SESSION_COOKIE = "pf_cloud_session";
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
const MAX_PROJECT_UPLOAD_FILES = 4;
const MAX_GLOBAL_UPLOAD_FILES = 20;

const loginSchema = z.object({
  email: z.string().trim().pipe(z.email()),
  password: z.string().min(1).max(10_000),
});

const registrationCodeSchema = z.object({
  email: z.string().trim().pipe(z.email()),
});

const registrationSchema = z.object({
  email: z.string().trim().pipe(z.email()),
  code: z.string().regex(/^\d{4}$/),
  password: z.string().min(8).max(10_000),
  nick_name: z.string().trim().max(120).nullable().optional(),
});

const passwordChangeSchema = z.object({
  old_password: z.string().min(1).max(10_000),
  new_password: z.string().min(8).max(10_000),
});

const feedbackSchema = z.object({
  feedback_type: z.string().trim().min(1).max(32),
  title: z.string().trim().min(2).max(240),
  content: z.string().trim().min(2).max(20_000),
  rating: z.number().int().min(1).max(5).nullable().default(null),
  contact_allowed: z.boolean().default(true),
  client_platform: z.string().max(32).nullable().default(null),
  client_version: z.string().max(64).nullable().default(null),
});

const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const evidenceSearchQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().min(1).max(4_000),
  kinds: z.string().max(200).optional(),
  include_historical: z
    .enum(["0", "1", "false", "true"])
    .default("0"),
});

const pdfPageNumberSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(1_000_000);

const routeGlobalUploadBodySchema = z
  .object({
    projectId: identifierSchema,
    idempotencyKey: z.string().trim().min(1).max(500),
  })
  .strict();

function parseIdentifier(value: unknown, label: string): string {
  const parsed = identifierSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError(`Invalid ${label}`, "invalid_identifier", 400);
  }
  return parsed.data;
}

function parseSourceFolderIdentifier(value: unknown): string {
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

function parseGlobalUploadBatchIdentifier(value: unknown): string {
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

function parseGlobalUploadItemIdentifier(value: unknown): string {
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

function parseSessionResourceIdentifier(value: unknown): string {
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

function parseEvidenceIdentifier(value: unknown): string {
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

function idempotencyKey(request: FastifyRequest): string {
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

async function sendOpenedFile(
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

  function setSessionCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      // Cloud auth is a production boundary and must never emit a session
      // cookie that a plaintext origin can send. Local HTTP development uses
      // PRIVATE_FUND_AUTH_MODE=development and does not mint this cookie.
      secure: config.auth.mode === "cloud",
      maxAge: 7 * 24 * 60 * 60,
    });
  }

  function clearSessionCookie(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.auth.mode === "cloud",
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
    workflow_store: dependencies.workflow !== undefined,
    insights_store: dependencies.insights !== undefined,
    legacy_omnigent_required: false,
  }));

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

  type MemoArtifactRoute = {
    Params: { projectId: string; memoVersionId: string };
    Querystring: { format?: string };
  };
  const serveMemoArtifact =
    (disposition: "inline" | "attachment") =>
    async (
      request: FastifyRequest<MemoArtifactRoute>,
      reply: FastifyReply,
    ) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const memoVersionId = parseIdentifier(
        request.params.memoVersionId,
        "memo version id",
      );
      const query = memoArtifactQuerySchema.parse(request.query);
      return sendOpenedFile(
        request,
        reply,
        requireInsights().openMemoArtifact(
          tenant,
          projectId,
          memoVersionId,
          query.format,
        ),
        disposition,
      );
    };
  app.get<MemoArtifactRoute>(
    "/v1/projects/:projectId/tracking/memos/:memoVersionId/preview",
    serveMemoArtifact("inline"),
  );
  app.get<MemoArtifactRoute>(
    "/v1/projects/:projectId/tracking/memos/:memoVersionId/download",
    serveMemoArtifact("attachment"),
  );

  app.get<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/workflow",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      return requireWorkflow().snapshot(tenant, projectId);
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/workflow/initialize",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const input = initializeWorkflowRequestSchema.parse(
        request.body ?? {},
      );
      return requireWorkflow().initialize(tenant, projectId, input);
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/workflow/current-node",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const input = selectWorkflowNodeRequestSchema.parse(request.body);
      return requireWorkflow().selectCurrentNode(
        tenant,
        projectId,
        input.nodeId,
      );
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/workflow/context",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const input = setWorkflowContextRequestSchema.parse(request.body);
      return requireWorkflow().setContext(tenant, projectId, input);
    },
  );

  app.post<{
    Params: { projectId: string; nodeId: string };
  }>(
    "/v1/projects/:projectId/workflow/nodes/:nodeId/start",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const nodeId = parseIdentifier(request.params.nodeId, "node id");
      const input = startWorkflowNodeRequestSchema.parse(
        request.body ?? {},
      );
      return requireWorkflow().startNode(
        tenant,
        projectId,
        nodeId,
        input,
      );
    },
  );

  app.post<{
    Params: { projectId: string; nodeId: string };
  }>(
    "/v1/projects/:projectId/workflow/nodes/:nodeId/complete",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const nodeId = parseIdentifier(request.params.nodeId, "node id");
      const input = completeWorkflowNodeRequestSchema.parse(request.body);
      return requireWorkflow().completeNode(
        tenant,
        projectId,
        nodeId,
        input,
      );
    },
  );

  app.post<{
    Params: { projectId: string; nodeId: string };
  }>(
    "/v1/projects/:projectId/workflow/nodes/:nodeId/assumptions",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const nodeId = parseIdentifier(request.params.nodeId, "node id");
      const input = createWorkflowAssumptionRequestSchema.parse(
        request.body,
      );
      return requireWorkflow().createAssumption(
        tenant,
        projectId,
        nodeId,
        input,
      );
    },
  );

  app.get<{
    Params: { projectId: string; nodeId: string };
    Querystring: {
      limit?: string;
      offset?: string;
      status?: string;
    };
  }>(
    "/v1/projects/:projectId/workflow/nodes/:nodeId/assumptions",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const nodeId = parseIdentifier(request.params.nodeId, "node id");
      const query = listWorkflowAssumptionsQuerySchema.parse(
        request.query,
      );
      return requireWorkflow().assumptions(
        tenant,
        projectId,
        nodeId,
        {
          limit: query.limit,
          offset: query.offset,
          ...(query.status === undefined
            ? {}
            : { status: query.status }),
        },
      );
    },
  );

  app.get<{
    Params: { projectId: string; nodeId: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    "/v1/projects/:projectId/workflow/nodes/:nodeId/versions",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const nodeId = parseIdentifier(request.params.nodeId, "node id");
      const page = paginationQuerySchema.parse(request.query);
      return requireWorkflow().nodeVersions(
        tenant,
        projectId,
        nodeId,
        page,
      );
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    "/v1/projects/:projectId/workflow/reports",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const page = paginationQuerySchema.parse(request.query);
      return requireWorkflow().reports(tenant, projectId, page);
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/workflow/reports",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const input = createWorkflowReportRequestSchema.parse(request.body);
      return reply
        .status(201)
        .send(
          await requireWorkflow().createReport(
            tenant,
            projectId,
            input,
          ),
        );
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { limit?: string; offset?: string };
  }>("/v1/projects/:projectId/tracking", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const projectId = parseIdentifier(request.params.projectId, "project id");
    const query = trackingPageQuerySchema.parse(request.query);
    return requireInsights().trackingOverview(tenant, projectId, query);
  });

  app.post<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/tracking/run",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const input = runTrackingScanRequestSchema.parse(request.body);
      return reply
        .status(202)
        .send(
          await requireInsights().runTracking(tenant, projectId, input),
        );
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: {
      itemType?: string;
      status?: string;
      limit?: string;
      offset?: string;
    };
  }>("/v1/projects/:projectId/tracking/items", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const projectId = parseIdentifier(request.params.projectId, "project id");
    const query = listTrackingItemsQuerySchema.parse(request.query);
    return requireInsights().trackingItems(tenant, projectId, query);
  });

  app.get<{
    Params: { projectId: string; itemId: string };
  }>(
    "/v1/projects/:projectId/tracking/items/:itemId/timeline",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const itemId = parseIdentifier(request.params.itemId, "item id");
      return requireInsights().trackingItemTimeline(
        tenant,
        projectId,
        itemId,
      );
    },
  );

  type DerivedModelFileRoute = {
    Params: { projectId: string; derivedModelId: string };
  };
  const serveDerivedModelFile =
    (disposition: "inline" | "attachment") =>
    async (
      request: FastifyRequest<DerivedModelFileRoute>,
      reply: FastifyReply,
    ) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const derivedModelId = parseIdentifier(
        request.params.derivedModelId,
        "derived model id",
      );
      return sendOpenedFile(
        request,
        reply,
        requireInsights().openDerivedModelFile(
          tenant,
          projectId,
          derivedModelId,
        ),
        disposition,
      );
    };
  app.get<DerivedModelFileRoute>(
    "/v1/projects/:projectId/valuation/derived-models/:derivedModelId/preview",
    serveDerivedModelFile("inline"),
  );
  app.get<DerivedModelFileRoute>(
    "/v1/projects/:projectId/valuation/derived-models/:derivedModelId/download",
    serveDerivedModelFile("attachment"),
  );

  app.post<{
    Params: { projectId: string; derivedModelId: string };
  }>(
    "/v1/projects/:projectId/valuation/derived-models/:derivedModelId/resources",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const derivedModelId = parseIdentifier(
        request.params.derivedModelId,
        "derived model id",
      );
      const input = addDerivedModelToResourcesRequestSchema.parse(
        request.body,
      );
      const result = await requireInsights().addDerivedModelToResources(
        tenant,
        projectId,
        derivedModelId,
        input,
      );
      return reply.status(202).send(result);
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: {
      seriesId?: string;
      limit?: string;
      offset?: string;
    };
  }>("/v1/projects/:projectId/tracking/memos", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const projectId = parseIdentifier(request.params.projectId, "project id");
    const query = listMemoVersionsQuerySchema.parse(request.query);
    return requireInsights().memoSeries(tenant, projectId, query);
  });

  app.post<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/tracking/memos",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const input = generateMemoRequestSchema.parse(request.body);
      return reply
        .status(202)
        .send(
          await requireInsights().generateMemo(
            tenant,
            projectId,
            input,
          ),
        );
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { fromVersionId?: string; toVersionId?: string };
  }>(
    "/v1/projects/:projectId/tracking/memos/compare",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const query = compareMemoVersionsQuerySchema.parse(request.query);
      return requireInsights().compareMemoVersions(
        tenant,
        projectId,
        query.fromVersionId,
        query.toVersionId,
      );
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    "/v1/projects/:projectId/tracking/watch-rules",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const query = trackingPageQuerySchema.parse(request.query);
      return requireInsights().trackingWatchRules(
        tenant,
        projectId,
        query,
      );
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/tracking/watch-rules",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const input = createTrackingWatchRuleRequestSchema.parse(
        request.body,
      );
      return reply
        .status(201)
        .send(
          await requireInsights().createTrackingWatchRule(
            tenant,
            projectId,
            input,
          ),
        );
    },
  );

  app.patch<{
    Params: { projectId: string; ruleId: string };
  }>(
    "/v1/projects/:projectId/tracking/watch-rules/:ruleId",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const ruleId = parseIdentifier(request.params.ruleId, "rule id");
      const input = updateTrackingWatchRuleRequestSchema.parse(
        request.body,
      );
      return requireInsights().updateTrackingWatchRule(
        tenant,
        projectId,
        ruleId,
        input,
      );
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { status?: string; limit?: string; offset?: string };
  }>("/v1/projects/:projectId/tracking/alerts", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const projectId = parseIdentifier(request.params.projectId, "project id");
    const query = listTrackingAlertsQuerySchema.parse(request.query);
    return requireInsights().trackingAlerts(tenant, projectId, query);
  });

  app.patch<{
    Params: { projectId: string; alertId: string };
  }>(
    "/v1/projects/:projectId/tracking/alerts/:alertId",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const alertId = parseIdentifier(request.params.alertId, "alert id");
      const input = transitionTrackingAlertRequestSchema.parse(
        request.body,
      );
      return requireInsights().transitionTrackingAlert(
        tenant,
        projectId,
        alertId,
        input,
      );
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { limit?: string; offset?: string };
  }>("/v1/projects/:projectId/valuation", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const projectId = parseIdentifier(request.params.projectId, "project id");
    const query = valuationPageQuerySchema.parse(request.query);
    return requireInsights().valuationOverview(tenant, projectId, query);
  });

  app.post<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/valuation/run",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const input = runValuationTrackingRequestSchema.parse(request.body);
      return reply
        .status(202)
        .send(
          await requireInsights().runValuationTracking(
            tenant,
            projectId,
            input,
          ),
        );
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { limit?: string; offset?: string };
  }>("/v1/projects/:projectId/valuation/series", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const projectId = parseIdentifier(request.params.projectId, "project id");
    const query = valuationPageQuerySchema.parse(request.query);
    return requireInsights().valuationSeries(tenant, projectId, query);
  });

  app.get<{
    Params: { projectId: string; seriesId: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    "/v1/projects/:projectId/valuation/series/:seriesId/versions",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const seriesId = parseIdentifier(
        request.params.seriesId,
        "series id",
      );
      const query = valuationPageQuerySchema.parse(request.query);
      return requireInsights().valuationModelVersions(
        tenant,
        projectId,
        seriesId,
        query,
      );
    },
  );

  app.get<{
    Params: { projectId: string; seriesId: string };
    Querystring: { fromVersionId?: string; toVersionId?: string };
  }>(
    "/v1/projects/:projectId/valuation/series/:seriesId/compare",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const seriesId = parseIdentifier(
        request.params.seriesId,
        "series id",
      );
      const query = compareValuationVersionsQuerySchema.parse(
        request.query,
      );
      return requireInsights().compareValuationVersions(
        tenant,
        projectId,
        seriesId,
        query.fromVersionId,
        query.toVersionId,
      );
    },
  );

  app.get<{
    Params: {
      projectId: string;
      seriesId: string;
      modelVersionId: string;
    };
  }>(
    "/v1/projects/:projectId/valuation/series/:seriesId/versions/:modelVersionId",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const seriesId = parseIdentifier(
        request.params.seriesId,
        "series id",
      );
      const modelVersionId = parseIdentifier(
        request.params.modelVersionId,
        "model version id",
      );
      return requireInsights().valuationModelOverview(
        tenant,
        projectId,
        seriesId,
        modelVersionId,
      );
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: {
      seriesId?: string;
      limit?: string;
      offset?: string;
    };
  }>("/v1/projects/:projectId/valuation/analyses", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const projectId = parseIdentifier(request.params.projectId, "project id");
    const query = listValuationResourcesQuerySchema.parse(request.query);
    return requireInsights().valuationAnalyses(tenant, projectId, query);
  });

  app.post<{
    Params: { projectId: string; seriesId: string };
  }>(
    "/v1/projects/:projectId/valuation/series/:seriesId/analyses",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const seriesId = parseIdentifier(
        request.params.seriesId,
        "series id",
      );
      const input = createValuationAgentAnalysisRequestSchema.parse(
        request.body,
      );
      return reply
        .status(202)
        .send(
          await requireInsights().createValuationAnalysis(
            tenant,
            projectId,
            seriesId,
            input,
          ),
        );
    },
  );

  app.get<{
    Params: { projectId: string; analysisId: string };
  }>(
    "/v1/projects/:projectId/valuation/analyses/:analysisId",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const analysisId = parseIdentifier(
        request.params.analysisId,
        "analysis id",
      );
      return requireInsights().valuationAnalysis(
        tenant,
        projectId,
        analysisId,
      );
    },
  );

  app.post<{
    Params: { projectId: string; analysisId: string };
  }>(
    "/v1/projects/:projectId/valuation/analyses/:analysisId/derive",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const analysisId = parseIdentifier(
        request.params.analysisId,
        "analysis id",
      );
      const input = deriveValuationModelRequestSchema.parse(request.body);
      return reply
        .status(202)
        .send(
          await requireInsights().deriveValuationModel(
            tenant,
            projectId,
            analysisId,
            input,
          ),
        );
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: {
      seriesId?: string;
      limit?: string;
      offset?: string;
    };
  }>(
    "/v1/projects/:projectId/valuation/derived-models",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const query = listValuationResourcesQuerySchema.parse(request.query);
      return requireInsights().valuationDerivedModels(
        tenant,
        projectId,
        query,
      );
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    "/v1/projects/:projectId/valuation/watch-rules",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const query = valuationPageQuerySchema.parse(request.query);
      return requireInsights().valuationWatchRules(
        tenant,
        projectId,
        query,
      );
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/valuation/watch-rules",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const input = createValuationWatchRuleRequestSchema.parse(
        request.body,
      );
      return reply
        .status(201)
        .send(
          await requireInsights().createValuationWatchRule(
            tenant,
            projectId,
            input,
          ),
        );
    },
  );

  app.patch<{
    Params: { projectId: string; ruleId: string };
  }>(
    "/v1/projects/:projectId/valuation/watch-rules/:ruleId",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const ruleId = parseIdentifier(request.params.ruleId, "rule id");
      const input = updateValuationWatchRuleRequestSchema.parse(
        request.body,
      );
      return requireInsights().updateValuationWatchRule(
        tenant,
        projectId,
        ruleId,
        input,
      );
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: {
      status?: string;
      seriesId?: string;
      alertType?: string;
      limit?: string;
      offset?: string;
    };
  }>("/v1/projects/:projectId/valuation/alerts", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const projectId = parseIdentifier(request.params.projectId, "project id");
    const query = listValuationAlertsQuerySchema.parse(request.query);
    return requireInsights().valuationAlerts(tenant, projectId, query);
  });

  app.patch<{
    Params: { projectId: string; alertId: string };
  }>(
    "/v1/projects/:projectId/valuation/alerts/:alertId",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const projectId = parseIdentifier(
        request.params.projectId,
        "project id",
      );
      const alertId = parseIdentifier(request.params.alertId, "alert id");
      const input = transitionValuationAlertRequestSchema.parse(
        request.body,
      );
      return requireInsights().transitionValuationAlert(
        tenant,
        projectId,
        alertId,
        input,
      );
    },
  );

  app.get<{
    Querystring: {
      project_id?: string;
      projectId?: string;
      include_archived?: string;
      includeArchived?: string;
    };
  }>(
    "/v1/sessions",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const query = listSessionsQuerySchema.parse({
        projectId: request.query.projectId ?? request.query.project_id,
        includeArchived:
          request.query.includeArchived ??
          request.query.include_archived ??
          false,
      });
      return {
        sessions: await dependencies.sessions.list(
          tenant,
          query.projectId,
          query.includeArchived,
        ),
      };
    },
  );

  app.post("/v1/sessions", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const input = createSessionRequestSchema.parse(request.body);
    return reply
      .status(201)
      .send(await dependencies.sessions.create(tenant, input));
  });

  app.get<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const sessionId = parseIdentifier(request.params.sessionId, "session id");
      const session = await dependencies.sessions.get(tenant, sessionId);
      if (!session) {
        throw new DomainError("Session not found", "not_found", 404);
      }
      return session;
    },
  );

  app.get<{
    Params: { sessionId: string };
    Querystring: {
      limit?: string;
      offset?: string;
      includeArchived?: string;
    };
  }>(
    "/v1/sessions/:sessionId/children",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const sessionId = parseIdentifier(
        request.params.sessionId,
        "session id",
      );
      const query = listSessionChildrenQuerySchema.parse(request.query);
      reply.header("cache-control", "no-store");
      return dependencies.sessions.children(
        tenant,
        sessionId,
        query,
      );
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/labels",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const sessionId = parseIdentifier(
        request.params.sessionId,
        "session id",
      );
      reply.header("cache-control", "no-store");
      return dependencies.sessions.labels(tenant, sessionId);
    },
  );

  app.patch<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const sessionId = parseIdentifier(
        request.params.sessionId,
        "session id",
      );
      const input = updateSessionRequestSchema.parse(request.body);
      return dependencies.sessions.update(tenant, sessionId, input);
    },
  );

  app.delete<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const sessionId = parseIdentifier(
        request.params.sessionId,
        "session id",
      );
      return dependencies.sessions.remove(tenant, sessionId);
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/fork",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const sessionId = parseIdentifier(
        request.params.sessionId,
        "session id",
      );
      const input = forkSessionRequestSchema.parse(request.body ?? {});
      return reply
        .status(201)
        .send(await dependencies.sessions.fork(tenant, sessionId, input));
    },
  );

  const rejectRetiredHostSurface = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    await tenantFor(request, reply);
    throw new DomainError(
      "Legacy Host/Runner resource surface is retired",
      "not_found",
      404,
    );
  };
  for (const surface of ["environments", "terminals"] as const) {
    app.all(
      `/v1/sessions/:sessionId/resources/${surface}`,
      rejectRetiredHostSurface,
    );
    app.all(
      `/v1/sessions/:sessionId/resources/${surface}/*`,
      rejectRetiredHostSurface,
    );
  }

  app.get<{
    Params: { sessionId: string };
    Querystring: {
      kind?: string;
      lifecycle?: string;
      limit?: string;
      offset?: string;
    };
  }>("/v1/sessions/:sessionId/resources", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const sessionId = parseIdentifier(
      request.params.sessionId,
      "session id",
    );
    const query = listSessionResourcesQuerySchema.parse(request.query);
    return requireSessionResources().listResources(
      tenant,
      sessionId,
      query,
    );
  });

  app.delete<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/resources",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const sessionId = parseIdentifier(
        request.params.sessionId,
        "session id",
      );
      return requireSessionResources().deleteResources(
        tenant,
        sessionId,
      );
    },
  );

  app.get<{
    Params: { sessionId: string; resourceId: string };
  }>(
    "/v1/sessions/:sessionId/resources/:resourceId",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const sessionId = parseIdentifier(
        request.params.sessionId,
        "session id",
      );
      const resourceId = parseSessionResourceIdentifier(
        request.params.resourceId,
      );
      return requireSessionResources().getResource(
        tenant,
        sessionId,
        resourceId,
      );
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/resources/research-assets",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const sessionId = parseIdentifier(
        request.params.sessionId,
        "session id",
      );
      const input =
        createSessionResearchAssetResourceRequestSchema.parse(
          request.body,
        );
      return reply.status(201).send(
        await requireSessionResources().addResearchAssetResource(
          tenant,
          sessionId,
          input,
        ),
      );
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/resources/document-references",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const sessionId = parseIdentifier(
        request.params.sessionId,
        "session id",
      );
      const input =
        createSessionDocumentReferenceResourceRequestSchema.parse(
          request.body,
        );
      return reply.status(201).send(
        await requireSessionResources().addDocumentReferenceResource(
          tenant,
          sessionId,
          input,
        ),
      );
    },
  );

  app.get<{
    Params: { sessionId: string };
    Querystring: {
      lifecycle?: string;
      limit?: string;
      offset?: string;
    };
  }>("/v1/sessions/:sessionId/attachments", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const sessionId = parseIdentifier(
      request.params.sessionId,
      "session id",
    );
    const query = listSessionAttachmentsQuerySchema.parse(request.query);
    return requireSessionResources().listAttachments(
      tenant,
      sessionId,
      query,
    );
  });

  app.post<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/attachments",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const sessionId = parseIdentifier(
        request.params.sessionId,
        "session id",
      );
      if (!request.isMultipart()) {
        throw new DomainError(
          "Expected multipart/form-data",
          "multipart_required",
          415,
        );
      }
      let attachment = null;
      for await (const part of request.files({
        limits: {
          fileSize: SESSION_ATTACHMENT_MAX_UPLOAD_BYTES,
          files: 1,
          parts: 1,
        },
      })) {
        if (part.fieldname !== "file") {
          part.file.resume();
          throw new DomainError(
            "Attachment file field must be named file",
            "invalid_upload_field",
            400,
          );
        }
        attachment = await requireSessionResources().uploadAttachment(
          tenant,
          sessionId,
          {
            filename: part.filename,
            mimeType: part.mimetype || "application/octet-stream",
            contents: part.file,
          },
        );
        if (part.file.truncated) {
          throw new DomainError(
            "Session attachment exceeds the upload limit",
            "upload_too_large",
            413,
          );
        }
      }
      if (attachment === null) {
        throw new DomainError(
          "One attachment file is required",
          "empty_upload",
          400,
        );
      }
      return reply.status(201).send(attachment);
    },
  );

  app.get<{
    Params: { sessionId: string; attachmentId: string };
  }>(
    "/v1/sessions/:sessionId/attachments/:attachmentId",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const sessionId = parseIdentifier(
        request.params.sessionId,
        "session id",
      );
      const attachmentId = parseSessionResourceIdentifier(
        request.params.attachmentId,
      );
      return requireSessionResources().getAttachment(
        tenant,
        sessionId,
        attachmentId,
      );
    },
  );

  app.delete<{
    Params: { sessionId: string; attachmentId: string };
  }>(
    "/v1/sessions/:sessionId/attachments/:attachmentId",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const sessionId = parseIdentifier(
        request.params.sessionId,
        "session id",
      );
      const attachmentId = parseSessionResourceIdentifier(
        request.params.attachmentId,
      );
      return requireSessionResources().deleteAttachment(
        tenant,
        sessionId,
        attachmentId,
      );
    },
  );

  app.get<{
    Params: { sessionId: string; attachmentId: string };
  }>(
    "/v1/sessions/:sessionId/attachments/:attachmentId/content",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const sessionId = parseIdentifier(
        request.params.sessionId,
        "session id",
      );
      const attachmentId = parseSessionResourceIdentifier(
        request.params.attachmentId,
      );
      return sendOpenedFile(
        request,
        reply,
        requireSessionResources().openAttachmentContent(
          tenant,
          sessionId,
          attachmentId,
        ),
        "inline",
      );
    },
  );

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

  app.post<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/messages",
    async (request, reply) => {
      const sessionId = parseIdentifier(request.params.sessionId, "session id");
      const { tenant, modelGatewayAccess } =
        await tenantAndModelAccessFor(request, reply, sessionId);
      const input = sendMessageRequestSchema.parse(request.body);
      return reply
        .status(202)
        .send(
          await dependencies.sessions.sendMessage(
            tenant,
            sessionId,
            input,
            modelGatewayAccess,
          ),
        );
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/operations",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const sessionId = parseIdentifier(request.params.sessionId, "session id");
      if ((await dependencies.sessions.get(tenant, sessionId)) === null) {
        throw new DomainError("Session not found", "not_found", 404);
      }
      return {
        operations: await dependencies.sessions.operations(tenant, sessionId),
      };
    },
  );

  app.get<{
    Params: { sessionId: string; operationId: string };
  }>(
    "/v1/sessions/:sessionId/operations/:operationId",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const sessionId = parseIdentifier(request.params.sessionId, "session id");
      const operationId = parseIdentifier(
        request.params.operationId,
        "operation id",
      );
      const operation = await dependencies.sessions.operation(
        tenant,
        sessionId,
        operationId,
      );
      if (operation === null) {
        throw new DomainError("Operation not found", "not_found", 404);
      }
      return operation;
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/steer",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const sessionId = parseIdentifier(request.params.sessionId, "session id");
      const input = steerSessionRequestSchema.parse(request.body);
      await dependencies.sessions.steer(tenant, sessionId, input.content);
      return reply.status(202).send({ ok: true });
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/interrupt",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const sessionId = parseIdentifier(request.params.sessionId, "session id");
      await dependencies.sessions.interrupt(tenant, sessionId);
      return reply.status(202).send({ ok: true });
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/compact",
    async (request, reply) => {
      const tenant = await tenantFor(request, reply);
      const sessionId = parseIdentifier(
        request.params.sessionId,
        "session id",
      );
      const input = compactSessionRequestSchema.parse(request.body ?? {});
      await dependencies.sessions.compact(
        tenant,
        sessionId,
        input.customInstructions,
      );
      return reply.status(202).send({ ok: true });
    },
  );

  app.get<{
    Params: { sessionId: string };
    Querystring: { after?: string; limit?: string; stream?: string };
  }>("/v1/sessions/:sessionId/events", async (request, reply) => {
    const tenant = await tenantFor(request, reply);
    const sessionId = parseIdentifier(request.params.sessionId, "session id");
    const session = await dependencies.sessions.get(tenant, sessionId);
    if (!session) {
      throw new DomainError("Session not found", "not_found", 404);
    }
    const headerSequence = request.headers["last-event-id"];
    const rawAfter =
      request.query.after ??
      (Array.isArray(headerSequence) ? headerSequence[0] : headerSequence) ??
      "0";
    const after = Math.max(0, Number.parseInt(rawAfter, 10) || 0);
    const limit = Math.min(
      10_000,
      Math.max(1, Number.parseInt(request.query.limit ?? "1000", 10) || 1000),
    );
    if (request.query.stream === "0") {
      return {
        events: await dependencies.sessions.events(
          tenant,
          sessionId,
          after,
          limit,
        ),
      };
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    let cursor = after;
    let catchingUp = true;
    const buffered: SessionEvent[] = [];
    const writeIfNew = (event: SessionEvent): void => {
      if (event.sequence <= cursor) {
        return;
      }
      writeSseEvent(reply.raw, event);
      cursor = event.sequence;
    };
    const unsubscribe = dependencies.sessions.subscribe(
      tenant,
      sessionId,
      (event) => {
        if (catchingUp) {
          buffered.push(event);
          return;
        }
        writeIfNew(event);
      },
    );
    try {
      const catchUpThrough =
        (await dependencies.sessions.get(tenant, sessionId))
          ?.lastSequence ?? cursor;
      const pageSize = Math.min(limit, 5_000);
      while (cursor < catchUpThrough) {
        const page = await dependencies.sessions.events(
          tenant,
          sessionId,
          cursor,
          Math.min(pageSize, catchUpThrough - cursor),
        );
        if (page.length === 0) {
          throw new Error(
            "Session event replay ended before its high watermark",
          );
        }
        for (const event of page) {
          writeIfNew(event);
        }
      }
      catchingUp = false;
      buffered.sort((left, right) => left.sequence - right.sequence);
      for (const event of buffered) {
        writeIfNew(event);
      }
      buffered.length = 0;
      writeSseComment(reply.raw, "connected");
    } catch (error) {
      catchingUp = false;
      unsubscribe();
      reply.raw.destroy(
        error instanceof Error ? error : new Error(String(error)),
      );
      return;
    }

    const heartbeat = setInterval(
      () => writeSseComment(reply.raw, "heartbeat"),
      15_000,
    );
    heartbeat.unref();

    request.raw.once("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    });
  });

  if (config.webRoot !== undefined) {
    await registerWebUi(app, config.webRoot);
  }

  return app;
}
