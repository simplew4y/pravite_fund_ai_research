import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export type SqlValue = null | number | string;
export type SqlRow = Record<string, SqlValue>;

export interface PageOptions {
  readonly limit?: number;
  readonly offset?: number;
}

export interface Page<T> {
  readonly items: T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
}

export interface NormalizedPageOptions {
  readonly limit: number;
  readonly offset: number;
}

export class WorkflowStoreError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | "conflict"
      | "corrupt_json"
      | "invalid_argument"
      | "invalid_state"
      | "not_found",
  ) {
    super(message);
    this.name = "WorkflowStoreError";
  }
}

function normalizeJson(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new WorkflowStoreError(
        `${path} contains a non-finite number`,
        "invalid_argument",
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new WorkflowStoreError(
        `${path} contains a circular reference`,
        "invalid_argument",
      );
    }
    ancestors.add(value);
    const normalized = value.map((item, index) =>
      normalizeJson(item, `${path}[${String(index)}]`, ancestors),
    );
    ancestors.delete(value);
    return normalized;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new WorkflowStoreError(
        `${path} contains a non-JSON object`,
        "invalid_argument",
      );
    }
    if (ancestors.has(value)) {
      throw new WorkflowStoreError(
        `${path} contains a circular reference`,
        "invalid_argument",
      );
    }
    ancestors.add(value);
    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as object).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) {
        normalized[key] = normalizeJson(child, `${path}.${key}`, ancestors);
      }
    }
    ancestors.delete(value);
    return normalized;
  }
  throw new WorkflowStoreError(
    `${path} is not JSON serializable`,
    "invalid_argument",
  );
}

export function encodeJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value, "value", new Set()));
}

export function decodeJson(value: unknown): JsonValue {
  if (typeof value !== "string") {
    throw new WorkflowStoreError("Stored JSON is not text", "corrupt_json");
  }
  try {
    return normalizeJson(JSON.parse(value) as unknown, "stored JSON", new Set());
  } catch (error) {
    if (error instanceof WorkflowStoreError) {
      throw error;
    }
    throw new WorkflowStoreError("Stored JSON is invalid", "corrupt_json");
  }
}

export function decodeJsonObject(
  value: unknown,
  _label?: string,
): Record<string, JsonValue> {
  const decoded = decodeJson(value);
  if (decoded === null || Array.isArray(decoded) || typeof decoded !== "object") {
    throw new WorkflowStoreError(
      "Stored JSON is not an object",
      "corrupt_json",
    );
  }
  return decoded as Record<string, JsonValue>;
}

export function decodeJsonArray(value: unknown, _label?: string): JsonValue[] {
  const decoded = decodeJson(value);
  if (!Array.isArray(decoded)) {
    throw new WorkflowStoreError(
      "Stored JSON is not an array",
      "corrupt_json",
    );
  }
  return decoded;
}

export function withTransaction<T>(
  database: DatabaseSync,
  callback: () => T,
): T {
  if (database.isTransaction) {
    const name = `sp_${randomUUID().replaceAll("-", "")}`;
    database.exec(`SAVEPOINT ${name}`);
    try {
      const value = callback();
      database.exec(`RELEASE SAVEPOINT ${name}`);
      return value;
    } catch (error) {
      database.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      database.exec(`RELEASE SAVEPOINT ${name}`);
      throw error;
    }
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const value = callback();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  }
}

export function nowIso(now: Date = new Date()): string {
  if (!Number.isFinite(now.getTime())) {
    throw new WorkflowStoreError("Clock returned an invalid date", "invalid_argument");
  }
  return now.toISOString();
}

export function stableId(prefix: string, ...parts: readonly unknown[]): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\0"))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

export function requireText(
  value: unknown,
  field: string,
  maxLength = 8_000,
): string {
  const text = String(value ?? "").trim();
  if (text.length === 0) {
    throw new WorkflowStoreError(`${field} is required`, "invalid_argument");
  }
  if (text.length > maxLength) {
    throw new WorkflowStoreError(
      `${field} exceeds ${String(maxLength)} characters`,
      "invalid_argument",
    );
  }
  return text;
}

export function optionalText(
  value: unknown,
  field: string,
  maxLength = 8_000,
): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return requireText(value, field, maxLength);
}

export function assertOneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  field: string,
): asserts value is T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new WorkflowStoreError(
      `${field} has unsupported value: ${value}`,
      "invalid_argument",
    );
  }
}

export function normalizeEvidenceIds(
  values: readonly unknown[] | undefined,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of values ?? []) {
    const evidenceId = requireText(raw, "evidenceId", 240);
    if (!isEvidenceId(evidenceId)) {
      throw new WorkflowStoreError(
        `Unsupported Evidence ID: ${evidenceId}`,
        "invalid_argument",
      );
    }
    if (!seen.has(evidenceId)) {
      seen.add(evidenceId);
      result.push(evidenceId);
    }
  }
  return result;
}

export function isEvidenceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:chunk|fact|cell|page|document):[^\s:][^\s]*$/u.test(value)
  );
}

export function pageOptions(
  options: PageOptions = {},
  maximum = 500,
): NormalizedPageOptions {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > maximum ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw new WorkflowStoreError(
      `Pagination requires limit 1..${String(maximum)} and offset >= 0`,
      "invalid_argument",
    );
  }
  return { limit, offset };
}

export function pageResult<T>(
  items: T[],
  total: number,
  options: NormalizedPageOptions,
): Page<T> {
  return {
    items,
    total,
    limit: options.limit,
    offset: options.offset,
    hasMore: options.offset + items.length < total,
  };
}

export function toRecord(row: unknown): SqlRow {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new WorkflowStoreError("Expected a database row", "corrupt_json");
  }
  return row as SqlRow;
}

export function boolInt(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

export function numberOrNull(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new WorkflowStoreError(`${field} must be finite`, "invalid_argument");
  }
  return number;
}

export function integer(
  value: unknown,
  field: string,
  minimum = 0,
): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new WorkflowStoreError(
      `${field} must be an integer >= ${String(minimum)}`,
      "invalid_argument",
    );
  }
  return number;
}

export function getRequiredRow(
  database: DatabaseSync,
  sql: string,
  params: readonly (null | number | string)[],
  entity: string,
): SqlRow {
  const row = database.prepare(sql).get(...params);
  if (row === undefined) {
    throw new WorkflowStoreError(`${entity} was not found`, "not_found");
  }
  return toRecord(row);
}

export function recordEvidenceReferences(
  database: DatabaseSync,
  ownerType: string,
  ownerId: string,
  evidenceIds: readonly string[],
  relationType = "supports",
  createdAt = nowIso(),
): void {
  const statement = database.prepare(
    `INSERT OR IGNORE INTO workflow_store_evidence_references
       (owner_type, owner_id, evidence_id, relation_type, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const evidenceId of evidenceIds) {
    statement.run(ownerType, ownerId, evidenceId, relationType, createdAt);
  }
}

export function replaceEvidenceReferences(
  database: DatabaseSync,
  ownerType: string,
  ownerId: string,
  evidenceIds: readonly string[],
  relationType = "supports",
  createdAt = nowIso(),
): void {
  database
    .prepare(
      `DELETE FROM workflow_store_evidence_references
       WHERE owner_type=? AND owner_id=? AND relation_type=?`,
    )
    .run(ownerType, ownerId, relationType);
  recordEvidenceReferences(
    database,
    ownerType,
    ownerId,
    evidenceIds,
    relationType,
    createdAt,
  );
}

export function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:UNIQUE constraint failed|constraint failed)/iu.test(error.message)
  );
}
