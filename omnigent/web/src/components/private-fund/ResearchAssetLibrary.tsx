import {
  ArrowDownAZ,
  BarChart3,
  FileSpreadsheet,
  FileText,
  GalleryVerticalEnd,
  Grid2X2,
  Image,
  Info,
  LayoutList,
  Search,
  Table2,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PrivateFundAsset } from "@/lib/privateFundApi";
import { cn } from "@/lib/utils";

type AssetView = "list" | "grid";
type AssetSort = "updated" | "title" | "type" | "evidence";

export type ResearchAssetLibraryProps = {
  assets: PrivateFundAsset[];
  contextAssetIds: string[];
  contextPending?: boolean;
  onSetContext: (assetIds: string[]) => Promise<void> | void;
  onToggleContext: (assetId: string) => void;
  onOpenAsset: (asset: PrivateFundAsset) => void;
  onDeleteAssets: (assetIds: string[]) => Promise<void>;
};

const typeLabels: Record<string, string> = {
  document: "原始资料",
  information: "重要信息",
  analysis: "分析输出",
  metrics: "关键指标",
  table: "表格",
  chart: "图表",
  infographic: "信息图",
  memo: "Memo",
  report: "专业研报",
};

function AssetIcon({ type, className }: { type: string; className?: string }) {
  const Icon =
    type === "document"
      ? FileText
      : type === "table"
        ? Table2
        : type === "chart"
          ? BarChart3
          : type === "infographic"
            ? Image
            : type === "memo"
              ? GalleryVerticalEnd
              : type === "metrics"
                ? FileSpreadsheet
                : Info;
  return <Icon className={className} />;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date);
}

function AssetContextCheckbox({
  asset,
  checked,
  disabled,
  onChange,
}: {
  asset: PrivateFundAsset;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <input
      aria-label={`选择资产 ${asset.title}`}
      checked={checked}
      className="size-3.5 cursor-pointer accent-[var(--pf-accent)] disabled:cursor-wait"
      disabled={disabled}
      onChange={onChange}
      onClick={(event) => event.stopPropagation()}
      type="checkbox"
    />
  );
}

function AssetSelectionCheckbox({
  label,
  checked,
  mixed = false,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  mixed?: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      aria-label={label}
      checked={checked}
      className="size-3.5 cursor-pointer accent-[var(--pf-accent)] disabled:cursor-not-allowed"
      disabled={disabled}
      onChange={onChange}
      onClick={(event) => event.stopPropagation()}
      ref={ref}
      type="checkbox"
    />
  );
}

