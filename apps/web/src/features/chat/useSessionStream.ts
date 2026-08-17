import { useEffect, useRef, useState } from "react";

import { fetchSessionEventsPage } from "../../api/client";
import { streamSessionEvents } from "../../api/sse";
import { emptyTranscript, reduceAll, reduceTranscript, type Transcript } from "./transcript";

/**
 * Replays the durable event history (?stream=0) and then follows the live SSE
 * stream, folding everything through the same reducer.
 */
export function useSessionStream(sessionId: string | null): Transcript {
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript);
  const cursor = useRef(0);

  useEffect(() => {
    setTranscript(emptyTranscript);
    cursor.current = 0;
    if (sessionId === null) return;
    const abort = new AbortController();

    void (async () => {
      try {
        let after = 0;
        for (;;) {
          const events = await fetchSessionEventsPage(sessionId, after);
          if (abort.signal.aborted) return;
          if (events.length > 0) {
            after = events[events.length - 1]!.sequence;
            setTranscript((state) => reduceAll(state, events));
            cursor.current = after;
          }
          if (events.length < 1000) break;
        }
      } catch {
        // history replay failed; the live stream below starts from 0
      }
      await streamSessionEvents(sessionId, {
        after: cursor.current,
        signal: abort.signal,
        onEvent: (event) => {
          cursor.current = Math.max(cursor.current, event.sequence);
          setTranscript((state) => reduceTranscript(state, event));
        },
      });
    })();

    return () => abort.abort();
  }, [sessionId]);

  return transcript;
}
