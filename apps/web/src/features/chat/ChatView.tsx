import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronsDownUp, GitFork, Send, Square } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { forkSession, interruptSession, sendMessage, type Session } from "../../api/client";
import { Blueprint } from "../../components/Blueprint";
import { MonoLabel } from "../../components/MonoLabel";
import { useT } from "../../i18n/useT";
import { useUiStore } from "../../store/ui";
import { useSessionStream } from "./useSessionStream";
import type { TranscriptMessage } from "./transcript";

function Message({ message }: { message: TranscriptMessage }) {
  const { t } = useT();
  const [showThinking, setShowThinking] = useState(false);
  if (message.kind === "user") {
    return (
      <div className="msg msg-user">
        <MonoLabel>{t("chat.me")}</MonoLabel>
        <pre>{message.text}</pre>
      </div>
    );
  }
  return (
    <div className="msg msg-assistant">
      <MonoLabel>RESEARCHER-01</MonoLabel>
      {message.thinking ? (
        <div>
          <button className="btn btn-ghost" onClick={() => setShowThinking((value) => !value)}>
            {t("chat.reasoning")}
          </button>
          {showThinking ? <pre className="text-muted">{message.thinking}</pre> : null}
        </div>
      ) : null}
      {message.tools.map((tool) => (
        <div key={tool.toolCallId} className="tool-line">
          TOOL · {tool.toolName} · {tool.status}
        </div>
      ))}
      {message.text ? <pre>{message.text}</pre> : null}
    </div>
  );
}

export function ChatView({ session }: { session: Session }) {
  const { t } = useT();
  const client = useQueryClient();
  const expandSession = useUiStore((state) => state.expandSession);
  const transcript = useSessionStream(session.id);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [transcript.messages]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setSendError(false);
    try {
      // clientMessageId lets the API queue the prompt when a turn is running.
      await sendMessage(session.id, {
        content,
        clientMessageId: `msg-${crypto.randomUUID()}`,
      });
      setDraft("");
    } catch {
      setSendError(true);
    } finally {
      setSending(false);
    }
  }

  async function fork() {
    const forked = await forkSession(session.id);
    await client.invalidateQueries({ queryKey: ["sessions", session.projectId] });
    expandSession(forked.id);
  }

  return (
    <Blueprint className="chat-view panel elev-sm">
      <div className="panel-title">
        <span>{session.title || session.id}</span>
        <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <MonoLabel>{transcript.running ? t("chat.running") : t("chat.idle")}</MonoLabel>
          {transcript.running ? (
            <button
              className="btn btn-icon btn-ghost"
              title={t("chat.stop")}
              onClick={() => void interruptSession(session.id)}
            >
              <Square size={14} />
            </button>
          ) : null}
          <button className="btn btn-icon btn-ghost" title={t("chat.fork")} onClick={() => void fork()}>
            <GitFork size={14} />
          </button>
          <button
            className="btn btn-icon btn-ghost"
            title={t("chat.collapse")}
            onClick={() => expandSession(null)}
          >
            <ChevronsDownUp size={14} />
          </button>
        </span>
      </div>
      <div className="chat-scroll" ref={scrollRef}>
        {transcript.messages.map((message, index) => (
          <Message key={index} message={message} />
        ))}
        {transcript.messages.length === 0 ? (
          <p className="text-muted">{t("common.empty")}</p>
        ) : null}
      </div>
      {sendError ? <p className="error-text">{t("common.error")}</p> : null}
      <form className="composer" onSubmit={(event) => void submit(event)}>
        <textarea
          className="input"
          placeholder={t("chat.composer.placeholder")}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit(event);
            }
          }}
        />
        <button className="btn btn-primary" type="submit" disabled={sending || !draft.trim()}>
          <Send size={14} />
          {transcript.running ? t("chat.queue") : t("chat.send")}
        </button>
      </form>
    </Blueprint>
  );
}
