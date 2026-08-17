import { Plus } from "lucide-react";

import { useCreateSession, useProjectSessions } from "../../api/queries";
import { useT } from "../../i18n/useT";
import { useUiStore } from "../../store/ui";

/**
 * Session history for the selected project, docked under the project list in
 * the left rail. Selecting a project scopes this list; selecting a session
 * opens it in the centre workbench.
 */
export function RailSessionList({ projectId }: { projectId: string }) {
  const { t } = useT();
  const sessions = useProjectSessions(projectId);
  const createSession = useCreateSession();
  const expandedSessionId = useUiStore((state) => state.expandedSessionId);
  const expandSession = useUiStore((state) => state.expandSession);

  function newChat() {
    createSession.mutate(
      { projectId },
      { onSuccess: (session) => expandSession(session.id) },
    );
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
        {sessions.data?.length === 0 ? (
          <p className="text-muted" style={{ fontSize: 12, padding: "0 4px" }}>
            {t("rail.noSessions")}
          </p>
        ) : null}
        {sessions.data?.map((session) => (
          <button
            key={session.id}
            className="rail-session"
            aria-current={session.id === expandedSessionId}
            onClick={() => expandSession(session.id)}
          >
            <span className="title">{session.title || session.id}</span>
            <span className="meta">
              {session.status === "running" ? (
                <span className="tag tag-accent">{t("chat.running")}</span>
              ) : null}
              {session.updatedAt.slice(5, 10)}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
