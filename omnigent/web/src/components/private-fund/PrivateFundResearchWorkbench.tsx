import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BellRing,
  BookOpen,
  Calculator,
  Check,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Download,
  ExternalLink,
  FileStack,
  History,
  Loader2,
  ListTree,
  Maximize2,
  Menu,
  MessageSquareText,
  NotebookPen,
  Package,
  PanelRightClose,
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
import { useTranslation } from "react-i18next";

const RichNodeContent = lazy(() =>
  import("./RichNodeContent").then((module) => ({ default: module.RichNodeContent })),
);

const EMPTY_ASSETS: PrivateFundAsset[] = [];
const EMPTY_ASSET_IDS: string[] = [];
const EMPTY_RECENT_USER_MESSAGES: string[] = [];

type SelectedInformation = { responseId: string; content: string };
type SaveInformationInput = SelectedInformation & { optimisticAssetId: string };
type WorkspaceView =
  | "research"
  | "sources"
  | "notes"
  | "memos"
  | "valuation"
  | "history"
  | "tracking";

export type PresentationMode = "plain_text" | "table" | "chart";
export type PrivateFundGenerationMode = PresentationMode | "memo";

export const PRIVATE_FUND_NOTE_OPTIONS: Array<{
  value: PresentationMode;
  label: string;
  description: string;
}> = [
  { value: "plain_text", label: "文本", description: "长期可读的研究正文与结论" },
  { value: "table", label: "表格", description: "期间 / 对象对比的精确表格" },
  { value: "chart", label: "图表", description: "自包含图文可视化研究笔记" },
];

