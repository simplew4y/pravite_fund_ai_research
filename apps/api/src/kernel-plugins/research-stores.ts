import { defineKernelPlugin, provide } from "@private-fund/kernel";

import { ProjectResearchStoreManager } from "../research-stores.js";

declare module "@private-fund/kernel" {
  interface KernelServices {
    researchStores: ProjectResearchStoreManager;
  }
}

/** Per-project research store manager (SQLite per project) as a service. */
export const researchStoresPlugin = defineKernelPlugin({
  name: "research-stores",
  provides: ["researchStores"],
  apply(ctx) {
    const manager = new ProjectResearchStoreManager();
    ctx.effect(() => () => manager.close(), "research-stores:close");
    provide(ctx, "researchStores", manager);
  },
});
