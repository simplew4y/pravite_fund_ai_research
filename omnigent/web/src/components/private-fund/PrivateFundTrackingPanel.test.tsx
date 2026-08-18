import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePrivateFundTracking } from "@/hooks/usePrivateFundProjects";
import {
  archivePrivateFundResearchItems,
  createPrivateFundWatchRule,
  getPrivateFundResearchItemTimeline,
  getPrivateFundResearchItemGovernance,
  rebuildPrivateFundTracking,
  runPrivateFundTracking,
  updatePrivateFundAlert,
  updatePrivateFundWatchRule,
  type PrivateFundTrackingOverview,
} from "@/lib/privateFundApi";
import { PrivateFundTrackingPanel } from "./PrivateFundTrackingPanel";

vi.mock("@/hooks/usePrivateFundProjects", () => ({ usePrivateFundTracking: vi.fn() }));
vi.mock("@/lib/privateFundApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privateFundApi")>();
  return {
    ...actual,
    getPrivateFundResearchItemTimeline: vi.fn(),
    getPrivateFundResearchItemGovernance: vi.fn(),
    rebuildPrivateFundTracking: vi.fn(),
    archivePrivateFundResearchItems: vi.fn(),
    createPrivateFundWatchRule: vi.fn(),
    runPrivateFundTracking: vi.fn(),
    updatePrivateFundAlert: vi.fn(),
    updatePrivateFundWatchRule: vi.fn(),
  };
});

const overview: PrivateFundTrackingOverview = {
  datasetId: "sungrow",
  schemaVersion: 2,
  rebuildRequired: false,
  legacyItemCount: 0,
  counts: { risk: 1, catalyst: 1 },
  unreadAlertCount: 1,
  qualityCounts: { verified: 1, needs_review: 0 },
  governanceCounts: { activeUnqualified: 1, archived: 0 },
  items: [
    {
      itemId: "risk-1",
      itemType: "risk",
      canonicalKey: "overseas-demand",
      title: "海外需求回落",
      status: "active",
      currentVersionNo: 2,
      currentVersionId: "risk-v2",
      firstSeenAt: "2026-07-01T00:00:00Z",
      lastSeenAt: "2026-07-14T00:00:00Z",
      currentVersion: {
        itemVersionId: "risk-v2",
        versionNo: 2,
        observedAt: "2026-07-14T00:00:00Z",
        sourceType: "document",
        sourceId: "doc-2",
        content: "渠道库存提高，海外需求存在回落迹象。",
        stance: "negative",
        state: "watching",
        impact: "high",
        confidence: 0.84,
        evidenceIds: ["chunk:2"],
        fieldChanges: [],
        metadata: {
          quality_status: "verified",
          event_type: "demand_decline",
          subject: "海外需求",
          trigger: "渠道库存提高",
          transmission_path: "库存提高导致订单需求回落",
        },
      },
    },
  ],
  alerts: [
    {
      alertId: "alert-1",
      itemId: "risk-1",
      alertType: "new_risk",
      priority: "high",
      title: "新增风险：海外需求回落",
      summary: "新资料首次出现该风险。",
      whyItMatters: "可能影响盈利预测。",
      evidenceIds: ["chunk:2"],
      status: "new",
      createdAt: "2026-07-14T00:00:00Z",
      updatedAt: "2026-07-14T00:00:00Z",
    },
  ],
  watchRules: [
    {
      ruleId: "rule-risk",
      name: "所有风险变化",
      targetType: "risk",
      query: {},
      minPriority: "medium",
      frequency: "on_ingest",
      active: true,
    },
  ],
  jobs: [],
  memoSeries: [],
  memoVersions: [],
};

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PrivateFundTrackingPanel datasetId="sungrow" />
    </QueryClientProvider>,
  );
  return client;
}

