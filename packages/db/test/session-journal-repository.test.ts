import { afterEach, describe, expect, it } from "vitest";

import { ConflictError, NotFoundError } from "@private-fund/core";

import {
  createControlRepositories,
  openControlDatabase,
  type ControlDatabase,
  type ControlRepositories,
} from "../src/index.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const FIXED_TIME = "2026-08-16T12:00:00.000Z";

describe("SessionJournalRepository", () => {
  let database: ControlDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  function setup(): {
    readonly repositories: ControlRepositories;
    readonly sessionA: string;
    readonly sessionA2: string;
    readonly sessionB: string;
  } {
    database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(
      database,
      () => new Date(FIXED_TIME),
    );
    repositories.users.upsertCloudShadow({
      userId: "user-a",
      dataNamespace: TENANT_A,
    });
    repositories.users.upsertCloudShadow({
      userId: "user-b",
      dataNamespace: TENANT_B,
    });
    const projectA = repositories.projects.createForTenant(TENANT_A, {
      id: "project-a",
      name: "Project A",
    });
    const projectB = repositories.projects.createForTenant(TENANT_B, {
      id: "project-b",
      name: "Project B",
    });
    const sessionA = repositories.sessions.createForTenant(TENANT_A, {
      id: "session-a",
      projectId: projectA.id,
    });
    const sessionA2 = repositories.sessions.createForTenant(TENANT_A, {
      id: "session-a-2",
      projectId: projectA.id,
    });
    const sessionB = repositories.sessions.createForTenant(TENANT_B, {
      id: "session-b",
      projectId: projectB.id,
    });
    return {
      repositories,
      sessionA: sessionA.id,
      sessionA2: sessionA2.id,
      sessionB: sessionB.id,
    };
  }

  it("appends, replays, and verifies a deterministic hash chain", () => {
    const { repositories, sessionA } = setup();
    const operation = repositories.operations.createForTenant(TENANT_A, {
      id: "operation-a",
      sessionId: sessionA,
      kind: "agent.turn",
      idempotencyKey: "operation-a",
      request: { prompt: "Analyze" },
    }).operation;

    const first = repositories.sessionJournal.appendForTenant(TENANT_A, {
      eventId: "journal-event-1",
      sessionId: sessionA,
      type: "message.user",
      operationId: operation.id,
      turnId: "turn-1",
      source: { kind: "user", id: "user-a", version: null },
      idempotencyKey: "journal-1",
      classification: "confidential",
      payload: { content: "Analyze the fund" },
    });
    const second = repositories.sessionJournal.appendForTenant(TENANT_A, {
      eventId: "journal-event-2",
      sessionId: sessionA,
      type: "model.request.snapshot",
      operationId: operation.id,
      turnId: "turn-1",
      stepId: "step-1",
      source: { kind: "model", id: "recorded", version: "1" },
      causationEventId: first.event.eventId,
      idempotencyKey: "journal-2",
      classification: "confidential",
      payload: { messages: [{ role: "user", content: "Analyze the fund" }] },
    });

    expect(first.created).toBe(true);
    expect(first.event.sequence).toBe(1);
    expect(first.event.previousHash).toBeNull();
    expect(second.event.sequence).toBe(2);
    expect(second.event.previousHash).toBe(first.event.eventHash);
    expect(second.event.payloadHash).toMatch(/^[0-9a-f]{64}$/);

    expect(
      repositories.sessionJournal.replayForTenant(TENANT_A, sessionA),
    ).toEqual([first.event, second.event]);
    expect(
      repositories.sessionJournal.replayForTenant(TENANT_A, sessionA, 1, 1),
    ).toEqual([second.event]);
    expect(
      repositories.sessionJournal.verifyIntegrityForTenant(TENANT_A, sessionA),
    ).toEqual({
      valid: true,
      eventCount: 2,
      checkedThroughSequence: 2,
      lastEventHash: second.event.eventHash,
      issue: null,
    });
  });

  it("returns the original event for an identical idempotent retry and rejects drift", () => {
    const { repositories, sessionA } = setup();
    const input = {
      eventId: "journal-event-idempotent",
      sessionId: sessionA,
      type: "message.user",
      source: { kind: "user" as const, id: "user-a", version: null },
      idempotencyKey: "journal-idempotent",
      payload: { content: "same" },
    };

    const first = repositories.sessionJournal.appendForTenant(TENANT_A, input);
    const retry = repositories.sessionJournal.appendForTenant(TENANT_A, input);

    expect(first.created).toBe(true);
    expect(retry).toEqual({ event: first.event, created: false });
    expect(() =>
      repositories.sessionJournal.appendForTenant(TENANT_A, {
        ...input,
        payload: { content: "changed" },
      }),
    ).toThrow(ConflictError);
    expect(
      repositories.sessionJournal.replayForTenant(TENANT_A, sessionA),
    ).toHaveLength(1);
  });

  it("enforces Session ownership for tenants, operations, and causation", () => {
    const { repositories, sessionA, sessionA2, sessionB } = setup();
    const foreignOperation = repositories.operations.createForTenant(TENANT_A, {
      id: "operation-other-session",
      sessionId: sessionA2,
      kind: "agent.turn",
      idempotencyKey: "operation-other-session",
    }).operation;

    expect(() =>
      repositories.sessionJournal.appendForTenant(TENANT_A, {
        sessionId: sessionA,
        type: "message.user",
        operationId: foreignOperation.id,
        idempotencyKey: "operation-mismatch",
        payload: {},
      }),
    ).toThrow(ConflictError);
    expect(() =>
      repositories.sessionJournal.appendForTenant(TENANT_A, {
        sessionId: sessionA,
        type: "message.user",
        causationEventId: "missing-event",
        idempotencyKey: "missing-cause",
        payload: {},
      }),
    ).toThrow(ConflictError);
    expect(() =>
      repositories.sessionJournal.replayForTenant(TENANT_B, sessionA),
    ).toThrow(NotFoundError);
    expect(() =>
      repositories.sessionJournal.replayForTenant(TENANT_A, sessionB),
    ).toThrow(NotFoundError);
  });

  it("commits the Journal event, head, and outbox atomically", () => {
    const { repositories, sessionA } = setup();
    database?.exec(`
      CREATE TRIGGER reject_session_journal_outbox
      BEFORE INSERT ON session_journal_outbox
      BEGIN
        SELECT RAISE(ABORT, 'forced_outbox_failure');
      END;
    `);

    expect(() =>
      repositories.sessionJournal.appendForTenant(TENANT_A, {
        sessionId: sessionA,
        type: "message.user",
        idempotencyKey: "atomic-append",
        payload: { content: "must roll back" },
      }),
    ).toThrow(/forced_outbox_failure/);

    const eventCount = database
      ?.prepare(
        "SELECT COUNT(*) AS count FROM session_journal_events WHERE session_id = ?",
      )
      .get(sessionA)?.count;
    const headCount = database
      ?.prepare(
        "SELECT COUNT(*) AS count FROM session_journal_heads WHERE session_id = ?",
      )
      .get(sessionA)?.count;
    expect(eventCount).toBe(0);
    expect(headCount).toBe(0);
  });

  it("tracks outbox delivery attempts without changing the immutable event", () => {
    const { repositories, sessionA } = setup();
    const appended = repositories.sessionJournal.appendForTenant(TENANT_A, {
      sessionId: sessionA,
      type: "message.user",
      idempotencyKey: "outbox-event",
      payload: { content: "publish me" },
    });
    const [pending] = repositories.sessionJournal.listPendingOutbox();

    expect(pending).toMatchObject({
      tenantNamespace: TENANT_A,
      sessionId: sessionA,
      eventId: appended.event.eventId,
      sequence: 1,
      attemptCount: 0,
      deliveredAt: null,
    });
    expect(
      repositories.sessionJournal.recordOutboxFailure(
        pending?.outboxId ?? 0,
        "transient failure",
      ),
    ).toBe(true);
    expect(repositories.sessionJournal.listPendingOutbox()[0]).toMatchObject({
      attemptCount: 1,
      lastError: "transient failure",
    });
    expect(
      repositories.sessionJournal.markOutboxDelivered(pending?.outboxId ?? 0),
    ).toBe(true);
    expect(repositories.sessionJournal.listPendingOutbox()).toEqual([]);
    expect(
      repositories.sessionJournal.markOutboxDelivered(pending?.outboxId ?? 0),
    ).toBe(false);
    expect(
      repositories.sessionJournal.replayForTenant(TENANT_A, sessionA),
    ).toEqual([appended.event]);
  });

  it("rejects mutation and detects corruption if storage protections are bypassed", () => {
    const { repositories, sessionA } = setup();
    repositories.sessionJournal.appendForTenant(TENANT_A, {
      sessionId: sessionA,
      type: "message.user",
      idempotencyKey: "immutable-event",
      payload: { content: "original" },
    });

    expect(() =>
      database
        ?.prepare(
          "UPDATE session_journal_events SET payload_json = ? WHERE session_id = ? AND sequence = 1",
        )
        .run('{"content":"changed"}', sessionA),
    ).toThrow(/session_journal_event_is_immutable/);
    expect(() =>
      database
        ?.prepare(
          "DELETE FROM session_journal_events WHERE session_id = ? AND sequence = 1",
        )
        .run(sessionA),
    ).toThrow(/session_journal_event_is_immutable/);

    database?.exec("DROP TRIGGER session_journal_events_are_immutable");
    database
      ?.prepare(
        "UPDATE session_journal_events SET payload_json = ? WHERE session_id = ? AND sequence = 1",
      )
      .run('{"content":"corrupt"}', sessionA);

    expect(
      repositories.sessionJournal.verifyIntegrityForTenant(TENANT_A, sessionA),
    ).toMatchObject({
      valid: false,
      checkedThroughSequence: 0,
      issue: "payload_hash_mismatch:1",
    });
  });
});
