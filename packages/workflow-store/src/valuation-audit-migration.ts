import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  encodeJson,
  isEvidenceId,
  recordEvidenceReferences,
  stableId,
} from "./shared.js";

export const VALUATION_AUDIT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS workflow_store_legacy_row_quarantine (
    quarantine_id TEXT PRIMARY KEY,
    table_name TEXT NOT NULL,
    row_key TEXT NOT NULL,
    raw_row_json TEXT NOT NULL CHECK (json_valid(raw_row_json)),
    raw_row_sha256 TEXT NOT NULL,
    reason TEXT NOT NULL,
    quarantined_at TEXT NOT NULL,
    UNIQUE(table_name, row_key)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS legacy_agent_run_reconciliation_manifest (
    reconciliation_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    legacy_table TEXT NOT NULL CHECK (
      legacy_table IN (
        'valuation_impact_agent_runs',
        'valuation_metric_agent_extractions'
      )
    ),
    legacy_run_id TEXT NOT NULL,
    legacy_status TEXT NOT NULL,
    target_job_type TEXT NOT NULL CHECK (
      target_job_type IN ('valuation.compare', 'valuation.extract')
    ),
    control_job_id TEXT,
    disposition TEXT NOT NULL CHECK (
      disposition IN ('mapped', 'quarantined')
    ),
    source_fingerprint TEXT NOT NULL,
    legacy_row_sha256 TEXT NOT NULL,
    legacy_payload_json TEXT NOT NULL CHECK (json_valid(legacy_payload_json)),
    reason TEXT NOT NULL,
    reconciled_at TEXT NOT NULL,
    UNIQUE(legacy_table, legacy_run_id),
    CHECK (
      (disposition = 'mapped' AND control_job_id IS NOT NULL)
      OR
      (disposition = 'quarantined' AND control_job_id IS NULL)
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS valuation_context_cards (
    card_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    series_id TEXT NOT NULL,
    model_version_id TEXT NOT NULL,
    source_doc_id TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    card_type TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    insight TEXT NOT NULL,
    source_name TEXT NOT NULL,
    document_date TEXT,
    evidence_ids_json TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(evidence_ids_json) AND json_type(evidence_ids_json)='array'),
    provenance_json TEXT NOT NULL DEFAULT '{}'
      CHECK (json_valid(provenance_json) AND json_type(provenance_json)='object'),
    created_at TEXT NOT NULL,
    UNIQUE(model_version_id, source_doc_id, card_type, source_fingerprint),
    FOREIGN KEY(series_id)
      REFERENCES valuation_model_series(series_id) ON DELETE CASCADE,
    FOREIGN KEY(model_version_id)
      REFERENCES valuation_model_versions(model_version_id) ON DELETE CASCADE,
    CHECK(length(source_fingerprint) = 64)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS valuation_impact_cards (
    card_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    series_id TEXT NOT NULL,
    model_version_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind = 'control_job'),
    source_job_id TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    direction TEXT NOT NULL CHECK (
      direction IN ('positive', 'negative', 'mixed', 'neutral', 'uncertain')
    ),
    horizon TEXT NOT NULL,
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    title TEXT NOT NULL,
    evidence_summary TEXT NOT NULL,
    valuation_impact TEXT NOT NULL,
    affected_inputs_json TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(affected_inputs_json) AND json_type(affected_inputs_json)='array'),
    watch_items_json TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(watch_items_json) AND json_type(watch_items_json)='array'),
    source_refs_json TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(source_refs_json) AND json_type(source_refs_json)='array'),
    evidence_ids_json TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(evidence_ids_json) AND json_type(evidence_ids_json)='array'),
    provenance_json TEXT NOT NULL DEFAULT '{}'
      CHECK (json_valid(provenance_json) AND json_type(provenance_json)='object'),
    created_at TEXT NOT NULL,
    UNIQUE(source_kind, source_job_id, ordinal),
    FOREIGN KEY(series_id)
      REFERENCES valuation_model_series(series_id) ON DELETE CASCADE,
    FOREIGN KEY(model_version_id)
      REFERENCES valuation_model_versions(model_version_id) ON DELETE CASCADE,
    CHECK(length(source_fingerprint) = 64)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS valuation_market_price_bars (
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
    source_fingerprint TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(evidence_ids_json) AND json_type(evidence_ids_json)='array'),
    provenance_json TEXT NOT NULL DEFAULT '{}'
      CHECK (json_valid(provenance_json) AND json_type(provenance_json)='object'),
    fetched_at TEXT NOT NULL,
    UNIQUE(dataset_id, provider, provider_symbol, trade_date, adjustment),
    CHECK(length(source_fingerprint) = 64),
    CHECK(volume IS NULL OR volume >= 0),
    CHECK(amount IS NULL OR amount >= 0),
    CHECK(high IS NULL OR high >= close),
    CHECK(low IS NULL OR low <= close),
    CHECK(open IS NULL OR high IS NULL OR high >= open),
    CHECK(open IS NULL OR low IS NULL OR low <= open),
    CHECK(high IS NULL OR low IS NULL OR high >= low)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS valuation_price_comparisons (
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
    metadata_json TEXT NOT NULL DEFAULT '{}'
      CHECK (json_valid(metadata_json) AND json_type(metadata_json)='object'),
    evidence_ids_json TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(evidence_ids_json) AND json_type(evidence_ids_json)='array'),
    source_fingerprint TEXT NOT NULL,
    provenance_json TEXT NOT NULL DEFAULT '{}'
      CHECK (json_valid(provenance_json) AND json_type(provenance_json)='object'),
    created_at TEXT NOT NULL,
    UNIQUE(model_version_id, snapshot_id),
    FOREIGN KEY(series_id)
      REFERENCES valuation_model_series(series_id) ON DELETE CASCADE,
    FOREIGN KEY(model_version_id)
      REFERENCES valuation_model_versions(model_version_id) ON DELETE CASCADE,
    FOREIGN KEY(snapshot_id)
      REFERENCES valuation_market_snapshots(snapshot_id) ON DELETE CASCADE,
    CHECK(length(source_fingerprint) = 64)
  ) STRICT;
