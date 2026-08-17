import { describe, expect, it } from "vitest";

import {
  MODEL_REQUEST_SCHEMA_VERSION,
  type ModelRequestDraft,
} from "@private-fund/contracts";

import {
  ModelRequestProvenanceError,
  createModelSourceManifestEntry,
  prepareModelRequestSnapshot,
} from "../src/index.js";

const base = {
  schemaVersion: MODEL_REQUEST_SCHEMA_VERSION,
  requestId: "request-1",
  sessionId: "session-1",
  operationId: "operation-1",
  turnId: "turn-1",
  stepId: "step-1",
  providerId: "recorded-provider",
  model: "recorded-model",
  compilerVersion: "context-compiler-1",
  journalThroughSequence: 3,
} as const;

function draft(
  body: Record<string, unknown> = {
    messages: [{ role: "user", content: "Analyze" }],
    temperature: 0,
  },
): ModelRequestDraft {
  const sourceManifest = [
    createModelSourceManifestEntry(body, {
      sourceId: "source-user",
      origin: {
        kind: "user_message",
        id: "event-3",
        version: null,
        sequence: 3,
      },
      classification: "confidential",
      required: true,
      bodyPointers: ["/messages"],
    }),
    createModelSourceManifestEntry(body, {
      sourceId: "source-config",
      origin: {
        kind: "static_configuration",
        id: "model-config-v1",
        version: "1",
        sequence: null,
      },
      classification: "internal",
      required: true,
      bodyPointers: ["/temperature"],
    }),
  ];
  return { ...base, body, sourceManifest };
}

describe("prepareModelRequestSnapshot", () => {
  it("produces a deeply frozen deterministic request and provenance digest", () => {
    const left = prepareModelRequestSnapshot(draft());
    const rightBody = {
      temperature: 0,
      messages: [{ content: "Analyze", role: "user" }],
    };
    const right = prepareModelRequestSnapshot(draft(rightBody));

    expect(left.requestHash).toBe(right.requestHash);
    expect(left.bodyHash).toBe(right.bodyHash);
    expect(left.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.body)).toBe(true);
    expect(Object.isFrozen((left.body.messages as unknown[])[0])).toBe(true);
  });

  it("rejects uncovered provider-bound content", () => {
    const input = draft();
    const incomplete = {
      ...input,
      sourceManifest: input.sourceManifest.filter(
        ({ sourceId }) => sourceId !== "source-config",
      ),
    };
    expect(() => prepareModelRequestSnapshot(incomplete)).toThrow(
      /without provenance at \/temperature/,
    );
  });

  it("rejects a stale digest, missing pointer, and duplicate source ID", () => {
    const input = draft();
    const [first, second] = input.sourceManifest;
    if (first === undefined || second === undefined) {
      throw new Error("Expected source fixtures");
    }
    expect(() =>
      prepareModelRequestSnapshot({
        ...input,
        sourceManifest: [
          { ...first, contentHash: "0".repeat(64) },
          second,
        ],
      }),
    ).toThrow(/digest mismatch/);
    expect(() =>
      createModelSourceManifestEntry(input.body, {
        sourceId: first.sourceId,
        origin: first.origin,
        classification: first.classification,
        required: first.required,
        bodyPointers: ["/missing"],
      }),
    ).toThrow(ModelRequestProvenanceError);
    expect(() =>
      prepareModelRequestSnapshot({
        ...input,
        sourceManifest: [first, { ...second, sourceId: first.sourceId }],
      }),
    ).toThrow(/Duplicate model source ID/);
  });
});
