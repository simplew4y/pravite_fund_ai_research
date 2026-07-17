import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePrivateFundValuationTracking } from "@/hooks/usePrivateFundProjects";
import {
  addPrivateFundValuationDerivedModelToResources,
  comparePrivateFundValuationModelVersions,
  derivePrivateFundValuationModel,
  fetchPrivateFundValuationDerivedModelFile,
  getPrivateFundPipelineJob,
  getPrivateFundValuationModelOverview,
  runPrivateFundValuationAgentAnalysis,
  runPrivateFundValuationTracking,
  updatePrivateFundValuationAlert,
  updatePrivateFundValuationWatchRule,
  type PrivateFundValuationTrackingOverview,
} from "@/lib/privateFundApi";
import { PrivateFundValuationTrackingPanel } from "./PrivateFundValuationTrackingPanel";

vi.mock("@/hooks/usePrivateFundProjects", () => ({
  usePrivateFundValuationTracking: vi.fn(),
}));
vi.mock("@/lib/privateFundApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privateFundApi")>();
  return {
    ...actual,
    addPrivateFundValuationDerivedModelToResources: vi.fn(),
    comparePrivateFundValuationModelVersions: vi.fn(),
    derivePrivateFundValuationModel: vi.fn(),
    fetchPrivateFundValuationDerivedModelFile: vi.fn(),
    getPrivateFundPipelineJob: vi.fn(),
    getPrivateFundValuationModelOverview: vi.fn(),
    runPrivateFundValuationAgentAnalysis: vi.fn(),
    runPrivateFundValuationTracking: vi.fn(),
    updatePrivateFundValuationAlert: vi.fn(),
    updatePrivateFundValuationWatchRule: vi.fn(),
  };
});

const overview: PrivateFundValuationTrackingOverview = {
  datasetId: "sungrow",
  analyzerVersion: "valuation-tracking-v1",
  unreadAlertCount: 1,
  changeCounts: { high: 1 },
  series: [
    {
      seriesId: "series-1",
      seriesKey: "logical:model",
      name: "阳光电源 DCF 模型",
      companyName: "阳光电源",
      companyTicker: "300274.SZ",
      modelType: "dcf",
      currentModelVersionId: "vmv-2",
      currentVersionNo: 2,
      versionCount: 2,
      status: "active",
      updatedAt: "2026-07-14T00:00:00Z",
      currentVersion: {
        modelVersionId: "vmv-2",
        documentVersionNo: 2,
        originalFilename: "阳光电源估值-v2.xlsx",
        nodeCount: 24,
        formulaNodeCount: 8,
        reviewRequiredCount: 1,
        createdAt: "2026-07-14T00:00:00Z",
        analysis: {
          analysisVersionId: "analysis-2",
          status: "completed",
          summaryMarkdown: "目标价与 WACC 出现重大变化。",
          analysis: { change_counts: { high: 1 } },
          analyzerVersion: "valuation-tracking-v1",
          createdAt: "2026-07-14T00:00:00Z",
        },
      },
      versions: [
        {
          modelVersionId: "vmv-2",
          documentVersionNo: 2,
          originalFilename: "阳光电源估值-v2.xlsx",
          nodeCount: 24,
          formulaNodeCount: 8,
          reviewRequiredCount: 1,
          createdAt: "2026-07-14T00:00:00Z",
        },
        {
          modelVersionId: "vmv-1",
          documentVersionNo: 1,
          originalFilename: "阳光电源估值-v1.xlsx",
          nodeCount: 23,
          formulaNodeCount: 7,
          reviewRequiredCount: 0,
          createdAt: "2026-07-01T00:00:00Z",
        },
      ],
    },
  ],
  alerts: [
    {
      alertId: "val-1",
      seriesId: "series-1",
      changeId: "change-1",
      alertType: "value_changed",
      priority: "high",
      title: "目标价",
      summary: "目标价：100 → 120",
      evidenceIds: ["fact:old", "fact:new"],
      status: "new",
      createdAt: "2026-07-14T00:00:00Z",
      updatedAt: "2026-07-14T00:00:00Z",
    },
  ],
  watchRules: [
    {
      ruleId: "rule-1",
      name: "自动追踪重大估值变化",
      minMateriality: "medium",
      changeTypes: [],
      active: true,
    },
  ],
  jobs: [],
  agentAnalyses: [],
  derivedModels: [],
};

