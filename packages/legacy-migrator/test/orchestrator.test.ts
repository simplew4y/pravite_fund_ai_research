import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  runLegacyMigration,
  type LegacyMigrationConfig,
} from "../src/index.js";
import {
  addAllNativeDomainFixture,
  ALL_NATIVE_GOLDEN_TABLES,
  DATASET_SCOPED_GOLDEN_TABLES,
  GOLDEN_INVALID_JSON_ROWS,
  GOLDEN_MODEL_OVERVIEW_HTML,
  GOLDEN_MODEL_OVERVIEW_JSON,
} from "./fixtures/all-native-domain.js";

const TENANT_NAMESPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_ID = "project-new";
const DATASET_ID = "dataset-old";
const FIXED_TIME = "2026-07-31T00:00:00.000Z";

interface Fixture {
  readonly root: string;
  readonly legacyRoot: string;
  readonly destinationRoot: string;
  readonly baselinePath: string;
  readonly projectRoot: string;
  readonly collectionPath: string;
  readonly sourcePath: string;
  readonly config: LegacyMigrationConfig;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function createFixture(): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "legacy-migrator-"));
  const legacyRoot = path.join(root, "legacy");
  const destinationRoot = path.join(root, "destination");
  const datasetRoot = path.join(legacyRoot, "tenant-a");
  const projectRoot = path.join(datasetRoot, DATASET_ID);
  const collectionPath = path.join(
    projectRoot,
    "meta",
    "collection.sqlite3",
  );
  const sourcePath = path.join(projectRoot, "raw", "report.pdf");
  mkdirSync(path.dirname(collectionPath), { recursive: true });
  mkdirSync(path.dirname(sourcePath), { recursive: true });
  const sourceBytes = Buffer.from("%PDF-1.4\nsynthetic legacy report\n");
  writeFileSync(sourcePath, sourceBytes);

  const registry = new DatabaseSync(
    path.join(datasetRoot, "datasets.sqlite3"),
  );
  registry.exec(`
    CREATE TABLE datasets (
      dataset_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      company_name TEXT,
      company_ticker TEXT
    ) STRICT;
    INSERT INTO datasets VALUES (
      '${DATASET_ID}', 'Mapped project', 'Mapped Co', 'MAP'
    );
  `);
  registry.close();

  const database = new DatabaseSync(collectionPath);
  database.exec(`
    CREATE TABLE documents (
      doc_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      logical_doc_id TEXT,
      version_no INTEGER NOT NULL,
      supersedes_doc_id TEXT,
      is_current INTEGER NOT NULL,
      lifecycle_state TEXT NOT NULL,
      title TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      source_root TEXT,
      source_relpath TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      file_type TEXT NOT NULL,
      checksum TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      status TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    ) STRICT;

    CREATE TABLE chunks (
      chunk_id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      content TEXT NOT NULL,
      content_type TEXT,
      title_path TEXT,
      summary TEXT,
      content_hash TEXT,
      source_ref TEXT,
      metadata_json TEXT,
      created_at TEXT
    ) STRICT;

    CREATE TABLE research_items (
      item_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      item_type TEXT NOT NULL,
      canonical_key TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      current_version_no INTEGER NOT NULL DEFAULT 0,
      current_version_id TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(dataset_id, item_type, canonical_key)
    ) STRICT;

    CREATE TABLE research_workflows (
      workflow_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      workflow_type TEXT NOT NULL,
      status TEXT NOT NULL,
      current_node_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(dataset_id, workflow_type)
    ) STRICT;

    CREATE TABLE legacy_preserved (
      dataset_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      value TEXT NOT NULL CHECK(length(value) > 0),
      PRIMARY KEY(dataset_id, source_key)
    ) STRICT, WITHOUT ROWID;
  `);
  database
    .prepare(
      `INSERT INTO documents VALUES (
         'doc-v1', ?, 'logical-report', 1, NULL, 1, 'active',
         'Legacy report', 'report.pdf', NULL, 'raw/report.pdf',
         'raw/report.pdf', 'pdf', ?, ?, 'indexed', '{}', ?, ?, NULL
       )`,
    )
    .run(
      DATASET_ID,
      sha256(sourceBytes),
      sourceBytes.length,
      FIXED_TIME,
      FIXED_TIME,
    );
  database
    .prepare(
      `INSERT INTO chunks VALUES (
         'chunk-v1', 'doc-v1', 'Revenue grew 20 percent.', 'pdf_page',
         'Report > Revenue', 'Revenue growth', 'chunk-hash',
         'report.pdf p.1', '{}', ?
       )`,
    )
    .run(FIXED_TIME);
  database
    .prepare(
      `INSERT INTO research_items VALUES (
         'item-v1', ?, 'thesis', 'growth', 'Growth thesis', 'active',
         0, NULL, ?, ?, ?, ?
       )`,
    )
    .run(
      DATASET_ID,
      FIXED_TIME,
      FIXED_TIME,
      FIXED_TIME,
      FIXED_TIME,
    );
  database
    .prepare(
      `INSERT INTO research_workflows VALUES (
         'workflow-v1', ?, 'agentic_research_graph_v2', 'active',
         NULL, ?, ?
       )`,
    )
    .run(DATASET_ID, FIXED_TIME, FIXED_TIME);
  database
    .prepare("INSERT INTO legacy_preserved VALUES (?, 'source-a', 'kept')")
    .run(DATASET_ID);
  database.close();

  const baselinePath = path.join(root, "baseline.json");
  writeFileSync(
    baselinePath,
    JSON.stringify({
      schemaVersion: 1,
      tables: [
        { name: "research_items" },
        { name: "valuation_model_series" },
        { name: "research_workflows" },
        { name: "obsidian_sync_outbox" },
        { name: "legacy_preserved" },
      ],
    }),
  );
  const config: LegacyMigrationConfig = {
    schemaVersion: 1,
    legacyRoot,
    destinationDataRoot: destinationRoot,
    baselinePath,
    tenants: [
      {
        legacyNamespace: "legacy-tenant-a",
        legacyDatasetRoot: "tenant-a",
        userId: "user-a",
        dataNamespace: TENANT_NAMESPACE,
        email: "owner@example.test",
        projects: [
          {
            legacyDatasetId: DATASET_ID,
            projectId: PROJECT_ID,
          },
        ],
      },
    ],
  };
  return {
    root,
    legacyRoot,
    destinationRoot,
    baselinePath,
    projectRoot,
    collectionPath,
    sourcePath,
    config,
  };
}

