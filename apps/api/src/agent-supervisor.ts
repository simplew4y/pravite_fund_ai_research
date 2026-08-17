// Agent runtime port contract. The Pi child-process supervisor that used to
// live here was retired in favour of the in-process harness agent loop
// (src/harness-agent/runtime.ts).
import {
  type AgentToolRequestMessage,
  type AgentWorkerMessage,
  type ModelGatewayAccess,
  type TenantIdentity,
} from "@private-fund/contracts";

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
   * Optional lifecycle hook for ports whose executor can die out-of-band.
   * The in-process harness runtime never fires it.
   */
  subscribeFailure?(listener: (error: Error) => void): () => void;
  stop(): Promise<void>;
}
