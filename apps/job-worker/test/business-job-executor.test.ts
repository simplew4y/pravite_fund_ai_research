import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DurableJobQueue,
  type EnqueueJobInput,
} from "@private-fund/job-queue";
import {
  createControlRepositories,
  openControlDatabase,
  type ControlDatabase,
} from "@private-fund/db";
import {
  createResearchStore,
  openProjectDatabase,
} from "@private-fund/research-store";
import { createWorkflowStore } from "@private-fund/workflow-store";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  RepositoryBusinessJobExecutor,
  type BusinessJob,
} from "../src/business-job-executor.js";

const TENANT = "00000000-0000-4000-8000-000000000021";
const PROJECT = "business-project";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function job(
  type: BusinessJob["type"],
  payload: Record<string, unknown>,
  id = `job-${type.replaceAll(".", "-")}`,
): BusinessJob {
  return {
    id,
    type,
    tenantNamespace: TENANT,
    projectId: PROJECT,
    payload,
    attempt: 1,
    createdAt: "2026-07-31T00:00:00.000Z",
  };
}

describe("RepositoryBusinessJobExecutor", () => {
  let dataRoot: string;
  let projectRoot: string;
  let controlDatabases: ControlDatabase[];

  beforeEach(async () => {
    controlDatabases = [];
    dataRoot = await mkdtemp(path.join(tmpdir(), "business-jobs-"));
    projectRoot = path.join(
      dataRoot,
      "users",
      TENANT,
      "projects",
      PROJECT,
    );
    await mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    for (const database of controlDatabases) {
      database.close();
    }
    await rm(dataRoot, { recursive: true, force: true });
  });

  function queueFixture() {
    let now = new Date("2026-07-31T00:00:00.000Z");
    const clock = () => new Date(now);
    const database = openControlDatabase(":memory:", { clock });
    controlDatabases.push(database);
    const repositories = createControlRepositories(database, clock);
    repositories.users.upsertCloudShadow({
      userId: "business-jobs-user",
      dataNamespace: TENANT,
    });
    repositories.projects.createForTenant(TENANT, {
      id: PROJECT,
      name: "Business jobs project",
    });
    return {
      queue: new DurableJobQueue(database, clock),
      advance(milliseconds: number): void {
        now = new Date(now.getTime() + milliseconds);
      },
    };
  }

  async function sourceFixture(text: string) {
    const sourcePath = path.join(projectRoot, "sources", "source.txt");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, text, "utf8");
    const database = openProjectDatabase({
      projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
      preferredSearchBackend: "deterministic",
    });
    try {
      const research = createResearchStore(database);
      const registered = research.documents.registerVersion({
        logicalKey: "company:source",
        sourceRoot: "test",
        sourceRelpath: "source.txt",
        title: "Company source",
        originalFilename: "source.txt",
        storedPath: path.relative(projectRoot, sourcePath),
        fileType: "txt",
        mimeType: "text/plain",
        sha256: digest(text),
        fileSize: Buffer.byteLength(text),
        status: "indexed",
      });
      const evidence = research.evidence.put({
        evidenceId: `chunk:${digest(text).slice(0, 32)}`,
        kind: "chunk",
        documentVersionId: registered.version.id,
        title: "Operating update",
        originalText: text,
        locator: {
          sourceRef: "source.txt",
          headingPath: "Update",
        },
      }).evidence;
      return { registered, evidence };
    } finally {
      database.close();
    }
  }

  it("creates an Evidence-backed memo, asset and idempotent render child job", async () => {
    const source = await sourceFixture(
      "核心逻辑：收入增长 28%，但供应链风险仍需持续验证。",
    );
    const enqueued: EnqueueJobInput[] = [];
    const childJobs = {
      enqueue: vi.fn((input: EnqueueJobInput) => {
        enqueued.push(input);
        return {
          created: true,
          job: { id: "job-render-1" },
        } as never;
      }),
    };
    const executor = new RepositoryBusinessJobExecutor({
      dataRoot,
      childJobs,
    });
    const request = job("memo.generate", {
      datasetId: PROJECT,
      topic: "季度跟踪",
      instruction: "生成有证据的季度更新",
      evidenceIds: [source.evidence.evidenceId],
    });

    const result = await executor.execute(request);
    expect(result).toMatchObject({
      kind: "memo.generate",
      evidenceCount: 1,
      renderJobId: "job-render-1",
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      type: "report.generate",
      tenantNamespace: TENANT,
      projectId: PROJECT,
    });
    const markdownPath = path.join(
      projectRoot,
      String(result.markdownPath),
    );
    await expect(readFile(markdownPath, "utf8")).resolves.toContain(
      source.evidence.evidenceId,
    );

    const database = openProjectDatabase({
      projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
      preferredSearchBackend: "deterministic",
    });
    try {
      const workflow = createWorkflowStore(database.connection);
      expect(
        workflow.tracking.listMemoVersions(PROJECT, { limit: 100 }).total,
      ).toBe(1);
      expect(createResearchStore(database).assets.list({}).total).toBe(1);
    } finally {
      database.close();
    }
  });

  it("recovers a memo job after durable writes but before queue completion without duplicates", async () => {
    const source = await sourceFixture(
      "核心逻辑：收入增长 28%，但供应链风险仍需持续验证。",
    );
    const durable = queueFixture();
    const queued = durable.queue.enqueue({
      tenantNamespace: TENANT,
      projectId: PROJECT,
      type: "memo.generate",
      payload: {
        datasetId: PROJECT,
        topic: "季度跟踪",
        instruction: "生成有证据的季度更新",
        evidenceIds: [source.evidence.evidenceId],
      },
      idempotencyKey: "memo-crash-recovery",
      maxAttempts: 3,
    }).job;
    const executor = new RepositoryBusinessJobExecutor({
      dataRoot,
      childJobs: durable.queue,
    });

    const firstClaim = durable.queue.claim({
      workerId: "memo-worker-before-crash",
      types: ["memo.generate"],
      leaseDurationMs: 100,
    });
    expect(firstClaim?.id).toBe(queued.id);
    const firstResult = await executor.execute(firstClaim!);
    expect(firstResult).toMatchObject({
      kind: "memo.generate",
      idempotentReplay: false,
      renderJobId: expect.any(String),
    });

    // Simulate a process crash after the project DB and child queue writes:
    // intentionally do not call queue.complete for the first lease.
    durable.advance(101);
    const reclaimed = durable.queue.claim({
      workerId: "memo-worker-after-crash",
      types: ["memo.generate"],
      leaseDurationMs: 1_000,
    });
    expect(reclaimed).toMatchObject({
      id: queued.id,
      attempt: 2,
      leaseOwner: "memo-worker-after-crash",
    });
    const replay = await executor.execute(reclaimed!);
    expect(replay).toMatchObject({
      kind: "memo.generate",
      idempotentReplay: true,
      memoVersionId: firstResult.memoVersionId,
      assetId: firstResult.assetId,
      renderJobId: firstResult.renderJobId,
    });
    durable.queue.complete({
      jobId: reclaimed!.id,
      workerId: "memo-worker-after-crash",
      result: replay,
    });

    expect(
      durable.queue.listForTenant(TENANT, {
        projectId: PROJECT,
        type: "report.generate",
      }),
    ).toHaveLength(1);
    const database = openProjectDatabase({
      projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
      preferredSearchBackend: "deterministic",
    });
    try {
      const workflow = createWorkflowStore(database.connection);
      expect(
        workflow.tracking.listMemoVersions(PROJECT, { limit: 100 }).total,
      ).toBe(1);
      const assets = createResearchStore(database).assets;
      expect(assets.list({}).total).toBe(1);
      expect(
        assets.get(String(replay.assetId)).currentVersionNo,
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it("rejects mismatched dataset scope before opening business data", async () => {
    const executor = new RepositoryBusinessJobExecutor({ dataRoot });
    await expect(
      executor.execute(
        job("memo.generate", {
          datasetId: "another-project",
          topic: "季度跟踪",
        }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_business_job",
      retryable: false,
    });
  });
});
