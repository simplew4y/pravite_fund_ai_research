import { randomUUID } from "node:crypto";

import {
  AGENT_TOOL_MAX_WIRE_BYTES,
  AGENT_TOOL_PROTOCOL_VERSION,
  agentToolRequestMessageSchema,
  agentToolResultCommandSchema,
  type AgentToolCancelMessage,
  type AgentToolName,
  type AgentToolRequestMessage,
  type AgentToolResultCommand,
} from "@private-fund/contracts";

import { errorMessage } from "./serialization.js";

export type ParentToolRpcOutboundMessage =
  | AgentToolRequestMessage
  | AgentToolCancelMessage;

export type ParentToolRpcSender = (
  message: ParentToolRpcOutboundMessage,
) => void;

export interface ParentToolRpcClientOptions {
  send: ParentToolRpcSender;
  timeoutMs?: number;
  requestIdFactory?: () => string;
  now?: () => number;
  maxWireBytes?: number;
}

export interface ParentToolRpcRequest {
  sessionId: string;
  toolCallId: string;
  tool: AgentToolName;
  arguments: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ParentToolRpcResponse {
  requestId: string;
  result: unknown;
}

export type ParentToolRpcResultDisposition = "settled" | "unknown";

interface PendingRequest {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  tool: AgentToolName;
  resolve(response: ParentToolRpcResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
}

export class ParentToolRpcProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParentToolRpcProtocolError";
  }
}

export class ParentToolRpcTimeoutError extends Error {
  readonly requestId: string;

  constructor(requestId: string, timeoutMs: number) {
    super(`Parent tool request ${requestId} timed out after ${timeoutMs}ms`);
    this.name = "ParentToolRpcTimeoutError";
    this.requestId = requestId;
  }
}

export class ParentToolRpcAbortedError extends Error {
  readonly requestId: string;
  readonly reason:
    | "aborted"
    | "session_disposed"
    | "worker_shutdown";

  constructor(
    requestId: string,
    reason: "aborted" | "session_disposed" | "worker_shutdown",
  ) {
    super(`Parent tool request ${requestId} was cancelled: ${reason}`);
    this.name = "ParentToolRpcAbortedError";
    this.requestId = requestId;
    this.reason = reason;
  }
}

export class ParentToolRpcRemoteError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId: string;

  constructor(
    requestId: string,
    error: NonNullable<AgentToolResultCommand["error"]>,
  ) {
    super(error.message);
    this.name = "ParentToolRpcRemoteError";
    this.code = error.code;
    this.retryable = error.retryable;
    this.requestId = requestId;
  }
}

function serializedByteLength(value: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new ParentToolRpcProtocolError(
      `Tool RPC payload is not serializable: ${errorMessage(error)}`,
    );
  }
  if (serialized === undefined) {
    throw new ParentToolRpcProtocolError(
      "Tool RPC payload cannot serialize to undefined",
    );
  }
  return Buffer.byteLength(serialized, "utf8");
}

export class ParentToolRpcClient {
  private readonly send: ParentToolRpcSender;
  private readonly timeoutMs: number;
  private readonly requestIdFactory: () => string;
  private readonly now: () => number;
  private readonly maxWireBytes: number;
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;

  constructor(options: ParentToolRpcClientOptions) {
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 10 ||
      timeoutMs > 300_000
    ) {
      throw new Error(
        "Parent tool RPC timeout must be an integer between 10 and 300000ms",
      );
    }
    const maxWireBytes = options.maxWireBytes ?? AGENT_TOOL_MAX_WIRE_BYTES;
    if (
      !Number.isInteger(maxWireBytes) ||
      maxWireBytes < 1_024 ||
      maxWireBytes > AGENT_TOOL_MAX_WIRE_BYTES
    ) {
      throw new Error(
        `Parent tool RPC maxWireBytes must be between 1024 and ${AGENT_TOOL_MAX_WIRE_BYTES}`,
      );
    }

