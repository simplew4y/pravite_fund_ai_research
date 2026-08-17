import { defineKernelPlugin, provide } from "@private-fund/kernel";
import {
  ModelGateway,
  type ModelGatewayOptions,
  type ModelProvider,
  type ModelRequestJournal,
} from "@private-fund/model-runtime";

export interface ModelGatewayCapability {
  /** Commit-before-send gateway bound to one tenant's journal. */
  forTenant(tenantNamespace: string): ModelGateway;
}

declare module "@private-fund/kernel" {
  interface KernelServices {
    modelGateway: ModelGatewayCapability;
  }
}

export interface ModelGatewayPluginConfig {
  provider: ModelProvider;
  /** Journal factory, e.g. RepositoryModelRequestJournal per tenant. */
  createJournal(tenantNamespace: string): ModelRequestJournal;
  gatewayOptions?: ModelGatewayOptions;
}

/**
 * ctx.modelGateway — the ONLY sanctioned model send path. ModelGateway
 * persists the final ModelRequestSnapshot through the tenant journal before
 * any network send and fails closed when the journal commit fails.
 *
 * Not loaded in the default api profile yet: the Pi worker still owns its
 * provider connection. The capability cuts over when the agent loop migrates.
 */
export const modelGatewayPlugin = defineKernelPlugin<ModelGatewayPluginConfig>({
  name: "model-gateway",
  provides: ["modelGateway"],
  apply(ctx, config) {
    const gateways = new Map<string, ModelGateway>();

    const capability: ModelGatewayCapability = {
      forTenant(tenantNamespace) {
        let gateway = gateways.get(tenantNamespace);
        if (gateway === undefined) {
          gateway = new ModelGateway(
            config.provider,
            config.createJournal(tenantNamespace),
            config.gatewayOptions ?? {},
          );
          gateways.set(tenantNamespace, gateway);
        }
        return gateway;
      },
    };

    ctx.effect(
      () => async () => {
        const pending = [...gateways.values()].map((gateway) =>
          gateway.dispose(),
        );
        gateways.clear();
        await Promise.all(pending);
      },
      "model-gateway:dispose",
    );
    provide(ctx, "modelGateway", capability);
  },
});
