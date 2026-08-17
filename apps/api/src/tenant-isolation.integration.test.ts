import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TenantIdentity } from "@private-fund/contracts";
import {
  buildTenantContext,
  type TenantContext,
} from "@private-fund/core";
import {
  createControlRepositories,
  openControlDatabase,
  type ControlDatabase,
  type ControlRepositories,
} from "@private-fund/db";

import type {
  AgentEvent,
  AgentWorkerPort,
  StartAgentSessionInput,
} from "./agent-supervisor.js";
import { createApiApp } from "./app.js";
import type { ApiConfig } from "./config.js";
import { DevelopmentIdentityProvider } from "./identity.js";
import {
  RepositoryJobService,
  RepositoryProjectService,
  RepositorySessionService,
} from "./repository-services.js";
import { RepositoryResearchService } from "./research-service.js";
import { ProjectResearchStoreManager } from "./research-stores.js";
import { RepositorySourceFolderService } from "./source-folder-service.js";

const TENANT_CASES = [
  {
    key: "alpha",
    identity: {
      userId: "acceptance-alpha",
      dataNamespace: "00000000-0000-4000-8000-0000000000a1",
    },
  },
  {
    key: "beta",
    identity: {
      userId: "acceptance-beta",
      dataNamespace: "00000000-0000-4000-8000-0000000000b2",
    },
  },
  {
    key: "gamma",
    identity: {
      userId: "acceptance-gamma",
      dataNamespace: "00000000-0000-4000-8000-0000000000c3",
    },
  },
] as const satisfies readonly {
  readonly key: string;
  readonly identity: TenantIdentity;
}[];

type TenantKey = (typeof TENANT_CASES)[number]["key"];
type ApiApp = Awaited<ReturnType<typeof createApiApp>>;

interface TenantApi {
  readonly key: TenantKey;
  readonly identity: TenantIdentity;
  readonly tenant: TenantContext;
  readonly app: ApiApp;
}

interface AcceptanceHarness {
  readonly dataRoot: string;
  readonly database: ControlDatabase;
  readonly repositories: ControlRepositories;
  readonly worker: FakeAgentWorker;
  readonly sessions: RepositorySessionService;
  readonly stores: ProjectResearchStoreManager;
  readonly tenants: ReadonlyMap<TenantKey, TenantApi>;
  close(): Promise<void>;
}

interface ControlFixture {
  readonly projectId: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly jobId: string;
  readonly eventCount: number;
}

interface ResearchFixture {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly databasePath: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly storedPath: string;
  readonly contents: Buffer;
}

class FakeAgentWorker implements AgentWorkerPort {
  public readonly starts: StartAgentSessionInput[] = [];
  public readonly prompts: Array<{
    readonly sessionId: string;
    readonly operationId: string;
    readonly content: string;
  }> = [];

  readonly #listeners = new Set<(event: AgentEvent) => void>();

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

  public async compact(): Promise<void> {}

  public async interrupt(): Promise<void> {}

  public async dispose(): Promise<void> {}

