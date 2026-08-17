import type { AgentToolRequestMessage } from "@private-fund/contracts";
import { DomainError } from "@private-fund/core";
import type { SessionJournalRepository } from "@private-fund/db";
import { describe, expect, it } from "vitest";

import { JournaledToolRuntime, knownToolGuard, type ToolGuard } from "./tool-runtime.js";

function request(overrides: Partial<AgentToolRequestMessage> = {}): AgentToolRequestMessage {
  return {
    type: "tool.request",
    protocolVersion: 1,
    requestId: "req-1",
    sessionId: "session-1",
    toolCallId: "call-1",
    tool: "workspace.list",
    arguments: { path: "." },
    deadlineAt: "2026-08-18T00:01:00.000Z",
    ...overrides,
  } as AgentToolRequestMessage;
}

interface AppendCall {
  tenant: string;
  type: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

function fakeJournal(options: { failIntent?: boolean } = {}) {
  const appends: AppendCall[] = [];
  const journal = {
    appendForTenant(tenant: string, input: {
      type: string;
      idempotencyKey: string;
      payload: Record<string, unknown>;
    }) {
      if (options.failIntent && input.type === "tool.call.requested") {
        throw new Error("journal down");
      }
      appends.push({
        tenant,
        type: input.type,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload,
      });
      return { event: {}, created: true };
    },
  } as unknown as SessionJournalRepository;
  return { journal, appends };
}

describe("JournaledToolRuntime", () => {
  it("journals intent before execution and result after", async () => {
    const { journal, appends } = fakeJournal();
    const order: string[] = [];
    const runtime = new JournaledToolRuntime({
      inner: {
        execute: async () => {
          order.push("execute");
          return { entries: [] };
        },
      },
      sessionJournal: journal,
      resolveTenantNamespace: () => "ns-1",
      onResultJournalError: () => undefined,
    });
    const result = await runtime.execute(request(), new AbortController().signal);
    expect(result).toEqual({ entries: [] });
    expect(appends.map((append) => append.type)).toEqual([
      "tool.call.requested",
      "tool.result.recorded",
    ]);
    // Intent persisted before the tool body ran.
    expect(order).toEqual(["execute"]);
    expect(appends[0]!.idempotencyKey).toBe("tool-intent-req-1");
    expect(appends[1]!.payload.status).toBe("ok");
  });

  it("fails closed: journal intent failure prevents execution", async () => {
    const { journal, appends } = fakeJournal({ failIntent: true });
    let executed = false;
    const runtime = new JournaledToolRuntime({
      inner: {
        execute: async () => {
          executed = true;
          return null;
        },
      },
      sessionJournal: journal,
      resolveTenantNamespace: () => "ns-1",
      onResultJournalError: () => undefined,
    });
    await expect(
      runtime.execute(request(), new AbortController().signal),
    ).rejects.toThrow("journal down");
    expect(executed).toBe(false);
    expect(appends).toHaveLength(0);
  });

  it("monotonic guard deny blocks execution and records the decision", async () => {
    const { journal, appends } = fakeJournal();
    const denyAll: ToolGuard = {
      name: "deny-all",
      evaluate: () => ({ decision: "deny", reason: "policy" }),
    };
    const approveAfter: ToolGuard = {
      name: "would-approve",
      evaluate: () => ({ decision: "abstain" }),
    };
    let executed = false;
    const runtime = new JournaledToolRuntime({
      inner: {
        execute: async () => {
          executed = true;
          return null;
        },
      },
      sessionJournal: journal,
      resolveTenantNamespace: () => "ns-1",
      guards: [denyAll, approveAfter],
      onResultJournalError: () => undefined,
    });
    await expect(
      runtime.execute(request(), new AbortController().signal),
    ).rejects.toThrow(DomainError);
    expect(executed).toBe(false);
    expect(appends.map((append) => append.type)).toEqual(["tool.policy.denied"]);
  });

  it("denies sessions without an authenticated tool context", async () => {
    const { journal } = fakeJournal();
    const runtime = new JournaledToolRuntime({
      inner: { execute: async () => null },
      sessionJournal: journal,
      resolveTenantNamespace: () => null,
    });
    await expect(
      runtime.execute(request(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("records tool failures without swallowing them", async () => {
    const { journal, appends } = fakeJournal();
    const runtime = new JournaledToolRuntime({
      inner: {
        execute: async () => {
          throw new Error("tool exploded");
        },
      },
      sessionJournal: journal,
      resolveTenantNamespace: () => "ns-1",
      onResultJournalError: () => undefined,
    });
    await expect(
      runtime.execute(request(), new AbortController().signal),
    ).rejects.toThrow("tool exploded");
    expect(appends[1]).toMatchObject({
      type: "tool.result.recorded",
      payload: { status: "error", error: "tool exploded" },
    });
  });

  it("knownToolGuard denies tools outside the allowlist", () => {
    expect(knownToolGuard.evaluate(request()).decision).toBe("abstain");
    expect(
      knownToolGuard.evaluate(request({ tool: "shell.exec" as never })).decision,
    ).toBe("deny");
  });
});
