const capabilityKeyBrand = Symbol("capability-key");

export type CapabilityMode = "single" | "multi";

export interface CapabilityKey<T, M extends CapabilityMode = "single"> {
  readonly name: string;
  readonly mode: M;
  readonly [capabilityKeyBrand]: T;
}

export interface MultiCapabilityOptions {
  readonly multi: true;
}

export function createCapabilityKey<T>(name: string): CapabilityKey<T>;
export function createCapabilityKey<T>(
  name: string,
  options: MultiCapabilityOptions,
): CapabilityKey<T, "multi">;
export function createCapabilityKey<T>(
  name: string,
  options?: MultiCapabilityOptions,
): CapabilityKey<T, CapabilityMode> {
  const normalizedName = name.trim();
  if (normalizedName.length === 0) {
    throw new CapabilityDefinitionError("Capability names must not be empty");
  }
  const key = {
    name: normalizedName,
    mode: options?.multi === true ? "multi" : "single",
    [capabilityKeyBrand]: undefined as T,
  } satisfies CapabilityKey<T, CapabilityMode>;
  knownCapabilityKeys.add(key);
  return Object.freeze(key);
}

type AnyCapabilityKey = CapabilityKey<unknown, CapabilityMode>;
type DependencyMap = Readonly<Record<string, AnyCapabilityKey>>;
type MaybePromise<T> = T | PromiseLike<T>;

export type CapabilityValue<K extends AnyCapabilityKey> =
  K extends CapabilityKey<infer T, CapabilityMode> ? T : never;

export type CapabilityLeaseResult<K extends AnyCapabilityKey> =
  K extends CapabilityKey<infer T, "multi">
    ? readonly CapabilityLease<T>[]
    : K extends CapabilityKey<infer T, "single">
      ? CapabilityLease<T>
      : never;

export type CapabilityUseValue<K extends AnyCapabilityKey> =
  K extends CapabilityKey<infer T, "multi">
    ? readonly T[]
    : K extends CapabilityKey<infer T, "single">
      ? T
      : never;

export interface CapabilityLease<T> {
  readonly value: T;
  readonly providerId: string;
  release(): void;
}

export interface CapabilityHandle<K extends AnyCapabilityKey> {
  readonly key: K;
  isAvailable(): boolean;
  lease(): Promise<CapabilityLeaseResult<K>>;
  use<R>(
    callback: (value: CapabilityUseValue<K>) => MaybePromise<R>,
  ): Promise<R>;
}

export interface OptionalCapabilityHandle<K extends AnyCapabilityKey> {
  readonly key: K;
  isAvailable(): boolean;
  lease(): Promise<CapabilityLeaseResult<K> | undefined>;
  use<R>(
    callback: (value: CapabilityUseValue<K>) => MaybePromise<R>,
  ): Promise<R | undefined>;
}

type RequiredHandles<R extends DependencyMap> = {
  readonly [P in keyof R]: CapabilityHandle<R[P]>;
};

type OptionalHandles<O extends DependencyMap> = {
  readonly [P in keyof O]: OptionalCapabilityHandle<O[P]>;
};

export interface ProviderStartContext<
  R extends DependencyMap,
  O extends DependencyMap,
> {
  readonly required: RequiredHandles<R>;
  readonly optional: OptionalHandles<O>;
}

export interface CapabilityAdmissionLimits {
  readonly maxConcurrent: number;
  readonly maxQueue: number;
}

export interface CapabilityProviderInstance<T> {
  readonly value: T;
  readonly healthCheck?: () => MaybePromise<boolean | void>;
  readonly dispose?: () => MaybePromise<void>;
}

export interface CapabilityProviderDescriptor<
  K extends AnyCapabilityKey,
  R extends DependencyMap = Readonly<Record<never, never>>,
  O extends DependencyMap = Readonly<Record<never, never>>,
> {
  readonly id: string;
  readonly capability: K;
  readonly required?: R;
  readonly optional?: O;
  readonly admission?: Partial<CapabilityAdmissionLimits>;
  readonly start: (
    context: ProviderStartContext<R, O>,
  ) => MaybePromise<CapabilityProviderInstance<CapabilityValue<K>>>;
}

