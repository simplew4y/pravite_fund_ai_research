import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Loader2,
  Maximize2,
  Menu,
  Minimize2,
  Package,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { usePrivateFundAssets, usePrivateFundWorkflow } from "@/hooks/usePrivateFundProjects";
import {
  type PrivateFundAsset,
  type PrivateFundRichContentBlock,
  deletePrivateFundAssets,
  savePrivateFundAsset,
  setPrivateFundAssetContext,
  wrapPrivateFundPromptContext,
} from "@/lib/privateFundApi";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { PdfSourcePanel } from "@/shell/PdfSourcePanel";
import type { PdfSourceSelection } from "@/shell/FileViewerContext";
import { ResearchAssetLibrary } from "./ResearchAssetLibrary";
import { FilePathAwareMessageResponse } from "@/components/blocks/BlockRenderer";
import { hostFetch } from "@/lib/host";

const RichNodeContent = lazy(() =>
  import("./RichNodeContent").then((module) => ({ default: module.RichNodeContent })),
);

const EMPTY_ASSETS: PrivateFundAsset[] = [];
const EMPTY_ASSET_IDS: string[] = [];

type SelectedInformation = { responseId: string; content: string };
type PresentationMode =
  | "plain_text"
  | "agent"
  | "metrics"
  | "table"
  | "line_chart"
  | "bar_chart"
  | "rich";
type GenerationMode = PresentationMode | "memo" | "report";

const PRESENTATION_OPTIONS: Array<{
  value: GenerationMode;
  label: string;
  description: string;
}> = [
  { value: "plain_text", label: "普通文本", description: "只保存长期可读的节点正文" },
  { value: "agent", label: "Agent 自主判断", description: "根据内容选择最合适的呈现" },
  { value: "metrics", label: "关键指标", description: "展示少量核心数字" },
  { value: "table", label: "对比表格", description: "精确比较期间或对象" },
  { value: "line_chart", label: "折线趋势", description: "展示时间序列变化" },
  { value: "bar_chart", label: "柱状对比", description: "比较类别或情景" },
  { value: "rich", label: "综合图文", description: "组合指标、表格、图表或静态布局" },
  { value: "memo", label: "研究 Memo", description: "调用 private-fund-memo 生成聚焦报告" },
  {
    value: "report",
    label: "专业研报",
    description: "调用 private-fund-report 生成 FinRobot 对齐研报",
  },
];

function isDocumentGenerationMode(mode: GenerationMode): mode is "memo" | "report" {
  return mode === "memo" || mode === "report";
}

type WorkbenchActionContextValue = {
  contextAssets: Array<{
    assetId: string;
    assetType: string;
    title: string;
    content: string;
    evidenceCitations: string[];
  }>;
  addResearchNodeFromResponse: (responseId: string, content: string) => void;
  markUsefulInformation: (responseId: string, content: string) => void;
  pinToCurrentAssumption: (responseId: string, content: string) => void;
};

const WorkbenchActionContext = createContext<WorkbenchActionContextValue | null>(null);

export function usePrivateFundWorkbenchActions(): WorkbenchActionContextValue | null {
  return useContext(WorkbenchActionContext);
}

export type PrivateFundResearchWorkbenchProps = {
  conversationId: string;
  datasetId: string;
  datasetName: string;
  chat: ReactNode;
  onGenerateNode: (prompt: string) => void;
  sidebarOpen?: boolean;
  onOpenSidebar?: () => void;
};

function cleanText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type DocumentPreviewPayload = {
  file_name: string;
  file_type: string;
  chunk_count: number;
  content_markdown: string;
  truncated: boolean;
};

