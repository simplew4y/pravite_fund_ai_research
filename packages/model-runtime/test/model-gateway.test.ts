import { describe, expect, it, vi } from "vitest";

import {
  MODEL_REQUEST_SCHEMA_VERSION,
  MODEL_STREAM_SCHEMA_VERSION,
  type ModelProviderEvent,
  type ModelRequestDraft,
  type ModelRequestSnapshot,
  type PayloadClassification,
} from "@private-fund/contracts";

import {
  ModelGateway,
  ModelGatewayAdmissionError,
  ModelGatewayRecoveryRequiredError,
  ModelGatewayUnavailableError,
  ModelJournalCommitError,
  createModelSourceManifestEntry,
  type ModelProvider,
  type ModelProviderEventCommit,
  type ModelRequestJournal,
} from "../src/index.js";

function makeDraft(suffix = "1"): ModelRequestDraft {
  const body = {
    messages: [{ role: "user", content: `Analyze ${suffix}` }],
    temperature: 0,
  };
  return {
    schemaVersion: MODEL_REQUEST_SCHEMA_VERSION,
    requestId: `request-${suffix}`,
    sessionId: "session-1",
    operationId: `operation-${suffix}`,
    turnId: `turn-${suffix}`,
    stepId: `step-${suffix}`,
    providerId: "recorded-provider",
    model: "recorded-model",
    compilerVersion: "context-compiler-1",
    journalThroughSequence: 3,
    body,
    sourceManifest: [
      createModelSourceManifestEntry(body, {
        sourceId: `source-${suffix}`,
        origin: {
          kind: "user_message",
          id: `event-${suffix}`,
          version: null,
          sequence: 3,
        },
        classification: "confidential",
        required: true,
        bodyPointers: [""],
      }),
    ],
  };
}

class MemoryJournal implements ModelRequestJournal {
  readonly requests: Array<{
    snapshot: ModelRequestSnapshot;
    classification: PayloadClassification;
  }> = [];
  readonly events: ModelProviderEventCommit[] = [];
  readonly order: string[] = [];
  failRequest = false;
  failEventIndex: number | null = null;

  async commitRequest(
    snapshot: ModelRequestSnapshot,
    classification: PayloadClassification,
  ) {
    this.order.push("request");
    if (this.failRequest) {
      throw new Error("forced request commit failure");
    }
    this.requests.push({ snapshot, classification });
    return {
      eventId: `request-event-${snapshot.requestId}`,
      sequence: 4,
      created: true,
    };
  }

  async commitProviderEvent(input: ModelProviderEventCommit): Promise<void> {
    this.order.push(`event:${String(input.eventIndex)}:${input.event.type}`);
    if (this.failEventIndex === input.eventIndex) {
      throw new Error("forced provider event commit failure");
    }
    this.events.push(input);
  }
}

function scriptedProvider(
  events: readonly ModelProviderEvent[],
  onInvoke: (signal: AbortSignal) => void = () => undefined,
): ModelProvider {
  return {
    id: "recorded-provider",
    async *stream({ signal }) {
      onInvoke(signal);
      for (const event of events) {
        yield event;
      }
    },
  };
}

