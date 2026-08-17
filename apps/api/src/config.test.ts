import { describe, expect, it } from "vitest";

import { loadApiConfig } from "./config.js";

const COOKIE_SECRET = "production-cookie-secret-".repeat(2);

describe("production API configuration", () => {
  it("resolves an optional same-origin Web UI root", () => {
    const config = loadApiConfig(
      {
        PRIVATE_FUND_AUTH_MODE: "development",
        PRIVATE_FUND_WEB_ROOT: "web-dist",
      },
      "/tmp/private-fund-config-test",
    );

    expect(config.webRoot).toBe("/tmp/private-fund-config-test/web-dist");
  });

  it("requires HTTPS for the cloud account backend", () => {
    expect(() =>
      loadApiConfig(
        {
          PRIVATE_FUND_AUTH_MODE: "cloud",
          OMNIGENT_CLOUD_BACKEND_URL: "http://accounts.example.test",
          OMNIGENT_ACCOUNTS_COOKIE_SECRET: COOKIE_SECRET,
        },
        "/tmp/private-fund-config-test",
      ),
    ).toThrow(/must use https/i);
  });

  it("accepts an HTTPS cloud backend without a cookie downgrade option", () => {
    const config = loadApiConfig(
      {
        PRIVATE_FUND_AUTH_MODE: "cloud",
        OMNIGENT_CLOUD_BACKEND_URL: "https://accounts.example.test",
        OMNIGENT_ACCOUNTS_COOKIE_SECRET: COOKIE_SECRET,
      },
      "/tmp/private-fund-config-test",
    );

    expect(config.auth).toMatchObject({
      mode: "cloud",
      backendUrl: "https://accounts.example.test",
    });
    expect(config.auth).not.toHaveProperty("secureCookie");
  });

  it("accepts a credential-free HTTPS model gateway configuration", () => {
    const config = loadApiConfig(
      {
        PRIVATE_FUND_AUTH_MODE: "cloud",
        OMNIGENT_CLOUD_BACKEND_URL: "https://accounts.example.test/control",
        OMNIGENT_ACCOUNTS_COOKIE_SECRET: COOKIE_SECRET,
        PRIVATE_FUND_MODEL_GATEWAY_BASE_URL:
          "https://accounts.example.test/control/gateway/v1/",
        PRIVATE_FUND_MODEL_GATEWAY_MODEL_ID: "qwen3-max",
      },
      "/tmp/private-fund-config-test",
    );

    expect(config.modelGateway).toEqual({
      baseUrl: "https://accounts.example.test/control/gateway/v1",
      providerId: "private_fund_gateway",
      modelId: "qwen3-max",
      contextWindow: 32_768,
      maxTokens: 8_192,
    });
  });

  it("rejects insecure or credential-bearing model gateway URLs", () => {
    const base = {
      PRIVATE_FUND_AUTH_MODE: "cloud",
      OMNIGENT_CLOUD_BACKEND_URL: "https://accounts.example.test",
      OMNIGENT_ACCOUNTS_COOKIE_SECRET: COOKIE_SECRET,
    };
    expect(() =>
      loadApiConfig(
        {
          ...base,
          PRIVATE_FUND_MODEL_GATEWAY_BASE_URL: "http://gateway.example.test/v1",
        },
        "/tmp/private-fund-config-test",
      ),
    ).toThrow(/credential-free HTTPS/i);
    expect(() =>
      loadApiConfig(
        {
          ...base,
          PRIVATE_FUND_MODEL_GATEWAY_BASE_URL:
            "https://user:secret@gateway.example.test/v1",
        },
        "/tmp/private-fund-config-test",
      ),
    ).toThrow(/credential-free HTTPS/i);
  });
});