function ExtractedDocumentPreview({
  datasetId,
  fileName,
}: {
  datasetId: string;
  fileName: string;
}) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; payload: DocumentPreviewPayload }
  >({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ dataset_id: datasetId, file_name: fileName });
    setState({ status: "loading" });
    hostFetch(`/v1/private-fund/dataset/document/preview?${params}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const error = (await response.json().catch(() => null)) as { detail?: string } | null;
          throw new Error(error?.detail || response.statusText || "无法读取文件预览");
        }
        return response.json() as Promise<DocumentPreviewPayload>;
      })
      .then((payload) => setState({ status: "ready", payload }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "无法读取文件预览",
        });
      });
    return () => controller.abort();
  }, [datasetId, fileName]);

  if (state.status === "loading") {
    return (
      <div className="mt-4 flex h-48 items-center justify-center gap-2 rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] text-xs text-[var(--pf-ink-secondary)]">
        <Loader2 className="size-4 animate-spin" />
        正在读取解析后的文件内容…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
        {state.message}
      </div>
    );
  }
  return (
    <div className="mt-4">
      <p className="mb-3 text-[10px] text-[var(--pf-ink-muted)]">
        pipeline 解析预览 · {state.payload.chunk_count} 个片段
        {state.payload.truncated ? " · 内容较长，已截断" : ""}
      </p>
      <FilePathAwareMessageResponse
        breaks
        className="text-sm leading-6 text-[var(--pf-ink-secondary)] [&_table]:text-xs"
      >
        {state.payload.content_markdown || "该文件没有可展示的解析正文。"}
      </FilePathAwareMessageResponse>
    </div>
  );
}

function buildGenerationPrompt(
  datasetId: string,
  selectedInformation: SelectedInformation[],
  parentNodeIds: string[],
  contextAssets: PrivateFundAsset[],
  presentationMode: GenerationMode,
  presentationInstruction: string,
): string {
  const information = selectedInformation
    .map(
      (item, index) =>
        `### 选中信息 ${index + 1}\nresponse_id: ${item.responseId}\n${item.content}`,
    )
    .join("\n\n");
  const context = contextAssets
    .map(
      (asset) =>
        `- [${asset.assetId}] ${asset.title}（${asset.assetType}）\n${(
          asset.contentMarkdown || asset.summary
        ).slice(0, 2400)}`,
    )
    .join("\n\n");
  if (isDocumentGenerationMode(presentationMode)) {
    const isMemo = presentationMode === "memo";
    const skillName = isMemo ? "private-fund-memo" : "private-fund-report";
    const defaultInstruction = isMemo
      ? "基于当前勾选信息和资产上下文生成一份聚焦研究 Memo。"
      : "基于当前勾选信息和资产上下文生成一份 FinRobot 对齐的专业研报。";
    const hiddenContext = [
      `dataset_id: ${datasetId}`,
      isMemo
        ? "必须调用 private_fund_dataset_memo，返回 Markdown、HTML 和 PDF。"
        : "必须调用 private_fund_equity_report_generate，返回 Markdown、HTML、PDF、JSON 和证据索引。",
      "所有重大事实和数字必须通过数据集工具核验；无法绑定 evidence_id 的内容标记为“资料未覆盖/待复核”。",
      information ? `\n用户勾选的重要信息:\n${information}` : "",
      context ? `\n用户勾选的资产上下文:\n${context}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return `/${skillName} ${presentationInstruction.trim() || defaultInstruction}\n${wrapPrivateFundPromptContext(hiddenContext)}`.trim();
  }
  const modeLabel = PRESENTATION_OPTIONS.find((option) => option.value === presentationMode)?.label;
  const modeInstructions: Record<PresentationMode, string[]> = {
    plain_text: [
      "本次节点使用普通文本呈现。",
      "- 只保存 content_markdown，不要生成 content_blocks；正文保持清晰、可引用和长期可读。",
    ],
    agent: [
      "本次呈现方式由你根据内容自主判断，不需要为了丰富而强行生成图表。",
      "- 只有结构化呈现确实提升理解时才生成 content_blocks。",
    ],
    metrics: ["- 必须加入 metrics block，突出 2-6 个有证据支持的核心指标及单位。"],
    table: ["- 必须加入 table block，列名、行名、单位和口径应明确，保留精确值。"],
    line_chart: [
      "- 必须加入 chart block，chart_type=line；仅使用同口径、有顺序的时间或连续数据。",
      "- 不得在聊天回复或 content_markdown 中使用 ASCII 字符画、文本坐标轴、Markdown 伪图表或代码块代替。",
    ],
    bar_chart: [
      "- 必须加入 chart block，chart_type=bar；用于有证据支持的类别、公司或情景对比。",
      "- 不得在聊天回复或 content_markdown 中使用 ASCII 字符画、文本坐标轴、Markdown 伪图表或代码块代替。",
    ],
    rich: [
      "- 生成综合图文节点，根据证据组合 metrics、table、chart、markdown 或静态 html blocks。",
      "- 优先使用声明式 blocks；只有标准 blocks 无法表达布局时才使用安全静态 HTML。资料不支持的 block 可以省略。",
    ],
  };
  const presentationLines = [
    `本次节点输出形式: ${modeLabel}`,
    ...modeInstructions[presentationMode],
    presentationInstruction.trim() ? `- 用户补充要求: ${presentationInstruction.trim()}` : "",
    presentationMode !== "plain_text"
      ? "- 如果资料不足以可靠生成指定结构，必须说明缺少哪些期间、指标或口径，不得虚构数据。"
      : "",
    presentationMode === "line_chart" || presentationMode === "bar_chart"
      ? '- chart block 示例: {"type":"chart","title":"毛利率趋势","chart_type":"line","x_key":"year","series":[{"key":"gross_margin","label":"毛利率"}],"data":[{"year":"2016","gross_margin":30.2}],"y_unit":"%","source_note":"数据来源与口径"}'
      : "",
    presentationMode !== "plain_text"
      ? "- 图表由页面的 JavaScript 图表组件渲染。Agent 只提供结构化数据，不生成或执行 JavaScript。保存成功后，聊天中只需报告节点 ID 和证据缺口。"
      : "",
  ].filter(Boolean);
  return [
    "请把我勾选的重要信息生成一个新的研究节点。",
    `dataset_id: ${datasetId}`,
    `作为上下文的父节点: ${parentNodeIds.length > 0 ? parentNodeIds.join(", ") : "无"}`,
    "你需要根据内容自行决定节点标题、node_type、摘要、标签和置信度，不要套用预设研究流程。",
    "每个重大事实、日期、事件、金额、比例、估值输入，以及 metrics/table/chart 中的每个数值，都必须使用 private_fund_dataset_search 检索，并用 private_fund_source_detail 核验决定性证据。",
    "必须调用 private_fund_research_node_save 保存节点；不要只在聊天中输出节点草稿。",
    "content_markdown 必须包含：结论、支持信息与引用、不确定性或反证、下一步问题，作为长期可读的文本回退。每个受支持的关键陈述后必须紧跟 evidence 返回的 markdown_citation。",
    "private_fund_research_node_save 的 evidence_ids 必须包含本节点实际核验并使用的全部证据；每个富内容 block 还要用 evidence_ids 绑定直接支持它的证据。无法绑定真实证据的内容必须标注“资料未覆盖/待复核”，不得作为已验证结论或图表数值。",
    presentationMode !== "plain_text"
      ? "可用 content_blocks 类型为 markdown、metrics、table、chart、html；不要为了视觉效果虚构数字。HTML 只能是静态内容，不得包含脚本、表单、远程资源或导航。"
      : "普通文本模式下不得保存 content_blocks。",
    presentationMode === "agent"
      ? "当内容包含三个及以上同口径时间点并且结论关注趋势时，应生成 chart block。严禁用 ASCII 字符画、文本坐标轴或 Markdown 伪图表表示走势图。"
      : "",
    ...presentationLines,
    "",
    information,
  ].join("\n");
}

export function PrivateFundResearchWorkbench({
  datasetId,
  datasetName,
  chat,
  onGenerateNode,
  sidebarOpen = true,
  onOpenSidebar,
}: PrivateFundResearchWorkbenchProps) {
  const queryClient = useQueryClient();
  const workflowQuery = usePrivateFundWorkflow(datasetId);
  const assetsQuery = usePrivateFundAssets(datasetId);
  const workflow = workflowQuery.data;
  const assetCatalog = assetsQuery.data;
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [assetPanelExpanded, setAssetPanelExpanded] = useState(false);
  const [selectedInformation, setSelectedInformation] = useState<SelectedInformation[]>([]);
  const [presentationMode, setPresentationMode] = useState<GenerationMode>("plain_text");
  const [presentationInstruction, setPresentationInstruction] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const assets = assetCatalog?.assets ?? EMPTY_ASSETS;
  const contextAssetIds = assetCatalog?.contextAssetIds ?? EMPTY_ASSET_IDS;
  const selectedAsset = assets.find((asset) => asset.assetId === selectedAssetId);
  const selectedNode = selectedAsset?.sourceKind.startsWith("research_node")
    ? workflow?.nodes.find((node) => node.nodeId === selectedAsset.sourceId)
    : undefined;
  const selectedBlock =
    selectedAsset?.sourceKind === "research_node_block"
      ? (selectedAsset.metadata.block as PrivateFundRichContentBlock | undefined)
      : undefined;
  const selectedMemoUrl =
    (selectedAsset?.assetType === "memo" || selectedAsset?.assetType === "report") &&
    selectedAsset.storedPath &&
    ["pdf", "html"].includes(selectedAsset.format.toLowerCase())
      ? `/v1/private-fund/dataset/memo/file?path=${encodeURIComponent(selectedAsset.storedPath)}`
      : null;
  const selectedDocumentUrl =
    selectedAsset?.assetType === "document" && selectedAsset.format.toLowerCase() === "pdf"
      ? `/v1/private-fund/dataset/document/file?${new URLSearchParams({
          dataset_id: datasetId,
          file_name: selectedAsset.title,
        })}`
      : null;
  const selectedDocumentSource = useMemo<PdfSourceSelection | null>(() => {
    if (!selectedAsset || selectedAsset.assetType !== "document") return null;
    if (!["xlsx", "xls", "xlsm", "csv"].includes(selectedAsset.format.toLowerCase())) return null;
    return {
      kind: "excel",
      label: selectedAsset.title,
      workbookName: selectedAsset.title,
      datasetId,
    };
  }, [datasetId, selectedAsset]);

  const contextMutation = useMutation({
    mutationFn: (assetIds: string[]) => setPrivateFundAssetContext(datasetId, assetIds),
    onSuccess: (next) => {
      queryClient.setQueryData(["private-fund-assets", datasetId], next);
      void workflowQuery.refetch();
      setNotice("资产上下文已更新，下一次分析会携带勾选资产");
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "更新资产上下文失败"),
  });

  const saveInformationMutation = useMutation({
    mutationFn: ({ responseId, content }: SelectedInformation) =>
      savePrivateFundAsset(datasetId, {
        assetType: "information",
        title: cleanText(content).slice(0, 42) || "重要信息",
        summary: cleanText(content).slice(0, 180),
        contentMarkdown: content,
        sourceResponseId: responseId,
        tags: ["勾选信息"],
      }),
    onSuccess: (next) => queryClient.setQueryData(["private-fund-assets", datasetId], next),
    onError: (error) => setNotice(error instanceof Error ? error.message : "保存重要信息失败"),
  });

  const deleteAssetsMutation = useMutation({
    mutationFn: (assetIds: string[]) => deletePrivateFundAssets(datasetId, assetIds),
    onSuccess: (next, deletedIds) => {
      queryClient.setQueryData(["private-fund-assets", datasetId], next);
      if (deletedIds.includes(selectedAssetId)) setSelectedAssetId("");
      void Promise.all([
        workflowQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["private-fund-project", datasetId] }),
        queryClient.invalidateQueries({ queryKey: ["private-fund-projects"] }),
      ]);
      setNotice(`已删除 ${deletedIds.length} 项资产`);
    },
  });

  const selectInformation = useCallback(
    (responseId: string, content: string) => {
      const normalized = content.trim();
      if (!normalized) return;
      setSelectedInformation((current) => {
        if (current.some((item) => item.responseId === responseId && item.content === normalized)) {
          return current;
        }
        return [...current, { responseId, content: normalized }];
      });
      saveInformationMutation.mutate({ responseId, content: normalized });
      setNotice("已保存为重要信息资产，可继续勾选或让 Agent 生成新资产");
    },
    [saveInformationMutation],
  );

  const workbenchActions = useMemo<WorkbenchActionContextValue>(
    () => ({
      contextAssets: contextAssetIds
        .map((assetId) => assets.find((asset) => asset.assetId === assetId))
        .filter((asset): asset is PrivateFundAsset => Boolean(asset))
        .map((asset) => {
          const node = asset.sourceKind.startsWith("research_node")
            ? workflow?.nodes.find((item) => item.nodeId === asset.sourceId)
            : undefined;
          return {
            assetId: asset.assetId,
            assetType: asset.assetType,
            title: asset.title,
            content: cleanText(asset.contentMarkdown || asset.summary).slice(0, 2400),
            evidenceCitations: (node?.evidenceSources ?? [])
              .map((source) => source.markdownCitation || source.citation)
              .slice(0, 12),
          };
        }),
      addResearchNodeFromResponse: selectInformation,
      markUsefulInformation: selectInformation,
      pinToCurrentAssumption: selectInformation,
    }),
    [assets, contextAssetIds, selectInformation, workflow?.nodes],
  );

  const toggleContextAsset = useCallback(
    (assetId: string) => {
      const current = new Set(contextAssetIds);
      if (current.has(assetId)) current.delete(assetId);
      else current.add(assetId);
      contextMutation.mutate([...current]);
    },
    [contextAssetIds, contextMutation],
  );

  const generateNode = useCallback(() => {
    if (!workflow) return;
    const documentMode = isDocumentGenerationMode(presentationMode);
    if (!documentMode && selectedInformation.length === 0) {
      setNotice("请先在 AI 回答中勾选至少一条重要信息");
      return;
    }
    if (
      documentMode &&
      selectedInformation.length === 0 &&
      contextAssetIds.length === 0 &&
      !presentationInstruction.trim()
    ) {
      setNotice("请填写 Memo/研报主题，或先勾选信息和资产上下文");
      return;
    }
    onGenerateNode(
      buildGenerationPrompt(
        datasetId,
        selectedInformation,
        contextAssetIds
          .filter((assetId) => assetId.startsWith("node:"))
          .map((assetId) => assetId.slice(5)),
        contextAssetIds
          .map((assetId) => assets.find((asset) => asset.assetId === assetId))
          .filter((asset): asset is PrivateFundAsset => Boolean(asset)),
        presentationMode,
        presentationInstruction,
      ),
    );
    setNotice(
      presentationMode === "memo"
        ? "已调用 private-fund-memo，Agent 将核验证据并生成 Memo"
        : presentationMode === "report"
          ? "已调用 private-fund-report，Agent 将生成 FinRobot 对齐研报"
          : "已交给 Agent：它会核验信息并通过 MCP 保存新的分析资产",
    );
    setSelectedInformation([]);
    setPresentationMode("plain_text");
    setPresentationInstruction("");
    window.setTimeout(() => void workflowQuery.refetch(), 2500);
  }, [
    datasetId,
    onGenerateNode,
    presentationMode,
    presentationInstruction,
    selectedInformation,
    contextAssetIds,
    assets,
    workflow,
    workflowQuery,
  ]);

  if (workflowQuery.isLoading || assetsQuery.isLoading || !workflow || !assetCatalog) {
    return (
      <div
        aria-busy="true"
        aria-label="正在加载研究资产"
        className="flex min-h-0 flex-1 flex-col bg-[var(--pf-canvas)] text-[var(--pf-ink-secondary)]"
      >
        <div className="flex h-16 items-center gap-3 border-b border-[var(--pf-line)] bg-[var(--pf-panel)] px-4">
          <div className="size-9 animate-pulse rounded-lg bg-[var(--pf-panel-subtle)] motion-reduce:animate-none" />
          <div className="space-y-2">
            <div className="h-3 w-36 animate-pulse rounded bg-[var(--pf-line)] motion-reduce:animate-none" />
            <div className="h-2 w-52 animate-pulse rounded bg-[var(--pf-panel-subtle)] motion-reduce:animate-none" />
          </div>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(420px,46vw)]">
          <div className="space-y-3 bg-[var(--pf-panel)] p-5">
            {[72, 88, 64].map((width) => (
              <div
                className="h-20 animate-pulse rounded-xl bg-[var(--pf-panel-subtle)] motion-reduce:animate-none"
                key={width}
                style={{ width: `${width}%` }}
              />
            ))}
          </div>
          <div className="border-l border-[var(--pf-line)] bg-[var(--pf-panel)] p-4">
            <div className="h-full min-h-64 animate-pulse rounded-xl bg-[var(--pf-panel-subtle)] motion-reduce:animate-none" />
          </div>
        </div>
        <span className="sr-only">正在加载研究资产</span>
      </div>
    );
  }

  return (
    <WorkbenchActionContext.Provider value={workbenchActions}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--pf-canvas)] text-[var(--pf-ink)]">
        <header className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--pf-line)] bg-[var(--pf-panel)] px-4 py-3 lg:flex-nowrap lg:py-0">
          <div className="flex min-w-0 items-center gap-3">
            {!sidebarOpen && onOpenSidebar ? (
              <button type="button" onClick={onOpenSidebar} aria-label="打开项目栏">
                <Menu size={18} />
              </button>
            ) : null}
            <span className="flex size-9 items-center justify-center rounded-lg bg-[var(--pf-accent-soft)] text-[var(--pf-accent-ink)]">
              <Package size={18} />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">Agent 研究工作台</p>
              <p className="truncate text-xs text-[var(--pf-ink-secondary)]">
                {datasetName} / {assets.length} 项资产 / {contextAssetIds.length} 项上下文
              </p>
            </div>
          </div>
          <div className="flex max-w-full shrink-0 items-center gap-2 overflow-x-auto">
            <ThemeToggle className="shrink-0 border border-[var(--pf-line)] bg-[var(--pf-panel-raised)]" />
            <label className="relative">
              <span className="sr-only">生成结果</span>
              <select
                aria-label="生成结果"
                value={presentationMode}
                onChange={(event) => setPresentationMode(event.target.value as GenerationMode)}
                className="h-10 min-w-[132px] appearance-none rounded-lg border border-[var(--pf-line-strong)] bg-[var(--pf-panel-raised)] py-0 pl-3 pr-8 text-xs font-semibold text-[var(--pf-ink-secondary)] outline-none transition-colors hover:bg-[var(--pf-panel-subtle)] focus:border-[var(--pf-accent)] focus:ring-2 focus:ring-[var(--pf-accent-soft)]"
              >
                <optgroup label="研究资产">
                  {PRESENTATION_OPTIONS.filter(
                    (option) => !isDocumentGenerationMode(option.value),
                  ).map((option) => (
                    <option key={option.value} value={option.value} title={option.description}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="文档报告">
                  {PRESENTATION_OPTIONS.filter((option) =>
                    isDocumentGenerationMode(option.value),
                  ).map((option) => (
                    <option key={option.value} value={option.value} title={option.description}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              </select>
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-[var(--pf-ink-muted)]">
                ▾
              </span>
            </label>
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="设置资产补充要求"
                  className={cn(
                    "inline-flex size-10 items-center justify-center rounded-lg border border-[var(--pf-line-strong)] bg-[var(--pf-panel-raised)] text-[var(--pf-ink-secondary)] transition-colors hover:bg-[var(--pf-panel-subtle)] active:translate-y-px",
                    presentationInstruction.trim() &&
                      "border-[var(--pf-accent)] bg-[var(--pf-accent-soft)] text-[var(--pf-accent-ink)]",
                  )}
                >
                  <SlidersHorizontal size={14} />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[340px] p-4">
                <PopoverHeader>
                  <PopoverTitle>生成要求</PopoverTitle>
                  <PopoverDescription>
                    当前选择“
                    {
                      PRESENTATION_OPTIONS.find((option) => option.value === presentationMode)
                        ?.label
                    }
                    ”。可输入主题、关键问题、时间范围、指标或格式要求。
                  </PopoverDescription>
                </PopoverHeader>
                <label className="mt-2 block">
                  <span className="mb-1.5 block text-xs font-semibold text-[var(--pf-ink-secondary)]">
                    主题与具体要求（可选）
                  </span>
                  <Textarea
                    aria-label="生成具体要求"
                    value={presentationInstruction}
                    onChange={(event) => setPresentationInstruction(event.target.value)}
                    maxLength={500}
                    placeholder={
                      presentationMode === "memo"
                        ? "例如：生成一份聚焦海外盈利质量的 Memo，重点回答增长可持续性与风险。"
                        : presentationMode === "report"
                          ? "例如：生成完整专业研报，包含财务预测、估值、风险和证据索引。"
                          : "例如：按季度绘制海外与国内毛利率两条线，单位为%。"
                    }
                    className="min-h-20 resize-none text-xs leading-5"
                  />
                </label>
                <p className="mt-2 text-[10px] text-[var(--pf-ink-muted)]">
                  将调用：
                  <code className="font-mono text-[var(--pf-ink-secondary)]">
                    {presentationMode === "memo"
                      ? "/private-fund-memo"
                      : presentationMode === "report"
                        ? "/private-fund-report"
                        : "private_fund_research_node_save"}
                  </code>
                </p>
              </PopoverContent>
            </Popover>
            <button
              type="button"
              onClick={generateNode}
              className="inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-lg bg-[var(--pf-accent)] px-4 text-xs font-semibold text-[var(--primary-foreground)] transition-colors hover:bg-[var(--pf-accent-hover)] active:translate-y-px"
            >
              <Sparkles size={15} />
              {presentationMode === "memo"
                ? "生成 Memo"
                : presentationMode === "report"
                  ? "生成专业研报"
                  : "Agent 生成资产"}
              {selectedInformation.length > 0 ? ` (${selectedInformation.length})` : ""}
            </button>
          </div>
        </header>

        <div
          className={cn(
            "grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_minmax(420px,46vw)] lg:overflow-hidden",
            selectedAsset && assetPanelExpanded ? "grid-cols-1" : "",
          )}
        >
          <main
            aria-label="Agent 输入与输出"
            className={cn(
              "relative flex min-h-[50vh] flex-col bg-[var(--pf-panel)] lg:min-h-0",
              selectedAsset && assetPanelExpanded && "hidden",
            )}
          >
            {notice ? (
              <div
                role="status"
                className="absolute left-1/2 top-3 z-20 flex max-w-[80%] -translate-x-1/2 items-start gap-2 rounded-lg border border-[var(--pf-line)] bg-[var(--pf-success-soft)] px-3 py-2 text-xs text-[var(--pf-success-ink)] shadow-sm"
              >
                <Check size={14} className="mt-0.5 shrink-0" />
                {notice}
              </div>
            ) : null}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{chat}</div>
          </main>

          <aside className="flex min-h-[40vh] flex-col border-t border-[var(--pf-line)] bg-[var(--pf-panel)] lg:min-h-0 lg:border-t-0 lg:border-l">
            {selectedAsset ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--pf-line)] px-3">
                  <button
                    aria-label="返回资产库"
                    className="rounded-lg p-1.5 text-[var(--pf-ink-secondary)] hover:bg-[var(--pf-panel-subtle)]"
                    onClick={() => {
                      setSelectedAssetId("");
                      setAssetPanelExpanded(false);
                    }}
                    type="button"
                  >
                    <ArrowLeft size={15} />
                  </button>
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold">资产详情</p>
                    <p className="truncate text-[9px] text-[var(--pf-ink-muted)]">
                      {selectedAsset.assetId}
                    </p>
                  </div>
                  <button
                    aria-label={assetPanelExpanded ? "收起资产详情" : "展开资产详情"}
                    className="ml-auto rounded-lg p-1.5 text-[var(--pf-ink-secondary)] hover:bg-[var(--pf-panel-subtle)]"
                    onClick={() => setAssetPanelExpanded((current) => !current)}
                    type="button"
                  >
                    {assetPanelExpanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                  </button>
                  <label className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-[var(--pf-ink-secondary)]">
                    <input
                      aria-label={`将${selectedAsset.title}加入上下文`}
                      checked={contextAssetIds.includes(selectedAsset.assetId)}
                      className="size-3.5 accent-[var(--pf-accent)]"
                      disabled={contextMutation.isPending}
                      onChange={() => toggleContextAsset(selectedAsset.assetId)}
                      type="checkbox"
                    />
                    上下文
                  </label>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <div className="rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] p-4 shadow-[var(--pf-shadow)]">
                    <div>
                      <p className="text-[10px] font-semibold text-[var(--pf-ink-muted)]">
                        {selectedAsset.assetType} / {selectedAsset.format} / v
                        {selectedAsset.versionNo}
                      </p>
                      <h3 className="mt-2 text-base font-semibold">{selectedAsset.title}</h3>
                    </div>
                    <p className="mt-3 text-xs leading-5 text-[var(--pf-ink-secondary)]">
                      {selectedAsset.summary}
                    </p>
                    {selectedAsset.storedPath ? (
                      <p className="mt-3 break-all rounded-lg bg-[var(--pf-panel-subtle)] p-2 font-mono text-[9px] text-[var(--pf-ink-secondary)]">
                        {selectedAsset.storedPath}
                      </p>
                    ) : null}
                    {selectedNode ? (
                      <div className="mt-4">
                        <Suspense
                          fallback={
                            <div
                              className="h-28 animate-pulse rounded-xl bg-[var(--pf-panel-subtle)] motion-reduce:animate-none"
                              aria-label="正在加载节点内容"
                            />
                          }
                        >
                          <RichNodeContent
                            blocks={selectedBlock ? [selectedBlock] : selectedNode.contentBlocks}
                            evidenceSources={selectedNode.evidenceSources}
                            fallbackMarkdown={selectedBlock ? "" : selectedNode.latestOutput}
                          />
                        </Suspense>
                      </div>
                    ) : selectedMemoUrl && selectedAsset.format.toLowerCase() === "pdf" ? (
                      <iframe
                        className="mt-4 h-[68vh] min-h-[520px] w-full rounded-xl border border-[var(--pf-line)] bg-white"
                        src={selectedMemoUrl}
                        title={`${selectedAsset.title} PDF 预览`}
                      />
                    ) : selectedMemoUrl && selectedAsset.format.toLowerCase() === "html" ? (
                      <iframe
                        className="mt-4 h-[68vh] min-h-[520px] w-full rounded-xl border border-[var(--pf-line)] bg-white"
                        sandbox=""
                        src={selectedMemoUrl}
                        title={`${selectedAsset.title} HTML 预览`}
                      />
                    ) : selectedDocumentUrl ? (
                      <iframe
                        className="mt-4 h-[68vh] min-h-[520px] w-full rounded-xl border border-[var(--pf-line)] bg-white"
                        src={selectedDocumentUrl}
                        title={`${selectedAsset.title} PDF 预览`}
                      />
                    ) : selectedDocumentSource ? (
                      <div className="mt-4 h-[68vh] min-h-[520px] overflow-hidden rounded-xl border border-[var(--pf-line)] bg-white">
                        <PdfSourcePanel selection={selectedDocumentSource} />
                      </div>
                    ) : selectedAsset.assetType === "document" ? (
                      <ExtractedDocumentPreview
                        datasetId={datasetId}
                        fileName={selectedAsset.title}
                      />
                    ) : selectedAsset.contentMarkdown ? (
                      <FilePathAwareMessageResponse
                        breaks
                        className="mt-4 text-sm leading-6 text-[var(--pf-ink-secondary)] [&_a]:font-medium [&_a]:text-[var(--pf-accent-ink)] [&_blockquote]:border-[var(--pf-line-strong)] [&_blockquote]:bg-[var(--pf-panel-subtle)] [&_blockquote]:px-3 [&_h1]:text-xl [&_h2]:text-lg [&_h3]:text-base [&_table]:text-xs"
                      >
                        {selectedAsset.contentMarkdown}
                      </FilePathAwareMessageResponse>
                    ) : (
                      <p className="mt-4 rounded-lg border border-dashed p-3 text-xs text-[var(--pf-ink-muted)]">
                        该资产保留原文件位置，分析时由 Agent 通过数据集检索工具读取。
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <ResearchAssetLibrary
                assets={assets}
                contextAssetIds={contextAssetIds}
                contextPending={contextMutation.isPending}
                onDeleteAssets={(assetIds) =>
                  deleteAssetsMutation.mutateAsync(assetIds).then(() => undefined)
                }
                onOpenAsset={(asset) => setSelectedAssetId(asset.assetId)}
                onSetContext={(assetIds) => contextMutation.mutate(assetIds)}
                onToggleContext={toggleContextAsset}
              />
            )}
          </aside>
        </div>
      </div>
    </WorkbenchActionContext.Provider>
  );
}
