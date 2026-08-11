import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CircleDot,
  Clock3,
  Database,
  FileSearch,
  FileSpreadsheet,
  RefreshCw,
  Scale,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { usePrivateFundValuationTracking } from "@/hooks/usePrivateFundProjects";
import {
  runPrivateFundValuationTracking,
  searchPrivateFundValuationSecurities,
  updatePrivateFundValuationModelIdentity,
  type PrivateFundValuationImpactAnalysis,
  type PrivateFundValuationMetricComparison,
  type PrivateFundValuationMetricTimeline,
  type PrivateFundValuationMarketSnapshot,
  type PrivateFundValuationPriceComparison,
  type PrivateFundValuationSecurityCandidate,
  type PrivateFundValuationTrackingOverview,
} from "@/lib/privateFundApi";
import { usePrivateFundWorkspaceStore } from "@/store/privateFundWorkspaceStore";
import { cn } from "@/lib/utils";

const EMPTY_SELECTED_DOCUMENT_IDS: string[] = [];

const EXPECTED_METRICS = [
  "quarter_net_profit_yoy",
  "quarter_gross_margin_qoq_delta",
  "forward_pe",
  "avg_turnover_amount_20d",
  "quarter_revenue_growth_qoq",
] as const;

const QUARTERLY_METRICS = [
  "quarter_net_profit_yoy",
  "quarter_gross_margin_qoq_delta",
  "quarter_revenue_growth_qoq",
] as const;

const IMPACT_DIRECTION_STYLES = {
  up: {
    label: "估值上行",
    icon: ArrowUpRight,
    badge:
      "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
  },
  down: {
    label: "估值下行",
    icon: ArrowDownRight,
    badge:
      "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300",
  },
  mixed: {
    label: "双向影响",
    icon: Scale,
    badge:
      "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
  },
} as const;

const SEVERITY = {
  normal: {
    label: "一致",
    icon: Check,
    badge:
      "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
    rail: "bg-emerald-500",
  },
  warning: {
    label: "关注",
    icon: AlertTriangle,
    badge:
      "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
    rail: "bg-amber-500",
  },
  critical: {
    label: "预警",
    icon: ShieldAlert,
    badge:
      "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300",
    rail: "bg-red-500",
  },
  unavailable: {
    label: "待补充",
    icon: CircleDot,
    badge: "border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] text-[var(--pf-ink-muted)]",
    rail: "bg-[var(--pf-line-strong)]",
  },
} as const;

function formatTime(value?: string | null): string {
  if (!value) return "暂无";
  const compactDate = /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : value;
  const timestamp = Date.parse(compactDate);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: value.includes("T") ? "2-digit" : undefined,
    minute: value.includes("T") ? "2-digit" : undefined,
  }).format(timestamp);
}

function formatMetricValue(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return "暂无";
  if (unit === "percent" || unit === "percentage_point") {
    return new Intl.NumberFormat("zh-CN", {
      style: "percent",
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
      signDisplay: "exceptZero",
    }).format(value);
  }
  if (unit === "multiple") {
    return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value)}x`;
  }
  if (unit === "currency") {
    const absolute = Math.abs(value);
    if (absolute >= 100_000_000) return `${(value / 100_000_000).toFixed(2)} 亿元`;
    if (absolute >= 10_000) return `${(value / 10_000).toFixed(1)} 万元`;
    return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value)} 元`;
  }
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

