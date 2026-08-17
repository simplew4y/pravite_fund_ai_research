import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { SessionEvent } from "@private-fund/contracts";
import { createControlRepositories } from "@private-fund/db";

import type { ApiConfig } from "./config.js";
import { createApiRuntime, type ApiRuntime } from "./main.js";

const WORKER_ENTRY = fileURLToPath(
  new URL("../test/fixtures/fake-agent-worker.mjs", import.meta.url),
);
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
  };
}

async function eventuallyEvents(
  runtime: ApiRuntime,
  sessionId: string,
  accept: (events: SessionEvent[]) => boolean,
): Promise<SessionEvent[]> {
  const deadline = Date.now() + 3_000;
  let events: SessionEvent[] = [];
  do {
    const response = await runtime.app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/events?stream=0&limit=10000`,
    });
    expect(response.statusCode, response.body).toBe(200);
    events = response.json<{ events: SessionEvent[] }>().events;
    if (accept(events)) {
      return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error(
    `Timed out waiting for session events: ${events.map((event) => event.type).join(", ")}`,
  );
}

async function readSseUntil(
  runtime: ApiRuntime,
  sessionId: string,
  after: number,
  accept: (events: SessionEvent[]) => boolean,
): Promise<SessionEvent[]> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 3_000);
  const response = await runtime.app.inject({
    method: "GET",
    url: `/v1/sessions/${sessionId}/events`,
    headers: {
      accept: "text/event-stream",
      "last-event-id": String(after),
    },
    payloadAsStream: true,
    signal: abort.signal,
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toContain(
    "text/event-stream",
  );

  const events: SessionEvent[] = [];
  let buffer = "";
  try {
    for await (const chunk of response.stream()) {
      buffer += Buffer.from(chunk).toString("utf8").replace(
        /\r\n|\r/g,
        "\n",
      );
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = frame.split("\n");
        const id = lines
          .find((line) => line.startsWith("id:"))
          ?.slice(3)
          .trim();
        const eventType = lines
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim();
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) {
          const event = JSON.parse(data) as SessionEvent;
          expect(id).toBe(String(event.sequence));
          expect(eventType).toBe(event.type);
          expect(event.sequence).toBeGreaterThan(after);
          const previous = events.at(-1);
          if (previous !== undefined) {
            expect(event.sequence).toBe(previous.sequence + 1);
          }
          events.push(event);
        }
        if (accept(events)) {
          return events;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    clearTimeout(timeout);
    abort.abort();
  }
  throw new Error("SSE stream ended before the expected event");
}

describe("canonical session HTTP and SSE control plane", () => {
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

  it("creates, lists, gets and forks non-empty sessions without crossing tenants", async () => {
    dataRoot = await mkdtemp(
      path.join(tmpdir(), "pf-session-control-"),
    );
    runtime = await createApiRuntime(
      configFor(dataRoot, "alpha-user", ALPHA_NAMESPACE),
    );

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
    const project = projectResponse.json<{ id: string }>();

    const createResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        projectId: project.id,
        title: "Base investment case",
        model: "synthetic-research-model",
      },
    });
    expect(createResponse.statusCode, createResponse.body).toBe(201);
    const source = createResponse.json<{
      id: string;
      projectId: string;
      title: string;
      forkedFromSessionId: string | null;
      lastSequence: number;
    }>();
    expect(source).toMatchObject({
      projectId: project.id,
      title: "Base investment case",
      forkedFromSessionId: null,
      lastSequence: 1,
    });

    const promptResponse = await runtime.app.inject({
      method: "POST",
      url: `/v1/sessions/${source.id}/messages`,
      payload: {
        content: "Build a non-empty downside thesis",
        clientMessageId: "session-acceptance-message-1",
      },
    });
    expect(promptResponse.statusCode, promptResponse.body).toBe(202);
    await eventuallyEvents(runtime, source.id, (events) =>
      events.some((event) => event.type === "operation.completed"),
    );

    const listResponse = await runtime.app.inject({
      method: "GET",
      url: `/v1/sessions?projectId=${project.id}`,
    });
    expect(listResponse.statusCode, listResponse.body).toBe(200);
    expect(listResponse.json()).toMatchObject({
      sessions: [
        {
          id: source.id,
          projectId: project.id,
          title: "Base investment case",
          status: "idle",
        },
      ],
    });

    const getResponse = await runtime.app.inject({
      method: "GET",
      url: `/v1/sessions/${source.id}`,
    });
    expect(getResponse.statusCode, getResponse.body).toBe(200);
    expect(getResponse.json()).toMatchObject({
      id: source.id,
      projectId: project.id,
      title: "Base investment case",
      status: "idle",
    });

    const forkResponse = await runtime.app.inject({
      method: "POST",
      url: `/v1/sessions/${source.id}/fork`,
      payload: {
        title: "Downside fork",
        model: "synthetic-downside-model",
      },
    });
    expect(forkResponse.statusCode, forkResponse.body).toBe(201);
    const fork = forkResponse.json<{
      id: string;
      projectId: string;
      title: string;
      forkedFromSessionId: string | null;
      lastSequence: number;
    }>();
    expect(fork).toMatchObject({
      projectId: project.id,
      title: "Downside fork",
      forkedFromSessionId: source.id,
    });
    expect(fork.lastSequence).toBeGreaterThan(1);

    const forkReplay = await eventuallyEvents(
      runtime,
      fork.id,
      (events) =>
        events.some(
          (event) =>
            event.type === "message.user" &&
            event.payload["content"] ===
              "Build a non-empty downside thesis",
        ),
    );
    expect(forkReplay.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "session.created",
        "message.user",
        "message.assistant.delta",
        "session.forked",
      ]),
    );

    await runtime.close();
    runtime = await createApiRuntime(
      configFor(dataRoot, "beta-user", BETA_NAMESPACE),
    );

    const betaList = await runtime.app.inject({
      method: "GET",
      url: "/v1/sessions",
    });
    expect(betaList.statusCode, betaList.body).toBe(200);
    expect(betaList.json()).toEqual({ sessions: [] });

    for (const request of [
      {
        method: "GET" as const,
        url: `/v1/sessions/${source.id}`,
      },
      {
        method: "GET" as const,
        url: `/v1/sessions/${source.id}/events?stream=0`,
      },
      {
        method: "POST" as const,
        url: `/v1/sessions/${source.id}/fork`,
        payload: {},
      },
      {
        method: "POST" as const,
        url: `/v1/sessions/${source.id}/compact`,
        payload: {},
      },
    ]) {
      const response = await runtime.app.inject(request);
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(
        404,
      );
    }
  });

  it("resumes SSE from Last-Event-ID and reconciles compaction after a control-plane restart", async () => {
    dataRoot = await mkdtemp(
      path.join(tmpdir(), "pf-session-recovery-"),
    );
    const alphaConfig = configFor(
      dataRoot,
      "alpha-user",
      ALPHA_NAMESPACE,
    );
    runtime = await createApiRuntime(alphaConfig);

    const projectResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Restart-safe research" },
    });
    const project = projectResponse.json<{ id: string }>();
    const sessionResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        projectId: project.id,
        title: "Durable event session",
      },
    });
    const session = sessionResponse.json<{ id: string }>();
    const promptResponse = await runtime.app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/messages`,
      payload: {
        content: "Persist the terminal event",
        clientMessageId: "terminal-replay-message",
      },
    });
    expect(promptResponse.statusCode, promptResponse.body).toBe(202);
    const terminalReplay = await eventuallyEvents(
      runtime,
      session.id,
      (events) =>
        events.some((event) => event.type === "operation.completed"),
    );
    const terminal = terminalReplay.find(
      (event) => event.type === "operation.completed",
    );
    if (terminal === undefined) {
      throw new Error("Expected a terminal operation event");
    }
    const cursor = terminal.sequence - 1;

    await runtime.close();
    runtime = await createApiRuntime(alphaConfig);
    const resumed = await readSseUntil(
      runtime,
      session.id,
      cursor,
      (events) =>
        events.some(
          (event) =>
            event.sequence === terminal.sequence &&
            event.type === "operation.completed",
        ),
    );
    expect(resumed[0]?.sequence).toBeGreaterThan(cursor);
    expect(resumed).toContainEqual(terminal);

    const compactResponse = await runtime.app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/compact`,
      payload: {
        customInstructions: "simulate-control-plane-crash",
      },
    });
    expect(compactResponse.statusCode, compactResponse.body).toBe(202);
    const interruptedCompaction = await eventuallyEvents(
      runtime,
      session.id,
      (events) =>
        events.some((event) => event.type === "compaction.started"),
    );
    const started = interruptedCompaction.findLast(
      (event) => event.type === "compaction.started",
    );
    if (started === undefined) {
      throw new Error("Expected compaction.started");
    }
    expect(
      interruptedCompaction
        .filter((event) => event.sequence > started.sequence)
        .some(
          (event) =>
            event.type === "compaction.completed" ||
            event.type === "compaction.failed",
        ),
    ).toBe(false);
    const messageWhileCompacting = await runtime.app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/messages`,
      payload: {
        content: "This must not race the compaction",
        clientMessageId: "message-during-compaction",
      },
    });
    expect(messageWhileCompacting.statusCode).toBe(409);
    expect(messageWhileCompacting.json()).toMatchObject({
      error: "session_busy",
    });
    const duplicateCompact = await runtime.app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/compact`,
      payload: {},
    });
    expect(duplicateCompact.statusCode).toBe(409);
    expect(duplicateCompact.json()).toMatchObject({
      error: "session_busy",
    });

    await runtime.close();
    runtime = await createApiRuntime(alphaConfig);
    const recoveredSession = await runtime.app.inject({
      method: "GET",
      url: `/v1/sessions/${session.id}`,
    });
    expect(recoveredSession.statusCode, recoveredSession.body).toBe(200);
    const recovered = await eventuallyEvents(
      runtime,
      session.id,
      (events) =>
        events.some(
          (event) =>
            event.type === "compaction.failed" &&
            event.payload["reason"] === "control_plane_restart",
        ),
    );
    const recoveredTerminal = recovered.find(
      (event) =>
        event.type === "compaction.failed" &&
        event.payload["reason"] === "control_plane_restart",
    );
    if (recoveredTerminal === undefined) {
      throw new Error("Expected a recovered compaction terminal");
    }
    expect(recoveredTerminal.payload).toMatchObject({
      recoverable: true,
      requestedSequence: started.sequence - 1,
    });

    const retryResponse = await runtime.app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/compact`,
      payload: {
        customInstructions: "Preserve Evidence references",
      },
    });
    expect(retryResponse.statusCode, retryResponse.body).toBe(202);
    const completed = await eventuallyEvents(
      runtime,
      session.id,
      (events) =>
        events.some(
          (event) =>
            event.sequence > recoveredTerminal.sequence &&
            event.type === "compaction.completed",
        ),
    );
    expect(
      completed
        .filter(
          (event) => event.sequence > recoveredTerminal.sequence,
        )
        .map((event) => event.type),
    ).toEqual(
      expect.arrayContaining([
        "compaction.requested",
        "compaction.started",
        "compaction.completed",
      ]),
    );
  });

  it("backpressures overlapping turns and recovers the durable operation after restart", async () => {
    dataRoot = await mkdtemp(
      path.join(tmpdir(), "pf-session-operation-recovery-"),
    );
    const alphaConfig = configFor(
      dataRoot,
      "alpha-user",
      ALPHA_NAMESPACE,
    );
    runtime = await createApiRuntime(alphaConfig);

    const projectResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Operation recovery" },
    });
    const project = projectResponse.json<{ id: string }>();
    const sessionResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { projectId: project.id, title: "Backpressured session" },
    });
    const session = sessionResponse.json<{ id: string }>();

    const first = await runtime.app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/messages`,
      payload: {
        content: "Hold after acknowledge",
        clientMessageId: "held-turn",
      },
    });
    expect(first.statusCode, first.body).toBe(202);
    const operation = first.json<{ operationId: string }>();

    const idempotentReplay = await runtime.app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/messages`,
      payload: {
        content: "Hold after acknowledge",
        clientMessageId: "held-turn",
      },
    });
    expect(idempotentReplay.statusCode, idempotentReplay.body).toBe(202);
    expect(idempotentReplay.json()).toEqual(operation);

    const overlap = await runtime.app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/messages`,
      payload: {
        content: "This turn must not overlap",
        clientMessageId: "overlapping-turn",
      },
    });
    expect(overlap.statusCode, overlap.body).toBe(409);
    expect(overlap.json()).toMatchObject({ error: "session_busy" });

    await runtime.close();
    runtime = await createApiRuntime(alphaConfig);
    const recoveredSession = await runtime.app.inject({
      method: "GET",
      url: `/v1/sessions/${session.id}`,
    });
    expect(recoveredSession.statusCode, recoveredSession.body).toBe(200);
    expect(recoveredSession.json()).toMatchObject({ status: "failed" });
    const recoveredOperation = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/sessions/${session.id}/operations/` +
        operation.operationId,
    });
    expect(
      recoveredOperation.statusCode,
      recoveredOperation.body,
    ).toBe(200);
    expect(recoveredOperation.json()).toMatchObject({
      id: operation.operationId,
      status: "failed",
      error:
        "Control plane restarted before the agent operation emitted a terminal event",
    });
    const recoveredEvents = await eventuallyEvents(
      runtime,
      session.id,
      (events) =>
        events.some(
          (event) =>
            event.type === "operation.failed" &&
            event.operationId === operation.operationId &&
            event.payload["reason"] === "control_plane_restart",
        ),
    );
    expect(
      recoveredEvents.find(
        (event) =>
          event.type === "operation.failed" &&
          event.operationId === operation.operationId,
      )?.payload,
    ).toMatchObject({
      reason: "control_plane_restart",
      recoverable: true,
    });

    const retry = await runtime.app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/messages`,
      payload: {
        content: "Complete after recovery",
        clientMessageId: "post-recovery-turn",
      },
    });
    expect(retry.statusCode, retry.body).toBe(202);
    await eventuallyEvents(
      runtime,
      session.id,
      (events) =>
        events.some(
          (event) =>
            event.type === "operation.completed" &&
            event.operationId ===
              retry.json<{ operationId: string }>().operationId,
        ),
    );
  });

  it("sustains concurrent session waves without dropping or crossing durable events", async () => {
    dataRoot = await mkdtemp(
      path.join(tmpdir(), "pf-session-concurrency-"),
    );
    runtime = await createApiRuntime(
      configFor(dataRoot, "alpha-user", ALPHA_NAMESPACE),
    );
    const projectResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Concurrent Pi control plane" },
    });
    const project = projectResponse.json<{ id: string }>();
    const sessionCount = 16;
    const waveCount = 4;
    const sessions = await Promise.all(
      Array.from({ length: sessionCount }, async (_, index) => {
        const response = await runtime!.app.inject({
          method: "POST",
          url: "/v1/sessions",
          payload: {
            projectId: project.id,
            title: `Concurrent session ${String(index)}`,
          },
        });
        expect(response.statusCode, response.body).toBe(201);
        return response.json<{ id: string }>();
      }),
    );

    for (let wave = 0; wave < waveCount; wave += 1) {
      const accepted = await Promise.all(
        sessions.map(async (session, index) => {
          const nonce =
            `load:${session.id}:session:${String(index)}:` +
            `wave:${String(wave)}`;
          const response = await runtime!.app.inject({
            method: "POST",
            url: `/v1/sessions/${session.id}/messages`,
            payload: {
              content: nonce,
              clientMessageId: `load-${String(index)}-${String(wave)}`,
            },
          });
          expect(response.statusCode, response.body).toBe(202);
          return {
            session,
            nonce,
            operationId: response.json<{ operationId: string }>()
              .operationId,
          };
        }),
      );
      await Promise.all(
        accepted.map(({ session, operationId }) =>
          eventuallyEvents(
            runtime!,
            session.id,
            (events) =>
              events.some(
                (event) =>
                  event.type === "operation.completed" &&
                  event.operationId === operationId,
              ),
          ),
        ),
      );
    }

    const allNonces = new Set(
      sessions.flatMap((session, index) =>
        Array.from(
          { length: waveCount },
          (_, wave) =>
            `load:${session.id}:session:${String(index)}:` +
            `wave:${String(wave)}`,
        ),
      ),
    );
    for (const [index, session] of sessions.entries()) {
      const events = await eventuallyEvents(
        runtime,
        session.id,
        (candidate) =>
          candidate.filter(
            (event) => event.type === "operation.completed",
          ).length === waveCount,
      );
      const messages = events
        .filter((event) => event.type === "message.user")
        .map((event) => String(event.payload["content"]));
      expect(messages).toEqual(
        Array.from(
          { length: waveCount },
          (_, wave) =>
            `load:${session.id}:session:${String(index)}:` +
            `wave:${String(wave)}`,
        ),
      );
      expect(
        messages.every(
          (message) =>
            allNonces.has(message) &&
            message.includes(`load:${session.id}:`),
        ),
      ).toBe(true);
    }
  }, 15_000);

  it("pages an SSE catch-up beyond the repository replay limit without gaps", async () => {
    dataRoot = await mkdtemp(
      path.join(tmpdir(), "pf-session-sse-backlog-"),
    );
    runtime = await createApiRuntime(
      configFor(dataRoot, "alpha-user", ALPHA_NAMESPACE),
    );
    const projectResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Large durable replay" },
    });
    const project = projectResponse.json<{ id: string }>();
    const sessionResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        projectId: project.id,
        title: "Five-thousand-event replay",
      },
    });
    const session = sessionResponse.json<{ id: string }>();

    const repositories = createControlRepositories(runtime.database);
    for (let index = 0; index < 5_005; index += 1) {
      repositories.sessionEvents.appendForTenant(ALPHA_NAMESPACE, {
        sessionId: session.id,
        type: "test.backlog",
        payload: { index },
      });
    }

    const events = await readSseUntil(
      runtime,
      session.id,
      1,
      (received) =>
        received.at(-1)?.payload["index"] === 5_004,
    );
    expect(events).toHaveLength(5_005);
    expect(events[0]).toMatchObject({
      sequence: 2,
      type: "test.backlog",
      payload: { index: 0 },
    });
    expect(events.at(-1)).toMatchObject({
      sequence: 5_006,
      type: "test.backlog",
      payload: { index: 5_004 },
    });
  });
});
