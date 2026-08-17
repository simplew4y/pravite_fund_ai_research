import {
  MODEL_STREAM_SCHEMA_VERSION,
  modelProviderEventSchema,
  type ModelProviderEvent,
  type ModelRequestDraft,
  type ModelRequestSnapshot,
  type PayloadClassification,
} from "@private-fund/contracts";
import { canonicalizeJson } from "@private-fund/core";

import { prepareModelRequestSnapshot } from "./model-request.js";

export interface ModelRequestCommitReceipt {
  readonly eventId: string;
  readonly sequence: number;
  /** False means this idempotency key was committed by an earlier attempt. */
  readonly created: boolean;
}

export interface ModelProviderEventCommit {
  readonly snapshot: ModelRequestSnapshot;
  readonly requestEventId: string;
  readonly requestSequence: number;
  readonly eventIndex: number;
  readonly classification: PayloadClassification;
  readonly event: ModelProviderEvent;
}

export interface ModelRequestJournal {
  commitRequest(
    snapshot: ModelRequestSnapshot,
    classification: PayloadClassification,
  ): Promise<ModelRequestCommitReceipt>;
  commitProviderEvent(input: ModelProviderEventCommit): Promise<void>;
}

export interface ModelProviderInvocation {
  readonly snapshot: ModelRequestSnapshot;
  readonly signal: AbortSignal;
}

export interface ModelProvider {
  readonly id: string;
  stream(
    invocation: ModelProviderInvocation,
  ):
    | AsyncIterable<unknown>
    | PromiseLike<AsyncIterable<unknown>>;
}

export interface ModelGatewayStreamOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface ModelGatewayOptions {
  readonly maxConcurrent?: number;
  readonly maxQueue?: number;
  readonly defaultTimeoutMs?: number;
  readonly journalCommitTimeoutMs?: number;
  readonly providerCloseTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

interface NormalizedModelGatewayOptions {
  readonly maxConcurrent: number;
  readonly maxQueue: number;
  readonly defaultTimeoutMs: number;
  readonly journalCommitTimeoutMs: number;
  readonly providerCloseTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
}

type ModelAbortReason = "cancelled" | "timeout" | "shutdown";

interface AdmissionWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

interface ActiveInvocation {
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  readonly resolveCompletion: () => void;
}

const DEFAULT_OPTIONS: NormalizedModelGatewayOptions = Object.freeze({
  maxConcurrent: 16,
  maxQueue: 64,
  defaultTimeoutMs: 120_000,
  journalCommitTimeoutMs: 10_000,
  providerCloseTimeoutMs: 5_000,
  shutdownTimeoutMs: 30_000,
});

export class ModelGatewayError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ModelGatewayError";
  }
}

export class ModelGatewayUnavailableError extends ModelGatewayError {
  public constructor(message: string) {
    super(message, "model_gateway_unavailable");
    this.name = "ModelGatewayUnavailableError";
  }
}

export class ModelGatewayAdmissionError extends ModelGatewayError {
  public constructor(message: string) {
    super(message, "model_gateway_overloaded");
    this.name = "ModelGatewayAdmissionError";
  }
}

export class ModelGatewayAbortError extends ModelGatewayError {
  public constructor(public readonly reason: ModelAbortReason) {
    super(`Model request was ${reason}`, `model_gateway_${reason}`);
    this.name = "ModelGatewayAbortError";
  }
}

export class ModelJournalCommitError extends ModelGatewayError {
  public constructor(stage: "request" | "provider_event", cause: unknown) {
    super(
      `Session Journal rejected the model ${stage === "request" ? "request snapshot" : "provider event"}`,
      `model_journal_${stage}_commit_failed`,
    );
    this.name = "ModelJournalCommitError";
    this.cause = cause;
  }
}

export class ModelGatewayProtocolError extends ModelGatewayError {
  public constructor(message: string) {
    super(message, "model_provider_protocol_error");
    this.name = "ModelGatewayProtocolError";
  }
}

export class ModelGatewayRecoveryRequiredError extends ModelGatewayError {
  public constructor(requestId: string) {
    super(
      `Model request ${requestId} was already committed; replay its durable outcome instead of sending it again`,
      "model_request_recovery_required",
    );
    this.name = "ModelGatewayRecoveryRequiredError";
  }
}

