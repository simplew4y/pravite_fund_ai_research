import { DomainError } from "@private-fund/core";

import {
  cloudModelAccessTokenResponseSchema,
  cloudModelCatalogSchema,
  cloudTokenResponseSchema,
  cloudUserSchema,
  type CloudModelAccessTokenResponse,
  type CloudModelCatalog,
  type CloudTokenResponse,
  type CloudUser,
} from "./types.js";

export interface CloudAccountClientOptions {
  baseUrl: string;
  timeoutMilliseconds?: number;
  fetchImplementation?: typeof fetch;
}

export class CloudAccountError extends DomainError {
  public constructor(
    message: string,
    public readonly upstreamStatus: number,
    code = "cloud_account_error",
  ) {
    super(message, code, upstreamStatus);
  }
}

export class CloudAccountClient {
  readonly #baseUrl: URL;
  readonly #timeoutMilliseconds: number;
  readonly #fetch: typeof fetch;

  public constructor(options: CloudAccountClientOptions) {
    const configuredBaseUrl = new URL(
      options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`,
    );
    if (!["http:", "https:"].includes(configuredBaseUrl.protocol)) {
      throw new Error("Cloud account URL must use http or https");
    }
    if (
      configuredBaseUrl.username ||
      configuredBaseUrl.password ||
      configuredBaseUrl.search ||
      configuredBaseUrl.hash
    ) {
      throw new Error(
        "Cloud account URL cannot contain credentials, a query, or a fragment",
      );
    }
    const normalizedPath = configuredBaseUrl.pathname.replace(/\/+$/, "");
    configuredBaseUrl.pathname = normalizedPath.endsWith("/api/v1")
      ? `${normalizedPath}/`
      : `${normalizedPath}/api/v1/`;
    this.#baseUrl = configuredBaseUrl;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 10_000;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  public login(email: string, password: string): Promise<CloudTokenResponse> {
    return this.#request("auth/login", cloudTokenResponseSchema, {
      method: "POST",
      body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
    });
  }

  public register(input: {
    email: string;
    code: string;
    password: string;
    nickName?: string;
  }): Promise<CloudTokenResponse> {
    return this.#request("auth/register", cloudTokenResponseSchema, {
      method: "POST",
      body: JSON.stringify({
        email: input.email.trim().toLowerCase(),
        code: input.code,
        password: input.password,
        nick_name: input.nickName?.trim() || null,
      }),
    });
  }

  public async sendRegistrationCode(email: string): Promise<{
    status: number;
    payload: Record<string, unknown>;
  }> {
    const response = await this.#performRequest("auth/register/send-code", {
      method: "POST",
      body: JSON.stringify({ email: email.trim().toLowerCase() }),
    });
    const payload = await response.json().catch(() => null);
    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      throw new CloudAccountError(
        "Cloud account service returned an invalid response",
        502,
        "invalid_cloud_response",
      );
    }
    return {
      status: response.status,
      payload: payload as Record<string, unknown>,
    };
  }

  public refresh(refreshToken: string): Promise<CloudTokenResponse> {
    return this.#request("auth/refresh", cloudTokenResponseSchema, {
      method: "POST",
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  }

  public me(accessToken: string): Promise<CloudUser> {
    return this.#request("me", cloudUserSchema, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  public issueModelAccessToken(
    accessToken: string,
  ): Promise<CloudModelAccessTokenResponse> {
    return this.#request(
      "model-access-token",
      cloudModelAccessTokenResponseSchema,
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}` },
      },
    );
  }

  public models(accessToken: string): Promise<CloudModelCatalog> {
    return this.#request("models", cloudModelCatalogSchema, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  public async logout(refreshToken: string): Promise<void> {
    await this.#requestUnknown(
      "auth/logout",
      {
        method: "POST",
        body: JSON.stringify({ refresh_token: refreshToken }),
      },
      true,
    );
  }

  public async proxy(
    pathName: string,
    accessToken: string,
    init: RequestInit = {},
  ): Promise<Response> {
    return this.#performRequest(pathName, init, accessToken);
  }

  async #request<T>(
    pathName: string,
    schema: { parse(value: unknown): T },
    init: RequestInit,
  ): Promise<T> {
    const value = await this.#requestUnknown(pathName, init);
    try {
      return schema.parse(value);
    } catch {
      throw new CloudAccountError(
        "Cloud account service returned an invalid response",
        502,
        "invalid_cloud_response",
      );
    }
  }

  async #requestUnknown(
    pathName: string,
    init: RequestInit,
    allowEmptySuccess = false,
  ): Promise<Record<string, unknown>> {
    const response = await this.#performRequest(pathName, init);
    if (allowEmptySuccess && response.ok && response.status === 204) {
      return {};
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const object =
        payload !== null && typeof payload === "object"
          ? (payload as Record<string, unknown>)
          : {};
      throw new CloudAccountError(
        String(object.message ?? "Cloud account request failed"),
        response.status,
        String(object.code ?? object.error ?? "cloud_account_error"),
      );
    }
    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      throw new CloudAccountError(
        "Cloud account service returned an invalid response",
        502,
        "invalid_cloud_response",
      );
    }
    return payload as Record<string, unknown>;
  }

  async #performRequest(
    pathName: string,
    init: RequestInit,
    accessToken?: string,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("accept")) {
      headers.set("accept", "application/json");
    }
    if (
      init.body !== undefined &&
      init.body !== null &&
      !headers.has("content-type")
    ) {
      headers.set("content-type", "application/json");
    }
    if (accessToken !== undefined) {
      headers.set("authorization", `Bearer ${accessToken}`);
    }
    try {
      return await this.#fetch(new URL(pathName, this.#baseUrl), {
        ...init,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMilliseconds),
      });
    } catch (error) {
      throw new CloudAccountError(
        error instanceof Error
          ? error.message
          : "Cloud account service unavailable",
        503,
        "cloud_service_unavailable",
      );
    }
  }
}
