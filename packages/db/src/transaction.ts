import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export function withTransaction<T>(
  database: DatabaseSync,
  callback: () => T,
): T {
  if (database.isTransaction) {
    const savepoint = `sp_${randomUUID().replaceAll("-", "")}`;
    database.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = callback();
      database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  }
}
