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
const OWNER_NAMESPACE = "00000000-0000-4000-8000-000000000091";
const OTHER_NAMESPACE = "00000000-0000-4000-8000-000000000092";

interface SeededComparison {
  readonly memoVersion1Id: string;
  readonly memoVersion2Id: string;
  readonly memoChangeEventId: string;
  readonly memoItemVersionId: string;
  readonly valuationSeriesId: string;
}

describe("memo comparison and valuation overview HTTP semantics", () => {
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

  it("returns memo-linked item changes and dataset-scoped valuation change counts", async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-memo-valuation-"));
    const config: ApiConfig = {
      host: "127.0.0.1",
      port: 6772,
      dataRoot,
      controlDatabase: path.join(dataRoot, "control.sqlite3"),
      auth: {
        mode: "development",
        userId: "memo-valuation-owner",
        dataNamespace: OWNER_NAMESPACE,
      },
      agentWorkerEntry: WORKER_ENTRY,
    };
    runtime = await createApiRuntime(config);

    const projectResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: {
        name: "Memo and valuation semantics",
        companyName: "Semantic Holdings",
        ticker: "000002.SZ",
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
    const seeded = seedComparison(project.id, projectRoot);

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

    const valuationOverview = await runtime.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/valuation?limit=100&offset=0`,
    });
    expect(valuationOverview.statusCode, valuationOverview.body).toBe(200);
    expect(valuationOverview.json()).toMatchObject({
      series: {
        total: 1,
        items: [{ seriesId: seeded.valuationSeriesId }],
      },
      changeCounts: {
        low: 1,
        high: 1,
      },
    });
    expect(valuationOverview.json().changeCounts).toEqual({
      low: 1,
      high: 1,
    });

    otherTenantRuntime = await createApiRuntime({
      ...config,
      port: 6773,
      auth: {
        mode: "development",
        userId: "memo-valuation-other",
        dataNamespace: OTHER_NAMESPACE,
      },
    });
    for (const url of [
      `/v1/projects/${project.id}/tracking/memos/compare` +
        `?fromVersionId=${seeded.memoVersion1Id}` +
        `&toVersionId=${seeded.memoVersion2Id}`,
      `/v1/projects/${project.id}/valuation?limit=100&offset=0`,
    ]) {
      const response = await otherTenantRuntime.app.inject({
        method: "GET",
        url,
      });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(404);
    }
  });
});

function seedComparison(
  projectId: string,
  projectRoot: string,
): SeededComparison {
  const seeder = new ProjectResearchStoreManager();
  try {
    const workflow = seeder.getWorkflow(projectRoot);
    const tracking = workflow.tracking;
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
          sectionKey: "risk",
          title: "供应链风险",
          content: "供应商切换仍在评估。",
          evidenceIds: ["fact:supplier-review"],
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
          sectionKey: "risk",
          title: "供应链风险",
          content: "供应商切换方案已获批。",
          evidenceIds: ["fact:supplier-approved"],
        },
      ],
    }).record;
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

    const valuation = workflow.valuation;
    const series = valuation.upsertSeries({
      datasetId: projectId,
      seriesKey: "semantic-dcf",
      name: "Semantic DCF",
      companyName: "Semantic Holdings",
      companyTicker: "000002.SZ",
      modelType: "dcf_model",
    });
    const version1 = valuation.saveModelVersion({
      datasetId: projectId,
      seriesId: series.seriesId,
      docId: "semantic-model-v1",
      logicalDocId: "semantic-model",
      documentVersionNo: 1,
      checksum: "a".repeat(64),
      snapshotHash: "b".repeat(64),
      originalFilename: "semantic-dcf-v1.xlsx",
      modelType: "dcf_model",
      nodeCount: 2,
      formulaNodeCount: 1,
      analyzerVersion: "valuation-tracking-v1",
      idempotencyKey: "semantic-model-v1",
    }).value;
    const version2 = valuation.saveModelVersion({
      datasetId: projectId,
      seriesId: series.seriesId,
      docId: "semantic-model-v2",
      logicalDocId: "semantic-model",
      documentVersionNo: 2,
      parentModelVersionId: version1.modelVersionId,
      checksum: "c".repeat(64),
      snapshotHash: "d".repeat(64),
      originalFilename: "semantic-dcf-v2.xlsx",
      modelType: "dcf_model",
      nodeCount: 2,
      formulaNodeCount: 1,
      analyzerVersion: "valuation-tracking-v1",
      idempotencyKey: "semantic-model-v2",
    }).value;
    const waccNode = valuation.upsertNode({
      seriesId: series.seriesId,
      canonicalKey: "assumption:wacc:2026:base",
      nodeKind: "assumption",
      metricKey: "wacc",
      displayName: "WACC",
      scope: "company",
      period: "2026",
      scenario: "base",
    });
    const growthNode = valuation.upsertNode({
      seriesId: series.seriesId,
      canonicalKey: "forecast:revenue-growth:2026:base",
      nodeKind: "forecast",
      metricKey: "revenue_growth",
      displayName: "收入增速",
      scope: "company",
      period: "2026",
      scenario: "base",
    });
    valuation.recordChange({
      datasetId: projectId,
      seriesId: series.seriesId,
      fromModelVersionId: version1.modelVersionId,
      toModelVersionId: version2.modelVersionId,
      nodeId: waccNode.nodeId,
      changeType: "formula_changed",
      materiality: "high",
      summary: "WACC 公式纳入风险溢价",
      oldValue: { formula: "=B8+B9" },
      newValue: { formula: "=B8+B9+B10" },
    });
    valuation.recordChange({
      datasetId: projectId,
      seriesId: series.seriesId,
      fromModelVersionId: version1.modelVersionId,
      toModelVersionId: version2.modelVersionId,
      nodeId: growthNode.nodeId,
      changeType: "value_changed",
      materiality: "low",
      summary: "收入增速小幅调整",
      oldValue: { value: 0.12 },
      newValue: { value: 0.115 },
    });

    return {
      memoVersion1Id: memo1.memoVersionId,
      memoVersion2Id: memo2.memoVersionId,
      memoChangeEventId: memoLinkedItem.change!.changeEventId,
      memoItemVersionId: memoLinkedItem.version.itemVersionId,
      valuationSeriesId: series.seriesId,
    };
  } finally {
    seeder.close();
  }
}
