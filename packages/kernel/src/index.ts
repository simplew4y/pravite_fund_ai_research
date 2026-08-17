/**
 * @private-fund/kernel — thin wrapper around the Cordis plugin kernel
 * (the control plane DeepSeek Harness is built on).
 *
 * Business plugins never see cordis: its runtime is loaded dynamically and
 * its types are re-declared structurally here (cordis 4.0.0-rc ships d.ts
 * that breaks under NodeNext resolution, so leaking them is not an option).
 * Upstream churn only ever touches this package.
 */

/**
 * Service registry. Plugins augment this interface to declare the services
 * they provide, e.g.
 *
 *   declare module "@private-fund/kernel" {
 *     interface KernelServices { blobStore: LocalEncryptedBlobStore }
 *   }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface KernelServices {}

export type KernelServiceName = keyof KernelServices & string;

/** A disposer returned by an effect; awaited during teardown. */
export type KernelDisposer = () => void | Promise<void>;

/** Context view handed to plugin apply() — typed access to injected services. */
export type KernelContext = Readonly<KernelServices> & {
  /** Register a reversible side effect; disposed with the plugin (LIFO). */
  effect(effect: () => KernelDisposer, label?: string): KernelDisposer;
};

export interface KernelPlugin<Config = void> {
  /** Unique plugin name; duplicate registrations fail. */
  readonly name: string;
  /** Services this plugin needs; missing required services block readiness. */
  readonly inject?: readonly KernelServiceName[];
  /** Services this plugin provides via provide(). */
  readonly provides?: readonly KernelServiceName[];
  apply(ctx: KernelContext, config: Config): void | Promise<void>;
}

export function defineKernelPlugin<Config = void>(
  plugin: KernelPlugin<Config>,
): KernelPlugin<Config> {
  return plugin;
}

/** Provide a service from inside a plugin's apply(). */
export function provide<K extends KernelServiceName>(
  ctx: KernelContext,
  name: K,
  value: KernelServices[K],
): void {
  (
    ctx as unknown as { provide(name: string, value: unknown): unknown }
  ).provide(name, value);
}

export interface KernelPluginHandle {
  readonly name: string;
  dispose(): Promise<void>;
}

export class KernelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KernelError";
  }
}

/* ---- structural view of the cordis runtime (internal only) ---- */

interface CordisFiber {
  dispose(): Promise<void>;
}

interface CordisContext {
  fiber: CordisFiber;
  provide(name: string, value?: unknown): unknown;
  plugin(
    plugin: {
      name: string;
      inject: string[];
      provide: string[];
      apply(ctx: unknown, config: unknown): unknown;
    },
    ...args: unknown[]
  ): CordisFiber & PromiseLike<unknown>;
}

const { Context } = (await import("cordis")) as unknown as {
  Context: new () => CordisContext;
};

/* --------------------------------------------------------------- */

export class Kernel {
  readonly #root: CordisContext;
  readonly #loaded = new Map<string, KernelPluginHandle>();
  #stopped = false;

  constructor() {
    this.#root = new Context();
  }

  /** Load a plugin and wait until it is active. Fails fast on error. */
  async use<Config>(
    plugin: KernelPlugin<Config>,
    ...args: Config extends void ? [] : [config: Config]
  ): Promise<KernelPluginHandle> {
    if (this.#stopped) {
      throw new KernelError(`Kernel is stopped; cannot load ${plugin.name}`);
    }
    if (this.#loaded.has(plugin.name)) {
      throw new KernelError(`Plugin already loaded: ${plugin.name}`);
    }
    const fiber = this.#root.plugin(
      {
        name: plugin.name,
        inject: [...(plugin.inject ?? [])],
        provide: [...(plugin.provides ?? [])],
        apply: (ctx: unknown, config: unknown) =>
          plugin.apply(ctx as KernelContext, config as Config),
      },
      ...(args as unknown[]),
    );
    try {
      await fiber;
    } catch (error) {
      await fiber.dispose().catch(() => undefined);
      throw new KernelError(
        `Plugin ${plugin.name} failed to start: ${String(
          error instanceof Error ? error.message : error,
        )}`,
      );
    }
    const handle: KernelPluginHandle = {
      name: plugin.name,
      dispose: async () => {
        this.#loaded.delete(plugin.name);
        await fiber.dispose();
      },
    };
    this.#loaded.set(plugin.name, handle);
    return handle;
  }

  /** Read a provided service (throws if absent). */
  get<K extends KernelServiceName>(name: K): KernelServices[K] {
    const value = (this.#root as unknown as Record<string, unknown>)[name];
    if (value === undefined || value === null) {
      throw new KernelError(`Service not available: ${name}`);
    }
    return value as KernelServices[K];
  }

  /** Names of currently loaded plugins, in load order. */
  get plugins(): string[] {
    return [...this.#loaded.keys()];
  }

  /**
   * Dispose all plugins in reverse load order, awaiting each disposer.
   * Idempotent; aggregates failures instead of stopping halfway.
   */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const failures: unknown[] = [];
    for (const handle of [...this.#loaded.values()].reverse()) {
      try {
        await handle.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    this.#loaded.clear();
    try {
      await this.#root.fiber.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new KernelError(
        `Kernel stop completed with ${String(failures.length)} failure(s): ${failures
          .map((failure) =>
            failure instanceof Error ? failure.message : String(failure),
          )
          .join("; ")}`,
      );
    }
  }
}

export function createKernel(): Kernel {
  return new Kernel();
}
