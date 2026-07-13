import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FileSearchIcon,
  FileTextIcon,
  FolderKanbanIcon,
  Loader2Icon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FilePathAwareMessageResponse } from "@/components/blocks/BlockRenderer";
import { RichNodeContent } from "@/components/private-fund/RichNodeContent";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  usePrivateFundAssets,
  usePrivateFundProject,
  usePrivateFundWorkflow,
} from "@/hooks/usePrivateFundProjects";
import {
  type PrivateFundAsset,
  deletePrivateFundAssets,
  getPrivateFundAssets,
  savePrivateFundAsset,
  setPrivateFundAssetContext,
  wrapPrivateFundPromptContext,
} from "@/lib/privateFundApi";
import {
  TRUSTED_MEMO_SOURCES_UPDATED_EVENT,
  type TrustedMemoSource,
  notifyTrustedMemoSourcesUpdated,
  readTrustedMemoSources,
  writeTrustedMemoSources,
} from "@/lib/privateFundMemo";
import type { PrivateFundGenerationRequest } from "./PrivateFundShellContext";
import type { PdfSourceSelection } from "./FileViewerContext";
import { PdfSourcePanel } from "./PdfSourcePanel";
import type { RightRailTab } from "./railTabs";

type GenerateOutputMode =
  | "plain_text"
  | "metrics"
  | "table"
  | "line_chart"
  | "bar_chart"
  | "rich"
  | "report";

const OUTPUT_MODES: Array<{ value: GenerateOutputMode; label: string }> = [
  { value: "plain_text", label: "研究节点" },
  { value: "metrics", label: "关键指标" },
  { value: "table", label: "对比表格" },
  { value: "line_chart", label: "趋势图" },
  { value: "bar_chart", label: "对比图" },
  { value: "rich", label: "综合内容" },
  { value: "report", label: "专业研报" },
];
const EMPTY_ASSETS: PrivateFundAsset[] = [];
const EMPTY_ASSET_IDS: string[] = [];

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
      {children}
    </p>
  );
}

function assetConversationId(asset: PrivateFundAsset): string {
  return String(asset.metadata.conversationId ?? "");
}

function assetResponseId(asset: PrivateFundAsset): string {
  return String(asset.metadata.responseId ?? "");
}

function isTrustedAsset(asset: PrivateFundAsset, conversationId: string): boolean {
  return (
    asset.assetType === "information" &&
    asset.metadata.trustedMemoSource === true &&
    assetConversationId(asset) === conversationId
  );
}

