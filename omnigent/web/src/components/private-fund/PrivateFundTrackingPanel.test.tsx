import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePrivateFundTracking } from "@/hooks/usePrivateFundProjects";
import {
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
    runPrivateFundTracking: vi.fn(),
    updatePrivateFundAlert: vi.fn(),
    updatePrivateFundWatchRule: vi.fn(),
  };
});

const overview: PrivateFundTrackingOverview = {
  datasetId: "sungrow",
  counts: { risk: 1, catalyst: 1 },
  unreadAlertCount: 1,
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
}

describe("PrivateFundTrackingPanel", () => {
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
    vi.mocked(updatePrivateFundAlert).mockResolvedValue({
      ...overview.alerts[0],
      status: "acknowledged",
    });
    vi.mocked(updatePrivateFundWatchRule).mockResolvedValue({
      ...overview.watchRules[0],
      active: false,
    });
  });

  it("shows current risks, reminders, and starts an asynchronous refresh", async () => {
    renderPanel();

    expect(screen.getByText("海外需求回落")).toBeInTheDocument();
    expect(screen.getByText("新增风险：海外需求回落")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "立即更新" }));
    await waitFor(() => expect(runPrivateFundTracking).toHaveBeenCalledWith("sungrow"));
  });

  it("acknowledges alerts and persists watch-rule switches", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "确认提醒 新增风险：海外需求回落" }));
    await waitFor(() =>
      expect(updatePrivateFundAlert).toHaveBeenCalledWith("sungrow", "alert-1", {
        status: "acknowledged",
      }),
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "启用追踪规则 所有风险变化" }));
    await waitFor(() =>
      expect(updatePrivateFundWatchRule).toHaveBeenCalledWith("sungrow", "rule-risk", {
        active: false,
      }),
    );
  });
});