const completedAgentAnalysis: PrivateFundValuationTrackingOverview["agentAnalyses"][number] = {
  analysisId: "vaa-1",
  datasetId: "sungrow",
  seriesId: "series-1",
  baseModelVersionId: "vmv-2",
  comparisonModelVersionId: "vmv-1",
  status: "completed",
  focus: "WACC 与目标价",
  valuationMethod: "DCF",
  executiveSummary: "WACC 下调推动估值上修，但目标价应继续由公式计算。",
  investmentConclusion: "建议先复核折现率，再派生新模型。",
  keyFindings: [
    {
      title: "折现率假设变化",
      detail: "WACC 从 10% 下调至 9%。",
      impact: "high",
      confidence: 0.92,
      evidenceIds: ["fact:wacc"],
    },
  ],
  evidenceChain: [
    {
      title: "WACC 下降影响 DCF",
      detail: "折现率下降会抬升现金流现值。",
      impact: "high",
      confidence: 0.9,
      evidenceIds: ["fact:wacc"],
    },
  ],
  recommendedChanges: [
    {
      nodeId: "node-wacc",
      displayName: "WACC",
      metricKey: "wacc",
      currentValueNumeric: 0.1,
      proposedValueNumeric: 0.09,
      rationale: "风险溢价假设下降。",
      confidence: 0.92,
      evidenceIds: ["fact:wacc"],
      writable: true,
      sheetName: "DCF",
      cellRef: "E5",
    },
  ],
  risks: [],
  openQuestions: [],
  selectedEvidence: [],
  planner: {},
  evidenceIds: ["fact:wacc"],
  modelName: "qwen3",
  agentVersion: "valuation-agent-v1",
  createdAt: "2026-07-14T01:00:00Z",
  updatedAt: "2026-07-14T01:01:00Z",
  completedAt: "2026-07-14T01:01:00Z",
};

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PrivateFundValuationTrackingPanel datasetId="sungrow" />
    </QueryClientProvider>,
  );
}

describe("PrivateFundValuationTrackingPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePrivateFundValuationTracking).mockReturnValue({
      data: overview,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePrivateFundValuationTracking>);
    vi.mocked(comparePrivateFundValuationModelVersions).mockResolvedValue({
      series: overview.series[0],
      fromVersion: overview.series[0].versions[1],
      toVersion: overview.series[0].versions[0],
      changes: [
        {
          canonicalKey: "output:target-price:2027",
          metricKey: "target_price",
          displayName: "目标价",
          period: "2027",
          changeType: "value_changed",
          materiality: "high",
          summary: "目标价：100 → 120",
          oldValue: { value_numeric: 100 },
          newValue: { value_numeric: 120 },
          relativeChange: 0.2,
          evidenceIds: ["fact:old", "fact:new"],
        },
      ],
    });
    vi.mocked(getPrivateFundValuationModelOverview).mockResolvedValue({
      overviewId: "overview-2",
      datasetId: "sungrow",
      seriesId: "series-1",
      modelVersionId: "vmv-2",
      docId: "doc-2",
      status: "completed",
      overviewVersion: "valuation-overview-v1",
      createdAt: "2026-07-14T00:00:00Z",
      html: "<!DOCTYPE html><html><body><h1>阳光电源估值总览</h1></body></html>",
      overview: {
        schemaVersion: 1,
        modelName: "阳光电源 DCF 模型",
        companyName: "阳光电源",
        companyTicker: "300274.SZ",
        modelVersionNo: 2,
        modelType: "dcf_model",
        originalFilename: "阳光电源估值-v2.xlsx",
        generatedAt: "2026-07-14T00:00:00Z",
        summary: {
          detectedStatements: ["income_statement", "balance_sheet", "cash_flow"],
          missingStatements: [],
          statementCount: 3,
          trendCount: 4,
          keyMetricCount: 3,
          periodStart: "2022A",
          periodEnd: "2027E",
          periods: ["2022A", "2023A", "2024E", "2025E", "2026E", "2027E"],
          factCount: 96,
          reviewRequiredCount: 2,
          qualityFlags: ["facts_require_review"],
        },
        keyMetrics: [],
        trends: [],
        statements: [],
      },
    });
    vi.mocked(runPrivateFundValuationTracking).mockResolvedValue([]);
    vi.mocked(runPrivateFundValuationAgentAnalysis).mockResolvedValue({
      ...completedAgentAnalysis,
      status: "pending",
    });
    vi.mocked(derivePrivateFundValuationModel).mockResolvedValue({
      derivedModelId: "vdm-1",
      datasetId: "sungrow",
      seriesId: "series-1",
      analysisId: "vaa-1",
      baseModelVersionId: "vmv-2",
      derivedVersionNo: 3,
      outputFilename: "阳光电源估值-agent-v3.xlsx",
      outputPath: "/tmp/阳光电源估值-agent-v3.xlsx",
      checksum: "checksum",
      appliedChanges: [{ node_id: "node-wacc" }],
      skippedChanges: [],
      resourceStatus: "not_added",
      createdAt: "2026-07-14T01:02:00Z",
    });
    vi.mocked(addPrivateFundValuationDerivedModelToResources).mockResolvedValue({
      derivedModel: {
        derivedModelId: "vdm-1",
        datasetId: "sungrow",
        seriesId: "series-1",
        analysisId: "vaa-1",
        baseModelVersionId: "vmv-2",
        derivedVersionNo: 3,
        outputFilename: "阳光电源估值-agent-v3.xlsx",
        outputPath: "/tmp/阳光电源估值-agent-v3.xlsx",
        checksum: "checksum",
        appliedChanges: [{ node_id: "node-wacc" }],
        skippedChanges: [],
        resourceFileName: "阳光电源估值-v2.xlsx",
        resourceStatus: "completed",
        resourceDocId: "doc-v3",
        createdAt: "2026-07-14T01:02:00Z",
      },
      job: null,
      status: "completed",
      fileName: "阳光电源估值-v2.xlsx",
      alreadyAdded: false,
      copied: true,
    });
    vi.mocked(getPrivateFundPipelineJob).mockResolvedValue({
      jobId: "pipeline-v3",
      datasetId: "sungrow",
      status: "completed",
    });
    vi.mocked(fetchPrivateFundValuationDerivedModelFile).mockResolvedValue(new Blob(["xlsx"]));
    vi.mocked(updatePrivateFundValuationAlert).mockResolvedValue({
      ...overview.alerts[0],
      status: "acknowledged",
    });
    vi.mocked(updatePrivateFundValuationWatchRule).mockResolvedValue({
      ...overview.watchRules[0],
      active: false,
    });
  });

  it("shows model versions, structured comparison, and current analysis", async () => {
    renderPanel();

    expect(screen.getByText("阳光电源 DCF 模型")).toBeInTheDocument();
    expect(screen.getByText("目标价与 WACC 出现重大变化。")).toBeInTheDocument();
    await waitFor(() =>
      expect(comparePrivateFundValuationModelVersions).toHaveBeenCalledWith(
        "sungrow",
        "series-1",
        "vmv-1",
        "vmv-2",
      ),
    );
    expect(await screen.findByText("20.0%")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    const modelOverviewFrame = await screen.findByTitle("阳光电源 DCF 模型 v2 总览");
    expect(modelOverviewFrame).toHaveAttribute("sandbox", "");
    expect(modelOverviewFrame.getAttribute("srcdoc")).toContain("阳光电源估值总览");
    expect(getPrivateFundValuationModelOverview).toHaveBeenCalledWith(
      "sungrow",
      "series-1",
      "vmv-2",
    );
  });

  it("scans models and persists alert and rule actions", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "扫描模型" }));
    await waitFor(() => expect(runPrivateFundValuationTracking).toHaveBeenCalledWith("sungrow"));

    fireEvent.click(screen.getByRole("button", { name: "确认估值提醒 目标价" }));
    await waitFor(() =>
      expect(updatePrivateFundValuationAlert).toHaveBeenCalledWith("sungrow", "val-1", {
        status: "acknowledged",
      }),
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "启用估值规则 自动追踪重大估值变化" }));
    await waitFor(() =>
      expect(updatePrivateFundValuationWatchRule).toHaveBeenCalledWith("sungrow", "rule-1", {
        active: false,
      }),
    );
  });

  it("starts an evidence-grounded Agent analysis for the selected versions", async () => {
    renderPanel();

    fireEvent.change(screen.getByLabelText("Agent 分析关注点"), {
      target: { value: "重点复核 WACC 与目标价" },
    });
    fireEvent.click(screen.getByRole("button", { name: "运行 Agent 分析" }));

    await waitFor(() =>
      expect(runPrivateFundValuationAgentAnalysis).toHaveBeenCalledWith("sungrow", "series-1", {
        baseModelVersionId: "vmv-2",
        comparisonModelVersionId: "vmv-1",
        focus: "重点复核 WACC 与目标价",
      }),
    );
  });

  it("shows summary, evidence chain, suggestions, and derives a new model", async () => {
    vi.mocked(usePrivateFundValuationTracking).mockReturnValue({
      data: { ...overview, agentAnalyses: [completedAgentAnalysis] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePrivateFundValuationTracking>);
    renderPanel();

    expect(screen.getByText(completedAgentAnalysis.executiveSummary)).toBeInTheDocument();
    expect(screen.getByText("WACC 下降影响 DCF")).toBeInTheDocument();
    expect(screen.getByText("可受控写入")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "生成新模型版本" }));

    await waitFor(() =>
      expect(derivePrivateFundValuationModel).toHaveBeenCalledWith("sungrow", "vaa-1"),
    );
  });

  it("adds the derived workbook to project resources with one click", async () => {
    const derivedModel = {
      derivedModelId: "vdm-1",
      datasetId: "sungrow",
      seriesId: "series-1",
      analysisId: "vaa-1",
      baseModelVersionId: "vmv-2",
      derivedVersionNo: 3,
      outputFilename: "阳光电源估值-agent-v3.xlsx",
      outputPath: "/tmp/阳光电源估值-agent-v3.xlsx",
      checksum: "checksum",
      appliedChanges: [{ node_id: "node-wacc" }],
      skippedChanges: [],
      resourceStatus: "not_added",
      createdAt: "2026-07-14T01:02:00Z",
    } as const;
    vi.mocked(usePrivateFundValuationTracking).mockReturnValue({
      data: {
        ...overview,
        agentAnalyses: [completedAgentAnalysis],
        derivedModels: [derivedModel],
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePrivateFundValuationTracking>);
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "一键加入资源" }));

    await waitFor(() =>
      expect(addPrivateFundValuationDerivedModelToResources).toHaveBeenCalledWith(
        "sungrow",
        "vdm-1",
      ),
    );
  });
});
