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

export function registerSessionRoutes(ctx: RouteContext): void {
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
}
