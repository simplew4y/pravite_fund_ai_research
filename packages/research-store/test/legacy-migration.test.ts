import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createResearchStore,
  openProjectDatabase,
  type ProjectDatabase,
} from "../src/index.js";

const FIXED_TIME = "2026-07-30T12:00:00.000Z";
const FILE_HASH = "a".repeat(64);

function createLegacyDatabase(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE documents (
      doc_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      logical_doc_id TEXT,
      version_no INTEGER,
      supersedes_doc_id TEXT,
      is_current INTEGER,
      lifecycle_state TEXT,
      title TEXT,
      original_filename TEXT,
      source_root TEXT,
      source_relpath TEXT,
      stored_path TEXT,
      file_type TEXT,
      doc_type TEXT,
      doc_subtype TEXT,
      classification_status TEXT,
      checksum TEXT,
      file_size INTEGER,
      status TEXT,
      metadata_json TEXT,
      parser_name TEXT,
      parser_version TEXT,
      parser_metadata_json TEXT,
      classification_metadata_json TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE chunks (
      chunk_id TEXT PRIMARY KEY,
      doc_id TEXT,
      content TEXT,
      content_type TEXT,
      title_path TEXT,
      summary TEXT,
      content_hash TEXT,
      source_ref TEXT,
      metadata_json TEXT,
      created_at TEXT
    );
    CREATE TABLE chunk_locations (
      location_id TEXT PRIMARY KEY,
      chunk_id TEXT,
      location_index INTEGER,
      page_start INTEGER,
      page_end INTEGER,
      page_numbers_json TEXT,
      slide_start INTEGER,
      slide_end INTEGER,
      sheet_name TEXT,
      cell_range TEXT,
      heading_path TEXT,
      bbox_json TEXT,
      source_refs_json TEXT,
      display_text TEXT,
      metadata_json TEXT
    );
    CREATE TABLE metric_facts (
      fact_id TEXT PRIMARY KEY,
      doc_id TEXT,
      metric_name TEXT,
      metric_alias TEXT,
      period TEXT,
      value_text TEXT,
      value_numeric REAL,
      unit TEXT,
      sheet_name TEXT,
      cell_ref TEXT,
      source_range TEXT,
      formula TEXT,
      confidence REAL,
      fact_status TEXT,
      quality_status TEXT,
      quality_issues_json TEXT,
      metadata_json TEXT
    );
    CREATE TABLE excel_cells (
      cell_id TEXT PRIMARY KEY,
      doc_id TEXT,
      sheet_name TEXT,
      cell_ref TEXT,
      row_index INTEGER,
      col_index INTEGER,
      display_value TEXT,
      raw_value TEXT,
      numeric_value REAL,
      formula TEXT,
      cached_value TEXT,
      number_format TEXT,
      row_label TEXT,
      col_label TEXT,
      period TEXT,
      unit TEXT,
      formula_type TEXT,
      formula_cache_status TEXT,
      metadata_json TEXT
    );
    CREATE TABLE pdf_pages (
      page_id TEXT PRIMARY KEY,
      doc_id TEXT,
      page_number INTEGER,
      text TEXT,
      bbox_json TEXT,
      metadata_json TEXT
    );
    CREATE TABLE research_saved_assets (
      asset_id TEXT PRIMARY KEY,
      workflow_id TEXT,
      asset_type TEXT,
      title TEXT,
      summary TEXT,
      content_markdown TEXT,
      source_response_id TEXT,
      metadata_json TEXT,
      tags_json TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE research_nodes (
      workflow_id TEXT,
      node_id TEXT,
      node_type TEXT,
      title TEXT,
      summary TEXT,
      status TEXT,
      current_version_no INTEGER,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE research_node_versions (
      node_version_id TEXT PRIMARY KEY,
      workflow_id TEXT,
      node_id TEXT,
      version_no INTEGER,
      status TEXT,
      input_manifest_json TEXT,
      output_markdown TEXT,
      structured_output_json TEXT,
      prompt_snapshot TEXT,
      model_name TEXT,
      source_response_id TEXT,
      created_at TEXT
    );
    CREATE TABLE research_node_evidence (
      node_version_id TEXT,
      evidence_id TEXT,
      relation_type TEXT
    );
  `);
  database
    .prepare(
      `INSERT INTO documents VALUES (
        'legacy-doc-v1', 'dataset-1', 'logical-company-report', 1, NULL,
        1, 'active', 'Company report', 'report.pdf', '/source', 'report.pdf',
        '/project/raw/report.pdf', 'pdf', 'financial_valuation_data',
        'financial_report', 'classified', ?, 1200, 'indexed',
        '{"legacy":true}', 'pymupdf', '1.24', '{"quality":"passed"}',
        '{"taxonomy":"v2"}', ?, ?, NULL
      )`,
    )
    .run(FILE_HASH, FIXED_TIME, FIXED_TIME);
  database
    .prepare(
      `INSERT INTO chunks VALUES (
        'chunk1', 'legacy-doc-v1',
        'Legacy revenue increased by twenty percent.',
        'pdf_page', 'Company report > page 3', 'Revenue growth',
        'chunk-hash', 'report.pdf p.3', '{"parser":"legacy"}', ?
      )`,
    )
    .run(FIXED_TIME);
  database.exec(`
    INSERT INTO chunk_locations VALUES (
      'loc1', 'chunk1', 0, 3, 3, '[3]', NULL, NULL, NULL, NULL,
      'Company report > page 3', '[10,20,300,400]', '["report.pdf p.3"]',
      'report.pdf p.3', '{"part_index":1}'
    );
    INSERT INTO metric_facts VALUES (
      'fact1', 'legacy-doc-v1', 'Revenue', 'revenue', '2026E',
      '120', 120, 'CNYm', 'Forecast', 'B7', 'Forecast!B7', '=B6*1.2',
      0.75, 'candidate', 'candidate_complete', '[]', '{"source":"excel"}'
    );
    INSERT INTO excel_cells VALUES (
      'cell1', 'legacy-doc-v1', 'Forecast', 'B7', 7, 2, '120', '=B6*1.2',
      120, '=B6*1.2', '120', '0.0', 'Revenue', '2026E', '2026E', 'CNYm',
      'normal', 'present', '{"sheet_role":"forecast"}'
    );
    INSERT INTO pdf_pages VALUES (
      'page3', 'legacy-doc-v1', 3,
      'Full original page text for the legacy revenue discussion.',
      '[0,0,595,842]', '{"method":"pymupdf"}'
    );
  `);
  database
    .prepare(
      `INSERT INTO research_saved_assets VALUES (
        'asset_saved', 'wf-1', 'information', 'Saved answer',
        'A durable note', 'Legacy saved asset body', 'response-1',
        '{"origin":"chat"}', '["important"]', ?, ?
      )`,
    )
    .run(FIXED_TIME, FIXED_TIME);
  database
    .prepare(
      `INSERT INTO research_nodes VALUES (
        'wf-1', 'analysis', 'analysis', 'Business analysis',
        'Revenue analysis', 'completed', 1, ?, ?
      )`,
    )
    .run(FIXED_TIME, FIXED_TIME);
  database
    .prepare(
      `INSERT INTO research_node_versions VALUES (
        'nv1', 'wf-1', 'analysis', 1, 'completed', '{}',
        'Revenue grew.', '{"content_blocks":[]}', 'prompt', 'model',
        'response-2', ?
      )`,
    )
    .run(FIXED_TIME);
  database.exec(`
    INSERT INTO research_node_evidence
    VALUES ('nv1', 'chunk:chunk1', 'supports');
  `);
  database.close();
}

describe("legacy project database migration", () => {
  const temporaryDirectories: string[] = [];
  const openDatabases: ProjectDatabase[] = [];

  afterEach(() => {
    for (const database of openDatabases.splice(0)) {
      database.close();
    }
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("imports the golden legacy schema with full citation traceability", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "research-store-legacy-"));
    temporaryDirectories.push(root);
    mkdirSync(path.join(root, "data"));
    const databasePath = path.join(root, "data", "project.sqlite");
    createLegacyDatabase(databasePath);

    const projectDatabase = openProjectDatabase({
      projectRoot: root,
      databasePath,
      clock: () => new Date(FIXED_TIME),
    });
    openDatabases.push(projectDatabase);
    const store = createResearchStore(
      projectDatabase,
      () => new Date(FIXED_TIME),
    );

    expect(store.documents.list().total).toBe(1);
    const document = store.documents.list().items[0]!;
    expect(document.currentVersionId).toBe("legacy-doc-v1");
    expect(store.documents.getCurrentVersion(document.id)?.sha256).toBe(
      FILE_HASH,
    );

    const chunk = store.evidence.trace("chunk:chunk1");
    expect(chunk.documentVersion.id).toBe("legacy-doc-v1");
    expect(chunk.document.id).toBe(document.id);
    expect(chunk.pageStart).toBe(3);
    expect(chunk.bbox).toEqual([10, 20, 300, 400]);
    expect(chunk.locator.displayText).toBe("report.pdf p.3");

    const fact = store.evidence.trace("fact:fact1");
    expect(fact.sheetName).toBe("Forecast");
    expect(fact.cellRef).toBe("B7");
    expect(fact.formula).toBe("=B6*1.2");
    expect(fact.metadata.value_numeric).toBe(120);

    const cell = store.evidence.trace("cell:cell1");
    expect(cell.locator.displayValue).toBe("120");
    expect(cell.locator.rawValue).toBe("=B6*1.2");
    expect(store.evidence.trace("page:page3").pageStart).toBe(3);

    const assets = store.assets.list();
    expect(assets.total).toBe(2);
    const savedAsset = store.assets.get("asset_saved");
    expect(savedAsset).toMatchObject({
      id: "asset_saved",
      assetType: "information",
      title: "Saved answer",
      status: "completed",
      currentVersionNo: 1,
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
      archivedAt: null,
      deletedAt: null,
    });
    const savedVersion = store.assets.getCurrentVersion("asset_saved");
    expect(savedVersion).toMatchObject({
      assetId: "asset_saved",
      versionNo: 1,
      status: "completed",
      summary: "A durable note",
      contentMarkdown: "Legacy saved asset body",
      sourceResponseId: "response-1",
      structuredContent: {},
      metadata: {
        origin: "chat",
        legacy_workflow_id: "wf-1",
      },
      tags: ["important"],
      createdAt: FIXED_TIME,
    });
    expect(savedAsset.currentVersionId).toBe(savedVersion?.id);
    const node = store.assets.get("node:analysis");
    const resolved = store.assets.resolveVersion(node.currentVersionId!);
    expect(resolved.version.id).toBe("nv1");
    expect(resolved.references[0]?.evidenceId).toBe("chunk:chunk1");
    expect(resolved.evidence[0]?.documentVersion.id).toBe("legacy-doc-v1");

    const search = store.evidence.search({ query: "Legacy revenue" });
    expect(search.items.map((item) => item.evidence.evidenceId)).toContain(
      "chunk:chunk1",
    );
    expect(
      projectDatabase.connection
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name = 'legacy_documents_v0'`,
        )
        .get(),
    ).toBeDefined();
  });

  it("reopening the golden database is migration-idempotent", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "research-store-reopen-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "project.sqlite");
    createLegacyDatabase(databasePath);

    const first = openProjectDatabase({
      projectRoot: root,
      databasePath,
    });
    first.close();
    const second = openProjectDatabase({
      projectRoot: root,
      databasePath,
    });
    openDatabases.push(second);

    expect(
      second.connection
        .prepare("SELECT COUNT(*) AS total FROM project_schema_migrations")
        .get()?.total,
    ).toBe(4);
    expect(
      second.connection.prepare("SELECT COUNT(*) AS total FROM evidence").get()
        ?.total,
    ).toBe(4);
    expect(
      second.connection
        .prepare("SELECT COUNT(*) AS total FROM research_assets")
        .get()?.total,
    ).toBe(2);
    expect(
      second.connection
        .prepare("SELECT COUNT(*) AS total FROM research_asset_versions")
        .get()?.total,
    ).toBe(2);
    expect(
      second.connection
        .prepare(
          `SELECT COUNT(*) AS total
           FROM research_asset_versions
           WHERE asset_id = 'asset_saved'`,
        )
        .get()?.total,
    ).toBe(1);
  });
});
