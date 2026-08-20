import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Play, Plus, Sparkles } from "lucide-react";

import { sendMessage } from "../../api/client";
import { ApiError } from "../../api/http";
import { useCreateSession } from "../../api/queries";
import {
  addAssumption,
  completeNode,
  createReport,
  fetchWorkflow,
  listAssumptions,
  listNodeVersions,
  listReports,
  setCurrentNode,
  setWorkflowContext,
  startNode,
  type WorkflowNode,
} from "../../api/workflow";
import { Modal } from "../../components/Modal";
import { MonoLabel } from "../../components/MonoLabel";
import type { DictKey } from "../../i18n/dict";
import { useT } from "../../i18n/useT";
import { useUiStore } from "../../store/ui";

/** Canvas geometry: node coordinates live in a 1560×360 plane (y 100..460). */
const PLANE_WIDTH = 1560;
const NODE_WIDTH = 96;
const PLANE_HEIGHT = 360;
const PLANE_Y_OFFSET = 100;
const CANVAS_HEIGHT = 240;

const WORKFLOW_STATUS_LABEL: Record<string, DictKey> = {
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

function text(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

function StatusTag({ status }: { status: string }) {
  const { t } = useT();
  const key = WORKFLOW_STATUS_LABEL[status];
  return <span className={statusTagClass(status)}>{key ? t(key) : status}</span>;
}

function EmptyLine() {
  const { t } = useT();
  return (
    <p className="text-muted" style={{ fontSize: 12 }}>
      {t("common.empty")}
    </p>
  );
}

export function WorkflowGraph({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const client = useQueryClient();
  const expandSession = useUiStore((state) => state.expandSession);
  const createSession = useCreateSession();

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [completeText, setCompleteText] = useState("");

  // Selection is project-scoped; the completion draft belongs to one node.
  useEffect(() => {
    setSelectedNodeId(null);
  }, [projectId]);
  useEffect(() => {
    setCompleteText("");
  }, [selectedNodeId]);

  const workflow = useQuery({
    queryKey: ["workflow", projectId],
    queryFn: () => fetchWorkflow(projectId),
  });
  const versions = useQuery({
    queryKey: ["workflow-versions", projectId, selectedNodeId],
    queryFn: () => listNodeVersions(projectId, selectedNodeId!),
    enabled: selectedNodeId !== null,
  });
  const assumptions = useQuery({
    queryKey: ["workflow-assumptions", projectId, selectedNodeId],
    queryFn: () => listAssumptions(projectId, selectedNodeId!),
    enabled: selectedNodeId !== null,
  });
  const reports = useQuery({
    queryKey: ["workflow-reports", projectId],
    queryFn: () => listReports(projectId),
  });

  const invalidateWorkflow = (): void =>
    void client.invalidateQueries({ queryKey: ["workflow", projectId] });

  const setCurrent = useMutation({
    mutationFn: (nodeId: string) => setCurrentNode(projectId, nodeId),
    onSuccess: (snapshot) => {
      client.setQueryData(["workflow", projectId], snapshot);
    },
  });
  const start = useMutation({
    mutationFn: (nodeId: string) => startNode(projectId, nodeId),
    onSuccess: invalidateWorkflow,
  });
  const toggleContext = useMutation({
    mutationFn: (nodeIds: string[]) => setWorkflowContext(projectId, nodeIds),
    // The endpoint replaces the whole context; adopt the returned snapshot
    // immediately so a rapid second toggle never computes from a stale list.
    onSuccess: (snapshot) => {
      client.setQueryData(["workflow", projectId], snapshot);
    },
  });
  const complete = useMutation({
    mutationFn: (input: { nodeId: string; outputMarkdown: string }) =>
      completeNode(projectId, input.nodeId, input.outputMarkdown),
    onSuccess: (_snapshot, input) => {
      invalidateWorkflow();
      void client.invalidateQueries({
        queryKey: ["workflow-versions", projectId, input.nodeId],
      });
    },
  });
  const research = useMutation({
    mutationFn: async (node: WorkflowNode) => {
      if (node.status === "ready") {
        try {
          await startNode(projectId, node.nodeId);
        } catch {
          // best-effort: the chat session is still useful when start fails
        }
      }
      const session = await createSession.mutateAsync({
        projectId,
        title: node.title,
      });
      try {
        await sendMessage(session.id, {
          content: `${node.title}：${node.objective || t("workflow.research.prompt")}`,
          clientMessageId: `msg-${crypto.randomUUID()}`,
        });
      } catch {
        // The session already exists — still open it so the user can send
        // manually instead of leaving an orphan and re-creating on retry.
      }
      return session.id;
    },
    onSuccess: (sessionId) => {
      invalidateWorkflow();
      expandSession(sessionId);
      onClose();
    },
  });
  const addAssumptionEntry = useMutation({
    mutationFn: (input: { nodeId: string; content: string }) =>
      addAssumption(projectId, input.nodeId, input.content),
    onSuccess: (_result, input) => {
      invalidateWorkflow();
      void client.invalidateQueries({
        queryKey: ["workflow-assumptions", projectId, input.nodeId],
      });
    },
  });
  const compileReport = useMutation({
    mutationFn: (input: { title: string; markdown: string }) =>
      createReport(projectId, input.title, input.markdown),
    onSuccess: () => {
      invalidateWorkflow();
      void client.invalidateQueries({ queryKey: ["workflow-reports", projectId] });
    },
  });

  // A new action clears feedback left over from previous ones, so a stale
  // 409 banner or the report "queued" note never outlives its context.
  const resetFeedback = (): void => {
    setCurrent.reset();
    start.reset();
    toggleContext.reset();
    complete.reset();
    research.reset();
    addAssumptionEntry.reset();
    compileReport.reset();
  };

  const mutationError =
    setCurrent.error ??
    start.error ??
    toggleContext.error ??
    complete.error ??
    research.error ??
    addAssumptionEntry.error ??
    compileReport.error;

  const data = workflow.data;
  const nodeById = new Map(
    (data?.nodes ?? []).map((node) => [node.nodeId, node] as const),
  );
  const selectedNode =
    selectedNodeId === null ? undefined : nodeById.get(selectedNodeId);
  const contextIds = data?.context.nodeIds ?? [];
  const inContext =
    selectedNode !== undefined && contextIds.includes(selectedNode.nodeId);

  // Latest version (by versionNo) that carries a non-empty markdown output.
  let latestOutput = "";
  let latestOutputNo = -1;
  for (const version of versions.data ?? []) {
    const output =
      typeof version.outputMarkdown === "string" ? version.outputMarkdown : "";
    if (output === "") continue;
    const versionNo =
      typeof version.versionNo === "number" ? version.versionNo : 0;
    if (versionNo > latestOutputNo) {
      latestOutputNo = versionNo;
      latestOutput = output;
    }
  }

  return (
    <Modal title={t("board.workflow")} onClose={onClose} wide>
      {workflow.isPending ? (
        <p className="text-muted">{t("common.loading")}</p>
      ) : null}
      {workflow.isError ? <p className="error-text">{t("common.error")}</p> : null}
      {data ? (
        <>
          <div style={{ overflowX: "auto" }}>
            <div style={{ position: "relative", height: 300, minWidth: 640 }}>
              <svg
                width="100%"
                height={CANVAS_HEIGHT}
                style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
                preserveAspectRatio="none"
                viewBox={`0 0 ${String(PLANE_WIDTH)} ${String(PLANE_HEIGHT)}`}
              >
                {data.dependencies.map((dependency, index) => {
                  const source = nodeById.get(dependency.dependsOnNodeId);
                  const target = nodeById.get(dependency.nodeId);
                  if (!source || !target) return null;
                  return (
                    <line
                      key={`${dependency.dependsOnNodeId}-${dependency.nodeId}-${String(index)}`}
                      x1={source.x + 110}
                      y1={source.y - PLANE_Y_OFFSET + 18}
                      x2={target.x}
                      y2={target.y - PLANE_Y_OFFSET + 18}
                      stroke="#d4d4d8"
                      strokeWidth={3}
                    />
                  );
                })}
              </svg>
              {data.nodes.map((node) => {
                const isCurrent = data.workflow.currentNodeId === node.nodeId;
                const isSelected = selectedNodeId === node.nodeId;
                return (
                  <div
                    key={node.nodeId}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedNodeId(node.nodeId)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") setSelectedNodeId(node.nodeId);
                    }}
                    style={{
                      position: "absolute",
                      left: `calc((100% - ${String(NODE_WIDTH)}px) * ${String(node.x / PLANE_WIDTH)})`,
                      top: ((node.y - PLANE_Y_OFFSET) / PLANE_HEIGHT) * CANVAS_HEIGHT,
                      width: NODE_WIDTH,
                      padding: "4px 6px",
                      borderRadius: 8,
                      background: "var(--color-surface)",
                      boxShadow: "var(--shadow-card)",
                      cursor: "pointer",
                      fontSize: 11,
                      border: isCurrent
                        ? "1.5px solid #006FEE"
                        : "1.5px solid transparent",
                      ...(isSelected
                        ? { outline: "2px solid #006FEE", outlineOffset: 1 }
                        : {}),
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {node.title}
                    </div>
                    <StatusTag status={node.status} />
                  </div>
                );
              })}
            </div>
          </div>

          {mutationError ? (
            <p className="error-text">
              {mutationError instanceof ApiError
                ? mutationError.message
                : t("common.error")}
            </p>
          ) : null}

          {selectedNode ? (
            <div className="panel" style={{ marginTop: 12 }}>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <strong style={{ fontSize: 13 }}>{selectedNode.title}</strong>
                <StatusTag status={selectedNode.status} />
                <span style={{ flex: 1 }} />
                {data.workflow.currentNodeId === selectedNode.nodeId ? null : (
                  <button
                    className="btn btn-ghost"
                    disabled={setCurrent.isPending}
                    onClick={() => { resetFeedback(); setCurrent.mutate(selectedNode.nodeId); }}
                  >
                    {t("workflow.setCurrent")}
                  </button>
                )}
                {selectedNode.status === "ready" ||
                selectedNode.status === "stale" ? (
                  <button
                    className="btn btn-secondary"
                    disabled={start.isPending}
                    onClick={() => { resetFeedback(); start.mutate(selectedNode.nodeId); }}
                  >
                    <Play size={13} /> {t("workflow.start")}
                  </button>
                ) : null}
                <button
                  className="btn btn-primary"
                  disabled={research.isPending}
                  onClick={() => { resetFeedback(); research.mutate(selectedNode); }}
                >
                  <Sparkles size={13} /> {t("workflow.research")}
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={toggleContext.isPending}
                  onClick={() => {
                    resetFeedback();
                    toggleContext.mutate(
                      inContext
                        ? contextIds.filter((id) => id !== selectedNode.nodeId)
                        : [...contextIds, selectedNode.nodeId],
                    );
                  }}
                >
                  {inContext ? t("workflow.context.in") : t("board.toContext")}
                </button>
              </div>

              <div style={{ marginTop: 8 }}>
                <MonoLabel>{t("workflow.objective")}</MonoLabel>
                <p style={{ fontSize: 12, margin: "4px 0" }}>
                  {selectedNode.objective}
                </p>
                {selectedNode.summary === "" ? null : (
                  <p className="text-muted" style={{ fontSize: 12, margin: "4px 0" }}>
                    {selectedNode.summary}
                  </p>
                )}
              </div>

              {selectedNode.status === "running" ? (
                <div
                  style={{
                    marginTop: 8,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    alignItems: "flex-start",
                  }}
                >
                  <textarea
                    className="input"
                    rows={5}
                    placeholder={t("workflow.complete.placeholder")}
                    value={completeText}
                    onChange={(event) => setCompleteText(event.target.value)}
                    style={{ width: "100%", resize: "vertical" }}
                  />
                  <button
                    className="btn btn-primary"
                    disabled={completeText.trim() === "" || complete.isPending}
                    onClick={() => {
                      resetFeedback();
                      complete.mutate({
                        nodeId: selectedNode.nodeId,
                        outputMarkdown: completeText.trim(),
                      });
                    }}
                  >
                    {t("workflow.complete")}
                  </button>
                </div>
              ) : null}

              <div style={{ marginTop: 10 }}>
                <MonoLabel>{t("workflow.versions")}</MonoLabel>
                {versions.isPending ? (
                  <p className="text-muted">{t("common.loading")}</p>
                ) : null}
                {versions.isError ? (
                  <p className="error-text">{t("common.error")}</p>
                ) : null}
                {versions.data?.length === 0 ? <EmptyLine /> : null}
                {versions.data?.map((version, index) => {
                  const versionId = text(version, "versionId", "id");
                  return (
                    <div
                      key={versionId === "" ? String(index) : versionId}
                      className="doc-row"
                    >
                      <span className="title">
                        v{text(version, "versionNo", "version")} ·{" "}
                        {text(version, "status")} ·{" "}
                        {text(version, "createdAt").slice(0, 10)}
                      </span>
                    </div>
                  );
                })}
                {latestOutput === "" ? null : (
                  <div style={{ marginTop: 6 }}>
                    <MonoLabel>{t("workflow.output")}</MonoLabel>
                    <pre
                      style={{
                        whiteSpace: "pre-wrap",
                        fontSize: 12,
                        maxHeight: 200,
                        overflow: "auto",
                      }}
                    >
                      {latestOutput}
                    </pre>
                  </div>
                )}
              </div>

              <div style={{ marginTop: 10 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <MonoLabel>{t("workflow.assumptions")}</MonoLabel>
                  <button
                    className="btn btn-ghost"
                    disabled={addAssumptionEntry.isPending}
                    onClick={() => {
                      const content = window.prompt(t("workflow.assumption.prompt"));
                      if (content?.trim()) {
                        resetFeedback();
                        addAssumptionEntry.mutate({
                          nodeId: selectedNode.nodeId,
                          content: content.trim(),
                        });
                      }
                    }}
                  >
                    <Plus size={13} /> {t("workflow.assumption.add")}
                  </button>
                </div>
                {assumptions.isPending ? (
                  <p className="text-muted">{t("common.loading")}</p>
                ) : null}
                {assumptions.isError ? (
                  <p className="error-text">{t("common.error")}</p>
                ) : null}
                {assumptions.data?.length === 0 ? <EmptyLine /> : null}
                {assumptions.data?.map((assumption, index) => {
                  const assumptionId = text(assumption, "assumptionId", "id");
                  return (
                    <div
                      key={assumptionId === "" ? String(index) : assumptionId}
                      className="doc-row"
                    >
                      <span className="title">{text(assumption, "content")}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div style={{ marginTop: 12 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <MonoLabel>{t("workflow.reports")}</MonoLabel>
              <button
                className="btn btn-secondary"
                disabled={compileReport.isPending}
                onClick={() => {
                  const title = window.prompt(t("workflow.report.prompt"));
                  if (!title?.trim()) return;
                  resetFeedback();
                  const sections = [...data.nodes]
                    .sort((a, b) => a.positionNo - b.positionNo)
                    .filter((node) => node.summary !== "")
                    .map((node) => `## ${node.title}\n\n${node.summary}`);
                  compileReport.mutate({
                    title: title.trim(),
                    markdown: `# ${title.trim()}\n\n${sections.join("\n\n")}`,
                  });
                }}
              >
                <FileText size={13} /> {t("workflow.report.create")}
              </button>
            </div>
            {compileReport.isSuccess ? (
              <p className="text-muted" style={{ fontSize: 12 }}>
                {t("common.queued")}
              </p>
            ) : null}
            {reports.isPending ? (
              <p className="text-muted">{t("common.loading")}</p>
            ) : null}
            {reports.isError ? (
              <p className="error-text">{t("common.error")}</p>
            ) : null}
            {reports.data?.length === 0 ? <EmptyLine /> : null}
            {reports.data?.map((report, index) => {
              const reportId = text(report, "reportId", "id");
              return (
                <div
                  key={reportId === "" ? String(index) : reportId}
                  className="doc-row"
                >
                  <span className="title">{text(report, "title")}</span>
                  <MonoLabel>
                    v{text(report, "currentVersionNo", "versionNo")}
                  </MonoLabel>
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </Modal>
  );
}
