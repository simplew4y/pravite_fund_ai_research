import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BellRing,
  Bot,
  Calculator,
  Check,
  Clock3,
  Download,
  FileSpreadsheet,
  FilePlus2,
  GitCompare,
  Link2,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  UploadCloud,
  X,
} from "lucide-react";
import { useState } from "react";

import { usePrivateFundValuationTracking } from "@/hooks/usePrivateFundProjects";
import {
  addPrivateFundValuationDerivedModelToResources,
  comparePrivateFundValuationModelVersions,
  derivePrivateFundValuationModel,
  fetchPrivateFundValuationDerivedModelFile,
  getPrivateFundPipelineJob,
  runPrivateFundValuationAgentAnalysis,
  runPrivateFundValuationTracking,
  updatePrivateFundValuationAlert,
  updatePrivateFundValuationWatchRule,
  type PrivateFundPipelineJob,
  type PrivateFundValuationChange,
  type PrivateFundValuationModelSeries,
} from "@/lib/privateFundApi";
import { triggerBrowserDownload } from "@/hooks/useFileContent";
import { cn } from "@/lib/utils";

const MATERIALITY_LABELS: Record<string, string> = {
  critical: "关键",
  high: "重大",
  medium: "中等",
  low: "轻微",
};

const MATERIALITY_STYLES: Record<string, string> = {
  critical:
    "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
  high: "border-orange-300 bg-orange-50 text-orange-800 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-200",
  medium:
    "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  low: "border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] text-[var(--pf-ink-secondary)]",
};

const CHANGE_TYPE_LABELS: Record<string, string> = {
  added: "新增节点",
  removed: "移除节点",
  value_changed: "数值变化",
  formula_changed: "公式变化",
  value_and_formula_changed: "数值与公式变化",
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

function formatNodeValue(value: Record<string, unknown>): string {
  if (typeof value.value_numeric === "number") {
    const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }).format(
      value.value_numeric,
    );
    return value.unit ? `${number} ${String(value.unit)}` : number;
  }
  if (value.value_text !== null && value.value_text !== undefined && value.value_text !== "") {
    return String(value.value_text);
  }
  return "—";
}

