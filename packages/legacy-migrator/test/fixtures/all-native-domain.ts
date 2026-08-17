import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export const ALL_NATIVE_GOLDEN_TABLES = [
  "obsidian_note_registry",
  "obsidian_sync_outbox",
  "research_alerts",
  "research_assumptions",
  "research_change_events",
  "research_item_evidence",
  "research_item_relations",
  "research_item_versions",
  "research_memo_sections",
  "research_memo_series",
  "research_memo_versions",
  "research_node_dependencies",
  "research_node_evidence",
  "research_node_versions",
  "research_nodes",
  "research_report_versions",
  "research_reports",
  "research_tracking_observations",
  "research_watch_rules",
  "research_workflow_context",
  "valuation_alerts",
  "valuation_analysis_versions",
  "valuation_model_overviews",
  "valuation_derived_models",
  "valuation_metric_actual_values",
  "valuation_metric_comparisons",
  "valuation_metric_manual_overrides",
  "valuation_metric_model_values",
  "valuation_model_changes",
  "valuation_model_node_values",
  "valuation_model_nodes",
  "valuation_watch_rules",
] as const;

export const DATASET_SCOPED_GOLDEN_TABLES = [
  "obsidian_note_registry",
  "obsidian_sync_outbox",
  "research_alerts",
  "research_change_events",
  "research_memo_series",
  "research_watch_rules",
  "valuation_alerts",
  "valuation_analysis_versions",
  "valuation_model_overviews",
  "valuation_derived_models",
  "valuation_metric_actual_values",
  "valuation_metric_comparisons",
  "valuation_metric_manual_overrides",
  "valuation_metric_model_values",
  "valuation_model_changes",
  "valuation_watch_rules",
] as const;

export const GOLDEN_MODEL_OVERVIEW_JSON = JSON.stringify({
  schema_version: 1,
  model_name: "Mapped Co DCF",
  company_name: "Mapped Co",
  company_ticker: "MAP",
  model_version_no: 1,
  model_type: "dcf",
  original_filename: "report.pdf",
  generated_at: "2026-07-31T00:00:00.000Z",
  summary: {
    detected_statements: ["income_statement"],
    missing_statements: ["balance_sheet", "cash_flow"],
    statement_count: 1,
    trend_count: 1,
    key_metric_count: 1,
    period_start: "2025FY",
    period_end: "2026FY",
    periods: ["2025FY", "2026FY"],
    fact_count: 2,
    review_required_count: 0,
    quality_flags: ["legacy_golden_fixture"],
  },
  key_metrics: [
    {
      metric_key: "revenue",
      label: "Revenue",
      period: "2026FY",
      value_numeric: 120,
      value_text: "120",
      unit: "CNYm",
      evidence_id: "chunk:chunk-v1",
      source: "DCF!B3",
    },
  ],
  trends: [
    {
      metric_key: "revenue",
      label: "Revenue",
      statement_type: "income_statement",
      unit: "CNYm",
      sheet_name: "DCF",
      values: [
        {
          period: "2025FY",
          value: 100,
          value_text: "100",
          evidence_id: "chunk:chunk-v1",
          source: "DCF!B2",
          quality_status: "verified",
          confidence: 0.95,
        },
        {
          period: "2026FY",
          value: 120,
          value_text: "120",
          evidence_id: "chunk:chunk-v1",
          source: "DCF!B3",
          quality_status: "verified",
          confidence: 0.95,
        },
      ],
    },
  ],
  statements: [
    {
      statement_type: "income_statement",
      title: "Income statement",
      sheet_name: "DCF",
      periods: ["2025FY", "2026FY"],
      rows: [
        {
          metric_key: "revenue",
          metric_name: "Revenue",
          unit: "CNYm",
          row_index: 3,
          values: [
            {
              period: "2025FY",
              value: 100,
              evidence_id: "chunk:chunk-v1",
              source: "DCF!B2",
            },
            {
              period: "2026FY",
              value: 120,
              evidence_id: "chunk:chunk-v1",
              source: "DCF!B3",
            },
          ],
        },
      ],
      source_refs: ["DCF!B2:B3"],
    },
  ],
});