`;

const VALUATION_AUDIT_INDEXES = `
  CREATE INDEX IF NOT EXISTS ix_valuation_context_cards_scope
    ON valuation_context_cards(
      dataset_id, series_id, model_version_id, created_at DESC, card_id
    );
  CREATE INDEX IF NOT EXISTS ix_valuation_impact_cards_scope
    ON valuation_impact_cards(
      dataset_id, series_id, model_version_id, created_at DESC, card_id
    );
  CREATE INDEX IF NOT EXISTS ix_valuation_market_price_bars_lookup
    ON valuation_market_price_bars(
      dataset_id, canonical_ticker, trade_date DESC, bar_id
    );
  CREATE INDEX IF NOT EXISTS ix_valuation_price_comparisons_scope
    ON valuation_price_comparisons(
      dataset_id, series_id, model_version_id, created_at DESC,
      price_comparison_id
    );
  CREATE INDEX IF NOT EXISTS ix_legacy_agent_run_reconciliation_source
    ON legacy_agent_run_reconciliation_manifest(
      source_fingerprint, legacy_table, legacy_run_id
    );
`;

const LEGACY_TABLES = [
  "valuation_context_cards",
  "valuation_impact_cards",
  "valuation_market_price_bars",
  "valuation_price_comparisons",
] as const;

type LegacyValuationTable = (typeof LEGACY_TABLES)[number];
type LegacyRow = Record<string, null | number | string>;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return (
    database
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?",
      )
      .get(table) !== undefined
  );
}

function columns(database: DatabaseSync, table: string): Set<string> {
  if (!tableExists(database, table)) return new Set();
  return new Set(
    database
      .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
      .all()
      .map((row) => String(row.name)),
  );
}

function rows(database: DatabaseSync, table: string): LegacyRow[] {
  return database
    .prepare(`SELECT * FROM ${quoteIdentifier(table)}`)
    .all()
    .map((raw) => {
      const result: LegacyRow = {};
      for (const [key, value] of Object.entries(raw)) {
        if (
          value !== null &&
          typeof value !== "number" &&
          typeof value !== "string"
        ) {
          throw new Error(`${table}.${key} contains an unsupported legacy value`);
        }
        result[key] = value;
      }
      return result;
    });
}

function requiredText(
  row: LegacyRow,
  key: string,
  maximum = 1_000_000,
): string {
  const value = row[key];
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${key} is missing or invalid`);
  }
  return value;
}

