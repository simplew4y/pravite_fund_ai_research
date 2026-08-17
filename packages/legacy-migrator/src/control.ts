import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { openControlDatabase } from "@private-fund/db";

import { LegacyMigrationError } from "./errors.js";
import type { ResolvedProjectMapping } from "./types.js";
import { tableExists, withTransaction } from "./sqlite.js";

interface ControlUserRow {
  readonly id: string;
  readonly data_namespace: string;
  readonly email: string | null;
}

interface ControlProjectRow {
  readonly id: string;
  readonly user_id: string;
  readonly name: string;
  readonly company_name: string | null;
  readonly ticker: string | null;
}

function nullable(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function assertExactControlRows(
  database: DatabaseSync,
  mapping: ResolvedProjectMapping,
  allowMissing: boolean,
): { readonly userExists: boolean; readonly projectExists: boolean } {
  if (!tableExists(database, "users") || !tableExists(database, "projects")) {
    if (allowMissing) return { userExists: false, projectExists: false };
    throw new LegacyMigrationError(
      "Existing control database has no current users/projects schema",
      "destination_conflict",
    );
  }

  const rawUserById = database
    .prepare("SELECT id, data_namespace, email FROM users WHERE id=?")
    .get(mapping.userId);
  const rawUserByNamespace = database
    .prepare("SELECT id, data_namespace, email FROM users WHERE data_namespace=?")
    .get(mapping.dataNamespace);
  if (
    rawUserById === undefined &&
    rawUserByNamespace !== undefined
  ) {
    throw new LegacyMigrationError(
      `Namespace ${mapping.dataNamespace} belongs to another control user`,
      "destination_conflict",
    );
  }
  if (
    rawUserById !== undefined &&
    rawUserByNamespace === undefined
  ) {
    throw new LegacyMigrationError(
      `Control user ${mapping.userId} belongs to another namespace`,
      "destination_conflict",
    );
  }
  if (rawUserById !== undefined) {
    const user: ControlUserRow = {
      id: String(rawUserById.id),
      data_namespace: String(rawUserById.data_namespace),
      email: nullable(rawUserById.email),
    };
    if (
      user.id !== mapping.userId ||
      user.data_namespace !== mapping.dataNamespace ||
      user.email !== mapping.email
    ) {
      throw new LegacyMigrationError(
        `Control user metadata conflicts for ${mapping.userId}`,
        "destination_conflict",
      );
    }
  }

  const rawProject = database
    .prepare(
      `SELECT id, user_id, name, company_name, ticker
       FROM projects WHERE id=?`,
    )
    .get(mapping.projectId);
  if (rawProject !== undefined) {
    const project: ControlProjectRow = {
      id: String(rawProject.id),
      user_id: String(rawProject.user_id),
      name: String(rawProject.name),
      company_name: nullable(rawProject.company_name),
      ticker: nullable(rawProject.ticker),
    };
    if (
      project.id !== mapping.projectId ||
      project.user_id !== mapping.userId ||
      project.name !== mapping.name ||
      project.company_name !== mapping.companyName ||
      project.ticker !== mapping.ticker
    ) {
      throw new LegacyMigrationError(
        `Control project ownership or metadata conflicts for ${mapping.projectId}`,
        "destination_conflict",
      );
    }
  }
  return {
    userExists: rawUserById !== undefined,
    projectExists: rawProject !== undefined,
  };
}

export function preflightControlMapping(
  filename: string,
  mapping: ResolvedProjectMapping,
): void {
  if (!existsSync(filename)) return;
  const database = new DatabaseSync(filename, {
    allowExtension: false,
    readOnly: true,
    timeout: 5_000,
  });
  try {
    database.exec("PRAGMA query_only=ON");
    assertExactControlRows(database, mapping, false);
  } finally {
    database.close();
  }
}

export function ensureControlMapping(
  filename: string,
  mapping: ResolvedProjectMapping,
  timestamp: string,
): void {
  const database = openControlDatabase(filename, { migrate: true });
  try {
    withTransaction(database, () => {
      const existing = assertExactControlRows(database, mapping, true);
      if (!existing.userExists) {
        database
          .prepare(
            `INSERT INTO users(
               id, data_namespace, email, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            mapping.userId,
            mapping.dataNamespace,
            mapping.email,
            timestamp,
            timestamp,
          );
      }
      if (!existing.projectExists) {
        database
          .prepare(
            `INSERT INTO projects(
               id, user_id, name, company_name, ticker, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            mapping.projectId,
            mapping.userId,
            mapping.name,
            mapping.companyName,
            mapping.ticker,
            timestamp,
            timestamp,
          );
      }
      assertExactControlRows(database, mapping, false);
    });
  } catch (error) {
    if (error instanceof LegacyMigrationError) throw error;
    throw new LegacyMigrationError(
      `Cannot create exact control mapping ${mapping.mappingKey}`,
      "destination_conflict",
      { cause: error },
    );
  } finally {
    database.close();
  }
}

export function verifyControlMapping(
  filename: string,
  mapping: ResolvedProjectMapping,
): void {
  if (!existsSync(filename)) {
    throw new LegacyMigrationError(
      `Control database is missing after migration: ${filename}`,
      "reconciliation_failed",
    );
  }
  const database = new DatabaseSync(filename, {
    allowExtension: false,
    readOnly: true,
    timeout: 5_000,
  });
  try {
    database.exec("PRAGMA query_only=ON");
    assertExactControlRows(database, mapping, false);
    const project = database
      .prepare(
        `SELECT 1
         FROM projects AS p
         JOIN users AS u ON u.id=p.user_id
         WHERE p.id=? AND u.data_namespace=?`,
      )
      .get(mapping.projectId, mapping.dataNamespace);
    if (project === undefined) {
      throw new LegacyMigrationError(
        `Control tenant scope is invalid for ${mapping.projectId}`,
        "reconciliation_failed",
      );
    }
  } finally {
    database.close();
  }
}

