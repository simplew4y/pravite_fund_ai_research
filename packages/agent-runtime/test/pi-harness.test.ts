import type {
  AgentSessionEvent,
  PromptOptions,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { PiHarness } from "../src/pi-harness.js";
import type {
  PiAgentSession,
  PiSessionFactory,
} from "../src/pi-session.js";

interface DeferredRun {
  promise: Promise<void>;
  resolve(): void;
}

function deferredRun(): DeferredRun {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      resolvePromise?.();
    },
  };
}

class StubPiSession implements PiAgentSession {
  readonly sessionId = "pi-session-1";
  readonly sessionFile = "/tmp/session-1.jsonl";
  private listener: ((event: AgentSessionEvent) => void) | null = null;
  private run: DeferredRun | null = null;
  private compactionRun: DeferredRun | null = null;
  disposed = false;
  compactionAborted = false;
  compactInstructions: string | undefined;

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  prompt(_content: string, options?: PromptOptions): Promise<void> {
    this.run = deferredRun();
    options?.preflightResult?.(true);
    return this.run.promise;
  }

  async steer(_content: string): Promise<void> {}

  compact(customInstructions?: string): Promise<void> {
    this.compactInstructions = customInstructions;
    this.compactionRun = deferredRun();
    return this.compactionRun.promise;
  }

  abortCompaction(): void {
    this.compactionAborted = true;
    this.compactionRun?.resolve();
  }

  async abort(): Promise<void> {
    this.run?.resolve();
  }

  dispose(): void {
    this.disposed = true;
  }

  emit(event: AgentSessionEvent): void {
    this.listener?.(event);
  }

  completePrompt(): void {
    this.run?.resolve();
  }

  completeCompaction(): void {
    this.compactionRun?.resolve();
  }
}

class StubPiSessionFactory implements PiSessionFactory {
  readonly session = new StubPiSession();

  async create(): Promise<PiAgentSession> {
    return this.session;
  }
}

class RejectingPreflightPiSession extends StubPiSession {
  constructor(private readonly rejection: unknown) {
    super();
  }

  prompt(_content: string, options?: PromptOptions): Promise<void> {
    options?.preflightResult?.(false);
    return Promise.reject(this.rejection);
  }
}

const startInput = {
  sessionId: "session-1",
  projectId: "project-1",
  tenant: {
    userId: "user@example.com",
    dataNamespace: "0b2ca3f8-a4b8-4c04-b23b-f50d4bea46a7",
  },
  workspace: "/tmp/project-1",
  sessionFile: "/tmp/session-1.jsonl",
};

