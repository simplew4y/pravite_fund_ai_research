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
  X,
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
type AssetSort = "updated" | "oldest" | "title" | "type" | "evidence";

export type ResearchAssetLibraryZone = "sources" | "notes" | "memos" | "generic";

export type ResearchAssetLibraryProps = {
  assets: PrivateFundAsset[];
  contextAssetIds: string[];
  title?: string;
  description?: string;
  emptyMessage?: string;
  compact?: boolean;
  /** Controls which filters/copy apply for the functional area. */
  zone?: ResearchAssetLibraryZone;
  contextPending?: boolean;
  onSetContext: (assetIds: string[]) => Promise<void> | void;
  onOpenAsset: (asset: PrivateFundAsset) => void;
  onDeleteAssets: (assetIds: string[]) => Promise<void>;
};

const typeLabels: Record<string, string> = {
  document: "资料",
  information: "回答笔记",
  analysis: "研究笔记",
  metrics: "关键指标",
  table: "表格",
  chart: "图表",
  infographic: "信息图",
  memo: "Memo",
  report: "专业研报",
};

const documentTypeLabels: Record<string, string> = {
  financial_report: "财报",
  annual_report: "年报",
  interim_report: "中报",
  quarterly_report: "季报",
  earnings_release: "业绩公告",
  preliminary_results: "业绩预告/快报",
  results_announcement: "业绩发布",
  meeting_minutes: "会议纪要",
  earnings_call: "业绩电话会",
  research_meeting: "调研纪要",
  expert_interview: "专家访谈",
  internal_meeting: "内部会议",
  valuation_model: "估值模型",
  dcf_model: "DCF 模型",
  comparable_company_model: "可比公司估值",
  financial_forecast_model: "财务预测模型",
  integrated_valuation_model: "综合估值模型",
  research_report: "研究报告",
  broker_company_report: "券商公司研报",
  broker_industry_report: "券商行业研报",
  internal_research_report: "内部研究报告",
  investor_presentation: "投资者演示",
  roadshow: "路演材料",
  investor_day: "投资者日材料",
  results_presentation: "业绩演示材料",
  regulatory_announcement: "监管公告",
  exchange_announcement: "交易所公告",
  corporate_action: "公司行动公告",
  risk_disclosure: "风险披露",
  financial_dataset: "财务数据",
  financial_statements: "财务报表数据",
  operating_data: "经营数据",
  market_data: "市场数据",
  company_material: "公司资料",
  company_profile: "公司简介",
  product_material: "产品资料",
  strategy_material: "战略资料",
  other: "其他资料",
  unknown: "待识别",
};

function documentType(asset: PrivateFundAsset): string {
  if (asset.assetType !== "document") return "";
  const subtype = asset.metadata.doc_subtype;
  if (typeof subtype === "string" && subtype) return subtype;
  const type = asset.metadata.doc_type;
  return typeof type === "string" && type ? type : "unknown";
}

function assetTypeLabel(asset: PrivateFundAsset): string {
  const classifiedType = documentType(asset);
  if (classifiedType) return documentTypeLabels[classifiedType] ?? classifiedType;
  if (asset.displayLabel) return asset.displayLabel;
  return typeLabels[asset.assetType] ?? asset.assetType;
}

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

