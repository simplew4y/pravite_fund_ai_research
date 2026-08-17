import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  ArrowRight,
  Columns2,
  GitCompareArrows,
  History,
  Loader2,
  Quote,
  Rows2,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import { usePrivateFundTracking } from "@/hooks/usePrivateFundProjects";
import {
  comparePrivateFundMemoVersions,
  getPrivateFundResearchItemTimeline,
  type PrivateFundMemoVersion,
} from "@/lib/privateFundApi";
import { cn } from "@/lib/utils";

const PrivateFundMemoDiffViewer = lazy(() =>
  import("./PrivateFundMemoDiffViewer").then((module) => ({
    default: module.PrivateFundMemoDiffViewer,
  })),
);

const ITEM_LABELS: Record<string, string> = {
  thesis: "投资观点",
  assumption: "模型假设",
  metric: "关键指标",
};

const CHANGE_LABELS: Record<string, string> = {
  added: "新增",
  changed: "已变化",
  unchanged: "未变化",
  not_mentioned: "新版未提及",
};

function versionLabel(version: PrivateFundMemoVersion): string {
  return `v${version.versionNo} · ${version.asOfDate || version.createdAt.slice(0, 10)}`;
}

function compact(value: string, limit = 560): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function memoVersionMarkdown(version: PrivateFundMemoVersion): string {
  const sections = version.sections.map((section) => {
    const body = section.content.trim();
    return `## ${section.title}\n\n${body || "_无内容_"}`;
  });
  return (sections.join("\n\n").trimEnd() || "_无章节内容_") + "\n";
}