export function defineCapabilityProvider<
  K extends AnyCapabilityKey,
  const R extends DependencyMap = Readonly<Record<never, never>>,
  const O extends DependencyMap = Readonly<Record<never, never>>,
>(
  descriptor: CapabilityProviderDescriptor<K, R, O>,
): CapabilityProviderDescriptor<K, R, O> {
  return descriptor;
}

export interface CapabilityRegistryOptions {
  readonly admission?: Partial<CapabilityAdmissionLimits>;
  readonly healthCheckTimeoutMs?: number;
  readonly drainTimeoutMs?: number;
  readonly disposeTimeoutMs?: number;
}

export type CapabilityRegistryStatus =
  | "collecting"
  | "starting"
  | "started"
  | "disposing"
  | "disposed"
  | "failed";

export class CapabilityRegistryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CapabilityRegistryError";
  }
}

export class CapabilityDefinitionError extends CapabilityRegistryError {
  public constructor(message: string) {
    super(message);
    this.name = "CapabilityDefinitionError";
  }
}

export class CapabilityUnavailableError extends CapabilityRegistryError {
  public constructor(message: string) {
    super(message);
    this.name = "CapabilityUnavailableError";
  }
}

export class CapabilityAdmissionError extends CapabilityRegistryError {
  public constructor(message: string) {
    super(message);
    this.name = "CapabilityAdmissionError";
  }
}

export class CapabilityTimeoutError extends CapabilityRegistryError {
  public constructor(
    message: string,
    public readonly timeoutMs: number,
  ) {
    super(message);
    this.name = "CapabilityTimeoutError";
  }
}

interface NormalizedOptions {
  readonly admission: CapabilityAdmissionLimits;
  readonly healthCheckTimeoutMs: number;
  readonly drainTimeoutMs: number;
  readonly disposeTimeoutMs: number;
}

interface RegisteredDescriptor {
  readonly index: number;
  readonly id: string;
  readonly capability: AnyCapabilityKey;
  readonly required: DependencyMap;
  readonly optional: DependencyMap;
  readonly admission?: Partial<CapabilityAdmissionLimits>;
  readonly start: (
    context: ProviderStartContext<DependencyMap, DependencyMap>,
  ) => MaybePromise<CapabilityProviderInstance<unknown>>;
}

interface StartPlan {
  readonly ordered: readonly RegisteredDescriptor[];
  readonly providersByCapability: ReadonlyMap<
    AnyCapabilityKey,
    readonly RegisteredDescriptor[]
  >;
}

interface AdmissionWaiter<T> {
  readonly resolve: (lease: CapabilityLease<T>) => void;
  readonly reject: (error: Error) => void;
}

const knownCapabilityKeys = new WeakSet<object>();
const EMPTY_DEPENDENCIES: DependencyMap = Object.freeze({});
const DEFAULT_OPTIONS: NormalizedOptions = Object.freeze({
  admission: Object.freeze({ maxConcurrent: 64, maxQueue: 256 }),
  healthCheckTimeoutMs: 5_000,
  drainTimeoutMs: 30_000,
  disposeTimeoutMs: 10_000,
});

class ProviderSlot<T> {
  readonly #waiters: AdmissionWaiter<T>[] = [];
  readonly #drained: Promise<void>;
  readonly #resolveDrained: () => void;
  #activeLeases = 0;
  #state: "starting" | "active" | "draining" | "disposed" = "starting";
  #disposePromise: Promise<void> | undefined;

