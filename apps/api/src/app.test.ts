import { describe, expect, it } from "vitest";

import type {
  CreateProjectRequest,
  CreateSessionRequest,
  DeleteSessionResponse,
  ForkSessionRequest,
  ListSessionChildrenQuery,
  Project,
  SendMessageRequest,
  Session,
  SessionChildrenPage,
  SessionEvent,
  SessionLabelsResponse,
  UpdateSessionRequest,
  Operation,
} from "@private-fund/contracts";
import {
  DomainError,
  newId,
  type TenantContext,
} from "@private-fund/core";

import { createApiApp } from "./app.js";
import type {
  ApiDependencies,
  ProjectService,
  SessionService,
} from "./dependencies.js";
import { DevelopmentIdentityProvider } from "./identity.js";

class MemoryProjects implements ProjectService {
  readonly rows: Project[] = [];

  async list(): Promise<Project[]> {
    return this.rows;
  }

  async create(
    _tenant: TenantContext,
    input: CreateProjectRequest,
  ): Promise<Project> {
    const now = new Date().toISOString();
    const row: Project = {
      id: newId("project"),
      name: input.name,
      companyName: input.companyName ?? null,
      ticker: input.ticker ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    return row;
  }

  async get(_tenant: TenantContext, projectId: string): Promise<Project | null> {
    return this.rows.find((row) => row.id === projectId) ?? null;
  }

  async update(
    _tenant: TenantContext,
    projectId: string,
    input: { name?: string; companyName?: string | null; ticker?: string | null },
  ): Promise<Project | null> {
    const row = this.rows.find((candidate) => candidate.id === projectId);
    if (!row) return null;
    if (input.name !== undefined) row.name = input.name;
    if (input.companyName !== undefined) row.companyName = input.companyName;
    if (input.ticker !== undefined) row.ticker = input.ticker;
    row.updatedAt = new Date().toISOString();
    return row;
  }

  async remove(_tenant: TenantContext, projectId: string): Promise<boolean> {
    const index = this.rows.findIndex((row) => row.id === projectId);
    if (index < 0) return false;
    this.rows.splice(index, 1);
    return true;
  }
}

class MemorySessions implements SessionService {
  readonly rows: Session[] = [];
  readonly eventRows = new Map<string, SessionEvent[]>();

  async list(
    _tenant: TenantContext,
    projectId?: string,
  ): Promise<Session[]> {
    return projectId
      ? this.rows.filter((row) => row.projectId === projectId)
      : this.rows;
  }

  async create(
    _tenant: TenantContext,
    input: CreateSessionRequest,
  ): Promise<Session> {
    const now = new Date().toISOString();
    const row: Session = {
      id: newId("session"),
      projectId: input.projectId,
      title: input.title ?? "New research",
      status: "idle",
      archivedAt: null,
      forkedFromSessionId: null,
      createdAt: now,
      updatedAt: now,
      lastSequence: 0,
    };
    this.rows.push(row);
    return row;
  }

  async get(_tenant: TenantContext, sessionId: string): Promise<Session | null> {
    return this.rows.find((row) => row.id === sessionId) ?? null;
  }

  async children(
    tenant: TenantContext,
    sessionId: string,
    query: ListSessionChildrenQuery,
  ): Promise<SessionChildrenPage> {
    if (!(await this.get(tenant, sessionId))) {
      throw new DomainError("Session not found", "not_found", 404);
    }
    const matching = this.rows.filter(
      (row) =>
        row.forkedFromSessionId === sessionId &&
        (query.includeArchived || row.archivedAt === null),
    );
    const items = matching.slice(
      query.offset,
      query.offset + query.limit,
    );
    return {
      parentSessionId: sessionId,
      items: items.map((row) => ({
        ...row,
        forkedFromSessionId: sessionId,
      })),
      total: matching.length,
      limit: query.limit,
      offset: query.offset,
      hasMore: query.offset + items.length < matching.length,
    };
  }

  async labels(
    tenant: TenantContext,
    sessionId: string,
  ): Promise<SessionLabelsResponse> {
    const session = await this.get(tenant, sessionId);
    if (!session) {
      throw new DomainError("Session not found", "not_found", 404);
    }
    const lifecycle: "active" | "archived" =
      session.archivedAt === null ? "active" : "archived";
    return session.forkedFromSessionId === null
      ? {
          id: session.id,
          labels: {
            "private_fund.project_id": session.projectId,
            "private_fund.lifecycle": lifecycle,
            "private_fund.lineage": "root",
          },
        }
      : {
          id: session.id,
          labels: {
            "private_fund.project_id": session.projectId,
            "private_fund.lifecycle": lifecycle,
            "private_fund.lineage": "fork",
            "private_fund.forked_from_session_id":
              session.forkedFromSessionId,
          },
        };
  }