async function collect(
  stream: AsyncIterable<ModelProviderEvent>,
): Promise<ModelProviderEvent[]> {
  const events: ModelProviderEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("ModelGateway", () => {
  it("commits the exact request snapshot before invoking the Provider", async () => {
    const journal = new MemoryJournal();
    const invoked = vi.fn();
    const provider = scriptedProvider(
      [
        {
          schemaVersion: MODEL_STREAM_SCHEMA_VERSION,
          type: "final",
          finishReason: "stop",
          responseModel: "recorded-model",
        },
      ],
      invoked,
    );
    const gateway = new ModelGateway(provider, journal);

    const events = await collect(gateway.stream(makeDraft()));

    expect(invoked).toHaveBeenCalledOnce();
    expect(journal.order).toEqual(["request", "event:1:final"]);
    expect(journal.requests[0]).toMatchObject({
      classification: "confidential",
      snapshot: {
        requestId: "request-1",
        providerId: "recorded-provider",
      },
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "final", finishReason: "stop" }),
    ]);
    await gateway.dispose();
  });

  it("sends zero Provider requests when the snapshot commit fails", async () => {
    const journal = new MemoryJournal();
    journal.failRequest = true;
    const invoked = vi.fn();
    const gateway = new ModelGateway(scriptedProvider([], invoked), journal);

    await expect(collect(gateway.stream(makeDraft()))).rejects.toBeInstanceOf(
      ModelJournalCommitError,
    );
    expect(invoked).not.toHaveBeenCalled();
    expect(journal.events).toEqual([]);
    await gateway.dispose();
  });

  it("does not resend a request that an earlier attempt already committed", async () => {
    const journal = new MemoryJournal();
    journal.commitRequest = async (snapshot, classification) => {
      journal.requests.push({ snapshot, classification });
      return { eventId: "existing-request-event", sequence: 4, created: false };
    };
    const invoked = vi.fn();
    const gateway = new ModelGateway(scriptedProvider([], invoked), journal);

    await expect(collect(gateway.stream(makeDraft()))).rejects.toBeInstanceOf(
      ModelGatewayRecoveryRequiredError,
    );
    expect(invoked).not.toHaveBeenCalled();
    expect(journal.events).toEqual([]);
    await gateway.dispose();
  });

  it("persists each event before exposing it and restricts reasoning", async () => {
    const journal = new MemoryJournal();
    const events: ModelProviderEvent[] = [
      {
        schemaVersion: MODEL_STREAM_SCHEMA_VERSION,
        type: "delta",
        channel: "reasoning",
        delta: "private analysis",
        contentIndex: 0,
      },
      {
        schemaVersion: MODEL_STREAM_SCHEMA_VERSION,
        type: "delta",
        channel: "text",
        delta: "answer",
        contentIndex: 1,
      },
      {
        schemaVersion: MODEL_STREAM_SCHEMA_VERSION,
        type: "final",
        finishReason: "stop",
        responseModel: null,
      },
    ];
    const gateway = new ModelGateway(scriptedProvider(events), journal);
    const observed: string[] = [];
    for await (const event of gateway.stream(makeDraft())) {
      observed.push(`${journal.events.length}:${event.type}`);
    }

    expect(observed).toEqual(["1:delta", "2:delta", "3:final"]);
    expect(journal.events.map(({ classification }) => classification)).toEqual([
      "restricted",
      "confidential",
      "confidential",
    ]);
    await gateway.dispose();
  });

  it("does not expose an event whose Journal commit failed", async () => {
    const journal = new MemoryJournal();
    journal.failEventIndex = 1;
    let providerSignal: AbortSignal | undefined;
    const gateway = new ModelGateway(
      scriptedProvider(
        [
          {
            schemaVersion: MODEL_STREAM_SCHEMA_VERSION,
            type: "delta",
            channel: "text",
            delta: "not durable",
            contentIndex: 0,
          },
        ],
        (signal) => {
          providerSignal = signal;
        },
      ),
      journal,
    );
    const observed: ModelProviderEvent[] = [];

    await expect(
      (async () => {
        for await (const event of gateway.stream(makeDraft())) {
          observed.push(event);
        }
      })(),
    ).rejects.toBeInstanceOf(ModelJournalCommitError);
    expect(observed).toEqual([]);
    expect(providerSignal?.aborted).toBe(true);
    await gateway.dispose();
  });

  it("synthesizes a durable error when the Provider ends without a terminal event", async () => {
    const journal = new MemoryJournal();
    const gateway = new ModelGateway(
      scriptedProvider([
        {
          schemaVersion: MODEL_STREAM_SCHEMA_VERSION,
          type: "usage",
          inputTokens: 3,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ]),
      journal,
    );

    const events = await collect(gateway.stream(makeDraft()));
    expect(events.map(({ type }) => type)).toEqual(["usage", "error"]);
    expect(events[1]).toMatchObject({
      code: "provider_stream_incomplete",
      retryable: false,
    });
    expect(journal.events).toHaveLength(2);
    await gateway.dispose();
  });

  it("propagates cancellation and timeout as one durable terminal event", async () => {
    const blockingProvider = (): ModelProvider => ({
      id: "recorded-provider",
      async *stream({ signal }) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });

    const cancelledJournal = new MemoryJournal();
    const cancelledGateway = new ModelGateway(
      blockingProvider(),
      cancelledJournal,
    );
    const controller = new AbortController();
    const cancelled = collect(
      cancelledGateway.stream(makeDraft("cancel"), {
        signal: controller.signal,
      }),
    );
    await vi.waitFor(() => expect(cancelledGateway.activeCount).toBe(1));
    controller.abort();
    await expect(cancelled).resolves.toEqual([
      expect.objectContaining({ type: "aborted", reason: "cancelled" }),
    ]);
    expect(cancelledJournal.events).toHaveLength(1);
    await cancelledGateway.dispose();

    const timeoutJournal = new MemoryJournal();
    const timeoutGateway = new ModelGateway(blockingProvider(), timeoutJournal, {
      defaultTimeoutMs: 10,
    });
    await expect(
      collect(timeoutGateway.stream(makeDraft("timeout"))),
    ).resolves.toEqual([
      expect.objectContaining({ type: "aborted", reason: "timeout" }),
    ]);
    expect(timeoutJournal.events).toHaveLength(1);
    await timeoutGateway.dispose();
  });

  it("bounds admission and rejects queued work during shutdown", async () => {
    let invocation = 0;
    const provider: ModelProvider = {
      id: "recorded-provider",
      async *stream({ signal }) {
        invocation += 1;
        if (invocation === 1) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return;
        }
        yield {
          schemaVersion: MODEL_STREAM_SCHEMA_VERSION,
          type: "final",
          finishReason: "stop",
          responseModel: null,
        };
      },
    };
    const gateway = new ModelGateway(provider, new MemoryJournal(), {
      maxConcurrent: 1,
      maxQueue: 1,
      shutdownTimeoutMs: 500,
    });
    const first = collect(gateway.stream(makeDraft("first")));
    await vi.waitFor(() => expect(gateway.activeCount).toBe(1));
    const second = collect(gateway.stream(makeDraft("second")));
    await vi.waitFor(() => expect(gateway.queuedCount).toBe(1));
    await expect(
      collect(gateway.stream(makeDraft("third"))),
    ).rejects.toBeInstanceOf(ModelGatewayAdmissionError);

    const stopping = gateway.dispose();
    await expect(second).rejects.toBeInstanceOf(ModelGatewayUnavailableError);
    await expect(first).resolves.toEqual([
      expect.objectContaining({ type: "aborted", reason: "shutdown" }),
    ]);
    await expect(stopping).resolves.toBeUndefined();
    expect(gateway.activeCount).toBe(0);
  });

  it("redacts credential assignments in Provider errors before persistence", async () => {
    const journal = new MemoryJournal();
    const provider: ModelProvider = {
      id: "recorded-provider",
      stream() {
        throw new Error("api_key=super-secret-value upstream failed");
      },
    };
    const gateway = new ModelGateway(provider, journal);

    const events = await collect(gateway.stream(makeDraft()));
    expect(events).toEqual([
      expect.objectContaining({
        type: "error",
        message: "Model Provider request failed",
      }),
    ]);
    expect(JSON.stringify(journal.events)).not.toContain("super-secret-value");
    await gateway.dispose();
  });
});
