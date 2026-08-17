import { afterEach, describe, expect, it } from "vitest";

import {
  ConflictError,
  NotFoundError,
} from "@private-fund/core";

import {
  createControlRepositories,
  formatSessionEventAsSse,
  openControlDatabase,
  runMigrations,
  withTransaction,
  type ControlDatabase,
} from "../src/index.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const FIXED_TIME = "2026-07-30T10:00:00.000Z";

describe("control database repositories", () => {
  let database: ControlDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  function setup() {
    database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(
      database,
      () => new Date(FIXED_TIME),
    );
    repositories.users.upsertCloudShadow({
      userId: "cloud-user-a",
      dataNamespace: TENANT_A,
      email: "a@example.com",
    });
    repositories.users.upsertCloudShadow({
      userId: "cloud-user-b",
      dataNamespace: TENANT_B,
      email: "b@example.com",
    });
    return repositories;
  }

  it("runs migrations idempotently and creates the requested control tables", () => {
    database = openControlDatabase(":memory:");
    const first = runMigrations(database);
    const second = runMigrations(database);
    expect(first).toEqual(second);

    const tables = database
      .prepare(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'table'
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "jobs",
        "legacy_business_job_reconciliation",
        "operations",
        "projects",
        "schema_migrations",
        "session_events",
        "session_journal_events",
        "session_journal_heads",
        "session_journal_outbox",
        "sessions",
        "users",
      ]),
    );
    expect(first).toContainEqual(
      expect.objectContaining({
        version: 6,
        name: "legacy_business_job_reconciliation",
      }),
    );
    expect(first).toContainEqual(
      expect.objectContaining({
        version: 7,
        name: "recoverable_project_tombstones",
      }),
    );
    expect(first).toContainEqual(
      expect.objectContaining({
        version: 8,
        name: "append_only_session_journal",
      }),
    );
  });

  it("upserts a stable cloud shadow without allowing namespace reassignment", () => {
    const repositories = setup();
    const original = repositories.users.getById("cloud-user-a");
    const updated = repositories.users.upsertCloudShadow({
      userId: "cloud-user-a",
      dataNamespace: TENANT_A,
      email: "new@example.com",
    });
    expect(updated.id).toBe(original.id);
    expect(updated.dataNamespace).toBe(TENANT_A);
    expect(updated.email).toBe("new@example.com");

    expect(() =>
      repositories.users.upsertCloudShadow({
        userId: "cloud-user-a",
        dataNamespace: TENANT_B,
      }),
    ).toThrow(ConflictError);
  });

  it("enforces tenant ownership for projects and sessions", () => {
    const repositories = setup();
    const project = repositories.projects.createForTenant(TENANT_A, {
      id: "project-a",
      name: "Tenant A project",
    });
    const session = repositories.sessions.createForTenant(TENANT_A, {
      id: "session-a",
      projectId: project.id,
      title: "Research",
    });

    expect(
      repositories.projects.getForTenant(TENANT_A, project.id).id,
    ).toBe(project.id);
    expect(
      repositories.sessions.getForTenant(TENANT_A, session.id).lastSequence,
    ).toBe(1);
    expect(() =>
      repositories.projects.getForTenant(TENANT_B, project.id),
    ).toThrow(NotFoundError);
    expect(() =>
      repositories.sessions.getForTenant(TENANT_B, session.id),
    ).toThrow(NotFoundError);
    expect(() =>
      repositories.sessions.createForTenant(TENANT_B, {
        projectId: project.id,
      }),
    ).toThrow(NotFoundError);
  });

  it("lists only direct tenant-owned fork children with bounded lifecycle pagination", () => {
    const repositories = setup();
    const projectA = repositories.projects.createForTenant(TENANT_A, {
      id: "project-a",
      name: "Tenant A project",
    });
    const otherProjectA = repositories.projects.createForTenant(TENANT_A, {
      id: "project-a-other",
      name: "Tenant A other project",
    });
    const projectB = repositories.projects.createForTenant(TENANT_B, {
      id: "project-b",
      name: "Tenant B project",
    });
    const parent = repositories.sessions.createForTenant(TENANT_A, {
      id: "session-parent",
      projectId: projectA.id,
    });
    const activeChild = repositories.sessions.createForTenant(TENANT_A, {
      id: "session-child-a",
      projectId: projectA.id,
      forkedFromSessionId: parent.id,
    });
    const archivedChild = repositories.sessions.createForTenant(TENANT_A, {
      id: "session-child-b",
      projectId: projectA.id,
      forkedFromSessionId: parent.id,
    });
    repositories.sessions.setArchivedForTenant(
      TENANT_A,
      archivedChild.id,
      true,
    );
    repositories.sessions.createForTenant(TENANT_A, {
      id: "session-grandchild",
      projectId: projectA.id,
      forkedFromSessionId: activeChild.id,
    });
    const deletedChild = repositories.sessions.createForTenant(TENANT_A, {
      id: "session-child-deleted",
      projectId: projectA.id,
      forkedFromSessionId: parent.id,
    });
    repositories.sessions.markDeletedForTenant(TENANT_A, deletedChild.id);

    const all = repositories.sessions.listChildrenForTenant(
      TENANT_A,
      parent.id,
      { limit: 1, offset: 0, includeArchived: true },
    );
    expect(all.total).toBe(2);
    expect(all.items).toHaveLength(1);
    expect(all.items[0]?.forkedFromSessionId).toBe(parent.id);
    const active = repositories.sessions.listChildrenForTenant(
      TENANT_A,
      parent.id,
      { limit: 500, offset: 0, includeArchived: false },
    );
    expect(active.total).toBe(1);
    expect(active.items.map((session) => session.id)).toEqual([
      activeChild.id,
    ]);

    expect(() =>
      repositories.sessions.listChildrenForTenant(
        TENANT_B,
        parent.id,
        { limit: 100, offset: 0, includeArchived: true },
      ),
    ).toThrow(NotFoundError);
    expect(() =>
      repositories.sessions.listChildrenForTenant(
        TENANT_A,
        "session-missing",
        { limit: 100, offset: 0, includeArchived: true },
      ),
    ).toThrow(NotFoundError);

    const foreignParent = repositories.sessions.createForTenant(TENANT_B, {
      id: "session-foreign-parent",
      projectId: projectB.id,
    });
    expect(() =>
      repositories.sessions.createForTenant(TENANT_A, {
        id: "session-forged-cross-tenant-child",
        projectId: projectA.id,
        forkedFromSessionId: foreignParent.id,
      }),
    ).toThrow(NotFoundError);
    expect(() =>
      database!
        .prepare(
          `INSERT INTO sessions(
             id, user_id, project_id, forked_from_session_id,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "session-direct-cross-tenant-child",
          "cloud-user-a",
          projectA.id,
          foreignParent.id,
          FIXED_TIME,
          FIXED_TIME,
        ),
    ).toThrow(/session_fork_source_mismatch/);
    expect(() =>
      repositories.sessions.createForTenant(TENANT_A, {
        id: "session-cross-project-child",
        projectId: otherProjectA.id,
        forkedFromSessionId: parent.id,
      }),
    ).toThrow(ConflictError);
    expect(() =>
      database!
        .prepare(
          "UPDATE sessions SET forked_from_session_id = NULL WHERE id = ?",
        )
        .run(activeChild.id),
    ).toThrow(/session_fork_lineage_is_immutable/);
  });

  it("appends monotonic events and replays after an SSE cursor", () => {
    const repositories = setup();
    const project = repositories.projects.createForTenant(TENANT_A, {
      id: "project-a",
      name: "Tenant A project",
    });
    const session = repositories.sessions.createForTenant(TENANT_A, {
      id: "session-a",
      projectId: project.id,
    });
    const second = repositories.sessionEvents.appendForTenant(TENANT_A, {
      sessionId: session.id,
      type: "message.user",
      payload: { content: "hello" },
    });
    const third = repositories.sessionEvents.appendForTenant(TENANT_A, {
      sessionId: session.id,
      type: "message.assistant.completed",
      payload: { content: "world" },
    });

    expect(second.sequence).toBe(2);
    expect(third.sequence).toBe(3);
    expect(
      repositories.sessionEvents
        .replayForTenant(TENANT_A, session.id, 1, 10)
        .map((event) => event.sequence),
    ).toEqual([2, 3]);
    expect(
      repositories.sessions.getForTenant(TENANT_A, session.id).lastSequence,
    ).toBe(3);
    expect(formatSessionEventAsSse(third)).toContain(
      "event: message.assistant.completed\n",
    );
    expect(() =>
      repositories.sessionEvents.replayForTenant(
        TENANT_B,
        session.id,
        0,
        10,
      ),
    ).toThrow(NotFoundError);
  });

  it("deduplicates operations and rejects idempotency-key reuse", () => {
    const repositories = setup();
    const project = repositories.projects.createForTenant(TENANT_A, {
      id: "project-a",
      name: "Tenant A project",
    });
    const session = repositories.sessions.createForTenant(TENANT_A, {
      id: "session-a",
      projectId: project.id,
    });

    const first = repositories.operations.createForTenant(TENANT_A, {
      sessionId: session.id,
      kind: "prompt",
      idempotencyKey: "message-1",
      request: { content: "hello", nested: { b: 2, a: 1 } },
    });
    const duplicate = repositories.operations.createForTenant(TENANT_A, {
      sessionId: session.id,
      kind: "prompt",
      idempotencyKey: "message-1",
      request: { nested: { a: 1, b: 2 }, content: "hello" },
    });
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.operation.id).toBe(first.operation.id);

    expect(() =>
      repositories.operations.createForTenant(TENANT_A, {
        sessionId: session.id,
        kind: "prompt",
        idempotencyKey: "message-1",
        request: { content: "different" },
      }),
    ).toThrow(ConflictError);

    const running = repositories.operations.markRunningForTenant(
      TENANT_A,
      first.operation.id,
    );
    expect(running.status).toBe("running");
    const completed = repositories.operations.completeForTenant(
      TENANT_A,
      first.operation.id,
      { answer: "done" },
    );
    expect(completed.status).toBe("completed");
    expect(completed.result).toEqual({ answer: "done" });
    expect(() =>
      repositories.operations.completeForTenant(
        TENANT_A,
        first.operation.id,
        { answer: "different" },
      ),
    ).toThrow(ConflictError);
  });

  it("rolls back both top-level transactions and nested savepoints", () => {
    const repositories = setup();
    expect(() =>
      withTransaction(database!, () => {
        repositories.users.create({
          id: "rolled-back",
          dataNamespace: "33333333-3333-4333-8333-333333333333",
        });
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(repositories.users.findById("rolled-back")).toBeNull();

    withTransaction(database!, () => {
      repositories.users.create({
        id: "outer",
        dataNamespace: "44444444-4444-4444-8444-444444444444",
      });
      expect(() =>
        withTransaction(database!, () => {
          repositories.users.create({
            id: "inner",
            dataNamespace: "55555555-5555-4555-8555-555555555555",
          });
          throw new Error("savepoint rollback");
        }),
      ).toThrow("savepoint rollback");
    });
    expect(repositories.users.findById("outer")).not.toBeNull();
    expect(repositories.users.findById("inner")).toBeNull();
  });
});