  public constructor(
    public readonly descriptor: RegisteredDescriptor,
    public readonly instance: CapabilityProviderInstance<T>,
    public readonly admission: CapabilityAdmissionLimits,
  ) {
    let resolveDrained: (() => void) | undefined;
    this.#drained = new Promise<void>((resolve) => {
      resolveDrained = resolve;
    });
    this.#resolveDrained = resolveDrained as () => void;
  }

  public get id(): string {
    return this.descriptor.id;
  }

  public get capability(): AnyCapabilityKey {
    return this.descriptor.capability;
  }

  public get index(): number {
    return this.descriptor.index;
  }

  public get isActive(): boolean {
    return this.#state === "active";
  }

  public activate(): void {
    if (this.#state !== "starting") {
      throw new CapabilityRegistryError(
        `Provider ${this.id} cannot be activated from ${this.#state}`,
      );
    }
    this.#state = "active";
  }

  public acquire(): Promise<CapabilityLease<T>> {
    if (this.#state !== "active") {
      return Promise.reject(
        new CapabilityUnavailableError(
          `Provider ${this.id} is not accepting new leases`,
        ),
      );
    }
    if (this.#activeLeases < this.admission.maxConcurrent) {
      this.#activeLeases += 1;
      return Promise.resolve(this.#newLease());
    }
    if (this.#waiters.length >= this.admission.maxQueue) {
      return Promise.reject(
        new CapabilityAdmissionError(
          `Provider ${this.id} admission queue is full`,
        ),
      );
    }
    return new Promise<CapabilityLease<T>>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  public retire(): void {
    if (this.#state === "disposed" || this.#state === "draining") {
      return;
    }
    this.#state = "draining";
    const error = new CapabilityUnavailableError(
      `Provider ${this.id} retired before a queued lease was admitted`,
    );
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
    if (this.#activeLeases === 0) {
      this.#resolveDrained();
    }
  }

  public waitUntilDrained(): Promise<void> {
    return this.#drained;
  }

  public disposeOnce(): Promise<void> {
    if (this.#disposePromise !== undefined) {
      return this.#disposePromise;
    }
    this.#disposePromise = (async () => {
      try {
        await this.instance.dispose?.();
      } finally {
        this.#state = "disposed";
      }
    })();
    return this.#disposePromise;
  }

  #newLease(): CapabilityLease<T> {
    let released = false;
    return Object.freeze({
      value: this.instance.value,
      providerId: this.id,
      release: (): void => {
        if (released) {
          return;
        }
        released = true;
        this.#release();
      },
    });
  }

  #release(): void {
    if (this.#activeLeases <= 0) {
      throw new CapabilityRegistryError(
        `Provider ${this.id} lease accounting underflow`,
      );
    }
    this.#activeLeases -= 1;
    if (this.#state === "active") {
      const waiter = this.#waiters.shift();
      if (waiter !== undefined) {
        this.#activeLeases += 1;
        waiter.resolve(this.#newLease());
      }
      return;
    }
    if (this.#activeLeases === 0) {
      this.#resolveDrained();
    }
  }
}

export class CapabilityRegistry {
  readonly #options: NormalizedOptions;
  readonly #descriptors: RegisteredDescriptor[] = [];
  readonly #routes = new Map<AnyCapabilityKey, readonly ProviderSlot<unknown>[]>();
  readonly #slotsById = new Map<string, ProviderSlot<unknown>>();
  readonly #retiredSlots = new Set<ProviderSlot<unknown>>();
  #shutdownOrder: readonly string[] = [];
  #status: CapabilityRegistryStatus = "collecting";
  #admissionOpen = false;
  #disposeRequested = false;
  #mutationTail: Promise<void> = Promise.resolve();
  #disposePromise: Promise<void> | undefined;

  public constructor(options: CapabilityRegistryOptions = {}) {
    this.#options = normalizeOptions(options);
  }

  public get status(): CapabilityRegistryStatus {
    return this.#status;
  }

  public register<
    K extends AnyCapabilityKey,
    R extends DependencyMap,
    O extends DependencyMap,
  >(descriptor: CapabilityProviderDescriptor<K, R, O>): this {
    if (this.#status !== "collecting" || this.#disposeRequested) {
      throw new CapabilityRegistryError(
        `Providers cannot be registered while registry is ${this.#status}`,
      );
    }
    this.#descriptors.push(
      eraseDescriptor(descriptor, this.#descriptors.length),
    );
    return this;
  }