function optionalText(
  row: LegacyRow,
  key: string,
  maximum = 1_000_000,
): string | null {
  const value = row[key];
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > maximum) {
    throw new Error(`${key} is invalid`);
  }
  return value;
}

function requiredNumber(row: LegacyRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} is not finite`);
  }
  return value;
}

function optionalNumber(row: LegacyRow, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} is not finite`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rowIdentity(table: LegacyValuationTable, row: LegacyRow): string {
  const key =
    table === "valuation_context_cards" ||
    table === "valuation_impact_cards"
      ? "card_id"
      : table === "valuation_market_price_bars"
        ? "bar_id"
        : "price_comparison_id";
  return requiredText(row, key, 240);
}

function legacyPayload(row: LegacyRow): {
  readonly json: string;
  readonly sha256: string;
} {
  const json = encodeJson(row);
  return { json, sha256: sha256(json) };
}

function quarantine(
  database: DatabaseSync,
  table: LegacyValuationTable,
  row: LegacyRow,
  reason: string,
  quarantinedAt: string,
): void {
  const rowKey = rowIdentity(table, row);
  const payload = legacyPayload(row);
  database
    .prepare(
      `INSERT INTO workflow_store_legacy_row_quarantine(
         quarantine_id, table_name, row_key, raw_row_json, raw_row_sha256,
         reason, quarantined_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(table_name, row_key) DO NOTHING`,
    )
    .run(
      stableId("qrow", table, rowKey),
      table,
      rowKey,
      payload.json,
      payload.sha256,
      reason.slice(0, 4_000),
      quarantinedAt,
    );
}

function parseJsonArray(
  row: LegacyRow,
  key: string,
): readonly unknown[] {
  const raw = row[key];
  if (typeof raw !== "string") throw new Error(`${key} is not JSON text`);
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value)) throw new Error(`${key} is not a JSON array`);
  return value;
}

function parseJsonObject(
  row: LegacyRow,
  key: string,
): Readonly<Record<string, unknown>> {
  const raw = row[key];
  if (typeof raw !== "string") throw new Error(`${key} is not JSON text`);
  const value = JSON.parse(raw) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} is not a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function evidenceIds(row: LegacyRow, key: string): string[] {
  return parseJsonArray(row, key).map((value) => {
    if (!isEvidenceId(value)) {
      throw new Error(`${key} contains an invalid Evidence ID`);
    }
    return value;
  });
}

function versionScope(
  database: DatabaseSync,
  modelVersionId: string,
  datasetId: string,
): string {
  const version = database
    .prepare(
      `SELECT series_id, dataset_id
       FROM valuation_model_versions WHERE model_version_id=?`,
    )
    .get(modelVersionId);
  if (
    version === undefined ||
    String(version.dataset_id) !== datasetId ||
    typeof version.series_id !== "string" ||
    version.series_id.length === 0
  ) {
    throw new Error("model_version_id has no matching tenant-scoped model");
  }
  return version.series_id;
}

function provenance(
  table: LegacyValuationTable,
  rowId: string,
  rawRowSha256: string,
): string {
  return encodeJson({
    migration: "legacy-valuation-audit-v1",
    legacyTable: table,
    legacyRowId: rowId,
    rawRowSha256,
  });
}

