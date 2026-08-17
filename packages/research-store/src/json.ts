import { DomainError } from "@private-fund/core";

function normalize(value: unknown, path: string, seen: Set<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DomainError(`${path} contains a non-finite number`, "invalid_json");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new DomainError(`${path} contains a circular reference`, "invalid_json");
    }
    seen.add(value);
    const result = value.map((item, index) =>
      normalize(item, `${path}[${String(index)}]`, seen),
    );
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DomainError(
        `${path} contains an unsupported object type`,
        "invalid_json",
      );
    }
    if (seen.has(value)) {
      throw new DomainError(`${path} contains a circular reference`, "invalid_json");
    }
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) {
        result[key] = normalize(child, `${path}.${key}`, seen);
      }
    }
    seen.delete(value);
    return result;
  }
  throw new DomainError(`${path} is not JSON serializable`, "invalid_json");
}

export function encodeJson(value: unknown): string {
  return JSON.stringify(normalize(value, "value", new Set()));
}

export function decodeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new DomainError("Stored JSON is invalid", "corrupt_database", 500);
  }
}

export function decodeObject(value: string): Record<string, unknown> {
  const decoded = decodeJson(value);
  if (decoded === null || Array.isArray(decoded) || typeof decoded !== "object") {
    throw new DomainError("Stored JSON is not an object", "corrupt_database", 500);
  }
  return decoded as Record<string, unknown>;
}

export function decodeArray(value: string): unknown[] {
  const decoded = decodeJson(value);
  if (!Array.isArray(decoded)) {
    throw new DomainError("Stored JSON is not an array", "corrupt_database", 500);
  }
  return decoded;
}

export function parseLegacyJson(
  value: unknown,
  fallback: Record<string, unknown> | unknown[],
): Record<string, unknown> | unknown[] {
  if (typeof value !== "string" || value.length === 0) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      (Array.isArray(fallback) && Array.isArray(parsed)) ||
      (!Array.isArray(fallback) &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        typeof parsed === "object")
    ) {
      return parsed as Record<string, unknown> | unknown[];
    }
  } catch {
    // Legacy databases did not consistently validate JSON. Invalid values are
    // retained in the legacy tables and normalized to the declared fallback.
  }
  return fallback;
}