function addLegacyValuationParityFixture(fixture: Fixture): void {
  const database = new DatabaseSync(fixture.collectionPath);
  database.exec(`
    CREATE TABLE valuation_model_series (
      series_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      series_key TEXT NOT NULL,
      name TEXT NOT NULL,
      company_name TEXT,
      company_ticker TEXT,
      model_type TEXT,
      current_model_version_id TEXT,
      current_version_no INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(dataset_id, series_key)
    );
    CREATE TABLE valuation_model_versions (
      model_version_id TEXT PRIMARY KEY,
      series_id TEXT NOT NULL,
      dataset_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      logical_doc_id TEXT,
      document_version_no INTEGER NOT NULL,
      parent_model_version_id TEXT,
      reverted_to_version_id TEXT,
      checksum TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      document_date TEXT,
      model_type TEXT,
      node_count INTEGER NOT NULL DEFAULT 0,
      formula_node_count INTEGER NOT NULL DEFAULT 0,
      review_required_count INTEGER NOT NULL DEFAULT 0,
      analyzer_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(doc_id, analyzer_version)
    );
    CREATE TABLE valuation_market_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      series_id TEXT NOT NULL,
      model_version_id TEXT NOT NULL,
      company_name TEXT,
      company_ticker TEXT,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      as_of TEXT,
      error_message TEXT,
      raw_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE valuation_context_cards (
      card_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      model_version_id TEXT NOT NULL,
      source_doc_id TEXT NOT NULL,
      card_type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      insight TEXT NOT NULL,
      source_name TEXT NOT NULL,
      document_date TEXT,
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      UNIQUE(model_version_id, source_doc_id)
    );
    CREATE TABLE valuation_impact_cards (
      card_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      dataset_id TEXT NOT NULL,
      series_id TEXT NOT NULL,
      model_version_id TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      direction TEXT NOT NULL,
      horizon TEXT NOT NULL,
      confidence REAL NOT NULL,
      title TEXT NOT NULL,
      evidence_summary TEXT NOT NULL,
      valuation_impact TEXT NOT NULL,
      affected_inputs_json TEXT NOT NULL DEFAULT '[]',
      watch_items_json TEXT NOT NULL DEFAULT '[]',
      source_refs_json TEXT NOT NULL DEFAULT '[]',
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      UNIQUE(run_id, ordinal)
    );
    CREATE TABLE valuation_market_price_bars (
      bar_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_symbol TEXT NOT NULL,
      canonical_ticker TEXT NOT NULL,
      exchange TEXT NOT NULL,
      currency TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL NOT NULL,
      volume REAL,
      amount REAL,
      adjustment TEXT NOT NULL DEFAULT 'raw',
      source TEXT,
      fetched_at TEXT NOT NULL,
      UNIQUE(dataset_id, provider, provider_symbol, trade_date, adjustment)
    );
    CREATE TABLE valuation_price_comparisons (
      price_comparison_id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL,
      dataset_id TEXT NOT NULL,
      series_id TEXT NOT NULL,
      model_version_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_symbol TEXT,
      currency TEXT,
      valuation_date TEXT,
      benchmark_trade_date TEXT,
      benchmark_close REAL,
      latest_trade_date TEXT,
      latest_close REAL,
      target_price REAL,
      target_unit TEXT,
      target_source TEXT,
      target_evidence_id TEXT,
      implied_upside REAL,
      latest_upside REAL,
      status TEXT NOT NULL,
      error_message TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(model_version_id, snapshot_id)
    );
    CREATE TABLE valuation_impact_agent_runs (
      run_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      series_id TEXT NOT NULL,
      model_version_id TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      extractor_version TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      status TEXT NOT NULL,
      card_count INTEGER NOT NULL DEFAULT 0,
      output_json TEXT NOT NULL DEFAULT '{}',
      raw_response TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(model_version_id, source_fingerprint, extractor_version)
    );
    CREATE TABLE valuation_metric_agent_extractions (
      extraction_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      series_id TEXT NOT NULL,
      model_version_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      extractor_version TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      target_period TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      valuation_date TEXT,
      output_json TEXT NOT NULL DEFAULT '{}',
      raw_response TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(model_version_id, extractor_version, target_period)
    );
  `);
  database
    .prepare(
      `INSERT INTO valuation_model_series VALUES (
         'series-v1', ?, 'valuation-series', 'Mapped valuation',
         'Mapped Co', 'MAP', 'dcf', 'model-version-v1', 1, 'active', ?, ?
       )`,
    )
    .run(DATASET_ID, FIXED_TIME, FIXED_TIME);
  database
    .prepare(
      `INSERT INTO valuation_model_versions VALUES (
         'model-version-v1', 'series-v1', ?, 'doc-v1', 'logical-report', 1,
         NULL, NULL, 'model-checksum', 'snapshot-hash', 'report.pdf',
         '2026-06-30', 'dcf', 0, 0, 0, 'legacy-v1', ?
       )`,
    )
    .run(DATASET_ID, FIXED_TIME);
  database
    .prepare(
      `INSERT INTO valuation_market_snapshots VALUES (
         'snapshot-v1', ?, 'series-v1', 'model-version-v1', 'Mapped Co',
         'MAP', 'legacy-provider', 'completed', ?, NULL, '{}', ?
       )`,
    )
    .run(DATASET_ID, FIXED_TIME, FIXED_TIME);
  database
    .prepare(
      `INSERT INTO valuation_context_cards VALUES (
         'context-v1', ?, 'model-version-v1', 'doc-v1', 'company',
         'Mapped context', 'Legacy source summary', 'Legacy insight',
         'Legacy report', '2026-06-30', '["chunk:chunk-v1"]', ?
       )`,
    )
    .run(DATASET_ID, FIXED_TIME);
  database
    .prepare(
      `INSERT INTO valuation_impact_cards VALUES (
         'impact-v1', 'impact-run-v1', ?, 'series-v1', 'model-version-v1',
         'legacy-source-fingerprint', 0, 'positive', '12m', 0.8,
         'Legacy impact', 'Legacy source evidence', 'Legacy valuation impact',
         '[]', '[]', '[]', '["chunk:chunk-v1"]', ?
       )`,
    )
    .run(DATASET_ID, FIXED_TIME);
  database
    .prepare(
      `INSERT INTO valuation_market_price_bars VALUES (
         'bar-v1', ?, 'legacy-provider', 'MAP', 'MAP', 'TEST', 'CNY',
         '2026-07-30', 10, 12, 9, 11, 100, 1100, 'raw', 'legacy-feed', ?
       )`,
    )
    .run(DATASET_ID, FIXED_TIME);
  database
    .prepare(
      `INSERT INTO valuation_price_comparisons VALUES (
         'price-v1', 'snapshot-v1', ?, 'series-v1', 'model-version-v1',
         'legacy-provider', 'MAP', 'CNY', '2026-07-15', '2026-07-15', 10,
         '2026-07-30', 11, 14, 'CNY/share', 'DCF', 'cell:legacy-target',
         0.4, 0.2727, 'completed', NULL, '{"policy":"legacy"}', ?
       )`,
    )
    .run(DATASET_ID, FIXED_TIME);
  database
    .prepare(
      `INSERT INTO valuation_impact_agent_runs VALUES (
         'impact-run-v1', ?, 'series-v1', 'model-version-v1',
         'legacy-source-fingerprint', 'impact-v1', 'valuation-impact',
         'completed', 1, '{"cards":["impact-v1"]}', 'raw impact response',
         NULL, ?, ?
       )`,
    )
    .run(DATASET_ID, FIXED_TIME, FIXED_TIME);
  database
    .prepare(
      `INSERT INTO valuation_metric_agent_extractions VALUES (
         'metric-run-v1', ?, 'series-v1', 'model-version-v1', 'doc-v1',
         'metric-v1', 'valuation-metric', '2026Q2', 'completed',
         '2026-06-30', '{"metrics":[]}', 'raw metric response', NULL, ?, ?
       )`,
    )
    .run(DATASET_ID, FIXED_TIME, FIXED_TIME);
  database.close();
}

