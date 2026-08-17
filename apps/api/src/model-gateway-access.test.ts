import { CloudAccountClient } from "@private-fund/auth";
import { describe, expect, it, vi } from "vitest";

import { CloudModelGatewayAccessIssuer } from "./model-gateway-access.js";

const TOKEN = `pfm_${"a".repeat(48)}`;
const BINDING = {
  userId: "95c29039-db82-4c52-98a7-d943de939c6a",
  dataNamespace: "5f33d8b1-165c-4e0a-ba15-346be0310666",
  projectId: "project-1",
  sessionId: "session-1",
};

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function issuerWith(
  fetchImplementation: typeof fetch,
  options: { readonly modelId?: string } = { modelId: "qwen3-max" },
) {
  return new CloudModelGatewayAccessIssuer({
    client: new CloudAccountClient({
      baseUrl: "https://cloud.example.test/backend",
      fetchImplementation,
    }),
    config: {
      baseUrl: "https://cloud.example.test/backend/gateway/v1",
      providerId: "private_fund_gateway",
      ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
      contextWindow: 32_768,
      maxTokens: 8_192,
    },
    now: () => Date.parse("2026-07-31T10:00:00.000Z"),
    leaseIdFactory: () => "model_lease_test",
  });
}

describe("CloudModelGatewayAccessIssuer", () => {
  it("uses the catalog default when the deployment does not pin a model", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/models")) {
        return response({
          object: "list",
          available: true,
          default_model: "private-fund-default",
          data: [
            { id: "another-model" },
            {
              id: "private-fund-default",
              display_name: "Qwen3 Max",
              provider: "dashscope",
              default_max_tokens: 4_096,
            },
          ],
        });
      }
      return response({
        access_token: TOKEN,
        expires_in: 604_800,
        gateway_base_url: "https://cloud.example.test/backend/gateway/v1",
      });
    });

    const access = await issuerWith(fetchImplementation, {}).issue(
      "cloud-access-token",
      BINDING,
    );

    expect(access.model).toMatchObject({
      id: "private-fund-default",
      name: "Qwen3 Max",
      maxTokens: 4_096,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("rejects a catalog whose default model is not in its data", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      response({
        available: true,
        default_model: "missing-default",
        data: [{ id: "another-model" }],
      }),
    );

    await expect(
      issuerWith(fetchImplementation, {}).issue("cloud-access-token", BINDING),
    ).rejects.toMatchObject({
      code: "invalid_model_gateway_response",
      statusCode: 502,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("issues and caches a session-bound in-memory model grant", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/model-access-token")) {
        return response({
          access_token: TOKEN,
          expires_in: 604_800,
          gateway_base_url:
            "https://cloud.example.test/backend/gateway/v1",
        });
      }
      return response({
        object: "list",
        available: true,
        default_model: "qwen3-max",
        data: [
          {
            id: "qwen3-max",
            display_name: "Qwen3 Max",
            provider: "custom_openai",
            default_max_tokens: 4_096,
            max_output_tokens: 8_192,
          },
        ],
      });
    });
    const issuer = issuerWith(fetchImplementation);

    const first = await issuer.issue("cloud-access-token", BINDING);
    const second = await issuer.issue("cloud-access-token", BINDING);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      accessToken: TOKEN,
      generation: 1,
      providerId: "private_fund_gateway",
      model: { id: "qwen3-max", maxTokens: 4_096 },
      binding: BINDING,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("rejects an upstream gateway URL that differs from deployment config", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      return url.pathname.endsWith("/model-access-token")
        ? response({
            access_token: TOKEN,
            expires_in: 3_600,
            gateway_base_url: "https://attacker.example.test/v1",
          })
        : response({
            available: true,
            default_model: "qwen3-max",
            data: [{ id: "qwen3-max" }],
          });
    });

    await expect(
      issuerWith(fetchImplementation).issue("cloud-access-token", BINDING),
    ).rejects.toMatchObject({
      code: "invalid_model_gateway_response",
      statusCode: 502,
    });
  });

  it("rejects cross-tenant reuse of a session id", async () => {
    let resolveToken: ((response: Response) => void) | undefined;
    const tokenResponse = new Promise<Response>((resolve) => {
      resolveToken = resolve;
    });
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/model-access-token")) {
        return tokenResponse;
      }
      return response({
        available: true,
        default_model: "qwen3-max",
        data: [{ id: "qwen3-max" }],
      });
    });
    const issuer = issuerWith(fetchImplementation);
    const pending = issuer.issue("cloud-access-token", BINDING);

    await expect(
      issuer.issue("other-cloud-access-token", {
        ...BINDING,
        userId: "00000000-0000-4000-8000-000000000099",
      }),
    ).rejects.toMatchObject({ code: "model_gateway_binding_conflict" });

    resolveToken?.(
      response({
        access_token: TOKEN,
        expires_in: 3_600,
        gateway_base_url:
          "https://cloud.example.test/backend/gateway/v1",
      }),
    );
    await pending;
  });
});
