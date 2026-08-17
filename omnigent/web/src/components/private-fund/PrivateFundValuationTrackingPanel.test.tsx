import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePrivateFundValuationTracking } from "@/hooks/usePrivateFundProjects";
import {
  getPrivateFundValuationPeriodMarket,
  runPrivateFundValuationTracking,
  type PrivateFundValuationImpactCard,
  type PrivateFundValuationMetricComparison,
  type PrivateFundValuationTrackingOverview,
} from "@/lib/privateFundApi";
import { usePrivateFundWorkspaceStore } from "@/store/privateFundWorkspaceStore";
import { PrivateFundValuationTrackingPanel } from "./PrivateFundValuationTrackingPanel";

vi.mock("@/hooks/usePrivateFundProjects", () => ({
  usePrivateFundValuationTracking: vi.fn(),
}));
vi.mock("@/lib/privateFundApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privateFundApi")>();
  return {
    ...actual,
    getPrivateFundValuationPeriodMarket: vi.fn(),
    runPrivateFundValuationTracking: vi.fn(),
  };
});

const QUARTERLY_METRIC_KEYS = new Set([
  "quarter_net_profit_yoy",
  "quarter_gross_margin_qoq_delta",
  "quarter_revenue_growth_qoq",
]);

const comparisons: PrivateFundValuationMetricComparison[] = [
  {
    comparisonId: "comparison-net-profit",
    metricKey: "quarter_net_profit_yoy",
    label: "单季净利润增速",
    unit: "percent",
    description: "本季度归母净利润相对上年同季度的增速",
    modelValue: 0.5,
    actualValue: 0.38,
    absoluteGap: 0.12,
    relativeGap: 0.3158,
    severity: "warning",
    status: "compared",
    explanation: "相差 +12.0 个百分点",
    modelPeriod: "2025Q2",
    actualPeriod: "2025Q2",
    modelSource: "QoQ&Results!AF25, QoQ&Results!AD25",
    actualSource: "Eastmoney F10",
    modelQualityStatus: "derived_from_model_facts",
    evidenceIds: ["fact:net-profit"],
    createdAt: "2026-07-20T05:30:00Z",
  },
  {
    comparisonId: "comparison-margin",
    metricKey: "quarter_gross_margin_qoq_delta",
    label: "单季毛利率环比变化",
    unit: "percentage_point",
    description: "本季度毛利率减去上一季度毛利率",
    modelValue: 0.05,
    actualValue: 0.01,
    absoluteGap: 0.04,
    relativeGap: 4,
    severity: "critical",
    status: "compared",
    explanation: "相差 +4.0 个百分点",
    modelPeriod: "2025Q2",
    actualPeriod: "2025Q2",
    modelSource: "QoQ&Results!AF4",
    actualSource: "Eastmoney F10",
    modelQualityStatus: "derived_from_model_facts",
    evidenceIds: ["fact:gross-profit"],
    createdAt: "2026-07-20T05:30:00Z",
  },
  {
    comparisonId: "comparison-pe",
    metricKey: "forward_pe",
    label: "Forward PE",
    unit: "multiple",
    description: "当前价格或市值相对未来十二个月一致预期盈利的倍数",
    modelValue: 25,
    actualValue: 20,
    absoluteGap: 5,
    relativeGap: 0.25,
    severity: "warning",
    status: "compared",
    explanation: "相对偏差 +25.0%",
    modelPeriod: "2026E",
    actualPeriod: "NTM",
    modelSource: "Control panel!F13",
    actualSource: "Consensus API",
    modelQualityStatus: "candidate_complete",
    evidenceIds: ["fact:forward-pe"],
    createdAt: "2026-07-20T05:30:00Z",
  },
  {
    comparisonId: "comparison-turnover",
    metricKey: "avg_turnover_amount_20d",
    label: "近20日日均成交额",
    unit: "currency",
    description: "最近二十个完整交易日成交额的算术平均值",
    modelValue: 800_000_000,
    actualValue: 1_000_000_000,
    absoluteGap: -200_000_000,
    relativeGap: -0.2,
    severity: "warning",
    status: "compared",
    explanation: "相对偏差 -20.0%",
    modelPeriod: "20D",
    actualPeriod: "20D@20260720",
    modelSource: "Market!B5",
    actualSource: "AKShare daily",
    modelQualityStatus: "candidate_complete",
    evidenceIds: ["fact:turnover"],
    createdAt: "2026-07-20T05:30:00Z",
  },
  {
    comparisonId: "comparison-revenue",
    metricKey: "quarter_revenue_growth_qoq",
    label: "单季营收增速环比",
    unit: "percentage_point",
    description: "本季度营收同比增速减去上一季度营收同比增速",
    modelValue: 0.2,
    actualValue: 0.18,
    absoluteGap: 0.02,
    relativeGap: 0.1111,
    severity: "normal",
    status: "compared",
    explanation: "相差 +2.0 个百分点",
    modelPeriod: "2025Q2",
    actualPeriod: "2025Q2",
    modelSource: "QoQ&Results!AF2",
    actualSource: "Eastmoney F10",
    modelQualityStatus: "derived_from_model_facts",
    evidenceIds: ["fact:revenue"],
    createdAt: "2026-07-20T05:30:00Z",
  },
];

