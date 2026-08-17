import { canonicalizeJson, sha256Hex } from "@private-fund/core";

export type RecordedJsonPrimitive = null | boolean | number | string;
export type RecordedJsonValue =
  | RecordedJsonPrimitive
  | RecordedJsonObject
  | readonly RecordedJsonValue[];
export interface RecordedJsonObject {
  readonly [key: string]: RecordedJsonValue;
}

export type RecordedModelRequest = RecordedJsonObject;

export interface RecordedModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: RecordedJsonObject;
}

export interface RecordedModelToolCallResponse {
  readonly type: "tool_call";
  readonly toolCall: RecordedModelToolCall;
}

export interface RecordedModelFinalResponse {
  readonly type: "final";
  readonly content: RecordedJsonValue;
  readonly finishReason?: string;
  readonly usage?: RecordedJsonObject;
}

export interface RecordedModelErrorResponse {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: RecordedJsonObject;
}

export type RecordedModelResult =
  | RecordedModelToolCallResponse
  | RecordedModelFinalResponse;
export type RecordedModelScriptedResponse =
  | RecordedModelResult
  | RecordedModelErrorResponse;

export interface RecordedModelScriptStep {
  readonly request: RecordedModelRequest;
  readonly response: RecordedModelScriptedResponse;
  readonly barrier?: RecordedModelBarrier;
  readonly label?: string;
}

export interface RecordedModelInvokeOptions {
  readonly signal?: AbortSignal;
}

export type RecordedModelCallStatus =
  | "pending"
  | "completed"
  | "failed"
  | "aborted"
  | "rejected";

export interface RecordedModelCallRecord {
  readonly callId: string;
  readonly callIndex: number;
  readonly scriptIndex: number | null;
  readonly label: string | null;
  readonly request: RecordedModelRequest | null;
  readonly canonicalRequest: string | null;
  readonly requestHash: string | null;
  readonly expectedRequestHash: string | null;
  readonly status: RecordedModelCallStatus;
  readonly response: RecordedModelResult | null;
  readonly errorCode: string | null;
}

interface MutableRecordedModelCallRecord {
  callId: string;
  callIndex: number;
  scriptIndex: number | null;
  label: string | null;
  request: RecordedModelRequest | null;
  canonicalRequest: string | null;
  requestHash: string | null;
  expectedRequestHash: string | null;
  status: RecordedModelCallStatus;
  response: RecordedModelResult | null;
  errorCode: string | null;
}

interface PreparedScriptStep {
  readonly request: RecordedModelRequest;
  readonly canonicalRequest: string;
  readonly requestHash: string;
  readonly response: RecordedModelScriptedResponse;
  readonly barrier: RecordedModelBarrier | undefined;
  readonly label: string;
}

interface BarrierWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

export class RecordedModelCanonicalizationError extends Error {
  readonly code = "recorded_model_invalid_json";

  constructor(message: string) {
    super(message);
    this.name = "RecordedModelCanonicalizationError";
  }
}

export class RecordedModelAbortError extends Error {
  readonly code = "recorded_model_aborted";
  readonly retryable = false;

  constructor() {
    super("Recorded model invocation was aborted");
    this.name = "RecordedModelAbortError";
  }
}

export class RecordedModelUnexpectedRequestError extends Error {
  readonly code = "recorded_model_unexpected_request";
  readonly retryable = false;
  readonly scriptIndex: number;
  readonly expectedRequestHash: string;
  readonly actualRequestHash: string;

  constructor(
    scriptIndex: number,
    expectedRequestHash: string,
    actualRequestHash: string,
  ) {
    super(
      `Recorded model request did not match script step ${String(scriptIndex)}`,
    );
    this.name = "RecordedModelUnexpectedRequestError";
    this.scriptIndex = scriptIndex;
    this.expectedRequestHash = expectedRequestHash;
    this.actualRequestHash = actualRequestHash;
  }
}

export class RecordedModelFixtureExhaustedError extends Error {
  readonly code = "recorded_model_fixture_exhausted";
  readonly retryable = false;

  constructor() {
    super("Recorded model fixture is exhausted");
    this.name = "RecordedModelFixtureExhaustedError";
  }
}

export class RecordedModelConcurrentCallError extends Error {
  readonly code = "recorded_model_concurrent_call";
  readonly retryable = false;
  readonly activeCallId: string;

  constructor(activeCallId: string) {
    super(`Recorded model call ${activeCallId} is still active`);
    this.name = "RecordedModelConcurrentCallError";
    this.activeCallId = activeCallId;
  }
}

export class RecordedModelScriptError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: RecordedJsonObject | null;

  constructor(response: RecordedModelErrorResponse) {
    super(response.message);
    this.name = "RecordedModelScriptError";
    this.code = response.code;
    this.retryable = response.retryable;
    this.details = response.details ?? null;
  }
}

