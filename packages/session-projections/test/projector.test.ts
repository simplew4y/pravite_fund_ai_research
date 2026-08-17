import { describe, expect, it } from "vitest";

import {
  sessionJournalEventSchema,
  type JournalBlobReference,
  type PayloadClassification,
  type SessionEventSourceKind,
  type SessionJournalEvent,
} from "@private-fund/contracts";
import { sha256Hex } from "@private-fund/core";

import {
  computeSessionJournalEventHash,
  computeSessionJournalPayloadHash,
  computeSessionJournalRequestHash,
  projectSessionJournal,
} from "../src/index.js";

const SESSION_ID = "session-projection-1";
const HASH_ZERO = "0".repeat(64);
const HASH_F = "f".repeat(64);

interface EventSpec {
  readonly eventId?: string;
  readonly type: string;
  readonly payload?: Record<string, unknown>;
  readonly sourceKind?: SessionEventSourceKind;
  readonly classification?: PayloadClassification;
  readonly operationId?: string | null;
  readonly turnId?: string | null;
  readonly stepId?: string | null;
  readonly blobReferences?: readonly JournalBlobReference[];
}

function eventFrom(
  spec: EventSpec,
  sequence: number,
  previousHash: string | null,
): SessionJournalEvent {
  const payload = spec.payload ?? {};
  const payloadHash = computeSessionJournalPayloadHash(payload);
  const semantic = {
    schemaVersion: 1 as const,
    type: spec.type,
    operationId: spec.operationId ?? "operation-1",
    turnId: spec.turnId ?? "turn-1",
    stepId: spec.stepId ?? null,
    source: {
      kind: spec.sourceKind ?? "runtime",
      id: null,
      version: "fixture-v1",
    },
    causationEventId: null,
    classification: spec.classification ?? "internal",
    payloadHash,
    blobReferences: [...(spec.blobReferences ?? [])],
  };
  const requestHash = computeSessionJournalRequestHash(semantic);
  const withoutEventHash: Omit<SessionJournalEvent, "eventHash"> = {
    eventId: spec.eventId ?? `event-${String(sequence)}`,
    sessionId: SESSION_ID,
    sequence,
    schemaVersion: 1,
    type: spec.type,
    timestamp: new Date(
      Date.parse("2026-08-16T12:00:00.000Z") + sequence * 1_000,
    ).toISOString(),
    operationId: semantic.operationId,
    turnId: semantic.turnId,
    stepId: semantic.stepId,
    source: semantic.source,
    causationEventId: semantic.causationEventId,
    idempotencyKey: `idempotency-${String(sequence)}`,
    classification: semantic.classification,
    payload,
    blobReferences: semantic.blobReferences,
    payloadHash,
    requestHash,
    previousHash,
  };
  return sessionJournalEventSchema.parse({
    ...withoutEventHash,
    eventHash: computeSessionJournalEventHash(withoutEventHash),
  });
}

function chain(specs: readonly EventSpec[]): SessionJournalEvent[] {
  const events: SessionJournalEvent[] = [];
  let previousHash: string | null = null;
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    if (spec === undefined) {
      throw new Error("Missing fixture spec");
    }
    const event = eventFrom(spec, index + 1, previousHash);
    events.push(event);
    previousHash = event.eventHash;
  }
  return events;
}

function rehashEvent(
  event: SessionJournalEvent,
  changes: Partial<Omit<SessionJournalEvent, "eventHash">>,
): SessionJournalEvent {
  const { eventHash: _eventHash, ...current } = event;
  const withoutEventHash = { ...current, ...changes };
  return sessionJournalEventSchema.parse({
    ...withoutEventHash,
    eventHash: computeSessionJournalEventHash(withoutEventHash),
  });
}

const INTERNAL_ONLY = ["internal"] as const;

