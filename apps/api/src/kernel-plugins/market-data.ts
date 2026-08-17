import {
  MarketDataWaterfall,
  type MarketDataExecutor,
  type MarketDataProviderDescriptor,
} from "@private-fund/market-data";
import { defineKernelPlugin, provide } from "@private-fund/kernel";

declare module "@private-fund/kernel" {
  interface KernelServices {
    marketData: MarketDataExecutor;
  }
}

export interface MarketDataPluginConfig {
  providers: readonly MarketDataProviderDescriptor[];
  /** Provider IDs in exact fallback order. */
  waterfall: readonly string[];
  totalTimeoutMs?: number;
  providerTimeoutMs?: number;
}

/**
 * Seam pilot #2: market data waterfall as a kernel capability
 * (`ctx.marketData`). Started before ready; dispose drains and awaits
 * provider teardown.
 */
export const marketDataPlugin = defineKernelPlugin<MarketDataPluginConfig>({
  name: "market-data",
  provides: ["marketData"],
  async apply(ctx, config) {
    const runtime = new MarketDataWaterfall({
      providers: config.providers,
      waterfall: config.waterfall,
      ...(config.totalTimeoutMs === undefined
        ? {}
        : { totalTimeoutMs: config.totalTimeoutMs }),
      ...(config.providerTimeoutMs === undefined
        ? {}
        : { providerTimeoutMs: config.providerTimeoutMs }),
    });
    ctx.effect(() => () => runtime.dispose(), "market-data:dispose");
    await runtime.start();
    provide(ctx, "marketData", runtime);
  },
});
