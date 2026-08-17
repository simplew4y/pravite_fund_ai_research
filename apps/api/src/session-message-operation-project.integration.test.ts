import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Operation, Project, SessionEvent } from "@private-fund/contracts";

import type { ApiConfig } from "./config.js";
import { createApiRuntime, type ApiRuntime } from "./main.js";

const WORKER_ENTRY = "unused-agent-worker-entry";
const ALPHA_NAMESPACE = "00000000-0000-4000-8000-0000000000a1";
const BETA_NAMESPACE = "00000000-0000-4000-8000-0000000000b2";

function configFor(
  dataRoot: string,
  userId: string,
  dataNamespace: string,
): ApiConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    dataRoot,
    controlDatabase: path.join(dataRoot, "control.sqlite3"),
    auth: {
      mode: "development",
      userId,
      dataNamespace,
    },
    agentWorkerEntry: WORKER_ENTRY,
    agentModel: fakeModelEndpoint(),
  };
}

async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 3_000;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    value = await read();
  }
  if (!accept(value)) {
    throw new Error("Timed out waiting for canonical session state");
  }
  return value;
}

import { startFakeChatServer } from "../test/fixtures/fake-chat-server.mjs";

let fakeChat: Awaited<ReturnType<typeof startFakeChatServer>> | undefined;

function fakeModelEndpoint(): { baseUrl: string; apiKey: string; model: string } {
  if (fakeChat === undefined) throw new Error("fake chat server not started");
  return { baseUrl: fakeChat.url, apiKey: "test-model-key", model: "fake-model" };
}

beforeAll(async () => {
  fakeChat = await startFakeChatServer();
});

afterAll(async () => {
  await fakeChat?.close();
  fakeChat = undefined;
});

describe("legacy session project/event/item replacements", () => {
  let dataRoot: string | undefined;
  let runtime: ApiRuntime | undefined;

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    if (dataRoot !== undefined) {
      await rm(dataRoot, { recursive: true, force: true });
      dataRoot = undefined;
    }
  });

  it("persists idempotent messages as durable operations and isolates explicit projects", async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-session-replacements-"));
    const alphaConfig = configFor(dataRoot, "alpha-user", ALPHA_NAMESPACE);
    runtime = await createApiRuntime(alphaConfig);

    const projectResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: {
        name: "Alpha confidential research",
        companyName: "Alpha Holdings",
        ticker: "ALPHA",
      },
    });
    expect(projectResponse.statusCode, projectResponse.body).toBe(201);
    const project = projectResponse.json<Project>();

    const projectListResponse = await runtime.app.inject({
      method: "GET",
      url: "/v1/projects",
    });
    expect(projectListResponse.statusCode, projectListResponse.body).toBe(200);
    expect(projectListResponse.json<{ projects: Project[] }>()).toEqual({
      projects: [project],
    });

    const sessionResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        projectId: project.id,
        title: "Downside case",
      },
    });
    expect(sessionResponse.statusCode, sessionResponse.body).toBe(201);
    const session = sessionResponse.json<{ id: string }>();

    const message = {
      content: "Build a non-empty downside thesis",
      clientMessageId: "route-089-message-alpha",
    } as const;
    const messageResponse = await runtime.app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/messages`,
      payload: message,
    });
    expect(messageResponse.statusCode, messageResponse.body).toBe(202);
    const operationId = messageResponse.json<{ operationId: string }>()
      .operationId;

    const operations = await eventually(
      async () => {
        const response = await runtime!.app.inject({
          method: "GET",
          url: `/v1/sessions/${session.id}/operations`,
        });
        expect(response.statusCode, response.body).toBe(200);
        return response.json<{ operations: Operation[] }>().operations;
      },
      (rows) => rows[0]?.status === "completed",
    );
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      id: operationId,
      sessionId: session.id,
      kind: "agent.prompt",
      status: "completed",
      idempotencyKey: message.clientMessageId,
      request: { content: message.content },
      result: { status: "completed" },
      error: null,
    });
    expect(operations[0]?.startedAt).not.toBeNull();
    expect(operations[0]?.completedAt).not.toBeNull();

    const operationResponse = await runtime.app.inject({
      method: "GET",
      url: `/v1/sessions/${session.id}/operations/${operationId}`,
    });
    expect(operationResponse.statusCode, operationResponse.body).toBe(200);
    expect(operationResponse.json<Operation>()).toEqual(operations[0]);

    const duplicateMessageResponse = await runtime.app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/messages`,
      payload: message,
    });
    expect(
      duplicateMessageResponse.json<{ operationId: string }>().operationId,
    ).toBe(operationId);

    const eventResponse = await runtime.app.inject({
      method: "GET",
      url: `/v1/sessions/${session.id}/events?stream=0&limit=100`,
    });
    expect(eventResponse.statusCode, eventResponse.body).toBe(200);
    const events = eventResponse.json<{ events: SessionEvent[] }>().events;
    expect(events.filter((event) => event.type === "message.user")).toEqual([
      expect.objectContaining({
        operationId,
        payload: {
          content: message.content,
          clientMessageId: message.clientMessageId,
        },
      }),
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message.assistant.delta",
          operationId,
          payload: { delta: "Synthetic answer" },
        }),
        expect.objectContaining({
          type: "operation.completed",
          operationId,
        }),
      ]),
    );

    for (const legacyRequest of [
      {
        method: "GET" as const,
        url: "/v1/sessions/projects",
      },
      {
        method: "GET" as const,
        url: `/v1/sessions/${session.id}/items`,
      },
      {
        method: "POST" as const,
        url: `/v1/sessions/${session.id}/events`,
        payload: {
          type: "message",
          content: message.content,
        },
      },
    ]) {
      const response = await runtime.app.inject(legacyRequest);
      expect(
        response.statusCode,
        `${legacyRequest.method} ${legacyRequest.url}`,
      ).toBe(404);
    }

    await runtime.close();
    runtime = await createApiRuntime(
      configFor(dataRoot, "beta-user", BETA_NAMESPACE),
    );

    const betaProjects = await runtime.app.inject({
      method: "GET",
      url: "/v1/projects",
    });
    expect(betaProjects.statusCode, betaProjects.body).toBe(200);
    expect(betaProjects.json()).toEqual({ projects: [] });

    const betaOperations = await runtime.app.inject({
      method: "GET",
      url: `/v1/sessions/${session.id}/operations`,
    });
    expect(betaOperations.statusCode, betaOperations.body).toBe(404);
    const betaMessage = await runtime.app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/messages`,
      payload: {
        content: "Attempt cross-tenant access",
        clientMessageId: "route-089-message-beta",
      },
    });
    expect(betaMessage.statusCode, betaMessage.body).toBe(404);

    await runtime.close();
    runtime = await createApiRuntime(alphaConfig);

    const restoredProjects = await runtime.app.inject({
      method: "GET",
      url: "/v1/projects",
    });
    expect(restoredProjects.json()).toEqual({ projects: [project] });
    const restoredOperations = await runtime.app.inject({
      method: "GET",
      url: `/v1/sessions/${session.id}/operations`,
    });
    expect(restoredOperations.statusCode, restoredOperations.body).toBe(200);
    expect(
      restoredOperations.json<{ operations: Operation[] }>().operations,
    ).toEqual(operations);
  });
});
