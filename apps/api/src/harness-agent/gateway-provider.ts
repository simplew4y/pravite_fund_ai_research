import {
  MODEL_REQUEST_SCHEMA_VERSION,
  MODEL_STREAM_SCHEMA_VERSION,
  type ModelProviderEvent,
  type ModelRequestDraft,
} from "@private-fund/contracts";
import { newId } from "@private-fund/core";
import {
  createModelSourceManifestEntry,
  type ModelProvider,
  type ModelProviderInvocation,
} from "@private-fund/model-runtime";

import {
  streamChatCompletion,
  type ChatMessage,
  type ChatModelEndpoint,
  type ChatToolDefinition,
} from "./model-client.js";

export const HARNESS_MODEL_PROVIDER_ID = "openai_compatible";
export const HARNESS_CONTEXT_COMPILER_VERSION = "harness-agent/1";

/** Batch streamed deltas before journaling; the plan explicitly allows
 * chunk batching as long as the final content is faithful. */
const DELTA_FLUSH_BYTES = 512;

export interface DraftInput {
  readonly sessionId: string;
  readonly operationId: string | null;
  readonly turnId: string;
  readonly stepId: string;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ChatToolDefinition[];
  /** Highest durable event sequence folded into the context. */
  readonly journalThroughSequence: number;
}

/**
 * Assemble the commit-before-send request draft. The body is exactly what
 * the provider adapter will put on the wire (minus transport credentials,
 * which never enter the snapshot), and the source manifest ties each body
 * region back to its origin so audits can answer "why did the model see
 * this?".
 */
export function buildModelRequestDraft(input: DraftInput): ModelRequestDraft {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    ...(input.tools !== undefined && input.tools.length > 0
      ? { tools: input.tools }
      : {}),
    stream: true,
  };
  const sourceManifest = [
    createModelSourceManifestEntry(body, {
      sourceId: `config-${input.stepId}`,
      origin: {
        kind: "static_configuration",
        id: input.sessionId,
        version: HARNESS_CONTEXT_COMPILER_VERSION,
        sequence: null,
      },
      classification: "internal",
      required: true,
      bodyPointers: ["/model", "/stream"],
    }),
    createModelSourceManifestEntry(body, {
      sourceId: `prompt-${input.stepId}`,
      origin: {
        kind: "session_event",
        id: input.sessionId,
        version: HARNESS_CONTEXT_COMPILER_VERSION,
        sequence: input.journalThroughSequence,
      },
      classification: "confidential",
      required: true,
      bodyPointers: ["/messages"],
    }),
  ];
  if (body.tools !== undefined) {
    sourceManifest.push(
      createModelSourceManifestEntry(body, {
        sourceId: `tools-${input.stepId}`,
        origin: {
          kind: "tool_schema",
          id: input.sessionId,
          version: HARNESS_CONTEXT_COMPILER_VERSION,
          sequence: null,
        },
        classification: "internal",
        required: true,
        bodyPointers: ["/tools"],
      }),
    );
  }
  return {
    schemaVersion: MODEL_REQUEST_SCHEMA_VERSION,
    requestId: newId("request"),
    sessionId: input.sessionId,
    operationId: input.operationId,
    turnId: input.turnId,
    stepId: input.stepId,
    providerId: HARNESS_MODEL_PROVIDER_ID,
    model: input.model,
    compilerVersion: HARNESS_CONTEXT_COMPILER_VERSION,
    journalThroughSequence: input.journalThroughSequence,
    body,
    sourceManifest,
  };
}

function safeToolCallId(raw: string, position: number): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(raw)
    ? raw
    : `call-${String(position)}`;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * ModelProvider adapter over any OpenAI-compatible /chat/completions
 * endpoint. Transport credentials are resolved out-of-band per session so
 * they never appear in the persisted request snapshot.
 */
export class OpenAiCompatibleModelProvider implements ModelProvider {
  public readonly id = HARNESS_MODEL_PROVIDER_ID;
  readonly #resolveEndpoint: (sessionId: string) => ChatModelEndpoint;
  readonly #fetchImplementation: typeof fetch | undefined;

  constructor(
    resolveEndpoint: (sessionId: string) => ChatModelEndpoint,
    fetchImplementation?: typeof fetch,
  ) {
    this.#resolveEndpoint = resolveEndpoint;
    this.#fetchImplementation = fetchImplementation;
  }

  public async *stream(
    invocation: ModelProviderInvocation,
  ): AsyncGenerator<ModelProviderEvent> {
    const { snapshot, signal } = invocation;
    const endpoint = this.#resolveEndpoint(snapshot.sessionId);
    const body = snapshot.body as {
      messages: ChatMessage[];
      tools?: ChatToolDefinition[];
    };
    let buffered = "";
    try {
      for await (const event of streamChatCompletion(
        endpoint,
        {
          model: snapshot.model,
          messages: body.messages,
          ...(body.tools === undefined ? {} : { tools: body.tools }),
          signal,
        },
        this.#fetchImplementation,
      )) {
        if (event.type === "delta") {
          buffered += event.text;
          if (buffered.length >= DELTA_FLUSH_BYTES) {
            yield this.#delta(buffered);
            buffered = "";
          }
          continue;
        }
        if (buffered.length > 0) {
          yield this.#delta(buffered);
          buffered = "";
        }
        for (const [position, call] of event.toolCalls.entries()) {
          yield {
            schemaVersion: MODEL_STREAM_SCHEMA_VERSION,
            type: "tool_call",
            toolCallId: safeToolCallId(call.id, position),
            name: call.function.name,
            arguments: parseArguments(call.function.arguments),
          };
        }
        yield {
          schemaVersion: MODEL_STREAM_SCHEMA_VERSION,
          type: "final",
          finishReason: event.finishReason ?? "stop",
          responseModel: null,
        };
        return;
      }
      // The upstream stream ended without a completion frame.
      if (buffered.length > 0) yield this.#delta(buffered);
      yield {
        schemaVersion: MODEL_STREAM_SCHEMA_VERSION,
        type: "error",
        code: "upstream_stream_truncated",
        message: "Chat completion stream ended without a finish frame",
        retryable: true,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      yield {
        schemaVersion: MODEL_STREAM_SCHEMA_VERSION,
        type: "error",
        code: "upstream_request_failed",
        message:
          error instanceof Error
            ? error.message.slice(0, 4_000)
            : String(error).slice(0, 4_000),
        retryable: true,
      };
    }
  }

  #delta(text: string): ModelProviderEvent {
    return {
      schemaVersion: MODEL_STREAM_SCHEMA_VERSION,
      type: "delta",
      channel: "text",
      delta: text,
      contentIndex: 0,
    };
  }
}
