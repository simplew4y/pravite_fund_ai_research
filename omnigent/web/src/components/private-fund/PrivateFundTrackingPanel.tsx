import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BellRing,
  Check,
  Clock3,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";

import { usePrivateFundTracking } from "@/hooks/usePrivateFundProjects";
import {
  runPrivateFundTracking,
  updatePrivateFundAlert,
  updatePrivateFundWatchRule,
  type PrivateFundResearchAlert,
  type PrivateFundResearchItem,
} from "@/lib/privateFundApi";
import { cn } from "@/lib/utils";

const ITEM_LABELS: Record<string, string> = {
  risk: "风险",
  catalyst: "催化剂",
  assumption: "模型假设",
  thesis: "投资观点",
  metric: "关键指标",
  question: "待验证问题",
};

const STATE_LABELS: Record<string, string> = {
  identified: "已识别",
  watching: "持续观察",
  triggered: "已触发",
  materialized: "已兑现",
  resolved: "已化解",
  expected: "预期中",
  achieved: "已达成",
  missed: "未达预期",
  active: "有效",
  revised: "已修订",
};

const PRIORITY_STYLES: Record<string, string> = {
  critical:
    "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
  high: "border-orange-300 bg-orange-50 text-orange-800 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-200",
  medium:
    "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  low: "border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] text-[var(--pf-ink-secondary)]",
};

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

function ItemCard({ item }: { item: PrivateFundResearchItem }) {
  const current = item.currentVersion;
  return (
    <article className="rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-[var(--pf-accent-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--pf-accent-ink)]">
              {ITEM_LABELS[item.itemType] ?? item.itemType}
            </span>
            <span className="text-[10px] text-[var(--pf-ink-muted)]">v{item.currentVersionNo}</span>
            {current?.state ? (
              <span className="text-[10px] text-[var(--pf-ink-muted)]">
                {STATE_LABELS[current.state] ?? current.state}
              </span>
            ) : null}
          </div>
          <h3 className="mt-2 text-sm font-semibold text-[var(--pf-ink)]">{item.title}</h3>
          <p className="mt-1.5 line-clamp-3 text-xs leading-5 text-[var(--pf-ink-secondary)]">
            {current?.content || "等待追踪任务补充当前状态。"}
          </p>
        </div>
        <div className="shrink-0 text-right text-[10px] text-[var(--pf-ink-muted)]">
          <p>{current?.impact ? `影响 ${current.impact}` : ""}</p>
          <p className="mt-1">{formatTime(current?.observedAt ?? item.lastSeenAt)}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-3 border-t border-[var(--pf-line)] pt-2.5 text-[10px] text-[var(--pf-ink-muted)]">
        <span>证据 {current?.evidenceIds.length ?? 0} 条</span>
        {current?.expectedStart ? <span>窗口 {current.expectedStart}</span> : null}
        {current?.probability ? <span>概率 {current.probability}</span> : null}
        {current?.confidence ? <span>置信度 {Math.round(current.confidence * 100)}%</span> : null}
      </div>
    </article>
  );
}

