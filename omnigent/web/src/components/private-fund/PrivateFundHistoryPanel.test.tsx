import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePrivateFundTracking } from "@/hooks/usePrivateFundProjects";
import {
  comparePrivateFundMemoVersions,
  getPrivateFundResearchItemTimeline,
  type PrivateFundMemoVersion,
  type PrivateFundTrackingOverview,
} from "@/lib/privateFundApi";
import { PrivateFundHistoryPanel } from "./PrivateFundHistoryPanel";

vi.mock("@/hooks/usePrivateFundProjects", () => ({ usePrivateFundTracking: vi.fn() }));
vi.mock("@/lib/privateFundApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privateFundApi")>();
  return {
    ...actual,
    comparePrivateFundMemoVersions: vi.fn(),
    getPrivateFundResearchItemTimeline: vi.fn(),
  };
});

const memoVersion = (versionNo: number): PrivateFundMemoVersion => ({
  memoVersionId: `memo-v${versionNo}`,
  seriesId: "series-1",
  versionNo,
  asOfDate: `2026-07-${String(versionNo).padStart(2, "0")}`,
  status: "completed",
  topic: "投资逻辑",
  seriesTitle: "投资逻辑 Memo",
  createdAt: `2026-07-${String(versionNo).padStart(2, "0")}T00:00:00Z`,
  sections: [],
});

const overview: PrivateFundTrackingOverview = {
  datasetId: "sungrow",
  counts: { thesis: 1, assumption: 1 },
  unreadAlertCount: 0,
  items: [
    {
      itemId: "assumption-1",
      itemType: "assumption",
      canonicalKey: "revenue/base/2026",
      title: "2026 收入增速",
      status: "active",
      currentVersionNo: 2,
      currentVersionId: "assumption-v2",
      firstSeenAt: "2026-07-01T00:00:00Z",
      lastSeenAt: "2026-07-14T00:00:00Z",
    },
  ],
  alerts: [],
  watchRules: [],
  jobs: [],
  memoSeries: [
    {
      seriesId: "series-1",
      topic: "投资逻辑",
      title: "投资逻辑 Memo",
      currentVersionNo: 2,
      versionCount: 2,
      currentMemoVersionId: "memo-v2",
      updatedAt: "2026-07-14T00:00:00Z",
    },
  ],
  memoVersions: [memoVersion(2), memoVersion(1)],
};

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PrivateFundHistoryPanel datasetId="sungrow" />
    </QueryClientProvider>,
  );
}

describe("PrivateFundHistoryPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePrivateFundTracking).mockReturnValue({
      data: overview,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePrivateFundTracking>);
    vi.mocked(comparePrivateFundMemoVersions).mockResolvedValue({
      fromVersion: memoVersion(1),
      toVersion: memoVersion(2),
      sectionChanges: [
        {
          sectionKey: "thesis",
          title: "投资逻辑",
          changeType: "changed",
          similarity: 0.62,
          oldContent: "海外收入保持高增长。",
          newContent: "海外增长放缓，储能业务补位。",
          oldEvidenceIds: ["chunk:1"],
          newEvidenceIds: ["chunk:2"],
        },
        {
          sectionKey: "valuation",
          title: "估值",
          changeType: "not_mentioned",
          similarity: 0,
          oldContent: "目标估值 20 倍。",
          newContent: "",
          oldEvidenceIds: ["chunk:3"],
          newEvidenceIds: [],
        },
      ],
      itemChanges: [],
    });
    vi.mocked(getPrivateFundResearchItemTimeline).mockResolvedValue({
      item: overview.items[0],
      versions: [
        {
          itemVersionId: "assumption-v1",
          versionNo: 1,
          observedAt: "2026-07-01T00:00:00Z",
          sourceType: "memo",
          sourceId: "memo-v1",
          content: "2026 年收入增速假设为 25%。",
          stance: "base",
          state: "active",
          valueText: "25",
          unit: "%",
          impact: "high",
          confidence: 0.82,
          evidenceIds: ["chunk:1"],
        },
        {
          itemVersionId: "assumption-v2",
          versionNo: 2,
          observedAt: "2026-07-14T00:00:00Z",
          sourceType: "memo",
          sourceId: "memo-v2",
          content: "2026 年收入增速假设下调至 20%。",
          stance: "base",
          state: "revised",
          valueText: "20",
          unit: "%",
          impact: "high",
          confidence: 0.87,
          evidenceIds: ["chunk:2"],
        },
      ],
      changes: [],
      observations: [],
    });
  });

  it("compares Memo sections and shows assumption version history", async () => {
    renderPanel();

    await waitFor(() =>
      expect(comparePrivateFundMemoVersions).toHaveBeenCalledWith("sungrow", "memo-v1", "memo-v2"),
    );
    expect(await screen.findByText("海外增长放缓，储能业务补位。")).toBeInTheDocument();
    expect(screen.getByText("新版未提及")).toBeInTheDocument();
    expect(await screen.findByText("2026 年收入增速假设下调至 20%。")).toBeInTheDocument();
    expect(screen.getByText("2026 年收入增速假设为 25%。")).toBeInTheDocument();
  });
});
