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

  it("scans current Evidence into durable tracking items idempotently", async () => {
    const source = await sourceFixture(
      "主要风险：原材料价格上涨可能导致毛利率下降 5%。",
    );
    const executor = new RepositoryBusinessJobExecutor({ dataRoot });
    const request = job("tracking.scan", {
      datasetId: PROJECT,
      includeHistory: false,
    });

    await expect(executor.execute(request)).resolves.toMatchObject({
      kind: "tracking.scan",
      scannedEvidence: 1,
      matchedEvidence: 1,
      createdVersions: 1,
    });
    await expect(executor.execute(request)).resolves.toMatchObject({
      createdVersions: 0,
    });

    const database = openProjectDatabase({
      projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
      preferredSearchBackend: "deterministic",
    });
    try {
      const tracking = createWorkflowStore(database.connection).tracking;
      const items = tracking.listItems(PROJECT, { limit: 100 });
      expect(items.total).toBe(1);
      expect(items.items[0]).toMatchObject({
        itemType: "risk",
        currentVersionNo: 1,
        currentVersion: {
          evidenceIds: [source.evidence.evidenceId],
        },
      });
      expect(
        tracking.getItemTimeline(PROJECT, items.items[0]!.itemId)
          .observations,
      ).toHaveLength(1);
    } finally {
      database.close();
    }
  });

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

  it("reclaims and replays a valuation comparison without duplicate analysis state", async () => {
    const source = await sourceFixture("估值模型输入。");
    const database = openProjectDatabase({
      projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
      preferredSearchBackend: "deterministic",
    });
    let analysisId: string;
    let seriesId: string;
    try {
      const workflow = createWorkflowStore(database.connection);
      const valuation = workflow.valuation;
      const series = valuation.upsertSeries({
        datasetId: PROJECT,
        seriesKey: "model",
        name: "Model",
      });
      seriesId = series.seriesId;
      const base = valuation.saveModelVersion({
        datasetId: PROJECT,
        seriesId: series.seriesId,
        docId: "document-version-base",
        documentVersionNo: 1,
        checksum: "a".repeat(64),
        snapshotHash: "b".repeat(64),
        originalFilename: "model.xlsx",
        nodeCount: 1,
        formulaNodeCount: 0,
        reviewRequiredCount: 0,
        analyzerVersion: "extractor-v1",
      }).value;
      const comparison = valuation.saveModelVersion({
        datasetId: PROJECT,
        seriesId: series.seriesId,
        docId: "document-version-comparison",
        documentVersionNo: 2,
        checksum: "c".repeat(64),
        snapshotHash: "d".repeat(64),
        originalFilename: "model.xlsx",
        nodeCount: 1,
        formulaNodeCount: 0,
        reviewRequiredCount: 0,
        analyzerVersion: "extractor-v1",
      }).value;
      const node = valuation.upsertNode({
        seriesId: series.seriesId,
        canonicalKey: "DCF!B12",
        nodeKind: "assumption",
        metricKey: "wacc",
        displayName: "WACC",
        scope: "model",
      });
      valuation.saveNodeValue({
        modelVersionId: base.modelVersionId,
        nodeId: node.nodeId,
        valueNumeric: 0.08,
        valueText: "0.08",
        unit: "ratio",
        sheetName: "DCF",
        cellRef: "B12",
        evidenceId: source.evidence.evidenceId,
        qualityStatus: "verified",
        metadata: { rawValue: 0.08 },
      });
      valuation.saveNodeValue({
        modelVersionId: comparison.modelVersionId,
        nodeId: node.nodeId,
        valueNumeric: 0.1,
        valueText: "0.1",
        unit: "ratio",
        sheetName: "DCF",
        cellRef: "B12",
        evidenceId: source.evidence.evidenceId,
        qualityStatus: "verified",
        metadata: { rawValue: 0.1 },
      });
      analysisId = valuation.createAgentAnalysis({
        datasetId: PROJECT,
        seriesId: series.seriesId,
        baseModelVersionId: base.modelVersionId,
        comparisonModelVersionId: comparison.modelVersionId,
        focus: "WACC",
        agentVersion: "pi-agent-v1",
        idempotencyKey: "analysis-1",
      }).value.analysisId;
    } finally {
      database.close();
    }

    const durable = queueFixture();
    const queued = durable.queue.enqueue({
      tenantNamespace: TENANT,
      projectId: PROJECT,
      type: "valuation.compare",
      payload: {
        datasetId: PROJECT,
        analysisId,
      },
      idempotencyKey: "valuation-compare-crash-recovery",
      maxAttempts: 3,
    }).job;
    const executor = new RepositoryBusinessJobExecutor({ dataRoot });
    const firstClaim = durable.queue.claim({
      workerId: "valuation-worker-before-crash",
      types: ["valuation.compare"],
      leaseDurationMs: 100,
    });
    expect(firstClaim?.id).toBe(queued.id);
    await expect(executor.execute(firstClaim!)).resolves.toMatchObject({
      kind: "valuation.compare",
      status: "completed",
      changeCount: 1,
      recommendationCount: 1,
    });
    durable.advance(101);
    const reclaimed = durable.queue.claim({
      workerId: "valuation-worker-after-crash",
      types: ["valuation.compare"],
      leaseDurationMs: 1_000,
    });
    expect(reclaimed).toMatchObject({ id: queued.id, attempt: 2 });
    const replay = await executor.execute(reclaimed!);
    expect(replay).toMatchObject({
      kind: "valuation.compare",
      status: "completed",
      idempotentReplay: true,
      analysisId,
    });
    durable.queue.complete({
      jobId: reclaimed!.id,
      workerId: "valuation-worker-after-crash",
      result: replay,
    });

    const check = openProjectDatabase({
      projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
      preferredSearchBackend: "deterministic",
    });
    try {
      const saved = createWorkflowStore(
        check.connection,
      ).valuation.getAgentAnalysis(PROJECT, analysisId);
      expect(saved.status).toBe("completed");
      expect(saved.analysis.recommendedChanges).toEqual([
        expect.objectContaining({
          sheet: "DCF",
          cell: "B12",
          expectedCurrentValue: 0.08,
          value: 0.1,
        }),
      ]);
      expect(saved.evidenceIds).toEqual([source.evidence.evidenceId]);
      expect(
        createWorkflowStore(check.connection).valuation.listAgentAnalyses(
          PROJECT,
          { seriesId, limit: 100 },
        ).total,
      ).toBe(1);
      expect(
        createWorkflowStore(check.connection).valuation.listChanges(
          PROJECT,
          seriesId,
          { limit: 100 },
        ).total,
      ).toBe(1);
    } finally {
      check.close();
    }
  });

  it("rejects mismatched dataset scope before opening business data", async () => {
    const executor = new RepositoryBusinessJobExecutor({ dataRoot });
    await expect(
      executor.execute(
        job("tracking.scan", {
          datasetId: "another-project",
          includeHistory: false,
        }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_business_job",
      retryable: false,
    });
  });
});