function addLegacyBusinessJobFixture(fixture: Fixture): void {
  const workbookPath = path.join(fixture.projectRoot, "raw", "model.xlsx");
  const workbookBytes = Buffer.from("synthetic legacy workbook bytes");
  writeFileSync(workbookPath, workbookBytes);

  const database = new DatabaseSync(fixture.collectionPath);
  database.exec(`
    CREATE TABLE research_tracking_jobs (
      job_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      job_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      extractor_version TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 4,
      available_at TEXT NOT NULL,
      locked_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      result_json TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(dataset_id, job_type, source_id, extractor_version)
    );
    CREATE TABLE valuation_tracking_jobs (
      job_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      job_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      analyzer_version TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 4,
      available_at TEXT NOT NULL,
      locked_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      result_json TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(dataset_id, job_type, source_id, analyzer_version)
    );
    CREATE TABLE research_equity_report_runs (
      run_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      dataset_id TEXT NOT NULL,
      report_id TEXT NOT NULL,
      report_version_id TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      request_json TEXT NOT NULL,
      report_package_json TEXT,
      artifact_manifest_json TEXT,
      render_engine TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(report_id, version_no)
    );
    CREATE TABLE valuation_agent_analyses (
      analysis_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      series_id TEXT NOT NULL,
      base_model_version_id TEXT NOT NULL,
      comparison_model_version_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      focus TEXT NOT NULL DEFAULT '',
      valuation_method TEXT,
      executive_summary TEXT,
      investment_conclusion TEXT,
      analysis_json TEXT NOT NULL DEFAULT '{}',
      planner_json TEXT NOT NULL DEFAULT '{}',
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      raw_response TEXT,
      model_name TEXT,
      agent_version TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(base_model_version_id, comparison_model_version_id, focus, agent_version)
    );
  `);
  database
    .prepare(
      `INSERT INTO documents VALUES (
         'doc-model-v1', ?, 'logical-model', 1, NULL, 1, 'active',
         'Legacy valuation model', 'model.xlsx', NULL, 'raw/model.xlsx',
         'raw/model.xlsx', 'xlsx', ?, ?, 'indexed', '{}', ?, ?, NULL
       )`,
    )
    .run(
      DATASET_ID,
      sha256(workbookBytes),
      workbookBytes.length,
      FIXED_TIME,
      FIXED_TIME,
    );
  database
    .prepare(
      `INSERT INTO valuation_agent_analyses VALUES (
         'analysis-v1', ?, 'series-history', 'base-history', NULL,
         'completed', 'historical focus', 'dcf', 'summary', 'conclusion',
         '{"changes":[]}', '{}', '[]', 'raw', 'legacy-model',
         'legacy-agent-v1', NULL, ?, ?, ?
       )`,
    )
    .run(DATASET_ID, FIXED_TIME, FIXED_TIME, FIXED_TIME);

  const insertResearch = database.prepare(
    `INSERT INTO research_tracking_jobs VALUES (
       ?, ?, ?, ?, ?, 'tracking-v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     )`,
  );
  insertResearch.run(
    "rtj-running",
    DATASET_ID,
    "manual_scan",
    "manual-1",
    '{"document_ids":["doc-v1"]}',
    "running",
    20,
    1,
    4,
    FIXED_TIME,
    FIXED_TIME,
    FIXED_TIME,
    null,
    null,
    "legacy warning",
    FIXED_TIME,
    FIXED_TIME,
  );
  insertResearch.run(
    "rtj-completed",
    DATASET_ID,
    "document_ingested",
    "doc-v1",
    '{"document_ids":["doc-v1"]}',
    "completed",
    50,
    1,
    4,
    FIXED_TIME,
    null,
    FIXED_TIME,
    FIXED_TIME,
    '{"items_created":2}',
    null,
    FIXED_TIME,
    FIXED_TIME,
  );
  insertResearch.run(
    "rtj-memo-audit",
    DATASET_ID,
    "memo_version_created",
    "memo-v1",
    '{"memo_version_id":"memo-v1"}',
    "queued",
    40,
    0,
    4,
    FIXED_TIME,
    null,
    null,
    null,
    null,
    null,
    FIXED_TIME,
    FIXED_TIME,
  );
  insertResearch.run(
    "rtj-unknown-audit",
    DATASET_ID,
    "legacy_magic_scan",
    "magic-v1",
    "{}",
    "queued",
    100,
    0,
    4,
    FIXED_TIME,
    null,
    null,
    null,
    null,
    null,
    FIXED_TIME,
    FIXED_TIME,
  );
  insertResearch.run(
    "rtj-invalid-json-audit",
    DATASET_ID,
    "manual_scan",
    "manual-invalid",
    "{",
    "queued",
    20,
    0,
    4,
    FIXED_TIME,
    null,
    null,
    null,
    null,
    null,
    FIXED_TIME,
    FIXED_TIME,
  );

  const insertValuation = database.prepare(
    `INSERT INTO valuation_tracking_jobs VALUES (
       ?, ?, ?, ?, ?, 'valuation-v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     )`,
  );
  insertValuation.run(
    "vtj-extract-running",
    DATASET_ID,
    "model_version_ingested",
    "doc-model-v1",
    '{"doc_id":"doc-model-v1"}',
    "running",
    41,
    1,
    4,
    FIXED_TIME,
    FIXED_TIME,
    FIXED_TIME,
    null,
    null,
    null,
    FIXED_TIME,
    FIXED_TIME,
  );
  insertValuation.run(
    "vtj-agent-completed",
    DATASET_ID,
    "agent_analysis",
    "analysis-v1",
    '{"analysis_id":"analysis-v1"}',
    "completed",
    60,
    1,
    4,
    FIXED_TIME,
    null,
    FIXED_TIME,
    FIXED_TIME,
    '{"analysis_id":"analysis-v1","status":"completed"}',
    null,
    FIXED_TIME,
    FIXED_TIME,
  );
  insertValuation.run(
    "vtj-market-completed",
    DATASET_ID,
    "market_data_refresh",
    "market-data:20260731",
    '{"refresh_bucket":"20260731"}',
    "completed",
    80,
    1,
    4,
    FIXED_TIME,
    null,
    FIXED_TIME,
    FIXED_TIME,
    '{"series_count":1}',
    null,
    FIXED_TIME,
    FIXED_TIME,
  );
  insertValuation.run(
    "vtj-market-pending-audit",
    DATASET_ID,
    "market_data_refresh",
    "market-data:20260801",
    '{"refresh_bucket":"20260801"}',
    "queued",
    80,
    0,
    4,
    FIXED_TIME,
    null,
    null,
    null,
    null,
    null,
    FIXED_TIME,
    FIXED_TIME,
  );
  insertValuation.run(
    "vtj-context-audit",
    DATASET_ID,
    "valuation_context_refresh",
    "fingerprint-v1",
    '{"document_fingerprint":"fingerprint-v1"}',
    "completed",
    70,
    1,
    4,
    FIXED_TIME,
    null,
    FIXED_TIME,
    FIXED_TIME,
    '{"series_count":1}',
    null,
    FIXED_TIME,
    FIXED_TIME,
  );
  insertValuation.run(
    "vtj-unknown-audit",
    DATASET_ID,
    "legacy_valuation_magic",
    "magic-v1",
    "{}",
    "queued",
    100,
    0,
    4,
    FIXED_TIME,
    null,
    null,
    null,
    null,
    null,
    FIXED_TIME,
    FIXED_TIME,
  );

  const insertReport = database.prepare(
    `INSERT INTO research_equity_report_runs VALUES (
       ?, 'workflow-v1', ?, 'report-v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     )`,
  );
  insertReport.run(
    "report-run-completed",
    DATASET_ID,
    "report-version-1",
    1,
    "completed",
    "Completed equity report",
    '{"company":"Mapped Co"}',
    '{"markdown":"reports/report.md"}',
    '{"artifacts":["report.pdf"]}',
    "finrobot-legacy",
    null,
    FIXED_TIME,
    FIXED_TIME,
    FIXED_TIME,
  );
  insertReport.run(
    "report-run-failed",
    DATASET_ID,
    "report-version-2",
    2,
    "failed",
    "Failed equity report",
    '{"company":"Mapped Co"}',
    null,
    null,
    "finrobot-legacy",
    "legacy render failed",
    FIXED_TIME,
    FIXED_TIME,
    null,
  );
  insertReport.run(
    "report-run-rendering-audit",
    DATASET_ID,
    "report-version-3",
    3,
    "rendering",
    "Interrupted equity report",
    '{"company":"Mapped Co"}',
    null,
    null,
    null,
    null,
    FIXED_TIME,
    FIXED_TIME,
    null,
  );
  database.close();
}