  async update(
    _tenant: TenantContext,
    sessionId: string,
    input: UpdateSessionRequest,
  ): Promise<Session> {
    const row = this.rows.find((candidate) => candidate.id === sessionId);
    if (!row) throw new Error("missing");
    const updated = {
      ...row,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.archived === undefined
        ? {}
        : {
            archivedAt: input.archived
              ? new Date().toISOString()
              : null,
          }),
    };
    this.rows.splice(this.rows.indexOf(row), 1, updated);
    return updated;
  }

  async fork(
    tenant: TenantContext,
    sessionId: string,
    input: ForkSessionRequest,
  ): Promise<Session> {
    const source = await this.get(tenant, sessionId);
    if (!source) throw new Error("missing");
    return this.create(tenant, {
      projectId: source.projectId,
      title: input.title ?? `Fork of ${source.title}`,
      ...(input.model === undefined ? {} : { model: input.model }),
    }).then((created) => {
      const forked = { ...created, forkedFromSessionId: source.id };
      this.rows.splice(this.rows.indexOf(created), 1, forked);
      return forked;
    });
  }

  async remove(
    _tenant: TenantContext,
    sessionId: string,
  ): Promise<DeleteSessionResponse> {
    const index = this.rows.findIndex((row) => row.id === sessionId);
    if (index < 0) throw new Error("missing");
    this.rows.splice(index, 1);
    return {
      sessionId,
      deleted: true,
      deletedAt: new Date().toISOString(),
    };
  }

  async sendMessage(
    _tenant: TenantContext,
    sessionId: string,
    _input: SendMessageRequest,
  ): Promise<{ operationId: string }> {
    if (!(await this.get(_tenant, sessionId))) throw new Error("missing");
    return { operationId: newId("operation") };
  }

  async steer(): Promise<void> {}
  async compact(): Promise<void> {}
  async interrupt(): Promise<void> {}

  async events(
    _tenant: TenantContext,
    sessionId: string,
    after: number,
    limit: number,
  ): Promise<SessionEvent[]> {
    return (this.eventRows.get(sessionId) ?? [])
      .filter((event) => event.sequence > after)
      .slice(0, limit);
  }

  subscribe(): () => void {
    return () => undefined;
  }

  async operation(): Promise<Operation | null> {
    return null;
  }

  async operations(): Promise<Operation[]> {
    return [];
  }
}

function testConfig() {
  return {
    host: "127.0.0.1",
    port: 6768,
    dataRoot: "/tmp/private-fund-api-test",
    controlDatabase: "/tmp/private-fund-api-test/control.sqlite3",
    auth: {
      mode: "development" as const,
      userId: "test-user",
      dataNamespace: "8dbf58b8-1bd5-4f5f-a821-01ffc896e7cc",
    },
    agentWorkerEntry: "/tmp/agent-worker.js",
  };
}

async function testApp() {
  const projects = new MemoryProjects();
  const sessions = new MemorySessions();
  const dependencies: ApiDependencies = {
    identityProvider: new DevelopmentIdentityProvider({
      userId: "test-user",
      dataNamespace: "8dbf58b8-1bd5-4f5f-a821-01ffc896e7cc",
    }),
    projects,
    sessions,
  };
  return { app: await createApiApp(testConfig(), dependencies), projects, sessions };
}

