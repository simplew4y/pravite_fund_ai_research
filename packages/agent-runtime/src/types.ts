import type {
  AgentWorkerCommand,
  AgentWorkerMessage,
  ModelGatewayAccess,
  TenantIdentity,
} from "@private-fund/contracts";

import { safeErrorMessage } from "./safe-error-message.js";

export type AgentEventWorkerMessage = Extract<
  AgentWorkerMessage,
  { type: "agent.event" }
>;

export interface HarnessStartInput {
  sessionId: string;
  projectId: string;
  tenant: TenantIdentity;
  workspace: string;
  sessionFile: string;
  model?: string;
}

/** Secret-bearing data is deliberately kept outside HarnessStartInput. */
export interface HarnessStartSecrets {
  modelGatewayAccess?: ModelGatewayAccess;
}

export interface HarnessPromptInput {
  sessionId: string;
  operationId: string;
  content: string;
}

export interface HarnessSteerInput {
  sessionId: string;
  content: string;
}

export interface HarnessCompactInput {
  sessionId: string;
  customInstructions?: string;
}

export interface HarnessSessionInput {
  sessionId: string;
}

export interface HarnessSessionInfo {
  sessionId: string;
  runtimeSessionId: string;
  sessionFile?: string;
}

export interface HarnessPromptHandle {
  operationId: string;
  completion: Promise<void>;
}

export interface HarnessCompactHandle {
  completion: Promise<void>;
}

export interface HarnessInterruptResult {
  operationId: string | null;
}

export type HarnessEventListener = (message: AgentEventWorkerMessage) => void;

export interface HarnessPort {
  start(
    input: HarnessStartInput,
    listener: HarnessEventListener,
    secrets?: HarnessStartSecrets,
  ): Promise<HarnessSessionInfo>;
  prompt(input: HarnessPromptInput): Promise<HarnessPromptHandle>;
  steer(input: HarnessSteerInput): Promise<void>;
  compact(input: HarnessCompactInput): Promise<HarnessCompactHandle>;
  interrupt(input: HarnessSessionInput): Promise<HarnessInterruptResult>;
  dispose(input: HarnessSessionInput): Promise<void>;
  disposeAll(): Promise<void>;
}

export type SessionStartCommand = Extract<
  AgentWorkerCommand,
  { type: "session.start" }
>;
export type SessionPromptCommand = Extract<
  AgentWorkerCommand,
  { type: "session.prompt" }
>;
export type SessionSteerCommand = Extract<
  AgentWorkerCommand,
  { type: "session.steer" }
>;
export type SessionInterruptCommand = Extract<
  AgentWorkerCommand,
  { type: "session.interrupt" }
>;
export type SessionCompactCommand = Extract<
  AgentWorkerCommand,
  { type: "session.compact" }
>;
export type SessionDisposeCommand = Extract<
  AgentWorkerCommand,
  { type: "session.dispose" }
>;

export class HarnessSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Agent session is not started: ${sessionId}`);
    this.name = "HarnessSessionNotFoundError";
  }
}

export class HarnessSessionBusyError extends Error {
  constructor(sessionId: string, operationId: string) {
    super(
      `Agent session ${sessionId} is already running operation ${operationId}`,
    );
    this.name = "HarnessSessionBusyError";
  }
}

export class HarnessSessionConflictError extends Error {
  constructor(sessionId: string) {
    super(`Agent session ${sessionId} was started with different configuration`);
    this.name = "HarnessSessionConflictError";
  }
}

export class HarnessPromptRejectedError extends Error {
  constructor(sessionId: string, operationId: string, reason?: unknown) {
    const prefix =
      `Pi rejected operation ${operationId} before starting session ${sessionId}`;
    const safeReason = safeErrorMessage(reason);
    super(safeReason === undefined ? prefix : `${prefix}: ${safeReason}`);
    this.name = "HarnessPromptRejectedError";
  }
}
