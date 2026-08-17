import { useRef, useState, type DragEvent } from "react";
import { Plus, UploadCloud } from "lucide-react";

import { uploadProjectDocuments, type Session } from "../../api/client";
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

function UploadZone({ projectId }: { projectId: string }) {
  const { t } = useT();
  const client = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [state, setState] = useState<"idle" | "uploading" | "done" | "failed">("idle");

  async function upload(files: File[]) {
    if (files.length === 0) return;
    setState("uploading");
    try {
      await uploadProjectDocuments(projectId, files);
      setState("done");
      await client.invalidateQueries({ queryKey: ["documents", projectId] });
    } catch {
      setState("failed");
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
        <UploadCloud size={22} strokeWidth={1.5} />
        <strong>{t("workbench.upload.hint")}</strong>
        <MonoLabel>{t("workbench.upload.types")}</MonoLabel>
        <button
          className="btn btn-secondary"
          onClick={() => inputRef.current?.click()}
          disabled={state === "uploading"}
        >
          {state === "uploading" ? t("workbench.upload.uploading") : t("workbench.upload.choose")}
        </button>
        {state === "done" ? <MonoLabel>{t("workbench.upload.done")}</MonoLabel> : null}
        {state === "failed" ? <span className="error-text">{t("workbench.upload.failed")}</span> : null}
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

function ChatCard({ session, onOpen }: { session: Session; onOpen: () => void }) {
  const { t } = useT();
  return (
    <Blueprint className="chat-card">
      <button className="rail-project" onClick={onOpen}>
        <span className="card-kicker">
          {session.status === "running" ? t("chat.running") : session.status.toUpperCase()}
        </span>
        <span className="card-title">{session.title || session.id}</span>
        <span className="card-meta">
          {session.lastSequence} {t("workbench.msgs")} · {session.updatedAt.slice(5, 10)}
        </span>
      </button>
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
      </div>

      <UploadZone projectId={projectId} />

      <section aria-label={t("workbench.chats")}>
        <div className="panel-title">
          <span>{t("workbench.chats")}</span>
          <button className="btn btn-secondary" onClick={newChat} disabled={createSession.isPending}>
            <Plus size={14} strokeWidth={1.5} /> {t("workbench.newChat")}
          </button>
        </div>
        {sessions.isPending ? <p className="text-muted">{t("common.loading")}</p> : null}
        <div className="chat-cards">
          {sessions.data?.map((session) => (
            <ChatCard key={session.id} session={session} onOpen={() => expandSession(session.id)} />
          ))}
        </div>
      </section>

      {expanded ? (
        <ChatView session={expanded} />
      ) : (
        <div className="center-placeholder">{t("workbench.chat.empty")}</div>
      )}
    </main>
  );
}