export function PrivateFundHistoryPanel({
  datasetId,
  initialSeriesId,
}: {
  datasetId: string;
  initialSeriesId?: string;
}) {
  const trackingQuery = usePrivateFundTracking(datasetId);
  const [seriesId, setSeriesId] = useState("");
  const [fromVersionId, setFromVersionId] = useState("");
  const [toVersionId, setToVersionId] = useState("");
  const [selectedItemId, setSelectedItemId] = useState("");
  const [diffLayout, setDiffLayout] = useState<"unified" | "split">("split");
  const [hideWhitespace, setHideWhitespace] = useState(true);

  const data = trackingQuery.data;
  const versions = useMemo(
    () =>
      (data?.memoVersions ?? [])
        .filter((version) => !seriesId || version.seriesId === seriesId)
        .sort((left, right) => left.versionNo - right.versionNo),
    [data?.memoVersions, seriesId],
  );
  const historicalItems = useMemo(
    () =>
      (data?.items ?? []).filter((item) =>
        ["thesis", "assumption", "metric"].includes(item.itemType),
      ),
    [data?.items],
  );

  useEffect(() => {
    if (!data?.memoSeries.length) return;
    setSeriesId((current) => {
      if (
        initialSeriesId &&
        data.memoSeries.some((series) => series.seriesId === initialSeriesId)
      ) {
        return initialSeriesId;
      }
      if (current && data.memoSeries.some((series) => series.seriesId === current)) {
        return current;
      }
      return data.memoSeries[0].seriesId;
    });
  }, [data?.memoSeries, initialSeriesId]);

  useEffect(() => {
    if (!versions.length) {
      setFromVersionId("");
      setToVersionId("");
      return;
    }
    const latest = versions.at(-1)!;
    const previous = versions.at(-2) ?? latest;
    setFromVersionId(previous.memoVersionId);
    setToVersionId(latest.memoVersionId);
  }, [seriesId, versions]);

  useEffect(() => {
    if (!selectedItemId && historicalItems[0]) setSelectedItemId(historicalItems[0].itemId);
  }, [historicalItems, selectedItemId]);

  const comparisonQuery = useQuery({
    queryKey: ["private-fund-memo-comparison", datasetId, fromVersionId, toVersionId],
    queryFn: () => comparePrivateFundMemoVersions(datasetId, fromVersionId, toVersionId),
    enabled: Boolean(fromVersionId && toVersionId && fromVersionId !== toVersionId),
  });
  const timelineQuery = useQuery({
    queryKey: ["private-fund-research-item-timeline", datasetId, selectedItemId],
    queryFn: () => getPrivateFundResearchItemTimeline(datasetId, selectedItemId),
    enabled: Boolean(selectedItemId),
  });

  const comparisonSummary = useMemo(() => {
    const comparison = comparisonQuery.data;
    if (!comparison) return null;
    const counts = { added: 0, changed: 0, not_mentioned: 0, unchanged: 0 };
    for (const change of comparison.sectionChanges) {
      if (change.changeType in counts) {
        counts[change.changeType as keyof typeof counts] += 1;
      }
    }
    const oldEvidence = new Set(
      comparison.sectionChanges.flatMap((change) => change.oldEvidenceIds),
    );
    const newEvidence = new Set(
      comparison.sectionChanges.flatMap((change) => change.newEvidenceIds),
    );
    return {
      counts,
      evidenceAdded: [...newEvidence].filter((id) => !oldEvidence.has(id)).length,
      evidenceRemoved: [...oldEvidence].filter((id) => !newEvidence.has(id)).length,
      needsReview: comparison.toVersion.sections.filter((section) => section.needsReview).length,
      before: memoVersionMarkdown(comparison.fromVersion),
      after: memoVersionMarkdown(comparison.toVersion),
    };
  }, [comparisonQuery.data]);

  if (trackingQuery.isLoading) {
    return (
      <div className="flex min-h-[420px] items-center justify-center gap-2 text-sm text-[var(--pf-ink-secondary)]">
        <Loader2 className="size-4 animate-spin" /> 正在读取历史版本…
      </div>
    );
  }
  if (trackingQuery.isError || !data) {
    return (
      <div className="m-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        无法读取历史版本：{trackingQuery.error?.message ?? "未知错误"}
      </div>
    );
  }

  return (
    <section
      aria-label="历史观点与 Memo 对比"
      className="min-h-0 flex-1 overflow-y-auto bg-[var(--pf-bg)]"
    >
      <div className="mx-auto max-w-7xl space-y-8 p-5 lg:p-8">
        <header>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--pf-ink-muted)]">
            Research memory
          </p>
          <h1 className="mt-1 text-xl font-semibold text-[var(--pf-ink)]">历史观点与 Memo 对比</h1>
          <p className="mt-1 text-xs leading-5 text-[var(--pf-ink-secondary)]">
            观点与假设按稳定对象延续版本；“新版未提及”不会被误判为观点失效。
          </p>
        </header>

        <div className="space-y-6">
          <div className="space-y-4">
            <div className="flex flex-col gap-3 rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] p-4 lg:flex-row lg:items-end">
              <label className="min-w-0 flex-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--pf-ink-muted)]">
                Memo 系列
                <select
                  aria-label="Memo 系列"
                  className="mt-1.5 h-9 w-full rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel)] px-2.5 text-xs normal-case text-[var(--pf-ink)] outline-none focus:border-[var(--pf-accent)]"
                  onChange={(event) => setSeriesId(event.target.value)}
                  value={seriesId}
                >
                  {data.memoSeries.map((series) => (
                    <option key={series.seriesId} value={series.seriesId}>
                      {series.title} · {series.versionCount} 版
                    </option>
                  ))}
                </select>
              </label>
              <label className="min-w-0 flex-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--pf-ink-muted)]">
                基准版本
                <select
                  aria-label="基准 Memo 版本"
                  className="mt-1.5 h-9 w-full rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel)] px-2.5 text-xs normal-case text-[var(--pf-ink)] outline-none focus:border-[var(--pf-accent)]"
                  onChange={(event) => setFromVersionId(event.target.value)}
                  value={fromVersionId}
                >
                  {versions.map((version) => (
                    <option key={version.memoVersionId} value={version.memoVersionId}>
                      {versionLabel(version)}
                    </option>
                  ))}
                </select>
              </label>
              <ArrowRight className="mb-2 hidden size-4 shrink-0 text-[var(--pf-ink-muted)] lg:block" />
              <label className="min-w-0 flex-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--pf-ink-muted)]">
                对比版本
                <select
                  aria-label="对比 Memo 版本"
                  className="mt-1.5 h-9 w-full rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel)] px-2.5 text-xs normal-case text-[var(--pf-ink)] outline-none focus:border-[var(--pf-accent)]"
                  onChange={(event) => setToVersionId(event.target.value)}
                  value={toVersionId}
                >
                  {versions.map((version) => (
                    <option key={version.memoVersionId} value={version.memoVersionId}>
                      {versionLabel(version)}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {data.memoSeries.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--pf-line-strong)] bg-[var(--pf-panel)] p-8 text-center text-xs leading-5 text-[var(--pf-ink-muted)]">
                还没有 Memo 版本。生成第一份 Memo 后，Markdown、HTML 与 PDF 会合并登记为同一个版本。
              </div>
            ) : versions.length < 2 ? (
              <div className="rounded-xl border border-dashed border-[var(--pf-line-strong)] bg-[var(--pf-panel)] p-8 text-center text-xs leading-5 text-[var(--pf-ink-muted)]">
                当前系列只有一个版本。下一次生成同主题 Memo 时会自动形成 v2 并开放逐章节对比。
              </div>
            ) : fromVersionId === toVersionId ? (
              <div className="rounded-xl border border-dashed border-[var(--pf-line)] p-6 text-center text-xs text-[var(--pf-ink-muted)]">
                请选择两个不同版本进行比较。
              </div>
            ) : comparisonQuery.isLoading ? (
              <div className="flex min-h-48 items-center justify-center gap-2 text-xs text-[var(--pf-ink-secondary)]">
                <Loader2 className="size-4 animate-spin" /> 正在计算版本差异…
              </div>
            ) : comparisonQuery.isError ? (
              <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700">
                对比失败：{comparisonQuery.error.message}
              </div>
            ) : comparisonQuery.data && comparisonSummary ? (
              <div className="overflow-hidden rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)]">
                <div className="flex flex-col gap-3 border-b border-[var(--pf-line)] p-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex flex-wrap items-center gap-2 text-[10px]">
                    <span className="mr-1 flex items-center gap-1.5 text-xs font-semibold text-[var(--pf-ink)]">
                      <GitCompareArrows className="size-4 text-[var(--pf-accent-ink)]" />
                      版本差异
                    </span>
                    {Object.entries(comparisonSummary.counts).map(([type, count]) => (
                      <span
                        className={cn(
                          "rounded-full border px-2 py-1",
                          type === "added" && "border-emerald-200 bg-emerald-50 text-emerald-700",
                          type === "changed" && "border-amber-200 bg-amber-50 text-amber-700",
                          type === "not_mentioned" && "border-slate-200 bg-slate-50 text-slate-600",
                          type === "unchanged" &&
                            "border-[var(--pf-line)] text-[var(--pf-ink-muted)]",
                        )}
                        key={type}
                      >
                        {CHANGE_LABELS[type] ?? type} {count}
                      </span>
                    ))}
                    <span className="text-[var(--pf-ink-muted)]">
                      证据 +{comparisonSummary.evidenceAdded} / -{comparisonSummary.evidenceRemoved}
                    </span>
                    {comparisonSummary.needsReview > 0 ? (
                      <span className="rounded-full border border-red-200 bg-red-50 px-2 py-1 text-red-700">
                        待复核 {comparisonSummary.needsReview}
                      </span>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      aria-label="交换对比版本"
                      className="flex size-8 items-center justify-center rounded-lg border border-[var(--pf-line)] text-[var(--pf-ink-secondary)] hover:bg-[var(--pf-panel-subtle)]"
                      onClick={() => {
                        setFromVersionId(toVersionId);
                        setToVersionId(fromVersionId);
                      }}
                      title="交换对比版本"
                      type="button"
                    >
                      <ArrowLeftRight className="size-3.5" />
                    </button>
                    <div className="flex h-8 overflow-hidden rounded-lg border border-[var(--pf-line)]">
                      <button
                        aria-pressed={diffLayout === "split"}
                        className={cn(
                          "flex items-center gap-1.5 px-2.5 text-[10px]",
                          diffLayout === "split"
                            ? "bg-[var(--pf-accent-soft)] text-[var(--pf-accent-ink)]"
                            : "text-[var(--pf-ink-muted)] hover:bg-[var(--pf-panel-subtle)]",
                        )}
                        onClick={() => setDiffLayout("split")}
                        type="button"
                      >
                        <Columns2 className="size-3" /> 并排
                      </button>
                      <button
                        aria-pressed={diffLayout === "unified"}
                        className={cn(
                          "flex items-center gap-1.5 border-l border-[var(--pf-line)] px-2.5 text-[10px]",
                          diffLayout === "unified"
                            ? "bg-[var(--pf-accent-soft)] text-[var(--pf-accent-ink)]"
                            : "text-[var(--pf-ink-muted)] hover:bg-[var(--pf-panel-subtle)]",
                        )}
                        onClick={() => setDiffLayout("unified")}
                        type="button"
                      >
                        <Rows2 className="size-3" /> 行内
                      </button>
                    </div>
                    <button
                      aria-pressed={hideWhitespace}
                      className={cn(
                        "h-8 rounded-lg border px-2.5 text-[10px]",
                        hideWhitespace
                          ? "border-[var(--pf-accent)] bg-[var(--pf-accent-soft)] text-[var(--pf-accent-ink)]"
                          : "border-[var(--pf-line)] text-[var(--pf-ink-muted)] hover:bg-[var(--pf-panel-subtle)]",
                      )}
                      onClick={() => setHideWhitespace((current) => !current)}
                      type="button"
                    >
                      忽略空白
                    </button>
                  </div>
                </div>
                <div className="h-[680px] min-h-[480px] bg-[var(--pf-panel)]">
                  <Suspense
                    fallback={
                      <div className="flex h-full items-center justify-center gap-2 text-xs text-[var(--pf-ink-muted)]">
                        <Loader2 className="size-4 animate-spin" /> 正在加载版本差异…
                      </div>
                    }
                  >
                    <PrivateFundMemoDiffViewer
                      after={comparisonSummary.after}
                      before={comparisonSummary.before}
                      hideWhitespace={hideWhitespace}
                      layout={diffLayout}
                    />
                  </Suspense>
                </div>
                {comparisonSummary.counts.not_mentioned > 0 ? (
                  <p className="border-t border-[var(--pf-line)] px-3 py-2 text-[10px] text-[var(--pf-ink-muted)]">
                    新版未提及不等于观点失效；需要新证据或显式状态更新后才关闭观点。
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <aside className="space-y-3 border-t border-[var(--pf-line)] pt-6">
            <div>
              <div className="flex items-center gap-2">
                <History className="size-4 text-[var(--pf-accent-ink)]" />
                <h2 className="text-sm font-semibold text-[var(--pf-ink)]">观点与假设版本</h2>
              </div>
              <p className="mt-1 text-[10px] leading-4 text-[var(--pf-ink-muted)]">
                同一事项只有在内容、状态、数值或时间窗口变化时才新增版本。
              </p>
            </div>
            {historicalItems.length ? (
              <>
                <select
                  aria-label="历史观点或假设"
                  className="h-10 w-full rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] px-3 text-xs text-[var(--pf-ink)] outline-none focus:border-[var(--pf-accent)]"
                  onChange={(event) => setSelectedItemId(event.target.value)}
                  value={selectedItemId}
                >
                  {historicalItems.map((item) => (
                    <option key={item.itemId} value={item.itemId}>
                      {ITEM_LABELS[item.itemType] ?? item.itemType} · {item.title}
                    </option>
                  ))}
                </select>
                {timelineQuery.isLoading ? (
                  <div className="flex min-h-40 items-center justify-center">
                    <Loader2 className="size-4 animate-spin text-[var(--pf-ink-muted)]" />
                  </div>
                ) : timelineQuery.data ? (
                  <div className="relative space-y-3 pl-5 before:absolute before:bottom-3 before:left-[6px] before:top-3 before:w-px before:bg-[var(--pf-line-strong)]">
                    {[...timelineQuery.data.versions].reverse().map((version) => (
                      <article
                        className="relative rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] p-3 before:absolute before:-left-[19px] before:top-4 before:size-2.5 before:rounded-full before:border-2 before:border-[var(--pf-panel)] before:bg-[var(--pf-accent)]"
                        key={version.itemVersionId}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] font-semibold text-[var(--pf-accent-ink)]">
                            v{version.versionNo}
                          </span>
                          <span className="text-[9px] text-[var(--pf-ink-muted)]">
                            {version.asOfDate || version.observedAt.slice(0, 10)}
                          </span>
                        </div>
                        <p className="mt-2 text-xs leading-5 text-[var(--pf-ink-secondary)]">
                          {compact(version.content, 360)}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2 text-[9px] text-[var(--pf-ink-muted)]">
                          <span>{version.state}</span>
                          {version.valueText ? (
                            <span>
                              {version.valueText}
                              {version.unit ?? ""}
                            </span>
                          ) : null}
                          <span>{version.evidenceIds.length} 条证据</span>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="rounded-xl border border-dashed border-[var(--pf-line)] p-6 text-center text-xs leading-5 text-[var(--pf-ink-muted)]">
                新资料或 Memo 中提取出投资观点、模型假设和关键指标后，会在这里形成时间线。
              </div>
            )}
            <div className="rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] p-4">
              <Quote className="size-4 text-[var(--pf-ink-muted)]" />
              <p className="mt-2 text-[10px] leading-4 text-[var(--pf-ink-secondary)]">
                每个版本保存来源类型、来源 ID、观察时间和
                evidence_id；展示层不会把“最后一次生成的文字”当作唯一历史。
              </p>
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}
