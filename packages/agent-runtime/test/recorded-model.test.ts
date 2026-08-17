import { describe, expect, it } from "vitest";

import {
  RecordedModel,
  RecordedModelAbortError,
  RecordedModelBarrier,
  RecordedModelCanonicalizationError,
  RecordedModelConcurrentCallError,
  RecordedModelFixtureExhaustedError,
  RecordedModelScriptError,
  RecordedModelUnexpectedRequestError,
  canonicalizeRecordedModelRequest,
  hashRecordedModelRequest,
  type RecordedModelRequest,
} from "../src/testing/recorded-model.js";

const firstRequest: RecordedModelRequest = {
  model: "recorded-model-v1",
  messages: [
    { role: "system", content: "Use only supplied evidence." },
    { role: "user", content: "Analyze recurring revenue." },
  ],
  tools: [
    {
      name: "workspace.read",
      inputSchema: {
        type: "object",
        properties: { resourceId: { type: "string" } },
        required: ["resourceId"],
      },
    },
  ],
  parameters: { temperature: 0, maxTokens: 512 },
};

const secondRequest: RecordedModelRequest = {
  model: "recorded-model-v1",
  messages: [
    { role: "system", content: "Use only supplied evidence." },
    { role: "user", content: "Analyze recurring revenue." },
    {
      role: "assistant",
      toolCall: {
        id: "tool-call-1",
        name: "workspace.read",
        arguments: { resourceId: "resource-1" },
      },
    },
    {
      role: "tool",
      toolCallId: "tool-call-1",
      content: "ARR grew 18% year over year.",
    },
  ],
  tools: [
    {
      name: "workspace.read",
      inputSchema: {
        type: "object",
        properties: { resourceId: { type: "string" } },
        required: ["resourceId"],
      },
    },
  ],
  parameters: { temperature: 0, maxTokens: 512 },
};

