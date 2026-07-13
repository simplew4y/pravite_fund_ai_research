import { FileSearchIcon, FileTextIcon, Loader2Icon, Trash2Icon } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePrivateFundProject } from "@/hooks/usePrivateFundProjects";
import {
  LOCAL_MEMOS_UPDATED_EVENT,
  TRUSTED_MEMO_SOURCES_UPDATED_EVENT,
  type LocalMemoDraft,
  type TrustedMemoSource,
  notifyLocalMemosUpdated,
  notifyTrustedMemoSourcesUpdated,
  readLocalMemos,
  readTrustedMemoSources,
  writeLocalMemos,
  writeTrustedMemoSources,
} from "@/lib/privateFundMemo";
import type { PdfSourceSelection } from "./FileViewerContext";
import { PdfSourcePanel } from "./PdfSourcePanel";
import type { RightRailTab } from "./railTabs";

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sourceTitle(source: TrustedMemoSource, index: number): string {
  return source.title || `可信来源 ${index + 1}`;
}

function MemoListEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
      {children}
    </p>
  );
}

export function PrivateFundMemoContent({
  conversationId,
  datasetId,
  datasetName,
}: {
  conversationId: string;
  datasetId: string;
  datasetName: string;
}) {
  const projectQuery = usePrivateFundProject(datasetId);
  const project = projectQuery.data?.project;
  const [trustedSources, setTrustedSources] = useState<TrustedMemoSource[]>(() =>
    readTrustedMemoSources(conversationId),
  );
  const [localMemos, setLocalMemos] = useState<LocalMemoDraft[]>(() =>
    readLocalMemos(conversationId),
  );

  const latestMemoUrl = project?.latestMemoPath
    ? `/v1/private-fund/dataset/memo/file?path=${encodeURIComponent(project.latestMemoPath)}`
    : null;

  const hasMemoArtifacts = localMemos.length > 0 || !!project?.latestMemoName || !!latestMemoUrl;
  const sourceCountLabel = useMemo(
    () => `${trustedSources.length} 条可信来源`,
    [trustedSources.length],
  );

  useEffect(() => {
    setTrustedSources(readTrustedMemoSources(conversationId));
    setLocalMemos(readLocalMemos(conversationId));
  }, [conversationId]);

  useEffect(() => {
    const handleTrustedSourcesUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationId?: string }>).detail;
      if (detail?.conversationId !== conversationId) return;
      setTrustedSources(readTrustedMemoSources(conversationId));
    };
    const handleLocalMemosUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationId?: string }>).detail;
      if (detail?.conversationId !== conversationId) return;
      setLocalMemos(readLocalMemos(conversationId));
    };
    window.addEventListener(TRUSTED_MEMO_SOURCES_UPDATED_EVENT, handleTrustedSourcesUpdated);
    window.addEventListener(LOCAL_MEMOS_UPDATED_EVENT, handleLocalMemosUpdated);
    return () => {
      window.removeEventListener(TRUSTED_MEMO_SOURCES_UPDATED_EVENT, handleTrustedSourcesUpdated);
      window.removeEventListener(LOCAL_MEMOS_UPDATED_EVENT, handleLocalMemosUpdated);
    };
  }, [conversationId]);

  function removeSource(sourceId: string) {
    setTrustedSources((prev) => {
      const next = prev.filter((source) => source.id !== sourceId);
      writeTrustedMemoSources(conversationId, next);
      notifyTrustedMemoSourcesUpdated(conversationId);
      return next;
    });
  }

  function generateLocalMemoDraft() {
    if (trustedSources.length === 0) return;
    const now = new Date().toISOString();
    const draft: LocalMemoDraft = {
      id: `local-memo-${Date.now()}`,
      datasetId,
      title: `${datasetName} 投资 memo 草稿`,
      sourceCount: trustedSources.length,
      status: "draft",
      createdAt: now,
    };
    setLocalMemos((prev) => {
      const next = [draft, ...prev];
      writeLocalMemos(conversationId, next);
      notifyLocalMemosUpdated(conversationId);
      return next;
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-border border-b px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">输出资源</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{datasetName}</p>
          </div>
          {projectQuery.isLoading ? (
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
          ) : (
            <span className="inline-flex h-6 shrink-0 items-center rounded-full border border-border px-2 text-xs text-muted-foreground">
              {sourceCountLabel}
            </span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-3">
        <section>
          <div className="px-1">
            <div className="min-w-0">
              <h3 className="text-sm font-medium">可信来源</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                从 AI 回答沉淀，用于后续 memo 依据。
              </p>
            </div>
          </div>

          {trustedSources.length === 0 ? (
            <div className="mt-2">
              <MemoListEmpty>
                暂无可信来源。请在对话中的完整 AI 回答下点击“加入可信来源”。
              </MemoListEmpty>
            </div>
          ) : (
            <ul className="mt-2 flex flex-col gap-0.5">
              {trustedSources.map((source, index) => (
                <li key={source.id}>
                  <div className="group flex w-full min-w-0 items-start gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted">
                    <FileSearchIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {sourceTitle(source, index)}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {formatDateTime(source.createdAt)}
                        </span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-muted-foreground">
                        {source.content}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="size-7 shrink-0 text-muted-foreground opacity-70 transition-opacity group-hover:opacity-100"
                      aria-label={`移除 ${sourceTitle(source, index)}`}
                      onClick={() => removeSource(source.id)}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <div className="flex items-start justify-between gap-3 px-1">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <FileTextIcon className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">历史 memo / memo 草稿</h3>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                前端草稿只记录生成动作，暂不调用后端。
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              className="h-8 shrink-0"
              disabled={trustedSources.length === 0}
              onClick={generateLocalMemoDraft}
            >
              生成 memo
            </Button>
          </div>

          <ul className="mt-2 flex flex-col gap-0.5">
            {localMemos.map((memo) => (
              <li key={memo.id}>
                <div className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted">
                  <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium">{memo.title}</span>
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        草稿
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-muted-foreground">
                      {memo.sourceCount} 条来源 · {formatDateTime(memo.createdAt)}
                    </p>
                  </div>
                </div>
              </li>
            ))}

            {(project?.latestMemoName || latestMemoUrl) && (
              <li>
                <div className="group flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted">
                  <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {project?.latestMemoName ?? "Latest memo"}
                    </span>
                    <p className="mt-0.5 truncate text-muted-foreground">项目已有 memo 产物</p>
                  </div>
                  {latestMemoUrl && (
                    <Button asChild variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs">
                      <a href={latestMemoUrl} target="_blank" rel="noreferrer">
                        打开
                      </a>
                    </Button>
                  )}
                </div>
              </li>
            )}
          </ul>

          {!hasMemoArtifacts && (
            <div className="mt-2">
              <MemoListEmpty>
                暂无 memo 草稿。加入可信来源后可在这里生成本地草稿记录。
              </MemoListEmpty>
            </div>
          )}
        </section>
      </div>
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
}) {
  const activeTab = rightRailTab === "sources" && pdfSourceSelection ? "sources" : "memo";
  return (
    <aside
      aria-label="Workspace"
      inert={inert}
      // Private-fund sessions use the selected flat research-workspace layout:
      // a persistent output column divided from chat, while keeping the same
      // resizable rail, tabs, memo actions, and optional source viewer.
      className="private-fund-output-panel @container/rail relative z-40 hidden md:mt-14 md:flex md:min-h-0 md:shrink-0 md:flex-col md:overflow-hidden md:border-l md:border-border md:bg-background"
      style={{ width }}
    >
      <div
        {...handleProps}
        className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-primary/30 active:bg-primary/50"
      />
      <div className="flex shrink-0 items-center overflow-x-auto overflow-y-hidden border-border border-b px-2 py-1.5 [scrollbar-width:thin] @min-[500px]/rail:overflow-x-hidden [&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent">
        <Tabs
          className="shrink-0"
          value={activeTab}
          onValueChange={(value) => onRightRailTabChange(value as RightRailTab)}
        >
          <TabsList variant="pill">
            <TabsTrigger
              value="memo"
              className="h-[32px] gap-[6px] rounded-[8px] px-[12px] text-[13px] leading-5"
            >
              <FileTextIcon className="size-4" />
              Memo
            </TabsTrigger>
            {pdfSourceSelection && (
              <TabsTrigger
                value="sources"
                className="h-[32px] gap-[6px] rounded-[8px] px-[12px] text-[13px] leading-5"
              >
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
        ) : (
          <PrivateFundMemoContent
            conversationId={conversationId}
            datasetId={datasetId}
            datasetName={datasetName}
          />
        )}
      </div>
    </aside>
  );
}
