import type { ModelGatewayAccess } from "@private-fund/contracts";
import type { CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";

type CredentialStore = NonNullable<CreateModelRuntimeOptions["credentials"]>;
type Credential = Exclude<
  Awaited<ReturnType<CredentialStore["read"]>>,
  undefined
>;

function sameBinding(
  left: ModelGatewayAccess["binding"],
  right: ModelGatewayAccess["binding"],
): boolean {
  return (
    left.userId === right.userId &&
    left.dataNamespace === right.dataNamespace &&
    left.projectId === right.projectId &&
    left.sessionId === right.sessionId
  );
}

function sameConfiguration(
  left: ModelGatewayAccess,
  right: ModelGatewayAccess,
): boolean {
  return (
    left.providerId === right.providerId &&
    left.gatewayBaseUrl === right.gatewayBaseUrl &&
    left.model.id === right.model.id &&
    left.model.contextWindow === right.model.contextWindow &&
    left.model.maxTokens === right.model.maxTokens &&
    sameBinding(left.binding, right.binding)
  );
}

/**
 * Session-local, memory-only credential storage for cloud model grants.
 * Missing or expired credentials reject instead of falling back to ambient
 * environment variables or auth.json.
 */
export class ModelGatewayCredentialStore implements CredentialStore {
  readonly #providerId: string;
  #access: ModelGatewayAccess | null;

  public constructor(access: ModelGatewayAccess) {
    this.#providerId = access.providerId;
    this.#access = access;
    this.#requireUsable();
  }

  public update(access: ModelGatewayAccess): void {
    const current = this.#access;
    if (current === null || !sameConfiguration(current, access)) {
      throw new Error("Model gateway credential binding mismatch");
    }
    if (access.generation < current.generation) {
      throw new Error("Stale model gateway credential update");
    }
    if (access.generation === current.generation) {
      if (
        access.leaseId === current.leaseId &&
        access.accessToken === current.accessToken &&
        access.expiresAt === current.expiresAt
      ) {
        return;
      }
      throw new Error("Conflicting model gateway credential generation");
    }
    this.#access = access;
    this.#requireUsable();
  }

  public clear(): void {
    this.#access = null;
  }

  public async read(providerId: string): Promise<Credential | undefined> {
    if (providerId !== this.#providerId) {
      return undefined;
    }
    const access = this.#requireUsable();
    return { type: "api_key", key: access.accessToken };
  }

  public async list(): Promise<
    Awaited<ReturnType<CredentialStore["list"]>>
  > {
    return this.#access === null
      ? []
      : [{ providerId: this.#providerId, type: "api_key" }];
  }

  public async modify(
    providerId: string,
    fn: Parameters<CredentialStore["modify"]>[1],
  ): Promise<Credential | undefined> {
    if (providerId !== this.#providerId) {
      return undefined;
    }
    const access = this.#requireUsable();
    const next = await fn({ type: "api_key", key: access.accessToken });
    if (next === undefined) {
      return { type: "api_key", key: access.accessToken };
    }
    if (next.type !== "api_key" || !next.key) {
      throw new Error("Model gateway credential type is not supported");
    }
    throw new Error("Model gateway credentials are updated by the API lease issuer");
  }

  public async delete(providerId: string): Promise<void> {
    if (providerId === this.#providerId) {
      this.clear();
    }
  }

  #requireUsable(): ModelGatewayAccess {
    const access = this.#access;
    if (access === null) {
      throw new Error("Model gateway credential is unavailable");
    }
    if (Date.parse(access.expiresAt) <= Date.now()) {
      this.#access = null;
      throw new Error("Model gateway credential has expired");
    }
    return access;
  }
}
