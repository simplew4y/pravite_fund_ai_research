import {
  ArrowDownAZ,
  BarChart3,
  Check,
  ChevronDown,
  ChevronRight,
  FileSpreadsheet,
  FileText,
  GalleryVerticalEnd,
  GitCompareArrows,
  Grid2X2,
  History,
  Image,
  Info,
  LayoutList,
  ListChecks,
  Search,
  SlidersHorizontal,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { currentAppLocale, formatLocalizedDate } from "@/lib/localeFormat";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  onOpenMemoHistory?: (seriesId: string) => void;
  onDeleteAssets: (assetIds: string[]) => Promise<void>;
  /** Incremented by an external entry point to open batch-management mode. */
  managementRequestId?: number;
};

type MemoAssetSeries = {
  seriesId: string;
  title: string;
  current: PrivateFundAsset;
  versions: PrivateFundAsset[];
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

const typeLabelsEn: Record<string, string> = {
  document: "Source",
  information: "Answer note",
  analysis: "Research note",
  metrics: "Key metrics",
  table: "Table",
  chart: "Chart",
  infographic: "Infographic",
  memo: "Memo",
  report: "Research report",
};

const documentTypeLabels: Record<string, string> = {
  financial_valuation_data: "财报与估值数据",
  meeting_third_party: "会议与第三方信息",
  other: "其他",
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
  unknown: "待识别",
};

const documentTypeLabelsEn: Record<string, string> = {
  financial_valuation_data: "Financial and valuation data",
  meeting_third_party: "Meetings and third-party information",
  other: "Other",
  financial_report: "Financial report",
  annual_report: "Annual report",
  interim_report: "Interim report",
  quarterly_report: "Quarterly report",
  earnings_release: "Earnings release",
  preliminary_results: "Preliminary results",
  results_announcement: "Results announcement",
  meeting_minutes: "Meeting minutes",
  earnings_call: "Earnings call",
  research_meeting: "Research meeting notes",
  expert_interview: "Expert interview",
  internal_meeting: "Internal meeting",
  valuation_model: "Valuation model",
  dcf_model: "DCF model",
  comparable_company_model: "Comparable-company valuation",
  financial_forecast_model: "Financial forecast model",
  integrated_valuation_model: "Integrated valuation model",
  research_report: "Research report",
  broker_company_report: "Broker company report",
  broker_industry_report: "Broker industry report",
  internal_research_report: "Internal research report",
  investor_presentation: "Investor presentation",
  roadshow: "Roadshow materials",
  investor_day: "Investor day materials",
  results_presentation: "Results presentation",
  regulatory_announcement: "Regulatory announcement",
  exchange_announcement: "Exchange announcement",
  corporate_action: "Corporate action announcement",
  risk_disclosure: "Risk disclosure",
  financial_dataset: "Financial data",
  financial_statements: "Financial statements",
  operating_data: "Operating data",
  market_data: "Market data",
  company_material: "Company materials",
  company_profile: "Company profile",
  product_material: "Product materials",
  strategy_material: "Strategy materials",
  unknown: "Unclassified",
};

function documentType(asset: PrivateFundAsset): string {
  if (asset.assetType !== "document") return "";
  const type = asset.metadata.doc_type;
  if (typeof type === "string" && type) return type;
  const subtype = asset.metadata.doc_subtype;
  return typeof subtype === "string" && subtype ? subtype : "other";
}

function assetTypeLabel(asset: PrivateFundAsset): string {
  const english = currentAppLocale() === "en-US";
  const classifiedType = documentType(asset);
  if (classifiedType) {
    return (english ? documentTypeLabelsEn : documentTypeLabels)[classifiedType] ?? classifiedType;
  }
  if (asset.displayLabel) return asset.displayLabel;
  return (english ? typeLabelsEn : typeLabels)[asset.assetType] ?? asset.assetType;
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
  return formatLocalizedDate(date, { month: "2-digit", day: "2-digit" });
}

function formatUpdatedDate(value: string | null | undefined): string {
  if (!value) return i18n.t("assets.updatedUnknown");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return i18n.t("assets.updatedUnknown");
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDifference = Math.round((startOfToday - startOfDate) / 86_400_000);
  if (dayDifference === 0) return i18n.t("assets.updatedToday");
  if (dayDifference === 1) return i18n.t("assets.updatedYesterday");
  return i18n.t("assets.updatedDate", { value: formatDate(value) });
}

function memoSeriesId(asset: PrivateFundAsset): string {
  const seriesId = asset.metadata.series_id;
  return typeof seriesId === "string" && seriesId.trim() ? seriesId : `standalone:${asset.assetId}`;
}

function groupMemoAssets(assets: PrivateFundAsset[]): MemoAssetSeries[] {
  const groups = new Map<string, PrivateFundAsset[]>();
  for (const asset of assets) {
    const seriesId = memoSeriesId(asset);
    const versions = groups.get(seriesId) ?? [];
    versions.push(asset);
    groups.set(seriesId, versions);
  }
  return [...groups.entries()].map(([seriesId, seriesAssets]) => {
    const versions = [...seriesAssets].sort((left, right) => {
      if (right.versionNo !== left.versionNo) return right.versionNo - left.versionNo;
      return String(right.updatedAt ?? right.createdAt ?? "").localeCompare(
        String(left.updatedAt ?? left.createdAt ?? ""),
      );
    });
    return {
      seriesId,
      title: versions[0].title,
      current: versions[0],
      versions,
    };
  });
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
      aria-label={label ?? i18n.t("assets.addContext", { title: asset.title })}
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
  title: titleProp,
  description,
  emptyMessage: emptyMessageProp,
  compact = false,
  zone = "generic",
  contextPending,
  onSetContext,
  onOpenAsset,
  onOpenMemoHistory,
  onDeleteAssets,
  managementRequestId,
}: ResearchAssetLibraryProps) {
  const { t } = useTranslation();
  const title = titleProp ?? t("privateFund.assets");
  const emptyMessage =
    emptyMessageProp ??
    t(
      "privateFund.assetEmptyDetail",
      "暂无内容。上传资料、保存回答笔记或生成研究笔记后会出现在这里。",
    );
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [documentTypeFilter, setDocumentTypeFilter] = useState("all");
  const [noteGroupFilter, setNoteGroupFilter] = useState<"all" | "answer_note" | "research_note">(
    "all",
  );
  const [sort, setSort] = useState<AssetSort>("updated");
  const [view, setView] = useState<AssetView>("list");
  const [managing, setManaging] = useState(false);
  const [managedSelection, setManagedSelection] = useState<Set<string>>(() => new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [expandedMemoSeriesIds, setExpandedMemoSeriesIds] = useState<Set<string>>(() => new Set());
  const compactSideLibrary = compact && (zone === "notes" || zone === "memos");

  useEffect(() => {
    if (managementRequestId === undefined || assets.length === 0) return;
    setManaging(true);
    setManagedSelection(new Set());
  }, [assets.length, managementRequestId]);

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
  const visibleMemoSeries = useMemo(() => groupMemoAssets(visibleAssets), [visibleAssets]);
  const contextSet = useMemo(() => new Set(contextAssetIds), [contextAssetIds]);
  const managedAssetIds = useMemo(
    () =>
      assets.filter((asset) => managedSelection.has(asset.assetId)).map((asset) => asset.assetId),
    [assets, managedSelection],
  );
  const visibleManagedCount = visibleAssetIds.filter((assetId) =>
    managedSelection.has(assetId),
  ).length;
  const allVisibleManaged =
    visibleAssetIds.length > 0 && visibleManagedCount === visibleAssetIds.length;
  const someVisibleManaged = visibleManagedCount > 0 && !allVisibleManaged;
  const managedAssets = assets.filter((asset) => managedSelection.has(asset.assetId));
  const includesDocument = managedAssets.some((asset) => asset.assetType === "document");

  function toggleVisibleManagedAssets() {
    const next = new Set(managedSelection);
    if (allVisibleManaged) {
      for (const assetId of visibleAssetIds) next.delete(assetId);
    } else {
      for (const assetId of visibleAssetIds) next.add(assetId);
    }
    setManagedSelection(next);
  }

  function toggleContextAsset(assetId: string) {
    const next = new Set(contextAssetIds);
    if (next.has(assetId)) next.delete(assetId);
    else next.add(assetId);
    void onSetContext([...next]);
  }

  function toggleManagedAsset(assetId: string) {
    setManagedSelection((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }

  function toggleMemoSeries(seriesId: string) {
    setExpandedMemoSeriesIds((current) => {
      const next = new Set(current);
      if (next.has(seriesId)) next.delete(seriesId);
      else next.add(seriesId);
      return next;
    });
  }

  function leaveManagement() {
    setManaging(false);
    setManagedSelection(new Set());
    setDeleteOpen(false);
    setDeleteError("");
  }

  function toggleManagementMode() {
    if (managing) {
      leaveManagement();
      return;
    }
    setManagedSelection(new Set());
    setManaging(true);
  }

  async function confirmDelete() {
    if (managedAssetIds.length === 0) return;
    setDeletePending(true);
    setDeleteError("");
    try {
      await onDeleteAssets(managedAssetIds);
      leaveManagement();
    } catch (error) {
      setDeleteError(
        error instanceof Error ? error.message : t("privateFund.deleteFailed", "删除失败"),
      );
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
            <DialogTitle>
              {t("privateFund.deleteItems", { count: managedAssetIds.length })}
            </DialogTitle>
            <DialogDescription>
              {t("assets.deleteDescription")}
              {includesDocument ? t("assets.deleteDocumentsDescription") : ""}
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
              {t("common.cancel")}
            </Button>
            <Button
              disabled={deletePending}
              onClick={() => void confirmDelete()}
              type="button"
              variant="destructive"
            >
              {deletePending
                ? t("privateFund.deleting", "正在删除…")
                : t("privateFund.confirmDelete", "确认删除")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div
        className={cn(
          "border-b border-[var(--pf-line)]",
          compactSideLibrary ? "space-y-2 p-2" : "space-y-2.5 p-3",
        )}
      >
        {compactSideLibrary ? (
          <>
            <div className="flex items-center gap-1.5">
              <label className="relative min-w-0 flex-1">
                <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--pf-ink-muted)]" />
                <input
                  aria-label={t("common.search")}
                  className="h-8 w-full rounded-md border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] pl-8 pr-2 text-xs outline-none placeholder:text-[var(--pf-ink-muted)] focus:border-[var(--pf-accent)] focus:ring-2 focus:ring-[var(--pf-accent-soft)]"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={
                    zone === "memos"
                      ? t("privateFund.searchMemo", "搜索 Memo")
                      : t("privateFund.searchNotes", "搜索笔记")
                  }
                  value={query}
                />
              </label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    aria-label={t("privateFund.filterSort")}
                    className="size-8 shrink-0"
                    size="icon"
                    title={t("privateFund.filterSort")}
                    type="button"
                    variant={sort === "updated" ? "ghost" : "secondary"}
                  >
                    <SlidersHorizontal className="size-3.5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-56 space-y-2.5 p-3">
                  <p className="text-xs font-semibold text-[var(--pf-ink)]">
                    {t("privateFund.filterSort", "筛选与排序")}
                  </p>
                  <label className="block space-y-1">
                    <span className="text-[11px] text-[var(--pf-ink-muted)]">
                      {t("assets.sortBy")}
                    </span>
                    <select
                      aria-label={t("assets.sort")}
                      className="h-8 w-full rounded-md border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] px-2 text-xs"
                      onChange={(event) => setSort(event.target.value as AssetSort)}
                      value={sort}
                    >
                      <option value="updated">{t("assets.sortUpdated")}</option>
                      <option value="oldest">{t("assets.sortOldest")}</option>
                      <option value="title">{t("assets.sortTitle")}</option>
                      <option value="type">{t("assets.sortType")}</option>
                      <option value="evidence">{t("assets.sortEvidence")}</option>
                    </select>
                  </label>
                </PopoverContent>
              </Popover>
              <Button
                aria-label={managing ? t("assets.finishManaging") : t("assets.startManaging")}
                className="h-8 shrink-0 gap-1.5 px-2 text-xs"
                disabled={assets.length === 0 || deletePending}
                onClick={toggleManagementMode}
                size="sm"
                type="button"
                variant={managing ? "secondary" : "ghost"}
              >
                {managing ? <Check className="size-3.5" /> : <ListChecks className="size-3.5" />}
                {managing ? t("common.confirm", "完成") : t("privateFund.batchManage")}
              </Button>
            </div>
            {zone === "notes" ? (
              <div
                aria-label={t("assets.noteType")}
                className="grid h-8 grid-cols-3 rounded-md bg-[var(--pf-panel-subtle)] p-0.5"
                role="group"
              >
                {[
                  ["all", t("common.all")],
                  ["answer_note", t("assets.answer")],
                  ["research_note", t("assets.research")],
                ].map(([value, label]) => (
                  <button
                    aria-label={
                      value === "all"
                        ? t("assets.showAllNotes")
                        : value === "answer_note"
                          ? t("assets.showAnswerNotes")
                          : t("assets.showResearchNotes")
                    }
                    aria-pressed={noteGroupFilter === value}
                    className={cn(
                      "rounded-[5px] px-2 text-xs font-medium text-[var(--pf-ink-muted)] transition-colors hover:text-[var(--pf-ink)]",
                      noteGroupFilter === value &&
                        "bg-[var(--pf-panel-raised)] text-[var(--pf-ink)] shadow-sm",
                    )}
                    key={value}
                    onClick={() =>
                      setNoteGroupFilter(value as "all" | "answer_note" | "research_note")
                    }
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">{title}</h2>
                <p className="mt-0.5 text-xs text-[var(--pf-ink-muted)]">
                  {description ??
                    t("assets.summary", {
                      total: assets.length,
                      selected: assets.filter((asset) => contextSet.has(asset.assetId)).length,
                    })}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {!compact ? (
                  <div className="flex rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] p-0.5">
                    <button
                      aria-label={t("assets.listView")}
                      className={cn(
                        "rounded-md p-1.5 text-[var(--pf-ink-muted)]",
                        view === "list" &&
                          "bg-[var(--pf-panel-raised)] text-[var(--pf-ink)] shadow-sm",
                      )}
                      onClick={() => setView("list")}
                      type="button"
                    >
                      <LayoutList size={14} />
                    </button>
                    <button
                      aria-label={t("assets.cardView")}
                      className={cn(
                        "rounded-md p-1.5 text-[var(--pf-ink-muted)]",
                        view === "grid" &&
                          "bg-[var(--pf-panel-raised)] text-[var(--pf-ink)] shadow-sm",
                      )}
                      onClick={() => setView("grid")}
                      type="button"
                    >
                      <Grid2X2 size={14} />
                    </button>
                  </div>
                ) : null}
                <Button
                  aria-label={managing ? t("assets.finishManaging") : t("assets.startManaging")}
                  className="h-8 gap-1.5 px-2 text-xs"
                  disabled={assets.length === 0 || deletePending}
                  onClick={toggleManagementMode}
                  size="sm"
                  type="button"
                  variant={managing ? "secondary" : "ghost"}
                >
                  {managing ? <Check className="size-3.5" /> : <ListChecks className="size-3.5" />}
                  {managing ? t("common.confirm") : t("privateFund.batchManage")}
                </Button>
              </div>
            </div>
            <label className="relative block">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--pf-ink-muted)]" />
              <input
                aria-label={t("common.search")}
                className="h-9 w-full rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] pl-8 pr-3 text-xs outline-none placeholder:text-[var(--pf-ink-muted)] focus:border-[var(--pf-accent)] focus:ring-2 focus:ring-[var(--pf-accent-soft)]"
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("privateFund.searchAssets", "搜索标题、摘要或标签")}
                value={query}
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              {zone === "notes" ? (
                <label className="relative col-span-2">
                  <span className="sr-only">{t("assets.noteType")}</span>
                  <select
                    aria-label={t("assets.noteType")}
                    className="h-8 w-full rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] px-2 text-xs"
                    onChange={(event) =>
                      setNoteGroupFilter(
                        event.target.value as "all" | "answer_note" | "research_note",
                      )
                    }
                    value={noteGroupFilter}
                  >
                    <option value="all">{t("privateFund.allNotes", "全部笔记")}</option>
                    <option value="answer_note">{t("chat.answerNote")}</option>
                    <option value="research_note">{t("privateFund.notes")}</option>
                  </select>
                </label>
              ) : null}
              {zone === "sources" || (zone === "generic" && availableDocumentTypes.length > 0) ? (
                <label className={zone === "sources" ? "relative col-span-2" : "relative"}>
                  <span className="sr-only">{t("assets.sourceType")}</span>
                  <select
                    aria-label={t("assets.sourceType")}
                    className="h-8 w-full rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] px-2 text-xs"
                    onChange={(event) => setDocumentTypeFilter(event.target.value)}
                    value={documentTypeFilter}
                  >
                    <option value="all">{t("assets.allSourceTypes")}</option>
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
                  <span className="sr-only">{t("assets.itemType")}</span>
                  <select
                    aria-label={t("assets.itemType")}
                    className="h-8 w-full rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] px-2 text-xs"
                    onChange={(event) => setTypeFilter(event.target.value)}
                    value={typeFilter}
                  >
                    <option value="all">{t("privateFund.allTypes", "全部类型")}</option>
                    {availableTypes.map((type) => (
                      <option key={type} value={type}>
                        {typeLabels[type] ?? type}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="relative col-span-2">
                <ArrowDownAZ className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-[var(--pf-ink-muted)]" />
                <span className="sr-only">{t("assets.sort")}</span>
                <select
                  aria-label={t("assets.sort")}
                  className="h-8 w-full rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] pl-7 pr-2 text-xs"
                  onChange={(event) => setSort(event.target.value as AssetSort)}
                  value={sort}
                >
                  <option value="updated">{t("assets.sortUpdated")}</option>
                  <option value="oldest">{t("assets.sortOldest")}</option>
                  <option value="title">{t("assets.sortTitle")}</option>
                  <option value="type">{t("assets.sortType")}</option>
                  <option value="evidence">{t("assets.sortEvidence")}</option>
                </select>
              </label>
            </div>
          </>
        )}
        {managing ? (
          <div
            className="flex min-h-9 flex-wrap items-center gap-2 rounded-lg border border-[var(--pf-accent)]/40 bg-[var(--pf-accent-soft)] px-2 py-1"
            data-testid="asset-management-toolbar"
          >
            <label className="flex min-w-0 cursor-pointer items-center gap-2 text-xs font-medium">
              <AssetSelectionCheckbox
                checked={allVisibleManaged}
                label={t("assets.selectAllVisible")}
                mixed={someVisibleManaged}
                disabled={visibleAssetIds.length === 0 || deletePending}
                onChange={toggleVisibleManagedAssets}
              />
              <span className="truncate">
                {t("assets.selectedCount", { count: managedAssetIds.length })}
              </span>
            </label>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <Button
                aria-label={t("assets.deleteSelected", { count: managedAssetIds.length })}
                className="h-7 shrink-0 gap-1 px-2 text-xs"
                disabled={managedAssetIds.length === 0 || deletePending}
                onClick={() => {
                  setDeleteError("");
                  setDeleteOpen(true);
                }}
                size="sm"
                type="button"
                variant="destructive"
              >
                <Trash2 className="size-3" />
                {t("common.delete")}
                {managedAssetIds.length > 0 ? ` ${managedAssetIds.length}` : ""}
              </Button>
              {managedAssetIds.length > 0 ? (
                <Button
                  aria-label={t("assets.clearSelection")}
                  className="size-7"
                  disabled={deletePending}
                  onClick={() => setManagedSelection(new Set())}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <X className="size-3.5" />
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {visibleAssets.length === 0 ? (
          <div className="m-4 rounded-2xl border border-dashed border-[var(--pf-line-strong)] bg-[var(--pf-panel-raised)] p-7 text-center text-xs leading-5 text-[var(--pf-ink-muted)]">
            {emptyMessage}
          </div>
        ) : zone === "memos" && !managing ? (
          <ul className="divide-y divide-[var(--pf-line)] px-3">
            {visibleMemoSeries.map((series) => {
              const expanded = expandedMemoSeriesIds.has(series.seriesId);
              const currentInContext = contextSet.has(series.current.assetId);
              return (
                <li className="py-3" key={series.seriesId}>
                  <div className="flex min-w-0 items-start gap-2.5">
                    <AssetRowCheckbox
                      asset={series.current}
                      checked={currentInContext}
                      disabled={contextPending}
                      label={t("assets.addCurrentVersion", { title: series.title })}
                      onChange={() => toggleContextAsset(series.current.assetId)}
                    />
                    <span className="mt-0.5 rounded-md bg-[var(--pf-accent-soft)] p-1.5 text-[var(--pf-accent-ink)]">
                      <GalleryVerticalEnd className="size-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <button
                        aria-label={t("assets.openAsset", { title: series.title })}
                        className="block w-full rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)]"
                        onClick={() => onOpenAsset(series.current)}
                        type="button"
                      >
                        <span className="block truncate text-sm font-semibold">{series.title}</span>
                        <span className="mt-0.5 block text-[11px] text-[var(--pf-ink-muted)]">
                          {t("assets.currentVersionSummary", {
                            version: series.current.versionNo,
                            count: series.versions.length,
                          })}{" "}
                          ·{" "}
                          {formatUpdatedDate(series.current.updatedAt ?? series.current.createdAt)}
                        </span>
                      </button>
                      {currentInContext ? (
                        <p className="mt-1 text-[11px] text-[var(--pf-accent-ink)]">
                          {t("assets.currentVersionInContext")}
                        </p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap items-center gap-1">
                        <Button
                          aria-label={t("assets.openCurrentVersion", { title: series.title })}
                          className="h-7 gap-1 px-2 text-xs"
                          onClick={() => onOpenAsset(series.current)}
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          {t("privateFund.openArtifact")}
                        </Button>
                        <Button
                          aria-expanded={expanded}
                          aria-label={t(
                            expanded ? "assets.collapseVersions" : "assets.viewVersions",
                            { title: series.title },
                          )}
                          className="h-7 gap-1 px-2 text-xs"
                          onClick={() => toggleMemoSeries(series.seriesId)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          <History className="size-3" />
                          {t("assets.versionHistory")}
                          {expanded ? (
                            <ChevronDown className="size-3" />
                          ) : (
                            <ChevronRight className="size-3" />
                          )}
                        </Button>
                        {series.versions.length > 1 && onOpenMemoHistory ? (
                          <Button
                            aria-label={t("assets.compareVersions", { title: series.title })}
                            className="h-7 gap-1 px-2 text-xs"
                            onClick={() => onOpenMemoHistory(series.seriesId)}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            <GitCompareArrows className="size-3" />
                            {t("assets.compare")}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  {expanded ? (
                    <ul className="ml-8 mt-2 divide-y divide-[var(--pf-line)] border-l border-[var(--pf-line-strong)] pl-3">
                      {series.versions.map((version, index) => (
                        <li className="flex items-center gap-2 py-2" key={version.assetId}>
                          <AssetRowCheckbox
                            asset={version}
                            checked={contextSet.has(version.assetId)}
                            disabled={contextPending}
                            label={t("assets.addVersion", {
                              title: series.title,
                              version: version.versionNo,
                            })}
                            onChange={() => toggleContextAsset(version.assetId)}
                          />
                          <button
                            aria-label={t("assets.openVersion", {
                              title: series.title,
                              version: version.versionNo,
                            })}
                            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-[var(--pf-panel-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)]"
                            onClick={() => onOpenAsset(version)}
                            type="button"
                          >
                            <span className="shrink-0 text-xs font-semibold">
                              v{version.versionNo}
                            </span>
                            <span className="truncate text-[11px] text-[var(--pf-ink-muted)]">
                              {formatDate(version.updatedAt ?? version.createdAt)}
                              {index === 0 ? ` · ${t("assets.current")}` : ""}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : compact ? (
          <ul className="divide-y divide-[var(--pf-line)] px-3">
            {visibleAssets.map((asset) => (
              <li
                className={cn(
                  "flex items-start gap-2.5 py-3",
                  managing && managedSelection.has(asset.assetId) && "bg-[var(--pf-accent-soft)]",
                )}
                key={asset.assetId}
              >
                <AssetRowCheckbox
                  asset={asset}
                  checked={
                    managing ? managedSelection.has(asset.assetId) : contextSet.has(asset.assetId)
                  }
                  disabled={managing ? deletePending : contextPending}
                  label={
                    managing
                      ? t("assets.selectManage", { title: asset.title })
                      : t("assets.addContext", { title: asset.title })
                  }
                  onChange={() =>
                    managing ? toggleManagedAsset(asset.assetId) : toggleContextAsset(asset.assetId)
                  }
                />
                <button
                  aria-label={t("assets.openAsset", { title: asset.title })}
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
                        {asset.summary || asset.contentMarkdown || t("assets.noSummary")}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-[var(--pf-ink-muted)]">
                        <span>{assetTypeLabel(asset)}</span>
                        <span>·</span>
                        <span>{formatDate(asset.updatedAt ?? asset.createdAt)}</span>
                        {contextSet.has(asset.assetId) ? (
                          <>
                            <span>·</span>
                            <span className="text-[var(--pf-accent-ink)]">
                              {t("assets.inContext")}
                            </span>
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
                <th
                  className="w-16 px-3 py-2"
                  title={managing ? t("assets.selectManagedItems") : t("assets.addQuestionContext")}
                >
                  {managing ? t("assets.select") : t("assets.add")}
                </th>
                <th className="px-2 py-2">{t("privateFund.assets")}</th>
                <th className="w-20 px-2 py-2">{t("assets.type")}</th>
                <th className="w-14 px-2 py-2">{t("assets.updated")}</th>
              </tr>
            </thead>
            <tbody>
              {visibleAssets.map((asset) => (
                <tr
                  className={cn(
                    "cursor-pointer border-t border-[var(--pf-line)] transition-colors hover:bg-[var(--pf-panel-subtle)]",
                    managing && managedSelection.has(asset.assetId) && "bg-[var(--pf-accent-soft)]",
                  )}
                  key={asset.assetId}
                  onClick={() => onOpenAsset(asset)}
                >
                  <td className="px-3 py-3 align-top">
                    <AssetRowCheckbox
                      asset={asset}
                      checked={
                        managing
                          ? managedSelection.has(asset.assetId)
                          : contextSet.has(asset.assetId)
                      }
                      disabled={managing ? deletePending : contextPending}
                      label={
                        managing
                          ? t("assets.selectManage", { title: asset.title })
                          : t("assets.addContext", { title: asset.title })
                      }
                      onChange={() =>
                        managing
                          ? toggleManagedAsset(asset.assetId)
                          : toggleContextAsset(asset.assetId)
                      }
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
                          {t("assets.versionEvidence", {
                            version: asset.versionNo,
                            count: asset.evidenceCount,
                          })}
                          {contextSet.has(asset.assetId) ? ` / ${t("assets.inContext")}` : ""}
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
                  (managing ? managedSelection.has(asset.assetId) : contextSet.has(asset.assetId))
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
                      checked={
                        managing
                          ? managedSelection.has(asset.assetId)
                          : contextSet.has(asset.assetId)
                      }
                      disabled={managing ? deletePending : contextPending}
                      label={
                        managing
                          ? t("assets.selectManage", { title: asset.title })
                          : t("assets.addContext", { title: asset.title })
                      }
                      onChange={() =>
                        managing
                          ? toggleManagedAsset(asset.assetId)
                          : toggleContextAsset(asset.assetId)
                      }
                    />
                    {managing
                      ? managedSelection.has(asset.assetId)
                        ? t("assets.selected")
                        : t("assets.select")
                      : contextSet.has(asset.assetId)
                        ? t("assets.inContext")
                        : t("privateFund.addContext")}
                  </label>
                </div>
                <button
                  aria-label={t("assets.openAsset", { title: asset.title })}
                  className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)]"
                  onClick={() => onOpenAsset(asset)}
                  type="button"
                >
                  <p className="mt-3 line-clamp-2 text-sm font-semibold leading-5">{asset.title}</p>
                  <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-[var(--pf-ink-secondary)]">
                    {asset.summary || asset.contentMarkdown}
                  </p>
                  <p className="mt-2 text-[11px] text-[var(--pf-ink-muted)]">
                    {assetTypeLabel(asset)} /{" "}
                    {t("assets.evidenceCount", { count: asset.evidenceCount })}
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
