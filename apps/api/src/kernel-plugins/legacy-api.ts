import {
  CloudAccountClient,
  CloudAuthService,
  SessionCipher,
  type CloudUser,
  type ShadowAccountStore,
} from "@private-fund/auth";
import type { ControlDatabase } from "@private-fund/db";
import { createPythonComputeClient } from "@private-fund/compute-client";
import { defineKernelPlugin, provide } from "@private-fund/kernel";

import { RepositoryAgentToolHandler } from "../agent-tools.js";
import { createApiApp } from "../app.js";
import type { ApiConfig } from "../config.js";
import type { ApiDependencies } from "../dependencies.js";
import {
  CloudIdentityProvider,
  DevelopmentIdentityProvider,
} from "../identity.js";
import { CloudModelGatewayAccessIssuer } from "../model-gateway-access.js";
import {
  RepositoryProjectService,
  RepositoryJobService,
  RepositorySessionService,
} from "../repository-services.js";
import { RepositoryProjectInsightsService } from "../insights-service.js";
import { RepositoryResearchService } from "../research-service.js";
import { ResearchStoreEvidenceTools } from "../research-stores.js";
import { ShadowSessionJournal } from "../session-journal-shadow.js";
import { JournaledToolRuntime } from "../tool-runtime.js";
import { RepositorySourceFolderService } from "../source-folder-service.js";
import { RepositoryGlobalUploadService } from "../global-upload-service.js";
import { RepositorySessionResourcesService } from "../session-resources-service.js";
import { RepositoryProjectWorkflowService } from "../workflow-service.js";

export interface LegacyApiService {
  readonly config: ApiConfig;
  readonly app: Awaited<ReturnType<typeof createApiApp>>;
  readonly database: ControlDatabase;
}

declare module "@private-fund/kernel" {
  interface KernelServices {
    legacyApi: LegacyApiService;
  }
}

/**
 * Phase 0 strangler shell: the entire pre-kernel assembly (services, Fastify
 * app, agent worker supervisor) wrapped as one plugin. Later phases carve
 * services out of here into dedicated plugins until this file disappears.
 *
 * Teardown order (mirrors the old close chain) is expressed as kernel
 * effects registered in reverse — effects dispose LIFO.
 */
export const legacyApiPlugin = defineKernelPlugin<{ config: ApiConfig }>({
  name: "legacy-api",
  inject: ["controlDb", "researchStores", "agentRuntime"],
  provides: ["legacyApi"],
  async apply(ctx, { config }) {
    const { database, repositories } = ctx.controlDb;
    const researchStores = ctx.researchStores;
    const worker = ctx.agentRuntime;

    const projects = new RepositoryProjectService(repositories);
    const jobs = new RepositoryJobService(database);
    const journalShadow = new ShadowSessionJournal({
      sessionEvents: repositories.sessionEvents,
      sessionJournal: repositories.sessionJournal,
      enabled: config.sessionJournalShadow ?? true,
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
      "legacy:sessions",
    );
    const research = new RepositoryResearchService(
      repositories,
      researchStores,
      jobs,
      config.sourcePreviewCompute === undefined
        ? undefined
        : createPythonComputeClient({
            workerScript: config.sourcePreviewCompute.workerEntry,
            pythonExecutable: config.sourcePreviewCompute.pythonExecutable,
            timeoutMs: config.sourcePreviewCompute.timeoutMilliseconds,
          }),
    );
    const sourceFolders = new RepositorySourceFolderService(
      repositories,
      researchStores,
    );
    const globalUploads = new RepositoryGlobalUploadService(
      repositories,
      research,
      jobs,
    );
    const sessionResources = new RepositorySessionResourcesService(
      repositories,
      researchStores,
    );
    const workflow = new RepositoryProjectWorkflowService(
      repositories,
      researchStores,
      jobs,
    );
    const insights = new RepositoryProjectInsightsService(
      repositories,
      researchStores,
      jobs,
    );
    // Unified tool pipeline: monotonic guards + intent-before-effect journal
    // appends wrap the repository handler (harness tools/* semantics).
    worker.setToolHandler(
      new JournaledToolRuntime({
        inner: new RepositoryAgentToolHandler({
          sessions,
          jobs,
          evidence: new ResearchStoreEvidenceTools(researchStores),
        }),
        sessionJournal: repositories.sessionJournal,
        resolveTenantNamespace: (sessionId) =>
          sessions.agentToolContext(sessionId)?.tenant.dataNamespace ?? null,
      }),
    );

    let cloudAccounts: ApiDependencies["cloudAccounts"];
    let modelGatewayAccessIssuer: ApiDependencies["modelGatewayAccessIssuer"];
    let identityProvider: ApiDependencies["identityProvider"];

    if (config.auth.mode === "development") {
      repositories.users.upsertCloudShadow({
        userId: config.auth.userId,
        dataNamespace: config.auth.dataNamespace,
      });
      identityProvider = new DevelopmentIdentityProvider({
        userId: config.auth.userId,
        dataNamespace: config.auth.dataNamespace,
      });
    } else {
      const shadowStore: ShadowAccountStore = {
        async upsertCloudUser(user: CloudUser): Promise<void> {
          repositories.users.upsertCloudShadow({
            userId: user.id,
            dataNamespace: user.data_namespace,
            email: user.email,
          });
        },
      };
      const client = new CloudAccountClient({
        baseUrl: config.auth.backendUrl,
        timeoutMilliseconds: config.auth.timeoutMilliseconds,
      });
      const service = new CloudAuthService({ client, shadowStore });
      const cipher = new SessionCipher(config.auth.cookieSecret);
      cloudAccounts = { client, service, cipher };
      if (config.modelGateway !== undefined) {
        modelGatewayAccessIssuer = new CloudModelGatewayAccessIssuer({
          client,
          config: config.modelGateway,
        });
      }
      identityProvider = new CloudIdentityProvider(cipher, service);
    }

    const app = await createApiApp(config, {
      identityProvider,
      projects,
      sessions,
      jobs,
      research,
      sourceFolders,
      globalUploads,
      sessionResources,
      workflow,
      insights,
      ...(cloudAccounts === undefined ? {} : { cloudAccounts }),
      ...(modelGatewayAccessIssuer === undefined
        ? {}
        : { modelGatewayAccessIssuer }),
    });
    ctx.effect(() => () => app.close(), "legacy:fastify");

    provide(ctx, "legacyApi", { config, app, database });
  },
});
