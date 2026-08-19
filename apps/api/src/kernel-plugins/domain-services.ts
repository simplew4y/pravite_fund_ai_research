import { createPythonComputeClient } from "@private-fund/compute-client";
import { defineKernelPlugin, provide } from "@private-fund/kernel";

import { RepositoryAgentToolHandler } from "../agent-tools.js";
import type { ApiConfig } from "../config.js";
import type {
  GlobalUploadService,
  JobService,
  ProjectInsightsService,
  ProjectService,
  ProjectWorkflowService,
  ResearchService,
  SessionResourcesService,
  SessionService,
  SourceFolderService,
} from "../dependencies.js";
import { RepositoryProjectInsightsService } from "../insights-service.js";
import {
  RepositoryProjectService,
  RepositoryJobService,
  RepositorySessionService,
} from "../repository-services.js";
import { RepositoryResearchService } from "../research-service.js";
import { ResearchStoreEvidenceTools } from "../research-stores.js";
import { ShadowSessionJournal } from "../session-journal-shadow.js";
import { RepositorySessionResourcesService } from "../session-resources-service.js";
import { RepositorySourceFolderService } from "../source-folder-service.js";
import { JournaledToolRuntime } from "../tool-runtime.js";
import { RepositoryGlobalUploadService } from "../global-upload-service.js";
import { RepositoryProjectWorkflowService } from "../workflow-service.js";

declare module "@private-fund/kernel" {
  interface KernelServices {
    projects: ProjectService;
    jobs: JobService;
    research: ResearchService;
    sourceFolders: SourceFolderService;
    sessionResources: SessionResourcesService;
    globalUploads: GlobalUploadService;
    workflow: ProjectWorkflowService;
    insights: ProjectInsightsService;
    sessions: SessionService;
  }
}

/** Projects CRUD + durable job queue. */
export const projectsJobsPlugin = defineKernelPlugin({
  name: "projects-jobs",
  inject: ["controlDb"],
  provides: ["projects", "jobs"],
  apply(ctx) {
    provide(ctx, "projects", new RepositoryProjectService(ctx.controlDb.repositories));
    provide(ctx, "jobs", new RepositoryJobService(ctx.controlDb.database));
  },
});

/** Research corpus: documents, assets, evidence, source folders, resources. */
export const researchPlugin = defineKernelPlugin<{ config: ApiConfig }>({
  name: "research",
  inject: ["controlDb", "researchStores", "jobs"],
  provides: ["research", "sourceFolders", "sessionResources"],
  apply(ctx, { config }) {
    const { repositories } = ctx.controlDb;
    provide(
      ctx,
      "research",
      new RepositoryResearchService(
        repositories,
        ctx.researchStores,
        ctx.jobs,
        config.sourcePreviewCompute === undefined
          ? undefined
          : createPythonComputeClient({
              workerScript: config.sourcePreviewCompute.workerEntry,
              pythonExecutable: config.sourcePreviewCompute.pythonExecutable,
              timeoutMs: config.sourcePreviewCompute.timeoutMilliseconds,
            }),
      ),
    );
    provide(
      ctx,
      "sourceFolders",
      new RepositorySourceFolderService(repositories, ctx.researchStores),
    );
    provide(
      ctx,
      "sessionResources",
      new RepositorySessionResourcesService(repositories, ctx.researchStores),
    );
  },
});

/** Global upload inbox (batch routing into projects). */
export const uploadsPlugin = defineKernelPlugin({
  name: "uploads",
  inject: ["controlDb", "research", "jobs"],
  provides: ["globalUploads"],
  apply(ctx) {
    provide(
      ctx,
      "globalUploads",
      new RepositoryGlobalUploadService(
        ctx.controlDb.repositories,
        ctx.research,
        ctx.jobs,
      ),
    );
  },
});

/** Research workflow + insights (tracking/valuation/memo). */
export const insightsPlugin = defineKernelPlugin({
  name: "insights",
  inject: ["controlDb", "researchStores", "jobs"],
  provides: ["workflow", "insights"],
  apply(ctx) {
    const { repositories } = ctx.controlDb;
    provide(
      ctx,
      "workflow",
      new RepositoryProjectWorkflowService(
        repositories,
        ctx.researchStores,
        ctx.jobs,
      ),
    );
    provide(
      ctx,
      "insights",
      new RepositoryProjectInsightsService(
        repositories,
        ctx.researchStores,
        ctx.jobs,
      ),
    );
  },
});

/**
 * Agent sessions: session service with journal shadow write, plus the
 * unified tool pipeline installed on the agent runtime. Loads after every
 * store plugin so its dispose (which quiesces sessions) runs first on stop.
 */
export const sessionsPlugin = defineKernelPlugin<{ config: ApiConfig }>({
  name: "sessions",
  inject: ["controlDb", "agentRuntime", "researchStores", "jobs"],
  provides: ["sessions"],
  apply(ctx, { config }) {
    const { repositories } = ctx.controlDb;
    const worker = ctx.agentRuntime;
    const journalShadow = new ShadowSessionJournal({
      database: ctx.controlDb.database,
      sessionEvents: repositories.sessionEvents,
      sessionJournal: repositories.sessionJournal,
      enabled: config.sessionJournalShadow ?? true,
      mode: (config.sessionJournalAuthority ?? true) ? "authority" : "shadow",
    });
    const sessions = new RepositorySessionService({
      repositories,
      worker,
      journalShadow,
    });
    ctx.effect(
      () => () => {
        sessions.dispose();
      },
      "sessions:dispose",
    );
    // Unified tool pipeline: monotonic guards + intent-before-effect journal
    // appends wrap the repository handler (harness tools/* semantics).
    worker.setToolHandler(
      new JournaledToolRuntime({
        inner: new RepositoryAgentToolHandler({
          sessions,
          jobs: ctx.jobs,
          evidence: new ResearchStoreEvidenceTools(ctx.researchStores),
        }),
        sessionJournal: repositories.sessionJournal,
        resolveTenantNamespace: (sessionId) =>
          sessions.agentToolContext(sessionId)?.tenant.dataNamespace ?? null,
      }),
    );
    ctx.effect(() => () => worker.setToolHandler(undefined), "sessions:tool-handler");
    provide(ctx, "sessions", sessions);
  },
});
