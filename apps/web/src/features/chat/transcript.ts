import type { SessionEvent } from "@private-fund/contracts";

export interface TranscriptToolCall {
  toolCallId: string;
  toolName: string;
  status: "running" | "completed" | "failed";
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
}

export const emptyTranscript: Transcript = {
  messages: [],
  running: false,
  lastSequence: 0,
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
  const payload = event.payload;

  switch (event.type) {
    case "message.user":
      messages.push({
        kind: "user",
        text: extractText(payload.message),
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
      if (tool) tool.status = event.type === "tool.completed" ? "completed" : "failed";
      break;
    }
    case "operation.completed":
    case "operation.failed":
    case "operation.interrupted":
    case "agent.run.ended":
      running = false;
      break;
    default:
      break;
  }

  return { messages, running, lastSequence: event.sequence };
}

export function reduceAll(state: Transcript, events: SessionEvent[]): Transcript {
  return events.reduce(reduceTranscript, state);
}