export const GOLDEN_MODEL_OVERVIEW_HTML =
  "<!DOCTYPE html><html><body><h1>Mapped Co DCF</h1><table><tr><td>Revenue</td><td>120</td></tr></table></body></html>";

export const GOLDEN_INVALID_JSON_ROWS = [
  {
    tableName: "obsidian_sync_outbox",
    rowKey: "obsidian-event-v1",
    columnName: "result_json",
    rawValue: "not-json:obsidian-result",
    replacementJson: "{}",
  },
  {
    tableName: "research_item_versions",
    rowKey: "item-version-v1",
    columnName: "metadata_json",
    rawValue: "not-json:item-metadata",
    replacementJson: "{}",
  },
  {
    tableName: "research_node_versions",
    rowKey: "node-version-v1",
    columnName: "structured_output_json",
    rawValue: "not-json:node-output",
    replacementJson: "{}",
  },
  {
    tableName: "valuation_metric_actual_values",
    rowKey: "actual-metric-v1",
    columnName: "metadata_json",
    rawValue: "not-json:actual-metadata",
    replacementJson: "{}",
  },
] as const;

interface AllNativeDomainFixtureOptions {
  readonly collectionPath: string;
  readonly datasetId: string;
  readonly fixedTime: string;
}

function run(
  database: DatabaseSync,
  sql: string,
  ...values: SQLInputValue[]
): void {
  database.prepare(sql).run(...values);
}

/**
 * Installs the exact additive schemas used by the legacy Python services and
 * writes one referentially closed row graph across every direct workflow-store
 * table that was previously only covered by empty-schema migration tests.
 *
 * The caller supplies valuation_model_series/model_versions/market_snapshots
 * because those already have a dedicated parity fixture and are parents here.
 */