export class ModelGatewayShutdownError extends ModelGatewayError {
  public constructor(message: string) {
    super(message, "model_gateway_shutdown_incomplete");
    this.name = "ModelGatewayShutdownError";
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function normalizeOptions(options: ModelGatewayOptions): NormalizedModelGatewayOptions {
  return Object.freeze({
    maxConcurrent: positiveInteger(
      options.maxConcurrent ?? DEFAULT_OPTIONS.maxConcurrent,
      "maxConcurrent",
    ),
    maxQueue: nonNegativeInteger(
      options.maxQueue ?? DEFAULT_OPTIONS.maxQueue,
      "maxQueue",
    ),
    defaultTimeoutMs: positiveInteger(
      options.defaultTimeoutMs ?? DEFAULT_OPTIONS.defaultTimeoutMs,
      "defaultTimeoutMs",
    ),
    journalCommitTimeoutMs: positiveInteger(
      options.journalCommitTimeoutMs ?? DEFAULT_OPTIONS.journalCommitTimeoutMs,
      "journalCommitTimeoutMs",
    ),
    providerCloseTimeoutMs: positiveInteger(
      options.providerCloseTimeoutMs ?? DEFAULT_OPTIONS.providerCloseTimeoutMs,
      "providerCloseTimeoutMs",
    ),
    shutdownTimeoutMs: positiveInteger(
      options.shutdownTimeoutMs ?? DEFAULT_OPTIONS.shutdownTimeoutMs,
      "shutdownTimeoutMs",
    ),
  });
}

function classificationRank(classification: PayloadClassification): number {
  switch (classification) {
    case "public":
      return 0;
    case "internal":
      return 1;
    case "confidential":
      return 2;
    case "restricted":
      return 3;
  }
}

function snapshotClassification(
  snapshot: ModelRequestSnapshot,
): PayloadClassification {
  let result: PayloadClassification = "internal";
  for (const source of snapshot.sourceManifest) {
    if (classificationRank(source.classification) > classificationRank(result)) {
      result = source.classification;
    }
  }
  return result;
}

function eventClassification(event: ModelProviderEvent): PayloadClassification {
  return event.type === "delta" && event.channel === "reasoning"
    ? "restricted"
    : "confidential";
}

function safeProviderErrorMessage(_value: unknown): string {
  return "Model Provider request failed";
}

function terminalEvent(event: ModelProviderEvent): boolean {
  return event.type === "final" || event.type === "error" || event.type === "aborted";
}

function abortReason(signal: AbortSignal): ModelAbortReason {
  return signal.reason instanceof ModelGatewayAbortError
    ? signal.reason.reason
    : "cancelled";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ModelGatewayAbortError(abortReason(signal));
  }
}

async function withTimeout<T>(
  operation: PromiseLike<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve(operation), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function withAbort<T>(
  operation: T | PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new ModelGatewayAbortError(abortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const promise = Promise.resolve(operation);
  void promise.catch(() => undefined);
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function completionDeferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolver: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  return { promise, resolve: () => resolver?.() };
}

export class ModelGateway {
  readonly #provider: ModelProvider;
  readonly #journal: ModelRequestJournal;
  readonly #options: NormalizedModelGatewayOptions;
  readonly #queue: AdmissionWaiter[] = [];
  readonly #reservedRequestIds = new Set<string>();
  readonly #activeInvocations = new Map<string, ActiveInvocation>();
  #activeCount = 0;
  #stopping = false;
  #disposePromise: Promise<void> | undefined;

  public constructor(
    provider: ModelProvider,
    journal: ModelRequestJournal,
    options: ModelGatewayOptions = {},
  ) {
    if (provider.id.trim().length === 0) {
      throw new TypeError("Model Provider ID must be non-empty");
    }
    this.#provider = provider;
    this.#journal = journal;
    this.#options = normalizeOptions(options);
  }

  public get activeCount(): number {
    return this.#activeCount;
  }

  public get queuedCount(): number {
    return this.#queue.length;
  }

  public async *stream(
    rawDraft: ModelRequestDraft,
    options: ModelGatewayStreamOptions = {},
  ): AsyncGenerator<ModelProviderEvent> {
    const snapshot = prepareModelRequestSnapshot(rawDraft);
    if (snapshot.providerId !== this.#provider.id) {
      throw new ModelGatewayProtocolError(
        `Request Provider ${snapshot.providerId} does not match configured Provider ${this.#provider.id}`,
      );
    }
    if (this.#reservedRequestIds.has(snapshot.requestId)) {
      throw new ModelGatewayAdmissionError(
        `Model request ${snapshot.requestId} is already queued or running`,
      );
    }
    this.#reservedRequestIds.add(snapshot.requestId);

    let admitted = false;
    let active: ActiveInvocation | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeExternalAbort: (() => void) | undefined;
    try {
      await this.#acquire(options.signal);
      admitted = true;

      const controller = new AbortController();
      const completion = completionDeferred();
      active = {
        controller,
        completion: completion.promise,
        resolveCompletion: completion.resolve,
      };
      this.#activeInvocations.set(snapshot.requestId, active);

      if (options.signal !== undefined) {
        const onAbort = (): void => {
          controller.abort(new ModelGatewayAbortError("cancelled"));
        };
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener("abort", onAbort, { once: true });
          removeExternalAbort = () =>
            options.signal?.removeEventListener("abort", onAbort);
        }
      }
      const timeoutMs = positiveInteger(
        options.timeoutMs ?? this.#options.defaultTimeoutMs,
        "timeoutMs",
      );
      timer = setTimeout(() => {
        controller.abort(new ModelGatewayAbortError("timeout"));
      }, timeoutMs);
      timer.unref?.();

      yield* this.#run(snapshot, controller);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      removeExternalAbort?.();
      if (active !== undefined) {
        this.#activeInvocations.delete(snapshot.requestId);
        active.resolveCompletion();
      }
      if (admitted) {
        this.#release();
      }
      this.#reservedRequestIds.delete(snapshot.requestId);
    }
  }

  public dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) {
      return this.#disposePromise;
    }
    this.#stopping = true;
    const unavailable = new ModelGatewayUnavailableError(
      "Model Gateway is shutting down",
    );
    for (const waiter of this.#queue.splice(0)) {
      this.#removeWaiterListener(waiter);
      waiter.reject(unavailable);
    }
    for (const active of this.#activeInvocations.values()) {
      active.controller.abort(new ModelGatewayAbortError("shutdown"));
    }
    this.#disposePromise = withTimeout(
      Promise.all(
        [...this.#activeInvocations.values()].map(({ completion }) => completion),
      ).then(() => undefined),
      this.#options.shutdownTimeoutMs,
      () =>
        new ModelGatewayShutdownError(
          `Model Gateway did not drain within ${String(this.#options.shutdownTimeoutMs)}ms`,
        ),
    );
    return this.#disposePromise;
  }

