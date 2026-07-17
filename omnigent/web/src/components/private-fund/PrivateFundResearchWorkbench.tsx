import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BellRing,
  BookOpen,
  Calculator,
  Check,
  Columns2,
  FileStack,
  History,
  Loader2,
  Menu,
  MessageSquareText,
  NotebookPen,
  Package,
  PanelTop,
} from "lucide-react";
import {
  createContext,
  lazy,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  usePrivateFundAssets,
  usePrivateFundProject,
  usePrivateFundWorkflow,
} from "@/hooks/usePrivateFundProjects";
import {
  type PrivateFundAsset,
  type PrivateFundAssetCatalog,
  deletePrivateFundAssets,
  savePrivateFundAsset,
  setPrivateFundAssetContext,
  wrapPrivateFundPromptContext,
} from "@/lib/privateFundApi";
import { cn } from "@/lib/utils";
import {
  generatePrivateFundPromptSuggestions,
  type PrivateFundPromptSuggestion,
} from "@/lib/privateFundPromptSuggestions";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { PdfSourcePanel } from "@/shell/PdfSourcePanel";
import type { PdfSourceSelection } from "@/shell/FileViewerContext";
import { ResearchAssetLibrary } from "./ResearchAssetLibrary";
import { PrivateFundHistoryPanel } from "./PrivateFundHistoryPanel";
import { PrivateFundTrackingPanel } from "./PrivateFundTrackingPanel";
import { PrivateFundValuationTrackingPanel } from "./PrivateFundValuationTrackingPanel";
import { FilePathAwareMessageResponse } from "@/components/blocks/BlockRenderer";
import { hostFetch } from "@/lib/host";
import { usePrivateFundWorkspaceStore } from "@/store/privateFundWorkspaceStore";

const RichNodeContent = lazy(() =>
  import("./RichNodeContent").then((module) => ({ default: module.RichNodeContent })),
);

const EMPTY_ASSETS: PrivateFundAsset[] = [];
const EMPTY_ASSET_IDS: string[] = [];
const EMPTY_RECENT_USER_MESSAGES: string[] = [];

type SelectedInformation = { responseId: string; content: string };
type SaveInformationInput = SelectedInformation & { optimisticAssetId: string };
type PresentationMode = "plain_text" | "table" | "chart";
export type PrivateFundGenerationMode = PresentationMode | "memo";
type WorkspaceView =
  | "research"
  | "sources"
  | "notes"
  | "memos"
  | "valuation"
  | "history"
  | "tracking";

export const PRIVATE_FUND_GENERATION_OPTIONS: Array<{
  value: PrivateFundGenerationMode;
  label: string;
  description: string;
}> = [
  { value: "plain_text", label: "文本", description: "生成长期可读的研究文本" },
  { value: "table", label: "表格", description: "生成精确的期间或对象对比表" },
  { value: "chart", label: "图表", description: "由模型选择图形并生成图文研究笔记" },
  { value: "memo", label: "Memo", description: "调用 private-fund-memo 生成聚焦报告" },
];

type WorkspaceViewMeta = {
  value: WorkspaceView;
  label: string;
  icon: typeof BookOpen;
};

/** Always available in the top tab strip (main work surfaces). */
const PRIMARY_WORKSPACE_VIEWS: WorkspaceViewMeta[] = [
  { value: "research", label: "研究", icon: MessageSquareText },
  { value: "sources", label: "资料", icon: FileStack },
];

/** Tools that live in the side rail under 侧栏布局 (and secondary tabs under 顶部标签). */
const SECONDARY_WORKSPACE_VIEWS: WorkspaceViewMeta[] = [
  { value: "notes", label: "笔记", icon: BookOpen },
  { value: "memos", label: "Memo", icon: NotebookPen },
  { value: "valuation", label: "估值跟踪", icon: Calculator },
  { value: "history", label: "历史变化", icon: History },
  { value: "tracking", label: "追踪提醒", icon: BellRing },
];

/** Open beside chat in the side panel (not 研究/资料). */
const SIDE_PANEL_VIEWS = new Set<WorkspaceView>(["notes", "memos"]);
/** Take over the main area when selected. */
const FULL_MAIN_VIEWS = new Set<WorkspaceView>(["valuation", "history", "tracking"]);

export type WorkbenchChromeMode = "tabs" | "ide";
const WORKBENCH_CHROME_STORAGE_KEY = "omnigent.privateFund.workbenchChrome";
const IDE_PANEL_WIDTH_KEY = "omnigent.privateFund.idePanelWidth";
const IDE_PANEL_DEFAULT_WIDTH = 360;
const IDE_PANEL_MIN_WIDTH = 280;
const IDE_PANEL_MAX_WIDTH = 560;

function readChromeMode(): WorkbenchChromeMode {
  try {
    const raw = window.localStorage.getItem(WORKBENCH_CHROME_STORAGE_KEY);
    if (raw === "tabs" || raw === "ide") return raw;
  } catch {
    /* ignore */
  }
  return "ide";
}

function readIdePanelWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem(IDE_PANEL_WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= IDE_PANEL_MIN_WIDTH && raw <= IDE_PANEL_MAX_WIDTH) {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return IDE_PANEL_DEFAULT_WIDTH;
}

