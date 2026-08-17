import type { SessionEvent } from "@private-fund/contracts";

export interface TranscriptToolCall {
  toolCallId: string;
  toolName: string;
  status: "running" | "completed" | "failed";
  error?: string;
}

export interface TranscriptMessage {
  kind: "user" | "assistant";
  text: string;
  thinking: string;
  tools: TranscriptToolCall[];
  completed: boolean;
}

export interface Transcript {
  messages: TranscriptMessage[];
  running: boolean;
  lastSequence: number;
  /** Last terminal failure for the session, surfaced in the composer. */
  error: string | null;
  /** True while the event stream is reconnecting. */
  streamDegraded: boolean;
}

export const emptyTranscript: Transcript = {
  messages: [],
  running: false,
  lastSequence: 0,
  error: null,
  streamDegraded: false,
};

function extractText(message: unknown): string {
  if (message === null || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block !== null && typeof block === "object") {
        const record = block as Record<string, unknown>;
        if (record.type === "text" && typeof record.text === "string") {
          return record.text;
        }
      }
      return "";
    })
    .join("");
}

function lastAssistant(messages: TranscriptMessage[]): TranscriptMessage | null {
  const last = messages[messages.length - 1];
  return last && last.kind === "assistant" && !last.completed ? last : null;
}

function openAssistant(messages: TranscriptMessage[]): TranscriptMessage {
  const open = lastAssistant(messages);
  if (open) return open;
  const created: TranscriptMessage = {
    kind: "assistant",
    text: "",
    thinking: "",
    tools: [],
    completed: false,
  };
  messages.push(created);
  return created;
}

/**
 * Fold one durable session event into the transcript. Pure so history replay
 * (?stream=0 page) and the live SSE stream share the same reducer.
 */
export function reduceTranscript(state: Transcript, event: SessionEvent): Transcript {
  if (event.sequence <= state.lastSequence) return state;
  const messages = state.messages.map((message) => ({
    ...message,
    tools: [...message.tools],
  }));
  let running = state.running;
  let error = state.error;
  const payload = event.payload;

  switch (event.type) {
    case "message.user":
      messages.push({
        kind: "user",
        // The control plane writes {content}; the agent loop writes {message}.
        text:
          extractText(payload.message) ||
          (typeof payload.content === "string" ? payload.content : ""),
        thinking: "",
        tools: [],
        completed: true,
      });
      running = true;
      break;
    case "message.assistant.delta": {
      const target = openAssistant(messages);
      if (typeof payload.delta === "string") target.text += payload.delta;
      running = true;
      break;
    }
    case "message.thinking.delta": {
      const target = openAssistant(messages);
      if (typeof payload.delta === "string") target.thinking += payload.delta;
      running = true;
      break;
    }
    case "message.assistant.completed": {
      const target = openAssistant(messages);
      const text = extractText(payload.message);
      if (text) target.text = text;
      target.completed = true;
      break;
    }
    case "tool.started": {
      const target = openAssistant(messages);
      target.tools.push({
        toolCallId: String(payload.toolCallId ?? ""),
        toolName: String(payload.toolName ?? "tool"),
        status: "running",
      });
      running = true;
      break;
    }
    case "tool.completed":
    case "tool.failed": {
      const target = lastAssistant(messages) ?? openAssistant(messages);
      const tool = target.tools.find(
        (candidate) => candidate.toolCallId === String(payload.toolCallId ?? ""),
      );
      if (tool) {
        tool.status = event.type === "tool.completed" ? "completed" : "failed";
        if (event.type === "tool.failed") {
          const result = payload.result;
          tool.error =
            result !== null &&
            typeof result === "object" &&
            typeof (result as { error?: unknown }).error === "string"
              ? (result as { error: string }).error
              : "tool failed";
        }
      }
      break;
    }
    case "operation.completed":
    case "agent.run.ended":
      running = false;
      error = null;
      break;
    case "operation.interrupted":
      running = false;
      break;
    case "operation.failed":
      running = false;
      error =
        typeof payload.error === "string" && payload.error
          ? payload.error
          : "Agent operation failed";
      break;
    default:
      break;
  }

  return {
    ...state,
    messages,
    running,
    error,
    streamDegraded: false,
    lastSequence: event.sequence,
  };
}

export function reduceAll(state: Transcript, events: SessionEvent[]): Transcript {
  return events.reduce(reduceTranscript, state);
}
