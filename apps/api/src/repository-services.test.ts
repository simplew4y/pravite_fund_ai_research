import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { TenantIdentity } from "@private-fund/contracts";
import { buildTenantContext } from "@private-fund/core";
import {
  createControlRepositories,
  openControlDatabase,
} from "@private-fund/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AgentEvent,
  AgentWorkerPort,
  StartAgentSessionInput,
} from "./agent-supervisor.js";
import {
  RepositoryJobService,
  RepositoryProjectService,
  RepositorySessionService,
} from "./repository-services.js";

class FakeAgentWorker implements AgentWorkerPort {
  readonly starts: StartAgentSessionInput[] = [];
  readonly prompts: Array<{
    sessionId: string;
    operationId: string;
    content: string;
  }> = [];
  readonly compactions: Array<{
    sessionId: string;
    customInstructions?: string;
  }> = [];
  readonly #listeners = new Set<(event: AgentEvent) => void>();
  readonly #failureListeners = new Set<(error: Error) => void>();

  public async start(input: StartAgentSessionInput): Promise<void> {
    this.starts.push(input);
  }

  public async prompt(
    sessionId: string,
    operationId: string,
    content: string,
  ): Promise<void> {
    this.prompts.push({ sessionId, operationId, content });
  }

  public async steer(): Promise<void> {}

  public async compact(
    sessionId: string,
    customInstructions?: string,
  ): Promise<void> {
    this.compactions.push({
      sessionId,
      ...(customInstructions === undefined
        ? {}
        : { customInstructions }),
    });
  }

  public async interrupt(): Promise<void> {}

  public async dispose(): Promise<void> {}

