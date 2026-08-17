import { DomainError } from "@private-fund/core";

import {
  decodeArray,
  decodeObject,
} from "./json.js";

export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

function corrupt(column: string): never {
  throw new DomainError(
    `Unexpected value in database column ${column}`,
    "corrupt_database",
    500,
  );
}

export function stringValue(row: SqlRow, column: string): string {
  const value = row[column];
  return typeof value === "string" ? value : corrupt(column);
}

export function nullableString(
  row: SqlRow,
  column: string,
): string | null {
  const value = row[column];
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : corrupt(column);
}

export function numberValue(row: SqlRow, column: string): number {
  const value = row[column];
  return typeof value === "number" ? value : corrupt(column);
}

export function nullableNumber(
  row: SqlRow,
  column: string,
): number | null {
  const value = row[column];
  if (value === null) {
    return null;
  }
  return typeof value === "number" ? value : corrupt(column);
}

export function objectValue(
  row: SqlRow,
  column: string,
): Record<string, unknown> {
  return decodeObject(stringValue(row, column));
}

export function arrayValue(row: SqlRow, column: string): unknown[] {
  return decodeArray(stringValue(row, column));
}