function impactCard(
  cardId: string,
  title: string,
  direction: "up" | "down" | "mixed",
): PrivateFundValuationImpactCard {
  return {
    cardId,
    direction,
    horizon: "2027年以后",
    confidence: 0.72,
    title,
    evidenceSummary: "Agent 从当前项目资料片段中提取的事实摘要。",
    valuationImpact: "若证据中的经营路径兑现，可能影响当前模型的收入与现金流假设。",
    affectedInputs: ["revenue_growth", "free_cash_flow"],
    watchItems: ["订单交付", "客户验收"],
    sourceRefs: ["阳光电源近况交流会.pdf p.18"],
    evidenceIds: [`chunk:${cardId}`],
    evidenceLocations: [],
    createdAt: "2026-07-21T06:00:00Z",
  };
}

const valuationImpactCards = [
  impactCard("impact-aidc", "AIDC 配储打开高利润增量", "up"),
  impactCard("impact-sst", "SST 商业化形成远期估值期权", "mixed"),
  impactCard("impact-margin", "储能毛利率面临阶段性下修", "down"),
  impactCard("impact-europe", "欧洲储能需求和本地化交付改善收入能见度", "up"),
  impactCard("impact-policy", "海外合规缓释经营冲击，但风险溢价仍需保留", "mixed"),
  impactCard("impact-delivery", "交付集中与标准未定压低近期现金流权重", "down"),
];

const overview: PrivateFundValuationTrackingOverview = {
  datasetId: "sungrow",
  analyzerVersion: "valuation-tracking-v1",
  unreadAlertCount: 2,
  unreadMetricAlertCount: 2,
  changeCounts: {},
  series: [
    {
      seriesId: "series-1",
      seriesKey: "logical:model",
      name: "阳光电源估值模型",
      companyName: "阳光电源",
      companyTicker: "300274.SZ",
      identityAudit: [],
      modelType: "integrated_model",
      currentModelVersionId: "vmv-2",
      currentVersionNo: 2,
      versionCount: 2,
      status: "active",
      updatedAt: "2026-07-20T05:25:00Z",
      currentVersion: {
        modelVersionId: "vmv-2",
        documentVersionNo: 2,
        originalFilename: "300274 v44.xlsx",
        nodeCount: 120,
        formulaNodeCount: 70,
        reviewRequiredCount: 1,
        createdAt: "2026-07-20T05:25:00Z",
      },
      versions: [],
      metricAnalysis: {
        marketData: {
          snapshotId: "snapshot-1",
          status: "completed",
          asOf: "2026-07-20T05:30:00Z",
          errorMessage: "",
          providerAttempts: [
            {
              provider: "akshare",
              status: "completed",
              fieldsFound: ["quarter_net_profit_yoy"],
              errorMessage: "",
              durationMs: 32,
            },
          ],
          createdAt: "2026-07-20T05:30:00Z",
          isStale: false,
          identitySnapshot: {},
        },
        marketSnapshot: {
          label: "当前市场快照",
          asOf: "2026-07-20T05:30:00Z",
          status: "partial",
          modelAvailableCount: 2,
          actualAvailableCount: 2,
          comparedCount: 1,
          periodMismatchCount: 1,
          comparisons: comparisons.filter((metric) =>
            ["forward_pe", "avg_turnover_amount_20d"].includes(metric.metricKey),
          ),
        },
        metricComparisons: comparisons,
        contextCards: [
          {
            cardId: "card-1",
            cardType: "管理层口径",
            title: "阳光电源近况交流会",
            summary: "管理层预计储能业务订单和毛利率仍有支撑。",
            insight: "用于解释经营节奏、管理层表述与模型假设。",
            sourceName: "阳光电源近况交流会.pdf",
            documentDate: "2026-07-01",
            evidenceIds: ["document:meeting"],
          },
        ],
        valuationImpacts: {
          runId: "impact-run-1",
          status: "completed",
          sourceFingerprint: "supporting-docs-v1",
          extractorVersion: "valuation-impact-skill-v2",
          skillName: "private-fund-valuation-impacts",
          analysisSummary: "基于当前项目资料生成六条估值影响路径。",
          warnings: [],
          cards: valuationImpactCards,
          errorMessage: "",
          updatedAt: "2026-07-21T06:00:00Z",
        },
      },
    },
  ],
  alerts: [],
  metricAlerts: [
    {
      alertId: "alert-margin",
      seriesId: "series-1",
      changeId: "comparison-margin",
      alertType: "model_actual_gap",
      priority: "high",
      title: "单季毛利率环比变化",
      summary: "单季毛利率环比变化：相差 +4.0 个百分点",
      evidenceIds: ["fact:gross-profit"],
      status: "new",
      createdAt: "2026-07-20T05:30:00Z",
      updatedAt: "2026-07-20T05:30:00Z",
    },
  ],
  watchRules: [],
  jobs: [],
  agentAnalyses: [],
  derivedModels: [],
};

