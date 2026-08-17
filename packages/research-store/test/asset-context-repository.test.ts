import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  ConflictError,
  DomainError,
  NotFoundError,
} from "@private-fund/core";

import {
  createResearchStore,
  openInMemoryProjectDatabase,
  runProjectMigrations,
} from "../src/index.js";

const FIXED_TIME = "2026-07-31T03:00:00.000Z";

describe("unified asset context", () => {
  it("keeps documents and research assets ordered and drops inactive resources", () => {
    const database = openInMemoryProjectDatabase({
      clock: () => new Date(FIXED_TIME),
      preferredSearchBackend: "deterministic",
    });
    const store = createResearchStore(
      database,
      () => new Date(FIXED_TIME),
    );
    const document = store.documents.registerVersion({
      documentId: "document_active",
      sourceRelpath: "annual.pdf",
      title: "Annual report",
      originalFilename: "annual.pdf",
      storedPath: "/tmp/annual.pdf",
      fileType: "pdf",
      sha256: "a".repeat(64),
      fileSize: 100,
    });
    const first = store.assets.saveVersion({
      assetId: "node:first",
      assetType: "analysis",
      title: "First",
      contentMarkdown: "First analysis",
    });
    const second = store.assets.saveVersion({
      assetId: "memo:second",
      assetType: "memo",
      title: "Second",
      contentMarkdown: "Second analysis",
    });
    const ids = [
      `document:${document.document.id}`,
      second.asset.id,
      first.asset.id,
    ];

    expect(store.assetContext.replace(ids)).toEqual(ids);
    expect(store.assetContext.list()).toEqual([
      expect.objectContaining({
        resourceType: "document",
        resourceId: document.document.id,
        contextId: `document:${document.document.id}`,
        position: 0,
      }),
      expect.objectContaining({
        resourceType: "research_asset",
        resourceId: second.asset.id,
        position: 1,
      }),
      expect.objectContaining({
        resourceType: "research_asset",
        resourceId: first.asset.id,
        position: 2,
      }),
    ]);
    expect(store.assets.listContext()).toEqual(ids);

    expect(() =>
      store.assetContext.replace([first.asset.id, first.asset.id]),
    ).toThrow(DomainError);
    expect(() =>
      store.assetContext.replace(["document:unknown"]),
    ).toThrow(NotFoundError);
    expect(() =>
      store.assetContext.replace(["asset:unknown"]),
    ).toThrow(NotFoundError);

    store.assets.setStatus(second.asset.id, "archived");
    expect(store.assetContext.listIds()).toEqual([
      `document:${document.document.id}`,
      first.asset.id,
    ]);
    expect(() =>
      store.assetContext.replace([second.asset.id]),
    ).toThrow(ConflictError);

    store.documents.markRemoved(document.document.id);
    expect(store.assetContext.listIds()).toEqual([first.asset.id]);
    expect(() =>
      store.assetContext.replace([`document:${document.document.id}`]),
    ).toThrow(ConflictError);

    store.assets.markDeleted(first.asset.id);
    expect(store.assetContext.listIds()).toEqual([]);
    expect(
      database.connection
        .prepare(
          `SELECT payload_json AS payloadJson
           FROM research_asset_audit_events
           WHERE event_type = 'asset.context.replaced'
           ORDER BY event_id DESC
           LIMIT 1`,
        )
        .get()?.payloadJson,
    ).toContain(`document:${document.document.id}`);
    expect(() =>
      database.connection
        .prepare(
          `INSERT INTO research_asset_context(
             resource_type, resource_id, position, selected_at
           ) VALUES ('document', 'unknown', 0, ?)`,
        )
        .run(FIXED_TIME),
    ).toThrow(/not active/);
    database.close();
  });

  it("migrates v2 asset selections without changing order or audit history", () => {
    const database = new DatabaseSync(":memory:", {
      enableForeignKeyConstraints: true,
    });
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE project_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO project_schema_migrations VALUES
        (1, 'normalized_research_store', '${FIXED_TIME}'),
        (2, 'research_asset_context_and_audit', '${FIXED_TIME}'),
        (3, 'normalized_source_folders', '${FIXED_TIME}');

      CREATE TABLE project_store_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT, WITHOUT ROWID;
      INSERT INTO project_store_settings VALUES
        ('search_backend', 'deterministic', '${FIXED_TIME}');

      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE TABLE research_assets (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      INSERT INTO research_assets VALUES
        ('node:later', 'completed', NULL),
        ('memo:first', 'completed', NULL);

      CREATE TABLE research_asset_context (
        asset_id TEXT PRIMARY KEY,
        selected_at TEXT NOT NULL,
        FOREIGN KEY (asset_id) REFERENCES research_assets(id) ON DELETE RESTRICT
      ) STRICT, WITHOUT ROWID;
      INSERT INTO research_asset_context VALUES
        ('node:later', '2026-07-31T03:00:01.000Z'),
        ('memo:first', '2026-07-31T03:00:00.000Z');

      CREATE TABLE research_asset_audit_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO research_asset_audit_events(
        asset_id, event_type, payload_json, created_at
      ) VALUES (
        NULL, 'asset.context.replaced',
        '{"assetIds":["memo:first","node:later"]}',
        '${FIXED_TIME}'
      );
    `);

    expect(
      runProjectMigrations(database, {
        clock: () => new Date(FIXED_TIME),
      }),
    ).toMatchObject({ version: 4, searchBackend: "deterministic" });
    expect(
      database
        .prepare(
          `SELECT
             resource_type AS resourceType,
             resource_id AS resourceId,
             position,
             selected_at AS selectedAt
           FROM research_asset_context
           ORDER BY position`,
        )
        .all(),
    ).toEqual([
      {
        resourceType: "research_asset",
        resourceId: "memo:first",
        position: 0,
        selectedAt: "2026-07-31T03:00:00.000Z",
      },
      {
        resourceType: "research_asset",
        resourceId: "node:later",
        position: 1,
        selectedAt: "2026-07-31T03:00:01.000Z",
      },
    ]);
    expect(
      database
        .prepare(
          `SELECT event_type AS eventType, payload_json AS payloadJson
           FROM research_asset_audit_events`,
        )
        .get(),
    ).toEqual({
      eventType: "asset.context.replaced",
      payloadJson: '{"assetIds":["memo:first","node:later"]}',
    });
    expect(
      database
        .prepare(
          `SELECT version, name
           FROM project_schema_migrations
           ORDER BY version DESC
           LIMIT 1`,
        )
        .get(),
    ).toEqual({
      version: 4,
      name: "unified_typed_asset_context",
    });
    database.close();
  });
});
