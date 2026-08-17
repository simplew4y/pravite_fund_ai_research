import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPythonComputeClient } from "@private-fund/compute-client";
import { ComputeResultProjector } from "@private-fund/compute-projector";
import type { ComputeResponse } from "@private-fund/contracts";
import { buildTenantContext } from "@private-fund/core";
import {
  createControlRepositories,
  openControlDatabase,
} from "@private-fund/db";
import { DurableJobQueue } from "@private-fund/job-queue";
import {
  createResearchStore,
  openProjectDatabase,
} from "@private-fund/research-store";
import { createWorkflowStore } from "@private-fund/workflow-store";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { RepositoryProjectInsightsService } from "../../api/src/insights-service.js";
import {
  RepositoryJobService,
  RepositoryProjectService,
} from "../../api/src/repository-services.js";
import { ProjectResearchStoreManager } from "../../api/src/research-stores.js";
import {
  ComputeJobExecutor,
  type ComputeJob,
} from "../src/compute-job-executor.js";
import { TenantProjectComputePathPolicy } from "../src/path-policy.js";
import { JobWorker } from "../src/worker.js";
import { WorkflowComputeProjectionHandler } from "../src/workflow-compute-handlers.js";

const TENANT = "00000000-0000-4000-8000-000000000031";
const PROJECT = "workflow-compute-project";
const pythonWorker = fileURLToPath(
  new URL("../../../python/compute-worker/worker.py", import.meta.url),
);
const temporaryDirectories: string[] = [];

interface ProjectFixture {
  readonly dataRoot: string;
  readonly projectRoot: string;
}

