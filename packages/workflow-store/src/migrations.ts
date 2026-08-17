import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  encodeJson,
  nowIso,
  stableId,
  toRecord,
  withTransaction,
} from "./shared.js";
import {
  finishValuationAuditMigration,
  VALUATION_AUDIT_SCHEMA,
} from "./valuation-audit-migration.js";

const TRACKING_SCHEMA = `
  CREATE TABLE IF NOT EXISTS research_memo_series (
    series_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    series_key TEXT NOT NULL,
    topic TEXT NOT NULL,
    title TEXT NOT NULL,
    current_version_no INTEGER NOT NULL DEFAULT 0 CHECK (current_version_no >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(dataset_id, series_key)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS research_memo_versions (
    memo_version_id TEXT PRIMARY KEY,
    series_id TEXT NOT NULL,
    version_no INTEGER NOT NULL CHECK (version_no > 0),
    revision_of_version_id TEXT,
    as_of_date TEXT NOT NULL,
    source_type TEXT NOT NULL,
    status TEXT NOT NULL,
    markdown_path TEXT,
    html_path TEXT,
    pdf_path TEXT,
    source_response_id TEXT,
    document_versions_json TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(document_versions_json)),
    input_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(input_json)),
    content_hash TEXT NOT NULL,
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(series_id, version_no),
    UNIQUE(series_id, content_hash, source_type),
    FOREIGN KEY(series_id) REFERENCES research_memo_series(series_id) ON DELETE CASCADE,
    FOREIGN KEY(revision_of_version_id)
      REFERENCES research_memo_versions(memo_version_id) ON DELETE SET NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS research_memo_sections (
    section_id TEXT PRIMARY KEY,
    memo_version_id TEXT NOT NULL,
    section_key TEXT NOT NULL,
    title TEXT NOT NULL,
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    content TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_ids_json)),
    needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),
    created_at TEXT NOT NULL,
    UNIQUE(memo_version_id, section_key),
    FOREIGN KEY(memo_version_id)
      REFERENCES research_memo_versions(memo_version_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS research_items (
    item_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    item_type TEXT NOT NULL,
    canonical_key TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    current_version_no INTEGER NOT NULL DEFAULT 0 CHECK (current_version_no >= 0),
    current_version_id TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(dataset_id, item_type, canonical_key)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS research_item_versions (
    item_version_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    version_no INTEGER NOT NULL CHECK (version_no > 0),
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
    confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
    expected_start TEXT,
    expected_end TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(item_id, version_no),
    FOREIGN KEY(item_id) REFERENCES research_items(item_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS research_item_evidence (
    item_version_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    relation_type TEXT NOT NULL DEFAULT 'supports',
    PRIMARY KEY(item_version_id, evidence_id, relation_type),
    FOREIGN KEY(item_version_id)
      REFERENCES research_item_versions(item_version_id) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS research_item_relations (
    from_item_id TEXT NOT NULL,
    to_item_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(from_item_id, to_item_id, relation_type),
    FOREIGN KEY(from_item_id) REFERENCES research_items(item_id) ON DELETE CASCADE,
    FOREIGN KEY(to_item_id) REFERENCES research_items(item_id) ON DELETE CASCADE,
    CHECK(from_item_id <> to_item_id)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS research_tracking_observations (
    observation_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    item_version_id TEXT,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    content TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_ids_json)),
    extracted_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extracted_json)),
    observed_at TEXT NOT NULL,
    idempotency_key TEXT,
    UNIQUE(item_id, source_type, source_id, content),
    FOREIGN KEY(item_id) REFERENCES research_items(item_id) ON DELETE CASCADE,
    FOREIGN KEY(item_version_id)
      REFERENCES research_item_versions(item_version_id) ON DELETE SET NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS research_change_events (
    change_event_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    old_version_id TEXT,
    new_version_id TEXT NOT NULL,
    change_type TEXT NOT NULL,
    materiality TEXT NOT NULL,
    summary TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(item_id, new_version_id, change_type),
    FOREIGN KEY(item_id) REFERENCES research_items(item_id) ON DELETE CASCADE,
    FOREIGN KEY(old_version_id)
      REFERENCES research_item_versions(item_version_id) ON DELETE SET NULL,
    FOREIGN KEY(new_version_id)
      REFERENCES research_item_versions(item_version_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS research_watch_rules (
    rule_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    name TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_item_id TEXT,
    query_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(query_json)),
    min_priority TEXT NOT NULL DEFAULT 'medium'
      CHECK (min_priority IN ('low', 'medium', 'high', 'critical')),
    frequency TEXT NOT NULL DEFAULT 'on_ingest',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(target_item_id) REFERENCES research_items(item_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS research_alerts (
    alert_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    rule_id TEXT,
    item_id TEXT NOT NULL,
    change_event_id TEXT,
    alert_type TEXT NOT NULL,
    priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    why_it_matters TEXT NOT NULL DEFAULT '',
    evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_ids_json)),
    status TEXT NOT NULL DEFAULT 'new'
      CHECK (status IN ('new', 'acknowledged', 'dismissed', 'snoozed')),
    due_at TEXT,
    snoozed_until TEXT,
    dedupe_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(rule_id) REFERENCES research_watch_rules(rule_id) ON DELETE SET NULL,
    FOREIGN KEY(item_id) REFERENCES research_items(item_id) ON DELETE CASCADE,
    FOREIGN KEY(change_event_id)
      REFERENCES research_change_events(change_event_id) ON DELETE SET NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS ix_research_memo_versions_series
    ON research_memo_versions(series_id, version_no DESC);
  CREATE INDEX IF NOT EXISTS ix_research_items_type_updated
    ON research_items(dataset_id, item_type, updated_at DESC);
  CREATE INDEX IF NOT EXISTS ix_research_item_versions_item
    ON research_item_versions(item_id, version_no DESC);
  CREATE INDEX IF NOT EXISTS ix_research_change_events_dataset
    ON research_change_events(dataset_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS ix_research_alerts_dataset_status
    ON research_alerts(dataset_id, status, created_at DESC);
`;

const VALUATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS valuation_model_series (
    series_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    series_key TEXT NOT NULL,
    name TEXT NOT NULL,
    company_name TEXT,
    company_ticker TEXT,
    model_type TEXT,
    current_model_version_id TEXT,
    current_version_no INTEGER NOT NULL DEFAULT 0 CHECK (current_version_no >= 0),
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(dataset_id, series_key)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS valuation_model_versions (
    model_version_id TEXT PRIMARY KEY,
    series_id TEXT NOT NULL,
    dataset_id TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    logical_doc_id TEXT,
    document_version_no INTEGER NOT NULL CHECK (document_version_no > 0),
    parent_model_version_id TEXT,
    reverted_to_version_id TEXT,
    checksum TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    document_date TEXT,
    model_type TEXT,
    node_count INTEGER NOT NULL DEFAULT 0 CHECK (node_count >= 0),
    formula_node_count INTEGER NOT NULL DEFAULT 0 CHECK (formula_node_count >= 0),
    review_required_count INTEGER NOT NULL DEFAULT 0 CHECK (review_required_count >= 0),
    analyzer_version TEXT NOT NULL,
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(doc_id, analyzer_version),
    FOREIGN KEY(series_id) REFERENCES valuation_model_series(series_id) ON DELETE CASCADE,
    FOREIGN KEY(parent_model_version_id)
      REFERENCES valuation_model_versions(model_version_id) ON DELETE SET NULL,
    FOREIGN KEY(reverted_to_version_id)
      REFERENCES valuation_model_versions(model_version_id) ON DELETE SET NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS valuation_model_nodes (
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
    UNIQUE(series_id, canonical_key),
    FOREIGN KEY(series_id) REFERENCES valuation_model_series(series_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS valuation_model_node_values (
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
    confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL,
    UNIQUE(model_version_id, node_id),
    FOREIGN KEY(model_version_id)
      REFERENCES valuation_model_versions(model_version_id) ON DELETE CASCADE,
    FOREIGN KEY(node_id) REFERENCES valuation_model_nodes(node_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS valuation_model_changes (
    change_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    series_id TEXT NOT NULL,
    from_model_version_id TEXT NOT NULL,
    to_model_version_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    change_type TEXT NOT NULL,
    materiality TEXT NOT NULL CHECK (materiality IN ('low', 'medium', 'high', 'critical')),
    summary TEXT NOT NULL,
    old_value_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(old_value_json)),
    new_value_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(new_value_json)),
    absolute_change REAL,
    relative_change REAL,
    evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_ids_json)),
    created_at TEXT NOT NULL,
    UNIQUE(from_model_version_id, to_model_version_id, node_id, change_type),
    FOREIGN KEY(series_id) REFERENCES valuation_model_series(series_id) ON DELETE CASCADE,
    FOREIGN KEY(from_model_version_id)
      REFERENCES valuation_model_versions(model_version_id) ON DELETE CASCADE,
    FOREIGN KEY(to_model_version_id)
      REFERENCES valuation_model_versions(model_version_id) ON DELETE CASCADE,
    FOREIGN KEY(node_id) REFERENCES valuation_model_nodes(node_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS valuation_analysis_versions (
    analysis_version_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    series_id TEXT NOT NULL,
    model_version_id TEXT NOT NULL,
    previous_analysis_version_id TEXT,
    status TEXT NOT NULL,
    summary_markdown TEXT NOT NULL,
    analysis_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(analysis_json)),
    analyzer_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(model_version_id, analyzer_version),
    FOREIGN KEY(series_id) REFERENCES valuation_model_series(series_id) ON DELETE CASCADE,
    FOREIGN KEY(model_version_id)
      REFERENCES valuation_model_versions(model_version_id) ON DELETE CASCADE,
    FOREIGN KEY(previous_analysis_version_id)
      REFERENCES valuation_analysis_versions(analysis_version_id) ON DELETE SET NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS valuation_metric_model_values (
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
    evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_ids_json)),
    quality_status TEXT NOT NULL DEFAULT 'review_required',
    created_at TEXT NOT NULL,
    UNIQUE(model_version_id, metric_key),
    FOREIGN KEY(series_id) REFERENCES valuation_model_series(series_id) ON DELETE CASCADE,
    FOREIGN KEY(model_version_id)
      REFERENCES valuation_model_versions(model_version_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS valuation_metric_manual_overrides (
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
    evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_ids_json)),
    derivation TEXT NOT NULL,
    quality_status TEXT NOT NULL DEFAULT 'manual_verified',
    reviewer TEXT NOT NULL,
    review_note TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(model_version_id, metric_key),
    FOREIGN KEY(series_id) REFERENCES valuation_model_series(series_id) ON DELETE CASCADE,
    FOREIGN KEY(model_version_id)
      REFERENCES valuation_model_versions(model_version_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS valuation_market_snapshots (
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
    raw_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(raw_json)),
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(series_id) REFERENCES valuation_model_series(series_id) ON DELETE CASCADE,
    FOREIGN KEY(model_version_id)
      REFERENCES valuation_model_versions(model_version_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS valuation_metric_actual_values (
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
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL,
    UNIQUE(snapshot_id, metric_key),
    FOREIGN KEY(snapshot_id) REFERENCES valuation_market_snapshots(snapshot_id)
      ON DELETE CASCADE,
    FOREIGN KEY(model_version_id)
      REFERENCES valuation_model_versions(model_version_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS valuation_metric_comparisons (
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
    evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_ids_json)),
    created_at TEXT NOT NULL,
    UNIQUE(model_version_id, snapshot_id, metric_key),
    FOREIGN KEY(model_version_id)
      REFERENCES valuation_model_versions(model_version_id) ON DELETE CASCADE,
    FOREIGN KEY(snapshot_id)
      REFERENCES valuation_market_snapshots(snapshot_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS valuation_watch_rules (
    rule_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    series_id TEXT,
    name TEXT NOT NULL,
    min_materiality TEXT NOT NULL DEFAULT 'medium'
      CHECK (min_materiality IN ('low', 'medium', 'high', 'critical')),
    change_types_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(change_types_json)),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(series_id) REFERENCES valuation_model_series(series_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS valuation_alerts (
    alert_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    series_id TEXT NOT NULL,
    rule_id TEXT,
    change_id TEXT NOT NULL,
    alert_type TEXT NOT NULL,
    priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_ids_json)),
    status TEXT NOT NULL DEFAULT 'new'
      CHECK (status IN ('new', 'acknowledged', 'dismissed', 'snoozed')),
    snoozed_until TEXT,
    dedupe_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(series_id) REFERENCES valuation_model_series(series_id) ON DELETE CASCADE,
    FOREIGN KEY(rule_id) REFERENCES valuation_watch_rules(rule_id) ON DELETE SET NULL,
    FOREIGN KEY(change_id) REFERENCES valuation_model_changes(change_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS valuation_agent_analyses (
    analysis_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    series_id TEXT NOT NULL,
    base_model_version_id TEXT NOT NULL,
    comparison_model_version_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    focus TEXT NOT NULL DEFAULT '',
    valuation_method TEXT,
    executive_summary TEXT,
    investment_conclusion TEXT,
    analysis_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(analysis_json)),
    planner_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(planner_json)),
    evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_ids_json)),
    raw_response TEXT,
    model_name TEXT,
    agent_version TEXT NOT NULL,
    error_message TEXT,
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(base_model_version_id, comparison_model_version_id, focus, agent_version),
    FOREIGN KEY(series_id) REFERENCES valuation_model_series(series_id) ON DELETE CASCADE,
    FOREIGN KEY(base_model_version_id)
      REFERENCES valuation_model_versions(model_version_id) ON DELETE CASCADE,
    FOREIGN KEY(comparison_model_version_id)
      REFERENCES valuation_model_versions(model_version_id) ON DELETE SET NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS valuation_derived_models (
    derived_model_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    series_id TEXT NOT NULL,
    analysis_id TEXT NOT NULL,
    base_model_version_id TEXT NOT NULL,
    derived_version_no INTEGER NOT NULL CHECK (derived_version_no > 0),
    output_filename TEXT NOT NULL,
    output_path TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_changes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(applied_changes_json)),
    skipped_changes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(skipped_changes_json)),
    resource_file_name TEXT,
    resource_pipeline_job_id TEXT,
    resource_status TEXT NOT NULL DEFAULT 'not_added'
      CHECK (resource_status IN ('not_added', 'queued', 'running', 'completed', 'failed')),
    resource_doc_id TEXT,
    resource_added_at TEXT,
    resource_error TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(analysis_id),
    FOREIGN KEY(series_id) REFERENCES valuation_model_series(series_id) ON DELETE CASCADE,
    FOREIGN KEY(analysis_id) REFERENCES valuation_agent_analyses(analysis_id) ON DELETE CASCADE,
    FOREIGN KEY(base_model_version_id)
      REFERENCES valuation_model_versions(model_version_id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX IF NOT EXISTS ix_valuation_versions_series
    ON valuation_model_versions(series_id, document_version_no DESC);
  CREATE INDEX IF NOT EXISTS ix_valuation_values_version
    ON valuation_model_node_values(model_version_id, node_id);
  CREATE INDEX IF NOT EXISTS ix_valuation_changes_series
    ON valuation_model_changes(series_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS ix_valuation_metric_comparison_latest
    ON valuation_metric_comparisons(series_id, model_version_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS ix_valuation_metric_manual_override_version
    ON valuation_metric_manual_overrides(model_version_id, is_active, updated_at DESC);
  CREATE INDEX IF NOT EXISTS ix_valuation_market_snapshot_latest
    ON valuation_market_snapshots(series_id, model_version_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS ix_valuation_alerts_dataset_status
    ON valuation_alerts(dataset_id, status, created_at DESC);
  CREATE INDEX IF NOT EXISTS ix_valuation_agent_series
    ON valuation_agent_analyses(series_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS ix_valuation_derived_series
    ON valuation_derived_models(series_id, created_at DESC);
`;

const WORKFLOW_SCHEMA = `
  CREATE TABLE IF NOT EXISTS research_workflows (
    workflow_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    workflow_type TEXT NOT NULL,
    status TEXT NOT NULL,
    current_node_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(dataset_id, workflow_type)
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_research_workflows_dataset_type
    ON research_workflows(dataset_id, workflow_type);

  CREATE TABLE IF NOT EXISTS research_nodes (
    workflow_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    node_type TEXT NOT NULL,
    title TEXT NOT NULL,
    objective TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL
      CHECK (status IN ('pending', 'ready', 'running', 'completed', 'stale', 'failed')),
    current_version_no INTEGER NOT NULL DEFAULT 0 CHECK (current_version_no >= 0),
    position_no INTEGER NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    tone TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(workflow_id, node_id),
    FOREIGN KEY(workflow_id) REFERENCES research_workflows(workflow_id) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS research_node_dependencies (
    workflow_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    depends_on_node_id TEXT NOT NULL,
    dependency_type TEXT NOT NULL DEFAULT 'completion',
    PRIMARY KEY(workflow_id, node_id, depends_on_node_id),
    FOREIGN KEY(workflow_id, node_id)
      REFERENCES research_nodes(workflow_id, node_id) ON DELETE CASCADE,
    FOREIGN KEY(workflow_id, depends_on_node_id)
      REFERENCES research_nodes(workflow_id, node_id) ON DELETE CASCADE,
    CHECK(node_id <> depends_on_node_id)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS research_node_versions (
    node_version_id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    version_no INTEGER NOT NULL CHECK (version_no > 0),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    input_manifest_json TEXT NOT NULL CHECK (json_valid(input_manifest_json)),
    output_markdown TEXT,
    structured_output_json TEXT CHECK (
      structured_output_json IS NULL OR json_valid(structured_output_json)
    ),
    prompt_snapshot TEXT,
    model_name TEXT,
    source_response_id TEXT,
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(workflow_id, node_id, version_no),
    FOREIGN KEY(workflow_id, node_id)
      REFERENCES research_nodes(workflow_id, node_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS research_node_evidence (
    node_version_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    relation_type TEXT NOT NULL DEFAULT 'supports',
    PRIMARY KEY(node_version_id, evidence_id),
    FOREIGN KEY(node_version_id)
      REFERENCES research_node_versions(node_version_id) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS research_assumptions (
    assumption_id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    content TEXT NOT NULL,
    source_response_id TEXT,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'resolved', 'dismissed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(workflow_id, node_id)
      REFERENCES research_nodes(workflow_id, node_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS research_workflow_context (
    workflow_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    selected_at TEXT NOT NULL,
    PRIMARY KEY(workflow_id, node_id),
    FOREIGN KEY(workflow_id, node_id)
      REFERENCES research_nodes(workflow_id, node_id) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS research_reports (
    report_id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    report_type TEXT NOT NULL,
    title TEXT NOT NULL,
    current_version_no INTEGER NOT NULL DEFAULT 0 CHECK (current_version_no >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(workflow_id, report_type),
    FOREIGN KEY(workflow_id) REFERENCES research_workflows(workflow_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS research_report_versions (
    report_version_id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL,
    version_no INTEGER NOT NULL CHECK (version_no > 0),
    node_versions_json TEXT NOT NULL CHECK (json_valid(node_versions_json)),
    document_versions_json TEXT NOT NULL CHECK (json_valid(document_versions_json)),
    markdown TEXT NOT NULL,
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(report_id, version_no),
    FOREIGN KEY(report_id) REFERENCES research_reports(report_id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX IF NOT EXISTS ix_research_nodes_status
    ON research_nodes(workflow_id, status, position_no);
  CREATE INDEX IF NOT EXISTS ix_research_node_versions_node
    ON research_node_versions(workflow_id, node_id, version_no DESC);
  CREATE INDEX IF NOT EXISTS ix_research_reports_workflow
    ON research_reports(workflow_id, updated_at DESC);
`;

const OBSIDIAN_SCHEMA = `
  CREATE TABLE IF NOT EXISTS obsidian_sync_outbox (
    event_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    source_version TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
    projector_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 4 CHECK (max_attempts > 0),
    available_at TEXT NOT NULL,
    locked_at TEXT,
    lease_token TEXT,
    finished_at TEXT,
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(
      dataset_id, entity_type, entity_id, source_version, event_type, projector_version
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS obsidian_note_registry (
    dataset_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    source_version TEXT NOT NULL,
    note_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    managed_hash TEXT NOT NULL,
    sync_status TEXT NOT NULL
      CHECK (sync_status IN (
        'pending', 'synced', 'written', 'unchanged',
        'conflict', 'failed', 'error', 'missing'
      )),
    last_synced_at TEXT,
    last_error TEXT,
    PRIMARY KEY(dataset_id, entity_type, entity_id, source_version),
    UNIQUE(note_path)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS ix_obsidian_outbox_claim
    ON obsidian_sync_outbox(status, available_at, created_at);
  CREATE INDEX IF NOT EXISTS ix_obsidian_registry_dataset
    ON obsidian_note_registry(dataset_id, entity_type, entity_id);
`;

const HARDENING_SCHEMA = `
  CREATE TABLE IF NOT EXISTS workflow_store_evidence_references (
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    relation_type TEXT NOT NULL DEFAULT 'supports',
    created_at TEXT NOT NULL,
    PRIMARY KEY(owner_type, owner_id, evidence_id, relation_type)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS ix_workflow_store_evidence_id
    ON workflow_store_evidence_references(evidence_id, owner_type, owner_id);

  CREATE TABLE IF NOT EXISTS workflow_store_legacy_json_quarantine (
    quarantine_id TEXT PRIMARY KEY,
    table_name TEXT NOT NULL,
    row_key TEXT NOT NULL,
    column_name TEXT NOT NULL,
    raw_value TEXT NOT NULL,
    replacement_json TEXT NOT NULL CHECK (json_valid(replacement_json)),
    quarantined_at TEXT NOT NULL,
    UNIQUE(table_name, row_key, column_name)
  ) STRICT;
`;

const VALUATION_MODEL_OVERVIEW_SCHEMA = `
  CREATE TABLE IF NOT EXISTS valuation_model_overviews (
    overview_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    series_id TEXT NOT NULL,
    model_version_id TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    status TEXT NOT NULL,
    overview_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(overview_json)),
    html TEXT NOT NULL,
    overview_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(model_version_id, overview_version),
    FOREIGN KEY(series_id)
      REFERENCES valuation_model_series(series_id) ON DELETE CASCADE,
    FOREIGN KEY(model_version_id)
      REFERENCES valuation_model_versions(model_version_id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX IF NOT EXISTS ix_valuation_overviews_version
    ON valuation_model_overviews(model_version_id, overview_version);
`;

const KNOWN_DOMAIN_TABLES = [
  "research_memo_series",
  "research_memo_versions",
  "research_memo_sections",
  "research_items",
  "research_item_versions",
  "research_item_evidence",
  "research_item_relations",
  "research_tracking_observations",
  "research_change_events",
  "research_watch_rules",
  "research_alerts",
  "valuation_model_series",
  "valuation_model_versions",
  "valuation_model_nodes",
  "valuation_model_node_values",
  "valuation_model_changes",
  "valuation_analysis_versions",
  "valuation_model_overviews",
  "valuation_metric_model_values",
  "valuation_metric_manual_overrides",
  "valuation_market_snapshots",
  "valuation_metric_actual_values",
  "valuation_metric_comparisons",
  "valuation_context_cards",
  "valuation_impact_cards",
  "valuation_market_price_bars",
  "valuation_price_comparisons",
  "valuation_watch_rules",
  "valuation_alerts",
  "valuation_agent_analyses",
  "valuation_derived_models",
  "research_workflows",
  "research_nodes",
  "research_node_dependencies",
  "research_node_versions",
  "research_node_evidence",
  "research_assumptions",
  "research_workflow_context",
  "research_reports",
  "research_report_versions",
  "obsidian_sync_outbox",
  "obsidian_note_registry",
] as const;

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly finish?: (database: DatabaseSync, appliedAt: string) => void;
}

export interface WorkflowStoreMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

export interface WorkflowStoreMigrationResult {
  readonly version: number;
  readonly applied: readonly WorkflowStoreMigration[];
  readonly adoptedLegacyTables: readonly string[];
  readonly quarantinedJsonValues: number;
  readonly quarantinedLegacyRows: number;
  readonly importedEvidenceReferences: number;
}

export interface RunWorkflowStoreMigrationsOptions {
  readonly now?: Date;
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return (
    database
      .prepare(
        `SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?`,
      )
      .get(table) !== undefined
  );
}

function columns(database: DatabaseSync, table: string): Set<string> {
  if (!tableExists(database, table)) {
    return new Set();
  }
  return new Set(
    database
      .prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
      .all()
      .map((row) => String(toRecord(row).name)),
  );
}

function ensureColumn(
  database: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  if (tableExists(database, table) && !columns(database, table).has(column)) {
    database.exec(
      `ALTER TABLE "${table.replaceAll('"', '""')}"
       ADD COLUMN "${column.replaceAll('"', '""')}" ${definition}`,
    );
  }
}

const JSON_COLUMNS = [
  ["research_memo_versions", "memo_version_id", "document_versions_json", []],
  ["research_memo_versions", "memo_version_id", "input_json", {}],
  ["research_memo_sections", "section_id", "evidence_ids_json", []],
  ["research_item_versions", "item_version_id", "metadata_json", {}],
  ["research_tracking_observations", "observation_id", "evidence_ids_json", []],
  ["research_tracking_observations", "observation_id", "extracted_json", {}],
  ["research_change_events", "change_event_id", "details_json", {}],
  ["research_watch_rules", "rule_id", "query_json", {}],
  ["research_alerts", "alert_id", "evidence_ids_json", []],
  ["valuation_model_node_values", "node_value_id", "metadata_json", {}],
  ["valuation_model_changes", "change_id", "old_value_json", {}],
  ["valuation_model_changes", "change_id", "new_value_json", {}],
  ["valuation_model_changes", "change_id", "evidence_ids_json", []],
  ["valuation_analysis_versions", "analysis_version_id", "analysis_json", {}],
  ["valuation_model_overviews", "overview_id", "overview_json", {}],
  ["valuation_metric_model_values", "model_metric_id", "evidence_ids_json", []],
  ["valuation_metric_manual_overrides", "override_id", "evidence_ids_json", []],
  ["valuation_market_snapshots", "snapshot_id", "raw_json", {}],
  ["valuation_metric_actual_values", "actual_metric_id", "metadata_json", {}],
  ["valuation_metric_comparisons", "comparison_id", "evidence_ids_json", []],
  ["valuation_watch_rules", "rule_id", "change_types_json", []],
  ["valuation_alerts", "alert_id", "evidence_ids_json", []],
  ["valuation_agent_analyses", "analysis_id", "analysis_json", {}],
  ["valuation_agent_analyses", "analysis_id", "planner_json", {}],
  ["valuation_agent_analyses", "analysis_id", "evidence_ids_json", []],
  ["valuation_derived_models", "derived_model_id", "applied_changes_json", []],
  ["valuation_derived_models", "derived_model_id", "skipped_changes_json", []],
  ["research_node_versions", "node_version_id", "input_manifest_json", {}],
  ["research_node_versions", "node_version_id", "structured_output_json", {}],
  ["research_report_versions", "report_version_id", "node_versions_json", {}],
  ["research_report_versions", "report_version_id", "document_versions_json", []],
  ["obsidian_sync_outbox", "event_id", "payload_json", {}],
  ["obsidian_sync_outbox", "event_id", "result_json", {}],
] as const;

const NULLABLE_JSON_COLUMNS = new Set([
  "research_node_versions.structured_output_json",
  "obsidian_sync_outbox.result_json",
]);

function normalizeLegacyJson(
  database: DatabaseSync,
  quarantinedAt: string,
): number {
  let quarantined = 0;
  for (const [table, primaryKey, column, fallback] of JSON_COLUMNS) {
    const available = columns(database, table);
    if (!available.has(primaryKey) || !available.has(column)) {
      continue;
    }
    const rows = database
      .prepare(
        `SELECT "${primaryKey}" AS row_key, "${column}" AS raw_value
         FROM "${table}"`,
      )
      .all();
    for (const rawRow of rows) {
      const row = toRecord(rawRow);
      const raw = row.raw_value;
      let valid = false;
      if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw);
          valid =
            Array.isArray(fallback)
              ? Array.isArray(parsed)
              : parsed !== null &&
                typeof parsed === "object" &&
                !Array.isArray(parsed);
        } catch {
          valid = false;
        }
      }
      if (
        valid ||
        (raw === null && NULLABLE_JSON_COLUMNS.has(`${table}.${column}`))
      ) {
        continue;
      }
      const rowKey = String(row.row_key);
      const replacement = encodeJson(fallback);
      database
        .prepare(
          `INSERT OR IGNORE INTO workflow_store_legacy_json_quarantine
             (quarantine_id, table_name, row_key, column_name, raw_value,
              replacement_json, quarantined_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          stableId("qjson", table, rowKey, column),
          table,
          rowKey,
          column,
          String(raw ?? ""),
          replacement,
          quarantinedAt,
        );
      database
        .prepare(
          `UPDATE "${table}" SET "${column}"=? WHERE "${primaryKey}"=?`,
        )
        .run(replacement, rowKey);
      quarantined += 1;
    }
  }
  return quarantined;
}

const DIRECT_EVIDENCE_IMPORTS = [
  [
    "research_item_evidence",
    "research-item-version",
    "item_version_id",
    "evidence_id",
    "supports",
  ],
  [
    "research_node_evidence",
    "workflow-node-version",
    "node_version_id",
    "evidence_id",
    "supports",
  ],
  [
    "valuation_model_node_values",
    "valuation-node-value",
    "node_value_id",
    "evidence_id",
    "source",
  ],
] as const;

const JSON_EVIDENCE_IMPORTS = [
  ["research_memo_sections", "memo-section", "section_id", "evidence_ids_json"],
  [
    "research_tracking_observations",
    "tracking-observation",
    "observation_id",
    "evidence_ids_json",
  ],
  ["research_alerts", "tracking-alert", "alert_id", "evidence_ids_json"],
  ["valuation_model_changes", "valuation-change", "change_id", "evidence_ids_json"],
  [
    "valuation_metric_model_values",
    "valuation-model-metric",
    "model_metric_id",
    "evidence_ids_json",
  ],
  [
    "valuation_metric_manual_overrides",
    "valuation-metric-override",
    "override_id",
    "evidence_ids_json",
  ],
  [
    "valuation_metric_comparisons",
    "valuation-metric-comparison",
    "comparison_id",
    "evidence_ids_json",
  ],
  ["valuation_alerts", "valuation-alert", "alert_id", "evidence_ids_json"],
  ["valuation_agent_analyses", "valuation-agent-analysis", "analysis_id", "evidence_ids_json"],
] as const;

const NESTED_JSON_EVIDENCE_IMPORTS = [
  [
    "research_memo_versions",
    "memo-version",
    "memo_version_id",
    "document_versions_json",
  ],
  ["research_memo_versions", "memo-version", "memo_version_id", "input_json"],
  [
    "research_tracking_observations",
    "tracking-observation",
    "observation_id",
    "extracted_json",
  ],
  ["research_change_events", "tracking-change", "change_event_id", "details_json"],
  [
    "valuation_analysis_versions",
    "valuation-analysis-version",
    "analysis_version_id",
    "analysis_json",
  ],
  [
    "valuation_metric_actual_values",
    "valuation-actual-metric",
    "actual_metric_id",
    "metadata_json",
  ],
  [
    "valuation_agent_analyses",
    "valuation-agent-analysis",
    "analysis_id",
    "analysis_json",
  ],
  [
    "valuation_agent_analyses",
    "valuation-agent-analysis",
    "analysis_id",
    "planner_json",
  ],
  [
    "valuation_derived_models",
    "valuation-derived",
    "derived_model_id",
    "applied_changes_json",
  ],
  [
    "valuation_derived_models",
    "valuation-derived",
    "derived_model_id",
    "skipped_changes_json",
  ],
  [
    "research_node_versions",
    "workflow-node-version",
    "node_version_id",
    "input_manifest_json",
  ],
  [
    "research_node_versions",
    "workflow-node-version",
    "node_version_id",
    "structured_output_json",
  ],
  [
    "research_report_versions",
    "workflow-report-version",
    "report_version_id",
    "node_versions_json",
  ],
  [
    "research_report_versions",
    "workflow-report-version",
    "report_version_id",
    "document_versions_json",
  ],
  ["obsidian_sync_outbox", "obsidian-event", "event_id", "payload_json"],
  ["obsidian_sync_outbox", "obsidian-event", "event_id", "result_json"],
] as const;

function importEvidenceReferences(
  database: DatabaseSync,
  importedAt: string,
): number {
  const before = Number(
    toRecord(
      database
        .prepare("SELECT COUNT(*) AS count FROM workflow_store_evidence_references")
        .get(),
    ).count,
  );
  for (const [
    table,
    ownerType,
    ownerColumn,
    evidenceColumn,
    relationType,
  ] of DIRECT_EVIDENCE_IMPORTS) {
    const available = columns(database, table);
    if (!available.has(ownerColumn) || !available.has(evidenceColumn)) {
      continue;
    }
    database
      .prepare(
        `INSERT OR IGNORE INTO workflow_store_evidence_references
           (owner_type, owner_id, evidence_id, relation_type, created_at)
         SELECT ?, CAST("${ownerColumn}" AS TEXT), CAST("${evidenceColumn}" AS TEXT),
                ?, ?
         FROM "${table}"
         WHERE "${evidenceColumn}" IS NOT NULL
           AND length(trim(CAST("${evidenceColumn}" AS TEXT))) > 0`,
      )
      .run(ownerType, relationType, importedAt);
  }
  for (const [table, ownerType, ownerColumn, jsonColumn] of JSON_EVIDENCE_IMPORTS) {
    const available = columns(database, table);
    if (!available.has(ownerColumn) || !available.has(jsonColumn)) {
      continue;
    }
    database
      .prepare(
        `INSERT OR IGNORE INTO workflow_store_evidence_references
           (owner_type, owner_id, evidence_id, relation_type, created_at)
         SELECT ?, CAST(source."${ownerColumn}" AS TEXT), CAST(item.value AS TEXT),
                'supports', ?
         FROM "${table}" AS source, json_each(source."${jsonColumn}") AS item
         WHERE json_valid(source."${jsonColumn}")
           AND item.type='text'
           AND length(trim(CAST(item.value AS TEXT))) > 0`,
      )
      .run(ownerType, importedAt);
  }
  for (const [
    table,
    ownerType,
    ownerColumn,
    jsonColumn,
  ] of NESTED_JSON_EVIDENCE_IMPORTS) {
    const available = columns(database, table);
    if (!available.has(ownerColumn) || !available.has(jsonColumn)) {
      continue;
    }
    database
      .prepare(
        `INSERT OR IGNORE INTO workflow_store_evidence_references
           (owner_type, owner_id, evidence_id, relation_type, created_at)
         SELECT ?, CAST(source."${ownerColumn}" AS TEXT),
                CAST(tree.value AS TEXT), 'supports', ?
         FROM "${table}" AS source, json_tree(source."${jsonColumn}") AS tree
         WHERE json_valid(source."${jsonColumn}")
           AND tree.type='text'
           AND (
             CAST(tree.value AS TEXT) GLOB 'chunk:*'
             OR CAST(tree.value AS TEXT) GLOB 'fact:*'
             OR CAST(tree.value AS TEXT) GLOB 'cell:*'
             OR CAST(tree.value AS TEXT) GLOB 'page:*'
             OR CAST(tree.value AS TEXT) GLOB 'document:*'
           )`,
      )
      .run(ownerType, importedAt);
  }
  const after = Number(
    toRecord(
      database
        .prepare("SELECT COUNT(*) AS count FROM workflow_store_evidence_references")
        .get(),
    ).count,
  );
  return after - before;
}

function finishHardening(database: DatabaseSync, appliedAt: string): void {
  const additions = [
    ["research_memo_versions", "idempotency_key", "TEXT"],
    ["research_item_versions", "idempotency_key", "TEXT"],
    ["research_tracking_observations", "idempotency_key", "TEXT"],
    ["research_change_events", "idempotency_key", "TEXT"],
    ["valuation_model_versions", "idempotency_key", "TEXT"],
    ["valuation_market_snapshots", "idempotency_key", "TEXT"],
    ["valuation_agent_analyses", "idempotency_key", "TEXT"],
    ["research_node_versions", "idempotency_key", "TEXT"],
    ["research_report_versions", "idempotency_key", "TEXT"],
    ["obsidian_sync_outbox", "lease_token", "TEXT"],
    ["valuation_derived_models", "resource_file_name", "TEXT"],
    ["valuation_derived_models", "resource_pipeline_job_id", "TEXT"],
    [
      "valuation_derived_models",
      "resource_status",
      "TEXT NOT NULL DEFAULT 'not_added'",
    ],
    ["valuation_derived_models", "resource_doc_id", "TEXT"],
    ["valuation_derived_models", "resource_added_at", "TEXT"],
    ["valuation_derived_models", "resource_error", "TEXT"],
  ] as const;
  for (const [table, column, definition] of additions) {
    ensureColumn(database, table, column, definition);
  }

  const idempotencyIndexes = [
    ["research_memo_versions", "uq_research_memo_versions_idempotency"],
    ["research_item_versions", "uq_research_item_versions_idempotency"],
    [
      "research_tracking_observations",
      "uq_research_tracking_observations_idempotency",
    ],
    ["research_change_events", "uq_research_change_events_idempotency"],
    ["valuation_model_versions", "uq_valuation_model_versions_idempotency"],
    ["valuation_market_snapshots", "uq_valuation_market_snapshots_idempotency"],
    ["valuation_agent_analyses", "uq_valuation_agent_analyses_idempotency"],
    ["research_node_versions", "uq_research_node_versions_idempotency"],
    ["research_report_versions", "uq_research_report_versions_idempotency"],
  ] as const;
  for (const [table, index] of idempotencyIndexes) {
    if (columns(database, table).has("idempotency_key")) {
      database.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${index}"
         ON "${table}"(idempotency_key)
         WHERE idempotency_key IS NOT NULL`,
      );
    }
  }
  normalizeLegacyJson(database, appliedAt);
  importEvidenceReferences(database, appliedAt);
}

const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "tracking_domain", sql: TRACKING_SCHEMA },
  { version: 2, name: "valuation_domain", sql: VALUATION_SCHEMA },
  { version: 3, name: "research_workflow_domain", sql: WORKFLOW_SCHEMA },
  { version: 4, name: "obsidian_transactional_projection", sql: OBSIDIAN_SCHEMA },
  {
    version: 5,
    name: "legacy_json_idempotency_and_evidence_ledger",
    sql: HARDENING_SCHEMA,
    finish: finishHardening,
  },
  {
    version: 6,
    name: "valuation_audit_sources_and_legacy_reconciliation",
    sql: VALUATION_AUDIT_SCHEMA,
    finish: finishValuationAuditMigration,
  },
  {
    version: 7,
    name: "valuation_model_overview_preservation",
    sql: VALUATION_MODEL_OVERVIEW_SCHEMA,
    finish: normalizeLegacyJson,
  },
];

export const WORKFLOW_STORE_MIGRATIONS: readonly WorkflowStoreMigration[] =
  MIGRATIONS.map((migration) => ({
    version: migration.version,
    name: migration.name,
    checksum: createHash("sha256")
      .update(`${migration.name}\0${migration.sql}`)
      .digest("hex"),
  }));

export const WORKFLOW_STORE_SCHEMA_VERSION =
  WORKFLOW_STORE_MIGRATIONS.at(-1)?.version ?? 0;

export function runWorkflowStoreMigrations(
  database: DatabaseSync,
  options: RunWorkflowStoreMigrationsOptions = {},
): WorkflowStoreMigrationResult {
  database.exec("PRAGMA foreign_keys=ON");
  database.exec("PRAGMA busy_timeout=30000");
  const adoptedLegacyTables = KNOWN_DOMAIN_TABLES.filter((table) =>
    tableExists(database, table),
  );
  const appliedAt = nowIso(options.now);
  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_store_schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const applied: WorkflowStoreMigration[] = [];
  for (const migration of MIGRATIONS) {
    const descriptor = WORKFLOW_STORE_MIGRATIONS.find(
      (candidate) => candidate.version === migration.version,
    );
    if (descriptor === undefined) {
      throw new Error(`Missing migration descriptor ${String(migration.version)}`);
    }
    const row = database
      .prepare(
        `SELECT name, checksum FROM workflow_store_schema_migrations WHERE version=?`,
      )
      .get(migration.version);
    if (row !== undefined) {
      const stored = toRecord(row);
      if (
        stored.name !== descriptor.name ||
        stored.checksum !== descriptor.checksum
      ) {
        throw new Error(
          `Workflow store migration ${String(migration.version)} checksum mismatch`,
        );
      }
      continue;
    }
    withTransaction(database, () => {
      database.exec(migration.sql);
      migration.finish?.(database, appliedAt);
      database
        .prepare(
          `INSERT INTO workflow_store_schema_migrations
             (version, name, checksum, applied_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          descriptor.version,
          descriptor.name,
          descriptor.checksum,
          appliedAt,
        );
    });
    applied.push(descriptor);
  }

  const quarantineRow = database
    .prepare(
      `SELECT COUNT(*) AS count FROM workflow_store_legacy_json_quarantine`,
    )
    .get();
  const evidenceRow = database
    .prepare(`SELECT COUNT(*) AS count FROM workflow_store_evidence_references`)
    .get();
  const legacyRowQuarantine = database
    .prepare(
      `SELECT COUNT(*) AS count FROM workflow_store_legacy_row_quarantine`,
    )
    .get();
  return {
    version: WORKFLOW_STORE_SCHEMA_VERSION,
    applied,
    adoptedLegacyTables,
    quarantinedJsonValues: Number(toRecord(quarantineRow).count),
    quarantinedLegacyRows: Number(toRecord(legacyRowQuarantine).count),
    importedEvidenceReferences: Number(toRecord(evidenceRow).count),
  };
}