describe("deterministic Session Journal projection", () => {
  it("rebuilds the same versioned snapshot and checksum from the same events", async () => {
    const events = chain([
      {
        type: "message.user",
        sourceKind: "user",
        payload: { content: "Analyze Fund A" },
      },
      {
        type: "message.assistant.delta",
        sourceKind: "model",
        payload: { delta: "Working" },
      },
      {
        type: "tool.started",
        sourceKind: "tool",
        stepId: "step-tool-1",
        payload: { toolCallId: "call-1", toolName: "market_data" },
      },
      {
        type: "operation.completed",
        sourceKind: "runtime",
        payload: { status: "completed", ignoredDetail: "not projected" },
      },
    ]);

    const first = await projectSessionJournal({
      sessionId: SESSION_ID,
      events,
      allowedClassifications: INTERNAL_ONLY,
    });
    const rebuilt = await projectSessionJournal({
      sessionId: SESSION_ID,
      events,
      allowedClassifications: INTERNAL_ONLY,
    });

    expect(rebuilt.checksum).toBe(first.checksum);
    expect(rebuilt.recoverySnapshot).toEqual(first.recoverySnapshot);
    expect(first).toMatchObject({
      projectionVersion: 1,
      throughSequence: 4,
      lastEventHash: events[3]?.eventHash,
    });
    expect(first.checkpoint).toMatchObject({
      schemaVersion: 1,
      throughSequence: 4,
      checksum: first.checksum,
    });
    expect(first.transcript.items.map(({ kind }) => kind)).toEqual([
      "message",
      "message",
      "tool",
      "operation",
    ]);
    expect(first.operationStates).toEqual([
      expect.objectContaining({
        operationId: "operation-1",
        status: "completed",
      }),
    ]);
    expect(first.toolStates).toEqual([
      expect.objectContaining({
        toolCallId: "call-1",
        status: "started",
      }),
    ]);
  });

  it("idempotently ignores an identical duplicate event", async () => {
    const events = chain([
      { type: "message.user", payload: { content: "once" } },
      { type: "operation.completed" },
    ]);
    const result = await projectSessionJournal({
      sessionId: SESSION_ID,
      events: [events[0]!, events[0]!, events[1]!],
      allowedClassifications: INTERNAL_ONLY,
    });

    expect(result.throughSequence).toBe(2);
    expect(result.trajectory.events).toHaveLength(2);
    expect(result.recoverySnapshot.seenEvents).toHaveLength(2);
  });

  it("rejects eventId reuse with a different valid event hash", async () => {
    const first = eventFrom(
      { eventId: "same-event", type: "message.user", payload: { content: "A" } },
      1,
      null,
    );
    const conflict = eventFrom(
      {
        eventId: "same-event",
        type: "message.user",
        payload: { content: "B" },
      },
      2,
      first.eventHash,
    );

    await expect(
      projectSessionJournal({
        sessionId: SESSION_ID,
        events: [first, conflict],
        allowedClassifications: INTERNAL_ONLY,
      }),
    ).rejects.toMatchObject({ code: "duplicate_event_conflict", sequence: 2 });
  });
});

describe("Journal integrity validation", () => {
  it("rejects sequence gaps and previousHash mismatches", async () => {
    const first = eventFrom({ type: "message.user" }, 1, null);
    const gap = eventFrom(
      { eventId: "event-gap", type: "operation.completed" },
      3,
      first.eventHash,
    );
    const second = eventFrom(
      { type: "operation.completed" },
      2,
      first.eventHash,
    );
    const wrongPrevious = rehashEvent(second, { previousHash: HASH_ZERO });

    await expect(
      projectSessionJournal({
        sessionId: SESSION_ID,
        events: [first, gap],
        allowedClassifications: INTERNAL_ONLY,
      }),
    ).rejects.toMatchObject({ code: "sequence_gap", sequence: 3 });
    await expect(
      projectSessionJournal({
        sessionId: SESSION_ID,
        events: [first, wrongPrevious],
        allowedClassifications: INTERNAL_ONLY,
      }),
    ).rejects.toMatchObject({ code: "previous_hash_mismatch", sequence: 2 });
  });

  it.each([
    ["payload_hash_mismatch", (event: SessionJournalEvent) => ({ ...event, payload: { changed: true } })],
    ["request_hash_mismatch", (event: SessionJournalEvent) => ({ ...event, requestHash: HASH_F })],
    ["event_hash_mismatch", (event: SessionJournalEvent) => ({ ...event, eventHash: HASH_F })],
  ] as const)("rejects %s", async (expectedCode, mutate) => {
    const event = eventFrom(
      { type: "message.user", payload: { content: "integrity" } },
      1,
      null,
    );

    await expect(
      projectSessionJournal({
        sessionId: SESSION_ID,
        events: [mutate(event)],
        allowedClassifications: INTERNAL_ONLY,
      }),
    ).rejects.toMatchObject({ code: expectedCode, sequence: 1 });
  });
});