export function addAllNativeDomainFixture({
  collectionPath,
  datasetId,
  fixedTime,
}: AllNativeDomainFixtureOptions): void {
  const database = new DatabaseSync(collectionPath);
  database.exec(`
    CREATE TABLE research_memo_series (
      series_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      series_key TEXT NOT NULL,
      topic TEXT NOT NULL,
      title TEXT NOT NULL,
      current_version_no INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(dataset_id, series_key)
    );
    CREATE TABLE research_memo_versions (
      memo_version_id TEXT PRIMARY KEY,
      series_id TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      revision_of_version_id TEXT,
      as_of_date TEXT NOT NULL,
      source_type TEXT NOT NULL,
      status TEXT NOT NULL,
      markdown_path TEXT,
      html_path TEXT,
      pdf_path TEXT,
      source_response_id TEXT,
      document_versions_json TEXT NOT NULL DEFAULT '[]',
      input_json TEXT NOT NULL DEFAULT '{}',
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(series_id, version_no),
      UNIQUE(series_id, content_hash, source_type)
    );
    CREATE TABLE research_memo_sections (
      section_id TEXT PRIMARY KEY,
      memo_version_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      title TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      content TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      needs_review INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(memo_version_id, section_key)
    );
    CREATE TABLE research_item_versions (
      item_version_id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      as_of_date TEXT,
      source_published_at TEXT,
      observed_at TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      content TEXT NOT NULL,
      stance TEXT NOT NULL DEFAULT 'neutral',
      state TEXT NOT NULL DEFAULT 'active',
      value_numeric REAL,
      value_text TEXT,
      unit TEXT,
      period TEXT,
      scenario TEXT,
      probability TEXT,
      impact TEXT NOT NULL DEFAULT 'medium',
      confidence REAL NOT NULL DEFAULT 0.5,
      expected_start TEXT,
      expected_end TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(item_id, version_no)
    );
    CREATE TABLE research_item_evidence (
      item_version_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      relation_type TEXT NOT NULL DEFAULT 'supports',
      PRIMARY KEY(item_version_id, evidence_id, relation_type)
    );
    CREATE TABLE research_item_relations (
      from_item_id TEXT NOT NULL,
      to_item_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(from_item_id, to_item_id, relation_type)
    );
    CREATE TABLE research_tracking_observations (
      observation_id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      item_version_id TEXT,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      content TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      extracted_json TEXT NOT NULL DEFAULT '{}',
      observed_at TEXT NOT NULL,
      UNIQUE(item_id, source_type, source_id, content)
    );
    CREATE TABLE research_change_events (
      change_event_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      old_version_id TEXT,
      new_version_id TEXT NOT NULL,
      change_type TEXT NOT NULL,
      materiality TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(item_id, new_version_id, change_type)
    );
    CREATE TABLE research_watch_rules (
      rule_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      name TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_item_id TEXT,
      query_json TEXT NOT NULL DEFAULT '{}',
      min_priority TEXT NOT NULL DEFAULT 'medium',
      frequency TEXT NOT NULL DEFAULT 'on_ingest',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE research_alerts (
      alert_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      rule_id TEXT,
      item_id TEXT NOT NULL,
      change_event_id TEXT,
      alert_type TEXT NOT NULL,
      priority TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      why_it_matters TEXT NOT NULL DEFAULT '',
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'new',
      due_at TEXT,
      snoozed_until TEXT,
      dedupe_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE research_nodes (
      workflow_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      node_type TEXT NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL,
      current_version_no INTEGER NOT NULL DEFAULT 0,
      position_no INTEGER NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      tone TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(workflow_id, node_id)
    );
    CREATE TABLE research_node_dependencies (
      workflow_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      depends_on_node_id TEXT NOT NULL,
      dependency_type TEXT NOT NULL DEFAULT 'completion',
      PRIMARY KEY(workflow_id, node_id, depends_on_node_id)
    );
    CREATE TABLE research_node_versions (
      node_version_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      status TEXT NOT NULL,
      input_manifest_json TEXT NOT NULL,
      output_markdown TEXT,
      structured_output_json TEXT,
      prompt_snapshot TEXT,
      model_name TEXT,
      source_response_id TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(workflow_id, node_id, version_no)
    );
    CREATE TABLE research_node_evidence (
      node_version_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      relation_type TEXT NOT NULL DEFAULT 'supports',
      PRIMARY KEY(node_version_id, evidence_id)
    );
    CREATE TABLE research_assumptions (
      assumption_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      content TEXT NOT NULL,
      source_response_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE research_workflow_context (
      workflow_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      selected_at TEXT NOT NULL,
      PRIMARY KEY(workflow_id, node_id)
    );
    CREATE TABLE research_reports (
      report_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      report_type TEXT NOT NULL,
      title TEXT NOT NULL,
      current_version_no INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE research_report_versions (
      report_version_id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      node_versions_json TEXT NOT NULL,
      document_versions_json TEXT NOT NULL,
      markdown TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(report_id, version_no)
    );

    CREATE TABLE obsidian_sync_outbox (
      event_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      source_version TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      projector_version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 4,
      available_at TEXT NOT NULL,
      locked_at TEXT,
      finished_at TEXT,
      result_json TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(
        dataset_id, entity_type, entity_id, source_version,
        event_type, projector_version
      )
    );
    CREATE TABLE obsidian_note_registry (
      dataset_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      source_version TEXT NOT NULL,
      note_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      managed_hash TEXT NOT NULL,
      sync_status TEXT NOT NULL,
      last_synced_at TEXT,
      last_error TEXT,
      PRIMARY KEY(dataset_id, entity_type, entity_id, source_version),
      UNIQUE(note_path)
    );

    CREATE TABLE valuation_model_nodes (
      node_id TEXT PRIMARY KEY,
      series_id TEXT NOT NULL,
      canonical_key TEXT NOT NULL,
      node_kind TEXT NOT NULL,
      metric_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      scope TEXT NOT NULL,
      period TEXT,
      scenario TEXT,
      first_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(series_id, canonical_key)
    );
    CREATE TABLE valuation_model_node_values (
      node_value_id TEXT PRIMARY KEY,
      model_version_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      value_numeric REAL,
      value_text TEXT,
      unit TEXT,
      formula TEXT,
      formula_fingerprint TEXT,
      sheet_name TEXT NOT NULL,
      cell_ref TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      quality_status TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(model_version_id, node_id)
    );
    CREATE TABLE valuation_model_changes (
      change_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      series_id TEXT NOT NULL,
      from_model_version_id TEXT NOT NULL,
      to_model_version_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      change_type TEXT NOT NULL,
      materiality TEXT NOT NULL,
      summary TEXT NOT NULL,
      old_value_json TEXT NOT NULL DEFAULT '{}',
      new_value_json TEXT NOT NULL DEFAULT '{}',
      absolute_change REAL,
      relative_change REAL,
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      UNIQUE(from_model_version_id, to_model_version_id, node_id, change_type)
    );
    CREATE TABLE valuation_analysis_versions (
      analysis_version_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      series_id TEXT NOT NULL,
      model_version_id TEXT NOT NULL,
      previous_analysis_version_id TEXT,
      status TEXT NOT NULL,
      summary_markdown TEXT NOT NULL,
      analysis_json TEXT NOT NULL DEFAULT '{}',
      analyzer_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(model_version_id, analyzer_version)
    );
    CREATE TABLE valuation_model_overviews (
      overview_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      series_id TEXT NOT NULL,
      model_version_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      status TEXT NOT NULL,
      overview_json TEXT NOT NULL DEFAULT '{}',
      html TEXT NOT NULL,
      overview_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(model_version_id, overview_version)
    );
    CREATE TABLE valuation_metric_model_values (
      model_metric_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      series_id TEXT NOT NULL,
      model_version_id TEXT NOT NULL,
      metric_key TEXT NOT NULL,
      value_numeric REAL,
      unit TEXT NOT NULL,
      period TEXT,
      status TEXT NOT NULL,
      method TEXT NOT NULL,
      source TEXT,
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      quality_status TEXT NOT NULL DEFAULT 'review_required',
      created_at TEXT NOT NULL,
      UNIQUE(model_version_id, metric_key)
    );
    CREATE TABLE valuation_metric_manual_overrides (
      override_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      series_id TEXT NOT NULL,
      model_version_id TEXT NOT NULL,
      metric_key TEXT NOT NULL,
      value_numeric REAL NOT NULL,
      unit TEXT NOT NULL,
      period TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'manual_override:source_verified',
      source TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      derivation TEXT NOT NULL,
      quality_status TEXT NOT NULL DEFAULT 'manual_verified',
      reviewer TEXT NOT NULL,
      review_note TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(model_version_id, metric_key)
    );
    CREATE TABLE valuation_metric_actual_values (
      actual_metric_id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL,
      dataset_id TEXT NOT NULL,
      series_id TEXT NOT NULL,
      model_version_id TEXT NOT NULL,
      metric_key TEXT NOT NULL,
      value_numeric REAL,
      unit TEXT NOT NULL,
      period TEXT,
      status TEXT NOT NULL,
      source TEXT,
      observed_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(snapshot_id, metric_key)
    );
    CREATE TABLE valuation_metric_comparisons (
      comparison_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      series_id TEXT NOT NULL,
      model_version_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      metric_key TEXT NOT NULL,
      model_value REAL,
      actual_value REAL,
      absolute_gap REAL,
      relative_gap REAL,
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      explanation TEXT NOT NULL,
      model_period TEXT,
      actual_period TEXT,
      model_source TEXT,
      actual_source TEXT,
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      UNIQUE(model_version_id, snapshot_id, metric_key)
    );
    CREATE TABLE valuation_watch_rules (
      rule_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      series_id TEXT,
      name TEXT NOT NULL,
      min_materiality TEXT NOT NULL DEFAULT 'medium',
      change_types_json TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE valuation_alerts (
      alert_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      series_id TEXT NOT NULL,
      rule_id TEXT,
      change_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      priority TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'new',
      snoozed_until TEXT,
      dedupe_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
    CREATE TABLE valuation_derived_models (
      derived_model_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      series_id TEXT NOT NULL,
      analysis_id TEXT NOT NULL,
      base_model_version_id TEXT NOT NULL,
      derived_version_no INTEGER NOT NULL,
      output_filename TEXT NOT NULL,
      output_path TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_changes_json TEXT NOT NULL DEFAULT '[]',
      skipped_changes_json TEXT NOT NULL DEFAULT '[]',
      resource_file_name TEXT,
      resource_pipeline_job_id TEXT,
      resource_status TEXT NOT NULL DEFAULT 'not_added',
      resource_doc_id TEXT,
      resource_added_at TEXT,
      resource_error TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(analysis_id)
    );
  `);

  run(
    database,
    `UPDATE research_items
     SET current_version_no=1, current_version_id='item-version-v1',
         updated_at=?
     WHERE item_id='item-v1'`,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO research_items VALUES (
       'item-v2', ?, 'risk', 'execution-risk', 'Execution risk', 'active',
       0, NULL, ?, ?, ?, ?
     )`,
    datasetId,
    fixedTime,
    fixedTime,
    fixedTime,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO research_memo_series VALUES (
       'memo-series-v1', ?, 'growth-memo', 'growth', 'Growth memo', 1, ?, ?
     )`,
    datasetId,
    fixedTime,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO research_memo_versions VALUES (
       'memo-version-v1', 'memo-series-v1', 1, NULL, '2026-07-31',
       'agent', 'completed', 'memos/growth.md', 'memos/growth.html',
       'memos/growth.pdf', 'response-memo-v1',
       '["document:doc-v1"]', '{"evidence":"chunk:chunk-v1"}',
       'memo-content-hash-v1', ?
     )`,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO research_memo_sections VALUES (
       'memo-section-v1', 'memo-version-v1', 'thesis', 'Thesis', 0,
       'Growth remains durable.', '["chunk:chunk-v1"]', 0, ?
     )`,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO research_item_versions VALUES (
       'item-version-v1', 'item-v1', 1, '2026-07-31', '2026-07-30', ?,
       'document', 'doc-v1', 'Revenue grew 20 percent.', 'positive',
       'active', 20, 'twenty percent', '%', '2026Q2', 'base', 'high',
       'high', 0.9, '2026-07-01', '2026-09-30',
       'not-json:item-metadata', ?
     )`,
    fixedTime,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO research_item_evidence VALUES (
       'item-version-v1', 'chunk:chunk-v1', 'supports'
     )`,
  );
  run(
    database,
    `INSERT INTO research_item_relations VALUES (
       'item-v1', 'item-v2', 'mitigated_by', ?
     )`,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO research_tracking_observations VALUES (
       'observation-v1', 'item-v1', 'item-version-v1', 'document', 'doc-v1',
       'Revenue grew 20 percent.', '["chunk:chunk-v1"]',
       '{"growth":20,"evidence":"chunk:chunk-v1"}', ?
     )`,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO research_change_events VALUES (
       'change-event-v1', ?, 'item-v1', NULL, 'item-version-v1',
       'created', 'high', 'Initial growth thesis',
       '{"evidence":"chunk:chunk-v1"}', ?
     )`,
    datasetId,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO research_watch_rules VALUES (
       'research-rule-v1', ?, 'Growth monitor', 'item', 'item-v1',
       '{"item_id":"item-v1"}', 'high', 'on_ingest', 1, ?, ?
     )`,
    datasetId,
    fixedTime,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO research_alerts VALUES (
       'research-alert-v1', ?, 'research-rule-v1', 'item-v1',
       'change-event-v1', 'material_change', 'high', 'Growth changed',
       'Growth moved materially.', 'Review valuation assumptions.',
       '["chunk:chunk-v1"]', 'new', NULL, NULL,
       'research-alert-dedupe-v1', ?, ?
     )`,
    datasetId,
    fixedTime,
    fixedTime,
  );

  run(
    database,
    `INSERT INTO research_nodes VALUES (
       'workflow-v1', 'node-a', 'research', 'Revenue research',
       'Validate revenue growth.', 'Revenue source work.', 'completed',
       1, 0, 10, 20, 'analytical', 'research', ?, ?
     )`,
    fixedTime,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO research_nodes VALUES (
       'workflow-v1', 'node-b', 'synthesis', 'Synthesis',
       'Synthesize the report.', 'Final synthesis.', 'ready',
       0, 1, 30, 20, 'decisive', 'report', ?, ?
     )`,
    fixedTime,
    fixedTime,
  );
  run(
    database,
    `UPDATE research_workflows
     SET current_node_id='node-b', updated_at=?
     WHERE workflow_id='workflow-v1'`,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO research_node_dependencies VALUES (
       'workflow-v1', 'node-b', 'node-a', 'completion'
     )`,
  );
  run(
    database,
    `INSERT INTO research_node_versions VALUES (
       'node-version-v1', 'workflow-v1', 'node-a', 1, 'completed',
       '{"document_versions":["doc-v1"]}', 'Revenue grew 20 percent.',
       'not-json:node-output', 'Analyze source.', 'legacy-model',
       'response-node-v1', ?, ?
     )`,
    fixedTime,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO research_node_evidence VALUES (
       'node-version-v1', 'chunk:chunk-v1', 'supports'
     )`,
  );
  run(
    database,
    `INSERT INTO research_assumptions VALUES (
       'assumption-v1', 'workflow-v1', 'node-a',
       'Revenue recognition policy is unchanged.', 'response-node-v1',
       'active', ?, ?
     )`,
    fixedTime,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO research_workflow_context VALUES (
       'workflow-v1', 'node-a', ?
     )`,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO research_reports VALUES (
       'report-v1', 'workflow-v1', 'equity_research', 'Mapped Co report',
       1, ?, ?
     )`,
    fixedTime,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO research_report_versions VALUES (
       'report-version-v1', 'report-v1', 1,
       '{"node-a":"node-version-v1"}', '["doc-v1"]',
       '# Mapped Co\\n\\nRevenue grew 20 percent.', ?
     )`,
    fixedTime,
  );

  run(
    database,
    `INSERT INTO obsidian_sync_outbox VALUES (
       'obsidian-event-v1', ?, 'research_report', 'report-v1',
       'report-version-v1', 'upsert', '{"report_id":"report-v1"}',
       'legacy-projector-v1', 'completed', 1, 4, ?, NULL, ?,
       'not-json:obsidian-result', NULL, ?, ?
     )`,
    datasetId,
    fixedTime,
    fixedTime,
    fixedTime,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO obsidian_note_registry VALUES (
       ?, 'research_report', 'report-v1', 'report-version-v1',
       'Reports/Mapped Co.md', 'content-hash-v1', 'managed-hash-v1',
       'synced', ?, NULL
     )`,
    datasetId,
    fixedTime,
  );

  run(
    database,
    `INSERT INTO valuation_model_versions VALUES (
       'model-version-v0', 'series-v1', ?, 'doc-v1', 'logical-report', 1,
       NULL, NULL, 'model-checksum-v0', 'snapshot-hash-v0', 'report.pdf',
       '2026-03-31', 'dcf', 1, 1, 0, 'legacy-v0', ?
     )`,
    datasetId,
    fixedTime,
  );
  run(
    database,
    `UPDATE valuation_model_versions
     SET parent_model_version_id='model-version-v0',
         node_count=1, formula_node_count=1
     WHERE model_version_id='model-version-v1'`,
  );
  run(
    database,
    `INSERT INTO valuation_model_nodes VALUES (
       'valuation-node-v1', 'series-v1', 'income.revenue.2026',
       'metric', 'revenue', 'Revenue', 'company', '2026FY', 'base', ?, ?
     )`,
    fixedTime,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO valuation_model_node_values VALUES (
       'node-value-v1', 'model-version-v1', 'valuation-node-v1', 120, '120',
       'CNYm', '=B2*1.2', 'formula-fingerprint-v1', 'DCF', 'B3',
       'chunk:chunk-v1', 'verified', 0.95,
       '{"source":"chunk:chunk-v1"}', ?
     )`,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO valuation_model_changes VALUES (
       'valuation-change-v1', ?, 'series-v1', 'model-version-v0',
       'model-version-v1', 'valuation-node-v1', 'value_changed', 'high',
       'Revenue increased.', '{"value":100}', '{"value":120}', 20, 0.2,
       '["chunk:chunk-v1"]', ?
     )`,
    datasetId,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO valuation_analysis_versions VALUES (
       'analysis-version-v1', ?, 'series-v1', 'model-version-v1', NULL,
       'completed', 'Revenue increased by 20%.',
       '{"evidence":"chunk:chunk-v1"}', 'legacy-analysis-v1', ?
     )`,
    datasetId,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO valuation_model_overviews VALUES (
       'overview-v1', ?, 'series-v1', 'model-version-v1', 'doc-v1',
       'completed', ?, ?, 'legacy-overview-v1', ?
     )`,
    datasetId,
    GOLDEN_MODEL_OVERVIEW_JSON,
    GOLDEN_MODEL_OVERVIEW_HTML,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO valuation_metric_model_values VALUES (
       'model-metric-v1', ?, 'series-v1', 'model-version-v1', 'revenue',
       120, 'CNYm', '2026FY', 'available', 'model_cell', 'DCF!B3',
       '["chunk:chunk-v1"]', 'verified', ?
     )`,
    datasetId,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO valuation_metric_manual_overrides VALUES (
       'metric-override-v1', ?, 'series-v1', 'model-version-v1', 'revenue',
       121, 'CNYm', '2026FY', 'manual_override:source_verified',
       'Legacy report', '["chunk:chunk-v1"]', 'Audited filing',
       'manual_verified', 'analyst@example.test', 'Cross-checked', 1, ?, ?
     )`,
    datasetId,
    fixedTime,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO valuation_metric_actual_values VALUES (
       'actual-metric-v1', 'snapshot-v1', ?, 'series-v1',
       'model-version-v1', 'revenue', 118, 'CNYm', '2026FY', 'available',
       'Legacy report', ?, 'not-json:actual-metadata', ?
     )`,
    datasetId,
    fixedTime,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO valuation_metric_comparisons VALUES (
       'metric-comparison-v1', ?, 'series-v1', 'model-version-v1',
       'snapshot-v1', 'revenue', 120, 118, 2, 0.016949, 'low',
       'reviewed', 'Model is modestly above actual.', '2026FY', '2026FY',
       'model', 'filing', '["chunk:chunk-v1"]', ?
     )`,
    datasetId,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO valuation_watch_rules VALUES (
       'valuation-rule-v1', ?, 'series-v1', 'Material valuation changes',
       'medium', '["value_changed"]', 1, ?, ?
     )`,
    datasetId,
    fixedTime,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO valuation_alerts VALUES (
       'valuation-alert-v1', ?, 'series-v1', 'valuation-rule-v1',
       'valuation-change-v1', 'model_change', 'high',
       'Revenue assumption increased', 'Review the revised revenue forecast.',
       '["chunk:chunk-v1"]', 'new', NULL, 'valuation-alert-dedupe-v1', ?, ?
     )`,
    datasetId,
    fixedTime,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO valuation_agent_analyses VALUES (
       'agent-analysis-v1', ?, 'series-v1', 'model-version-v1',
       'model-version-v0', 'completed', 'revenue', 'dcf',
       'Revenue upside is modest.', 'Maintain position.',
       '{"changes":["valuation-change-v1"],"evidence":"chunk:chunk-v1"}',
       '{"steps":["compare"]}', '["chunk:chunk-v1"]', 'raw response',
       'legacy-model', 'legacy-agent-v1', NULL, ?, ?, ?
     )`,
    datasetId,
    fixedTime,
    fixedTime,
    fixedTime,
  );
  run(
    database,
    `INSERT INTO valuation_derived_models VALUES (
       'derived-model-v1', ?, 'series-v1', 'agent-analysis-v1',
       'model-version-v1', 1, 'mapped-co-derived.xlsx',
       'derived/mapped-co-derived.xlsx', 'derived-checksum-v1',
       '[{"change_id":"valuation-change-v1"}]', '[]',
       'mapped-co-derived.xlsx', 'legacy-resource-job-v1', 'completed',
       'legacy-resource-doc-v1', ?, NULL, ?
     )`,
    datasetId,
    fixedTime,
    fixedTime,
  );
  database.close();
}