export function PrivateFundMemoContent({
  conversationId,
  datasetId,
  datasetName,
  onGenerate,
}: {
  conversationId: string;
  datasetId: string;
  datasetName: string;
  onGenerate?: (request: PrivateFundGenerationRequest) => boolean;
}) {
  const queryClient = useQueryClient();
  const projectQuery = usePrivateFundProject(datasetId);
  const assetsQuery = usePrivateFundAssets(datasetId);
  const project = projectQuery.data?.project;
  const catalog = assetsQuery.data;
  const [legacySources, setLegacySources] = useState<TrustedMemoSource[]>(() =>
    readTrustedMemoSources(conversationId),
  );
  const [instruction, setInstruction] = useState("");
  const [notice, setNotice] = useState("");
  const migrationKeyRef = useRef("");

  const backendSources = useMemo(
    () => (catalog?.assets ?? []).filter((asset) => isTrustedAsset(asset, conversationId)),
    [catalog?.assets, conversationId],
  );
  const backendResponseIds = useMemo(
    () => new Set(backendSources.map(assetResponseId).filter(Boolean)),
    [backendSources],
  );
  const localOnlySources = useMemo(
    () => legacySources.filter((source) => !backendResponseIds.has(source.responseId)),
    [backendResponseIds, legacySources],
  );
  const trustedSourceCount = backendSources.length + localOnlySources.length;
  const latestMemoUrl = project?.latestMemoPath
    ? `/v1/private-fund/dataset/memo/file?path=${encodeURIComponent(project.latestMemoPath)}`
    : null;

  useEffect(() => {
    setLegacySources(readTrustedMemoSources(conversationId));
  }, [conversationId]);

  useEffect(() => {
    const handleUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationId?: string }>).detail;
      if (detail?.conversationId === conversationId) {
        setLegacySources(readTrustedMemoSources(conversationId));
      }
    };
    window.addEventListener(TRUSTED_MEMO_SOURCES_UPDATED_EVENT, handleUpdated);
    return () => window.removeEventListener(TRUSTED_MEMO_SOURCES_UPDATED_EVENT, handleUpdated);
  }, [conversationId]);

  useEffect(() => {
    if (!catalog || localOnlySources.length === 0) return;
    const key = `${conversationId}:${localOnlySources.map((source) => source.responseId).join(",")}`;
    if (migrationKeyRef.current === key) return;
    migrationKeyRef.current = key;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void (async () => {
        const freshCatalog = await getPrivateFundAssets(datasetId);
        const persistedResponseIds = new Set(
          freshCatalog.assets
            .filter((asset) => isTrustedAsset(asset, conversationId))
            .map(assetResponseId),
        );
        const missingSources = localOnlySources.filter(
          (source) => !persistedResponseIds.has(source.responseId),
        );
        await Promise.all(
          missingSources.map((source) =>
            savePrivateFundAsset(datasetId, {
              assetType: "information",
              title: source.title,
              summary: source.content.replace(/\s+/g, " ").slice(0, 180),
              contentMarkdown: source.content,
              sourceResponseId: source.responseId,
              tags: ["可信来源"],
              metadata: {
                conversationId,
                responseId: source.responseId,
                trustedMemoSource: true,
              },
            }),
          ),
        );
        let nextCatalog = await getPrivateFundAssets(datasetId);
        const migratedIds = nextCatalog.assets
          .filter((asset) => isTrustedAsset(asset, conversationId))
          .map((asset) => asset.assetId);
        const contextIds = Array.from(new Set([...nextCatalog.contextAssetIds, ...migratedIds]));
        if (contextIds.length !== nextCatalog.contextAssetIds.length) {
          nextCatalog = await setPrivateFundAssetContext(datasetId, contextIds);
        }
        if (!cancelled) {
          queryClient.setQueryData(["private-fund-assets", datasetId], nextCatalog);
        }
      })().catch(() => {
        migrationKeyRef.current = "";
      });
    }, 1200);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [catalog, conversationId, datasetId, localOnlySources, queryClient]);

  const deleteSourceMutation = useMutation({
    mutationFn: (asset: PrivateFundAsset) => deletePrivateFundAssets(datasetId, [asset.assetId]),
    onSuccess: (next, asset) => {
      queryClient.setQueryData(["private-fund-assets", datasetId], next);
      const responseId = assetResponseId(asset);
      const nextLegacy = legacySources.filter((source) => source.responseId !== responseId);
      setLegacySources(nextLegacy);
      writeTrustedMemoSources(conversationId, nextLegacy);
      notifyTrustedMemoSourcesUpdated(conversationId);
    },
  });

  function removeLegacySource(sourceId: string) {
    const next = legacySources.filter((source) => source.id !== sourceId);
    setLegacySources(next);
    writeTrustedMemoSources(conversationId, next);
    notifyTrustedMemoSourcesUpdated(conversationId);
  }

  function generateMemo() {
    if (!onGenerate) return;
    const visibleInstruction = instruction.trim() || `为${datasetName}生成一份中文投资 Memo`;
    const context = [
      `dataset_id: ${datasetId}`,
      `可信来源资产: ${backendSources.map((asset) => asset.assetId).join(", ") || "无"}`,
      `当前上下文资产: ${catalog?.contextAssetIds.join(", ") || "无"}`,
      "必须调用 private_fund_dataset_memo，并对重大事实和数字保留可追溯证据。",
    ].join("\n");
    const accepted = onGenerate({
      kind: "skill",
      name: "private-fund-memo",
      args: `${visibleInstruction}\n${wrapPrivateFundPromptContext(context)}`,
    });
    if (accepted) {
      setNotice("Memo 生成任务已发送");
      setInstruction("");
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-border border-b px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">Memo</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{datasetName}</p>
          </div>
          {assetsQuery.isLoading ? (
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
          ) : (
            <span className="shrink-0 text-xs text-muted-foreground">
              {trustedSourceCount} 条可信来源
            </span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-3">
        <section>
          <h3 className="px-1 text-sm font-medium">可信来源</h3>
          <p className="mt-0.5 px-1 text-xs text-muted-foreground">来自已经完成的 AI 研究回答。</p>
          {trustedSourceCount === 0 ? (
            <div className="mt-2">
              <EmptyRow>在完整 AI 回答下点击“加入可信来源”后会显示在这里。</EmptyRow>
            </div>
          ) : (
            <ul className="mt-2 flex flex-col gap-0.5">
              {backendSources.map((asset) => (
                <li
                  key={asset.assetId}
                  className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
                >
                  <FileSearchIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{asset.title}</p>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                      {asset.summary || asset.contentMarkdown}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-7 shrink-0 text-muted-foreground"
                    aria-label={`移除 ${asset.title}`}
                    disabled={deleteSourceMutation.isPending}
                    onClick={() => deleteSourceMutation.mutate(asset)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </li>
              ))}
              {localOnlySources.map((source) => (
                <li
                  key={source.id}
                  className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
                >
                  <FileSearchIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{source.title}</p>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                      {source.content}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-7 shrink-0 text-muted-foreground"
                    aria-label={`移除 ${source.title}`}
                    onClick={() => removeLegacySource(source.id)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-2 border-border border-t pt-4">
          <div className="flex items-center justify-between gap-2 px-1">
            <div>
              <h3 className="text-sm font-medium">生成 Memo</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">使用可信来源和已选研究资产。</p>
            </div>
            <Button type="button" size="sm" className="h-8" onClick={generateMemo}>
              生成
            </Button>
          </div>
          <Textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="主题、时间范围或重点问题（可选）"
            className="min-h-20 resize-none text-xs"
          />
          {notice && <p className="px-1 text-xs text-muted-foreground">{notice}</p>}
        </section>

        <section className="border-border border-t pt-4">
          <h3 className="px-1 text-sm font-medium">已有 Memo</h3>
          {project?.latestMemoName || latestMemoUrl ? (
            <div className="mt-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted">
              <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">
                {project?.latestMemoName ?? "Latest memo"}
              </span>
              {latestMemoUrl && (
                <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
                  <a href={latestMemoUrl} target="_blank" rel="noreferrer">
                    打开
                  </a>
                </Button>
              )}
            </div>
          ) : (
            <div className="mt-2">
              <EmptyRow>暂无 Memo 产物。</EmptyRow>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export function PrivateFundAssetsContent({
  datasetId,
  datasetName,
  onGenerate,
}: {
  datasetId: string;
  datasetName: string;
  onGenerate?: (request: PrivateFundGenerationRequest) => boolean;
}) {
  const queryClient = useQueryClient();
  const assetsQuery = usePrivateFundAssets(datasetId);
  const workflowQuery = usePrivateFundWorkflow(datasetId);
  const catalog = assetsQuery.data;
  const assets = catalog?.assets ?? EMPTY_ASSETS;
  const contextIds = catalog?.contextAssetIds ?? EMPTY_ASSET_IDS;
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [mode, setMode] = useState<GenerateOutputMode>("plain_text");
  const [instruction, setInstruction] = useState("");
  const [notice, setNotice] = useState("");

  const selectedAsset = assets.find((asset) => asset.assetId === selectedAssetId);
  const selectedNode = selectedAsset?.sourceKind.startsWith("research_node")
    ? workflowQuery.data?.nodes.find((node) => node.nodeId === selectedAsset.sourceId)
    : undefined;
  const visibleAssets = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return assets.filter(
      (asset) =>
        (typeFilter === "all" || asset.assetType === typeFilter) &&
        (!needle || `${asset.title} ${asset.summary}`.toLocaleLowerCase().includes(needle)),
    );
  }, [assets, query, typeFilter]);
  const assetTypes = useMemo(
    () => Array.from(new Set(assets.map((asset) => asset.assetType))),
    [assets],
  );

  const contextMutation = useMutation({
    mutationFn: (assetIds: string[]) => setPrivateFundAssetContext(datasetId, assetIds),
    onSuccess: (next) => queryClient.setQueryData(["private-fund-assets", datasetId], next),
  });
  const deleteMutation = useMutation({
    mutationFn: (assetId: string) => deletePrivateFundAssets(datasetId, [assetId]),
    onSuccess: (next, assetId) => {
      queryClient.setQueryData(["private-fund-assets", datasetId], next);
      if (selectedAssetId === assetId) setSelectedAssetId("");
    },
  });

  function toggleContext(assetId: string) {
    const next = new Set(contextIds);
    if (next.has(assetId)) next.delete(assetId);
    else next.add(assetId);
    contextMutation.mutate([...next]);
  }

  function generateAsset() {
    if (!onGenerate) return;
    const label = OUTPUT_MODES.find((option) => option.value === mode)?.label ?? "研究资产";
    const visibleInstruction = instruction.trim() || `生成${label}`;
    if (mode === "report") {
      const args = `${visibleInstruction}\n${wrapPrivateFundPromptContext(
        `dataset_id: ${datasetId}\n当前上下文资产: ${contextIds.join(", ") || "无"}\n必须调用 private_fund_equity_report_generate。`,
      )}`;
      if (onGenerate({ kind: "skill", name: "private-fund-report", args })) {
        setNotice("专业研报生成任务已发送");
      }
      return;
    }
    const hidden = [
      `dataset_id: ${datasetId}`,
      `输出形式: ${mode}`,
      `当前上下文资产: ${contextIds.join(", ") || "无"}`,
      "必须检索并核验关键事实，调用 private_fund_research_node_save 保存结果。",
      "无法绑定真实证据的结论必须标记为资料未覆盖/待复核。",
    ].join("\n");
    if (
      onGenerate({
        kind: "message",
        prompt: `${visibleInstruction}\n${wrapPrivateFundPromptContext(hidden)}`,
      })
    ) {
      setNotice(`${label}生成任务已发送`);
      setInstruction("");
    }
  }

  if (selectedAsset) {
    const memoUrl =
      (selectedAsset.assetType === "memo" || selectedAsset.assetType === "report") &&
      selectedAsset.storedPath
        ? `/v1/private-fund/dataset/memo/file?path=${encodeURIComponent(selectedAsset.storedPath)}`
        : null;
    const documentPdfUrl =
      selectedAsset.assetType === "document" && selectedAsset.format.toLowerCase() === "pdf"
        ? `/v1/private-fund/dataset/document/file?${new URLSearchParams({ dataset_id: datasetId, file_name: selectedAsset.title })}`
        : null;
    const spreadsheetSource: PdfSourceSelection | null =
      selectedAsset.assetType === "document" &&
      ["xlsx", "xls", "xlsm", "csv"].includes(selectedAsset.format.toLowerCase())
        ? {
            kind: "excel",
            label: selectedAsset.title,
            workbookName: selectedAsset.title,
            datasetId,
          }
        : null;
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-12 shrink-0 items-center gap-2 border-border border-b px-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2"
            onClick={() => setSelectedAssetId("")}
          >
            返回
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{selectedAsset.title}</span>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={contextIds.includes(selectedAsset.assetId)}
              disabled={contextMutation.isPending}
              onChange={() => toggleContext(selectedAsset.assetId)}
            />
            上下文
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <p className="text-xs text-muted-foreground">
            {selectedAsset.assetType} · {selectedAsset.format} · v{selectedAsset.versionNo}
          </p>
          {selectedAsset.summary && (
            <p className="mt-3 text-sm leading-6">{selectedAsset.summary}</p>
          )}
          {selectedNode ? (
            <div className="mt-4">
              <RichNodeContent
                blocks={selectedNode.contentBlocks}
                evidenceSources={selectedNode.evidenceSources}
                fallbackMarkdown={selectedNode.latestOutput ?? selectedAsset.contentMarkdown}
              />
            </div>
          ) : memoUrl ? (
            <iframe
              sandbox="allow-same-origin"
              className="mt-4 h-[60vh] w-full rounded-md border bg-white"
              src={memoUrl}
              title={selectedAsset.title}
            />
          ) : documentPdfUrl ? (
            <iframe
              sandbox="allow-same-origin"
              className="mt-4 h-[60vh] w-full rounded-md border bg-white"
              src={documentPdfUrl}
              title={selectedAsset.title}
            />
          ) : spreadsheetSource ? (
            <div className="mt-4 h-[60vh] overflow-hidden rounded-md border">
              <PdfSourcePanel selection={spreadsheetSource} />
            </div>
          ) : selectedAsset.contentMarkdown ? (
            <FilePathAwareMessageResponse className="mt-4 text-sm leading-6">
              {selectedAsset.contentMarkdown}
            </FilePathAwareMessageResponse>
          ) : (
            <div className="mt-4">
              <EmptyRow>该资产没有可预览的正文。</EmptyRow>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-border border-b px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">研究资产</p>
            <p className="truncate text-xs text-muted-foreground">
              {datasetName} · {assets.length} 项
            </p>
          </div>
          {assetsQuery.isLoading && (
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="relative mt-3">
          <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索研究资产"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <select
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
          className="mt-2 h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="all">全部类型</option>
          {assetTypes.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {visibleAssets.length === 0 ? (
          <EmptyRow>暂无匹配的研究资产。</EmptyRow>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {visibleAssets.map((asset) => (
              <li
                key={asset.assetId}
                className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
              >
                <input
                  type="checkbox"
                  aria-label={`将 ${asset.title} 加入上下文`}
                  checked={contextIds.includes(asset.assetId)}
                  disabled={contextMutation.isPending}
                  onChange={() => toggleContext(asset.assetId)}
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setSelectedAssetId(asset.assetId)}
                >
                  <span className="block truncate text-xs font-medium">{asset.title}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                    {asset.assetType} · v{asset.versionNo} · {asset.evidenceCount} 条证据
                  </span>
                </button>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {formatDateTime(asset.updatedAt)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 text-muted-foreground"
                  aria-label={`删除 ${asset.title}`}
                  disabled={deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate(asset.assetId)}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="shrink-0 space-y-2 border-border border-t p-3">
        <div className="flex gap-2">
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as GenerateOutputMode)}
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
          >
            {OUTPUT_MODES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Button type="button" size="sm" className="h-8" onClick={generateAsset}>
            生成
          </Button>
        </div>
        <Textarea
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder="补充主题或口径（可选）"
          className="min-h-16 resize-none text-xs"
        />
        {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
      </div>
    </div>
  );
}

export function PrivateFundMobileWorkspaceContent({
  conversationId,
  datasetId,
  datasetName,
  onGenerate,
}: {
  conversationId: string;
  datasetId: string;
  datasetName: string;
  onGenerate: (request: PrivateFundGenerationRequest) => boolean;
}) {
  const [tab, setTab] = useState<"memo" | "assets">("memo");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-border border-b px-3 py-2">
        <Tabs value={tab} onValueChange={(value) => setTab(value as "memo" | "assets")}>
          <TabsList variant="pill">
            <TabsTrigger value="memo">Memo</TabsTrigger>
            <TabsTrigger value="assets">研究资产</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {tab === "assets" ? (
        <PrivateFundAssetsContent
          datasetId={datasetId}
          datasetName={datasetName}
          onGenerate={onGenerate}
        />
      ) : (
        <PrivateFundMemoContent
          conversationId={conversationId}
          datasetId={datasetId}
          datasetName={datasetName}
          onGenerate={onGenerate}
        />
      )}
    </div>
  );
}

export function PrivateFundWorkspacePanel({
  conversationId,
  datasetId,
  datasetName,
  width,
  inert,
  handleProps,
  rightRailTab,
  onRightRailTabChange,
  pdfSourceSelection,
  onGenerate,
}: {
  conversationId: string;
  datasetId: string;
  datasetName: string;
  width: number;
  inert?: boolean;
  handleProps: HTMLAttributes<HTMLDivElement> & { tabIndex: number };
  rightRailTab: RightRailTab;
  onRightRailTabChange: (next: RightRailTab) => void;
  pdfSourceSelection: PdfSourceSelection | null;
  onGenerate: (request: PrivateFundGenerationRequest) => boolean;
}) {
  const activeTab =
    rightRailTab === "sources" && pdfSourceSelection
      ? "sources"
      : rightRailTab === "assets"
        ? "assets"
        : "memo";
  return (
    <aside
      aria-label="Workspace"
      inert={inert}
      className="@container/rail relative z-40 hidden md:mt-14 md:mr-2 md:mb-2 md:flex md:min-h-0 md:shrink-0 md:flex-col md:overflow-hidden md:rounded-xl md:border md:border-border md:bg-card md:shadow-lg"
      style={{ width }}
    >
      <div
        {...handleProps}
        className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-primary/30 active:bg-primary/50"
      />
      <div className="flex shrink-0 items-center overflow-x-auto border-border border-b px-2 py-1.5">
        <Tabs
          value={activeTab}
          onValueChange={(value) => onRightRailTabChange(value as RightRailTab)}
        >
          <TabsList variant="pill">
            <TabsTrigger value="memo" className="h-8 gap-1.5 rounded-lg px-3 text-[13px]">
              <FileTextIcon className="size-4" />
              Memo
            </TabsTrigger>
            <TabsTrigger value="assets" className="h-8 gap-1.5 rounded-lg px-3 text-[13px]">
              <FolderKanbanIcon className="size-4" />
              研究资产
            </TabsTrigger>
            {pdfSourceSelection && (
              <TabsTrigger value="sources" className="h-8 gap-1.5 rounded-lg px-3 text-[13px]">
                <FileSearchIcon className="size-4" />
                Sources
              </TabsTrigger>
            )}
          </TabsList>
        </Tabs>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {activeTab === "sources" ? (
          <PdfSourcePanel selection={pdfSourceSelection} />
        ) : activeTab === "assets" ? (
          <PrivateFundAssetsContent
            datasetId={datasetId}
            datasetName={datasetName}
            onGenerate={onGenerate}
          />
        ) : (
          <PrivateFundMemoContent
            conversationId={conversationId}
            datasetId={datasetId}
            datasetName={datasetName}
            onGenerate={onGenerate}
          />
        )}
      </div>
    </aside>
  );
}
