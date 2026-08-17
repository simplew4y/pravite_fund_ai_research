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
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

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
import { currentAppLocale } from "@/lib/localeFormat";

const IMPACT_VALUES = ["low", "medium", "high", "critical"] as const;
const FREQUENCY_TRANSLATION_KEYS: Record<string, string> = {
  on_ingest: "onIngest",
  daily: "daily",
  weekly: "weekly",
};
const CHANGE_TYPE_TRANSLATION_KEYS: Record<string, string> = {
  new: "new",
  status_changed: "statusChanged",
  value_changed: "valueChanged",
  timing_changed: "timingChanged",
  probability_changed: "probabilityChanged",
  stance_changed: "stanceChanged",
  content_changed: "contentChanged",
};

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function diffValue(value: unknown, t: TFunction): string {
  if (value === null || value === undefined || value === "") return t("tracking.unset");
  if (Array.isArray(value)) return value.length ? value.join(", ") : t("tracking.unset");
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
  return new Intl.DateTimeFormat(currentAppLocale(), {
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

const STATE_TRANSLATION_KEYS: Record<string, string> = {
  emerging: "emerging",
  announced: "announced",
  identified: "identified",
  watching: "watching",
  triggered: "triggered",
  materialized: "materialized",
  resolved: "resolved",
  achieved: "achieved",
  missed: "missed",
  active: "active",
  valid: "active",
  effective: "active",
  confirmed: "confirmed",
  pending: "pending",
  expected: "expected",
  planned: "planned",
  in_progress: "inProgress",
  completed: "completed",
  cancelled: "cancelled",
};

const EVENT_TYPE_TRANSLATION_KEYS: Record<string, string> = {
  order_award: "orderAward",
  order_win: "orderWin",
  order_pipeline: "orderPipeline",
  order_growth: "orderGrowth",
  order_delay: "orderDelay",
  product_launch: "productLaunch",
  production_start: "productionStart",
  capacity_expansion: "capacityExpansion",
  capacity_ramp: "capacityRamp",
  local_factory: "localFactory",
  demand_growth: "demandGrowth",
  demand_decline: "demandDecline",
  market_demand_shift: "marketDemandShift",
  cost_increase: "costIncrease",
  cost_pressure: "costPressure",
  product_cost_pressure: "productCostPressure",
  margin_pressure: "marginPressure",
  project_delay: "projectDelay",
  regulatory_change: "regulatoryChange",
  geopolitical_restriction: "geopoliticalRestriction",
  financing_restriction: "financingRestriction",
  market_access_restriction: "marketAccessRestriction",
  certification: "certification",
  grid_connection: "gridConnection",
  policy_support: "policySupport",
  share_buyback: "shareBuyback",
};

function itemTypeLabel(value: string, t: TFunction): string {
  if (value === "all") return t("tracking.allRiskCatalyst");
  if (value === "risk") return t("tracking.risk");
  if (value === "catalyst") return t("tracking.catalyst");
  return value;
}

function frequencyLabel(value: string, t: TFunction): string {
  const key = FREQUENCY_TRANSLATION_KEYS[value];
  return key ? t(`tracking.frequencies.${key}`) : value;
}

function changeTypeLabel(value: string, t: TFunction): string {
  const key = CHANGE_TYPE_TRANSLATION_KEYS[value];
  return key ? t(`tracking.changeTypes.${key}`) : value;
}

function stateLabel(value: string | null | undefined, t: TFunction): string {
  const normalized = String(value ?? "")
    .trim()
    .toLocaleLowerCase();
  const key = STATE_TRANSLATION_KEYS[normalized];
  return key ? t(`tracking.states.${key}`) : t("tracking.pendingConfirmation");
}

function eventTypeLabel(value: string, t: TFunction): string {
  const normalized = value.trim().toLocaleLowerCase().replaceAll("-", "_");
  if (!normalized) return "";
  const key = EVENT_TYPE_TRANSLATION_KEYS[normalized];
  if (key) return t(`tracking.eventTypes.${key}`);
  return /[\u3400-\u9fff]/u.test(value) ? value : t("tracking.otherEvent");
}

function QualityBadge({ quality }: { quality: string }) {
  const { t } = useTranslation();
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
      {verified ? t("tracking.verified") : t("tracking.needsReview")}
    </span>
  );
}

function impactLabel(value: string | null | undefined, t: TFunction): string {
  const normalized = String(value ?? "").trim().toLocaleLowerCase();
  return ["critical", "high", "medium", "low"].includes(normalized)
    ? t(`tracking.impacts.${normalized}`)
    : value || "—";
}

function trackingDisplayTitle(item: PrivateFundResearchItem, t: TFunction): string {
  if (currentAppLocale() !== "en-US") return item.title;
  const entity = metadataText(item, "entity");
  const subject = metadataText(item, "subject");
  const event = eventTypeLabel(metadataText(item, "event_type"), t);
  const core = subject || event;
  if (entity && core) return `${entity}: ${core}`;
  return core || entity || item.title;
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
  const { t } = useTranslation();
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
              {impactLabel(alert.priority, t)}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-5 text-[var(--pf-ink-secondary)]">
            {alert.summary}
          </p>
          <p className="mt-1.5 text-[10px] text-[var(--pf-ink-muted)]">
            {formatTime(alert.createdAt)} ·{" "}
            {t("tracking.alertEvidenceCount", { count: alert.evidenceIds.length })}
          </p>
        </div>
        {alert.status === "new" ? (
          <div className="flex shrink-0 gap-1">
            <button
              aria-label={t("tracking.acknowledgeAlert", { title: alert.title })}
              className="pf-icon-button"
              disabled={pending}
              onClick={() => onUpdate("acknowledged")}
              title={t("tracking.markRead")}
              type="button"
            >
              {pending ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
            </button>
            <button
              aria-label={t("tracking.dismissAlert", { title: alert.title })}
              className="pf-icon-button"
              disabled={pending}
              onClick={() => onUpdate("dismissed")}
              title={t("tracking.dismiss")}
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
  const { t } = useTranslation();
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
    [t("tracking.eventType"), eventTypeLabel(metadataText(item, "event_type"), t)],
    [t("tracking.subject"), metadataText(item, "subject")],
    [t("tracking.trigger"), metadataText(item, "trigger")],
    [t("tracking.transmissionPath"), metadataText(item, "transmission_path")],
  ].filter((entry) => entry[1]);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/20"
      role="dialog"
      aria-modal="true"
    >
      <button
        aria-label={t("tracking.closeDetails")}
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <aside className="relative h-full w-full max-w-xl overflow-y-auto border-l border-[var(--pf-line)] bg-[var(--pf-panel-raised)] shadow-2xl">
        <header className="sticky top-0 z-10 flex items-start justify-between border-b border-[var(--pf-line)] bg-[var(--pf-panel-raised)]/95 px-5 py-4 backdrop-blur">
          <div className="min-w-0 pr-4">
            <div className="mb-2 flex items-center gap-2">
              <span className={item.itemType === "risk" ? "pf-risk-badge" : "pf-catalyst-badge"}>
                {itemTypeLabel(item.itemType, t)}
              </span>
              <QualityBadge quality={qualityOf(item)} />
              <span className="text-[10px] text-[var(--pf-ink-muted)]">
                v{item.currentVersionNo}
              </span>
            </div>
            <h2 className="text-base font-semibold leading-6 text-[var(--pf-ink)]">
              {trackingDisplayTitle(item, t)}
            </h2>
          </div>
          <button className="pf-icon-button" onClick={onClose} type="button">
            <X className="size-4" />
          </button>
        </header>

        <div className="space-y-6 p-5">
          <section>
            <h3 className="pf-section-label">{t("tracking.currentJudgement")}</h3>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[var(--pf-ink-secondary)]">
              {current?.content || t("tracking.noContent")}
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
              <h3 className="pf-section-label">{t("tracking.evidence")}</h3>
              <span className="text-[10px] text-[var(--pf-ink-muted)]">
                {t("tracking.evidenceCountShort", {
                  count: current?.evidenceIds.length ?? 0,
                })}
              </span>
            </div>
            {timelineQuery.isLoading ? (
              <p className="mt-3 flex items-center gap-2 text-xs text-[var(--pf-ink-muted)]">
                <Loader2 className="size-3 animate-spin" /> {t("tracking.resolvingEvidence")}
              </p>
            ) : timelineQuery.isError ? (
              <div className="mt-2 rounded-lg border border-[var(--pf-danger-ink)]/20 bg-[var(--pf-danger-soft)] p-3 text-xs text-[var(--pf-danger-ink)]">
                <p>{t("tracking.evidenceLoadFailed")}</p>
                <button
                  className="mt-2 underline"
                  onClick={() => timelineQuery.refetch()}
                  type="button"
                >
                  {t("tracking.reload")}
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
                              t("tracking.noEvidenceExcerpt")}
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
                                {isExpanded
                                  ? t("tracking.collapseEvidence")
                                  : t("tracking.expandEvidence")}
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
                {t("tracking.evidenceUnavailable")}
              </div>
            )}
          </section>

          <section>
            <div className="flex items-center justify-between">
              <h3 className="pf-section-label">{t("tracking.versionTimeline")}</h3>
              <span className="text-[10px] text-[var(--pf-ink-muted)]">
                {t("tracking.fieldComparison")}
              </span>
            </div>
            {timelineQuery.isLoading ? (
              <p className="mt-3 flex items-center gap-2 text-xs text-[var(--pf-ink-muted)]">
                <Loader2 className="size-3 animate-spin" /> {t("tracking.loadingVersions")}
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
                            v{version.versionNo} · {stateLabel(version.state, t)}
                          </span>
                          <span className="mt-0.5 block text-[10px] text-[var(--pf-ink-muted)]">
                            {t("tracking.versionEvidenceCount", {
                              time: formatTime(version.observedAt),
                              count: version.evidenceIds.length,
                            })}
                          </span>
                        </span>
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--pf-panel-subtle)] px-2 py-1 text-[10px] text-[var(--pf-accent-ink)]">
                          <GitCompare className="size-3" />
                          {version.versionNo === 1
                            ? t("tracking.initialVersion")
                            : t("tracking.changeCount", {
                                count: version.fieldChanges.length,
                              })}
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
                                    {diffValue(change.before, t)}
                                  </span>
                                  <span className="text-[var(--pf-ink-muted)]">→</span>
                                  <span className="break-words font-medium text-[var(--pf-ink-secondary)]">
                                    {diffValue(change.after, t)}
                                  </span>
                                </div>
                              </div>
                            ))
                          ) : (
                            <p className="text-[10px] text-[var(--pf-ink-muted)]">
                              {t("tracking.noStructuredChanges")}
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
  const { t } = useTranslation();
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
          <span>{t("tracking.ruleName")}</span>
          <input
            className="pf-filter-input w-full"
            maxLength={80}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder={t("tracking.ruleNamePlaceholder")}
            required
            value={draft.name}
          />
        </label>
        <label className="space-y-1 text-[10px] font-semibold text-[var(--pf-ink-muted)]">
          <span>{t("tracking.ruleItemType")}</span>
          <select
            className="pf-filter-input w-full"
            onChange={(event) => setDraft({ ...draft, targetType: event.target.value })}
            value={draft.targetType}
          >
            <option value="all">{t("tracking.allRiskCatalyst")}</option>
            <option value="risk">{t("tracking.risksOnly")}</option>
            <option value="catalyst">{t("tracking.catalystsOnly")}</option>
          </select>
        </label>
        <label className="space-y-1 text-[10px] font-semibold text-[var(--pf-ink-muted)]">
          <span>{t("tracking.minimumPriority")}</span>
          <select
            className="pf-filter-input w-full"
            onChange={(event) => setDraft({ ...draft, minPriority: event.target.value })}
            value={draft.minPriority}
          >
            {IMPACT_VALUES.toReversed().map((value) => (
                <option key={value} value={value}>
                  {impactLabel(value, t)}
                </option>
              ))}
          </select>
        </label>
        <label className="space-y-1 text-[10px] font-semibold text-[var(--pf-ink-muted)]">
          <span>{t("tracking.checkFrequency")}</span>
          <select
            className="pf-filter-input w-full"
            onChange={(event) => setDraft({ ...draft, frequency: event.target.value })}
            value={draft.frequency}
          >
            {Object.keys(FREQUENCY_TRANSLATION_KEYS).map((value) => (
              <option key={value} value={value}>
                {frequencyLabel(value, t)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block space-y-1 text-[10px] font-semibold text-[var(--pf-ink-muted)]">
        <span>{t("tracking.keywordsLabel")}</span>
        <textarea
          className="pf-filter-input min-h-20 w-full resize-y py-2"
          onChange={(event) => setDraft({ ...draft, keywords: event.target.value })}
          placeholder={t("tracking.keywordsPlaceholder")}
          value={draft.keywords}
        />
      </label>
      <fieldset>
        <legend className="text-[10px] font-semibold text-[var(--pf-ink-muted)]">
          {t("tracking.eventTypesLegend")}
        </legend>
        <div className="mt-2 grid max-h-40 gap-1.5 overflow-y-auto rounded-lg border border-[var(--pf-line)] p-2 sm:grid-cols-3">
          {Object.keys(EVENT_TYPE_TRANSLATION_KEYS).map((value) => (
            <label
              className="flex items-center gap-1.5 text-[10px] text-[var(--pf-ink-secondary)]"
              key={value}
            >
              <input
                checked={draft.eventTypes.includes(value)}
                onChange={() => toggle("eventTypes", value)}
                type="checkbox"
              />
              {eventTypeLabel(value, t)}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="text-[10px] font-semibold text-[var(--pf-ink-muted)]">
          {t("tracking.changeTypesLegend")}
        </legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {Object.keys(CHANGE_TYPE_TRANSLATION_KEYS).map((value) => (
            <label
              className="flex items-center gap-1.5 rounded-full bg-[var(--pf-panel-subtle)] px-2 py-1 text-[10px] text-[var(--pf-ink-secondary)]"
              key={value}
            >
              <input
                checked={draft.changeTypes.includes(value)}
                onChange={() => toggle("changeTypes", value)}
                type="checkbox"
              />
              {changeTypeLabel(value, t)}
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
        {t("tracking.enableAfterSave")}
      </label>
      {error ? <p className="text-xs text-[var(--pf-danger-ink)]">{error}</p> : null}
      <div className="flex justify-end gap-2 border-t border-[var(--pf-line)] pt-3">
        <button className="pf-secondary-button" onClick={onCancel} type="button">
          {t("tracking.cancel")}
        </button>
        <button
          className="pf-primary-button"
          disabled={pending || !draft.name.trim()}
          type="submit"
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t("tracking.saveRule")}
        </button>
      </div>
    </form>
  );
}

export function PrivateFundTrackingPanel({ datasetId }: { datasetId: string }) {
  const { t } = useTranslation();
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
      if (item.itemType !== "risk" && item.itemType !== "catalyst") return false;
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
        {t("tracking.loading")}
      </div>
    );
  }
  if (trackingQuery.isError || !data) {
    return (
      <div className="m-6 rounded-xl border border-[var(--pf-danger-ink)]/25 bg-[var(--pf-danger-soft)] p-4 text-sm text-[var(--pf-danger-ink)]">
        {t("tracking.loadFailed")}：{trackingQuery.error?.message ?? t("common.unknown")}
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
    { key: "risk", label: t("tracking.risks"), value: data.counts.risk ?? 0, icon: ShieldAlert },
    {
      key: "catalyst",
      label: t("tracking.catalysts"),
      value: data.counts.catalyst ?? 0,
      icon: Sparkles,
    },
    {
      key: "needs_review",
      label: t("tracking.needsReview"),
      value: data.qualityCounts.needs_review ?? 0,
      icon: Clock3,
    },
    {
      key: "unread",
      label: t("tracking.unreadAlerts"),
      value: data.unreadAlertCount,
      icon: BellRing,
    },
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
      aria-label={t("tracking.title")}
      className="min-h-0 flex-1 overflow-y-auto bg-[var(--pf-canvas)]"
    >
      <div className="mx-auto max-w-[1480px] p-4 lg:p-6">
        <header className="flex flex-col gap-4 border-b border-[var(--pf-line)] pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="pf-section-label">{t("tracking.eyebrow")}</p>
            <h1 className="mt-1 text-xl font-semibold text-[var(--pf-ink)]">
              {t("tracking.title")}
            </h1>
            <p className="mt-1 text-xs text-[var(--pf-ink-secondary)]">
              {t("tracking.description")}
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
            {activeJob ? t("tracking.updating") : t("tracking.updateNow")}
          </button>
        </header>

        {data.rebuildRequired ? (
          <div className="mt-5 flex flex-col gap-3 rounded-lg border border-amber-500/35 bg-amber-50 px-4 py-3 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold">{t("tracking.legacyTitle")}</p>
              <p className="mt-1 text-[11px] opacity-80">
                {t("tracking.legacyFound", { count: data.legacyItemCount })}
              </p>
            </div>
            <button
              className="pf-secondary-button shrink-0"
              disabled={rebuildMutation.isPending || Boolean(activeJob)}
              onClick={() => {
                if (
                  window.confirm(
                    t("tracking.rebuildConfirm"),
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
              {t("tracking.rebuild")}
            </button>
          </div>
        ) : null}

        <div className="grid gap-px overflow-hidden rounded-xl border border-[var(--pf-line)] bg-[var(--pf-line)] sm:grid-cols-2 xl:grid-cols-4 mt-5">
          {stats.map((stat) => {
            const active = summaryIsActive(stat.key);
            return (
              <button
                aria-label={t("tracking.viewSummary", {
                  label: stat.label,
                  count: stat.value,
                })}
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

        <nav
          className="mt-5 flex gap-1 border-b border-[var(--pf-line)]"
          aria-label={t("tracking.viewsLabel")}
        >
          {(
            [
              ["ledger", t("tracking.ledger")],
              ["alerts", `${t("tracking.inbox")} ${data.unreadAlertCount}`],
              ["rules", t("tracking.rules")],
              [
                "governance",
                `${t("tracking.governance")} ${data.governanceCounts.activeUnqualified + data.governanceCounts.archived}`,
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
                  aria-label={t("tracking.searchLabel")}
                  className="pf-filter-input pl-8"
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(1);
                  }}
                  placeholder={t("tracking.search")}
                  value={search}
                />
              </label>
              <select
                aria-label={t("tracking.typeFilterLabel")}
                className="pf-filter-input lg:w-32"
                onChange={(event) => {
                  setTypeFilter(event.target.value);
                  setPage(1);
                }}
                value={typeFilter}
              >
                <option value="all">{t("tracking.allTypes")}</option>
                <option value="risk">{t("tracking.risk")}</option>
                <option value="catalyst">{t("tracking.catalyst")}</option>
              </select>
              <select
                aria-label={t("tracking.qualityFilterLabel")}
                className="pf-filter-input lg:w-32"
                onChange={(event) => {
                  setQualityFilter(event.target.value);
                  setPage(1);
                }}
                value={qualityFilter}
              >
                <option value="all">{t("tracking.allQuality")}</option>
                <option value="verified">{t("tracking.verified")}</option>
                <option value="needs_review">{t("tracking.needsReview")}</option>
              </select>
              <span className="px-1 text-[10px] text-[var(--pf-ink-muted)]">
                {t("tracking.itemCount", { count: trackedItems.length })}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[920px] text-left">
                <thead className="bg-[var(--pf-panel-subtle)] text-[10px] font-semibold text-[var(--pf-ink-muted)]">
                  <tr>
                    <th className="px-4 py-2.5">{t("tracking.type")}</th>
                    <th className="px-3 py-2.5">{t("tracking.item")}</th>
                    <th className="px-3 py-2.5">{t("tracking.state")}</th>
                    <th className="px-3 py-2.5">{t("tracking.impact")}</th>
                    <th className="px-3 py-2.5">{t("tracking.window")}</th>
                    <th className="px-3 py-2.5">{t("tracking.quality")}</th>
                    <th className="px-3 py-2.5">{t("tracking.evidence")}</th>
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
                            {itemTypeLabel(item.itemType, t)}
                          </span>
                        </td>
                        <td className="max-w-xl px-3 py-3">
                          <p className="truncate text-xs font-semibold text-[var(--pf-ink)]">
                            {trackingDisplayTitle(item, t)}
                          </p>
                          <p className="mt-1 line-clamp-1 text-[10px] text-[var(--pf-ink-muted)]">
                            {current?.content}
                          </p>
                        </td>
                        <td className="px-3 py-3 text-xs text-[var(--pf-ink-secondary)]">
                          {stateLabel(current?.state, t)}
                        </td>
                        <td className="px-3 py-3 text-xs text-[var(--pf-ink-secondary)]">
                          {impactLabel(current?.impact, t)}
                        </td>
                        <td className="px-3 py-3 text-xs text-[var(--pf-ink-secondary)]">
                          {current?.expectedStart || current?.expectedEnd || "—"}
                        </td>
                        <td className="px-3 py-3">
                          <QualityBadge quality={qualityOf(item)} />
                          {current?.metadata?.requires_rebuild ? (
                            <p className="mt-1 text-[9px] font-medium text-amber-700 dark:text-amber-300">
                              {t("tracking.legacyData")}
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
                  {t("tracking.empty")}
                </div>
              ) : null}
            </div>
            {trackedItems.length ? (
              <div className="flex flex-col gap-3 border-t border-[var(--pf-line)] px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2 text-[10px] text-[var(--pf-ink-muted)]">
                  <span>
                    {t("tracking.rangeSummary", {
                      start: (page - 1) * pageSize + 1,
                      end: Math.min(page * pageSize, trackedItems.length),
                      count: trackedItems.length,
                    })}
                  </span>
                  <label className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                    {t("tracking.perPage")}
                    <select
                      aria-label={t("tracking.perPageLabel")}
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
                <nav aria-label={t("tracking.paginationLabel")} className="flex items-center gap-1">
                  <button
                    className="pf-pagination-button"
                    disabled={page === 1}
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                    type="button"
                  >
                    {t("common.previous")}
                  </button>
                  {visiblePages.map((pageNumber) => (
                    <button
                      aria-current={pageNumber === page ? "page" : undefined}
                      aria-label={t("tracking.pageLabel", { page: pageNumber })}
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
                    {t("common.next")}
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
                {t("tracking.noAlerts")}
              </div>
            )}
          </div>
        ) : null}

        {view === "rules" ? (
          <div className="mt-4 overflow-hidden rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)]">
            <div className="flex items-center justify-between border-b border-[var(--pf-line)] px-4 py-3">
              <div>
                <h2 className="text-xs font-semibold text-[var(--pf-ink)]">
                  {t("tracking.trackingRules")}
                </h2>
                <p className="mt-1 text-[10px] text-[var(--pf-ink-muted)]">
                  {t("tracking.trackingRulesDescription")}
                </p>
              </div>
              <button
                className="pf-primary-button"
                onClick={() => setEditingRule(null)}
                type="button"
              >
                <Plus className="size-3.5" /> {t("tracking.newRule")}
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
                  aria-label={t("tracking.enableRule", { name: rule.name })}
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
                    {t("tracking.ruleSummary", {
                      type: itemTypeLabel(rule.targetType, t),
                      priority: impactLabel(rule.minPriority, t),
                      frequency: frequencyLabel(rule.frequency, t),
                    })}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {stringList(rule.query.keywords).map((keyword) => (
                      <span
                        className="rounded-full bg-[var(--pf-accent-soft)] px-2 py-0.5 text-[9px] text-[var(--pf-accent-ink)]"
                        key={keyword}
                      >
                        {t("tracking.keyword", { keyword })}
                      </span>
                    ))}
                    {stringList(rule.query.event_types).map((eventType) => (
                      <span
                        className="rounded-full bg-[var(--pf-panel-subtle)] px-2 py-0.5 text-[9px] text-[var(--pf-ink-secondary)]"
                        key={eventType}
                      >
                        {eventTypeLabel(eventType, t)}
                      </span>
                    ))}
                    {!stringList(rule.query.keywords).length &&
                    !stringList(rule.query.event_types).length ? (
                      <span className="text-[9px] text-[var(--pf-ink-muted)]">
                        {t("tracking.matchAllEvents")}
                      </span>
                    ) : null}
                  </div>
                </div>
                <button
                  className="pf-icon-button"
                  onClick={() => setEditingRule(rule)}
                  title={t("tracking.editRule")}
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
                <h2 className="text-xs font-semibold text-[var(--pf-ink)]">
                  {t("tracking.governanceTitle")}
                </h2>
                <p className="mt-1 text-[10px] leading-4 text-[var(--pf-ink-muted)]">
                  {t("tracking.governanceDescription")}
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
                      ? t("tracking.governancePending", {
                          count: data.governanceCounts.activeUnqualified,
                        })
                      : t("tracking.governanceArchived", {
                          count: data.governanceCounts.archived,
                        })}
                  </button>
                ))}
              </div>
            </div>
            {governanceQuery.isLoading ? (
              <div className="flex items-center justify-center gap-2 p-10 text-xs text-[var(--pf-ink-muted)]">
                <Loader2 className="size-3.5 animate-spin" /> {t("tracking.governanceLoading")}
              </div>
            ) : governanceQuery.isError ? (
              <div className="m-4 rounded-lg bg-[var(--pf-danger-soft)] p-3 text-xs text-[var(--pf-danger-ink)]">
                {t("tracking.governanceLoadFailed", {
                  error: governanceQuery.error.message,
                })}
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
                    {t("tracking.selectAllGovernance", {
                      count: selectedGovernanceIds.size,
                    })}
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
                      <Archive className="size-3.5" /> {t("tracking.archiveSelected")}
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
                        <RotateCcw className="size-3.5" /> {t("tracking.restoreSelected")}
                      </button>
                      <button
                        className="pf-secondary-button text-[var(--pf-danger-ink)]"
                        disabled={!selectedGovernanceIds.size || governanceMutation.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              t("tracking.purgeConfirm", {
                                count: selectedGovernanceIds.size,
                              }),
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
                        <Trash2 className="size-3.5" /> {t("tracking.purgeSelected")}
                      </button>
                    </div>
                  )}
                </div>
                {governanceMutation.isError ? (
                  <p className="border-b border-[var(--pf-line)] px-4 py-2 text-xs text-[var(--pf-danger-ink)]">
                    {t("tracking.governanceActionFailed", {
                      error: governanceMutation.error.message,
                    })}
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
                              {itemTypeLabel(item.itemType, t)}
                            </span>
                            <span className="truncate text-xs font-semibold text-[var(--pf-ink)]">
                              {item.title || t("tracking.invalidTitle")}
                            </span>
                          </span>
                          <span className="mt-1.5 block text-[10px] font-medium text-[var(--pf-danger-ink)]">
                            {item.qualityIssue ??
                              item.archiveReason ??
                              t("tracking.failedQualityGate")}
                          </span>
                          <span className="mt-1 block line-clamp-2 text-[10px] leading-4 text-[var(--pf-ink-muted)]">
                            {item.currentVersion?.content || t("tracking.invalidContent")}
                          </span>
                          {item.archivedAt ? (
                            <span className="mt-1 block text-[9px] text-[var(--pf-ink-muted)]">
                              {t("tracking.archivedAt", {
                                time: formatTime(item.archivedAt),
                              })}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className="p-10 text-center text-xs text-[var(--pf-ink-muted)]">
                    {governanceStatus === "active"
                      ? t("tracking.noPendingGovernance")
                      : t("tracking.noArchivedGovernance")}
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
