import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, RefreshCw, Trash2 } from "lucide-react";

import { deleteDocuments } from "../../api/client";
import {
  addDocumentToSession,
  compareMemoVersions,
  fetchTracking,
  fetchValuation,
  memoDownloadUrl,
  runTracking,
  runValuation,
  transitionTrackingAlert,
} from "../../api/insights";
import { useProjectDocuments, useServerInfo } from "../../api/queries";
import { Blueprint } from "../../components/Blueprint";
import { MonoLabel } from "../../components/MonoLabel";
import type { DictKey } from "../../i18n/dict";
import { useT } from "../../i18n/useT";
import { useUiStore } from "../../store/ui";

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

function DocumentsPanel({ projectId }: { projectId: string }) {
  const { t } = useT();
  const client = useQueryClient();
  const documents = useProjectDocuments(projectId);
  const expandedSessionId = useUiStore((state) => state.expandedSessionId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");

  // Selection is project-scoped: keeping it across a project switch would
  // delete or attach documents that belong to another project.
  useEffect(() => {
    setSelected(new Set());
    setFilter("");
  }, [projectId]);

  const remove = useMutation({
    mutationFn: () => deleteDocuments(projectId, [...selected]),
    onSuccess: () => {
      setSelected(new Set());
      void client.invalidateQueries({ queryKey: ["documents", projectId] });
    },
  });

  const addToContext = useMutation({
    mutationFn: async () => {
      for (const documentId of selected) {
        await addDocumentToSession(expandedSessionId!, documentId);
      }
      setSelected(new Set());
    },
  });

  function toggle(documentId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(documentId)) next.delete(documentId);
      else next.add(documentId);
      return next;
    });
  }

  const rows = documents.data?.items.filter(
    (document) => !filter || document.title.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div>
      <input
        className="input"
        placeholder={t("docs.search")}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      {documents.isPending ? <p className="text-muted">{t("common.loading")}</p> : null}
      {documents.isError ? <p className="error-text">{t("common.error")}</p> : null}
      {remove.isError || addToContext.isError ? (
        <p className="error-text">{t("common.error")}</p>
      ) : null}
      {rows?.map((document) => (
        <label
          key={document.id}
          className={selected.has(document.id) ? "doc-row selected" : "doc-row"}
        >
          <input
            type="checkbox"
            checked={selected.has(document.id)}
            onChange={() => toggle(document.id)}
          />
          <FileText size={15} color="#71717a" style={{ flex: "none" }} />
          <span className="title">{document.title}</span>
          {document.currentVersionNo === 0 ? (
            <span className="tag tag-neutral">{t("docs.indexing")}</span>
          ) : null}
          <span className="date">{document.updatedAt.slice(5, 10)}</span>
        </label>
      ))}
      {rows?.length === 0 ? <p className="text-muted">{t("common.empty")}</p> : null}
      {selected.size > 0 ? (
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
          <MonoLabel>
            {selected.size} {t("board.selected")}
          </MonoLabel>
          {expandedSessionId ? (
            <button
              className="btn btn-primary"
              onClick={() => addToContext.mutate()}
              disabled={addToContext.isPending}
            >
              {t("board.toContext")}
            </button>
          ) : null}
          <button
            className="btn btn-ghost"
            onClick={() => {
              if (window.confirm(t("docs.delete.confirm"))) remove.mutate();
            }}
            disabled={remove.isPending}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function MemoPanel({ projectId }: { projectId: string }) {
  const { t } = useT();
  const info = useServerInfo();
  const tracking = useQuery({
    queryKey: ["tracking", projectId],
    queryFn: () => fetchTracking(projectId),
    enabled: info.data?.insights_store === true,
  });
  const [compareFrom, setCompareFrom] = useState<string | null>(null);
  const compare = useMutation({
    mutationFn: (input: { from: string; to: string }) =>
      compareMemoVersions(projectId, input.from, input.to),
  });
  const resetCompare = compare.reset;
  useEffect(() => {
    setCompareFrom(null);
    resetCompare();
  }, [projectId, resetCompare]);

  if (info.isError) return <p className="error-text">{t("common.error")}</p>;
  if (info.data && !info.data.insights_store) {
    return <p className="text-muted">{t("memo.unavailable")}</p>;
  }
  if (tracking.isPending) return <p className="text-muted">{t("common.loading")}</p>;
  if (tracking.isError) return <p className="error-text">{t("common.error")}</p>;

  const versions = tracking.data.memoVersions;
  return (
    <div>
      <MonoLabel>{t("memo.versions")}</MonoLabel>
      {versions.length === 0 ? <p className="text-muted">{t("common.empty")}</p> : null}
      {versions.map((version) => {
        const id = text(version, "memoVersionId", "id", "versionId");
        return (
          <div key={id} className="doc-row">
            <span className="title">
              v{text(version, "versionNo", "version")} · {text(version, "title", "topic")}
            </span>
            <button
              className="btn btn-ghost"
              disabled={id === ""}
              onClick={() => {
                if (compareFrom === null) setCompareFrom(id);
                else {
                  compare.mutate({ from: compareFrom, to: id });
                  setCompareFrom(null);
                }
              }}
            >
              {compareFrom === null ? t("memo.compare") : `→ ${t("memo.compare")}`}
            </button>
            {id === "" ? null : (
              <a
                className="btn btn-icon btn-ghost"
                href={memoDownloadUrl(projectId, id)}
                target="_blank"
                rel="noopener"
                title={t("common.download")}
              >
                <Download size={14} />
              </a>
            )}
          </div>
        );
      })}
      {compare.isError ? <p className="error-text">{t("common.error")}</p> : null}
      {compare.data ? (
        <Blueprint className="panel" style={{ marginTop: 8 }}>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: 0 }}>
            {JSON.stringify(compare.data, null, 2)}
          </pre>
        </Blueprint>
      ) : null}
    </div>
  );
}

function ValuationPanel({ projectId }: { projectId: string }) {
  const { t } = useT();
  const info = useServerInfo();
  const client = useQueryClient();
  const valuation = useQuery({
    queryKey: ["valuation", projectId],
    queryFn: () => fetchValuation(projectId),
    enabled: info.data?.insights_store === true,
  });
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

  if (info.isError) return <p className="error-text">{t("common.error")}</p>;
  if (info.data && !info.data.insights_store) {
    return <p className="text-muted">{t("memo.unavailable")}</p>;
  }
  if (valuation.isPending) return <p className="text-muted">{t("common.loading")}</p>;
  if (valuation.isError) return <p className="error-text">{t("common.error")}</p>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <MonoLabel>{t("board.valuation")}</MonoLabel>
        <button className="btn btn-secondary" onClick={() => run.mutate()} disabled={run.isPending}>
          <RefreshCw size={14} /> {t("valuation.run")}
        </button>
      </div>
      {run.isError ? <p className="error-text">{t("common.error")}</p> : null}
      {run.isSuccess ? (
        <p className="text-muted" style={{ fontSize: 12 }}>
          {t("valuation.queued")}
        </p>
      ) : null}
      {valuation.data.series.length === 0 ? (
        <p className="text-muted">{t("common.empty")}</p>
      ) : null}
      {valuation.data.series.map((series) => (
        <div key={text(series, "id", "seriesId")} className="doc-row">
          <span className="title">{text(series, "name", "title", "id")}</span>
          <MonoLabel>
            {typeof series.currentVersionNo === "number" &&
            series.currentVersionNo > 0
              ? `v${String(series.currentVersionNo)}`
              : t("common.missing")}
          </MonoLabel>
        </div>
      ))}
      {valuation.data.derivedModels.length > 0 ? (
        <p className="text-muted" style={{ fontSize: 12 }}>
          {t("valuation.derived.pending")} · {valuation.data.derivedModels.length}
        </p>
      ) : null}
    </div>
  );
}

