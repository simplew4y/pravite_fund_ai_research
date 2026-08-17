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
}
export declare const emptyTranscript: Transcript;
/**
 * Fold one durable session event into the transcript. Pure so history replay
 * (?stream=0 page) and the live SSE stream share the same reducer.
 */
export declare function reduceTranscript(state: Transcript, event: SessionEvent): Transcript;
export declare function reduceAll(state: Transcript, events: SessionEvent[]): Transcript;
//# sourceMappingURL=transcript.d.ts.map