function isDocumentGenerationMode(mode: PrivateFundGenerationMode): mode is "memo" {
  return mode === "memo";
}

export type WorkbenchActionContextValue = {
  contextAssets: Array<{
    assetId: string;
    assetType: string;
    title: string;
    content: string;
    evidenceCitations: string[];
    displayLabel?: string;
  }>;
  contextAssetIds: string[];
  removeContextAsset: (assetId: string) => void;
  addResearchNodeFromResponse: (responseId: string, content: string) => void;
  markUsefulInformation: (responseId: string, content: string) => void;
  pinToCurrentAssumption: (responseId: string, content: string) => void;
  generationMode: PrivateFundGenerationMode;
  generationInstruction: string;
  selectedInformationCount: number;
  promptSuggestions: PrivateFundPromptSuggestion[];
  setGenerationMode: (mode: PrivateFundGenerationMode) => void;
  setGenerationInstruction: (instruction: string) => void;
  generateAsset: () => void;
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
  hasConversationContext?: boolean;
  recentUserMessages?: string[];
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

function assetNeedsWidePreview(asset: PrivateFundAsset): boolean {
  return (
    ["table", "chart", "infographic", "memo", "report"].includes(asset.assetType) ||
    ["html", "pdf", "xlsx", "xls", "xlsm", "csv"].includes(asset.format.toLowerCase())
  );
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
      <p className="mb-3 text-xs text-[var(--pf-ink-muted)]">
        Pipeline 解析预览 / {state.payload.chunk_count} 个片段
        {state.payload.truncated ? " / 内容较长，已截断" : ""}
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
  hasConversationContext: boolean,
  presentationMode: PrivateFundGenerationMode,
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
    const defaultInstruction = "基于当前会话、勾选信息和所选资产生成一份聚焦研究 Memo。";
    const hiddenContext = [
      `dataset_id: ${datasetId}`,
      "必须调用 private_fund_dataset_memo，返回 Markdown、HTML 和 PDF。",
      "所有重大事实和数字必须通过数据集工具核验；无法绑定 evidence_id 的内容标记为“资料未覆盖/待复核”。",
      hasConversationContext
        ? "当前会话也是本次生成依据：请结合对话中的用户问题、@raw/[Attached:] 附件和已有回答；其中的重大事实和数字仍须通过数据集工具重新核验。"
        : "",
      information ? `\n用户保存的回答笔记:\n${information}` : "",
      context ? `\n用户选择的问题上下文:\n${context}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return `/private-fund-memo ${presentationInstruction.trim() || defaultInstruction}\n${wrapPrivateFundPromptContext(hiddenContext)}`.trim();
  }
  const modeLabel = PRIVATE_FUND_GENERATION_OPTIONS.find(
    (option) => option.value === presentationMode,
  )?.label;
  const modeInstructions: Record<PresentationMode, string[]> = {
    plain_text: [
      "本次节点使用普通文本呈现。",
      "- 只保存 content_markdown，不要生成 content_blocks；正文保持清晰、可引用和长期可读。",
    ],
    table: ["- 必须加入 table block，列名、行名、单位和口径应明确，保留精确值。"],
    chart: [
      "- 必须加入且只加入一个 html block，生成完整的图文可视化；不要用 chart block、ASCII 字符画、Markdown 伪图表或代码块代替。",
      "- 你必须根据数据关系自主选择最合适的图形，可选折线图、柱状图、饼图/环形图、面积图、散点图、雷达图、瀑布图或热力图；不要让用户预先指定图表类型。",
      "- html 字段必须是自包含的 HTML/CSS/JavaScript：把已核验数据写入内联 JavaScript，使用原生 SVG 或 Canvas 绘图，并同时包含标题、核心结论、图例、单位、数据口径和来源说明。",
      "- 禁止任何外部依赖、CDN、fetch、XHR、WebSocket、远程图片、表单、导航、下载、localStorage 或访问 parent/top；不得使用定时轮询或无界循环。",
      "- 图文应响应式适配容器，并为关键数值提供可读文字或数据表回退。html block 的 evidence_ids 必须覆盖图中使用的每个数值。",
    ],
  };
  const presentationLines = [
    `本次节点输出形式: ${modeLabel}`,
    ...modeInstructions[presentationMode],
    presentationInstruction.trim() ? `- 用户补充要求: ${presentationInstruction.trim()}` : "",
    presentationMode !== "plain_text"
      ? "- 如果资料不足以可靠生成指定结构，必须说明缺少哪些期间、指标或口径，不得虚构数据。"
      : "",
    presentationMode === "chart"
      ? '- html block 示例结构: {"type":"html","title":"盈利趋势与结构","html":"<section>...<svg id=\\"chart\\"></svg><script>const data=[...];/* 原生 SVG/Canvas 绘图 */</script></section>","height":520,"evidence_ids":["真实 evidence_id"]}'
      : "",
    presentationMode !== "plain_text"
      ? "- 保存成功后，聊天中只需报告节点 ID、资产类型和证据缺口，不要重复粘贴完整表格或 HTML。"
      : "",
  ].filter(Boolean);
  return [
    "请基于当前会话和我选择的资产生成一条新的研究笔记。",
    `dataset_id: ${datasetId}`,
    `作为分析依据的父节点: ${parentNodeIds.length > 0 ? parentNodeIds.join(", ") : "无"}`,
    "你需要根据内容自行决定节点标题、node_type、摘要、标签和置信度，不要套用预设研究流程。",
    "每个重大事实、日期、事件、金额、比例、估值输入，以及 metrics/table/chart 中的每个数值，都必须使用 private_fund_dataset_search 检索，并用 private_fund_source_detail 核验决定性证据。",
    "必须调用 private_fund_research_node_save 保存节点；不要只在聊天中输出节点草稿。",
    "content_markdown 必须包含：结论、支持信息与引用、不确定性或反证、下一步问题，作为长期可读的文本回退。每个受支持的关键陈述后必须紧跟 evidence 返回的 markdown_citation。",
    "private_fund_research_node_save 的 evidence_ids 必须包含本节点实际核验并使用的全部证据；每个富内容 block 还要用 evidence_ids 绑定直接支持它的证据。无法绑定真实证据的内容必须标注“资料未覆盖/待复核”，不得作为已验证结论或图表数值。",
    presentationMode === "table"
      ? "本次 content_blocks 只保存 table block；不要为了视觉效果虚构数字。"
      : presentationMode === "chart"
        ? "本次 content_blocks 只保存一个可执行但完全自包含的 html block；它会在禁止联网和父页面访问的 sandbox iframe 中运行。"
        : "文本模式下不要保存 content_blocks，仅正文即可。",
    ...presentationLines,
    "",
    hasConversationContext
      ? "当前会话也是本次生成依据：请结合对话中的用户问题、@raw/[Attached:] 附件和已有回答；其中的重大事实和数字仍须通过数据集工具重新核验。"
      : "",
    information ? `用户保存的回答笔记:\n${information}` : "",
    context ? `用户选择的问题上下文:\n${context}` : "",
  ].join("\n");
}

export function PrivateFundResearchWorkbench({
  conversationId: _conversationId,
  datasetId,
  datasetName,
  chat,
  hasConversationContext = false,
  recentUserMessages = EMPTY_RECENT_USER_MESSAGES,
  onGenerateNode,
  sidebarOpen = true,
  onOpenSidebar,
}: PrivateFundResearchWorkbenchProps) {
  void _conversationId;
  const queryClient = useQueryClient();
  const workflowQuery = usePrivateFundWorkflow(datasetId);
  const assetsQuery = usePrivateFundAssets(datasetId);
  const projectQuery = usePrivateFundProject(datasetId);
  const workflow = workflowQuery.data;
  const assetCatalog = assetsQuery.data;
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [returnToResearchAfterPreview, setReturnToResearchAfterPreview] = useState(false);
  const [, setAssetPanelExpanded] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("research");
  const [chromeMode, setChromeMode] = useState<WorkbenchChromeMode>(() =>
    typeof window === "undefined" ? "ide" : readChromeMode(),
  );
  const [idePanelWidth, setIdePanelWidth] = useState(() =>
    typeof window === "undefined" ? IDE_PANEL_DEFAULT_WIDTH : readIdePanelWidth(),
  );
  const [idePanelOpen, setIdePanelOpen] = useState(true);
  const [sidePanelKind, setSidePanelKind] = useState<"notes" | "memos">("notes");
  const ideResizeDrag = useRef<{ startX: number; startWidth: number } | null>(null);
  const [selectedInformation, setSelectedInformation] = useState<SelectedInformation[]>([]);
  const [presentationMode, setPresentationMode] = useState<PrivateFundGenerationMode>("plain_text");
  const [presentationInstruction, setPresentationInstruction] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const documentPreviewRequest = usePrivateFundWorkspaceStore(
    (state) => state.documentPreviewRequest,
  );
  const clearDocumentPreview = usePrivateFundWorkspaceStore(
    (state) => state.clearDocumentPreview,
  );
  const handledPreviewRequestId = useRef(0);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const assets = assetCatalog?.assets ?? EMPTY_ASSETS;
  const contextAssetIds = assetCatalog?.contextAssetIds ?? EMPTY_ASSET_IDS;
  const promptSuggestions = useMemo(
    () =>
      projectQuery.data
        ? generatePrivateFundPromptSuggestions({
            companyName: projectQuery.data.project.companyName || datasetName,
            files: projectQuery.data.files,
            assets,
            recentUserMessages,
          })
        : [],
    [assets, datasetName, projectQuery.data, recentUserMessages],
  );
  const selectedAsset = assets.find((asset) => asset.assetId === selectedAssetId);
  const selectedNode = selectedAsset?.sourceKind.startsWith("research_node")
    ? workflow?.nodes.find((node) => node.nodeId === selectedAsset.sourceId)
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

  const isIde = chromeMode === "ide";
  const sidePanelView = sidePanelKind;
  const showIdeSidePanel =
    isIde && idePanelOpen && !FULL_MAIN_VIEWS.has(workspaceView) && !selectedAsset;
  // Tabs: chat only on research. IDE: chat stays while side panel views are active.
  // 对话仅在「研究」主区展示；侧栏打开笔记/Memo 时 workspaceView 仍为 research。
  const mainShowsChat = !selectedAsset && workspaceView === "research";

  useEffect(() => {
    try {
      window.localStorage.setItem(WORKBENCH_CHROME_STORAGE_KEY, chromeMode);
    } catch {
      /* ignore */
    }
  }, [chromeMode]);

  useEffect(() => {
    try {
      window.localStorage.setItem(IDE_PANEL_WIDTH_KEY, String(idePanelWidth));
    } catch {
      /* ignore */
    }
  }, [idePanelWidth]);

  const selectWorkspaceView = useCallback(
    (next: WorkspaceView) => {
      setReturnToResearchAfterPreview(false);
      setSelectedAssetId("");
      setAssetPanelExpanded(false);
      if (chromeMode === "ide") {
        // 笔记 / Memo → 侧栏，主区保持对话
        if (SIDE_PANEL_VIEWS.has(next)) {
          setSidePanelKind(next as "notes" | "memos");
          setIdePanelOpen(true);
          setWorkspaceView("research");
          return;
        }
        // 研究 / 资料 → 主区切换（资料用于预览）；侧栏可保持打开
        if (next === "research" || next === "sources") {
          setWorkspaceView(next);
          return;
        }
        // 估值 / 历史 / 追踪 → 主区全屏，收起侧栏
        setWorkspaceView(next);
        setIdePanelOpen(false);
        return;
      }
      setWorkspaceView(next);
    },
    [chromeMode],
  );

  const onIdeResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      ideResizeDrag.current = { startX: event.clientX, startWidth: idePanelWidth };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [idePanelWidth],
  );

  const onIdeResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = ideResizeDrag.current;
    if (!drag) return;
    const delta = drag.startX - event.clientX;
    const next = Math.min(
      IDE_PANEL_MAX_WIDTH,
      Math.max(IDE_PANEL_MIN_WIDTH, drag.startWidth + delta),
    );
    setIdePanelWidth(next);
  }, []);

  const onIdeResizePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    ideResizeDrag.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  const openAsset = useCallback((asset: PrivateFundAsset) => {
    setReturnToResearchAfterPreview(false);
    setSelectedAssetId(asset.assetId);
    setAssetPanelExpanded(assetNeedsWidePreview(asset));
  }, []);

  useEffect(() => {
    if (
      !documentPreviewRequest ||
      documentPreviewRequest.datasetId !== datasetId ||
      documentPreviewRequest.requestId === handledPreviewRequestId.current
    ) {
      return;
    }
    const documentAsset = assets.find(
      (asset) =>
        asset.assetType === "document" &&
        (asset.title === documentPreviewRequest.fileName ||
          asset.metadata.fileName === documentPreviewRequest.fileName ||
          asset.metadata.file_name === documentPreviewRequest.fileName),
    );
    if (!documentAsset) return;
    handledPreviewRequestId.current = documentPreviewRequest.requestId;
    setReturnToResearchAfterPreview(true);
    setWorkspaceView("sources");
    setSelectedAssetId(documentAsset.assetId);
    setAssetPanelExpanded(assetNeedsWidePreview(documentAsset));
    clearDocumentPreview(documentPreviewRequest.requestId);
  }, [assets, clearDocumentPreview, datasetId, documentPreviewRequest]);

  const contextMutation = useMutation({
    mutationFn: (assetIds: string[]) => setPrivateFundAssetContext(datasetId, assetIds),
    onSuccess: (next) => {
      queryClient.setQueryData(["private-fund-assets", datasetId], next);
      void workflowQuery.refetch();
      setNotice("问题上下文已更新，下一次提问或生成会使用已选项");
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "更新对话上下文失败"),
  });

  const saveInformationMutation = useMutation({
    mutationFn: ({ responseId, content }: SaveInformationInput) =>
      savePrivateFundAsset(datasetId, {
        assetType: "information",
        title: cleanText(content).slice(0, 42) || "回答笔记",
        summary: cleanText(content).slice(0, 180),
        contentMarkdown: content,
        sourceResponseId: responseId,
        tags: ["回答笔记"],
      }),
    onMutate: async ({ responseId, content, optimisticAssetId }) => {
      const queryKey = ["private-fund-assets", datasetId] as const;
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<PrivateFundAssetCatalog>(queryKey);
      const now = new Date().toISOString();
      const optimisticAsset: PrivateFundAsset = {
        assetId: optimisticAssetId,
        assetType: "information",
        title: cleanText(content).slice(0, 42) || "回答笔记",
        summary: cleanText(content).slice(0, 180),
        contentMarkdown: content,
        format: "markdown",
        status: "saving",
        sourceKind: "saved_information",
        sourceId: responseId,
        tags: ["回答笔记"],
        createdAt: now,
        updatedAt: now,
        versionNo: 1,
        evidenceCount: 0,
        metadata: { optimistic: true },
        displayGroup: "answer_note",
        displayLabel: "回答笔记",
      };
      queryClient.setQueryData<PrivateFundAssetCatalog>(queryKey, {
        assets: [
          optimisticAsset,
          ...(previous?.assets ?? assets).filter((asset) => asset.assetId !== optimisticAssetId),
        ],
        contextAssetIds: previous?.contextAssetIds ?? contextAssetIds,
      });
      return { optimisticAssetId };
    },
    onSuccess: (next, variables) => {
      queryClient.setQueryData<PrivateFundAssetCatalog>(
        ["private-fund-assets", datasetId],
        (current) => ({
          ...next,
          assets: [
            ...(current?.assets ?? []).filter(
              (asset) =>
                asset.metadata.optimistic === true && asset.assetId !== variables.optimisticAssetId,
            ),
            ...next.assets,
          ],
        }),
      );
    },
    onError: (error, _variables, mutationContext) => {
      if (mutationContext?.optimisticAssetId) {
        queryClient.setQueryData<PrivateFundAssetCatalog>(
          ["private-fund-assets", datasetId],
          (current) =>
            current
              ? {
                  ...current,
                  assets: current.assets.filter(
                    (asset) => asset.assetId !== mutationContext.optimisticAssetId,
                  ),
                }
              : current,
        );
      }
      setNotice(error instanceof Error ? error.message : "保存回答笔记失败");
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["private-fund-assets", datasetId] }),
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
      setNotice(`已删除 ${deletedIds.length} 项`);
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
      saveInformationMutation.mutate({
        responseId,
        content: normalized,
        optimisticAssetId: `pending-information:${responseId}:${Date.now()}`,
      });
      setNotice("已保存为回答笔记");
    },
    [saveInformationMutation],
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
    const contextAssets = contextAssetIds
      .map((assetId) => assets.find((asset) => asset.assetId === assetId))
      .filter((asset): asset is PrivateFundAsset => Boolean(asset));
    if (
      !documentMode &&
      !hasConversationContext &&
      selectedInformation.length === 0 &&
      contextAssets.length === 0
    ) {
      setNotice("请先提供对话内容，或选择至少一项上下文");
      return;
    }
    if (
      documentMode &&
      selectedInformation.length === 0 &&
      contextAssetIds.length === 0 &&
      !hasConversationContext &&
      !presentationInstruction.trim()
    ) {
      setNotice("请填写 Memo/研报主题，或先选择至少一项上下文");
      return;
    }
    onGenerateNode(
      buildGenerationPrompt(
        datasetId,
        selectedInformation,
        contextAssets
          .filter((asset) => asset.sourceKind.startsWith("research_node"))
          .map((asset) => asset.sourceId)
          .filter((sourceId): sourceId is string => Boolean(sourceId)),
        contextAssets,
        hasConversationContext,
        presentationMode,
        presentationInstruction,
      ),
    );
    setNotice(
      presentationMode === "memo"
        ? "已调用 private-fund-memo，Agent 将核验证据并生成 Memo"
        : "已交给 Agent：它会核验信息并保存为研究笔记",
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
    hasConversationContext,
    contextAssetIds,
    assets,
    workflow,
    workflowQuery,
  ]);

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
            displayLabel: asset.displayLabel,
          };
        }),
      contextAssetIds,
      removeContextAsset: (assetId: string) => {
        contextMutation.mutate(contextAssetIds.filter((id) => id !== assetId));
      },
      addResearchNodeFromResponse: selectInformation,
      markUsefulInformation: selectInformation,
      pinToCurrentAssumption: selectInformation,
      generationMode: presentationMode,
      generationInstruction: presentationInstruction,
      selectedInformationCount: selectedInformation.length,
      promptSuggestions,
      setGenerationMode: setPresentationMode,
      setGenerationInstruction: setPresentationInstruction,
      generateAsset: generateNode,
    }),
    [
      assets,
      contextAssetIds,
      contextMutation,
      generateNode,
      presentationInstruction,
      presentationMode,
      promptSuggestions,
      selectInformation,
      selectedInformation.length,
      workflow?.nodes,
    ],
  );

  if (workflowQuery.isLoading || assetsQuery.isLoading || !workflow || !assetCatalog) {
    return (
      <div
        aria-busy="true"
        aria-label="正在加载研究工作台"
        className="private-fund-research-workbench flex min-h-0 flex-1 flex-col bg-[var(--pf-canvas)] text-[var(--pf-ink-secondary)]"
      >
        <div className="flex h-14 items-center gap-3 border-b border-[var(--pf-line)] bg-[var(--pf-panel)] px-4">
          <div className="size-9 animate-pulse rounded-lg bg-[var(--pf-panel-subtle)] motion-reduce:animate-none" />
          <div className="space-y-2">
            <div className="h-3 w-36 animate-pulse rounded bg-[var(--pf-line)] motion-reduce:animate-none" />
            <div className="h-2 w-52 animate-pulse rounded bg-[var(--pf-panel-subtle)] motion-reduce:animate-none" />
          </div>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 space-y-3 bg-[var(--pf-panel)] p-5">
            {[72, 88, 64].map((width) => (
              <div
                className="h-20 animate-pulse rounded-xl bg-[var(--pf-panel-subtle)] motion-reduce:animate-none"
                key={width}
                style={{ width: `${width}%` }}
              />
            ))}
          </div>
          <div className="hidden w-12 shrink-0 border-l border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] xl:block" />
        </div>
      </div>
    );
  }

  const renderLibraryPanel = (view: WorkspaceView, compact = false) => {
    const assetsForView =
      view === "sources"
        ? assets.filter((asset) => asset.assetType === "document")
        : view === "memos"
          ? assets.filter((asset) => asset.assetType === "memo")
          : view === "notes"
            ? assets.filter(
                (asset) =>
                  asset.assetType === "information" ||
                  asset.assetType === "analysis" ||
                  asset.displayGroup === "answer_note" ||
                  asset.displayGroup === "research_note",
              )
            : assets.filter((asset) => asset.assetType !== "report");
    const zone =
      view === "sources" ? "sources" : view === "notes" ? "notes" : view === "memos" ? "memos" : "generic";
    return (
      <ResearchAssetLibrary
        key={`${view}-${compact ? "c" : "f"}`}
        assets={assetsForView}
        compact={compact}
        contextAssetIds={contextAssetIds}
        contextPending={contextMutation.isPending}
        zone={zone}
        description={
          view === "sources"
            ? `${assetsForView.length} 份资料，勾选后加入问题上下文`
            : view === "memos"
              ? `${assetsForView.length} 份 Memo`
              : `${assetsForView.length} 条笔记（回答笔记与研究笔记）`
        }
        emptyMessage={
          view === "sources"
            ? "当前项目还没有资料。请从左侧资料来源上传文档。"
            : view === "memos"
              ? "还没有 Memo。在研究区选择 Memo 并生成。"
              : "还没有笔记。可在对话中保存回答笔记，或生成研究笔记。"
        }
        onDeleteAssets={(assetIds) =>
          deleteAssetsMutation.mutateAsync(assetIds).then(() => undefined)
        }
        onOpenAsset={openAsset}
        onSetContext={(assetIds) =>
          contextMutation.mutateAsync(assetIds).then(() => undefined)
        }
        title={view === "sources" ? "资料" : view === "memos" ? "Memo" : "笔记"}
      />
    );
  };

  const renderMainWorkspace = () => {
    if (selectedAsset) {
      return (
        <div className="flex min-h-0 flex-1 flex-col animate-in fade-in duration-200">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--pf-line)] px-3">
            <button
              aria-label="返回列表"
              className="flex size-9 items-center justify-center rounded-lg text-[var(--pf-ink-secondary)] transition-colors hover:bg-[var(--pf-panel-subtle)]"
              onClick={() => {
                if (returnToResearchAfterPreview) setWorkspaceView("research");
                setReturnToResearchAfterPreview(false);
                setSelectedAssetId("");
                setAssetPanelExpanded(false);
              }}
              type="button"
            >
              <ArrowLeft size={15} />
            </button>
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold">详情</p>
              <p className="truncate text-[11px] text-[var(--pf-ink-muted)]">
                {selectedAsset.displayLabel || selectedAsset.assetType}
              </p>
            </div>
            <label className="ml-auto inline-flex items-center gap-1.5 text-[11px] font-semibold text-[var(--pf-ink-secondary)]">
              <input
                aria-label={`将${selectedAsset.title}加入问题上下文`}
                checked={contextAssetIds.includes(selectedAsset.assetId)}
                className="size-3.5 accent-[var(--pf-accent)]"
                disabled={contextMutation.isPending}
                onChange={() => toggleContextAsset(selectedAsset.assetId)}
                type="checkbox"
              />
              加入上下文
            </label>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <article className="mx-auto w-full max-w-4xl">
              <div>
                <p className="text-xs font-medium text-[var(--pf-ink-muted)]">
                  {selectedAsset.displayLabel}
                  {selectedAsset.versionNo ? ` · v${selectedAsset.versionNo}` : ""}
                </p>
                <h3 className="mt-2 text-base font-semibold">{selectedAsset.title}</h3>
              </div>
              <p className="mt-3 text-xs leading-5 text-[var(--pf-ink-secondary)]">
                {selectedAsset.summary}
              </p>
              {selectedNode ? (
                <div className="mt-4 min-w-0 overflow-x-auto">
                  <Suspense
                    fallback={
                      <div
                        className="h-28 animate-pulse rounded-xl bg-[var(--pf-panel-subtle)] motion-reduce:animate-none"
                        aria-label="正在加载笔记内容"
                      />
                    }
                  >
                    <RichNodeContent
                      blocks={selectedNode.contentBlocks}
                      evidenceSources={selectedNode.evidenceSources}
                      fallbackMarkdown={selectedNode.latestOutput}
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
                <ExtractedDocumentPreview datasetId={datasetId} fileName={selectedAsset.title} />
              ) : selectedAsset.contentMarkdown ? (
                <FilePathAwareMessageResponse
                  breaks
                  className="mt-4 text-sm leading-6 text-[var(--pf-ink-secondary)] [&_a]:font-medium [&_a]:text-[var(--pf-accent-ink)] [&_blockquote]:border-[var(--pf-line-strong)] [&_blockquote]:bg-[var(--pf-panel-subtle)] [&_blockquote]:px-3 [&_h1]:text-xl [&_h2]:text-lg [&_h3]:text-base [&_table]:text-xs"
                >
                  {selectedAsset.contentMarkdown}
                </FilePathAwareMessageResponse>
              ) : (
                <p className="mt-4 rounded-lg border border-dashed p-3 text-xs text-[var(--pf-ink-muted)]">
                  该资料保留原文件位置，分析时由 Agent 通过数据集检索工具读取。
                </p>
              )}
            </article>
          </div>
        </div>
      );
    }
    if (mainShowsChat) return chat;
    if (workspaceView === "history") return <PrivateFundHistoryPanel datasetId={datasetId} />;
    if (workspaceView === "valuation")
      return <PrivateFundValuationTrackingPanel datasetId={datasetId} />;
    if (workspaceView === "tracking") return <PrivateFundTrackingPanel datasetId={datasetId} />;
    return renderLibraryPanel(workspaceView);
  };

  return (
    <WorkbenchActionContext.Provider value={workbenchActions}>
      <div className="private-fund-research-workbench flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--pf-canvas)] text-[var(--pf-ink)]">
        <header className="private-fund-workbench-header flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-[var(--pf-line)] bg-[var(--pf-panel)] px-3 py-2.5 xl:flex-nowrap xl:px-4 xl:py-0">
          <div className="flex min-w-0 items-center gap-3">
            {!sidebarOpen && onOpenSidebar ? (
              <button
                type="button"
                onClick={onOpenSidebar}
                aria-label="打开项目栏"
                className="flex size-9 items-center justify-center rounded-lg text-[var(--pf-ink-secondary)] transition-colors hover:bg-[var(--pf-panel-subtle)]"
              >
                <Menu size={18} />
              </button>
            ) : null}
            <span className="flex size-9 items-center justify-center rounded-lg bg-[var(--pf-accent-soft)] text-[var(--pf-accent-ink)]">
              <Package size={18} />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">私募研究工作台</p>
              <p className="truncate text-xs text-[var(--pf-ink-secondary)]">
                {datasetName} · 上下文 {contextAssetIds.length} 项
              </p>
            </div>
          </div>

          <div className="private-fund-workbench-tabs order-3 flex w-full min-w-0 items-center gap-2 overflow-x-auto xl:order-none xl:ml-4 xl:w-auto">
            {/* 主工作区：研究对话 + 资料预览 */}
            <nav
              aria-label="主工作区"
              className="flex shrink-0 items-center gap-0.5 rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] p-1 shadow-[var(--pf-shadow)]"
            >
              {PRIMARY_WORKSPACE_VIEWS.map((item) => {
                const Icon = item.icon;
                const active = workspaceView === item.value;
                return (
                  <button
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)] active:translate-y-px",
                      active
                        ? "bg-[var(--pf-accent)] text-[var(--primary-foreground)] shadow-sm"
                        : "text-[var(--pf-ink-secondary)] hover:bg-[var(--pf-panel-subtle)] hover:text-[var(--pf-ink)]",
                    )}
                    key={item.value}
                    onClick={() => selectWorkspaceView(item.value)}
                    type="button"
                  >
                    <Icon className="size-3.5" />
                    {item.label}
                  </button>
                );
              })}
            </nav>

            {/* 顶部标签布局：其余功能仍在顶栏，样式弱一级 */}
            {!isIde ? (
              <>
                <span
                  aria-hidden
                  className="mx-0.5 hidden h-5 w-px shrink-0 bg-[var(--pf-line-strong)] sm:block"
                />
                <nav
                  aria-label="扩展工作区"
                  className="flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-lg bg-[var(--pf-panel-subtle)] p-1"
                >
                  {SECONDARY_WORKSPACE_VIEWS.map((item) => {
                    const Icon = item.icon;
                    const active = workspaceView === item.value;
                    return (
                      <button
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-[var(--pf-ink-muted)] transition-all duration-200 hover:text-[var(--pf-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)] active:translate-y-px",
                          active &&
                            "bg-[var(--pf-panel-raised)] text-[var(--pf-ink)] shadow-[var(--pf-shadow)]",
                        )}
                        key={item.value}
                        onClick={() => selectWorkspaceView(item.value)}
                        type="button"
                      >
                        <Icon className="size-3.5 opacity-80" />
                        {item.label}
                      </button>
                    );
                  })}
                </nav>
              </>
            ) : null}
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <div
              className="flex rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] p-0.5"
              role="group"
              aria-label="工作台布局"
            >
              <button
                type="button"
                aria-pressed={!isIde}
                title="顶部标签布局"
                aria-label="顶部标签布局"
                className={cn(
                  "flex size-8 items-center justify-center rounded-md text-[var(--pf-ink-muted)] transition-all duration-200 hover:text-[var(--pf-ink)]",
                  !isIde &&
                    "bg-[var(--pf-panel-raised)] text-[var(--pf-accent-ink)] shadow-sm",
                )}
                onClick={() => setChromeMode("tabs")}
              >
                <PanelTop className="size-3.5" />
              </button>
              <button
                type="button"
                aria-pressed={isIde}
                title="侧栏布局"
                aria-label="侧栏布局"
                className={cn(
                  "flex size-8 items-center justify-center rounded-md text-[var(--pf-ink-muted)] transition-all duration-200 hover:text-[var(--pf-ink)]",
                  isIde &&
                    "bg-[var(--pf-panel-raised)] text-[var(--pf-accent-ink)] shadow-sm",
                )}
                onClick={() => {
                  setChromeMode("ide");
                  if (SIDE_PANEL_VIEWS.has(workspaceView)) {
                    setSidePanelKind(workspaceView as "notes" | "memos");
                    setIdePanelOpen(true);
                    setWorkspaceView("research");
                  } else if (workspaceView === "research" || workspaceView === "sources") {
                    // keep current primary surface; leave panel state as-is
                  } else {
                    setIdePanelOpen(false);
                  }
                }}
              >
                <Columns2 className="size-3.5" />
              </button>
            </div>
            <ThemeToggle className="shrink-0 border border-[var(--pf-line)] bg-[var(--pf-panel-raised)]" />
          </div>
        </header>

        <div
          data-testid="private-fund-workbench-grid"
          className={cn(
            "flex min-h-0 flex-1 overflow-hidden",
            isIde ? "flex-row" : "flex-col",
          )}
        >
          <main
            aria-label={
              mainShowsChat
                ? "Agent 输入与输出"
                : workspaceView === "notes"
                  ? "笔记"
                  : workspaceView === "sources"
                    ? "资料"
                    : "工作区"
            }
            className={cn(
              "relative flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--pf-panel)] transition-[flex,width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
              mainShowsChat && "private-fund-ai-panel",
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
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {renderMainWorkspace()}
            </div>
          </main>

          {/* IDE side panel */}
          <aside
            data-testid="private-fund-ide-side-panel"
            aria-label="工作台侧栏"
            aria-hidden={!showIdeSidePanel}
            className={cn(
              "relative flex min-h-0 shrink-0 flex-col border-[var(--pf-line)] bg-[var(--pf-panel)]",
              "transition-[width,opacity,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
              "motion-reduce:transition-none",
              showIdeSidePanel
                ? "border-l opacity-100"
                : "pointer-events-none w-0 overflow-hidden border-l-0 opacity-0",
            )}
            style={
              showIdeSidePanel
                ? { width: idePanelWidth }
                : { width: 0 }
            }
          >
            {showIdeSidePanel ? (
              <>
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="调整侧栏宽度"
                  tabIndex={0}
                  className="absolute inset-y-0 left-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-[var(--pf-accent)]/35 active:bg-[var(--pf-accent)]/50"
                  onPointerDown={onIdeResizePointerDown}
                  onPointerMove={onIdeResizePointerMove}
                  onPointerUp={onIdeResizePointerUp}
                  onPointerCancel={onIdeResizePointerUp}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowLeft") {
                      setIdePanelWidth((w) => Math.min(IDE_PANEL_MAX_WIDTH, w + 16));
                    } else if (event.key === "ArrowRight") {
                      setIdePanelWidth((w) => Math.max(IDE_PANEL_MIN_WIDTH, w - 16));
                    }
                  }}
                />
                <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--pf-line)] px-3">
                  <h2 className="text-xs font-semibold tracking-wide text-[var(--pf-ink)]">
                    {sidePanelView === "notes" ? "笔记" : "Memo"}
                  </h2>
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-[11px] font-medium text-[var(--pf-ink-muted)] transition-colors hover:bg-[var(--pf-panel-subtle)] hover:text-[var(--pf-ink)]"
                    onClick={() => setIdePanelOpen(false)}
                  >
                    收起
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">
                  {renderLibraryPanel(sidePanelView, true)}
                </div>
              </>
            ) : null}
          </aside>

          {/* IDE activity rail */}
          {isIde ? (
            <nav
              aria-label="工作台活动栏"
              data-testid="private-fund-ide-activity-rail"
              className="flex w-12 shrink-0 flex-col items-center gap-1 border-l border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] py-2 transition-all duration-300"
            >
              {SECONDARY_WORKSPACE_VIEWS.map((item) => {
                const Icon = item.icon;
                const isSide = SIDE_PANEL_VIEWS.has(item.value);
                const active = isSide
                  ? showIdeSidePanel && sidePanelView === item.value
                  : workspaceView === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    title={item.label}
                    aria-label={item.label}
                    aria-current={!isSide && workspaceView === item.value ? "page" : undefined}
                    aria-pressed={
                      isSide ? showIdeSidePanel && sidePanelView === item.value : undefined
                    }
                    className={cn(
                      "group relative flex size-10 items-center justify-center rounded-xl text-[var(--pf-ink-muted)] transition-all duration-200",
                      "hover:bg-[var(--pf-panel-raised)] hover:text-[var(--pf-ink)] hover:scale-[1.04]",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)]",
                      "active:scale-[0.97]",
                      active &&
                        "bg-[var(--pf-panel-raised)] text-[var(--pf-accent-ink)] shadow-[var(--pf-shadow)]",
                    )}
                    onClick={() => {
                      if (isSide) {
                        if (showIdeSidePanel && sidePanelView === item.value) {
                          setIdePanelOpen(false);
                          return;
                        }
                        selectWorkspaceView(item.value);
                        return;
                      }
                      selectWorkspaceView(item.value);
                    }}
                  >
                    {active ? (
                      <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-[var(--pf-accent)]" />
                    ) : null}
                    <Icon className="size-4 transition-transform duration-200 group-hover:scale-105" />
                  </button>
                );
              })}
            </nav>
          ) : null}
        </div>
      </div>
    </WorkbenchActionContext.Provider>
  );

}
