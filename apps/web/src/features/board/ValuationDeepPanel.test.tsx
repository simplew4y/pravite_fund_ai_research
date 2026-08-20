import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQuery, stubFetch } from "../../test-utils";
import { ValuationDeepPanel } from "./ValuationDeepPanel";

const info = {
  auth_mode: "development",
  accounts_enabled: false,
  registration_mode: null,
  durable_jobs: true,
  research_store: true,
  workflow_store: true,
  insights_store: true,
};

const overview = {
  series: [
    {
      id: "s-1",
      name: "DCF 主模型",
      currentVersionNo: 3,
      currentModelVersionId: "mv-3",
    },
  ],
  // The overview accepts both plain arrays and { items: [...] } pages.
  analyses: {
    items: [{ analysisId: "an-1", status: "completed", focus: "WACC 敏感性分析" }],
  },
  derivedModels: [
    {
      derivedModelId: "dm-1",
      outputFilename: "derived_model.xlsx",
      resourceStatus: "pending",
    },
  ],
  watchRules: [
    { ruleId: "r-1", name: "重大假设变动", minMateriality: "high", active: true },
  ],
  alerts: [{ alertId: "al-1", status: "new", title: "估值缺口扩大" }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ValuationDeepPanel", () => {
  it("renders all five sections from the overview", async () => {
    stubFetch({
      "GET /v1/info": info,
      "GET /v1/projects/p-1/valuation": overview,
    });
    renderWithQuery(<ValuationDeepPanel projectId="p-1" />);

    // Series
    expect(await screen.findByText("DCF 主模型")).toBeInTheDocument();
    expect(screen.getByText("v3")).toBeInTheDocument();
    // Analyses: status tag, truncated focus, derive action for completed
    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.getByText("WACC 敏感性分析")).toBeInTheDocument();
    expect(screen.getByText("生成派生模型")).toBeInTheDocument();
    // Derived models: filename, resource status, to-library action
    expect(screen.getByText("derived_model.xlsx")).toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();
    expect(screen.getByText("入库为资料")).toBeInTheDocument();
    // Watch rules: name, active tag, toggle action
    expect(screen.getByText("重大假设变动")).toBeInTheDocument();
    expect(screen.getByText("启用")).toBeInTheDocument();
    expect(screen.getByText("停用")).toBeInTheDocument();
    // Alerts: title and acknowledge action for a "new" alert
    expect(screen.getByText("估值缺口扩大")).toBeInTheDocument();
    expect(screen.getByText("确认")).toBeInTheDocument();
  });

  it("expands a series, lists versions and compares two of them", async () => {
    const calls = stubFetch({
      "GET /v1/info": info,
      "GET /v1/projects/p-1/valuation": overview,
      "GET /v1/projects/p-1/valuation/series/s-1/versions": {
        items: [
          {
            versionId: "mv-1",
            documentVersionNo: 1,
            originalFilename: "model_v1.xlsx",
            createdAt: "2026-08-01T00:00:00.000Z",
          },
          {
            versionId: "mv-2",
            documentVersionNo: 2,
            originalFilename: "model_v2.xlsx",
            createdAt: "2026-08-10T00:00:00.000Z",
          },
        ],
      },
      "GET /v1/projects/p-1/valuation/series/s-1/compare": {
        fromVersion: { versionId: "mv-1" },
        toVersion: { versionId: "mv-2" },
        changes: [
          {
            summary: "WACC 上调",
            materiality: "high",
            absoluteChange: 0.5,
            relativeChange: "4.2%",
          },
        ],
      },
    });
    renderWithQuery(<ValuationDeepPanel projectId="p-1" />);

    await userEvent.click(await screen.findByText("DCF 主模型"));
    expect(await screen.findByText("v1 · model_v1.xlsx · 2026-08-01")).toBeInTheDocument();

    const compareButtons = await screen.findAllByRole("button", { name: "对比" });
    expect(compareButtons).toHaveLength(2);
    await userEvent.click(compareButtons[0]!);
    const armedButtons = await screen.findAllByRole("button", { name: "→ 对比" });
    expect(armedButtons).toHaveLength(2);
    await userEvent.click(armedButtons[1]!);

    expect(await screen.findByText("WACC 上调")).toBeInTheDocument();
    expect(screen.getByText("0.5 / 4.2%")).toBeInTheDocument();
    expect(
      calls.filter(
        (call) =>
          call.method === "GET" &&
          call.path === "/v1/projects/p-1/valuation/series/s-1/compare",
      ),
    ).toHaveLength(1);
  });

  it("toggles a watch rule via PATCH", async () => {
    const calls = stubFetch({
      "GET /v1/info": info,
      "GET /v1/projects/p-1/valuation": overview,
      "PATCH /v1/projects/p-1/valuation/watch-rules/r-1": {
        ruleId: "r-1",
        active: false,
      },
    });
    renderWithQuery(<ValuationDeepPanel projectId="p-1" />);

    await userEvent.click(await screen.findByText("停用"));
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: "PATCH",
        path: "/v1/projects/p-1/valuation/watch-rules/r-1",
        body: { active: false },
      });
    });
  });
});
