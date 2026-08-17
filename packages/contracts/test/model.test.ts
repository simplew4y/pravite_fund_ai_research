import { describe, expect, it } from "vitest";

import {
  MODEL_REQUEST_SCHEMA_VERSION,
  MODEL_STREAM_SCHEMA_VERSION,
  modelProviderEventSchema,
  modelRequestDraftSchema,
} from "../src/index.js";

const HASH = "a".repeat(64);

function draft() {
  return {
    schemaVersion: MODEL_REQUEST_SCHEMA_VERSION,
    requestId: "request-1",
    sessionId: "session-1",
    operationId: "operation-1",
    turnId: "turn-1",
    stepId: "step-1",
    providerId: "recorded-provider",
    model: "recorded-model",
    compilerVersion: "context-compiler-1",
    journalThroughSequence: 4,
    body: {
      messages: [{ role: "user", content: "Analyze the fund" }],
      tools: [],
    },
    sourceManifest: [
      {
        sourceId: "source-1",
        origin: {
          kind: "user_message",
          id: "event-4",
          version: null,
          sequence: 4,
        },
        classification: "confidential",
        required: true,
        contentHash: HASH,
        sizeBytes: 16,
        bodyPointers: ["/messages/0/content"],
      },
    ],
  };
}

describe("model runtime contracts", () => {
  it("accepts a strict, source-addressable provider request draft", () => {
    expect(modelRequestDraftSchema.parse(draft())).toEqual(draft());
    expect(() =>
      modelRequestDraftSchema.parse({ ...draft(), unknown: true }),
    ).toThrow();
  });

  it.each([
    { authorization: "Bearer secret" },
    { metadata: { api_key: "secret" } },
    { nested: [{ accessToken: "secret" }] },
    { credentials: { value: "secret" } },
  ])("rejects secret-bearing body fields before dispatch", (body) => {
    expect(() => modelRequestDraftSchema.parse({ ...draft(), body })).toThrow(
      /forbidden secret field/,
    );
  });

  it("accepts versioned stream events and rejects unknown fields", () => {
    const event = modelProviderEventSchema.parse({
      schemaVersion: MODEL_STREAM_SCHEMA_VERSION,
      type: "usage",
      inputTokens: 10,
      outputTokens: 3,
    });
    expect(event).toMatchObject({
      type: "usage",
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(() =>
      modelProviderEventSchema.parse({
        schemaVersion: MODEL_STREAM_SCHEMA_VERSION,
        type: "final",
        finishReason: "stop",
        leakedApiKey: "secret",
      }),
    ).toThrow();
  });
});