function renderPanel(datasetId = "sungrow") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PrivateFundValuationTrackingPanel datasetId={datasetId} />
    </QueryClientProvider>,
  );
}

describe("PrivateFundValuationTrackingPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePrivateFundWorkspaceStore.setState({
      documentPreviewRequest: null,
      selectedSourceDocumentIdsByDataset: {},
    });
    vi.mocked(usePrivateFundValuationTracking).mockReturnValue({
      data: overview,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePrivateFundValuationTracking>);
    vi.mocked(getPrivateFundValuationPeriodMarket).mockResolvedValue(
      overview.series[0].metricAnalysis!.marketSnapshot!,
    );
    vi.mocked(runPrivateFundValuationTracking).mockResolvedValue([]);
  });

  it("groups three quarterly metrics separately from two non-alerting market snapshots", async () => {
    renderPanel();
    const region = screen.getByRole("region", { name: "估值模型五指标对比" });
    const quarterlyRegion = screen.getByRole("region", { name: "季度经营指标 · 3项" });
    const marketRegion = await screen.findByRole("region", { name: "当前市场快照" });

    for (const metric of comparisons.filter((item) => QUARTERLY_METRIC_KEYS.has(item.metricKey))) {
      expect(
        within(quarterlyRegion).getByRole("heading", { name: metric.label }),
      ).toBeInTheDocument();
      expect(within(marketRegion).queryByRole("heading", { name: metric.label })).toBeNull();
    }
    for (const metric of comparisons.filter((item) => !QUARTERLY_METRIC_KEYS.has(item.metricKey))) {
      expect(within(marketRegion).getByRole("heading", { name: metric.label })).toBeInTheDocument();
      expect(within(quarterlyRegion).queryByRole("heading", { name: metric.label })).toBeNull();
    }

    expect(screen.getByText("50.0%", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("38.0%", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("25x")).toBeInTheDocument();
    expect(screen.getByText("20x")).toBeInTheDocument();
    expect(screen.getByText("10.00 亿元")).toBeInTheDocument();
    expect(screen.getAllByText("真实值 · API")).toHaveLength(5);
    expect(screen.getAllByText((content) => content.startsWith("\u516C\u5F0F\uFF1A"))).toHaveLength(
      5,
    );
    expect(within(marketRegion).queryByText("关注")).toBeNull();
    expect(within(marketRegion).queryByText("预警")).toBeNull();
    expect(screen.queryByText("临时录入", { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByText("临时硬编码", { exact: false })).not.toBeInTheDocument();
    expect(within(region).queryByText("差距", { exact: true })).not.toBeInTheDocument();
    expect(screen.getAllByText("akshare", { exact: false }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("region", { name: "目标价与市场价格对比" })).toBeNull();
  });

  it("does not render the market-data error banner", () => {
    const withMarketWarning = structuredClone(overview);
    const warning = "market-data warning sentinel";
    withMarketWarning.series[0].metricAnalysis.marketData.errorMessage = warning;
    vi.mocked(usePrivateFundValuationTracking).mockReturnValue({
      data: withMarketWarning,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePrivateFundValuationTracking>);

    renderPanel();

    expect(screen.queryByText(warning)).not.toBeInTheDocument();
  });

  it("owns the vertical scroll area inside the workbench", () => {
    renderPanel();
    const region = screen.getByRole("region", { name: "估值模型五指标对比" });

    expect(region).toHaveClass("min-h-0", "flex-1", "overflow-y-auto", "overscroll-contain");
  });

  it("shows persisted Agent valuation impacts with source references", () => {
    renderPanel();
    const region = screen.getByRole("region", { name: "其他资料对估值的综合影响" });
    const expectedTitles = [
      "AIDC 配储打开高利润增量",
      "SST 商业化形成远期估值期权",
      "储能毛利率面临阶段性下修",
      "欧洲储能需求和本地化交付改善收入能见度",
      "海外合规缓释经营冲击，但风险溢价仍需保留",
      "交付集中与标准未定压低近期现金流权重",
    ];

    expect(within(region).getAllByRole("article")).toHaveLength(6);
    for (const title of expectedTitles) {
      expect(within(region).getByRole("heading", { name: title })).toBeInTheDocument();
    }
    expect(within(region).getByText("资料综合分析 · 6 张")).toBeInTheDocument();
    expect(
      within(region).getByText("private-fund-valuation-impacts", { exact: false }),
    ).toBeInTheDocument();
    expect(within(region).getAllByText("来源：阳光电源近况交流会.pdf p.18")).toHaveLength(6);
  });

  it("renders valuation impact source URLs as source buttons", () => {
    const withSourceButtons = structuredClone(overview);
    const card = withSourceButtons.series[0].metricAnalysis.valuationImpacts.cards[0];
    card.sourceRefs = [
      "五粮液 - 2026-07-09 - http://ft.10jqka.com.cn/standardgwapi/api/news_service/pubnote/download/resource?seq=1&token=secret",
    ];
    card.evidenceLocations = [
      {
        provider: "ifind_report_query",
        source_name: "五粮液",
        source_url:
          "http://ft.10jqka.com.cn/standardgwapi/api/news_service/pubnote/download/resource?seq=1&token=secret",
        canonical_url:
          "http://ft.10jqka.com.cn/standardgwapi/api/news_service/pubnote/download/resource?seq=1",
        published_at: "2026-07-09T00:00:00+00:00",
      },
      {
        provider: "google_news_rss",
        source_name: "东方财富",
        source_url: "https://news.google.com/rss/articles/eastmoney?oc=5",
        published_at: "2026-07-09T00:00:00+00:00",
      },
      {
        provider: "google_news_rss",
        source_name: "雪球",
        source_url: "https://news.google.com/rss/articles/xueqiu?oc=5",
        published_at: "2026-07-02T00:00:00+00:00",
      },
      {
        provider: "google_news_rss",
        source_name: "证券时报",
        source_url: "https://news.google.com/rss/articles/stcn?oc=5",
        published_at: "2026-06-26T00:00:00+00:00",
      },
      {
        provider: "ifind_report_query",
        source_name: "五粮液",
        source_url:
          "http://ft.10jqka.com.cn/standardgwapi/api/news_service/pubnote/download/resource?seq=1&token=duplicate",
        canonical_url:
          "http://ft.10jqka.com.cn/standardgwapi/api/news_service/pubnote/download/resource?seq=1",
        published_at: "2026-07-09T00:00:00+00:00",
      },
    ];
    vi.mocked(usePrivateFundValuationTracking).mockReturnValue({
      data: withSourceButtons,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePrivateFundValuationTracking>);

    renderPanel();

    const region = screen.getByRole("region", { name: "其他资料对估值的综合影响" });
    const article = within(region)
      .getByRole("heading", { name: "AIDC 配储打开高利润增量" })
      .closest("article");
    expect(article).not.toBeNull();
    const scoped = within(article as HTMLElement);
    const ifindLink = scoped.getByRole("link", { name: "同花顺" });
    expect(ifindLink).toHaveAttribute("target", "_blank");
    expect(ifindLink).toHaveAttribute(
      "href",
      "http://ft.10jqka.com.cn/standardgwapi/api/news_service/pubnote/download/resource?seq=1&token=secret",
    );
    expect(ifindLink).toHaveAttribute(
      "title",
      "打开原文：ft.10jqka.com.cn/standardgwapi/api/news_service/pubnote/download/resource",
    );
    expect(scoped.getByRole("link", { name: "东方财富" })).toBeInTheDocument();
    expect(scoped.getByRole("link", { name: "雪球" })).toBeInTheDocument();
    expect(scoped.queryByRole("link", { name: "证券时报" })).not.toBeInTheDocument();
    expect(scoped.getAllByText("2026-07-09")).toHaveLength(2);
    expect(scoped.queryByText(/token=secret/)).not.toBeInTheDocument();

    fireEvent.click(scoped.getByRole("button", { name: "+1" }));

    expect(scoped.getByRole("link", { name: "证券时报" })).toBeInTheDocument();
    expect(scoped.getAllByRole("link", { name: "同花顺" })).toHaveLength(1);
  });
  it("marks sentiment impact cards as industry news", () => {
    const withIndustryNews = structuredClone(overview);
    const card = withIndustryNews.series[0].metricAnalysis.valuationImpacts.cards[0];
    card.evidenceIds = ["sentiment:ifind:1"];
    card.evidenceLocations = [{ provider: "ifind_report_query" }];
    vi.mocked(usePrivateFundValuationTracking).mockReturnValue({
      data: withIndustryNews,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePrivateFundValuationTracking>);

    renderPanel();

    const region = screen.getByRole("region", { name: "其他资料对估值的综合影响" });
    const article = within(region)
      .getByRole("heading", { name: "AIDC 配储打开高利润增量" })
      .closest("article");
    expect(article).not.toBeNull();
    expect(within(article as HTMLElement).getByText("行业资讯")).toBeInTheDocument();
  });

  it("shows metric-gap alerts and auxiliary documents as non-numeric cards", () => {
    renderPanel();
    expect(screen.getByText("单季毛利率环比变化：相差 +4.0 个百分点")).toBeInTheDocument();
    expect(screen.getByText("阳光电源近况交流会")).toBeInTheDocument();
    expect(screen.getByText("不参与指标数值与预警")).toBeInTheDocument();
  });

  it("refreshes live data", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "刷新模型与真实数据" }));
    await waitFor(() =>
      expect(runPrivateFundValuationTracking).toHaveBeenCalledWith("sungrow", {
        seriesId: "series-1",
        modelVersionId: "vmv-2",
      }),
    );
  });

  it("passes currently selected source document IDs to the impact refresh", async () => {
    usePrivateFundWorkspaceStore.setState({
      selectedSourceDocumentIdsByDataset: {
        sungrow: ["doc-meeting", "doc-model"],
      },
    });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "刷新模型与真实数据" }));

    await waitFor(() =>
      expect(runPrivateFundValuationTracking).toHaveBeenCalledWith("sungrow", {
        seriesId: "series-1",
        modelVersionId: "vmv-2",
        documentIds: ["doc-meeting", "doc-model"],
      }),
    );
  });

  it("does not keep spinning while a failed source is waiting for automatic retry", () => {
    const retrying = structuredClone(overview);
    retrying.jobs = [
      {
        jobId: "market-retry",
        jobType: "market_data_refresh",
        sourceId: "market-data:vmv-2:manual",
        status: "queued",
        attemptCount: 3,
        maxAttempts: 4,
        createdAt: "2026-08-09T01:42:00Z",
        startedAt: "2026-08-09T01:45:00Z",
        lastError: "market-data refresh failed for series: series-1",
        payload: {
          series_id: "series-1",
          model_version_id: "vmv-2",
        },
      },
    ];
    vi.mocked(usePrivateFundValuationTracking).mockReturnValue({
      data: retrying,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePrivateFundValuationTracking>);

    renderPanel();

    expect(screen.getByRole("button", { name: "刷新模型与真实数据" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "刷新中" })).toBeNull();
    expect(screen.getByText("上次执行失败，等待自动重试（已尝试 3/4 次）")).toBeInTheDocument();
  });

  it("keeps the spinner for a newly queued refresh that has not started yet", () => {
    const queued = structuredClone(overview);
    queued.jobs = [
      {
        jobId: "market-new",
        jobType: "market_data_refresh",
        sourceId: "market-data:vmv-2:manual",
        status: "queued",
        attemptCount: 0,
        maxAttempts: 4,
        createdAt: "2026-08-09T01:42:00Z",
        payload: {
          series_id: "series-1",
          model_version_id: "vmv-2",
        },
      },
    ];
    vi.mocked(usePrivateFundValuationTracking).mockReturnValue({
      data: queued,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePrivateFundValuationTracking>);

    renderPanel();

    expect(screen.getByRole("button", { name: "刷新中" })).toBeDisabled();
  });

  it("does not label a completed zero-result extraction as pending", () => {
    const completedWithoutValues = structuredClone(overview);
    completedWithoutValues.series[0].metricAnalysis.metricComparisons.forEach((metric) => {
      metric.modelValue = null;
    });
    completedWithoutValues.jobs = [
      {
        jobId: "model-completed-empty",
        jobType: "model_metric_refresh",
        sourceId: "model-metrics:vmv-2:manual",
        status: "completed",
        attemptCount: 1,
        maxAttempts: 2,
        createdAt: "2026-08-09T01:42:00Z",
        startedAt: "2026-08-09T01:42:01Z",
        finishedAt: "2026-08-09T01:42:03Z",
        payload: {
          series_id: "series-1",
          model_version_id: "vmv-2",
        },
      },
    ];
    vi.mocked(usePrivateFundValuationTracking).mockReturnValue({
      data: completedWithoutValues,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePrivateFundValuationTracking>);

    renderPanel();

    const stage = screen.getByText("抽取五指标").parentElement!;
    expect(within(stage).getByText("部分完成")).toBeInTheDocument();
    expect(within(stage).queryByText("待处理")).toBeNull();
    expect(within(stage).getByText("抽取已完成，未识别到可用模型指标（0/5）")).toBeInTheDocument();
  });

  it("shows an unavailable Forward PE value without a market-warning badge", async () => {
    const unavailable = structuredClone(overview);
    unavailable.series[0].companyTicker = "NVDA";
    const forward = unavailable.series[0].metricAnalysis.metricComparisons.find(
      (metric) => metric.metricKey === "forward_pe",
    )!;
    forward.actualValue = null;
    forward.status = "incomplete";
    forward.severity = "unavailable";
    forward.explanation = "真实值暂不可用，未触发预警。";
    vi.mocked(usePrivateFundValuationTracking).mockReturnValue({
      data: unavailable,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePrivateFundValuationTracking>);
    vi.mocked(getPrivateFundValuationPeriodMarket).mockResolvedValue(
      unavailable.series[0].metricAnalysis!.marketSnapshot!,
    );

    renderPanel("other-company");
    const forwardRow = (await screen.findByRole("heading", { name: "Forward PE" })).closest(
      "article",
    )!;
    expect(within(forwardRow).getByText("暂无")).toBeInTheDocument();
    expect(within(forwardRow).queryByText("待补充")).toBeNull();
    expect(within(forwardRow).queryByText("关注")).toBeNull();
    expect(within(forwardRow).queryByText("预警")).toBeNull();
    expect(screen.getByRole("region", { name: "其他资料对估值的综合影响" })).toBeInTheDocument();
  });

  it("labels source-verified manual model values", async () => {
    const manuallyVerified = structuredClone(overview);
    const forward = manuallyVerified.series[0].metricAnalysis.metricComparisons.find(
      (metric) => metric.metricKey === "forward_pe",
    )!;
    forward.modelQualityStatus = "manual_verified";
    vi.mocked(usePrivateFundValuationTracking).mockReturnValue({
      data: manuallyVerified,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePrivateFundValuationTracking>);
    vi.mocked(getPrivateFundValuationPeriodMarket).mockResolvedValue(
      manuallyVerified.series[0].metricAnalysis!.marketSnapshot!,
    );

    renderPanel();
    const forwardRow = (await screen.findByRole("heading", { name: "Forward PE" })).closest(
      "article",
    )!;
    expect(within(forwardRow).getByText("2026E · 人工核验")).toBeInTheDocument();
    fireEvent.click(within(forwardRow).getByText("查看口径与来源"));
    expect(within(forwardRow).getByText("模型（人工核验）：")).toBeInTheDocument();
  });

  it("switches model and API values together when a timeline period is selected", () => {
    const withTimeline = structuredClone(overview);
    const historical = structuredClone(comparisons);
    historical.forEach((metric) => {
      metric.modelPeriod = "2024Q2";
      metric.actualPeriod = "2024Q2";
    });
    historical[0].modelValue = 0.2;
    historical[0].actualValue = 0.1;
    const latest = structuredClone(comparisons);
    latest.forEach((metric) => {
      metric.modelValue = null;
      metric.modelPeriod = "";
      metric.actualPeriod = "2026Q1";
      metric.status = "incomplete";
      metric.severity = "unavailable";
    });
    latest[0].actualValue = 0.7;
    withTimeline.series[0].metricAnalysis.metricTimeline = {
      defaultPeriod: "2024Q2",
      latestPeriod: "2026Q1",
      periods: [
        {
          period: "2024Q2",
          label: "2024 Q2",
          status: "comparable",
          modelAvailableCount: 3,
          actualAvailableCount: 3,
          comparedCount: 3,
          alertCount: 2,
          observedAt: "2024-08-24",
          comparisons: historical,
        },
        {
          period: "2026Q1",
          label: "2026 Q1",
          status: "actual_only",
          modelAvailableCount: 0,
          actualAvailableCount: 3,
          comparedCount: 0,
          alertCount: 0,
          observedAt: "2026-04-24",
          comparisons: latest,
        },
      ],
    };
    vi.mocked(usePrivateFundValuationTracking).mockReturnValue({
      data: withTimeline,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePrivateFundValuationTracking>);

    renderPanel();
    expect(screen.getByRole("region", { name: "历史估值时间轴" })).toBeInTheDocument();
    let netProfitRow = screen.getByRole("heading", { name: "单季净利润增速" }).closest("article")!;
    expect(within(netProfitRow).getByText("+20.0%")).toBeInTheDocument();
    expect(within(netProfitRow).getByText("+10.0%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /2026.*Q1.*仅 API/ }));

    netProfitRow = screen.getByRole("heading", { name: "单季净利润增速" }).closest("article")!;
    expect(within(netProfitRow).getByText("+70.0%")).toBeInTheDocument();
    expect(screen.getByText("季度 API 3/3")).toBeInTheDocument();
  });

  it("prioritizes the latest comparable period and folds distant periods on both sides", async () => {
    const withTimeline = structuredClone(overview);
    const periodNames = [
      "2022Q4",
      "2023Q1",
      "2023Q2",
      "2023Q3",
      "2023Q4",
      "2024Q1",
      "2024Q2",
      "2024Q3",
      "2024Q4",
    ];
    withTimeline.series[0].metricAnalysis.metricTimeline = {
      defaultPeriod: "2024Q4",
      latestPeriod: "2024Q4",
      periods: periodNames.map((period, index) => {
        const comparable = index <= 5;
        const periodComparisons = structuredClone(comparisons);
        periodComparisons.forEach((metric) => {
          metric.modelValue = comparable ? metric.modelValue : null;
          metric.modelPeriod = comparable ? period : "";
          metric.actualPeriod = period;
          metric.status = comparable ? "compared" : "incomplete";
          metric.severity = comparable ? metric.severity : "unavailable";
        });
        return {
          period,
          label: period.replace("Q", " Q"),
          status: comparable ? ("comparable" as const) : ("actual_only" as const),
          modelAvailableCount: comparable ? 5 : 0,
          actualAvailableCount: 5,
          comparedCount: comparable ? 5 : 0,
          alertCount: comparable ? 2 : 0,
          observedAt: `${period.slice(0, 4)}-04-30`,
          comparisons: periodComparisons,
        };
      }),
    };
    vi.mocked(usePrivateFundValuationTracking).mockReturnValue({
      data: withTimeline,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePrivateFundValuationTracking>);

    renderPanel();

    const preferred = screen.getByRole("tab", {
      name: "2024 Q1 最新可比 模型 + API",
    });
    expect(preferred).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: /2022 Q4/ })).toBeNull();
    expect(screen.queryByRole("tab", { name: /2024 Q4/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开 3 个更早期间" }));
    expect(screen.getByRole("tab", { name: /2022 Q4/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起 3 个更早期间" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "展开 1 个较新期间" }));
    const latest = screen.getByRole("tab", { name: /2024 Q4/ });
    fireEvent.click(latest);
    expect(latest).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("button", { name: "收起 1 个较新期间" }));
    await waitFor(() => expect(screen.queryByRole("tab", { name: /2024 Q4/ })).toBeNull());
    expect(preferred).toHaveAttribute("aria-selected", "true");
  });
});
