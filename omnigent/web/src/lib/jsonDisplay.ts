/**
 * Display helpers for tool parameters / outputs that may arrive as
 * JSON-encoded strings (sometimes double-encoded, sometimes with
 * Python-style `ensure_ascii` `\uXXXX` sequences left as literal text).
 *
 * Goal: show human-readable characters (e.g. 阳光电源) instead of
 * `\u9633\u5149\u7535\u6e90` in the transcript UI.
 */

const UNICODE_ESCAPE_RE = /\\u([0-9a-fA-F]{4})/g;
const MAX_DEPTH = 8;

/** Decode literal `\uXXXX` sequences in a free-form string. */
export function decodeUnicodeEscapes(value: string): string {
  if (!value.includes("\\u")) return value;
  return value.replace(UNICODE_ESCAPE_RE, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function looksLikeJsonContainer(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 2) return false;
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

/**
 * Recursively:
 * 1. Parse string values that are themselves JSON objects/arrays
 * 2. Decode residual `\uXXXX` escapes in remaining strings
 *
 * Safe for display — never throws; unparseable strings are left as-is
 * (after unicode-escape decode when applicable).
 */
export function decodeForDisplay(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value;

  if (typeof value === "string") {
    if (looksLikeJsonContainer(value)) {
      try {
        return decodeForDisplay(JSON.parse(value) as unknown, depth + 1);
      } catch {
        // not valid JSON — fall through to unicode decode
      }
    }
    return decodeUnicodeEscapes(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => decodeForDisplay(item, depth + 1));
  }

  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = decodeForDisplay(child, depth + 1);
    }
    return out;
  }

  return value;
}

/**
 * Pretty-print a tool output string for the transcript.
 * Parses JSON when possible, expands nested JSON strings, and decodes
 * unicode escapes so Chinese (and other non-ASCII) renders correctly.
 */
export function prettyPrintForDisplay(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  try {
    if (looksLikeJsonContainer(trimmed)) {
      const parsed = decodeForDisplay(JSON.parse(trimmed) as unknown);
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    // fall through
  }

  // Not a top-level JSON value — still decode residual escapes.
  return decodeUnicodeEscapes(raw);
}

/**
 * Format a tool-arguments object for the Parameters panel.
 */
export function formatArgumentsForDisplay(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(decodeForDisplay(args), null, 2);
  } catch {
    return JSON.stringify(args, null, 2);
  }
}