  public subscribe(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  public async stop(): Promise<void> {}

  public emit(event: AgentEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}

function tenantApi(
  harness: AcceptanceHarness,
  key: TenantKey,
): TenantApi {
  const value = harness.tenants.get(key);
  if (value === undefined) {
    throw new Error(`Missing acceptance tenant ${key}`);
  }
  return value;
}

function multipartFile(
  filename: string,
  mediaType: string,
  contents: Buffer,
): { readonly boundary: string; readonly payload: Buffer } {
  const boundary =
    "----private-fund-tenant-acceptance-" +
    createHash("sha256")
      .update(filename)
      .update(contents)
      .digest("hex")
      .slice(0, 24);
  return {
    boundary,
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: ${mediaType}\r\n\r\n`,
      ),
      contents,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function sha256(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

function expectInside(candidate: string, root: string): void {
  const relative = path.relative(root, candidate);
  expect(relative).not.toBe("");
  expect(path.isAbsolute(relative)).toBe(false);
  expect(relative).not.toBe("..");
  expect(relative.startsWith(`..${path.sep}`)).toBe(false);
}

async function createAcceptanceHarness(
  dataRoot: string,
): Promise<AcceptanceHarness> {
  const database = openControlDatabase(
    path.join(dataRoot, "control.sqlite3"),
  );
  const repositories = createControlRepositories(database);
  for (const tenantCase of TENANT_CASES) {
    repositories.users.upsertCloudShadow(tenantCase.identity);
  }

  const worker = new FakeAgentWorker();
  const projects = new RepositoryProjectService(repositories);
  const sessions = new RepositorySessionService({
    repositories,
    worker,
  });
  const jobs = new RepositoryJobService(database);
  const stores = new ProjectResearchStoreManager();
  const research = new RepositoryResearchService(
    repositories,
    stores,
    jobs,
  );
  const sourceFolders = new RepositorySourceFolderService(
    repositories,
    stores,
  );
  const tenants = new Map<TenantKey, TenantApi>();

  try {
    for (const tenantCase of TENANT_CASES) {
      const config: ApiConfig = {
        host: "127.0.0.1",
        port: 6768,
        dataRoot,
        controlDatabase: path.join(dataRoot, "control.sqlite3"),
        auth: {
          mode: "development",
          userId: tenantCase.identity.userId,
          dataNamespace: tenantCase.identity.dataNamespace,
        },
        agentWorkerEntry: path.join(dataRoot, "unused-agent-worker.mjs"),
      };
      const app = await createApiApp(config, {
        identityProvider: new DevelopmentIdentityProvider(
          tenantCase.identity,
        ),
        projects,
        sessions,
        jobs,
        research,
        sourceFolders,
      });
      tenants.set(tenantCase.key, {
        key: tenantCase.key,
        identity: tenantCase.identity,
        tenant: buildTenantContext(dataRoot, tenantCase.identity),
        app,
      });
    }
  } catch (error) {
    await Promise.all(
      [...tenants.values()].map(async (tenant) => tenant.app.close()),
    );
    sessions.dispose();
    stores.close();
    database.close();
    throw error;
  }

  let closed = false;
  return {
    dataRoot,
    database,
    repositories,
    worker,
    sessions,
    stores,
    tenants,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await Promise.all(
        [...tenants.values()].map(async (tenant) => tenant.app.close()),
      );
      sessions.dispose();
      await worker.stop();
      stores.close();
      database.close();
    },
  };
}

describe("A/B/C canonical tenant isolation acceptance", () => {
  let dataRoot: string;
  let harness: AcceptanceHarness;

  beforeEach(async () => {
    dataRoot = await mkdtemp(
      path.join(tmpdir(), "pf-tenant-isolation-acceptance-"),
    );
    harness = await createAcceptanceHarness(dataRoot);
  });

  afterEach(async () => {
    await harness.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("isolates projects, sessions, events, operations and jobs for all directed tenant pairs", async () => {
    const fixtures = new Map<TenantKey, ControlFixture>();

    for (const [index, tenantCase] of TENANT_CASES.entries()) {
      const current = tenantApi(harness, tenantCase.key);
      const spoof =
        TENANT_CASES[(index + 1) % TENANT_CASES.length]!.identity;

      const meResponse = await current.app.inject({
        method: "GET",
        url: "/v1/me",
      });
      expect(meResponse.statusCode).toBe(200);
      expect(meResponse.json()).toEqual({
        user_id: current.identity.userId,
        data_namespace: current.identity.dataNamespace,
      });

      const projectResponse = await current.app.inject({
        method: "POST",
        url: "/v1/projects",
        payload: {
          name: `Private ${current.key} project`,
          userId: spoof.userId,
          dataNamespace: spoof.dataNamespace,
          tenantNamespace: spoof.dataNamespace,
        },
      });
      expect(projectResponse.statusCode, projectResponse.body).toBe(201);
      const project = projectResponse.json<{ id: string }>();
      expect(
        harness.repositories.projects.getForTenant(
          current.identity.dataNamespace,
          project.id,
        ),
      ).toMatchObject({
        userId: current.identity.userId,
        tenantNamespace: current.identity.dataNamespace,
      });
      expect(
        harness.repositories.projects.findForTenant(
          spoof.dataNamespace,
          project.id,
        ),
      ).toBeNull();

      const sessionResponse = await current.app.inject({
        method: "POST",
        url: "/v1/sessions",
        payload: {
          projectId: project.id,
          title: `Private ${current.key} session`,
          userId: spoof.userId,
          dataNamespace: spoof.dataNamespace,
        },
      });
      expect(sessionResponse.statusCode, sessionResponse.body).toBe(201);
      const session = sessionResponse.json<{ id: string }>();

      const messageResponse = await current.app.inject({
        method: "POST",
        url: `/v1/sessions/${session.id}/messages`,
        payload: {
          content: `Analyze ${current.key}`,
          clientMessageId: "shared-client-message",
          userId: spoof.userId,
          dataNamespace: spoof.dataNamespace,
        },
      });
      expect(messageResponse.statusCode, messageResponse.body).toBe(202);
      const operation = messageResponse.json<{ operationId: string }>();
      harness.worker.emit({
        type: "agent.event",
        sessionId: session.id,
        operationId: operation.operationId,
        eventType: "message.assistant.delta",
        payload: { delta: `private reply for ${current.key}` },
      });
      harness.worker.emit({
        type: "agent.event",
        sessionId: session.id,
        operationId: operation.operationId,
        eventType: "session.status",
        payload: { status: "idle" },
      });

      const eventResponse = await current.app.inject({
        method: "GET",
        url: `/v1/sessions/${session.id}/events?stream=0`,
      });
      expect(eventResponse.statusCode, eventResponse.body).toBe(200);
      const events = eventResponse.json<{
        events: Array<{ type: string; payload: Record<string, unknown> }>;
      }>().events;
      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "session.created",
          "message.user",
          "message.assistant.delta",
          "operation.completed",
        ]),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "message.assistant.delta",
          payload: { delta: `private reply for ${current.key}` },
        }),
      );

      const operationResponse = await current.app.inject({
        method: "GET",
        url:
          `/v1/sessions/${session.id}/operations/` +
          operation.operationId,
      });
      expect(operationResponse.statusCode, operationResponse.body).toBe(200);
      expect(operationResponse.json()).toMatchObject({
        id: operation.operationId,
        status: "completed",
      });

      const jobResponse = await current.app.inject({
        method: "POST",
        url: "/v1/jobs",
        payload: {
          projectId: project.id,
          type: "tracking.scan",
          payload: {
            requestedBy: spoof.userId,
            tenantNamespace: spoof.dataNamespace,
          },
          idempotencyKey: "shared-control-acceptance-job",
          maxAttempts: 3,
          userId: spoof.userId,
          dataNamespace: spoof.dataNamespace,
          tenantNamespace: spoof.dataNamespace,
        },
      });
      expect(jobResponse.statusCode, jobResponse.body).toBe(201);
      const job = jobResponse.json<{
        job: {
          id: string;
          tenantNamespace: string;
          projectId: string;
        };
      }>().job;
      expect(job).toMatchObject({
        tenantNamespace: current.identity.dataNamespace,
        projectId: project.id,
      });

      fixtures.set(current.key, {
        projectId: project.id,
        sessionId: session.id,
        operationId: operation.operationId,
        jobId: job.id,
        eventCount: events.length,
      });
    }

    expect(harness.worker.starts).toHaveLength(TENANT_CASES.length);
    expect(
      harness.worker.starts.map((start) => start.tenant.dataNamespace).sort(),
    ).toEqual(
      TENANT_CASES.map((tenantCase) =>
        tenantCase.identity.dataNamespace
      ).sort(),
    );

    for (const ownerCase of TENANT_CASES) {
      const owner = tenantApi(harness, ownerCase.key);
      const fixture = fixtures.get(owner.key);
      if (fixture === undefined) {
        throw new Error(`Missing control fixture for ${owner.key}`);
      }

      const projectsResponse = await owner.app.inject({
        method: "GET",
        url: "/v1/projects",
      });
      expect(projectsResponse.statusCode).toBe(200);
      expect(
        projectsResponse.json<{ projects: Array<{ id: string }> }>().projects,
      ).toEqual([expect.objectContaining({ id: fixture.projectId })]);

      const sessionsResponse = await owner.app.inject({
        method: "GET",
        url: "/v1/sessions",
      });
      expect(sessionsResponse.statusCode).toBe(200);
      expect(
        sessionsResponse.json<{ sessions: Array<{ id: string }> }>().sessions,
      ).toEqual([expect.objectContaining({ id: fixture.sessionId })]);

      const jobsResponse = await owner.app.inject({
        method: "GET",
        url: "/v1/jobs",
      });
      expect(jobsResponse.statusCode).toBe(200);
      expect(
        jobsResponse.json<{ jobs: Array<{ id: string }> }>().jobs,
      ).toEqual([expect.objectContaining({ id: fixture.jobId })]);
    }

    for (const attackerCase of TENANT_CASES) {
      const attacker = tenantApi(harness, attackerCase.key);
      for (const targetCase of TENANT_CASES) {
        if (attacker.key === targetCase.key) {
          continue;
        }
        const target = fixtures.get(targetCase.key);
        if (target === undefined) {
          throw new Error(`Missing target fixture for ${targetCase.key}`);
        }

        const deniedResponses = await Promise.all([
          attacker.app.inject({
            method: "GET",
            url: `/v1/projects/${target.projectId}`,
          }),
          attacker.app.inject({
            method: "DELETE",
            url: `/v1/projects/${target.projectId}`,
          }),
          attacker.app.inject({
            method: "GET",
            url: `/v1/sessions/${target.sessionId}`,
          }),
          attacker.app.inject({
            method: "GET",
            url: `/v1/sessions/${target.sessionId}/children`,
          }),
          attacker.app.inject({
            method: "GET",
            url: `/v1/sessions/${target.sessionId}/labels`,
          }),
          attacker.app.inject({
            method: "PATCH",
            url: `/v1/sessions/${target.sessionId}`,
            payload: { title: `hijacked by ${attacker.key}` },
          }),
          attacker.app.inject({
            method: "POST",
            url: `/v1/sessions/${target.sessionId}/messages`,
            payload: {
              content: `cross-tenant write by ${attacker.key}`,
              clientMessageId: `cross-${attacker.key}-${targetCase.key}`,
            },
          }),
          attacker.app.inject({
            method: "GET",
            url: `/v1/sessions/${target.sessionId}/events?stream=0`,
          }),
          attacker.app.inject({
            method: "GET",
            url: `/v1/sessions/${target.sessionId}/operations`,
          }),
          attacker.app.inject({
            method: "GET",
            url:
              `/v1/sessions/${target.sessionId}/operations/` +
              target.operationId,
          }),
          attacker.app.inject({
            method: "POST",
            url: "/v1/sessions",
            payload: {
              projectId: target.projectId,
              title: "cross-tenant session",
            },
          }),
          attacker.app.inject({
            method: "GET",
            url: `/v1/jobs/${target.jobId}`,
          }),
          attacker.app.inject({
            method: "POST",
            url: `/v1/jobs/${target.jobId}/cancel`,
          }),
          attacker.app.inject({
            method: "POST",
            url: "/v1/jobs",
            payload: {
              projectId: target.projectId,
              type: "tracking.scan",
              payload: {},
              idempotencyKey:
                `cross-${attacker.key}-${targetCase.key}`,
              maxAttempts: 3,
            },
          }),
        ]);
        for (const response of deniedResponses) {
          expect(response.statusCode, response.body).toBe(404);
          expect(response.json()).toMatchObject({ error: "not_found" });
        }
      }
    }

    for (const ownerCase of TENANT_CASES) {
      const owner = tenantApi(harness, ownerCase.key);
      const fixture = fixtures.get(owner.key);
      if (fixture === undefined) {
        throw new Error(`Missing post-attack fixture for ${owner.key}`);
      }

      const projectResponse = await owner.app.inject({
        method: "GET",
        url: `/v1/projects/${fixture.projectId}`,
      });
      expect(projectResponse.statusCode).toBe(200);
      expect(projectResponse.json()).toMatchObject({
        id: fixture.projectId,
        name: `Private ${owner.key} project`,
      });

      const sessionResponse = await owner.app.inject({
        method: "GET",
        url: `/v1/sessions/${fixture.sessionId}`,
      });
      expect(sessionResponse.statusCode).toBe(200);
      expect(sessionResponse.json()).toMatchObject({
        id: fixture.sessionId,
        title: `Private ${owner.key} session`,
      });

      const childrenResponse = await owner.app.inject({
        method: "GET",
        url: `/v1/sessions/${fixture.sessionId}/children`,
      });
      expect(childrenResponse.statusCode).toBe(200);
      expect(childrenResponse.json()).toMatchObject({
        parentSessionId: fixture.sessionId,
        items: [],
        total: 0,
      });

      const labelsResponse = await owner.app.inject({
        method: "GET",
        url: `/v1/sessions/${fixture.sessionId}/labels`,
      });
      expect(labelsResponse.statusCode).toBe(200);
      expect(labelsResponse.json()).toEqual({
        id: fixture.sessionId,
        labels: {
          "private_fund.project_id": fixture.projectId,
          "private_fund.lifecycle": "active",
          "private_fund.lineage": "root",
        },
      });

      const eventsResponse = await owner.app.inject({
        method: "GET",
        url: `/v1/sessions/${fixture.sessionId}/events?stream=0`,
      });
      expect(eventsResponse.statusCode).toBe(200);
      expect(
        eventsResponse.json<{ events: unknown[] }>().events,
      ).toHaveLength(fixture.eventCount);

      const operationsResponse = await owner.app.inject({
        method: "GET",
        url: `/v1/sessions/${fixture.sessionId}/operations`,
      });
      expect(operationsResponse.statusCode).toBe(200);
      expect(
        operationsResponse.json<{
          operations: Array<{ id: string; status: string }>;
        }>().operations,
      ).toEqual([
        expect.objectContaining({
          id: fixture.operationId,
          status: "completed",
        }),
      ]);

      const jobResponse = await owner.app.inject({
        method: "GET",
        url: `/v1/jobs/${fixture.jobId}`,
      });
      expect(jobResponse.statusCode).toBe(200);
      expect(jobResponse.json()).toMatchObject({
        id: fixture.jobId,
        status: "queued",
        tenantNamespace: owner.identity.dataNamespace,
      });
    }
  });

  it("keeps project SQLite, documents, evidence, folders, assets and same-name files tenant-local", async () => {
    const sharedFilename = "shared-private-source.pdf";
    const sharedEvidenceId = "chunk:shared-private-evidence";
    const sharedFolderId = "folder_shared_private";
    const sharedAssetId = "asset_shared_private";
    const fixtures = new Map<TenantKey, ResearchFixture>();

    for (const tenantCase of TENANT_CASES) {
      const current = tenantApi(harness, tenantCase.key);
      const projectResponse = await current.app.inject({
        method: "POST",
        url: "/v1/projects",
        payload: { name: `Research ${current.key}` },
      });
      expect(projectResponse.statusCode, projectResponse.body).toBe(201);
      const project = projectResponse.json<{ id: string }>();

      const contents = Buffer.from(
        `%PDF-1.7\nprivate source for ${current.key}\n`,
        "utf8",
      );
      const multipart = multipartFile(
        sharedFilename,
        "application/pdf",
        contents,
      );
      const uploadResponse = await current.app.inject({
        method: "POST",
        url: `/v1/projects/${project.id}/documents/upload`,
        headers: {
          "content-type":
            `multipart/form-data; boundary=${multipart.boundary}`,
        },
        payload: multipart.payload,
      });
      expect(uploadResponse.statusCode, uploadResponse.body).toBe(202);
      const uploaded = uploadResponse.json<{
        uploads: Array<{
          document: { id: string };
          version: {
            id: string;
            originalFilename: string;
            storedPath: string;
          };
        }>;
      }>().uploads[0];
      if (uploaded === undefined) {
        throw new Error(`Missing upload result for ${current.key}`);
      }
      expect(uploaded.version.originalFilename).toBe(sharedFilename);

      const projectRoot = path.join(
        current.tenant.projectsRoot,
        project.id,
      );
      const store = harness.stores.get(projectRoot);
      store.evidence.put({
        evidenceId: sharedEvidenceId,
        kind: "chunk",
        documentVersionId: uploaded.version.id,
        title: `Evidence ${current.key}`,
        summary: `Summary ${current.key}`,
        originalText: `private evidence for ${current.key}`,
        locator: {
          pageStart: 1,
          pageEnd: 1,
          sourceRef: `${sharedFilename}#page=1`,
        },
        metadata: { tenant: current.key },
      });
      store.sourceFolders.create({
        folderId: sharedFolderId,
        name: `Private folder ${current.key}`,
        folderKind: "manual",
        classificationKey: `private.${current.key}`,
        metadata: { tenant: current.key },
      });

