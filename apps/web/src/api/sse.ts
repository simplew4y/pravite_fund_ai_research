import { sessionEventSchema, type SessionEvent } from "@private-fund/contracts";

export interface SessionEventStreamOptions {
  after?: number;
  signal?: AbortSignal;
  onEvent: (event: SessionEvent) => void;
  onError?: (error: unknown) => void;
  /** Reconnect delay in ms; tests can shrink it. */
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

/** Parse one SSE frame body (the `data:` lines joined) into a SessionEvent. */
export function parseEventData(data: string): SessionEvent | null {
  try {
    return sessionEventSchema.parse(JSON.parse(data));
  } catch {
    return null;
  }
}

/**
 * Incremental SSE frame splitter. Event names are dynamic strings, so we read
 * the raw stream with fetch instead of EventSource named listeners.
 */
export function createSseParser(onData: (data: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLines = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());
      if (dataLines.length > 0) onData(dataLines.join("\n"));
      boundary = buffer.indexOf("\n\n");
    }
  };
}

/**
 * Stream session events with sequence-based resume. Resolves when aborted.
 */
export async function streamSessionEvents(
  sessionId: string,
  options: SessionEventStreamOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retryDelay = options.retryDelayMs ?? 2000;
  let cursor = options.after ?? 0;

  while (!options.signal?.aborted) {
    try {
      const response = await fetchImpl(
        `/v1/sessions/${sessionId}/events?after=${String(cursor)}`,
        {
          credentials: "same-origin",
          headers: { accept: "text/event-stream" },
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      if (!response.ok || !response.body) {
        throw new Error(`SSE connect failed: ${String(response.status)}`);
      }
      const decoder = new TextDecoder();
      const parse = createSseParser((data) => {
        const event = parseEventData(data);
        if (event && event.sequence > cursor) {
          cursor = event.sequence;
          options.onEvent(event);
        }
      });
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parse(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      if (options.signal?.aborted) return;
      options.onError?.(error);
    }
    if (options.signal?.aborted) return;
    await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }
}
