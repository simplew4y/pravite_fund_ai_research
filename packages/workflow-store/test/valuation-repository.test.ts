import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runWorkflowStoreMigrations } from "../src/migrations.js";
import {
  ValuationRepository,
} from "../src/valuation-repository.js";

interface Fixture {
  readonly datasetId: string;
  readonly seriesId: string;
  readonly version1Id: string;
  readonly version2Id: string;
  readonly nodeId: string;
}

describe("ValuationRepository", () => {
  let database: DatabaseSync;
  let repository: ValuationRepository;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    runWorkflowStoreMigrations(database);
    repository = new ValuationRepository(database);
  });

  afterEach(() => {
    database.close();
  });

  function fixture(): Fixture {
    const datasetId = "project-alpha";
    const series = repository.upsertSeries({
      datasetId,
      seriesKey: "logical-doc:valuation-model",
      name: "Alpha DCF",
      companyName: "Alpha Holdings",
      companyTicker: "000001.SZ",
      modelType: "dcf_model",
    });
    const first = repository.saveModelVersion({
      datasetId,
      seriesId: series.seriesId,
      docId: "doc:model:v1",
      documentVersionNo: 1,
      checksum: "a".repeat(64),
      snapshotHash: "b".repeat(64),
      originalFilename: "alpha-dcf-v1.xlsx",
      modelType: "dcf_model",
      nodeCount: 1,
      analyzerVersion: "valuation-tracking-v1",
      idempotencyKey: "alpha-model-v1",
    });
    const second = repository.saveModelVersion({
      datasetId,
      seriesId: series.seriesId,
      docId: "doc:model:v2",
      documentVersionNo: 2,
      parentModelVersionId: first.value.modelVersionId,
      checksum: "c".repeat(64),
      snapshotHash: "d".repeat(64),
      originalFilename: "alpha-dcf-v2.xlsx",
      modelType: "dcf_model",
      nodeCount: 1,
      analyzerVersion: "valuation-tracking-v1",
      idempotencyKey: "alpha-model-v2",
    });
    const node = repository.upsertNode({
      seriesId: series.seriesId,
      canonicalKey: "assumption:wacc:2026:base",
      nodeKind: "assumption",
      metricKey: "wacc",
      displayName: "WACC",
      scope: "company",
      period: "2026",
      scenario: "base",
    });
    return {
      datasetId,
      seriesId: series.seriesId,
      version1Id: first.value.modelVersionId,
      version2Id: second.value.modelVersionId,
      nodeId: node.nodeId,
    };
  }

  it("stores versioned model nodes immutably and preserves Evidence IDs", () => {
    const setup = fixture();
    expect(() =>
      repository.saveModelVersion({
        datasetId: setup.datasetId,
        seriesId: setup.seriesId,
        docId: "doc:model:v1",
        documentVersionNo: 1,
        checksum: "a".repeat(64),
        snapshotHash: "b".repeat(64),
        originalFilename: "different-name.xlsx",
        modelType: "dcf_model",
        nodeCount: 1,
        analyzerVersion: "valuation-tracking-v1",
        idempotencyKey: "alpha-model-v1",
      }),
    ).toThrow(/idempotency key/u);
    const firstSave = repository.saveNodeValue({
      modelVersionId: setup.version1Id,
      nodeId: setup.nodeId,
      valueNumeric: 0.085,
      unit: "percent",
      sheetName: "DCF",
      cellRef: "B12",
      evidenceId: "cell:alpha-v1-dcf-b12",
      qualityStatus: "verified",
      confidence: 0.98,
      metadata: { source: "legacy-excel", labels: ["WACC", "base"] },
    });
    const duplicate = repository.saveNodeValue({
      modelVersionId: setup.version1Id,
      nodeId: setup.nodeId,
      valueNumeric: 0.085,
      unit: "percent",
      sheetName: "DCF",
      cellRef: "B12",
      evidenceId: "cell:alpha-v1-dcf-b12",
      qualityStatus: "verified",
      confidence: 0.98,
      metadata: { labels: ["WACC", "base"], source: "legacy-excel" },
    });

    expect(firstSave.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.value.evidenceId).toBe("cell:alpha-v1-dcf-b12");
    expect(duplicate.value.metadata).toEqual({
      labels: ["WACC", "base"],
      source: "legacy-excel",
    });
    expect(() =>
      repository.saveNodeValue({
        modelVersionId: setup.version1Id,
        nodeId: setup.nodeId,
        valueNumeric: 0.09,
        unit: "percent",
        sheetName: "DCF",
        cellRef: "B12",
        evidenceId: "cell:alpha-v1-dcf-b12",
        qualityStatus: "verified",
        confidence: 0.98,
        metadata: { source: "legacy-excel", labels: ["WACC", "base"] },
      }),
    ).toThrow(/immutable/u);

    const versions = repository.listModelVersions(
      setup.datasetId,
      setup.seriesId,
      { limit: 1, offset: 0 },
    );
    expect(versions).toMatchObject({
      total: 2,
      limit: 1,
      offset: 0,
      hasMore: true,
    });
    expect(versions.items[0]?.documentVersionNo).toBe(2);
    expect(
      database
        .prepare(
          `SELECT evidence_id FROM workflow_store_evidence_references
           WHERE owner_type = 'valuation-node-value'
             AND owner_id = ?`,
        )
        .get(firstSave.value.nodeValueId),
    ).toMatchObject({ evidence_id: "cell:alpha-v1-dcf-b12" });
  });

  it("stores immutable legacy-compatible valuation analysis versions", () => {
    const setup = fixture();
    const first = repository.saveAnalysisVersion({
      datasetId: setup.datasetId,
      seriesId: setup.seriesId,
      modelVersionId: setup.version1Id,
      summaryMarkdown: "# Baseline",
      analysis: {
        highlights: [{ evidence_ids: ["cell:alpha-v1-dcf-b12"] }],
      },
      analyzerVersion: "valuation-tracking-v1",
    });
    const second = repository.saveAnalysisVersion({
      datasetId: setup.datasetId,
      seriesId: setup.seriesId,
      modelVersionId: setup.version2Id,
      previousAnalysisVersionId: first.value.analysisVersionId,
      summaryMarkdown: "# Updated",
      analysis: {
        highlights: [{ evidence_ids: ["cell:alpha-v2-dcf-b12"] }],
      },
      analyzerVersion: "valuation-tracking-v1",
    });
    const repeated = repository.saveAnalysisVersion({
      datasetId: setup.datasetId,
      seriesId: setup.seriesId,
      modelVersionId: setup.version2Id,
      previousAnalysisVersionId: first.value.analysisVersionId,
      summaryMarkdown: "# Updated",
      analysis: {
        highlights: [{ evidence_ids: ["cell:alpha-v2-dcf-b12"] }],
      },
      analyzerVersion: "valuation-tracking-v1",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(repeated).toEqual({ value: second.value, created: false });
    expect(
      repository.getAnalysisForModelVersion(
        setup.datasetId,
        setup.version2Id,
        "valuation-tracking-v1",
      ),
    ).toEqual(second.value);
    expect(
      repository.listAnalysisVersions(
        setup.datasetId,
        setup.seriesId,
        { limit: 1 },
      ),
    ).toMatchObject({ total: 2, hasMore: true });
    expect(
      database
        .prepare(
          `SELECT evidence_id FROM workflow_store_evidence_references
           WHERE owner_type='valuation-analysis-version'
             AND owner_id=?
           ORDER BY evidence_id`,
        )
        .all(second.value.analysisVersionId)
        .map((row) => row.evidence_id),
    ).toEqual(["cell:alpha-v2-dcf-b12"]);
    expect(() =>
      repository.saveAnalysisVersion({
        datasetId: setup.datasetId,
        seriesId: setup.seriesId,
        modelVersionId: setup.version2Id,
        previousAnalysisVersionId: first.value.analysisVersionId,
        summaryMarkdown: "# Overwrite",
        analysis: {},
        analyzerVersion: "valuation-tracking-v1",
      }),
    ).toThrow(/identity was reused/u);
  });

  it("returns the full materialized model overview without dropping legacy fields", () => {
    const setup = fixture();
    const overview = {
      schema_version: 1,
      model_name: "Alpha DCF",
      summary: {
        detected_statements: ["income_statement"],
        missing_statements: ["cash_flow"],
        statement_count: 1,
      },
      statements: [
        {
          statement_type: "income_statement",
          title: "Income statement",
          periods: ["2025FY", "2026FY"],
          rows: [
            {
              metric_key: "revenue",
              metric_name: "Revenue",
              values: [100, 120],
            },
          ],
        },
      ],
    };
    const html =
      "<!DOCTYPE html><html><body><table><tr><td>Revenue</td></tr></table></body></html>";
    database
      .prepare(
        `INSERT INTO valuation_model_overviews(
           overview_id, dataset_id, series_id, model_version_id, doc_id,
           status, overview_json, html, overview_version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "overview-alpha-v2",
        setup.datasetId,
        setup.seriesId,
        setup.version2Id,
        "doc:model:v2",
        "completed",
        JSON.stringify(overview),
        html,
        "legacy-overview-v1",
        "2026-07-31T00:00:00.000Z",
      );

    expect(
      repository.getModelOverview(
        setup.datasetId,
        setup.seriesId,
        setup.version2Id,
      ),
    ).toEqual({
      overviewId: "overview-alpha-v2",
      datasetId: setup.datasetId,
      seriesId: setup.seriesId,
      modelVersionId: setup.version2Id,
      docId: "doc:model:v2",
      status: "completed",
      overview,
      html,
      overviewVersion: "legacy-overview-v1",
      createdAt: "2026-07-31T00:00:00.000Z",
    });
    expect(
      repository.getModelOverview(
        "another-project",
        setup.seriesId,
        setup.version2Id,
      ),
    ).toBeNull();
  });

  it("adopts Python legacy identities through natural keys", () => {
    const setup = fixture();
    database
      .prepare(
        `INSERT INTO valuation_model_versions(
           model_version_id, series_id, dataset_id, doc_id, logical_doc_id,
           document_version_no, parent_model_version_id,
           reverted_to_version_id, checksum, snapshot_hash,
           original_filename, document_date, model_type, node_count,
           formula_node_count, review_required_count, analyzer_version,
           idempotency_key, created_at
         ) VALUES (
           'vmv_python_legacy_id', ?, ?, 'doc:model:legacy', NULL, 3,
           NULL, NULL, ?, ?, 'legacy.xlsx', NULL, 'dcf_model', 2, 1, 0,
           'valuation-tracking-v1', NULL, '2026-07-01T00:00:00.000Z'
         )`,
      )
      .run(
        setup.seriesId,
        setup.datasetId,
        "e".repeat(64),
        "f".repeat(64),
      );
    const adoptedVersion = repository.saveModelVersion({
      datasetId: setup.datasetId,
      seriesId: setup.seriesId,
      docId: "doc:model:legacy",
      documentVersionNo: 3,
      checksum: "e".repeat(64),
      snapshotHash: "f".repeat(64),
      originalFilename: "legacy.xlsx",
      modelType: "dcf_model",
      nodeCount: 2,
      formulaNodeCount: 1,
      analyzerVersion: "valuation-tracking-v1",
    });
    expect(adoptedVersion).toMatchObject({
      created: false,
      value: { modelVersionId: "vmv_python_legacy_id" },
    });

    database
      .prepare(
        `INSERT INTO valuation_agent_analyses(
           analysis_id, dataset_id, series_id, base_model_version_id,
           comparison_model_version_id, status, focus, valuation_method,
           executive_summary, investment_conclusion, analysis_json,
           planner_json, evidence_ids_json, raw_response, model_name,
           agent_version, error_message, idempotency_key, created_at,
           updated_at, completed_at
         ) VALUES (
           'vaa_python_legacy_id', ?, ?, 'vmv_python_legacy_id', NULL,
           'pending', 'Legacy focus', NULL, NULL, NULL, '{}', '{}', '[]',
           NULL, NULL, 'legacy-agent-v1', NULL, NULL,
           '2026-07-01T00:00:00.000Z',
           '2026-07-01T00:00:00.000Z', NULL
         )`,
      )
      .run(setup.datasetId, setup.seriesId);
    expect(
      repository.createAgentAnalysis({
        datasetId: setup.datasetId,
        seriesId: setup.seriesId,
        baseModelVersionId: "vmv_python_legacy_id",
        focus: "Legacy focus",
        agentVersion: "legacy-agent-v1",
      }),
    ).toMatchObject({
      created: false,
      value: { analysisId: "vaa_python_legacy_id" },
    });
  });

  it("persists market metrics, manual overrides, comparisons and snapshot state", () => {
    const setup = fixture();
    repository.upsertMetricModelValue({
      datasetId: setup.datasetId,
      seriesId: setup.seriesId,
      modelVersionId: setup.version2Id,
      metricKey: "forward_pe",
      valueNumeric: 14.2,
      unit: "multiple",
      period: "2026E",
      status: "available",
      method: "model_fact",
      source: "Alpha DCF!F42",
      evidenceIds: ["fact:alpha-forward-pe"],
      qualityStatus: "verified",
    });
    repository.upsertMetricModelValue({
      datasetId: setup.datasetId,
      seriesId: setup.seriesId,
      modelVersionId: setup.version2Id,
      metricKey: "forward_pe",
      valueNumeric: 14.2,
      unit: "multiple",
      period: "2026E",
      status: "available",
      method: "model_fact",
      source: "Alpha DCF!F42",
      evidenceIds: ["fact:alpha-forward-pe-updated"],
      qualityStatus: "verified",
    });
    expect(
      database
        .prepare(
          `SELECT evidence_id FROM workflow_store_evidence_references
           WHERE owner_type='valuation-model-metric'
           ORDER BY evidence_id`,
        )
        .all()
        .map((row) => row.evidence_id),
    ).toEqual(["fact:alpha-forward-pe-updated"]);
    const created = repository.createMarketSnapshot({
      datasetId: setup.datasetId,
      seriesId: setup.seriesId,
      modelVersionId: setup.version2Id,
      provider: "akshare",
      companyName: "Alpha Holdings",
      companyTicker: "000001.SZ",
      idempotencyKey: "2026-07-30T09",
      raw: { request: { ticker: "000001.SZ" } },
    });
    const duplicate = repository.createMarketSnapshot({
      datasetId: setup.datasetId,
      seriesId: setup.seriesId,
      modelVersionId: setup.version2Id,
      provider: "akshare",
      companyName: "Alpha Holdings",
      companyTicker: "000001.SZ",
      idempotencyKey: "2026-07-30T09",
      raw: { request: { ticker: "000001.SZ" } },
    });
    expect(created.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(() =>
      repository.createMarketSnapshot({
        datasetId: setup.datasetId,
        seriesId: setup.seriesId,
        modelVersionId: setup.version2Id,
        provider: "akshare",
        companyName: "Alpha Holdings",
        companyTicker: "000001.SZ",
        idempotencyKey: "2026-07-30T09",
        raw: { request: { ticker: "DIFFERENT" } },
      }),
    ).toThrow(/idempotency key/u);
    repository.transitionMarketSnapshot(
      setup.datasetId,
      created.value.snapshotId,
      { status: "running" },
    );
    const completed = repository.transitionMarketSnapshot(
      setup.datasetId,
      created.value.snapshotId,
      {
        status: "completed",
        asOf: "2026-07-30T01:00:00.000Z",
        raw: {
          request: { ticker: "000001.SZ" },
          metrics: { forward_pe: 17.5 },
        },
      },
    );
    expect(completed.status).toBe("completed");
    expect(() =>
      repository.transitionMarketSnapshot(
        setup.datasetId,
        created.value.snapshotId,
        { status: "running" },
      ),
    ).toThrow(/cannot transition/u);

    repository.upsertMetricActualValue({
      snapshotId: created.value.snapshotId,
      datasetId: setup.datasetId,
      seriesId: setup.seriesId,
      modelVersionId: setup.version2Id,
      metricKey: "forward_pe",
      valueNumeric: 17.5,
      unit: "multiple",
      period: "2026E",
      status: "available",
      source: "consensus",
      observedAt: "2026-07-30T01:00:00.000Z",
      metadata: { providerSymbol: "000001.SZ" },
    });
    repository.upsertMetricComparison({
      datasetId: setup.datasetId,
      seriesId: setup.seriesId,
      modelVersionId: setup.version2Id,
      snapshotId: created.value.snapshotId,
      metricKey: "forward_pe",
      modelValue: 14.2,
      actualValue: 17.5,
      absoluteGap: 3.3,
      relativeGap: 3.3 / 14.2,
      severity: "warning",
      status: "compared",
      explanation: "Model multiple is below current consensus.",
      modelPeriod: "2026E",
      actualPeriod: "2026E",
      modelSource: "Alpha DCF!F42",
      actualSource: "consensus",
      evidenceIds: ["fact:alpha-forward-pe"],
    });
    expect(() =>
      repository.upsertManualMetricOverride({
        datasetId: setup.datasetId,
        seriesId: setup.seriesId,
        modelVersionId: setup.version2Id,
        metricKey: "forward_pe",
        valueNumeric: 15.1,
        unit: "multiple",
        period: "2026E",
        source: "Investment committee memo",
        evidenceIds: [
          "fact:alpha-forward-pe",
          "page:alpha-committee-memo-7",
        ],
        derivation: "Committee-approved normalized earnings.",
        reviewer: "reviewer@example.com",
      }),
    ).toThrow(/Unresolved manual evidence/u);
    database
      .prepare(
        `INSERT INTO workflow_store_evidence_references
           (owner_type, owner_id, evidence_id, relation_type, created_at)
         VALUES ('source-document', 'committee-memo', ?,
                 'contains', '2026-07-30T00:00:00.000Z')`,
      )
      .run("page:alpha-committee-memo-7");
    const override = repository.upsertManualMetricOverride({
      datasetId: setup.datasetId,
      seriesId: setup.seriesId,
      modelVersionId: setup.version2Id,
      metricKey: "forward_pe",
      valueNumeric: 15.1,
      unit: "multiple",
      period: "2026E",
      source: "Investment committee memo",
      evidenceIds: ["fact:alpha-forward-pe", "page:alpha-committee-memo-7"],
      derivation: "Committee-approved normalized earnings.",
      reviewer: "reviewer@example.com",
    });

    const bundle = repository.getLatestMetricBundle(
      setup.datasetId,
      setup.seriesId,
      setup.version2Id,
    );
    expect(bundle.snapshot?.raw).toMatchObject({
      metrics: { forward_pe: 17.5 },
    });
    expect(bundle.modelValues).toHaveLength(1);
    expect(bundle.actualValues).toHaveLength(1);
    expect(bundle.comparisons[0]?.evidenceIds).toEqual([
      "fact:alpha-forward-pe",
    ]);
    expect(override.evidenceIds).toEqual([
      "fact:alpha-forward-pe",
      "page:alpha-committee-memo-7",
    ]);
    expect(
      repository.setManualMetricOverrideActive(
        setup.datasetId,
        override.overrideId,
        false,
      ).active,
    ).toBe(false);

    database.exec("PRAGMA ignore_check_constraints=ON");
    database
      .prepare(
        `UPDATE valuation_market_snapshots
         SET raw_json = 'not-json' WHERE snapshot_id = ?`,
      )
      .run(created.value.snapshotId);
    expect(() =>
      repository.getMarketSnapshot(
        setup.datasetId,
        created.value.snapshotId,
      ),
    ).toThrow(/Stored JSON/u);
  });

  it("stores tenant-scoped immutable context, impact, price-bar and price-comparison sources", () => {
    const setup = fixture();
    const fingerprintA = "1".repeat(64);
    const fingerprintB = "2".repeat(64);
    const context = repository.saveContextCard({
      datasetId: setup.datasetId,
      seriesId: setup.seriesId,
      modelVersionId: setup.version2Id,
      sourceDocId: "doc:industry:v1",
      sourceFingerprint: fingerprintA,
      cardType: "industry",
      title: "Industry demand",
      summary: "Demand remains resilient.",
      insight: "The base-case volume assumption remains supportable.",
      sourceName: "Industry report",
      documentDate: "2026-07-01",
      evidenceIds: ["page:industry-v1-7"],
      provenance: { extractorVersion: "context-v2" },
    });
    expect(context.created).toBe(true);
    expect(
      repository.saveContextCard({
        datasetId: setup.datasetId,
        seriesId: setup.seriesId,
        modelVersionId: setup.version2Id,
        sourceDocId: "doc:industry:v1",
        sourceFingerprint: fingerprintA,
        cardType: "industry",
        title: "Industry demand",
        summary: "Demand remains resilient.",
        insight: "The base-case volume assumption remains supportable.",
        sourceName: "Industry report",
        documentDate: "2026-07-01",
        evidenceIds: ["page:industry-v1-7"],
        provenance: { extractorVersion: "context-v2" },
      }).created,
    ).toBe(false);
    expect(() =>
      repository.saveContextCard({
        datasetId: setup.datasetId,
        seriesId: setup.seriesId,
        modelVersionId: setup.version2Id,
        sourceDocId: "doc:industry:v1",
        sourceFingerprint: fingerprintA,
        cardType: "industry",
        title: "Mutated title",
        summary: "Demand remains resilient.",
        insight: "The base-case volume assumption remains supportable.",
        sourceName: "Industry report",
        evidenceIds: ["page:industry-v1-7"],
      }),
    ).toThrow(/immutable/u);
    expect(
      repository.listContextCards(setup.datasetId, {
        modelVersionId: setup.version2Id,
        limit: 1,
      }),
    ).toMatchObject({ total: 1, hasMore: false });
    expect(() =>
      repository.getContextCard("another-project", context.value.cardId),
    ).toThrow(/not found/u);

    const impact = repository.saveImpactCard({
      datasetId: setup.datasetId,
      seriesId: setup.seriesId,
      modelVersionId: setup.version2Id,
      sourceJobId: "job-valuation-compare-1",
      sourceFingerprint: fingerprintB,
      ordinal: 0,
      direction: "negative",
      horizon: "12m",
      confidence: 0.83,
      title: "Margin pressure",
      evidenceSummary: "Input-cost evidence points to near-term pressure.",
      valuationImpact: "Reduce the base-case margin assumption.",
      affectedInputs: [{ metricKey: "gross_margin" }],
      watchItems: ["quarterly margin"],
      sourceRefs: [{ evidenceId: "fact:margin-pressure" }],
      evidenceIds: ["fact:margin-pressure"],
      provenance: { jobType: "valuation.compare" },
    });
    expect(impact.value.sourceKind).toBe("control_job");
    expect(
      repository.listImpactCards(setup.datasetId, {
        sourceJobId: "job-valuation-compare-1",
      }).items,
    ).toHaveLength(1);

    const barInput = {
      datasetId: setup.datasetId,
      provider: "market-provider",
      providerSymbol: "000001.SZ",
      canonicalTicker: "000001.SZ",
      exchange: "SZ",
      currency: "CNY",
      tradeDate: "2026-07-30",
      open: 10,
      high: 12,
      low: 9,
      close: 11,
      volume: 1_000,
      amount: 11_000,
      source: "daily-bars",
      sourceFingerprint: "3".repeat(64),
      evidenceIds: ["fact:close-2026-07-30"],
      provenance: { providerRequestId: "request-1" },
    } as const;
    const bar = repository.saveMarketPriceBar(barInput);
    expect(repository.saveMarketPriceBar(barInput).created).toBe(false);
    expect(bar.value.close).toBe(11);
    expect(
      repository.listMarketPriceBars(setup.datasetId, "000001.SZ", {
        tradeDateFrom: "2026-01-01",
        tradeDateTo: "2026-12-31",
        limit: 1,
      }),
    ).toMatchObject({ total: 1, hasMore: false });
    expect(() =>
      repository.listMarketPriceBars(setup.datasetId, "000001.SZ", {
        tradeDateFrom: "2000-01-01",
        tradeDateTo: "2026-12-31",
      }),
    ).toThrow(/ten years/u);
    expect(() =>
      repository.saveMarketPriceBar({ ...barInput, close: 13 }),
    ).toThrow(/invariants|immutable/u);

    const snapshot = repository.createMarketSnapshot({
      datasetId: setup.datasetId,
      seriesId: setup.seriesId,
      modelVersionId: setup.version2Id,
      provider: "market-provider",
      idempotencyKey: "price-comparison-snapshot",
      raw: { ticker: "000001.SZ" },
    });
    const comparisonInput = {
      datasetId: setup.datasetId,
      seriesId: setup.seriesId,
      modelVersionId: setup.version2Id,
      snapshotId: snapshot.value.snapshotId,
      provider: "market-provider",
      providerSymbol: "000001.SZ",
      currency: "CNY",
      valuationDate: "2026-07-15",
      benchmarkTradeDate: "2026-07-15",
      benchmarkClose: 10,
      latestTradeDate: "2026-07-30",
      latestClose: 11,
      targetPrice: 14,
      targetUnit: "CNY/share",
      targetSource: "DCF output",
      targetEvidenceId: "cell:target-price",
      impliedUpside: 0.4,
      latestUpside: 3 / 11,
      status: "completed",
      metadata: { benchmarkPolicy: "on-or-before" },
      sourceFingerprint: "4".repeat(64),
      provenance: { jobId: "job-market-refresh-1" },
    } as const;
    const comparison = repository.savePriceComparison(comparisonInput);
    expect(repository.savePriceComparison(comparisonInput).created).toBe(false);
    expect(comparison.value.evidenceIds).toEqual(["cell:target-price"]);
    expect(
      repository.listPriceComparisons(setup.datasetId, {
        modelVersionId: setup.version2Id,
      }).items,
    ).toHaveLength(1);
    expect(
      database
        .prepare(
          `SELECT owner_type, evidence_id
           FROM workflow_store_evidence_references
           WHERE owner_id IN (?, ?, ?, ?)
           ORDER BY owner_type`,
        )
        .all(
          context.value.cardId,
          impact.value.cardId,
          bar.value.barId,
          comparison.value.priceComparisonId,
        ),
    ).toEqual([
      {
        owner_type: "valuation-context-card",
        evidence_id: "page:industry-v1-7",
      },
      {
        owner_type: "valuation-impact-card",
        evidence_id: "fact:margin-pressure",
      },
      {
        owner_type: "valuation-market-price-bar",
        evidence_id: "fact:close-2026-07-30",
      },
      {
        owner_type: "valuation-price-comparison",
        evidence_id: "cell:target-price",
      },
    ]);
  });

  it("deduplicates change alerts and enforces alert lifecycle", () => {
    const setup = fixture();
    expect(() =>
      repository.createAlert({
        datasetId: setup.datasetId,
        seriesId: setup.seriesId,
        changeId: "missing-change",
        alertType: "formula_changed",
        priority: "high",
        title: "Invalid orphan",
        summary: "This alert has no underlying model change.",
        dedupeKey: "missing-change-alert",
      }),
    ).toThrow(/model change was not found/u);
    const rule = repository.upsertWatchRule({
      datasetId: setup.datasetId,
      seriesId: setup.seriesId,
      name: "Material formula changes",
      minMateriality: "medium",
      changeTypes: ["formula_changed"],
      idempotencyKey: "material-formula-change",
    });
    const input = {
      datasetId: setup.datasetId,
      seriesId: setup.seriesId,
      fromModelVersionId: setup.version1Id,
      toModelVersionId: setup.version2Id,
      nodeId: setup.nodeId,
      changeType: "formula_changed",
      materiality: "high" as const,
      summary: "WACC calculation changed.",
      oldValue: { formula: "=B8+B9" },
      newValue: { formula: "=B8+B9+B10" },
      evidenceIds: [
        "cell:alpha-v1-dcf-b12",
        "cell:alpha-v2-dcf-b12",
      ],
    };
    expect(repository.recordChange(input).created).toBe(true);
    expect(repository.recordChange(input).created).toBe(false);
    expect(repository.countChangesByMateriality(setup.datasetId)).toEqual({
      high: 1,
    });
    expect(repository.countChangesByMateriality("other-dataset")).toEqual({});
    const comparison = repository.compareModelVersions(
      setup.datasetId,
      setup.seriesId,
      setup.version1Id,
      setup.version2Id,
    );
    expect(comparison.fromVersion.modelVersionId).toBe(setup.version1Id);
    expect(comparison.toVersion.modelVersionId).toBe(setup.version2Id);
    expect(comparison.changes).toHaveLength(1);
    expect(comparison.changes[0]).toMatchObject({
      nodeId: setup.nodeId,
      changeType: "formula_changed",
      materiality: "high",
    });

    const alerts = repository.listAlerts(setup.datasetId);
    expect(alerts.total).toBe(1);
    expect(alerts.items[0]).toMatchObject({
      ruleId: rule.ruleId,
      alertType: "formula_changed",
      priority: "high",
      status: "new",
    });
    expect(alerts.items[0]?.evidenceIds).toEqual([
      "cell:alpha-v1-dcf-b12",
      "cell:alpha-v2-dcf-b12",
    ]);

    const future = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    const snoozed = repository.updateAlertStatus(
      setup.datasetId,
      alerts.items[0]!.alertId,
      "snoozed",
      future.toISOString(),
    );
    expect(snoozed.status).toBe("snoozed");
    expect(
      repository.releaseExpiredSnoozes(
        setup.datasetId,
        new Date(future.getTime() + 1_000),
      ),
    ).toBe(1);
    const reopened = repository.listAlerts(setup.datasetId, {
      status: "new",
    });
    expect(reopened.total).toBe(1);
    expect(
      repository.updateAlertStatus(
        setup.datasetId,
        reopened.items[0]!.alertId,
        "acknowledged",
      ).status,
    ).toBe("acknowledged");
  });

  it("runs auditable agent-analysis and derived-model state machines", () => {
    const setup = fixture();
    const created = repository.createAgentAnalysis({
      datasetId: setup.datasetId,
      seriesId: setup.seriesId,
      baseModelVersionId: setup.version2Id,
      comparisonModelVersionId: setup.version1Id,
      focus: "Review valuation assumptions",
      agentVersion: "valuation-agent-v2",
    });
    expect(created.created).toBe(true);
    expect(
      repository.createAgentAnalysis({
        datasetId: setup.datasetId,
        seriesId: setup.seriesId,
        baseModelVersionId: setup.version2Id,
        comparisonModelVersionId: setup.version1Id,
        focus: "Review valuation assumptions",
        agentVersion: "valuation-agent-v2",
      }).created,
    ).toBe(false);
    repository.transitionAgentAnalysis(
      setup.datasetId,
      created.value.analysisId,
      {
        status: "running",
        planner: {
          selectedEvidenceIds: ["fact:alpha-forward-pe"],
          dimensions: ["assumptions"],
        },
      },
    );
    const completed = repository.transitionAgentAnalysis(
      setup.datasetId,
      created.value.analysisId,
      {
        status: "completed",
        valuationMethod: "DCF",
        executiveSummary: "The discount rate remains the key sensitivity.",
        investmentConclusion: "Retain the base case pending revenue validation.",
        analysis: {
          keyFindings: [
            {
              claim: "WACC drives most of the target-price range.",
              evidenceIds: ["cell:alpha-v2-dcf-b12"],
            },
          ],
        },
        evidenceIds: [
          "cell:alpha-v2-dcf-b12",
          "fact:alpha-forward-pe",
        ],
        modelName: "test-valuation-agent",
      },
    );
    expect(completed.status).toBe("completed");
    expect(completed.evidenceIds).toEqual([
      "cell:alpha-v2-dcf-b12",
      "fact:alpha-forward-pe",
    ]);
    expect(() =>
      repository.transitionAgentAnalysis(
        setup.datasetId,
        created.value.analysisId,
        { status: "running" },
      ),
    ).toThrow(/cannot transition/u);
    expect(() =>
      repository.transitionAgentAnalysis(
        setup.datasetId,
        created.value.analysisId,
        {
          status: "completed",
          analysis: { overwritten: true },
        },
      ),
    ).toThrow(/cannot be overwritten/u);

    const derived = repository.saveDerivedModel({
      datasetId: setup.datasetId,
      seriesId: setup.seriesId,
      analysisId: created.value.analysisId,
      baseModelVersionId: setup.version2Id,
      derivedVersionNo: 3,
      outputFilename: "alpha-dcf-agent-v3.xlsx",
      outputPath: "/project/resources/alpha-dcf-agent-v3.xlsx",
      checksum: "e".repeat(64),
      appliedChanges: [
        {
          nodeId: setup.nodeId,
          oldValue: 0.085,
          newValue: 0.0825,
          evidenceIds: ["cell:alpha-v2-dcf-b12"],
        },
      ],
      skippedChanges: [],
    });
    expect(derived.created).toBe(true);
    expect(
      repository.saveDerivedModel({
        datasetId: setup.datasetId,
        seriesId: setup.seriesId,
        analysisId: created.value.analysisId,
        baseModelVersionId: setup.version2Id,
        derivedVersionNo: 3,
        outputFilename: "alpha-dcf-agent-v3.xlsx",
        outputPath: "/project/resources/alpha-dcf-agent-v3.xlsx",
        checksum: "e".repeat(64),
        appliedChanges: [
          {
            nodeId: setup.nodeId,
            oldValue: 0.085,
            newValue: 0.0825,
            evidenceIds: ["cell:alpha-v2-dcf-b12"],
          },
        ],
        skippedChanges: [],
      }).created,
    ).toBe(false);

    repository.transitionDerivedResource(
      setup.datasetId,
      derived.value.derivedModelId,
      {
        status: "queued",
        fileName: "alpha-dcf-agent-v3.xlsx",
        pipelineJobId: "pipeline:derived:v3",
      },
    );
    repository.transitionDerivedResource(
      setup.datasetId,
      derived.value.derivedModelId,
      { status: "running" },
    );
    const imported = repository.transitionDerivedResource(
      setup.datasetId,
      derived.value.derivedModelId,
      {
        status: "completed",
        documentId: "doc:derived:v3",
      },
    );
    expect(imported).toMatchObject({
      resourceStatus: "completed",
      resourceDocId: "doc:derived:v3",
      resourcePipelineJobId: "pipeline:derived:v3",
    });
    expect(() =>
      repository.transitionDerivedResource(
        setup.datasetId,
        derived.value.derivedModelId,
        {
          status: "queued",
          fileName: "alpha-dcf-agent-v3.xlsx",
          pipelineJobId: "pipeline:derived:v3",
        },
      ),
    ).toThrow(/cannot transition/u);
  });

  it("adopts legacy valuation rows and repairs invalid legacy JSON", () => {
    database.close();
    database = new DatabaseSync(":memory:");
    database.exec(`
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
      INSERT INTO valuation_watch_rules(
        rule_id, dataset_id, series_id, name, min_materiality,
        change_types_json, active, created_at, updated_at
      ) VALUES (
        'legacy-rule', 'legacy-project', NULL, 'Legacy material changes',
        'medium', 'not-json', 1,
        '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'
      );
    `);

    const migration = runWorkflowStoreMigrations(database);
    repository = new ValuationRepository(database);

    expect(migration.adoptedLegacyTables).toContain("valuation_watch_rules");
    expect(repository.listWatchRules("legacy-project").items).toEqual([
      expect.objectContaining({
        ruleId: "legacy-rule",
        name: "Legacy material changes",
        changeTypes: [],
        active: true,
      }),
    ]);
  });
});
