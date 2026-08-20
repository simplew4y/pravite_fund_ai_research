import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";

import {
  fetchItemTimeline,
  fetchTracking,
  transitionTrackingAlert,
  updateTrackingWatchRule,
} from "../../api/insights";
import { useServerInfo } from "../../api/queries";
import { MonoLabel } from "../../components/MonoLabel";
import type { DictKey } from "../../i18n/dict";
import { useT } from "../../i18n/useT";

const ITEM_TYPE_TAG: Record<
  string,
  { key: DictKey; className: string }
> = {
  risk: { key: "risks.risk", className: "tag tag-outline" },
  catalyst: { key: "risks.catalyst", className: "tag tag-accent" },
  thesis: { key: "risks.thesis", className: "tag tag-neutral" },
  assumption: { key: "risks.assumption", className: "tag tag-neutral" },
  metric: { key: "risks.metric", className: "tag tag-neutral" },
  question: { key: "risks.question", className: "tag tag-neutral" },
};

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

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function ItemTimelineView({ projectId, itemId }: { projectId: string; itemId: string }) {
  const { t } = useT();
  const timeline = useQuery({
    queryKey: ["item-timeline", projectId, itemId],
    queryFn: () => fetchItemTimeline(projectId, itemId),
  });

  if (timeline.isPending) return <p className="text-muted">{t("common.loading")}</p>;
  if (timeline.isError) return <p className="error-text">{t("common.error")}</p>;

  const versions = [...timeline.data.versions].reverse().slice(0, 5);
  const changes = timeline.data.changes.slice(0, 5);

  return (
    <div className="panel" style={{ margin: "4px 0 8px", padding: 8 }}>
      <MonoLabel>{t("risks.timeline")}</MonoLabel>
      {versions.length === 0 && changes.length === 0 ? (
        <p className="text-muted">{t("risks.timeline.empty")}</p>
      ) : null}
      {versions.map((version, index) => {
        const versionId = text(version, "versionId", "id");
        return (
          <div key={versionId === "" ? `v-${String(index)}` : versionId} className="doc-row">
            <span className="title">
              v{text(version, "versionNo", "version")} ·{" "}
              {truncate(text(version, "content", "summary", "title"), 120)} ·{" "}
              {text(version, "observedAt", "createdAt").slice(0, 10)}
            </span>
          </div>
        );
      })}
      {changes.map((change, index) => {
        const changeId = text(change, "changeId", "id");
        const materiality = text(change, "materiality");
        return (
          <div key={changeId === "" ? `c-${String(index)}` : changeId} className="doc-row">
            <span className="title">{text(change, "summary", "description", "title")}</span>
            {materiality === "" ? null : <span className="tag tag-neutral">{materiality}</span>}
          </div>
        );
      })}
    </div>
  );
}

export function RisksDeepPanel({ projectId }: { projectId: string }) {
  const { t } = useT();
  const info = useServerInfo();
  const client = useQueryClient();
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const tracking = useQuery({
    queryKey: ["tracking", projectId],
    queryFn: () => fetchTracking(projectId),
    enabled: info.data?.insights_store === true,
  });
  const acknowledge = useMutation({
    mutationFn: (alertId: string) => transitionTrackingAlert(projectId, alertId, "acknowledged"),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["tracking", projectId] }),
  });
  const toggleRule = useMutation({
    mutationFn: (input: { ruleId: string; active: boolean }) =>
      updateTrackingWatchRule(projectId, input.ruleId, { active: input.active }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["tracking", projectId] }),
  });

  if (info.isError) return <p className="error-text">{t("common.error")}</p>;
  if (info.data && !info.data.insights_store) {
    return <p className="text-muted">{t("memo.unavailable")}</p>;
  }
  if (tracking.isPending) return <p className="text-muted">{t("common.loading")}</p>;
  if (tracking.isError) return <p className="error-text">{t("common.error")}</p>;

  return (
    <div>
      {tracking.data.items.length === 0 && tracking.data.alerts.length === 0 ? (
        <p className="text-muted">{t("common.empty")}</p>
      ) : null}
      {tracking.data.items.map((item) => {
        const itemId = text(item, "itemId", "id");
        const type = text(item, "itemType", "type");
        const tag = ITEM_TYPE_TAG[type] ?? {
          key: "risks.item" as const,
          className: "tag tag-neutral",
        };
        const expanded = itemId !== "" && expandedItemId === itemId;
        return (
          <div key={itemId}>
            <div
              className="doc-row"
              role="button"
              tabIndex={0}
              style={{ cursor: "pointer" }}
              onClick={() => setExpandedItemId(expanded ? null : itemId)}
              onKeyDown={(event) => {
                if (event.key === "Enter") setExpandedItemId(expanded ? null : itemId);
              }}
            >
              {expanded ? (
                <ChevronDown size={13} style={{ flex: "none" }} />
              ) : (
                <ChevronRight size={13} style={{ flex: "none" }} />
              )}
              <span className={tag.className}>{t(tag.key)}</span>
              <span className="title">{text(item, "title", "summary", "description")}</span>
            </div>
            {expanded ? <ItemTimelineView projectId={projectId} itemId={itemId} /> : null}
          </div>
        );
      })}
      {tracking.data.alerts.map((alert) => {
        const alertId = text(alert, "alertId", "id");
        const status = text(alert, "status");
        const statusKey = ALERT_STATUS_LABEL[status];
        // The backend domain is new | acknowledged | dismissed | snoozed;
        // only new and snoozed can transition to acknowledged.
        const canAcknowledge =
          alertId !== "" && (status === "new" || status === "snoozed");
        return (
          <div key={alertId} className="doc-row">
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
      <div style={{ marginTop: 8 }}>
        <MonoLabel>{t("rules.title")}</MonoLabel>
        {tracking.data.watchRules.length === 0 ? (
          <p className="text-muted">{t("common.empty")}</p>
        ) : null}
        {tracking.data.watchRules.map((rule) => {
          const ruleId = text(rule, "ruleId", "id");
          const active = rule.active === true;
          const minPriority = text(rule, "minPriority");
          return (
            <div key={ruleId} className="doc-row">
              <span className="title">{text(rule, "name", "title")}</span>
              <span className="tag tag-neutral">{text(rule, "targetType")}</span>
              {minPriority === "" ? null : <MonoLabel>{minPriority}</MonoLabel>}
              <span className={active ? "tag tag-accent" : "tag tag-outline"}>
                {t(active ? "rules.active" : "rules.paused")}
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
    </div>
  );
}
