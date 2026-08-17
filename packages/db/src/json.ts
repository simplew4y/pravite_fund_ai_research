import { DomainError } from "@private-fund/core";

function normalizeJson(value: unknown, path: string, seen: Set<object>): unknown {
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
    const normalized = value.map((item, index) =>
      normalizeJson(item, `${path}[${String(index)}]`, seen),
    );
    seen.delete(value);
    return normalized;
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
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) {
        continue;
      }
      normalized[key] = normalizeJson(child, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return normalized;
  }

  throw new DomainError(`${path} is not JSON serializable`, "invalid_json");
}

export function encodeJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value, "value", new Set()));
}

export function decodeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new DomainError("Stored JSON is invalid", "corrupt_database", 500);
  }
}

export function decodeJsonObject(value: string): Record<string, unknown> {
  const decoded = decodeJson(value);
  if (decoded === null || Array.isArray(decoded) || typeof decoded !== "object") {
    throw new DomainError("Stored JSON payload is not an object", "corrupt_database", 500);
  }
  return decoded as Record<string, unknown>;
}
