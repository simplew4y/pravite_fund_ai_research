import { describe, expect, it } from "vitest";

import {
  agentWorkerCommandSchema,
  modelGatewayAccessSchema,
} from "../src/index.js";

const access = {
  leaseId: "model_lease_1",
  generation: 1,
  providerId: "private_fund_gateway",
  accessToken: `pfm_${"a".repeat(48)}`,
  expiresAt: "2026-08-01T10:00:00.000Z",
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
};

describe("model gateway worker contract", () => {
  it("accepts a strict session-bound model gateway grant", () => {
    expect(modelGatewayAccessSchema.parse(access)).toEqual(access);
    expect(
      agentWorkerCommandSchema.parse({
        type: "session.start",
        requestId: "request-1",
        sessionId: "session-1",
        projectId: "project-1",
        tenant: {
          userId: access.binding.userId,
          dataNamespace: access.binding.dataNamespace,
        },
        workspace: "/tmp/workspace",
        sessionFile: "/tmp/session.jsonl",
        modelGatewayAccess: access,
      }).type,
    ).toBe("session.start");
  });

  it("rejects malformed tokens, unsafe URLs, and unknown secret fields", () => {
    expect(
      modelGatewayAccessSchema.safeParse({
        ...access,
        accessToken: "not-a-model-token",
      }).success,
    ).toBe(false);
    expect(
      modelGatewayAccessSchema.safeParse({
        ...access,
        gatewayBaseUrl: "http://cloud.example.test/gateway/v1",
      }).success,
    ).toBe(false);
    expect(
      modelGatewayAccessSchema.safeParse({
        ...access,
        refreshToken: "must-not-cross-the-worker-boundary",
      }).success,
    ).toBe(false);
  });
});