describe("PiHarness", () => {
  it("fails completion instead of settling idle on a final model error", async () => {
    const factory = new StubPiSessionFactory();
    const harness = new PiHarness(factory);
    const events: Array<{ eventType?: string }> = [];
    const modelToken = `pfm_${"m".repeat(48)}`;

    await harness.start(startInput, (event) => events.push(event));
    const handle = await harness.prompt({
      sessionId: "session-1",
      operationId: "operation-model-error",
      content: "Analyze revenue",
    });
    factory.session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage:
          `402 insufficient_available_balance Authorization: Bearer ${modelToken}`,
      },
    } as unknown as AgentSessionEvent);
    factory.session.emit({ type: "agent_settled" } as AgentSessionEvent);
    factory.session.completePrompt();

    await expect(handle.completion).rejects.toThrow(
      "402 insufficient_available_balance",
    );
    await expect(handle.completion).rejects.not.toThrow(modelToken);
    expect(events.map((event) => event.eventType)).not.toContain(
      "session.status",
    );
    expect(JSON.stringify(events)).not.toContain(modelToken);
  });

  it("clears a retryable model error when a later assistant message succeeds", async () => {
    const factory = new StubPiSessionFactory();
    const harness = new PiHarness(factory);
    const events: Array<{ eventType?: string; payload?: unknown }> = [];

    await harness.start(startInput, (event) => events.push(event));
    const handle = await harness.prompt({
      sessionId: "session-1",
      operationId: "operation-retried",
      content: "Analyze revenue",
    });
    factory.session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Temporary provider failure",
      },
    } as unknown as AgentSessionEvent);
    factory.session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Recovered" }],
        stopReason: "stop",
      },
    } as unknown as AgentSessionEvent);
    factory.session.emit({ type: "agent_settled" } as AgentSessionEvent);
    factory.session.completePrompt();

    await expect(handle.completion).resolves.toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: "session.status",
        payload: { status: "idle" },
      }),
    );
  });

  it("preserves a safe Pi preflight rejection reason", async () => {
    const session = new RejectingPreflightPiSession(
      new Error('No API key found for provider "custom_openai"'),
    );
    const harness = new PiHarness({
      async create() {
        return session;
      },
    });

    await harness.start(startInput, () => undefined);

    await expect(
      harness.prompt({
        sessionId: "session-1",
        operationId: "operation-rejected",
        content: "Analyze revenue",
      }),
    ).rejects.toThrow(
      'Pi rejected operation operation-rejected before starting session session-1: No API key found for provider "custom_openai"',
    );
  });

  it("redacts credentials from Pi preflight rejection reasons", async () => {
    const bearerToken = "header.payload.signature";
    const apiKey = "provider-secret-value-without-prefix";
    const session = new RejectingPreflightPiSession(
      new Error(
        `Provider rejected Authorization: Bearer ${bearerToken}; api_key=${apiKey}`,
      ),
    );
    const harness = new PiHarness({
      async create() {
        return session;
      },
    });

    await harness.start(startInput, () => undefined);

    const prompt = harness.prompt({
      sessionId: "session-1",
      operationId: "operation-secret",
      content: "Analyze revenue",
    });
    await expect(prompt).rejects.toThrow("Provider rejected");
    await expect(prompt).rejects.toThrow("[REDACTED]");
    await expect(prompt).rejects.not.toThrow(bearerToken);
    await expect(prompt).rejects.not.toThrow(apiKey);
  });

  it("redacts an unlabelled private-fund model token", async () => {
    const modelToken = `pfm_${"a".repeat(48)}`;
    const session = new RejectingPreflightPiSession(
      new Error(`Gateway rejected ${modelToken}`),
    );
    const harness = new PiHarness({
      async create() {
        return session;
      },
    });

    await harness.start(startInput, () => undefined);
    const prompt = harness.prompt({
      sessionId: "session-1",
      operationId: "operation-model-token",
      content: "Analyze revenue",
    });
    await expect(prompt).rejects.toThrow("Gateway rejected [REDACTED]");
    await expect(prompt).rejects.not.toThrow(modelToken);
  });

  it("correlates Pi events with the active operation and interrupts it", async () => {
    const factory = new StubPiSessionFactory();
    const harness = new PiHarness(factory);
    const events: unknown[] = [];

    await harness.start(startInput, (event) => events.push(event));
    const handle = await harness.prompt({
      sessionId: "session-1",
      operationId: "operation-1",
      content: "Analyze revenue",
    });
    factory.session.emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Revenue",
        partial: { role: "assistant" },
      },
    } as unknown as AgentSessionEvent);

    await expect(
      harness.prompt({
        sessionId: "session-1",
        operationId: "operation-2",
        content: "Competing prompt",
      }),
    ).rejects.toThrow("already running operation");

    const interrupted = await harness.interrupt({
      sessionId: "session-1",
    });
    await handle.completion;

    expect(interrupted).toEqual({ operationId: "operation-1" });
    expect(events).toContainEqual(
      expect.objectContaining({
        operationId: "operation-1",
        eventType: "message.assistant.delta",
      }),
    );
  });

  it("is idempotent for equal starts and disposes the Pi session", async () => {
    const factory = new StubPiSessionFactory();
    const harness = new PiHarness(factory);

    const first = await harness.start(startInput, () => undefined);
    const second = await harness.start(startInput, () => undefined);
    await harness.dispose({ sessionId: "session-1" });

    expect(second).toEqual(first);
    expect(factory.session.disposed).toBe(true);
  });

  it("runs explicit Pi compaction and forwards its lifecycle events", async () => {
    const factory = new StubPiSessionFactory();
    const harness = new PiHarness(factory);
    const events: unknown[] = [];

    await harness.start(startInput, (event) => events.push(event));
    const handle = await harness.compact({
      sessionId: "session-1",
      customInstructions: "Keep evidence citations",
    });
    factory.session.emit({
      type: "compaction_start",
      reason: "manual",
    } as AgentSessionEvent);
    factory.session.emit({
      type: "compaction_end",
      reason: "manual",
      result: null,
      aborted: false,
      willRetry: false,
    } as AgentSessionEvent);
    factory.session.completeCompaction();
    await handle.completion;

    expect(factory.session.compactInstructions).toBe(
      "Keep evidence citations",
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: null,
          eventType: "compaction.started",
        }),
        expect.objectContaining({
          operationId: null,
          eventType: "compaction.completed",
        }),
      ]),
    );
  });

  it("aborts an active compaction before disposing its Pi session", async () => {
    const factory = new StubPiSessionFactory();
    const harness = new PiHarness(factory);

    await harness.start(startInput, () => undefined);
    await harness.compact({ sessionId: "session-1" });
    await harness.dispose({ sessionId: "session-1" });

    expect(factory.session.compactionAborted).toBe(true);
    expect(factory.session.disposed).toBe(true);
  });
});
