/**
 * Minimal OpenAI-compatible streaming chat client used by the in-process
 * harness agent loop. Works against the private-fund cloud model gateway
 * (Bearer pfm_ token) and any /chat/completions-compatible endpoint.
 */

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly tool_calls?: readonly ChatToolCall[];
  readonly tool_call_id?: string;
}

export interface ChatToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { name: string; arguments: string };
}

export interface ChatToolDefinition {
  readonly type: "function";
  readonly function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatStreamRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ChatToolDefinition[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export type ChatStreamEvent =
  | { readonly type: "delta"; readonly text: string }
  | {
      readonly type: "completed";
      readonly text: string;
      readonly toolCalls: readonly ChatToolCall[];
      readonly finishReason: string | null;
    };

export interface ChatModelEndpoint {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

export class ChatModelError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ChatModelError";
  }
}

interface MutableToolCall {
  id: string;
  name: string;
  arguments: string;
}

function parseSseData(buffer: { text: string }, chunk: string): string[] {
  buffer.text += chunk;
  const events: string[] = [];
  let boundary = buffer.text.indexOf("\n\n");
  while (boundary !== -1) {
    const frame = buffer.text.slice(0, boundary);
    buffer.text = buffer.text.slice(boundary + 2);
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) events.push(line.slice(5).trim());
    }
    boundary = buffer.text.indexOf("\n\n");
  }
  return events;
}

export async function* streamChatCompletion(
  endpoint: ChatModelEndpoint,
  request: ChatStreamRequest,
  fetchImplementation: typeof fetch = fetch,
): AsyncGenerator<ChatStreamEvent> {
  const url = `${endpoint.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetchImplementation(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${endpoint.apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      stream: true,
      ...(request.tools !== undefined && request.tools.length > 0
        ? { tools: request.tools }
        : {}),
      ...(request.temperature === undefined
        ? {}
        : { temperature: request.temperature }),
      ...(request.maxTokens === undefined
        ? {}
        : { max_tokens: request.maxTokens }),
    }),
    ...(request.signal ? { signal: request.signal } : {}),
  });
  if (!response.ok || response.body === null) {
    const detail = await response.text().catch(() => "");
    throw new ChatModelError(
      `Model endpoint returned ${String(response.status)}: ${detail.slice(0, 500)}`,
      response.status,
    );
  }

  const decoder = new TextDecoder();
  const buffer = { text: "" };
  const toolCalls = new Map<number, MutableToolCall>();
  let text = "";
  let finishReason: string | null = null;
  const reader = response.body.getReader();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const data of parseSseData(buffer, decoder.decode(value, { stream: true }))) {
      if (data === "[DONE]") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = (parsed as { choices?: unknown[] }).choices?.[0] as
        | {
            delta?: {
              content?: string | null;
              tool_calls?: {
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }[];
            };
            finish_reason?: string | null;
          }
        | undefined;
      if (choice === undefined) continue;
      if (typeof choice.delta?.content === "string" && choice.delta.content) {
        text += choice.delta.content;
        yield { type: "delta", text: choice.delta.content };
      }
      for (const call of choice.delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        const existing = toolCalls.get(index) ?? {
          id: "",
          name: "",
          arguments: "",
        };
        if (call.id) existing.id = call.id;
        if (call.function?.name) existing.name += call.function.name;
        if (call.function?.arguments)
          existing.arguments += call.function.arguments;
        toolCalls.set(index, existing);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }

  yield {
    type: "completed",
    text,
    finishReason,
    toolCalls: [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call], position) => ({
        id: call.id || `call_${String(position)}`,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments || "{}" },
      })),
  };
}
