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

interface SeededInsights {
  readonly projectId: string;
  readonly itemId: string;
  readonly trackingAlertId: string;
  readonly memoSeriesId: string;
  readonly valuationSeriesId: string;
  readonly valuationVersion1Id: string;
  readonly valuationVersion2Id: string;
  readonly valuationAnalysisId: string;
  readonly valuationRuleId: string;
  readonly valuationAlertId: string;
}

describe("seeded tracking and valuation HTTP acceptance", () => {
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

  it("preserves non-empty tracking and valuation reads, mutations, pagination and tenant scope", async () => {
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
        name: "Seeded insights acceptance",
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
    const seeded = seedInsights(project.id, projectRoot);

    const trackingOverview = await runtime.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/tracking?limit=1&offset=0`,
    });
    expect(trackingOverview.statusCode, trackingOverview.body).toBe(200);
    expect(trackingOverview.json()).toMatchObject({
      overview: {
        datasetId: project.id,
        counts: { risk: 1 },
        unreadAlertCount: 1,
      },
      items: {
        total: 1,
        items: [
          {
            itemId: seeded.itemId,
            status: "resolved",
            currentVersion: {
              content: "核心客户续约已经落地",
              impact: "high",
            },
          },
        ],
      },
      alerts: {
        total: 1,
        items: [
          {
            alertId: seeded.trackingAlertId,
            status: "new",
            priority: "high",
          },
        ],
      },
      watchRules: { total: 2, hasMore: true },
      memoSeries: {
        total: 1,
        items: [
          {
            seriesId: seeded.memoSeriesId,
            currentVersionNo: 1,
            versionCount: 1,
          },
        ],
      },
      memoVersions: {
        total: 1,
        items: [{ topic: "客户集中度", sections: [{ sectionKey: "risk" }] }],
      },
    });

    const trackingItems = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/tracking/items` +
        "?itemType=risk&status=resolved&limit=1&offset=0",
    });
    expect(trackingItems.statusCode, trackingItems.body).toBe(200);
    expect(trackingItems.json()).toMatchObject({
      total: 1,
      limit: 1,
      offset: 0,
      hasMore: false,
      items: [{ itemId: seeded.itemId, itemType: "risk" }],
    });

    const timeline = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/tracking/items/` +
        `${seeded.itemId}/timeline`,
    });
    expect(timeline.statusCode, timeline.body).toBe(200);
    expect(timeline.json()).toMatchObject({
      item: { itemId: seeded.itemId, status: "resolved" },
      versions: [
        { versionNo: 1, content: "核心客户续约仍存在不确定性" },
        { versionNo: 2, content: "核心客户续约已经落地" },
      ],
      changes: [
        {
          changeType: "status_changed",
          materiality: "high",
          summary: "核心客户续约风险解除",
        },
      ],
      observations: [
        {
          sourceType: "memo",
          content: "投委会确认续约合同已经签署",
        },
      ],
    });

    const memoHistory = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/tracking/memos` +
        `?seriesId=${seeded.memoSeriesId}&limit=1&offset=0`,
    });
    expect(memoHistory.statusCode, memoHistory.body).toBe(200);
    expect(memoHistory.json()).toMatchObject({
      series: {
        total: 1,
        items: [{ seriesId: seeded.memoSeriesId, versionCount: 1 }],
      },
      versions: {
        total: 1,
        items: [
          {
            seriesId: seeded.memoSeriesId,
            seriesTitle: "客户集中度跟踪备忘录",
            sections: [
              {
                title: "风险结论",
                evidenceIds: ["fact:customer-renewal"],
              },
            ],
          },
        ],
      },
    });

    const initialTrackingRules = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/tracking/watch-rules` +
        "?limit=10&offset=0",
    });
    expect(initialTrackingRules.statusCode, initialTrackingRules.body).toBe(
      200,
    );
    expect(initialTrackingRules.json()).toMatchObject({
      total: 2,
      items: expect.arrayContaining([
        expect.objectContaining({ targetType: "risk", active: true }),
        expect.objectContaining({ targetType: "catalyst", active: true }),
      ]),
    });

    const createTrackingRule = await runtime.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/tracking/watch-rules`,
      payload: {
        name: "客户续约专项规则",
        targetType: "risk",
        targetItemId: seeded.itemId,
        query: { terms: ["续约", "合同"] },
        minPriority: "high",
        frequency: "daily",
        active: true,
      },
    });
    expect(createTrackingRule.statusCode, createTrackingRule.body).toBe(201);
    const createdTrackingRule = createTrackingRule.json<{
      ruleId: string;
    }>();
    expect(createTrackingRule.json()).toMatchObject({
      datasetId: project.id,
      name: "客户续约专项规则",
      targetType: "risk",
      targetItemId: seeded.itemId,
      query: { terms: ["续约", "合同"] },
      minPriority: "high",
      frequency: "daily",
      active: true,
    });

    const updateTrackingRule = await runtime.app.inject({
      method: "PATCH",
      url:
        `/v1/projects/${project.id}/tracking/watch-rules/` +
        createdTrackingRule.ruleId,
      payload: {
        name: "客户续约专项规则（归档）",
        active: false,
      },
    });
    expect(updateTrackingRule.statusCode, updateTrackingRule.body).toBe(200);
    expect(updateTrackingRule.json()).toMatchObject({
      ruleId: createdTrackingRule.ruleId,
      name: "客户续约专项规则（归档）",
      targetItemId: seeded.itemId,
      minPriority: "high",
      active: false,
    });

    const trackingAlerts = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/tracking/alerts` +
        "?status=new&limit=1&offset=0",
    });
    expect(trackingAlerts.statusCode, trackingAlerts.body).toBe(200);
    expect(trackingAlerts.json()).toMatchObject({
      total: 1,
      items: [
        {
          alertId: seeded.trackingAlertId,
          itemId: seeded.itemId,
          evidenceIds: ["fact:customer-renewal"],
          status: "new",
        },
      ],
    });

    const updateTrackingAlert = await runtime.app.inject({
      method: "PATCH",
      url:
        `/v1/projects/${project.id}/tracking/alerts/` +
        seeded.trackingAlertId,
      payload: { status: "acknowledged" },
    });
    expect(updateTrackingAlert.statusCode, updateTrackingAlert.body).toBe(
      200,
    );
    expect(updateTrackingAlert.json()).toMatchObject({
      alertId: seeded.trackingAlertId,
      status: "acknowledged",
      snoozedUntil: null,
    });

    const valuationVersions = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/valuation/series/` +
        `${seeded.valuationSeriesId}/versions?limit=1&offset=0`,
    });
    expect(valuationVersions.statusCode, valuationVersions.body).toBe(200);
    expect(valuationVersions.json()).toMatchObject({
      total: 2,
      limit: 1,
      offset: 0,
      hasMore: true,
      items: [
        {
          modelVersionId: seeded.valuationVersion2Id,
          documentVersionNo: 2,
          originalFilename: "acceptance-dcf-v2.xlsx",
        },
      ],
    });

    const valuationComparison = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/valuation/series/` +
        `${seeded.valuationSeriesId}/compare` +
        `?fromVersionId=${seeded.valuationVersion1Id}` +
        `&toVersionId=${seeded.valuationVersion2Id}`,
    });
    expect(
      valuationComparison.statusCode,
      valuationComparison.body,
    ).toBe(200);
    expect(valuationComparison.json()).toMatchObject({
      series: { seriesId: seeded.valuationSeriesId, name: "Acceptance DCF" },
      fromVersion: { modelVersionId: seeded.valuationVersion1Id },
      toVersion: { modelVersionId: seeded.valuationVersion2Id },
      changes: [
        {
          changeType: "formula_changed",
          materiality: "high",
          summary: "WACC 公式纳入新增风险溢价",
          evidenceIds: ["cell:acceptance-v1-b12", "cell:acceptance-v2-b12"],
        },
      ],
      fromValues: [
        {
          modelVersionId: seeded.valuationVersion1Id,
          valueNumeric: 0.085,
          cellRef: "B12",
        },
      ],
      toValues: [
        {
          modelVersionId: seeded.valuationVersion2Id,
          valueNumeric: 0.09,
          cellRef: "B12",
        },
      ],
    });

    const valuationAnalysis = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/valuation/analyses/` +
        seeded.valuationAnalysisId,
    });
    expect(valuationAnalysis.statusCode, valuationAnalysis.body).toBe(200);
    expect(valuationAnalysis.json()).toMatchObject({
      analysisId: seeded.valuationAnalysisId,
      datasetId: project.id,
      seriesId: seeded.valuationSeriesId,
      status: "completed",
      valuationMethod: "DCF",
      executiveSummary: "WACC 是当前估值最敏感的变量。",
      investmentConclusion: "维持基础情景，持续验证风险溢价。",
      analysis: {
        keyFindings: [
          {
            claim: "WACC 上调压低目标价值。",
            evidenceIds: ["cell:acceptance-v2-b12"],
          },
        ],
      },
    });

    const updateValuationRule = await runtime.app.inject({
      method: "PATCH",
      url:
        `/v1/projects/${project.id}/valuation/watch-rules/` +
        seeded.valuationRuleId,
      payload: { active: false, minMateriality: "critical" },
    });
    expect(updateValuationRule.statusCode, updateValuationRule.body).toBe(200);
    expect(updateValuationRule.json()).toMatchObject({
      ruleId: seeded.valuationRuleId,
      seriesId: seeded.valuationSeriesId,
      name: "重大公式变化",
      minMateriality: "critical",
      changeTypes: ["formula_changed"],
      active: false,
    });

    const updateValuationAlert = await runtime.app.inject({
      method: "PATCH",
      url:
        `/v1/projects/${project.id}/valuation/alerts/` +
        seeded.valuationAlertId,
      payload: { status: "acknowledged" },
    });
    expect(updateValuationAlert.statusCode, updateValuationAlert.body).toBe(
      200,
    );
    expect(updateValuationAlert.json()).toMatchObject({
      alertId: seeded.valuationAlertId,
      seriesId: seeded.valuationSeriesId,
      changeId: expect.any(String),
      status: "acknowledged",
      snoozedUntil: null,
    });

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
        url: `/v1/projects/${project.id}/tracking`,
      },
      {
        method: "GET" as const,
        url: `/v1/projects/${project.id}/tracking/items`,
      },
      {
        method: "GET" as const,
        url:
          `/v1/projects/${project.id}/tracking/items/` +
          `${seeded.itemId}/timeline`,
      },
      {
        method: "GET" as const,
        url: `/v1/projects/${project.id}/tracking/memos`,
      },
      {
        method: "GET" as const,
        url: `/v1/projects/${project.id}/tracking/watch-rules`,
      },
      {
        method: "POST" as const,
        url: `/v1/projects/${project.id}/tracking/watch-rules`,
        payload: {
          name: "Cross tenant rule",
          targetType: "all",
        },
      },
      {
        method: "PATCH" as const,
        url:
          `/v1/projects/${project.id}/tracking/watch-rules/` +
          createdTrackingRule.ruleId,
        payload: { active: true },
      },
      {
        method: "GET" as const,
        url: `/v1/projects/${project.id}/tracking/alerts`,
      },
      {
        method: "PATCH" as const,
        url:
          `/v1/projects/${project.id}/tracking/alerts/` +
          seeded.trackingAlertId,
        payload: { status: "dismissed" },
      },
      {
        method: "GET" as const,
        url:
          `/v1/projects/${project.id}/valuation/series/` +
          `${seeded.valuationSeriesId}/versions`,
      },
      {
        method: "GET" as const,
        url:
          `/v1/projects/${project.id}/valuation/series/` +
          `${seeded.valuationSeriesId}/compare` +
          `?fromVersionId=${seeded.valuationVersion1Id}` +
          `&toVersionId=${seeded.valuationVersion2Id}`,
      },
      {
        method: "GET" as const,
        url:
          `/v1/projects/${project.id}/valuation/analyses/` +
          seeded.valuationAnalysisId,
      },
      {
        method: "PATCH" as const,
        url:
          `/v1/projects/${project.id}/valuation/watch-rules/` +
          seeded.valuationRuleId,
        payload: { active: true },
      },
      {
        method: "PATCH" as const,
        url:
          `/v1/projects/${project.id}/valuation/alerts/` +
          seeded.valuationAlertId,
        payload: { status: "dismissed" },
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
  });
});

