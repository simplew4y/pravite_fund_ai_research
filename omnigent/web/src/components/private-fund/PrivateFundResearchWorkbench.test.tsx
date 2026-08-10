import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  usePrivateFundAssets,
  usePrivateFundProject,
  usePrivateFundWorkflow,
} from "@/hooks/usePrivateFundProjects";
import {
  PRIVATE_FUND_CONTEXT_START,
  type PrivateFundAssetCatalog,
  type PrivateFundResearchWorkflow,
  savePrivateFundAsset,
  setPrivateFundAssetContext,
} from "@/lib/privateFundApi";
import {
  PRIVATE_FUND_GENERATION_OPTIONS,
  PrivateFundResearchWorkbench,
  usePrivateFundWorkbenchActions,
} from "./PrivateFundResearchWorkbench";
import { usePrivateFundWorkspaceStore } from "@/store/privateFundWorkspaceStore";

vi.mock("@/hooks/usePrivateFundProjects", () => ({
  usePrivateFundWorkflow: vi.fn(),
  usePrivateFundAssets: vi.fn(),
  usePrivateFundProject: vi.fn(),
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
vi.mock("./PrivateFundHistoryPanel", () => ({
  PrivateFundHistoryPanel: () => <div>历史追踪面板</div>,
}));
vi.mock("./PrivateFundTrackingPanel", () => ({
  PrivateFundTrackingPanel: () => <div>风险催化剂面板</div>,
}));
vi.mock("./PrivateFundValuationTrackingPanel", () => ({
  PrivateFundValuationTrackingPanel: () => <div>估值模型跟踪面板</div>,
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
      displayGroup: "research_note",
      displayLabel: "研究笔记",
    },
  ],
};

function ActionFixture() {
  const actions = usePrivateFundWorkbenchActions();
  return (
    <div>
      <button
        type="button"
        onClick={() => actions?.markUsefulInformation("response-1", "海外收入和现金流同步改善")}
      >
        勾选回答
      </button>
      {actions ? (
        <div aria-label="测试生成条">
          {PRIVATE_FUND_GENERATION_OPTIONS.map((option) => (
            <button
              aria-pressed={actions.generationMode === option.value}
              key={option.value}
              onClick={() => actions.setGenerationMode(option.value)}
              type="button"
            >
              生成模式 {option.label}
            </button>
          ))}
          <input
            aria-label="生成具体要求"
            onChange={(event) => actions.setGenerationInstruction(event.target.value)}
            value={actions.generationInstruction}
          />
          <button onClick={() => actions.generateAsset()} type="button">
            {actions.generationMode === "memo" ? "生成 Memo" : "生成研究笔记"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

let renderedQueryClient: QueryClient;

function renderWorkbench(
  onGenerateNode = vi.fn(),
  options: {
    hasConversationContext?: boolean;
    conversationId?: string;
    generationAvailable?: boolean;
  } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderedQueryClient = queryClient;
  render(
    <QueryClientProvider client={queryClient}>
      <PrivateFundResearchWorkbench
        conversationId={options.conversationId ?? "conv-test"}
        datasetId="阳光电源"
        datasetName="阳光电源"
        hasConversationContext={options.hasConversationContext}
        chat={
          <>
            <textarea aria-label="真实 AI 对话" defaultValue="保留的草稿" />
            <ActionFixture />
          </>
        }
        {...(options.generationAvailable === false ? {} : { onGenerateNode })}
      />
    </QueryClientProvider>,
  );
  return onGenerateNode;
}

describe("PrivateFundResearchWorkbench", () => {
  beforeEach(() => {
    window.localStorage.setItem("omnigent.privateFund.workbenchChrome", "tabs");
    window.localStorage.removeItem("omnigent.privateFund.idePanelWidth");
    vi.clearAllMocks();
    usePrivateFundWorkspaceStore.setState({ documentPreviewRequest: null });
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
    vi.mocked(usePrivateFundProject).mockReturnValue({
      data: {
        project: { companyName: "阳光电源" },
        files: [],
      },
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof usePrivateFundProject>);
    vi.mocked(savePrivateFundAsset).mockResolvedValue(assetCatalog);
    vi.mocked(setPrivateFundAssetContext).mockResolvedValue({
      ...assetCatalog,
      contextAssetIds: ["node:node-overseas"],
    });
  });

  it("switches to sources and opens the existing document preview on request", async () => {
    vi.mocked(usePrivateFundAssets).mockReturnValue({
      data: {
        ...assetCatalog,
        assets: [
          ...assetCatalog.assets,
          {
            ...assetCatalog.assets[0],
            assetId: "document:alpha",
            assetType: "document",
            title: "alpha.pdf",
            sourceKind: "document",
            format: "pdf",
            displayGroup: "source",
            displayLabel: "资料",
          },
        ],
      },
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof usePrivateFundAssets>);
    renderWorkbench();

    act(() => {
      usePrivateFundWorkspaceStore.getState().openDocumentPreview(workflow.datasetId, "alpha.pdf");
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "资料" })).toHaveAttribute("aria-current", "page"),
    );
    expect(document.querySelector('iframe[title^="alpha.pdf"]')).not.toBeNull();
    expect(usePrivateFundWorkspaceStore.getState().documentPreviewRequest).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));

    expect(screen.getByRole("button", { name: "研究" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByLabelText("真实 AI 对话")).toBeInTheDocument();
  });

  it("renders the research workspace as a flex layout", () => {
    renderWorkbench();
    const grid = screen.getByTestId("private-fund-workbench-grid");
    expect(grid.className).toContain("flex");
  });

  it("keeps the complete workbench chrome visible before the first conversation", () => {
    window.localStorage.setItem("omnigent.privateFund.workbenchChrome", "ide");
    renderWorkbench(vi.fn(), { conversationId: "", generationAvailable: false });

    expect(screen.getByRole("button", { name: "研究" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "资料" })).toBeInTheDocument();
    expect(screen.getByTestId("private-fund-ide-activity-rail")).toBeInTheDocument();
    expect(screen.getByLabelText("真实 AI 对话")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "生成研究笔记" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "请先在研究区输入问题并创建会话，再生成研究笔记",
    );
  });

  it("opens research note detail from the notes workspace", async () => {
    renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "笔记" }));
    fireEvent.click(screen.getByText("海外盈利质量改善"));
    expect(
      await screen.findByText("结论、证据、不确定性和下一步问题", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  });

  it("uses full-width research chat without a right-side asset library", () => {
    vi.mocked(usePrivateFundAssets).mockReturnValue({
      data: {
        ...assetCatalog,
        contextAssetIds: ["node:node-overseas"],
      },
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof usePrivateFundAssets>);

    renderWorkbench();
    expect(screen.queryByRole("region", { name: "资产" })).toBeNull();
    expect(screen.getByLabelText("真实 AI 对话")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "研究" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "资料" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "笔记" })).toBeInTheDocument();
  });

  it("sends selected LLM information to the agent instead of creating a preset node", async () => {
    const onGenerateNode = renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "勾选回答" }));

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
    fireEvent.click(screen.getByRole("button", { name: "生成研究笔记" }));
    await waitFor(() => expect(onGenerateNode).toHaveBeenCalledOnce());
    const prompt = vi.mocked(onGenerateNode).mock.calls[0][0];
    expect(prompt).toContain("海外收入和现金流同步改善");
    expect(prompt).toContain("private_fund_research_node_save");
    expect(prompt).toContain("不要套用预设研究流程");
    expect(prompt).toContain("content_blocks");
    expect(prompt).toContain("本次节点输出形式: 文本");
    expect(prompt).toContain("文本模式");
  });

  it("writes a newly saved response into the asset cache before the request completes", async () => {
    vi.mocked(savePrivateFundAsset).mockReturnValue(new Promise(() => undefined));
    renderWorkbench();

    fireEvent.click(screen.getByRole("button", { name: "勾选回答" }));

    await waitFor(() => {
      const catalog = renderedQueryClient.getQueryData<PrivateFundAssetCatalog>([
        "private-fund-assets",
        "阳光电源",
      ]);
      expect(catalog?.assets[0]).toEqual(
        expect.objectContaining({
          assetType: "information",
          title: "海外收入和现金流同步改善",
          status: "saving",
        }),
      );
    });
  });

  it("generates a selected asset type from asset context without requiring AI information", () => {
    const documentAsset = {
      ...assetCatalog.assets[0],
      assetId: "document:annual-report",
      assetType: "document",
      title: "2025 年报.pdf",
      summary: "已索引的公司年报",
      contentMarkdown: "海外收入同比增长 28%，但仍需核验证据。",
      sourceKind: "document",
      sourceId: "doc-annual-report",
      format: "pdf",
      displayGroup: "source",
      displayLabel: "资料",
    };
    vi.mocked(usePrivateFundAssets).mockReturnValue({
      data: {
        assets: [...assetCatalog.assets, documentAsset],
        contextAssetIds: [documentAsset.assetId],
      },
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof usePrivateFundAssets>);

    const onGenerateNode = renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "生成模式 表格" }));
    fireEvent.click(screen.getByRole("button", { name: "生成研究笔记" }));

    expect(onGenerateNode).toHaveBeenCalledOnce();
    const prompt = vi.mocked(onGenerateNode).mock.calls[0][0];
    expect(prompt).toContain("本次节点输出形式: 表格");
    expect(prompt).toContain("用户选择的问题上下文");
    expect(prompt).toContain("2025 年报.pdf（document）");
    expect(prompt).toContain("海外收入同比增长 28%，但仍需核验证据");
    expect(prompt).toContain("作为分析依据的父节点: 无");
    expect(prompt).not.toContain("用户保存的回答笔记");
  });

  it("generates from existing conversation context without requiring selected information", () => {
    const onGenerateNode = renderWorkbench(vi.fn(), { hasConversationContext: true });
    fireEvent.click(screen.getByRole("button", { name: "生成研究笔记" }));

    expect(onGenerateNode).toHaveBeenCalledOnce();
    expect(vi.mocked(onGenerateNode).mock.calls[0][0]).toContain("当前会话也是本次生成依据");
  });

  it("asks for context only when the conversation and selections are both empty", () => {
    const onGenerateNode = renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "生成研究笔记" }));

    expect(onGenerateNode).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("请先提供对话内容，或选择至少一项上下文");
  });

  it("only exposes text, table, chart, and memo generation modes", () => {
    renderWorkbench();
    expect(
      screen
        .getAllByRole("button", { name: /生成模式/ })
        .map((button) => button.textContent?.replace("生成模式 ", "")),
    ).toEqual(["文本", "表格", "图表", "Memo"]);
  });

  it("separates sources, findings, and deliverables into stable workspaces", () => {
    vi.mocked(usePrivateFundAssets).mockReturnValue({
      data: {
        contextAssetIds: [],
        assets: [
          assetCatalog.assets[0],
          {
            ...assetCatalog.assets[0],
            assetId: "document:annual-report",
            assetType: "document",
            title: "2025 年报.pdf",
            sourceKind: "document",
            format: "pdf",
            displayGroup: "source",
            displayLabel: "资料",
          },
          {
            ...assetCatalog.assets[0],
            assetId: "memo:investment-case",
            assetType: "memo",
            displayGroup: "memo",
            displayLabel: "Memo",
            title: "投资逻辑 Memo",
            sourceKind: "memo",
            format: "markdown",
          },
        ],
      },
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof usePrivateFundAssets>);

    renderWorkbench();

    fireEvent.click(screen.getByRole("button", { name: "资料" }));
    expect(screen.getByRole("heading", { name: "资料" })).toBeInTheDocument();
    expect(screen.getByText("2025 年报.pdf")).toBeInTheDocument();
    expect(screen.queryByText("海外盈利质量改善")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "笔记" }));
    expect(screen.getByRole("heading", { name: "笔记" })).toBeInTheDocument();
    expect(screen.getByText("海外盈利质量改善")).toBeInTheDocument();
    expect(screen.queryByText("投资逻辑 Memo")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Memo" }));
    expect(screen.getByRole("heading", { name: "Memo" })).toBeInTheDocument();
    expect(screen.getByText("投资逻辑 Memo")).toBeInTheDocument();
    expect(screen.queryByText("2025 年报.pdf")).toBeNull();
  });

  it("opens valuation, history, and risk tracking as independent workspaces", () => {
    renderWorkbench();

    fireEvent.click(screen.getByRole("button", { name: "估值跟踪" }));
    expect(screen.getByText("估值模型跟踪面板")).toBeInTheDocument();
    expect(screen.queryByLabelText("真实 AI 对话")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "历史变化" }));
    expect(screen.getByText("历史追踪面板")).toBeInTheDocument();
    expect(screen.queryByLabelText("真实 AI 对话")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "追踪提醒" }));
    expect(screen.getByText("风险催化剂面板")).toBeInTheDocument();
  });

  it("lets the model choose a self-contained HTML/JS chart from the content", async () => {
    const onGenerateNode = renderWorkbench();
    expect(screen.getByRole("button", { name: "生成模式 文本" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "生成模式 图表" }));
    fireEvent.change(screen.getByLabelText("生成具体要求"), {
      target: { value: "展示海外与国内盈利质量差异，由模型选择最合适图形。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "勾选回答" }));
    await waitFor(() => expect(savePrivateFundAsset).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "生成研究笔记" }));

    await waitFor(() => expect(onGenerateNode).toHaveBeenCalledOnce());
    const prompt = vi.mocked(onGenerateNode).mock.calls[0][0];
    expect(prompt).toContain("本次节点输出形式: 图表");
    expect(prompt).toContain("饼图/环形图");
    expect(prompt).toContain("原生 SVG 或 Canvas");
    expect(prompt).toContain("自包含的 HTML/CSS/JavaScript");
    expect(prompt).toContain("只加入一个 html block");
    expect(prompt).toContain("禁止任何外部依赖、CDN、fetch");
    expect(prompt).toContain("可读文字或数据表回退");
    expect(prompt).toContain("ASCII 字符画");
    expect(prompt).toContain("展示海外与国内盈利质量差异，由模型选择最合适图形");
    expect(screen.getByRole("button", { name: "生成模式 文本" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("explicitly invokes the memo skill with dialog instructions", () => {
    const onGenerateNode = renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "生成模式 Memo" }));
    expect(screen.getByRole("button", { name: "生成 Memo" })).toBeInTheDocument();
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
                title: "交互分析摘要",
                html: "<strong>海外改善</strong><script>document.body.dataset.rendered = 'true'</script>",
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
    fireEvent.click(screen.getByRole("button", { name: "笔记" }));
    fireEvent.click(screen.getByText("海外盈利质量改善"));
    expect(
      await screen.findByRole("heading", { name: "关键指标" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("31.4")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "毛利率" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "毛利率走势" })).toBeInTheDocument();
    const htmlFrame = screen.getByTitle("交互分析摘要");
    expect(htmlFrame).toHaveAttribute("sandbox", "allow-scripts");
    expect(htmlFrame.getAttribute("srcdoc")).toContain("default-src 'none'");
    expect(htmlFrame.getAttribute("srcdoc")).toContain("script-src 'unsafe-inline'");
    expect(htmlFrame.getAttribute("srcdoc")).toContain("connect-src 'none'");
    expect(htmlFrame.getAttribute("srcdoc")).toContain("document.body.dataset.rendered");
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
            displayGroup: "answer_note",
            displayLabel: "回答笔记",
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
    fireEvent.click(screen.getByRole("button", { name: "笔记" }));
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
            displayGroup: "memo",
            displayLabel: "Memo",
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
    fireEvent.click(screen.getByRole("button", { name: "Memo" }));
    fireEvent.click(screen.getByText("private_fund_memo_阳光电源_20260712_161105"));

    const frame = screen.getByTitle("private_fund_memo_阳光电源_20260712_161105 PDF 预览");
    expect(frame).toHaveAttribute(
      "src",
      `/v1/private-fund/dataset/memo/file?path=${encodeURIComponent(storedPath)}`,
    );
    expect(screen.queryByTestId("pdf-preview-toolbar")).toBeNull();
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
            displayGroup: "source",
            displayLabel: "资料",
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
    fireEvent.click(screen.getByRole("button", { name: "资料" }));
    fireEvent.click(screen.getByText("300274 v44.xlsx"));

    expect(screen.getByTestId("structured-document-preview")).toHaveTextContent(
      "300274 v44.xlsx · 阳光电源",
    );
    expect(screen.queryByText("该资料保留原文件位置")).toBeNull();
    expect(screen.getByRole("button", { name: "返回列表" })).toBeInTheDocument();
  });

  it("persists selected assets for the next analysis", async () => {
    renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "笔记" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "加入上下文 海外盈利质量改善" }));

    await waitFor(() =>
      expect(setPrivateFundAssetContext).toHaveBeenCalledWith("阳光电源", ["node:node-overseas"]),
    );
    expect(screen.queryByText("上下文")).toBeNull();
  });

  it("previews side-panel notes without replacing the active conversation", () => {
    window.localStorage.setItem("omnigent.privateFund.workbenchChrome", "ide");
    renderWorkbench();

    expect(screen.getAllByRole("heading", { name: "笔记" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "筛选与排序" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "笔记类型" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "笔记类型" })).toBeNull();
    expect(screen.queryByText("1 条笔记（回答笔记与研究笔记）")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "仅显示回答笔记" }));
    expect(screen.queryByRole("button", { name: "打开资产 海外盈利质量改善" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "仅显示研究笔记" }));
    expect(screen.getByRole("button", { name: "打开资产 海外盈利质量改善" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "筛选与排序" }));
    expect(screen.getByRole("combobox", { name: "排序" })).toBeInTheDocument();

    const search = screen.getByRole("textbox", { name: "搜索" });
    fireEvent.change(search, { target: { value: "海外" } });
    fireEvent.click(screen.getByRole("button", { name: "打开资产 海外盈利质量改善" }));

    expect(screen.getByLabelText("真实 AI 对话")).toBeInTheDocument();
    expect(screen.getByTestId("private-fund-side-asset-detail")).toBeInTheDocument();
    expect(screen.getByTestId("private-fund-ide-side-panel")).toHaveStyle({ width: "520px" });
    expect(screen.getByRole("heading", { name: "海外盈利质量改善" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回笔记列表" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上一条笔记" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下一条笔记" })).toBeDisabled();
    expect(screen.getByTestId("asset-preview-metadata")).toHaveTextContent("来源 0 条");
    expect(
      screen.getByRole("button", { name: "在主工作区展开 海外盈利质量改善" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "返回笔记列表" }));

    expect(screen.queryByTestId("private-fund-side-asset-detail")).toBeNull();
    expect(screen.getByRole("textbox", { name: "搜索" })).toHaveValue("海外");
    expect(screen.getByLabelText("真实 AI 对话")).toBeInTheDocument();
  });

  it("reviews adjacent notes without returning to the list", () => {
    window.localStorage.setItem("omnigent.privateFund.workbenchChrome", "ide");
    vi.mocked(usePrivateFundAssets).mockReturnValue({
      data: {
        contextAssetIds: [],
        assets: [
          {
            ...assetCatalog.assets[0],
            assetId: "note:first",
            assetType: "information",
            displayGroup: "answer_note",
            displayLabel: "回答笔记",
            title: "第一条研究结论",
            sourceKind: "saved_information",
            sourceId: "response-first",
            contentMarkdown: "## 核心判断\n\n海外业务盈利质量改善。",
            updatedAt: "2026-07-14T08:30:00Z",
          },
          {
            ...assetCatalog.assets[0],
            assetId: "note:second",
            assetType: "analysis",
            displayGroup: "research_note",
            displayLabel: "研究笔记",
            title: "第二条风险复核",
            sourceKind: "saved_information",
            sourceId: "response-second",
            contentMarkdown: "## 风险因素\n\n渠道库存仍需跟踪。",
            evidenceCount: 2,
            updatedAt: "2026-07-13T09:45:00Z",
          },
        ],
      },
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof usePrivateFundAssets>);

    renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "打开资产 第一条研究结论" }));

    expect(screen.getByRole("navigation", { name: "第一条研究结论目录" })).toHaveTextContent(
      "核心判断",
    );
    expect(screen.getByTestId("asset-preview-metadata")).toHaveTextContent("1 / 2");
    fireEvent.click(screen.getByRole("button", { name: "下一条笔记" }));
    expect(screen.getByRole("heading", { name: "第二条风险复核" })).toBeInTheDocument();
    expect(screen.getByTestId("asset-preview-metadata")).toHaveTextContent("来源 2 条");
    expect(screen.getByTestId("asset-preview-metadata")).toHaveTextContent("2 / 2");
    expect(screen.getByRole("button", { name: "下一条笔记" })).toBeDisabled();
  });

  it("previews side-panel Memo files without replacing the active conversation", () => {
    const storedPath = "/dataset/memos/investment-case.pdf";
    window.localStorage.setItem("omnigent.privateFund.workbenchChrome", "ide");
    vi.mocked(usePrivateFundAssets).mockReturnValue({
      data: {
        contextAssetIds: [],
        assets: [
          {
            ...assetCatalog.assets[0],
            assetId: "memo:investment-case",
            assetType: "memo",
            displayGroup: "memo",
            displayLabel: "Memo",
            title: "投资逻辑 Memo",
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
    fireEvent.click(screen.getByRole("button", { name: "Memo" }));
    expect(screen.getAllByRole("heading", { name: "Memo" })).toHaveLength(1);
    expect(screen.queryByText("1 份 Memo")).toBeNull();
    expect(screen.getByRole("button", { name: "筛选与排序" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开资产 投资逻辑 Memo" }));

    expect(screen.getByLabelText("真实 AI 对话")).toBeInTheDocument();
    expect(screen.getByTestId("private-fund-side-asset-detail")).toContainElement(
      screen.getByTitle("投资逻辑 Memo PDF 预览"),
    );
    expect(screen.getByRole("button", { name: "返回Memo列表" })).toBeInTheDocument();
    expect(screen.getByTestId("asset-preview-metadata")).toHaveTextContent("PDF");
    expect(screen.queryByTestId("pdf-preview-toolbar")).toBeNull();
  });

  it("keeps 研究/资料 as primary tabs and only secondary tools on the side rail", () => {
    renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "侧栏布局" }));
    expect(screen.getByTestId("private-fund-ide-activity-rail")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "主工作区" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "研究" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "资料" })).toBeInTheDocument();
    const rail = screen.getByTestId("private-fund-ide-activity-rail");
    expect(rail.querySelector('[aria-label="研究"]')).toBeNull();
    expect(rail.querySelector('[aria-label="资料"]')).toBeNull();
    expect(rail.querySelector('[aria-label="笔记"]')).not.toBeNull();
    expect(screen.getByTestId("private-fund-ide-side-panel")).toHaveTextContent("笔记");
    expect(screen.getByLabelText("真实 AI 对话")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "资料" }));
    expect(screen.getByRole("heading", { name: "资料" })).toBeInTheDocument();
  });
});
