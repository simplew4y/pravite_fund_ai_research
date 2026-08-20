import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQuery, stubFetch } from "../../test-utils";
import { WorkflowGraph } from "./WorkflowGraph";

const snapshot = {
  workflow: { workflowId: "wf-1", status: "active", currentNodeId: "n-1" },
  nodes: [
    {
      nodeId: "n-1",
      nodeType: "source_review",
      title: "资料梳理",
      objective: "梳理项目资料",
      summary: "资料已完成梳理",
      status: "completed",
      currentVersionNo: 2,
      positionNo: 10,
      x: 0,
      y: 100,
      tone: "",
      kind: "",
    },
    {
      nodeId: "n-2",
      nodeType: "analysis",
      title: "业务分析",
      objective: "分析业务与盈利能力",
      summary: "",
      status: "running",
      currentVersionNo: 1,
      positionNo: 20,
      x: 180,
      y: 220,
      tone: "",
      kind: "",
    },
    {
      nodeId: "n-3",
      nodeType: "assumptions",
      title: "关键假设",
      objective: "建立关键假设",
      summary: "",
      status: "ready",
      currentVersionNo: 0,
      positionNo: 30,
      x: 360,
      y: 340,
      tone: "",
      kind: "",
    },
    {
      nodeId: "n-4",
      nodeType: "valuation",
      title: "估值汇总",
      objective: "",
      summary: "",
      status: "pending",
      currentVersionNo: 0,
      positionNo: 40,
      x: 540,
      y: 460,
      tone: "",
      kind: "",
    },
  ],
  dependencies: [{ nodeId: "n-2", dependsOnNodeId: "n-1" }],
  context: { nodeIds: ["n-1"] },
};

function routes() {
  return {
    "GET /v1/projects/p-1/workflow": snapshot,
    "GET /v1/projects/p-1/workflow/reports": { items: [] },
    "GET /v1/projects/p-1/workflow/nodes/n-2/versions": {
      items: [
        {
          versionId: "v-1",
          versionNo: 1,
          status: "draft",
          createdAt: "2026-08-10T00:00:00.000Z",
          outputMarkdown: "初稿结论",
        },
      ],
    },
    "GET /v1/projects/p-1/workflow/nodes/n-2/assumptions": {
      items: [{ assumptionId: "as-1", content: "毛利率维持 40%" }],
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WorkflowGraph", () => {
  it("renders node cards with dependency lines and opens the node detail", async () => {
    stubFetch(routes());
    const { container } = renderWithQuery(
      <WorkflowGraph projectId="p-1" onClose={() => {}} />,
    );

    expect(await screen.findByText("资料梳理")).toBeInTheDocument();
    expect(screen.getByText("估值汇总")).toBeInTheDocument();

    const line = container.querySelector("svg line");
    expect(line).not.toBeNull();
    // Source n-1 sits at x=0/y=100: exit anchor is x+110, y-100+18.
    expect(line?.getAttribute("x1")).toBe("110");
    expect(line?.getAttribute("y1")).toBe("18");

    await userEvent.click(screen.getByText("业务分析"));
    expect(await screen.findByText("分析业务与盈利能力")).toBeInTheDocument();
    expect(screen.getByText("目标")).toBeInTheDocument();
    // Versions and assumptions load for the selected node.
    expect(await screen.findByText("v1 · draft · 2026-08-10")).toBeInTheDocument();
    expect(await screen.findByText("毛利率维持 40%")).toBeInTheDocument();
    expect(screen.getByText("初稿结论")).toBeInTheDocument();
  });

  it("completes a running node with the typed markdown", async () => {
    const calls = stubFetch({
      ...routes(),
      "POST /v1/projects/p-1/workflow/nodes/n-2/complete": { workflow: snapshot },
    });
    renderWithQuery(<WorkflowGraph projectId="p-1" onClose={() => {}} />);

    await userEvent.click(await screen.findByText("业务分析"));
    const textarea = await screen.findByPlaceholderText(
      "粘贴或撰写该节点的研究结论（Markdown，可引用 [evidenceId]）",
    );
    const completeButton = screen.getByRole("button", { name: "完成节点" });
    expect(completeButton).toBeDisabled();

    await userEvent.type(textarea, "盈利能力稳健，维持增持结论");
    await userEvent.click(completeButton);

    await waitFor(() => {
      expect(calls).toContainEqual({
        method: "POST",
        path: "/v1/projects/p-1/workflow/nodes/n-2/complete",
        body: { outputMarkdown: "盈利能力稳健，维持增持结论" },
      });
    });
  });

  it("adds the selected node to the workflow context", async () => {
    const calls = stubFetch({
      ...routes(),
      "POST /v1/projects/p-1/workflow/context": snapshot,
    });
    renderWithQuery(<WorkflowGraph projectId="p-1" onClose={() => {}} />);

    // n-2 is not in the context yet, so the toggle offers "to context".
    await userEvent.click(await screen.findByText("业务分析"));
    await userEvent.click(screen.getByRole("button", { name: "加入上下文" }));

    await waitFor(() => {
      expect(calls).toContainEqual({
        method: "POST",
        path: "/v1/projects/p-1/workflow/context",
        body: { nodeIds: ["n-1", "n-2"] },
      });
    });
  });
});
