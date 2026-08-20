import { useQuery } from "@tanstack/react-query";
import { Workflow } from "lucide-react";

import { useServerInfo } from "../../api/queries";
import { fetchWorkflow } from "../../api/workflow";
import { MonoLabel } from "../../components/MonoLabel";
import type { DictKey } from "../../i18n/dict";
import { useT } from "../../i18n/useT";

const STATUS_LABEL: Record<string, DictKey> = {
  pending: "workflow.status.pending",
  ready: "workflow.status.ready",
  running: "workflow.status.running",
  completed: "workflow.status.completed",
  stale: "workflow.status.stale",
  failed: "workflow.status.failed",
};

function statusTagClass(status: string): string {
  if (status === "completed" || status === "running") return "tag tag-accent";
  if (status === "ready" || status === "failed") return "tag tag-outline";
  return "tag tag-neutral";
}

/**
 * Compact summary of the fixed 9-node research workflow for the right board:
 * completion progress plus one row per node. The full graph view is a modal
 * owned by the caller — `onOpen` asks it to open.
 */
export function WorkflowPanel({
  projectId,
  onOpen,
}: {
  projectId: string;
  onOpen: () => void;
}) {
  const { t } = useT();
  const info = useServerInfo();
  const workflow = useQuery({
    queryKey: ["workflow", projectId],
    queryFn: () => fetchWorkflow(projectId),
    enabled: info.data?.workflow_store === true,
  });

  if (info.isError) return <p className="error-text">{t("common.error")}</p>;
  if (info.data && info.data.workflow_store !== true) {
    return <p className="text-muted">{t("workflow.unavailable")}</p>;
  }
  if (workflow.isPending) return <p className="text-muted">{t("common.loading")}</p>;
  if (workflow.isError) return <p className="error-text">{t("common.error")}</p>;

  const snapshot = workflow.data;
  const nodes = [...snapshot.nodes].sort((a, b) => a.positionNo - b.positionNo);
  const completed = nodes.filter((node) => node.status === "completed").length;

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <MonoLabel>
          {completed}/{nodes.length}
        </MonoLabel>
        <button className="btn btn-secondary" onClick={onOpen}>
          <Workflow size={13} /> {t("workflow.open")}
        </button>
      </div>
      {nodes.length === 0 ? <p className="text-muted">{t("common.empty")}</p> : null}
      {nodes.map((node) => {
        const statusKey = STATUS_LABEL[node.status];
        return (
          <div key={node.nodeId} className="doc-row">
            <span className="title">{node.title}</span>
            <span className={statusTagClass(node.status)}>
              {statusKey ? t(statusKey) : node.status}
            </span>
            {snapshot.workflow.currentNodeId === node.nodeId ? (
              <span className="tag tag-accent">{t("workflow.current")}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