describe("RecordedModel", () => {
  it("captures canonical requests and replays tool and final responses in order", async () => {
    const model = new RecordedModel([
      {
        label: "request-evidence",
        request: firstRequest,
        response: {
          type: "tool_call",
          toolCall: {
            id: "tool-call-1",
            name: "workspace.read",
            arguments: { resourceId: "resource-1" },
          },
        },
      },
      {
        label: "answer",
        request: secondRequest,
        response: {
          type: "final",
          content: [
            { type: "text", text: "Recurring revenue grew 18%." },
          ],
          finishReason: "stop",
          usage: { inputTokens: 42, outputTokens: 8 },
        },
      },
    ]);

    await expect(model.invoke(firstRequest)).resolves.toEqual({
      type: "tool_call",
      toolCall: {
        id: "tool-call-1",
        name: "workspace.read",
        arguments: { resourceId: "resource-1" },
      },
    });
    await expect(model.invoke(secondRequest)).resolves.toEqual({
      type: "final",
      content: [{ type: "text", text: "Recurring revenue grew 18%." }],
      finishReason: "stop",
      usage: { inputTokens: 42, outputTokens: 8 },
    });

    expect(model.calls).toMatchObject([
      {
        callId: "recorded-model-call-0",
        scriptIndex: 0,
        label: "request-evidence",
        requestHash: hashRecordedModelRequest(firstRequest),
        status: "completed",
        response: { type: "tool_call" },
      },
      {
        callId: "recorded-model-call-1",
        scriptIndex: 1,
        label: "answer",
        requestHash: hashRecordedModelRequest(secondRequest),
        status: "completed",
        response: { type: "final" },
      },
    ]);
    expect(model.remainingSteps).toBe(0);
    expect(() => model.assertConsumed()).not.toThrow();
  });

  it("uses stable sorted JSON and SHA-256 independent of object key order", () => {
    const left: RecordedModelRequest = {
      z: 3,
      nested: { b: 2, a: 1 },
      array: [{ y: true, x: false }],
    };
    const right: RecordedModelRequest = {
      array: [{ x: false, y: true }],
      nested: { a: 1, b: 2 },
      z: 3,
    };

    expect(canonicalizeRecordedModelRequest(left)).toBe(
      '{"array":[{"x":false,"y":true}],"nested":{"a":1,"b":2},"z":3}',
    );
    expect(hashRecordedModelRequest(left)).toBe(
      hashRecordedModelRequest(right),
    );
    expect(hashRecordedModelRequest(left)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects an unexpected request without consuming the expected step", async () => {
    const model = new RecordedModel([
      {
        request: firstRequest,
        response: { type: "final", content: "ok" },
      },
    ]);

    const unexpected = model.invoke({ ...firstRequest, model: "wrong-model" });
    await expect(unexpected).rejects.toBeInstanceOf(
      RecordedModelUnexpectedRequestError,
    );
    await expect(unexpected).rejects.toMatchObject({
      code: "recorded_model_unexpected_request",
      scriptIndex: 0,
      expectedRequestHash: hashRecordedModelRequest(firstRequest),
    });
    expect(model.remainingSteps).toBe(1);
    expect(model.calls[0]).toMatchObject({
      status: "rejected",
      errorCode: "recorded_model_unexpected_request",
    });

    await expect(model.invoke(firstRequest)).resolves.toEqual({
      type: "final",
      content: "ok",
    });
    model.assertConsumed();
  });

  it("throws scripted provider errors and rejects calls after exhaustion", async () => {
    const model = new RecordedModel([
      {
        request: firstRequest,
        response: {
          type: "error",
          code: "provider_rate_limited",
          message: "Recorded provider rate limit",
          retryable: true,
          details: { retryAfterMs: 250 },
        },
      },
    ]);

    const failed = model.invoke(firstRequest);
    await expect(failed).rejects.toBeInstanceOf(RecordedModelScriptError);
    await expect(failed).rejects.toMatchObject({
      code: "provider_rate_limited",
      retryable: true,
      details: { retryAfterMs: 250 },
    });
    expect(model.calls[0]).toMatchObject({
      status: "failed",
      errorCode: "provider_rate_limited",
    });
    model.assertConsumed();

    const extra = model.invoke(firstRequest);
    await expect(extra).rejects.toBeInstanceOf(
      RecordedModelFixtureExhaustedError,
    );
    expect(model.calls[1]).toMatchObject({
      scriptIndex: null,
      status: "rejected",
      errorCode: "recorded_model_fixture_exhausted",
    });
  });

  it("holds a response behind a controllable barrier until release", async () => {
    const barrier = new RecordedModelBarrier();
    const model = new RecordedModel([
      {
        request: firstRequest,
        response: { type: "final", content: "released" },
        barrier,
      },
    ]);

    const pending = model.invoke(firstRequest);
    expect(barrier.isHeld).toBe(true);
    expect(barrier.pendingCount).toBe(1);
    expect(model.isActive).toBe(true);
    expect(model.calls[0]?.status).toBe("pending");

    barrier.release();
    await expect(pending).resolves.toEqual({
      type: "final",
      content: "released",
    });
    expect(barrier.pendingCount).toBe(0);
    expect(model.isActive).toBe(false);
    model.assertConsumed();
  });

  it("propagates AbortSignal while held and removes the barrier waiter", async () => {
    const barrier = new RecordedModelBarrier();
    const controller = new AbortController();
    const model = new RecordedModel([
      {
        request: firstRequest,
        response: { type: "final", content: "must not be returned" },
        barrier,
      },
    ]);

    const pending = model.invoke(firstRequest, { signal: controller.signal });
    expect(barrier.pendingCount).toBe(1);
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(RecordedModelAbortError);
    expect(barrier.pendingCount).toBe(0);
    expect(model.calls[0]).toMatchObject({
      status: "aborted",
      response: null,
      errorCode: "recorded_model_aborted",
    });
    model.assertConsumed();
  });

  it("does not consume a fixture step for a pre-aborted invocation", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = new RecordedModel([
      {
        request: firstRequest,
        response: { type: "final", content: "next call" },
      },
    ]);

    await expect(
      model.invoke(firstRequest, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(RecordedModelAbortError);
    expect(model.remainingSteps).toBe(1);

    await expect(model.invoke(firstRequest)).resolves.toMatchObject({
      content: "next call",
    });
    model.assertConsumed();
  });

  it("rejects concurrent calls so scripted responses cannot reorder", async () => {
    const barrier = new RecordedModelBarrier();
    const model = new RecordedModel([
      {
        request: firstRequest,
        response: { type: "final", content: "first" },
        barrier,
      },
      {
        request: secondRequest,
        response: { type: "final", content: "second" },
      },
    ]);

    const first = model.invoke(firstRequest);
    const concurrent = model.invoke(secondRequest);
    await expect(concurrent).rejects.toBeInstanceOf(
      RecordedModelConcurrentCallError,
    );
    expect(model.remainingSteps).toBe(1);

    barrier.release();
    await first;
    await expect(model.invoke(secondRequest)).resolves.toMatchObject({
      content: "second",
    });
    model.assertConsumed();
  });

  it("strictly rejects non-JSON requests before consuming a step", async () => {
    const model = new RecordedModel([
      {
        request: firstRequest,
        response: { type: "final", content: "ok" },
      },
    ]);
    const invalid = { model: "recorded-model-v1", temperature: NaN };

    await expect(
      model.invoke(invalid as unknown as RecordedModelRequest),
    ).rejects.toBeInstanceOf(RecordedModelCanonicalizationError);
    expect(model.calls[0]).toMatchObject({
      request: null,
      status: "rejected",
      errorCode: "recorded_model_invalid_json",
    });
    expect(model.remainingSteps).toBe(1);
  });

  it("rejects symbol-keyed request data that ordinary JSON would omit", async () => {
    const model = new RecordedModel([
      {
        request: firstRequest,
        response: { type: "final", content: "ok" },
      },
    ]);
    const invalid = { ...firstRequest } as Record<PropertyKey, unknown>;
    invalid[Symbol("hidden")] = "must not disappear from the digest";

    await expect(
      model.invoke(invalid as RecordedModelRequest),
    ).rejects.toBeInstanceOf(RecordedModelCanonicalizationError);
    expect(model.remainingSteps).toBe(1);
  });
});
