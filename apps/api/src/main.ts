import { fileURLToPath } from "node:url";

import {
  CloudAccountClient,
  CloudAuthService,
  SessionCipher,
  type CloudUser,
  type ShadowAccountStore,
} from "@private-fund/auth";
import {
  createControlRepositories,
  openControlDatabase,
  type ControlDatabase,
} from "@private-fund/db";
import { createPythonComputeClient } from "@private-fund/compute-client";

import {
  AgentWorkerSupervisor,
  buildAgentWorkerEnvironment,
} from "./agent-supervisor.js";
import { RepositoryAgentToolHandler } from "./agent-tools.js";
import { createApiApp } from "./app.js";
import { loadApiConfig, type ApiConfig } from "./config.js";
import type { ApiDependencies } from "./dependencies.js";
import {
  CloudIdentityProvider,
  DevelopmentIdentityProvider,
} from "./identity.js";
import { CloudModelGatewayAccessIssuer } from "./model-gateway-access.js";
import {
  RepositoryProjectService,
  RepositoryJobService,
  RepositorySessionService,
} from "./repository-services.js";
import { RepositoryProjectInsightsService } from "./insights-service.js";
import { RepositoryResearchService } from "./research-service.js";
import {
  ProjectResearchStoreManager,
  ResearchStoreEvidenceTools,
} from "./research-stores.js";
import { RepositorySourceFolderService } from "./source-folder-service.js";
import { RepositoryGlobalUploadService } from "./global-upload-service.js";
import { RepositorySessionResourcesService } from "./session-resources-service.js";
import { RepositoryProjectWorkflowService } from "./workflow-service.js";

export interface ApiRuntime {
  readonly config: ApiConfig;
  readonly app: Awaited<ReturnType<typeof createApiApp>>;
  readonly database: ControlDatabase;
  close(): Promise<void>;
}

export async function createApiRuntime(
  config: ApiConfig = loadApiConfig(),
): Promise<ApiRuntime> {
  const database = openControlDatabase(config.controlDatabase);
  const repositories = createControlRepositories(database);
  const researchStores = new ProjectResearchStoreManager();
  const worker = new AgentWorkerSupervisor({
    workerEntry: config.agentWorkerEntry,
    environment: {
      ...buildAgentWorkerEnvironment(process.env, {
        includeAmbientModelCredentials: config.auth.mode === "development",
      }),
      PRIVATE_FUND_ENABLE_PARENT_RPC_TOOLS: "1",
    },
  });
  const projects = new RepositoryProjectService(repositories);
  const jobs = new RepositoryJobService(database);
  const sessions = new RepositorySessionService({
    repositories,
    worker,
  });
  const research = new RepositoryResearchService(
    repositories,
    researchStores,
    jobs,
    config.sourcePreviewCompute === undefined
      ? undefined
      : createPythonComputeClient({
          workerScript: config.sourcePreviewCompute.workerEntry,
          pythonExecutable:
            config.sourcePreviewCompute.pythonExecutable,
          timeoutMs:
            config.sourcePreviewCompute.timeoutMilliseconds,
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
  worker.setToolHandler(
    new RepositoryAgentToolHandler({
      sessions,
      jobs,
      evidence: new ResearchStoreEvidenceTools(researchStores),
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

  try {
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
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      await app.close();
      sessions.dispose();
      await worker.stop();
      researchStores.close();
      database.close();
    };
    return { config, app, database, close };
  } catch (error) {
    sessions.dispose();
    await worker.stop();
    researchStores.close();
    database.close();
    throw error;
  }
}

export async function runApi(): Promise<void> {
  const runtime = await createApiRuntime();
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    await runtime.close();
  };
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
  await runtime.app.listen({
    host: runtime.config.host,
    port: runtime.config.port,
  });
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isEntryPoint) {
  runApi().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
