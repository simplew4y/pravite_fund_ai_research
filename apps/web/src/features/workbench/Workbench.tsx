import { useRef, useState, type DragEvent } from "react";
import { Plus, Send, Sparkles, Upload, UploadCloud } from "lucide-react";

import { sendMessage, uploadProjectDocuments, type Session } from "../../api/client";
import { ApiError } from "../../api/http";
import {
  useCreateSession,
  useProjectDocuments,
  useProjects,
  useProjectSessions,
} from "../../api/queries";
import { Blueprint } from "../../components/Blueprint";
import { MonoLabel } from "../../components/MonoLabel";
import { useT } from "../../i18n/useT";
import { useUiStore } from "../../store/ui";
import { ChatView } from "../chat/ChatView";
import { useQueryClient } from "@tanstack/react-query";

const ACCEPT = ".pdf,.xlsx,.xlsm,.docx,.pptx,.csv,.md,.markdown,.txt";
const ACCEPTED_EXTENSIONS = new Set(
  ACCEPT.split(",").map((extension) => extension.trim().toLowerCase()),
);
/** apps/api caps a project upload batch at four files. */
const MAX_BATCH_FILES = 4;

function partitionUploads(files: File[]): {
  accepted: File[];
  rejected: string[];
} {
  const accepted: File[] = [];
  const rejected: string[] = [];
  for (const file of files) {
    const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!ACCEPTED_EXTENSIONS.has(extension)) rejected.push(file.name);
    else if (accepted.length >= MAX_BATCH_FILES) rejected.push(file.name);
    else accepted.push(file);
  }
  return { accepted, rejected };
}

