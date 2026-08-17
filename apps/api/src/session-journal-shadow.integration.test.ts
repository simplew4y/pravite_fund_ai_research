import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { loadApiConfig } from "./config.js";
import { createApiRuntime, type ApiRuntime } from "./main.js";
import {
  shadowIdempotencyKey,
  shadowSourceKind,
} from "./session-journal-shadow.js";

const DEV_NAMESPACE = "00000000-0000-4000-8000-000000000001";

describe("Session Journal shadow write (Phase 1)", () => {
  let root: string;
  let runtime: ApiRuntime;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "pf-journal-"));
    runtime = await createApiRuntime(
      loadApiConfig(
        {
          PRIVATE_FUND_AUTH_MODE: "development",
          PRIVATE_FUND_DATA_ROOT: root,
          PRIVATE_FUND_DEV_DATA_NAMESPACE: DEV_NAMESPACE,
          PRIVATE_FUND_SESSION_JOURNAL_SHADOW: "1",
        },
        root,
      ),
    );
  });

  afterAll(async () => {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
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
    return {
      statusCode: response.statusCode,
      body: response.statusCode === 204 ? null : response.json(),
    };
  }

  it("replays journal events equivalent to the legacy stream", async () => {
    const project = await request("POST", "/v1/projects", { name: "影子测试" });
    expect(project.statusCode).toBe(201);
    const projectId = (project.body as { id: string }).id;

    const session = await request("POST", "/v1/sessions", {
      projectId,
      title: "journal parity",
    });
    expect(session.statusCode).toBe(201);
    const sessionId = (session.body as { id: string }).id;

    // The prompt fails without model credentials — that is fine: it still
    // produces message.user / session.status / operation.failed events.
    await request(`POST`, `/v1/sessions/${sessionId}/messages`, {
      content: "对比测试",
      clientMessageId: "msg-journal-parity-1",
    });

    // Reading the event stream triggers a shadow sync.
    const events = await request(
      "GET",
      `/v1/sessions/${sessionId}/events?stream=0`,
    );
    const legacy = (events.body as { events: { sequence: number }[] }).events;
    expect(legacy.length).toBeGreaterThanOrEqual(2);

    const { createControlRepositories } = await import("@private-fund/db");
    const repos = createControlRepositories(runtime.database);
    const journalEvents = repos.sessionJournal
      .replayForTenant(DEV_NAMESPACE, sessionId, 0, 5_000)
      .filter((event) => event.source.version === "shadow-sync/1");

    // 1:1 parity on (sequence, type, operationId, payload).
    expect(journalEvents).toHaveLength(legacy.length);
    for (const [index, legacyEvent] of (
      legacy as {
        sequence: number;
        type: string;
        operationId: string | null;
        payload: Record<string, unknown>;
      }[]
    ).entries()) {
      const mirrored = journalEvents[index]!;
      expect(mirrored.payload.shadowSequence).toBe(legacyEvent.sequence);
      expect(mirrored.type).toBe(legacyEvent.type);
      expect(mirrored.operationId).toBe(legacyEvent.operationId);
      const { shadowSequence: _drop, ...payload } = mirrored.payload;
      expect(payload).toEqual(legacyEvent.payload);
      expect(mirrored.idempotencyKey).toBe(
        shadowIdempotencyKey(sessionId, legacyEvent.sequence),
      );
    }

    // Hash chain intact.
    const report = repos.sessionJournal.verifyIntegrityForTenant(
      DEV_NAMESPACE,
      sessionId,
    );
    expect(report.valid).toBe(true);
    expect(report.eventCount).toBe(journalEvents.length);

    // Re-reading must be idempotent: no duplicate journal rows.
    await request("GET", `/v1/sessions/${sessionId}/events?stream=0`);
    const again = repos.sessionJournal
      .replayForTenant(DEV_NAMESPACE, sessionId, 0, 5_000)
      .filter((event) => event.source.version === "shadow-sync/1");
    expect(again).toHaveLength(journalEvents.length);
  });

  it("covers fork history: child session journal mirrors copied events", async () => {
    const project = await request("POST", "/v1/projects", { name: "fork 影子" });
    const projectId = (project.body as { id: string }).id;
    const session = await request("POST", "/v1/sessions", {
      projectId,
      title: "parent",
    });
    const sessionId = (session.body as { id: string }).id;
    await request("POST", `/v1/sessions/${sessionId}/messages`, {
      content: "fork 前",
      clientMessageId: "msg-fork-parity-1",
    });
    const fork = await request("POST", `/v1/sessions/${sessionId}/fork`, {
      title: "child",
    });
    expect(fork.statusCode).toBe(201);
    const childId = (fork.body as { id: string }).id;

    const childEvents = await request(
      "GET",
      `/v1/sessions/${childId}/events?stream=0`,
    );
    const legacy = (childEvents.body as { events: unknown[] }).events;

    const { createControlRepositories } = await import("@private-fund/db");
    const repos = createControlRepositories(runtime.database);
    const mirrored = repos.sessionJournal
      .replayForTenant(DEV_NAMESPACE, childId, 0, 5_000)
      .filter((event) => event.source.version === "shadow-sync/1");
    expect(mirrored).toHaveLength(legacy.length);
    expect(
      repos.sessionJournal.verifyIntegrityForTenant(DEV_NAMESPACE, childId)
        .valid,
    ).toBe(true);
  });
});

describe("shadowSourceKind", () => {
  it("maps event types onto journal source kinds", () => {
    expect(shadowSourceKind("message.user")).toBe("user");
    expect(shadowSourceKind("message.assistant.delta")).toBe("agent");
    expect(shadowSourceKind("tool.completed")).toBe("tool");
    expect(shadowSourceKind("model.stream.completed")).toBe("model");
    expect(shadowSourceKind("usage.updated")).toBe("model");
    expect(shadowSourceKind("session.created")).toBe("runtime");
    expect(shadowSourceKind("operation.failed")).toBe("runtime");
  });
});
