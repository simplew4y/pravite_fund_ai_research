import { describe, expect, it } from "vitest";

import {
  createKernel,
  defineKernelPlugin,
  provide,
  KernelError,
} from "./index.js";

declare module "./index.js" {
  interface KernelServices {
    greeter: { greet(name: string): string };
    counter: { value(): number };
  }
}

const greeterPlugin = defineKernelPlugin({
  name: "greeter",
  provides: ["greeter"],
  apply(ctx) {
    provide(ctx, "greeter", { greet: (name) => `hi ${name}` });
  },
});

describe("Kernel", () => {
  it("provides and resolves services", async () => {
    const kernel = createKernel();
    await kernel.use(greeterPlugin);
    expect(kernel.get("greeter").greet("pi")).toBe("hi pi");
    await kernel.stop();
  });

  it("injects dependencies into downstream plugins", async () => {
    const kernel = createKernel();
    await kernel.use(greeterPlugin);
    let seen = "";
    await kernel.use(
      defineKernelPlugin({
        name: "consumer",
        inject: ["greeter"],
        apply(ctx) {
          seen = ctx.greeter.greet("kernel");
        },
      }),
    );
    expect(seen).toBe("hi kernel");
    await kernel.stop();
  });

  it("rejects duplicate plugin names", async () => {
    const kernel = createKernel();
    await kernel.use(greeterPlugin);
    await expect(kernel.use(greeterPlugin)).rejects.toThrow(KernelError);
    await kernel.stop();
  });

  it("fails fast when a plugin throws during apply", async () => {
    const kernel = createKernel();
    await expect(
      kernel.use(
        defineKernelPlugin({
          name: "broken",
          apply() {
            throw new Error("boom");
          },
        }),
      ),
    ).rejects.toThrow(/broken failed to start/);
    await kernel.stop();
  });

  it("runs effect disposers in reverse order and awaits them", async () => {
    const kernel = createKernel();
    const order: string[] = [];
    await kernel.use(
      defineKernelPlugin({
        name: "a",
        apply(ctx) {
          ctx.effect(() => () => {
            order.push("dispose-a");
          });
        },
      }),
    );
    await kernel.use(
      defineKernelPlugin({
        name: "b",
        apply(ctx) {
          ctx.effect(() => async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            order.push("dispose-b");
          });
        },
      }),
    );
    await kernel.stop();
    expect(order).toEqual(["dispose-b", "dispose-a"]);
  });

  it("stop is idempotent and blocks further loads", async () => {
    const kernel = createKernel();
    await kernel.use(greeterPlugin);
    await kernel.stop();
    await kernel.stop();
    await expect(
      kernel.use(defineKernelPlugin({ name: "late", apply() {} })),
    ).rejects.toThrow(/stopped/);
  });

  it("config is passed through to apply", async () => {
    const kernel = createKernel();
    let start = 0;
    await kernel.use(
      defineKernelPlugin<{ start: number }>({
        name: "counter",
        provides: ["counter"],
        apply(ctx, config) {
          start = config.start;
          provide(ctx, "counter", { value: () => config.start });
        },
      }),
      { start: 7 },
    );
    expect(start).toBe(7);
    expect(kernel.get("counter").value()).toBe(7);
    await kernel.stop();
  });
});