describe("TypeScript API", () => {
  it("exposes the new runtime capabilities", async () => {
    const { app } = await testApp();
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({
      status: "ok",
      service: "private-fund-ts-api",
      version: "0.1.0",
    });
    const response = await app.inject({ method: "GET", url: "/v1/info" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      auth_mode: "development",
      pi_sdk_harness: true,
      legacy_omnigent_required: false,
    });
    await app.close();
  });

  it("isolates project CRUD behind the server identity", async () => {
    const { app } = await testApp();
    const created = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Tesla", companyName: "Tesla, Inc.", ticker: "TSLA" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "Tesla", ticker: "TSLA" });

    const listed = await app.inject({ method: "GET", url: "/v1/projects" });
    expect(listed.json().projects).toHaveLength(1);

    const projectId = created.json().id as string;
    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}`,
      payload: { name: "Tesla Motors", ticker: null },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      id: projectId,
      name: "Tesla Motors",
      ticker: null,
      companyName: "Tesla, Inc.",
    });

    const emptyPatch = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}`,
      payload: {},
    });
    expect(emptyPatch.statusCode).toBe(400);

    const missing = await app.inject({
      method: "PATCH",
      url: "/v1/projects/project-does-not-exist",
      payload: { name: "x" },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("serves bounded fork children and read-only canonical session labels", async () => {
    const { app, projects, sessions } = await testApp();
    const tenant = {} as TenantContext;
    const project = await projects.create(tenant, { name: "Lineage" });
    const parent = await sessions.create(tenant, {
      projectId: project.id,
      title: "Root",
    });
    const activeChild = await sessions.fork(tenant, parent.id, {
      title: "Active fork",
    });
    const archivedChild = await sessions.fork(tenant, parent.id, {
      title: "Archived fork",
    });
    await sessions.update(tenant, archivedChild.id, { archived: true });

    const allChildren = await app.inject({
      method: "GET",
      url: `/v1/sessions/${parent.id}/children?limit=1&offset=0`,
    });
    expect(allChildren.statusCode).toBe(200);
    expect(allChildren.headers["cache-control"]).toBe("no-store");
    expect(allChildren.json()).toMatchObject({
      parentSessionId: parent.id,
      total: 2,
      limit: 1,
      offset: 0,
      hasMore: true,
    });
    expect(allChildren.json().items).toHaveLength(1);

    const activeChildren = await app.inject({
      method: "GET",
      url: `/v1/sessions/${parent.id}/children?includeArchived=0`,
    });
    expect(activeChildren.json()).toMatchObject({
      total: 1,
      items: [
        expect.objectContaining({
          id: activeChild.id,
          forkedFromSessionId: parent.id,
        }),
      ],
    });

    const rootLabels = await app.inject({
      method: "GET",
      url: `/v1/sessions/${parent.id}/labels`,
    });
    expect(rootLabels.statusCode).toBe(200);
    expect(rootLabels.headers["cache-control"]).toBe("no-store");
    expect(rootLabels.json()).toEqual({
      id: parent.id,
      labels: {
        "private_fund.project_id": project.id,
        "private_fund.lifecycle": "active",
        "private_fund.lineage": "root",
      },
    });
    const forkLabels = await app.inject({
      method: "GET",
      url: `/v1/sessions/${archivedChild.id}/labels`,
    });
    expect(forkLabels.json()).toEqual({
      id: archivedChild.id,
      labels: {
        "private_fund.project_id": project.id,
        "private_fund.lifecycle": "archived",
        "private_fund.lineage": "fork",
        "private_fund.forked_from_session_id": parent.id,
      },
    });
    const rejectedLegacyLabelWrite = await app.inject({
      method: "PATCH",
      url: `/v1/sessions/${parent.id}`,
      payload: {
        labels: { "omnigent.wrapper": "codex-native-ui" },
      },
    });
    expect(rejectedLegacyLabelWrite.statusCode).toBe(400);
    const rejectedLabelRouteWrite = await app.inject({
      method: "PATCH",
      url: `/v1/sessions/${parent.id}/labels`,
      payload: {
        labels: {
          "private_fund.lifecycle": "archived",
        },
      },
    });
    expect(rejectedLabelRouteWrite.statusCode).toBe(404);

    for (const suffix of ["children", "labels"]) {
      const missing = await app.inject({
        method: "GET",
        url: `/v1/sessions/session-missing/${suffix}`,
      });
      expect(missing.statusCode).toBe(404);
    }
    const invalidPage = await app.inject({
      method: "GET",
      url: `/v1/sessions/${parent.id}/children?limit=501`,
    });
    expect(invalidPage.statusCode).toBe(400);
    await app.close();
  });

  it("supports replay-only session event reads", async () => {
    const { app, projects, sessions } = await testApp();
    const project = await projects.create(
      {} as TenantContext,
      { name: "Project" },
    );
    const session = await sessions.create(
      {} as TenantContext,
      { projectId: project.id },
    );
    sessions.eventRows.set(session.id, [
      {
        sessionId: session.id,
        sequence: 1,
        type: "session.created",
        timestamp: new Date().toISOString(),
        operationId: null,
        payload: {},
      },
      {
        sessionId: session.id,
        sequence: 2,
        type: "session.status",
        timestamp: new Date().toISOString(),
        operationId: null,
        payload: { status: "idle" },
      },
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/v1/sessions/${session.id}/events?stream=0&after=1`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().events.map((event: SessionEvent) => event.sequence)).toEqual([
      2,
    ]);
    await app.close();
  });
});
