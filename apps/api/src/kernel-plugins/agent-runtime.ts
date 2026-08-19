import path from "node:path";

import { buildTenantContext } from "@private-fund/core";
import { defineKernelPlugin, provide } from "@private-fund/kernel";

import type {
  AgentToolRequestHandler,
  AgentWorkerPort,
} from "../agent-supervisor.js";
import type { ApiConfig } from "../config.js";
import { HarnessAgentRuntime } from "../harness-agent/runtime.js";
import type { ChatModelEndpoint } from "../harness-agent/model-client.js";
import type { ModelGatewayCapability } from "./model-gateway.js";
import type { ControlDbService } from "@private-fund/db";

export type AgentRuntimeService = AgentWorkerPort & {
  setToolHandler(handler: AgentToolRequestHandler | undefined): void;
  setModelGateway(gateway: ModelGatewayCapability | undefined): void;
  endpointForSession(sessionId: string): ChatModelEndpoint;
};

declare module "@private-fund/kernel" {
  interface KernelServices {
    agentRuntime: AgentRuntimeService;
  }
}

export class AgentModelUnconfiguredError extends Error {
  constructor() {
    super(
      "No model endpoint configured: cloud sessions carry gateway access; " +
        "development mode needs PRIVATE_FUND_AGENT_API_KEY (or DASHSCOPE_API_KEY / OPENAI_API_KEY)",
    );
    this.name = "AgentModelUnconfiguredError";
  }
}

function developmentEndpoint(config: ApiConfig): ChatModelEndpoint | null {
  if (config.agentModel !== undefined) return config.agentModel;
  return null;
}

/**
 * ctx.agents — the in-process harness agent loop (Cordis-style: context
 * derives from the durable event stream, tools flow through the unified
 * pipeline, no Pi child process). Cloud sessions talk to the model gateway
 * with their per-session pfm_ access token; development sessions use the
 * locally configured OpenAI-compatible endpoint.
 */
export const agentRuntimePlugin = defineKernelPlugin<{ config: ApiConfig }>({
  name: "agent-runtime",
  inject: ["controlDb", "researchStores"],
  provides: ["agentRuntime"],
  apply(ctx, { config }) {
    const controlDb: ControlDbService = ctx.controlDb;
    const researchStores = ctx.researchStores;
    const journalAuthority = config.sessionJournalAuthority ?? true;
    const runtime = new HarnessAgentRuntime({
      sessionEvents: controlDb.repositories.sessionEvents,
      ...(journalAuthority
        ? {
            // Authority mode: the model-visible context derives from the
            // Session Journal's mirrored UI facts (shadow-sync rows carry
            // the original payload plus the projection sequence). Audit
            // rows (tool intents, model snapshots) are filtered out by
            // provenance.
            replayEvents: (tenantNamespace, sessionId, after, limit) => {
              const records: {
                sequence: number;
                type: string;
                payload: Record<string, unknown>;
              }[] = [];
              let cursor = after;
              // Page internally: filtering must not shrink a page below the
              // caller's limit and end its pagination early.
              while (records.length < limit) {
                const page = controlDb.repositories.sessionJournal.replayForTenant(
                  tenantNamespace,
                  sessionId,
                  cursor,
                  1_000,
                );
                if (page.length === 0) break;
                for (const event of page) {
                  cursor = event.sequence;
                  if (event.source.version !== "shadow-sync/1") continue;
                  records.push({
                    sequence: event.sequence,
                    type: event.type,
                    payload: event.payload,
                  });
                  if (records.length >= limit) break;
                }
                if (page.length < 1_000) break;
              }
              return records;
            },
          }
        : {}),
      // System-prompt assembly: project identity + corpus inventory, so the
      // model knows which company it researches and what evidence exists.
      describeSession: (session) => {
        const project = controlDb.repositories.projects.getForTenant(
          session.tenantNamespace,
          session.projectId,
        );
        const lines = [
          `当前项目：${project.name}` +
            (project.companyName ? `（${project.companyName}）` : "") +
            (project.ticker ? ` · ${project.ticker}` : ""),
        ];
        try {
          const tenant = buildTenantContext(config.dataRoot, {
            userId: config.auth.mode === "development" ? config.auth.userId : "cloud",
            dataNamespace: session.tenantNamespace,
          });
          const store = researchStores.get(
            path.join(tenant.projectsRoot, session.projectId),
          );
          const page = store.documents.list({ limit: 40, offset: 0 });
          lines.push(`项目资料库共 ${String(page.total)} 份文件。`);
          if (page.items.length > 0) {
            lines.push(
              `已入库资料：${page.items.map((item) => item.title).join("、")}`,
            );
          }
          lines.push(
            "回答前请用 evidence.search 检索资料库获取证据，并在结论中引用来源；资料库没有的信息要明确说明。",
          );
        } catch {
          lines.push("项目资料库尚未初始化。");
        }
        return lines.join("\n");
      },
      resolveEndpoint: (session) => {
        if (session.modelGatewayAccess !== undefined) {
          return {
            baseUrl: session.modelGatewayAccess.gatewayBaseUrl,
            apiKey: session.modelGatewayAccess.accessToken,
            model: session.modelGatewayAccess.model.id,
          };
        }
        const endpoint = developmentEndpoint(config);
        if (endpoint === null) throw new AgentModelUnconfiguredError();
        return {
          ...endpoint,
          ...(session.model === undefined ? {} : { model: session.model }),
        };
      },
      ...(process.env.PRIVATE_FUND_AGENT_SYSTEM_PROMPT
        ? { systemPrompt: process.env.PRIVATE_FUND_AGENT_SYSTEM_PROMPT }
        : {}),
    });
    ctx.effect(() => () => runtime.stop(), "agent-runtime:stop");
    provide(ctx, "agentRuntime", runtime);
  },
});
