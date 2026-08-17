import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { Clock } from "@private-fund/core";
import {
  isoNow,
  systemClock,
} from "@private-fund/core";

import {
  encodeJson,
  parseLegacyJson,
} from "./json.js";
import type { SqlRow } from "./rows.js";
import { withProjectTransaction } from "./transaction.js";
import type { SearchBackend } from "./types.js";

const INITIAL_SCHEMA = `
  CREATE TABLE project_store_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    logical_key TEXT NOT NULL UNIQUE,
    source_root TEXT,
    source_relpath TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'removed', 'archived')),
    current_version_id TEXT,
    current_version_no INTEGER NOT NULL DEFAULT 0 CHECK (current_version_no >= 0),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    CHECK (length(id) BETWEEN 1 AND 200),
    CHECK (length(logical_key) BETWEEN 1 AND 1000),
    CHECK (length(source_relpath) BETWEEN 1 AND 4000),
    CHECK (length(title) BETWEEN 1 AND 500)
  ) STRICT;
  CREATE INDEX documents_status_updated_idx
    ON documents(status, updated_at DESC, id);

  CREATE TABLE document_versions (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    version_no INTEGER NOT NULL CHECK (version_no > 0),
    supersedes_version_id TEXT,
    sha256 TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    file_type TEXT NOT NULL,
    mime_type TEXT,
    file_size INTEGER NOT NULL CHECK (file_size >= 0),
    status TEXT NOT NULL
      CHECK (status IN ('parsing', 'indexed', 'needs_ocr', 'failed', 'review_required')),
    lifecycle TEXT NOT NULL
      CHECK (lifecycle IN ('pending', 'active', 'superseded', 'removed', 'failed_attempt')),
    parser_name TEXT,
    parser_version TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (document_id, version_no),
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
    FOREIGN KEY (supersedes_version_id)
      REFERENCES document_versions(id) ON DELETE SET NULL,
    CHECK (length(id) BETWEEN 1 AND 200),
    CHECK (length(sha256) BETWEEN 1 AND 128),
    CHECK (length(original_filename) BETWEEN 1 AND 1000),
    CHECK (length(stored_path) BETWEEN 1 AND 8000)
  ) STRICT;
  CREATE INDEX document_versions_document_created_idx
    ON document_versions(document_id, version_no DESC);
  CREATE INDEX document_versions_hash_idx
    ON document_versions(document_id, sha256);

  CREATE TABLE evidence (
    evidence_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('chunk', 'fact', 'cell', 'page')),
    document_version_id TEXT NOT NULL,
    title TEXT,
    summary TEXT,
    original_text TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source_locator_json TEXT NOT NULL CHECK (json_valid(source_locator_json)),
    page_start INTEGER,
    page_end INTEGER,
    page_numbers_json TEXT CHECK (
      page_numbers_json IS NULL OR json_valid(page_numbers_json)
    ),
    bbox_json TEXT CHECK (bbox_json IS NULL OR json_valid(bbox_json)),
    slide_start INTEGER,
    slide_end INTEGER,
    sheet_name TEXT,
    cell_range TEXT,
    cell_ref TEXT,
    heading_path TEXT,
    formula TEXT,
    display_value TEXT,
    raw_value TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL,
    FOREIGN KEY (document_version_id)
      REFERENCES document_versions(id) ON DELETE CASCADE,
    CHECK (length(evidence_id) BETWEEN 3 AND 240),
    CHECK (evidence_id LIKE kind || ':%'),
    CHECK (page_start IS NULL OR page_start > 0),
    CHECK (page_end IS NULL OR page_end >= page_start),
    CHECK (slide_start IS NULL OR slide_start > 0),
    CHECK (slide_end IS NULL OR slide_end >= slide_start)
  ) STRICT;
  CREATE INDEX evidence_version_kind_idx
    ON evidence(document_version_id, kind, evidence_id);
  CREATE INDEX evidence_pdf_locator_idx
    ON evidence(document_version_id, page_start, page_end)
    WHERE page_start IS NOT NULL;
  CREATE INDEX evidence_sheet_locator_idx
    ON evidence(document_version_id, sheet_name, cell_ref, cell_range)
    WHERE sheet_name IS NOT NULL;

  CREATE TABLE research_assets (
    id TEXT PRIMARY KEY,
    asset_type TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL
      CHECK (status IN ('draft', 'running', 'completed', 'stale', 'failed', 'archived')),
    current_version_id TEXT,
    current_version_no INTEGER NOT NULL DEFAULT 0 CHECK (current_version_no >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    deleted_at TEXT,
    CHECK (length(id) BETWEEN 1 AND 240),
    CHECK (length(asset_type) BETWEEN 1 AND 80),
    CHECK (length(title) BETWEEN 1 AND 500)
  ) STRICT;
  CREATE INDEX research_assets_status_updated_idx
    ON research_assets(status, updated_at DESC, id);
  CREATE INDEX research_assets_type_updated_idx
    ON research_assets(asset_type, updated_at DESC, id);

  CREATE TABLE research_asset_versions (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    version_no INTEGER NOT NULL CHECK (version_no > 0),
    status TEXT NOT NULL
      CHECK (status IN ('draft', 'running', 'completed', 'stale', 'failed', 'archived')),
    summary TEXT NOT NULL DEFAULT '',
    content_markdown TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source_response_id TEXT,
    structured_content_json TEXT NOT NULL DEFAULT '{}'
      CHECK (json_valid(structured_content_json)),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
    created_at TEXT NOT NULL,
    UNIQUE (asset_id, version_no),
    UNIQUE (asset_id, content_hash),
    FOREIGN KEY (asset_id) REFERENCES research_assets(id) ON DELETE CASCADE,
    CHECK (length(id) BETWEEN 1 AND 240)
  ) STRICT;
  CREATE INDEX research_asset_versions_asset_idx
    ON research_asset_versions(asset_id, version_no DESC);

  CREATE TABLE research_asset_evidence (
    asset_version_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    relation_type TEXT NOT NULL DEFAULT 'supports',
    quote TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (asset_version_id, evidence_id, relation_type),
    FOREIGN KEY (asset_version_id)
      REFERENCES research_asset_versions(id) ON DELETE CASCADE,
    FOREIGN KEY (evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
    CHECK (length(relation_type) BETWEEN 1 AND 80)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX research_asset_evidence_evidence_idx
    ON research_asset_evidence(evidence_id, asset_version_id);
`;

export interface ProjectMigration {
  readonly version: number;
  readonly name: string;
}

export const PROJECT_MIGRATIONS: readonly ProjectMigration[] = [
  { version: 1, name: "normalized_research_store" },
  { version: 2, name: "research_asset_context_and_audit" },
  { version: 3, name: "normalized_source_folders" },
  { version: 4, name: "unified_typed_asset_context" },
];

export interface RunProjectMigrationsOptions {
  readonly clock?: Clock;
  readonly preferredSearchBackend?: "auto" | "deterministic";
}

export interface ProjectMigrationResult {
  readonly version: number;
  readonly searchBackend: SearchBackend;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return (
    database
      .prepare(
        `SELECT 1 FROM sqlite_schema
         WHERE type = 'table' AND name = ?`,
      )
      .get(table) !== undefined
  );
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  if (!tableExists(database, table)) {
    return new Set();
  }
  return new Set(
    database
      .prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
      .all()
      .map((row) => String(row.name)),
  );
}

