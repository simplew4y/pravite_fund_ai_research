import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { cloneTables } from "../src/sqlite.js";

describe("schema-preserving SQLite clone", () => {
  let source: DatabaseSync | undefined;
  let destination: DatabaseSync | undefined;

  afterEach(() => {
    source?.close();
    destination?.close();
    source = undefined;
    destination = undefined;
  });

  it("retains composite PK, STRICT/WITHOUT ROWID, checks, indexes and triggers", () => {
    source = new DatabaseSync(":memory:");
    destination = new DatabaseSync(":memory:");
    source.exec(`
      CREATE TABLE clone_audit (
        audit_id INTEGER PRIMARY KEY,
        message TEXT NOT NULL
      ) STRICT;
      CREATE TABLE preserved_rows (
        dataset_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        value TEXT NOT NULL CHECK(length(value) > 0),
        PRIMARY KEY(dataset_id, source_key)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX preserved_rows_value_idx ON preserved_rows(value);
      CREATE TRIGGER preserved_rows_insert
      AFTER INSERT ON preserved_rows
      BEGIN
        INSERT INTO clone_audit(message)
        VALUES (NEW.dataset_id || ':' || NEW.source_key);
      END;
      INSERT INTO preserved_rows VALUES ('dataset-a', 'one', 'value-one');
    `);

    cloneTables(source, destination, [
      "clone_audit",
      "preserved_rows",
    ]);

    expect(
      destination
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type='table' AND name='preserved_rows'",
        )
        .get()?.sql,
    ).toBe(
      source
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type='table' AND name='preserved_rows'",
        )
        .get()?.sql,
    );
    expect(
      destination
        .prepare("PRAGMA table_info(preserved_rows)")
        .all()
        .filter((row) => Number(row.pk) > 0)
        .map((row) => row.name),
    ).toEqual(["dataset_id", "source_key"]);
    expect(
      destination
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type='index' AND name='preserved_rows_value_idx'",
        )
        .get(),
    ).toBeDefined();
    expect(() =>
      destination
        ?.prepare(
          "INSERT INTO preserved_rows VALUES ('dataset-a', 'bad', '')",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/u);

    destination
      .prepare(
        "INSERT INTO preserved_rows VALUES ('dataset-a', 'two', 'value-two')",
      )
      .run();
    expect(
      destination
        .prepare(
          "SELECT message FROM clone_audit WHERE message='dataset-a:two'",
        )
        .get()?.message,
    ).toBe("dataset-a:two");
  });
});

