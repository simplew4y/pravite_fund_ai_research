import {
  agentToolArgumentsSchemas,
  type AgentToolRequestMessage,
} from "@private-fund/contracts";
import { DomainError, canonicalJsonSha256 } from "@private-fund/core";
import type { SessionJournalRepository } from "@private-fund/db";

import type { AgentToolRequestHandler } from "./agent-supervisor.js";

const TOOL_RUNTIME_SOURCE_VERSION = "tool-runtime/1";

export type ToolGuardDecision =
  | { readonly decision: "abstain" }
  | { readonly decision: "deny"; readonly reason: string };

/**
 * Monotonic guard: may only deny or abstain — it can never approve past an
 * earlier denial, reorder the pipeline, or mutate the request.
 */
export interface ToolGuard {
  readonly name: string;
  evaluate(request: AgentToolRequestMessage): ToolGuardDecision;
}

/** Fail closed on tools outside the compiled allowlist. */
export const knownToolGuard: ToolGuard = {
  name: "known-tool",
  evaluate(request) {
    return Object.hasOwn(agentToolArgumentsSchemas, request.tool)
      ? { decision: "abstain" }
      : { decision: "deny", reason: `Unknown tool: ${request.tool}` };
  },
};

export interface JournaledToolRuntimeOptions {
  readonly inner: AgentToolRequestHandler;
  readonly sessionJournal: SessionJournalRepository;
  /** Maps a session to its tenant namespace; null denies the call. */
  readonly resolveTenantNamespace: (sessionId: string) => string | null;
  readonly guards?: readonly ToolGuard[];
  readonly onResultJournalError?: (error: unknown, requestId: string) => void;
}

/**
 * The unified tool execution pipeline (harness tools/* semantics):
 *
 *   guards (monotonic deny) → tool.call.requested journal append
 *   (intent-before-effect, fail closed) → execute → tool.result.recorded.
 *
 * The intent append happening before execution is the safety gate: if the
 * journal write fails, the tool body never runs. The result append happens
 * after the side effect and therefore cannot fail closed — failures there
 * are surfaced through onResultJournalError.
 */
export class JournaledToolRuntime implements AgentToolRequestHandler {
  readonly #inner: AgentToolRequestHandler;
  readonly #journal: SessionJournalRepository;
  readonly #resolveTenant: (sessionId: string) => string | null;
  readonly #guards: readonly ToolGuard[];
  readonly #onResultJournalError: (error: unknown, requestId: string) => void;

  constructor(options: JournaledToolRuntimeOptions) {
    this.#inner = options.inner;
    this.#journal = options.sessionJournal;
    this.#resolveTenant = options.resolveTenantNamespace;
    this.#guards = options.guards ?? [knownToolGuard];
    this.#onResultJournalError =
      options.onResultJournalError ??
      ((error, requestId) => {
        console.error(
          `Tool result journal append failed for ${requestId}`,
          error,
        );
      });
  }

  public async execute(
    request: AgentToolRequestMessage,
    signal: AbortSignal,
  ): Promise<unknown> {
    const tenantNamespace = this.#resolveTenant(request.sessionId);
    if (tenantNamespace === null) {
      throw new DomainError(
        "Agent session has no authenticated tool context",
        "forbidden",
        403,
      );
    }
    const argumentsDigest = canonicalJsonSha256(request.arguments);

    for (const guard of this.#guards) {
      const verdict = guard.evaluate(request);
      if (verdict.decision === "deny") {
        this.#tryAppend(tenantNamespace, request, "tool.policy.denied", {
          tool: request.tool,
          toolCallId: request.toolCallId,
          guard: guard.name,
          reason: verdict.reason,
          argumentsDigest,
        });
        throw new DomainError(
          `Tool call denied by ${guard.name}: ${verdict.reason}`,
          "forbidden",
          403,
        );
      }
    }

    // Intent-before-effect: this append is the gate. Let failures propagate
    // so the tool body never runs without a persisted intent.
    this.#journal.appendForTenant(tenantNamespace, {
      sessionId: request.sessionId,
      type: "tool.call.requested",
      operationId: null,
      turnId: null,
      stepId: null,
      source: { kind: "tool", id: null, version: TOOL_RUNTIME_SOURCE_VERSION },
      causationEventId: null,
      idempotencyKey: `tool-intent-${request.requestId}`,
      classification: "internal",
      payload: {
        tool: request.tool,
        toolCallId: request.toolCallId,
        requestId: request.requestId,
        argumentsDigest,
        deadlineAt: request.deadlineAt,
      },
      blobReferences: [],
      schemaVersion: 1,
    });

    try {
      const result = await this.#inner.execute(request, signal);
      this.#recordResult(tenantNamespace, request, argumentsDigest, {
        status: "ok",
        resultDigest: canonicalJsonSha256({ result: result ?? null }),
      });
      return result;
    } catch (error) {
      this.#recordResult(tenantNamespace, request, argumentsDigest, {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  #recordResult(
    tenantNamespace: string,
    request: AgentToolRequestMessage,
    argumentsDigest: string,
    outcome: Record<string, unknown>,
  ): void {
    this.#tryAppend(tenantNamespace, request, "tool.result.recorded", {
      tool: request.tool,
      toolCallId: request.toolCallId,
      requestId: request.requestId,
      argumentsDigest,
      ...outcome,
    });
  }

  #tryAppend(
    tenantNamespace: string,
    request: AgentToolRequestMessage,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    try {
      this.#journal.appendForTenant(tenantNamespace, {
        sessionId: request.sessionId,
        type,
        operationId: null,
        turnId: null,
        stepId: null,
        source: {
          kind: "tool",
          id: null,
          version: TOOL_RUNTIME_SOURCE_VERSION,
        },
        causationEventId: null,
        idempotencyKey: `tool-${type}-${request.requestId}`,
        classification: "internal",
        payload,
        blobReferences: [],
        schemaVersion: 1,
      });
    } catch (error) {
      this.#onResultJournalError(error, request.requestId);
    }
  }
}
