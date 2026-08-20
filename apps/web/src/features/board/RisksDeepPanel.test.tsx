import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQuery, stubFetch } from "../../test-utils";
import { RisksDeepPanel } from "./RisksDeepPanel";

const info = {
  auth_mode: "development",
  accounts_enabled: false,
  registration_mode: null,
  durable_jobs: true,
  research_store: true,
  workflow_store: true,
  insights_store: true,
};

const tracking = {
  items: [{ itemId: "i-1", itemType: "risk", title: "客户集中度风险" }],
  alerts: [{ alertId: "a-1", status: "new", title: "毛利率低于预警线" }],
  memoVersions: [],
  watchRules: [
    {
      ruleId: "r-1",
      name: "毛利率监控",
      targetType: "metric",
      minPriority: "medium",
      active: true,
    },
  ],
};

const baseRoutes = {
  "GET /v1/info": info,
  "GET /v1/projects/p-1/tracking": tracking,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RisksDeepPanel", () => {
  it("renders items, alerts and watch rules, and acknowledges an alert", async () => {
    const calls = stubFetch({
      ...baseRoutes,
      "PATCH /v1/projects/p-1/tracking/alerts/a-1": {},
    });
    renderWithQuery(<RisksDeepPanel projectId="p-1" />);
    expect(await screen.findByText("客户集中度风险")).toBeInTheDocument();
    expect(screen.getByText("风险")).toBeInTheDocument();
    expect(screen.getByText("毛利率低于预警线")).toBeInTheDocument();
    expect(screen.getByText("未读")).toBeInTheDocument();
    expect(screen.getByText("毛利率监控")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: "PATCH",
        path: "/v1/projects/p-1/tracking/alerts/a-1",
        body: { status: "acknowledged" },
      });
    });
  });

  it("expands an item and renders its timeline", async () => {
    stubFetch({
      ...baseRoutes,
      "GET /v1/projects/p-1/tracking/items/i-1/timeline": {
        item: { itemId: "i-1" },
        versions: [
          {
            versionId: "tv-1",
            versionNo: 1,
            content: "初始表述",
            observedAt: "2026-08-01T00:00:00.000Z",
          },
          {
            versionId: "tv-2",
            versionNo: 2,
            content: "更新表述",
            observedAt: "2026-08-10T00:00:00.000Z",
          },
        ],
        changes: [{ changeId: "c-1", summary: "口径更新", materiality: "high" }],
        observations: [],
      },
    });
    renderWithQuery(<RisksDeepPanel projectId="p-1" />);
    await userEvent.click(await screen.findByText("客户集中度风险"));
    expect(await screen.findByText("时间线")).toBeInTheDocument();
    expect(await screen.findByText("v2 · 更新表述 · 2026-08-10")).toBeInTheDocument();
    expect(screen.getByText("v1 · 初始表述 · 2026-08-01")).toBeInTheDocument();
    expect(screen.getByText("口径更新")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
  });

  it("toggles a watch rule via PATCH", async () => {
    const calls = stubFetch({
      ...baseRoutes,
      "PATCH /v1/projects/p-1/tracking/watch-rules/r-1": { ruleId: "r-1", active: false },
    });
    renderWithQuery(<RisksDeepPanel projectId="p-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "停用" }));
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: "PATCH",
        path: "/v1/projects/p-1/tracking/watch-rules/r-1",
        body: { active: false },
      });
    });
  });
});
