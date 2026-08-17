import {
  CloudAccountClient,
  CloudAuthService,
  SessionCipher,
  type CloudUser,
  type ShadowAccountStore,
} from "@private-fund/auth";
import { defineKernelPlugin, provide } from "@private-fund/kernel";

import type { ApiConfig } from "../config.js";
import type { ApiDependencies } from "../dependencies.js";
import {
  CloudIdentityProvider,
  DevelopmentIdentityProvider,
} from "../identity.js";
import { CloudModelGatewayAccessIssuer } from "../model-gateway-access.js";

export interface IdentityService {
  readonly identityProvider: ApiDependencies["identityProvider"];
  readonly cloudAccounts: ApiDependencies["cloudAccounts"];
  readonly modelGatewayAccessIssuer: ApiDependencies["modelGatewayAccessIssuer"];
}

declare module "@private-fund/kernel" {
  interface KernelServices {
    identity: IdentityService;
  }
}

/** Auth: development identity or cloud accounts + model gateway access. */
export const identityPlugin = defineKernelPlugin<{ config: ApiConfig }>({
  name: "identity",
  inject: ["controlDb"],
  provides: ["identity"],
  apply(ctx, { config }) {
    const { repositories } = ctx.controlDb;
    if (config.auth.mode === "development") {
      repositories.users.upsertCloudShadow({
        userId: config.auth.userId,
        dataNamespace: config.auth.dataNamespace,
      });
      provide(ctx, "identity", {
        identityProvider: new DevelopmentIdentityProvider({
          userId: config.auth.userId,
          dataNamespace: config.auth.dataNamespace,
        }),
        cloudAccounts: undefined,
        modelGatewayAccessIssuer: undefined,
      });
      return;
    }
    const shadowStore: ShadowAccountStore = {
      async upsertCloudUser(user: CloudUser): Promise<void> {
        repositories.users.upsertCloudShadow({
          userId: user.id,
          dataNamespace: user.data_namespace,
          email: user.email,
        });
      },
    };
    const client = new CloudAccountClient({
      baseUrl: config.auth.backendUrl,
      timeoutMilliseconds: config.auth.timeoutMilliseconds,
    });
    const service = new CloudAuthService({ client, shadowStore });
    const cipher = new SessionCipher(config.auth.cookieSecret);
    provide(ctx, "identity", {
      identityProvider: new CloudIdentityProvider(cipher, service),
      cloudAccounts: { client, service, cipher },
      modelGatewayAccessIssuer:
        config.modelGateway === undefined
          ? undefined
          : new CloudModelGatewayAccessIssuer({
              client,
              config: config.modelGateway,
            }),
    });
  },
});