  public start(): Promise<void> {
    if (this.#status !== "collecting" || this.#disposeRequested) {
      return Promise.reject(
        new CapabilityRegistryError(
          `Registry cannot start while it is ${this.#status}`,
        ),
      );
    }
    this.#status = "starting";
    return this.#runExclusive(async () => {
      const started: ProviderSlot<unknown>[] = [];
      try {
        const plan = buildStartPlan(this.#descriptors, this.#options);
        for (const descriptor of plan.ordered) {
          const instance = await descriptor.start(this.#contextFor(descriptor));
          assertProviderInstance(descriptor, instance);
          const slot = new ProviderSlot(
            descriptor,
            instance,
            admissionFor(descriptor, this.#options),
          );
          started.push(slot);
          await this.#checkHealth(slot);
          slot.activate();
          this.#publish(slot);
          this.#slotsById.set(slot.id, slot);
        }
        this.#shutdownOrder = plan.ordered.map(({ id }) => id);
        this.#admissionOpen = !this.#disposeRequested;
        this.#status = "started";
      } catch (cause) {
        const cleanupErrors: unknown[] = [];
        for (const slot of started.reverse()) {
          this.#unpublish(slot);
          this.#slotsById.delete(slot.id);
          cleanupErrors.push(...(await this.#cleanupSlot(slot)));
        }
        this.#shutdownOrder = [];
        if (cleanupErrors.length === 0) {
          this.#status = "collecting";
          throw cause;
        }
        this.#status = "failed";
        throw new AggregateError(
          [cause, ...cleanupErrors],
          "Capability registry start failed and rollback was incomplete",
        );
      }
    });
  }

  public lease<K extends AnyCapabilityKey>(
    key: K,
  ): Promise<CapabilityLeaseResult<K>> {
    if (this.#status !== "started" || !this.#admissionOpen) {
      return Promise.reject(
        new CapabilityUnavailableError(
          `Registry is not accepting leases while it is ${this.#status}`,
        ),
      );
    }
    return this.#leaseInternal(key);
  }

  public async use<K extends AnyCapabilityKey, R>(
    key: K,
    callback: (value: CapabilityUseValue<K>) => MaybePromise<R>,
  ): Promise<R> {
    const leases = await this.lease(key);
    return useLeases(leases, callback);
  }

  public replaceProvider<
    K extends AnyCapabilityKey,
    R extends DependencyMap,
    O extends DependencyMap,
  >(
    providerId: string,
    replacement: CapabilityProviderDescriptor<K, R, O>,
  ): Promise<void> {
    return this.#runExclusive(async () => {
      if (this.#status !== "started" || !this.#admissionOpen) {
        throw new CapabilityRegistryError(
          `Providers cannot be replaced while registry is ${this.#status}`,
        );
      }
      const previous = this.#slotsById.get(providerId);
      if (previous === undefined) {
        throw new CapabilityDefinitionError(
          `Provider ${providerId} is not registered`,
        );
      }
      const candidateDescriptor = eraseDescriptor(
        replacement,
        previous.index,
      );
      if (candidateDescriptor.capability !== previous.capability) {
        throw new CapabilityDefinitionError(
          `Replacement for ${providerId} must provide capability ${previous.capability.name}`,
        );
      }
      const prospective = this.#descriptors.map((descriptor) =>
        descriptor.id === providerId ? candidateDescriptor : descriptor,
      );
      const plan = buildStartPlan(prospective, this.#options);

      let candidate: ProviderSlot<unknown> | undefined;
      try {
        const instance = await candidateDescriptor.start(
          this.#contextFor(candidateDescriptor),
        );
        assertProviderInstance(candidateDescriptor, instance);
        candidate = new ProviderSlot(
          candidateDescriptor,
          instance,
          admissionFor(candidateDescriptor, this.#options),
        );
        await this.#checkHealth(candidate);
      } catch (cause) {
        if (candidate === undefined) {
          throw cause;
        }
        const cleanupErrors = await this.#cleanupSlot(candidate);
        if (cleanupErrors.length === 0) {
          throw cause;
        }
        throw new AggregateError(
          [cause, ...cleanupErrors],
          `Replacement provider ${candidateDescriptor.id} failed health check and cleanup`,
        );
      }

      candidate.activate();
      this.#swap(previous, candidate);
      this.#slotsById.delete(previous.id);
      this.#slotsById.set(candidate.id, candidate);
      this.#descriptors.splice(
        this.#descriptors.indexOf(previous.descriptor),
        1,
        candidateDescriptor,
      );
      this.#shutdownOrder = plan.ordered.map(({ id }) => id);

      this.#retiredSlots.add(previous);
      const cleanupErrors = await this.#cleanupSlot(previous);
      if (cleanupErrors.length === 0) {
        this.#retiredSlots.delete(previous);
        return;
      }
      throw new AggregateError(
        cleanupErrors,
        `Provider ${previous.id} was replaced, but its cleanup was incomplete`,
      );
    });
  }

  public dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) {
      return this.#disposePromise;
    }
    this.#disposeRequested = true;
    this.#admissionOpen = false;
    this.#disposePromise = this.#runExclusive(async () => {
      if (this.#status === "disposed") {
        return;
      }
      this.#status = "disposing";
      const errors: unknown[] = [];
      const ordered = [...this.#shutdownOrder].reverse();
      const visited = new Set<ProviderSlot<unknown>>();
      for (const providerId of ordered) {
        const slot = this.#slotsById.get(providerId);
        if (slot === undefined || visited.has(slot)) {
          continue;
        }
        visited.add(slot);
        this.#unpublish(slot);
        errors.push(...(await this.#cleanupSlot(slot)));
      }
      for (const slot of this.#slotsById.values()) {
        if (visited.has(slot)) {
          continue;
        }
        this.#unpublish(slot);
        errors.push(...(await this.#cleanupSlot(slot)));
      }
      for (const slot of this.#retiredSlots) {
        errors.push(...(await this.#cleanupSlot(slot)));
      }
      this.#slotsById.clear();
      this.#retiredSlots.clear();
      this.#routes.clear();
      this.#shutdownOrder = [];
      this.#status = "disposed";
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          "One or more capability providers failed to stop cleanly",
        );
      }
    });
    return this.#disposePromise;
  }

  #contextFor(
    descriptor: RegisteredDescriptor,
  ): ProviderStartContext<DependencyMap, DependencyMap> {
    const required: Record<string, CapabilityHandle<AnyCapabilityKey>> =
      Object.create(null) as Record<
        string,
        CapabilityHandle<AnyCapabilityKey>
      >;
    const optional: Record<
      string,
      OptionalCapabilityHandle<AnyCapabilityKey>
    > = Object.create(null) as Record<
      string,
      OptionalCapabilityHandle<AnyCapabilityKey>
    >;
    for (const [alias, key] of Object.entries(descriptor.required)) {
      required[alias] = this.#requiredHandle(key);
    }
    for (const [alias, key] of Object.entries(descriptor.optional)) {
      optional[alias] = this.#optionalHandle(key);
    }
    return Object.freeze({
      required: Object.freeze(required),
      optional: Object.freeze(optional),
    });
  }

  #requiredHandle<K extends AnyCapabilityKey>(key: K): CapabilityHandle<K> {
    return Object.freeze({
      key,
      isAvailable: (): boolean => this.#hasActiveProvider(key),
      lease: (): Promise<CapabilityLeaseResult<K>> => this.#leaseInternal(key),
      use: async <R>(
        callback: (value: CapabilityUseValue<K>) => MaybePromise<R>,
      ): Promise<R> => {
        const leases = await this.#leaseInternal(key);
        return useLeases(leases, callback);
      },
    });
  }

