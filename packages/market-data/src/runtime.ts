import {
  type MarketDataAttemptDiagnostic,
  type MarketDataCancellationCapability,
  type MarketDataEffects,
  type MarketDataExecution,
  type MarketDataExecutor,
  type MarketDataFallbackDiagnostics,
  type MarketDataProviderDescriptor,
  type MarketDataRequest,
  type MarketDataRunOptions,
} from "./contracts.js";
import {
  MarketDataError,
  MarketDataWaterfallError,
  redactMarketDataMessage,
} from "./errors.js";
import {
  normalizeMarketDataRequest,
  normalizeMarketDataResult,
} from "./normalization.js";

const OPERATION_DEADLINE = Symbol("market-data-operation-deadline");
const PROVIDER_TIMEOUT = Symbol("market-data-provider-timeout");
const RUNTIME_DISPOSE = Symbol("market-data-runtime-dispose");

export interface MarketDataWaterfallOptions {
  readonly providers: readonly MarketDataProviderDescriptor[];
  /** Provider IDs in exact fallback order. */
  readonly waterfall: readonly string[];
  readonly totalTimeoutMs?: number;
  readonly providerTimeoutMs?: number;
  readonly readinessTimeoutMs?: number;
  readonly maxConcurrent?: number;
  readonly maxQueue?: number;
  readonly drainTimeoutMs?: number;
  readonly abortGraceMs?: number;
  readonly disposeTimeoutMs?: number;
}

interface NormalizedRuntimeOptions {
  readonly totalTimeoutMs: number;
  readonly providerTimeoutMs: number;
  readonly readinessTimeoutMs: number;
  readonly drainTimeoutMs: number;
  readonly abortGraceMs: number;
  readonly disposeTimeoutMs: number;
}

type RuntimeState =
  | "created"
  | "starting"
  | "ready"
  | "disposing"
  | "disposed"
  | "failed";

interface AdmissionWaiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  settled: boolean;
}

class AdmissionGate {
  readonly #queue: AdmissionWaiter[] = [];
  readonly #drainWaiters = new Set<() => void>();
  #active = 0;
  #open = false;

  public constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueue: number,
  ) {}

  public open(): void {
    this.#open = true;
  }

  public acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(signal.reason);
    }
    if (!this.#open) {
      return Promise.reject(disposedError());
    }
    if (this.#active < this.maxConcurrent) {
      this.#active += 1;
      return Promise.resolve(this.#releaseHandle());
    }
    if (this.#queue.length >= this.maxQueue) {
      return Promise.reject(
        new MarketDataError("Market-data admission queue is full", {
          code: "backpressure",
          retryable: true,
          fallbackEligible: false,
        }),
      );
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: AdmissionWaiter = {
        resolve,
        reject,
        signal,
        settled: false,
        onAbort: () => {
          if (waiter.settled) return;
          waiter.settled = true;
          const index = this.#queue.indexOf(waiter);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(signal.reason);
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.#queue.push(waiter);
    });
  }

  public stop(): void {
    if (!this.#open) return;
    this.#open = false;
    const error = disposedError();
    for (const waiter of this.#queue.splice(0)) {
      waiter.settled = true;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
    this.#resolveDrainIfIdle();
  }

  public drained(): Promise<void> {
    if (this.#active === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#drainWaiters.add(resolve);
    });
  }

  #releaseHandle(): () => void {
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      this.#active -= 1;
      if (this.#open) this.#admitNext();
      this.#resolveDrainIfIdle();
    };
  }

  #admitNext(): void {
    while (
      this.#open &&
      this.#active < this.maxConcurrent &&
      this.#queue.length > 0
    ) {
      const waiter = this.#queue.shift();
      if (waiter === undefined || waiter.settled) continue;
      waiter.settled = true;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason);
        continue;
      }
      this.#active += 1;
      waiter.resolve(this.#releaseHandle());
    }
  }

  #resolveDrainIfIdle(): void {
    if (this.#active !== 0) return;
    for (const resolve of this.#drainWaiters) resolve();
    this.#drainWaiters.clear();
  }
}

export class MarketDataWaterfall implements MarketDataExecutor {
  readonly #providers: readonly MarketDataProviderDescriptor[];
  readonly #waterfall: readonly string[];
  readonly #options: NormalizedRuntimeOptions;
  readonly #admission: AdmissionGate;
  readonly #operationControllers = new Set<AbortController>();
  readonly #readinessControllers = new Set<AbortController>();
  readonly #readinessTasks = new Set<Promise<unknown>>();
  readonly #providerDisposals = new Map<
    MarketDataProviderDescriptor,
    Promise<void>
  >();
  #state: RuntimeState = "created";
  #startPromise: Promise<void> | undefined;
  #disposePromise: Promise<void> | undefined;