function formatPrice(value: number | null, currency: string): string {
  if (value === null || !Number.isFinite(value)) return "暂无";
  try {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: currency || "CNY",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`.trim();
  }
}

function formatUpside(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "暂无";
  return new Intl.NumberFormat("zh-CN", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  }).format(value);
}

export function PriceComparisonCard({ price }: { price: PrivateFundValuationPriceComparison }) {
  const items = [
    {
      label: "模型目标价",
      value: formatPrice(price.targetPrice, price.currency),
      meta: price.targetSource,
    },
    {
      label: "估值日收盘",
      value: formatPrice(price.benchmarkClose, price.currency),
      meta: formatTime(price.benchmarkTradeDate || price.valuationDate),
    },
    {
      label: "估值日隐含空间",
      value: formatUpside(price.impliedUpside),
      meta: "目标价 ÷ 收盘价 − 1",
    },
    {
      label: "最新收盘",
      value: formatPrice(price.latestClose, price.currency),
      meta: formatTime(price.latestTradeDate),
    },
    { label: "当前剩余空间", value: formatUpside(price.latestUpside), meta: "目标价 ÷ 最新价 − 1" },
  ];
  return (
    <section
      aria-label="目标价与市场价格对比"
      className="overflow-hidden rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] px-4 py-2.5">
        <div>
          <h2 className="text-xs font-semibold text-[var(--pf-ink)]">目标价与真实价格</h2>
          <p className="mt-0.5 text-[9px] text-[var(--pf-ink-muted)]">
            原始收盘价（不复权）· {price.provider || "AKShare"} {price.providerSymbol}
          </p>
        </div>
        <span className="rounded-full border border-[var(--pf-line)] px-2 py-0.5 text-[9px] text-[var(--pf-ink-muted)]">
          {price.status === "completed"
            ? "已对比"
            : price.status === "failed"
              ? "查询失败"
              : "待补充"}
        </span>
      </div>
      <div className="grid gap-px bg-[var(--pf-line)] sm:grid-cols-2 xl:grid-cols-5">
        {items.map((item) => (
          <div className="bg-[var(--pf-panel-raised)] px-4 py-3" key={item.label}>
            <p className="text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--pf-ink-muted)]">
              {item.label}
            </p>
            <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-[var(--pf-ink)]">
              {item.value}
            </p>
            <p className="mt-0.5 truncate text-[9px] text-[var(--pf-ink-muted)]">
              {item.meta || "暂无"}
            </p>
          </div>
        ))}
      </div>
      {price.errorMessage ? (
        <p className="border-t border-[var(--pf-line)] px-4 py-2 text-[9px] text-amber-700 dark:text-amber-300">
          {price.errorMessage}
        </p>
      ) : null}
    </section>
  );
}

function ComparisonRow({
  metric,
  showSeverity = true,
}: {
  metric: PrivateFundValuationMetricComparison;
  showSeverity?: boolean;
}) {
  const isPeriodMismatch = metric.status === "period_mismatch";
  const severityStyle = SEVERITY[metric.severity as keyof typeof SEVERITY] ?? SEVERITY.unavailable;
  const style = isPeriodMismatch ? SEVERITY.warning : severityStyle;
  const statusLabel = isPeriodMismatch ? "期间不一致" : style.label;
  const StatusIcon = style.icon;
  const isManuallyVerified = metric.modelQualityStatus.startsWith("manual_verified");
  return (
    <article className="group relative grid gap-3 border-t border-[var(--pf-line)] bg-[var(--pf-panel-raised)] px-4 py-4 first:border-t-0 lg:grid-cols-[minmax(220px,1.35fr)_minmax(140px,0.75fr)_32px_minmax(140px,0.75fr)] lg:items-center lg:px-5">
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-3 left-0 w-0.5 rounded-r",
          showSeverity ? style.rail : "bg-[var(--pf-line-strong)]",
        )}
      />
      <div className="min-w-0 pl-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold tracking-tight text-[var(--pf-ink)]">
            {metric.label}
          </h3>
          {showSeverity ? (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-semibold",
                style.badge,
              )}
            >
              <StatusIcon className="size-2.5" /> {statusLabel}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-[10px] leading-4 text-[var(--pf-ink-muted)]">
          {metric.description}
        </p>
      </div>

      <div className="rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel)] px-3 py-2.5">
        <p className="text-[9px] font-medium uppercase tracking-[0.12em] text-[var(--pf-ink-muted)]">
          模型值
        </p>
        <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-[var(--pf-ink)]">
          {formatMetricValue(metric.modelValue, metric.unit)}
        </p>
        <p className="mt-0.5 truncate text-[9px] text-[var(--pf-ink-muted)]">
          {metric.modelPeriod || "模型未提取"}
          {isManuallyVerified ? " · 人工核验" : ""}
        </p>
      </div>

      <ArrowRight className="hidden size-4 text-[var(--pf-ink-muted)] lg:block" />

      <div className="rounded-lg border border-[var(--pf-accent)]/25 bg-[var(--pf-accent-soft)] px-3 py-2.5">
        <p className="text-[9px] font-medium uppercase tracking-[0.12em] text-[var(--pf-accent-ink)]">
          真实值 · API
        </p>
        <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-[var(--pf-ink)]">
          {formatMetricValue(metric.actualValue, metric.unit)}
        </p>
        <p className="mt-0.5 truncate text-[9px] text-[var(--pf-ink-muted)]">
          {metric.actualPeriod || "数据源未返回"}
        </p>
      </div>

      <details className="group/details lg:col-span-4">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-[9px] text-[var(--pf-ink-muted)] hover:text-[var(--pf-ink)]">
          <ChevronDown className="size-3 transition-transform group-open/details:rotate-180" />
          查看口径与来源
        </summary>
        <div className="mt-2 grid gap-2 rounded-lg bg-[var(--pf-panel-subtle)] p-3 text-[10px] leading-4 text-[var(--pf-ink-secondary)] md:grid-cols-2">
          <p>
            <span className="text-[var(--pf-ink-muted)]">
              模型{isManuallyVerified ? "（人工核验）" : ""}：
            </span>
            {metric.modelSource || "未定位到对应模型单元格"}
          </p>
          <p>
            <span className="text-[var(--pf-ink-muted)]">真实：</span>
            {metric.actualSource || "API 未返回同口径数据"}
          </p>
          <p className="md:col-span-2">
            <span className="text-[var(--pf-ink-muted)]">判断：</span>
            {metric.explanation}
          </p>
        </div>
      </details>
    </article>
  );
}

function MarketSnapshotSection({
  snapshot,
}: {
  snapshot: PrivateFundValuationMarketSnapshot | undefined;
}) {
  if (!snapshot) return null;
  const statusLabel =
    snapshot.periodMismatchCount > 0
      ? "期间待对齐"
      : snapshot.comparedCount > 0
        ? "已对比"
        : snapshot.actualAvailableCount > 0
          ? "部分完成"
          : "待补充";
  return (
    <section
      aria-labelledby="valuation-market-snapshot-title"
      className="overflow-hidden rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] px-4 py-3">
        <div>
          <h2
            id="valuation-market-snapshot-title"
            className="text-xs font-semibold text-[var(--pf-ink)]"
          >
            当前市场快照
          </h2>
          <p className="mt-0.5 text-[9px] text-[var(--pf-ink-muted)]">
            Forward PE 与近 20 日日均成交额不归入财报季度；窗口不一致时仅展示，不触发预警。
          </p>
        </div>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[9px] font-semibold",
            snapshot.periodMismatchCount > 0 ? SEVERITY.warning.badge : SEVERITY.normal.badge,
          )}
        >
          {statusLabel}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--pf-line)] px-4 py-2 text-[10px] text-[var(--pf-ink-secondary)]">
        <span>模型 {snapshot.modelAvailableCount}/2</span>
        <span>API {snapshot.actualAvailableCount}/2</span>
        <span>可直接对比 {snapshot.comparedCount}/2</span>
        <span>快照：{formatTime(snapshot.asOf)}</span>
      </div>
      {snapshot.comparisons.length ? (
        snapshot.comparisons.map((metric) => (
          <ComparisonRow key={metric.metricKey} metric={metric} showSeverity={false} />
        ))
      ) : (
        <div className="px-5 py-8 text-center text-[10px] text-[var(--pf-ink-muted)]">
          等待市场指标刷新。
        </div>
      )}
    </section>
  );
}

const TIMELINE_STATUS = {
  comparable: {
    label: "模型 + API",
    dot: "border-[var(--pf-accent)] bg-[var(--pf-accent)]",
  },
  partial: {
    label: "部分可比",
    dot: "border-amber-500 bg-amber-500",
  },
  model_only: {
    label: "仅模型",
    dot: "border-[var(--pf-ink-muted)] bg-[var(--pf-panel-raised)]",
  },
  actual_only: {
    label: "仅 API",
    dot: "border-sky-500 bg-sky-500",
  },
  unavailable: {
    label: "暂无数据",
    dot: "border-[var(--pf-line-strong)] bg-[var(--pf-panel-raised)]",
  },
} as const;

const TIMELINE_NEARBY_PERIODS = 2;

function preferredTimelinePeriod(timeline: PrivateFundValuationMetricTimeline): string {
  for (let index = timeline.periods.length - 1; index >= 0; index -= 1) {
    if (timeline.periods[index].comparedCount > 0) return timeline.periods[index].period;
  }
  for (let index = timeline.periods.length - 1; index >= 0; index -= 1) {
    const period = timeline.periods[index];
    if (period.modelAvailableCount > 0 && period.actualAvailableCount > 0) return period.period;
  }
  return timeline.defaultPeriod || timeline.latestPeriod || timeline.periods.at(-1)?.period || "";
}

function MetricTimeline({
  timeline,
  selectedPeriod,
  onSelect,
}: {
  timeline: PrivateFundValuationMetricTimeline;
  selectedPeriod: string;
  onSelect: (period: string) => void;
}) {
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const reduceMotion = useReducedMotion();
  const [earlierExpanded, setEarlierExpanded] = useState(false);
  const [laterExpanded, setLaterExpanded] = useState(false);
  const activeIndex = timeline.periods.findIndex((item) => item.period === selectedPeriod);
  const active = timeline.periods[activeIndex] ?? timeline.periods[0];
  const preferredPeriod = preferredTimelinePeriod(timeline);
  const preferredIndex = Math.max(
    0,
    timeline.periods.findIndex((item) => item.period === preferredPeriod),
  );
  const collapsedStart = Math.max(0, preferredIndex - TIMELINE_NEARBY_PERIODS);
  const collapsedEnd = Math.min(
    timeline.periods.length - 1,
    preferredIndex + TIMELINE_NEARBY_PERIODS,
  );
  const hiddenEarlierCount = collapsedStart;
  const hiddenLaterCount = Math.max(0, timeline.periods.length - 1 - collapsedEnd);
  const visiblePeriods = timeline.periods.filter(
    (_item, index) =>
      index >= (earlierExpanded ? 0 : collapsedStart) &&
      index <= (laterExpanded ? timeline.periods.length - 1 : collapsedEnd),
  );

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, [selectedPeriod]);

  useEffect(() => {
    setEarlierExpanded(false);
    setLaterExpanded(false);
  }, [preferredPeriod, timeline.periods.length]);

  if (!active) return null;

  const selectPeriod = (period: string) => {
    const nextIndex = timeline.periods.findIndex((item) => item.period === period);
    if (nextIndex < collapsedStart) setEarlierExpanded(true);
    if (nextIndex > collapsedEnd) setLaterExpanded(true);
    onSelect(period);
  };

  const move = (offset: number) => {
    const next =
      timeline.periods[Math.min(timeline.periods.length - 1, Math.max(0, activeIndex + offset))];
    if (next) selectPeriod(next.period);
  };

  const toggleEarlier = () => {
    if (earlierExpanded && activeIndex < collapsedStart) onSelect(preferredPeriod);
    setEarlierExpanded((current) => !current);
  };

  const toggleLater = () => {
    if (laterExpanded && activeIndex > collapsedEnd) onSelect(preferredPeriod);
    setLaterExpanded((current) => !current);
  };

  return (
    <section
      aria-labelledby="valuation-timeline-title"
      className="overflow-hidden rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--pf-line)] px-4 py-3">
        <div>
          <h2 id="valuation-timeline-title" className="text-xs font-semibold text-[var(--pf-ink)]">
            历史估值时间轴
          </h2>
          <p className="mt-0.5 text-[9px] text-[var(--pf-ink-muted)]">
            默认聚焦最近可比期，左右可按需展开
          </p>
        </div>
        <div className="flex items-center gap-1">
          {selectedPeriod !== timeline.latestPeriod ? (
            <button
              className="mr-1 rounded-md border border-[var(--pf-line)] px-2 py-1 text-[9px] font-semibold text-[var(--pf-ink-secondary)] hover:bg-[var(--pf-panel-subtle)]"
              onClick={() => selectPeriod(timeline.latestPeriod)}
              type="button"
            >
              跳到最新披露
            </button>
          ) : null}
          <button
            aria-label="上一个期间"
            className="grid size-7 place-items-center rounded-md border border-[var(--pf-line)] text-[var(--pf-ink-muted)] hover:bg-[var(--pf-panel-subtle)] disabled:opacity-35"
            disabled={activeIndex <= 0}
            onClick={() => move(-1)}
            type="button"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <button
            aria-label="下一个期间"
            className="grid size-7 place-items-center rounded-md border border-[var(--pf-line)] text-[var(--pf-ink-muted)] hover:bg-[var(--pf-panel-subtle)] disabled:opacity-35"
            disabled={activeIndex >= timeline.periods.length - 1}
            onClick={() => move(1)}
            type="button"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="flex items-stretch gap-2 px-3 py-4 sm:px-4">
        {hiddenEarlierCount ? (
          <button
            aria-controls="valuation-period-tabs"
            aria-expanded={earlierExpanded}
            aria-label={
              earlierExpanded
                ? `收起 ${hiddenEarlierCount} 个更早期间`
                : `展开 ${hiddenEarlierCount} 个更早期间`
            }
            className="group inline-flex w-9 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] px-1 text-[9px] font-semibold text-[var(--pf-ink-muted)] outline-none transition-[border-color,background-color,color,transform] hover:border-[var(--pf-line-strong)] hover:text-[var(--pf-ink)] active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)] sm:w-[4.5rem]"
            onClick={toggleEarlier}
            type="button"
          >
            {earlierExpanded ? (
              <ChevronsRight className="size-3.5" />
            ) : (
              <ChevronsLeft className="size-3.5" />
            )}
            <span className="hidden sm:block">{earlierExpanded ? "收起更早" : "展开更早"}</span>
            <span className="font-mono text-[8px] font-medium">{hiddenEarlierCount} 期</span>
          </button>
        ) : null}

        <div className="relative min-w-0 flex-1 overflow-x-auto [scrollbar-width:thin]">
          <div
            aria-hidden
            className="absolute left-4 right-4 top-[2.15rem] h-px bg-[var(--pf-line-strong)]"
          />
          <div
            aria-label="选择估值期间"
            className="relative flex min-w-max gap-1"
            id="valuation-period-tabs"
            role="tablist"
          >
            <AnimatePresence initial={false} mode="popLayout">
              {visiblePeriods.map((item) => {
                const periodIndex = timeline.periods.findIndex(
                  (period) => period.period === item.period,
                );
                const status =
                  TIMELINE_STATUS[item.status as keyof typeof TIMELINE_STATUS] ??
                  TIMELINE_STATUS.unavailable;
                const selected = item.period === selectedPeriod;
                const preferred = item.period === preferredPeriod;
                const [year, quarter = ""] = item.period.split("Q");
                return (
                  <motion.div
                    animate={{ opacity: 1, scale: 1 }}
                    className="shrink-0"
                    exit={reduceMotion ? undefined : { opacity: 0, scale: 0.96 }}
                    initial={reduceMotion ? false : { opacity: 0, scale: 0.96 }}
                    key={item.period}
                    layout={reduceMotion ? false : "position"}
                    role="presentation"
                    transition={{
                      duration: reduceMotion ? 0 : 0.18,
                      ease: [0.16, 1, 0.3, 1],
                    }}
                  >
                    <button
                      aria-controls="valuation-period-panel"
                      aria-label={`${item.label} ${preferred ? "最新可比 " : ""}${status.label}`}
                      aria-posinset={periodIndex + 1}
                      aria-selected={selected}
                      aria-setsize={timeline.periods.length}
                      className={cn(
                        "group min-w-[6.5rem] scroll-mx-4 rounded-lg border px-3 py-2.5 text-left outline-none transition-[border-color,background-color,transform] active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)]",
                        selected
                          ? "border-[var(--pf-accent)] bg-[var(--pf-accent-soft)]"
                          : preferred
                            ? "border-[var(--pf-accent)]/45 bg-[var(--pf-accent-soft)]/45 hover:border-[var(--pf-accent)]"
                            : "border-transparent bg-[var(--pf-panel-raised)] hover:border-[var(--pf-line-strong)] hover:bg-[var(--pf-panel-subtle)]",
                      )}
                      onClick={() => selectPeriod(item.period)}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowLeft") {
                          event.preventDefault();
                          move(-1);
                        }
                        if (event.key === "ArrowRight") {
                          event.preventDefault();
                          move(1);
                        }
                      }}
                      ref={selected ? activeRef : undefined}
                      role="tab"
                      tabIndex={selected ? 0 : -1}
                      type="button"
                    >
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className={cn(
                            "relative z-10 size-2.5 rounded-full border-2 ring-4 ring-[var(--pf-panel-raised)]",
                            status.dot,
                          )}
                        />
                        <span className="font-mono text-[10px] text-[var(--pf-ink-muted)]">
                          {year}
                        </span>
                      </span>
                      <span className="mt-2 block text-sm font-semibold text-[var(--pf-ink)]">
                        Q{quarter}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[9px] text-[var(--pf-ink-muted)]">
                        {status.label}
                        {preferred ? (
                          <span className="rounded border border-[var(--pf-accent)]/30 px-1 py-px font-semibold text-[var(--pf-accent-ink)]">
                            最新可比
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        </div>

        {hiddenLaterCount ? (
          <button
            aria-controls="valuation-period-tabs"
            aria-expanded={laterExpanded}
            aria-label={
              laterExpanded
                ? `收起 ${hiddenLaterCount} 个较新期间`
                : `展开 ${hiddenLaterCount} 个较新期间`
            }
            className="group inline-flex w-9 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] px-1 text-[9px] font-semibold text-[var(--pf-ink-muted)] outline-none transition-[border-color,background-color,color,transform] hover:border-[var(--pf-line-strong)] hover:text-[var(--pf-ink)] active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)] sm:w-[4.5rem]"
            onClick={toggleLater}
            type="button"
          >
            {laterExpanded ? (
              <ChevronsLeft className="size-3.5" />
            ) : (
              <ChevronsRight className="size-3.5" />
            )}
            <span className="hidden sm:block">{laterExpanded ? "收起较新" : "展开较新"}</span>
            <span className="font-mono text-[8px] font-medium">{hiddenLaterCount} 期</span>
          </button>
        ) : null}
      </div>

      <div
        className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] px-4 py-2.5"
        id="valuation-period-panel"
        role="tabpanel"
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-[var(--pf-ink-secondary)]">
          <span className="font-semibold text-[var(--pf-ink)]">{active.label}</span>
          <span>季度模型 {active.modelAvailableCount}/3</span>
          <span>季度 API {active.actualAvailableCount}/3</span>
          <span>可直接对比 {active.comparedCount}/3</span>
        </div>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[9px] font-semibold",
            active.alertCount ? SEVERITY.warning.badge : SEVERITY.normal.badge,
          )}
        >
          {active.alertCount ? active.alertCount + " 项偏差预警" : "无偏差预警"}
        </span>
      </div>
    </section>
  );
}

const IMPACT_INPUT_LABELS: Record<string, string> = {
  revenue_growth: "收入增速",
  gross_margin: "毛利率",
  operating_margin: "营业利润率",
  unit_economics: "单位经济性",
  r_and_d: "研发费用",
  capex: "资本开支",
  working_capital: "营运资金",
  free_cash_flow: "自由现金流",
  wacc: "WACC",
  terminal_growth: "终值增速",
  valuation_multiple: "估值倍数",
  success_probability: "成功概率",
  timing_discount: "时间折现",
  overseas_revenue: "海外收入",
  order_conversion: "订单转化",
};

function impactConfidenceLabel(confidence: number): string {
  if (confidence >= 0.8) return "高";
  if (confidence >= 0.65) return "中高";
  if (confidence >= 0.5) return "中等";
  return "中低";
}

function ValuationImpactSection({ analysis }: { analysis: PrivateFundValuationImpactAnalysis }) {
  const statusLabel =
    analysis.status === "completed"
      ? `资料综合分析 · ${analysis.cards.length} 张`
      : analysis.status === "partial" && analysis.cards.length
        ? `资料证据卡 · ${analysis.cards.length} 张（待核验）`
        : analysis.status === "failed"
          ? "生成失败"
          : analysis.status === "no_evidence"
            ? "暂无可引用资料"
            : "等待生成";
  return (
    <section
      aria-labelledby="valuation-impact-title"
      className="overflow-hidden rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] px-4 py-3.5">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--pf-accent-soft)] text-[var(--pf-accent-ink)]">
            <Sparkles className="size-3.5" />
          </span>
          <div>
            <h2 id="valuation-impact-title" className="text-sm font-semibold text-[var(--pf-ink)]">
              其他资料对估值的综合影响
            </h2>
            <p className="mt-0.5 text-[10px] leading-4 text-[var(--pf-ink-muted)]">
              Agent 基于当前项目的研究资料、会议纪要和财务资料生成，并保留原文证据定位。
            </p>
          </div>
        </div>
        <span className="rounded-full border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] px-2.5 py-1 text-[9px] font-semibold text-[var(--pf-ink-muted)]">
          {statusLabel}
        </span>
      </div>

      {analysis.cards.length ? (
        <div className="grid gap-px bg-[var(--pf-line)] lg:grid-cols-2 2xl:grid-cols-3">
          {analysis.cards.map((card) => {
            const style = IMPACT_DIRECTION_STYLES[card.direction];
            const DirectionIcon = style.icon;
            return (
              <article className="flex flex-col bg-[var(--pf-panel-raised)] p-4" key={card.cardId}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-semibold",
                      style.badge,
                    )}
                  >
                    <DirectionIcon className="size-2.5" /> {style.label}
                  </span>
                  <span className="text-[9px] text-[var(--pf-ink-muted)]">
                    {card.horizon} · 置信度{impactConfidenceLabel(card.confidence)}
                  </span>
                </div>

                <h3 className="mt-3 text-sm font-semibold tracking-tight text-[var(--pf-ink)]">
                  {card.title}
                </h3>
                <p className="mt-1.5 text-[10px] leading-4 text-[var(--pf-ink-secondary)]">
                  {card.evidenceSummary}
                </p>

                <div className="mt-3 rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] p-3">
                  <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--pf-accent)]">
                    对当前估值的可能影响
                  </p>
                  <p className="mt-1 text-[10px] leading-4 text-[var(--pf-ink)]">
                    {card.valuationImpact}
                  </p>
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  {card.affectedInputs.map((input) => (
                    <span
                      className="rounded-md bg-[var(--pf-accent-soft)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--pf-accent-ink)]"
                      key={input}
                    >
                      {IMPACT_INPUT_LABELS[input] ?? input}
                    </span>
                  ))}
                </div>

                <div className="mt-auto border-t border-[var(--pf-line)] pt-3 text-[9px] leading-4 text-[var(--pf-ink-muted)]">
                  <p>
                    <span className="font-semibold text-[var(--pf-ink-secondary)]">后续观察：</span>
                    {card.watchItems.join("、")}
                  </p>
                  <p className="mt-1">来源：{card.sourceRefs.join("；")}</p>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="px-5 py-8 text-center text-[10px] leading-5 text-[var(--pf-ink-muted)]">
          {analysis.errorMessage || "上传或更新辅助资料后，系统会生成可追溯的估值影响卡片。"}
        </div>
      )}

      <p className="border-t border-[var(--pf-line)] px-4 py-2.5 text-[9px] leading-4 text-[var(--pf-ink-muted)]">
        由 {analysis.skillName || "估值影响 Agent"} 基于当前资料生成；服务端已校验证据 ID。
        结果不直接改写估值模型，也不参与五指标数值与预警。
      </p>
    </section>
  );
}

function LoadingState() {
  return (
    <div
      aria-label="正在加载估值对比"
      className="overflow-hidden rounded-xl border border-[var(--pf-line)]"
    >
      {EXPECTED_METRICS.map((key) => (
        <div
          className="grid animate-pulse gap-3 border-t border-[var(--pf-line)] p-4 first:border-t-0 lg:grid-cols-[1.35fr_0.75fr_32px_0.75fr]"
          key={key}
        >
          <div className="space-y-2">
            <div className="h-4 w-36 rounded bg-[var(--pf-panel-subtle)]" />
            <div className="h-3 w-52 rounded bg-[var(--pf-panel-subtle)]" />
          </div>
          <div className="h-16 rounded-lg bg-[var(--pf-panel-subtle)]" />
          <div />
          <div className="h-16 rounded-lg bg-[var(--pf-panel-subtle)]" />
        </div>
      ))}
    </div>
  );
}

type ValuationStageState = "pending" | "running" | "completed" | "partial" | "failed" | "blocked";

type ValuationStage = {
  key: string;
  label: string;
  status: ValuationStageState;
  detail: string;
};

const STAGE_STYLE: Record<ValuationStageState, { label: string; className: string }> = {
  pending: { label: "待处理", className: "border-[var(--pf-line)] text-[var(--pf-ink-muted)]" },
  running: {
    label: "处理中",
    className:
      "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-300",
  },
  completed: {
    label: "完成",
    className:
      "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300",
  },
  partial: {
    label: "部分完成",
    className:
      "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300",
  },
  failed: {
    label: "失败",
    className:
      "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300",
  },
  blocked: {
    label: "待补充",
    className: "border-[var(--pf-line-strong)] bg-[var(--pf-panel-subtle)] text-[var(--pf-ink)]",
  },
};

function jobMatchesSeries(
  job: PrivateFundValuationTrackingOverview["jobs"][number],
  series: PrivateFundValuationTrackingOverview["series"][number],
) {
  const payload = job.payload ?? {};
  return (
    payload.series_id === series.seriesId &&
    payload.model_version_id === series.currentModelVersionId
  );
}

function latestJob(
  data: PrivateFundValuationTrackingOverview | undefined,
  series: PrivateFundValuationTrackingOverview["series"][number],
  jobTypes: string[],
  statuses?: string[],
) {
  return data?.jobs.find(
    (job) =>
      jobMatchesSeries(job, series) &&
      jobTypes.includes(job.jobType) &&
      (!statuses || statuses.includes(job.status)),
  );
}

function isJobActivelyRefreshing(
  job: PrivateFundValuationTrackingOverview["jobs"][number] | undefined,
) {
  return Boolean(
    job && (job.status === "running" || (job.status === "queued" && job.attemptCount === 0)),
  );
}

function isJobWaitingForRetry(
  job: PrivateFundValuationTrackingOverview["jobs"][number] | undefined,
) {
  return Boolean(job && job.status === "queued" && job.attemptCount > 0);
}

function retryWaitingDetail(job: PrivateFundValuationTrackingOverview["jobs"][number]) {
  return "上次执行失败，等待自动重试（已尝试 " + job.attemptCount + "/" + job.maxAttempts + " 次）";
}

function buildValuationStages(
  data: PrivateFundValuationTrackingOverview | undefined,
  series: PrivateFundValuationTrackingOverview["series"][number],
): ValuationStage[] {
  const modelMetricJob = latestJob(data, series, ["model_metric_refresh"]);
  const marketJob = latestJob(data, series, ["market_data_refresh"]);
  const contextJob = latestJob(data, series, ["valuation_context_refresh"]);
  const modelMetricRunning = isJobActivelyRefreshing(modelMetricJob);
  const modelMetricRetrying = isJobWaitingForRetry(modelMetricJob);
  const modelMetricFailed = modelMetricJob?.status === "failed" ? modelMetricJob : undefined;
  const modelMetricCompleted = modelMetricJob?.status === "completed";
  const marketRunning = isJobActivelyRefreshing(marketJob);
  const marketRetrying = isJobWaitingForRetry(marketJob);
  const marketFailed = marketJob?.status === "failed" ? marketJob : undefined;
  const contextRunning = isJobActivelyRefreshing(contextJob);
  const contextRetrying = isJobWaitingForRetry(contextJob);
  const contextFailed = contextJob?.status === "failed" ? contextJob : undefined;
  const analysis = series.metricAnalysis;
  const comparisons = analysis.metricComparisons ?? [];
  const modelMetricCount = EXPECTED_METRICS.filter((key) =>
    comparisons.some((metric) => metric.metricKey === key && metric.modelValue !== null),
  ).length;
  const actualMetricCount = EXPECTED_METRICS.filter((key) =>
    comparisons.some((metric) => metric.metricKey === key && metric.actualValue !== null),
  ).length;
  const marketStatus = analysis.marketData.status;
  const impactStatus = analysis.valuationImpacts.status;
  const impactCount = analysis.valuationImpacts.cards.length;

  return [
    {
      key: "recognition",
      label: "识别估值模型",
      status: series.currentModelVersionId ? "completed" : "pending",
      detail: series.currentModelVersionId ? "模型已识别" : "等待估值模型文件",
    },
    {
      key: "metrics",
      label: "抽取五指标",
      status: modelMetricRunning
        ? "running"
        : modelMetricRetrying
          ? "partial"
          : modelMetricFailed
            ? "failed"
            : modelMetricCount === EXPECTED_METRICS.length
              ? "completed"
              : modelMetricCount > 0
                ? "partial"
                : modelMetricCompleted
                  ? "partial"
                  : "pending",
      detail: modelMetricRunning
        ? "正在抽取固定五指标"
        : modelMetricRetrying && modelMetricJob
          ? retryWaitingDetail(modelMetricJob)
          : modelMetricFailed?.lastError ||
            (modelMetricCompleted && modelMetricCount === 0
              ? "抽取已完成，未识别到可用模型指标（0/" + EXPECTED_METRICS.length + "）"
              : modelMetricCount + "/" + EXPECTED_METRICS.length + " 项模型值可用"),
    },
    {
      key: "market",
      label: "拉真实值并对比",
      status: !series.companyTicker
        ? "blocked"
        : marketRunning
          ? "running"
          : marketRetrying
            ? "partial"
            : marketFailed || marketStatus === "failed"
              ? "failed"
              : actualMetricCount === EXPECTED_METRICS.length
                ? "completed"
                : actualMetricCount > 0 || marketStatus === "partial"
                  ? "partial"
                  : marketStatus === "pending"
                    ? "pending"
                    : "partial",
      detail: !series.companyTicker
        ? "缺 ticker，等待补充"
        : marketRunning
          ? "免费组合数据源拉取中"
          : marketRetrying && marketJob
            ? retryWaitingDetail(marketJob)
            : marketFailed?.lastError ||
              actualMetricCount + "/" + EXPECTED_METRICS.length + " 项真实值可用",
    },
    {
      key: "impact",
      label: "生成影响卡片",
      status: contextRunning
        ? "running"
        : contextRetrying
          ? "partial"
          : contextFailed || impactStatus === "failed"
            ? "failed"
            : impactStatus === "completed" && impactCount > 0
              ? "completed"
              : impactStatus === "partial" || impactCount > 0
                ? "partial"
                : "pending",
      detail: contextRunning
        ? "正在汇总研究资料、会议纪要和财务资料"
        : contextRetrying && contextJob
          ? retryWaitingDetail(contextJob)
          : contextFailed?.lastError ||
            (impactCount ? impactCount + " 张影响卡片" : "等待辅助资料分析"),
    },
  ];
}

function ValuationProcessingStages({ stages }: { stages: ValuationStage[] }) {
  return (
    <div className="grid gap-2 md:grid-cols-4" aria-label="估值自动处理进度">
      {stages.map((stage, index) => {
        const style = STAGE_STYLE[stage.status];
        return (
          <div
            className={cn("rounded-lg border bg-[var(--pf-panel-raised)] p-3", style.className)}
            key={stage.key}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase text-[var(--pf-ink-muted)]">
                阶段 {index + 1}
              </span>
              <span className="rounded-full border border-current px-2 py-0.5 text-[10px] font-semibold">
                {style.label}
              </span>
            </div>
            <div className="mt-2 text-xs font-semibold text-[var(--pf-ink)]">{stage.label}</div>
            <div className="mt-1 min-h-8 text-[10px] leading-4 text-[var(--pf-ink-muted)]">
              {stage.detail}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ValuationIdentityEditor({
  datasetId,
  series,
}: {
  datasetId: string;
  series: PrivateFundValuationTrackingOverview["series"][number];
}) {
  const queryClient = useQueryClient();
  const [companyName, setCompanyName] = useState(series.companyName ?? "");
  const [companyTicker, setCompanyTicker] = useState(series.companyTicker ?? "");
  const [candidates, setCandidates] = useState<PrivateFundValuationSecurityCandidate[]>([]);
  const [isCandidateOpen, setIsCandidateOpen] = useState(false);
  const [isIdentityDirty, setIsIdentityDirty] = useState(false);
  const searchGeneration = useRef(0);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setCompanyName(series.companyName ?? "");
    setCompanyTicker(series.companyTicker ?? "");
    setCandidates([]);
    setIsCandidateOpen(false);
    setIsIdentityDirty(false);
    searchGeneration.current += 1;
    setMessage("");
  }, [series.seriesId, series.companyName, series.companyTicker]);

  useEffect(() => {
    const query = companyName.trim() || companyTicker.trim();
    if (!isCandidateOpen || !isIdentityDirty || query.length < 1) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    const generation = ++searchGeneration.current;
    const timer = window.setTimeout(() => {
      searchPrivateFundValuationSecurities(datasetId, query)
        .then((items) => {
          if (!cancelled && generation === searchGeneration.current) setCandidates(items);
        })
        .catch(() => {
          if (!cancelled && generation === searchGeneration.current) setCandidates([]);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [companyName, companyTicker, datasetId, isCandidateOpen, isIdentityDirty]);

  const saveMutation = useMutation({
    mutationFn: () =>
      updatePrivateFundValuationModelIdentity(datasetId, series.seriesId, {
        companyName,
        companyTicker,
        changeSource: "manual_entry",
      }),
    onSuccess: async (result) => {
      const saved = result.series;
      if (saved) {
        setCompanyName(saved.companyName ?? "");
        setCompanyTicker(saved.companyTicker ?? "");
      }
      searchGeneration.current += 1;
      setCandidates([]);
      setIsCandidateOpen(false);
      setIsIdentityDirty(false);
      setMessage("已保存，市场数据刷新已排队");
      await queryClient.invalidateQueries({
        queryKey: ["private-fund-valuation-tracking", datasetId],
      });
    },
    onError: (error: Error) => setMessage(error.message),
  });

  const needsAttention =
    !series.companyTicker ||
    !series.companyName ||
    series.identityStatus !== "validated_directory_match" ||
    series.metricAnalysis.marketData.isStale;
  const pickCandidate = (candidate: PrivateFundValuationSecurityCandidate) => {
    setCompanyName(candidate.companyName);
    setCompanyTicker(candidate.ticker);
    searchGeneration.current += 1;
    setCandidates([]);
    setIsCandidateOpen(false);
    setMessage("");
  };

  const editCompanyName = (value: string) => {
    setCompanyName(value);
    setIsIdentityDirty(true);
    setIsCandidateOpen(Boolean(value.trim() || companyTicker.trim()));
  };

  const editCompanyTicker = (value: string) => {
    setCompanyTicker(value);
    setIsIdentityDirty(true);
    setIsCandidateOpen(Boolean(companyName.trim() || value.trim()));
  };

  return (
    <section
      className={cn(
        "rounded-xl border bg-[var(--pf-panel-raised)] p-4 shadow-sm",
        needsAttention ? "border-amber-300 dark:border-amber-800" : "border-[var(--pf-line)]",
      )}
      aria-labelledby="valuation-identity-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="valuation-identity-title" className="text-xs font-semibold text-[var(--pf-ink)]">
            模型证券身份
          </h2>
          <p className="mt-1 text-[10px] leading-4 text-[var(--pf-ink-muted)]">
            {needsAttention
              ? "请确认公司名称和股票代码，保存后会刷新该模型系列的市场数据。"
              : "名称和代码已通过当前证券目录校验。"}
          </p>
        </div>
        <span className="rounded-full border border-[var(--pf-line)] px-2 py-0.5 text-[9px] font-semibold text-[var(--pf-ink-muted)]">
          {series.identityStatus || "unverified"}
        </span>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_auto]">
        <label className="relative block">
          <span className="mb-1 block text-[9px] font-semibold uppercase text-[var(--pf-ink-muted)]">
            公司名称
          </span>
          <input
            className="h-9 w-full rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel)] px-3 text-xs text-[var(--pf-ink)] outline-none focus:border-[var(--pf-accent)]"
            aria-autocomplete="list"
            aria-expanded={isCandidateOpen && candidates.length > 0}
            onChange={(event) => editCompanyName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                searchGeneration.current += 1;
                setCandidates([]);
                setIsCandidateOpen(false);
              }
            }}
            value={companyName}
          />
          {isCandidateOpen && candidates.length ? (
            <div
              className="absolute z-20 mt-1 max-h-44 w-full overflow-auto rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] p-1 shadow-lg"
              role="listbox"
            >
              {candidates.map((candidate) => (
                <button
                  className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-[10px] text-[var(--pf-ink)] hover:bg-[var(--pf-panel-subtle)]"
                  key={candidate.securityId}
                  onClick={() => pickCandidate(candidate)}
                  type="button"
                >
                  <span>{candidate.label}</span>
                  <span className="text-[var(--pf-ink-muted)]">{candidate.exchange}</span>
                </button>
              ))}
            </div>
          ) : null}
        </label>
        <label className="block">
          <span className="mb-1 block text-[9px] font-semibold uppercase text-[var(--pf-ink-muted)]">
            股票代码
          </span>
          <input
            className="h-9 w-full rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel)] px-3 font-mono text-xs text-[var(--pf-ink)] outline-none focus:border-[var(--pf-accent)]"
            onChange={(event) => editCompanyTicker(event.target.value)}
            value={companyTicker}
          />
        </label>
        <button
          className="mt-4 inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-[var(--pf-accent)] px-3 text-xs font-semibold text-white transition-opacity disabled:opacity-60 md:mt-5"
          disabled={saveMutation.isPending || !companyName.trim() || !companyTicker.trim()}
          onClick={() => saveMutation.mutate()}
          type="button"
        >
          <Check className="size-3.5" />
          {saveMutation.isPending ? "保存中" : "保存"}
        </button>
      </div>
      {message ? (
        <p className="mt-2 text-[10px] leading-4 text-[var(--pf-ink-muted)]">{message}</p>
      ) : null}
    </section>
  );
}
export function PrivateFundValuationTrackingPanel({ datasetId }: { datasetId: string }) {
  const queryClient = useQueryClient();
  const valuationQuery = usePrivateFundValuationTracking(datasetId);
  const [selectedSeriesId, setSelectedSeriesId] = useState("");
  const [selectedPeriod, setSelectedPeriod] = useState("");
  const selectedSourceDocumentIds = usePrivateFundWorkspaceStore(
    (state) => state.selectedSourceDocumentIdsByDataset[datasetId] ?? EMPTY_SELECTED_DOCUMENT_IDS,
  );
  const data = valuationQuery.data;
  const activeSeriesId = selectedSeriesId || data?.series[0]?.seriesId || "";
  const activeSeries = data?.series.find((series) => series.seriesId === activeSeriesId);
  const metricAnalysis = activeSeries?.metricAnalysis;
  const metricTimeline = metricAnalysis?.metricTimeline;
  const preferredPeriod = metricTimeline ? preferredTimelinePeriod(metricTimeline) : "";
  const effectiveSelectedPeriod = metricTimeline?.periods.some(
    (period) => period.period === selectedPeriod,
  )
    ? selectedPeriod
    : preferredPeriod;
  const activeTimelinePeriod = metricTimeline?.periods.find(
    (period) => period.period === effectiveSelectedPeriod,
  );
  const comparisons = QUARTERLY_METRICS.map((key) => {
    const periodMetric = activeTimelinePeriod?.comparisons.find(
      (metric) => metric.metricKey === key,
    );
    const currentMetric = metricAnalysis?.metricComparisons.find(
      (metric) => metric.metricKey === key,
    );
    return periodMetric ?? currentMetric;
  }).filter((metric): metric is PrivateFundValuationMetricComparison => Boolean(metric));
  const marketSnapshot = metricAnalysis?.marketSnapshot;
  const selectedGapAlerts = comparisons.filter((metric) =>
    ["warning", "critical"].includes(metric.severity),
  );
  const refreshRunning = Boolean(
    activeSeries &&
    data?.jobs.some(
      (job) =>
        jobMatchesSeries(job, activeSeries) &&
        ["model_metric_refresh", "market_data_refresh", "valuation_context_refresh"].includes(
          job.jobType,
        ) &&
        isJobActivelyRefreshing(job),
    ),
  );

  useEffect(() => {
    setSelectedPeriod(preferredPeriod);
  }, [activeSeriesId, preferredPeriod]);

  const refreshMutation = useMutation({
    mutationFn: () =>
      runPrivateFundValuationTracking(datasetId, {
        seriesId: activeSeries?.seriesId,
        modelVersionId: activeSeries?.currentModelVersionId ?? undefined,
        ...(selectedSourceDocumentIds.length ? { documentIds: selectedSourceDocumentIds } : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["private-fund-valuation-tracking", datasetId],
      });
    },
  });
  if (valuationQuery.isLoading) return <LoadingState />;
  if (valuationQuery.isError) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
        无法加载估值模型分析：{valuationQuery.error.message}
      </div>
    );
  }
  if (!activeSeries) {
    return (
      <section className="rounded-xl border border-dashed border-[var(--pf-line-strong)] bg-[var(--pf-panel-raised)] p-10 text-center">
        <FileSpreadsheet className="mx-auto size-8 text-[var(--pf-ink-muted)]" />
        <h2 className="mt-3 text-sm font-semibold text-[var(--pf-ink)]">还没有可分析的估值模型</h2>
        <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-[var(--pf-ink-muted)]">
          上传 Excel 估值模型后，系统会自动解析并启动五指标对比。其他文件只会成为辅助分析卡片。
        </p>
      </section>
    );
  }

  const marketData = metricAnalysis?.marketData;
  const processingStages = buildValuationStages(data, activeSeries);
  return (
    <section
      className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-4 [scrollbar-gutter:stable] sm:p-5 lg:p-6"
      aria-labelledby="valuation-five-metrics-title"
    >
      <header className="flex flex-col gap-4 border-b border-[var(--pf-line)] pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--pf-accent)]">
            <Database className="size-3.5" /> Model vs actual
          </div>
          <h1
            id="valuation-five-metrics-title"
            className="mt-2 text-xl font-semibold tracking-tight text-[var(--pf-ink)]"
          >
            估值模型五指标对比
          </h1>
          <p className="mt-1 text-xs text-[var(--pf-ink-muted)]">
            五项核心指标分为季度经营与当前市场快照；仅季度经营偏差触发预警。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data && data.series.length > 1 ? (
            <label className="relative">
              <span className="sr-only">选择估值模型</span>
              <select
                className="h-9 appearance-none rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] pl-3 pr-8 text-xs font-medium text-[var(--pf-ink)] outline-none focus:border-[var(--pf-accent)]"
                onChange={(event) => setSelectedSeriesId(event.target.value)}
                value={activeSeriesId}
              >
                {data.series.map((series) => (
                  <option key={series.seriesId} value={series.seriesId}>
                    {series.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 size-4 text-[var(--pf-ink-muted)]" />
            </label>
          ) : (
            <span className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] px-3 text-xs font-medium text-[var(--pf-ink)]">
              <FileSpreadsheet className="size-3.5" /> {activeSeries.name}
            </span>
          )}
          <button
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--pf-accent)] px-3 text-xs font-semibold text-white transition-opacity disabled:opacity-60"
            disabled={refreshMutation.isPending || refreshRunning}
            onClick={() => refreshMutation.mutate()}
            type="button"
          >
            <RefreshCw
              className={cn(
                "size-3.5",
                (refreshMutation.isPending || refreshRunning) && "animate-spin",
              )}
            />
            {refreshMutation.isPending || refreshRunning ? "刷新中" : "刷新模型与真实数据"}
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] px-3 py-2 text-[10px] text-[var(--pf-ink-muted)]">
        <span className="inline-flex items-center gap-1.5">
          <Clock3 className="size-3" /> 模型 v{activeSeries.currentVersionNo} ·{" "}
          {activeSeries.currentVersion?.originalFilename}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Database className="size-3" />
          {marketData?.provider || "真实数据 API 未配置"} · {formatTime(marketData?.asOf)}
        </span>
      </div>

      <ValuationIdentityEditor datasetId={datasetId} series={activeSeries} />

      <ValuationProcessingStages stages={processingStages} />

      {marketData?.providerAttempts?.length ? (
        <details className="rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] px-3 py-2 text-[10px] text-[var(--pf-ink-muted)]">
          <summary className="cursor-pointer font-semibold text-[var(--pf-ink)]">逐源诊断</summary>
          <div className="mt-2 grid gap-1.5 md:grid-cols-2">
            {marketData.providerAttempts.map((attempt, index) => (
              <div
                className="rounded-md bg-[var(--pf-panel-subtle)] px-2 py-1.5"
                key={`${attempt.provider}-${index}`}
              >
                <span className="font-semibold text-[var(--pf-ink)]">
                  {attempt.provider || "unknown"}
                </span>
                <span> · {attempt.status || "unknown"}</span>
                {attempt.fieldsFound.length ? (
                  <span> · {attempt.fieldsFound.join(", ")}</span>
                ) : null}
                {attempt.errorMessage ? <span> · {attempt.errorMessage}</span> : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {metricTimeline?.periods.length ? (
        <MetricTimeline
          onSelect={setSelectedPeriod}
          selectedPeriod={effectiveSelectedPeriod}
          timeline={metricTimeline}
        />
      ) : null}

      <MarketSnapshotSection snapshot={marketSnapshot} />

      <section
        aria-labelledby="valuation-quarterly-metrics-title"
        className="overflow-hidden rounded-xl border border-[var(--pf-line)] shadow-sm"
      >
        <div className="hidden grid-cols-[minmax(220px,1.35fr)_minmax(140px,0.75fr)_32px_minmax(140px,0.75fr)] items-center bg-[var(--pf-panel-subtle)] px-5 py-2 text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--pf-ink-muted)] lg:grid">
          <span id="valuation-quarterly-metrics-title">
            季度经营指标 · 3项
            {activeTimelinePeriod ? " · " + activeTimelinePeriod.label : ""}
          </span>
          <span>模型值</span>
          <span />
          <span>真实值</span>
        </div>
        {comparisons.length === QUARTERLY_METRICS.length ? (
          comparisons.map((metric) => <ComparisonRow key={metric.metricKey} metric={metric} />)
        ) : (
          <LoadingState />
        )}
      </section>

      {metricAnalysis?.valuationImpacts ? (
        <ValuationImpactSection analysis={metricAnalysis.valuationImpacts} />
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <section
          className="rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)]"
          aria-labelledby="valuation-alerts-title"
        >
          <div className="flex items-center justify-between border-b border-[var(--pf-line)] px-4 py-3">
            <div className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-[var(--pf-accent)]" />
              <h2
                id="valuation-alerts-title"
                className="text-xs font-semibold text-[var(--pf-ink)]"
              >
                所选期间差距预警
              </h2>
            </div>
            <span className="font-mono text-[10px] text-[var(--pf-ink-muted)]">
              {selectedGapAlerts.length}
            </span>
          </div>
          {selectedGapAlerts.length ? (
            <div className="divide-y divide-[var(--pf-line)]">
              {selectedGapAlerts.map((metric) => (
                <article className="p-4" key={metric.metricKey}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold text-[var(--pf-ink)]">{metric.label}</p>
                      <p className="mt-1 text-[10px] leading-4 text-[var(--pf-ink-secondary)]">
                        {metric.label}：{metric.explanation}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[9px] font-semibold",
                        metric.severity === "critical"
                          ? SEVERITY.critical.badge
                          : SEVERITY.warning.badge,
                      )}
                    >
                      {metric.severity === "critical" ? "重大" : "关注"}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="px-5 py-8 text-center">
              <Check className="mx-auto size-5 text-emerald-600" />
              <p className="mt-2 text-xs font-medium text-[var(--pf-ink)]">当前没有指标差距预警</p>
              <p className="mt-1 text-[10px] text-[var(--pf-ink-muted)]">
                缺失数据不会误触发预警。
              </p>
            </div>
          )}
        </section>

        <section
          className="rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)]"
          aria-labelledby="valuation-context-title"
        >
          <div className="flex items-center justify-between border-b border-[var(--pf-line)] px-4 py-3">
            <div className="flex items-center gap-2">
              <FileSearch className="size-4 text-[var(--pf-accent)]" />
              <h2
                id="valuation-context-title"
                className="text-xs font-semibold text-[var(--pf-ink)]"
              >
                辅助分析卡片
              </h2>
            </div>
            <span className="text-[9px] text-[var(--pf-ink-muted)]">不参与指标数值与预警</span>
          </div>
          {metricAnalysis?.contextCards.length ? (
            <div className="grid gap-px bg-[var(--pf-line)] sm:grid-cols-2">
              {metricAnalysis.contextCards.map((card) => (
                <article className="bg-[var(--pf-panel-raised)] p-4" key={card.cardId}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="rounded-full bg-[var(--pf-accent-soft)] px-2 py-0.5 text-[9px] font-semibold text-[var(--pf-accent-ink)]">
                      {card.cardType}
                    </span>
                    <time className="text-[9px] text-[var(--pf-ink-muted)]">
                      {formatTime(card.documentDate)}
                    </time>
                  </div>
                  <h3 className="mt-2 line-clamp-1 text-xs font-semibold text-[var(--pf-ink)]">
                    {card.title}
                  </h3>
                  <p className="mt-1 line-clamp-3 text-[10px] leading-4 text-[var(--pf-ink-secondary)]">
                    {card.summary}
                  </p>
                  <p className="mt-2 border-l-2 border-[var(--pf-accent)] pl-2 text-[9px] leading-4 text-[var(--pf-ink-muted)]">
                    {card.insight}
                  </p>
                </article>
              ))}
            </div>
          ) : (
            <div className="px-5 py-8 text-center text-[10px] leading-5 text-[var(--pf-ink-muted)]">
              上传财报、调研纪要或研究报告后，会在这里形成辅助分析卡片。
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