describe("critical events, permissions and normalized views", () => {
  it("retains unknown non-critical events but blocks checkpoints for unknown critical events", async () => {
    const nonCritical = await projectSessionJournal({
      sessionId: SESSION_ID,
      events: chain([
        {
          type: "telemetry.experimental",
          sourceKind: "system",
          payload: { counter: 1 },
        },
      ]),
      allowedClassifications: INTERNAL_ONLY,
    });
    expect(nonCritical.trajectory.events).toEqual([
      expect.objectContaining({
        type: "telemetry.experimental",
        knownType: false,
        criticalType: false,
      }),
    ]);
    expect(nonCritical.checkpoint).not.toBeNull();

    const critical = await projectSessionJournal({
      sessionId: SESSION_ID,
      events: chain([
        {
          type: "operation.future_state",
          sourceKind: "runtime",
          payload: { status: "future" },
        },
      ]),
      allowedClassifications: INTERNAL_ONLY,
    });
    expect(critical.trajectory.events[0]).toMatchObject({
      knownType: false,
      criticalType: true,
    });
    expect(critical.checkpoint).toBeNull();
    expect(critical.checkpointBlockers).toEqual([
      expect.objectContaining({
        code: "unknown_critical_event",
        type: "operation.future_state",
      }),
    ]);
  });

  it("never exposes thinking, raw reasoning or restricted payload in transcript", async () => {
    const result = await projectSessionJournal({
      sessionId: SESSION_ID,
      events: chain([
        {
          type: "message.user",
          sourceKind: "user",
          payload: {
            message: {
              role: "user",
              content: [
                { type: "thinking", thinking: "hidden thought" },
                { type: "text", text: "Visible question" },
              ],
            },
            rawReasoning: "hidden raw chain",
          },
        },
        {
          type: "message.thinking.delta",
          sourceKind: "model",
          payload: { delta: "private reasoning delta" },
        },
        {
          type: "message.assistant.completed",
          sourceKind: "model",
          classification: "restricted",
          payload: { content: "restricted answer" },
        },
      ]),
      allowedClassifications: ["internal", "restricted"],
    });

    expect(result.transcript.items).toEqual([
      expect.objectContaining({
        kind: "message",
        role: "user",
        content: "Visible question",
        redacted: false,
      }),
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        content: null,
        redacted: true,
      }),
    ]);
    expect(result.trajectory.events[2]?.payload).toEqual({
      visibility: "redacted",
      reason: "restricted_payload",
    });
    expect(result.trajectory.events[1]?.payload).toEqual({
      visibility: "redacted",
      reason: "reasoning_payload",
    });
    expect(result.trajectory.events[0]?.payload).toMatchObject({
      visibility: "visible",
      value: {
        rawReasoning: "[REDACTED]",
      },
    });
    expect(JSON.stringify(result.trajectory)).not.toContain("hidden raw chain");
    const serializedTranscript = JSON.stringify(result.transcript);
    expect(serializedTranscript).not.toContain("hidden thought");
    expect(serializedTranscript).not.toContain("hidden raw chain");
    expect(serializedTranscript).not.toContain("private reasoning delta");
    expect(serializedTranscript).not.toContain("restricted answer");
  });

  it("fails closed for classifications outside the explicit allowlist", async () => {
    const result = await projectSessionJournal({
      sessionId: SESSION_ID,
      events: chain([
        {
          type: "message.user",
          classification: "confidential",
          payload: { content: "confidential question" },
        },
      ]),
      allowedClassifications: [],
    });

    expect(result.trajectory.events[0]?.payload).toEqual({
      visibility: "redacted",
      reason: "classification_not_allowed",
    });
    expect(result.transcript.items[0]).toMatchObject({
      content: null,
      redacted: true,
    });
    expect(JSON.stringify(result)).not.toContain("confidential question");
  });

  it("filters trajectory by source without skipping integrity or transcript reduction", async () => {
    const result = await projectSessionJournal({
      sessionId: SESSION_ID,
      events: chain([
        {
          type: "message.user",
          sourceKind: "user",
          payload: { content: "Question" },
        },
        {
          type: "message.assistant.delta",
          sourceKind: "model",
          payload: { delta: "Answer" },
        },
        {
          type: "telemetry.experimental",
          sourceKind: "context",
          payload: { marker: true },
        },
      ]),
      allowedClassifications: INTERNAL_ONLY,
      trajectorySources: ["model", "context"],
    });

    expect(result.trajectory.events.map(({ type }) => type)).toEqual([
      "message.assistant.delta",
      "telemetry.experimental",
    ]);
    expect(result.transcript.items).toHaveLength(2);
    expect(result.throughSequence).toBe(3);
  });
});