function plainAnalysis(value: string): string {
  return value
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*/g, "")
    .replace(/`([^`]+)`/g, "$1");
}

async function waitForPipelineCompletion(
  job: PrivateFundPipelineJob,
  attempt = 0,
): Promise<PrivateFundPipelineJob> {
  if (!["queued", "running"].includes(job.status)) return job;
  if (attempt >= 400) {
    throw new Error("资源索引等待超时，请稍后在资料页查看处理状态。");
  }
  await new Promise((resolve) => window.setTimeout(resolve, 1500));
  const nextJob = await getPrivateFundPipelineJob(job.jobId);
  return waitForPipelineCompletion(nextJob, attempt + 1);
}

function ModelSelector({
  series,
  selectedSeriesId,
  onSelect,
}: {
  series: PrivateFundValuationModelSeries[];
  selectedSeriesId: string;
  onSelect: (seriesId: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)]">
      {series.map((model, index) => {
        const active = model.seriesId === selectedSeriesId;
        return (
          <button
            className={cn(
              "flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors",
              index > 0 && "border-t border-[var(--pf-line)]",
              active
                ? "bg-[var(--pf-accent-soft)] text-[var(--pf-accent-ink)]"
                : "hover:bg-[var(--pf-panel-subtle)]",
            )}
            key={model.seriesId}
            onClick={() => onSelect(model.seriesId)}
            type="button"
          >
            <FileSpreadsheet className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold">{model.name}</span>
              <span className="mt-1 block text-[10px] opacity-70">
                v{model.currentVersionNo} · {model.versionCount} 个版本 · 更新于{" "}
                {formatTime(model.updatedAt)}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ChangeRow({ change }: { change: PrivateFundValuationChange }) {
  return (
    <article className="grid gap-3 border-t border-[var(--pf-line)] px-4 py-3 first:border-t-0 lg:grid-cols-[minmax(180px,1fr)_minmax(120px,0.6fr)_minmax(130px,0.75fr)_minmax(130px,0.75fr)] lg:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              "rounded-full border px-1.5 py-0.5 text-[9px] font-semibold",
              MATERIALITY_STYLES[change.materiality] ?? MATERIALITY_STYLES.low,
            )}
          >
            {MATERIALITY_LABELS[change.materiality] ?? change.materiality}
          </span>
          <span className="text-[10px] text-[var(--pf-ink-muted)]">
            {CHANGE_TYPE_LABELS[change.changeType] ?? change.changeType}
          </span>
        </div>
        <p className="mt-1.5 truncate text-xs font-semibold text-[var(--pf-ink)]">
          {change.displayName}
        </p>
        <p className="mt-0.5 text-[10px] text-[var(--pf-ink-muted)]">
          {[change.period, change.scenario, change.scope].filter(Boolean).join(" · ") || "模型节点"}
        </p>
      </div>
      <div className="text-[10px] text-[var(--pf-ink-muted)]">
        变化幅度
        <p className="mt-1 text-xs font-medium text-[var(--pf-ink)]">
          {typeof change.relativeChange === "number"
            ? `${(change.relativeChange * 100).toFixed(1)}%`
            : "结构变化"}
        </p>
      </div>
      <div className="rounded-lg bg-[var(--pf-panel-subtle)] px-3 py-2">
        <p className="text-[9px] uppercase tracking-wide text-[var(--pf-ink-muted)]">原版本</p>
        <p className="mt-1 break-all text-xs font-medium text-[var(--pf-ink-secondary)]">
          {formatNodeValue(change.oldValue)}
        </p>
      </div>
      <div className="rounded-lg bg-[var(--pf-accent-soft)] px-3 py-2">
        <p className="text-[9px] uppercase tracking-wide text-[var(--pf-accent-ink)]">新版本</p>
        <p className="mt-1 break-all text-xs font-semibold text-[var(--pf-ink)]">
          {formatNodeValue(change.newValue)}
        </p>
      </div>
    </article>
  );
}

export function PrivateFundValuationTrackingPanel({ datasetId }: { datasetId: string }) {
  const queryClient = useQueryClient();
  const valuationQuery = usePrivateFundValuationTracking(datasetId);
  const [selectedSeriesId, setSelectedSeriesId] = useState("");
  const [fromVersionId, setFromVersionId] = useState("");
  const [toVersionId, setToVersionId] = useState("");
  const [agentFocus, setAgentFocus] = useState("");

  const data = valuationQuery.data;
  const activeSeriesId = selectedSeriesId || data?.series[0]?.seriesId || "";
  const activeSeries = data?.series.find((series) => series.seriesId === activeSeriesId);
  const versions = activeSeries?.versions ?? [];
  const activeToVersionId = versions.some((version) => version.modelVersionId === toVersionId)
    ? toVersionId
    : versions[0]?.modelVersionId || "";
  const activeFromVersionId = versions.some((version) => version.modelVersionId === fromVersionId)
    ? fromVersionId
    : versions[1]?.modelVersionId || versions[0]?.modelVersionId || "";

  const comparisonQuery = useQuery({
    queryKey: [
      "private-fund-valuation-comparison",
      datasetId,
      activeSeriesId,
      activeFromVersionId,
      activeToVersionId,
    ],
    queryFn: () =>
      comparePrivateFundValuationModelVersions(
        datasetId,
        activeSeriesId,
        activeFromVersionId,
        activeToVersionId,
      ),
    enabled: Boolean(
      activeSeriesId &&
      activeFromVersionId &&
      activeToVersionId &&
      activeFromVersionId !== activeToVersionId,
    ),
  });

  const refreshMutation = useMutation({
    mutationFn: () => runPrivateFundValuationTracking(datasetId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["private-fund-valuation-tracking", datasetId],
      });
    },
  });
  const alertMutation = useMutation({
    mutationFn: ({ alertId, status }: { alertId: string; status: "acknowledged" | "dismissed" }) =>
      updatePrivateFundValuationAlert(datasetId, alertId, { status }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["private-fund-valuation-tracking", datasetId],
      });
    },
  });
  const ruleMutation = useMutation({
    mutationFn: ({ ruleId, active }: { ruleId: string; active: boolean }) =>
      updatePrivateFundValuationWatchRule(datasetId, ruleId, { active }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["private-fund-valuation-tracking", datasetId],
      });
    },
  });
  const agentMutation = useMutation({
    mutationFn: () =>
      runPrivateFundValuationAgentAnalysis(datasetId, activeSeriesId, {
        baseModelVersionId: activeToVersionId,
        comparisonModelVersionId:
          activeFromVersionId === activeToVersionId ? "" : activeFromVersionId,
        focus: agentFocus,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["private-fund-valuation-tracking", datasetId],
      });
    },
  });
  const deriveMutation = useMutation({
    mutationFn: (analysisId: string) => derivePrivateFundValuationModel(datasetId, analysisId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["private-fund-valuation-tracking", datasetId],
      });
    },
  });
  const downloadMutation = useMutation({
    mutationFn: async ({
      derivedModelId,
      filename,
    }: {
      derivedModelId: string;
      filename: string;
    }) => ({
      blob: await fetchPrivateFundValuationDerivedModelFile(datasetId, derivedModelId),
      filename,
    }),
    onSuccess: ({ blob, filename }) => triggerBrowserDownload(blob, filename),
  });
  const resourceMutation = useMutation({
    mutationFn: async (derivedModelId: string) => {
      const imported = await addPrivateFundValuationDerivedModelToResources(
        datasetId,
        derivedModelId,
      );
      let job = imported.job;
      if (job) job = await waitForPipelineCompletion(job);
      if (job?.status === "failed") {
        throw new Error(job.message || "派生模型加入资源失败。");
      }
      return { ...imported, job };
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["private-fund-valuation-tracking", datasetId],
        }),
        queryClient.invalidateQueries({ queryKey: ["private-fund-project", datasetId] }),
        queryClient.invalidateQueries({ queryKey: ["private-fund-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["private-fund-assets", datasetId] }),
        queryClient.invalidateQueries({
          queryKey: ["private-fund-source-folders", datasetId],
        }),
      ]);
    },
  });

  if (valuationQuery.isLoading) {
    return (
      <div className="flex min-h-[420px] items-center justify-center gap-2 text-sm text-[var(--pf-ink-secondary)]">
        <Loader2 className="size-4 animate-spin" /> 正在读取估值模型台账…
      </div>
    );
  }
  if (valuationQuery.isError || !data) {
    return (
      <div className="m-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        无法读取估值模型台账：{valuationQuery.error?.message ?? "未知错误"}
      </div>
    );
  }

  const activeJob = data.jobs.find((job) => ["queued", "running"].includes(job.status));
  const visibleAlerts = data.alerts.filter(
    (alert) =>
      alert.status !== "dismissed" && (!activeSeriesId || alert.seriesId === activeSeriesId),
  );
  const currentVersion = activeSeries?.currentVersion;
  const currentAnalysis = currentVersion?.analysis;
  const changes = comparisonQuery.data?.changes ?? [];
  const agentAnalysis =
    data.agentAnalyses.find(
      (analysis) =>
        analysis.seriesId === activeSeriesId && analysis.baseModelVersionId === activeToVersionId,
    ) ?? data.agentAnalyses.find((analysis) => analysis.seriesId === activeSeriesId);
  const derivedModel = data.derivedModels.find(
    (model) => model.analysisId === agentAnalysis?.analysisId,
  );
  const agentJob = data.jobs.find(
    (job) =>
      job.jobType === "agent_analysis" &&
      ["queued", "running"].includes(job.status) &&
      (!agentAnalysis || job.sourceId === agentAnalysis.analysisId),
  );

  return (
    <section aria-label="估值模型跟踪" className="min-h-0 flex-1 overflow-y-auto bg-[var(--pf-bg)]">
      <div className="mx-auto max-w-[1500px] space-y-6 p-5 lg:p-8">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--pf-ink-muted)]">
              Valuation model intelligence
            </p>
            <h1 className="mt-1 text-xl font-semibold text-[var(--pf-ink)]">估值模型变化跟踪</h1>
            <p className="mt-1 text-xs leading-5 text-[var(--pf-ink-secondary)]">
              独立记录模型系列、结构化快照与版本差异；原始 Excel 始终作为不可变证据保留。
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
            {activeJob ? "分析中" : "扫描模型"}
          </button>
        </header>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { label: "模型系列", value: data.series.length, icon: FileSpreadsheet },
            {
              label: "当前版本",
              value: activeSeries ? `v${activeSeries.currentVersionNo}` : "—",
              icon: GitCompare,
            },
            { label: "结构化节点", value: currentVersion?.nodeCount ?? 0, icon: Calculator },
            { label: "未读提醒", value: data.unreadAlertCount, icon: BellRing },
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

        {data.series.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--pf-line-strong)] bg-[var(--pf-panel)] p-10 text-center">
            <FileSpreadsheet className="mx-auto size-7 text-[var(--pf-ink-muted)]" />
            <h2 className="mt-3 text-sm font-semibold text-[var(--pf-ink)]">尚未发现估值模型</h2>
            <p className="mt-1 text-xs leading-5 text-[var(--pf-ink-muted)]">
              上传 Excel 估值模型并运行资料 Pipeline，系统会自动建立独立版本链路。
            </p>
          </div>
        ) : (
          <div className="grid items-start gap-6 xl:grid-cols-[280px_minmax(0,1fr)]">
            <aside className="space-y-5">
              <div>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-[var(--pf-ink)]">模型系列</h2>
                  <span className="text-[10px] text-[var(--pf-ink-muted)]">
                    {data.series.length} 个
                  </span>
                </div>
                <ModelSelector
                  onSelect={(seriesId) => {
                    setSelectedSeriesId(seriesId);
                    setFromVersionId("");
                    setToVersionId("");
                  }}
                  selectedSeriesId={activeSeriesId}
                  series={data.series}
                />
              </div>

              <div>
                <h2 className="mb-3 text-sm font-semibold text-[var(--pf-ink)]">跟踪规则</h2>
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
                        aria-label={`启用估值规则 ${rule.name}`}
                        checked={rule.active}
                        className="size-3.5 accent-[var(--pf-accent)]"
                        disabled={ruleMutation.isPending}
                        onChange={(event) =>
                          ruleMutation.mutate({ ruleId: rule.ruleId, active: event.target.checked })
                        }
                        type="checkbox"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium text-[var(--pf-ink)]">
                          {rule.name}
                        </span>
                        <span className="mt-0.5 block text-[10px] text-[var(--pf-ink-muted)]">
                          重大性 ≥ {MATERIALITY_LABELS[rule.minMateriality] ?? rule.minMateriality}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </aside>

            <div className="min-w-0 space-y-6">
              <section>
                <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <h2 className="text-sm font-semibold text-[var(--pf-ink)]">版本对比</h2>
                    <p className="mt-1 text-[10px] text-[var(--pf-ink-muted)]">
                      {activeSeries?.name} · 节点按指标、期间、场景和业务范围稳定匹配
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="text-[10px] text-[var(--pf-ink-muted)]">
                      原版本
                      <select
                        aria-label="估值原版本"
                        className="ml-1.5 h-8 rounded-md border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] px-2 text-xs text-[var(--pf-ink)]"
                        onChange={(event) => setFromVersionId(event.target.value)}
                        value={activeFromVersionId}
                      >
                        {versions.map((version) => (
                          <option key={version.modelVersionId} value={version.modelVersionId}>
                            v{version.documentVersionNo}
                          </option>
                        ))}
                      </select>
                    </label>
                    <span className="text-[var(--pf-ink-muted)]">→</span>
                    <label className="text-[10px] text-[var(--pf-ink-muted)]">
                      新版本
                      <select
                        aria-label="估值新版本"
                        className="ml-1.5 h-8 rounded-md border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] px-2 text-xs text-[var(--pf-ink)]"
                        onChange={(event) => setToVersionId(event.target.value)}
                        value={activeToVersionId}
                      >
                        {versions.map((version) => (
                          <option key={version.modelVersionId} value={version.modelVersionId}>
                            v{version.documentVersionNo}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>

                <div className="overflow-hidden rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)]">
                  {versions.length < 2 ? (
                    <div className="p-8 text-center text-xs text-[var(--pf-ink-muted)]">
                      当前只有一个基线版本；新模型版本入库后将在这里显示差异。
                    </div>
                  ) : activeFromVersionId === activeToVersionId ? (
                    <div className="p-8 text-center text-xs text-[var(--pf-ink-muted)]">
                      请选择两个不同版本进行对比。
                    </div>
                  ) : comparisonQuery.isLoading ? (
                    <div className="flex min-h-32 items-center justify-center gap-2 text-xs text-[var(--pf-ink-muted)]">
                      <Loader2 className="size-3.5 animate-spin" /> 正在计算结构化差异…
                    </div>
                  ) : comparisonQuery.isError ? (
                    <div className="p-5 text-xs text-red-700">
                      无法读取版本差异：{comparisonQuery.error.message}
                    </div>
                  ) : changes.length ? (
                    changes.map((change) => <ChangeRow change={change} key={change.canonicalKey} />)
                  ) : (
                    <div className="flex min-h-32 items-center justify-center gap-2 text-xs text-[var(--pf-ink-muted)]">
                      <Check className="size-3.5" /> 两个版本的结构化节点没有实质变化。
                    </div>
                  )}
                </div>
              </section>

              <section aria-label="估值 Agent 分析">
                <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <Bot className="size-4 text-[var(--pf-accent)]" />
                      <h2 className="text-sm font-semibold text-[var(--pf-ink)]">Agent 多维分析</h2>
                    </div>
                    <p className="mt-1 text-[10px] leading-4 text-[var(--pf-ink-muted)]">
                      基于模型节点、版本差异和研究资料生成分析、总结、证据链与可审计的调参建议。
                    </p>
                  </div>
                  <button
                    className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-[var(--pf-accent)] px-3 text-xs font-semibold text-white disabled:opacity-50"
                    disabled={
                      !activeSeriesId ||
                      !activeToVersionId ||
                      agentMutation.isPending ||
                      Boolean(agentJob)
                    }
                    onClick={() => agentMutation.mutate()}
                    type="button"
                  >
                    {agentMutation.isPending || agentJob ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Bot className="size-3.5" />
                    )}
                    {agentJob ? "Agent 分析中" : "运行 Agent 分析"}
                  </button>
                </div>

                <div className="overflow-hidden rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)]">
                  <div className="border-b border-[var(--pf-line)] p-4">
                    <label className="text-[10px] font-medium text-[var(--pf-ink-secondary)]">
                      本轮关注点（可选）
                      <textarea
                        aria-label="Agent 分析关注点"
                        className="mt-2 min-h-16 w-full resize-y rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel)] px-3 py-2 text-xs leading-5 text-[var(--pf-ink)] outline-none focus:border-[var(--pf-accent)]"
                        maxLength={2000}
                        onChange={(event) => setAgentFocus(event.target.value)}
                        placeholder="例如：重点分析不同模板下的收入预测、WACC、终值假设和目标价变化"
                        value={agentFocus}
                      />
                    </label>
                    {agentMutation.isError ? (
                      <p className="mt-2 text-[10px] text-red-700">
                        无法启动 Agent 分析：{agentMutation.error.message}
                      </p>
                    ) : null}
                  </div>

                  {!agentAnalysis ? (
                    <div className="p-8 text-center text-xs leading-5 text-[var(--pf-ink-muted)]">
                      选择比较版本后运行
                      Agent。系统会先选择证据，再生成可追溯结论；不会直接修改原模型。
                    </div>
                  ) : ["pending", "running"].includes(agentAnalysis.status) || agentJob ? (
                    <div className="flex min-h-32 items-center justify-center gap-2 text-xs text-[var(--pf-ink-muted)]">
                      <Loader2 className="size-3.5 animate-spin" /> Agent 正在组织证据并分析模型…
                    </div>
                  ) : agentAnalysis.status === "failed" ? (
                    <div className="p-5 text-xs text-red-700">
                      Agent 分析失败：{agentAnalysis.errorMessage || "未知错误"}
                    </div>
                  ) : (
                    <div className="space-y-5 p-4 lg:p-5">
                      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(260px,0.6fr)]">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full bg-[var(--pf-accent-soft)] px-2 py-1 text-[9px] font-semibold text-[var(--pf-accent-ink)]">
                              {agentAnalysis.valuationMethod || "估值方法待识别"}
                            </span>
                            <span className="text-[9px] text-[var(--pf-ink-muted)]">
                              {agentAnalysis.modelName || agentAnalysis.agentVersion} ·{" "}
                              {agentAnalysis.evidenceIds.length} 条引用证据
                            </span>
                          </div>
                          <h3 className="mt-3 text-xs font-semibold text-[var(--pf-ink)]">
                            分析总结
                          </h3>
                          <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-[var(--pf-ink-secondary)]">
                            {agentAnalysis.executiveSummary}
                          </p>
                          {agentAnalysis.investmentConclusion ? (
                            <div className="mt-3 rounded-lg bg-[var(--pf-accent-soft)] px-3 py-2.5">
                              <p className="text-[9px] font-semibold uppercase tracking-wide text-[var(--pf-accent-ink)]">
                                投资结论
                              </p>
                              <p className="mt-1 text-xs leading-5 text-[var(--pf-ink)]">
                                {agentAnalysis.investmentConclusion}
                              </p>
                            </div>
                          ) : null}
                        </div>
                        <div className="rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] p-3">
                          <div className="flex items-center gap-2">
                            <ShieldCheck className="size-3.5 text-[var(--pf-accent)]" />
                            <h3 className="text-[10px] font-semibold text-[var(--pf-ink)]">
                              一键输出安全边界
                            </h3>
                          </div>
                          <p className="mt-2 text-[10px] leading-4 text-[var(--pf-ink-muted)]">
                            仅高置信度、可唯一定位且非公式的输入单元格会写入副本；公式、低置信度和不可定位建议只进入审计页。
                          </p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {derivedModel ? (
                              <button
                                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--pf-accent)] px-2.5 text-[10px] font-semibold text-white disabled:opacity-50"
                                disabled={downloadMutation.isPending}
                                onClick={() =>
                                  downloadMutation.mutate({
                                    derivedModelId: derivedModel.derivedModelId,
                                    filename: derivedModel.outputFilename,
                                  })
                                }
                                type="button"
                              >
                                {downloadMutation.isPending ? (
                                  <Loader2 className="size-3 animate-spin" />
                                ) : (
                                  <Download className="size-3" />
                                )}
                                下载 v{derivedModel.derivedVersionNo}
                              </button>
                            ) : (
                              <button
                                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--pf-accent)] px-2.5 text-[10px] font-semibold text-white disabled:opacity-50"
                                disabled={deriveMutation.isPending}
                                onClick={() => deriveMutation.mutate(agentAnalysis.analysisId)}
                                type="button"
                              >
                                {deriveMutation.isPending ? (
                                  <Loader2 className="size-3 animate-spin" />
                                ) : (
                                  <FilePlus2 className="size-3" />
                                )}
                                生成新模型版本
                              </button>
                            )}
                            {derivedModel ? (
                              <button
                                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--pf-line-strong)] bg-[var(--pf-panel-raised)] px-2.5 text-[10px] font-semibold text-[var(--pf-ink)] disabled:opacity-60"
                                disabled={
                                  resourceMutation.isPending ||
                                  ["queued", "running", "completed"].includes(
                                    derivedModel.resourceStatus,
                                  )
                                }
                                onClick={() =>
                                  resourceMutation.mutate(derivedModel.derivedModelId)
                                }
                                type="button"
                              >
                                {resourceMutation.isPending ||
                                ["queued", "running"].includes(
                                  derivedModel.resourceStatus,
                                ) ? (
                                  <Loader2 className="size-3 animate-spin" />
                                ) : derivedModel.resourceStatus === "completed" ? (
                                  <Check className="size-3 text-emerald-600" />
                                ) : (
                                  <UploadCloud className="size-3" />
                                )}
                                {resourceMutation.isPending ||
                                ["queued", "running"].includes(
                                  derivedModel.resourceStatus,
                                )
                                  ? "正在加入资源"
                                  : derivedModel.resourceStatus === "completed"
                                    ? "已加入资源"
                                    : "一键加入资源"}
                              </button>
                            ) : null}
                            {derivedModel ? (
                              <span className="self-center text-[9px] text-[var(--pf-ink-muted)]">
                                写入 {derivedModel.appliedChanges.length} 项 · 跳过{" "}
                                {derivedModel.skippedChanges.length} 项
                              </span>
                            ) : null}
                          </div>
                          {derivedModel?.resourceStatus === "completed" ? (
                            <p className="mt-2 text-[9px] text-emerald-700 dark:text-emerald-300">
                              已作为 {derivedModel.resourceFileName || "估值模型"}
                              的新版本加入当前项目资源。
                            </p>
                          ) : null}
                          {deriveMutation.isError ||
                          downloadMutation.isError ||
                          resourceMutation.isError ||
                          derivedModel?.resourceStatus === "failed" ? (
                            <p className="mt-2 text-[9px] text-red-700">
                              {deriveMutation.error?.message ||
                                downloadMutation.error?.message ||
                                resourceMutation.error?.message ||
                                derivedModel?.resourceError}
                            </p>
                          ) : null}
                        </div>
                      </div>

                      {agentAnalysis.keyFindings.length ? (
                        <div>
                          <h3 className="mb-2 text-xs font-semibold text-[var(--pf-ink)]">
                            关键发现
                          </h3>
                          <div className="grid gap-2 lg:grid-cols-2">
                            {agentAnalysis.keyFindings.map((finding) => (
                              <article
                                className="rounded-lg border border-[var(--pf-line)] p-3"
                                key={[finding.title, ...finding.evidenceIds].join("|")}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <p className="text-xs font-semibold text-[var(--pf-ink)]">
                                    {finding.title}
                                  </p>
                                  <span className="shrink-0 text-[9px] text-[var(--pf-ink-muted)]">
                                    置信度 {(finding.confidence * 100).toFixed(0)}%
                                  </span>
                                </div>
                                <p className="mt-1 text-[10px] leading-4 text-[var(--pf-ink-secondary)]">
                                  {finding.detail}
                                </p>
                              </article>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {agentAnalysis.evidenceChain.length ? (
                        <div>
                          <div className="mb-2 flex items-center gap-2">
                            <Link2 className="size-3.5 text-[var(--pf-accent)]" />
                            <h3 className="text-xs font-semibold text-[var(--pf-ink)]">证据链</h3>
                          </div>
                          <div className="space-y-2">
                            {agentAnalysis.evidenceChain.map((chain) => (
                              <article
                                className="rounded-lg bg-[var(--pf-panel-subtle)] px-3 py-2.5"
                                key={[chain.title, ...chain.evidenceIds].join("|")}
                              >
                                <p className="text-xs font-semibold text-[var(--pf-ink)]">
                                  {chain.title}
                                </p>
                                <p className="mt-1 text-[10px] leading-4 text-[var(--pf-ink-secondary)]">
                                  {chain.detail}
                                </p>
                                <div className="mt-2 flex flex-wrap gap-1">
                                  {chain.evidenceIds.map((evidenceId) => (
                                    <span
                                      className="rounded bg-[var(--pf-panel-raised)] px-1.5 py-0.5 font-mono text-[8px] text-[var(--pf-ink-muted)]"
                                      key={evidenceId}
                                    >
                                      {evidenceId}
                                    </span>
                                  ))}
                                </div>
                              </article>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {agentAnalysis.recommendedChanges.length ? (
                        <div>
                          <h3 className="mb-2 text-xs font-semibold text-[var(--pf-ink)]">
                            建议变更
                          </h3>
                          <div className="overflow-hidden rounded-lg border border-[var(--pf-line)]">
                            {agentAnalysis.recommendedChanges.map((change, index) => (
                              <article
                                className={cn(
                                  "grid gap-2 px-3 py-3 lg:grid-cols-[minmax(160px,0.7fr)_minmax(160px,0.5fr)_minmax(0,1fr)]",
                                  index > 0 && "border-t border-[var(--pf-line)]",
                                )}
                                key={change.nodeId}
                              >
                                <div>
                                  <p className="text-xs font-semibold text-[var(--pf-ink)]">
                                    {change.displayName}
                                  </p>
                                  <p className="mt-1 font-mono text-[9px] text-[var(--pf-ink-muted)]">
                                    {change.sheetName}!{change.cellRef}
                                  </p>
                                </div>
                                <div className="text-[10px] text-[var(--pf-ink-secondary)]">
                                  {change.currentValueNumeric ?? change.currentValueText ?? "—"} →{" "}
                                  <span className="font-semibold text-[var(--pf-ink)]">
                                    {change.proposedValueNumeric ??
                                      change.proposedValueText ??
                                      "待人工确定"}
                                  </span>
                                  <span
                                    className={cn(
                                      "mt-1 block w-fit rounded-full px-1.5 py-0.5 text-[8px] font-semibold",
                                      change.writable &&
                                        !derivedModel?.skippedChanges.some(
                                          (item) =>
                                            String(item.node_id ?? item.nodeId ?? "") ===
                                            change.nodeId,
                                        )
                                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                                        : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
                                    )}
                                  >
                                    {derivedModel?.skippedChanges.some(
                                      (item) =>
                                        String(item.node_id ?? item.nodeId ?? "") === change.nodeId,
                                    )
                                      ? "派生时已跳过"
                                      : change.writable
                                        ? "可受控写入"
                                        : "仅供人工复核"}
                                  </span>
                                </div>
                                <p className="text-[10px] leading-4 text-[var(--pf-ink-secondary)]">
                                  {change.rationale}
                                </p>
                              </article>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              </section>

              <div className="grid items-start gap-6 lg:grid-cols-2">
                <section>
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-[var(--pf-ink)]">当前分析</h2>
                    {currentVersion?.revertedToVersionId ? (
                      <span className="inline-flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-300">
                        <RotateCcw className="size-3" /> 检测到历史版本回滚
                      </span>
                    ) : null}
                  </div>
                  <div className="rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] p-4">
                    {currentAnalysis ? (
                      <>
                        <p className="whitespace-pre-wrap text-xs leading-5 text-[var(--pf-ink-secondary)]">
                          {plainAnalysis(currentAnalysis.summaryMarkdown)}
                        </p>
                        <p className="mt-3 border-t border-[var(--pf-line)] pt-2 text-[10px] text-[var(--pf-ink-muted)]">
                          {currentAnalysis.analyzerVersion} ·{" "}
                          {formatTime(currentAnalysis.createdAt)}
                        </p>
                      </>
                    ) : (
                      <p className="text-xs text-[var(--pf-ink-muted)]">
                        等待 Worker 完成当前模型分析。
                      </p>
                    )}
                  </div>
                </section>

                <section>
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-[var(--pf-ink)]">变化提醒</h2>
                    <span className="text-[10px] text-[var(--pf-ink-muted)]">
                      当前模型 {visibleAlerts.filter((alert) => alert.status === "new").length}{" "}
                      条未读
                    </span>
                  </div>
                  {visibleAlerts.length ? (
                    <div className="space-y-2.5">
                      {visibleAlerts.slice(0, 10).map((alert) => (
                        <article
                          className={cn(
                            "rounded-xl border p-4",
                            MATERIALITY_STYLES[alert.priority] ?? MATERIALITY_STYLES.low,
                            alert.status !== "new" && "opacity-60",
                          )}
                          key={alert.alertId}
                        >
                          <div className="flex items-start gap-3">
                            <BellRing className="mt-0.5 size-4 shrink-0" />
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-semibold">{alert.title}</p>
                              <p className="mt-1 text-[11px] leading-4">{alert.summary}</p>
                              <p className="mt-2 flex items-center gap-1 text-[9px] opacity-65">
                                <Clock3 className="size-2.5" /> {formatTime(alert.createdAt)} ·{" "}
                                {alert.evidenceIds.length} 条证据
                              </p>
                            </div>
                            {alert.status === "new" ? (
                              <div className="flex shrink-0 gap-1">
                                <button
                                  aria-label={`确认估值提醒 ${alert.title}`}
                                  className="flex size-7 items-center justify-center rounded-md border border-current/20"
                                  disabled={alertMutation.isPending}
                                  onClick={() =>
                                    alertMutation.mutate({
                                      alertId: alert.alertId,
                                      status: "acknowledged",
                                    })
                                  }
                                  type="button"
                                >
                                  <Check className="size-3" />
                                </button>
                                <button
                                  aria-label={`忽略估值提醒 ${alert.title}`}
                                  className="flex size-7 items-center justify-center rounded-md border border-current/20"
                                  disabled={alertMutation.isPending}
                                  onClick={() =>
                                    alertMutation.mutate({
                                      alertId: alert.alertId,
                                      status: "dismissed",
                                    })
                                  }
                                  type="button"
                                >
                                  <X className="size-3" />
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-[var(--pf-line)] p-5 text-xs text-[var(--pf-ink-muted)]">
                      当前模型没有待处理的重大变化提醒。
                    </div>
                  )}
                </section>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