function UploadZone({ projectId }: { projectId: string }) {
  const { t } = useT();
  const client = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [state, setState] = useState<"idle" | "uploading" | "done" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);

  async function upload(files: File[]) {
    if (files.length === 0) return;
    const { accepted, rejected } = partitionUploads(files);
    if (accepted.length === 0) {
      setState("failed");
      setError(`${t("workbench.upload.rejected")}: ${rejected.join("、")}`);
      return;
    }
    setState("uploading");
    setError(null);
    try {
      await uploadProjectDocuments(projectId, accepted);
      setState("done");
      setError(
        rejected.length > 0
          ? `${t("workbench.upload.rejected")}: ${rejected.join("、")}`
          : null,
      );
      await client.invalidateQueries({ queryKey: ["documents", projectId] });
    } catch (uploadError) {
      setState("failed");
      setError(
        uploadError instanceof ApiError ? uploadError.message : null,
      );
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    void upload([...event.dataTransfer.files]);
  }

  return (
    <Blueprint>
      <div
        className={dragging ? "upload-zone dragging" : "upload-zone"}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <UploadCloud size={22} />
        <strong>{t("workbench.upload.hint")}</strong>
        <MonoLabel>{t("workbench.upload.types")}</MonoLabel>
        <button
          className="btn btn-secondary"
          onClick={() => inputRef.current?.click()}
          disabled={state === "uploading"}
        >
          {state === "uploading" ? t("workbench.upload.uploading") : t("workbench.upload.choose")}
        </button>
        {state === "done" ? (
          <MonoLabel>
            {t("workbench.upload.done")}
            {error ? ` · ${error}` : ""}
          </MonoLabel>
        ) : null}
        {state === "failed" ? (
          <span className="error-text">
            {t("workbench.upload.failed")}
            {error ? ` · ${error}` : ""}
          </span>
        ) : null}
        <input
          ref={inputRef}
          type="file"
          hidden
          multiple
          accept={ACCEPT}
          onChange={(event) => {
            void upload([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
      </div>
    </Blueprint>
  );
}

export function Workbench({ projectId }: { projectId: string }) {
  const { t } = useT();
  const projects = useProjects();
  const documents = useProjectDocuments(projectId);
  const sessions = useProjectSessions(projectId);
  const createSession = useCreateSession();
  const { expandedSessionId, expandSession } = useUiStore();
  const client = useQueryClient();
  const headerUploadRef = useRef<HTMLInputElement>(null);
  const [newDraft, setNewDraft] = useState("");
  const [starting, setStarting] = useState(false);

  async function startResearch(content: string) {
    if (starting) return;
    setStarting(true);
    try {
      const session = await createSession.mutateAsync({
        projectId,
        title: content.slice(0, 60),
      });
      await sendMessage(session.id, {
        content,
        clientMessageId: `msg-${crypto.randomUUID()}`,
      });
      setNewDraft("");
      expandSession(session.id);
    } finally {
      setStarting(false);
    }
  }

  const [headerUploadState, setHeaderUploadState] = useState<
    "idle" | "uploading" | "failed"
  >("idle");
  const [headerUploadError, setHeaderUploadError] = useState<string | null>(null);

  async function headerUpload(files: File[]) {
    if (files.length === 0) return;
    const { accepted, rejected } = partitionUploads(files);
    if (accepted.length === 0) {
      setHeaderUploadState("failed");
      setHeaderUploadError(`${t("workbench.upload.rejected")}: ${rejected.join("、")}`);
      return;
    }
    setHeaderUploadState("uploading");
    setHeaderUploadError(null);
    try {
      await uploadProjectDocuments(projectId, accepted);
      setHeaderUploadState("idle");
      await client.invalidateQueries({ queryKey: ["documents", projectId] });
    } catch (error) {
      setHeaderUploadState("failed");
      setHeaderUploadError(
        error instanceof ApiError ? error.message : t("workbench.upload.failed"),
      );
    }
  }

  const project = projects.data?.find((candidate) => candidate.id === projectId);
  const expanded = sessions.data?.find((candidate) => candidate.id === expandedSessionId);

  function newChat() {
    createSession.mutate(
      { projectId },
      { onSuccess: (session) => expandSession(session.id) },
    );
  }

  return (
    <main className="app-center">
      <div className="center-header">
        <h1>{project?.name ?? projectId}</h1>
        <MonoLabel>
          {documents.data?.total ?? "–"} {t("rail.docs")} · {sessions.data?.length ?? "–"}{" "}
          {t("rail.chats")}
        </MonoLabel>
        <span style={{ flex: 1 }} />
        <button
          className="btn btn-quiet"
          style={{ width: 36, height: 36 }}
          title={t("workbench.upload")}
          aria-label={t("workbench.upload")}
          onClick={() => headerUploadRef.current?.click()}
          disabled={headerUploadState === "uploading"}
        >
          <Upload size={16} />
        </button>
        <button
          className="btn btn-icon btn-primary"
          title={t("workbench.newChat")}
          aria-label={t("workbench.newChat")}
          onClick={newChat}
          disabled={createSession.isPending}
        >
          <Plus size={16} />
        </button>
        <input
          ref={headerUploadRef}
          type="file"
          hidden
          multiple
          accept={ACCEPT}
          onChange={(event) => {
            void headerUpload([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
      </div>

      {headerUploadState !== "idle" ? (
        <p
          className={headerUploadState === "failed" ? "error-text" : "text-muted"}
          style={{ padding: "0 22px", margin: "8px 0 0" }}
        >
          {headerUploadState === "uploading"
            ? t("workbench.upload.uploading")
            : headerUploadError}
        </p>
      ) : null}

      <div className="center-body">
        {expanded ? (
          <ChatView session={expanded} />
        ) : (
          <>
            <UploadZone projectId={projectId} />
            <Blueprint className="chat-view">
              <div className="center-placeholder" style={{ padding: 20 }}>
                <Sparkles size={26} color="#a1a1aa" />
                <span>{t("workbench.askCorpus")}</span>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", maxWidth: 520 }}>
                  {(["workbench.suggest.vbp", "workbench.suggest.pipeline", "workbench.suggest.quarter"] as const).map(
                    (key) => (
                      <button key={key} className="suggestion-chip" onClick={() => void startResearch(t(key))}>
                        {t(key)}
                      </button>
                    ),
                  )}
                </div>
              </div>
              <div className="chat-footer" style={{ borderTop: 0 }}>
                <form
                  className="composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (newDraft.trim()) void startResearch(newDraft.trim());
                  }}
                >
                  <textarea
                    placeholder={t("workbench.askCorpus")}
                    rows={1}
                    value={newDraft}
                    onChange={(event) => setNewDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        if (newDraft.trim()) void startResearch(newDraft.trim());
                      }
                    }}
                  />
                  <button
                    className="btn btn-primary btn-send"
                    type="submit"
                    title={t("chat.send")}
                    aria-label={t("chat.send")}
                    disabled={!newDraft.trim() || starting}
                  >
                    <Send size={15} />
                  </button>
                </form>
              </div>
            </Blueprint>
          </>
        )}
      </div>
    </main>
  );
}