  #optionalHandle<K extends AnyCapabilityKey>(
    key: K,
  ): OptionalCapabilityHandle<K> {
    return Object.freeze({
      key,
      isAvailable: (): boolean => this.#hasActiveProvider(key),
      lease: (): Promise<CapabilityLeaseResult<K> | undefined> =>
        this.#hasActiveProvider(key)
          ? this.#leaseInternal(key)
          : Promise.resolve(undefined),
      use: async <R>(
        callback: (value: CapabilityUseValue<K>) => MaybePromise<R>,
      ): Promise<R | undefined> => {
        if (!this.#hasActiveProvider(key)) {
          return undefined;
        }
        const leases = await this.#leaseInternal(key);
        return useLeases(leases, callback);
      },
    });
  }

  #hasActiveProvider(key: AnyCapabilityKey): boolean {
    return this.#routes.get(key)?.some((slot) => slot.isActive) === true;
  }

  async #leaseInternal<K extends AnyCapabilityKey>(
    key: K,
  ): Promise<CapabilityLeaseResult<K>> {
    assertKnownKey(key);
    const slots = this.#routes.get(key)?.filter((slot) => slot.isActive) ?? [];
    if (slots.length === 0) {
      throw new CapabilityUnavailableError(
        `Capability ${key.name} has no active provider`,
      );
    }
    if (key.mode === "single") {
      if (slots.length !== 1) {
        throw new CapabilityRegistryError(
          `Single capability ${key.name} resolved to ${slots.length} providers`,
        );
      }
      return (await slots[0]?.acquire()) as CapabilityLeaseResult<K>;
    }
    const leases: CapabilityLease<unknown>[] = [];
    try {
      for (const slot of slots) {
        leases.push(await slot.acquire());
      }
      return Object.freeze(leases) as CapabilityLeaseResult<K>;
    } catch (error) {
      for (const lease of leases.reverse()) {
        lease.release();
      }
      throw error;
    }
  }

  async #checkHealth(slot: ProviderSlot<unknown>): Promise<void> {
    if (slot.instance.healthCheck === undefined) {
      return;
    }
    const healthy = await withTimeout(
      Promise.resolve().then(() => slot.instance.healthCheck?.()),
      this.#options.healthCheckTimeoutMs,
      `Health check for provider ${slot.id}`,
    );
    if (healthy === false) {
      throw new CapabilityRegistryError(
        `Health check for provider ${slot.id} reported unhealthy`,
      );
    }
  }

  async #cleanupSlot(slot: ProviderSlot<unknown>): Promise<unknown[]> {
    const errors: unknown[] = [];
    slot.retire();
    try {
      await withTimeout(
        slot.waitUntilDrained(),
        this.#options.drainTimeoutMs,
        `Drain for provider ${slot.id}`,
      );
    } catch (error) {
      errors.push(error);
    }
    try {
      await withTimeout(
        slot.disposeOnce(),
        this.#options.disposeTimeoutMs,
        `Disposer for provider ${slot.id}`,
      );
    } catch (error) {
      errors.push(error);
    }
    return errors;
  }

  #publish(slot: ProviderSlot<unknown>): void {
    const current = this.#routes.get(slot.capability) ?? [];
    this.#routes.set(
      slot.capability,
      Object.freeze([...current, slot].sort((left, right) => left.index - right.index)),
    );
  }

  #unpublish(slot: ProviderSlot<unknown>): void {
    const current = this.#routes.get(slot.capability);
    if (current === undefined) {
      return;
    }
    const remaining = current.filter((candidate) => candidate !== slot);
    if (remaining.length === 0) {
      this.#routes.delete(slot.capability);
    } else {
      this.#routes.set(slot.capability, Object.freeze(remaining));
    }
  }

  #swap(previous: ProviderSlot<unknown>, candidate: ProviderSlot<unknown>): void {
    const current = this.#routes.get(previous.capability) ?? [];
    const next = current.map((slot) =>
      slot === previous ? candidate : slot,
    );
    if (!next.includes(candidate)) {
      throw new CapabilityRegistryError(
        `Provider ${previous.id} disappeared before atomic replacement`,
      );
    }
    this.#routes.set(previous.capability, Object.freeze(next));
  }

  #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTail;
    let release: (() => void) | undefined;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(operation).finally(() => {
      release?.();
    });
  }
}

