import { defineKernelPlugin, provide } from "@private-fund/kernel";

import {
  AgentWorkerSupervisor,
  buildAgentWorkerEnvironment,
} from "../agent-supervisor.js";
import type { ApiConfig } from "../config.js";

declare module "@private-fund/kernel" {
  interface KernelServices {
    agentRuntime: AgentWorkerSupervisor;
  }
}

/**
 * ctx.agentRuntime — the Pi agent worker supervisor (child process per
 * shared worker). Dispose stops the worker and awaits child teardown; the
 * plugin loads before the API assembly so it disposes after sessions but
 * before the stores it may still be flushing into.
 */
export const agentRuntimePlugin = defineKernelPlugin<{ config: ApiConfig }>({
  name: "agent-runtime",
  provides: ["agentRuntime"],
  apply(ctx, { config }) {
    const worker = new AgentWorkerSupervisor({
      workerEntry: config.agentWorkerEntry,
      environment: {
        ...buildAgentWorkerEnvironment(process.env, {
          includeAmbientModelCredentials: config.auth.mode === "development",
        }),
        PRIVATE_FUND_ENABLE_PARENT_RPC_TOOLS: "1",
      },
    });
    ctx.effect(() => () => worker.stop(), "agent-runtime:stop");
    provide(ctx, "agentRuntime", worker);
  },
});