function RisksPanel({ projectId }: { projectId: string }) {
  const { t } = useT();
  const info = useServerInfo();
  const client = useQueryClient();
  const tracking = useQuery({
    queryKey: ["tracking", projectId],
    queryFn: () => fetchTracking(projectId),
    enabled: info.data?.insights_store === true,
  });
  const acknowledge = useMutation({
    mutationFn: (alertId: string) => transitionTrackingAlert(projectId, alertId, "acknowledged"),
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
        const type = text(item, "itemType", "type");
        const tag = ITEM_TYPE_TAG[type] ?? {
          key: "risks.item" as const,
          className: "tag tag-neutral",
        };
        return (
          <div key={text(item, "itemId", "id")} className="doc-row">
            <span className={tag.className}>{t(tag.key)}</span>
            <span className="title">{text(item, "title", "summary", "description")}</span>
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
    </div>
  );
}

export function ResearchBoard({ projectId }: { projectId: string }) {
  const { t } = useT();

  return (
    <aside className="app-board">
      <div className="board-title">{t("board.title")}</div>
      <section className="board-section" aria-label={t("board.documents")}>
        <h4>{t("board.documents")}</h4>
        <DocumentsPanel projectId={projectId} />
      </section>
      <section className="board-section" aria-label={t("board.memo")}>
        <h4>{t("board.memo")}</h4>
        <MemoPanel projectId={projectId} />
      </section>
      <section className="board-section" aria-label={t("board.valuation")}>
        <h4>{t("board.valuation")}</h4>
        <ValuationPanel projectId={projectId} />
      </section>
      <section className="board-section" aria-label={t("board.risks")}>
        <h4>{t("board.risks")}</h4>
        <RisksPanel projectId={projectId} />
      </section>
    </aside>
  );
}
