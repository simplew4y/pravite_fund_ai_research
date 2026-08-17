import type {
  CloudAccountClient,
  CloudModelCatalog,
  CloudModelCatalogItem,
} from "@private-fund/auth";
import type {
  ModelGatewayAccess,
  TenantIdentity,
} from "@private-fund/contracts";
import { DomainError, newId } from "@private-fund/core";

import type { ApiConfig } from "./config.js";

export interface ModelGatewayAccessBinding {
  readonly userId: string;
  readonly dataNamespace: string;
  readonly projectId: string;
  readonly sessionId: string;
}

export interface ModelGatewayAccessIssuer {
  issue(
    cloudAccessToken: string,
    binding: ModelGatewayAccessBinding,
  ): Promise<ModelGatewayAccess>;
  clearForTenant(identity: TenantIdentity): void;
}

interface CachedAccess {
  readonly access: ModelGatewayAccess;
  readonly bindingKey: string;
}

export interface CloudModelGatewayAccessIssuerOptions {
  readonly client: CloudAccountClient;
  readonly config: NonNullable<ApiConfig["modelGateway"]>;
  readonly now?: () => number;
  readonly leaseIdFactory?: () => string;
}

function normalizedUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function bindingKey(binding: ModelGatewayAccessBinding): string {
  return [
    binding.userId,
    binding.dataNamespace,
    binding.projectId,
    binding.sessionId,
  ].join("\u0000");
}

function boundedMaxTokens(
  configured: number,
  model: CloudModelCatalogItem,
): number {
  const advertised = model.default_max_tokens ?? model.max_output_tokens;
  return advertised === undefined
    ? configured
    : Math.min(configured, advertised);
}

function selectCatalogModel(
  catalog: CloudModelCatalog,
  configuredModelId: string | undefined,
): CloudModelCatalogItem {
  const uniqueIds = new Set(catalog.data.map((candidate) => candidate.id));
  if (uniqueIds.size !== catalog.data.length) {
    throw new DomainError(
      "Cloud account service returned an invalid model catalog",
      "invalid_model_gateway_response",
      502,
    );
  }

  const modelId = configuredModelId ?? catalog.default_model;
  const model = catalog.data.find((candidate) => candidate.id === modelId);
  if (model !== undefined) {
    return model;
  }
  if (configuredModelId === undefined) {
    throw new DomainError(
      "Cloud account service returned an invalid default model",
      "invalid_model_gateway_response",
      502,
    );
  }
  throw new DomainError(
    `Cloud model is not available: ${configuredModelId}`,
    "model_not_available",
    403,
  );
}

export class CloudModelGatewayAccessIssuer
  implements ModelGatewayAccessIssuer
{
  readonly #client: CloudAccountClient;
  readonly #config: NonNullable<ApiConfig["modelGateway"]>;
  readonly #now: () => number;
  readonly #leaseIdFactory: () => string;
  readonly #cache = new Map<string, CachedAccess>();
  readonly #inFlight = new Map<
    string,
    { readonly bindingKey: string; readonly promise: Promise<ModelGatewayAccess> }
  >();

  public constructor(options: CloudModelGatewayAccessIssuerOptions) {
    this.#client = options.client;
    this.#config = options.config;
    this.#now = options.now ?? Date.now;
    this.#leaseIdFactory =
      options.leaseIdFactory ?? (() => newId("model_lease"));
  }

  public async issue(
    cloudAccessToken: string,
    binding: ModelGatewayAccessBinding,
  ): Promise<ModelGatewayAccess> {
    const key = bindingKey(binding);
    const cached = this.#cache.get(binding.sessionId);
    if (
      cached !== undefined &&
      cached.bindingKey === key &&
      Date.parse(cached.access.expiresAt) > this.#now() + 5 * 60_000
    ) {
      return Promise.resolve(cached.access);
    }
    if (cached !== undefined && cached.bindingKey !== key) {
      throw new DomainError(
        "Model gateway session binding conflict",
        "model_gateway_binding_conflict",
        409,
      );
    }
    const existing = this.#inFlight.get(binding.sessionId);
    if (existing !== undefined) {
      if (existing.bindingKey !== key) {
        throw new DomainError(
          "Model gateway session binding conflict",
          "model_gateway_binding_conflict",
          409,
        );
      }
      return existing.promise;
    }
    const pending = this.#issueFresh(cloudAccessToken, binding, cached)
      .then((access) => {
        this.#cache.set(binding.sessionId, { access, bindingKey: key });
        return access;
      })
      .finally(() => {
        if (this.#inFlight.get(binding.sessionId)?.promise === pending) {
          this.#inFlight.delete(binding.sessionId);
        }
      });
    this.#inFlight.set(binding.sessionId, {
      bindingKey: key,
      promise: pending,
    });
    return pending;
  }

  public clearForTenant(identity: TenantIdentity): void {
    for (const [sessionId, cached] of this.#cache) {
      if (
        cached.access.binding.userId === identity.userId &&
        cached.access.binding.dataNamespace === identity.dataNamespace
      ) {
        this.#cache.delete(sessionId);
      }
    }
  }

  async #issueFresh(
    cloudAccessToken: string,
    binding: ModelGatewayAccessBinding,
    previous: CachedAccess | undefined,
  ): Promise<ModelGatewayAccess> {
    const catalog = await this.#client.models(cloudAccessToken);
    if (!catalog.available) {
      throw new DomainError(
        "No cloud model is available for this account",
        "model_access_unavailable",
        403,
      );
    }
    const model = selectCatalogModel(catalog, this.#config.modelId);
    const token = await this.#client.issueModelAccessToken(cloudAccessToken);
    if (normalizedUrl(token.gateway_base_url) !== this.#config.baseUrl) {
      throw new DomainError(
        "Cloud account service returned an unexpected model gateway URL",
        "invalid_model_gateway_response",
        502,
      );
    }
    const generation =
      previous === undefined ? 1 : previous.access.generation + 1;
    return {
      leaseId: this.#leaseIdFactory(),
      generation,
      providerId: this.#config.providerId,
      accessToken: token.access_token,
      expiresAt: new Date(
        this.#now() + token.expires_in * 1_000,
      ).toISOString(),
      gatewayBaseUrl: this.#config.baseUrl,
      model: {
        id: model.id,
        name: model.display_name ?? model.id,
        contextWindow: this.#config.contextWindow,
        maxTokens: boundedMaxTokens(this.#config.maxTokens, model),
      },
      binding,
    };
  }
}
