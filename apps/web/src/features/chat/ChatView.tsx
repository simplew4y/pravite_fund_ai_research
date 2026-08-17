import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Bot,
  ChevronUp,
  Copy,
  GitBranch,
  Mic,
  Paperclip,
  Send,
  Square,
  Terminal,
  WandSparkles,
  X,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  deleteSessionResource,
  forkSession,
  interruptSession,
  listSessionResources,
  sendMessage,
  steerSession,
  type Session,
} from "../../api/client";
import { ApiError } from "../../api/http";
import { Blueprint } from "../../components/Blueprint";
import { useT } from "../../i18n/useT";
import { useUiStore } from "../../store/ui";
import { useSessionStream } from "./useSessionStream";
import type { TranscriptMessage } from "./transcript";

function AssistantMessage({ message }: { message: TranscriptMessage }) {
  const { t } = useT();
  const thinkingSteps = message.thinking
    ? message.thinking.split("\n").filter((line) => line.trim()).length
    : 0;
  return (
    <div className="msg-assistant">
      <div className="agent-byline">
        <span className="avatar">
          <Bot size={14} />
        </span>
        Researcher-01
      </div>
      {message.thinking ? (
        <details className="reasoning">
          <summary>
            {t("chat.reasoning")} · {thinkingSteps} {t("chat.steps")}
          </summary>
          <pre>{message.thinking}</pre>
        </details>
      ) : null}
      {message.tools.map((tool) => (
        <div key={tool.toolCallId} className="tool-card">
          <div className="tool-head">
            <Terminal size={13} />
            {tool.toolName}
          </div>
          <div className="tool-body">
            {tool.status}
            {tool.error ? ` · ${tool.error}` : ""}
          </div>
        </div>
      ))}
      {message.text ? (
        <div className="answer-card">
          <pre>{message.text}</pre>
          {message.completed ? (
            <div className="answer-actions">
              <button
                className="btn btn-quiet"
                title={t("common.copy")}
                onClick={() => void navigator.clipboard.writeText(message.text)}
              >
                <Copy size={14} />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ContextChips({ sessionId }: { sessionId: string }) {
  const { t } = useT();
  const client = useQueryClient();
  const resources = useQuery({
    queryKey: ["session-resources", sessionId],
    queryFn: () => listSessionResources(sessionId),
    refetchInterval: 15_000,
  });
  const remove = useMutation({
    mutationFn: (resourceId: string) => deleteSessionResource(sessionId, resourceId),
    onSettled: () =>
      void client.invalidateQueries({ queryKey: ["session-resources", sessionId] }),
  });

  if (!resources.data?.length) return null;
  return (
    <div className="ctx-chips">
      {remove.isError ? (
        <span className="error-text">
          {remove.error instanceof ApiError ? remove.error.message : t("common.error")}
        </span>
      ) : null}
      {resources.data.map((resource) => (
        <button
          key={resource.id}
          className={resource.kind === "research_asset" ? "ctx-chip asset" : "ctx-chip"}
          title={`${t("chat.context")} · ${resource.name}`}
          disabled={remove.isPending}
          onClick={() => remove.mutate(resource.id)}
        >
          {resource.name}
          <X size={12} />
        </button>
      ))}
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
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  // Follow new output only while the reader is already at the bottom, so
  // scrolling up during generation is not yanked back every token.
  useEffect(() => {
    const node = scrollRef.current;
    if (node && pinnedToBottom.current) node.scrollTop = node.scrollHeight;
  }, [transcript.messages]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setSendError(null);
    try {
      if (transcript.running) {
        // A turn is in flight: steer queues the follow-up into the next step.
        await steerSession(session.id, content);
      } else {
        await sendMessage(session.id, {
          content,
          clientMessageId: `msg-${crypto.randomUUID()}`,
        });
      }
      setDraft("");
    } catch (error) {
      setSendError(
        error instanceof ApiError ? error.message : t("common.error"),
      );
    } finally {
      setSending(false);
    }
  }

  const [actionError, setActionError] = useState<string | null>(null);

  async function runAction(action: () => Promise<void>) {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(
        error instanceof ApiError ? error.message : t("common.error"),
      );
    }
  }

  async function fork() {
    const forked = await forkSession(session.id);
    await client.invalidateQueries({ queryKey: ["sessions", session.projectId] });
    expandSession(forked.id);
  }

  return (
    <Blueprint className="chat-view">
      <div className="chat-header">
        <span className="title">{session.title || session.id}</span>
        <span style={{ flex: 1 }} />
        {transcript.running ? (
          <button
            className="btn btn-quiet"
            title={t("chat.stop")}
            onClick={() => void runAction(() => interruptSession(session.id))}
          >
            <Square size={14} />
          </button>
        ) : null}
        <button
          className="btn btn-quiet"
          title={t("chat.fork")}
          onClick={() => void runAction(fork)}
        >
          <GitBranch size={14} />
        </button>
        <button
          className="btn btn-quiet"
          title={t("chat.collapse")}
          onClick={() => expandSession(null)}
        >
          <ChevronUp size={14} />
        </button>
      </div>

      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          pinnedToBottom.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        }}
      >
        {transcript.messages.map((message, index) =>
          message.kind === "user" ? (
            <div key={index} className="msg-user">
              <pre>{message.text}</pre>
            </div>
          ) : (
            <AssistantMessage key={index} message={message} />
          ),
        )}
        {transcript.messages.length === 0 ? (
          <p className="text-muted">{t("common.empty")}</p>
        ) : null}
      </div>

      <div className="chat-footer">
        <ContextChips sessionId={session.id} />
        {transcript.error ? (
          <p className="error-text">{transcript.error}</p>
        ) : null}
        {actionError ? <p className="error-text">{actionError}</p> : null}
        {sendError ? <p className="error-text">{sendError}</p> : null}
        <form className="composer" onSubmit={(event) => void submit(event)}>
          <textarea
            placeholder={
              transcript.running ? t("chat.composer.queued") : t("chat.composer.placeholder")
            }
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit(event);
              }
            }}
          />
          <button type="button" className="btn btn-quiet" title={t("chat.attach")} disabled>
            <Paperclip size={16} />
          </button>
          <button type="button" className="btn btn-quiet" title={t("chat.voice")} disabled>
            <Mic size={16} />
          </button>
          <button type="button" className="btn btn-quiet" title={t("chat.skills")} disabled>
            <WandSparkles size={16} />
          </button>
          <button
            className="btn btn-primary btn-send"
            type="submit"
            title={transcript.running ? t("chat.queue") : t("chat.send")}
            aria-label={transcript.running ? t("chat.queue") : t("chat.send")}
            disabled={sending || !draft.trim()}
          >
            <Send size={15} />
          </button>
        </form>
      </div>
    </Blueprint>
  );
}
