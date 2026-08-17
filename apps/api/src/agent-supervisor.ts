import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";

import {
  AGENT_TOOL_PROTOCOL_VERSION,
  agentWorkerMessageSchema,
  agentToolResultCommandSchema,
  type AgentToolCancelMessage,
  type AgentToolRemoteError,
  type AgentToolRequestMessage,
  type AgentWorkerCommand,
  type AgentWorkerMessage,
  type ModelGatewayAccess,
  type TenantIdentity,
} from "@private-fund/contracts";
import { DomainError, newId } from "@private-fund/core";

export interface StartAgentSessionInput {
  readonly sessionId: string;
  readonly projectId: string;
  readonly tenant: TenantIdentity;
  readonly workspace: string;
  readonly sessionFile: string;
  readonly model?: string;
  readonly modelGatewayAccess?: ModelGatewayAccess;
}

export type AgentEvent = Extract<AgentWorkerMessage, { type: "agent.event" }>;

export interface AgentToolRequestHandler {
  execute(
    request: AgentToolRequestMessage,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface AgentWorkerPort {
  start(input: StartAgentSessionInput): Promise<void>;
  prompt(sessionId: string, operationId: string, content: string): Promise<void>;
  steer(sessionId: string, content: string): Promise<void>;
  compact(sessionId: string, customInstructions?: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  dispose(sessionId: string): Promise<void>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  /**
   * Optional lifecycle hook used by the control plane to durably reconcile
   * operations when the shared Pi worker exits after acknowledging a command.
   * Test doubles and alternative in-process ports may omit it.
   */
  subscribeFailure?(listener: (error: Error) => void): () => void;
  stop(): Promise<void>;
}

interface PendingCommand {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface ReadyWaiter {
  readonly resolve: (child: ChildProcess) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface ActiveToolRequest {
  readonly request: AgentToolRequestMessage;
  readonly abort: AbortController;
  readonly timer: NodeJS.Timeout;
}

export interface AgentWorkerSupervisorOptions {
  readonly workerEntry: string;
  readonly workingDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly commandTimeoutMilliseconds?: number;
  readonly readyTimeoutMilliseconds?: number;
  readonly forkProcess?: typeof fork;
}

const WORKER_ENVIRONMENT_KEYS = [
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ELECTRON_RUN_AS_NODE",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "PRIVATE_FUND_AGENT_SKILL_PATHS",
  "PRIVATE_FUND_AGENT_SYSTEM_PROMPT",
  "PRIVATE_FUND_ENABLE_PARENT_RPC_TOOLS",
  "PRIVATE_FUND_PARENT_TOOL_RPC_TIMEOUT_MS",
] as const;

const AMBIENT_MODEL_CREDENTIAL_KEYS = new Set<string>([
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
]);

/**
 * Agent children receive only model/runtime settings. In particular, account
 * cookie secrets and cloud refresh tokens never enter the Pi process.
 */
export function buildAgentWorkerEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  options: { includeAmbientModelCredentials?: boolean } = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of WORKER_ENVIRONMENT_KEYS) {
    if (
      options.includeAmbientModelCredentials === false &&
      AMBIENT_MODEL_CREDENTIAL_KEYS.has(key)
    ) {
      continue;
    }
    const value = source[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

export class AgentWorkerSupervisor implements AgentWorkerPort {
  readonly #workerEntry: string;
  readonly #workingDirectory: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #commandTimeoutMilliseconds: number;
  readonly #readyTimeoutMilliseconds: number;
  readonly #forkProcess: typeof fork;
  readonly #pending = new Map<string, PendingCommand>();
  readonly #activeToolRequests = new Map<string, ActiveToolRequest>();
  readonly #listeners = new Set<(event: AgentEvent) => void>();
  readonly #failureListeners = new Set<(error: Error) => void>();

  #child: ChildProcess | null = null;
  #starting: Promise<ChildProcess> | null = null;
  #readyWaiter: ReadyWaiter | null = null;
  #stopping = false;
  #toolHandler: AgentToolRequestHandler | undefined;

  public constructor(options: AgentWorkerSupervisorOptions) {
    this.#workerEntry = path.resolve(options.workerEntry);
    this.#workingDirectory = path.resolve(
      options.workingDirectory ?? process.cwd(),
    );
    this.#environment =
      options.environment ?? buildAgentWorkerEnvironment(process.env);
    this.#commandTimeoutMilliseconds =
      options.commandTimeoutMilliseconds ?? 30_000;
    this.#readyTimeoutMilliseconds =
      options.readyTimeoutMilliseconds ?? 30_000;
    this.#forkProcess = options.forkProcess ?? fork;
  }

  public start(input: StartAgentSessionInput): Promise<void> {
    return this.#command({
      type: "session.start",
      requestId: newId("request"),
      sessionId: input.sessionId,
      projectId: input.projectId,
      tenant: input.tenant,
      workspace: input.workspace,
      sessionFile: input.sessionFile,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.modelGatewayAccess === undefined
        ? {}
        : { modelGatewayAccess: input.modelGatewayAccess }),
    });
  }

  public prompt(
    sessionId: string,
    operationId: string,
    content: string,
  ): Promise<void> {
    return this.#command({
      type: "session.prompt",
      requestId: newId("request"),
      sessionId,
      operationId,
      content,
    });
  }

