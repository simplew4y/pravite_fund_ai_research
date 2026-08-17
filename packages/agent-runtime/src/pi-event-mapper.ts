import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { toIpcRecord, toIpcValue } from "./serialization.js";
import type { AgentEventWorkerMessage } from "./types.js";

export interface PiEventMappingContext {
  sessionId: string;
  operationId: string | null;
}

function eventMessage(
  context: PiEventMappingContext,
  eventType: string,
  payload: Record<string, unknown>,
): AgentEventWorkerMessage {
  return {
    type: "agent.event",
    sessionId: context.sessionId,
    operationId: context.operationId,
    eventType,
    payload: toIpcRecord(payload),
  };
}

function messageRole(message: unknown): string | undefined {
  if (
    message !== null &&
    typeof message === "object" &&
    "role" in message &&
    typeof message.role === "string"
  ) {
    return message.role;
  }
  return undefined;
}

function assistantUsage(message: unknown): unknown {
  if (
    message !== null &&
    typeof message === "object" &&
    "usage" in message
  ) {
    return message.usage;
  }
  return undefined;
}

function mapMessageUpdate(
  event: Extract<AgentSessionEvent, { type: "message_update" }>,
  context: PiEventMappingContext,
): AgentEventWorkerMessage[] {
  const update = event.assistantMessageEvent;

  switch (update.type) {
    case "text_delta":
      return [
        eventMessage(context, "message.assistant.delta", {
          delta: update.delta,
          contentIndex: update.contentIndex,
        }),
      ];
    case "thinking_delta":
      return [
        eventMessage(context, "message.thinking.delta", {
          delta: update.delta,
          contentIndex: update.contentIndex,
        }),
      ];
    case "done":
      return [
        eventMessage(context, "model.stream.completed", {
          reason: update.reason,
          provider: update.message.provider,
          model: update.message.model,
          responseModel: update.message.responseModel ?? null,
        }),
      ];
    case "error":
      return [
        eventMessage(
          context,
          update.reason === "aborted"
            ? "model.stream.aborted"
            : "model.stream.error",
          {
            reason: update.reason,
            error: update.error.errorMessage ?? "Model stream failed",
            message: update.error,
          },
        ),
      ];
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      return [
        eventMessage(context, `assistant.${update.type}`, {
          update,
        }),
      ];
    case "start":
    case "text_start":
    case "text_end":
    case "thinking_start":
    case "thinking_end":
      return [
        eventMessage(context, `assistant.${update.type}`, {
          update,
        }),
      ];
  }
}

export function mapPiEventToWorkerMessages(
  event: AgentSessionEvent,
  context: PiEventMappingContext,
): AgentEventWorkerMessage[] {
  switch (event.type) {
    case "agent_start":
      return [
        eventMessage(context, "session.status", {
          status: "running",
        }),
      ];
    case "agent_end":
      return [
        eventMessage(context, "agent.run.ended", {
          willRetry: event.willRetry,
          messageCount: event.messages.length,
        }),
      ];
    case "agent_settled":
      return [
        eventMessage(context, "session.status", {
          status: "idle",
        }),
      ];
    case "turn_start":
      return [
        eventMessage(context, "agent.turn.started", {}),
      ];
    case "turn_end":
      return [
        eventMessage(context, "agent.turn.completed", {
          message: event.message,
          toolResults: event.toolResults,
        }),
      ];
    case "message_start": {
      const role = messageRole(event.message);
      if (role === "user") {
        return [
          eventMessage(context, "message.user", {
            message: event.message,
          }),
        ];
      }
      return [
        eventMessage(context, "message.started", {
          role: role ?? "unknown",
        }),
      ];
    }
    case "message_update":
      return mapMessageUpdate(event, context);
    case "message_end": {
      const role = messageRole(event.message);
      if (role !== "assistant") {
        return [
          eventMessage(context, "message.completed", {
            role: role ?? "unknown",
            message: event.message,
          }),
        ];
      }

      const messages = [
        eventMessage(context, "message.assistant.completed", {
          message: event.message,
        }),
      ];
      const usage = assistantUsage(event.message);
      if (usage !== undefined) {
        messages.push(
          eventMessage(context, "usage.updated", {
            usage,
          }),
        );
      }
      return messages;
    }
    case "tool_execution_start":
      return [
        eventMessage(context, "tool.started", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          arguments: event.args,
        }),
      ];
    case "tool_execution_update":
      return [
        eventMessage(context, "tool.progress", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          arguments: event.args,
          partialResult: event.partialResult,
        }),
      ];
    case "tool_execution_end":
      return [
        eventMessage(
          context,
          event.isError ? "tool.failed" : "tool.completed",
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result,
            isError: event.isError,
          },
        ),
      ];
    case "queue_update":
      return [
        eventMessage(context, "agent.queue.updated", {
          steering: event.steering,
          followUp: event.followUp,
        }),
      ];
    case "compaction_start":
      return [
        eventMessage(context, "compaction.started", {
          reason: event.reason,
        }),
      ];
    case "compaction_end":
      return [
        eventMessage(context, "compaction.completed", {
          reason: event.reason,
          result: event.result ?? null,
          aborted: event.aborted,
          willRetry: event.willRetry,
          error: event.errorMessage ?? null,
        }),
      ];
    case "auto_retry_start":
      return [
        eventMessage(context, "agent.retry.started", {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          error: event.errorMessage,
        }),
      ];
    case "auto_retry_end":
      return [
        eventMessage(context, "agent.retry.completed", {
          success: event.success,
          attempt: event.attempt,
          finalError: event.finalError ?? null,
        }),
      ];
    case "summarization_retry_scheduled":
      return [
        eventMessage(context, "summarization.retry.scheduled", {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          error: event.errorMessage,
        }),
      ];
    case "summarization_retry_attempt_start":
      return [
        eventMessage(context, "summarization.retry.started", {
          source: event.source,
          reason: "reason" in event ? event.reason : null,
        }),
      ];
    case "summarization_retry_finished":
      return [
        eventMessage(context, "summarization.retry.completed", {}),
      ];
    case "entry_appended":
      return [
        eventMessage(context, "session.entry.appended", {
          entry: event.entry,
        }),
      ];
    case "session_info_changed":
      return [
        eventMessage(context, "session.info.changed", {
          name: event.name ?? null,
        }),
      ];
    case "thinking_level_changed":
      return [
        eventMessage(context, "session.thinking.changed", {
          level: event.level,
        }),
      ];
    case "bash_execution_update":
      return [
        eventMessage(context, "agent.bash.delta", {
          id: event.id ?? null,
          delta: event.delta,
        }),
      ];
    default: {
      const unknownEvent = event as { type?: unknown };
      const type =
        typeof unknownEvent.type === "string" ? unknownEvent.type : "unknown";
      return [
        eventMessage(context, `pi.${type}`, {
          event: toIpcValue(event),
        }),
      ];
    }
  }
}
