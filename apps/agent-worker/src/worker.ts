import {
  KeyedSerialExecutor,
  ParentToolRpcClient,
  errorMessage,
  type HarnessPort,
} from "@private-fund/agent-runtime";
import {
  agentWorkerCommandSchema,
  type AgentToolResultCommand,
  type AgentWorkerCommand,
  type AgentWorkerMessage,
} from "@private-fund/contracts";

export type AgentWorkerSender = (message: AgentWorkerMessage) => void;

interface DispatchResult {
  messagesAfterAcknowledgement: AgentWorkerMessage[];
}

const EMPTY_DISPATCH_RESULT: DispatchResult = {
  messagesAfterAcknowledgement: [],
};

export class AgentWorkerCommandProcessor {
  private readonly harness: HarnessPort;
  private readonly send: AgentWorkerSender;
  private readonly parentToolRpc: ParentToolRpcClient | undefined;
  private readonly serial = new KeyedSerialExecutor();
  private acceptingCommands = true;

  constructor(
    harness: HarnessPort,
    send: AgentWorkerSender,
    parentToolRpc?: ParentToolRpcClient,
  ) {
    this.harness = harness;
    this.send = send;
    this.parentToolRpc = parentToolRpc;
  }

  async handle(rawCommand: unknown): Promise<void> {
    if (!this.acceptingCommands) {
      this.send({
        type: "worker.error",
        error: "Agent worker is shutting down",
      });
      return;
    }

    const parsed = agentWorkerCommandSchema.safeParse(rawCommand);
    if (!parsed.success) {
      this.send({
        type: "worker.error",
        error: `Invalid agent worker command: ${parsed.error.message}`,
      });
      return;
    }

    const command = parsed.data;
    if (command.type === "tool.result") {
      this.handleToolResult(command);
      return;
    }

    try {
      const result = await this.serial.run(command.sessionId, () =>
        this.dispatch(command),
      );
      this.send({
        type: "command.result",
        requestId: command.requestId,
        ok: true,
      });
      for (const message of result.messagesAfterAcknowledgement) {
        this.send(message);
      }
    } catch (error) {
      this.send({
        type: "command.result",
        requestId: command.requestId,
        ok: false,
        error: errorMessage(error),
      });
    }
  }

  async shutdown(): Promise<void> {
    if (!this.acceptingCommands) {
      return;
    }
    this.acceptingCommands = false;
    this.parentToolRpc?.shutdown();
    await this.serial.drain();
    await this.harness.disposeAll();
  }

  private async dispatch(command: AgentWorkerCommand): Promise<DispatchResult> {
    switch (command.type) {
      case "session.start":
        await this.harness.start(
          {
            sessionId: command.sessionId,
            projectId: command.projectId,
            tenant: command.tenant,
            workspace: command.workspace,
            sessionFile: command.sessionFile,
            ...(command.model === undefined ? {} : { model: command.model }),
          },
          (message) => {
            this.send(message);
          },
          command.modelGatewayAccess === undefined
            ? undefined
            : { modelGatewayAccess: command.modelGatewayAccess },
        );
        return EMPTY_DISPATCH_RESULT;

      case "session.prompt": {
        const handle = await this.harness.prompt({
          sessionId: command.sessionId,
          operationId: command.operationId,
          content: command.content,
        });
        void handle.completion.catch((error: unknown) => {
          try {
            this.send({
              type: "agent.event",
              sessionId: command.sessionId,
              operationId: command.operationId,
              eventType: "operation.failed",
              payload: {
                error: errorMessage(error),
              },
            });
          } catch {
            return;
          }
        });
        return EMPTY_DISPATCH_RESULT;
      }

      case "session.steer":
        await this.harness.steer({
          sessionId: command.sessionId,
          content: command.content,
        });
        return EMPTY_DISPATCH_RESULT;

      case "session.interrupt": {
        const result = await this.harness.interrupt({
          sessionId: command.sessionId,
        });
        this.parentToolRpc?.cancelSession(command.sessionId, "aborted");
        if (result.operationId === null) {
          return EMPTY_DISPATCH_RESULT;
        }
        return {
          messagesAfterAcknowledgement: [
            {
              type: "agent.event",
              sessionId: command.sessionId,
              operationId: result.operationId,
              eventType: "operation.interrupted",
              payload: {},
            },
          ],
        };
      }

      case "session.compact": {
        const handle = await this.harness.compact({
          sessionId: command.sessionId,
          ...(command.customInstructions === undefined
            ? {}
            : { customInstructions: command.customInstructions }),
        });
        void handle.completion.catch((error: unknown) => {
          try {
            this.send({
              type: "agent.event",
              sessionId: command.sessionId,
              operationId: null,
              eventType: "compaction.failed",
              payload: { error: errorMessage(error) },
            });
          } catch {
            return;
          }
        });
        return EMPTY_DISPATCH_RESULT;
      }

      case "session.dispose":
        await this.harness.dispose({
          sessionId: command.sessionId,
        });
        this.parentToolRpc?.cancelSession(
          command.sessionId,
          "session_disposed",
        );
        return EMPTY_DISPATCH_RESULT;

      case "tool.result":
        throw new Error("Tool results are handled outside the session queue");
    }
  }

  private handleToolResult(command: AgentToolResultCommand): void {
    if (this.parentToolRpc === undefined) {
      this.send({
        type: "worker.error",
        sessionId: command.sessionId,
        error: `Unexpected tool result without parent RPC: ${command.requestId}`,
      });
      return;
    }

    try {
      const disposition = this.parentToolRpc.handleResult(command);
      if (disposition === "unknown") {
        this.send({
          type: "worker.error",
          sessionId: command.sessionId,
          error: `Unknown or expired tool result: ${command.requestId}`,
        });
      }
    } catch (error) {
      this.send({
        type: "worker.error",
        sessionId: command.sessionId,
        error: errorMessage(error),
      });
    }
  }
}
