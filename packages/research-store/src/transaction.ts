import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export function withProjectTransaction<T>(
  database: DatabaseSync,
  callback: () => T,
): T {
  if (database.isTransaction) {
    const name = `sp_${randomUUID().replaceAll("-", "")}`;
    database.exec(`SAVEPOINT ${name}`);
    try {
      const result = callback();
      database.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      database.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      database.exec(`RELEASE SAVEPOINT ${name}`);
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
