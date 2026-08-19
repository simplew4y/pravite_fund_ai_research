import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createControlRepositories } from "@private-fund/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadApiConfig } from "./config.js";
import { createApiRuntime, type ApiRuntime } from "./main.js";
import { startFakeChatServer } from "../test/fixtures/fake-chat-server.mjs";

const DEV_NAMESPACE = "00000000-0000-4000-8000-000000000001";

describe("commit-before-send model audit", () => {
  let root: string;
  let fakeChat: Awaited<ReturnType<typeof startFakeChatServer>>;
  let runtime: ApiRuntime;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "pf-model-audit-"));
    fakeChat = await startFakeChatServer();
    runtime = await createApiRuntime(
      loadApiConfig(
        {
          PRIVATE_FUND_AUTH_MODE: "development",
          PRIVATE_FUND_DATA_ROOT: root,
          PRIVATE_FUND_DEV_DATA_NAMESPACE: DEV_NAMESPACE,
          PRIVATE_FUND_AGENT_API_KEY: "test-model-key",
          PRIVATE_FUND_AGENT_BASE_URL: fakeChat.url,
          PRIVATE_FUND_AGENT_MODEL: "fake-model",
        },
        root,
      ),
    );
  });

  afterAll(async () => {
    await runtime.close();
    await fakeChat.close();
    await rm(root, { recursive: true, force: true });
  });

  async function request(
    method: string,
    url: string,
    payload?: unknown,
  ): Promise<{ statusCode: number; body: unknown }> {
    const response = await runtime.app.inject({
      method: method as "GET",
      url,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { statusCode: response.statusCode, body: response.json() };
  }

  async function waitForTerminal(sessionId: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const events = (
        (await request("GET", `/v1/sessions/${sessionId}/events?stream=0`))
          .body as { events: { type: string }[] }
      ).events;
      if (
        events.some(
          (event) =>
            event.type === "operation.completed" ||
            event.type === "operation.failed",
        )
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Turn did not reach a terminal event");
  }

  it("journals the exact request snapshot and every provider event for a tool-using turn", async () => {
    const project = (
      await request("POST", "/v1/projects", { name: "审计" })
    ).body as { id: string };
    const session = (
      await request("POST", "/v1/sessions", {
        projectId: project.id,
        title: "audit",
      })
    ).body as { id: string };
    await request("POST", `/v1/sessions/${session.id}/messages`, {
      content: "Request parent tool",
      clientMessageId: "audit-1",
    });
    await waitForTerminal(session.id);

    const repositories = createControlRepositories(runtime.database);
    const journal = repositories.sessionJournal.replayForTenant(
      DEV_NAMESPACE,
      session.id,
      0,
      5_000,
    );

    // One snapshot per model step: step 1 requests the tool, step 2 answers.
    const snapshots = journal.filter(
      (event) => event.type === "model.request.snapshot",
    );
    expect(snapshots).toHaveLength(2);
    for (const snapshot of snapshots) {
      expect(snapshot.requestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(snapshot.source).toMatchObject({ kind: "model" });
      // Audit payloads are wrapped: {storage:"inline", contentHash, value}.
      const payload = snapshot.payload as {
        storage: string;
        contentHash: string;
        value: {
          body: { model: string; messages: unknown[]; stream: boolean };
          sourceManifest: { bodyPointers: string[] }[];
        };
      };
      expect(payload.storage).toBe("inline");
      expect(payload.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(payload.value.body.model).toBe("fake-model");
      expect(payload.value.body.stream).toBe(true);
      expect(Array.isArray(payload.value.body.messages)).toBe(true);
      expect(payload.value.sourceManifest.length).toBeGreaterThanOrEqual(2);
    }

    // Tool intent (from the tool pipeline) and the model's tool call are
    // both journaled; provider stream terminals close each request.
    const types = journal.map((event) => event.type);
    expect(types).toContain("assistant.toolcall_end");
    expect(types).toContain("tool.call.requested");
    expect(types).toContain("tool.result.recorded");
    expect(
      journal.filter((event) => event.type === "model.stream.completed"),
    ).toHaveLength(2);

    // Provider events are causally linked to their request snapshot.
    const streamEvents = journal.filter((event) =>
      [
        "message.assistant.delta",
        "assistant.toolcall_end",
        "model.stream.completed",
      ].includes(event.type),
    );
    const snapshotIds = new Set(snapshots.map((event) => event.eventId));
    for (const event of streamEvents) {
      expect(event.causationEventId).not.toBeNull();
      expect(snapshotIds.has(event.causationEventId!)).toBe(true);
    }

    // The hash chain over the whole journal (shadow + audit) stays intact.
    const integrity = repositories.sessionJournal.verifyIntegrityForTenant(
      DEV_NAMESPACE,
      session.id,
    );
    expect(integrity.valid).toBe(true);
  });

  it("fails closed: a poisoned journal blocks the turn with no model output", async () => {
    const project = (
      await request("POST", "/v1/projects", { name: "审计2" })
    ).body as { id: string };
    const session = (
      await request("POST", "/v1/sessions", {
        projectId: project.id,
        title: "audit-closed",
      })
    ).body as { id: string };

    // Sabotage: journal appends for this tenant fail while the transport
    // stays perfectly healthy.
    const repositories = createControlRepositories(runtime.database);
    runtime.database
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS poison_journal
         BEFORE INSERT ON session_journal_events
         WHEN NEW.type = 'model.request.snapshot'
         BEGIN SELECT RAISE(ABORT, 'journal poisoned'); END`,
      )
      .run();
    try {
      await request("POST", `/v1/sessions/${session.id}/messages`, {
        content: "hello",
        clientMessageId: "audit-closed-1",
      });
      await waitForTerminal(session.id);
      const events = (
        (await request("GET", `/v1/sessions/${session.id}/events?stream=0`))
          .body as { events: { type: string; payload: Record<string, unknown> }[] }
      ).events;
      const failure = events.find((event) => event.type === "operation.failed");
      expect(failure?.payload.error).toContain(
        "Session Journal rejected the model request snapshot",
      );
      // Fail closed means silence: no assistant output ever streamed.
      expect(
        events.some((event) => event.type === "message.assistant.delta"),
      ).toBe(false);
    } finally {
      runtime.database
        .prepare("DROP TRIGGER IF EXISTS poison_journal")
        .run();
    }
  });
});
