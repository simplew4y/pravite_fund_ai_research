import {
  createControlRepositories,
  openControlDatabase,
  type ControlDatabase,
  type ControlRepositories,
} from "@private-fund/db";
import { defineKernelPlugin, provide } from "@private-fund/kernel";

export interface ControlDbService {
  readonly database: ControlDatabase;
  readonly repositories: ControlRepositories;
}

declare module "@private-fund/kernel" {
  interface KernelServices {
    controlDb: ControlDbService;
  }
}

/** Control-plane SQLite database + repositories as a kernel service. */
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