describe("blob and checkpoint continuation", () => {
  it("requires explicit blob reads and returns only indexable references", async () => {
    const bytes = new TextEncoder().encode("blob payload");
    const reference: JournalBlobReference = {
      blobId: "blob-1",
      sha256: sha256Hex(bytes),
      sizeBytes: bytes.byteLength,
      mimeType: "application/octet-stream",
      classification: "internal",
    };
    const [event] = chain([
      {
        type: "model.request.snapshot",
        sourceKind: "model",
        blobReferences: [reference],
        payload: { blobId: "blob-1" },
      },
    ]);
    if (event === undefined) {
      throw new Error("Missing blob fixture event");
    }

    await expect(
      projectSessionJournal({
        sessionId: SESSION_ID,
        events: [event],
        allowedClassifications: INTERNAL_ONLY,
      }),
    ).rejects.toMatchObject({ code: "blob_reader_required" });
    await expect(
      projectSessionJournal({
        sessionId: SESSION_ID,
        events: [event],
        allowedClassifications: INTERNAL_ONLY,
        blobReader: () => null,
      }),
    ).rejects.toMatchObject({ code: "blob_missing" });

    const projected = await projectSessionJournal({
      sessionId: SESSION_ID,
      events: [event],
      allowedClassifications: INTERNAL_ONLY,
      blobReader: () => bytes,
    });
    expect(projected.indexReferences).toEqual([
      expect.objectContaining({
        kind: "journal_blob",
        blobId: "blob-1",
        sha256: reference.sha256,
        allowed: true,
      }),
    ]);
    expect(JSON.stringify(projected.indexReferences)).not.toContain(
      "blob payload",
    );
  });

  it("does not fetch a blob outside the explicit classification allowlist", async () => {
    const restrictedBytes = new TextEncoder().encode("restricted reasoning");
    const reference: JournalBlobReference = {
      blobId: "blob-restricted",
      sha256: sha256Hex(restrictedBytes),
      sizeBytes: restrictedBytes.byteLength,
      mimeType: "application/octet-stream",
      classification: "restricted",
    };
    const events = chain([
      {
        type: "message.thinking.delta",
        sourceKind: "model",
        classification: "restricted",
        blobReferences: [reference],
        payload: { blobId: reference.blobId },
      },
    ]);
    let reads = 0;

    const result = await projectSessionJournal({
      sessionId: SESSION_ID,
      events,
      allowedClassifications: INTERNAL_ONLY,
      blobReader: () => {
        reads += 1;
        return restrictedBytes;
      },
    });

    expect(reads).toBe(0);
    expect(result.indexReferences).toEqual([
      expect.objectContaining({
        allowed: false,
        blobId: null,
        sha256: null,
      }),
    ]);
  });

  it("continues from an explicit checkpoint and matches a full rebuild", async () => {
    const events = chain([
      { type: "message.user", sourceKind: "user", payload: { content: "Q" } },
      {
        type: "tool.started",
        sourceKind: "tool",
        payload: { toolCallId: "call-1", toolName: "research" },
      },
      {
        type: "tool.completed",
        sourceKind: "tool",
        payload: { toolCallId: "call-1", toolName: "research", result: "ok" },
      },
      { type: "operation.completed", sourceKind: "runtime" },
    ]);
    const full = await projectSessionJournal({
      sessionId: SESSION_ID,
      events,
      allowedClassifications: INTERNAL_ONLY,
      trajectorySources: ["user", "tool", "runtime"],
    });
    const firstHalf = await projectSessionJournal({
      sessionId: SESSION_ID,
      events: events.slice(0, 2),
      allowedClassifications: INTERNAL_ONLY,
      trajectorySources: ["user", "tool", "runtime"],
    });
    if (firstHalf.checkpoint === null) {
      throw new Error("Expected a continuation checkpoint");
    }

    const continued = await projectSessionJournal({
      sessionId: SESSION_ID,
      events: [events[1]!, ...events.slice(2)],
      allowedClassifications: INTERNAL_ONLY,
      trajectorySources: ["user", "tool", "runtime"],
      checkpoint: firstHalf.checkpoint,
      throughSequence: 2,
    });

    expect(continued.checksum).toBe(full.checksum);
    expect(continued.recoverySnapshot).toEqual(full.recoverySnapshot);
    expect(continued.throughSequence).toBe(4);
    expect(continued.toolStates).toEqual([
      expect.objectContaining({ status: "completed", toolCallId: "call-1" }),
    ]);
  });

  it("rejects continuation when the permission policy changes", async () => {
    const [event] = chain([{ type: "message.user", payload: { content: "Q" } }]);
    const first = await projectSessionJournal({
      sessionId: SESSION_ID,
      events: event === undefined ? [] : [event],
      allowedClassifications: INTERNAL_ONLY,
    });
    if (first.checkpoint === null) {
      throw new Error("Expected checkpoint");
    }

    await expect(
      projectSessionJournal({
        sessionId: SESSION_ID,
        events: [],
        allowedClassifications: ["public", "internal"],
        checkpoint: first.checkpoint,
        throughSequence: 1,
      }),
    ).rejects.toMatchObject({ code: "checkpoint_policy_mismatch" });
  });
});