describe("PrivateFundTrackingPanel", () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePrivateFundTracking).mockReturnValue({
      data: overview,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePrivateFundTracking>);
    vi.mocked(runPrivateFundTracking).mockResolvedValue({
      jobId: "job-1",
      jobType: "manual_scan",
      sourceId: "manual:1",
      status: "queued",
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: "2026-07-14T00:00:00Z",
    });
    vi.mocked(rebuildPrivateFundTracking).mockResolvedValue({
      jobId: "job-rebuild",
      jobType: "legacy_rebuild",
      sourceId: "manual:rebuild",
      status: "queued",
      attemptCount: 0,
      maxAttempts: 1,
      createdAt: "2026-07-14T00:00:00Z",
    });
    vi.mocked(updatePrivateFundAlert).mockResolvedValue({
      ...overview.alerts[0],
      status: "acknowledged",
    });
    vi.mocked(updatePrivateFundWatchRule).mockResolvedValue({
      ...overview.watchRules[0],
      active: false,
    });
    vi.mocked(createPrivateFundWatchRule).mockResolvedValue(overview.watchRules[0]);
    vi.mocked(archivePrivateFundResearchItems).mockResolvedValue({ archived_count: 1 });
    vi.mocked(getPrivateFundResearchItemGovernance).mockResolvedValue([
      {
        ...overview.items[0],
        itemId: "legacy-1",
        title: "催化剂：但是",
        itemType: "catalyst",
        qualityIssue: "旧版关键词降级记录，未形成完整事件结构",
      },
    ]);
    vi.mocked(getPrivateFundResearchItemTimeline).mockResolvedValue({
      item: overview.items[0],
      versions: [
        {
          ...overview.items[0].currentVersion!,
          evidenceSources: [
            {
              evidenceId: "chunk:2",
              citation: "2026Q2交流纪要.pdf · 第 12 页",
              documentName: "2026Q2交流纪要.pdf",
              excerpt: "海外渠道库存提高，订单确认节奏可能放缓。",
              fullContent:
                "海外渠道库存提高，订单确认节奏可能放缓。完整证据还包括渠道去库存周期和收入确认节奏分析。",
              sourceUrl: "#private-fund-pdf-source?page=12",
              pageStart: 12,
              pageEnd: 12,
            },
          ],
          fieldChanges: [
            {
              field: "content",
              label: "当前判断",
              before: "海外需求稳定。",
              after: "渠道库存提高，海外需求存在回落迹象。",
              changeKind: "changed",
            },
          ],
        },
      ],
      changes: [],
      observations: [],
    });
  });

  it("shows current risks, reminders, and starts an asynchronous refresh", async () => {
    renderPanel();

    expect(screen.getByText("海外需求回落")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "提醒收件箱 1" }));
    expect(screen.getByText("新增风险：海外需求回落")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "立即更新" }));
    await waitFor(() => expect(runPrivateFundTracking).toHaveBeenCalledWith("sungrow"));
  });

  it("acknowledges alerts and persists watch-rule switches", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "提醒收件箱 1" }));
    fireEvent.click(screen.getByRole("button", { name: "确认提醒 新增风险：海外需求回落" }));
    await waitFor(() =>
      expect(updatePrivateFundAlert).toHaveBeenCalledWith("sungrow", "alert-1", {
        status: "acknowledged",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "规则" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "启用追踪规则 所有风险变化" }));
    await waitFor(() =>
      expect(updatePrivateFundWatchRule).toHaveBeenCalledWith("sungrow", "rule-risk", {
        active: false,
      }),
    );
  });

  it("uses summary cards to open and filter their corresponding lists", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "查看催化剂，共 1 项" }));
    expect(screen.getByRole("combobox", { name: "事项类型" })).toHaveValue("catalyst");
    expect(screen.getByRole("button", { name: "查看催化剂，共 1 项" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByText("海外需求回落")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看风险事项，共 1 项" }));
    expect(screen.getByRole("combobox", { name: "事项类型" })).toHaveValue("risk");
    expect(screen.getByText("海外需求回落")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看待复核，共 0 项" }));
    expect(screen.getByRole("combobox", { name: "事项类型" })).toHaveValue("all");
    expect(screen.getByRole("combobox", { name: "质量状态" })).toHaveValue("needs_review");

    fireEvent.click(screen.getByRole("button", { name: "查看未读提醒，共 1 项" }));
    expect(screen.getByText("新增风险：海外需求回落")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看未读提醒，共 1 项" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("paginates the tracking ledger and resets when page size changes", () => {
    const baseItem = overview.items[0];
    vi.mocked(usePrivateFundTracking).mockReturnValue({
      data: {
        ...overview,
        items: Array.from({ length: 25 }, (_, index) => ({
          ...baseItem,
          itemId: `risk-${index + 1}`,
          title: `Risk ${index + 1}`,
          currentVersion: baseItem.currentVersion
            ? {
                ...baseItem.currentVersion,
                itemVersionId: `risk-v${index + 1}`,
              }
            : undefined,
        })),
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePrivateFundTracking>);

    renderPanel();

    expect(screen.getByText("Risk 20")).toBeInTheDocument();
    expect(screen.queryByText("Risk 21")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByText("Risk 21")).toBeInTheDocument();
    expect(screen.getByText("显示 21–25，共 25 项")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "每页显示数量" }), {
      target: { value: "10" },
    });
    expect(screen.getByText("Risk 1")).toBeInTheDocument();
    expect(screen.getByText("显示 1–10，共 25 项")).toBeInTheDocument();
  });

  it("resolves evidence IDs into citations and source excerpts", async () => {
    renderPanel();

    fireEvent.click(screen.getByText(overview.items[0].title));

    expect(await screen.findByText("2026Q2交流纪要.pdf · 第 12 页")).toBeInTheDocument();
    expect(screen.getByText("海外渠道库存提高，订单确认节奏可能放缓。")).toBeInTheDocument();
    expect(screen.getByText("chunk:2")).toBeInTheDocument();
    expect(screen.queryByText("打开原始文件")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开完整证据" }));
    expect(
      screen.getByText(
        "海外渠道库存提高，订单确认节奏可能放缓。完整证据还包括渠道去库存周期和收入确认节奏分析。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("需求下降")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /v2/ }));
    expect(screen.getByText("海外需求稳定。")).toBeInTheDocument();
    expect(screen.getAllByText("渠道库存提高，海外需求存在回落迹象。").length).toBeGreaterThan(1);
  });

  it("opens a PDF citation inside the current page without changing the URL", async () => {
    const sourceFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          kind: "pdf",
          file_name: "2026Q2交流纪要.pdf",
          page_no: 12,
          image_url: "data:image/png;base64,AA==",
          image_width: 1,
          image_height: 1,
          highlights: [],
          matched: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", sourceFetch);
    window.history.replaceState({}, "", "/?private_fund_project=sungrow");
    renderPanel();

    fireEvent.click(screen.getByText(overview.items[0].title));
    fireEvent.click(
      await screen.findByRole("button", { name: /2026Q2交流纪要\.pdf · 第 12 页/ }),
    );

    expect(
      await screen.findByRole("img", { name: "2026Q2交流纪要.pdf 第 12 页" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("dialog").some((element) => element.classList.contains("max-w-none")),
    ).toBe(true);
    const sourceDialog = screen
      .getAllByRole("dialog")
      .find((element) => element.querySelector('[data-pdf-page-container="true"]'));
    expect(sourceDialog).toHaveClass("sm:max-w-none");
    expect(sourceDialog).toHaveClass("z-50");
    expect(sourceDialog).toHaveClass("h-[max(360px,calc(100dvh-400px))]");
    expect(sourceDialog).toHaveClass("w-[max(640px,calc(100vw-400px))]");
    const pageContainer = sourceDialog?.querySelector<HTMLElement>(
      '[data-pdf-page-container="true"]',
    );
    expect(pageContainer).toHaveStyle({ width: "100%" });
    fireEvent.click(screen.getByRole("button", { name: "放大 PDF" }));
    expect(pageContainer).toHaveStyle({ width: "125%" });
    expect(window.location.hash).toBe("");
    expect(String(sourceFetch.mock.calls[0]?.[0] ?? "")).toContain(
      "/v1/private-fund/pdf/source/page?",
    );
    expect(String(sourceFetch.mock.calls[0]?.[0] ?? "")).toContain("page_no=12");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(document.querySelector('[data-pdf-page-container="true"]')).not.toBeInTheDocument(),
    );
  });

  it("creates a complete watch rule with keyword, event type, importance and frequency", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "规则" }));
    fireEvent.click(screen.getByRole("button", { name: "新建规则" }));
    fireEvent.change(screen.getByRole("textbox", { name: "规则名称" }), {
      target: { value: "海外订单异常" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /关键词/ }), {
      target: { value: "海外订单、关税" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "订单延期" }));
    fireEvent.change(screen.getByRole("combobox", { name: "最低重要度" }), {
      target: { value: "high" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "检查频率" }), {
      target: { value: "daily" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存规则" }));
    await waitFor(() =>
      expect(createPrivateFundWatchRule).toHaveBeenCalledWith(
        "sungrow",
        expect.objectContaining({
          name: "海外订单异常",
          minPriority: "high",
          frequency: "daily",
          query: expect.objectContaining({
            keywords: ["海外订单", "关税"],
            event_types: ["order_delay"],
          }),
        }),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("规则已创建，列表已同步。");
    expect(screen.queryByRole("textbox", { name: "规则名称" })).not.toBeInTheDocument();
  });

  it("archives selected records from the low-quality governance queue", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /数据治理/ }));
    expect(await screen.findByText("旧版关键词降级记录，未形成完整事件结构")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /全选/ }));
    fireEvent.click(screen.getByRole("button", { name: "归档选中" }));
    await waitFor(() =>
      expect(archivePrivateFundResearchItems).toHaveBeenCalledWith("sungrow", ["legacy-1"]),
    );
  });

  it("shows user-friendly Chinese tracking states", () => {
    const baseItem = overview.items[0];
    vi.mocked(usePrivateFundTracking).mockReturnValue({
      data: {
        ...overview,
        items: [
          {
            ...baseItem,
            itemId: "confirmed-item",
            title: "Confirmed item",
            currentVersion: { ...baseItem.currentVersion!, state: "confirmed" },
          },
          {
            ...baseItem,
            itemId: "pending-item",
            title: "Pending item",
            currentVersion: { ...baseItem.currentVersion!, state: "pending" },
          },
        ],
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePrivateFundTracking>);

    renderPanel();

    expect(screen.getByText("已确认")).toBeInTheDocument();
    expect(screen.getByText("待验证")).toBeInTheDocument();
  });
});