function eraseDescriptor<
  K extends AnyCapabilityKey,
  R extends DependencyMap,
  O extends DependencyMap,
>(
  descriptor: CapabilityProviderDescriptor<K, R, O>,
  index: number,
): RegisteredDescriptor {
  return {
    index,
    id: descriptor.id,
    capability: descriptor.capability,
    required: descriptor.required ?? EMPTY_DEPENDENCIES,
    optional: descriptor.optional ?? EMPTY_DEPENDENCIES,
    ...(descriptor.admission === undefined
      ? {}
      : { admission: descriptor.admission }),
    start: descriptor.start as unknown as RegisteredDescriptor["start"],
  };
}

function buildStartPlan(
  descriptors: readonly RegisteredDescriptor[],
  options: NormalizedOptions,
): StartPlan {
  const providersById = new Map<string, RegisteredDescriptor>();
  const providersByCapability = new Map<
    AnyCapabilityKey,
    RegisteredDescriptor[]
  >();
  for (const descriptor of descriptors) {
    if (descriptor.id.trim().length === 0 || descriptor.id !== descriptor.id.trim()) {
      throw new CapabilityDefinitionError(
        "Provider IDs must be non-empty and must not have surrounding whitespace",
      );
    }
    assertKnownKey(descriptor.capability);
    if (typeof descriptor.start !== "function") {
      throw new CapabilityDefinitionError(
        `Provider ${descriptor.id} does not define start()`,
      );
    }
    if (providersById.has(descriptor.id)) {
      throw new CapabilityDefinitionError(
        `Provider ID ${descriptor.id} is registered more than once`,
      );
    }
    providersById.set(descriptor.id, descriptor);
    const providers = providersByCapability.get(descriptor.capability) ?? [];
    providers.push(descriptor);
    providersByCapability.set(descriptor.capability, providers);
    admissionFor(descriptor, options);
    validateDependencyAliases(descriptor);
  }
  for (const [key, providers] of providersByCapability) {
    if (key.mode === "single" && providers.length > 1) {
      throw new CapabilityDefinitionError(
        `Single capability ${key.name} has ${providers.length} providers`,
      );
    }
  }
  for (const descriptor of descriptors) {
    for (const [alias, key] of Object.entries(descriptor.required)) {
      assertKnownKey(key);
      if ((providersByCapability.get(key)?.length ?? 0) === 0) {
        throw new CapabilityDefinitionError(
          `Provider ${descriptor.id} is missing required dependency ${alias} (${key.name})`,
        );
      }
    }
    for (const key of Object.values(descriptor.optional)) {
      assertKnownKey(key);
    }
  }

  const ordered: RegisteredDescriptor[] = [];
  const permanent = new Set<RegisteredDescriptor>();
  const temporary = new Set<RegisteredDescriptor>();
  const stack: RegisteredDescriptor[] = [];
  const visit = (descriptor: RegisteredDescriptor): void => {
    if (permanent.has(descriptor)) {
      return;
    }
    if (temporary.has(descriptor)) {
      const cycleStart = stack.indexOf(descriptor);
      const cycle = [...stack.slice(cycleStart), descriptor]
        .map(({ id }) => id)
        .join(" -> ");
      throw new CapabilityDefinitionError(`Capability dependency cycle: ${cycle}`);
    }
    temporary.add(descriptor);
    stack.push(descriptor);
    const dependencyKeys = [
      ...Object.values(descriptor.required),
      ...Object.values(descriptor.optional),
    ];
    const dependencies = new Set<RegisteredDescriptor>();
    for (const key of dependencyKeys) {
      for (const provider of providersByCapability.get(key) ?? []) {
        dependencies.add(provider);
      }
    }
    for (const dependency of dependencies) {
      visit(dependency);
    }
    stack.pop();
    temporary.delete(descriptor);
    permanent.add(descriptor);
    ordered.push(descriptor);
  };
  for (const descriptor of descriptors) {
    visit(descriptor);
  }
  return { ordered, providersByCapability };
}

