import type { TenantIdentity } from "@private-fund/contracts";
import {
  CloudAccountError,
  CloudAuthService,
  SessionCipher,
  type SealedCloudSession,
} from "@private-fund/auth";
import { DomainError } from "@private-fund/core";

import type { RequestIdentityProvider } from "./dependencies.js";

export class DevelopmentIdentityProvider implements RequestIdentityProvider {
  public constructor(private readonly identity: TenantIdentity) {}

  public async authenticate(): Promise<{ identity: TenantIdentity }> {
    return { identity: this.identity };
  }
}

export class CloudIdentityProvider implements RequestIdentityProvider {
  public constructor(
    private readonly cipher: SessionCipher,
    private readonly service: CloudAuthService,
  ) {}

  public async authenticate(
    cookieValue: string | undefined,
  ): Promise<{ identity: TenantIdentity; replacementCookie?: string }> {
    if (!cookieValue) {
      throw new DomainError(
        "Authentication required",
        "not_authenticated",
        401,
      );
    }
    const session = this.cipher.open(cookieValue);
    if (!session) {
      throw new DomainError("Invalid session", "not_authenticated", 401);
    }
    let fresh: { session: SealedCloudSession; refreshed: boolean };
    try {
      fresh = await this.service.ensureFresh(session);
    } catch (error) {
      if (
        error instanceof CloudAccountError &&
        error.code === "cloud_service_unavailable"
      ) {
        throw error;
      }
      throw new DomainError("Session expired", "not_authenticated", 401);
    }
    return {
      identity: {
        userId: fresh.session.user.id,
        dataNamespace: fresh.session.user.data_namespace,
      },
      ...(fresh.refreshed
        ? { replacementCookie: this.cipher.seal(fresh.session) }
        : {}),
    };
  }
}