function canonicalizationError(path: string, problem: string): never {
  throw new RecordedModelCanonicalizationError(`${path} ${problem}`);
}

function normalizeJson(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): RecordedJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return canonicalizationError(path, "contains a non-finite number");
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      return canonicalizationError(path, "contains a circular reference");
    }
    ancestors.add(value);
    const result: RecordedJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        ancestors.delete(value);
        return canonicalizationError(path, "contains a sparse array");
      }
      result.push(
        normalizeJson(value[index], `${path}[${String(index)}]`, ancestors),
      );
    }
    ancestors.delete(value);
    return result;
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return canonicalizationError(path, "contains a non-JSON object");
    }
    if (ancestors.has(value)) {
      return canonicalizationError(path, "contains a circular reference");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return canonicalizationError(path, "contains a symbol-keyed property");
    }
    ancestors.add(value);
    const result: Record<string, RecordedJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = normalizeJson(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        ancestors,
      );
    }
    ancestors.delete(value);
    return result;
  }

  return canonicalizationError(path, `contains unsupported ${typeof value}`);
}

function deepFreezeJson(value: RecordedJsonValue): RecordedJsonValue {
  if (value !== null && typeof value === "object") {
    for (const child of Array.isArray(value)
      ? value
      : Object.values(value)) {
      deepFreezeJson(child);
    }
    Object.freeze(value);
  }
  return value;
}

function normalizeObject(
  value: unknown,
  path: string,
): RecordedJsonObject {
  const normalized = normalizeJson(value, path, new Set<object>());
  if (
    normalized === null ||
    Array.isArray(normalized) ||
    typeof normalized !== "object"
  ) {
    return canonicalizationError(path, "must be a JSON object");
  }
  return deepFreezeJson(normalized) as RecordedJsonObject;
}

function requireNonEmpty(value: string, path: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`${path} must be non-empty`);
  }
  return value;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function normalizeScriptedResponse(
  response: RecordedModelScriptedResponse,
  path: string,
): RecordedModelScriptedResponse {
  switch (response.type) {
    case "tool_call":
      return Object.freeze({
        type: "tool_call" as const,
        toolCall: Object.freeze({
          id: requireNonEmpty(response.toolCall.id, `${path}.toolCall.id`),
          name: requireNonEmpty(
            response.toolCall.name,
            `${path}.toolCall.name`,
          ),
          arguments: normalizeObject(
            response.toolCall.arguments,
            `${path}.toolCall.arguments`,
          ),
        }),
      });
    case "final": {
      const content = deepFreezeJson(
        normalizeJson(response.content, `${path}.content`, new Set<object>()),
      );
      return Object.freeze({
        type: "final" as const,
        content,
        ...(response.finishReason === undefined
          ? {}
          : {
              finishReason: requireNonEmpty(
                response.finishReason,
                `${path}.finishReason`,
              ),
            }),
        ...(response.usage === undefined
          ? {}
          : { usage: normalizeObject(response.usage, `${path}.usage`) }),
      });
    }
    case "error":
      return Object.freeze({
        type: "error" as const,
        code: requireNonEmpty(response.code, `${path}.code`),
        message: requireNonEmpty(response.message, `${path}.message`),
        retryable: response.retryable,
        ...(response.details === undefined
          ? {}
          : { details: normalizeObject(response.details, `${path}.details`) }),
      });
  }
}

export function canonicalizeRecordedModelRequest(
  request: RecordedModelRequest,
): string {
  return canonicalizeJson(normalizeObject(request, "request"));
}

export function hashRecordedModelRequest(
  request: RecordedModelRequest,
): string {
  return sha256Hex(canonicalizeRecordedModelRequest(request));
}

export class RecordedModelBarrier {
  readonly #waiters = new Set<BarrierWaiter>();
  #held: boolean;

  constructor(held = true) {
    this.#held = held;
  }

  get isHeld(): boolean {
    return this.#held;
  }

  get pendingCount(): number {
    return this.#waiters.size;
  }

  hold(): this {
    this.#held = true;
    return this;
  }

  release(): void {
    if (!this.#held) {
      return;
    }
    this.#held = false;
    for (const waiter of [...this.#waiters]) {
      this.#removeWaiter(waiter);
      waiter.resolve();
    }
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      return Promise.reject(new RecordedModelAbortError());
    }
    if (!this.#held) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let waiter: BarrierWaiter;
      const onAbort =
        signal === undefined
          ? undefined
          : () => {
              this.#removeWaiter(waiter);
              reject(new RecordedModelAbortError());
            };
      waiter = { resolve, reject, signal, onAbort };
      this.#waiters.add(waiter);
      signal?.addEventListener("abort", onAbort as () => void, { once: true });
    });
  }

  #removeWaiter(waiter: BarrierWaiter): void {
    if (!this.#waiters.delete(waiter)) {
      return;
    }
    if (waiter.onAbort !== undefined) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
    }
  }
}