function validateDependencyAliases(descriptor: RegisteredDescriptor): void {
  const requiredAliases = new Set(Object.keys(descriptor.required));
  for (const alias of Object.keys(descriptor.optional)) {
    if (requiredAliases.has(alias)) {
      throw new CapabilityDefinitionError(
        `Provider ${descriptor.id} declares dependency alias ${alias} as both required and optional`,
      );
    }
  }
}

function assertKnownKey(key: AnyCapabilityKey): void {
  if (
    typeof key !== "object" ||
    key === null ||
    !knownCapabilityKeys.has(key)
  ) {
    throw new CapabilityDefinitionError(
      "Capability keys must be created with createCapabilityKey()",
    );
  }
}

function assertProviderInstance(
  descriptor: RegisteredDescriptor,
  instance: CapabilityProviderInstance<unknown>,
): asserts instance is CapabilityProviderInstance<unknown> {
  if (
    typeof instance !== "object" ||
    instance === null ||
    !Object.prototype.hasOwnProperty.call(instance, "value")
  ) {
    throw new CapabilityDefinitionError(
      `Provider ${descriptor.id} start() must return an object with a value`,
    );
  }
  if (
    instance.healthCheck !== undefined &&
    typeof instance.healthCheck !== "function"
  ) {
    throw new CapabilityDefinitionError(
      `Provider ${descriptor.id} healthCheck must be a function`,
    );
  }
  if (instance.dispose !== undefined && typeof instance.dispose !== "function") {
    throw new CapabilityDefinitionError(
      `Provider ${descriptor.id} dispose must be a function`,
    );
  }
}

