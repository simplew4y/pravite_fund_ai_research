import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Pencil, Plus, Trash2 } from "lucide-react";

import { deleteSession, updateSession, type Session } from "../../api/client";
import { ApiError } from "../../api/http";
import { useCreateSession, useProjectSessions } from "../../api/queries";
import { useT } from "../../i18n/useT";
import { useUiStore } from "../../store/ui";

/**
 * Session history for the selected project, docked under the project list in
 * the left rail. Selecting a project scopes this list; selecting a session
 * opens it in the centre workbench. Rows carry rename / archive / delete
 * actions; archived sessions are hidden behind the toggle.
 */
export function RailSessionList({ projectId }: { projectId: string }) {
  const { t } = useT();
  const client = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const sessions = useProjectSessions(projectId, showArchived);
  const createSession = useCreateSession();
  const expandedSessionId = useUiStore((state) => state.expandedSessionId);
  const expandSession = useUiStore((state) => state.expandSession);
  const [actionError, setActionError] = useState<string | null>(null);

  function newChat() {
    createSession.mutate(
      { projectId },
      { onSuccess: (session) => expandSession(session.id) },
    );
  }

  function surface(error: unknown) {
    setActionError(error instanceof ApiError ? error.message : t("common.error"));
  }

  const invalidate = () =>
    void client.invalidateQueries({ queryKey: ["sessions", projectId] });

  const rename = useMutation({
    mutationFn: (input: { sessionId: string; title: string }) =>
      updateSession(input.sessionId, { title: input.title }),
    onSuccess: invalidate,
    onError: surface,
  });
  const archive = useMutation({
    mutationFn: (input: { sessionId: string; archived: boolean }) =>
      updateSession(input.sessionId, { archived: input.archived }),
    onSuccess: (updated: Session) => {
      invalidate();
      if (updated.archivedAt !== null && updated.id === expandedSessionId) {
        expandSession(null);
      }
    },
    onError: surface,
  });
  const remove = useMutation({
    mutationFn: (sessionId: string) => deleteSession(sessionId),
    onSuccess: (_result, sessionId) => {
      invalidate();
      if (sessionId === expandedSessionId) expandSession(null);
    },
    onError: surface,
  });

  function onRename(session: Session) {
    const title = window.prompt(t("session.rename"), session.title);
    if (title !== null && title.trim() && title !== session.title) {
      setActionError(null);
      rename.mutate({ sessionId: session.id, title: title.trim() });
    }
  }

  return (
    <section className="rail-sessions" aria-label={t("workbench.chats")}>
      <div className="rail-section-title">
        <span>{t("workbench.chats")}</span>
        {sessions.data !== undefined ? (
          <span className="count">{sessions.data.length}</span>
        ) : null}
        <span style={{ flex: 1 }} />
        <button
          className="btn btn-quiet"
          style={{ height: 22, padding: "0 6px", fontSize: 11 }}
          aria-pressed={showArchived}
          title={t("session.showArchived")}
          onClick={() => setShowArchived((current) => !current)}
        >
          <Archive size={12} />
        </button>
        <button
          className="btn btn-quiet"
          style={{ width: 26, height: 26, borderRadius: 9 }}
          title={t("workbench.newChat")}
          aria-label={t("workbench.newChat")}
          onClick={newChat}
          disabled={createSession.isPending}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="rail-session-list">
        {sessions.isPending ? (
          <p className="text-muted" style={{ fontSize: 12, padding: "0 4px" }}>
            {t("common.loading")}
          </p>
        ) : null}
        {sessions.isError ? (
          <p className="error-text" style={{ fontSize: 12, padding: "0 4px" }}>
            {t("common.error")}
          </p>
        ) : null}
        {actionError ? (
          <p className="error-text" style={{ fontSize: 12, padding: "0 4px" }}>
            {actionError}
          </p>
        ) : null}
        {sessions.data?.length === 0 ? (
          <p className="text-muted" style={{ fontSize: 12, padding: "0 4px" }}>
            {t("rail.noSessions")}
          </p>
        ) : null}
        {sessions.data?.map((session) => {
          const archived = session.archivedAt !== null;
          return (
            <div
              key={session.id}
              className="rail-session"
              role="button"
              tabIndex={0}
              aria-current={session.id === expandedSessionId}
              style={archived ? { opacity: 0.6 } : undefined}
              onClick={() => expandSession(session.id)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter") expandSession(session.id);
              }}
            >
              <span className="title">{session.title || session.id}</span>
              <span className="meta">
                {session.status === "running" ? (
                  <span className="tag tag-accent">{t("chat.running")}</span>
                ) : null}
                {session.status === "interrupted" ? (
                  <span className="tag tag-neutral">{t("chat.interrupted")}</span>
                ) : null}
                {session.status === "failed" ? (
                  <span className="tag tag-outline">{t("chat.failed")}</span>
                ) : null}
                {archived ? (
                  <span className="tag tag-neutral">{t("session.archived")}</span>
                ) : null}
                {session.updatedAt.slice(5, 10)}
                <button
                  className="btn btn-quiet"
                  style={{ width: 20, height: 20 }}
                  title={t("session.rename")}
                  aria-label={t("session.rename")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRename(session);
                  }}
                >
                  <Pencil size={11} />
                </button>
                <button
                  className="btn btn-quiet"
                  style={{ width: 20, height: 20 }}
                  title={archived ? t("session.unarchive") : t("session.archive")}
                  aria-label={archived ? t("session.unarchive") : t("session.archive")}
                  onClick={(event) => {
                    event.stopPropagation();
                    setActionError(null);
                    archive.mutate({ sessionId: session.id, archived: !archived });
                  }}
                >
                  {archived ? <ArchiveRestore size={11} /> : <Archive size={11} />}
                </button>
                <button
                  className="btn btn-quiet danger"
                  style={{ width: 20, height: 20 }}
                  title={t("session.delete")}
                  aria-label={t("session.delete")}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (window.confirm(t("session.delete.confirm"))) {
                      setActionError(null);
                      remove.mutate(session.id);
                    }
                  }}
                >
                  <Trash2 size={11} />
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