export class RecordedModel {
  readonly #steps: readonly PreparedScriptStep[];
  readonly #calls: MutableRecordedModelCallRecord[] = [];
  #nextScriptIndex = 0;
  #activeCallId: string | null = null;

  constructor(script: readonly RecordedModelScriptStep[]) {
    this.#steps = Object.freeze(
      script.map((step, index) => {
        const request = normalizeObject(
          step.request,
          `script[${String(index)}].request`,
        );
        const canonicalRequest = canonicalizeJson(request);
        return Object.freeze({
          request,
          canonicalRequest,
          requestHash: sha256Hex(canonicalRequest),
          response: normalizeScriptedResponse(
            step.response,
            `script[${String(index)}].response`,
          ),
          barrier: step.barrier,
          label: step.label ?? `step-${String(index)}`,
        });
      }),
    );
  }

  get calls(): readonly RecordedModelCallRecord[] {
    return this.#calls.map((call) => Object.freeze({ ...call }));
  }

  get consumedSteps(): number {
    return this.#nextScriptIndex;
  }

  get remainingSteps(): number {
    return this.#steps.length - this.#nextScriptIndex;
  }

  get isActive(): boolean {
    return this.#activeCallId !== null;
  }

  async invoke(
    rawRequest: RecordedModelRequest,
    options: RecordedModelInvokeOptions = {},
  ): Promise<RecordedModelResult> {
    const callIndex = this.#calls.length;
    const callId = `recorded-model-call-${String(callIndex)}`;
    const expected = this.#steps[this.#nextScriptIndex];
    let request: RecordedModelRequest;
    let canonicalRequest: string;
    let requestHash: string;

    try {
      request = normalizeObject(rawRequest, "request");
      canonicalRequest = canonicalizeJson(request);
      requestHash = sha256Hex(canonicalRequest);
    } catch (error) {
      this.#calls.push({
        callId,
        callIndex,
        scriptIndex: expected === undefined ? null : this.#nextScriptIndex,
        label: expected?.label ?? null,
        request: null,
        canonicalRequest: null,
        requestHash: null,
        expectedRequestHash: expected?.requestHash ?? null,
        status: "rejected",
        response: null,
        errorCode:
          error instanceof RecordedModelCanonicalizationError
            ? error.code
            : "recorded_model_invalid_request",
      });
      throw error;
    }

    const call: MutableRecordedModelCallRecord = {
      callId,
      callIndex,
      scriptIndex: expected === undefined ? null : this.#nextScriptIndex,
      label: expected?.label ?? null,
      request,
      canonicalRequest,
      requestHash,
      expectedRequestHash: expected?.requestHash ?? null,
      status: "pending",
      response: null,
      errorCode: null,
    };
    this.#calls.push(call);

    if (isAborted(options.signal)) {
      const error = new RecordedModelAbortError();
      call.status = "aborted";
      call.errorCode = error.code;
      throw error;
    }

    if (this.#activeCallId !== null) {
      const error = new RecordedModelConcurrentCallError(this.#activeCallId);
      call.status = "rejected";
      call.errorCode = error.code;
      throw error;
    }

    if (expected === undefined) {
      const error = new RecordedModelFixtureExhaustedError();
      call.status = "rejected";
      call.errorCode = error.code;
      throw error;
    }

    if (canonicalRequest !== expected.canonicalRequest) {
      const error = new RecordedModelUnexpectedRequestError(
        this.#nextScriptIndex,
        expected.requestHash,
        requestHash,
      );
      call.status = "rejected";
      call.errorCode = error.code;
      throw error;
    }

    const scriptIndex = this.#nextScriptIndex;
    this.#nextScriptIndex += 1;
    this.#activeCallId = callId;
    call.scriptIndex = scriptIndex;

    try {
      await expected.barrier?.wait(options.signal);
      if (isAborted(options.signal)) {
        throw new RecordedModelAbortError();
      }
      if (expected.response.type === "error") {
        throw new RecordedModelScriptError(expected.response);
      }

      call.status = "completed";
      call.response = expected.response;
      return expected.response;
    } catch (error) {
      if (error instanceof RecordedModelAbortError) {
        call.status = "aborted";
        call.errorCode = error.code;
      } else if (error instanceof RecordedModelScriptError) {
        call.status = "failed";
        call.errorCode = error.code;
      } else {
        call.status = "failed";
        call.errorCode = "recorded_model_internal_error";
      }
      throw error;
    } finally {
      if (this.#activeCallId === callId) {
        this.#activeCallId = null;
      }
    }
  }

  assertConsumed(): void {
    if (this.#activeCallId !== null) {
      throw new Error(
        `Recorded model still has active call ${this.#activeCallId}`,
      );
    }
    if (this.remainingSteps !== 0) {
      throw new Error(
        `Recorded model has ${String(this.remainingSteps)} unconsumed script step(s)`,
      );
    }
  }
}
