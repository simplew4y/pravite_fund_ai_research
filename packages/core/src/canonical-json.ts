import { createHash } from "node:crypto";

export class CanonicalJsonError extends TypeError {
  public constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function serializeCanonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError("Canonical JSON rejects non-finite numbers");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (
    typeof value === "undefined" ||
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    typeof value === "function"
  ) {
    throw new CanonicalJsonError(
      `Canonical JSON rejects values of type ${typeof value}`,
    );
  }

  if (ancestors.has(value)) {
    throw new CanonicalJsonError("Canonical JSON rejects cyclic values");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new CanonicalJsonError("Canonical JSON rejects sparse arrays");
        }
        entries.push(serializeCanonical(value[index], ancestors));
      }
      return `[${entries.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError(
        "Canonical JSON accepts only plain objects and arrays",
      );
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new CanonicalJsonError(
        "Canonical JSON rejects symbol-keyed properties",
      );
    }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    const entries = keys.map(
      (key) =>
        `${JSON.stringify(key)}:${serializeCanonical(object[key], ancestors)}`,
    );
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Project canonical JSON representation used for idempotency and integrity
 * digests. It deliberately rejects values JSON would silently drop or coerce.
 */
export function canonicalizeJson(value: unknown): string {
  return serializeCanonical(value, new Set<object>());
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJsonSha256(value: unknown): string {
  return sha256Hex(canonicalizeJson(value));
}
