import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQuery, stubFetch } from "../../test-utils";
import { WorkflowPanel } from "./WorkflowPanel";

function info(workflowStore: boolean) {
  return {
    auth_mode: "development",
    accounts_enabled: false,
    registration_mode: null,
    durable_jobs: true,
    research_store: true,
    workflow_store: workflowStore,
    insights_store: true,
  };
}

const NODE_ROWS: [title: string, status: string][] = [
  ["信源审阅", "completed"],
  ["深度分析", "completed"],
  ["假设台账", "completed"],
  ["情景 A", "running"],
  ["情景 B", "ready"],
  ["情景 C", "pending"],
  ["估值建模", "pending"],
  ["研究结论", "stale"],
  ["报告汇编", "failed"],
];

const snapshot = {
  workflow: { workflowId: "wf-1", status: "running", currentNodeId: "n-4" },
  nodes: NODE_ROWS.map(([title, status], index) => ({
    nodeId: `n-${index + 1}`,
    nodeType: "generic",
    title,
    objective: "",
    summary: "",
    status,
    currentVersionNo: 0,
    positionNo: (index + 1) * 10,
    x: index * 180,
    y: 100 + (index % 2) * 360,
    tone: "",
    kind: "",
  })),
  dependencies: [],
  context: { nodeIds: [] },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WorkflowPanel", () => {
  it("shows the unavailable notice without fetching when the store is off", async () => {
    const calls = stubFetch({ "GET /v1/info": info(false) });
    renderWithQuery(<WorkflowPanel projectId="p-1" onOpen={() => {}} />);

    expect(await screen.findByText("工作流服务未启用")).toBeInTheDocument();
    expect(
      calls.filter((call) => call.path === "/v1/projects/p-1/workflow"),
    ).toHaveLength(0);
  });

  it("renders all nine nodes with progress, status tags and current marker", async () => {
    stubFetch({
      "GET /v1/info": info(true),
      "GET /v1/projects/p-1/workflow": snapshot,
    });
    renderWithQuery(<WorkflowPanel projectId="p-1" onOpen={() => {}} />);

    expect(await screen.findByText("3/9")).toBeInTheDocument();
    for (const [title] of NODE_ROWS) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    expect(screen.getAllByText("已完成")).toHaveLength(3);
    expect(screen.getByText("进行中")).toBeInTheDocument();
    expect(screen.getByText("可开始")).toBeInTheDocument();
    expect(screen.getByText("需更新")).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();
    // Only the workflow's currentNodeId row carries the CURRENT marker.
    expect(screen.getAllByText("当前节点")).toHaveLength(1);
    const currentRow = screen.getByText("情景 A").closest(".doc-row");
    expect(currentRow).not.toBeNull();
    expect(currentRow!.textContent).toContain("当前节点");
  });

  it("invokes onOpen when the open button is clicked", async () => {
    stubFetch({
      "GET /v1/info": info(true),
      "GET /v1/projects/p-1/workflow": snapshot,
    });
    const onOpen = vi.fn();
    renderWithQuery(<WorkflowPanel projectId="p-1" onOpen={onOpen} />);

    await userEvent.click(
      await screen.findByRole("button", { name: "打开工作流" }),
    );
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
