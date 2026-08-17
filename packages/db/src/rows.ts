import { DomainError } from "@private-fund/core";

import { decodeJson, decodeJsonObject } from "./json.js";

export type SqlRow = Record<string, null | number | bigint | string | Uint8Array>;

function corrupt(column: string): never {
  throw new DomainError(
    `Unexpected value in database column ${column}`,
    "corrupt_database",
    500,
  );
}

export function rowString(row: SqlRow, column: string): string {
  const value = row[column];
  return typeof value === "string" ? value : corrupt(column);
}

export function rowNullableString(row: SqlRow, column: string): string | null {
  const value = row[column];
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : corrupt(column);
}

export function rowNumber(row: SqlRow, column: string): number {
  const value = row[column];
  return typeof value === "number" ? value : corrupt(column);
}

export function rowJson(row: SqlRow, column: string): unknown {
  return decodeJson(rowString(row, column));
}

export function rowJsonObject(
  row: SqlRow,
  column: string,
): Record<string, unknown> {
  return decodeJsonObject(rowString(row, column));
}
