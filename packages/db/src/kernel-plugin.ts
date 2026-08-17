import { defineKernelPlugin, provide } from "@private-fund/kernel";

import { openControlDatabase } from "./database.js";
import { createControlRepositories } from "./repositories.js";
import type { ControlDatabase } from "./database.js";
import type { ControlRepositories } from "./repositories.js";

export interface ControlDbService {
  readonly database: ControlDatabase;
  readonly repositories: ControlRepositories;
}

declare module "@private-fund/kernel" {
  interface KernelServices {
    controlDb: ControlDbService;
  }
}

/**
 * Control-plane SQLite database + repositories as a kernel service. Shared
 * by every process profile (api, job-worker, obsidian-worker).
 */
export const controlDbPlugin = defineKernelPlugin<{ path: string }>({
  name: "control-db",
  provides: ["controlDb"],
  apply(ctx, config) {
    const database = openControlDatabase(config.path);
    ctx.effect(() => () => database.close(), "control-db:close");
    provide(ctx, "controlDb", {
      database,
      repositories: createControlRepositories(database),
    });
  },
});
