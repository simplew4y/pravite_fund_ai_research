import type { DatabaseSync, StatementSync } from "node:sqlite";

import { LegacyMigrationError } from "./errors.js";
import { stableSha256 } from "./stable.js";
import type { TableReconciliation } from "./types.js";

export type SqlValue = null | number | string | bigint | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface TableColumn {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly defaultValue: SqlValue;
  readonly primaryKeyOrder: number;
}

export function quoteIdentifier(value: string): string {
  if (!value || value.includes("\0")) {
    throw new LegacyMigrationError("Unsafe SQLite identifier", "legacy_schema");
  }
  return `"${value.replaceAll('"', '""')}"`;
}

export function tableExists(database: DatabaseSync, table: string): boolean {
  return (
    database
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?",
      )
      .get(table) !== undefined
  );
}

export function tableColumns(
  database: DatabaseSync,
  table: string,
): readonly TableColumn[] {
  if (!tableExists(database, table)) return [];
  return database
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        name: String(row.name),
        type: String(row.type ?? ""),
        notNull: Number(row.notnull) === 1,
        defaultValue: (row.dflt_value ?? null) as SqlValue,
        primaryKeyOrder: Number(row.pk),
      };
    });
}

export function primaryKeyColumns(
  database: DatabaseSync,
  table: string,
): readonly string[] {
  return tableColumns(database, table)
    .filter((column) => column.primaryKeyOrder > 0)
    .sort((left, right) => left.primaryKeyOrder - right.primaryKeyOrder)
    .map((column) => column.name);
}

function normalizeSqlValue(value: unknown): SqlValue {
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new LegacyMigrationError(
    `Unsupported SQLite value ${Object.prototype.toString.call(value)}`,
    "legacy_schema",
  );
}

export function rows(database: DatabaseSync, table: string): readonly SqlRow[] {
  if (!tableExists(database, table)) return [];
  return database
    .prepare(`SELECT * FROM ${quoteIdentifier(table)}`)
    .all()
    .map((raw) =>
      Object.fromEntries(
        Object.entries(raw).map(([key, value]) => [key, normalizeSqlValue(value)]),
      ),
    );
}

function comparable(value: SqlValue): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  return value;
}

export function rowChecksum(
  sourceRows: readonly SqlRow[],
  columns?: readonly string[],
): string {
  const projected = sourceRows.map((row) =>
    Object.fromEntries(
      (columns ?? Object.keys(row).sort()).map((column) => [
        column,
        comparable(row[column] ?? null),
      ]),
    ),
  );
  projected.sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  return stableSha256(projected);
}

export function insertRows(
  database: DatabaseSync,
  table: string,
  sourceRows: readonly SqlRow[],
  columns: readonly string[],
  mode: "insert" | "ignore" = "insert",
): number {
  if (sourceRows.length === 0 || columns.length === 0) return 0;
  const statement = database.prepare(
    `INSERT ${mode === "ignore" ? "OR IGNORE " : ""}INTO ${quoteIdentifier(table)}
       (${columns.map(quoteIdentifier).join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  );
  let changes = 0;
  for (const row of sourceRows) {
    changes += Number(
      statement.run(...columns.map((column) => row[column] ?? null)).changes,
    );
  }
  return changes;
}

export function cloneTables(
  source: DatabaseSync,
  destination: DatabaseSync,
  tables: readonly string[],
): void {
  const tableSet = new Set(tables);
  for (const table of tables) {
    const schema = source
      .prepare(
        `SELECT sql FROM sqlite_schema
         WHERE type='table' AND name=?`,
      )
      .get(table);
    if (typeof schema?.sql !== "string" || !schema.sql.trim()) {
      throw new LegacyMigrationError(
        `Cannot clone table ${table} without its original schema`,
        "legacy_schema",
      );
    }
    /*
     * Execute the source DDL verbatim. Reconstructing columns from PRAGMA
     * metadata loses composite PKs, WITHOUT ROWID, STRICT, CHECK, generated
     * columns and conflict clauses.
     */
    destination.exec(schema.sql);
    const columns = tableColumns(source, table);
    if (columns.length === 0) continue;
    insertRows(
      destination,
      table,
      rows(source, table),
      columns.map((column) => column.name),
    );
  }
  const secondarySchema = source
    .prepare(
      `SELECT type, tbl_name, sql
       FROM sqlite_schema
       WHERE type IN ('index', 'trigger')
         AND sql IS NOT NULL
       ORDER BY CASE type WHEN 'index' THEN 0 ELSE 1 END, name`,
    )
    .all();
  for (const row of secondarySchema) {
    if (tableSet.has(String(row.tbl_name)) && typeof row.sql === "string") {
      destination.exec(row.sql);
    }
  }
}

export function withTransaction<T>(
  database: DatabaseSync,
  action: () => T,
): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original migration error.
    }
    throw error;
  }
}

function bindPrimaryKey(
  statement: StatementSync,
  row: SqlRow,
  primaryKey: readonly string[],
): Record<string, unknown> | undefined {
  return statement.get(...primaryKey.map((column) => row[column] ?? null)) as
    | Record<string, unknown>
    | undefined;
}

export function reconcileRowsByPrimaryKey(
  source: DatabaseSync,
  destination: DatabaseSync,
  table: string,
  mode: TableReconciliation["mode"],
  sourceTransform: (row: SqlRow) => SqlRow = (row) => row,
): TableReconciliation {
  const destinationColumnNames = tableColumns(destination, table).map(
    (column) => column.name,
  );
  const primaryKey = primaryKeyColumns(destination, table);
  if (primaryKey.length === 0) {
    throw new LegacyMigrationError(
      `Destination table ${table} has no primary key`,
      "legacy_schema",
    );
  }
  const selectedColumns = tableColumns(source, table)
    .map((column) => column.name)
    .filter((column) => destinationColumnNames.includes(column));
  const sourceRows = rows(source, table).map(sourceTransform);
  const destinationRows: SqlRow[] = [];
  const lookup = destination.prepare(
    `SELECT ${selectedColumns.map(quoteIdentifier).join(", ")}
     FROM ${quoteIdentifier(table)}
     WHERE ${primaryKey.map((column) => `${quoteIdentifier(column)}=?`).join(" AND ")}`,
  );
  for (const sourceRow of sourceRows) {
    const raw = bindPrimaryKey(lookup, sourceRow, primaryKey);
    if (raw !== undefined) {
      destinationRows.push(
        Object.fromEntries(
          Object.entries(raw).map(([key, value]) => [
            key,
            normalizeSqlValue(value),
          ]),
        ),
      );
    }
  }
  const sourceChecksum = rowChecksum(sourceRows, selectedColumns);
  const destinationChecksum = rowChecksum(destinationRows, selectedColumns);
  return {
    table,
    mode,
    sourceRows: sourceRows.length,
    destinationRows: destinationRows.length,
    sourceChecksum,
    destinationChecksum,
    matched:
      sourceRows.length === destinationRows.length &&
      sourceChecksum === destinationChecksum,
  };
}
