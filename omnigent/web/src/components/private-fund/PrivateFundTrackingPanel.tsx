import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  BellRing,
  Check,
  ChevronRight,
  Clock3,
  FileSearch,
  FileText,
  GitCompare,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { usePrivateFundTracking } from "@/hooks/usePrivateFundProjects";
import { InlineSourcePopover } from "@/components/private-fund/InlineSourcePopover";
import {
  archivePrivateFundResearchItems,
  createPrivateFundWatchRule,
  getPrivateFundResearchItemTimeline,
  getPrivateFundResearchItemGovernance,
  purgePrivateFundResearchItems,
  rebuildPrivateFundTracking,
  restorePrivateFundResearchItems,
  runPrivateFundTracking,
  updatePrivateFundAlert,
  updatePrivateFundWatchRule,
  type PrivateFundResearchAlert,
  type PrivateFundResearchItem,
  type PrivateFundTrackingEvidenceSource,
  type PrivateFundWatchRule,
} from "@/lib/privateFundApi";
import type { PdfSourceSelection } from "@/shell/FileViewerContext";
import { cn } from "@/lib/utils";

const ITEM_LABELS: Record<string, string> = {
  all: "风险与催化剂",
  risk: "风险",
  catalyst: "催化剂",
};
const STATE_LABELS: Record<string, string> = {
  emerging: "新出现",
  announced: "已公布",
  identified: "已识别",
  watching: "持续观察",
  triggered: "已触发",
  materialized: "已兑现",
  resolved: "已化解",
  achieved: "已达成",
  missed: "未达预期",
  active: "持续跟踪",
  valid: "持续跟踪",
  effective: "持续跟踪",
  confirmed: "已确认",
  pending: "待验证",
  expected: "预期中",
  planned: "计划中",
  in_progress: "推进中",
  completed: "已完成",
  cancelled: "已取消",
};
const EVENT_TYPE_LABELS: Record<string, string> = {
  order_award: "订单落地",
  order_win: "获得订单",
  order_pipeline: "订单储备",
  order_growth: "订单增长",
  order_delay: "订单延期",
  product_launch: "产品发布",
  production_start: "开始量产",
  capacity_expansion: "产能扩张",
  capacity_ramp: "产能爬坡",
  local_factory: "本地建厂",
  demand_growth: "需求增长",
  demand_decline: "需求下降",
  market_demand_shift: "市场需求变化",
  cost_increase: "成本上升",
  cost_pressure: "成本压力",
  product_cost_pressure: "产品成本压力",
  margin_pressure: "利润率承压",
  project_delay: "项目延期",
  regulatory_change: "监管变化",
  geopolitical_restriction: "地缘政治限制",
  financing_restriction: "融资限制",
  market_access_restriction: "市场准入限制",
  certification: "认证进展",
  grid_connection: "项目并网",
  policy_support: "政策支持",
  share_buyback: "股份回购",
};
const IMPACT_LABELS: Record<string, string> = {
  critical: "重大",
  high: "高",
  medium: "中",
  low: "低",
};
const FREQUENCY_LABELS: Record<string, string> = {
  on_ingest: "资料更新时",
  daily: "每日最多一次",
  weekly: "每周最多一次",
};
const CHANGE_TYPE_LABELS: Record<string, string> = {
  new: "新增事项",
  status_changed: "状态变化",
  value_changed: "数值变化",
  timing_changed: "时间变化",
  probability_changed: "概率变化",
  stance_changed: "判断变化",
  content_changed: "内容变化",
};

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function diffValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "未设置";
  if (Array.isArray(value)) return value.length ? value.join("、") : "未设置";
  if (typeof value === "number" && value >= 0 && value <= 1) {
    return `${Math.round(value * 100)}%`;
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatTime(value?: string | null): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function qualityOf(item: PrivateFundResearchItem): string {
  return String(item.currentVersion?.metadata?.quality_status ?? "needs_review");
}

function metadataText(item: PrivateFundResearchItem, key: string): string {
  return String(item.currentVersion?.metadata?.[key] ?? "").trim();
}

function evidenceSourceSelection(
  datasetId: string,
  source: PrivateFundTrackingEvidenceSource,
): PdfSourceSelection | null {
  if (source.pageStart) {
    return {
      kind: "pdf",
      datasetId,
      pdfName: source.documentName,
      pageNo: source.pageStart,
      pageEnd: source.pageEnd ?? source.pageStart,
      quote: source.excerpt,
      evidenceId: source.evidenceId,
      label: source.citation,
    };
  }
  if (source.sheetName) {
    return {
      kind: "excel",
      datasetId,
      workbookName: source.documentName,
      sheetName: source.sheetName,
      rangeRef: source.cellRange ?? undefined,
      evidenceId: source.evidenceId,
      label: source.citation,
    };
  }
  return null;
}

function stateLabel(value?: string | null): string {
  const normalized = String(value ?? "")
    .trim()
    .toLocaleLowerCase();
  return STATE_LABELS[normalized] ?? "待确认";
}

function eventTypeLabel(value: string): string {
  const normalized = value.trim().toLocaleLowerCase().replaceAll("-", "_");
  if (!normalized) return "";
  if (EVENT_TYPE_LABELS[normalized]) return EVENT_TYPE_LABELS[normalized];
  return /[\u3400-\u9fff]/u.test(value) ? value : "其他事件";
}

function QualityBadge({ quality }: { quality: string }) {
  const verified = quality === "verified";
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold",
        verified
          ? "bg-[var(--pf-success-soft)] text-[var(--pf-success-ink)]"
          : "bg-[var(--pf-review-soft)] text-[var(--pf-review-ink)]",
      )}
    >
      {verified ? "已验证" : "待复核"}
    </span>
  );
}