export const PRIVATE_FUND_GENERATION_OPTIONS: Array<{
  value: PrivateFundGenerationMode;
  label: string;
  description: string;
}> = [
  ...PRIVATE_FUND_NOTE_OPTIONS,
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
const IDE_PANEL_DETAIL_WIDTH = 520;
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
  markUsefulInformation: (responseId: string, content: string) => Promise<void>;
  openSourcePicker: () => void;
  openAssetManagement: () => void;
  pinToCurrentAssumption: (responseId: string, content: string) => void;
  generationMode: PrivateFundGenerationMode;
  generationInstruction: string;
  selectedInformationCount: number;
  promptSuggestions: PrivateFundPromptSuggestion[];
  setGenerationMode: (mode: PrivateFundGenerationMode) => void;
  setGenerationInstruction: (instruction: string) => void;
  generateAsset: (mode?: PrivateFundGenerationMode, instruction?: string) => void;
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
  recentAssistantMessages?: string[];
  /** Available after the first research question creates a conversation. */
  onGenerateNode?: (prompt: string) => void;
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

function formatPreviewDate(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function extractMarkdownOutline(markdown?: string | null): string[] {
  if (!markdown) return [];
  return [...markdown.matchAll(/^#{1,4}\s+(.+)$/gm)]
    .map((match) => match[1]?.replace(/\s+#+\s*$/, "").trim() ?? "")
    .filter(Boolean)
    .slice(0, 8);
}

function assetSourceCount(asset: PrivateFundAsset): number {
  const metadataCount = [
    asset.metadata.source_count,
    asset.metadata.evidence_count,
    asset.metadata.trusted_source_count,
  ].find((value) => typeof value === "number");
  return typeof metadataCount === "number" ? metadataCount : asset.evidenceCount;
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
  recentAssistantMessages = EMPTY_RECENT_USER_MESSAGES,
  onGenerateNode,
  sidebarOpen = true,
  onOpenSidebar,
}: PrivateFundResearchWorkbenchProps) {
  const { t } = useTranslation();
  void _conversationId;
  const queryClient = useQueryClient();
  const workflowQuery = usePrivateFundWorkflow(datasetId);
  const assetsQuery = usePrivateFundAssets(datasetId);
  const projectQuery = usePrivateFundProject(datasetId);
  const resolvedDatasetName = projectQuery.data?.project.name || datasetName;
  const viewLabel = useCallback(
    (view: WorkspaceView) =>
      ({
        research: t("privateFund.research", "Research"),
        sources: t("privateFund.sources"),
        notes: t("privateFund.notes"),
        memos: t("privateFund.memo"),
        valuation: t("privateFund.valuation"),
        history: t("privateFund.history"),
        tracking: t("privateFund.tracking"),
      })[view],
    [t],
  );
  const workflow = workflowQuery.data;
  const assetCatalog = assetsQuery.data;
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [sidePanelAssetId, setSidePanelAssetId] = useState("");
  const [returnToResearchAfterPreview, setReturnToResearchAfterPreview] = useState(false);
  const [, setAssetPanelExpanded] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("research");
  const [historySeriesId, setHistorySeriesId] = useState("");
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
  const [assetManagementRequestId, setAssetManagementRequestId] = useState<number | undefined>();
  const documentPreviewRequest = usePrivateFundWorkspaceStore(
    (state) => state.documentPreviewRequest,
  );
  const clearDocumentPreview = usePrivateFundWorkspaceStore((state) => state.clearDocumentPreview);
  const handledPreviewRequestId = useRef(0);
  const sidePreviewScrollRef = useRef<HTMLDivElement | null>(null);
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
            recentAssistantMessages,
            contextAssetIds,
          })
        : [],
    [
      assets,
      contextAssetIds,
      datasetName,
      projectQuery.data,
      recentAssistantMessages,
      recentUserMessages,
    ],
  );
  const selectedAsset = assets.find((asset) => asset.assetId === selectedAssetId);
  const sidePanelAsset = assets.find((asset) => asset.assetId === sidePanelAssetId);
  const sidePanelAssets = useMemo(() => {
    const filtered =
      sidePanelKind === "memos"
        ? assets.filter((asset) => asset.assetType === "memo")
        : assets.filter(
            (asset) =>
              asset.assetType === "information" ||
              asset.assetType === "analysis" ||
              asset.displayGroup === "answer_note" ||
              asset.displayGroup === "research_note",
          );
    return [...filtered].sort(
      (left, right) =>
        new Date(right.updatedAt ?? right.createdAt ?? 0).getTime() -
        new Date(left.updatedAt ?? left.createdAt ?? 0).getTime(),
    );
  }, [assets, sidePanelKind]);
  const sidePanelAssetIndex = sidePanelAssets.findIndex(
    (asset) => asset.assetId === sidePanelAssetId,
  );

  const moveSidePanelPreview = useCallback(
    (offset: -1 | 1) => {
      if (sidePanelAssetIndex < 0) return;
      const nextAsset = sidePanelAssets[sidePanelAssetIndex + offset];
      if (!nextAsset) return;
      setSidePanelAssetId(nextAsset.assetId);
      const preview = sidePreviewScrollRef.current;
      if (preview && typeof preview.scrollTo === "function") {
        preview.scrollTo({ top: 0, behavior: "smooth" });
      } else if (preview) {
        preview.scrollTop = 0;
      }
    },
    [sidePanelAssetIndex, sidePanelAssets],
  );

  const scrollToPreviewHeading = useCallback((headingText: string) => {
    const root = sidePreviewScrollRef.current;
    if (!root) return;
    const heading = [...root.querySelectorAll<HTMLElement>("h1, h2, h3, h4")].find(
      (candidate) => candidate.textContent?.trim() === headingText,
    );
    if (heading && typeof heading.scrollIntoView === "function") {
      heading.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  const isIde = chromeMode === "ide";
  const sidePanelView = sidePanelKind;
  const sidePanelAssetCount =
    sidePanelView === "memos"
      ? assets.filter((asset) => asset.assetType === "memo").length
      : assets.filter(
          (asset) =>
            asset.assetType === "information" ||
            asset.assetType === "analysis" ||
            asset.displayGroup === "answer_note" ||
            asset.displayGroup === "research_note",
        ).length;
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
          if (next !== sidePanelKind) setSidePanelAssetId("");
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
    [chromeMode, sidePanelKind],
  );

  const openMemoHistory = useCallback((seriesId: string) => {
    setHistorySeriesId(seriesId);
    setReturnToResearchAfterPreview(false);
    setSelectedAssetId("");
    setSidePanelAssetId("");
    setAssetPanelExpanded(false);
    setWorkspaceView("history");
    setIdePanelOpen(false);
  }, []);

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

  const openSidePanelAsset = useCallback((asset: PrivateFundAsset) => {
    setSidePanelAssetId(asset.assetId);
    setIdePanelWidth((width) => Math.max(width, IDE_PANEL_DETAIL_WIDTH));
  }, []);

  useEffect(() => {
    if (sidePanelAssetId && !sidePanelAsset) setSidePanelAssetId("");
  }, [sidePanelAsset, sidePanelAssetId]);

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
      setNotice(t("privateFund.contextUpdated", "Question context updated"));
    },
    onError: (error) =>
      setNotice(
        error instanceof Error
          ? error.message
          : t("privateFund.contextUpdateFailed", "Could not update question context"),
      ),
  });

  const saveInformationMutation = useMutation({
    mutationFn: ({ responseId, content }: SaveInformationInput) =>
      savePrivateFundAsset(datasetId, {
        assetType: "information",
        title: cleanText(content).slice(0, 42) || t("privateFund.answerNote", "Answer note"),
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
      setNotice(
        error instanceof Error
          ? error.message
          : t("privateFund.saveAnswerNoteFailed", "Could not save answer note"),
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["private-fund-assets", datasetId] }),
  });

  const deleteAssetsMutation = useMutation({
    mutationFn: (assetIds: string[]) => deletePrivateFundAssets(datasetId, assetIds),
    onSuccess: (next, deletedIds) => {
      queryClient.setQueryData(["private-fund-assets", datasetId], next);
      if (deletedIds.includes(selectedAssetId)) setSelectedAssetId("");
      if (deletedIds.includes(sidePanelAssetId)) setSidePanelAssetId("");
      void Promise.all([
        workflowQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["private-fund-project", datasetId] }),
        queryClient.invalidateQueries({ queryKey: ["private-fund-projects"] }),
      ]);
      setNotice(
        t("privateFund.deletedCount", {
          count: deletedIds.length,
          defaultValue: `${deletedIds.length} items deleted`,
        }),
      );
    },
  });

  const selectInformation = useCallback(
    async (responseId: string, content: string) => {
      const normalized = content.trim();
      if (!normalized) return;
      await saveInformationMutation.mutateAsync({
        responseId,
        content: normalized,
        optimisticAssetId: `pending-information:${responseId}:${Date.now()}`,
      });
      setSelectedInformation((current) => {
        if (current.some((item) => item.responseId === responseId && item.content === normalized)) {
          return current;
        }
        return [...current, { responseId, content: normalized }];
      });
      setNotice(t("privateFund.answerNoteSaved", "Saved as an answer note"));
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

  const generateNode = useCallback(
    (modeOverride?: PrivateFundGenerationMode, instructionOverride?: string) => {
      if (!workflow) return;
      if (!onGenerateNode) {
        setNotice(
          t(
            "privateFund.startConversationFirst",
            "Start a conversation before generating a research note",
          ),
        );
        return;
      }
      const mode = modeOverride ?? presentationMode;
      const instruction =
        instructionOverride !== undefined ? instructionOverride : presentationInstruction;
      const documentMode = isDocumentGenerationMode(mode);
      const contextAssets = contextAssetIds
        .map((assetId) => assets.find((asset) => asset.assetId === assetId))
        .filter((asset): asset is PrivateFundAsset => Boolean(asset));
      if (
        !documentMode &&
        !hasConversationContext &&
        selectedInformation.length === 0 &&
        contextAssets.length === 0
      ) {
        setNotice(
          t(
            "privateFund.selectContextFirst",
            "Provide conversation content or select at least one context item",
          ),
        );
        return;
      }
      if (
        documentMode &&
        selectedInformation.length === 0 &&
        contextAssetIds.length === 0 &&
        !hasConversationContext &&
        !instruction.trim()
      ) {
        setNotice(
          t("privateFund.memoNeedsTopic", "Enter a memo topic or select at least one context item"),
        );
        return;
      }
      if (modeOverride !== undefined) {
        setPresentationMode(modeOverride);
      }
      if (instructionOverride !== undefined) {
        setPresentationInstruction(instructionOverride);
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
          mode,
          instruction,
        ),
      );
      setNotice(
        mode === "memo"
          ? t("privateFund.memoStarted", "The Agent will verify evidence and generate the memo")
          : t(
              "privateFund.noteStarted",
              "The Agent will verify the information and save a research note",
            ),
      );
      setSelectedInformation([]);
      setPresentationMode("plain_text");
      setPresentationInstruction("");
      window.setTimeout(() => void workflowQuery.refetch(), 2500);
    },
    [
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
      t,
    ],
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
            displayLabel: asset.displayLabel,
          };
        }),
      contextAssetIds,
      removeContextAsset: (assetId: string) => {
        contextMutation.mutate(contextAssetIds.filter((id) => id !== assetId));
      },
      addResearchNodeFromResponse: selectInformation,
      markUsefulInformation: selectInformation,
      openSourcePicker: () => selectWorkspaceView("sources"),
      openAssetManagement: () => {
        setAssetManagementRequestId((value) => (value ?? 0) + 1);
        selectWorkspaceView("notes");
      },
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
      selectWorkspaceView,
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

  const renderAssetContent = (asset: PrivateFundAsset, compact = false) => {
    const node = asset.sourceKind.startsWith("research_node")
      ? workflow.nodes.find((candidate) => candidate.nodeId === asset.sourceId)
      : undefined;
    const memoUrl =
      (asset.assetType === "memo" || asset.assetType === "report") &&
      asset.storedPath &&
      ["pdf", "html"].includes(asset.format.toLowerCase())
        ? `/v1/private-fund/dataset/memo/file?path=${encodeURIComponent(asset.storedPath)}`
        : null;
    const documentUrl =
      asset.assetType === "document" && asset.format.toLowerCase() === "pdf"
        ? `/v1/private-fund/dataset/document/file?${new URLSearchParams({
            dataset_id: datasetId,
            file_name: asset.title,
          })}`
        : null;
    const documentSource: PdfSourceSelection | null =
      asset.assetType === "document" &&
      ["xlsx", "xls", "xlsm", "csv"].includes(asset.format.toLowerCase())
        ? {
            kind: "excel",
            label: asset.title,
            workbookName: asset.title,
            datasetId,
          }
        : null;
    const outline = [
      ...new Set(
        node
          ? [
              ...node.contentBlocks.flatMap((block) => [
                ...(block.title ? [block.title] : []),
                ...(block.type === "markdown" ? extractMarkdownOutline(block.markdown) : []),
              ]),
              ...extractMarkdownOutline(node.latestOutput),
            ]
          : extractMarkdownOutline(asset.contentMarkdown),
      ),
    ].slice(0, 8);
    const embeddedPreviewClass = cn(
      "w-full rounded-lg border border-[var(--pf-line)] bg-white",
      compact ? "h-[calc(100vh-12rem)] min-h-[420px]" : "h-[68vh] min-h-[520px]",
    );

    return (
      <article className={compact ? "w-full" : "mx-auto w-full max-w-4xl"}>
        {!compact ? (
          <div>
            <p className="text-xs font-medium text-[var(--pf-ink-muted)]">
              {asset.displayLabel}
              {asset.versionNo ? ` · v${asset.versionNo}` : ""}
            </p>
            <h3 className="mt-2 text-base font-semibold">{asset.title}</h3>
          </div>
        ) : null}
        {asset.summary ? (
          <p
            className={cn(
              "text-xs leading-5 text-[var(--pf-ink-secondary)]",
              compact ? "mb-3" : "mt-3",
            )}
          >
            {asset.summary}
          </p>
        ) : null}
        {compact && outline.length > 0 ? (
          <nav
            aria-label={`${asset.title}目录`}
            className="mb-3 border-y border-[var(--pf-line)] py-2"
          >
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold text-[var(--pf-ink-muted)]">
              <ListTree className="size-3" />
              内容目录
            </p>
            <div className="flex gap-1.5 overflow-x-auto pb-0.5">
              {outline.map((heading) => (
                <button
                  className="shrink-0 rounded-md bg-[var(--pf-panel-subtle)] px-2 py-1 text-[10px] font-medium text-[var(--pf-ink-secondary)] transition-colors hover:bg-[var(--pf-accent-soft)] hover:text-[var(--pf-accent-ink)]"
                  key={heading}
                  onClick={() => scrollToPreviewHeading(heading)}
                  type="button"
                >
                  {heading}
                </button>
              ))}
            </div>
          </nav>
        ) : null}
        {node ? (
          <div className={cn("min-w-0 overflow-x-auto", !compact && "mt-4")}>
            <Suspense
              fallback={
                <div
                  className="h-28 animate-pulse rounded-xl bg-[var(--pf-panel-subtle)] motion-reduce:animate-none"
                  aria-label="正在加载笔记内容"
                />
              }
            >
              <RichNodeContent
                blocks={node.contentBlocks}
                evidenceSources={node.evidenceSources}
                fallbackMarkdown={node.latestOutput}
              />
            </Suspense>
          </div>
        ) : memoUrl && asset.format.toLowerCase() === "pdf" ? (
          <iframe
            className={cn(embeddedPreviewClass, !compact && "mt-4")}
            src={memoUrl}
            title={`${asset.title} PDF 预览`}
          />
        ) : memoUrl && asset.format.toLowerCase() === "html" ? (
          <>
            <div className={cn("flex justify-end gap-1", compact ? "mb-2" : "mb-2 mt-4")}>
              <a
                aria-label={`下载 ${asset.title}`}
                className="flex size-8 items-center justify-center rounded-md text-[var(--pf-ink-secondary)] hover:bg-[var(--pf-panel-subtle)]"
                download
                href={memoUrl}
                title="下载"
              >
                <Download className="size-3.5" />
              </a>
              <a
                aria-label={`打开原文件 ${asset.title}`}
                className="flex size-8 items-center justify-center rounded-md text-[var(--pf-ink-secondary)] hover:bg-[var(--pf-panel-subtle)]"
                href={memoUrl}
                rel="noreferrer"
                target="_blank"
                title="打开原文件"
              >
                <ExternalLink className="size-3.5" />
              </a>
            </div>
            <iframe
              className={embeddedPreviewClass}
              sandbox=""
              src={memoUrl}
              title={`${asset.title} HTML 预览`}
            />
          </>
        ) : documentUrl ? (
          <iframe
            className={cn(embeddedPreviewClass, !compact && "mt-4")}
            src={documentUrl}
            title={`${asset.title} PDF 预览`}
          />
        ) : documentSource ? (
          <div className={cn(embeddedPreviewClass, !compact && "mt-4", "overflow-hidden")}>
            <PdfSourcePanel selection={documentSource} />
          </div>
        ) : asset.assetType === "document" ? (
          <ExtractedDocumentPreview datasetId={datasetId} fileName={asset.title} />
        ) : asset.contentMarkdown ? (
          <FilePathAwareMessageResponse
            className={cn(
              "text-sm leading-6 text-[var(--pf-ink-secondary)] [&_a]:font-medium [&_a]:text-[var(--pf-accent-ink)] [&_blockquote]:border-[var(--pf-line-strong)] [&_blockquote]:bg-[var(--pf-panel-subtle)] [&_blockquote]:px-3 [&_h1]:text-xl [&_h2]:text-lg [&_h3]:text-base [&_table]:text-xs",
              !compact && "mt-4",
            )}
            breaks
          >
            {asset.contentMarkdown}
          </FilePathAwareMessageResponse>
        ) : (
          <p className="mt-4 rounded-lg border border-dashed p-3 text-xs text-[var(--pf-ink-muted)]">
            该资料保留原文件位置，分析时由 Agent 通过数据集检索工具读取。
          </p>
        )}
      </article>
    );
  };

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
      view === "sources"
        ? "sources"
        : view === "notes"
          ? "notes"
          : view === "memos"
            ? "memos"
            : "generic";
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
            ? t("privateFund.sourcesDescription", { count: assetsForView.length })
            : view === "memos"
              ? t("privateFund.memosDescription", { count: assetsForView.length })
              : t("privateFund.notesDescription", { count: assetsForView.length })
        }
        emptyMessage={
          view === "sources"
            ? t("privateFund.noSourcesDetail")
            : view === "memos"
              ? t("privateFund.noMemosDetail")
              : t("privateFund.noNotesDetail")
        }
        onDeleteAssets={(assetIds) =>
          deleteAssetsMutation.mutateAsync(assetIds).then(() => undefined)
        }
        onOpenAsset={compact && SIDE_PANEL_VIEWS.has(view) ? openSidePanelAsset : openAsset}
        onOpenMemoHistory={view === "memos" ? openMemoHistory : undefined}
        managementRequestId={view === "notes" ? assetManagementRequestId : undefined}
        onSetContext={(assetIds) => contextMutation.mutateAsync(assetIds).then(() => undefined)}
        title={viewLabel(view)}
      />
    );
  };

  const renderSidePanelAssetDetail = () => {
    if (!sidePanelAsset) return null;
    const listLabel = viewLabel(sidePanelView);
    const updatedLabel = formatPreviewDate(sidePanelAsset.updatedAt ?? sidePanelAsset.createdAt);
    const previewNode = sidePanelAsset.sourceKind.startsWith("research_node")
      ? workflow.nodes.find((node) => node.nodeId === sidePanelAsset.sourceId)
      : undefined;
    const sourceCount = previewNode?.evidenceSources?.length ?? assetSourceCount(sidePanelAsset);

    return (
      <div
        className="flex min-h-0 flex-1 flex-col animate-in fade-in slide-in-from-right-2 duration-200"
        data-testid="private-fund-side-asset-detail"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--pf-line)] px-2">
          <button
            aria-label={`返回${listLabel}列表`}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-[var(--pf-ink-secondary)] transition-colors hover:bg-[var(--pf-panel-subtle)]"
            onClick={() => setSidePanelAssetId("")}
            type="button"
          >
            <ArrowLeft size={15} />
          </button>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-xs font-semibold">{sidePanelAsset.title}</h3>
            <p className="truncate text-[11px] text-[var(--pf-ink-muted)]">
              {sidePanelAsset.displayLabel || sidePanelAsset.assetType}
              {sidePanelAsset.versionNo ? ` · v${sidePanelAsset.versionNo}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center">
            <button
              aria-label={`上一条${listLabel}`}
              className="flex size-8 items-center justify-center rounded-lg text-[var(--pf-ink-secondary)] transition-colors hover:bg-[var(--pf-panel-subtle)] disabled:opacity-30"
              disabled={sidePanelAssetIndex <= 0}
              onClick={() => moveSidePanelPreview(-1)}
              title={`上一条${listLabel}`}
              type="button"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              aria-label={`下一条${listLabel}`}
              className="flex size-8 items-center justify-center rounded-lg text-[var(--pf-ink-secondary)] transition-colors hover:bg-[var(--pf-panel-subtle)] disabled:opacity-30"
              disabled={
                sidePanelAssetIndex < 0 || sidePanelAssetIndex >= sidePanelAssets.length - 1
              }
              onClick={() => moveSidePanelPreview(1)}
              title={`下一条${listLabel}`}
              type="button"
            >
              <ChevronRight size={14} />
            </button>
          </div>
          <label
            className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-medium text-[var(--pf-ink-secondary)] hover:bg-[var(--pf-panel-subtle)]"
            title="加入问题上下文"
          >
            <input
              aria-label={`将${sidePanelAsset.title}加入问题上下文`}
              checked={contextAssetIds.includes(sidePanelAsset.assetId)}
              className="size-3.5 accent-[var(--pf-accent)]"
              disabled={contextMutation.isPending}
              onChange={() => toggleContextAsset(sidePanelAsset.assetId)}
              type="checkbox"
            />
            {t("privateFund.context", "Context")}
          </label>
          <button
            aria-label={`在主工作区展开 ${sidePanelAsset.title}`}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-[var(--pf-ink-secondary)] transition-colors hover:bg-[var(--pf-panel-subtle)]"
            onClick={() => {
              setSidePanelAssetId("");
              openAsset(sidePanelAsset);
            }}
            title="在主工作区展开"
            type="button"
          >
            <Maximize2 size={14} />
          </button>
        </div>
        <div
          className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--pf-line)] bg-[var(--pf-panel-subtle)]/55 px-3 py-1.5 text-[10px] text-[var(--pf-ink-muted)]"
          data-testid="asset-preview-metadata"
        >
          <span className="font-medium text-[var(--pf-ink-secondary)]">
            {sidePanelAsset.format.toUpperCase()}
          </span>
          {updatedLabel ? (
            <time dateTime={sidePanelAsset.updatedAt ?? sidePanelAsset.createdAt ?? undefined}>
              {t("privateFund.updatedAt", {
                value: updatedLabel,
                defaultValue: `Updated ${updatedLabel}`,
              })}
            </time>
          ) : null}
          <span>
            {t("privateFund.sourceCount", {
              count: sourceCount,
              defaultValue: `${sourceCount} sources`,
            })}
          </span>
          <span className="ml-auto tabular-nums">
            {sidePanelAssetIndex + 1} / {sidePanelAssets.length}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4" ref={sidePreviewScrollRef}>
          {renderAssetContent(sidePanelAsset, true)}
        </div>
      </div>
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
              <p className="truncate text-xs font-semibold">
                {t("privateFund.details", "Details")}
              </p>
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
              {t("privateFund.addContext")}
            </label>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {renderAssetContent(selectedAsset)}
          </div>
        </div>
      );
    }
    if (mainShowsChat) return chat;
    if (workspaceView === "history")
      return (
        <PrivateFundHistoryPanel
          datasetId={datasetId}
          initialSeriesId={historySeriesId || undefined}
        />
      );
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
                aria-label={t("sidebar.open", "Open project sidebar")}
                className="flex size-9 items-center justify-center rounded-lg text-[var(--pf-ink-secondary)] transition-colors hover:bg-[var(--pf-panel-subtle)]"
              >
                <Menu size={18} />
              </button>
            ) : null}
            <span className="flex size-9 items-center justify-center rounded-lg bg-[var(--pf-accent-soft)] text-[var(--pf-accent-ink)]">
              <Package size={18} />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">{t("common.productName")}</p>
              <p className="truncate text-xs text-[var(--pf-ink-secondary)]">
                {resolvedDatasetName} ·{" "}
                {t("privateFund.contextCount", {
                  count: contextAssetIds.length,
                  defaultValue: `${contextAssetIds.length} context items`,
                })}
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
                    {viewLabel(item.value)}
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
                        {viewLabel(item.value)}
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
                title={t("privateFund.tabLayout", "Tab layout")}
                aria-label={t("privateFund.tabLayout", "Tab layout")}
                className={cn(
                  "flex size-8 items-center justify-center rounded-md text-[var(--pf-ink-muted)] transition-all duration-200 hover:text-[var(--pf-ink)]",
                  !isIde && "bg-[var(--pf-panel-raised)] text-[var(--pf-accent-ink)] shadow-sm",
                )}
                onClick={() => setChromeMode("tabs")}
              >
                <PanelTop className="size-3.5" />
              </button>
              <button
                type="button"
                aria-pressed={isIde}
                title={t("privateFund.sidebarLayout", "Sidebar layout")}
                aria-label={t("privateFund.sidebarLayout", "Sidebar layout")}
                className={cn(
                  "flex size-8 items-center justify-center rounded-md text-[var(--pf-ink-muted)] transition-all duration-200 hover:text-[var(--pf-ink)]",
                  isIde && "bg-[var(--pf-panel-raised)] text-[var(--pf-accent-ink)] shadow-sm",
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
          className={cn("flex min-h-0 flex-1 overflow-hidden", isIde ? "flex-row" : "flex-col")}
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
            style={showIdeSidePanel ? { width: idePanelWidth } : { width: 0 }}
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
                <div
                  aria-hidden={sidePanelAsset ? true : undefined}
                  className={cn("flex min-h-0 flex-1 flex-col", sidePanelAsset && "hidden")}
                >
                  <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--pf-line)] px-3">
                    <h2 className="flex items-center gap-1.5 text-xs font-semibold text-[var(--pf-ink)]">
                      <span>{viewLabel(sidePanelView)}</span>
                      <span
                        aria-hidden="true"
                        className="min-w-5 rounded bg-[var(--pf-panel-subtle)] px-1.5 py-0.5 text-center text-[10px] font-medium tabular-nums text-[var(--pf-ink-muted)]"
                      >
                        {sidePanelAssetCount}
                      </span>
                    </h2>
                    <button
                      aria-label={t("settings.collapseSidebar", "Collapse sidebar")}
                      title={t("settings.collapseSidebar", "Collapse sidebar")}
                      type="button"
                      className="flex size-7 items-center justify-center rounded-md text-[var(--pf-ink-muted)] transition-colors hover:bg-[var(--pf-panel-subtle)] hover:text-[var(--pf-ink)]"
                      onClick={() => setIdePanelOpen(false)}
                    >
                      <PanelRightClose className="size-3.5" />
                    </button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-hidden">
                    {renderLibraryPanel(sidePanelView, true)}
                  </div>
                </div>
                {renderSidePanelAssetDetail()}
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
                    title={viewLabel(item.value)}
                    aria-label={viewLabel(item.value)}
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