      const assignmentResponse = await current.app.inject({
        method: "POST",
        url:
          `/v1/projects/${project.id}/source-folders/` +
          `${sharedFolderId}/documents`,
        payload: {
          documentId: uploaded.document.id,
          assignmentSource: "acceptance",
          classificationKey: `private.${current.key}`,
          metadata: { tenant: current.key },
        },
      });
      expect(
        assignmentResponse.statusCode,
        assignmentResponse.body,
      ).toBe(201);

      const assetResponse = await current.app.inject({
        method: "POST",
        url: `/v1/projects/${project.id}/assets`,
        payload: {
          assetId: sharedAssetId,
          assetType: "investment_memo",
          title: `Private asset ${current.key}`,
          status: "completed",
          summary: `Asset summary ${current.key}`,
          contentMarkdown: `# Private asset for ${current.key}`,
          structuredContent: { tenant: current.key },
          metadata: { tenant: current.key },
          tags: [current.key],
          evidence: [
            {
              evidenceId: sharedEvidenceId,
              relationType: "supports",
              quote: `private evidence for ${current.key}`,
            },
          ],
        },
      });
      expect(assetResponse.statusCode, assetResponse.body).toBe(201);
      expect(assetResponse.json()).toMatchObject({
        asset: {
          id: sharedAssetId,
          title: `Private asset ${current.key}`,
        },
        version: {
          contentMarkdown: `# Private asset for ${current.key}`,
        },
      });
      const contextResponse = await current.app.inject({
        method: "PUT",
        url: `/v1/projects/${project.id}/assets/context`,
        payload: {
          assetIds: [
            `document:${uploaded.document.id}`,
            sharedAssetId,
          ],
        },
      });
      expect(
        contextResponse.statusCode,
        contextResponse.body,
      ).toBe(200);
      expect(contextResponse.json()).toEqual({
        assetIds: [
          `document:${uploaded.document.id}`,
          sharedAssetId,
        ],
      });

