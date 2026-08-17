import type { ControlDatabase } from "@private-fund/db";
import { defineKernelPlugin, provide } from "@private-fund/kernel";

import { createApiApp } from "../app.js";
import type { ApiConfig } from "../config.js";

export interface ApiHttpService {
  readonly config: ApiConfig;
  readonly app: Awaited<ReturnType<typeof createApiApp>>;
  readonly database: ControlDatabase;
}

declare module "@private-fund/kernel" {
  interface KernelServices {
    apiHttp: ApiHttpService;
  }
}

/**
 * The HTTP surface: assembles ApiDependencies from kernel services and
 * registers every domain route module. Loads last, so its dispose
 * (fastify close, stopping request admission) runs first on shutdown.
 */
export const apiHttpPlugin = defineKernelPlugin<{ config: ApiConfig }>({
  name: "api-http",
  inject: [
    "controlDb",
    "identity",
    "projects",
    "jobs",
    "research",
    "sourceFolders",
    "sessionResources",
    "globalUploads",
    "workflow",
    "insights",
    "sessions",
  ],
  provides: ["apiHttp"],
  async apply(ctx, { config }) {
    const identity = ctx.identity;
    const app = await createApiApp(config, {
      identityProvider: identity.identityProvider,
      projects: ctx.projects,
      sessions: ctx.sessions,
      jobs: ctx.jobs,
      research: ctx.research,
      sourceFolders: ctx.sourceFolders,
      globalUploads: ctx.globalUploads,
      sessionResources: ctx.sessionResources,
      workflow: ctx.workflow,
      insights: ctx.insights,
      ...(identity.cloudAccounts === undefined
        ? {}
        : { cloudAccounts: identity.cloudAccounts }),
      ...(identity.modelGatewayAccessIssuer === undefined
        ? {}
        : { modelGatewayAccessIssuer: identity.modelGatewayAccessIssuer }),
    });
    ctx.effect(() => () => app.close(), "api-http:close");
    provide(ctx, "apiHttp", {
      config,
      app,
      database: ctx.controlDb.database,
    });
  },
});
