import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AgentWorkerSupervisor,
  buildAgentWorkerEnvironment,
} from "./agent-supervisor.js";

const WORKER_ENTRY = fileURLToPath(
  new URL("../test/fixtures/fake-agent-worker.mjs", import.meta.url),
);

describe("AgentWorkerSupervisor", () => {
  it("round-trips commands and forwards validated worker events", async () => {
    const supervisor = new AgentWorkerSupervisor({
      workerEntry: WORKER_ENTRY,
      environment: buildAgentWorkerEnvironment({
        PATH: process.env.PATH,
        OMNIGENT_ACCOUNTS_COOKIE_SECRET: "must-not-leak",
      }),
      commandTimeoutMilliseconds: 2_000,
      readyTimeoutMilliseconds: 2_000,
    });
    const eventPromise = new Promise<Record<string, unknown>>((resolve) => {
      supervisor.subscribe((event) => {
        resolve(event.payload);
      });
    });

    await supervisor.start({
      sessionId: "session-test",
      projectId: "project-test",
      tenant: {
        userId: "user-test",
        dataNamespace: "00000000-0000-4000-8000-000000000001",
      },
      workspace: "/tmp/workspace",
      sessionFile: "/tmp/session.jsonl",
    });
    await supervisor.prompt(
      "session-test",
      "operation-test",
      "Research this",
    );

    await expect(eventPromise).resolves.toEqual({
      cookieSecretVisible: false,
    });
    await supervisor.stop();
  });

  it("filters API account secrets out of child environments", () => {
    expect(
      buildAgentWorkerEnvironment({
        PATH: "/bin",
        ELECTRON_RUN_AS_NODE: "1",
        OPENAI_API_KEY: "model-key",
        OMNIGENT_ACCOUNTS_COOKIE_SECRET: "cookie-secret",
        OMNIGENT_CLOUD_BACKEND_URL: "https://accounts.invalid",
      }),
    ).toEqual({
      PATH: "/bin",
      ELECTRON_RUN_AS_NODE: "1",
      OPENAI_API_KEY: "model-key",
    });
  });

  it("removes ambient provider credentials from cloud workers", () => {
    expect(
      buildAgentWorkerEnvironment(
        {
          PATH: "/bin",
          OPENAI_API_KEY: "must-not-cross-tenant-boundary",
          AWS_ACCESS_KEY_ID: "must-not-cross-tenant-boundary",
        },
        { includeAmbientModelCredentials: false },
      ),
    ).toEqual({ PATH: "/bin" });
  });

  it("executes parent tools and sends correlated results directly", async () => {
    const supervisor = new AgentWorkerSupervisor({
      workerEntry: WORKER_ENTRY,
      environment: buildAgentWorkerEnvironment({
        PATH: process.env.PATH,
      }),
      commandTimeoutMilliseconds: 2_000,
      readyTimeoutMilliseconds: 2_000,
    });
    supervisor.setToolHandler({
      async execute(request) {
        expect(request.tool).toBe("workspace.list");
        expect(request.sessionId).toBe("session-tool-test");
        return { items: [], nextCursor: null };
      },
    });
    const resultEvent = new Promise<Record<string, unknown>>((resolve) => {
      supervisor.subscribe((event) => {
        if (event.eventType === "test.tool-result") {
          resolve(event.payload);
        }
      });
    });

    await supervisor.start({
      sessionId: "session-tool-test",
      projectId: "project-tool-test",
      tenant: {
        userId: "user-tool-test",
        dataNamespace: "00000000-0000-4000-8000-000000000001",
      },
      workspace: "/tmp/workspace-tool-test",
      sessionFile: "/tmp/session-tool-test.jsonl",
    });
    await supervisor.prompt(
      "session-tool-test",
      "operation-tool-test",
      "Request parent tool",
    );

    await expect(resultEvent).resolves.toEqual({
      ok: true,
      result: { items: [], nextCursor: null },
      error: null,
    });
    await supervisor.stop();
  });

  it("reports an acknowledged worker crash and starts a clean child on the next command", async () => {
    const supervisor = new AgentWorkerSupervisor({
      workerEntry: WORKER_ENTRY,
      environment: buildAgentWorkerEnvironment({
        PATH: process.env.PATH,
      }),
      commandTimeoutMilliseconds: 2_000,
      readyTimeoutMilliseconds: 2_000,
    });
    const failure = new Promise<Error>((resolve) => {
      supervisor.subscribeFailure(resolve);
    });

    await supervisor.start({
      sessionId: "session-before-crash",
      projectId: "project-before-crash",
      tenant: {
        userId: "user-before-crash",
        dataNamespace: "00000000-0000-4000-8000-000000000011",
      },
      workspace: "/tmp/workspace-before-crash",
      sessionFile: "/tmp/session-before-crash.jsonl",
    });
    await supervisor.prompt(
      "session-before-crash",
      "operation-before-crash",
      "Crash after acknowledge",
    );
    await expect(failure).resolves.toMatchObject({
      code: "agent_worker_unavailable",
      statusCode: 503,
    });

    await expect(
      supervisor.start({
        sessionId: "session-after-crash",
        projectId: "project-after-crash",
        tenant: {
          userId: "user-after-crash",
          dataNamespace: "00000000-0000-4000-8000-000000000012",
        },
        workspace: "/tmp/workspace-after-crash",
        sessionFile: "/tmp/session-after-crash.jsonl",
      }),
    ).resolves.toBeUndefined();
    await supervisor.stop();
  });
});
