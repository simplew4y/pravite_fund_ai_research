import type { ModelGatewayAccess } from "@private-fund/contracts";
import { describe, expect, it, vi } from "vitest";

import { ModelGatewayCredentialStore } from "../src/model-gateway-credential-store.js";

function access(
  overrides: Partial<ModelGatewayAccess> = {},
): ModelGatewayAccess {
  return {
    leaseId: "model_lease_1",
    generation: 1,
    providerId: "private_fund_gateway",
    accessToken: `pfm_${"a".repeat(48)}`,
    expiresAt: "2099-08-01T10:00:00.000Z",
    gatewayBaseUrl: "https://cloud.example.test/backend/gateway/v1",
    model: {
      id: "qwen3-max",
      name: "Qwen3 Max",
      contextWindow: 32_768,
      maxTokens: 8_192,
    },
    binding: {
      userId: "95c29039-db82-4c52-98a7-d943de939c6a",
      dataNamespace: "5f33d8b1-165c-4e0a-ba15-346be0310666",
      projectId: "project-1",
      sessionId: "session-1",
    },
    ...overrides,
  };
}

describe("ModelGatewayCredentialStore", () => {
  it("keeps credentials isolated and rotates only to a newer generation", async () => {
    const firstToken = `pfm_${"a".repeat(48)}`;
    const secondToken = `pfm_${"b".repeat(48)}`;
    const storeA = new ModelGatewayCredentialStore(
      access({ accessToken: firstToken }),
    );
    const storeB = new ModelGatewayCredentialStore(
      access({
        leaseId: "model_lease_b",
        accessToken: secondToken,
        binding: { ...access().binding, sessionId: "session-2" },
      }),
    );

    expect(await storeA.read("private_fund_gateway")).toEqual({
      type: "api_key",
      key: firstToken,
    });
    expect(await storeB.read("private_fund_gateway")).toEqual({
      type: "api_key",
      key: secondToken,
    });

    storeA.update(
      access({
        leaseId: "model_lease_2",
        generation: 2,
        accessToken: secondToken,
      }),
    );
    expect(await storeA.read("private_fund_gateway")).toEqual({
      type: "api_key",
      key: secondToken,
    });
    expect(() =>
      storeA.update(access({ generation: 1 })),
    ).toThrow(/stale/i);
  });

  it("fails closed after expiry or disposal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T10:00:00.000Z"));
    try {
      const store = new ModelGatewayCredentialStore(
        access({ expiresAt: "2026-07-31T10:01:00.000Z" }),
      );
      vi.setSystemTime(new Date("2026-07-31T10:02:00.000Z"));
      await expect(store.read("private_fund_gateway")).rejects.toThrow(
        /expired/i,
      );
      await expect(store.read("private_fund_gateway")).rejects.toThrow(
        /unavailable/i,
      );
    } finally {
      vi.useRealTimers();
    }

    const disposed = new ModelGatewayCredentialStore(access());
    disposed.clear();
    await expect(disposed.read("private_fund_gateway")).rejects.toThrow(
      /unavailable/i,
    );
  });

  it("rejects cross-session credential updates", () => {
    const store = new ModelGatewayCredentialStore(access());
    expect(() =>
      store.update(
        access({
          leaseId: "model_lease_other",
          generation: 2,
          binding: { ...access().binding, sessionId: "session-other" },
        }),
      ),
    ).toThrow(/binding mismatch/i);
  });
});
