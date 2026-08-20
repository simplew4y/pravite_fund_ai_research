import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("repository project insights service (memo pipeline)", () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-insights-service-"));
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  async function harness(projectName: string) {
    const database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(database);
    repositories.users.upsertCloudShadow(ALPHA);
    repositories.users.upsertCloudShadow(BETA);
    const alpha = buildTenantContext(dataRoot, ALPHA);
    const beta = buildTenantContext(dataRoot, BETA);
    const projects = new RepositoryProjectService(repositories);
    const project = await projects.create(alpha, { name: projectName });
    const projectRoot = path.join(alpha.projectsRoot, project.id);
    const stores = new ProjectResearchStoreManager();
    const jobs = new RepositoryJobService(database);
    const insights = new RepositoryProjectInsightsService(
      repositories,
      stores,
      jobs,
    );
    return {
      database,
      alpha,
      beta,
      project,
      projectRoot,
      stores,
      insights,
      close: () => {
        stores.close();
        database.close();
      },
    };
  }

  it("enqueues memo.generate jobs and rejects unresolved evidence references", async () => {
    const ctx = await harness("Memo generation project");
    const { alpha, project, projectRoot, stores, insights } = ctx;
    const research = stores.get(projectRoot);

    const sourceBytes = Buffer.from("memo evidence workbook", "utf8");
    const sourcePath = path.join(projectRoot, "sources", "base.xlsx");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, sourceBytes);
    const document = research.documents.registerVersion({
      logicalKey: "memo:base",
      sourceRelpath: "base.xlsx",
      title: "Base workbook",
      originalFilename: "base.xlsx",
      storedPath: path.relative(projectRoot, sourcePath),
      fileType: "xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sha256: createHash("sha256").update(sourceBytes).digest("hex"),
      fileSize: sourceBytes.byteLength,
      status: "indexed",
      activate: true,
    });
    const evidence = research.evidence.put({
      evidenceId: "cell:memo-dcf-b7",
      kind: "cell",
      documentVersionId: document.version.id,
      title: "Target price",
      originalText: "Target price | 2026E | 42.5",
    }).evidence;

    await expect(
      insights.generateMemo(alpha, project.id, {
        idempotencyKey: "memo-invalid-evidence",
        instruction: "更新投资结论",
        evidenceIds: ["fact:does-not-exist"],
      }),
    ).rejects.toMatchObject({
      code: "invalid_evidence_reference",
      statusCode: 400,
    });

    const memo = await insights.generateMemo(alpha, project.id, {
      idempotencyKey: "memo-producer",
      instruction: "更新投资结论",
      topic: "投资结论",
      title: "投资结论更新",
      evidenceIds: [evidence.evidenceId],
    });
    expect(memo.created).toBe(true);
    expect(memo.job).toMatchObject({
      projectId: project.id,
      type: "memo.generate",
      status: "queued",
      payload: {
        datasetId: project.id,
        instruction: "更新投资结论",
        topic: "投资结论",
        title: "投资结论更新",
        evidenceIds: [evidence.evidenceId],
      },
    });

    const replay = await insights.generateMemo(alpha, project.id, {
      idempotencyKey: "memo-producer",
      instruction: "更新投资结论",
      topic: "投资结论",
      title: "投资结论更新",
      evidenceIds: [evidence.evidenceId],
    });
    expect(replay).toMatchObject({
      created: false,
      job: { id: memo.job.id },
    });

    ctx.close();
  });

  it("returns memo series with versions, filtering, paging and tenant isolation", async () => {
    const ctx = await harness("Memo series project");
    const { alpha, beta, project, projectRoot, stores, insights } = ctx;
    const tracking = stores.getWorkflow(projectRoot).tracking;

    const supplyV1 = tracking.saveMemoVersion({
      datasetId: project.id,
      topic: "供应链",
      title: "供应链跟踪备忘录",
      asOfDate: "2026-06-30",
      sourceType: "agent_generated",
      contentHash: "memo-supply-v1",
      idempotencyKey: "memo-supply-v1",
      sections: [
        {
          sectionKey: "risk",
          title: "供应链风险",
          content: "供应商切换仍在评估。",
          evidenceIds: [],
        },
      ],
    }).record;
    const supplyV2 = tracking.saveMemoVersion({
      datasetId: project.id,
      topic: "供应链",
      title: "供应链跟踪备忘录",
      asOfDate: "2026-07-31",
      sourceType: "agent_generated",
      contentHash: "memo-supply-v2",
      idempotencyKey: "memo-supply-v2",
      sections: [
        {
          sectionKey: "risk",
          title: "供应链风险",
          content: "供应商切换方案已获批。",
          evidenceIds: [],
        },
      ],
    }).record;
    tracking.saveMemoVersion({
      datasetId: project.id,
      topic: "客户集中度",
      title: "客户集中度备忘录",
      asOfDate: "2026-07-31",
      sourceType: "agent_generated",
      contentHash: "memo-concentration-v1",
      idempotencyKey: "memo-concentration-v1",
      sections: [],
    });
    expect(supplyV2.seriesId).toBe(supplyV1.seriesId);

    const overview = await insights.memoSeries(alpha, project.id, {
      limit: 100,
      offset: 0,
    });
    expect(overview.series).toMatchObject({ total: 2 });
    expect(overview.versions).toMatchObject({ total: 3 });

    const filtered = await insights.memoSeries(alpha, project.id, {
      seriesId: supplyV1.seriesId,
      limit: 1,
      offset: 0,
    });
    expect(filtered.versions).toMatchObject({
      total: 2,
      limit: 1,
      offset: 0,
      hasMore: true,
      items: [
        {
          memoVersionId: supplyV2.memoVersionId,
          seriesId: supplyV1.seriesId,
          versionNo: 2,
        },
      ],
    });

    await expect(
      insights.memoSeries(beta, project.id, { limit: 100, offset: 0 }),
    ).rejects.toMatchObject({ code: "not_found" });

    ctx.close();
  });

  it("compares memo versions with added/changed/not_mentioned/unchanged semantics", async () => {
    const ctx = await harness("Memo compare project");
    const { alpha, beta, project, projectRoot, stores, insights } = ctx;
    const tracking = stores.getWorkflow(projectRoot).tracking;

    const from = tracking.saveMemoVersion({
      datasetId: project.id,
      topic: "综合投研",
      title: "综合投研备忘录",
      asOfDate: "2026-06-30",
      sourceType: "agent_generated",
      contentHash: "memo-compare-v1",
      idempotencyKey: "memo-compare-v1",
      sections: [
        {
          sectionKey: "overview",
          title: "概览",
          content: "公司基本面保持稳定。",
          evidenceIds: [],
        },
        {
          sectionKey: "risk",
          title: "风险",
          content: "供应商切换仍在评估。",
          evidenceIds: [],
        },
        {
          sectionKey: "legacy",
          title: "历史事项",
          content: "旧产线折旧已计提完毕。",
          evidenceIds: [],
        },
      ],
    }).record;
    const to = tracking.saveMemoVersion({
      datasetId: project.id,
      topic: "综合投研",
      title: "综合投研备忘录",
      asOfDate: "2026-07-31",
      sourceType: "agent_generated",
      contentHash: "memo-compare-v2",
      idempotencyKey: "memo-compare-v2",
      sections: [
        {
          sectionKey: "overview",
          title: "概览",
          content: "公司基本面保持稳定。",
          evidenceIds: [],
        },
        {
          sectionKey: "risk",
          title: "风险",
          content: "供应商切换方案已获批。",
          evidenceIds: [],
        },
        {
          sectionKey: "catalyst",
          title: "催化剂",
          content: "新产能预计四季度爬坡。",
          evidenceIds: [],
        },
      ],
    }).record;

    const comparison = await insights.compareMemoVersions(
      alpha,
      project.id,
      from.memoVersionId,
      to.memoVersionId,
    );
    expect(comparison.fromVersion).toMatchObject({
      memoVersionId: from.memoVersionId,
      versionNo: 1,
    });
    expect(comparison.toVersion).toMatchObject({
      memoVersionId: to.memoVersionId,
      versionNo: 2,
    });
    expect(comparison.sectionChanges).toMatchObject([
      { sectionKey: "catalyst", changeType: "added", oldContent: "" },
      { sectionKey: "legacy", changeType: "not_mentioned", newContent: "" },
      { sectionKey: "overview", changeType: "unchanged" },
      {
        sectionKey: "risk",
        changeType: "changed",
        oldContent: "供应商切换仍在评估。",
        newContent: "供应商切换方案已获批。",
      },
    ]);
    expect(comparison.itemChanges).toEqual([]);

    const foreignSeries = tracking.saveMemoVersion({
      datasetId: project.id,
      topic: "另一个主题",
      title: "另一个系列",
      asOfDate: "2026-07-31",
      sourceType: "agent_generated",
      contentHash: "memo-foreign-series-v1",
      idempotencyKey: "memo-foreign-series-v1",
      sections: [],
    }).record;
    await expect(
      insights.compareMemoVersions(
        alpha,
        project.id,
        from.memoVersionId,
        foreignSeries.memoVersionId,
      ),
    ).rejects.toMatchObject({
      code: "insights_invalid_argument",
      statusCode: 400,
    });
    await expect(
      insights.compareMemoVersions(
        alpha,
        project.id,
        from.memoVersionId,
        "memo-version-missing",
      ),
    ).rejects.toMatchObject({
      code: "insights_not_found",
      statusCode: 404,
    });
    await expect(
      insights.compareMemoVersions(
        beta,
        project.id,
        from.memoVersionId,
        to.memoVersionId,
      ),
    ).rejects.toMatchObject({ code: "not_found" });

    ctx.close();
  });

  it("opens memo artifacts by format with attachMemoArtifacts fixtures", async () => {
    const ctx = await harness("Memo artifact project");
    const { alpha, project, projectRoot, stores, insights } = ctx;
    const tracking = stores.getWorkflow(projectRoot).tracking;

    const memoMarkdown = Buffer.from(
      "# 投资结论更新\n\n维持审慎乐观。",
      "utf8",
    );
    const memoPdf = Buffer.from("%PDF-1.7\ncanonical memo fixture\n", "utf8");
    const memoHtml = Buffer.from(
      "<h1>投资结论更新</h1><p>维持审慎乐观。</p>",
      "utf8",
    );
    const memoMarkdownPath = path.join(
      projectRoot,
      "artifacts",
      "memos",
      "memo.md",
    );
    const memoPdfPath = path.join(projectRoot, "artifacts", "memos", "memo.pdf");
    const memoHtmlPath = path.join(
      projectRoot,
      "artifacts",
      "memos",
      "memo.html",
    );
    await mkdir(path.dirname(memoMarkdownPath), { recursive: true });
    await Promise.all([
      writeFile(memoMarkdownPath, memoMarkdown),
      writeFile(memoPdfPath, memoPdf),
      writeFile(memoHtmlPath, memoHtml),
    ]);

    const storedMemo = tracking.saveMemoVersion({
      datasetId: project.id,
      topic: "投资结论更新",
      title: "投资结论更新",
      asOfDate: "2026-07-31",
      sourceType: "agent_generated",
      contentHash: createHash("sha256").update(memoMarkdown).digest("hex"),
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

    const openedMarkdown = await insights.openMemoArtifact(
      alpha,
      project.id,
      storedMemo.memoVersionId,
      "markdown",
    );
    try {
      expect(openedMarkdown).toMatchObject({
        filename: "memo.md",
        mimeType: "text/markdown; charset=utf-8",
        size: memoMarkdown.byteLength,
      });
      await expect(readFile(openedMarkdown.absolutePath)).resolves.toEqual(
        memoMarkdown,
      );
    } finally {
      await openedMarkdown.handle.close();
    }

    // Without an HTML artifact, the default format falls back to PDF.
    const openedDefaultPdf = await insights.openMemoArtifact(
      alpha,
      project.id,
      storedMemo.memoVersionId,
    );
    try {
      expect(openedDefaultPdf).toMatchObject({
        filename: "memo.pdf",
        mimeType: "application/pdf",
        size: memoPdf.byteLength,
      });
      await expect(readFile(openedDefaultPdf.absolutePath)).resolves.toEqual(
        memoPdf,
      );
    } finally {
      await openedDefaultPdf.handle.close();
    }
    await expect(
      insights.openMemoArtifact(
        alpha,
        project.id,
        storedMemo.memoVersionId,
        "html",
      ),
    ).rejects.toMatchObject({
      code: "memo_artifact_not_found",
      statusCode: 404,
    });

    tracking.attachMemoArtifacts(project.id, storedMemo.memoVersionId, {
      markdownPath: path.relative(projectRoot, memoMarkdownPath),
      htmlPath: path.relative(projectRoot, memoHtmlPath),
      pdfPath: path.relative(projectRoot, memoPdfPath),
    });
    const openedDefaultHtml = await insights.openMemoArtifact(
      alpha,
      project.id,
      storedMemo.memoVersionId,
    );
    try {
      expect(openedDefaultHtml).toMatchObject({
        filename: "memo.html",
        size: memoHtml.byteLength,
      });
      await expect(readFile(openedDefaultHtml.absolutePath)).resolves.toEqual(
        memoHtml,
      );
    } finally {
      await openedDefaultHtml.handle.close();
    }

    ctx.close();
  });
});
