import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "./config.js";
import { createApiRuntime, type ApiRuntime } from "./main.js";
import { ProjectResearchStoreManager } from "./research-stores.js";

const WORKER_ENTRY = fileURLToPath(
  new URL("../test/fixtures/fake-agent-worker.mjs", import.meta.url),
);
const OWNER_NAMESPACE = "00000000-0000-4000-8000-000000000081";
const OTHER_NAMESPACE = "00000000-0000-4000-8000-000000000082";

interface SeededMemos {
  readonly memoSeriesId: string;
  readonly memoVersion1Id: string;
  readonly memoVersion2Id: string;
  readonly memoChangeEventId: string;
  readonly memoItemVersionId: string;
}

describe("memo HTTP acceptance", () => {
  let runtime: ApiRuntime | undefined;
  let otherTenantRuntime: ApiRuntime | undefined;
  let dataRoot: string | undefined;

  afterEach(async () => {
    await otherTenantRuntime?.close();
    await runtime?.close();
    if (dataRoot !== undefined) {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("serves memo listing, compare, generation, tenant scope and retired-route 404s", async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-insights-http-"));
    const config: ApiConfig = {
      host: "127.0.0.1",
      port: 6768,
      dataRoot,
      controlDatabase: path.join(dataRoot, "control.sqlite3"),
      auth: {
        mode: "development",
        userId: "insights-http-owner",
        dataNamespace: OWNER_NAMESPACE,
      },
      agentWorkerEntry: WORKER_ENTRY,
    };
    runtime = await createApiRuntime(config);

    const projectResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: {
        name: "Memo HTTP acceptance",
        companyName: "Acceptance Holdings",
        ticker: "000001.SZ",
      },
    });
    expect(projectResponse.statusCode, projectResponse.body).toBe(201);
    const project = projectResponse.json<{ id: string }>();
    const projectRoot = path.join(
      dataRoot,
      "users",
      OWNER_NAMESPACE,
      "projects",
      project.id,
    );
    const seeded = seedMemos(project.id, projectRoot);

    // (a) memo listing: series + versions pagination, seriesId filter.
    const memoListing = await runtime.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/tracking/memos?limit=10&offset=0`,
    });
    expect(memoListing.statusCode, memoListing.body).toBe(200);
    expect(memoListing.json()).toMatchObject({
      series: {
        total: 2,
        items: expect.arrayContaining([
          expect.objectContaining({
            seriesId: seeded.memoSeriesId,
            topic: "供应链",
            currentVersionNo: 2,
            versionCount: 2,
          }),
        ]),
      },
      versions: { total: 3, limit: 10, offset: 0, hasMore: false },
    });

    const filteredListing = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/tracking/memos` +
        `?seriesId=${seeded.memoSeriesId}&limit=1&offset=0`,
    });
    expect(filteredListing.statusCode, filteredListing.body).toBe(200);
    expect(filteredListing.json()).toMatchObject({
      series: { total: 2, limit: 1, offset: 0, hasMore: true },
      versions: {
        total: 2,
        limit: 1,
        offset: 0,
        hasMore: true,
        items: [
          {
            memoVersionId: seeded.memoVersion2Id,
            seriesId: seeded.memoSeriesId,
            seriesTitle: "供应链跟踪备忘录",
            versionNo: 2,
            sections: [
              expect.objectContaining({ sectionKey: "overview" }),
              expect.objectContaining({ sectionKey: "risk" }),
              expect.objectContaining({ sectionKey: "catalyst" }),
            ],
          },
        ],
      },
    });

    // (b) memo compare: full section-change semantics plus memo-linked
    // item changes (source_type='memo' item versions written through the
    // workflow-store tracking repository).
    const memoComparison = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/tracking/memos/compare` +
        `?fromVersionId=${seeded.memoVersion1Id}` +
        `&toVersionId=${seeded.memoVersion2Id}`,
    });
    expect(memoComparison.statusCode, memoComparison.body).toBe(200);
    expect(memoComparison.json()).toMatchObject({
      fromVersion: {
        memoVersionId: seeded.memoVersion1Id,
        versionNo: 1,
      },
      toVersion: {
        memoVersionId: seeded.memoVersion2Id,
        versionNo: 2,
      },
      sectionChanges: [
        {
          sectionKey: "catalyst",
          changeType: "added",
          oldContent: "",
          newContent: "新产能预计四季度爬坡。",
        },
        {
          sectionKey: "legacy",
          changeType: "not_mentioned",
          oldContent: "旧产线折旧已计提完毕。",
          newContent: "",
        },
        {
          sectionKey: "overview",
          changeType: "unchanged",
          oldContent: "公司基本面保持稳定。",
          newContent: "公司基本面保持稳定。",
        },
        {
          sectionKey: "risk",
          changeType: "changed",
          oldContent: "供应商切换仍在评估。",
          newContent: "供应商切换方案已获批。",
        },
      ],
      itemChanges: [
        {
          changeEventId: seeded.memoChangeEventId,
          newVersionId: seeded.memoItemVersionId,
          changeType: "status_changed",
          materiality: "high",
          summary: "备忘录确认供应链风险进入缓解阶段",
          details: { source: "memo-v2" },
        },
      ],
    });

    const incompleteComparison = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/tracking/memos/compare` +
        `?fromVersionId=${seeded.memoVersion1Id}`,
    });
    expect(incompleteComparison.statusCode).toBe(400);

    // (c) memo generation: 202 enqueue, idempotent replay, evidence guard.
    const generatePayload = {
      idempotencyKey: "memo-http-generate-1",
      instruction: "更新供应链风险结论",
      topic: "供应链",
      title: "供应链跟踪备忘录",
    };
    const generate = await runtime.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/tracking/memos`,
      payload: generatePayload,
    });
    expect(generate.statusCode, generate.body).toBe(202);
    expect(generate.json()).toMatchObject({
      created: true,
      job: {
        projectId: project.id,
        type: "memo.generate",
        status: "queued",
        idempotencyKey: "memo-http-generate-1",
        payload: {
          datasetId: project.id,
          instruction: "更新供应链风险结论",
          topic: "供应链",
          title: "供应链跟踪备忘录",
        },
      },
    });
    const generatedJob = generate.json<{ job: { id: string } }>().job;

    const generateReplay = await runtime.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/tracking/memos`,
      payload: generatePayload,
    });
    expect(generateReplay.statusCode, generateReplay.body).toBe(202);
    expect(generateReplay.json()).toMatchObject({
      created: false,
      job: { id: generatedJob.id, type: "memo.generate" },
    });

    const invalidEvidence = await runtime.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/tracking/memos`,
      payload: {
        idempotencyKey: "memo-http-generate-2",
        instruction: "引用不存在的证据",
        evidenceIds: ["fact:does-not-exist"],
      },
    });
    expect(invalidEvidence.statusCode, invalidEvidence.body).toBe(400);
    expect(invalidEvidence.json()).toMatchObject({
      error: "invalid_evidence_reference",
    });

    // (d) tenant isolation: another namespace cannot see the project.
    otherTenantRuntime = await createApiRuntime({
      ...config,
      port: 6769,
      auth: {
        mode: "development",
        userId: "insights-http-other",
        dataNamespace: OTHER_NAMESPACE,
      },
    });
    const foreignRequests = [
      {
        method: "GET" as const,
        url: `/v1/projects/${project.id}/tracking/memos`,
      },
      {
        method: "GET" as const,
        url:
          `/v1/projects/${project.id}/tracking/memos/compare` +
          `?fromVersionId=${seeded.memoVersion1Id}` +
          `&toVersionId=${seeded.memoVersion2Id}`,
      },
      {
        method: "POST" as const,
        url: `/v1/projects/${project.id}/tracking/memos`,
        payload: {
          idempotencyKey: "memo-cross-tenant",
          instruction: "跨租户请求",
        },
      },
      {
        method: "GET" as const,
        url:
          `/v1/projects/${project.id}/tracking/memos/` +
          `${seeded.memoVersion2Id}/preview`,
      },
    ];
    for (const request of foreignRequests) {
      // eslint-disable-next-line no-await-in-loop
      const response = await otherTenantRuntime.app.inject(request);
      expect(
        response.statusCode,
        `${request.method} ${request.url}: ${response.body}`,
      ).toBe(404);
    }

    // (e) the retired pre/post-investment surface is gone entirely.
    for (const url of [
      `/v1/projects/${project.id}/tracking`,
      `/v1/projects/${project.id}/valuation`,
      `/v1/projects/${project.id}/workflow`,
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const response = await runtime.app.inject({ method: "GET", url });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(404);
    }
  });
});

function seedMemos(projectId: string, projectRoot: string): SeededMemos {
  const seeder = new ProjectResearchStoreManager();
  try {
    const tracking = seeder.getWorkflow(projectRoot).tracking;
    const memo1 = tracking.saveMemoVersion({
      datasetId: projectId,
      topic: "供应链",
      title: "供应链跟踪备忘录",
      asOfDate: "2026-06-30",
      sourceType: "agent_generated",
      status: "completed",
      contentHash: "memo-supply-chain-v1",
      idempotencyKey: "memo-supply-chain-v1",
      sections: [
        {
          sectionKey: "overview",
          title: "概览",
          content: "公司基本面保持稳定。",
          evidenceIds: [],
        },
        {
          sectionKey: "risk",
          title: "供应链风险",
          content: "供应商切换仍在评估。",
          evidenceIds: ["fact:supplier-review"],
        },
        {
          sectionKey: "legacy",
          title: "历史事项",
          content: "旧产线折旧已计提完毕。",
          evidenceIds: [],
        },
      ],
    }).record;
    const memo2 = tracking.saveMemoVersion({
      datasetId: projectId,
      topic: "供应链",
      title: "供应链跟踪备忘录",
      asOfDate: "2026-07-31",
      sourceType: "agent_generated",
      status: "completed",
      contentHash: "memo-supply-chain-v2",
      idempotencyKey: "memo-supply-chain-v2",
      sections: [
        {
          sectionKey: "overview",
          title: "概览",
          content: "公司基本面保持稳定。",
          evidenceIds: [],
        },
        {
          sectionKey: "risk",
          title: "供应链风险",
          content: "供应商切换方案已获批。",
          evidenceIds: ["fact:supplier-approved"],
        },
        {
          sectionKey: "catalyst",
          title: "催化剂",
          content: "新产能预计四季度爬坡。",
          evidenceIds: [],
        },
      ],
    }).record;
    tracking.saveMemoVersion({
      datasetId: projectId,
      topic: "客户集中度",
      title: "客户集中度备忘录",
      asOfDate: "2026-07-31",
      sourceType: "agent_generated",
      status: "completed",
      contentHash: "memo-concentration-v1",
      idempotencyKey: "memo-concentration-v1",
      sections: [],
    });
    tracking.appendItemVersion({
      datasetId: projectId,
      itemType: "risk",
      canonicalKey: "supplier-transition",
      title: "供应商切换",
      sourceType: "document",
      sourceId: "supplier-review-document",
      content: "供应商切换仍在评估",
      state: "monitoring",
      evidenceIds: ["fact:supplier-review"],
    });
    const memoLinkedItem = tracking.appendItemVersion({
      datasetId: projectId,
      itemType: "risk",
      canonicalKey: "supplier-transition",
      title: "供应商切换",
      sourceType: "memo",
      sourceId: memo2.memoVersionId,
      content: "供应商切换方案已获批",
      state: "mitigating",
      evidenceIds: ["fact:supplier-approved"],
      change: {
        changeType: "status_changed",
        materiality: "high",
        summary: "备忘录确认供应链风险进入缓解阶段",
        details: { source: "memo-v2" },
      },
    });

    return {
      memoSeriesId: memo1.seriesId,
      memoVersion1Id: memo1.memoVersionId,
      memoVersion2Id: memo2.memoVersionId,
      memoChangeEventId: memoLinkedItem.change!.changeEventId,
      memoItemVersionId: memoLinkedItem.version.itemVersionId,
    };
  } finally {
    seeder.close();
  }
}