function AlertCard({
  alert,
  pending,
  onUpdate,
}: {
  alert: PrivateFundResearchAlert;
  pending: boolean;
  onUpdate: (status: "acknowledged" | "dismissed") => void;
}) {
  return (
    <article
      className={cn(
        "rounded-xl border p-4",
        PRIORITY_STYLES[alert.priority] ?? PRIORITY_STYLES.low,
        alert.status !== "new" && "opacity-65",
      )}
    >
      <div className="flex items-start gap-3">
        <BellRing className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{alert.title}</h3>
            <span className="rounded-full border border-current/20 px-1.5 py-0.5 text-[9px] uppercase">
              {alert.priority}
            </span>
          </div>
          <p className="mt-1.5 text-xs leading-5">{alert.summary}</p>
          {alert.whyItMatters ? (
            <p className="mt-2 text-[11px] leading-4 opacity-80">
              为什么重要：{alert.whyItMatters}
            </p>
          ) : null}
          <p className="mt-2 text-[10px] opacity-65">
            {formatTime(alert.createdAt)} · {alert.evidenceIds.length} 条证据
          </p>
        </div>
        {alert.status === "new" ? (
          <div className="flex shrink-0 items-center gap-1">
            <button
              aria-label={`确认提醒 ${alert.title}`}
              className="flex size-7 items-center justify-center rounded-md border border-current/20 hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/5"
              disabled={pending}
              onClick={() => onUpdate("acknowledged")}
              title="确认已阅"
              type="button"
            >
              {pending ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
            </button>
            <button
              aria-label={`忽略提醒 ${alert.title}`}
              className="flex size-7 items-center justify-center rounded-md border border-current/20 hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/5"
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

export function PrivateFundTrackingPanel({ datasetId }: { datasetId: string }) {
  const queryClient = useQueryClient();
  const trackingQuery = usePrivateFundTracking(datasetId);
  const refreshMutation = useMutation({
    mutationFn: () => runPrivateFundTracking(datasetId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["private-fund-tracking", datasetId] });
    },
  });
  const alertMutation = useMutation({
    mutationFn: ({ alertId, status }: { alertId: string; status: "acknowledged" | "dismissed" }) =>
      updatePrivateFundAlert(datasetId, alertId, { status }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["private-fund-tracking", datasetId] });
    },
  });
  const ruleMutation = useMutation({
    mutationFn: ({ ruleId, active }: { ruleId: string; active: boolean }) =>
      updatePrivateFundWatchRule(datasetId, ruleId, { active }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["private-fund-tracking", datasetId] });
    },
  });

  if (trackingQuery.isLoading) {
    return (
      <div className="flex min-h-[420px] items-center justify-center gap-2 text-sm text-[var(--pf-ink-secondary)]">
        <Loader2 className="size-4 animate-spin" /> 正在读取追踪台账…
      </div>
    );
  }
  if (trackingQuery.isError || !trackingQuery.data) {
    return (
      <div className="m-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        无法读取追踪台账：{trackingQuery.error?.message ?? "未知错误"}
      </div>
    );
  }

  const data = trackingQuery.data;
  const activeJob = data.jobs.find((job) => ["queued", "running"].includes(job.status));
  const alerts = data.alerts.filter((alert) => alert.status !== "dismissed");
  const trackedItems = data.items.filter((item) => ["risk", "catalyst"].includes(item.itemType));

  return (
    <section
      aria-label="风险与催化剂追踪"
      className="min-h-0 flex-1 overflow-y-auto bg-[var(--pf-bg)]"
    >
      <div className="mx-auto max-w-7xl space-y-6 p-5 lg:p-8">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--pf-ink-muted)]">
              Continuous monitoring
            </p>
            <h1 className="mt-1 text-xl font-semibold text-[var(--pf-ink)]">风险与催化剂追踪</h1>
            <p className="mt-1 text-xs leading-5 text-[var(--pf-ink-secondary)]">
              新资料入库后自动解析；小时级扫描负责到期窗口和漏处理任务。
            </p>
          </div>
          <button
            className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-[var(--pf-accent)] px-3 text-xs font-semibold text-white disabled:opacity-50"
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

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { label: "风险事项", value: data.counts.risk ?? 0, icon: ShieldAlert },
            { label: "催化剂", value: data.counts.catalyst ?? 0, icon: Sparkles },
            { label: "未读提醒", value: data.unreadAlertCount, icon: BellRing },
            {
              label: "最新任务",
              value: activeJob ? "运行中" : (data.jobs[0]?.status ?? "待命"),
              icon: Clock3,
            },
          ].map((stat) => (
            <article
              className="rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] p-4"
              key={stat.label}
            >
              <div className="flex items-center justify-between text-[var(--pf-ink-muted)]">
                <span className="text-[10px] font-semibold uppercase tracking-wide">
                  {stat.label}
                </span>
                <stat.icon className="size-3.5" />
              </div>
              <p className="mt-3 text-2xl font-semibold text-[var(--pf-ink)]">{stat.value}</p>
            </article>
          ))}
        </div>

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)]">
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[var(--pf-ink)]">当前追踪事项</h2>
              <span className="text-[10px] text-[var(--pf-ink-muted)]">
                {trackedItems.length} 项
              </span>
            </div>
            {trackedItems.length ? (
              <div className="grid gap-3 lg:grid-cols-2">
                {trackedItems.map((item) => (
                  <ItemCard item={item} key={item.itemId} />
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-[var(--pf-line-strong)] bg-[var(--pf-panel)] p-8 text-center text-xs leading-5 text-[var(--pf-ink-muted)]">
                还没有识别到风险或催化剂。上传并运行资料 Pipeline
                后会自动建立台账，也可以点击“立即更新”。
              </div>
            )}
          </div>

          <div className="space-y-6">
            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-[var(--pf-ink)]">提醒</h2>
                <span className="text-[10px] text-[var(--pf-ink-muted)]">
                  未读 {data.unreadAlertCount}
                </span>
              </div>
              {alerts.length ? (
                <div className="space-y-2.5">
                  {alerts.slice(0, 12).map((alert) => (
                    <AlertCard
                      alert={alert}
                      key={alert.alertId}
                      onUpdate={(status) =>
                        alertMutation.mutate({ alertId: alert.alertId, status })
                      }
                      pending={
                        alertMutation.isPending &&
                        alertMutation.variables?.alertId === alert.alertId
                      }
                    />
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-[var(--pf-line)] p-5 text-xs text-[var(--pf-ink-muted)]">
                  当前没有待处理提醒。
                </div>
              )}
            </div>

            <div>
              <h2 className="mb-3 text-sm font-semibold text-[var(--pf-ink)]">追踪规则</h2>
              <div className="overflow-hidden rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)]">
                {data.watchRules.map((rule, index) => (
                  <label
                    className={cn(
                      "flex cursor-pointer items-center gap-3 px-4 py-3",
                      index > 0 && "border-t border-[var(--pf-line)]",
                    )}
                    key={rule.ruleId}
                  >
                    <input
                      aria-label={`启用追踪规则 ${rule.name}`}
                      checked={rule.active}
                      className="size-3.5 accent-[var(--pf-accent)]"
                      disabled={ruleMutation.isPending}
                      onChange={(event) =>
                        ruleMutation.mutate({ ruleId: rule.ruleId, active: event.target.checked })
                      }
                      type="checkbox"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-[var(--pf-ink)]">
                        {rule.name}
                      </span>
                      <span className="mt-0.5 block text-[10px] text-[var(--pf-ink-muted)]">
                        {ITEM_LABELS[rule.targetType] ?? rule.targetType} · {rule.frequency} · ≥{" "}
                        {rule.minPriority}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
