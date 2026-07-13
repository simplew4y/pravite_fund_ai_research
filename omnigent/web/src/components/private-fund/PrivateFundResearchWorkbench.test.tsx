import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePrivateFundAssets, usePrivateFundWorkflow } from "@/hooks/usePrivateFundProjects";
import {
  PRIVATE_FUND_CONTEXT_START,
  type PrivateFundAssetCatalog,
  type PrivateFundResearchWorkflow,
  savePrivateFundAsset,
  setPrivateFundAssetContext,
} from "@/lib/privateFundApi";
import {
  PrivateFundResearchWorkbench,
  usePrivateFundWorkbenchActions,
} from "./PrivateFundResearchWorkbench";

vi.mock("@/hooks/usePrivateFundProjects", () => ({
  usePrivateFundWorkflow: vi.fn(),
  usePrivateFundAssets: vi.fn(),
}));
vi.mock("@/lib/privateFundApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privateFundApi")>();
  return {
    ...actual,
    savePrivateFundAsset: vi.fn(),
    setPrivateFundAssetContext: vi.fn(),
  };
});
vi.mock("./ResearchGraphCanvas", () => ({
  ResearchGraphCanvas: (props: import("./ResearchGraphCanvas").ResearchGraphCanvasProps) => (
    <section data-testid="graph-canvas">
      {props.workflowNodes.map((node) => (
        <div key={node.id}>
          <button
            type="button"
            data-testid={`graph-node-${node.id}`}
            onClick={() => props.onSelectNode?.(node.id)}
          >
            {node.data.title}
          </button>
          <input
            type="checkbox"
            aria-label={`将${node.data.title}加入上下文`}
            checked={props.contextNodeIds?.includes(node.id) ?? false}
            disabled={props.contextPending}
            onChange={() => props.onToggleContextNode?.(node.id)}
          />
        </div>
      ))}
    </section>
  ),
}));
vi.mock("@/shell/PdfSourcePanel", () => ({
  PdfSourcePanel: ({ selection }: { selection: { workbookName?: string; datasetId?: string } }) => (
    <div data-testid="structured-document-preview">
      {selection.workbookName} · {selection.datasetId}
    </div>
  ),
}));

const workflow: PrivateFundResearchWorkflow = {
  workflowId: "wf-agentic",
  datasetId: "阳光电源",
  workflowType: "agentic_research_graph_v2",
  status: "active",
  currentNodeId: "node-overseas",
  contextNodeIds: [],
  createdAt: "2026-07-12T00:00:00Z",
  updatedAt: "2026-07-12T00:00:00Z",
  nodes: [
    {
      nodeId: "node-overseas",
      nodeType: "insight",
      title: "海外盈利质量改善",
      objective: "海外收入增长同时伴随现金流改善",
      summary: "海外收入增长同时伴随现金流改善",
      status: "completed",
      currentVersionNo: 1,
      positionNo: 10,
      x: 0,
      y: 100,
      tone: "mist",
      kind: "analysis",
      assumptionCount: 0,
      latestOutput: "结论、证据、不确定性和下一步问题",
      contentBlocks: [],
    },
  ],
  edges: [],
};

const assetCatalog: PrivateFundAssetCatalog = {
  contextAssetIds: [],
  assets: [
    {
      assetId: "node:node-overseas",
      assetType: "analysis",
      title: "海外盈利质量改善",
      summary: "海外收入增长同时伴随现金流改善",
      contentMarkdown: "结论、证据、不确定性和下一步问题",
      format: "markdown",
      status: "completed",
      sourceKind: "research_node",
      sourceId: "node-overseas",
      tags: [],
      createdAt: "2026-07-12T00:00:00Z",
      updatedAt: "2026-07-12T00:00:00Z",
      versionNo: 1,
      evidenceCount: 0,
      metadata: {},
    },
  ],
};

function ActionFixture() {
  const actions = usePrivateFundWorkbenchActions();
  return (
    <button
      type="button"
      onClick={() => actions?.markUsefulInformation("response-1", "海外收入和现金流同步改善")}
    >
      勾选回答
    </button>
  );
}

function renderWorkbench(onGenerateNode = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PrivateFundResearchWorkbench
        conversationId="conv-test"
        datasetId="阳光电源"
        datasetName="阳光电源"
        chat={
          <>
            <textarea aria-label="真实 AI 对话" defaultValue="保留的草稿" />
            <ActionFixture />
          </>
        }
        onGenerateNode={onGenerateNode}
      />
    </QueryClientProvider>,
  );
  return onGenerateNode;
}

