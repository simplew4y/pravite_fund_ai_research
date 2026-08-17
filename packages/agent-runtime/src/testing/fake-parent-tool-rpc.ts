import {
  AGENT_TOOL_PROTOCOL_VERSION,
  type AgentToolCancelMessage,
  type AgentToolRemoteError,
  type AgentToolRequestMessage,
  type AgentToolResultCommand,
} from "@private-fund/contracts";

import {
  ParentToolRpcClient,
  type ParentToolRpcClientOptions,
  type ParentToolRpcOutboundMessage,
  type ParentToolRpcResultDisposition,
} from "../parent-tool-rpc.js";

export interface FakeParentToolRpcOptions
  extends Omit<ParentToolRpcClientOptions, "send"> {}

export class FakeParentToolRpc {
  readonly requests: AgentToolRequestMessage[] = [];
  readonly cancellations: AgentToolCancelMessage[] = [];
  readonly client: ParentToolRpcClient;

  constructor(options: FakeParentToolRpcOptions = {}) {
    this.client = new ParentToolRpcClient({
      ...options,
      send: (message) => this.capture(message),
    });
  }

  respondSuccess(
    requestId: string,
    result: unknown,
    overrides: Partial<
      Pick<AgentToolResultCommand, "sessionId" | "toolCallId" | "tool">
    > = {},
  ): ParentToolRpcResultDisposition {
    const request = this.requireRequest(requestId);
    return this.client.handleResult({
      type: "tool.result",
      protocolVersion: AGENT_TOOL_PROTOCOL_VERSION,
      requestId,
      sessionId: overrides.sessionId ?? request.sessionId,
      toolCallId: overrides.toolCallId ?? request.toolCallId,
      tool: overrides.tool ?? request.tool,
      ok: true,
      result,
    });
  }

  respondError(
    requestId: string,
    error: AgentToolRemoteError,
  ): ParentToolRpcResultDisposition {
    const request = this.requireRequest(requestId);
    return this.client.handleResult({
      type: "tool.result",
      protocolVersion: AGENT_TOOL_PROTOCOL_VERSION,
      requestId,
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      tool: request.tool,
      ok: false,
      error,
    });
  }

  handleRawResult(result: unknown): ParentToolRpcResultDisposition {
    return this.client.handleResult(result);
  }

  requestAt(index: number): AgentToolRequestMessage {
    const request = this.requests[index];
    if (request === undefined) {
      throw new Error(`Fake parent tool request ${index} does not exist`);
    }
    return request;
  }

  private capture(message: ParentToolRpcOutboundMessage): void {
    if (message.type === "tool.request") {
      this.requests.push(message);
    } else {
      this.cancellations.push(message);
    }
  }

  private requireRequest(requestId: string): AgentToolRequestMessage {
    const request = this.requests.find(
      (candidate) => candidate.requestId === requestId,
    );
    if (request === undefined) {
      throw new Error(`Fake parent tool request not found: ${requestId}`);
    }
    return request;
  }
}
