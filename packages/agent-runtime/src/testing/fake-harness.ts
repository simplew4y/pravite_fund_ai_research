import {
  HarnessSessionBusyError,
  HarnessSessionConflictError,
  HarnessSessionNotFoundError,
  type AgentEventWorkerMessage,
  type HarnessCompactHandle,
  type HarnessCompactInput,
  type HarnessEventListener,
  type HarnessInterruptResult,
  type HarnessPort,
  type HarnessPromptHandle,
  type HarnessPromptInput,
  type HarnessSessionInfo,
  type HarnessSessionInput,
  type HarnessStartInput,
  type HarnessSteerInput,
} from "../types.js";

interface FakeDeferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

interface FakeActiveOperation {
  operationId: string;
  deferred: FakeDeferred;
}

interface FakeSession {
  input: HarnessStartInput;
  listener: HarnessEventListener;
  active: FakeActiveOperation | null;
}

export type FakeHarnessCall =
  | { type: "start"; sessionId: string }
  | { type: "prompt"; sessionId: string; operationId: string; content: string }
  | { type: "steer"; sessionId: string; content: string }
  | { type: "compact"; sessionId: string; customInstructions?: string }
  | { type: "interrupt"; sessionId: string }
  | { type: "dispose"; sessionId: string };

export interface FakeHarnessOptions {
  autoCompletePrompts?: boolean;
}

function createDeferred(): FakeDeferred {
  let resolvePromise: (() => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return {
    promise,
    resolve() {
      resolvePromise?.();
    },
    reject(error: Error) {
      rejectPromise?.(error);
    },
  };
}

function isSameSession(
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

export class FakeHarness implements HarnessPort {
  readonly calls: FakeHarnessCall[] = [];

  private readonly sessions = new Map<string, FakeSession>();
  private readonly autoCompletePrompts: boolean;

  constructor(options: FakeHarnessOptions = {}) {
    this.autoCompletePrompts = options.autoCompletePrompts ?? true;
  }

  async start(
    input: HarnessStartInput,
    listener: HarnessEventListener,
  ): Promise<HarnessSessionInfo> {
    this.calls.push({ type: "start", sessionId: input.sessionId });
    const existing = this.sessions.get(input.sessionId);
    if (existing !== undefined) {
      if (!isSameSession(existing.input, input)) {
        throw new HarnessSessionConflictError(input.sessionId);
      }
      existing.listener = listener;
    } else {
      this.sessions.set(input.sessionId, {
        input,
        listener,
        active: null,
      });
    }
    return {
      sessionId: input.sessionId,
      runtimeSessionId: `fake:${input.sessionId}`,
      sessionFile: input.sessionFile,
    };
  }

  async prompt(input: HarnessPromptInput): Promise<HarnessPromptHandle> {
    const session = this.requireSession(input.sessionId);
    if (session.active !== null) {
      throw new HarnessSessionBusyError(
        input.sessionId,
        session.active.operationId,
      );
    }
    this.calls.push({
      type: "prompt",
      sessionId: input.sessionId,
      operationId: input.operationId,
      content: input.content,
    });
    const active: FakeActiveOperation = {
      operationId: input.operationId,
      deferred: createDeferred(),
    };
    session.active = active;
    const completion = active.deferred.promise.then(
      () => {
        if (session.active === active) {
          session.active = null;
        }
      },
      (error: unknown) => {
        if (session.active === active) {
          session.active = null;
        }
        throw error;
      },
    );
    void completion.catch(() => undefined);
    if (this.autoCompletePrompts) {
      queueMicrotask(() => active.deferred.resolve());
    }
    return {
      operationId: input.operationId,
      completion,
    };
  }

  async steer(input: HarnessSteerInput): Promise<void> {
    const session = this.requireSession(input.sessionId);
    if (session.active === null) {
      throw new Error(`Cannot steer idle fake session: ${input.sessionId}`);
    }
    this.calls.push({
      type: "steer",
      sessionId: input.sessionId,
      content: input.content,
    });
  }

  async compact(input: HarnessCompactInput): Promise<HarnessCompactHandle> {
    this.requireSession(input.sessionId);
    this.calls.push({
      type: "compact",
      sessionId: input.sessionId,
      ...(input.customInstructions === undefined
        ? {}
        : { customInstructions: input.customInstructions }),
    });
    return { completion: Promise.resolve() };
  }

  async interrupt(
    input: HarnessSessionInput,
  ): Promise<HarnessInterruptResult> {
    const session = this.requireSession(input.sessionId);
    this.calls.push({ type: "interrupt", sessionId: input.sessionId });
    const operationId = session.active?.operationId ?? null;
    session.active?.deferred.resolve();
    return { operationId };
  }

  async dispose(input: HarnessSessionInput): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    this.calls.push({ type: "dispose", sessionId: input.sessionId });
    session?.active?.deferred.resolve();
    this.sessions.delete(input.sessionId);
  }

  async disposeAll(): Promise<void> {
    await Promise.all(
      [...this.sessions.keys()].map((sessionId) =>
        this.dispose({ sessionId }),
      ),
    );
  }

  emit(
    sessionId: string,
    eventType: string,
    payload: Record<string, unknown> = {},
    operationId?: string | null,
  ): AgentEventWorkerMessage {
    const session = this.requireSession(sessionId);
    const message: AgentEventWorkerMessage = {
      type: "agent.event",
      sessionId,
      operationId:
        operationId === undefined
          ? (session.active?.operationId ?? null)
          : operationId,
      eventType,
      payload,
    };
    session.listener(message);
    return message;
  }

  completePrompt(sessionId: string): void {
    const session = this.requireSession(sessionId);
    session.active?.deferred.resolve();
  }

  failPrompt(sessionId: string, error: Error): void {
    const session = this.requireSession(sessionId);
    session.active?.deferred.reject(error);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  activeOperationId(sessionId: string): string | null {
    return this.requireSession(sessionId).active?.operationId ?? null;
  }

  private requireSession(sessionId: string): FakeSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new HarnessSessionNotFoundError(sessionId);
    }
    return session;
  }
}
