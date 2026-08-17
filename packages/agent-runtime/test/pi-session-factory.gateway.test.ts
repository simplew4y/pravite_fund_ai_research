import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ModelGatewayAccess } from "@private-fund/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { PiAgentSessionFactory } from "../src/pi-session-factory.js";

const temporaryDirectories: string[] = [];

async function allFileContents(root: string): Promise<string> {
  const contents: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile()) {
        contents.push(await readFile(target, "utf8"));
      }
    }
  }
  await visit(root);
  return contents.join("\n");
}

function gatewayAccess(): ModelGatewayAccess {
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
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("PiAgentSessionFactory model gateway runtime", () => {
  it("keeps the cloud token memory-only and binds it to one session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-gateway-runtime-"));
    temporaryDirectories.push(root);
    const token = `pfm_${"a".repeat(48)}`;
    const access = gatewayAccess();
    const factory = new PiAgentSessionFactory();
    const session = await factory.create(
      {
        sessionId: "session-1",
        projectId: "project-1",
        tenant: {
          userId: access.binding.userId,
          dataNamespace: access.binding.dataNamespace,
        },
        workspace: path.join(root, "workspace"),
        sessionFile: path.join(root, "sessions", "session-1.jsonl"),
      },
      { modelGatewayAccess: access },
    );

    expect(await allFileContents(root)).not.toContain(token);
    await expect(
      session.updateModelGatewayAccess?.({
        ...access,
        leaseId: "model_lease_wrong-session",
        generation: 2,
        binding: { ...access.binding, sessionId: "session-other" },
      }),
    ).rejects.toThrow(/binding mismatch/i);
    session.dispose();
    expect(await allFileContents(root)).not.toContain(token);
  });
});