function AlertRow({
  alert,
  pending,
  onUpdate,
}: {
  alert: PrivateFundResearchAlert;
  pending: boolean;
  onUpdate: (status: "acknowledged" | "dismissed") => void;
}) {
  return (
    <article className="border-b border-[var(--pf-line)] px-4 py-3 last:border-b-0">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-1 size-2 shrink-0 rounded-full",
            alert.priority === "critical" || alert.priority === "high"
              ? "bg-[var(--pf-danger-ink)]"
              : "bg-[var(--pf-warning-ink)]",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-semibold text-[var(--pf-ink)]">{alert.title}</h3>
            <span className="text-[10px] text-[var(--pf-ink-muted)]">
              {IMPACT_LABELS[alert.priority] ?? alert.priority}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-5 text-[var(--pf-ink-secondary)]">
            {alert.summary}
          </p>
          <p className="mt-1.5 text-[10px] text-[var(--pf-ink-muted)]">
            {formatTime(alert.createdAt)} · {alert.evidenceIds.length} 条证据
          </p>
        </div>
        {alert.status === "new" ? (
          <div className="flex shrink-0 gap-1">
            <button
              aria-label={`确认提醒 ${alert.title}`}
              className="pf-icon-button"
              disabled={pending}
              onClick={() => onUpdate("acknowledged")}
              title="确认已阅"
              type="button"
            >
              {pending ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
            </button>
            <button
              aria-label={`忽略提醒 ${alert.title}`}
              className="pf-icon-button"
              disabled={pending}
              onClick={() => onUpdate("dismissed")}
              title="忽略"
              type="button"
            >
              <X className="size-3" />
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function ItemDetailDrawer({
  datasetId,
  item,
  onClose,
}: {
  datasetId: string;
  item: PrivateFundResearchItem;
  onClose: () => void;
}) {
  const [expandedEvidence, setExpandedEvidence] = useState<Set<string>>(new Set());
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(new Set());
  const timelineQuery = useQuery({
    queryKey: ["private-fund-research-item-timeline", datasetId, item.itemId],
    queryFn: () => getPrivateFundResearchItemTimeline(datasetId, item.itemId),
  });
  const current = item.currentVersion;
  const detailedCurrent = timelineQuery.data?.versions.find(
    (version) => version.itemVersionId === item.currentVersionId,
  );
  const evidenceSources = detailedCurrent?.evidenceSources ?? [];
  const fields = [
    ["事件类型", eventTypeLabel(metadataText(item, "event_type"))],
    ["影响对象", metadataText(item, "subject")],
    ["触发因素", metadataText(item, "trigger")],
    ["传导路径", metadataText(item, "transmission_path")],
  ].filter((entry) => entry[1]);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/20"
      role="dialog"
      aria-modal="true"
    >
      <button aria-label="关闭详情" className="absolute inset-0 cursor-default" onClick={onClose} />
      <aside className="relative h-full w-full max-w-xl overflow-y-auto border-l border-[var(--pf-line)] bg-[var(--pf-panel-raised)] shadow-2xl">
        <header className="sticky top-0 z-10 flex items-start justify-between border-b border-[var(--pf-line)] bg-[var(--pf-panel-raised)]/95 px-5 py-4 backdrop-blur">
          <div className="min-w-0 pr-4">
            <div className="mb-2 flex items-center gap-2">
              <span className={item.itemType === "risk" ? "pf-risk-badge" : "pf-catalyst-badge"}>
                {ITEM_LABELS[item.itemType]}
              </span>
              <QualityBadge quality={qualityOf(item)} />
              <span className="text-[10px] text-[var(--pf-ink-muted)]">
                v{item.currentVersionNo}
              </span>
            </div>
            <h2 className="text-base font-semibold leading-6 text-[var(--pf-ink)]">{item.title}</h2>
          </div>
          <button className="pf-icon-button" onClick={onClose} type="button">
            <X className="size-4" />
          </button>
        </header>

        <div className="space-y-6 p-5">
          <section>
            <h3 className="pf-section-label">当前判断</h3>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[var(--pf-ink-secondary)]">
              {current?.content || "暂无内容"}
            </p>
          </section>

          {fields.length ? (
            <section className="grid gap-px overflow-hidden rounded-xl border border-[var(--pf-line)] bg-[var(--pf-line)] sm:grid-cols-2">
              {fields.map(([label, value]) => (
                <div className="bg-[var(--pf-panel)] p-3" key={label}>
                  <p className="text-[10px] text-[var(--pf-ink-muted)]">{label}</p>
                  <p className="mt-1 text-xs leading-5 text-[var(--pf-ink)]">{value}</p>
                </div>
              ))}
            </section>
          ) : null}

          <section>
            <div className="flex items-center justify-between">
              <h3 className="pf-section-label">证据</h3>
              <span className="text-[10px] text-[var(--pf-ink-muted)]">
                {current?.evidenceIds.length ?? 0} 条
              </span>
            </div>
            {timelineQuery.isLoading ? (
              <p className="mt-3 flex items-center gap-2 text-xs text-[var(--pf-ink-muted)]">
                <Loader2 className="size-3 animate-spin" /> 正在解析证据来源
              </p>
            ) : timelineQuery.isError ? (
              <div className="mt-2 rounded-lg border border-[var(--pf-danger-ink)]/20 bg-[var(--pf-danger-soft)] p-3 text-xs text-[var(--pf-danger-ink)]">
                <p>证据内容加载失败，请检查文件是否仍存在或当前账号是否有权限。</p>
                <button
                  className="mt-2 underline"
                  onClick={() => timelineQuery.refetch()}
                  type="button"
                >
                  重新加载
                </button>
              </div>
            ) : evidenceSources.length ? (
              <div className="mt-2 space-y-2">
                {evidenceSources.map((source) => {
                  const isExpanded = expandedEvidence.has(source.evidenceId);
                  const evidenceContent = source.fullContent || source.excerpt;
                  const sourceSelection = evidenceSourceSelection(datasetId, source);
                  const canExpand =
                    evidenceContent !== source.excerpt || evidenceContent.length > 180;
                  return (
                    <article
                      className="rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel)] p-3"
                      key={source.evidenceId}
                    >
                      <div className="flex items-start gap-2">
                        <FileText className="mt-0.5 size-3.5 shrink-0 text-[var(--pf-accent-ink)]" />
                        <div className="min-w-0 flex-1">
                          {sourceSelection ? (
                            <InlineSourcePopover
                              className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--pf-accent-ink)] hover:underline"
                              href={source.sourceUrl ?? undefined}
                              presentation="dialog"
                              source={sourceSelection}
                            >
                              {source.citation}
                              <FileSearch className="size-3" />
                            </InlineSourcePopover>
                          ) : (
                            <p className="text-xs font-semibold text-[var(--pf-ink)]">
                              {source.citation}
                            </p>
                          )}
                          <p
                            className={cn(
                              "mt-1.5 whitespace-pre-wrap text-[11px] leading-5 text-[var(--pf-ink-secondary)]",
                              !isExpanded && "line-clamp-4",
                            )}
                          >
                            {(isExpanded ? evidenceContent : source.excerpt) ||
                              "该证据暂无可展示的文本摘录。"}
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-3">
                            {canExpand ? (
                              <button
                                className="text-[10px] font-semibold text-[var(--pf-accent-ink)] hover:underline"
                                onClick={() =>
                                  setExpandedEvidence((current) => {
                                    const next = new Set(current);
                                    if (next.has(source.evidenceId)) next.delete(source.evidenceId);
                                    else next.add(source.evidenceId);
                                    return next;
                                  })
                                }
                                type="button"
                              >
                                {isExpanded ? "收起证据" : "展开完整证据"}
                              </button>
                            ) : null}
                          </div>
                          <p className="mt-1.5 truncate font-mono text-[9px] text-[var(--pf-ink-muted)]">
                            {source.evidenceId}
                          </p>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="mt-2 rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] p-3 text-xs text-[var(--pf-ink-muted)]">
                无法解析证据内容。对应资料可能已被删除、尚未完成索引，或属于旧版记录。
              </div>
            )}
          </section>

          <section>
            <div className="flex items-center justify-between">
              <h3 className="pf-section-label">版本时间线</h3>
              <span className="text-[10px] text-[var(--pf-ink-muted)]">逐字段对比</span>
            </div>
            {timelineQuery.isLoading ? (
              <p className="mt-3 flex items-center gap-2 text-xs text-[var(--pf-ink-muted)]">
                <Loader2 className="size-3 animate-spin" /> 正在读取历史版本
              </p>
            ) : (
              <ol className="mt-3 space-y-3 border-l border-[var(--pf-line-strong)] pl-4">
                {(timelineQuery.data?.versions ?? []).toReversed().map((version) => {
                  const expanded = expandedVersions.has(version.itemVersionId);
                  return (
                    <li key={version.itemVersionId}>
                      <button
                        className="flex w-full items-start justify-between gap-3 text-left"
                        onClick={() =>
                          setExpandedVersions((current) => {
                            const next = new Set(current);
                            if (next.has(version.itemVersionId)) next.delete(version.itemVersionId);
                            else next.add(version.itemVersionId);
                            return next;
                          })
                        }
                        type="button"
                      >
                        <span>
                          <span className="block text-xs font-medium text-[var(--pf-ink)]">
                            v{version.versionNo} · {stateLabel(version.state)}
                          </span>
                          <span className="mt-0.5 block text-[10px] text-[var(--pf-ink-muted)]">
                            {formatTime(version.observedAt)} · {version.evidenceIds.length} 条证据
                          </span>
                        </span>
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--pf-panel-subtle)] px-2 py-1 text-[10px] text-[var(--pf-accent-ink)]">
                          <GitCompare className="size-3" />
                          {version.versionNo === 1
                            ? "首次建立"
                            : `${version.fieldChanges.length} 项变化`}
                        </span>
                      </button>
                      {expanded ? (
                        <div className="mt-2 space-y-2 rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel)] p-2.5">
                          {version.fieldChanges.length ? (
                            version.fieldChanges.map((change) => (
                              <div
                                className="rounded-md bg-[var(--pf-panel-subtle)] p-2"
                                key={change.field}
                              >
                                <p className="text-[10px] font-semibold text-[var(--pf-ink)]">
                                  {change.label}
                                </p>
                                <div className="mt-1 grid grid-cols-[1fr_auto_1fr] items-start gap-2 text-[10px] leading-4">
                                  <span className="break-words text-[var(--pf-ink-muted)]">
                                    {diffValue(change.before)}
                                  </span>
                                  <span className="text-[var(--pf-ink-muted)]">→</span>
                                  <span className="break-words font-medium text-[var(--pf-ink-secondary)]">
                                    {diffValue(change.after)}
                                  </span>
                                </div>
                              </div>
                            ))
                          ) : (
                            <p className="text-[10px] text-[var(--pf-ink-muted)]">
                              本版本未检测到结构化字段变化。
                            </p>
                          )}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}

type RuleDraft = {
  name: string;
  targetType: string;
  keywords: string;
  eventTypes: string[];
  changeTypes: string[];
  minPriority: string;
  frequency: string;
  active: boolean;
};

function RuleEditor({
  rule,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  rule?: PrivateFundWatchRule | null;
  pending: boolean;
  error?: string;
  onCancel: () => void;
  onSubmit: (draft: RuleDraft) => void;
}) {
  const [draft, setDraft] = useState<RuleDraft>(() => ({
    name: rule?.name ?? "",
    targetType: rule?.targetType ?? "all",
    keywords: stringList(rule?.query.keywords).join("、"),
    eventTypes: stringList(rule?.query.event_types),
    changeTypes: stringList(rule?.query.change_types),
    minPriority: rule?.minPriority ?? "medium",
    frequency: rule?.frequency ?? "on_ingest",
    active: rule?.active ?? true,
  }));
  const toggle = (field: "eventTypes" | "changeTypes", value: string) =>
    setDraft((current) => ({
      ...current,
      [field]: current[field].includes(value)
        ? current[field].filter((item) => item !== value)
        : [...current[field], value],
    }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft.name.trim()) onSubmit(draft);
  };
  return (
    <form className="space-y-4 p-4" onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-[10px] font-semibold text-[var(--pf-ink-muted)]">
          <span>规则名称</span>
          <input
            className="pf-filter-input w-full"
            maxLength={80}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder="例如：海外订单风险"
            required
            value={draft.name}
          />
        </label>
        <label className="space-y-1 text-[10px] font-semibold text-[var(--pf-ink-muted)]">
          <span>事项类型</span>
          <select
            className="pf-filter-input w-full"
            onChange={(event) => setDraft({ ...draft, targetType: event.target.value })}
            value={draft.targetType}
          >
            <option value="all">风险与催化剂</option>
            <option value="risk">仅风险</option>
            <option value="catalyst">仅催化剂</option>
          </select>
        </label>
        <label className="space-y-1 text-[10px] font-semibold text-[var(--pf-ink-muted)]">
          <span>最低重要度</span>
          <select
            className="pf-filter-input w-full"
            onChange={(event) => setDraft({ ...draft, minPriority: event.target.value })}
            value={draft.minPriority}
          >
            {Object.entries(IMPACT_LABELS)
              .toReversed()
              .map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
          </select>
        </label>
        <label className="space-y-1 text-[10px] font-semibold text-[var(--pf-ink-muted)]">
          <span>检查频率</span>
          <select
            className="pf-filter-input w-full"
            onChange={(event) => setDraft({ ...draft, frequency: event.target.value })}
            value={draft.frequency}
          >
            {Object.entries(FREQUENCY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block space-y-1 text-[10px] font-semibold text-[var(--pf-ink-muted)]">
        <span>关键词（使用逗号、顿号或换行分隔；任一命中即可）</span>
        <textarea
          className="pf-filter-input min-h-20 w-full resize-y py-2"
          onChange={(event) => setDraft({ ...draft, keywords: event.target.value })}
          placeholder="关税、海外订单、认证"
          value={draft.keywords}
        />
      </label>
      <fieldset>
        <legend className="text-[10px] font-semibold text-[var(--pf-ink-muted)]">
          事件类型（不选表示全部）
        </legend>
        <div className="mt-2 grid max-h-40 gap-1.5 overflow-y-auto rounded-lg border border-[var(--pf-line)] p-2 sm:grid-cols-3">
          {Object.entries(EVENT_TYPE_LABELS).map(([value, label]) => (
            <label
              className="flex items-center gap-1.5 text-[10px] text-[var(--pf-ink-secondary)]"
              key={value}
            >
              <input
                checked={draft.eventTypes.includes(value)}
                onChange={() => toggle("eventTypes", value)}
                type="checkbox"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="text-[10px] font-semibold text-[var(--pf-ink-muted)]">
          变化类型（不选表示全部）
        </legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {Object.entries(CHANGE_TYPE_LABELS).map(([value, label]) => (
            <label
              className="flex items-center gap-1.5 rounded-full bg-[var(--pf-panel-subtle)] px-2 py-1 text-[10px] text-[var(--pf-ink-secondary)]"
              key={value}
            >
              <input
                checked={draft.changeTypes.includes(value)}
                onChange={() => toggle("changeTypes", value)}
                type="checkbox"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-xs text-[var(--pf-ink-secondary)]">
        <input
          checked={draft.active}
          onChange={(event) => setDraft({ ...draft, active: event.target.checked })}
          type="checkbox"
        />
        保存后立即启用
      </label>
      {error ? <p className="text-xs text-[var(--pf-danger-ink)]">{error}</p> : null}
      <div className="flex justify-end gap-2 border-t border-[var(--pf-line)] pt-3">
        <button className="pf-secondary-button" onClick={onCancel} type="button">
          取消
        </button>
        <button
          className="pf-primary-button"
          disabled={pending || !draft.name.trim()}
          type="submit"
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
          保存规则
        </button>
      </div>
    </form>
  );
}

export function PrivateFundTrackingPanel({ datasetId }: { datasetId: string }) {
  const queryClient = useQueryClient();
  const trackingQuery = usePrivateFundTracking(datasetId);
  const [view, setView] = useState<"ledger" | "alerts" | "rules" | "governance">("ledger");
  const [typeFilter, setTypeFilter] = useState("all");
  const [qualityFilter, setQualityFilter] = useState("all");
  const [alertStatusFilter, setAlertStatusFilter] = useState<"all" | "new">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [selectedItem, setSelectedItem] = useState<PrivateFundResearchItem | null>(null);
  const [editingRule, setEditingRule] = useState<PrivateFundWatchRule | null | undefined>(
    undefined,
  );
  const [governanceStatus, setGovernanceStatus] = useState<"active" | "archived">("active");
  const [selectedGovernanceIds, setSelectedGovernanceIds] = useState<Set<string>>(new Set());

  const governanceQuery = useQuery({
    queryKey: ["private-fund-research-item-governance", datasetId, governanceStatus],
    queryFn: () => getPrivateFundResearchItemGovernance(datasetId, governanceStatus),
    enabled: view === "governance",
  });

  const refreshMutation = useMutation({
    mutationFn: () => runPrivateFundTracking(datasetId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["private-fund-tracking", datasetId] }),
  });
  const rebuildMutation = useMutation({
    mutationFn: () => rebuildPrivateFundTracking(datasetId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["private-fund-tracking", datasetId] }),
  });
  const alertMutation = useMutation({
    mutationFn: ({ alertId, status }: { alertId: string; status: "acknowledged" | "dismissed" }) =>
      updatePrivateFundAlert(datasetId, alertId, { status }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["private-fund-tracking", datasetId] }),
  });
  const ruleMutation = useMutation({
    mutationFn: ({ ruleId, active }: { ruleId: string; active: boolean }) =>
      updatePrivateFundWatchRule(datasetId, ruleId, { active }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["private-fund-tracking", datasetId] }),
  });
  const ruleSaveMutation = useMutation({
    mutationFn: ({ rule, draft }: { rule?: PrivateFundWatchRule | null; draft: RuleDraft }) => {
      const keywords = draft.keywords
        .split(/[，,、\n]/u)
        .map((value) => value.trim())
        .filter(Boolean);
      const input = {
        name: draft.name.trim(),
        targetType: draft.targetType,
        query: {
          keywords,
          event_types: draft.eventTypes,
          change_types: draft.changeTypes,
        },
        minPriority: draft.minPriority,
        frequency: draft.frequency,
        active: draft.active,
      };
      return rule
        ? updatePrivateFundWatchRule(datasetId, rule.ruleId, input)
        : createPrivateFundWatchRule(datasetId, input);
    },
    onSuccess: () => {
      setEditingRule(undefined);
      queryClient.invalidateQueries({ queryKey: ["private-fund-tracking", datasetId] });
    },
  });
  const governanceMutation = useMutation({
    mutationFn: ({
      action,
      itemIds,
    }: {
      action: "archive" | "restore" | "purge";
      itemIds: string[];
    }) => {
      if (action === "archive") return archivePrivateFundResearchItems(datasetId, itemIds);
      if (action === "restore") return restorePrivateFundResearchItems(datasetId, itemIds);
      return purgePrivateFundResearchItems(datasetId, itemIds);
    },
    onSuccess: () => {
      setSelectedGovernanceIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["private-fund-tracking", datasetId] });
      queryClient.invalidateQueries({
        queryKey: ["private-fund-research-item-governance", datasetId],
      });
    },
  });

  const data = trackingQuery.data;
  const trackedItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (data?.items ?? []).filter((item) => {
      if (!ITEM_LABELS[item.itemType]) return false;
      if (typeFilter !== "all" && item.itemType !== typeFilter) return false;
      if (qualityFilter !== "all" && qualityOf(item) !== qualityFilter) return false;
      return (
        !query ||
        `${item.title} ${item.currentVersion?.content ?? ""}`.toLocaleLowerCase().includes(query)
      );
    });
  }, [data?.items, qualityFilter, search, typeFilter]);
  const totalPages = Math.max(1, Math.ceil(trackedItems.length / pageSize));
  const paginatedItems = useMemo(
    () => trackedItems.slice((page - 1) * pageSize, page * pageSize),
    [page, pageSize, trackedItems],
  );
  const visiblePages = useMemo(() => {
    const start = Math.max(1, Math.min(page - 2, totalPages - 4));
    const end = Math.min(totalPages, start + 4);
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }, [page, totalPages]);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  if (trackingQuery.isLoading) {
    return (
      <div className="flex min-h-[420px] items-center justify-center gap-2 text-sm text-[var(--pf-ink-secondary)]">
        <Loader2 className="size-4 animate-spin" />
        正在读取追踪台账
      </div>
    );
  }
  if (trackingQuery.isError || !data) {
    return (
      <div className="m-6 rounded-xl border border-[var(--pf-danger-ink)]/25 bg-[var(--pf-danger-soft)] p-4 text-sm text-[var(--pf-danger-ink)]">
        无法读取追踪台账：{trackingQuery.error?.message ?? "未知错误"}
      </div>
    );
  }

  const activeJob = data.jobs.find((job) => ["queued", "running"].includes(job.status));
  const alerts = data.alerts.filter(
    (alert) =>
      alert.status !== "dismissed" &&
      (alertStatusFilter === "all" || alert.status === alertStatusFilter),
  );
  const stats = [
    { key: "risk", label: "风险事项", value: data.counts.risk ?? 0, icon: ShieldAlert },
    { key: "catalyst", label: "催化剂", value: data.counts.catalyst ?? 0, icon: Sparkles },
    {
      key: "needs_review",
      label: "待复核",
      value: data.qualityCounts.needs_review ?? 0,
      icon: Clock3,
    },
    { key: "unread", label: "未读提醒", value: data.unreadAlertCount, icon: BellRing },
  ] as const;

  const applySummaryFilter = (key: (typeof stats)[number]["key"]) => {
    setPage(1);
    setSearch("");
    if (key === "unread") {
      setView("alerts");
      setAlertStatusFilter("new");
      return;
    }
    setView("ledger");
    setAlertStatusFilter("all");
    if (key === "needs_review") {
      setTypeFilter("all");
      setQualityFilter("needs_review");
      return;
    }
    setTypeFilter(key);
    setQualityFilter("all");
  };

  const summaryIsActive = (key: (typeof stats)[number]["key"]) => {
    if (key === "unread") return view === "alerts" && alertStatusFilter === "new";
    if (view !== "ledger") return false;
    if (key === "needs_review") return typeFilter === "all" && qualityFilter === "needs_review";
    return typeFilter === key && qualityFilter === "all";
  };

  return (
    <section
      aria-label="风险与催化剂追踪"
      className="min-h-0 flex-1 overflow-y-auto bg-[var(--pf-canvas)]"
    >
      <div className="mx-auto max-w-[1480px] p-4 lg:p-6">
        <header className="flex flex-col gap-4 border-b border-[var(--pf-line)] pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="pf-section-label">持续监测</p>
            <h1 className="mt-1 text-xl font-semibold text-[var(--pf-ink)]">风险与催化剂追踪</h1>
            <p className="mt-1 text-xs text-[var(--pf-ink-secondary)]">
              只让经过证据与质量门校验的重大变化进入提醒。
            </p>
          </div>
          <button
            className="pf-primary-button"
            disabled={refreshMutation.isPending || Boolean(activeJob)}
            onClick={() => refreshMutation.mutate()}
            type="button"
          >
            {refreshMutation.isPending || activeJob ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {activeJob ? "更新中" : "立即更新"}
          </button>
        </header>

        {data.rebuildRequired ? (
          <div className="mt-5 flex flex-col gap-3 rounded-lg border border-amber-500/35 bg-amber-50 px-4 py-3 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold">旧版数据待复核</p>
              <p className="mt-1 text-[11px] opacity-80">
                发现 {data.legacyItemCount} 条旧版风险或催化剂记录。它们仍可查看，但不会触发提醒。
              </p>
            </div>
            <button
              className="pf-secondary-button shrink-0"
              disabled={rebuildMutation.isPending || Boolean(activeJob)}
              onClick={() => {
                if (
                  window.confirm(
                    "重新分析会调用当前模型并产生用量。旧版记录会保留到分析成功，是否继续？",
                  )
                ) {
                  rebuildMutation.mutate();
                }
              }}
              type="button"
            >
              {rebuildMutation.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw className="size-3.5" />
              )}
              重新分析旧版数据
            </button>
          </div>
        ) : null}

        <div className="grid gap-px overflow-hidden rounded-xl border border-[var(--pf-line)] bg-[var(--pf-line)] sm:grid-cols-2 xl:grid-cols-4 mt-5">
          {stats.map((stat) => {
            const active = summaryIsActive(stat.key);
            return (
              <button
                aria-label={`查看${stat.label}，共 ${stat.value} 项`}
                aria-pressed={active}
                className={cn(
                  "group bg-[var(--pf-panel-raised)] px-4 py-3.5 text-left transition-colors hover:bg-[var(--pf-panel-subtle)] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--pf-accent)]",
                  active && "bg-[var(--pf-accent-soft)] ring-1 ring-inset ring-[var(--pf-accent)]",
                )}
                key={stat.label}
                onClick={() => applySummaryFilter(stat.key)}
                type="button"
              >
                <div className="flex items-center justify-between text-[var(--pf-ink-muted)]">
                  <span className="text-[10px] font-semibold">{stat.label}</span>
                  <span className="flex items-center gap-1">
                    <stat.icon className="size-3.5" />
                    <ChevronRight className="size-3 opacity-50 transition-transform group-hover:translate-x-0.5 group-hover:opacity-100" />
                  </span>
                </div>
                <p className="mt-2 text-2xl font-semibold tabular-nums text-[var(--pf-ink)]">
                  {stat.value}
                </p>
              </button>
            );
          })}
        </div>

        <nav className="mt-5 flex gap-1 border-b border-[var(--pf-line)]" aria-label="追踪视图">
          {(
            [
              ["ledger", "追踪台账"],
              ["alerts", `提醒收件箱 ${data.unreadAlertCount}`],
              ["rules", "规则"],
              [
                "governance",
                `数据治理 ${data.governanceCounts.activeUnqualified + data.governanceCounts.archived}`,
              ],
            ] as const
          ).map(([key, label]) => (
            <button
              className={cn(
                "border-b-2 px-3 py-2 text-xs font-medium",
                view === key
                  ? "border-[var(--pf-accent)] text-[var(--pf-accent-ink)]"
                  : "border-transparent text-[var(--pf-ink-muted)] hover:text-[var(--pf-ink)]",
              )}
              key={key}
              onClick={() => {
                setView(key);
                if (key === "alerts") setAlertStatusFilter("all");
              }}
              type="button"
            >
              {label}
            </button>
          ))}
        </nav>

        {view === "ledger" ? (
          <div className="mt-4 overflow-hidden rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)]">
            <div className="flex flex-col gap-2 border-b border-[var(--pf-line)] p-3 lg:flex-row lg:items-center">
              <label className="relative min-w-0 flex-1">
                <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--pf-ink-muted)]" />
                <input
                  aria-label="搜索追踪事项"
                  className="pf-filter-input pl-8"
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(1);
                  }}
                  placeholder="搜索事项或内容"
                  value={search}
                />
              </label>
              <select
                aria-label="事项类型"
                className="pf-filter-input lg:w-32"
                onChange={(event) => {
                  setTypeFilter(event.target.value);
                  setPage(1);
                }}
                value={typeFilter}
              >
                <option value="all">全部类型</option>
                <option value="risk">风险</option>
                <option value="catalyst">催化剂</option>
              </select>
              <select
                aria-label="质量状态"
                className="pf-filter-input lg:w-32"
                onChange={(event) => {
                  setQualityFilter(event.target.value);
                  setPage(1);
                }}
                value={qualityFilter}
              >
                <option value="all">全部质量</option>
                <option value="verified">已验证</option>
                <option value="needs_review">待复核</option>
              </select>
              <span className="px-1 text-[10px] text-[var(--pf-ink-muted)]">
                {trackedItems.length} 项
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[920px] text-left">
                <thead className="bg-[var(--pf-panel-subtle)] text-[10px] font-semibold text-[var(--pf-ink-muted)]">
                  <tr>
                    <th className="px-4 py-2.5">类型</th>
                    <th className="px-3 py-2.5">事项</th>
                    <th className="px-3 py-2.5">状态</th>
                    <th className="px-3 py-2.5">影响</th>
                    <th className="px-3 py-2.5">时间窗口</th>
                    <th className="px-3 py-2.5">质量</th>
                    <th className="px-3 py-2.5">证据</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--pf-line)]">
                  {paginatedItems.map((item) => {
                    const current = item.currentVersion;
                    return (
                      <tr
                        className="cursor-pointer hover:bg-[var(--pf-panel-subtle)]/70"
                        key={item.itemId}
                        onClick={() => setSelectedItem(item)}
                      >
                        <td className="px-4 py-3">
                          <span
                            className={
                              item.itemType === "risk" ? "pf-risk-badge" : "pf-catalyst-badge"
                            }
                          >
                            {ITEM_LABELS[item.itemType]}
                          </span>
                        </td>
                        <td className="max-w-xl px-3 py-3">
                          <p className="truncate text-xs font-semibold text-[var(--pf-ink)]">
                            {item.title}
                          </p>
                          <p className="mt-1 line-clamp-1 text-[10px] text-[var(--pf-ink-muted)]">
                            {current?.content}
                          </p>
                        </td>
                        <td className="px-3 py-3 text-xs text-[var(--pf-ink-secondary)]">
                          {stateLabel(current?.state)}
                        </td>
                        <td className="px-3 py-3 text-xs text-[var(--pf-ink-secondary)]">
                          {IMPACT_LABELS[current?.impact ?? ""] ?? current?.impact ?? "—"}
                        </td>
                        <td className="px-3 py-3 text-xs text-[var(--pf-ink-secondary)]">
                          {current?.expectedStart || current?.expectedEnd || "—"}
                        </td>
                        <td className="px-3 py-3">
                          <QualityBadge quality={qualityOf(item)} />
                          {current?.metadata?.requires_rebuild ? (
                            <p className="mt-1 text-[9px] font-medium text-amber-700 dark:text-amber-300">
                              旧版数据
                            </p>
                          ) : null}
                          <p className="mt-1 text-[9px] text-[var(--pf-ink-muted)]">
                            {Math.round((current?.confidence ?? 0) * 100)}%
                          </p>
                        </td>
                        <td className="px-3 py-3 text-xs tabular-nums text-[var(--pf-ink-secondary)]">
                          {current?.evidenceIds.length ?? 0}
                        </td>
                        <td className="pr-3 text-[var(--pf-ink-muted)]">
                          <ChevronRight className="size-4" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!trackedItems.length ? (
                <div className="p-10 text-center text-xs text-[var(--pf-ink-muted)]">
                  没有符合当前筛选条件的事项。
                </div>
              ) : null}
            </div>
            {trackedItems.length ? (
              <div className="flex flex-col gap-3 border-t border-[var(--pf-line)] px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2 text-[10px] text-[var(--pf-ink-muted)]">
                  <span>
                    {`显示 ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, trackedItems.length)}，共 ${trackedItems.length} 项`}
                  </span>
                  <label className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                    每页
                    <select
                      aria-label="每页显示数量"
                      className="pf-filter-input h-7 w-16 py-0 text-[10px]"
                      onChange={(event) => {
                        setPageSize(Number(event.target.value));
                        setPage(1);
                      }}
                      value={pageSize}
                    >
                      <option value={10}>10</option>
                      <option value={20}>20</option>
                      <option value={50}>50</option>
                    </select>
                  </label>
                </div>
                <nav aria-label="追踪列表分页" className="flex items-center gap-1">
                  <button
                    className="pf-pagination-button"
                    disabled={page === 1}
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                    type="button"
                  >
                    上一页
                  </button>
                  {visiblePages.map((pageNumber) => (
                    <button
                      aria-current={pageNumber === page ? "page" : undefined}
                      aria-label={`第 ${pageNumber} 页`}
                      className={cn(
                        "pf-pagination-button min-w-7",
                        pageNumber === page && "pf-pagination-button-active",
                      )}
                      key={pageNumber}
                      onClick={() => setPage(pageNumber)}
                      type="button"
                    >
                      {pageNumber}
                    </button>
                  ))}
                  <button
                    className="pf-pagination-button"
                    disabled={page === totalPages}
                    onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                    type="button"
                  >
                    下一页
                  </button>
                </nav>
              </div>
            ) : null}
          </div>
        ) : null}

        {view === "alerts" ? (
          <div className="mt-4 overflow-hidden rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)]">
            {alerts.length ? (
              alerts.map((alert) => (
                <AlertRow
                  alert={alert}
                  key={alert.alertId}
                  onUpdate={(status) => alertMutation.mutate({ alertId: alert.alertId, status })}
                  pending={
                    alertMutation.isPending && alertMutation.variables?.alertId === alert.alertId
                  }
                />
              ))
            ) : (
              <div className="p-10 text-center text-xs text-[var(--pf-ink-muted)]">
                当前没有待处理提醒。
              </div>
            )}
          </div>
        ) : null}

        {view === "rules" ? (
          <div className="mt-4 overflow-hidden rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)]">
            <div className="flex items-center justify-between border-b border-[var(--pf-line)] px-4 py-3">
              <div>
                <h2 className="text-xs font-semibold text-[var(--pf-ink)]">追踪规则</h2>
                <p className="mt-1 text-[10px] text-[var(--pf-ink-muted)]">
                  关键词、事件类型、变化类型与最低重要度共同决定哪些变化进入提醒。
                </p>
              </div>
              <button
                className="pf-primary-button"
                onClick={() => setEditingRule(null)}
                type="button"
              >
                <Plus className="size-3.5" /> 新建规则
              </button>
            </div>
            {editingRule !== undefined ? (
              <div className="border-b border-[var(--pf-line)] bg-[var(--pf-panel-subtle)]">
                <RuleEditor
                  error={
                    ruleSaveMutation.error instanceof Error
                      ? ruleSaveMutation.error.message
                      : undefined
                  }
                  key={editingRule?.ruleId ?? "new"}
                  onCancel={() => setEditingRule(undefined)}
                  onSubmit={(draft) => ruleSaveMutation.mutate({ rule: editingRule, draft })}
                  pending={ruleSaveMutation.isPending}
                  rule={editingRule}
                />
              </div>
            ) : null}
            {data.watchRules.map((rule) => (
              <div
                className="flex items-start gap-3 border-b border-[var(--pf-line)] px-4 py-3 last:border-b-0"
                key={rule.ruleId}
              >
                <input
                  aria-label={`启用追踪规则 ${rule.name}`}
                  checked={rule.active}
                  className="size-4 accent-[var(--pf-accent)]"
                  disabled={ruleMutation.isPending}
                  onChange={(event) =>
                    ruleMutation.mutate({ ruleId: rule.ruleId, active: event.target.checked })
                  }
                  type="checkbox"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-[var(--pf-ink)]">{rule.name}</p>
                  <p className="mt-1 text-[10px] text-[var(--pf-ink-muted)]">
                    {ITEM_LABELS[rule.targetType] ?? rule.targetType} · 最低优先级{" "}
                    {IMPACT_LABELS[rule.minPriority] ?? rule.minPriority} ·{" "}
                    {FREQUENCY_LABELS[rule.frequency] ?? rule.frequency}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {stringList(rule.query.keywords).map((keyword) => (
                      <span
                        className="rounded-full bg-[var(--pf-accent-soft)] px-2 py-0.5 text-[9px] text-[var(--pf-accent-ink)]"
                        key={keyword}
                      >
                        关键词：{keyword}
                      </span>
                    ))}
                    {stringList(rule.query.event_types).map((eventType) => (
                      <span
                        className="rounded-full bg-[var(--pf-panel-subtle)] px-2 py-0.5 text-[9px] text-[var(--pf-ink-secondary)]"
                        key={eventType}
                      >
                        {eventTypeLabel(eventType)}
                      </span>
                    ))}
                    {!stringList(rule.query.keywords).length &&
                    !stringList(rule.query.event_types).length ? (
                      <span className="text-[9px] text-[var(--pf-ink-muted)]">
                        匹配该事项类型下的全部事件
                      </span>
                    ) : null}
                  </div>
                </div>
                <button
                  className="pf-icon-button"
                  onClick={() => setEditingRule(rule)}
                  title="编辑规则"
                  type="button"
                >
                  <Pencil className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {view === "governance" ? (
          <div className="mt-4 overflow-hidden rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)]">
            <div className="flex flex-col gap-3 border-b border-[var(--pf-line)] p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-xs font-semibold text-[var(--pf-ink)]">历史低质量数据治理</h2>
                <p className="mt-1 text-[10px] leading-4 text-[var(--pf-ink-muted)]">
                  这里只收纳未通过当前质量门的旧记录。归档可恢复；永久清理会同时删除版本、证据关联与提醒。
                </p>
              </div>
              <div className="flex gap-1 rounded-lg bg-[var(--pf-panel-subtle)] p-1">
                {(["active", "archived"] as const).map((status) => (
                  <button
                    className={cn(
                      "rounded-md px-3 py-1.5 text-[10px] font-semibold",
                      governanceStatus === status
                        ? "bg-[var(--pf-panel-raised)] text-[var(--pf-accent-ink)] shadow-sm"
                        : "text-[var(--pf-ink-muted)]",
                    )}
                    key={status}
                    onClick={() => {
                      setGovernanceStatus(status);
                      setSelectedGovernanceIds(new Set());
                    }}
                    type="button"
                  >
                    {status === "active"
                      ? `待治理 ${data.governanceCounts.activeUnqualified}`
                      : `已归档 ${data.governanceCounts.archived}`}
                  </button>
                ))}
              </div>
            </div>
            {governanceQuery.isLoading ? (
              <div className="flex items-center justify-center gap-2 p-10 text-xs text-[var(--pf-ink-muted)]">
                <Loader2 className="size-3.5 animate-spin" /> 正在读取治理队列
              </div>
            ) : governanceQuery.isError ? (
              <div className="m-4 rounded-lg bg-[var(--pf-danger-soft)] p-3 text-xs text-[var(--pf-danger-ink)]">
                治理队列加载失败：{governanceQuery.error.message}
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between border-b border-[var(--pf-line)] px-4 py-2.5">
                  <label className="flex items-center gap-2 text-[10px] text-[var(--pf-ink-secondary)]">
                    <input
                      checked={
                        Boolean(governanceQuery.data?.length) &&
                        selectedGovernanceIds.size === governanceQuery.data?.length
                      }
                      onChange={(event) =>
                        setSelectedGovernanceIds(
                          event.target.checked
                            ? new Set((governanceQuery.data ?? []).map((item) => item.itemId))
                            : new Set(),
                        )
                      }
                      type="checkbox"
                    />
                    全选（已选 {selectedGovernanceIds.size} 项）
                  </label>
                  {governanceStatus === "active" ? (
                    <button
                      className="pf-secondary-button"
                      disabled={!selectedGovernanceIds.size || governanceMutation.isPending}
                      onClick={() =>
                        governanceMutation.mutate({
                          action: "archive",
                          itemIds: [...selectedGovernanceIds],
                        })
                      }
                      type="button"
                    >
                      <Archive className="size-3.5" /> 归档选中
                    </button>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        className="pf-secondary-button"
                        disabled={!selectedGovernanceIds.size || governanceMutation.isPending}
                        onClick={() =>
                          governanceMutation.mutate({
                            action: "restore",
                            itemIds: [...selectedGovernanceIds],
                          })
                        }
                        type="button"
                      >
                        <RotateCcw className="size-3.5" /> 恢复选中
                      </button>
                      <button
                        className="pf-secondary-button text-[var(--pf-danger-ink)]"
                        disabled={!selectedGovernanceIds.size || governanceMutation.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              `将永久删除 ${selectedGovernanceIds.size} 条已归档记录及其历史版本，且无法恢复。确定继续吗？`,
                            )
                          ) {
                            governanceMutation.mutate({
                              action: "purge",
                              itemIds: [...selectedGovernanceIds],
                            });
                          }
                        }}
                        type="button"
                      >
                        <Trash2 className="size-3.5" /> 永久清理
                      </button>
                    </div>
                  )}
                </div>
                {governanceMutation.isError ? (
                  <p className="border-b border-[var(--pf-line)] px-4 py-2 text-xs text-[var(--pf-danger-ink)]">
                    操作失败：{governanceMutation.error.message}
                  </p>
                ) : null}
                {(governanceQuery.data ?? []).length ? (
                  <div className="divide-y divide-[var(--pf-line)]">
                    {(governanceQuery.data ?? []).map((item) => (
                      <label
                        className="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-[var(--pf-panel-subtle)]"
                        key={item.itemId}
                      >
                        <input
                          checked={selectedGovernanceIds.has(item.itemId)}
                          className="mt-0.5"
                          onChange={() =>
                            setSelectedGovernanceIds((current) => {
                              const next = new Set(current);
                              if (next.has(item.itemId)) next.delete(item.itemId);
                              else next.add(item.itemId);
                              return next;
                            })
                          }
                          type="checkbox"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span
                              className={
                                item.itemType === "risk" ? "pf-risk-badge" : "pf-catalyst-badge"
                              }
                            >
                              {ITEM_LABELS[item.itemType]}
                            </span>
                            <span className="truncate text-xs font-semibold text-[var(--pf-ink)]">
                              {item.title || "无有效标题"}
                            </span>
                          </span>
                          <span className="mt-1.5 block text-[10px] font-medium text-[var(--pf-danger-ink)]">
                            {item.qualityIssue ?? item.archiveReason ?? "未通过质量门"}
                          </span>
                          <span className="mt-1 block line-clamp-2 text-[10px] leading-4 text-[var(--pf-ink-muted)]">
                            {item.currentVersion?.content || "无有效内容"}
                          </span>
                          {item.archivedAt ? (
                            <span className="mt-1 block text-[9px] text-[var(--pf-ink-muted)]">
                              归档于 {formatTime(item.archivedAt)}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className="p-10 text-center text-xs text-[var(--pf-ink-muted)]">
                    {governanceStatus === "active"
                      ? "没有待治理的低质量记录。"
                      : "尚未归档低质量记录。"}
                  </div>
                )}
              </>
            )}
          </div>
        ) : null}
      </div>
      {selectedItem ? (
        <ItemDetailDrawer
          datasetId={datasetId}
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
        />
      ) : null}
    </section>
  );
}
