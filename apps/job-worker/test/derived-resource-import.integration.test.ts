import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createPythonComputeClient } from "@private-fund/compute-client";
import { ComputeResultProjector } from "@private-fund/compute-projector";
import type { TenantIdentity } from "@private-fund/contracts";
import { buildTenantContext } from "@private-fund/core";
import {
  createControlRepositories,
  openControlDatabase,
} from "@private-fund/db";
import { DurableJobQueue } from "@private-fund/job-queue";

import { RepositoryProjectInsightsService } from "../../api/src/insights-service.js";
import {
  RepositoryJobService,
  RepositoryProjectService,
} from "../../api/src/repository-services.js";
import { ProjectResearchStoreManager } from "../../api/src/research-stores.js";
import { ComputeJobExecutor } from "../src/compute-job-executor.js";
import { TenantProjectComputePathPolicy } from "../src/path-policy.js";
import { JobWorker } from "../src/worker.js";

const TENANT: TenantIdentity = {
  userId: "derived-resource-worker",
  dataNamespace: "00000000-0000-4000-8000-0000000000e1",
};
const PYTHON_WORKER = fileURLToPath(
  new URL("../../../python/compute-worker/worker.py", import.meta.url),
);
const PYTHON_EXECUTABLE = fileURLToPath(
  new URL(
    "../../../python/compute-worker/.venv/bin/python",
    import.meta.url,
  ),
);

describe("derived valuation resource import worker chain", () => {
  let dataRoot: string | undefined;

  afterEach(async () => {
    if (dataRoot !== undefined) {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("runs the API-produced document.ingest job through compute, projection, completion, and replay", async () => {
    dataRoot = await mkdtemp(
      path.join(tmpdir(), "derived-resource-worker-"),
    );
    const database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(database);
    repositories.users.upsertCloudShadow(TENANT);
    const tenant = buildTenantContext(dataRoot, TENANT);
    const project = await new RepositoryProjectService(
      repositories,
    ).create(tenant, {
      name: "Derived resource integration",
    });
    const projectRoot = path.join(tenant.projectsRoot, project.id);
    const stores = new ProjectResearchStoreManager();
    const jobs = new RepositoryJobService(database);
    const insights = new RepositoryProjectInsightsService(
      repositories,
      stores,
      jobs,
    );
    const workflow = stores.getWorkflow(projectRoot);
    const series = workflow.valuation.upsertSeries({
      datasetId: project.id,
      seriesKey: "base",
      name: "Base valuation",
    });
    const model = workflow.valuation.saveModelVersion({
      datasetId: project.id,
      seriesId: series.seriesId,
      docId: "base-document-version",
      logicalDocId: "base-document",
      documentVersionNo: 1,
      checksum: "a".repeat(64),
      snapshotHash: "b".repeat(64),
      originalFilename: "base.xlsx",
      analyzerVersion: "derived-resource-test",
    }).value;
    const analysis = workflow.valuation.createAgentAnalysis({
      datasetId: project.id,
      seriesId: series.seriesId,
      baseModelVersionId: model.modelVersionId,
      idempotencyKey: "derived-resource-analysis",
      agentVersion: "pi-agent-v1",
    }).value;
    workflow.valuation.transitionAgentAnalysis(
      project.id,
      analysis.analysisId,
      { status: "running" },
    );
    workflow.valuation.transitionAgentAnalysis(
      project.id,
      analysis.analysisId,
      {
        status: "completed",
        analysis: { recommendedChanges: [] },
      },
    );

    const derivedContents =
      "metric,period,value\nRevenue,2026E,100\nEBITDA,2026E,20\n";
    const derivedPath = path.join(
      projectRoot,
      "artifacts",
      "valuation",
      "derived.csv",
    );
    await mkdir(path.dirname(derivedPath), { recursive: true });
    await writeFile(derivedPath, derivedContents, "utf8");
    const derived = workflow.valuation.saveDerivedModel({
      datasetId: project.id,
      seriesId: series.seriesId,
      analysisId: analysis.analysisId,
      baseModelVersionId: model.modelVersionId,
      derivedVersionNo: 1,
      outputFilename: "derived.csv",
      outputPath: path.relative(projectRoot, derivedPath),
      checksum: createHash("sha256")
        .update(derivedContents)
        .digest("hex"),
      appliedChanges: [],
      skippedChanges: [],
    }).value;

    const queued = await insights.addDerivedModelToResources(
      tenant,
      project.id,
      derived.derivedModelId,
      { idempotencyKey: "derived-resource-document-ingest" },
    );
    expect(queued).toMatchObject({
      created: true,
      derivedModel: {
        resourceStatus: "queued",
        resourcePipelineJobId: queued.job?.id,
      },
      document: {
        logicalKey: `valuation-derived:${derived.derivedModelId}`,
      },
      documentVersion: { status: "parsing" },
      job: {
        type: "document.ingest",
        status: "queued",
        payload: {
          sourceDerivedModelId: derived.derivedModelId,
        },
      },
    });
    if (
      queued.job === null ||
      queued.document === null ||
      queued.documentVersion === undefined
    ) {
      throw new Error("Resource import did not produce a document job");
    }
    expect(path.isAbsolute(String(queued.job.payload.inputPath))).toBe(
      true,
    );
    expect(
      path.isAbsolute(String(queued.job.payload.outputDirectory)),
    ).toBe(true);

    stores.close();
    const queue = new DurableJobQueue(database);
    const worker = new JobWorker(
      queue,
      new ComputeJobExecutor(
        createPythonComputeClient({
          workerScript: PYTHON_WORKER,
          pythonExecutable: PYTHON_EXECUTABLE,
          timeoutMs: 10_000,
        }),
        new TenantProjectComputePathPolicy(dataRoot),
      ),
      new ComputeResultProjector({ dataRoot }),
      {
        workerId: "derived-resource-worker-1",
        leaseDurationMs: 5_000,
      },
    );

    await expect(worker.runOnce()).resolves.toBe(true);
    const completedJob = queue.getForTenant(
      TENANT.dataNamespace,
      queued.job.id,
    );
    expect(completedJob, completedJob.error ?? undefined).toMatchObject({
      status: "completed",
      attempt: 1,
    });

    const documents = stores.get(projectRoot).documents;
    expect(
      documents.getVersion(queued.documentVersion.id),
    ).toMatchObject({
      documentId: queued.document.id,
      status: "indexed",
    });
    expect(
      stores
        .get(projectRoot)
        .evidence.search({ query: "Revenue", limit: 20, offset: 0 })
        .total,
    ).toBeGreaterThan(0);

    const reconciled = await insights.valuationDerivedModels(
      tenant,
      project.id,
      { limit: 100, offset: 0 },
    );
    expect(reconciled.items).toContainEqual(
      expect.objectContaining({
        derivedModelId: derived.derivedModelId,
        resourceStatus: "completed",
        resourceDocId: queued.document.id,
      }),
    );
    const replay = await insights.addDerivedModelToResources(
      tenant,
      project.id,
      derived.derivedModelId,
      { idempotencyKey: "derived-resource-document-ingest" },
    );
    expect(replay).toMatchObject({
      created: false,
      document: { id: queued.document.id },
      job: null,
      derivedModel: {
        resourceStatus: "completed",
        resourceDocId: queued.document.id,
      },
    });

    stores.close();
    database.close();
  });
});
