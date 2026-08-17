import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  WORKFLOW_STORE_SCHEMA_VERSION,
  runWorkflowStoreMigrations,
} from "../src/index.js";

describe("workflow-store migrations", () => {
  let database: DatabaseSync | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("adopts exact legacy tables, quarantines malformed JSON and preserves Evidence IDs", () => {
    database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE research_memo_sections (
        section_id TEXT PRIMARY KEY,
        evidence_ids_json TEXT
      );
      INSERT INTO research_memo_sections VALUES
        ('section-valid', '["chunk:legacy-1","fact:legacy-2"]'),
        ('section-corrupt', '{not-json');

      CREATE TABLE research_item_evidence (
        item_version_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        relation_type TEXT NOT NULL DEFAULT 'supports',
        PRIMARY KEY(item_version_id, evidence_id, relation_type)
      );
      INSERT INTO research_item_evidence VALUES
        ('version-legacy', 'cell:legacy-3', 'supports');

      CREATE TABLE valuation_derived_models (
        derived_model_id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL,
        series_id TEXT NOT NULL,
        analysis_id TEXT NOT NULL UNIQUE,
        base_model_version_id TEXT NOT NULL,
        derived_version_no INTEGER NOT NULL,
        output_filename TEXT NOT NULL,
        output_path TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_changes_json TEXT NOT NULL DEFAULT '[]',
        skipped_changes_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      INSERT INTO valuation_derived_models VALUES (
        'derived-legacy', 'dataset-a', 'series-a', 'analysis-a', 'version-a', 1,
        'derived.xlsx', '/project/derived.xlsx', 'checksum',
        '[]', '[]', '2026-07-01T00:00:00Z'
      );

      CREATE TABLE valuation_analysis_versions (
        analysis_version_id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL,
        series_id TEXT NOT NULL,
        model_version_id TEXT NOT NULL,
        previous_analysis_version_id TEXT,
        status TEXT NOT NULL,
        summary_markdown TEXT NOT NULL,
        analysis_json TEXT NOT NULL,
        analyzer_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(model_version_id, analyzer_version)
      );
      INSERT INTO valuation_analysis_versions VALUES (
        'analysis-version-legacy', 'dataset-a', 'series-a', 'version-a', NULL,
        'completed', '# Legacy',
        '{"highlights":[{"evidence_ids":["page:legacy-analysis-4"]}]}',
        'legacy-analyzer', '2026-07-01T00:00:00Z'
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
        completed_at TEXT
      );
      INSERT INTO research_node_versions VALUES (
        'node-version-running', 'workflow-a', 'node-a', 1, 'running',
        '{}', NULL, NULL, NULL, NULL, NULL,
        '2026-07-01T00:00:00Z', NULL
      );

      CREATE TABLE obsidian_sync_outbox (
        event_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        available_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL
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
      INSERT INTO obsidian_note_registry VALUES (
        'dataset-a', 'memo-series', 'memo-a', '1', 'memo-a.md',
        'content', 'managed', 'synced', '2026-07-01T00:00:00Z', NULL
      );
    `);

    const result = runWorkflowStoreMigrations(database, {
      now: new Date("2026-07-30T00:00:00Z"),
    });
    expect(result.version).toBe(WORKFLOW_STORE_SCHEMA_VERSION);
    expect(result.adoptedLegacyTables).toEqual(
      expect.arrayContaining([
        "research_memo_sections",
        "research_item_evidence",
        "valuation_derived_models",
        "valuation_analysis_versions",
        "research_node_versions",
        "obsidian_sync_outbox",
        "obsidian_note_registry",
      ]),
    );
    expect(result.quarantinedLegacyRows).toBe(0);
    expect(result.quarantinedJsonValues).toBe(1);
    expect(
      database
        .prepare(
          `SELECT raw_value, replacement_json
           FROM workflow_store_legacy_json_quarantine
           WHERE table_name='research_memo_sections'
             AND row_key='section-corrupt'`,
        )
        .get(),
    ).toMatchObject({
      raw_value: "{not-json",
      replacement_json: "[]",
    });
    expect(
      database
        .prepare(
          `SELECT evidence_id FROM workflow_store_evidence_references
           ORDER BY evidence_id`,
        )
        .all()
        .map((row) => row.evidence_id),
    ).toEqual([
      "cell:legacy-3",
      "chunk:legacy-1",
      "fact:legacy-2",
      "page:legacy-analysis-4",
    ]);
    expect(
      database
        .prepare(
          `SELECT resource_status FROM valuation_derived_models
           WHERE derived_model_id='derived-legacy'`,
        )
        .get()?.resource_status,
    ).toBe("not_added");
    expect(
      database
        .prepare(
          `SELECT sync_status FROM obsidian_note_registry
           WHERE entity_id='memo-a'`,
        )
        .get()?.sync_status,
    ).toBe("synced");
    expect(
      database
        .prepare(
          `SELECT structured_output_json FROM research_node_versions
           WHERE node_version_id='node-version-running'`,
        )
        .get()?.structured_output_json,
    ).toBeNull();
    expect(
      database
        .prepare(`PRAGMA table_info(obsidian_sync_outbox)`)
        .all()
        .map((row) => row.name),
    ).toContain("lease_token");

    const rerun = runWorkflowStoreMigrations(database);
    expect(rerun.applied).toEqual([]);
    expect(
      database
        .prepare(`SELECT COUNT(*) AS count FROM workflow_store_schema_migrations`)
        .get()?.count,
    ).toBe(WORKFLOW_STORE_SCHEMA_VERSION);
  });

  it("creates strict JSON checks for new project databases", () => {
    database = new DatabaseSync(":memory:");
    runWorkflowStoreMigrations(database);
    expect(() =>
      database?.prepare(
        `INSERT INTO research_watch_rules
           (rule_id, dataset_id, name, target_type, query_json, min_priority,
            frequency, active, created_at, updated_at)
         VALUES ('rule', 'dataset', 'name', 'all', '{bad', 'medium',
                 'on_ingest', 1, 'now', 'now')`,
      ).run(),
    ).toThrow(/CHECK constraint failed/u);
  });

  it("preserves legacy valuation source tables and accounts for every canonical or quarantined row", () => {
    database = new DatabaseSync(":memory:");
    runWorkflowStoreMigrations(database);
    database.exec(`
      DELETE FROM workflow_store_schema_migrations WHERE version=6;
      DROP TABLE valuation_context_cards;
      DROP TABLE valuation_impact_cards;
      DROP TABLE valuation_market_price_bars;
      DROP TABLE valuation_price_comparisons;

      INSERT INTO valuation_model_series(
        series_id, dataset_id, series_key, name, current_version_no, status,
        created_at, updated_at
      ) VALUES (
        'series-legacy', 'project-legacy', 'legacy-series', 'Legacy model',
        1, 'active', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'
      );
      INSERT INTO valuation_model_versions(
        model_version_id, series_id, dataset_id, doc_id, logical_doc_id,
        document_version_no, parent_model_version_id, reverted_to_version_id,
        checksum, snapshot_hash, original_filename, document_date, model_type,
        node_count, formula_node_count, review_required_count, analyzer_version,
        idempotency_key, created_at
      ) VALUES (
        'model-version-legacy', 'series-legacy', 'project-legacy',
        'model-doc-legacy', NULL, 1, NULL, NULL, 'checksum', 'snapshot',
        'legacy.xlsx', '2026-06-30', 'dcf', 0, 0, 0, 'legacy-v1', NULL,
        '2026-07-01T00:00:00Z'
      );
      INSERT INTO valuation_market_snapshots(
        snapshot_id, dataset_id, series_id, model_version_id, company_name,
        company_ticker, provider, status, as_of, error_message, raw_json,
        idempotency_key, created_at
      ) VALUES (
        'snapshot-legacy', 'project-legacy', 'series-legacy',
        'model-version-legacy', 'Legacy Co', 'LEG', 'legacy-provider',
        'completed', '2026-07-30T00:00:00Z', NULL, '{}', NULL,
        '2026-07-30T00:00:00Z'
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
      INSERT INTO valuation_context_cards VALUES
        (
          'context-valid', 'project-legacy', 'model-version-legacy',
          'industry-doc', 'industry', 'Demand', 'Stable demand',
          'Base case supported', 'Industry source', '2026-06-30',
          '["page:industry-7"]', '2026-07-01T00:00:00Z'
        ),
        (
          'context-invalid', 'project-legacy', 'model-version-legacy',
          'bad-doc', 'industry', 'Bad', 'Bad JSON', 'Must quarantine',
          'Bad source', NULL, '{bad-json', '2026-07-01T00:00:00Z'
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
      INSERT INTO valuation_impact_cards VALUES (
        'impact-legacy', 'python-run-1', 'project-legacy', 'series-legacy',
        'model-version-legacy', 'source-fingerprint', 0, 'negative', '12m',
        0.8, 'Pressure', 'Legacy evidence', 'Reduce margin', '[]', '[]',
        '[]', '["fact:legacy-impact"]', '2026-07-01T00:00:00Z'
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
      INSERT INTO valuation_market_price_bars VALUES (
        'bar-legacy', 'project-legacy', 'legacy-provider', 'LEG',
        'LEG', 'TEST', 'CNY', '2026-07-30', 10, 12, 9, 11, 100, 1100,
        'raw', 'legacy-feed', '2026-07-30T01:00:00Z'
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
      INSERT INTO valuation_price_comparisons VALUES (
        'price-comparison-legacy', 'snapshot-legacy', 'project-legacy',
        'series-legacy', 'model-version-legacy', 'legacy-provider', 'LEG',
        'CNY', '2026-07-15', '2026-07-15', 10, '2026-07-30', 11, 14,
        'CNY/share', 'DCF', 'cell:legacy-target', 0.4, 0.2727, 'completed',
        NULL, '{"policy":"on-or-before"}', '2026-07-30T01:00:00Z'
      );
    `);

    const result = runWorkflowStoreMigrations(database, {
      now: new Date("2026-07-31T00:00:00Z"),
    });
    expect(result.applied.map((migration) => migration.version)).toEqual([6]);
    expect(result.adoptedLegacyTables).toEqual(
      expect.arrayContaining([
        "valuation_context_cards",
        "valuation_impact_cards",
        "valuation_market_price_bars",
        "valuation_price_comparisons",
      ]),
    );
    expect(result.quarantinedLegacyRows).toBe(2);
    for (const table of [
      "valuation_context_cards",
      "valuation_impact_cards",
      "valuation_market_price_bars",
      "valuation_price_comparisons",
    ]) {
      expect(
        database
          .prepare(
            `SELECT 1 FROM sqlite_schema
             WHERE type='table' AND name=?`,
          )
          .get(`legacy_${table}_v0`),
      ).toBeDefined();
    }
    expect(
      database
        .prepare(`SELECT card_id FROM valuation_context_cards`)
        .all(),
    ).toEqual([{ card_id: "context-valid" }]);
    expect(
      database
        .prepare(`SELECT bar_id FROM valuation_market_price_bars`)
        .all(),
    ).toEqual([{ bar_id: "bar-legacy" }]);
    expect(
      database
        .prepare(
          `SELECT price_comparison_id FROM valuation_price_comparisons`,
        )
        .all(),
    ).toEqual([
      { price_comparison_id: "price-comparison-legacy" },
    ]);
    expect(
      database
        .prepare(`SELECT COUNT(*) AS count FROM valuation_impact_cards`)
        .get()?.count,
    ).toBe(0);
    expect(
      database
        .prepare(
          `SELECT table_name, row_key
           FROM workflow_store_legacy_row_quarantine
           ORDER BY table_name, row_key`,
        )
        .all(),
    ).toEqual([
      {
        table_name: "valuation_context_cards",
        row_key: "context-invalid",
      },
      {
        table_name: "valuation_impact_cards",
        row_key: "impact-legacy",
      },
    ]);
    expect(
      database
        .prepare(
          `SELECT owner_type, owner_id, evidence_id
           FROM workflow_store_evidence_references
           WHERE owner_type IN (
             'valuation-context-card', 'valuation-price-comparison'
           )
           ORDER BY owner_type`,
        )
        .all(),
    ).toEqual([
      {
        owner_type: "valuation-context-card",
        owner_id: "context-valid",
        evidence_id: "page:industry-7",
      },
      {
        owner_type: "valuation-price-comparison",
        owner_id: "price-comparison-legacy",
        evidence_id: "cell:legacy-target",
      },
    ]);
  });
});