describe("PrivateFundResearchWorkbench", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePrivateFundWorkflow).mockReturnValue({
      data: workflow,
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof usePrivateFundWorkflow>);
    vi.mocked(usePrivateFundAssets).mockReturnValue({
      data: assetCatalog,
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof usePrivateFundAssets>);
    vi.mocked(savePrivateFundAsset).mockResolvedValue(assetCatalog);
    vi.mocked(setPrivateFundAssetContext).mockResolvedValue({
      ...assetCatalog,
      contextAssetIds: ["node:node-overseas"],
    });
  });

  it("keeps the real chat mounted while inspecting an agent-created node", async () => {
    renderWorkbench();
    const chat = screen.getByLabelText("真实 AI 对话") as HTMLTextAreaElement;
    fireEvent.click(screen.getByText("海外盈利质量改善"));
    expect(
      await screen.findByText("结论、证据、不确定性和下一步问题", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("真实 AI 对话")).toBe(chat);
    expect(chat).toHaveValue("保留的草稿");
  });

  it("sends selected LLM information to the agent instead of creating a preset node", async () => {
    const onGenerateNode = renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "勾选回答" }));
    fireEvent.click(screen.getByRole("button", { name: /Agent 生成资产/ }));

    await waitFor(() =>
      expect(savePrivateFundAsset).toHaveBeenCalledWith(
        "阳光电源",
        expect.objectContaining({
          assetType: "information",
          contentMarkdown: "海外收入和现金流同步改善",
          sourceResponseId: "response-1",
        }),
      ),
    );
    expect(onGenerateNode).toHaveBeenCalledOnce();
    const prompt = vi.mocked(onGenerateNode).mock.calls[0][0];
    expect(prompt).toContain("海外收入和现金流同步改善");
    expect(prompt).toContain("private_fund_research_node_save");
    expect(prompt).toContain("不要套用预设研究流程");
    expect(prompt).toContain("content_blocks");
    expect(prompt).toContain("本次节点输出形式: 普通文本");
    expect(prompt).toContain("普通文本模式下不得保存 content_blocks");
  });

  it("sends the selected node output mode and chart instructions to one node request", () => {
    const onGenerateNode = renderWorkbench();
    expect(screen.getByRole("combobox", { name: "生成结果" })).toHaveValue("plain_text");
    fireEvent.change(screen.getByRole("combobox", { name: "生成结果" }), {
      target: { value: "line_chart" },
    });
    fireEvent.click(screen.getByRole("button", { name: "设置资产补充要求" }));
    fireEvent.change(screen.getByLabelText("生成具体要求"), {
      target: { value: "按季度绘制海外与国内毛利率两条线，单位为%。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "勾选回答" }));
    fireEvent.click(screen.getByRole("button", { name: /Agent 生成资产/ }));

    const prompt = vi.mocked(onGenerateNode).mock.calls[0][0];
    expect(prompt).toContain("本次节点输出形式: 折线趋势");
    expect(prompt).toContain("chart_type=line");
    expect(prompt).toContain("ASCII 字符画");
    expect(prompt).toContain('"x_key":"year"');
    expect(prompt).toContain("Agent 只提供结构化数据，不生成或执行 JavaScript");
    expect(prompt).toContain("按季度绘制海外与国内毛利率两条线，单位为%");
    expect(screen.getByRole("combobox", { name: "生成结果" })).toHaveValue("plain_text");
  });

  it("lets the agent choose a rich format when requested", () => {
    const onGenerateNode = renderWorkbench();
    fireEvent.change(screen.getByRole("combobox", { name: "生成结果" }), {
      target: { value: "agent" },
    });
    fireEvent.click(screen.getByRole("button", { name: "勾选回答" }));
    fireEvent.click(screen.getByRole("button", { name: /Agent 生成资产/ }));

    const prompt = vi.mocked(onGenerateNode).mock.calls[0][0];
    expect(prompt).toContain("本次节点输出形式: Agent 自主判断");
    expect(prompt).toContain("呈现方式由你根据内容自主判断");
  });

  it("explicitly invokes the memo skill with dialog instructions", () => {
    const onGenerateNode = renderWorkbench();
    fireEvent.change(screen.getByRole("combobox", { name: "生成结果" }), {
      target: { value: "memo" },
    });
    expect(screen.getByRole("button", { name: "生成 Memo" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "设置资产补充要求" }));
    expect(screen.getByText("/private-fund-memo")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("生成具体要求"), {
      target: { value: "聚焦海外盈利质量，分析增长持续性和主要风险。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成 Memo" }));

    expect(onGenerateNode).toHaveBeenCalledOnce();
    const prompt = vi.mocked(onGenerateNode).mock.calls[0][0];
    const visiblePrompt = prompt.slice(0, prompt.indexOf(PRIVATE_FUND_CONTEXT_START)).trim();
    expect(visiblePrompt).toBe("/private-fund-memo 聚焦海外盈利质量，分析增长持续性和主要风险。");
    expect(visiblePrompt).not.toContain("dataset_id");
    expect(visiblePrompt).not.toContain("用户勾选的资产上下文");
    expect(prompt).toContain("private_fund_dataset_memo");
    expect(prompt).toContain("dataset_id: 阳光电源");
  });

  it("explicitly invokes the FinRobot-aligned report skill", () => {
    const onGenerateNode = renderWorkbench();
    fireEvent.change(screen.getByRole("combobox", { name: "生成结果" }), {
      target: { value: "report" },
    });
    fireEvent.click(screen.getByRole("button", { name: "设置资产补充要求" }));
    fireEvent.change(screen.getByLabelText("生成具体要求"), {
      target: { value: "形成完整专业研报，覆盖估值与风险。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成专业研报" }));

    const prompt = vi.mocked(onGenerateNode).mock.calls[0][0];
    const visiblePrompt = prompt.slice(0, prompt.indexOf(PRIVATE_FUND_CONTEXT_START)).trim();
    expect(visiblePrompt).toBe("/private-fund-report 形成完整专业研报，覆盖估值与风险。");
    expect(prompt).toContain("private_fund_equity_report_generate");
  });

  it("renders agent-selected metrics, tables, and charts as rich node content", async () => {
    vi.mocked(usePrivateFundWorkflow).mockReturnValue({
      data: {
        ...workflow,
        nodes: [
          {
            ...workflow.nodes[0],
            evidenceSources: [
              {
                evidenceId: "fact:gross-margin-2026q1",
                relationType: "supports",
                citation: "经营数据.xlsx Chart!B2",
                documentName: "经营数据.xlsx",
                sourcePath: "/research/阳光电源/经营数据.xlsx",
                sheetName: "Chart",
                cellRange: "B2",
                excerpt: "2026Q1 海外毛利率 31.4%",
              },
            ],
            contentBlocks: [
              {
                type: "metrics",
                title: "关键指标",
                items: [{ label: "海外毛利率", value: "31.4", unit: "%", delta: "+2.1pct" }],
              },
              {
                type: "table",
                title: "区域对比",
                columns: [
                  { key: "region", label: "区域" },
                  { key: "margin", label: "毛利率", align: "right" },
                ],
                rows: [{ region: "海外", margin: "31.4%" }],
              },
              {
                type: "chart",
                title: "毛利率走势",
                chart_type: "line",
                x_key: "period",
                series: [{ key: "margin", label: "毛利率" }],
                data: [{ period: "2026Q1", margin: 31.4 }],
                y_unit: "%",
              },
              {
                type: "html",
                title: "静态分析摘要",
                html: "<strong>海外改善</strong><script>window.__unsafe = true</script>",
                height: 180,
              },
            ],
          },
        ],
      },
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof usePrivateFundWorkflow>);

    renderWorkbench();
    fireEvent.click(screen.getByText("海外盈利质量改善"));
    expect(
      await screen.findByRole("heading", { name: "关键指标" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("31.4")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "毛利率" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "毛利率走势" })).toBeInTheDocument();
    const htmlFrame = screen.getByTitle("静态分析摘要");
    expect(htmlFrame).toHaveAttribute("sandbox", "");
    expect(htmlFrame.getAttribute("srcdoc")).toContain("default-src 'none'");
    expect(screen.getByText("溯源资料 · 1 条")).toBeInTheDocument();
    expect(screen.getByText("点击下方来源，查看真实文档位置和证据原文")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /经营数据.xlsx Chart!B2/ }));
    expect(await screen.findByText("真实文档位置")).toBeInTheDocument();
    expect(screen.getByText("工作表 Chart · B2")).toBeInTheDocument();
    expect(screen.getByText("/research/阳光电源/经营数据.xlsx")).toBeInTheDocument();
    expect(screen.getByText("2026Q1 海外毛利率 31.4%")).toBeInTheDocument();
  });

  it("renders saved Markdown assets with the Streamdown plugin stack", async () => {
    vi.mocked(usePrivateFundAssets).mockReturnValue({
      data: {
        contextAssetIds: [],
        assets: [
          {
            ...assetCatalog.assets[0],
            assetId: "asset:management-view",
            assetType: "information",
            title: "管理层观点摘录",
            sourceKind: "saved_information",
            sourceId: "response-2",
            contentMarkdown: [
              "## 核心观点",
              "",
              "这是一个 **重要判断**。",
              "",
              "| 主题 | 观点 |",
              "| --- | --- |",
              "| 电网 | 优先关注稳定性 |",
            ].join("\n"),
          },
        ],
      },
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof usePrivateFundAssets>);

    renderWorkbench();
    fireEvent.click(screen.getByText("管理层观点摘录"));

    expect(await screen.findByRole("heading", { name: "核心观点" })).toBeInTheDocument();
    expect(screen.getByText("重要判断").closest('[data-streamdown="strong"]')).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "主题" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "优先关注稳定性" })).toBeInTheDocument();
  });

  it("embeds PDF memo assets instead of showing only their filesystem path", () => {
    const storedPath =
      "/Users/feiyuzi/project/pravite_fund_ai_research/output/private_fund_datasets/阳光电源/memos/private_fund_memo_阳光电源_20260712_161105.pdf";
    vi.mocked(usePrivateFundAssets).mockReturnValue({
      data: {
        contextAssetIds: [],
        assets: [
          {
            ...assetCatalog.assets[0],
            assetId: "memo:pdf",
            assetType: "memo",
            title: "private_fund_memo_阳光电源_20260712_161105",
            summary: "长期报告产物 · PDF",
            sourceKind: "memo",
            sourceId: storedPath,
            storedPath,
            fileType: "pdf",
            format: "pdf",
            contentMarkdown: "",
          },
        ],
      },
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof usePrivateFundAssets>);

    renderWorkbench();
    fireEvent.click(screen.getByText("private_fund_memo_阳光电源_20260712_161105"));

    const frame = screen.getByTitle("private_fund_memo_阳光电源_20260712_161105 PDF 预览");
    expect(frame).toHaveAttribute(
      "src",
      `/v1/private-fund/dataset/memo/file?path=${encodeURIComponent(storedPath)}`,
    );
  });

  it("renders Excel document assets with the structured workbook viewer", () => {
    vi.mocked(usePrivateFundAssets).mockReturnValue({
      data: {
        contextAssetIds: [],
        assets: [
          {
            ...assetCatalog.assets[0],
            assetId: "document:workbook",
            assetType: "document",
            title: "300274 v44.xlsx",
            summary: "XLSX · 51 个可检索片段",
            sourceKind: "document",
            sourceId: "doc-workbook",
            storedPath: "/dataset/raw/300274 v44.xlsx",
            fileType: "xlsx",
            format: "xlsx",
            contentMarkdown: "",
          },
        ],
      },
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof usePrivateFundAssets>);

    renderWorkbench();
    fireEvent.click(screen.getByText("300274 v44.xlsx"));

    expect(screen.getByTestId("structured-document-preview")).toHaveTextContent(
      "300274 v44.xlsx · 阳光电源",
    );
    expect(screen.queryByText("该资产保留原文件位置")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开资产详情" }));
    expect(screen.getByLabelText("Agent 输入与输出")).toHaveClass("hidden");
    expect(screen.getByRole("button", { name: "收起资产详情" })).toBeInTheDocument();
  });

  it("persists checked graph nodes as the next LLM context", async () => {
    renderWorkbench();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择资产 海外盈利质量改善" }));

    await waitFor(() =>
      expect(setPrivateFundAssetContext).toHaveBeenCalledWith("阳光电源", ["node:node-overseas"]),
    );
    expect(screen.queryByRole("button", { name: /加入上下文|已作为上下文/ })).toBeNull();
  });
});