      const databasePath = path.join(
        projectRoot,
        "data",
        "research.sqlite3",
      );
      expect((await stat(databasePath)).isFile()).toBe(true);
      fixtures.set(current.key, {
        projectId: project.id,
        projectRoot,
        databasePath,
        documentId: uploaded.document.id,
        documentVersionId: uploaded.version.id,
        storedPath: uploaded.version.storedPath,
        contents,
      });
    }

    expect(
      new Set([...fixtures.values()].map((entry) => entry.documentId)).size,
    ).toBe(1);
    expect(
      new Set([...fixtures.values()].map((entry) => entry.databasePath)).size,
    ).toBe(TENANT_CASES.length);
    expect(
      new Set([...fixtures.values()].map((entry) => entry.storedPath)).size,
    ).toBe(TENANT_CASES.length);

    for (const ownerCase of TENANT_CASES) {
      const owner = tenantApi(harness, ownerCase.key);
      const fixture = fixtures.get(owner.key);
      if (fixture === undefined) {
        throw new Error(`Missing research fixture for ${owner.key}`);
      }

      const [realTenantRoot, realProjectRoot, realDatabase, realStoredFile] =
        await Promise.all([
          realpath(owner.tenant.root),
          realpath(fixture.projectRoot),
          realpath(fixture.databasePath),
          realpath(fixture.storedPath),
        ]);
      expectInside(realProjectRoot, realTenantRoot);
      expectInside(realDatabase, realProjectRoot);
      expectInside(realStoredFile, realProjectRoot);
      await expect(readFile(realStoredFile)).resolves.toEqual(
        fixture.contents,
      );

      const documentsResponse = await owner.app.inject({
        method: "GET",
        url: `/v1/projects/${fixture.projectId}/documents`,
      });
      expect(documentsResponse.statusCode).toBe(200);
      expect(documentsResponse.json()).toMatchObject({
        total: 1,
        items: [
          {
            id: fixture.documentId,
            sourceRelpath: sharedFilename,
          },
        ],
      });

      const documentResponse = await owner.app.inject({
        method: "GET",
        url:
          `/v1/projects/${fixture.projectId}/documents/` +
          `${fixture.documentId}/download`,
      });
      expect(documentResponse.statusCode, documentResponse.body).toBe(200);
      expect(documentResponse.rawPayload).toEqual(fixture.contents);

      const evidenceResponse = await owner.app.inject({
        method: "GET",
        url:
          `/v1/projects/${fixture.projectId}/evidence/` +
          sharedEvidenceId,
      });
      expect(evidenceResponse.statusCode, evidenceResponse.body).toBe(200);
      expect(evidenceResponse.json()).toMatchObject({
        evidenceId: sharedEvidenceId,
        originalText: `private evidence for ${owner.key}`,
        document: { id: fixture.documentId },
        documentVersion: { id: fixture.documentVersionId },
      });

      const evidencePreviewResponse = await owner.app.inject({
        method: "GET",
        url:
          `/v1/projects/${fixture.projectId}/evidence/` +
          `${sharedEvidenceId}/preview`,
      });
      expect(
        evidencePreviewResponse.statusCode,
        evidencePreviewResponse.body,
      ).toBe(200);
      expect(evidencePreviewResponse.rawPayload).toEqual(fixture.contents);

      const foldersResponse = await owner.app.inject({
        method: "GET",
        url: `/v1/projects/${fixture.projectId}/source-folders`,
      });
      expect(foldersResponse.statusCode, foldersResponse.body).toBe(200);
      expect(foldersResponse.json()).toMatchObject({
        folders: [
          {
            id: sharedFolderId,
            name: `Private folder ${owner.key}`,
            documentCount: 1,
          },
        ],
        assignments: [
          {
            folderId: sharedFolderId,
            documentId: fixture.documentId,
            metadata: { tenant: owner.key },
          },
        ],
      });

      const assetResponse = await owner.app.inject({
        method: "GET",
        url:
          `/v1/projects/${fixture.projectId}/assets/` +
          sharedAssetId,
      });
      expect(assetResponse.statusCode, assetResponse.body).toBe(200);
      expect(assetResponse.json()).toMatchObject({
        asset: {
          id: sharedAssetId,
          title: `Private asset ${owner.key}`,
        },
        version: {
          contentMarkdown: `# Private asset for ${owner.key}`,
          metadata: { tenant: owner.key },
        },
        references: [
          {
            evidenceId: sharedEvidenceId,
            quote: `private evidence for ${owner.key}`,
          },
        ],
      });
      const contextResponse = await owner.app.inject({
        method: "GET",
        url: `/v1/projects/${fixture.projectId}/assets/context`,
      });
      expect(
        contextResponse.statusCode,
        contextResponse.body,
      ).toBe(200);
      expect(contextResponse.json()).toEqual({
        assetIds: [
          `document:${fixture.documentId}`,
          sharedAssetId,
        ],
      });
    }

    for (const attackerCase of TENANT_CASES) {
      const attacker = tenantApi(harness, attackerCase.key);
      for (const targetCase of TENANT_CASES) {
        if (attacker.key === targetCase.key) {
          continue;
        }
        const target = fixtures.get(targetCase.key);
        if (target === undefined) {
          throw new Error(`Missing research target for ${targetCase.key}`);
        }

        const deniedResponses = await Promise.all([
          attacker.app.inject({
            method: "GET",
            url: `/v1/projects/${target.projectId}/documents`,
          }),
          attacker.app.inject({
            method: "GET",
            url:
              `/v1/projects/${target.projectId}/documents/` +
              `${target.documentId}/download`,
          }),
          attacker.app.inject({
            method: "DELETE",
            url:
              `/v1/projects/${target.projectId}/documents/` +
              target.documentId,
          }),
          attacker.app.inject({
            method: "GET",
            url:
              `/v1/projects/${target.projectId}/evidence/` +
              sharedEvidenceId,
          }),
          attacker.app.inject({
            method: "GET",
            url:
              `/v1/projects/${target.projectId}/evidence/` +
              `${sharedEvidenceId}/preview`,
          }),
          attacker.app.inject({
            method: "GET",
            url: `/v1/projects/${target.projectId}/source-folders`,
          }),
          attacker.app.inject({
            method: "POST",
            url:
              `/v1/projects/${target.projectId}/source-folders/` +
              `${sharedFolderId}/documents`,
            payload: {
              documentId: target.documentId,
              assignmentSource: "cross-tenant",
              metadata: { attacker: attacker.key },
            },
          }),
          attacker.app.inject({
            method: "GET",
            url:
              `/v1/projects/${target.projectId}/assets/` +
              sharedAssetId,
          }),
          attacker.app.inject({
            method: "PATCH",
            url:
              `/v1/projects/${target.projectId}/assets/` +
              sharedAssetId,
            payload: { archived: true },
          }),
          attacker.app.inject({
            method: "DELETE",
            url:
              `/v1/projects/${target.projectId}/assets/` +
              sharedAssetId,
          }),
          attacker.app.inject({
            method: "GET",
            url: `/v1/projects/${target.projectId}/assets/context`,
          }),
          attacker.app.inject({
            method: "PUT",
            url: `/v1/projects/${target.projectId}/assets/context`,
            payload: {
              assetIds: [
                `document:${target.documentId}`,
                sharedAssetId,
              ],
            },
          }),
        ]);
        for (const response of deniedResponses) {
          expect(response.statusCode, response.body).toBe(404);
          expect(response.json()).toMatchObject({ error: "not_found" });
        }
      }
    }

    for (const ownerCase of TENANT_CASES) {
      const owner = tenantApi(harness, ownerCase.key);
      const fixture = fixtures.get(owner.key);
      if (fixture === undefined) {
        throw new Error(`Missing retained resource for ${owner.key}`);
      }
      const retainedDocument = await owner.app.inject({
        method: "GET",
        url:
          `/v1/projects/${fixture.projectId}/documents/` +
          `${fixture.documentId}/download`,
      });
      expect(retainedDocument.statusCode).toBe(200);
      expect(retainedDocument.rawPayload).toEqual(fixture.contents);

      const retainedAsset = await owner.app.inject({
        method: "GET",
        url:
          `/v1/projects/${fixture.projectId}/assets/` +
          sharedAssetId,
      });
      expect(retainedAsset.statusCode).toBe(200);
      expect(retainedAsset.json()).toMatchObject({
        asset: {
          id: sharedAssetId,
          status: "completed",
          deletedAt: null,
        },
        version: {
          contentMarkdown: `# Private asset for ${owner.key}`,
        },
      });
      const retainedContext = await owner.app.inject({
        method: "GET",
        url: `/v1/projects/${fixture.projectId}/assets/context`,
      });
      expect(retainedContext.statusCode).toBe(200);
      expect(retainedContext.json()).toEqual({
        assetIds: [
          `document:${fixture.documentId}`,
          sharedAssetId,
        ],
      });
    }
  });

  it("ignores forged identity fields and rejects absolute, traversal and symlink escapes", async () => {
    const alpha = tenantApi(harness, "alpha");
    const beta = tenantApi(harness, "beta");
    const gamma = tenantApi(harness, "gamma");

    const alphaProjectResponse = await alpha.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: {
        name: "Alpha boundary project",
        userId: beta.identity.userId,
        dataNamespace: beta.identity.dataNamespace,
        tenantNamespace: beta.identity.dataNamespace,
      },
    });
    expect(
      alphaProjectResponse.statusCode,
      alphaProjectResponse.body,
    ).toBe(201);
    const alphaProject = alphaProjectResponse.json<{ id: string }>();

    const betaProjectResponse = await beta.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Beta secret project" },
    });
    expect(
      betaProjectResponse.statusCode,
      betaProjectResponse.body,
    ).toBe(201);
    const betaProject = betaProjectResponse.json<{ id: string }>();

    expect(
      harness.repositories.projects.findForTenant(
        alpha.identity.dataNamespace,
        alphaProject.id,
      ),
    ).toMatchObject({ userId: alpha.identity.userId });
    expect(
      harness.repositories.projects.findForTenant(
        beta.identity.dataNamespace,
        alphaProject.id,
      ),
    ).toBeNull();
    expect(
      harness.repositories.projects.findForTenant(
        gamma.identity.dataNamespace,
        alphaProject.id,
      ),
    ).toBeNull();

    const alphaProjectRoot = path.join(
      alpha.tenant.projectsRoot,
      alphaProject.id,
    );
    const betaProjectRoot = path.join(
      beta.tenant.projectsRoot,
      betaProject.id,
    );
    const betaSecretDirectory = path.join(
      betaProjectRoot,
      "sources",
      "private",
    );
    const betaSecretPath = path.join(
      betaSecretDirectory,
      "beta-secret.pdf",
    );
    const betaSecret = Buffer.from(
      "%PDF-1.7\nbeta-only-secret\n",
      "utf8",
    );
    await mkdir(betaSecretDirectory, { recursive: true, mode: 0o700 });
    await writeFile(betaSecretPath, betaSecret, {
      flag: "wx",
      mode: 0o600,
    });

    const registration = {
      documentId: "doc_boundary_probe",
      logicalKey: "acceptance:boundary-probe",
      sourceRoot: "acceptance",
      sourceRelpath: "boundary-probe.pdf",
      title: "Boundary probe",
      originalFilename: "boundary-probe.pdf",
      fileType: "pdf",
      mimeType: "application/pdf",
      sha256: sha256(betaSecret),
      fileSize: betaSecret.byteLength,
      status: "indexed",
      metadata: {},
      activate: true,
      userId: beta.identity.userId,
      dataNamespace: beta.identity.dataNamespace,
      tenantNamespace: beta.identity.dataNamespace,
    };

    const absoluteResponse = await alpha.app.inject({
      method: "POST",
      url: `/v1/projects/${alphaProject.id}/documents/register`,
      payload: {
        ...registration,
        storedPath: betaSecretPath,
      },
    });
    expect(absoluteResponse.statusCode, absoluteResponse.body).toBe(400);
    expect(absoluteResponse.json()).toMatchObject({
      error: "invalid_document_path",
    });

    const traversalResponse = await alpha.app.inject({
      method: "POST",
      url: `/v1/projects/${alphaProject.id}/documents/register`,
      payload: {
        ...registration,
        storedPath: path.relative(alphaProjectRoot, betaSecretPath),
      },
    });
    expect(traversalResponse.statusCode, traversalResponse.body).toBe(403);
    expect(traversalResponse.json()).toMatchObject({ error: "forbidden" });

    const alphaSources = path.join(alphaProjectRoot, "sources");
    await mkdir(alphaSources, { recursive: true, mode: 0o700 });
    await symlink(
      betaSecretDirectory,
      path.join(alphaSources, "linked-beta"),
      "dir",
    );
    const symlinkResponse = await alpha.app.inject({
      method: "POST",
      url: `/v1/projects/${alphaProject.id}/documents/register`,
      payload: {
        ...registration,
        storedPath: "sources/linked-beta/beta-secret.pdf",
      },
    });
    expect(symlinkResponse.statusCode, symlinkResponse.body).toBe(403);
    expect(symlinkResponse.json()).toMatchObject({ error: "forbidden" });

    const traversalJobResponse = await alpha.app.inject({
      method: "POST",
      url: "/v1/jobs",
      payload: {
        projectId: alphaProject.id,
        type: "document.ingest",
        payload: {
          inputPath: path.relative(alphaProjectRoot, betaSecretPath),
          outputDirectory: "artifacts/acceptance",
          userId: beta.identity.userId,
          tenantNamespace: beta.identity.dataNamespace,
        },
        idempotencyKey: "tenant-boundary-traversal",
        maxAttempts: 3,
        userId: beta.identity.userId,
        dataNamespace: beta.identity.dataNamespace,
        tenantNamespace: beta.identity.dataNamespace,
      },
    });
    expect(
      traversalJobResponse.statusCode,
      traversalJobResponse.body,
    ).toBe(403);
    expect(traversalJobResponse.json()).toMatchObject({
      error: "forbidden",
    });

    const folderTraversalResponse = await alpha.app.inject({
      method: "POST",
      url: `/v1/projects/${alphaProject.id}/source-folders`,
      payload: {
        name: "../beta-private",
        folderKind: "manual",
        metadata: {
          userId: beta.identity.userId,
          dataNamespace: beta.identity.dataNamespace,
        },
      },
    });
    expect(
      folderTraversalResponse.statusCode,
      folderTraversalResponse.body,
    ).toBe(400);
    expect(folderTraversalResponse.json()).toMatchObject({
      error: "invalid_request",
    });

    const sessionResponse = await alpha.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        projectId: alphaProject.id,
        title: "Symlink history boundary",
        userId: beta.identity.userId,
        dataNamespace: beta.identity.dataNamespace,
      },
    });
    expect(sessionResponse.statusCode, sessionResponse.body).toBe(201);
    const session = sessionResponse.json<{ id: string }>();
    const sessionRecord = harness.repositories.sessions.getForTenant(
      alpha.identity.dataNamespace,
      session.id,
    );
    if (sessionRecord.piSessionFile === null) {
      throw new Error("Acceptance session did not receive a history path");
    }
    await symlink(betaSecretPath, sessionRecord.piSessionFile);

    const forkResponse = await alpha.app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/fork`,
      payload: {},
    });
    expect(forkResponse.statusCode, forkResponse.body).toBe(409);
    expect(forkResponse.json()).toMatchObject({
      error: "invalid_session_history",
    });

    const alphaDocuments = await alpha.app.inject({
      method: "GET",
      url: `/v1/projects/${alphaProject.id}/documents`,
    });
    expect(alphaDocuments.statusCode).toBe(200);
    expect(alphaDocuments.json()).toMatchObject({ items: [], total: 0 });

    const alphaFolders = await alpha.app.inject({
      method: "GET",
      url: `/v1/projects/${alphaProject.id}/source-folders`,
    });
    expect(alphaFolders.statusCode).toBe(200);
    expect(alphaFolders.json()).toEqual({
      folders: [],
      assignments: [],
    });

    const alphaJobs = await alpha.app.inject({
      method: "GET",
      url: "/v1/jobs",
    });
    expect(alphaJobs.statusCode).toBe(200);
    expect(alphaJobs.json()).toEqual({ jobs: [] });

    const alphaSessions = await alpha.app.inject({
      method: "GET",
      url: "/v1/sessions",
    });
    expect(alphaSessions.statusCode).toBe(200);
    expect(
      alphaSessions.json<{ sessions: Array<{ id: string }> }>().sessions,
    ).toEqual([expect.objectContaining({ id: session.id })]);

    await expect(readFile(betaSecretPath)).resolves.toEqual(betaSecret);
  });
});
