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

export function registerInsightsRoutes(ctx: RouteContext): void {
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

}
