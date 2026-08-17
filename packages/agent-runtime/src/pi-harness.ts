import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { mapPiEventToWorkerMessages } from "./pi-event-mapper.js";
import type { PiAgentSession, PiSessionFactory } from "./pi-session.js";
import { errorMessage } from "./serialization.js";
import { KeyedSerialExecutor } from "./serial-executor.js";
import {
  HarnessPromptRejectedError,
  HarnessSessionBusyError,
  HarnessSessionConflictError,
  HarnessSessionNotFoundError,
  type HarnessEventListener,
  type HarnessCompactHandle,
  type HarnessCompactInput,
  type HarnessInterruptResult,
  type HarnessPort,
  type HarnessPromptHandle,
  type HarnessPromptInput,
  type HarnessSessionInfo,
  type HarnessSessionInput,
  type HarnessStartInput,
  type HarnessStartSecrets,
  type HarnessSteerInput,
} from "./types.js";

interface ActiveOperation {
  operationId: string;
  completion: Promise<void>;
  interrupted: boolean;
  modelFailure: string | null;
}

interface SessionSlot {
  input: HarnessStartInput;
  session: PiAgentSession;
  listener: HarnessEventListener;
  unsubscribe: () => void;
  activeOperation: ActiveOperation | null;
  activeCompaction: Promise<void> | null;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      resolvePromise?.(value);
    },
  };
}

function sameStartConfiguration(
  left: HarnessStartInput,
  right: HarnessStartInput,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.projectId === right.projectId &&
    left.tenant.userId === right.tenant.userId &&
    left.tenant.dataNamespace === right.tenant.dataNamespace &&
    left.workspace === right.workspace &&
    left.sessionFile === right.sessionFile &&
    left.model === right.model
  );
}

export class PiHarness implements HarnessPort {
  private readonly factory: PiSessionFactory;
  private readonly sessions = new Map<string, SessionSlot>();
  private readonly serial = new KeyedSerialExecutor();

  constructor(factory: PiSessionFactory) {
    this.factory = factory;
  }

  start(
    input: HarnessStartInput,
    listener: HarnessEventListener,
    secrets?: HarnessStartSecrets,
  ): Promise<HarnessSessionInfo> {
    return this.serial.run(input.sessionId, async () => {
      const existing = this.sessions.get(input.sessionId);
      if (existing !== undefined) {
        if (!sameStartConfiguration(existing.input, input)) {
          throw new HarnessSessionConflictError(input.sessionId);
        }
        if (secrets?.modelGatewayAccess !== undefined) {
          if (existing.session.updateModelGatewayAccess === undefined) {
            throw new HarnessSessionConflictError(input.sessionId);
          }
          await existing.session.updateModelGatewayAccess(
            secrets.modelGatewayAccess,
          );
        }
        existing.listener = listener;
        return this.sessionInfo(input.sessionId, existing.session);
      }

      const session = await this.factory.create(input, secrets);
      const slot: SessionSlot = {
        input,
        session,
        listener,
        unsubscribe: () => undefined,
        activeOperation: null,
        activeCompaction: null,
      };
      slot.unsubscribe = session.subscribe((event) => {
        this.forwardEvent(slot, event);
      });
      this.sessions.set(input.sessionId, slot);

      return this.sessionInfo(input.sessionId, session);
    });
  }

  prompt(input: HarnessPromptInput): Promise<HarnessPromptHandle> {
    return this.serial.run(input.sessionId, async () => {
      const slot = this.requireSession(input.sessionId);
      if (slot.activeOperation !== null) {
        throw new HarnessSessionBusyError(
          input.sessionId,
          slot.activeOperation.operationId,
        );
      }

      const preflight = deferred<boolean>();
      let preflightReported = false;
      let preflightAccepted: boolean | undefined;
      const operation: ActiveOperation = {
        operationId: input.operationId,
        completion: Promise.resolve(),
        interrupted: false,
        modelFailure: null,
      };
      slot.activeOperation = operation;

      let piCompletion: Promise<void>;
      try {
        piCompletion = slot.session.prompt(input.content, {
          preflightResult: (accepted) => {
            if (!preflightReported) {
              preflightReported = true;
              preflightAccepted = accepted;
              preflight.resolve(accepted);
            }
          },
        });
      } catch (error) {
        slot.activeOperation = null;
        if (preflightAccepted === false) {
          throw new HarnessPromptRejectedError(
            input.sessionId,
            input.operationId,
            error,
          );
        }
        throw error;
      }

      const completion = piCompletion.then(
        () => {
          if (slot.activeOperation === operation) {
            slot.activeOperation = null;
          }
          if (
            operation.modelFailure !== null &&
            !operation.interrupted
          ) {
            throw new Error(operation.modelFailure);
          }
        },
        (error: unknown) => {
          if (slot.activeOperation === operation) {
            slot.activeOperation = null;
          }
          if (operation.interrupted) {
            return;
          }
          throw error;
        },
      );
      operation.completion = completion;
      void completion.catch(() => undefined);

      let accepted: boolean;
      try {
        accepted = await Promise.race([
          preflight.promise,
          completion.then(() => true),
        ]);
      } catch (error) {
        if (preflightAccepted === false) {
          throw new HarnessPromptRejectedError(
            input.sessionId,
            input.operationId,
            error,
          );
        }
        throw error;
      }
      if (!accepted) {
        let rejectionReason: unknown;
        try {
          await piCompletion;
        } catch (error) {
          rejectionReason = error;
        }
        if (slot.activeOperation === operation) {
          slot.activeOperation = null;
        }
        throw new HarnessPromptRejectedError(
          input.sessionId,
          input.operationId,
          rejectionReason,
        );
      }

      return {
        operationId: input.operationId,
        completion,
      };
    });
  }

