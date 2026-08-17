import { type Transcript } from "./transcript";
/**
 * Replays the durable event history (?stream=0) and then follows the live SSE
 * stream, folding everything through the same reducer.
 */
export declare function useSessionStream(sessionId: string | null): Transcript;
//# sourceMappingURL=useSessionStream.d.ts.map