  public steer(sessionId: string, content: string): Promise<void> {
    return this.#command({
      type: "session.steer",
      requestId: newId("request"),
      sessionId,
      content,
    });
  }

  public interrupt(sessionId: string): Promise<void> {
    return this.#command({
      type: "session.interrupt",
      requestId: newId("request"),
      sessionId,
    });
  }

  public compact(
    sessionId: string,
    customInstructions?: string,
  ): Promise<void> {
    return this.#command({
      type: "session.compact",
      requestId: newId("request"),
      sessionId,
      ...(customInstructions === undefined
        ? {}
        : { customInstructions }),
    });
  }

  public dispose(sessionId: string): Promise<void> {
    return this.#command({
      type: "session.dispose",
      requestId: newId("request"),
      sessionId,
    });
  }

  public subscribe(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  public subscribeFailure(listener: (error: Error) => void): () => void {
    this.#failureListeners.add(listener);
    return () => {
      this.#failureListeners.delete(listener);
    };
  }

  public setToolHandler(handler: AgentToolRequestHandler | undefined): void {
    this.#toolHandler = handler;
  }

  public async stop(): Promise<void> {
    if (this.#stopping) {
      return;
    }
    this.#stopping = true;
    const child = this.#child;
    this.#failAll(new Error("Agent worker supervisor stopped"));
    this.#abortAllTools();
    this.#readyWaiter?.reject(new Error("Agent worker supervisor stopped"));
    this.#readyWaiter = null;
    this.#starting = null;
    this.#child = null;
    if (child === null || child.exitCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish();
      }, 5_000);
      timer.unref();
      child.once("exit", finish);
      if (child.connected) {
        child.disconnect();
      } else {
        child.kill("SIGTERM");
      }
    });
  }

  async #command(command: AgentWorkerCommand): Promise<void> {
    if (this.#stopping) {
      throw new DomainError(
        "Agent worker is shutting down",
        "agent_worker_unavailable",
        503,
      );
    }
    const child = await this.#ensureChild();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(command.requestId);
        reject(
          new DomainError(
            `Agent command timed out: ${command.type}`,
            "agent_command_timeout",
            504,
          ),
        );
      }, this.#commandTimeoutMilliseconds);
      timer.unref();
      this.#pending.set(command.requestId, { resolve, reject, timer });

      child.send(command, (error) => {
        if (error === null) {
          return;
        }
        const pending = this.#pending.get(command.requestId);
        if (pending === undefined) {
          return;
        }
        clearTimeout(pending.timer);
        this.#pending.delete(command.requestId);
        pending.reject(
          new DomainError(
            `Could not send command to agent worker: ${error.message}`,
            "agent_worker_unavailable",
            503,
          ),
        );
      });
    });
  }

  #ensureChild(): Promise<ChildProcess> {
    if (
      this.#child !== null &&
      this.#child.connected &&
      this.#readyWaiter === null
    ) {
      return Promise.resolve(this.#child);
    }
    if (this.#starting !== null) {
      return this.#starting;
    }

    this.#starting = new Promise<ChildProcess>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.#forkProcess(this.#workerEntry, [], {
          cwd: this.#workingDirectory,
          env: this.#environment,
          serialization: "advanced",
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        });
      } catch (error) {
        this.#starting = null;
        reject(this.#workerFailure(error));
        return;
      }

      this.#child = child;
      child.on("message", (message) => {
        this.#handleMessage(child, message);
      });
      child.once("error", (error) => {
        this.#handleExit(child, this.#workerFailure(error));
      });
      child.once("exit", (code, signal) => {
        this.#handleExit(
          child,
          new DomainError(
            `Agent worker exited (code=${String(code)}, signal=${String(signal)})`,
            "agent_worker_unavailable",
            503,
          ),
        );
      });

      const timer = setTimeout(() => {
        if (this.#child === child) {
          child.kill("SIGTERM");
        }
        const error = new DomainError(
          "Agent worker did not become ready",
          "agent_worker_start_timeout",
          504,
        );
        this.#readyWaiter = null;
        this.#starting = null;
        reject(error);
      }, this.#readyTimeoutMilliseconds);
      timer.unref();
      this.#readyWaiter = {
        resolve: (readyChild) => {
          clearTimeout(timer);
          this.#readyWaiter = null;
          this.#starting = null;
          resolve(readyChild);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.#readyWaiter = null;
          this.#starting = null;
          reject(error);
        },
        timer,
      };
    });
    return this.#starting;
  }

  #handleMessage(child: ChildProcess, rawMessage: unknown): void {
    if (this.#child !== child) {
      return;
    }
    const parsed = agentWorkerMessageSchema.safeParse(rawMessage);
    if (!parsed.success) {
      this.#handleExit(
        child,
        new DomainError(
          "Agent worker sent an invalid IPC message",
          "invalid_agent_worker_message",
          502,
        ),
      );
      child.kill("SIGTERM");
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "worker.ready":
        this.#readyWaiter?.resolve(child);
        return;
      case "command.result": {
        const pending = this.#pending.get(message.requestId);
        if (pending === undefined) {
          return;
        }
        clearTimeout(pending.timer);
        this.#pending.delete(message.requestId);
        if (message.ok) {
          pending.resolve();
        } else {
          pending.reject(
            new DomainError(
              message.error ?? "Agent command failed",
              "agent_command_failed",
              502,
            ),
          );
        }
        return;
      }
      case "agent.event":
        for (const listener of this.#listeners) {
          try {
            listener(message);
          } catch {
            continue;
          }
        }
        return;
      case "worker.error":
        return;
      case "tool.request":
        this.#handleToolRequest(child, message);
        return;
      case "tool.cancel":
        this.#handleToolCancel(message);
        return;
    }
  }

  #handleExit(child: ChildProcess, error: Error): void {
    if (this.#child !== child) {
      return;
    }
    this.#child = null;
    this.#starting = null;
    const ready = this.#readyWaiter;
    this.#readyWaiter = null;
    if (ready !== null) {
      clearTimeout(ready.timer);
      ready.reject(error);
    }
    this.#failAll(error);
    this.#abortAllTools();
    for (const listener of this.#failureListeners) {
      try {
        listener(error);
      } catch {
        continue;
      }
    }
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #workerFailure(error: unknown): DomainError {
    return new DomainError(
      error instanceof Error ? error.message : "Agent worker unavailable",
      "agent_worker_unavailable",
      503,
    );
  }

  #handleToolRequest(
    child: ChildProcess,
    request: AgentToolRequestMessage,
  ): void {
    if (this.#activeToolRequests.has(request.requestId)) {
      this.#sendToolError(child, request, {
        code: "conflict",
        message: "Duplicate tool request id",
        retryable: false,
      });
      return;
    }
    const remaining = Date.parse(request.deadlineAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      this.#sendToolError(child, request, {
        code: "cancelled",
        message: "Tool request deadline has expired",
        retryable: true,
      });
      return;
    }
    const handler = this.#toolHandler;
    if (handler === undefined) {
      this.#sendToolError(child, request, {
        code: "unavailable",
        message: "Parent tool service is not enabled",
        retryable: true,
      });
      return;
    }

    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort();
      this.#activeToolRequests.delete(request.requestId);
      this.#sendToolError(child, request, {
        code: "cancelled",
        message: "Parent tool execution timed out",
        retryable: true,
      });
    }, Math.min(remaining, 300_000));
    timer.unref();
    this.#activeToolRequests.set(request.requestId, {
      request,
      abort,
      timer,
    });

    void handler.execute(request, abort.signal).then(
      (result) => {
        if (!this.#finishToolRequest(request.requestId)) {
          return;
        }
        try {
          const command = agentToolResultCommandSchema.parse({
            type: "tool.result",
            protocolVersion: AGENT_TOOL_PROTOCOL_VERSION,
            requestId: request.requestId,
            sessionId: request.sessionId,
            toolCallId: request.toolCallId,
            tool: request.tool,
            ok: true,
            result,
          });
          this.#sendDirect(child, command);
        } catch {
          this.#sendToolError(child, request, {
            code: "internal",
            message: "Parent tool returned an invalid result",
            retryable: false,
          });
        }
      },
      (error: unknown) => {
        if (!this.#finishToolRequest(request.requestId)) {
          return;
        }
        this.#sendToolError(child, request, this.#toolError(error));
      },
    );
  }

  #handleToolCancel(message: AgentToolCancelMessage): void {
    const active = this.#activeToolRequests.get(message.requestId);
    if (
      active === undefined ||
      active.request.sessionId !== message.sessionId ||
      active.request.toolCallId !== message.toolCallId
    ) {
      return;
    }
    clearTimeout(active.timer);
    this.#activeToolRequests.delete(message.requestId);
    active.abort.abort();
  }

  #finishToolRequest(requestId: string): boolean {
    const active = this.#activeToolRequests.get(requestId);
    if (active === undefined) {
      return false;
    }
    clearTimeout(active.timer);
    this.#activeToolRequests.delete(requestId);
    return true;
  }

  #abortAllTools(): void {
    for (const active of this.#activeToolRequests.values()) {
      clearTimeout(active.timer);
      active.abort.abort();
    }
    this.#activeToolRequests.clear();
  }

  #sendToolError(
    child: ChildProcess,
    request: AgentToolRequestMessage,
    error: AgentToolRemoteError,
  ): void {
    if (this.#child !== child || !child.connected) {
      return;
    }
    const command = agentToolResultCommandSchema.parse({
      type: "tool.result",
      protocolVersion: AGENT_TOOL_PROTOCOL_VERSION,
      requestId: request.requestId,
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      tool: request.tool,
      ok: false,
      error,
    });
    this.#sendDirect(child, command);
  }

  #sendDirect(child: ChildProcess, message: AgentWorkerCommand): void {
    if (this.#child !== child || !child.connected) {
      return;
    }
    child.send(message, () => undefined);
  }

  #toolError(error: unknown): AgentToolRemoteError {
    if (error instanceof DomainError) {
      const code: AgentToolRemoteError["code"] =
        error.code === "forbidden"
          ? "forbidden"
          : error.code === "not_found"
            ? "not_found"
            : error.statusCode === 409
              ? "conflict"
              : error.statusCode === 429
                ? "rate_limited"
                : error.statusCode >= 500
                  ? "unavailable"
                  : "invalid_request";
      return {
        code,
        message: error.message.slice(0, 4_000),
        retryable: error.statusCode >= 500 || error.statusCode === 429,
      };
    }
    return {
      code: "internal",
      message:
        (error instanceof Error ? error.message : String(error)).slice(
          0,
          4_000,
        ) || "Parent tool execution failed",
      retryable: false,
    };
  }
}