  steer(input: HarnessSteerInput): Promise<void> {
    return this.serial.run(input.sessionId, async () => {
      const slot = this.requireSession(input.sessionId);
      if (slot.activeOperation === null) {
        throw new Error(
          `Cannot steer idle agent session: ${input.sessionId}`,
        );
      }
      await slot.session.steer(input.content);
    });
  }

  compact(input: HarnessCompactInput): Promise<HarnessCompactHandle> {
    return this.serial.run(input.sessionId, async () => {
      const slot = this.requireSession(input.sessionId);
      if (slot.activeOperation !== null) {
        throw new HarnessSessionBusyError(
          input.sessionId,
          slot.activeOperation.operationId,
        );
      }
      if (slot.activeCompaction !== null) {
        throw new Error(
          `Agent session compaction is already running: ${input.sessionId}`,
        );
      }
      const completion = slot.session
        .compact(input.customInstructions)
        .then(() => undefined)
        .finally(() => {
          if (slot.activeCompaction === completion) {
            slot.activeCompaction = null;
          }
        });
      slot.activeCompaction = completion;
      void completion.catch(() => undefined);
      return { completion };
    });
  }

  interrupt(input: HarnessSessionInput): Promise<HarnessInterruptResult> {
    return this.serial.run(input.sessionId, async () => {
      const slot = this.requireSession(input.sessionId);
      const operationId = slot.activeOperation?.operationId ?? null;
      if (operationId !== null) {
        if (slot.activeOperation !== null) {
          slot.activeOperation.interrupted = true;
        }
        await slot.session.abort();
      }
      return { operationId };
    });
  }

  dispose(input: HarnessSessionInput): Promise<void> {
    return this.serial.run(input.sessionId, async () => {
      const slot = this.sessions.get(input.sessionId);
      if (slot === undefined) {
        return;
      }

      if (slot.activeOperation !== null) {
        slot.activeOperation.interrupted = true;
        const completion = slot.activeOperation.completion;
        await slot.session.abort();
        await completion.catch(() => undefined);
      }
      if (slot.activeCompaction !== null) {
        slot.session.abortCompaction();
        await slot.activeCompaction.catch(() => undefined);
      }

      slot.unsubscribe();
      slot.session.dispose();
      this.sessions.delete(input.sessionId);
    });
  }

  async disposeAll(): Promise<void> {
    const sessionIds = [...this.sessions.keys()];
    await Promise.all(
      sessionIds.map((sessionId) => this.dispose({ sessionId })),
    );
    await this.serial.drain();
  }

  private requireSession(sessionId: string): SessionSlot {
    const slot = this.sessions.get(sessionId);
    if (slot === undefined) {
      throw new HarnessSessionNotFoundError(sessionId);
    }
    return slot;
  }

  private forwardEvent(slot: SessionSlot, event: AgentSessionEvent): void {
    const operation = slot.activeOperation;
    if (
      operation !== null &&
      event.type === "message_end" &&
      event.message.role === "assistant"
    ) {
      operation.modelFailure =
        event.message.stopReason === "error"
          ? errorMessage(
              event.message.errorMessage ?? "Model response failed",
            )
          : null;
    }

    // Pi resolves prompt() after agent_settled even when the final assistant
    // message has stopReason="error". Do not expose that settlement as an idle
    // success: completion rejects immediately afterwards and the worker emits
    // the single canonical operation.failed event.
    if (
      event.type === "agent_settled" &&
      operation !== null &&
      operation.modelFailure !== null &&
      !operation.interrupted
    ) {
      return;
    }

    const messages = mapPiEventToWorkerMessages(event, {
      sessionId: slot.input.sessionId,
      operationId: operation?.operationId ?? null,
    });
    for (const message of messages) {
      try {
        slot.listener(message);
      } catch {
        continue;
      }
    }
  }

  private sessionInfo(
    sessionId: string,
    session: PiAgentSession,
  ): HarnessSessionInfo {
    return {
      sessionId,
      runtimeSessionId: session.sessionId,
      ...(session.sessionFile === undefined
        ? {}
        : { sessionFile: session.sessionFile }),
    };
  }
}
