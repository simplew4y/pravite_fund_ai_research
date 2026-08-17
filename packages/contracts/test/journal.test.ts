import { describe, expect, it } from "vitest";

import {
  SESSION_JOURNAL_SCHEMA_VERSION,
  appendSessionJournalEventSchema,
  sessionJournalEventSchema,
} from "../src/index.js";

const HASH = "a".repeat(64);

describe("session journal contracts", () => {
  it("applies safe append defaults without weakening the durable schema", () => {
    const input = appendSessionJournalEventSchema.parse({
      sessionId: "session-1",
      type: "message.user",
      idempotencyKey: "message-1",
      payload: { content: "hello" },
    });

    expect(input).toMatchObject({
      schemaVersion: SESSION_JOURNAL_SCHEMA_VERSION,
      operationId: null,
      turnId: null,
      stepId: null,
      causationEventId: null,
      classification: "internal",
      source: { kind: "runtime", id: null, version: null },
      blobReferences: [],
    });
    expect(() =>
      sessionJournalEventSchema.parse(input),
    ).toThrow();
  });

  it("requires complete integrity metadata for durable events", () => {
    const event = sessionJournalEventSchema.parse({
      eventId: "event-1",
      sessionId: "session-1",
      sequence: 1,
      schemaVersion: SESSION_JOURNAL_SCHEMA_VERSION,
      type: "model.request.snapshot",
      timestamp: "2026-08-16T12:00:00.000Z",
      operationId: "operation-1",
      turnId: "turn-1",
      stepId: "step-1",
      source: { kind: "model", id: "gateway-1", version: "1.0.0" },
      causationEventId: null,
      idempotencyKey: "request-1",
      classification: "confidential",
      payload: { provider: "recorded", model: "fixture" },
      blobReferences: [
        {
          blobId: "blob-1",
          sha256: HASH,
          sizeBytes: 10,
          mimeType: "application/json",
          classification: "confidential",
        },
      ],
      payloadHash: HASH,
      requestHash: HASH,
      previousHash: null,
      eventHash: HASH,
    });

    expect(event.type).toBe("model.request.snapshot");
    expect(() =>
      sessionJournalEventSchema.parse({ ...event, eventHash: "not-a-hash" }),
    ).toThrow();
    expect(() =>
      appendSessionJournalEventSchema.parse({
        sessionId: "session-1",
        type: "message.user",
        idempotencyKey: "message-1",
        payload: {},
        unknownSecurityField: "ignored",
      }),
    ).toThrow();
  });
});