    this.send = options.send;
    this.timeoutMs = timeoutMs;
    this.requestIdFactory =
      options.requestIdFactory ?? (() => `toolreq:${randomUUID()}`);
    this.now = options.now ?? Date.now;
    this.maxWireBytes = maxWireBytes;
  }

  request(input: ParentToolRpcRequest): Promise<ParentToolRpcResponse> {
    if (this.closed) {
      return Promise.reject(
        new Error("Parent tool RPC client is shut down"),
      );
    }
    if (input.signal?.aborted === true) {
      return Promise.reject(
        new ParentToolRpcAbortedError(
          "not-sent",
          "aborted",
        ),
      );
    }

    const requestId = this.requestIdFactory();
    if (this.pending.has(requestId)) {
      return Promise.reject(
        new ParentToolRpcProtocolError(
          `Duplicate parent tool request id: ${requestId}`,
        ),
      );
    }

    const rawMessage: AgentToolRequestMessage = {
      type: "tool.request",
      protocolVersion: AGENT_TOOL_PROTOCOL_VERSION,
      requestId,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      tool: input.tool,
      arguments: input.arguments,
      deadlineAt: new Date(this.now() + this.timeoutMs).toISOString(),
    };
    this.assertWireSize(rawMessage);
    const message = agentToolRequestMessageSchema.parse(rawMessage);

    return new Promise<ParentToolRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cancelPending(
          requestId,
          "timeout",
          new ParentToolRpcTimeoutError(requestId, this.timeoutMs),
        );
      }, this.timeoutMs);
      timer.unref?.();

      const abortListener =
        input.signal === undefined
          ? undefined
          : () => {
              this.cancelPending(
                requestId,
                "aborted",
                new ParentToolRpcAbortedError(requestId, "aborted"),
              );
            };

      const pending: PendingRequest = {
        requestId,
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        tool: input.tool,
        resolve,
        reject,
        timer,
        signal: input.signal,
        abortListener,
      };
      this.pending.set(requestId, pending);
      input.signal?.addEventListener("abort", abortListener as () => void, {
        once: true,
      });

      try {
        this.send(message);
      } catch (error) {
        this.removePending(pending);
        reject(
          new Error(
            `Failed to send parent tool request ${requestId}: ${errorMessage(error)}`,
          ),
        );
      }
    });
  }

  handleResult(rawResult: unknown): ParentToolRpcResultDisposition {
    this.assertWireSize(rawResult);
    const parsed = agentToolResultCommandSchema.safeParse(rawResult);
    if (!parsed.success) {
      throw new ParentToolRpcProtocolError(
        `Invalid parent tool result: ${parsed.error.message}`,
      );
    }
    const result = parsed.data;
    const pending = this.pending.get(result.requestId);
    if (pending === undefined) {
      return "unknown";
    }

    if (
      pending.sessionId !== result.sessionId ||
      pending.toolCallId !== result.toolCallId ||
      pending.tool !== result.tool
    ) {
      throw new ParentToolRpcProtocolError(
        `Tool result correlation mismatch for ${result.requestId}`,
      );
    }

    this.removePending(pending);
    if (result.ok) {
      pending.resolve({
        requestId: result.requestId,
        result: result.result,
      });
    } else {
      pending.reject(
        new ParentToolRpcRemoteError(
          result.requestId,
          result.error as NonNullable<AgentToolResultCommand["error"]>,
        ),
      );
    }
    return "settled";
  }

  cancelSession(
    sessionId: string,
    reason: "session_disposed" | "aborted" = "session_disposed",
  ): number {
    const requests = [...this.pending.values()].filter(
      (pending) => pending.sessionId === sessionId,
    );
    for (const pending of requests) {
      this.cancelPending(
        pending.requestId,
        reason,
        new ParentToolRpcAbortedError(pending.requestId, reason),
      );
    }
    return requests.length;
  }

  shutdown(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of [...this.pending.values()]) {
      this.cancelPending(
        pending.requestId,
        "worker_shutdown",
        new ParentToolRpcAbortedError(
          pending.requestId,
          "worker_shutdown",
        ),
      );
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private cancelPending(
    requestId: string,
    reason:
      | "timeout"
      | "aborted"
      | "session_disposed"
      | "worker_shutdown",
    error: Error,
  ): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) {
      return;
    }
    this.removePending(pending);
    const cancellation: AgentToolCancelMessage = {
      type: "tool.cancel",
      protocolVersion: AGENT_TOOL_PROTOCOL_VERSION,
      requestId: pending.requestId,
      sessionId: pending.sessionId,
      toolCallId: pending.toolCallId,
      reason,
    };
    try {
      this.send(cancellation);
    } catch {
      pending.reject(error);
      return;
    }
    pending.reject(error);
  }

  private removePending(pending: PendingRequest): void {
    if (this.pending.get(pending.requestId) !== pending) {
      return;
    }
    this.pending.delete(pending.requestId);
    clearTimeout(pending.timer);
    if (pending.abortListener !== undefined) {
      pending.signal?.removeEventListener(
        "abort",
        pending.abortListener,
      );
    }
  }

  private assertWireSize(value: unknown): void {
    const size = serializedByteLength(value);
    if (size > this.maxWireBytes) {
      throw new ParentToolRpcProtocolError(
        `Tool RPC payload is ${size} bytes; limit is ${this.maxWireBytes}`,
      );
    }
  }
}