function seedInsights(projectId: string, projectRoot: string): SeededInsights {
  const seeder = new ProjectResearchStoreManager();
  try {
    const workflow = seeder.getWorkflow(projectRoot);
    const tracking = workflow.tracking;
    const firstItem = tracking.appendItemVersion({
      datasetId: projectId,
      itemType: "risk",
      canonicalKey: "customer-renewal",
      title: "核心客户续约",
      status: "monitoring",
      sourceType: "document",
      sourceId: "customer-renewal-v1",
      content: "核心客户续约仍存在不确定性",
      state: "monitoring",
      impact: "high",
      evidenceIds: ["fact:customer-renewal-risk"],
    });
    const secondItem = tracking.appendItemVersion({
      datasetId: projectId,
      itemType: "risk",
      canonicalKey: "customer-renewal",
      title: "核心客户续约",
      status: "resolved",
      sourceType: "document",
      sourceId: "customer-renewal-v2",
      content: "核心客户续约已经落地",
      state: "resolved",
      impact: "high",
      evidenceIds: ["fact:customer-renewal"],
      change: {
        changeType: "status_changed",
        materiality: "high",
        summary: "核心客户续约风险解除",
        details: { from: "monitoring", to: "resolved" },
      },
    });
    tracking.recordObservation({
      datasetId: projectId,
      itemId: firstItem.item.itemId,
      itemVersionId: secondItem.version.itemVersionId,
      sourceType: "memo",
      sourceId: "investment-committee-confirmation",
      content: "投委会确认续约合同已经签署",
      evidenceIds: ["fact:customer-renewal"],
      extracted: { confidence: 0.98 },
    });
    const trackingRule = tracking.ensureDefaultWatchRules(projectId)[0]!;
    const trackingAlert = tracking.createAlert({
      datasetId: projectId,
      ruleId: trackingRule.ruleId,
      itemId: firstItem.item.itemId,
      changeEventId: secondItem.change!.changeEventId,
      alertType: "status_changed",
      priority: "high",
      title: "核心客户续约状态变化",
      summary: "核心客户续约风险已经解除",
      whyItMatters: "客户集中度风险下降",
      evidenceIds: ["fact:customer-renewal"],
      dedupeKey: "customer-renewal-status-v2",
    });
    const memo = tracking.saveMemoVersion({
      datasetId: projectId,
      topic: "客户集中度",
      title: "客户集中度跟踪备忘录",
      asOfDate: "2026-07-31",
      sourceType: "agent_generated",
      status: "completed",
      contentHash: "memo-customer-renewal-v1",
      idempotencyKey: "memo-customer-renewal-v1",
      sections: [
        {
          sectionKey: "risk",
          title: "风险结论",
          content: "续约落地后，客户集中度风险边际下降。",
          evidenceIds: ["fact:customer-renewal"],
        },
      ],
    }).record;

    const valuation = workflow.valuation;
    const series = valuation.upsertSeries({
      datasetId: projectId,
      seriesKey: "acceptance-dcf",
      name: "Acceptance DCF",
      companyName: "Acceptance Holdings",
      companyTicker: "000001.SZ",
      modelType: "dcf_model",
    });
    const firstVersion = valuation.saveModelVersion({
      datasetId: projectId,
      seriesId: series.seriesId,
      docId: "acceptance-model-v1",
      logicalDocId: "acceptance-model",
      documentVersionNo: 1,
      checksum: "a".repeat(64),
      snapshotHash: "b".repeat(64),
      originalFilename: "acceptance-dcf-v1.xlsx",
      modelType: "dcf_model",
      nodeCount: 1,
      formulaNodeCount: 1,
      analyzerVersion: "valuation-tracking-v1",
      idempotencyKey: "acceptance-model-v1",
    }).value;
    const secondVersion = valuation.saveModelVersion({
      datasetId: projectId,
      seriesId: series.seriesId,
      docId: "acceptance-model-v2",
      logicalDocId: "acceptance-model",
      documentVersionNo: 2,
      parentModelVersionId: firstVersion.modelVersionId,
      checksum: "c".repeat(64),
      snapshotHash: "d".repeat(64),
      originalFilename: "acceptance-dcf-v2.xlsx",
      modelType: "dcf_model",
      nodeCount: 1,
      formulaNodeCount: 1,
      analyzerVersion: "valuation-tracking-v1",
      idempotencyKey: "acceptance-model-v2",
    }).value;
    const node = valuation.upsertNode({
      seriesId: series.seriesId,
      canonicalKey: "assumption:wacc:2026:base",
      nodeKind: "assumption",
      metricKey: "wacc",
      displayName: "WACC",
      scope: "company",
      period: "2026",
      scenario: "base",
    });
    valuation.saveNodeValue({
      modelVersionId: firstVersion.modelVersionId,
      nodeId: node.nodeId,
      valueNumeric: 0.085,
      unit: "percent",
      formula: "=B8+B9",
      formulaFingerprint: "wacc-v1",
      sheetName: "DCF",
      cellRef: "B12",
      evidenceId: "cell:acceptance-v1-b12",
      qualityStatus: "verified",
      confidence: 0.98,
    });
    valuation.saveNodeValue({
      modelVersionId: secondVersion.modelVersionId,
      nodeId: node.nodeId,
      valueNumeric: 0.09,
      unit: "percent",
      formula: "=B8+B9+B10",
      formulaFingerprint: "wacc-v2",
      sheetName: "DCF",
      cellRef: "B12",
      evidenceId: "cell:acceptance-v2-b12",
      qualityStatus: "verified",
      confidence: 0.98,
    });
    const valuationRule = valuation.upsertWatchRule({
      datasetId: projectId,
      seriesId: series.seriesId,
      name: "重大公式变化",
      minMateriality: "medium",
      changeTypes: ["formula_changed"],
      idempotencyKey: "material-formula-changes",
      active: true,
    });
    valuation.recordChange({
      datasetId: projectId,
      seriesId: series.seriesId,
      fromModelVersionId: firstVersion.modelVersionId,
      toModelVersionId: secondVersion.modelVersionId,
      nodeId: node.nodeId,
      changeType: "formula_changed",
      materiality: "high",
      summary: "WACC 公式纳入新增风险溢价",
      oldValue: { formula: "=B8+B9", value: 0.085 },
      newValue: { formula: "=B8+B9+B10", value: 0.09 },
      absoluteChange: 0.005,
      relativeChange: 0.0588,
      evidenceIds: ["cell:acceptance-v1-b12", "cell:acceptance-v2-b12"],
    });
    const valuationAlert = valuation.listAlerts(projectId, {
      limit: 10,
      offset: 0,
    }).items[0]!;
    const analysis = valuation.createAgentAnalysis({
      datasetId: projectId,
      seriesId: series.seriesId,
      baseModelVersionId: secondVersion.modelVersionId,
      comparisonModelVersionId: firstVersion.modelVersionId,
      focus: "WACC 敏感性",
      agentVersion: "pi-agent-v1",
      idempotencyKey: "acceptance-analysis-v1",
    }).value;
    valuation.transitionAgentAnalysis(projectId, analysis.analysisId, {
      status: "running",
      planner: {
        dimensions: ["assumptions"],
        selectedEvidenceIds: ["cell:acceptance-v2-b12"],
      },
    });
    valuation.transitionAgentAnalysis(projectId, analysis.analysisId, {
      status: "completed",
      valuationMethod: "DCF",
      executiveSummary: "WACC 是当前估值最敏感的变量。",
      investmentConclusion: "维持基础情景，持续验证风险溢价。",
      analysis: {
        keyFindings: [
          {
            claim: "WACC 上调压低目标价值。",
            evidenceIds: ["cell:acceptance-v2-b12"],
          },
        ],
      },
      evidenceIds: ["cell:acceptance-v2-b12"],
      rawResponse: "completed",
      modelName: "pi-agent",
    });

    return {
      projectId,
      itemId: firstItem.item.itemId,
      trackingAlertId: trackingAlert.record.alertId,
      memoSeriesId: memo.seriesId,
      valuationSeriesId: series.seriesId,
      valuationVersion1Id: firstVersion.modelVersionId,
      valuationVersion2Id: secondVersion.modelVersionId,
      valuationAnalysisId: analysis.analysisId,
      valuationRuleId: valuationRule.ruleId,
      valuationAlertId: valuationAlert.alertId,
    };
  } finally {
    seeder.close();
  }
}
