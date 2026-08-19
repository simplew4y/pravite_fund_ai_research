import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createControlRepositories } from "@private-fund/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadApiConfig } from "./config.js";
import { createApiRuntime, type ApiRuntime } from "./main.js";
import { startFakeChatServer } from "../test/fixtures/fake-chat-server.mjs";

const DEV_NAMESPACE = "00000000-0000-4000-8000-000000000001";

describe("Session Journal as authority", () => {
  let root: string;
  let fakeChat: Awaited<ReturnType<typeof startFakeChatServer>>;
  let runtime: ApiRuntime;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "pf-authority-"));
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
          PRIVATE_FUND_SESSION_JOURNAL_AUTHORITY: "1",
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

  function mirrorRows(sessionId: string) {
    const repositories = createControlRepositories(runtime.database);
    return repositories.sessionJournal
      .replayForTenant(DEV_NAMESPACE, sessionId, 0, 5_000)
      .filter((event) => event.source.version === "shadow-sync/1");
  }

  it("mirrors every durable event transactionally, in legacy order", async () => {
    const project = (
      await request("POST", "/v1/projects", { name: "权威" })
    ).body as { id: string };
    const session = (
      await request("POST", "/v1/sessions", {
        projectId: project.id,
        title: "authority",
      })
    ).body as { id: string };
    await request("POST", `/v1/sessions/${session.id}/messages`, {
      content: "Request parent tool",
      clientMessageId: "auth-1",
    });
    await waitForTerminal(session.id);

    const legacy = (
      (await request("GET", `/v1/sessions/${session.id}/events?stream=0`))
        .body as {
        events: {
          sequence: number;
          type: string;
          payload: Record<string, unknown>;
        }[];
      }
    ).events;
    const mirrored = mirrorRows(session.id);
    // 1:1 parity in identical order — including session.created (seq 1),
    // which is inserted by the sessions repository and backfilled inside
    // the first mirrored transaction.
    expect(mirrored).toHaveLength(legacy.length);
    for (const [index, legacyEvent] of legacy.entries()) {
      expect(mirrored[index]!.payload.shadowSequence).toBe(
        legacyEvent.sequence,
      );
      expect(mirrored[index]!.type).toBe(legacyEvent.type);
    }

    const repositories = createControlRepositories(runtime.database);
    expect(
      repositories.sessionJournal.verifyIntegrityForTenant(
        DEV_NAMESPACE,
        session.id,
      ).valid,
    ).toBe(true);
  });

  it("fails closed: when the journal cannot commit, the legacy write rolls back too", async () => {
    const project = (
      await request("POST", "/v1/projects", { name: "权威2" })
    ).body as { id: string };
    const session = (
      await request("POST", "/v1/sessions", {
        projectId: project.id,
        title: "authority-closed",
      })
    ).body as { id: string };

    // Warm the session so seq 1 is already mirrored, then poison the journal.
    await request("POST", `/v1/sessions/${session.id}/messages`, {
      content: "hello",
      clientMessageId: "warm-1",
    });
    await waitForTerminal(session.id);
    const legacyBefore = (
      (await request("GET", `/v1/sessions/${session.id}/events?stream=0`))
        .body as { events: unknown[] }
    ).events.length;

    runtime.database
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS poison_mirror
         BEFORE INSERT ON session_journal_events
         WHEN NEW.type = 'message.user'
         BEGIN SELECT RAISE(ABORT, 'journal poisoned'); END`,
      )
      .run();
    try {
      const rejected = await request(
        "POST",
        `/v1/sessions/${session.id}/messages`,
        { content: "must fail closed", clientMessageId: "poison-1" },
      );
      expect(rejected.statusCode).toBeGreaterThanOrEqual(500);

      // The legacy projection must not contain the rejected user message:
      // the mirror transaction rolled both writes back together.
      const legacyAfter = (
        (await request("GET", `/v1/sessions/${session.id}/events?stream=0`))
          .body as { events: { type: string; payload: Record<string, unknown> }[] }
      ).events;
      expect(
        legacyAfter.some(
          (event) => event.payload["clientMessageId"] === "poison-1",
        ),
      ).toBe(false);
      // The rejected turn may legitimately append failure bookkeeping
      // (operation.failed / session.status) — but never message content.
      for (const event of legacyAfter.slice(legacyBefore)) {
        expect(["operation.failed", "session.status"]).toContain(event.type);
      }
    } finally {
      runtime.database.prepare("DROP TRIGGER IF EXISTS poison_mirror").run();
    }

    // After the poison clears, the session keeps working.
    const retry = await request(
      "POST",
      `/v1/sessions/${session.id}/messages`,
      { content: "hello again", clientMessageId: "recover-1" },
    );
    expect(retry.statusCode).toBe(202);
  });

  it("derives the model context from the journal (authority source)", async () => {
    const project = (
      await request("POST", "/v1/projects", { name: "权威3" })
    ).body as { id: string };
    const session = (
      await request("POST", "/v1/sessions", {
        projectId: project.id,
        title: "authority-derive",
      })
    ).body as { id: string };
    await request("POST", `/v1/sessions/${session.id}/messages`, {
      content: "第一问",
      clientMessageId: "derive-1",
    });
    await waitForTerminal(session.id);
    await request("POST", `/v1/sessions/${session.id}/messages`, {
      content: "第二问",
      clientMessageId: "derive-2",
    });
    await waitForTerminal(session.id);

    // The second model request snapshot must contain the first exchange —
    // and that context can only have come through the journal reader.
    const repositories = createControlRepositories(runtime.database);
    const snapshots = repositories.sessionJournal
      .replayForTenant(DEV_NAMESPACE, session.id, 0, 5_000)
      .filter((event) => event.type === "model.request.snapshot");
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    const lastSnapshot = snapshots[snapshots.length - 1]!.payload as {
      value: { body: { messages: { role: string; content: unknown }[] } };
    };
    const serialized = JSON.stringify(lastSnapshot.value.body.messages);
    expect(serialized).toContain("第一问");
    expect(serialized).toContain("Synthetic answer");
    expect(serialized).toContain("第二问");
  });
});
