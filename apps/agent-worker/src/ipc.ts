import {
  createParentRpcToolRegistry,
  ParentToolRpcClient,
  PiAgentSessionFactory,
  PiHarness,
  type HarnessPort,
  type PiSessionFactoryOptions,
} from "@private-fund/agent-runtime";
import {
  agentWorkerMessageSchema,
  type AgentWorkerMessage,
} from "@private-fund/contracts";

import {
  AgentWorkerCommandProcessor,
  type AgentWorkerSender,
} from "./worker.js";

export interface AgentWorkerIpcOptions {
  harness?: HarnessPort;
  parentToolRpc?: ParentToolRpcClient;
  enableParentRpcTools?: boolean;
  parentToolRpcTimeoutMs?: number;
  piSessionFactoryOptions?: Omit<
    PiSessionFactoryOptions,
    "toolRegistry"
  >;
  workerId?: string;
  processRef?: NodeJS.Process;
}

export interface AgentWorkerIpcController {
  processor: AgentWorkerCommandProcessor;
  parentToolRpc: ParentToolRpcClient | undefined;
  stop(): Promise<void>;
}

function createProcessSender(processRef: NodeJS.Process): AgentWorkerSender {
  return (message: AgentWorkerMessage) => {
    const validated = agentWorkerMessageSchema.parse(message);
    if (
      typeof processRef.send !== "function" ||
      processRef.connected === false
    ) {
      throw new Error("Agent worker IPC channel is not connected");
    }
    processRef.send(validated);
  };
}

export function installAgentWorkerIpc(
  options: AgentWorkerIpcOptions = {},
): AgentWorkerIpcController {
  const processRef = options.processRef ?? process;
  const send = createProcessSender(processRef);
  const parentRpcToolsEnabled = options.enableParentRpcTools === true;
  if (parentRpcToolsEnabled && options.harness !== undefined) {
    throw new Error(
      "Cannot enable parent RPC tools with a preconstructed harness",
    );
  }
  if (
    options.piSessionFactoryOptions !== undefined &&
    Object.prototype.hasOwnProperty.call(
      options.piSessionFactoryOptions,
      "toolRegistry",
    )
  ) {
    throw new Error(
      "Agent worker tool registry can only be configured by its explicit RPC-tools switch",
    );
  }
  const parentToolRpc =
    options.parentToolRpc ??
    (parentRpcToolsEnabled
      ? new ParentToolRpcClient({
          send,
          ...(options.parentToolRpcTimeoutMs === undefined
            ? {}
            : { timeoutMs: options.parentToolRpcTimeoutMs }),
        })
      : undefined);
  const harness =
    options.harness ??
    new PiHarness(
      new PiAgentSessionFactory({
        ...options.piSessionFactoryOptions,
        ...(parentRpcToolsEnabled && parentToolRpc !== undefined
          ? { toolRegistry: createParentRpcToolRegistry(parentToolRpc) }
          : {}),
      }),
    );
  const processor = new AgentWorkerCommandProcessor(
    harness,
    send,
    parentToolRpc,
  );
  const workerId = options.workerId ?? `worker-${processRef.pid}`;
  let stopping: Promise<void> | null = null;

  const stop = (): Promise<void> => {
    if (stopping !== null) {
      return stopping;
    }
    processRef.off("message", onMessage);
    processRef.off("disconnect", onDisconnect);
    processRef.off("SIGTERM", onTerminate);
    processRef.off("SIGINT", onTerminate);
    stopping = processor.shutdown();
    return stopping;
  };

  const onMessage = (message: unknown): void => {
    void processor.handle(message).catch((error: unknown) => {
      try {
        send({
          type: "worker.error",
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        return;
      }
    });
  };

  const onDisconnect = (): void => {
    void stop().catch(() => {
      processRef.exitCode = 1;
    });
  };

  const onTerminate = (): void => {
    void stop().then(
      () => {
        processRef.exitCode = 0;
      },
      () => {
        processRef.exitCode = 1;
      },
    );
  };

  processRef.on("message", onMessage);
  processRef.on("disconnect", onDisconnect);
  processRef.on("SIGTERM", onTerminate);
  processRef.on("SIGINT", onTerminate);

  send({
    type: "worker.ready",
    workerId,
  });

  return {
    processor,
    parentToolRpc,
    stop,
  };
}
