import {
  redactSensitiveText,
  safeErrorMessage,
} from "./safe-error-message.js";

const MAX_SERIALIZATION_DEPTH = 24;

function serializeValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (depth > MAX_SERIALIZATION_DEPTH) {
    return "[maximum serialization depth reached]";
  }

  if (
    value === null ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "string") {
    return redactSensitiveText(value);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "undefined") {
    return null;
  }

  if (typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: value.name,
      message: redactSensitiveText(value.message),
    };
    if (value.stack !== undefined) {
      serialized.stack = redactSensitiveText(value.stack);
    }
    if (value.cause !== undefined) {
      serialized.cause = serializeValue(value.cause, seen, depth + 1);
    }
    return serialized;
  }

  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const serialized = value.map((entry) =>
      serializeValue(entry, seen, depth + 1),
    );
    seen.delete(value);
    return serialized;
  }

  const serialized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    try {
      serialized[key] = serializeValue(entry, seen, depth + 1);
    } catch (error) {
      serialized[key] = {
        serializationError:
          error instanceof Error ? error.message : String(error),
      };
    }
  }
  seen.delete(value);
  return serialized;
}

export function toIpcValue(value: unknown): unknown {
  return serializeValue(value, new WeakSet<object>(), 0);
}

export function toIpcRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const serialized = toIpcValue(value);
  if (
    serialized !== null &&
    typeof serialized === "object" &&
    !Array.isArray(serialized)
  ) {
    return serialized as Record<string, unknown>;
  }
  return { value: serialized };
}

export function errorMessage(error: unknown): string {
  return safeErrorMessage(error) ?? "Unknown agent runtime error";
}