function destinationDatabase(fixture: Fixture): string {
  return path.join(
    fixture.destinationRoot,
    "users",
    TENANT_NAMESPACE,
    "projects",
    PROJECT_ID,
    "data",
    "research.sqlite3",
  );
}

describe("legacy migration orchestrator", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps dry-run strictly read-only while returning a complete plan", async () => {
    const fixture = createFixture();
    roots.push(fixture.root);
    const result = await runLegacyMigration({
      ...fixture.config,
      dryRun: true,
      reportPath: path.join(fixture.destinationRoot, "report.json"),
    });

    expect(result.report.status).toBe("planned");
    expect(result.report.projects[0]?.phases.map((phase) => phase.phase)).toEqual([
      "control",
      "files",
      "research",
      "workflow",
      "reconcile",
    ]);
    expect(result.report.legacyDataDeleted).toBe(false);
    expect(result.reportPath).toBeNull();
    expect(existsSync(fixture.destinationRoot)).toBe(false);
    expect(existsSync(fixture.collectionPath)).toBe(true);
    expect(existsSync(fixture.sourcePath)).toBe(true);
  });

  it("migrates an exact snapshot, rewrites scope/path, and reconciles idempotently", async () => {
    const fixture = createFixture();
    roots.push(fixture.root);
    const reportPath = path.join(
      fixture.destinationRoot,
      "migration",
      "machine-report.json",
    );
    const executionConfig = {
      ...fixture.config,
      reportPath,
    };
    const first = await runLegacyMigration(executionConfig);
    expect(first.report.status).toBe("completed");
    expect(first.reportPath).toBe(reportPath.replace("/var/", "/private/var/"));
    expect(
      JSON.parse(readFileSync(reportPath, "utf8")) as {
        status: string;
        legacyDataDeleted: boolean;
      },
    ).toMatchObject({
      status: "completed",
      legacyDataDeleted: false,
    });
    const project = first.report.projects[0]!;
    expect(project.status).toBe("completed");
    expect(project.phases.every((phase) => phase.status === "completed")).toBe(
      true,
    );
    expect(
      project.phases
        .find((phase) => phase.phase === "reconcile")
        ?.tables.every((table) => table.matched),
    ).toBe(true);

    const targetPath = destinationDatabase(fixture);
    const target = new DatabaseSync(targetPath, { readOnly: true });
    expect(
      target
        .prepare(
          "SELECT dataset_id, stored_path FROM legacy_documents_v0 WHERE doc_id='doc-v1'",
        )
        .get(),
    ).toEqual({
      dataset_id: PROJECT_ID,
      stored_path:
        "sources/legacy/dataset-old/doc-v1/report.pdf",
    });
    expect(
      target
        .prepare("SELECT dataset_id FROM research_items WHERE item_id='item-v1'")
        .get()?.dataset_id,
    ).toBe(PROJECT_ID);
    expect(
      target
        .prepare(
          "SELECT dataset_id FROM legacy_preserved WHERE source_key='source-a'",
        )
        .get()?.dataset_id,
    ).toBe(PROJECT_ID);
    expect(
      target
        .prepare("PRAGMA table_info(legacy_preserved)")
        .all()
        .filter((row) => Number(row.pk) > 0)
        .map((row) => row.name),
    ).toEqual(["dataset_id", "source_key"]);
    expect(
      target.prepare("SELECT COUNT(*) AS count FROM documents").get()?.count,
    ).toBe(1);
    expect(
      target
        .prepare("SELECT COUNT(*) AS count FROM document_versions")
        .get()?.count,
    ).toBe(1);
    expect(
      target.prepare("SELECT COUNT(*) AS count FROM evidence").get()?.count,
    ).toBe(1);
    expect(
      target
        .prepare(
          "SELECT manifest_sha256 FROM legacy_migration_manifest WHERE singleton=1",
        )
        .get()?.manifest_sha256,
    ).toBe(project.manifestSha256);
    target.close();

    const copiedFile = path.join(
      fixture.destinationRoot,
      "users",
      TENANT_NAMESPACE,
      "projects",
      PROJECT_ID,
      "sources",
      "legacy",
      DATASET_ID,
      "doc-v1",
      "report.pdf",
    );
    expect(readFileSync(copiedFile)).toEqual(
      readFileSync(fixture.sourcePath),
    );

    const control = new DatabaseSync(
      path.join(fixture.destinationRoot, "control.sqlite3"),
      { readOnly: true },
    );
    expect(
      control
        .prepare("SELECT id, data_namespace, email FROM users")
        .get(),
    ).toEqual({
      id: "user-a",
      data_namespace: TENANT_NAMESPACE,
      email: "owner@example.test",
    });
    expect(
      control
        .prepare(
          "SELECT id, user_id, name, company_name, ticker FROM projects",
        )
        .get(),
    ).toEqual({
      id: PROJECT_ID,
      user_id: "user-a",
      name: "Mapped project",
      company_name: "Mapped Co",
      ticker: "MAP",
    });
    control.close();

    const source = new DatabaseSync(fixture.collectionPath, {
      readOnly: true,
    });
    expect(
      source
        .prepare("SELECT dataset_id, stored_path FROM documents")
        .get(),
    ).toEqual({
      dataset_id: DATASET_ID,
      stored_path: "raw/report.pdf",
    });
    source.close();

    const second = await runLegacyMigration(executionConfig);
    expect(second.report.status).toBe("completed");
    expect(
      second.report.projects[0]?.phases.map((phase) => phase.attempt),
    ).toEqual([1, 1, 1, 1, 1]);
  });

  it("migrates a non-empty referentially closed golden graph for every native domain table", async () => {
    const fixture = createFixture();
    roots.push(fixture.root);
    addLegacyValuationParityFixture(fixture);
    addAllNativeDomainFixture({
      collectionPath: fixture.collectionPath,
      datasetId: DATASET_ID,
      fixedTime: FIXED_TIME,
    });

    const first = await runLegacyMigration(fixture.config);
    expect(first.report.status).toBe("completed");
    const firstReconciliation =
      first.report.projects[0]?.phases.find(
        (phase) => phase.phase === "reconcile",
      )?.tables ?? [];
    expect(
      ALL_NATIVE_GOLDEN_TABLES.map((table) => {
        const report = firstReconciliation.find(
          (candidate) => candidate.table === table,
        );
        return {
          table,
          mode: report?.mode,
          sourceRowsPositive: (report?.sourceRows ?? 0) > 0,
          rowCountsMatched:
            report?.sourceRows === report?.destinationRows,
          checksumMatched:
            report?.sourceChecksum === report?.destinationChecksum,
          matched: report?.matched,
        };
      }),
    ).toEqual(
      ALL_NATIVE_GOLDEN_TABLES.map((table) => ({
        table,
        mode: "native",
        sourceRowsPositive: true,
        rowCountsMatched: true,
        checksumMatched: true,
        matched: true,
      })),
    );

    const targetPath = destinationDatabase(fixture);
    const target = new DatabaseSync(targetPath, { readOnly: true });
    for (const table of DATASET_SCOPED_GOLDEN_TABLES) {
      expect(
        target
          .prepare(
            `SELECT DISTINCT dataset_id
             FROM "${table}"
             ORDER BY dataset_id`,
          )
          .all(),
        `${table} must remain inside the mapped project dataset`,
      ).toEqual([{ dataset_id: PROJECT_ID }]);
    }
    expect(
      target
        .prepare(
          `SELECT alert.dataset_id, alert.rule_id, alert.item_id,
                  alert.change_event_id, version.metadata_json,
                  relation.to_item_id
           FROM research_alerts AS alert
           JOIN research_item_versions AS version
             ON version.item_id=alert.item_id
           JOIN research_item_relations AS relation
             ON relation.from_item_id=alert.item_id
           WHERE alert.alert_id='research-alert-v1'`,
        )
        .get(),
    ).toEqual({
      dataset_id: PROJECT_ID,
      rule_id: "research-rule-v1",
      item_id: "item-v1",
      change_event_id: "change-event-v1",
      metadata_json: "{}",
      to_item_id: "item-v2",
    });
    expect(
      target
        .prepare(
          `SELECT report.workflow_id, version.node_versions_json,
                  version.document_versions_json,
                  node_version.structured_output_json,
                  dependency.depends_on_node_id
           FROM research_reports AS report
           JOIN research_report_versions AS version
             ON version.report_id=report.report_id
           JOIN research_node_versions AS node_version
             ON node_version.node_version_id='node-version-v1'
           JOIN research_node_dependencies AS dependency
             ON dependency.workflow_id=report.workflow_id
            AND dependency.node_id='node-b'
           WHERE report.report_id='report-v1'`,
        )
        .get(),
    ).toEqual({
      workflow_id: "workflow-v1",
      node_versions_json: '{"node-a":"node-version-v1"}',
      document_versions_json: '["doc-v1"]',
      structured_output_json: "{}",
      depends_on_node_id: "node-a",
    });
    expect(
      target
        .prepare(
          `SELECT derived.dataset_id, derived.series_id, derived.analysis_id,
                  derived.base_model_version_id, analysis.comparison_model_version_id,
                  change_row.node_id, actual.snapshot_id,
                  actual.metadata_json, comparison.metric_key
           FROM valuation_derived_models AS derived
           JOIN valuation_agent_analyses AS analysis
             ON analysis.analysis_id=derived.analysis_id
           JOIN valuation_model_changes AS change_row
             ON change_row.to_model_version_id=derived.base_model_version_id
           JOIN valuation_metric_actual_values AS actual
             ON actual.model_version_id=derived.base_model_version_id
           JOIN valuation_metric_comparisons AS comparison
             ON comparison.snapshot_id=actual.snapshot_id
            AND comparison.metric_key=actual.metric_key
           WHERE derived.derived_model_id='derived-model-v1'`,
        )
        .get(),
    ).toEqual({
      dataset_id: PROJECT_ID,
      series_id: "series-v1",
      analysis_id: "agent-analysis-v1",
      base_model_version_id: "model-version-v1",
      comparison_model_version_id: "model-version-v0",
      node_id: "valuation-node-v1",
      snapshot_id: "snapshot-v1",
      metadata_json: "{}",
      metric_key: "revenue",
    });
    expect(
      target
        .prepare(
          `SELECT dataset_id, series_id, model_version_id, doc_id, status,
                  overview_json, html, overview_version, created_at
           FROM valuation_model_overviews
           WHERE overview_id='overview-v1'`,
        )
        .get(),
    ).toEqual({
      dataset_id: PROJECT_ID,
      series_id: "series-v1",
      model_version_id: "model-version-v1",
      doc_id: "doc-v1",
      status: "completed",
      overview_json: GOLDEN_MODEL_OVERVIEW_JSON,
      html: GOLDEN_MODEL_OVERVIEW_HTML,
      overview_version: "legacy-overview-v1",
      created_at: FIXED_TIME,
    });
    expect(
      target
        .prepare(
          `SELECT outbox.dataset_id, outbox.entity_id, outbox.result_json,
                  registry.note_path, registry.sync_status
           FROM obsidian_sync_outbox AS outbox
           JOIN obsidian_note_registry AS registry
             ON registry.dataset_id=outbox.dataset_id
            AND registry.entity_type=outbox.entity_type
            AND registry.entity_id=outbox.entity_id
            AND registry.source_version=outbox.source_version
           WHERE outbox.event_id='obsidian-event-v1'`,
        )
        .get(),
    ).toEqual({
      dataset_id: PROJECT_ID,
      entity_id: "report-v1",
      result_json: "{}",
      note_path: "Reports/Mapped Co.md",
      sync_status: "synced",
    });
    expect(
      target
        .prepare(
          `SELECT table_name AS tableName, row_key AS rowKey,
                  column_name AS columnName, raw_value AS rawValue,
                  replacement_json AS replacementJson
           FROM workflow_store_legacy_json_quarantine
           WHERE row_key IN (
             'obsidian-event-v1',
             'item-version-v1',
             'node-version-v1',
             'actual-metric-v1'
           )
           ORDER BY table_name, row_key, column_name`,
        )
        .all(),
    ).toEqual(GOLDEN_INVALID_JSON_ROWS);
    expect(
      target
        .prepare(
          `SELECT owner_type, owner_id, evidence_id
           FROM workflow_store_evidence_references
           WHERE owner_id IN (
             'item-version-v1',
             'memo-section-v1',
             'node-version-v1',
             'valuation-change-v1'
           )
           ORDER BY owner_type, owner_id, evidence_id`,
        )
        .all(),
    ).toEqual([
      {
        owner_type: "memo-section",
        owner_id: "memo-section-v1",
        evidence_id: "chunk:chunk-v1",
      },
      {
        owner_type: "research-item-version",
        owner_id: "item-version-v1",
        evidence_id: "chunk:chunk-v1",
      },
      {
        owner_type: "valuation-change",
        owner_id: "valuation-change-v1",
        evidence_id: "chunk:chunk-v1",
      },
      {
        owner_type: "workflow-node-version",
        owner_id: "node-version-v1",
        evidence_id: "chunk:chunk-v1",
      },
    ]);
    const firstCounts = Object.fromEntries(
      ALL_NATIVE_GOLDEN_TABLES.map((table) => [
        table,
        Number(
          target
            .prepare(`SELECT COUNT(*) AS count FROM "${table}"`)
            .get()?.count,
        ),
      ]),
    );
    const firstQuarantineCount = Number(
      target
        .prepare(
          "SELECT COUNT(*) AS count FROM workflow_store_legacy_json_quarantine",
        )
        .get()?.count,
    );
    target.close();

    const source = new DatabaseSync(fixture.collectionPath, {
      readOnly: true,
    });
    expect(
      source
        .prepare(
          `SELECT dataset_id, metadata_json
           FROM research_items
           JOIN research_item_versions USING(item_id)
           WHERE item_version_id='item-version-v1'`,
        )
        .get(),
    ).toEqual({
      dataset_id: DATASET_ID,
      metadata_json: "not-json:item-metadata",
    });
    source.close();

    const replay = await runLegacyMigration(fixture.config);
    expect(replay.report.status).toBe("completed");
    const replayReconciliation =
      replay.report.projects[0]?.phases.find(
        (phase) => phase.phase === "reconcile",
      )?.tables ?? [];
    expect(
      ALL_NATIVE_GOLDEN_TABLES.every((table) => {
        const report = replayReconciliation.find(
          (candidate) => candidate.table === table,
        );
        return (
          (report?.sourceRows ?? 0) > 0 &&
          report?.sourceRows === report?.destinationRows &&
          report.sourceChecksum === report.destinationChecksum &&
          report.matched
        );
      }),
    ).toBe(true);

    const replayTarget = new DatabaseSync(targetPath, { readOnly: true });
    expect(
      Object.fromEntries(
        ALL_NATIVE_GOLDEN_TABLES.map((table) => [
          table,
          Number(
            replayTarget
              .prepare(`SELECT COUNT(*) AS count FROM "${table}"`)
              .get()?.count,
          ),
        ]),
      ),
    ).toEqual(firstCounts);
    expect(
      Number(
        replayTarget
          .prepare(
            "SELECT COUNT(*) AS count FROM workflow_store_legacy_json_quarantine",
          )
          .get()?.count,
      ),
    ).toBe(firstQuarantineCount);
    replayTarget.close();
  });

  it("resumes from durable phase checkpoints after an interruption", async () => {
    const fixture = createFixture();
    roots.push(fixture.root);
    let interrupted = false;
    const first = await runLegacyMigration(fixture.config, {
      hooks: {
        afterPhase(phase) {
          if (phase === "files" && !interrupted) {
            interrupted = true;
            throw new Error("simulated interruption");
          }
        },
      },
    });
    expect(first.report.status).toBe("failed");
    expect(existsSync(destinationDatabase(fixture))).toBe(false);
    expect(existsSync(fixture.collectionPath)).toBe(true);
    expect(existsSync(fixture.sourcePath)).toBe(true);

    const resumed = await runLegacyMigration(fixture.config);
    expect(resumed.report.status).toBe("completed");
    expect(
      resumed.report.projects[0]?.phases.map((phase) => [
        phase.phase,
        phase.attempt,
      ]),
    ).toEqual([
      ["control", 1],
      ["files", 1],
      ["research", 1],
      ["workflow", 1],
      ["reconcile", 1],
    ]);
  });

  it("normalizes auditable valuation sources and quarantines unverified Python Agent runs without inventing jobs", async () => {
    const fixture = createFixture();
    roots.push(fixture.root);
    addLegacyValuationParityFixture(fixture);

    const result = await runLegacyMigration(fixture.config);
    expect(result.report.status).toBe("completed");
    const project = result.report.projects[0]!;
    const reconciliationTables =
      project.phases.find((phase) => phase.phase === "reconcile")?.tables ?? [];
    expect(
      reconciliationTables
        .filter((table) =>
          [
            "valuation_context_cards",
            "valuation_impact_cards",
            "valuation_market_price_bars",
            "valuation_price_comparisons",
          ].includes(table.table),
        )
        .every((table) => table.mode === "native" && table.matched),
    ).toBe(true);
    expect(
      reconciliationTables.find(
        (table) => table.table === "@reconciliation/legacy-agent-runs",
      ),
    ).toMatchObject({
      mode: "normalized",
      sourceRows: 2,
      destinationRows: 2,
      matched: true,
    });

    const target = new DatabaseSync(destinationDatabase(fixture), {
      readOnly: true,
    });
    expect(
      target
        .prepare(
          `SELECT card_id, dataset_id, series_id, model_version_id
           FROM valuation_context_cards`,
        )
        .get(),
    ).toEqual({
      card_id: "context-v1",
      dataset_id: PROJECT_ID,
      series_id: "series-v1",
      model_version_id: "model-version-v1",
    });
    expect(
      target
        .prepare(
          `SELECT bar_id, dataset_id FROM valuation_market_price_bars`,
        )
        .get(),
    ).toEqual({ bar_id: "bar-v1", dataset_id: PROJECT_ID });
    expect(
      target
        .prepare(
          `SELECT price_comparison_id, target_evidence_id
           FROM valuation_price_comparisons`,
        )
        .get(),
    ).toEqual({
      price_comparison_id: "price-v1",
      target_evidence_id: "cell:legacy-target",
    });
    expect(
      target
        .prepare(`SELECT COUNT(*) AS count FROM valuation_impact_cards`)
        .get()?.count,
    ).toBe(0);
    expect(
      target
        .prepare(
          `SELECT table_name, row_key
           FROM workflow_store_legacy_row_quarantine
           WHERE table_name='valuation_impact_cards'`,
        )
        .get(),
    ).toEqual({
      table_name: "valuation_impact_cards",
      row_key: "impact-v1",
    });
    expect(
      target
        .prepare(
          `SELECT legacy_table, legacy_run_id, target_job_type,
                  control_job_id, disposition, source_fingerprint
           FROM legacy_agent_run_reconciliation_manifest
           ORDER BY legacy_table`,
        )
        .all(),
    ).toEqual([
      {
        legacy_table: "valuation_impact_agent_runs",
        legacy_run_id: "impact-run-v1",
        target_job_type: "valuation.compare",
        control_job_id: null,
        disposition: "quarantined",
        source_fingerprint: project.sourceFingerprint,
      },
      {
        legacy_table: "valuation_metric_agent_extractions",
        legacy_run_id: "metric-run-v1",
        target_job_type: "valuation.extract",
        control_job_id: null,
        disposition: "quarantined",
        source_fingerprint: project.sourceFingerprint,
      },
    ]);
    expect(
      target
        .prepare(
          `SELECT card_id FROM legacy_valuation_impact_cards_v0`,
        )
        .get()?.card_id,
    ).toBe("impact-v1");
    target.close();

    const control = new DatabaseSync(
      path.join(fixture.destinationRoot, "control.sqlite3"),
      { readOnly: true },
    );
    expect(control.prepare("SELECT COUNT(*) AS count FROM jobs").get()?.count).toBe(
      0,
    );
    control.close();
  });

  it("maps legacy business queues into tenant-scoped canonical jobs and exactly audits unsafe rows", async () => {
    const fixture = createFixture();
    roots.push(fixture.root);
    addLegacyBusinessJobFixture(fixture);

    const first = await runLegacyMigration(fixture.config);
    expect(first.report.status).toBe("completed");
    const reconciliation =
      first.report.projects[0]?.phases.find(
        (phase) => phase.phase === "reconcile",
      )?.tables ?? [];
    expect(
      reconciliation
        .filter((table) => table.table.startsWith("@control/"))
        .map((table) => ({
          table: table.table,
          sourceRows: table.sourceRows,
          destinationRows: table.destinationRows,
          matched: table.matched,
        })),
    ).toEqual([
      {
        table: "@control/research_equity_report_runs",
        sourceRows: 3,
        destinationRows: 3,
        matched: true,
      },
      {
        table: "@control/research_tracking_jobs",
        sourceRows: 5,
        destinationRows: 5,
        matched: true,
      },
      {
        table: "@control/valuation_tracking_jobs",
        sourceRows: 6,
        destinationRows: 6,
        matched: true,
      },
    ]);

    const controlPath = path.join(
      fixture.destinationRoot,
      "control.sqlite3",
    );
    const control = new DatabaseSync(controlPath);
    expect(
      control
        .prepare(
          `SELECT COUNT(*) AS count
           FROM jobs
           WHERE tenant_namespace=? AND project_id=?`,
        )
        .get(TENANT_NAMESPACE, PROJECT_ID)?.count,
    ).toBe(7);
    expect(
      control
        .prepare(
          `SELECT legacy_table, legacy_row_id, disposition,
                  target_job_type, reason_code, jobs.type, jobs.status,
                  jobs.attempt, jobs.max_attempts, jobs.error
           FROM legacy_business_job_reconciliation AS reconciliation
           LEFT JOIN jobs ON jobs.id=reconciliation.canonical_job_id
           WHERE reconciliation.tenant_namespace=?
             AND reconciliation.project_id=?
           ORDER BY legacy_table, legacy_row_id`,
        )
        .all(TENANT_NAMESPACE, PROJECT_ID),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          legacy_table: "research_tracking_jobs",
          legacy_row_id: "rtj-running",
          disposition: "mapped",
          target_job_type: "tracking.scan",
          reason_code: "running_requeued",
          type: "tracking.scan",
          status: "queued",
          attempt: 1,
          max_attempts: 4,
          error: "legacy warning",
        }),
        expect.objectContaining({
          legacy_table: "research_tracking_jobs",
          legacy_row_id: "rtj-memo-audit",
          disposition: "audited",
          target_job_type: "tracking.scan",
          reason_code: "unsupported_memo_tracking_semantics",
          type: null,
          status: null,
        }),
        expect.objectContaining({
          legacy_table: "research_tracking_jobs",
          legacy_row_id: "rtj-invalid-json-audit",
          disposition: "audited",
          target_job_type: "tracking.scan",
          reason_code: "invalid_json",
        }),
        expect.objectContaining({
          legacy_table: "valuation_tracking_jobs",
          legacy_row_id: "vtj-extract-running",
          disposition: "mapped",
          target_job_type: "valuation.extract",
          reason_code: "running_requeued",
          type: "valuation.extract",
          status: "queued",
        }),
        expect.objectContaining({
          legacy_table: "valuation_tracking_jobs",
          legacy_row_id: "vtj-market-pending-audit",
          disposition: "audited",
          target_job_type: "market.refresh",
          reason_code: "requires_series_fanout",
        }),
        expect.objectContaining({
          legacy_table: "valuation_tracking_jobs",
          legacy_row_id: "vtj-context-audit",
          disposition: "audited",
          target_job_type: null,
          reason_code: "unsupported_aggregate_refresh",
        }),
        expect.objectContaining({
          legacy_table: "research_equity_report_runs",
          legacy_row_id: "report-run-completed",
          disposition: "mapped",
          target_job_type: "report.generate",
          type: "report.generate",
          status: "completed",
        }),
        expect.objectContaining({
          legacy_table: "research_equity_report_runs",
          legacy_row_id: "report-run-rendering-audit",
          disposition: "audited",
          target_job_type: "report.generate",
          reason_code: "unrecoverable_legacy_render",
        }),
      ]),
    );

    const valuationPayload = JSON.parse(
      String(
        control
          .prepare(
            `SELECT jobs.payload_json
             FROM legacy_business_job_reconciliation AS reconciliation
             JOIN jobs ON jobs.id=reconciliation.canonical_job_id
             WHERE reconciliation.legacy_table='valuation_tracking_jobs'
               AND reconciliation.legacy_row_id='vtj-extract-running'`,
          )
          .get()?.payload_json,
      ),
    ) as Record<string, unknown>;
    expect(valuationPayload).toMatchObject({
      datasetId: PROJECT_ID,
      action: "extract",
      documentVersionId: "doc-model-v1",
      computeOperation: "extract_workbook",
      legacyMigration: {
        sourceDatasetId: DATASET_ID,
        sourceTable: "valuation_tracking_jobs",
        sourceRowId: "vtj-extract-running",
      },
    });
    expect(path.isAbsolute(String(valuationPayload.inputPath))).toBe(true);
    expect(String(valuationPayload.inputPath)).toContain(
      `/users/${TENANT_NAMESPACE}/projects/${PROJECT_ID}/`,
    );
    expect(
      control
        .prepare(
          `SELECT json_extract(legacy_row_json, '$.dataset_id') AS dataset_id
           FROM legacy_business_job_reconciliation
           WHERE legacy_row_id='vtj-extract-running'`,
        )
        .get()?.dataset_id,
    ).toBe(DATASET_ID);
    expect(() =>
      control
        .prepare(
          `INSERT INTO legacy_business_job_reconciliation(
             reconciliation_id, tenant_namespace, project_id,
             source_fingerprint, legacy_table, legacy_row_id,
             legacy_status, legacy_type, legacy_row_sha256,
             legacy_row_json, target_job_type, canonical_job_id,
             canonical_job_immutable_sha256, disposition, reason_code,
             reason, reconciled_at
           ) VALUES (
             'lbj_cross_tenant', ?, ?, ?, 'research_tracking_jobs',
             'forged-row', 'queued', 'manual_scan', ?, '{}', NULL, NULL,
             NULL, 'audited', 'forged', 'forged tenant row', ?
           )`,
        )
        .run(
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          PROJECT_ID,
          "f".repeat(64),
          sha256(Buffer.from("{}")),
          FIXED_TIME,
        ),
    ).toThrow(/tenant_project_mismatch/u);
    expect(() =>
      control
        .prepare(
          `UPDATE legacy_business_job_reconciliation
           SET reason='mutated'
           WHERE legacy_row_id='rtj-memo-audit'`,
        )
        .run(),
    ).toThrow(/legacy_business_job_reconciliation_is_immutable/u);

    const mutableJob = control
      .prepare(
        `SELECT canonical_job_id
         FROM legacy_business_job_reconciliation
         WHERE legacy_table='research_tracking_jobs'
           AND legacy_row_id='rtj-running'`,
      )
      .get();
    const mutableJobId = String(mutableJob?.canonical_job_id);
    control
      .prepare(
        `UPDATE jobs
         SET status='failed', completed_at=?, updated_at=?,
             error='post-migration worker failure'
         WHERE id=?`,
      )
      .run(FIXED_TIME, FIXED_TIME, mutableJobId);
    control.close();

    const replay = await runLegacyMigration(fixture.config);
    expect(replay.report.status).toBe("completed");
    const replayControl = new DatabaseSync(controlPath);
    expect(
      replayControl.prepare("SELECT COUNT(*) AS count FROM jobs").get()?.count,
    ).toBe(7);
    expect(
      replayControl
        .prepare(
          "SELECT COUNT(*) AS count FROM legacy_business_job_reconciliation",
        )
        .get()?.count,
    ).toBe(14);
    replayControl
      .prepare("UPDATE jobs SET payload_json='{}' WHERE id=?")
      .run(mutableJobId);
    replayControl.close();

    const conflict = await runLegacyMigration(fixture.config);
    expect(conflict.report.status).toBe("failed");
    expect(conflict.report.errors.join("\n")).toMatch(
      /no longer matches|reconciliation/u,
    );
  });

  it("rejects an existing target without the exact manifest and never overwrites it", async () => {
    const fixture = createFixture();
    roots.push(fixture.root);
    const targetPath = destinationDatabase(fixture);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    const target = new DatabaseSync(targetPath);
    target.exec("CREATE TABLE foreign_data(value TEXT); INSERT INTO foreign_data VALUES ('keep')");
    target.close();
    const before = readFileSync(targetPath);

    const result = await runLegacyMigration(fixture.config);
    expect(result.report.status).toBe("failed");
    expect(result.report.errors.join("\n")).toMatch(/manifest/u);
    expect(readFileSync(targetPath)).toEqual(before);
    expect(existsSync(fixture.collectionPath)).toBe(true);
  });

  it("rejects changed mapping metadata after publication", async () => {
    const fixture = createFixture();
    roots.push(fixture.root);
    expect((await runLegacyMigration(fixture.config)).report.status).toBe(
      "completed",
    );
    const changed: LegacyMigrationConfig = {
      ...fixture.config,
      tenants: fixture.config.tenants.map((tenant) => ({
        ...tenant,
        projects: tenant.projects.map((project) => ({
          ...project,
          name: "Conflicting project name",
        })),
      })),
    };
    const result = await runLegacyMigration(changed);
    expect(result.report.status).toBe("failed");
    expect(result.report.errors.join("\n")).toMatch(/manifest/u);
  });

  it("rejects cross-dataset rows before writing any destination state", async () => {
    const fixture = createFixture();
    roots.push(fixture.root);
    const database = new DatabaseSync(fixture.collectionPath);
    database
      .prepare("UPDATE research_items SET dataset_id='another-dataset'")
      .run();
    database.close();

    const result = await runLegacyMigration({
      ...fixture.config,
      dryRun: true,
    });
    expect(result.report.status).toBe("failed");
    expect(result.report.errors.join("\n")).toMatch(/foreign dataset IDs/u);
    expect(existsSync(fixture.destinationRoot)).toBe(false);
  });

  it("rejects stored-file symlinks that resolve outside legacyRoot", async () => {
    const fixture = createFixture();
    roots.push(fixture.root);
    const outside = path.join(fixture.root, "outside.pdf");
    writeFileSync(outside, "outside");
    rmSync(fixture.sourcePath);
    symlinkSync(outside, fixture.sourcePath);

    const result = await runLegacyMigration({
      ...fixture.config,
      dryRun: true,
    });
    expect(result.report.status).toBe("failed");
    expect(result.report.errors.join("\n")).toMatch(/outside.*legacy root/u);
    expect(existsSync(fixture.destinationRoot)).toBe(false);
    expect(existsSync(outside)).toBe(true);
  });
});