  public readonly effects: MarketDataEffects;
  public readonly shadowSafe: boolean;

  public constructor(options: MarketDataWaterfallOptions) {
    this.#providers = validateProviders(options.providers, options.waterfall);
    this.#waterfall = Object.freeze([...options.waterfall]);
    this.#options = Object.freeze({
      totalTimeoutMs: positiveInteger(
        options.totalTimeoutMs ?? 15_000,
        "totalTimeoutMs",
      ),
      providerTimeoutMs: positiveInteger(
        options.providerTimeoutMs ?? 5_000,
        "providerTimeoutMs",
      ),
      readinessTimeoutMs: positiveInteger(
        options.readinessTimeoutMs ?? 5_000,
        "readinessTimeoutMs",
      ),
      drainTimeoutMs: positiveInteger(
        options.drainTimeoutMs ?? 10_000,
        "drainTimeoutMs",
      ),
      abortGraceMs: positiveInteger(
        options.abortGraceMs ?? 2_000,
        "abortGraceMs",
      ),
      disposeTimeoutMs: positiveInteger(
        options.disposeTimeoutMs ?? 5_000,
        "disposeTimeoutMs",
      ),
    });
    this.#admission = new AdmissionGate(
      positiveInteger(options.maxConcurrent ?? 8, "maxConcurrent"),
      nonNegativeInteger(options.maxQueue ?? 32, "maxQueue"),
    );
    this.effects = aggregateEffects(this.#providers);
    this.shadowSafe = this.effects === "none";
  }

  public get state(): RuntimeState {
    return this.#state;
  }

  public start(signal?: AbortSignal): Promise<void> {
    if (this.#startPromise !== undefined) return this.#startPromise;
    if (this.#state !== "created") {
      return Promise.reject(
        new MarketDataError(`Market-data runtime cannot start from ${this.#state}`, {
          code: "not_ready",
          retryable: false,
          fallbackEligible: false,
        }),
      );
    }
    this.#state = "starting";
    this.#startPromise = this.#start(signal);
    return this.#startPromise;
  }

  public async fetch(
    request: MarketDataRequest,
    options: MarketDataRunOptions = {},
  ): Promise<MarketDataExecution> {
    if (this.#state !== "ready") {
      throw new MarketDataError(
        `Market-data runtime is not ready (${this.#state})`,
        {
          code: this.#state === "disposed" ? "disposed" : "not_ready",
          retryable: this.#state !== "disposed",
          fallbackEligible: false,
        },
      );
    }
    const normalizedRequest = normalizeMarketDataRequest(request);
    const providerTimeoutMs = positiveInteger(
      options.providerTimeoutMs ?? this.#options.providerTimeoutMs,
      "providerTimeoutMs",
    );
    const startedAt = Date.now();
    const configuredDeadline = startedAt + this.#options.totalTimeoutMs;
    const requestedDeadline =
      options.deadlineAt === undefined
        ? configuredDeadline
        : finiteDeadline(options.deadlineAt);
    const deadlineAt = Math.min(configuredDeadline, requestedDeadline);
    const operation = new AbortController();
    const unlinkCaller = forwardAbort(options.signal, operation);
    const deadlineTimer = abortAt(operation, deadlineAt, OPERATION_DEADLINE);
    this.#operationControllers.add(operation);
    const providerTasks: Promise<unknown>[] = [];
    let release: (() => void) | undefined;
    try {
      try {
        release = await this.#admission.acquire(operation.signal);
      } catch (error) {
        throw abortOrError(operation.signal, error);
      }
      const attempts: MarketDataAttemptDiagnostic[] = [];
      const failures: MarketDataError[] = [];
      for (const provider of this.#providers) {
        if (operation.signal.aborted) {
          throw abortOrError(operation.signal, operation.signal.reason);
        }
        const attemptStartedAt = Date.now();
        try {
          const output = await this.#fetchFromProvider(
            provider,
            normalizedRequest,
            operation.signal,
            deadlineAt,
            providerTimeoutMs,
            providerTasks,
          );
          const data = normalizeMarketDataResult(
            provider.id,
            normalizedRequest,
            output,
          );
          attempts.push(
            Object.freeze({
              providerId: provider.id,
              outcome: "succeeded",
              durationMs: durationSince(attemptStartedAt),
              error: null,
            }),
          );
          return Object.freeze({
            data,
            diagnostics: diagnostics(
              this.#waterfall,
              provider.id,
              attempts,
              startedAt,
            ),
          });
        } catch (error) {
          if (operation.signal.aborted) {
            throw abortOrError(operation.signal, error);
          }
          const failure = providerFailure(provider.id, error);
          failures.push(failure);
          attempts.push(
            Object.freeze({
              providerId: provider.id,
              outcome: "failed",
              durationMs: durationSince(attemptStartedAt),
              error: Object.freeze({
                code: failure.code,
                retryable: failure.retryable,
                message: redactMarketDataMessage(failure.message),
              }),
            }),
          );
          if (!failure.fallbackEligible) throw failure;
        }
      }
      throw new MarketDataWaterfallError(
        failures,
        diagnostics(this.#waterfall, null, attempts, startedAt),
      );
    } finally {
      unlinkCaller();
      clearTimeout(deadlineTimer);
      if (providerTasks.length === 0) {
        release?.();
        this.#operationControllers.delete(operation);
      } else {
        void Promise.allSettled(providerTasks).then(() => {
          release?.();
          this.#operationControllers.delete(operation);
        });
      }
    }
  }

  public dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#disposePromise = this.#dispose();
    return this.#disposePromise;
  }

  async #start(signal: AbortSignal | undefined): Promise<void> {
    try {
      for (const provider of this.#providers) {
        assertCancellationReady(provider.id, provider.capabilities.cancellation);
        const controller = new AbortController();
        this.#readinessControllers.add(controller);
        const unlink = forwardAbort(signal, controller);
        const deadlineAt = Date.now() + this.#options.readinessTimeoutMs;
        const timer = abortAt(controller, deadlineAt, PROVIDER_TIMEOUT);
        try {
          const readinessTask = Promise.resolve().then(() =>
            provider.readiness({ signal: controller.signal, deadlineAt }),
          );
          this.#readinessTasks.add(readinessTask);
          void readinessTask.then(
            () => this.#readinessTasks.delete(readinessTask),
            () => this.#readinessTasks.delete(readinessTask),
          );
          const readiness = await raceAgainstAbort(
            readinessTask,
            controller.signal,
          );
          if (!readiness.ready) {
            throw new MarketDataError(
              `Provider ${provider.id} is not ready: ${readiness.reason ?? "no reason supplied"}`,
              {
                code: "readiness_failed",
                retryable: true,
                fallbackEligible: false,
                providerId: provider.id,
              },
            );
          }
        } catch (error) {
          if (controller.signal.reason === PROVIDER_TIMEOUT) {
            throw new MarketDataError(
              `Provider ${provider.id} readiness timed out`,
              {
                code: "readiness_failed",
                retryable: true,
                fallbackEligible: false,
                providerId: provider.id,
              },
            );
          }
          if (signal?.aborted) {
            throw abortedError();
          }
          if (controller.signal.reason === RUNTIME_DISPOSE) {
            throw disposedError();
          }
          if (error instanceof MarketDataError) throw error;
          throw new MarketDataError(
            `Provider ${provider.id} readiness failed: ${redactMarketDataMessage(error)}`,
            {
              code: "readiness_failed",
              retryable: true,
              fallbackEligible: false,
              providerId: provider.id,
              cause: error,
            },
          );
        } finally {
          this.#readinessControllers.delete(controller);
          unlink();
          clearTimeout(timer);
        }
      }
      if (this.#state !== "starting") throw disposedError();
      this.#admission.open();
      this.#state = "ready";
    } catch (cause) {
      const cleanupErrors: unknown[] = [];
      for (const controller of this.#readinessControllers) {
        controller.abort(RUNTIME_DISPOSE);
      }
      try {
        await withTimeout(
          Promise.allSettled([...this.#readinessTasks]).then(() => undefined),
          this.#options.abortGraceMs,
          "Market-data readiness cancellation drain",
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
      for (const provider of [...this.#providers].reverse()) {
        try {
          await this.#disposeProvider(provider);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      this.#state = "failed";
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [cause, ...cleanupErrors],
          "Market-data readiness failed and cleanup was incomplete",
        );
      }
      throw cause;
    }
  }

  async #fetchFromProvider(
    provider: MarketDataProviderDescriptor,
    request: MarketDataRequest,
    operationSignal: AbortSignal,
    deadlineAt: number,
    providerTimeoutMs: number,
    providerTasks: Promise<unknown>[],
  ) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw deadlineError();
    const attempt = new AbortController();
    const unlink = forwardAbort(operationSignal, attempt);
    const attemptTimeout = Math.min(providerTimeoutMs, remaining);
    const timer =
      providerTimeoutMs < remaining
        ? setTimeout(() => attempt.abort(PROVIDER_TIMEOUT), attemptTimeout)
        : undefined;
    timer?.unref?.();
    const providerTask = Promise.resolve().then(() =>
      provider.fetch(request, { signal: attempt.signal, deadlineAt }),
    );
    providerTasks.push(providerTask);
    try {
      return await raceAgainstAbort(
        providerTask,
        attempt.signal,
      );
    } catch (error) {
      if (operationSignal.aborted) throw abortOrError(operationSignal, error);
      if (attempt.signal.reason === PROVIDER_TIMEOUT) {
        try {
          await withTimeout(
            providerTask.then(
              () => undefined,
              () => undefined,
            ),
            this.#options.abortGraceMs,
            `Cancellation acknowledgement for provider ${provider.id}`,
          );
        } catch {
          throw new MarketDataError(
            `Provider ${provider.id} did not settle after its abort deadline`,
            {
              code: "provider_failure",
              retryable: false,
              fallbackEligible: false,
              providerId: provider.id,
            },
          );
        }
        throw new MarketDataError(
          `Provider ${provider.id} timed out after ${attemptTimeout}ms`,
          {
            code: "provider_timeout",
            retryable: true,
            fallbackEligible: true,
            providerId: provider.id,
          },
        );
      }
      throw error;
    } finally {
      unlink();
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #dispose(): Promise<void> {
    if (this.#state === "disposed") return;
    const pendingStart = this.#state === "starting" ? this.#startPromise : undefined;
    this.#state = "disposing";
    this.#admission.stop();
    for (const controller of this.#readinessControllers) {
      controller.abort(RUNTIME_DISPOSE);
    }
    const errors: unknown[] = [];
    if (pendingStart !== undefined) {
      try {
        await pendingStart;
      } catch {
        // The start path performs its own rollback; shutdown reuses its
        // idempotent provider-disposal promises below.
      }
      this.#state = "disposing";
    }
    try {
      await withTimeout(
        this.#admission.drained(),
        this.#options.drainTimeoutMs,
        "Market-data runtime drain",
      );
    } catch {
      for (const controller of this.#operationControllers) {
        controller.abort(RUNTIME_DISPOSE);
      }
      try {
        await withTimeout(
          this.#admission.drained(),
          this.#options.abortGraceMs,
          "Market-data runtime cancellation drain",
        );
      } catch (error) {
        errors.push(error);
      }
    }
    for (const provider of [...this.#providers].reverse()) {
      try {
        await this.#disposeProvider(provider);
      } catch (error) {
        errors.push(error);
      }
    }
    this.#state = "disposed";
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "Market-data runtime did not stop cleanly",
      );
    }
  }

  #disposeProvider(provider: MarketDataProviderDescriptor): Promise<void> {
    const existing = this.#providerDisposals.get(provider);
    if (existing !== undefined) return existing;
    const disposal = withTimeout(
      Promise.resolve().then(() => provider.dispose?.()),
      this.#options.disposeTimeoutMs,
      `Disposer for market-data provider ${provider.id}`,
    ).then(() => undefined);
    this.#providerDisposals.set(provider, disposal);
    return disposal;
  }
}

function validateProviders(
  providers: readonly MarketDataProviderDescriptor[],
  waterfall: readonly string[],
): readonly MarketDataProviderDescriptor[] {
  if (providers.length === 0 || waterfall.length === 0) {
    throw new MarketDataError(
      "Market-data runtime requires at least one provider",
      {
        code: "not_ready",
        retryable: false,
        fallbackEligible: false,
      },
    );
  }
  const byId = new Map<string, MarketDataProviderDescriptor>();
  for (const provider of providers) {
    if (!provider.id || provider.id !== provider.id.trim()) {
      throw new MarketDataError("Provider IDs must be non-empty and trimmed", {
        code: "not_ready",
        retryable: false,
        fallbackEligible: false,
      });
    }
    if (byId.has(provider.id)) {
      throw new MarketDataError(`Duplicate market-data provider ${provider.id}`, {
        code: "not_ready",
        retryable: false,
        fallbackEligible: false,
      });
    }
    byId.set(provider.id, provider);
  }
  if (new Set(waterfall).size !== waterfall.length) {
    throw new MarketDataError("Market-data waterfall contains duplicate IDs", {
      code: "not_ready",
      retryable: false,
      fallbackEligible: false,
    });
  }
  if (
    waterfall.length !== providers.length ||
    waterfall.some((id) => !byId.has(id))
  ) {
    throw new MarketDataError(
      "Market-data waterfall must name every provider exactly once",
      {
        code: "not_ready",
        retryable: false,
        fallbackEligible: false,
      },
    );
  }
  return Object.freeze(
    waterfall.map((id) => {
      const provider = byId.get(id);
      if (provider === undefined) throw new Error("validated provider missing");
      return provider;
    }),
  );
}

function assertCancellationReady(
  providerId: string,
  capability: MarketDataCancellationCapability,
): void {
  if (!capability.guaranteed) {
    throw new MarketDataError(
      `Provider ${providerId} cannot guarantee cancellation: ${capability.reason}`,
      {
        code: "readiness_failed",
        retryable: false,
        fallbackEligible: false,
        providerId,
      },
    );
  }
}

function aggregateEffects(
  providers: readonly MarketDataProviderDescriptor[],
): MarketDataEffects {
  if (providers.some(({ capabilities }) => capabilities.effects === "external-write")) {
    return "external-write";
  }
  return providers.some(
    ({ capabilities }) => capabilities.effects === "isolated-artifacts",
  )
    ? "isolated-artifacts"
    : "none";
}

function providerFailure(providerId: string, error: unknown): MarketDataError {
  if (error instanceof MarketDataError) {
    return new MarketDataError(error.message, {
      code: error.code,
      retryable: error.retryable,
      fallbackEligible: error.fallbackEligible,
      providerId: error.providerId ?? providerId,
      cause: error,
    });
  }
  return new MarketDataError(redactMarketDataMessage(error), {
    code: "provider_failure",
    retryable: false,
    fallbackEligible: true,
    providerId,
    cause: error,
  });
}

function diagnostics(
  waterfall: readonly string[],
  selectedProviderId: string | null,
  attempts: readonly MarketDataAttemptDiagnostic[],
  startedAt: number,
): MarketDataFallbackDiagnostics {
  return Object.freeze({
    waterfall: Object.freeze([...waterfall]),
    selectedProviderId,
    attempts: Object.freeze([...attempts]),
    totalDurationMs: durationSince(startedAt),
  });
}

function abortOrError(signal: AbortSignal, error: unknown): unknown {
  if (!signal.aborted) return error;
  if (signal.reason === OPERATION_DEADLINE) return deadlineError();
  if (signal.reason === RUNTIME_DISPOSE) return disposedError();
  return abortedError();
}

function deadlineError(): MarketDataError {
  return new MarketDataError("Market-data total deadline was exceeded", {
    code: "deadline_exceeded",
    retryable: true,
    fallbackEligible: false,
  });
}

function abortedError(): MarketDataError {
  return new MarketDataError("Market-data request was aborted", {
    code: "aborted",
    retryable: false,
    fallbackEligible: false,
  });
}

function disposedError(): MarketDataError {
  return new MarketDataError("Market-data runtime is stopping or disposed", {
    code: "disposed",
    retryable: false,
    fallbackEligible: false,
  });
}

function forwardAbort(
  source: AbortSignal | undefined,
  target: AbortController,
): () => void {
  if (source === undefined) return () => undefined;
  const abort = (): void => target.abort(source.reason);
  if (source.aborted) {
    abort();
    return () => undefined;
  }
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function abortAt(
  controller: AbortController,
  deadlineAt: number,
  reason: unknown,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(
    () => controller.abort(reason),
    Math.max(0, deadlineAt - Date.now()),
  );
  timer.unref?.();
  return timer;
}

function raceAgainstAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new MarketDataError(`${label} timed out after ${timeoutMs}ms`, {
          code: "provider_timeout",
          retryable: true,
          fallbackEligible: false,
        }),
      );
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MarketDataError(`${name} must be a positive integer`, {
      code: "not_ready",
      retryable: false,
      fallbackEligible: false,
    });
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MarketDataError(`${name} must be a non-negative integer`, {
      code: "not_ready",
      retryable: false,
      fallbackEligible: false,
    });
  }
  return value;
}

function finiteDeadline(value: number): number {
  if (!Number.isFinite(value)) {
    throw new MarketDataError("deadlineAt must be finite epoch milliseconds", {
      code: "invalid_request",
      retryable: false,
      fallbackEligible: false,
    });
  }
  return value;
}

function durationSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}
