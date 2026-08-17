import { createHash } from "node:crypto";

import type { Clock } from "@private-fund/core";
import { systemClock } from "@private-fund/core";

import { CloudAccountError, type CloudAccountClient } from "./cloud-client.js";
import type {
  CloudTokenResponse,
  CloudUser,
  SealedCloudSession,
  ShadowAccountStore,
} from "./types.js";

export interface CloudAuthServiceOptions {
  client: CloudAccountClient;
  shadowStore: ShadowAccountStore;
  sessionTtlSeconds?: number;
  refreshSkewSeconds?: number;
  refreshReplayTtlMilliseconds?: number;
  clock?: Clock;
}

export class CloudAuthService {
  readonly #client: CloudAccountClient;
  readonly #shadowStore: ShadowAccountStore;
  readonly #sessionTtlSeconds: number;
  readonly #refreshSkewSeconds: number;
  readonly #refreshReplayTtlMilliseconds: number;
  readonly #clock: Clock;
  readonly #refreshInFlight = new Map<string, Promise<SealedCloudSession>>();
  readonly #refreshReplay = new Map<
    string,
    { readonly expiresAt: number; readonly session: SealedCloudSession }
  >();

  public constructor(options: CloudAuthServiceOptions) {
    this.#client = options.client;
    this.#shadowStore = options.shadowStore;
    this.#sessionTtlSeconds = options.sessionTtlSeconds ?? 7 * 24 * 60 * 60;
    this.#refreshSkewSeconds = options.refreshSkewSeconds ?? 30;
    this.#refreshReplayTtlMilliseconds =
      options.refreshReplayTtlMilliseconds ?? 15_000;
    this.#clock = options.clock ?? systemClock;
  }

  public async login(
    email: string,
    password: string,
  ): Promise<SealedCloudSession> {
    return this.#persist(await this.#client.login(email, password));
  }

  public async register(input: {
    email: string;
    code: string;
    password: string;
    nickName?: string;
  }): Promise<SealedCloudSession> {
    return this.#persist(await this.#client.register(input));
  }

  public sendRegistrationCode(email: string): Promise<{
    status: number;
    payload: Record<string, unknown>;
  }> {
    return this.#client.sendRegistrationCode(email);
  }

  public async ensureFresh(
    session: SealedCloudSession,
  ): Promise<{ session: SealedCloudSession; refreshed: boolean }> {
    const now = Math.floor(this.#clock().getTime() / 1000);
    if (session.sessionExpiresAt <= now) {
      throw new Error("Session expired");
    }
    if (session.accessExpiresAt > now + this.#refreshSkewSeconds) {
      return { session, refreshed: false };
    }
    return {
      session: await this.refresh(session),
      refreshed: true,
    };
  }

  /**
   * Force a refresh while deduplicating rotating refresh tokens.
   *
   * A short replay window is required because multiple HTTP requests can
   * arrive with the same stale encrypted cookie before the browser receives
   * the first replacement cookie.
   */
  public async refresh(
    session: SealedCloudSession,
  ): Promise<SealedCloudSession> {
    const nowSeconds = Math.floor(this.#clock().getTime() / 1000);
    if (session.sessionExpiresAt <= nowSeconds) {
      throw new Error("Session expired");
    }

    const nowMilliseconds = this.#clock().getTime();
    for (const [key, replay] of this.#refreshReplay) {
      if (replay.expiresAt <= nowMilliseconds) {
        this.#refreshReplay.delete(key);
      }
    }
    const key = createHash("sha256")
      .update(session.refreshToken, "utf8")
      .digest("hex");
    const replay = this.#refreshReplay.get(key);
    if (replay !== undefined) {
      this.#assertSameIdentity(session, replay.session.user);
      return replay.session;
    }
    const existing = this.#refreshInFlight.get(key);
    if (existing !== undefined) {
      const fresh = await existing;
      this.#assertSameIdentity(session, fresh.user);
      return fresh;
    }

    const refreshPromise = this.#refreshAndPersist(session)
      .then((fresh) => {
        this.#refreshReplay.set(key, {
          expiresAt:
            this.#clock().getTime() + this.#refreshReplayTtlMilliseconds,
          session: fresh,
        });
        return fresh;
      })
      .finally(() => {
        if (this.#refreshInFlight.get(key) === refreshPromise) {
          this.#refreshInFlight.delete(key);
        }
      });
    this.#refreshInFlight.set(key, refreshPromise);
    return refreshPromise;
  }

  public async verify(session: SealedCloudSession): Promise<{
    session: SealedCloudSession;
    user: CloudUser;
    refreshed: boolean;
  }> {
    let fresh = await this.ensureFresh(session);
    let user: CloudUser;
    try {
      user = await this.#client.me(fresh.session.accessToken);
    } catch (error) {
      if (
        !(error instanceof CloudAccountError) ||
        error.upstreamStatus !== 401 ||
        fresh.refreshed
      ) {
        throw error;
      }
      const refreshedSession = await this.refresh(fresh.session);
      fresh = { session: refreshedSession, refreshed: true };
      user = await this.#client.me(refreshedSession.accessToken);
    }
    this.#assertSameIdentity(fresh.session, user);
    await this.#shadowStore.upsertCloudUser(
      user,
      Math.floor(this.#clock().getTime() / 1000),
    );
    const profileChanged =
      JSON.stringify(fresh.session.user) !== JSON.stringify(user);
    return {
      session: profileChanged ? { ...fresh.session, user } : fresh.session,
      user,
      refreshed: fresh.refreshed || profileChanged,
    };
  }

  public async logout(session: SealedCloudSession): Promise<void> {
    await this.#client.logout(session.refreshToken);
  }

  async #refreshAndPersist(
    session: SealedCloudSession,
  ): Promise<SealedCloudSession> {
    let response: CloudTokenResponse;
    try {
      response = await this.#client.refresh(session.refreshToken);
    } catch (error) {
      if (
        error instanceof CloudAccountError &&
        error.code !== "cloud_service_unavailable"
      ) {
        throw new CloudAccountError(
          "Session expired",
          401,
          "not_authenticated",
        );
      }
      throw error;
    }
    this.#assertSameIdentity(session, response.user);
    return this.#persist(response);
  }

  #assertSameIdentity(session: SealedCloudSession, user: CloudUser): void {
    if (
      user.id !== session.user.id ||
      user.data_namespace !== session.user.data_namespace
    ) {
      throw new CloudAccountError(
        "Cloud refresh changed the authenticated tenant identity",
        401,
        "not_authenticated",
      );
    }
  }

  async #persist(response: CloudTokenResponse): Promise<SealedCloudSession> {
    const now = Math.floor(this.#clock().getTime() / 1000);
    await this.#shadowStore.upsertCloudUser(response.user, now);
    return {
      version: 1,
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      accessExpiresAt: now + response.expires_in,
      sessionExpiresAt: now + this.#sessionTtlSeconds,
      user: response.user,
    };
  }
}
