import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Download, RefreshCw } from "lucide-react";

import {
  addDerivedModelToResources,
  compareValuationVersions,
  createValuationAnalysis,
  deriveValuationModel,
  derivedModelDownloadUrl,
  fetchValuation,
  listValuationVersions,
  runValuation,
  transitionValuationAlert,
  updateValuationWatchRule,
} from "../../api/insights";
import { useServerInfo } from "../../api/queries";
import { MonoLabel } from "../../components/MonoLabel";
import type { DictKey } from "../../i18n/dict";
import { useT } from "../../i18n/useT";

const ALERT_STATUS_LABEL: Record<string, DictKey> = {
  new: "risks.status.new",
  acknowledged: "risks.status.acknowledged",
  dismissed: "risks.status.dismissed",
  snoozed: "risks.status.snoozed",
};

function text(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

function analysisStatusTag(status: string): string {
  if (status === "completed") return "tag tag-accent";
  if (status === "failed") return "tag tag-outline";
  return "tag tag-neutral";
}

function EmptyLine() {
  const { t } = useT();
  return (
    <p className="text-muted" style={{ fontSize: 12 }}>
      {t("common.empty")}
    </p>
  );
}

/** Expanded body of a series row: version list, compare and analyze actions. */
function SeriesVersions({
  projectId,
  seriesId,
  currentModelVersionId,
}: {
  projectId: string;
  seriesId: string;
  currentModelVersionId: string;
}) {
  const { t } = useT();
  const client = useQueryClient();
  const versions = useQuery({
    queryKey: ["valuation-versions", projectId, seriesId],
    queryFn: () => listValuationVersions(projectId, seriesId),
  });
  const [compareFrom, setCompareFrom] = useState<string | null>(null);
  const compare = useMutation({
    mutationFn: (input: { from: string; to: string }) =>
      compareValuationVersions(projectId, seriesId, input.from, input.to),
  });
  const analyze = useMutation({
    mutationFn: () =>
      createValuationAnalysis(projectId, seriesId, currentModelVersionId),
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: ["valuation", projectId] }),
  });

  return (
    <div className="panel" style={{ marginLeft: 12, marginBottom: 8 }}>
      {versions.isPending ? <p className="text-muted">{t("common.loading")}</p> : null}
      {versions.isError ? <p className="error-text">{t("common.error")}</p> : null}
      {versions.data?.length === 0 ? <EmptyLine /> : null}
      {versions.data?.map((version, index) => {
        const versionId = text(version, "versionId", "modelVersionId", "id");
        return (
          <div key={versionId === "" ? String(index) : versionId} className="doc-row">
            <span className="title">
              v{text(version, "documentVersionNo", "versionNo", "version")} ·{" "}
              {text(version, "originalFilename", "filename")} ·{" "}
              {text(version, "createdAt").slice(0, 10)}
            </span>
            <button
              className="btn btn-ghost"
              disabled={versionId === "" || compare.isPending}
              onClick={() => {
                if (compareFrom === null) setCompareFrom(versionId);
                else {
                  compare.mutate({ from: compareFrom, to: versionId });
                  setCompareFrom(null);
                }
              }}
            >
              {compareFrom === null
                ? t("valuation.compare")
                : `→ ${t("valuation.compare")}`}
            </button>
          </div>
        );
      })}
      {compare.isError ? <p className="error-text">{t("common.error")}</p> : null}
      {compare.data?.changes.map((change, index) => {
        const materiality = text(change, "materiality");
        const absolute = text(change, "absoluteChange");
        const relative = text(change, "relativeChange");
        const delta = [absolute, relative].filter(Boolean).join(" / ");
        return (
          <div key={String(index)} className="doc-row">
            <span className="title">
              {text(change, "summary", "description", "field")}
            </span>
            {materiality === "" ? null : (
              <span className="tag tag-outline">{materiality}</span>
            )}
            {delta === "" ? null : <MonoLabel>{delta}</MonoLabel>}
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
        <button
          className="btn btn-secondary"
          disabled={currentModelVersionId === "" || analyze.isPending}
          onClick={() => analyze.mutate()}
        >
          {t("valuation.analyze")}
        </button>
        {analyze.isSuccess ? (
          <span className="text-muted" style={{ fontSize: 12 }}>
            {t("common.queued")}
          </span>
        ) : null}
      </div>
      {analyze.isError ? <p className="error-text">{t("common.error")}</p> : null}
    </div>
  );
}

export function ValuationDeepPanel({ projectId }: { projectId: string }) {
  const { t } = useT();
  const info = useServerInfo();
  const client = useQueryClient();
  const valuation = useQuery({
    queryKey: ["valuation", projectId],
    queryFn: () => fetchValuation(projectId),
    enabled: info.data?.insights_store === true,
  });
  const [expandedSeriesId, setExpandedSeriesId] = useState<string | null>(null);

  // Expansion is project-scoped: another project's series ids are unrelated.
  useEffect(() => {
    setExpandedSeriesId(null);
  }, [projectId]);

  const invalidate = (): void =>
    void client.invalidateQueries({ queryKey: ["valuation", projectId] });

  const run = useMutation({
    mutationFn: () => runValuation(projectId),
    // The refresh is a background job; poll briefly so the panel reflects it.
    onSuccess: () => {
      const stop = Date.now() + 60_000;
      const tick = (): void => {
        void client.invalidateQueries({ queryKey: ["valuation", projectId] });
        if (Date.now() < stop) setTimeout(tick, 5_000);
      };
      setTimeout(tick, 3_000);
    },
  });
  const derive = useMutation({
    mutationFn: (analysisId: string) => deriveValuationModel(projectId, analysisId),
  });
  const toLibrary = useMutation({
    mutationFn: (derivedModelId: string) =>
      addDerivedModelToResources(projectId, derivedModelId),
    onSuccess: invalidate,
  });
  const toggleRule = useMutation({
    mutationFn: (input: { ruleId: string; active: boolean }) =>
      updateValuationWatchRule(projectId, input.ruleId, { active: input.active }),
    onSuccess: invalidate,
  });
  const acknowledge = useMutation({
    mutationFn: (alertId: string) =>
      transitionValuationAlert(projectId, alertId, "acknowledged"),
    onSuccess: invalidate,
  });

  if (info.isError) return <p className="error-text">{t("common.error")}</p>;
  if (info.data && !info.data.insights_store) {
    return <p className="text-muted">{t("memo.unavailable")}</p>;
  }
  if (valuation.isPending) return <p className="text-muted">{t("common.loading")}</p>;
  if (valuation.isError) return <p className="error-text">{t("common.error")}</p>;

  const overview = valuation.data;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <MonoLabel>{t("board.valuation")}</MonoLabel>
        <button
          className="btn btn-secondary"
          onClick={() => run.mutate()}
          disabled={run.isPending}
        >
          <RefreshCw size={14} /> {t("valuation.run")}
        </button>
      </div>
      {run.isError ? <p className="error-text">{t("common.error")}</p> : null}
      {run.isSuccess ? (
        <p className="text-muted" style={{ fontSize: 12 }}>
          {t("valuation.queued")}
        </p>
      ) : null}
      {overview.series.length === 0 ? <EmptyLine /> : null}
      {overview.series.map((series, index) => {
        const seriesId = text(series, "id", "seriesId");
        const expanded = seriesId !== "" && expandedSeriesId === seriesId;
        return (
          <div key={seriesId === "" ? String(index) : seriesId}>
            <div
              className="doc-row"
              style={{ cursor: "pointer" }}
              onClick={() => setExpandedSeriesId(expanded ? null : seriesId)}
            >
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span className="title">{text(series, "name", "title", "id")}</span>
              <MonoLabel>
                {typeof series.currentVersionNo === "number" &&
                series.currentVersionNo > 0
                  ? `v${String(series.currentVersionNo)}`
                  : t("common.missing")}
              </MonoLabel>
            </div>
            {expanded ? (
              <SeriesVersions
                projectId={projectId}
                seriesId={seriesId}
                currentModelVersionId={text(series, "currentModelVersionId")}
              />
            ) : null}
          </div>
        );
      })}

      <div style={{ marginTop: 10 }}>
        <MonoLabel>{t("valuation.analyses")}</MonoLabel>
        {overview.analyses.length === 0 ? <EmptyLine /> : null}
        {overview.analyses.map((analysis, index) => {
          const analysisId = text(analysis, "analysisId", "id");
          const status = text(analysis, "status");
          const summary = text(analysis, "focus", "executiveSummary");
          const truncated =
            summary.length > 90 ? `${summary.slice(0, 90)}…` : summary;
          return (
            <div key={analysisId === "" ? String(index) : analysisId} className="doc-row">
              <span className={analysisStatusTag(status)}>
                {status === "" ? t("common.missing") : status}
              </span>
              <span className="title">{truncated}</span>
              {status === "completed" && analysisId !== "" ? (
                <button
                  className="btn btn-ghost"
                  onClick={() => derive.mutate(analysisId)}
                  disabled={derive.isPending}
                >
                  {t("valuation.derive")}
                </button>
              ) : null}
            </div>
          );
        })}
        {derive.isSuccess ? (
          <p className="text-muted" style={{ fontSize: 12 }}>
            {t("common.queued")}
          </p>
        ) : null}
        {derive.isError ? <p className="error-text">{t("common.error")}</p> : null}
      </div>

      <div style={{ marginTop: 10 }}>
        <MonoLabel>{t("valuation.derived.models")}</MonoLabel>
        {overview.derivedModels.length === 0 ? <EmptyLine /> : null}
        {overview.derivedModels.map((model, index) => {
          const modelId = text(model, "derivedModelId", "id");
          const resourceStatus = text(model, "resourceStatus");
          return (
            <div key={modelId === "" ? String(index) : modelId} className="doc-row">
              <span className="title">
                {text(model, "outputFilename", "filename", "name")}
              </span>
              <span className="tag tag-neutral">
                {resourceStatus === "" ? t("common.missing") : resourceStatus}
              </span>
              {modelId === "" ? null : (
                <a
                  className="btn btn-icon btn-ghost"
                  href={derivedModelDownloadUrl(projectId, modelId)}
                  target="_blank"
                  rel="noopener"
                  title={t("common.download")}
                >
                  <Download size={14} />
                </a>
              )}
              {modelId !== "" && resourceStatus !== "completed" ? (
                <button
                  className="btn btn-ghost"
                  onClick={() => toLibrary.mutate(modelId)}
                  disabled={toLibrary.isPending}
                >
                  {t("valuation.toLibrary")}
                </button>
              ) : null}
            </div>
          );
        })}
        {toLibrary.isError ? <p className="error-text">{t("common.error")}</p> : null}
      </div>

      <div style={{ marginTop: 10 }}>
        <MonoLabel>{t("rules.title")}</MonoLabel>
        {overview.watchRules.length === 0 ? <EmptyLine /> : null}
        {overview.watchRules.map((rule, index) => {
          const ruleId = text(rule, "ruleId", "id");
          const active = rule.active === true;
          const minMateriality = text(rule, "minMateriality");
          return (
            <div key={ruleId === "" ? String(index) : ruleId} className="doc-row">
              <span className="title">{text(rule, "name", "title", "id")}</span>
              {minMateriality === "" ? null : (
                <span className="tag tag-outline">{minMateriality}</span>
              )}
              <span className={active ? "tag tag-accent" : "tag tag-neutral"}>
                {active ? t("rules.active") : t("rules.paused")}
              </span>
              {ruleId === "" ? null : (
                <button
                  className="btn btn-ghost"
                  onClick={() => toggleRule.mutate({ ruleId, active: !active })}
                  disabled={toggleRule.isPending}
                >
                  {t(active ? "rules.disable" : "rules.enable")}
                </button>
              )}
            </div>
          );
        })}
        {toggleRule.isError ? <p className="error-text">{t("common.error")}</p> : null}
      </div>

      <div style={{ marginTop: 10 }}>
        <MonoLabel>{t("valuation.alerts")}</MonoLabel>
        {overview.alerts.length === 0 ? <EmptyLine /> : null}
        {overview.alerts.map((alert, index) => {
          const alertId = text(alert, "alertId", "id");
          const status = text(alert, "status");
          const statusKey = ALERT_STATUS_LABEL[status];
          // Domain is new | acknowledged | dismissed | snoozed; only new and
          // snoozed can transition to acknowledged.
          const canAcknowledge =
            alertId !== "" && (status === "new" || status === "snoozed");
          return (
            <div key={alertId === "" ? String(index) : alertId} className="doc-row">
              <span className="tag tag-neutral">
                {statusKey ? t(statusKey) : status}
              </span>
              <span className="title">{text(alert, "title", "message", "summary")}</span>
              {canAcknowledge ? (
                <button
                  className="btn btn-ghost"
                  onClick={() => acknowledge.mutate(alertId)}
                  disabled={acknowledge.isPending}
                >
                  {t("risks.acknowledge")}
                </button>
              ) : null}
            </div>
          );
        })}
        {acknowledge.isError ? <p className="error-text">{t("common.error")}</p> : null}
      </div>
    </div>
  );
}
