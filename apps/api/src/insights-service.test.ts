import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TenantIdentity } from "@private-fund/contracts";
import { buildTenantContext } from "@private-fund/core";
import {
  createControlRepositories,
  openControlDatabase,
} from "@private-fund/db";

import { RepositoryProjectInsightsService } from "./insights-service.js";
import {
  RepositoryJobService,
  RepositoryProjectService,
} from "./repository-services.js";
import { ProjectResearchStoreManager } from "./research-stores.js";

const ALPHA: TenantIdentity = {
  userId: "insights-alpha",
  dataNamespace: "00000000-0000-4000-8000-0000000000d1",
};
const BETA: TenantIdentity = {
  userId: "insights-beta",
  dataNamespace: "00000000-0000-4000-8000-0000000000d2",
};

describe("repository project insights service", () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-insights-service-"));
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("exposes tracking and valuation state with durable jobs and tenant isolation", async () => {
    const database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(database);
    repositories.users.upsertCloudShadow(ALPHA);
    repositories.users.upsertCloudShadow(BETA);
    const alpha = buildTenantContext(dataRoot, ALPHA);
    const beta = buildTenantContext(dataRoot, BETA);
    const projects = new RepositoryProjectService(repositories);
    const project = await projects.create(alpha, {
      name: "Insights project",
    });
    const stores = new ProjectResearchStoreManager();
    const jobs = new RepositoryJobService(database);
    const insights = new RepositoryProjectInsightsService(
      repositories,
      stores,
      jobs,
    );
    const workflowStore = stores.getWorkflow(
      path.join(alpha.projectsRoot, project.id),
    );

    const item = workflowStore.tracking.appendItemVersion({
      datasetId: project.id,
      itemType: "risk",
      canonicalKey: "customer-concentration",
      title: "客户集中度",
      sourceType: "test",
      sourceId: "source-v1",
      content: "头部客户收入占比较高",
      impact: "high",
      evidenceIds: [],
    });
    const tracking = await insights.trackingOverview(alpha, project.id, {
      limit: 100,
      offset: 0,
    });
    expect(tracking).toMatchObject({
      overview: {
        datasetId: project.id,
        counts: { risk: 1 },
      },
      items: { total: 1 },
      watchRules: { total: 2 },
    });
    expect(
      await insights.trackingItemTimeline(
        alpha,
        project.id,
        item.item.itemId,
      ),
    ).toMatchObject({ item: { title: "客户集中度" } });

    const customRule = await insights.createTrackingWatchRule(
      alpha,
      project.id,
      {
        name: "集中度变化",
        targetType: "risk",
        targetItemId: item.item.itemId,
        query: { terms: ["集中度"] },
        minPriority: "high",
        frequency: "on_ingest",
        active: true,
      },
    );
    expect(customRule).toMatchObject({
      name: "集中度变化",
      active: true,
    });

    const trackingJob = await insights.runTracking(alpha, project.id, {
      idempotencyKey: "tracking-scan-1",
      includeHistory: false,
    });
    expect(trackingJob).toMatchObject({
      created: true,
      job: {
        projectId: project.id,
        type: "tracking.scan",
        status: "queued",
      },
    });

    const series = workflowStore.valuation.upsertSeries({
      datasetId: project.id,
      seriesKey: "tesla-base",
      name: "Tesla Base Model",
      companyTicker: "TSLA",
    });
    const version = workflowStore.valuation.saveModelVersion({
      datasetId: project.id,
      seriesId: series.seriesId,
      docId: "document-model",
      documentVersionNo: 1,
      checksum: "a".repeat(64),
      snapshotHash: "b".repeat(64),
      originalFilename: "tesla.xlsx",
      nodeCount: 0,
      formulaNodeCount: 0,
      reviewRequiredCount: 0,
      analyzerVersion: "extractor-v1",
    });
    const valuation = await insights.valuationOverview(alpha, project.id, {
      limit: 100,
      offset: 0,
    });
    expect(valuation).toMatchObject({
      series: { total: 1 },
      watchRules: { total: 1 },
    });
    expect(
      await insights.valuationModelOverview(
        alpha,
        project.id,
        series.seriesId,
        version.value.modelVersionId,
      ),
    ).toMatchObject({
      series: { seriesId: series.seriesId },
      version: { modelVersionId: version.value.modelVersionId },
    });

    const analysis = await insights.createValuationAnalysis(
      alpha,
      project.id,
      series.seriesId,
      {
        idempotencyKey: "analysis-v1",
        baseModelVersionId: version.value.modelVersionId,
        focus: "利润率敏感性",
        agentVersion: "pi-agent-v1",
      },
    );
    expect(analysis).toMatchObject({
      analysis: { status: "pending" },
      job: { type: "valuation.compare", status: "queued" },
      created: true,
    });

    await expect(
      insights.trackingOverview(beta, project.id, {
        limit: 100,
        offset: 0,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      insights.valuationOverview(beta, project.id, {
        limit: 100,
        offset: 0,
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    stores.close();
    database.close();
  });

  it("produces complete derive, market, memo and resource-import jobs with controlled paths", async () => {
    const database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(database);
    repositories.users.upsertCloudShadow(ALPHA);
    const alpha = buildTenantContext(dataRoot, ALPHA);
    const projects = new RepositoryProjectService(repositories);
    const project = await projects.create(alpha, {
      name: "Producer payload project",
    });
    const projectRoot = path.join(alpha.projectsRoot, project.id);
    const stores = new ProjectResearchStoreManager();
    const jobs = new RepositoryJobService(database);
    const insights = new RepositoryProjectInsightsService(
      repositories,
      stores,
      jobs,
    );
    const research = stores.get(projectRoot);
    const workflow = stores.getWorkflow(projectRoot);

    const sourceBytes = Buffer.from("not-executed-xlsx-fixture", "utf8");
    const sourceSha256 = createHash("sha256")
      .update(sourceBytes)
      .digest("hex");
    const sourcePath = path.join(projectRoot, "sources", "base.xlsx");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, sourceBytes);
    const document = research.documents.registerVersion({
      logicalKey: "valuation:base",
      sourceRelpath: "base.xlsx",
      title: "Base model",
      originalFilename: "base.xlsx",
      storedPath: path.relative(projectRoot, sourcePath),
      fileType: "xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sha256: sourceSha256,
      fileSize: sourceBytes.byteLength,
      status: "indexed",
      activate: true,
    });
    const series = workflow.valuation.upsertSeries({
      datasetId: project.id,
      seriesKey: "base-model",
      name: "Base model",
      companyTicker: "600000",
    });
    const model = workflow.valuation.saveModelVersion({
      datasetId: project.id,
      seriesId: series.seriesId,
      docId: document.version.id,
      logicalDocId: document.document.id,
      documentVersionNo: 1,
      checksum: sourceSha256,
      snapshotHash: "b".repeat(64),
      originalFilename: "base.xlsx",
      analyzerVersion: "test",
    }).value;
    const analysis = workflow.valuation.createAgentAnalysis({
      datasetId: project.id,
      seriesId: series.seriesId,
      baseModelVersionId: model.modelVersionId,
      agentVersion: "pi-agent-v1",
      idempotencyKey: "analysis-producer",
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
        analysis: {
          recommendedChanges: [
            {
              sheet: "DCF",
              cell: "B7",
              expectedCurrentValue: 10,
              value: 12,
              rationale: "Evidence-backed update",
              evidenceIds: [],
            },
          ],
        },
      },
    );

    const derive = await insights.deriveValuationModel(
      alpha,
      project.id,
      analysis.analysisId,
      { idempotencyKey: "derive-producer" },
    );
    expect(derive.job).toMatchObject({
      type: "valuation.derive",
      payload: {
        inputPath: await realpath(sourcePath),
        computeOperation: "derive_workbook",
        options: {
          changes: [expect.objectContaining({ sheet: "DCF", cell: "B7" })],
        },
      },
    });
    expect(path.isAbsolute(String(derive.job.payload.outputDirectory))).toBe(
      true,
    );

    const run = await insights.runValuationTracking(
      alpha,
      project.id,
      {
        idempotencyKey: "valuation-run-producer",
        includeHistory: true,
        refreshMarket: true,
      },
    );
    expect(run.jobs).toHaveLength(1);
    expect(run.jobs[0]?.job).toMatchObject({
      type: "valuation.extract",
      payload: {
        datasetId: project.id,
        documentId: document.document.id,
        documentVersionId: document.version.id,
        inputPath: await realpath(sourcePath),
        computeOperation: "extract_workbook",
        options: {
          documentId: document.document.id,
          documentVersionId: document.version.id,
          includeHistory: true,
        },
      },
    });
    const valuationInputPath = String(
      run.jobs[0]!.job.payload.inputPath,
    );
    const valuationOutputDirectory = String(
      run.jobs[0]!.job.payload.outputDirectory,
    );
    const canonicalProjectRoot = await realpath(projectRoot);
    expect(path.isAbsolute(valuationInputPath)).toBe(true);
    expect(path.isAbsolute(valuationOutputDirectory)).toBe(true);
    expect(
      path.relative(canonicalProjectRoot, valuationInputPath),
    ).not.toMatch(/^(?:\.\.(?:[/\\]|$)|[/\\])/u);
    expect(
      path.relative(projectRoot, valuationOutputDirectory),
    ).not.toMatch(/^(?:\.\.(?:[/\\]|$)|[/\\])/u);
    expect(
      await insights.runValuationTracking(alpha, project.id, {
        idempotencyKey: "valuation-run-producer",
        includeHistory: true,
        refreshMarket: true,
      }),
    ).toMatchObject({
      jobs: [{ created: false, job: { id: run.jobs[0]!.job.id } }],
      marketJobs: [
        { created: false, job: { id: run.marketJobs[0]!.job.id } },
      ],
    });
    expect(run.refreshMarketEnqueued).toBe(true);
    expect(run.marketJobs[0]?.job).toMatchObject({
      type: "market.refresh",
      payload: {
        seriesId: series.seriesId,
        modelVersionId: model.modelVersionId,
        computeOperation: "fetch_market_data",
        options: { provider: "akshare", ticker: "600000" },
      },
    });
    const descriptorPath = String(
      run.marketJobs[0]!.job.payload.inputPath,
    );
    expect(path.isAbsolute(descriptorPath)).toBe(true);
    await expect(readFile(descriptorPath, "utf8")).resolves.toContain(
      '"ticker": "600000"',
    );

    const memo = await insights.generateMemo(alpha, project.id, {
      idempotencyKey: "memo-producer",
      instruction: "更新投资结论",
      title: "投资结论更新",
    });
    expect(memo.job).toMatchObject({
      type: "memo.generate",
      payload: {
        instruction: "更新投资结论",
        title: "投资结论更新",
      },
    });

    const memoMarkdown = Buffer.from("# 投资结论更新\n\n维持审慎乐观。", "utf8");
    const memoPdf = Buffer.from("%PDF-1.7\ncanonical memo fixture\n", "utf8");
    const memoMarkdownPath = path.join(
      projectRoot,
      "artifacts",
      "memos",
      "memo.md",
    );
    const memoPdfPath = path.join(
      projectRoot,
      "artifacts",
      "memos",
      "memo.pdf",
    );
    await mkdir(path.dirname(memoMarkdownPath), { recursive: true });
    await Promise.all([
      writeFile(memoMarkdownPath, memoMarkdown),
      writeFile(memoPdfPath, memoPdf),
    ]);
    const storedMemo = workflow.tracking.saveMemoVersion({
      datasetId: project.id,
      topic: "投资结论更新",
      title: "投资结论更新",
      asOfDate: "2026-07-31",
      sourceType: "agent_generated",
      contentHash: createHash("sha256")
        .update(memoMarkdown)
        .digest("hex"),
      markdownPath: path.relative(projectRoot, memoMarkdownPath),
      pdfPath: path.relative(projectRoot, memoPdfPath),
      idempotencyKey: "memo-artifact-producer",
      sections: [
        {
          sectionKey: "conclusion",
          title: "投资结论",
          content: "维持审慎乐观。",
          evidenceIds: [],
        },
      ],
    }).record;
    const openedMemoMarkdown = await insights.openMemoArtifact(
      alpha,
      project.id,
      storedMemo.memoVersionId,
      "markdown",
    );
    try {
      expect(openedMemoMarkdown).toMatchObject({
        filename: "memo.md",
        mimeType: "text/markdown; charset=utf-8",
        size: memoMarkdown.byteLength,
      });
      await expect(readFile(openedMemoMarkdown.absolutePath)).resolves.toEqual(
        memoMarkdown,
      );
    } finally {
      await openedMemoMarkdown.handle.close();
    }
    const openedMemoPdf = await insights.openMemoArtifact(
      alpha,
      project.id,
      storedMemo.memoVersionId,
      "pdf",
    );
    try {
      expect(openedMemoPdf).toMatchObject({
        filename: "memo.pdf",
        mimeType: "application/pdf",
        size: memoPdf.byteLength,
      });
      await expect(readFile(openedMemoPdf.absolutePath)).resolves.toEqual(
        memoPdf,
      );
    } finally {
      await openedMemoPdf.handle.close();
    }

    const derivedBytes = Buffer.from("derived-workbook", "utf8");
    const derivedSha256 = createHash("sha256")
      .update(derivedBytes)
      .digest("hex");
    const derivedPath = path.join(
      projectRoot,
      "artifacts",
      "valuation",
      "derived.xlsx",
    );
    await mkdir(path.dirname(derivedPath), { recursive: true });
    await writeFile(derivedPath, derivedBytes);
    const derived = workflow.valuation.saveDerivedModel({
      datasetId: project.id,
      seriesId: series.seriesId,
      analysisId: analysis.analysisId,
      baseModelVersionId: model.modelVersionId,
      derivedVersionNo: 1,
      outputFilename: "derived.xlsx",
      outputPath: path.relative(projectRoot, derivedPath),
      checksum: derivedSha256,
      appliedChanges: [],
      skippedChanges: [],
    }).value;
    const openedDerived = await insights.openDerivedModelFile(
      alpha,
      project.id,
      derived.derivedModelId,
    );
    try {
      expect(openedDerived).toMatchObject({
        filename: "derived.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: derivedBytes.byteLength,
        sha256: derivedSha256,
      });
      await expect(readFile(openedDerived.absolutePath)).resolves.toEqual(
        derivedBytes,
      );
    } finally {
      await openedDerived.handle.close();
    }
    const resource = await insights.addDerivedModelToResources(
      alpha,
      project.id,
      derived.derivedModelId,
      { idempotencyKey: "derived-resource-producer" },
    );
    expect(resource).toMatchObject({
      derivedModel: {
        resourceStatus: "queued",
        resourceDocId: null,
      },
      document: { logicalKey: `valuation-derived:${derived.derivedModelId}` },
      job: {
        type: "document.ingest",
        payload: {
          sourceDerivedModelId: derived.derivedModelId,
        },
      },
    });
    if (resource.job === null || resource.document === null) {
      throw new Error("Resource import did not create its document job");
    }
    const resourceJobId = resource.job.id;
    const resourceDocumentId = resource.document.id;
    database
      .prepare(
        `UPDATE jobs
         SET status = 'running', lease_owner = 'test-worker',
             lease_expires_at = '2999-01-01T00:00:00.000Z'
         WHERE id = ?`,
      )
      .run(resourceJobId);
    const runningResources = await insights.valuationDerivedModels(
      alpha,
      project.id,
      { limit: 100, offset: 0 },
    );
    expect(runningResources.items[0]).toMatchObject({
      derivedModelId: derived.derivedModelId,
      resourceStatus: "running",
    });

    database
      .prepare(
        `UPDATE jobs
         SET status = 'completed', lease_owner = NULL,
             lease_expires_at = NULL,
             completed_at = '2026-07-31T00:00:00.000Z'
         WHERE id = ?`,
      )
      .run(resourceJobId);
    const completedResources = await insights.valuationDerivedModels(
      alpha,
      project.id,
      { limit: 100, offset: 0 },
    );
    expect(completedResources.items[0]).toMatchObject({
      derivedModelId: derived.derivedModelId,
      resourceStatus: "completed",
      resourceDocId: resourceDocumentId,
    });

    stores.close();
    database.close();
  });
});