function digest(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function prefixedDigest(data: string | Buffer): string {
  return `sha256:${digest(data)}`;
}

function cellEvidenceId(
  documentVersionId: string,
  sheet: string,
  coordinate: string,
): string {
  return `cell:${createHash("sha256")
    .update(`${documentVersionId}\0${sheet}\0${coordinate}`)
    .digest("hex")
    .slice(0, 48)}`;
}

async function projectFixture(): Promise<ProjectFixture> {
  const dataRoot = await mkdtemp(
    path.join(tmpdir(), "workflow-compute-handler-"),
  );
  temporaryDirectories.push(dataRoot);
  const projectRoot = path.join(
    dataRoot,
    "users",
    TENANT,
    "projects",
    PROJECT,
  );
  await mkdir(projectRoot, { recursive: true });
  return { dataRoot, projectRoot };
}

async function writeArtifact(
  outputDirectory: string,
  artifactPath: string,
  mediaType: string,
  contents: string | Buffer,
): Promise<ComputeResponse["artifacts"][number]> {
  const bytes =
    typeof contents === "string" ? Buffer.from(contents, "utf8") : contents;
  const absolutePath = path.join(outputDirectory, artifactPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);
  return {
    path: artifactPath,
    mediaType,
    checksum: prefixedDigest(bytes),
    size: bytes.length,
  };
}

function completedResponse(
  recordsFile: string,
  artifacts: ComputeResponse["artifacts"],
  metrics: ComputeResponse["metrics"],
): ComputeResponse {
  return {
    protocolVersion: 1,
    requestId: `request-${recordsFile.replaceAll(/[^A-Za-z0-9]/gu, "-")}`,
    status: "completed",
    recordsFile,
    artifacts,
    metrics,
    error: null,
  };
}

function computeJob(
  id: string,
  type: ComputeJob["type"],
  payload: Readonly<Record<string, unknown>>,
): ComputeJob {
  return {
    id,
    tenantNamespace: TENANT,
    projectId: PROJECT,
    type,
    payload,
    attempt: 1,
  };
}

function projector(dataRoot: string): ComputeResultProjector {
  return new ComputeResultProjector({
    dataRoot,
    handlers: [new WorkflowComputeProjectionHandler()],
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("WorkflowComputeProjectionHandler", () => {
  it("atomically projects workbook cells into valuation versions and Evidence links", async () => {
    const fixture = await projectFixture();
    const inputPath = path.join(
      fixture.projectRoot,
      "sources",
      "model.xlsx",
    );
    const outputDirectory = path.join(
      fixture.projectRoot,
      "artifacts",
      "valuation-extract",
    );
    const source = Buffer.from("bounded synthetic workbook source");
    await mkdir(path.dirname(inputPath), { recursive: true });
    await writeFile(inputPath, source);

    const database = openProjectDatabase({
      projectRoot: fixture.projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
      preferredSearchBackend: "deterministic",
    });
    const research = createResearchStore(database);
    const registration = research.documents.registerVersion({
      logicalKey: "valuation:model",
      sourceRoot: "test",
      sourceRelpath: "model.xlsx",
      title: "Alpha valuation model",
      originalFilename: "model.xlsx",
      storedPath: path.relative(fixture.projectRoot, inputPath),
      fileType: "xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sha256: digest(source),
      fileSize: source.length,
      status: "indexed",
      metadata: {
        companyName: "Alpha Holdings",
        ticker: "600519.SH",
        docSubtype: "dcf",
      },
    });
    const evidenceA1 = cellEvidenceId(
      registration.version.id,
      "Model",
      "A1",
    );
    const evidenceB1 = cellEvidenceId(
      registration.version.id,
      "Model",
      "B1",
    );
    research.evidence.put({
      evidenceId: evidenceA1,
      kind: "cell",
      documentVersionId: registration.version.id,
      title: "Model!A1",
      originalText: "Model!A1: 10",
      locator: {
        sourceRef: "model.xlsx",
        sheetName: "Model",
        cellRange: "A1",
        cellRef: "A1",
      },
    });
    database.close();

    const records = [
      {
        recordType: "workbook",
        sourceName: "model.xlsx",
        sheetNames: ["Model"],
      },
      {
        recordType: "worksheet",
        sheet: "Model",
        maxRow: 1,
        maxColumn: 2,
      },
      {
        recordType: "cell",
        sheet: "Model",
        coordinate: "A1",
        row: 1,
        column: 1,
        value: 10,
        formula: null,
        cachedValue: null,
        dataType: "n",
        numberFormat: "0.00",
      },
      {
        recordType: "cell",
        sheet: "Model",
        coordinate: "B1",
        row: 1,
        column: 2,
        value: null,
        formula: "=A1*2",
        cachedValue: 20,
        dataType: "f",
        numberFormat: "0.00",
      },
    ];
    const recordsContents = `${records
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`;
    const recordsArtifact = await writeArtifact(
      outputDirectory,
      "workbook-records.ndjson",
      "application/x-ndjson",
      recordsContents,
    );
    const response = completedResponse(
      recordsArtifact.path,
      [recordsArtifact],
      {
        inputChecksum: prefixedDigest(source),
        recordCount: records.length,
        sheetCount: 1,
        cellCount: 2,
      },
    );
    const job = computeJob("job-valuation-extract", "valuation.extract", {
      datasetId: PROJECT,
      inputPath,
      outputDirectory,
      documentId: registration.document.id,
      documentVersionId: registration.version.id,
    });
    const resultProjector = projector(fixture.dataRoot);

    await expect(resultProjector.project(job, response)).rejects.toMatchObject({
      code: "projection_integrity_mismatch",
      retryable: true,
    });
    const afterRollback = openProjectDatabase({
      projectRoot: fixture.projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
      preferredSearchBackend: "deterministic",
    });
    expect(
      createWorkflowStore(afterRollback.connection).valuation.listSeries(
        PROJECT,
      ).total,
    ).toBe(0);
    createResearchStore(afterRollback).evidence.put({
      evidenceId: evidenceB1,
      kind: "cell",
      documentVersionId: registration.version.id,
      title: "Model!B1",
      originalText: "Model!B1: 20",
      locator: {
        sourceRef: "model.xlsx",
        sheetName: "Model",
        cellRange: "B1",
        cellRef: "B1",
        formula: "=A1*2",
      },
    });
    afterRollback.close();

    await expect(resultProjector.project(job, response)).resolves.toMatchObject(
      {
        kind: "extension",
        handler: "workflow-compute-v1",
        details: {
          operation: "valuation.extract",
          nodeCount: 2,
          formulaNodeCount: 1,
        },
      },
    );
    await expect(resultProjector.project(job, response)).resolves.toMatchObject(
      {
        kind: "extension",
        details: { operation: "valuation.extract" },
      },
    );

    const projected = openProjectDatabase({
      projectRoot: fixture.projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
      preferredSearchBackend: "deterministic",
    });
    try {
      const valuation = createWorkflowStore(projected.connection).valuation;
      const series = valuation.listSeries(PROJECT);
      expect(series.total).toBe(1);
      expect(series.items[0]).toMatchObject({
        companyName: "Alpha Holdings",
        companyTicker: "600519.SH",
        modelType: "dcf",
      });
      const versions = valuation.listModelVersions(
        PROJECT,
        series.items[0]!.seriesId,
      );
      expect(versions.total).toBe(1);
      expect(
        valuation.listNodeValues(versions.items[0]!.modelVersionId).items,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cellRef: "A1",
            valueNumeric: 10,
            evidenceId: evidenceA1,
          }),
          expect.objectContaining({
            cellRef: "B1",
            valueNumeric: 20,
            formula: "=A1*2",
            evidenceId: evidenceB1,
          }),
        ]),
      );
      expect(
        valuation.getAnalysisForModelVersion(
          PROJECT,
          versions.items[0]!.modelVersionId,
          "ts-workbook-extractor-v1",
        ),
      ).toMatchObject({ status: "completed" });
    } finally {
      projected.close();
    }
  });

  it("runs an API-produced valuation.extract job through worker lease recovery idempotently", async () => {
    const fixture = await projectFixture();
    const control = openControlDatabase(":memory:");
    const repositories = createControlRepositories(control);
    repositories.users.upsertCloudShadow({
      userId: "valuation-run-worker-user",
      dataNamespace: TENANT,
    });
    const tenant = buildTenantContext(fixture.dataRoot, {
      userId: "valuation-run-worker-user",
      dataNamespace: TENANT,
    });
    const projects = new RepositoryProjectService(repositories);
    const project = await projects.create(tenant, {
      name: "Valuation run worker recovery",
    });
    const projectRoot = path.join(tenant.projectsRoot, project.id);
    const stores = new ProjectResearchStoreManager();
    try {
      const source = Buffer.from("bounded producer workbook fixture");
      const inputPath = path.join(projectRoot, "sources", "model.xlsx");
      await mkdir(path.dirname(inputPath), { recursive: true });
      await writeFile(inputPath, source);
      const research = stores.get(projectRoot);
      const registration = research.documents.registerVersion({
        logicalKey: "valuation:producer-model",
        sourceRoot: "test",
        sourceRelpath: "model.xlsx",
        title: "Producer valuation model",
        originalFilename: "model.xlsx",
        storedPath: path.relative(projectRoot, inputPath),
        fileType: "xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sha256: digest(source),
        fileSize: source.length,
        status: "indexed",
        activate: true,
      });
      const evidenceA1 = cellEvidenceId(
        registration.version.id,
        "Model",
        "A1",
      );
      const evidenceB1 = cellEvidenceId(
        registration.version.id,
        "Model",
        "B1",
      );
      for (const [evidenceId, coordinate, value] of [
        [evidenceA1, "A1", "10"],
        [evidenceB1, "B1", "20"],
      ] as const) {
        research.evidence.put({
          evidenceId,
          kind: "cell",
          documentVersionId: registration.version.id,
          title: `Model!${coordinate}`,
          originalText: `Model!${coordinate}: ${value}`,
          locator: {
            sourceRef: "model.xlsx",
            sheetName: "Model",
            cellRange: coordinate,
            cellRef: coordinate,
          },
        });
      }

      const jobs = new RepositoryJobService(control);
      const insights = new RepositoryProjectInsightsService(
        repositories,
        stores,
        jobs,
      );
      const produced = await insights.runValuationTracking(
        tenant,
        project.id,
        {
          idempotencyKey: "valuation-run-worker-recovery",
          includeHistory: false,
          refreshMarket: false,
        },
      );
      expect(produced.jobs).toHaveLength(1);
      const producedJob = produced.jobs[0]!.job;
      expect(producedJob).toMatchObject({
        type: "valuation.extract",
        payload: {
          datasetId: project.id,
          documentId: registration.document.id,
          documentVersionId: registration.version.id,
          inputPath: await realpath(inputPath),
          computeOperation: "extract_workbook",
        },
      });
      expect(path.isAbsolute(String(producedJob.payload.inputPath))).toBe(
        true,
      );
      expect(
        path.isAbsolute(String(producedJob.payload.outputDirectory)),
      ).toBe(true);

      const records = [
        {
          recordType: "workbook",
          sourceName: "model.xlsx",
          sheetNames: ["Model"],
        },
        {
          recordType: "worksheet",
          sheet: "Model",
          maxRow: 1,
          maxColumn: 2,
        },
        {
          recordType: "cell",
          sheet: "Model",
          coordinate: "A1",
          row: 1,
          column: 1,
          value: 10,
          formula: null,
          cachedValue: null,
          dataType: "n",
          numberFormat: "0.00",
        },
        {
          recordType: "cell",
          sheet: "Model",
          coordinate: "B1",
          row: 1,
          column: 2,
          value: null,
          formula: "=A1*2",
          cachedValue: 20,
          dataType: "f",
          numberFormat: "0.00",
        },
      ];
      const recordsContents = `${records
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`;
      const recordsArtifact = await writeArtifact(
        String(producedJob.payload.outputDirectory),
        "workbook-records.ndjson",
        "application/x-ndjson",
        recordsContents,
      );
      const response = completedResponse(
        recordsArtifact.path,
        [recordsArtifact],
        {
          inputChecksum: prefixedDigest(source),
          recordCount: records.length,
          sheetCount: 1,
          cellCount: 2,
        },
      );
      stores.close();

      const queue = new DurableJobQueue(control);
      const transport = {
        execute: vi.fn(async (request: { readonly requestId: string }) => ({
          ...response,
          requestId: request.requestId,
        })),
      };
      const executor = new ComputeJobExecutor(
        transport,
        new TenantProjectComputePathPolicy(fixture.dataRoot),
      );
      const resultProjector = projector(fixture.dataRoot);
      const crash = new Error(
        "simulated process exit before durable queue completion",
      );
      const crashingQueue = {
        claim: queue.claim.bind(queue),
        heartbeat: queue.heartbeat.bind(queue),
        complete: () => {
          throw crash;
        },
        fail: () => {
          throw crash;
        },
      };
      const firstWorker = new JobWorker(
        crashingQueue,
        executor,
        resultProjector,
        {
          workerId: "valuation-worker-before-crash",
          leaseDurationMs: 60_000,
        },
      );
      await expect(firstWorker.runOnce()).rejects.toBe(crash);

      control
        .prepare(
          `UPDATE jobs
           SET lease_expires_at = '2000-01-01T00:00:00.000Z'
           WHERE id = ? AND status = 'running'`,
        )
        .run(producedJob.id);
      const recoveryWorker = new JobWorker(
        queue,
        executor,
        resultProjector,
        {
          workerId: "valuation-worker-after-crash",
          leaseDurationMs: 60_000,
        },
      );
      await expect(recoveryWorker.runOnce()).resolves.toBe(true);
      expect(queue.getForTenant(TENANT, producedJob.id)).toMatchObject({
        status: "completed",
        attempt: 2,
        error: null,
      });
      expect(transport.execute).toHaveBeenCalledTimes(2);

      const projected = openProjectDatabase({
        projectRoot,
        databasePath: path.join("data", "research.sqlite3"),
        preferredSearchBackend: "deterministic",
      });
      try {
        const valuation = createWorkflowStore(
          projected.connection,
        ).valuation;
        const series = valuation.listSeries(project.id);
        expect(series.total).toBe(1);
        const versions = valuation.listModelVersions(
          project.id,
          series.items[0]!.seriesId,
        );
        expect(versions.total).toBe(1);
        expect(
          valuation.listAnalysisVersions(
            project.id,
            series.items[0]!.seriesId,
          ).total,
        ).toBe(1);
        expect(
          valuation.listNodeValues(
            versions.items[0]!.modelVersionId,
          ).total,
        ).toBe(2);
      } finally {
        projected.close();
      }
    } finally {
      stores.close();
      control.close();
    }
  });

  it("runs fixture market compute and atomically persists snapshot metrics", async () => {
    const fixture = await projectFixture();
    const inputPath = path.join(
      fixture.projectRoot,
      "sources",
      "market-request.json",
    );
    const outputDirectory = path.join(
      fixture.projectRoot,
      "artifacts",
      "market-refresh",
    );
    await mkdir(path.dirname(inputPath), { recursive: true });
    await writeFile(
      inputPath,
      `${JSON.stringify(
        {
          provider: "fixture",
          ticker: "600519.SH",
          startDate: "2026-07-27",
          endDate: "2026-07-29",
          retrievedAt: "2026-07-30T00:00:00Z",
          source: "offline integration fixture",
          bars: [
            {
              tradeDate: "2026-07-29",
              open: 1420,
              high: 1455,
              low: 1410,
              close: 1448,
              volume: 12_000,
              amount: 17_280_000,
            },
            {
              tradeDate: "2026-07-27",
              open: 1400,
              high: 1430,
              low: 1390,
              close: 1420,
              volume: 10_000,
              amount: 14_100_000,
            },
            {
              tradeDate: "2026-07-28",
              open: 1422,
              high: 1440,
              low: 1408,
              close: 1418,
              volume: 11_000,
              amount: 15_600_000,
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const database = openProjectDatabase({
      projectRoot: fixture.projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
      preferredSearchBackend: "deterministic",
    });
    const valuation = createWorkflowStore(database.connection).valuation;
    const series = valuation.upsertSeries({
      datasetId: PROJECT,
      seriesKey: "market:alpha",
      name: "Alpha model",
      companyName: "Alpha Holdings",
      companyTicker: "600519.SH",
      modelType: "dcf",
    });
    const version = valuation.saveModelVersion({
      datasetId: PROJECT,
      seriesId: series.seriesId,
      docId: "document-version-market",
      documentVersionNo: 1,
      checksum: "a".repeat(64),
      snapshotHash: "b".repeat(64),
      originalFilename: "alpha.xlsx",
      modelType: "dcf",
      nodeCount: 0,
      analyzerVersion: "test-v1",
    }).value;
    valuation.upsertMetricModelValue({
      datasetId: PROJECT,
      seriesId: series.seriesId,
      modelVersionId: version.modelVersionId,
      metricKey: "avg_turnover_amount_20d",
      valueNumeric: 15_000_000,
      unit: "currency",
      period: "2026-07-29",
      status: "available",
      method: "model",
      source: "Model!A1",
      evidenceIds: [],
      qualityStatus: "verified",
    });
    database.close();

    const job = computeJob("job-market-refresh", "market.refresh", {
      datasetId: PROJECT,
      seriesId: series.seriesId,
      modelVersionId: version.modelVersionId,
      snapshotId: "market-snapshot-1",
      inputPath,
      outputDirectory,
      options: {},
    });
    const executor = new ComputeJobExecutor(
      createPythonComputeClient({
        workerScript: pythonWorker,
        timeoutMs: 5_000,
      }),
      new TenantProjectComputePathPolicy(fixture.dataRoot),
    );
    const response = await executor.execute(job);
    const resultProjector = projector(fixture.dataRoot);

    await expect(resultProjector.project(job, response)).resolves.toMatchObject(
      {
        kind: "extension",
        details: {
          operation: "market.refresh",
          snapshotId: "market-snapshot-1",
          barCount: 3,
          metricCount: 2,
        },
      },
    );
    await expect(resultProjector.project(job, response)).resolves.toMatchObject(
      {
        kind: "extension",
        details: { operation: "market.refresh" },
      },
    );

    const projected = openProjectDatabase({
      projectRoot: fixture.projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
      preferredSearchBackend: "deterministic",
    });
    try {
      const repository = createWorkflowStore(
        projected.connection,
      ).valuation;
      expect(
        repository.getMarketSnapshot(PROJECT, "market-snapshot-1"),
      ).toMatchObject({
        status: "completed",
        asOf: "2026-07-29",
        provider: "fixture",
      });
      expect(
        repository.listMetricActualValues("market-snapshot-1"),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            metricKey: "latest_close",
            valueNumeric: 1448,
          }),
          expect.objectContaining({
            metricKey: "avg_turnover_amount_20d",
            status: "partial",
          }),
        ]),
      );
      expect(
        repository.listMetricComparisons("market-snapshot-1"),
      ).toEqual([
        expect.objectContaining({
          metricKey: "avg_turnover_amount_20d",
          absoluteGap: 660_000,
          status: "completed",
        }),
      ]);
    } finally {
      projected.close();
    }
  });

  it("projects a derived workbook only for its completed bound analysis", async () => {
    const fixture = await projectFixture();
    const inputPath = path.join(
      fixture.projectRoot,
      "sources",
      "base-model.xlsx",
    );
    const outputDirectory = path.join(
      fixture.projectRoot,
      "artifacts",
      "valuation-derived",
    );
    const source = Buffer.from("immutable base workbook bytes");
    await mkdir(path.dirname(inputPath), { recursive: true });
    await writeFile(inputPath, source);

    const database = openProjectDatabase({
      projectRoot: fixture.projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
      preferredSearchBackend: "deterministic",
    });
    const valuation = createWorkflowStore(database.connection).valuation;
    const series = valuation.upsertSeries({
      datasetId: PROJECT,
      seriesKey: "derived:alpha",
      name: "Alpha base model",
      companyName: "Alpha Holdings",
      companyTicker: "600519.SH",
      modelType: "dcf",
    });
    const base = valuation.saveModelVersion({
      datasetId: PROJECT,
      seriesId: series.seriesId,
      docId: "base-document-version",
      documentVersionNo: 1,
      checksum: digest(source),
      snapshotHash: "c".repeat(64),
      originalFilename: "base-model.xlsx",
      modelType: "dcf",
      nodeCount: 0,
      analyzerVersion: "test-v1",
    }).value;
    const analysis = valuation.createAgentAnalysis({
      analysisId: "analysis-derived-1",
      datasetId: PROJECT,
      seriesId: series.seriesId,
      baseModelVersionId: base.modelVersionId,
      focus: "Update revenue assumption",
      agentVersion: "pi-valuation-v1",
    }).value;
    valuation.transitionAgentAnalysis(PROJECT, analysis.analysisId, {
      status: "running",
    });
    valuation.transitionAgentAnalysis(PROJECT, analysis.analysisId, {
      status: "completed",
      analysis: { recommendation: "Raise A1 to 12" },
      evidenceIds: [],
    });
    database.close();

    const outputArtifact = await writeArtifact(
      outputDirectory,
      "derived-model.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      Buffer.from("deterministic derived workbook bytes"),
    );
    const changes = [
      {
        sheet: "Model",
        cell: "A1",
        value: 12,
        rationale: "Updated assumption",
        evidenceIds: [],
      },
    ];
    const manifestArtifact = await writeArtifact(
      outputDirectory,
      "derived-model.manifest.json",
      "application/json",
      `${JSON.stringify({
        manifestVersion: 1,
        operation: "derive_workbook",
        sourceName: "base-model.xlsx",
        sourceChecksum: prefixedDigest(source),
        output: outputArtifact,
        changes,
        sourceOverwritten: false,
      })}\n`,
    );
    const response = completedResponse(
      manifestArtifact.path,
      [outputArtifact, manifestArtifact],
      {
        inputChecksum: prefixedDigest(source),
        sourceOverwritten: false,
        changeCount: 1,
      },
    );
    const job = computeJob("job-valuation-derived", "valuation.derive", {
      datasetId: PROJECT,
      analysisId: analysis.analysisId,
      baseModelVersionId: base.modelVersionId,
      inputPath,
      outputDirectory,
      options: { changes },
    });
    const resultProjector = projector(fixture.dataRoot);

    await expect(resultProjector.project(job, response)).resolves.toMatchObject(
      {
        kind: "extension",
        details: {
          operation: "valuation.derive",
          outputPath: "artifacts/valuation-derived/derived-model.xlsx",
          changeCount: 1,
        },
      },
    );
    await expect(resultProjector.project(job, response)).resolves.toMatchObject(
      {
        kind: "extension",
        details: { operation: "valuation.derive" },
      },
    );

    const projected = openProjectDatabase({
      projectRoot: fixture.projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
      preferredSearchBackend: "deterministic",
    });
    try {
      const derived = createWorkflowStore(
        projected.connection,
      ).valuation.listDerivedModels(PROJECT);
      expect(derived.total).toBe(1);
      expect(derived.items[0]).toMatchObject({
        analysisId: analysis.analysisId,
        baseModelVersionId: base.modelVersionId,
        outputPath: "artifacts/valuation-derived/derived-model.xlsx",
        checksum: outputArtifact.checksum,
        appliedChanges: changes,
      });
      expect(createResearchStore(projected).assets.list({}).total).toBe(1);
    } finally {
      projected.close();
    }
  });

  it("runs real report compute and attaches immutable memo artifacts", async () => {
    const fixture = await projectFixture();
    const inputPath = path.join(
      fixture.projectRoot,
      "reports",
      "memo-source.md",
    );
    const outputDirectory = path.join(
      fixture.projectRoot,
      "artifacts",
      "memo-render",
    );
    const markdown = [
      "# Alpha Investment Memo",
      "",
      "## Thesis",
      "",
      "Revenue remains resilient.",
    ].join("\n");
    await mkdir(path.dirname(inputPath), { recursive: true });
    await writeFile(inputPath, `${markdown}\n`, "utf8");

    const database = openProjectDatabase({
      projectRoot: fixture.projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
      preferredSearchBackend: "deterministic",
    });
    const memo = createWorkflowStore(
      database.connection,
    ).tracking.saveMemoVersion({
      datasetId: PROJECT,
      topic: "Alpha",
      title: "Alpha Investment Memo",
      asOfDate: "2026-07-31",
      sourceType: "pi-agent",
      contentHash: digest(`${markdown}\n`),
      markdownPath: path.relative(fixture.projectRoot, inputPath),
      sections: [
        {
          sectionKey: "thesis",
          title: "Thesis",
          content: "Revenue remains resilient.",
          evidenceIds: [],
        },
      ],
      idempotencyKey: "memo-alpha-2026-07-31",
    }).record;
    database.close();

    const job = computeJob("job-report-generate", "report.generate", {
      datasetId: PROJECT,
      sourceKind: "memo",
      memoVersionId: memo.memoVersionId,
      assetId: "memo-rendered-alpha",
      inputPath,
      outputDirectory,
      options: {
        renderPdf: false,
        outputBasename: "alpha-investment-memo",
      },
    });
    const executor = new ComputeJobExecutor(
      createPythonComputeClient({
        workerScript: pythonWorker,
        timeoutMs: 5_000,
      }),
      new TenantProjectComputePathPolicy(fixture.dataRoot),
    );
    const response = await executor.execute(job);
    const resultProjector = projector(fixture.dataRoot);

    await expect(resultProjector.project(job, response)).resolves.toMatchObject(
      {
        kind: "extension",
        details: {
          operation: "report.generate",
          sourceKind: "memo",
          memoVersionId: memo.memoVersionId,
          assetId: "memo-rendered-alpha",
        },
      },
    );
    await expect(resultProjector.project(job, response)).resolves.toMatchObject(
      {
        kind: "extension",
        details: { operation: "report.generate" },
      },
    );

    const projected = openProjectDatabase({
      projectRoot: fixture.projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
      preferredSearchBackend: "deterministic",
    });
    try {
      const attached = createWorkflowStore(
        projected.connection,
      ).tracking.getMemoVersion(PROJECT, memo.memoVersionId);
      expect(attached.markdownPath).toBe(
        path.relative(fixture.projectRoot, inputPath),
      );
      expect(attached.htmlPath).toBe(
        "artifacts/memo-render/alpha-investment-memo.html",
      );
      expect(attached.pdfPath).toBeNull();
      const assets = createResearchStore(projected).assets;
      expect(assets.get("memo-rendered-alpha")).toMatchObject({
        status: "completed",
        currentVersionNo: 1,
      });
      expect(
        assets.getCurrentVersion("memo-rendered-alpha"),
      ).toMatchObject({
        metadata: {
          memoVersionId: memo.memoVersionId,
          rendererVersion: expect.any(String),
        },
      });
    } finally {
      projected.close();
    }
  });

  it("runs real workflow-report compute and reprojects one immutable report asset", async () => {
    const fixture = await projectFixture();
    const inputPath = path.join(
      fixture.projectRoot,
      "reports",
      "workflow-report-source.md",
    );
    const outputDirectory = path.join(
      fixture.projectRoot,
      "artifacts",
      "workflow-report-render",
    );
    const markdown = [
      "# Alpha Workflow Investment Report",
      "",
      "## Investment conclusion",
      "",
      "The evidence-backed workflow remains constructive.",
    ].join("\n");
    await mkdir(path.dirname(inputPath), { recursive: true });
    await writeFile(inputPath, markdown, "utf8");

    const database = openProjectDatabase({
      projectRoot: fixture.projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
      preferredSearchBackend: "deterministic",
    });
    const workflowStore = createWorkflowStore(database.connection);
    const workflow = workflowStore.workflow.getOrCreateWorkflow({
      datasetId: PROJECT,
      workflowType: "agentic_research_graph_v2",
    });
    const reportVersion = workflowStore.workflow.createReportVersion({
      workflowId: workflow.workflowId,
      reportType: "investment_report",
      title: "Alpha Workflow Investment Report",
      idempotencyKey: "workflow-report-alpha-2026-07-31",
      markdown,
      nodeVersions: {},
      documentVersions: [],
    });
    const report = workflowStore.workflow.getReport(reportVersion.reportId);
    database.close();

    const job = computeJob(
      "job-workflow-report-generate",
      "report.generate",
      {
        datasetId: PROJECT,
        sourceKind: "workflow-report",
        reportVersionId: reportVersion.reportVersionId,
        inputPath,
        outputDirectory,
        computeOperation: "render_report",
        options: {
          renderPdf: false,
          outputBasename: "alpha-workflow-investment-report",
        },
      },
    );
    const executor = new ComputeJobExecutor(
      createPythonComputeClient({
        workerScript: pythonWorker,
        timeoutMs: 5_000,
      }),
      new TenantProjectComputePathPolicy(fixture.dataRoot),
    );
    const response = await executor.execute(job);
    const resultProjector = projector(fixture.dataRoot);

    await expect(resultProjector.project(job, response)).resolves.toMatchObject(
      {
        kind: "extension",
        details: {
          operation: "report.generate",
          sourceKind: "workflow-report",
          reportVersionId: reportVersion.reportVersionId,
          assetId: `report:${report.reportId}`,
          artifacts: expect.arrayContaining([
            expect.objectContaining({
              mediaType: expect.stringMatching(/^text\/markdown/u),
            }),
            expect.objectContaining({
              mediaType: expect.stringMatching(/^text\/html/u),
            }),
          ]),
        },
      },
    );
    await expect(resultProjector.project(job, response)).resolves.toMatchObject(
      {
        kind: "extension",
        details: {
          operation: "report.generate",
          sourceKind: "workflow-report",
          reportVersionId: reportVersion.reportVersionId,
          assetId: `report:${report.reportId}`,
        },
      },
    );

    const projected = openProjectDatabase({
      projectRoot: fixture.projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
      preferredSearchBackend: "deterministic",
    });
    try {
      const savedWorkflow = createWorkflowStore(projected.connection).workflow;
      expect(
        savedWorkflow.listReportVersions(report.reportId, { limit: 100 }),
      ).toMatchObject({
        total: 1,
        items: [
          expect.objectContaining({
            reportVersionId: reportVersion.reportVersionId,
            markdown,
          }),
        ],
      });
      const assets = createResearchStore(projected).assets;
      expect(assets.get(`report:${report.reportId}`)).toMatchObject({
        status: "completed",
        currentVersionNo: 1,
      });
      expect(
        assets.getCurrentVersion(`report:${report.reportId}`),
      ).toMatchObject({
        versionNo: 1,
        structuredContent: {
          reportId: report.reportId,
          reportVersionId: reportVersion.reportVersionId,
          versionNo: reportVersion.versionNo,
        },
        metadata: {
          artifacts: expect.arrayContaining([
            expect.objectContaining({
              mediaType: expect.stringMatching(/^text\/html/u),
            }),
          ]),
        },
      });
    } finally {
      projected.close();
    }
  });
});