function applyAssetLifecycleMigration(database: DatabaseSync): void {
  if (!tableColumns(database, "research_assets").has("deleted_at")) {
    database.exec(
      "ALTER TABLE research_assets ADD COLUMN deleted_at TEXT",
    );
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS research_asset_context (
      asset_id TEXT PRIMARY KEY,
      selected_at TEXT NOT NULL,
      FOREIGN KEY (asset_id) REFERENCES research_assets(id) ON DELETE RESTRICT
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS research_asset_audit_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id TEXT,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      created_at TEXT NOT NULL,
      FOREIGN KEY (asset_id) REFERENCES research_assets(id) ON DELETE RESTRICT,
      CHECK (length(event_type) BETWEEN 1 AND 100)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS research_asset_audit_asset_idx
      ON research_asset_audit_events(asset_id, event_id DESC);
    CREATE INDEX IF NOT EXISTS research_assets_deleted_idx
      ON research_assets(deleted_at, updated_at DESC, id);
  `);
}

function applyUnifiedAssetContextMigration(database: DatabaseSync): void {
  const columns = tableColumns(database, "research_asset_context");
  if (!columns.has("resource_type")) {
    database.exec(`
      ALTER TABLE research_asset_context
        RENAME TO research_asset_context_v2;

      CREATE TABLE research_asset_context (
        resource_type TEXT NOT NULL
          CHECK (resource_type IN ('document', 'research_asset')),
        resource_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 0),
        selected_at TEXT NOT NULL,
        PRIMARY KEY (resource_type, resource_id),
        UNIQUE (position),
        CHECK (length(resource_id) BETWEEN 1 AND 240),
        CHECK (
          resource_id NOT LIKE '%/%'
          AND resource_id NOT LIKE '%\\%'
        )
      ) STRICT, WITHOUT ROWID;

      INSERT INTO research_asset_context(
        resource_type, resource_id, position, selected_at
      )
      SELECT
        'research_asset',
        asset_id,
        ROW_NUMBER() OVER (ORDER BY selected_at, asset_id) - 1,
        selected_at
      FROM research_asset_context_v2
      ORDER BY selected_at, asset_id;

      DROP TABLE research_asset_context_v2;
    `);
  }

  database.exec(`
    CREATE TRIGGER IF NOT EXISTS research_asset_context_document_insert
    BEFORE INSERT ON research_asset_context
    WHEN NEW.resource_type = 'document'
      AND NOT EXISTS (
        SELECT 1
        FROM documents
        WHERE id = NEW.resource_id
          AND status = 'active'
          AND deleted_at IS NULL
      )
    BEGIN
      SELECT RAISE(ABORT, 'asset context document is not active');
    END;

    CREATE TRIGGER IF NOT EXISTS research_asset_context_asset_insert
    BEFORE INSERT ON research_asset_context
    WHEN NEW.resource_type = 'research_asset'
      AND NOT EXISTS (
        SELECT 1
        FROM research_assets
        WHERE id = NEW.resource_id
          AND status != 'archived'
          AND deleted_at IS NULL
      )
    BEGIN
      SELECT RAISE(ABORT, 'asset context research asset is not active');
    END;

    CREATE TRIGGER IF NOT EXISTS research_asset_context_document_inactive
    AFTER UPDATE OF status, deleted_at ON documents
    WHEN NEW.status != 'active' OR NEW.deleted_at IS NOT NULL
    BEGIN
      DELETE FROM research_asset_context
      WHERE resource_type = 'document' AND resource_id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS research_asset_context_document_deleted
    AFTER DELETE ON documents
    BEGIN
      DELETE FROM research_asset_context
      WHERE resource_type = 'document' AND resource_id = OLD.id;
    END;

    CREATE TRIGGER IF NOT EXISTS research_asset_context_asset_inactive
    AFTER UPDATE OF status, deleted_at ON research_assets
    WHEN NEW.status = 'archived' OR NEW.deleted_at IS NOT NULL
    BEGIN
      DELETE FROM research_asset_context
      WHERE resource_type = 'research_asset' AND resource_id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS research_asset_context_asset_deleted
    AFTER DELETE ON research_assets
    BEGIN
      DELETE FROM research_asset_context
      WHERE resource_type = 'research_asset' AND resource_id = OLD.id;
    END;
  `);
}

const SOURCE_FOLDER_SCHEMA = `
  CREATE TABLE source_folders (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    folder_kind TEXT NOT NULL DEFAULT 'manual',
    classification_key TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
      CHECK (sort_order BETWEEN -1000000 AND 1000000),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    FOREIGN KEY (parent_id) REFERENCES source_folders(id) ON DELETE RESTRICT,
    CHECK (length(id) BETWEEN 1 AND 240),
    CHECK (length(name) BETWEEN 1 AND 200),
    CHECK (length(normalized_name) BETWEEN 1 AND 200),
    CHECK (length(folder_kind) BETWEEN 1 AND 80),
    CHECK (
      classification_key IS NULL OR
      length(classification_key) BETWEEN 1 AND 240
    )
  ) STRICT;
  CREATE UNIQUE INDEX source_folders_active_sibling_name_idx
    ON source_folders(COALESCE(parent_id, ''), normalized_name)
    WHERE deleted_at IS NULL;
  CREATE UNIQUE INDEX source_folders_active_classification_idx
    ON source_folders(classification_key)
    WHERE deleted_at IS NULL AND classification_key IS NOT NULL;
  CREATE INDEX source_folders_parent_sort_idx
    ON source_folders(parent_id, deleted_at, sort_order, normalized_name, id);

  CREATE TABLE source_folder_assignments (
    document_id TEXT PRIMARY KEY,
    folder_id TEXT NOT NULL,
    assignment_source TEXT NOT NULL,
    classification_key TEXT,
    legacy_file_name TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    assigned_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
    FOREIGN KEY (folder_id) REFERENCES source_folders(id) ON DELETE RESTRICT,
    CHECK (length(assignment_source) BETWEEN 1 AND 100),
    CHECK (
      classification_key IS NULL OR
      length(classification_key) BETWEEN 1 AND 240
    ),
    CHECK (
      legacy_file_name IS NULL OR
      length(legacy_file_name) BETWEEN 1 AND 1000
    )
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX source_folder_assignments_folder_idx
    ON source_folder_assignments(folder_id, document_id);

  CREATE TABLE source_folder_audit_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id TEXT,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    CHECK (length(event_type) BETWEEN 1 AND 100)
  ) STRICT;
  CREATE INDEX source_folder_audit_folder_idx
    ON source_folder_audit_events(folder_id, event_id DESC);

  CREATE TABLE source_folder_migration_sources (
    dataset_id TEXT PRIMARY KEY,
    legacy_schema_version INTEGER NOT NULL CHECK (legacy_schema_version >= 0),
    legacy_updated_at TEXT,
    migrated_at TEXT NOT NULL
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE source_folder_migration_quarantine (
    quarantine_id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_table TEXT NOT NULL,
    source_key TEXT NOT NULL,
    reason TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX source_folder_quarantine_source_idx
    ON source_folder_migration_quarantine(source_table, source_key);
`;

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error("Unsafe source-folder migration identifier");
  }
  return `"${value}"`;
}

function migrationFolderName(value: string, fallback: string): {
  readonly name: string;
  readonly normalizedName: string;
} {
  let name = (value || fallback)
    .normalize("NFKC")
    .replaceAll("/", "／")
    .replaceAll("\\", "＼")
    .replaceAll("\0", "")
    .replaceAll(/\s+/gu, " ")
    .trim();
  if (name === "." || name === "..") {
    name = `Legacy ${name === "." ? "current" : "parent"} folder`;
  }
  name = name.slice(0, 200) || fallback.slice(0, 200) || "Legacy folder";
  return {
    name,
    normalizedName: name.toLocaleLowerCase("en-US"),
  };
}

function migrationIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(value);
}

function quarantineSourceFolderRow(
  database: DatabaseSync,
  sourceTable: string,
  sourceKey: string,
  reason: string,
  row: SqlRow,
  timestamp: string,
): void {
  database
    .prepare(
      `INSERT INTO source_folder_migration_quarantine(
         source_table, source_key, reason, payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      sourceTable,
      sourceKey || "unknown",
      reason,
      encodeJson(row),
      timestamp,
    );
}

function prepareLegacySourceFolderTables(database: DatabaseSync): void {
  const columns = tableColumns(database, "source_folders");
  if (
    columns.has("dataset_id") &&
    columns.has("folder_id") &&
    !columns.has("id")
  ) {
    if (tableExists(database, "legacy_source_folders_v0")) {
      throw new Error(
        "Both source_folders and legacy_source_folders_v0 contain legacy rows",
      );
    }
    database.exec(
      "ALTER TABLE source_folders RENAME TO legacy_source_folders_v0",
    );
  } else if (columns.size > 0 && !columns.has("id")) {
    throw new Error("Existing source_folders schema cannot be normalized");
  }
}

function availableMigrationFolderName(
  database: DatabaseSync,
  preferred: ReturnType<typeof migrationFolderName>,
  identity: string,
): ReturnType<typeof migrationFolderName> {
  if (
    database
      .prepare(
        `SELECT 1 FROM source_folders
         WHERE parent_id IS NULL AND normalized_name=?
           AND deleted_at IS NULL`,
      )
      .get(preferred.normalizedName) === undefined
  ) {
    return preferred;
  }
  const suffix = ` (${hash(identity).slice(0, 8)})`;
  return migrationFolderName(
    `${preferred.name.slice(0, 200 - suffix.length)}${suffix}`,
    "Legacy folder",
  );
}

function canonicalLegacyFolderId(
  database: DatabaseSync,
  datasetId: string,
  legacyFolderId: string,
): string {
  const preferred = migrationIdentifier(legacyFolderId)
    ? legacyFolderId
    : `folder_${hash(`${datasetId}\0${legacyFolderId}`).slice(0, 32)}`;
  if (
    database
      .prepare("SELECT 1 FROM source_folders WHERE id=?")
      .get(preferred) === undefined
  ) {
    return preferred;
  }
  return `folder_${hash(
    `${datasetId}\0${legacyFolderId}\0canonical`,
  ).slice(0, 32)}`;
}

function importLegacySourceFolders(
  database: DatabaseSync,
  timestamp: string,
): Map<string, string> {
  const folderMap = new Map<string, string>();
  for (const sourceTable of [
    "legacy_source_folders_v0",
    "source_folders_v2",
  ]) {
    if (!tableExists(database, sourceTable)) {
      continue;
    }
    const columns = tableColumns(database, sourceTable);
    if (!columns.has("folder_id") || !columns.has("name")) {
      continue;
    }
    for (const row of database
      .prepare(
        `SELECT * FROM ${quoteIdentifier(sourceTable)}
         ORDER BY dataset_id, folder_id`,
      )
      .all()) {
      const datasetId = legacyString(row, "dataset_id", "legacy-project");
      const legacyFolderId = legacyString(row, "folder_id");
      const mappingKey = `${datasetId}\0${legacyFolderId}`;
      if (!legacyFolderId) {
        quarantineSourceFolderRow(
          database,
          sourceTable,
          mappingKey,
          "missing_folder_id",
          row,
          timestamp,
        );
        continue;
      }
      const mapped = folderMap.get(mappingKey);
      if (mapped !== undefined) {
        continue;
      }
      const folderId = canonicalLegacyFolderId(
        database,
        datasetId,
        legacyFolderId,
      );
      const preferredName = migrationFolderName(
        legacyString(row, "name"),
        legacyFolderId,
      );
      const actualName = availableMigrationFolderName(
        database,
        preferredName,
        mappingKey,
      );
      const rawClassificationKey = legacyNullableString(
        row,
        "classification_key",
      );
      const classificationKey =
        rawClassificationKey !== null &&
        rawClassificationKey.length <= 240 &&
        database
          .prepare(
            `SELECT 1 FROM source_folders
             WHERE classification_key=? AND deleted_at IS NULL`,
          )
          .get(rawClassificationKey) === undefined
          ? rawClassificationKey
          : null;
      const folderKind =
        legacyString(row, "folder_kind", "legacy").slice(0, 80) ||
        "legacy";
      const createdAt =
        legacyString(row, "created_at", timestamp) || timestamp;
      const updatedAt =
        legacyString(row, "updated_at", createdAt) || createdAt;
      database
        .prepare(
          `INSERT INTO source_folders(
             id, parent_id, name, normalized_name, folder_kind,
             classification_key, sort_order, metadata_json,
             created_at, updated_at, deleted_at
           ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          folderId,
          actualName.name,
          actualName.normalizedName,
          folderKind,
          classificationKey,
          Number.isSafeInteger(row.sort_order)
            ? Number(row.sort_order)
            : 0,
          encodeJson({
            legacyDatasetId: datasetId,
            legacyFolderId,
            legacySourceTable: sourceTable,
            legacyClassificationKey: rawClassificationKey,
            legacyIsPinned:
              typeof row.is_pinned === "number"
                ? row.is_pinned === 1
                : null,
          }),
          createdAt,
          updatedAt,
        );
      database
        .prepare(
          `INSERT INTO source_folder_audit_events(
             folder_id, event_type, payload_json, created_at
           ) VALUES (?, 'legacy_imported', ?, ?)`,
        )
        .run(
          folderId,
          encodeJson({
            datasetId,
            legacyFolderId,
            sourceTable,
          }),
          timestamp,
        );
      folderMap.set(mappingKey, folderId);
    }
  }
  return folderMap;
}

function documentIdsByLegacyFilename(
  database: DatabaseSync,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const add = (value: string, documentId: string): void => {
    const normalized = value
      .normalize("NFKC")
      .replaceAll("\\", "/")
      .trim()
      .toLocaleLowerCase("en-US");
    if (!normalized) return;
    for (const key of [
      normalized,
      normalized.split("/").at(-1) ?? normalized,
    ]) {
      const matches = result.get(key) ?? new Set<string>();
      matches.add(documentId);
      result.set(key, matches);
    }
  };
  for (const row of database
    .prepare(
      `SELECT d.id, d.source_relpath, v.original_filename
       FROM documents d
       LEFT JOIN document_versions v ON v.document_id=d.id`,
    )
    .all()) {
    const documentId = legacyString(row, "id");
    if (!documentId) continue;
    add(legacyString(row, "source_relpath"), documentId);
    add(legacyString(row, "original_filename"), documentId);
  }
  return result;
}

function importLegacySourceFolderAssignments(
  database: DatabaseSync,
  timestamp: string,
  folderMap: ReadonlyMap<string, string>,
): void {
  const documents = documentIdsByLegacyFilename(database);
  for (const sourceTable of [
    "source_folder_file_assignments",
    "source_folder_file_assignments_v2",
  ]) {
    if (!tableExists(database, sourceTable)) {
      continue;
    }
    const columns = tableColumns(database, sourceTable);
    if (
      !columns.has("folder_id") ||
      !columns.has("file_name") ||
      !columns.has("dataset_id")
    ) {
      continue;
    }
    for (const row of database
      .prepare(
        `SELECT * FROM ${quoteIdentifier(sourceTable)}
         ORDER BY dataset_id, file_name`,
      )
      .all()) {
      const datasetId = legacyString(row, "dataset_id", "legacy-project");
      const legacyFolderId = legacyString(row, "folder_id");
      const fileName = legacyString(row, "file_name");
      const sourceKey = `${datasetId}\0${fileName}`;
      const folderId = folderMap.get(`${datasetId}\0${legacyFolderId}`);
      if (folderId === undefined) {
        quarantineSourceFolderRow(
          database,
          sourceTable,
          sourceKey,
          "folder_not_migrated",
          row,
          timestamp,
        );
        continue;
      }
      const normalizedFilename = fileName
        .normalize("NFKC")
        .replaceAll("\\", "/")
        .trim()
        .toLocaleLowerCase("en-US");
      const documentIds =
        documents.get(normalizedFilename) ??
        documents.get(
          normalizedFilename.split("/").at(-1) ?? normalizedFilename,
        ) ??
        new Set<string>();
      if (documentIds.size !== 1) {
        quarantineSourceFolderRow(
          database,
          sourceTable,
          sourceKey,
          documentIds.size === 0
            ? "document_not_found"
            : "ambiguous_document_filename",
          row,
          timestamp,
        );
        continue;
      }
      const documentId = [...documentIds][0]!;
      const existing = database
        .prepare(
          `SELECT folder_id FROM source_folder_assignments
           WHERE document_id=?`,
        )
        .get(documentId);
      if (
        existing !== undefined &&
        String(existing.folder_id) !== folderId
      ) {
        quarantineSourceFolderRow(
          database,
          sourceTable,
          sourceKey,
          "conflicting_document_assignment",
          row,
          timestamp,
        );
        continue;
      }
      if (existing !== undefined) {
        continue;
      }
      const updatedAt =
        legacyString(row, "updated_at", timestamp) || timestamp;
      database
        .prepare(
          `INSERT INTO source_folder_assignments(
             document_id, folder_id, assignment_source, classification_key,
             legacy_file_name, metadata_json, assigned_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          documentId,
          folderId,
          legacyString(row, "assignment_source", "legacy").slice(0, 100) ||
            "legacy",
          legacyNullableString(row, "classification_key")?.slice(0, 240) ??
            null,
          fileName.slice(0, 1_000) || null,
          encodeJson({
            legacyDatasetId: datasetId,
            legacyFolderId,
            legacySourceTable: sourceTable,
          }),
          updatedAt,
          updatedAt,
        );
    }
  }
}

function importLegacySourceFolderVersions(
  database: DatabaseSync,
  timestamp: string,
): void {
  if (!tableExists(database, "source_folder_schema_versions")) {
    return;
  }
  const columns = tableColumns(database, "source_folder_schema_versions");
  if (!columns.has("dataset_id") || !columns.has("schema_version")) {
    return;
  }
  for (const row of database
    .prepare(
      `SELECT * FROM source_folder_schema_versions
       ORDER BY dataset_id`,
    )
    .all()) {
    const datasetId = legacyString(row, "dataset_id", "legacy-project");
    const version = Math.max(0, legacyNumber(row, "schema_version", 0));
    database
      .prepare(
        `INSERT INTO source_folder_migration_sources(
           dataset_id, legacy_schema_version, legacy_updated_at, migrated_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(dataset_id) DO UPDATE SET
           legacy_schema_version=MAX(
             source_folder_migration_sources.legacy_schema_version,
             excluded.legacy_schema_version
           ),
           legacy_updated_at=COALESCE(
             excluded.legacy_updated_at,
             source_folder_migration_sources.legacy_updated_at
           )`,
      )
      .run(
        datasetId,
        version,
        legacyNullableString(row, "updated_at"),
        timestamp,
      );
  }
}

function applySourceFolderMigration(
  database: DatabaseSync,
  timestamp: string,
): void {
  prepareLegacySourceFolderTables(database);
  database.exec(SOURCE_FOLDER_SCHEMA);
  const folderMap = importLegacySourceFolders(database, timestamp);
  importLegacySourceFolderAssignments(
    database,
    timestamp,
    folderMap,
  );
  importLegacySourceFolderVersions(database, timestamp);
}

function detectSearchBackend(
  database: DatabaseSync,
  preference: "auto" | "deterministic",
): SearchBackend {
  if (preference === "deterministic") {
    return "deterministic";
  }
  for (const [name, tokenizer] of [
    ["fts5-trigram", "trigram"],
    ["fts5-unicode61", "unicode61"],
  ] as const) {
    try {
      database.exec(
        `CREATE VIRTUAL TABLE temp.__research_store_fts_probe
         USING fts5(value, tokenize='${tokenizer}')`,
      );
      database.exec("DROP TABLE temp.__research_store_fts_probe");
      return name;
    } catch {
      try {
        database.exec("DROP TABLE IF EXISTS temp.__research_store_fts_probe");
      } catch {
        // The probe table was never created.
      }
    }
  }
  return "deterministic";
}

function createSearchSchema(
  database: DatabaseSync,
  backend: SearchBackend,
): void {
  if (backend === "deterministic") {
    return;
  }
  const tokenizer = backend === "fts5-trigram" ? "trigram" : "unicode61";
  database.exec(`
    CREATE VIRTUAL TABLE evidence_fts USING fts5(
      evidence_id UNINDEXED,
      title,
      summary,
      original_text,
      tokenize='${tokenizer}'
    );
    CREATE TRIGGER evidence_fts_insert
    AFTER INSERT ON evidence
    BEGIN
      INSERT INTO evidence_fts(evidence_id, title, summary, original_text)
      VALUES (
        NEW.evidence_id,
        COALESCE(NEW.title, ''),
        COALESCE(NEW.summary, ''),
        NEW.original_text
      );
    END;
    CREATE TRIGGER evidence_fts_delete
    AFTER DELETE ON evidence
    BEGIN
      DELETE FROM evidence_fts WHERE evidence_id = OLD.evidence_id;
    END;
    CREATE TRIGGER evidence_fts_update
    AFTER UPDATE OF title, summary, original_text ON evidence
    BEGIN
      DELETE FROM evidence_fts WHERE evidence_id = OLD.evidence_id;
      INSERT INTO evidence_fts(evidence_id, title, summary, original_text)
      VALUES (
        NEW.evidence_id,
        COALESCE(NEW.title, ''),
        COALESCE(NEW.summary, ''),
        NEW.original_text
      );
    END;
  `);
}

function legacyString(
  row: SqlRow,
  key: string,
  fallback = "",
): string {
  const value = row[key];
  return typeof value === "string" ? value : fallback;
}

function legacyNullableString(row: SqlRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function legacyNumber(row: SqlRow, key: string, fallback = 0): number {
  const value = row[key];
  return typeof value === "number" ? value : fallback;
}

function normalizedRelpath(value: string): string {
  const components = value
    .normalize("NFKC")
    .replaceAll("\\", "/")
    .split("/")
    .filter((component) => component.length > 0 && component !== ".");
  return components.join("/") || "document";
}

function safeObject(value: unknown): Record<string, unknown> {
  const parsed = parseLegacyJson(value, {});
  return Array.isArray(parsed) ? {} : parsed;
}

function safeArray(value: unknown): unknown[] {
  const parsed = parseLegacyJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function validBbox(value: unknown): [number, number, number, number] | null {
  const parsed =
    typeof value === "string" ? safeArray(value) : Array.isArray(value) ? value : [];
  if (
    parsed.length !== 4 ||
    !parsed.every((coordinate) =>
      typeof coordinate === "number" && Number.isFinite(coordinate)
    )
  ) {
    return null;
  }
  return parsed as [number, number, number, number];
}

function mapLegacyVersionStatus(value: string): string {
  if (["parsing", "indexed", "needs_ocr", "failed"].includes(value)) {
    return value;
  }
  return value === "classification_review_required"
    ? "review_required"
    : "failed";
}

function mapLegacyLifecycle(value: string): string {
  if (
    ["pending", "active", "superseded", "removed", "failed_attempt"].includes(
      value,
    )
  ) {
    return value;
  }
  return "active";
}

function importLegacyDocuments(
  database: DatabaseSync,
  timestamp: string,
): Map<string, string> {
  const versionToDocument = new Map<string, string>();
  if (!tableExists(database, "legacy_documents_v0")) {
    return versionToDocument;
  }
  const rows = database
    .prepare("SELECT * FROM legacy_documents_v0 ORDER BY created_at, doc_id")
    .all();
  const ambiguousCounts = new Map<string, number>();
  for (const row of rows) {
    if (legacyNullableString(row, "logical_doc_id") !== null) {
      continue;
    }
    const key = `${legacyString(row, "dataset_id")}\0${normalizedRelpath(
      legacyString(
        row,
        "source_relpath",
        legacyString(row, "original_filename", "document"),
      ),
    )}`;
    ambiguousCounts.set(key, (ambiguousCounts.get(key) ?? 0) + 1);
  }

  const documentRows = new Map<string, SqlRow[]>();
  for (const row of rows) {
    const versionId = legacyString(row, "doc_id");
    if (!versionId) {
      continue;
    }
    const datasetId = legacyString(row, "dataset_id");
    const fallbackPath = normalizedRelpath(
      legacyString(
        row,
        "source_relpath",
        legacyString(row, "original_filename", versionId),
      ),
    );
    const ambiguousKey = `${datasetId}\0${fallbackPath}`;
    const existingLogicalKey = legacyNullableString(row, "logical_doc_id");
    const logicalKey =
      existingLogicalKey ??
      ((ambiguousCounts.get(ambiguousKey) ?? 0) > 1
        ? `legacy:${datasetId}:${versionId}`
        : `path:${datasetId}:${fallbackPath}`);
    const documentId = `doc_${hash(logicalKey).slice(0, 32)}`;
    versionToDocument.set(versionId, documentId);
    const grouped = documentRows.get(documentId) ?? [];
    grouped.push({ ...row, __logical_key: logicalKey });
    documentRows.set(documentId, grouped);
  }

  for (const [documentId, versions] of documentRows) {
    versions.sort(
      (left, right) =>
        legacyNumber(left, "version_no", 1) -
          legacyNumber(right, "version_no", 1) ||
        legacyString(left, "created_at").localeCompare(
          legacyString(right, "created_at"),
        ),
    );
    const latest = versions.at(-1)!;
    const explicitCurrent = [...versions].reverse().find(
      (row) =>
        legacyNumber(row, "is_current", 0) === 1 &&
        mapLegacyLifecycle(legacyString(row, "lifecycle_state", "active")) ===
          "active" &&
        legacyNullableString(row, "deleted_at") === null,
    );
    const current =
      explicitCurrent ??
      [...versions]
        .reverse()
        .find(
          (row) =>
            mapLegacyLifecycle(
              legacyString(row, "lifecycle_state", "active"),
            ) === "active" &&
            legacyNullableString(row, "deleted_at") === null,
        );
    const logicalKey = legacyString(latest, "__logical_key");
    const sourceRelpath = normalizedRelpath(
      legacyString(
        latest,
        "source_relpath",
        legacyString(latest, "original_filename", documentId),
      ),
    );
    const createdAt =
      legacyString(versions[0]!, "created_at", timestamp) || timestamp;
    const updatedAt =
      legacyString(latest, "updated_at", createdAt) || createdAt;
    const metadata = safeObject(latest.metadata_json);
    Object.assign(metadata, {
      legacy_dataset_id: legacyString(latest, "dataset_id"),
      legacy_doc_type: legacyNullableString(latest, "doc_type"),
      legacy_doc_subtype: legacyNullableString(latest, "doc_subtype"),
      legacy_classification_status: legacyNullableString(
        latest,
        "classification_status",
      ),
    });
    const logicalStatus =
      current !== undefined
        ? "active"
        : versions.some(
              (row) =>
                mapLegacyLifecycle(
                  legacyString(row, "lifecycle_state", "active"),
                ) === "removed",
            )
          ? "removed"
          : "archived";

    database
      .prepare(
        `INSERT OR IGNORE INTO documents(
           id, logical_key, source_root, source_relpath, title, status,
           current_version_id, current_version_no, metadata_json,
           created_at, updated_at, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?)`,
      )
      .run(
        documentId,
        logicalKey,
        legacyNullableString(latest, "source_root"),
        sourceRelpath,
        legacyString(
          latest,
          "title",
          legacyString(latest, "original_filename", documentId),
        ),
        logicalStatus,
        encodeJson(metadata),
        createdAt,
        updatedAt,
        current === undefined
          ? legacyString(latest, "deleted_at", updatedAt)
          : null,
      );

    for (const [index, row] of versions.entries()) {
      const versionId = legacyString(row, "doc_id");
      const versionNo = legacyNumber(row, "version_no", index + 1);
      const checksum =
        legacyString(row, "checksum") ||
        hash(`${versionId}\0${legacyString(row, "stored_path")}`);
      const versionMetadata = safeObject(row.metadata_json);
      Object.assign(versionMetadata, {
        legacy_parser_metadata: safeObject(row.parser_metadata_json),
        legacy_classification_metadata: safeObject(
          row.classification_metadata_json,
        ),
      });
      database
        .prepare(
          `INSERT OR IGNORE INTO document_versions(
             id, document_id, version_no, supersedes_version_id, sha256,
             original_filename, stored_path, file_type, mime_type, file_size,
             status, lifecycle, parser_name, parser_version, metadata_json,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          versionId,
          documentId,
          versionNo,
          legacyNullableString(row, "supersedes_doc_id"),
          checksum,
          legacyString(row, "original_filename", versionId),
          legacyString(row, "stored_path", `legacy://${versionId}`),
          legacyString(row, "file_type", "unknown"),
          Math.max(0, legacyNumber(row, "file_size", 0)),
          mapLegacyVersionStatus(legacyString(row, "status", "failed")),
          mapLegacyLifecycle(
            legacyString(row, "lifecycle_state", "active"),
          ),
          legacyNullableString(row, "parser_name"),
          legacyNullableString(row, "parser_version"),
          encodeJson(versionMetadata),
          legacyString(row, "created_at", timestamp) || timestamp,
          legacyString(row, "updated_at", timestamp) || timestamp,
        );
    }

    if (current !== undefined) {
      database
        .prepare(
          `UPDATE documents
           SET current_version_id = ?, current_version_no = ?
           WHERE id = ?`,
        )
        .run(
          legacyString(current, "doc_id"),
          legacyNumber(current, "version_no", 1),
          documentId,
        );
    }
  }
  return versionToDocument;
}

function insertLegacyEvidence(
  database: DatabaseSync,
  input: {
    evidenceId: string;
    kind: string;
    versionId: string;
    title?: string | null;
    summary?: string | null;
    originalText: string;
    contentHash?: string;
    locator: Record<string, unknown>;
    metadata: Record<string, unknown>;
    createdAt: string;
  },
): void {
  const bbox = validBbox(input.locator.bbox);
  const compactLocator = Object.fromEntries(
    Object.entries(input.locator).filter(
      ([, value]) => value !== null && value !== undefined,
    ),
  );
  const pageNumbers = Array.isArray(input.locator.pageNumbers)
    ? input.locator.pageNumbers
    : null;
  const nullableInteger = (key: string): number | null => {
    const value = input.locator[key];
    return typeof value === "number" && Number.isInteger(value)
      ? value
      : null;
  };
  const nullableText = (key: string): string | null => {
    const value = input.locator[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  database
    .prepare(
      `INSERT OR IGNORE INTO evidence(
         evidence_id, kind, document_version_id, title, summary,
         original_text, content_hash, source_locator_json,
         page_start, page_end, page_numbers_json, bbox_json,
         slide_start, slide_end, sheet_name, cell_range, cell_ref,
         heading_path, formula, display_value, raw_value,
         metadata_json, created_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       )`,
    )
    .run(
      input.evidenceId,
      input.kind,
      input.versionId,
      input.title ?? null,
      input.summary ?? null,
      input.originalText,
      input.contentHash ?? hash(input.originalText),
      encodeJson(compactLocator),
      nullableInteger("pageStart"),
      nullableInteger("pageEnd"),
      pageNumbers === null ? null : encodeJson(pageNumbers),
      bbox === null ? null : encodeJson(bbox),
      nullableInteger("slideStart"),
      nullableInteger("slideEnd"),
      nullableText("sheetName"),
      nullableText("cellRange"),
      nullableText("cellRef"),
      nullableText("headingPath"),
      nullableText("formula"),
      nullableText("displayValue"),
      nullableText("rawValue"),
      encodeJson(input.metadata),
      input.createdAt,
    );
}

function importLegacyEvidence(
  database: DatabaseSync,
  timestamp: string,
): void {
  const versionExists = database.prepare(
    "SELECT 1 FROM document_versions WHERE id = ?",
  );

  if (tableExists(database, "chunks")) {
    for (const row of database.prepare("SELECT * FROM chunks").all()) {
      const versionId = legacyString(row, "doc_id");
      const chunkId = legacyString(row, "chunk_id");
      if (!chunkId || versionExists.get(versionId) === undefined) {
        continue;
      }
      const location = tableExists(database, "chunk_locations")
        ? database
            .prepare(
              `SELECT * FROM chunk_locations
               WHERE chunk_id = ?
               ORDER BY location_index
               LIMIT 1`,
            )
            .get(chunkId)
        : undefined;
      const locator = {
        displayText:
          location === undefined
            ? legacyNullableString(row, "source_ref")
            : legacyNullableString(location, "display_text"),
        sourceRef: legacyNullableString(row, "source_ref"),
        pageStart:
          location === undefined
            ? null
            : legacyNumber(location, "page_start") || null,
        pageEnd:
          location === undefined
            ? null
            : legacyNumber(location, "page_end") || null,
        pageNumbers:
          location === undefined
            ? []
            : safeArray(location.page_numbers_json),
        bbox:
          location === undefined ? null : validBbox(location.bbox_json),
        slideStart:
          location === undefined
            ? null
            : legacyNumber(location, "slide_start") || null,
        slideEnd:
          location === undefined
            ? null
            : legacyNumber(location, "slide_end") || null,
        sheetName:
          location === undefined
            ? null
            : legacyNullableString(location, "sheet_name"),
        cellRange:
          location === undefined
            ? null
            : legacyNullableString(location, "cell_range"),
        headingPath:
          location === undefined
            ? legacyNullableString(row, "title_path")
            : legacyNullableString(location, "heading_path"),
      };
      const metadata = safeObject(row.metadata_json);
      if (location !== undefined) {
        metadata.location = safeObject(location.metadata_json);
        metadata.source_refs = safeArray(location.source_refs_json);
      }
      insertLegacyEvidence(database, {
        evidenceId: `chunk:${chunkId}`,
        kind: "chunk",
        versionId,
        title: legacyNullableString(row, "title_path"),
        summary: legacyNullableString(row, "summary"),
        originalText: legacyString(row, "content"),
        ...(legacyString(row, "content_hash")
          ? { contentHash: legacyString(row, "content_hash") }
          : {}),
        locator,
        metadata,
        createdAt: legacyString(row, "created_at", timestamp) || timestamp,
      });
    }
  }

  if (tableExists(database, "metric_facts")) {
    for (const row of database.prepare("SELECT * FROM metric_facts").all()) {
      const versionId = legacyString(row, "doc_id");
      const factId = legacyString(row, "fact_id");
      if (!factId || versionExists.get(versionId) === undefined) {
        continue;
      }
      const originalText = [
        legacyString(row, "metric_name"),
        legacyString(row, "period"),
        legacyString(row, "value_text"),
        legacyString(row, "unit"),
      ]
        .filter(Boolean)
        .join(" | ");
      const metadata = safeObject(row.metadata_json);
      Object.assign(metadata, {
        metric_name: legacyNullableString(row, "metric_name"),
        metric_alias: legacyNullableString(row, "metric_alias"),
        period: legacyNullableString(row, "period"),
        value_numeric:
          row.value_numeric === null ? null : legacyNumber(row, "value_numeric"),
        unit: legacyNullableString(row, "unit"),
        confidence:
          row.confidence === null ? null : legacyNumber(row, "confidence"),
        fact_status: legacyNullableString(row, "fact_status"),
        quality_status: legacyNullableString(row, "quality_status"),
        quality_issues: safeArray(row.quality_issues_json),
      });
      insertLegacyEvidence(database, {
        evidenceId: `fact:${factId}`,
        kind: "fact",
        versionId,
        title: legacyNullableString(row, "metric_name"),
        summary: originalText,
        originalText,
        locator: {
          displayText: legacyNullableString(row, "source_range"),
          sheetName: legacyNullableString(row, "sheet_name"),
          cellRange: legacyNullableString(row, "cell_ref"),
          cellRef: legacyNullableString(row, "cell_ref"),
          formula: legacyNullableString(row, "formula"),
          displayValue: legacyNullableString(row, "value_text"),
        },
        metadata,
        createdAt: timestamp,
      });
    }
  }

  if (tableExists(database, "excel_cells")) {
    for (const row of database.prepare("SELECT * FROM excel_cells").all()) {
      const versionId = legacyString(row, "doc_id");
      const cellId = legacyString(row, "cell_id");
      if (!cellId || versionExists.get(versionId) === undefined) {
        continue;
      }
      const display =
        legacyString(row, "display_value") ||
        legacyString(row, "raw_value");
      const originalText = [
        legacyString(row, "row_label"),
        legacyString(row, "col_label"),
        display,
      ]
        .filter(Boolean)
        .join(" | ");
      const metadata = safeObject(row.metadata_json);
      Object.assign(metadata, {
        row_index: legacyNumber(row, "row_index"),
        col_index: legacyNumber(row, "col_index"),
        numeric_value:
          row.numeric_value === null ? null : legacyNumber(row, "numeric_value"),
        cached_value: legacyNullableString(row, "cached_value"),
        number_format: legacyNullableString(row, "number_format"),
        period: legacyNullableString(row, "period"),
        unit: legacyNullableString(row, "unit"),
        formula_type: legacyNullableString(row, "formula_type"),
        formula_cache_status: legacyNullableString(
          row,
          "formula_cache_status",
        ),
      });
      insertLegacyEvidence(database, {
        evidenceId: `cell:${cellId}`,
        kind: "cell",
        versionId,
        title: legacyNullableString(row, "row_label"),
        summary: originalText,
        originalText,
        locator: {
          displayText: `${legacyString(row, "sheet_name")}!${legacyString(
            row,
            "cell_ref",
          )}`,
          sheetName: legacyNullableString(row, "sheet_name"),
          cellRange: legacyNullableString(row, "cell_ref"),
          cellRef: legacyNullableString(row, "cell_ref"),
          formula: legacyNullableString(row, "formula"),
          displayValue: legacyNullableString(row, "display_value"),
          rawValue: legacyNullableString(row, "raw_value"),
        },
        metadata,
        createdAt: timestamp,
      });
    }
  }

  if (tableExists(database, "pdf_pages")) {
    for (const row of database.prepare("SELECT * FROM pdf_pages").all()) {
      const versionId = legacyString(row, "doc_id");
      const pageId = legacyString(row, "page_id");
      if (!pageId || versionExists.get(versionId) === undefined) {
        continue;
      }
      const pageNumber = legacyNumber(row, "page_number");
      insertLegacyEvidence(database, {
        evidenceId: `page:${pageId}`,
        kind: "page",
        versionId,
        title: `Page ${String(pageNumber)}`,
        originalText: legacyString(row, "text"),
        locator: {
          displayText: `p.${String(pageNumber)}`,
          pageStart: pageNumber,
          pageEnd: pageNumber,
          pageNumbers: [pageNumber],
          bbox: validBbox(row.bbox_json),
        },
        metadata: safeObject(row.metadata_json),
        createdAt: timestamp,
      });
    }
  }
}

function importLegacySavedAssets(
  database: DatabaseSync,
  timestamp: string,
): void {
  if (!tableExists(database, "research_saved_assets")) {
    return;
  }
  for (const row of database
    .prepare("SELECT * FROM research_saved_assets ORDER BY created_at, asset_id")
    .all()) {
    const assetId = legacyString(row, "asset_id");
    const content = legacyString(row, "content_markdown");
    if (!assetId || !content) {
      continue;
    }
    const metadata = safeObject(row.metadata_json);
    metadata.legacy_workflow_id = legacyNullableString(row, "workflow_id");
    const tags = safeArray(row.tags_json).map(String).slice(0, 100);
    const revisionHash = hash(
      encodeJson({
        content,
        metadata,
        tags,
        sourceResponseId: legacyNullableString(row, "source_response_id"),
      }),
    );
    const versionId = `assetv_${hash(`${assetId}\0legacy\0${String(1)}`).slice(0, 32)}`;
    const createdAt = legacyString(row, "created_at", timestamp) || timestamp;
    const updatedAt = legacyString(row, "updated_at", createdAt) || createdAt;
    database
      .prepare(
        `INSERT OR IGNORE INTO research_assets(
           id, asset_type, title, status, current_version_id,
           current_version_no, created_at, updated_at, archived_at
         ) VALUES (?, ?, ?, 'completed', ?, 1, ?, ?, NULL)`,
      )
      .run(
        assetId,
        legacyString(row, "asset_type", "information"),
        legacyString(row, "title", assetId),
        versionId,
        createdAt,
        updatedAt,
      );
    database
      .prepare(
        `INSERT OR IGNORE INTO research_asset_versions(
           id, asset_id, version_no, status, summary, content_markdown,
           content_hash, source_response_id, structured_content_json,
           metadata_json, tags_json, created_at
         ) VALUES (?, ?, 1, 'completed', ?, ?, ?, ?, '{}', ?, ?, ?)`,
      )
      .run(
        versionId,
        assetId,
        legacyString(row, "summary"),
        content,
        revisionHash,
        legacyNullableString(row, "source_response_id"),
        encodeJson(metadata),
        encodeJson(tags),
        createdAt,
      );
  }
}

function mapAssetStatus(value: string): string {
  if (value === "pending" || value === "ready") {
    return "draft";
  }
  return [
    "draft",
    "running",
    "completed",
    "stale",
    "failed",
    "archived",
  ].includes(value)
    ? value
    : "completed";
}

function importLegacyResearchNodes(
  database: DatabaseSync,
  timestamp: string,
): void {
  if (
    !tableExists(database, "research_nodes") ||
    !tableExists(database, "research_node_versions")
  ) {
    return;
  }
  for (const node of database.prepare("SELECT * FROM research_nodes").all()) {
    const nodeId = legacyString(node, "node_id");
    if (!nodeId) {
      continue;
    }
    const assetId = `node:${nodeId}`;
    const status = mapAssetStatus(legacyString(node, "status", "completed"));
    const versions = database
      .prepare(
        `SELECT * FROM research_node_versions
         WHERE node_id = ?
         ORDER BY version_no`,
      )
      .all(nodeId);
    const currentNo = legacyNumber(node, "current_version_no");
    const current =
      versions.find((row) => legacyNumber(row, "version_no") === currentNo) ??
      versions.at(-1);
    const createdAt =
      legacyString(node, "created_at", timestamp) || timestamp;
    const updatedAt =
      legacyString(node, "updated_at", createdAt) || createdAt;
    database
      .prepare(
        `INSERT OR IGNORE INTO research_assets(
           id, asset_type, title, status, current_version_id,
           current_version_no, created_at, updated_at, archived_at
         ) VALUES (?, 'analysis', ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        assetId,
        legacyString(node, "title", nodeId),
        status,
        current === undefined
          ? null
          : legacyString(current, "node_version_id"),
        current === undefined ? 0 : legacyNumber(current, "version_no"),
        createdAt,
        updatedAt,
      );

    for (const version of versions) {
      const versionId = legacyString(version, "node_version_id");
      const content = legacyString(version, "output_markdown");
      const structured = safeObject(version.structured_output_json);
      const metadata = {
        legacy_workflow_id: legacyNullableString(version, "workflow_id"),
        legacy_input_manifest: safeObject(version.input_manifest_json),
        prompt_snapshot: legacyNullableString(version, "prompt_snapshot"),
        model_name: legacyNullableString(version, "model_name"),
      };
      const versionStatus = mapAssetStatus(
        legacyString(version, "status", status),
      );
      const versionHash = hash(
        encodeJson({
          legacyVersionNo: legacyNumber(version, "version_no", 1),
          content,
          structured,
          metadata,
          sourceResponseId: legacyNullableString(
            version,
            "source_response_id",
          ),
        }),
      );
      database
        .prepare(
          `INSERT OR IGNORE INTO research_asset_versions(
             id, asset_id, version_no, status, summary, content_markdown,
             content_hash, source_response_id, structured_content_json,
             metadata_json, tags_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
        )
        .run(
          versionId,
          assetId,
          legacyNumber(version, "version_no", 1),
          versionStatus,
          legacyString(node, "summary"),
          content,
          versionHash,
          legacyNullableString(version, "source_response_id"),
          encodeJson(structured),
          encodeJson(metadata),
          legacyString(version, "created_at", createdAt) || createdAt,
        );

      if (tableExists(database, "research_node_evidence")) {
        for (const reference of database
          .prepare(
            `SELECT * FROM research_node_evidence
             WHERE node_version_id = ?`,
          )
          .all(versionId)) {
          const evidenceId = legacyString(reference, "evidence_id");
          if (
            database
              .prepare("SELECT 1 FROM evidence WHERE evidence_id = ?")
              .get(evidenceId) === undefined
          ) {
            continue;
          }
          database
            .prepare(
              `INSERT OR IGNORE INTO research_asset_evidence(
                 asset_version_id, evidence_id, relation_type, quote, created_at
               ) VALUES (?, ?, ?, NULL, ?)`,
            )
            .run(
              versionId,
              evidenceId,
              legacyString(reference, "relation_type", "supports"),
              legacyString(version, "created_at", createdAt) || createdAt,
            );
        }
      }
    }
  }
}

function prepareLegacySchema(database: DatabaseSync): void {
  const columns = tableColumns(database, "documents");
  if (columns.has("doc_id") && !columns.has("id")) {
    if (tableExists(database, "legacy_documents_v0")) {
      throw new Error(
        "Both documents and legacy_documents_v0 contain legacy document data",
      );
    }
    database.exec("ALTER TABLE documents RENAME TO legacy_documents_v0");
  }
}

function readStoredBackend(database: DatabaseSync): SearchBackend {
  const row = database
    .prepare(
      `SELECT value FROM project_store_settings
       WHERE key = 'search_backend'`,
    )
    .get();
  const value = row?.value;
  if (
    value === "fts5-trigram" ||
    value === "fts5-unicode61" ||
    value === "deterministic"
  ) {
    return value;
  }
  throw new Error("Project database has no valid search backend setting");
}

export function runProjectMigrations(
  database: DatabaseSync,
  options: RunProjectMigrationsOptions = {},
): ProjectMigrationResult {
  const clock = options.clock ?? systemClock;
  database.exec(`
    CREATE TABLE IF NOT EXISTS project_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const applied = database
    .prepare(
      `SELECT version, name
       FROM project_schema_migrations
       ORDER BY version`,
    )
    .all();
  for (const row of applied) {
    const known = PROJECT_MIGRATIONS.find(
      (migration) => migration.version === Number(row.version),
    );
    if (known === undefined || known.name !== String(row.name)) {
      throw new Error(
        `Unknown project migration ${String(row.version)} (${String(row.name)})`,
      );
    }
  }

  let backend: SearchBackend;
  const appliedVersions = new Set(
    applied.map((row) => Number(row.version)),
  );
  if (applied.length === 0) {
    const backend = detectSearchBackend(
      database,
      options.preferredSearchBackend ?? "auto",
    );
    withProjectTransaction(database, () => {
      prepareLegacySchema(database);
      database.exec(INITIAL_SCHEMA);
      createSearchSchema(database, backend);
      const timestamp = isoNow(clock);
      database
        .prepare(
          `INSERT INTO project_store_settings(key, value, updated_at)
           VALUES ('search_backend', ?, ?)`,
        )
        .run(backend, timestamp);
      importLegacyDocuments(database, timestamp);
      importLegacyEvidence(database, timestamp);
      importLegacySavedAssets(database, timestamp);
      importLegacyResearchNodes(database, timestamp);
      database
        .prepare(
          `INSERT INTO project_schema_migrations(version, name, applied_at)
           VALUES (1, 'normalized_research_store', ?)`,
        )
        .run(timestamp);
    });
    appliedVersions.add(1);
    if (!appliedVersions.has(2)) {
      withProjectTransaction(database, () => {
        applyAssetLifecycleMigration(database);
        database
          .prepare(
            `INSERT INTO project_schema_migrations(version, name, applied_at)
             VALUES (2, 'research_asset_context_and_audit', ?)`,
          )
          .run(isoNow(clock));
      });
      appliedVersions.add(2);
    }
    if (!appliedVersions.has(3)) {
      withProjectTransaction(database, () => {
        const timestamp = isoNow(clock);
        applySourceFolderMigration(database, timestamp);
        database
          .prepare(
            `INSERT INTO project_schema_migrations(version, name, applied_at)
             VALUES (3, 'normalized_source_folders', ?)`,
          )
          .run(timestamp);
      });
      appliedVersions.add(3);
    }
    if (!appliedVersions.has(4)) {
      withProjectTransaction(database, () => {
        applyUnifiedAssetContextMigration(database);
        database
          .prepare(
            `INSERT INTO project_schema_migrations(version, name, applied_at)
             VALUES (4, 'unified_typed_asset_context', ?)`,
          )
          .run(isoNow(clock));
      });
      appliedVersions.add(4);
    }
    return { version: 4, searchBackend: backend };
  }

  backend = readStoredBackend(database);
  if (!appliedVersions.has(2)) {
    withProjectTransaction(database, () => {
      applyAssetLifecycleMigration(database);
      database
        .prepare(
          `INSERT INTO project_schema_migrations(version, name, applied_at)
           VALUES (2, 'research_asset_context_and_audit', ?)`,
        )
        .run(isoNow(clock));
    });
    appliedVersions.add(2);
  }
  if (!appliedVersions.has(3)) {
    withProjectTransaction(database, () => {
      const timestamp = isoNow(clock);
      applySourceFolderMigration(database, timestamp);
      database
        .prepare(
          `INSERT INTO project_schema_migrations(version, name, applied_at)
           VALUES (3, 'normalized_source_folders', ?)`,
        )
        .run(timestamp);
    });
    appliedVersions.add(3);
  }
  if (!appliedVersions.has(4)) {
    withProjectTransaction(database, () => {
      applyUnifiedAssetContextMigration(database);
      database
        .prepare(
          `INSERT INTO project_schema_migrations(version, name, applied_at)
           VALUES (4, 'unified_typed_asset_context', ?)`,
        )
        .run(isoNow(clock));
    });
    appliedVersions.add(4);
  }
  return {
    version: Math.max(...appliedVersions),
    searchBackend: backend,
  };
}