function migrateContextCards(
  database: DatabaseSync,
  migratedAt: string,
): void {
  const table = "valuation_context_cards";
  const backup = `legacy_${table}_v0`;
  if (!tableExists(database, backup)) return;
  const insert = database.prepare(
    `INSERT INTO valuation_context_cards(
       card_id, dataset_id, series_id, model_version_id, source_doc_id,
       source_fingerprint, card_type, title, summary, insight, source_name,
       document_date, evidence_ids_json, provenance_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows(database, backup)) {
    try {
      const cardId = rowIdentity(table, row);
      const datasetId = requiredText(row, "dataset_id", 240);
      const modelVersionId = requiredText(row, "model_version_id", 240);
      const seriesId = versionScope(database, modelVersionId, datasetId);
      const ids = evidenceIds(row, "evidence_ids_json");
      const payload = legacyPayload(row);
      insert.run(
        cardId,
        datasetId,
        seriesId,
        modelVersionId,
        requiredText(row, "source_doc_id", 240),
        payload.sha256,
        requiredText(row, "card_type", 120),
        requiredText(row, "title", 1_000),
        requiredText(row, "summary"),
        requiredText(row, "insight"),
        requiredText(row, "source_name", 1_000),
        optionalText(row, "document_date", 80),
        encodeJson(ids),
        provenance(table, cardId, payload.sha256),
        requiredText(row, "created_at", 80),
      );
      recordEvidenceReferences(
        database,
        "valuation-context-card",
        cardId,
        ids,
        "supports",
        migratedAt,
      );
    } catch (error) {
      quarantine(
        database,
        table,
        row,
        error instanceof Error ? error.message : String(error),
        migratedAt,
      );
    }
  }
}

function migrateImpactCards(
  database: DatabaseSync,
  migratedAt: string,
): void {
  const table = "valuation_impact_cards";
  const backup = `legacy_${table}_v0`;
  if (!tableExists(database, backup)) return;
  for (const row of rows(database, backup)) {
    quarantine(
      database,
      table,
      row,
      "Legacy impact cards depend on an unverified Python Agent run; raw data is preserved but must be recomputed by a control-plane valuation.compare job",
      migratedAt,
    );
  }
}

function assertPriceBar(
  open: number | null,
  high: number | null,
  low: number | null,
  close: number,
  volume: number | null,
  amount: number | null,
): void {
  if (
    (volume !== null && volume < 0) ||
    (amount !== null && amount < 0) ||
    (high !== null && high < close) ||
    (low !== null && low > close) ||
    (open !== null && high !== null && high < open) ||
    (open !== null && low !== null && low > open) ||
    (high !== null && low !== null && high < low)
  ) {
    throw new Error("OHLCV values violate market-bar invariants");
  }
}

function migrateMarketPriceBars(
  database: DatabaseSync,
  migratedAt: string,
): void {
  const table = "valuation_market_price_bars";
  const backup = `legacy_${table}_v0`;
  if (!tableExists(database, backup)) return;
  const insert = database.prepare(
    `INSERT INTO valuation_market_price_bars(
       bar_id, dataset_id, provider, provider_symbol, canonical_ticker,
       exchange, currency, trade_date, open, high, low, close, volume,
       amount, adjustment, source, source_fingerprint, evidence_ids_json,
       provenance_json, fetched_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
  );
  for (const row of rows(database, backup)) {
    try {
      const barId = rowIdentity(table, row);
      const open = optionalNumber(row, "open");
      const high = optionalNumber(row, "high");
      const low = optionalNumber(row, "low");
      const close = requiredNumber(row, "close");
      const volume = optionalNumber(row, "volume");
      const amount = optionalNumber(row, "amount");
      assertPriceBar(open, high, low, close, volume, amount);
      const payload = legacyPayload(row);
      insert.run(
        barId,
        requiredText(row, "dataset_id", 240),
        requiredText(row, "provider", 120),
        requiredText(row, "provider_symbol", 120),
        requiredText(row, "canonical_ticker", 120),
        requiredText(row, "exchange", 80),
        requiredText(row, "currency", 40),
        requiredText(row, "trade_date", 40),
        open,
        high,
        low,
        close,
        volume,
        amount,
        requiredText(row, "adjustment", 80),
        optionalText(row, "source", 2_000),
        payload.sha256,
        provenance(table, barId, payload.sha256),
        requiredText(row, "fetched_at", 80),
      );
    } catch (error) {
      quarantine(
        database,
        table,
        row,
        error instanceof Error ? error.message : String(error),
        migratedAt,
      );
    }
  }
}

function migratePriceComparisons(
  database: DatabaseSync,
  migratedAt: string,
): void {
  const table = "valuation_price_comparisons";
  const backup = `legacy_${table}_v0`;
  if (!tableExists(database, backup)) return;
  const insert = database.prepare(
    `INSERT INTO valuation_price_comparisons(
       price_comparison_id, snapshot_id, dataset_id, series_id,
       model_version_id, provider, provider_symbol, currency, valuation_date,
       benchmark_trade_date, benchmark_close, latest_trade_date, latest_close,
       target_price, target_unit, target_source, target_evidence_id,
       implied_upside, latest_upside, status, error_message, metadata_json,
       evidence_ids_json, source_fingerprint, provenance_json, created_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?
     )`,
  );
  for (const row of rows(database, backup)) {
    try {
      const comparisonId = rowIdentity(table, row);
      const datasetId = requiredText(row, "dataset_id", 240);
      const seriesId = requiredText(row, "series_id", 240);
      const modelVersionId = requiredText(row, "model_version_id", 240);
      if (versionScope(database, modelVersionId, datasetId) !== seriesId) {
        throw new Error("series_id does not match model_version_id");
      }
      const snapshotId = requiredText(row, "snapshot_id", 240);
      const snapshot = database
        .prepare(
          `SELECT dataset_id, series_id, model_version_id
           FROM valuation_market_snapshots WHERE snapshot_id=?`,
        )
        .get(snapshotId);
      if (
        snapshot === undefined ||
        String(snapshot.dataset_id) !== datasetId ||
        String(snapshot.series_id) !== seriesId ||
        String(snapshot.model_version_id) !== modelVersionId
      ) {
        throw new Error("snapshot_id does not match valuation scope");
      }
      const targetEvidenceId = optionalText(row, "target_evidence_id", 240);
      if (targetEvidenceId !== null && !isEvidenceId(targetEvidenceId)) {
        throw new Error("target_evidence_id is invalid");
      }
      const ids = targetEvidenceId === null ? [] : [targetEvidenceId];
      const metadata = parseJsonObject(row, "metadata_json");
      const payload = legacyPayload(row);
      insert.run(
        comparisonId,
        snapshotId,
        datasetId,
        seriesId,
        modelVersionId,
        requiredText(row, "provider", 120),
        optionalText(row, "provider_symbol", 120),
        optionalText(row, "currency", 40),
        optionalText(row, "valuation_date", 80),
        optionalText(row, "benchmark_trade_date", 40),
        optionalNumber(row, "benchmark_close"),
        optionalText(row, "latest_trade_date", 40),
        optionalNumber(row, "latest_close"),
        optionalNumber(row, "target_price"),
        optionalText(row, "target_unit", 80),
        optionalText(row, "target_source", 2_000),
        targetEvidenceId,
        optionalNumber(row, "implied_upside"),
        optionalNumber(row, "latest_upside"),
        requiredText(row, "status", 120),
        optionalText(row, "error_message", 8_000),
        encodeJson(metadata),
        encodeJson(ids),
        payload.sha256,
        provenance(table, comparisonId, payload.sha256),
        requiredText(row, "created_at", 80),
      );
      recordEvidenceReferences(
        database,
        "valuation-price-comparison",
        comparisonId,
        ids,
        "supports",
        migratedAt,
      );
    } catch (error) {
      quarantine(
        database,
        table,
        row,
        error instanceof Error ? error.message : String(error),
        migratedAt,
      );
    }
  }
}

function preserveLegacyTables(database: DatabaseSync): void {
  for (const table of LEGACY_TABLES) {
    if (
      !tableExists(database, table) ||
      columns(database, table).has("provenance_json")
    ) {
      continue;
    }
    const backup = `legacy_${table}_v0`;
    if (tableExists(database, backup)) {
      throw new Error(
        `Cannot preserve ${table}: destination ${backup} already exists`,
      );
    }
    for (const index of database
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`,
      )
      .all(table)
      .map((row) => String(row.name))) {
      database.exec(`DROP INDEX ${quoteIdentifier(index)}`);
    }
    database.exec(
      `ALTER TABLE ${quoteIdentifier(table)} RENAME TO ${quoteIdentifier(backup)}`,
    );
  }
}

export function finishValuationAuditMigration(
  database: DatabaseSync,
  migratedAt: string,
): void {
  preserveLegacyTables(database);
  database.exec(VALUATION_AUDIT_SCHEMA);
  database.exec(VALUATION_AUDIT_INDEXES);
  migrateContextCards(database, migratedAt);
  migrateImpactCards(database, migratedAt);
  migrateMarketPriceBars(database, migratedAt);
  migratePriceComparisons(database, migratedAt);
}