  public subscribe(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  public subscribeFailure(listener: (error: Error) => void): () => void {
    this.#failureListeners.add(listener);
    return () => {
      this.#failureListeners.delete(listener);
    };
  }

  public async stop(): Promise<void> {}

  public emit(event: AgentEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  public fail(error: Error): void {
    for (const listener of this.#failureListeners) {
      listener(error);
    }
  }
}

const ALPHA: TenantIdentity = {
  userId: "user-alpha",
  dataNamespace: "00000000-0000-4000-8000-0000000000a1",
};
const BETA: TenantIdentity = {
  userId: "user-beta",
  dataNamespace: "00000000-0000-4000-8000-0000000000b2",
};

describe("repository-backed API services", () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-api-services-"));
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("persists, replays and completes an agent operation", async () => {
    const database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(database);
    repositories.users.upsertCloudShadow(ALPHA);
    const worker = new FakeAgentWorker();
    const projects = new RepositoryProjectService(repositories);
    const sessions = new RepositorySessionService({ repositories, worker });
    const tenant = buildTenantContext(dataRoot, ALPHA);

    const project = await projects.create(tenant, { name: "Alpha research" });
    const session = await sessions.create(tenant, {
      projectId: project.id,
      title: "Investment case",
    });
    const received: string[] = [];
    const unsubscribe = sessions.subscribe(tenant, session.id, (event) => {
      received.push(event.type);
    });

    const first = await sessions.sendMessage(tenant, session.id, {
      content: "Analyze the company",
      clientMessageId: "client-message-1",
    });
    const duplicate = await sessions.sendMessage(tenant, session.id, {
      content: "Analyze the company",
      clientMessageId: "client-message-1",
    });

    expect(duplicate).toEqual(first);
    expect(worker.prompts).toHaveLength(1);
    expect(worker.starts[0]?.tenant).toEqual(ALPHA);
    expect(received).toContain("message.user");
    expect(received).toContain("session.status");

    worker.emit({
      type: "agent.event",
      sessionId: session.id,
      operationId: first.operationId,
      eventType: "message.assistant.delta",
      payload: { delta: "Answer" },
    });
    worker.emit({
      type: "agent.event",
      sessionId: session.id,
      operationId: first.operationId,
      eventType: "session.status",
      payload: { status: "idle" },
    });

    const events = await sessions.events(tenant, session.id, 0, 100);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "session.created",
        "message.user",
        "message.assistant.delta",
        "operation.completed",
      ]),
    );
    expect(
      repositories.operations.getForTenant(
        tenant.dataNamespace,
        first.operationId,
      ).status,
    ).toBe("completed");
    expect((await sessions.get(tenant, session.id))?.status).toBe("idle");

    unsubscribe();
    sessions.dispose();
    database.close();
  });

  it("persists one model operation failure and leaves the session failed", async () => {
    const database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(database);
    repositories.users.upsertCloudShadow(ALPHA);
    const worker = new FakeAgentWorker();
    const projects = new RepositoryProjectService(repositories);
    const sessions = new RepositorySessionService({ repositories, worker });
    const tenant = buildTenantContext(dataRoot, ALPHA);
    const project = await projects.create(tenant, { name: "Failed model turn" });
    const session = await sessions.create(tenant, { projectId: project.id });
    const operation = await sessions.sendMessage(tenant, session.id, {
      content: "Analyze the company",
      clientMessageId: "model-failure-turn",
    });

    worker.emit({
      type: "agent.event",
      sessionId: session.id,
      operationId: operation.operationId,
      eventType: "operation.failed",
      payload: { error: "402 insufficient_available_balance" },
    });

    expect(
      repositories.operations.getForTenant(
        tenant.dataNamespace,
        operation.operationId,
      ),
    ).toMatchObject({
      status: "failed",
      error: "402 insufficient_available_balance",
    });
    await expect(sessions.get(tenant, session.id)).resolves.toMatchObject({
      status: "failed",
    });
    const events = await sessions.events(tenant, session.id, 0, 100);
    expect(
      events.filter(
        (event) =>
          event.type === "operation.failed" &&
          event.operationId === operation.operationId,
      ),
    ).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.type === "operation.completed" &&
          event.operationId === operation.operationId,
      ),
    ).toBe(false);

    sessions.dispose();
    database.close();
  });

  it("applies per-session backpressure while preserving idempotent message replay", async () => {
    const database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(database);
    repositories.users.upsertCloudShadow(ALPHA);
    const worker = new FakeAgentWorker();
    const projects = new RepositoryProjectService(repositories);
    const sessions = new RepositorySessionService({ repositories, worker });
    const tenant = buildTenantContext(dataRoot, ALPHA);
    const project = await projects.create(tenant, { name: "Backpressure" });
    const session = await sessions.create(tenant, { projectId: project.id });

    const first = await sessions.sendMessage(tenant, session.id, {
      content: "Run one turn",
      clientMessageId: "message-one",
    });
    await expect(
      sessions.sendMessage(tenant, session.id, {
        content: "Run one turn",
        clientMessageId: "message-one",
      }),
    ).resolves.toEqual(first);
    await expect(
      sessions.sendMessage(tenant, session.id, {
        content: "Do not overlap",
        clientMessageId: "message-two",
      }),
    ).rejects.toMatchObject({ code: "session_busy", statusCode: 409 });
    expect(
      repositories.operations.listForSession(
        tenant.dataNamespace,
        session.id,
      ),
    ).toHaveLength(1);
    expect(worker.prompts).toHaveLength(1);

    sessions.dispose();
    database.close();
  });

  it("durably fails an active turn on Pi worker exit and starts the next turn in a fresh worker session", async () => {
    const database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(database);
    repositories.users.upsertCloudShadow(ALPHA);
    const worker = new FakeAgentWorker();
    const projects = new RepositoryProjectService(repositories);
    const sessions = new RepositorySessionService({ repositories, worker });
    const tenant = buildTenantContext(dataRoot, ALPHA);
    const project = await projects.create(tenant, { name: "Worker recovery" });
    const session = await sessions.create(tenant, { projectId: project.id });

    const first = await sessions.sendMessage(tenant, session.id, {
      content: "Turn before crash",
      clientMessageId: "before-crash",
    });
    worker.fail(new Error("Synthetic Pi worker crash"));

    expect(
      repositories.operations.getForTenant(
        tenant.dataNamespace,
        first.operationId,
      ),
    ).toMatchObject({
      status: "failed",
      error: "Synthetic Pi worker crash",
    });
    await expect(sessions.get(tenant, session.id)).resolves.toMatchObject({
      status: "failed",
    });
    expect(
      (await sessions.events(tenant, session.id, 0, 100)).some(
        (event) =>
          event.type === "operation.failed" &&
          event.operationId === first.operationId &&
          event.payload["reason"] === "agent_worker_exit" &&
          event.payload["recoverable"] === true,
      ),
    ).toBe(true);

    const second = await sessions.sendMessage(tenant, session.id, {
      content: "Turn after crash",
      clientMessageId: "after-crash",
    });
    expect(second.operationId).not.toBe(first.operationId);
    expect(worker.starts).toHaveLength(2);
    expect(worker.prompts).toHaveLength(2);

    sessions.dispose();
    database.close();
  });

  it("reconciles a running operation after a control-plane restart", async () => {
    const database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(database);
    repositories.users.upsertCloudShadow(ALPHA);
    const projects = new RepositoryProjectService(repositories);
    const tenant = buildTenantContext(dataRoot, ALPHA);
    const project = await projects.create(tenant, { name: "API recovery" });
    const firstWorker = new FakeAgentWorker();
    const firstService = new RepositorySessionService({
      repositories,
      worker: firstWorker,
    });
    const session = await firstService.create(tenant, {
      projectId: project.id,
    });
    const operation = await firstService.sendMessage(tenant, session.id, {
      content: "Turn interrupted by restart",
      clientMessageId: "restart-turn",
    });
    firstService.dispose();

    const recoveredService = new RepositorySessionService({
      repositories,
      worker: new FakeAgentWorker(),
    });
    await expect(
      recoveredService.get(tenant, session.id),
    ).resolves.toMatchObject({ status: "failed" });
    expect(
      repositories.operations.getForTenant(
        tenant.dataNamespace,
        operation.operationId,
      ),
    ).toMatchObject({
      status: "failed",
      error:
        "Control plane restarted before the agent operation emitted a terminal event",
    });
    expect(
      (await recoveredService.events(tenant, session.id, 0, 100)).some(
        (event) =>
          event.type === "operation.failed" &&
          event.payload["reason"] === "control_plane_restart" &&
          event.payload["recoverable"] === true,
      ),
    ).toBe(true);

    recoveredService.dispose();
    database.close();
  });

  it("does not expose another tenant's sessions or events", async () => {
    const database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(database);
    repositories.users.upsertCloudShadow(ALPHA);
    repositories.users.upsertCloudShadow(BETA);
    const worker = new FakeAgentWorker();
    const projects = new RepositoryProjectService(repositories);
    const sessions = new RepositorySessionService({ repositories, worker });
    const alpha = buildTenantContext(dataRoot, ALPHA);
    const beta = buildTenantContext(dataRoot, BETA);

    const project = await projects.create(alpha, { name: "Private project" });
    const session = await sessions.create(alpha, { projectId: project.id });

    await expect(sessions.get(beta, session.id)).resolves.toBeNull();
    await expect(sessions.events(beta, session.id, 0, 100)).rejects.toMatchObject(
      { code: "not_found" },
    );

    sessions.dispose();
    database.close();
  });

  it("projects tenant-safe fork lineage and canonical labels without runtime metadata", async () => {
    const database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(database);
    repositories.users.upsertCloudShadow(ALPHA);
    repositories.users.upsertCloudShadow(BETA);
    const worker = new FakeAgentWorker();
    const projects = new RepositoryProjectService(repositories);
    const sessions = new RepositorySessionService({ repositories, worker });
    const alpha = buildTenantContext(dataRoot, ALPHA);
    const beta = buildTenantContext(dataRoot, BETA);

    const project = await projects.create(alpha, { name: "Lineage" });
    const parent = await sessions.create(alpha, {
      projectId: project.id,
      title: "Root",
    });
    const child = await sessions.fork(alpha, parent.id, {
      title: "Scenario fork",
    });
    await sessions.update(alpha, child.id, { archived: true });

    await expect(
      sessions.children(alpha, parent.id, {
        limit: 100,
        offset: 0,
        includeArchived: true,
      }),
    ).resolves.toMatchObject({
      parentSessionId: parent.id,
      total: 1,
      hasMore: false,
      items: [
        expect.objectContaining({
          id: child.id,
          forkedFromSessionId: parent.id,
        }),
      ],
    });
    await expect(
      sessions.children(alpha, parent.id, {
        limit: 100,
        offset: 0,
        includeArchived: false,
      }),
    ).resolves.toMatchObject({ total: 0, items: [] });
    await expect(sessions.labels(alpha, child.id)).resolves.toEqual({
      id: child.id,
      labels: {
        "private_fund.project_id": project.id,
        "private_fund.lifecycle": "archived",
        "private_fund.lineage": "fork",
        "private_fund.forked_from_session_id": parent.id,
      },
    });

    for (const tenant of [beta]) {
      await expect(
        sessions.children(tenant, parent.id, {
          limit: 100,
          offset: 0,
          includeArchived: true,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        sessions.labels(tenant, child.id),
      ).rejects.toMatchObject({ code: "not_found" });
    }
    await expect(
      sessions.children(alpha, "session-missing", {
        limit: 100,
        offset: 0,
        includeArchived: true,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      sessions.labels(alpha, "session-missing"),
    ).rejects.toMatchObject({ code: "not_found" });

    sessions.dispose();
    database.close();
  });

  it("starts Pi compaction only for an idle tenant session and persists its events", async () => {
    const database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(database);
    repositories.users.upsertCloudShadow(ALPHA);
    repositories.users.upsertCloudShadow(BETA);
    const worker = new FakeAgentWorker();
    const projects = new RepositoryProjectService(repositories);
    const sessions = new RepositorySessionService({ repositories, worker });
    const alpha = buildTenantContext(dataRoot, ALPHA);
    const beta = buildTenantContext(dataRoot, BETA);
    const project = await projects.create(alpha, { name: "Compact project" });
    const session = await sessions.create(alpha, { projectId: project.id });

    await expect(
      sessions.compact(beta, session.id, "Preserve evidence references"),
    ).rejects.toMatchObject({ code: "not_found" });

    await sessions.compact(
      alpha,
      session.id,
      "Preserve evidence references",
    );
    expect(worker.compactions).toEqual([
      {
        sessionId: session.id,
        customInstructions: "Preserve evidence references",
      },
    ]);

    worker.emit({
      type: "agent.event",
      sessionId: session.id,
      operationId: null,
      eventType: "compaction.started",
      payload: { reason: "manual" },
    });
    worker.emit({
      type: "agent.event",
      sessionId: session.id,
      operationId: null,
      eventType: "compaction.completed",
      payload: { reason: "manual", aborted: false },
    });
    expect(
      (await sessions.events(alpha, session.id, 0, 100)).map(
        (event) => event.type,
      ),
    ).toEqual(
      expect.arrayContaining([
        "compaction.started",
        "compaction.completed",
      ]),
    );

    sessions.dispose();
    database.close();
  });

  it("renames, archives, forks and tombstones Pi sessions without crossing tenants", async () => {
    const database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(database);
    repositories.users.upsertCloudShadow(ALPHA);
    repositories.users.upsertCloudShadow(BETA);
    const worker = new FakeAgentWorker();
    const projects = new RepositoryProjectService(repositories);
    const sessions = new RepositorySessionService({ repositories, worker });
    const alpha = buildTenantContext(dataRoot, ALPHA);
    const beta = buildTenantContext(dataRoot, BETA);
    const project = await projects.create(alpha, {
      name: "Session lifecycle",
    });
    const source = await sessions.create(alpha, {
      projectId: project.id,
      title: "Original",
    });
    const sourceRecord = repositories.sessions.getForTenant(
      alpha.dataNamespace,
      source.id,
    );
    await writeFile(
      sourceRecord.piSessionFile!,
      '{"type":"session","id":"runtime-original"}\n',
      { flag: "wx", mode: 0o600 },
    );
    repositories.sessionEvents.appendForTenant(alpha.dataNamespace, {
      sessionId: source.id,
      type: "message.user",
      payload: { content: "Preserve this history" },
    });

    await expect(
      sessions.fork(beta, source.id, {}),
    ).rejects.toMatchObject({ code: "not_found" });
    const fork = await sessions.fork(alpha, source.id, {
      title: "Scenario fork",
    });
    expect(fork).toMatchObject({
      projectId: project.id,
      title: "Scenario fork",
      forkedFromSessionId: source.id,
      archivedAt: null,
    });
    const forkRecord = repositories.sessions.getForTenant(
      alpha.dataNamespace,
      fork.id,
    );
    await expect(readFile(forkRecord.piSessionFile!, "utf8")).resolves.toBe(
      '{"type":"session","id":"runtime-original"}\n',
    );
    expect(
      (await sessions.events(alpha, fork.id, 0, 100)).map(
        (event) => event.type,
      ),
    ).toEqual(
      expect.arrayContaining(["message.user", "session.forked"]),
    );
    expect(
      (await sessions.events(alpha, source.id, 0, 100)).map(
        (event) => event.type,
      ),
    ).toContain("session.fork.created");

    const renamed = await sessions.update(alpha, source.id, {
      title: "Renamed",
      archived: true,
    });
    expect(renamed.title).toBe("Renamed");
    expect(renamed.archivedAt).toBeTruthy();
    await expect(
      sessions.sendMessage(alpha, source.id, { content: "blocked" }),
    ).rejects.toMatchObject({ code: "session_archived" });
    expect(await sessions.list(alpha)).not.toContainEqual(
      expect.objectContaining({ id: source.id }),
    );
    expect(await sessions.list(alpha, undefined, true)).toContainEqual(
      expect.objectContaining({ id: source.id }),
    );

    const deleted = await sessions.remove(alpha, source.id);
    expect(deleted).toMatchObject({ sessionId: source.id, deleted: true });
    await expect(sessions.get(alpha, source.id)).resolves.toBeNull();
    await expect(
      sessions.events(alpha, source.id, 0, 100),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS total FROM session_events WHERE session_id = ?",
        )
        .get(source.id)?.total,
    ).toBeGreaterThan(0);

    sessions.dispose();
    database.close();
  });

  it("canonicalizes job paths and keeps job lookup tenant-scoped", async () => {
    const database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(database);
    repositories.users.upsertCloudShadow(ALPHA);
    repositories.users.upsertCloudShadow(BETA);
    const projects = new RepositoryProjectService(repositories);
    const jobs = new RepositoryJobService(database);
    const alpha = buildTenantContext(dataRoot, ALPHA);
    const beta = buildTenantContext(dataRoot, BETA);
    const project = await projects.create(alpha, { name: "Job project" });

    const enqueued = await jobs.enqueue(alpha, {
      projectId: project.id,
      type: "document.ingest",
      payload: {
        inputPath: "uploads/source.pdf",
        outputDirectory: "artifacts/ingest",
      },
      idempotencyKey: "ingest-source-v1",
      maxAttempts: 3,
    });

    expect(enqueued.created).toBe(true);
    expect(enqueued.job.payload.inputPath).toBe(
      path.join(
        alpha.projectsRoot,
        project.id,
        "uploads/source.pdf",
      ),
    );
    await expect(jobs.get(beta, enqueued.job.id)).resolves.toBeNull();
    await expect(
      jobs.enqueue(alpha, {
        projectId: project.id,
        type: "document.ingest",
        payload: {
          inputPath: "../../outside.pdf",
          outputDirectory: "artifacts/ingest",
        },
        idempotencyKey: "escape-attempt",
        maxAttempts: 3,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    await expect(jobs.cancel(alpha, enqueued.job.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    database.close();
  });
});
