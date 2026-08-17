import type {
  AgentSessionEvent,
  PromptOptions,
} from "@earendil-works/pi-coding-agent";

import type { HarnessStartInput } from "./types.js";
import type { HarnessStartSecrets } from "./types.js";
import type { ModelGatewayAccess } from "@private-fund/contracts";

export interface PiAgentSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(content: string, options?: PromptOptions): Promise<void>;
  steer(content: string): Promise<void>;
  compact(customInstructions?: string): Promise<unknown>;
  abortCompaction(): void;
  abort(): Promise<void>;
  updateModelGatewayAccess?(access: ModelGatewayAccess): Promise<void>;
  dispose(): void;
}

export interface PiSessionFactory {
  create(
    input: HarnessStartInput,
    secrets?: HarnessStartSecrets,
  ): Promise<PiAgentSession>;
}