  async *#run(
    snapshot: ModelRequestSnapshot,
    controller: AbortController,
  ): AsyncGenerator<ModelProviderEvent> {
    const classification = snapshotClassification(snapshot);
    let requestReceipt: ModelRequestCommitReceipt;
    try {
      throwIfAborted(controller.signal);
      requestReceipt = await withTimeout(
        this.#journal.commitRequest(snapshot, classification),
        this.#options.journalCommitTimeoutMs,
        () => new Error("Journal request commit timed out"),
      );
      if (!requestReceipt.created) {
        throw new ModelGatewayRecoveryRequiredError(snapshot.requestId);
      }
    } catch (cause) {
      if (
        cause instanceof ModelGatewayAbortError ||
        cause instanceof ModelGatewayRecoveryRequiredError
      ) {
        throw cause;
      }
      throw new ModelJournalCommitError("request", cause);
    }

    let eventIndex = 0;
    const persist = async (event: ModelProviderEvent): Promise<ModelProviderEvent> => {
      eventIndex += 1;
      try {
        await withTimeout(
          this.#journal.commitProviderEvent({
            snapshot,
            requestEventId: requestReceipt.eventId,
            requestSequence: requestReceipt.sequence,
            eventIndex,
            classification: eventClassification(event),
            event,
          }),
          this.#options.journalCommitTimeoutMs,
          () => new Error("Journal provider event commit timed out"),
        );
      } catch (cause) {
        controller.abort(new ModelGatewayAbortError("shutdown"));
        throw new ModelJournalCommitError("provider_event", cause);
      }
      return event;
    };

    if (controller.signal.aborted) {
      yield await persist({
        schemaVersion: MODEL_STREAM_SCHEMA_VERSION,
        type: "aborted",
        reason: abortReason(controller.signal),
      });
      return;
    }

    let iterator: AsyncIterator<unknown> | undefined;
    try {
      const iterable = await withAbort(
        this.#provider.stream({ snapshot, signal: controller.signal }),
        controller.signal,
      );
      iterator = iterable[Symbol.asyncIterator]();
      while (true) {
        let result: IteratorResult<unknown>;
        try {
          result = await withAbort(iterator.next(), controller.signal);
        } catch (cause) {
          if (cause instanceof ModelGatewayAbortError) {
            yield await persist({
              schemaVersion: MODEL_STREAM_SCHEMA_VERSION,
              type: "aborted",
              reason: cause.reason,
            });
            return;
          }
          throw cause;
        }
        if (result.done === true) {
          yield await persist({
            schemaVersion: MODEL_STREAM_SCHEMA_VERSION,
            type: "error",
            code: "provider_stream_incomplete",
            message: "Model Provider ended without a terminal event",
            retryable: false,
          });
          return;
        }

        const parsedEvent = modelProviderEventSchema.safeParse(result.value);
        if (!parsedEvent.success) {
          throw new ModelGatewayProtocolError(
            "Model Provider returned an invalid stream event",
          );
        }
        let event = parsedEvent.data;
        if (event.type === "tool_call") {
          try {
            canonicalizeJson(event.arguments);
          } catch {
            throw new ModelGatewayProtocolError(
              "Model Provider returned non-canonical Tool arguments",
            );
          }
        } else if (event.type === "error") {
          event = {
            ...event,
            message: safeProviderErrorMessage(event.message),
          };
        }
        yield await persist(event);
        if (terminalEvent(event)) {
          return;
        }
      }
    } catch (cause) {
      if (cause instanceof ModelJournalCommitError) {
        throw cause;
      }
      let event: ModelProviderEvent;
      if (controller.signal.aborted || cause instanceof ModelGatewayAbortError) {
        const reason: ModelAbortReason = controller.signal.aborted
          ? abortReason(controller.signal)
          : cause instanceof ModelGatewayAbortError
            ? cause.reason
            : "cancelled";
        event = {
          schemaVersion: MODEL_STREAM_SCHEMA_VERSION,
          type: "aborted",
          reason,
        };
      } else {
        event = {
          schemaVersion: MODEL_STREAM_SCHEMA_VERSION,
          type: "error",
          code:
            cause instanceof ModelGatewayProtocolError
              ? cause.code
              : "provider_failed",
          message: safeProviderErrorMessage(cause),
          retryable: false,
        };
      }
      yield await persist(event);
    } finally {
      if (iterator?.return !== undefined) {
        try {
          await withTimeout(
            iterator.return(),
            this.#options.providerCloseTimeoutMs,
            () =>
              new ModelGatewayShutdownError(
                "Model Provider stream did not close after cancellation",
              ),
          );
        } catch {
          // The durable terminal event or thrown Journal error remains authoritative.
        }
      }
    }
  }

  #acquire(signal?: AbortSignal): Promise<void> {
    if (this.#stopping) {
      return Promise.reject(
        new ModelGatewayUnavailableError("Model Gateway is not accepting requests"),
      );
    }
    if (signal?.aborted === true) {
      return Promise.reject(new ModelGatewayAbortError("cancelled"));
    }
    if (this.#activeCount < this.#options.maxConcurrent) {
      this.#activeCount += 1;
      return Promise.resolve();
    }
    if (this.#queue.length >= this.#options.maxQueue) {
      return Promise.reject(
        new ModelGatewayAdmissionError("Model Gateway admission queue is full"),
      );
    }
    return new Promise<void>((resolve, reject) => {
      let waiter: AdmissionWaiter;
      const onAbort =
        signal === undefined
          ? undefined
          : () => {
              const index = this.#queue.indexOf(waiter);
              if (index >= 0) {
                this.#queue.splice(index, 1);
              }
              this.#removeWaiterListener(waiter);
              reject(new ModelGatewayAbortError("cancelled"));
            };
      waiter = { resolve, reject, signal, onAbort };
      this.#queue.push(waiter);
      signal?.addEventListener("abort", onAbort as () => void, { once: true });
    });
  }

  #release(): void {
    if (this.#activeCount <= 0) {
      throw new ModelGatewayProtocolError("Model Gateway admission counter underflow");
    }
    this.#activeCount -= 1;
    if (this.#stopping) {
      return;
    }
    while (this.#queue.length > 0) {
      const waiter = this.#queue.shift();
      if (waiter === undefined) {
        return;
      }
      this.#removeWaiterListener(waiter);
      if (waiter.signal?.aborted === true) {
        waiter.reject(new ModelGatewayAbortError("cancelled"));
        continue;
      }
      this.#activeCount += 1;
      waiter.resolve();
      return;
    }
  }

  #removeWaiterListener(waiter: AdmissionWaiter): void {
    if (waiter.onAbort !== undefined) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
    }
  }
}