function normalizeOptions(options: CapabilityRegistryOptions): NormalizedOptions {
  const admission = normalizeAdmission(
    options.admission,
    DEFAULT_OPTIONS.admission,
    "Registry",
  );
  return Object.freeze({
    admission,
    healthCheckTimeoutMs: positiveInteger(
      options.healthCheckTimeoutMs ?? DEFAULT_OPTIONS.healthCheckTimeoutMs,
      "healthCheckTimeoutMs",
    ),
    drainTimeoutMs: positiveInteger(
      options.drainTimeoutMs ?? DEFAULT_OPTIONS.drainTimeoutMs,
      "drainTimeoutMs",
    ),
    disposeTimeoutMs: positiveInteger(
      options.disposeTimeoutMs ?? DEFAULT_OPTIONS.disposeTimeoutMs,
      "disposeTimeoutMs",
    ),
  });
}

function admissionFor(
  descriptor: RegisteredDescriptor,
  options: NormalizedOptions,
): CapabilityAdmissionLimits {
  return normalizeAdmission(
    descriptor.admission,
    options.admission,
    `Provider ${descriptor.id}`,
  );
}

function normalizeAdmission(
  input: Partial<CapabilityAdmissionLimits> | undefined,
  defaults: CapabilityAdmissionLimits,
  owner: string,
): CapabilityAdmissionLimits {
  return Object.freeze({
    maxConcurrent: positiveInteger(
      input?.maxConcurrent ?? defaults.maxConcurrent,
      `${owner} maxConcurrent`,
    ),
    maxQueue: nonNegativeInteger(
      input?.maxQueue ?? defaults.maxQueue,
      `${owner} maxQueue`,
    ),
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CapabilityDefinitionError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CapabilityDefinitionError(
      `${name} must be a non-negative integer`,
    );
  }
  return value;
}

async function useLeases<K extends AnyCapabilityKey, R>(
  leases: CapabilityLeaseResult<K>,
  callback: (value: CapabilityUseValue<K>) => MaybePromise<R>,
): Promise<R> {
  if (Array.isArray(leases)) {
    try {
      return await callback(
        Object.freeze(leases.map(({ value }) => value)) as CapabilityUseValue<K>,
      );
    } finally {
      for (const lease of [...leases].reverse()) {
        lease.release();
      }
    }
  }
  const lease = leases as CapabilityLease<unknown>;
  try {
    return await callback(lease.value as CapabilityUseValue<K>);
  } finally {
    lease.release();
  }
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
        new CapabilityTimeoutError(
          `${label} did not complete within ${timeoutMs}ms`,
          timeoutMs,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