export function ResearchAssetLibrary({
  assets,
  contextAssetIds,
  contextPending,
  onSetContext,
  onToggleContext,
  onOpenAsset,
  onDeleteAssets,
}: ResearchAssetLibraryProps) {
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [sort, setSort] = useState<AssetSort>("updated");
  const [view, setView] = useState<AssetView>("list");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const availableTypes = useMemo(
    () => [...new Set(assets.map((asset) => asset.assetType))].sort(),
    [assets],
  );
  const visibleAssets = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const filtered = assets.filter(
      (asset) =>
        (typeFilter === "all" || asset.assetType === typeFilter) &&
        (!needle ||
          `${asset.title} ${asset.summary} ${asset.tags.join(" ")}`
            .toLocaleLowerCase()
            .includes(needle)),
    );
    return filtered.sort((left, right) => {
      if (sort === "title") return left.title.localeCompare(right.title, "zh-CN");
      if (sort === "type") return left.assetType.localeCompare(right.assetType);
      if (sort === "evidence") return right.evidenceCount - left.evidenceCount;
      return String(right.updatedAt ?? right.createdAt ?? "").localeCompare(
        String(left.updatedAt ?? left.createdAt ?? ""),
      );
    });
  }, [assets, query, sort, typeFilter]);
  const visibleAssetIds = useMemo(
    () => visibleAssets.map((asset) => asset.assetId),
    [visibleAssets],
  );
  const contextSet = useMemo(() => new Set(contextAssetIds), [contextAssetIds]);
  const visibleSelectedCount = visibleAssetIds.filter((assetId) => contextSet.has(assetId)).length;
  const allVisibleSelected =
    visibleAssetIds.length > 0 && visibleSelectedCount === visibleAssetIds.length;
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;
  const selectedAssets = assets.filter((asset) => contextSet.has(asset.assetId));
  const includesDocument = selectedAssets.some((asset) => asset.assetType === "document");

  function toggleVisibleAssets() {
    const next = new Set(contextAssetIds);
    if (allVisibleSelected) {
      for (const assetId of visibleAssetIds) next.delete(assetId);
    } else {
      for (const assetId of visibleAssetIds) next.add(assetId);
    }
    void onSetContext([...next]);
  }

  async function confirmDelete() {
    if (contextAssetIds.length === 0) return;
    setDeletePending(true);
    setDeleteError("");
    try {
      await onDeleteAssets(contextAssetIds);
      setDeleteOpen(false);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "删除资产失败");
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <section
      aria-label="资产库"
      className="flex min-h-0 flex-1 flex-col bg-[var(--pf-panel)] text-[var(--pf-ink)]"
    >
      <Dialog open={deleteOpen} onOpenChange={(open) => !deletePending && setDeleteOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除 {contextAssetIds.length} 项资产？</DialogTitle>
            <DialogDescription>
              此操作不可撤销。分析节点会连同其图表和上下文引用一起删除，Memo/研报会删除对应产物文件。
              {includesDocument ? "所选原始资料也会从当前项目资料来源中移除。" : ""}
            </DialogDescription>
          </DialogHeader>
          {deleteError ? (
            <p className="text-sm text-destructive" role="alert">
              {deleteError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={deletePending}
              onClick={() => setDeleteOpen(false)}
              type="button"
              variant="ghost"
            >
              取消
            </Button>
            <Button
              disabled={deletePending}
              onClick={() => void confirmDelete()}
              type="button"
              variant="destructive"
            >
              {deletePending ? "正在删除…" : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="space-y-2.5 border-b border-[var(--pf-line)] p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">资产库</h2>
            <p className="mt-0.5 text-[10px] text-[var(--pf-ink-muted)]">
              {assets.length} 项资产 · 已选 {contextAssetIds.length} 项，勾选后加入本轮上下文
            </p>
          </div>
          <div className="flex rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] p-0.5">
            <button
              aria-label="列表视图"
              className={cn(
                "rounded-md p-1.5 text-[var(--pf-ink-muted)]",
                view === "list" && "bg-[var(--pf-panel-raised)] text-[var(--pf-ink)] shadow-sm",
              )}
              onClick={() => setView("list")}
              type="button"
            >
              <LayoutList size={14} />
            </button>
            <button
              aria-label="卡片视图"
              className={cn(
                "rounded-md p-1.5 text-[var(--pf-ink-muted)]",
                view === "grid" && "bg-[var(--pf-panel-raised)] text-[var(--pf-ink)] shadow-sm",
              )}
              onClick={() => setView("grid")}
              type="button"
            >
              <Grid2X2 size={14} />
            </button>
          </div>
        </div>
        <label className="relative block">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--pf-ink-muted)]" />
          <input
            aria-label="搜索资产"
            className="h-9 w-full rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] pl-8 pr-3 text-xs outline-none placeholder:text-[var(--pf-ink-muted)] focus:border-[var(--pf-accent)] focus:ring-2 focus:ring-[var(--pf-accent-soft)]"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题、摘要或标签"
            value={query}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="relative">
            <span className="sr-only">资产类型</span>
            <select
              aria-label="资产类型"
              className="h-8 w-full rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] px-2 text-[11px]"
              onChange={(event) => setTypeFilter(event.target.value)}
              value={typeFilter}
            >
              <option value="all">全部类型</option>
              {availableTypes.map((type) => (
                <option key={type} value={type}>
                  {typeLabels[type] ?? type}
                </option>
              ))}
            </select>
          </label>
          <label className="relative">
            <ArrowDownAZ className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-[var(--pf-ink-muted)]" />
            <span className="sr-only">资产排序</span>
            <select
              aria-label="资产排序"
              className="h-8 w-full rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] pl-7 pr-2 text-[11px]"
              onChange={(event) => setSort(event.target.value as AssetSort)}
              value={sort}
            >
              <option value="updated">最近更新</option>
              <option value="title">标题</option>
              <option value="type">类型</option>
              <option value="evidence">溯源数量</option>
            </select>
          </label>
        </div>
        <div className="flex min-h-8 items-center justify-between gap-2 rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] px-2">
          <label className="flex min-w-0 cursor-pointer items-center gap-2 text-[11px] font-medium">
            <AssetSelectionCheckbox
              checked={allVisibleSelected}
              label="全选当前资产"
              mixed={someVisibleSelected}
              disabled={contextPending || visibleAssetIds.length === 0}
              onChange={toggleVisibleAssets}
            />
            <span className="truncate">{allVisibleSelected ? "取消全选" : "全选当前结果"}</span>
          </label>
          <Button
            aria-label={`删除已选资产 ${contextAssetIds.length} 项`}
            className="h-7 shrink-0 gap-1 px-2 text-[11px]"
            disabled={contextAssetIds.length === 0 || contextPending}
            onClick={() => {
              setDeleteError("");
              setDeleteOpen(true);
            }}
            size="sm"
            type="button"
            variant="destructive"
          >
            <Trash2 className="size-3" />
            删除{contextAssetIds.length > 0 ? ` ${contextAssetIds.length}` : ""}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {visibleAssets.length === 0 ? (
          <div className="m-4 rounded-xl border border-dashed border-[var(--pf-line-strong)] p-7 text-center text-xs leading-5 text-[var(--pf-ink-muted)]">
            没有符合条件的资产。上传资料、勾选重要信息或让 Agent 生成输出后，会自动出现在这里。
          </div>
        ) : view === "list" ? (
          <table className="w-full table-fixed border-collapse text-left text-[11px]">
            <thead className="sticky top-0 z-10 bg-[var(--pf-panel-subtle)] text-[10px] text-[var(--pf-ink-muted)]">
              <tr>
                <th className="w-9 px-3 py-2" title="选择资产并加入上下文">
                  选择
                </th>
                <th className="px-2 py-2">资产</th>
                <th className="w-20 px-2 py-2">类型</th>
                <th className="w-14 px-2 py-2">更新</th>
              </tr>
            </thead>
            <tbody>
              {visibleAssets.map((asset) => (
                <tr
                  className="cursor-pointer border-t border-[var(--pf-line)] transition-colors hover:bg-[var(--pf-panel-subtle)]"
                  key={asset.assetId}
                  onClick={() => onOpenAsset(asset)}
                >
                  <td className="px-3 py-3 align-top">
                    <AssetContextCheckbox
                      asset={asset}
                      checked={contextSet.has(asset.assetId)}
                      disabled={contextPending}
                      onChange={() => onToggleContext(asset.assetId)}
                    />
                  </td>
                  <td className="px-2 py-2.5">
                    <div className="flex min-w-0 items-start gap-2">
                      <span className="mt-0.5 rounded-lg bg-[var(--pf-accent-soft)] p-1.5 text-[var(--pf-accent-ink)]">
                        <AssetIcon className="size-3.5" type={asset.assetType} />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{asset.title}</p>
                        <p className="mt-0.5 line-clamp-2 leading-4 text-[var(--pf-ink-secondary)]">
                          {asset.summary || asset.contentMarkdown}
                        </p>
                        <p className="mt-1 text-[9px] text-[var(--pf-ink-muted)]">
                          v{asset.versionNo} · {asset.evidenceCount} 条溯源
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-3 align-top text-[var(--pf-ink-secondary)]">
                    {typeLabels[asset.assetType] ?? asset.assetType}
                  </td>
                  <td className="px-2 py-3 align-top text-[var(--pf-ink-muted)]">
                    {formatDate(asset.updatedAt ?? asset.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
            {visibleAssets.map((asset) => (
              <div
                className={cn(
                  "min-h-36 rounded-xl border bg-[var(--pf-panel-raised)] p-3 text-left transition hover:-translate-y-0.5 hover:border-[var(--pf-line-strong)] hover:shadow-[var(--pf-shadow)]",
                  contextSet.has(asset.assetId)
                    ? "border-[var(--pf-accent)]"
                    : "border-[var(--pf-line)]",
                )}
                key={asset.assetId}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded-lg bg-[var(--pf-accent-soft)] p-2 text-[var(--pf-accent-ink)]">
                      <AssetIcon className="size-4" type={asset.assetType} />
                    </span>
                  </div>
                  <label className="flex cursor-pointer items-center gap-1 text-[9px] text-[var(--pf-ink-muted)]">
                    <AssetContextCheckbox
                      asset={asset}
                      checked={contextSet.has(asset.assetId)}
                      disabled={contextPending}
                      onChange={() => onToggleContext(asset.assetId)}
                    />
                    选择
                  </label>
                </div>
                <button
                  aria-label={`打开资产 ${asset.title}`}
                  className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)]"
                  onClick={() => onOpenAsset(asset)}
                  type="button"
                >
                  <p className="mt-3 line-clamp-2 text-xs font-semibold leading-4">{asset.title}</p>
                  <p className="mt-1.5 line-clamp-2 text-[10px] leading-4 text-[var(--pf-ink-secondary)]">
                    {asset.summary || asset.contentMarkdown}
                  </p>
                  <p className="mt-2 text-[9px] text-[var(--pf-ink-muted)]">
                    {typeLabels[asset.assetType] ?? asset.assetType} · {asset.evidenceCount} 条溯源
                  </p>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
