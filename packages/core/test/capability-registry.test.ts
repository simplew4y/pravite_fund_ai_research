import { describe, expect, it, vi } from "vitest";

import {
  CapabilityAdmissionError,
  CapabilityDefinitionError,
  CapabilityRegistry,
  CapabilityTimeoutError,
  createCapabilityKey,
  defineCapabilityProvider,
} from "../src/capability-registry.js";

describe("CapabilityRegistry", () => {
  it("starts providers topologically and exposes typed required and optional handles", async () => {
    const events: string[] = [];
    const configuration = createCapabilityKey<{ readonly prefix: string }>(
      "configuration",
    );
    const optionalCache = createCapabilityKey<{ get(): string }>("cache");
    const greeting = createCapabilityKey<{ greet(name: string): string }>(
      "greeting",
    );
    const registry = new CapabilityRegistry();

    registry.register(
      defineCapabilityProvider({
        id: "greeting-provider",
        capability: greeting,
        required: { configuration },
        optional: { cache: optionalCache },
        start: async ({ required, optional }) => {
          events.push("greeting:start");
          const prefix = await required.configuration.use(
            (value) => value.prefix,
          );
          expect(optional.cache.isAvailable()).toBe(false);
          expect(await optional.cache.lease()).toBeUndefined();
          return {
            value: {
              greet: (name: string): string => `${prefix}, ${name}`,
            },
            dispose: () => {
              events.push("greeting:dispose");
            },
          };
        },
      }),
    );
    registry.register(
      defineCapabilityProvider({
        id: "configuration-provider",
        capability: configuration,
        start: () => {
          events.push("configuration:start");
          return {
            value: { prefix: "hello" },
            dispose: () => {
              events.push("configuration:dispose");
            },
          };
        },
      }),
    );

    await registry.start();
    expect(events).toEqual(["configuration:start", "greeting:start"]);
    await expect(
      registry.use(greeting, ({ greet }) => greet("Ada")),
    ).resolves.toBe("hello, Ada");

    await registry.dispose();
    expect(events).toEqual([
      "configuration:start",
      "greeting:start",
      "greeting:dispose",
      "configuration:dispose",
    ]);
  });

  it("supports multiple providers only for an explicitly multi capability", async () => {
    const hooks = createCapabilityKey<() => string>("hooks", { multi: true });
    const registry = new CapabilityRegistry();
    registry.register(
      defineCapabilityProvider({
        id: "hook-a",
        capability: hooks,
        start: () => ({ value: () => "a" }),
      }),
    );
    registry.register(
      defineCapabilityProvider({
        id: "hook-b",
        capability: hooks,
        start: () => ({ value: () => "b" }),
      }),
    );
    await registry.start();
    await expect(
      registry.use(hooks, (providers) => providers.map((hook) => hook())),
    ).resolves.toEqual(["a", "b"]);
    await registry.dispose();

    const single = createCapabilityKey<string>("single");
    const invalid = new CapabilityRegistry();
    invalid.register(
      defineCapabilityProvider({
        id: "first",
        capability: single,
        start: () => ({ value: "first" }),
      }),
    );
    invalid.register(
      defineCapabilityProvider({
        id: "second",
        capability: single,
        start: () => ({ value: "second" }),
      }),
    );
    await expect(invalid.start()).rejects.toThrow(/Single capability single/);
  });

  it("rejects missing dependencies, duplicate IDs, and cycles before starting anything", async () => {
    const missing = createCapabilityKey<string>("missing");
    const first = createCapabilityKey<string>("first");
    const second = createCapabilityKey<string>("second");

    const missingStart = vi.fn(() => ({ value: "never" }));
    const missingRegistry = new CapabilityRegistry();
    missingRegistry.register(
      defineCapabilityProvider({
        id: "needs-missing",
        capability: first,
        required: { missing },
        start: missingStart,
      }),
    );
    await expect(missingRegistry.start()).rejects.toThrow(
      /missing required dependency missing/,
    );
    expect(missingStart).not.toHaveBeenCalled();

    const duplicateStart = vi.fn(() => ({ value: "never" }));
    const duplicateRegistry = new CapabilityRegistry();
    duplicateRegistry.register(
      defineCapabilityProvider({
        id: "duplicate",
        capability: first,
        start: duplicateStart,
      }),
    );
    duplicateRegistry.register(
      defineCapabilityProvider({
        id: "duplicate",
        capability: second,
        start: duplicateStart,
      }),
    );
    await expect(duplicateRegistry.start()).rejects.toThrow(
      /Provider ID duplicate is registered more than once/,
    );
    expect(duplicateStart).not.toHaveBeenCalled();

    const cycleStart = vi.fn(() => ({ value: "never" }));
    const cycleRegistry = new CapabilityRegistry();
    cycleRegistry.register(
      defineCapabilityProvider({
        id: "first-provider",
        capability: first,
        required: { second },
        start: cycleStart,
      }),
    );
    cycleRegistry.register(
      defineCapabilityProvider({
        id: "second-provider",
        capability: second,
        required: { first },
        start: cycleStart,
      }),
    );
    await expect(cycleRegistry.start()).rejects.toThrow(
      /first-provider -> second-provider -> first-provider/,
    );
    expect(cycleStart).not.toHaveBeenCalled();
  });

  it("rolls a failed start back in reverse order and aggregates cleanup errors", async () => {
    const events: string[] = [];
    const root = createCapabilityKey<string>("root");
    const leaf = createCapabilityKey<string>("leaf");
    const failing = createCapabilityKey<string>("failing");
    const registry = new CapabilityRegistry();
    registry.register(
      defineCapabilityProvider({
        id: "root-provider",
        capability: root,
        start: () => ({
          value: "root",
          dispose: () => {
            events.push("root:dispose");
          },
        }),
      }),
    );
    registry.register(
      defineCapabilityProvider({
        id: "leaf-provider",
        capability: leaf,
        required: { root },
        start: () => ({
          value: "leaf",
          dispose: () => {
            events.push("leaf:dispose");
            throw new Error("leaf cleanup failed");
          },
        }),
      }),
    );
    registry.register(
      defineCapabilityProvider({
        id: "failing-provider",
        capability: failing,
        required: { leaf },
        start: () => {
          throw new Error("start failed");
        },
      }),
    );

    const failure = await registry.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "start failed" }),
      expect.objectContaining({ message: "leaf cleanup failed" }),
    ]);
    expect(events).toEqual(["leaf:dispose", "root:dispose"]);
    expect(registry.status).toBe("failed");
  });

  it("bounds concurrent leases and its admission queue", async () => {
    const service = createCapabilityKey<string>("bounded-service");
    const registry = new CapabilityRegistry();
    registry.register(
      defineCapabilityProvider({
        id: "bounded-provider",
        capability: service,
        admission: { maxConcurrent: 1, maxQueue: 1 },
        start: () => ({ value: "service" }),
      }),
    );
    await registry.start();

    const first = await registry.lease(service);
    const queued = registry.lease(service);
    await expect(registry.lease(service)).rejects.toBeInstanceOf(
      CapabilityAdmissionError,
    );
    first.release();
    const second = await queued;
    expect(second.value).toBe("service");
    second.release();
    await registry.dispose();
  });

  it("stops admission immediately and drains leases before disposal", async () => {
    const service = createCapabilityKey<string>("drained-service");
    const dispose = vi.fn();
    const registry = new CapabilityRegistry({ drainTimeoutMs: 500 });
    registry.register(
      defineCapabilityProvider({
        id: "drained-provider",
        capability: service,
        start: () => ({ value: "service", dispose }),
      }),
    );
    await registry.start();
    const lease = await registry.lease(service);

    const stopping = registry.dispose();
    await expect(registry.lease(service)).rejects.toThrow(/not accepting leases/);
    await Promise.resolve();
    expect(dispose).not.toHaveBeenCalled();
    lease.release();
    await stopping;
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("starts and health-checks a replacement before atomic swap, then drains the old provider", async () => {
    const service = createCapabilityKey<{ readonly version: number }>("service");
    const events: string[] = [];
    const registry = new CapabilityRegistry({ drainTimeoutMs: 500 });
    registry.register(
      defineCapabilityProvider({
        id: "service-provider",
        capability: service,
        start: () => ({
          value: { version: 1 },
          dispose: () => {
            events.push("v1:dispose");
          },
        }),
      }),
    );
    await registry.start();
    const oldLease = await registry.lease(service);

    const replacing = registry.replaceProvider(
      "service-provider",
      defineCapabilityProvider({
        id: "service-provider",
        capability: service,
        start: () => {
          events.push("v2:start");
          return {
            value: { version: 2 },
            healthCheck: () => {
              events.push("v2:healthy");
              return true;
            },
            dispose: () => {
              events.push("v2:dispose");
            },
          };
        },
      }),
    );
    await vi.waitFor(() => {
      expect(events).toContain("v2:healthy");
    });
    await expect(registry.use(service, ({ version }) => version)).resolves.toBe(
      2,
    );
    expect(events).not.toContain("v1:dispose");
    oldLease.release();
    await replacing;
    expect(events).toEqual(["v2:start", "v2:healthy", "v1:dispose"]);

    await registry.dispose();
    expect(events).toContain("v2:dispose");
  });

  it("keeps the old provider active when replacement health fails", async () => {
    const service = createCapabilityKey<number>("health-service");
    const candidateDispose = vi.fn();
    const registry = new CapabilityRegistry();
    registry.register(
      defineCapabilityProvider({
        id: "health-provider",
        capability: service,
        start: () => ({ value: 1 }),
      }),
    );
    await registry.start();

    await expect(
      registry.replaceProvider(
        "health-provider",
        defineCapabilityProvider({
          id: "health-provider-v2",
          capability: service,
          start: () => ({
            value: 2,
            healthCheck: () => false,
            dispose: candidateDispose,
          }),
        }),
      ),
    ).rejects.toThrow(/reported unhealthy/);
    expect(candidateDispose).toHaveBeenCalledOnce();
    await expect(registry.use(service, (value) => value)).resolves.toBe(1);
    await registry.dispose();
  });

  it("times out and aggregates disposers while invoking each disposer only once", async () => {
    const first = createCapabilityKey<string>("first-disposer");
    const second = createCapabilityKey<string>("second-disposer");
    const firstDispose = vi.fn(() => {
      throw new Error("first disposer failed");
    });
    const secondDispose = vi.fn(() => new Promise<void>(() => undefined));
    const registry = new CapabilityRegistry({ disposeTimeoutMs: 10 });
    registry.register(
      defineCapabilityProvider({
        id: "first-disposer-provider",
        capability: first,
        start: () => ({ value: "first", dispose: firstDispose }),
      }),
    );
    registry.register(
      defineCapabilityProvider({
        id: "second-disposer-provider",
        capability: second,
        start: () => ({ value: "second", dispose: secondDispose }),
      }),
    );
    await registry.start();

    const failure = await registry.dispose().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors;
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "first disposer failed" }),
        expect.any(CapabilityTimeoutError),
      ]),
    );
    await expect(registry.dispose()).rejects.toBe(failure);
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).toHaveBeenCalledOnce();
  });

  it("validates definition errors without invoking provider start", async () => {
    const service = createCapabilityKey<string>("validated-service");
    const start = vi.fn(() => ({ value: "service" }));
    const registry = new CapabilityRegistry();
    registry.register(
      defineCapabilityProvider({
        id: "invalid-admission",
        capability: service,
        admission: { maxConcurrent: 0 },
        start,
      }),
    );
    await expect(registry.start()).rejects.toBeInstanceOf(
      CapabilityDefinitionError,
    );
    expect(start).not.toHaveBeenCalled();
  });
});
