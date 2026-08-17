import { DatabaseSync } from "node:sqlite";

import {
  createWorkflowStore,
  type ObsidianOutboxEvent,
  type WorkflowStore,
} from "@private-fund/workflow-store";
import { beforeEach, describe, expect, it } from "vitest";

import {
  AuthoritativeObsidianReconciler,
  AuthoritativeObsidianRenderer,
  ObsidianProjectionError,
} from "../src/index.js";

const DATASET_ID = "project-a";

function context(event: ObsidianOutboxEvent) {
  return {
    binding: {
      tenantId: "tenant-a",
      projectId: DATASET_ID,
      datasetId: DATASET_ID,
      projectRoot: "/tmp/not-used-by-renderer",
    },
    event,
  };
}

describe("AuthoritativeObsidianRenderer", () => {
  let database: DatabaseSync;
  let store: WorkflowStore;
  let renderer: AuthoritativeObsidianRenderer;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys=ON");
    store = createWorkflowStore(database);
    renderer = new AuthoritativeObsidianRenderer(store);
  });

  it("renders Memo content and Evidence from SQLite, never event payload", async () => {
    const saved = store.tracking.saveMemoVersion({
      datasetId: DATASET_ID,
      topic: "Tesla",
      title: "Tesla investment memo",
      asOfDate: "2026-07-31",
      sourceType: "agent",
      contentHash: "memo-hash-1",
      sections: [
        {
          sectionKey: "thesis",
          title: "Investment thesis",
          content: "Repository-authoritative margin expansion.",
          evidenceIds: ["fact:margin", "cell:gross-margin"],
        },
      ],
    }).record;
    const event = store.obsidian.enqueue({
      datasetId: DATASET_ID,
      entityType: "memo-series",
      entityId: saved.seriesId,
      sourceVersion: "1",
      payload: {
        body: "PAYLOAD MUST NOT APPEAR",
        title: "Spoofed title",
      },
    });

    const plan = await renderer.render(context(event));
    const note = plan.notes[0];

    expect(note?.title).toBe("Tesla investment memo");
    expect(note?.body).toContain(
      "Repository-authoritative margin expansion.",
    );
    expect(note?.body).not.toContain("PAYLOAD MUST NOT APPEAR");
    expect(note?.evidence?.map((item) => item.evidenceId)).toEqual([
      "cell:gross-margin",
      "fact:margin",
    ]);
    expect(note?.relativePath).toMatch(/^memos\/.+\.md$/u);
  });

  it("renders exact tracking history and reconciles a missing outbox event", async () => {
    const appended = store.tracking.appendItemVersion({
      datasetId: DATASET_ID,
      itemType: "risk",
      canonicalKey: "risk:gross-margin",
      title: "Gross-margin pressure",
      sourceType: "filing",
      sourceId: "doc-1",
      content: "Automotive gross margin declined year over year.",
      impact: "high",
      confidence: 0.92,
      evidenceIds: ["fact:risk-margin"],
    });
    const reconciler = new AuthoritativeObsidianReconciler(store);

    const result = reconciler.reconcile(DATASET_ID);
    const event = store.obsidian.listEvents({
      datasetId: DATASET_ID,
      entityType: "tracking-item",
    }).items[0];

    expect(result.newlyEnqueued).toBe(1);
    expect(event?.entityId).toBe(appended.item.itemId);
    const plan = await renderer.render(context(event!));
    expect(plan.notes[0]?.title).toBe("Gross-margin pressure");
    expect(plan.notes[0]?.body).toContain(
      "Automotive gross margin declined year over year.",
    );
    expect(plan.notes[0]?.evidence?.[0]?.evidenceId).toBe(
      "fact:risk-margin",
    );
  });

  it("does not leak a later tracking version into an older source projection", async () => {
    const first = store.tracking.appendItemVersion({
      datasetId: DATASET_ID,
      itemType: "metric",
      canonicalKey: "estimate:deliveries",
      title: "Vehicle deliveries",
      sourceType: "filing",
      sourceId: "doc-v1",
      content: "Version-one delivery estimate.",
      evidenceIds: ["fact:deliveries-v1"],
    });
    const oldEvent = store.obsidian.enqueue({
      datasetId: DATASET_ID,
      entityType: "tracking-item",
      entityId: first.item.itemId,
      sourceVersion: "1",
    });
    store.tracking.appendItemVersion({
      datasetId: DATASET_ID,
      itemType: "metric",
      canonicalKey: "estimate:deliveries",
      title: "Vehicle deliveries",
      sourceType: "filing",
      sourceId: "doc-v2",
      content: "Version-two delivery estimate must stay out.",
      evidenceIds: ["fact:deliveries-v2"],
    });

    const plan = await renderer.render(context(oldEvent));

    expect(plan.notes[0]?.body).toContain("Version-one delivery estimate.");
    expect(plan.notes[0]?.body).not.toContain(
      "Version-two delivery estimate must stay out.",
    );
    expect(plan.notes[0]?.evidence?.map((item) => item.evidenceId)).toEqual([
      "fact:deliveries-v1",
    ]);
  });

  it("renders valuation model nodes and both repository and agent analyses", async () => {
    const series = store.valuation.upsertSeries({
      datasetId: DATASET_ID,
      seriesKey: "tesla-dcf",
      name: "Tesla DCF",
      companyName: "Tesla",
      companyTicker: "TSLA",
      modelType: "dcf",
    });
    const version = store.valuation.saveModelVersion({
      datasetId: DATASET_ID,
      seriesId: series.seriesId,
      docId: "doc-model-1",
      documentVersionNo: 1,
      checksum: "checksum-model-1",
      snapshotHash: "snapshot-model-1",
      originalFilename: "tesla.xlsx",
      modelType: "dcf",
      nodeCount: 1,
      formulaNodeCount: 1,
      reviewRequiredCount: 0,
      analyzerVersion: "extractor-v1",
    }).value;
    const node = store.valuation.upsertNode({
      seriesId: series.seriesId,
      canonicalKey: "valuation:target-price",
      nodeKind: "output",
      metricKey: "target_price",
      displayName: "Target price",
      scope: "consolidated",
    });
    store.valuation.saveNodeValue({
      modelVersionId: version.modelVersionId,
      nodeId: node.nodeId,
      valueNumeric: 325,
      unit: "USD/share",
      formula: "=DCF!B42",
      sheetName: "DCF",
      cellRef: "B42",
      evidenceId: "cell:dcf-b42",
      qualityStatus: "verified",
    });
    store.valuation.saveAnalysisVersion({
      datasetId: DATASET_ID,
      seriesId: series.seriesId,
      modelVersionId: version.modelVersionId,
      summaryMarkdown: "Base-case value is supported by free-cash-flow growth.",
      analysis: { evidenceId: "cell:dcf-b42" },
      analyzerVersion: "analysis-v1",
    });
    let agent = store.valuation.createAgentAnalysis({
      datasetId: DATASET_ID,
      seriesId: series.seriesId,
      baseModelVersionId: version.modelVersionId,
      focus: "downside",
      agentVersion: "pi-v1",
    }).value;
    agent = store.valuation.transitionAgentAnalysis(
      DATASET_ID,
      agent.analysisId,
      { status: "running" },
    );
    agent = store.valuation.transitionAgentAnalysis(
      DATASET_ID,
      agent.analysisId,
      {
        status: "completed",
        executiveSummary: "Downside is bounded by liquidity.",
        investmentConclusion: "Maintain a measured position.",
        valuationMethod: "DCF",
        analysis: { downside: "20%" },
        planner: { steps: ["compare", "stress"] },
        evidenceIds: ["cell:dcf-b42"],
      },
    );

    const seriesEvent = store.obsidian.enqueue({
      datasetId: DATASET_ID,
      entityType: "valuation-series",
      entityId: series.seriesId,
      sourceVersion: "1",
    });
    const analysisEvent = store.obsidian.enqueue({
      datasetId: DATASET_ID,
      entityType: "valuation-analysis",
      entityId: agent.analysisId,
      sourceVersion: agent.updatedAt,
    });

    const modelPlan = await renderer.render(context(seriesEvent));
    expect(modelPlan.notes[0]?.body).toContain("Target price");
    expect(modelPlan.notes[0]?.body).toContain("325 USD/share");
    expect(modelPlan.notes[0]?.body).toContain(
      "Base-case value is supported",
    );
    expect(modelPlan.notes[0]?.evidence?.[0]?.evidenceId).toBe(
      "cell:dcf-b42",
    );

    const analysisPlan = await renderer.render(context(analysisEvent));
    expect(analysisPlan.notes[0]?.body).toContain(
      "Downside is bounded by liquidity.",
    );
    expect(analysisPlan.notes[0]?.body).toContain(
      "Maintain a measured position.",
    );
  });

  it("renders the exact workflow report version and reconciles it", async () => {
    const workflow = store.workflow.getOrCreateWorkflow({
      datasetId: DATASET_ID,
    });
    const reportVersion = store.workflow.createReportVersion({
      workflowId: workflow.workflowId,
      title: "Quarterly research report",
      idempotencyKey: "report-v1",
      markdown: "## Conclusion\n\nDemand remains resilient.",
      nodeVersions: {},
      documentVersions: ["doc-version-1"],
    });

    const result = new AuthoritativeObsidianReconciler(store).reconcile(
      DATASET_ID,
    );
    const event = store.obsidian.listEvents({
      datasetId: DATASET_ID,
      entityType: "workflow-report",
    }).items[0];

    expect(result.newlyEnqueued).toBe(1);
    expect(event?.entityId).toBe(reportVersion.reportId);
    const plan = await renderer.render(context(event!));
    expect(plan.notes[0]?.title).toBe("Quarterly research report");
    expect(plan.notes[0]?.body).toContain("Demand remains resilient.");
    expect(plan.notes[0]?.body).toContain("doc-version-1");
  });

  it("rejects workflow-report node bindings that cross workflows", () => {
    const reportWorkflow = store.workflow.getOrCreateWorkflow({
      datasetId: DATASET_ID,
      workflowType: "report-workflow",
    });
    const otherWorkflow = store.workflow.getOrCreateWorkflow({
      datasetId: DATASET_ID,
      workflowType: "other-workflow",
    });
    const otherNode = store.workflow.createNode({
      workflowId: otherWorkflow.workflowId,
      idempotencyKey: "other-node",
      nodeType: "analysis",
      title: "Other workflow node",
    });
    const running = store.workflow.startNode({
      workflowId: otherWorkflow.workflowId,
      nodeId: otherNode.nodeId,
      idempotencyKey: "other-node-v1",
    });
    const completed = store.workflow.completeNode({
      workflowId: otherWorkflow.workflowId,
      nodeId: otherNode.nodeId,
      nodeVersionId: running.nodeVersionId,
      outputMarkdown: "Cross-workflow content.",
      evidenceIds: ["fact:other-workflow"],
    });
    const reportVersion = store.workflow.createReportVersion({
      workflowId: reportWorkflow.workflowId,
      title: "Scoped report",
      idempotencyKey: "scoped-report-v1",
      markdown: "The report body is scoped.",
      nodeVersions: {
        [otherNode.nodeId]: completed.nodeVersionId,
      },
    });
    const event = store.obsidian.enqueue({
      datasetId: DATASET_ID,
      entityType: "workflow-report",
      entityId: reportVersion.reportId,
      sourceVersion: "1",
    });

    expect(() => renderer.render(context(event))).toThrowError(
      /crosses its report workflow/u,
    );
  });

  it("fails unsupported entity types terminally instead of consuming them", async () => {
    const event = store.obsidian.enqueue({
      datasetId: DATASET_ID,
      entityType: "unknown-domain-object",
      entityId: "unknown-1",
      sourceVersion: "1",
    });

    expect(() => renderer.render(context(event))).toThrowError(
      expect.objectContaining({
        name: "ObsidianProjectionError",
        code: "invalid_projection",
        retryable: false,
      } satisfies Partial<ObsidianProjectionError>),
    );
  });
});
