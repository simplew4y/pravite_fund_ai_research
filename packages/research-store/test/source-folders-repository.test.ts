import { DatabaseSync } from "node:sqlite";

import { ConflictError } from "@private-fund/core";
import { describe, expect, it } from "vitest";

import {
  createResearchStore,
  openInMemoryProjectDatabase,
  runProjectMigrations,
} from "../src/index.js";

const FIXED_TIME = "2026-07-31T04:00:00.000Z";

function setup() {
  const database = openInMemoryProjectDatabase({
    clock: () => new Date(FIXED_TIME),
    preferredSearchBackend: "deterministic",
  });
  return {
    database,
    store: createResearchStore(
      database,
      () => new Date(FIXED_TIME),
    ),
  };
}

describe("SourceFoldersRepository", () => {
  it("builds a bounded tree and rejects duplicate names and cycles", () => {
    const { database, store } = setup();
    try {
      const root = store.sourceFolders.create({
        folderId: "folder-root",
        name: "财报与估值数据",
        folderKind: "manual",
        sortOrder: 10,
        metadata: { color: "blue" },
      });
      expect(root.created).toBe(true);
      expect(
        store.sourceFolders.create({
          folderId: "folder-root",
          name: " 财报与估值数据 ",
          folderKind: "manual",
          sortOrder: 10,
          metadata: { color: "blue" },
        }).created,
      ).toBe(false);
      const child = store.sourceFolders.create({
        folderId: "folder-child",
        parentId: root.folder.id,
        name: "2026 Q2",
        sortOrder: 1,
      }).folder;
      const grandchild = store.sourceFolders.create({
        folderId: "folder-grandchild",
        parentId: child.id,
        name: "Model",
      }).folder;

      expect(store.sourceFolders.listTree()).toEqual([
        expect.objectContaining({
          id: root.folder.id,
          depth: 0,
          path: ["财报与估值数据"],
          childCount: 1,
        }),
        expect.objectContaining({
          id: child.id,
          depth: 1,
          path: ["财报与估值数据", "2026 Q2"],
          childCount: 1,
        }),
        expect.objectContaining({
          id: grandchild.id,
          depth: 2,
          path: ["财报与估值数据", "2026 Q2", "Model"],
        }),
      ]);
      expect(() =>
        store.sourceFolders.create({
          parentId: root.folder.id,
          name: "2026 q2",
          metadata: { different: true },
        }),
      ).toThrow(ConflictError);
      expect(() =>
        store.sourceFolders.update(root.folder.id, {
          parentId: grandchild.id,
        }),
      ).toThrow(/cycle/u);

      const renamed = store.sourceFolders.update(child.id, {
        name: "2026 Q2 Results",
        sortOrder: 2,
      });
      expect(renamed).toMatchObject({
        parentId: root.folder.id,
        name: "2026 Q2 Results",
        sortOrder: 2,
      });
    } finally {
      database.close();
    }
  });

  it("moves each document atomically and only removes empty folders", () => {
    const { database, store } = setup();
    try {
      const document = store.documents.registerVersion({
        sourceRelpath: "reports/alpha.pdf",
        title: "Alpha report",
        originalFilename: "alpha.pdf",
        storedPath: "/tmp/alpha.pdf",
        fileType: "pdf",
        sha256: "a".repeat(64),
        fileSize: 100,
      }).document;
      const first = store.sourceFolders.create({
        folderId: "folder-first",
        name: "First",
      }).folder;
      const second = store.sourceFolders.create({
        folderId: "folder-second",
        name: "Second",
      }).folder;

      const assigned = store.sourceFolders.assignDocument(
        document.id,
        first.id,
        {
          assignmentSource: "manual",
          metadata: { actor: "user" },
        },
      );
      expect(assigned.created).toBe(true);
      expect(
        store.sourceFolders.assignDocument(document.id, first.id, {
          assignmentSource: "manual",
          metadata: { actor: "user" },
        }).created,
      ).toBe(false);
      const moved = store.sourceFolders.assignDocument(
        document.id,
        second.id,
        {
          assignmentSource: "manual",
          metadata: { actor: "user" },
        },
      );
      expect(moved).toMatchObject({
        created: false,
        assignment: {
          documentId: document.id,
          folderId: second.id,
        },
      });
      expect(store.sourceFolders.listAssignments(first.id)).toEqual([]);
      expect(store.sourceFolders.listAssignments(second.id)).toHaveLength(1);
      expect(() => store.sourceFolders.remove(second.id)).toThrow(
        /must be empty/u,
      );
      expect(store.sourceFolders.unassignDocument(document.id)).toBe(true);
      expect(store.sourceFolders.unassignDocument(document.id)).toBe(false);
      expect(store.sourceFolders.remove(second.id)).toMatchObject({
        id: second.id,
        deletedAt: FIXED_TIME,
      });
      expect(
        store.sourceFolders.listTree().map((folder) => folder.id),
      ).toEqual([first.id]);
      expect(
        Number(
          database.connection
            .prepare(
              "SELECT COUNT(*) AS count FROM source_folder_audit_events",
            )
            .get()?.count,
        ),
      ).toBe(6);
    } finally {
      database.close();
    }
  });

  it("adopts legacy v1 folders and filename assignments without losing source rows", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE documents (
          doc_id TEXT PRIMARY KEY,
          dataset_id TEXT NOT NULL,
          logical_doc_id TEXT,
          version_no INTEGER,
          is_current INTEGER,
          lifecycle_state TEXT,
          title TEXT,
          original_filename TEXT,
          source_relpath TEXT,
          stored_path TEXT,
          file_type TEXT,
          checksum TEXT,
          file_size INTEGER,
          status TEXT,
          created_at TEXT,
          updated_at TEXT
        );
        INSERT INTO documents VALUES (
          'legacy-doc-v1', 'dataset-1', 'logical-report', 1, 1, 'active',
          'Legacy report', 'report.pdf', 'reports/report.pdf',
          '/legacy/report.pdf', 'pdf', '${"b".repeat(64)}', 120, 'indexed',
          '${FIXED_TIME}', '${FIXED_TIME}'
        );

        CREATE TABLE source_folders (
          dataset_id TEXT NOT NULL,
          folder_id TEXT NOT NULL,
          folder_kind TEXT NOT NULL,
          classification_key TEXT,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (dataset_id, folder_id)
        );
        INSERT INTO source_folders VALUES (
          'dataset-1', 'folder-legacy', 'manual', NULL, 'Legacy Folder',
          '${FIXED_TIME}', '${FIXED_TIME}'
        );

        CREATE TABLE source_folder_file_assignments (
          dataset_id TEXT NOT NULL,
          file_name TEXT NOT NULL,
          folder_id TEXT NOT NULL,
          assignment_source TEXT NOT NULL,
          classification_key TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (dataset_id, file_name),
          FOREIGN KEY (dataset_id, folder_id)
            REFERENCES source_folders(dataset_id, folder_id)
        );
        INSERT INTO source_folder_file_assignments VALUES (
          'dataset-1', 'report.pdf', 'folder-legacy', 'manual', NULL,
          '${FIXED_TIME}'
        );

        CREATE TABLE source_folder_schema_versions (
          dataset_id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO source_folder_schema_versions VALUES (
          'dataset-1', 3, '${FIXED_TIME}'
        );
      `);

      expect(
        runProjectMigrations(database, {
          clock: () => new Date(FIXED_TIME),
          preferredSearchBackend: "deterministic",
        }),
      ).toMatchObject({ version: 4 });
      const store = createResearchStore(
        database,
        () => new Date(FIXED_TIME),
      );
      const folder = store.sourceFolders.get("folder-legacy");
      expect(folder).toMatchObject({
        name: "Legacy Folder",
        folderKind: "manual",
        metadata: {
          legacyDatasetId: "dataset-1",
          legacyFolderId: "folder-legacy",
        },
      });
      const assignment =
        store.sourceFolders.getAssignment(
          store.documents.list().items[0]!.id,
        );
      expect(assignment).toMatchObject({
        folderId: folder.id,
        assignmentSource: "manual",
        legacyFileName: "report.pdf",
      });
      expect(
        database
          .prepare(
            `SELECT legacy_schema_version
             FROM source_folder_migration_sources
             WHERE dataset_id='dataset-1'`,
          )
          .get()?.legacy_schema_version,
      ).toBe(3);
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM source_folder_migration_quarantine`,
          )
          .get()?.count,
      ).toBe(0);
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM legacy_source_folders_v0`,
          )
          .get()?.count,
      ).toBe(1);
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM source_folder_file_assignments",
          )
          .get()?.count,
      ).toBe(1);
    } finally {
      database.close();
    }
  });
});
