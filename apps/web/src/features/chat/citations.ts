export interface Citation {
  evidenceId: string;
  excerpt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Pull citations out of an evidence tool result. Tool results arrive as
 * untyped JSON from the agent loop, so every shape check is defensive:
 * anything malformed is skipped rather than thrown.
 */
export function extractToolCitations(toolName: unknown, result: unknown): Citation[] {
  if (!isRecord(result)) return [];

  if (toolName === "evidence.search") {
    const hits = result.hits;
    if (!Array.isArray(hits)) return [];
    const citations: Citation[] = [];
    for (const hit of hits) {
      if (!isRecord(hit)) continue;
      const evidenceId = hit.evidenceId;
      if (typeof evidenceId !== "string") continue;
      citations.push({
        evidenceId,
        excerpt: typeof hit.excerpt === "string" ? hit.excerpt : "",
      });
    }
    return citations;
  }

  if (toolName === "evidence.get") {
    const items = result.items;
    if (!Array.isArray(items)) return [];
    const citations: Citation[] = [];
    for (const item of items) {
      if (!isRecord(item)) continue;
      const evidenceId = item.evidenceId;
      if (typeof evidenceId !== "string") continue;
      const content = item.content;
      citations.push({
        evidenceId,
        excerpt: typeof content === "string" ? content.slice(0, 200) : "",
      });
    }
    return citations;
  }

  return [];
}

/** Deduplicate by evidenceId, keeping the first occurrence's excerpt and order. */
export function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const unique: Citation[] = [];
  for (const citation of citations) {
    if (seen.has(citation.evidenceId)) continue;
    seen.add(citation.evidenceId);
    unique.push(citation);
  }
  return unique;
}

export type AnswerSegment =
  | { type: "text"; value: string }
  | { type: "citation"; evidenceId: string };

/**
 * Split answer text on inline citation tokens like [chunk:abc-1]. Text between
 * tokens is preserved verbatim (whitespace included); unknown prefixes such as
 * [foo:x] stay in the surrounding text segment.
 */
export function splitCitationTokens(text: string): AnswerSegment[] {
  const token = /\[((?:chunk|fact|cell|page):[A-Za-z0-9_.-]+)\]/g;
  const segments: AnswerSegment[] = [];
  let lastIndex = 0;
  for (let match = token.exec(text); match !== null; match = token.exec(text)) {
    const evidenceId = match[1];
    if (evidenceId === undefined) continue;
    if (match.index > lastIndex) {
      segments.push({ type: "text", value: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: "citation", evidenceId });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", value: text.slice(lastIndex) });
  }
  return segments;
}