function AssetRowCheckbox({
  asset,
  label,
  checked,
  disabled,
  onChange,
}: {
  asset: PrivateFundAsset;
  label?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <input
      aria-label={label ?? `加入上下文 ${asset.title}`}
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
  title = "资产库",
  description,
  emptyMessage = "暂无内容。上传资料、保存回答笔记或生成研究笔记后会出现在这里。",
  compact = false,
  zone = "generic",
  contextPending,
  onSetContext,
  onOpenAsset,
  onDeleteAssets,
}: ResearchAssetLibraryProps) {
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [documentTypeFilter, setDocumentTypeFilter] = useState("all");
  const [noteGroupFilter, setNoteGroupFilter] = useState<"all" | "answer_note" | "research_note">(
    "all",
  );
  const [sort, setSort] = useState<AssetSort>("updated");
  const [view, setView] = useState<AssetView>("list");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const availableTypes = useMemo(
    () => [...new Set(assets.map((asset) => asset.assetType))].sort(),
    [assets],
  );
  const availableDocumentTypes = useMemo(
    () => [...new Set(assets.map(documentType).filter(Boolean))].sort(),
    [assets],
  );
  const visibleAssets = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const filtered = assets.filter((asset) => {
      if (zone === "notes" && noteGroupFilter !== "all") {
        const group =
          asset.displayGroup ||
          (asset.assetType === "information" ? "answer_note" : "research_note");
        if (group !== noteGroupFilter) return false;
      }
      if (typeFilter !== "all" && asset.assetType !== typeFilter) return false;
      if (documentTypeFilter !== "all" && documentType(asset) !== documentTypeFilter) return false;
      if (
        needle &&
        !`${asset.title} ${asset.summary} ${asset.tags.join(" ")} ${asset.displayLabel ?? ""}`
          .toLocaleLowerCase()
          .includes(needle)
      ) {
        return false;
      }
      return true;
    });
    return filtered.sort((left, right) => {
      if (sort === "title") return left.title.localeCompare(right.title, "zh-CN");
      if (sort === "type") return left.assetType.localeCompare(right.assetType);
      if (sort === "evidence") return right.evidenceCount - left.evidenceCount;
      if (sort === "oldest") {
        return String(left.updatedAt ?? left.createdAt ?? "").localeCompare(
          String(right.updatedAt ?? right.createdAt ?? ""),
        );
      }
      return String(right.updatedAt ?? right.createdAt ?? "").localeCompare(
        String(left.updatedAt ?? left.createdAt ?? ""),
      );
    });
  }, [assets, documentTypeFilter, noteGroupFilter, query, sort, typeFilter, zone]);
  const visibleAssetIds = useMemo(
    () => visibleAssets.map((asset) => asset.assetId),
    [visibleAssets],
  );
  const contextSet = useMemo(() => new Set(contextAssetIds), [contextAssetIds]);
  const selectedAssetIds = useMemo(
    () => assets.filter((asset) => contextSet.has(asset.assetId)).map((asset) => asset.assetId),
    [assets, contextSet],
  );
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

  function toggleAssetSelection(assetId: string) {
    const next = new Set(contextAssetIds);
    if (next.has(assetId)) next.delete(assetId);
    else next.add(assetId);
    void onSetContext([...next]);
  }

  function clearAssetSelection() {
    const next = new Set(contextAssetIds);
    for (const assetId of selectedAssetIds) next.delete(assetId);
    void onSetContext([...next]);
  }

  async function confirmDelete() {
    if (selectedAssetIds.length === 0) return;
    setDeletePending(true);
    setDeleteError("");
    try {
      await onDeleteAssets(selectedAssetIds);
      setDeleteOpen(false);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "删除失败");
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <section
      aria-label={title}
      className="private-fund-asset-library flex min-h-0 flex-1 flex-col bg-[var(--pf-panel)] text-[var(--pf-ink)]"
    >
      <Dialog open={deleteOpen} onOpenChange={(open) => !deletePending && setDeleteOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除 {selectedAssetIds.length} 项？</DialogTitle>
            <DialogDescription>
              此操作不可撤销。研究笔记会连同其中的图表等内容一起删除；Memo 会删除对应产物文件。
              {includesDocument ? "所选资料也会从当前项目资料来源中移除。" : ""}
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
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="mt-0.5 text-xs text-[var(--pf-ink-muted)]">
              {description ?? `${assets.length} 项资产，${selectedAssetIds.length} 项已选`}
            </p>
          </div>
          {!compact ? (
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
          ) : null}
        </div>
        <label className="relative block">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--pf-ink-muted)]" />
          <input
            aria-label="搜索"
            className="h-9 w-full rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] pl-8 pr-3 text-xs outline-none placeholder:text-[var(--pf-ink-muted)] focus:border-[var(--pf-accent)] focus:ring-2 focus:ring-[var(--pf-accent-soft)]"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题、摘要或标签"
            value={query}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          {zone === "notes" ? (
            <label className="relative col-span-2">
              <span className="sr-only">笔记类型</span>
              <select
                aria-label="笔记类型"
                className="h-8 w-full rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] px-2 text-xs"
                onChange={(event) =>
                  setNoteGroupFilter(event.target.value as "all" | "answer_note" | "research_note")
                }
                value={noteGroupFilter}
              >
                <option value="all">全部笔记</option>
                <option value="answer_note">回答笔记</option>
                <option value="research_note">研究笔记</option>
              </select>
            </label>
          ) : null}
          {zone === "sources" || (zone === "generic" && availableDocumentTypes.length > 0) ? (
            <label className={zone === "sources" ? "relative col-span-2" : "relative"}>
              <span className="sr-only">资料类型</span>
              <select
                aria-label="资料类型"
                className="h-8 w-full rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] px-2 text-xs"
                onChange={(event) => setDocumentTypeFilter(event.target.value)}
                value={documentTypeFilter}
              >
                <option value="all">全部资料类型</option>
                {availableDocumentTypes.map((type) => (
                  <option key={type} value={type}>
                    {documentTypeLabels[type] ?? type}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {zone === "generic" ? (
            <label className="relative">
              <span className="sr-only">条目类型</span>
              <select
                aria-label="条目类型"
                className="h-8 w-full rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] px-2 text-xs"
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
          ) : null}
          <label
            className={
              zone === "notes" || zone === "sources" ? "relative col-span-2" : "relative col-span-2"
            }
          >
            <ArrowDownAZ className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-[var(--pf-ink-muted)]" />
            <span className="sr-only">排序</span>
            <select
              aria-label="排序"
              className="h-8 w-full rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] pl-7 pr-2 text-xs"
              onChange={(event) => setSort(event.target.value as AssetSort)}
              value={sort}
            >
              <option value="updated">最近更新</option>
              <option value="oldest">最早更新</option>
              <option value="title">标题</option>
              <option value="type">类型</option>
              <option value="evidence">溯源数量</option>
            </select>
          </label>
        </div>
        <div className="flex min-h-9 flex-wrap items-center gap-2 rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] px-2 py-1">
          <label className="flex min-w-0 cursor-pointer items-center gap-2 text-xs font-medium">
            <AssetSelectionCheckbox
              checked={allVisibleSelected}
              label="选择当前显示的全部条目"
              mixed={someVisibleSelected}
              disabled={visibleAssetIds.length === 0 || contextPending}
              onChange={toggleVisibleAssets}
            />
            <span className="truncate">{selectedAssetIds.length} 项已选</span>
          </label>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Button
              aria-label={`删除已选 ${selectedAssetIds.length} 项`}
              className="h-7 shrink-0 gap-1 px-2 text-xs"
              disabled={selectedAssetIds.length === 0 || contextPending}
              onClick={() => {
                setDeleteError("");
                setDeleteOpen(true);
              }}
              size="sm"
              type="button"
              variant="destructive"
            >
              <Trash2 className="size-3" />
              删除{selectedAssetIds.length > 0 ? ` ${selectedAssetIds.length}` : ""}
            </Button>
            {selectedAssetIds.length > 0 ? (
              <Button
                aria-label="清除选择"
                className="size-7"
                disabled={contextPending}
                onClick={clearAssetSelection}
                size="icon"
                type="button"
                variant="ghost"
              >
                <X className="size-3.5" />
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {visibleAssets.length === 0 ? (
          <div className="m-4 rounded-2xl border border-dashed border-[var(--pf-line-strong)] bg-[var(--pf-panel-raised)] p-7 text-center text-xs leading-5 text-[var(--pf-ink-muted)]">
            {emptyMessage}
          </div>
        ) : compact ? (
          <ul className="divide-y divide-[var(--pf-line)] px-3">
            {visibleAssets.map((asset) => (
              <li className="flex items-start gap-2.5 py-3" key={asset.assetId}>
                <AssetRowCheckbox
                  asset={asset}
                  checked={contextSet.has(asset.assetId)}
                  disabled={contextPending}
                  label={`加入上下文 ${asset.title}`}
                  onChange={() => toggleAssetSelection(asset.assetId)}
                />
                <button
                  aria-label={`打开资产 ${asset.title}`}
                  className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)]"
                  onClick={() => onOpenAsset(asset)}
                  type="button"
                >
                  <span className="flex items-start gap-2">
                    <span className="mt-0.5 rounded-md bg-[var(--pf-accent-soft)] p-1.5 text-[var(--pf-accent-ink)]">
                      <AssetIcon className="size-3.5" type={asset.assetType} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{asset.title}</span>
                      <span className="mt-0.5 block line-clamp-2 text-xs leading-5 text-[var(--pf-ink-secondary)]">
                        {asset.summary || asset.contentMarkdown || "暂无摘要"}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-[var(--pf-ink-muted)]">
                        <span>{assetTypeLabel(asset)}</span>
                        <span>·</span>
                        <span>{formatDate(asset.updatedAt ?? asset.createdAt)}</span>
                        {contextSet.has(asset.assetId) ? (
                          <>
                            <span>·</span>
                            <span className="text-[var(--pf-accent-ink)]">已加入上下文</span>
                          </>
                        ) : null}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : view === "list" ? (
          <table className="w-full table-fixed border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 bg-[var(--pf-panel-subtle)] text-xs text-[var(--pf-ink-muted)]">
              <tr>
                <th className="w-12 px-3 py-2" title="加入上下文">
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
                    <AssetRowCheckbox
                      asset={asset}
                      checked={contextSet.has(asset.assetId)}
                      disabled={contextPending}
                      label={`加入上下文 ${asset.title}`}
                      onChange={() => toggleAssetSelection(asset.assetId)}
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
                        <p className="mt-1 text-[11px] text-[var(--pf-ink-muted)]">
                          v{asset.versionNo} / {asset.evidenceCount} 条溯源
                          {contextSet.has(asset.assetId) ? " / 已加入上下文" : ""}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-3 align-top text-[var(--pf-ink-secondary)]">
                    {assetTypeLabel(asset)}
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
                  "min-h-36 rounded-2xl border bg-[var(--pf-panel-raised)] p-3 text-left transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:border-[var(--pf-line-strong)] hover:shadow-[var(--pf-shadow)]",
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
                  <label className="flex cursor-pointer items-center gap-1 text-[11px] text-[var(--pf-ink-muted)]">
                    <AssetRowCheckbox
                      asset={asset}
                      checked={contextSet.has(asset.assetId)}
                      disabled={contextPending}
                      label={`加入上下文 ${asset.title}`}
                      onChange={() => toggleAssetSelection(asset.assetId)}
                    />
                    {contextSet.has(asset.assetId) ? "已加入上下文" : "选择"}
                  </label>
                </div>
                <button
                  aria-label={`打开资产 ${asset.title}`}
                  className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)]"
                  onClick={() => onOpenAsset(asset)}
                  type="button"
                >
                  <p className="mt-3 line-clamp-2 text-sm font-semibold leading-5">{asset.title}</p>
                  <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-[var(--pf-ink-secondary)]">
                    {asset.summary || asset.contentMarkdown}
                  </p>
                  <p className="mt-2 text-[11px] text-[var(--pf-ink-muted)]">
                    {assetTypeLabel(asset)} / {asset.evidenceCount} 条溯源
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
