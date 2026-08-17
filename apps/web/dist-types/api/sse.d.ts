import { type SessionEvent } from "@private-fund/contracts";
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
export declare function parseEventData(data: string): SessionEvent | null;
/**
 * Incremental SSE frame splitter. Event names are dynamic strings, so we read
 * the raw stream with fetch instead of EventSource named listeners.
 */
export declare function createSseParser(onData: (data: string) => void): (chunk: string) => void;
/**
 * Stream session events with sequence-based resume. Resolves when aborted.
 */
export declare function streamSessionEvents(sessionId: string, options: SessionEventStreamOptions): Promise<void>;
//# sourceMappingURL=sse.d.ts.map