import type { DatabaseSync } from "node:sqlite";

import {
  WorkflowStoreError,
  assertOneOf,
  boolInt,
  decodeJsonArray,
  decodeJsonObject,
  encodeJson,
  getRequiredRow,
  isEvidenceId,
  normalizeEvidenceIds,
  nowIso,
  pageOptions,
  pageResult,
  recordEvidenceReferences,
  replaceEvidenceReferences,
  requireText,
  stableId,
  toRecord,
  withTransaction,
} from "./shared.js";
import type {
  JsonValue,
  Page,
  PageOptions,
  SqlRow,
} from "./shared.js";

const SERIES_STATUSES = ["active", "archived"] as const;
const NODE_KINDS = [
  "assumption",
  "forecast",
  "output",
  "sensitivity",
  "other",
] as const;
const MATERIALITIES = ["low", "medium", "high", "critical"] as const;
const ALERT_STATUSES = [
  "new",
  "acknowledged",
  "dismissed",
  "snoozed",
] as const;
const SNAPSHOT_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "unavailable",
] as const;
const ANALYSIS_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
] as const;
const RESOURCE_STATUSES = [
  "not_added",
  "queued",
  "running",
  "completed",
  "failed",
] as const;
const MANUAL_QUALITY_STATUSES = [
  "manual_verified",
  "manual_verified_with_caveat",
] as const;
const IMPACT_DIRECTIONS = [
  "positive",
  "negative",
  "mixed",
  "neutral",
  "uncertain",
] as const;

export const VALUATION_METRIC_DEFINITIONS = {
  quarter_net_profit_yoy: {
    unit: "percent",
    minimumEvidence: 2,
  },
  quarter_gross_margin_qoq_delta: {
    unit: "percentage_point",
    minimumEvidence: 2,
  },
  forward_pe: {
    unit: "multiple",
    minimumEvidence: 1,
  },
  avg_turnover_amount_20d: {
    unit: "currency",
    minimumEvidence: 1,
  },
  quarter_revenue_growth_qoq: {
    unit: "percentage_point",
    minimumEvidence: 4,
  },
} as const;

export type ValuationMetricKey = keyof typeof VALUATION_METRIC_DEFINITIONS;

export type ValuationSeriesStatus = (typeof SERIES_STATUSES)[number];
export type ValuationNodeKind = (typeof NODE_KINDS)[number];
export type ValuationMateriality = (typeof MATERIALITIES)[number];
export type ValuationAlertStatus = (typeof ALERT_STATUSES)[number];
export type ValuationSnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];
export type ValuationAnalysisStatus = (typeof ANALYSIS_STATUSES)[number];
export type ValuationResourceStatus = (typeof RESOURCE_STATUSES)[number];
export type ManualMetricQualityStatus =
  (typeof MANUAL_QUALITY_STATUSES)[number];

export interface ValuationModelSeries {
  readonly seriesId: string;
  readonly datasetId: string;
  readonly seriesKey: string;
  readonly name: string;
  readonly companyName: string | null;
  readonly companyTicker: string | null;
  readonly modelType: string | null;
  readonly currentModelVersionId: string | null;
  readonly currentVersionNo: number;
  readonly status: ValuationSeriesStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpsertValuationSeriesInput {
  readonly seriesId?: string;
  readonly datasetId: string;
  readonly seriesKey: string;
  readonly name: string;
  readonly companyName?: string | null;
  readonly companyTicker?: string | null;
  readonly modelType?: string | null;
  readonly status?: ValuationSeriesStatus;
}

export interface ValuationModelVersion {
  readonly modelVersionId: string;
  readonly seriesId: string;
  readonly datasetId: string;
  readonly docId: string;
  readonly logicalDocId: string | null;
  readonly documentVersionNo: number;
  readonly parentModelVersionId: string | null;
  readonly revertedToVersionId: string | null;
  readonly checksum: string;
  readonly snapshotHash: string;
  readonly originalFilename: string;
  readonly documentDate: string | null;
  readonly modelType: string | null;
  readonly nodeCount: number;
  readonly formulaNodeCount: number;
  readonly reviewRequiredCount: number;
  readonly analyzerVersion: string;
  readonly createdAt: string;
}

export interface ValuationModelOverview {
  readonly overviewId: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly modelVersionId: string;
  readonly docId: string;
  readonly status: string;
  readonly overview: Record<string, JsonValue>;
  readonly html: string;
  readonly overviewVersion: string;
  readonly createdAt: string;
}

export interface SaveValuationModelVersionInput {
  readonly modelVersionId?: string;
  readonly idempotencyKey?: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly docId: string;
  readonly logicalDocId?: string | null;
  readonly documentVersionNo: number;
  readonly parentModelVersionId?: string | null;
  readonly revertedToVersionId?: string | null;
  readonly checksum: string;
  readonly snapshotHash: string;
  readonly originalFilename: string;
  readonly documentDate?: string | null;
  readonly modelType?: string | null;
  readonly nodeCount?: number;
  readonly formulaNodeCount?: number;
  readonly reviewRequiredCount?: number;
  readonly analyzerVersion: string;
}

export interface SaveResult<T> {
  readonly value: T;
  readonly created: boolean;
}

export interface ValuationAnalysisVersion {
  readonly analysisVersionId: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly modelVersionId: string;
  readonly previousAnalysisVersionId: string | null;
  readonly status: string;
  readonly summaryMarkdown: string;
  readonly analysis: Record<string, JsonValue>;
  readonly analyzerVersion: string;
  readonly createdAt: string;
}

export interface SaveValuationAnalysisVersionInput {
  readonly analysisVersionId?: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly modelVersionId: string;
  readonly previousAnalysisVersionId?: string | null;
  readonly status?: string;
  readonly summaryMarkdown: string;
  readonly analysis?: Readonly<Record<string, unknown>>;
  readonly analyzerVersion: string;
}

export interface ValuationModelNode {
  readonly nodeId: string;
  readonly seriesId: string;
  readonly canonicalKey: string;
  readonly nodeKind: ValuationNodeKind;
  readonly metricKey: string;
  readonly displayName: string;
  readonly scope: string;
  readonly period: string | null;
  readonly scenario: string | null;
  readonly firstSeenAt: string;
  readonly updatedAt: string;
}

export interface UpsertValuationNodeInput {
  readonly nodeId?: string;
  readonly seriesId: string;
  readonly canonicalKey: string;
  readonly nodeKind: ValuationNodeKind;
  readonly metricKey: string;
  readonly displayName: string;
  readonly scope: string;
  readonly period?: string | null;
  readonly scenario?: string | null;
}

export interface ValuationNodeValue {
  readonly nodeValueId: string;
  readonly modelVersionId: string;
  readonly nodeId: string;
  readonly valueNumeric: number | null;
  readonly valueText: string | null;
  readonly unit: string | null;
  readonly formula: string | null;
  readonly formulaFingerprint: string | null;
  readonly sheetName: string;
  readonly cellRef: string;
  readonly evidenceId: string;
  readonly qualityStatus: string;
  readonly confidence: number;
  readonly metadata: Record<string, JsonValue>;
  readonly createdAt: string;
}

export interface SaveValuationNodeValueInput {
  readonly nodeValueId?: string;
  readonly modelVersionId: string;
  readonly nodeId: string;
  readonly valueNumeric?: number | null;
  readonly valueText?: string | null;
  readonly unit?: string | null;
  readonly formula?: string | null;
  readonly formulaFingerprint?: string | null;
  readonly sheetName: string;
  readonly cellRef: string;
  readonly evidenceId: string;
  readonly qualityStatus: string;
  readonly confidence?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ValuationModelChange {
  readonly changeId: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly fromModelVersionId: string;
  readonly toModelVersionId: string;
  readonly nodeId: string;
  readonly changeType: string;
  readonly materiality: ValuationMateriality;
  readonly summary: string;
  readonly oldValue: Record<string, JsonValue>;
  readonly newValue: Record<string, JsonValue>;
  readonly absoluteChange: number | null;
  readonly relativeChange: number | null;
  readonly evidenceIds: string[];
  readonly createdAt: string;
}

export interface RecordValuationChangeInput {
  readonly changeId?: string;
  readonly idempotencyKey?: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly fromModelVersionId: string;
  readonly toModelVersionId: string;
  readonly nodeId: string;
  readonly changeType: string;
  readonly materiality: ValuationMateriality;
  readonly summary: string;
  readonly oldValue?: Readonly<Record<string, unknown>>;
  readonly newValue?: Readonly<Record<string, unknown>>;
  readonly absoluteChange?: number | null;
  readonly relativeChange?: number | null;
  readonly evidenceIds?: readonly string[];
  readonly alertTitle?: string;
}

export interface ValuationVersionComparison {
  readonly series: ValuationModelSeries;
  readonly fromVersion: ValuationModelVersion;
  readonly toVersion: ValuationModelVersion;
  readonly changes: readonly ValuationModelChange[];
  readonly fromValues: readonly ValuationNodeValue[];
  readonly toValues: readonly ValuationNodeValue[];
}

export interface ValuationMetricModelValue {
  readonly modelMetricId: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly modelVersionId: string;
  readonly metricKey: string;
  readonly valueNumeric: number | null;
  readonly unit: string;
  readonly period: string | null;
  readonly status: string;
  readonly method: string;
  readonly source: string | null;
  readonly evidenceIds: string[];
  readonly qualityStatus: string;
  readonly createdAt: string;
}

export interface UpsertMetricModelValueInput {
  readonly modelMetricId?: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly modelVersionId: string;
  readonly metricKey: string;
  readonly valueNumeric?: number | null;
  readonly unit: string;
  readonly period?: string | null;
  readonly status: string;
  readonly method: string;
  readonly source?: string | null;
  readonly evidenceIds?: readonly string[];
  readonly qualityStatus?: string;
}

export interface ValuationMarketSnapshot {
  readonly snapshotId: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly modelVersionId: string;
  readonly companyName: string | null;
  readonly companyTicker: string | null;
  readonly provider: string;
  readonly status: ValuationSnapshotStatus;
  readonly asOf: string | null;
  readonly errorMessage: string | null;
  readonly raw: Record<string, JsonValue>;
  readonly createdAt: string;
}

export interface CreateMarketSnapshotInput {
  readonly snapshotId?: string;
  readonly idempotencyKey?: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly modelVersionId: string;
  readonly companyName?: string | null;
  readonly companyTicker?: string | null;
  readonly provider: string;
  readonly status?: ValuationSnapshotStatus;
  readonly asOf?: string | null;
  readonly errorMessage?: string | null;
  readonly raw?: Readonly<Record<string, unknown>>;
}

export interface TransitionMarketSnapshotInput {
  readonly status: ValuationSnapshotStatus;
  readonly asOf?: string | null;
  readonly errorMessage?: string | null;
  readonly raw?: Readonly<Record<string, unknown>>;
}

export interface ValuationMetricActualValue {
  readonly actualMetricId: string;
  readonly snapshotId: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly modelVersionId: string;
  readonly metricKey: string;
  readonly valueNumeric: number | null;
  readonly unit: string;
  readonly period: string | null;
  readonly status: string;
  readonly source: string | null;
  readonly observedAt: string | null;
  readonly metadata: Record<string, JsonValue>;
  readonly createdAt: string;
}

export interface UpsertMetricActualValueInput {
  readonly actualMetricId?: string;
  readonly snapshotId: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly modelVersionId: string;
  readonly metricKey: string;
  readonly valueNumeric?: number | null;
  readonly unit: string;
  readonly period?: string | null;
  readonly status: string;
  readonly source?: string | null;
  readonly observedAt?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ValuationMetricComparison {
  readonly comparisonId: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly modelVersionId: string;
  readonly snapshotId: string;
  readonly metricKey: string;
  readonly modelValue: number | null;
  readonly actualValue: number | null;
  readonly absoluteGap: number | null;
  readonly relativeGap: number | null;
  readonly severity: string;
  readonly status: string;
  readonly explanation: string;
  readonly modelPeriod: string | null;
  readonly actualPeriod: string | null;
  readonly modelSource: string | null;
  readonly actualSource: string | null;
  readonly evidenceIds: string[];
  readonly createdAt: string;
}

export interface UpsertMetricComparisonInput {
  readonly comparisonId?: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly modelVersionId: string;
  readonly snapshotId: string;
  readonly metricKey: string;
  readonly modelValue?: number | null;
  readonly actualValue?: number | null;
  readonly absoluteGap?: number | null;
  readonly relativeGap?: number | null;
  readonly severity: string;
  readonly status: string;
  readonly explanation: string;
  readonly modelPeriod?: string | null;
  readonly actualPeriod?: string | null;
  readonly modelSource?: string | null;
  readonly actualSource?: string | null;
  readonly evidenceIds?: readonly string[];
}

export interface ValuationContextCard {
  readonly cardId: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly modelVersionId: string;
  readonly sourceDocId: string;
  readonly sourceFingerprint: string;
  readonly cardType: string;
  readonly title: string;
  readonly summary: string;
  readonly insight: string;
  readonly sourceName: string;
  readonly documentDate: string | null;
  readonly evidenceIds: string[];
  readonly provenance: Record<string, JsonValue>;
  readonly createdAt: string;
}

export interface SaveValuationContextCardInput {
  readonly cardId?: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly modelVersionId: string;
  readonly sourceDocId: string;
  readonly sourceFingerprint: string;
  readonly cardType: string;
  readonly title: string;
  readonly summary: string;
  readonly insight: string;
  readonly sourceName: string;
  readonly documentDate?: string | null;
  readonly evidenceIds?: readonly string[];
  readonly provenance?: Readonly<Record<string, unknown>>;
}

export interface ListValuationContextCardOptions extends PageOptions {
  readonly seriesId?: string;
  readonly modelVersionId?: string;
  readonly sourceDocId?: string;
}

export interface ValuationImpactCard {
  readonly cardId: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly modelVersionId: string;
  readonly sourceKind: "control_job";
  readonly sourceJobId: string;
  readonly sourceFingerprint: string;
  readonly ordinal: number;
  readonly direction:
    | "positive"
    | "negative"
    | "mixed"
    | "neutral"
    | "uncertain";
  readonly horizon: string;
  readonly confidence: number;
  readonly title: string;
  readonly evidenceSummary: string;
  readonly valuationImpact: string;
  readonly affectedInputs: JsonValue[];
  readonly watchItems: JsonValue[];
  readonly sourceRefs: JsonValue[];
  readonly evidenceIds: string[];
  readonly provenance: Record<string, JsonValue>;
  readonly createdAt: string;
}

export interface SaveValuationImpactCardInput {
  readonly cardId?: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly modelVersionId: string;
  /** A real control-plane job ID. Legacy Python run IDs are quarantined. */
  readonly sourceJobId: string;
  readonly sourceFingerprint: string;
  readonly ordinal: number;
  readonly direction: ValuationImpactCard["direction"];
  readonly horizon: string;
  readonly confidence: number;
  readonly title: string;
  readonly evidenceSummary: string;
  readonly valuationImpact: string;
  readonly affectedInputs?: readonly unknown[];
  readonly watchItems?: readonly unknown[];
  readonly sourceRefs?: readonly unknown[];
  readonly evidenceIds?: readonly string[];
  readonly provenance?: Readonly<Record<string, unknown>>;
}

export interface ListValuationImpactCardOptions extends PageOptions {
  readonly seriesId?: string;
  readonly modelVersionId?: string;
  readonly sourceJobId?: string;
}

export interface ValuationMarketPriceBar {
  readonly barId: string;
  readonly datasetId: string;
  readonly provider: string;
  readonly providerSymbol: string;
  readonly canonicalTicker: string;
  readonly exchange: string;
  readonly currency: string;
  readonly tradeDate: string;
  readonly open: number | null;
  readonly high: number | null;
  readonly low: number | null;
  readonly close: number;
  readonly volume: number | null;
  readonly amount: number | null;
  readonly adjustment: string;
  readonly source: string | null;
  readonly sourceFingerprint: string;
  readonly evidenceIds: string[];
  readonly provenance: Record<string, JsonValue>;
  readonly fetchedAt: string;
}

export interface SaveValuationMarketPriceBarInput {
  readonly barId?: string;
  readonly datasetId: string;
  readonly provider: string;
  readonly providerSymbol: string;
  readonly canonicalTicker: string;
  readonly exchange: string;
  readonly currency: string;
  readonly tradeDate: string;
  readonly open?: number | null;
  readonly high?: number | null;
  readonly low?: number | null;
  readonly close: number;
  readonly volume?: number | null;
  readonly amount?: number | null;
  readonly adjustment?: string;
  readonly source?: string | null;
  readonly sourceFingerprint: string;
  readonly evidenceIds?: readonly string[];
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly fetchedAt?: string;
}

export interface ListValuationMarketPriceBarOptions extends PageOptions {
  readonly tradeDateFrom: string;
  readonly tradeDateTo: string;
  readonly provider?: string;
  readonly adjustment?: string;
}

export interface ValuationPriceComparison {
  readonly priceComparisonId: string;
  readonly snapshotId: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly modelVersionId: string;
  readonly provider: string;
  readonly providerSymbol: string | null;
  readonly currency: string | null;
  readonly valuationDate: string | null;
  readonly benchmarkTradeDate: string | null;
  readonly benchmarkClose: number | null;
  readonly latestTradeDate: string | null;
  readonly latestClose: number | null;
  readonly targetPrice: number | null;
  readonly targetUnit: string | null;
  readonly targetSource: string | null;
  readonly targetEvidenceId: string | null;
  readonly impliedUpside: number | null;
  readonly latestUpside: number | null;
  readonly status: string;
  readonly errorMessage: string | null;
  readonly metadata: Record<string, JsonValue>;
  readonly evidenceIds: string[];
  readonly sourceFingerprint: string;
  readonly provenance: Record<string, JsonValue>;
  readonly createdAt: string;
}

export interface SaveValuationPriceComparisonInput {
  readonly priceComparisonId?: string;
  readonly snapshotId: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly modelVersionId: string;
  readonly provider: string;
  readonly providerSymbol?: string | null;
  readonly currency?: string | null;
  readonly valuationDate?: string | null;
  readonly benchmarkTradeDate?: string | null;
  readonly benchmarkClose?: number | null;
  readonly latestTradeDate?: string | null;
  readonly latestClose?: number | null;
  readonly targetPrice?: number | null;
  readonly targetUnit?: string | null;
  readonly targetSource?: string | null;
  readonly targetEvidenceId?: string | null;
  readonly impliedUpside?: number | null;
  readonly latestUpside?: number | null;
  readonly status: string;
  readonly errorMessage?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly evidenceIds?: readonly string[];
  readonly sourceFingerprint: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
}

export interface ListValuationPriceComparisonOptions extends PageOptions {
  readonly seriesId?: string;
  readonly modelVersionId?: string;
  readonly snapshotId?: string;
}

export interface ValuationMetricManualOverride {
  readonly overrideId: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly modelVersionId: string;
  readonly metricKey: string;
  readonly valueNumeric: number;
  readonly unit: string;
  readonly period: string;
  readonly method: string;
  readonly source: string;
  readonly evidenceIds: string[];
  readonly derivation: string;
  readonly qualityStatus: ManualMetricQualityStatus;
  readonly reviewer: string;
  readonly reviewNote: string;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpsertManualMetricOverrideInput {
  readonly overrideId?: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly modelVersionId: string;
  readonly metricKey: string;
  readonly valueNumeric: number;
  readonly unit: string;
  readonly period: string;
  readonly method?: string;
  readonly source: string;
  readonly evidenceIds: readonly string[];
  readonly derivation: string;
  readonly qualityStatus?: ManualMetricQualityStatus;
  readonly reviewer: string;
  readonly reviewNote?: string;
}

export interface ValuationAgentAnalysis {
  readonly analysisId: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly baseModelVersionId: string;
  readonly comparisonModelVersionId: string | null;
  readonly status: ValuationAnalysisStatus;
  readonly focus: string;
  readonly valuationMethod: string | null;
  readonly executiveSummary: string | null;
  readonly investmentConclusion: string | null;
  readonly analysis: Record<string, JsonValue>;
  readonly planner: Record<string, JsonValue>;
  readonly evidenceIds: string[];
  readonly rawResponse: string | null;
  readonly modelName: string | null;
  readonly agentVersion: string;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface CreateAgentAnalysisInput {
  readonly analysisId?: string;
  readonly idempotencyKey?: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly baseModelVersionId: string;
  readonly comparisonModelVersionId?: string | null;
  readonly focus?: string;
  readonly agentVersion: string;
}

export interface TransitionAgentAnalysisInput {
  readonly status: ValuationAnalysisStatus;
  readonly valuationMethod?: string | null;
  readonly executiveSummary?: string | null;
  readonly investmentConclusion?: string | null;
  readonly analysis?: Readonly<Record<string, unknown>>;
  readonly planner?: Readonly<Record<string, unknown>>;
  readonly evidenceIds?: readonly string[];
  readonly rawResponse?: string | null;
  readonly modelName?: string | null;
  readonly errorMessage?: string | null;
}

export interface ValuationDerivedModel {
  readonly derivedModelId: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly analysisId: string;
  readonly baseModelVersionId: string;
  readonly derivedVersionNo: number;
  readonly outputFilename: string;
  readonly outputPath: string;
  readonly checksum: string;
  readonly appliedChanges: JsonValue[];
  readonly skippedChanges: JsonValue[];
  readonly resourceFileName: string | null;
  readonly resourcePipelineJobId: string | null;
  readonly resourceStatus: ValuationResourceStatus;
  readonly resourceDocId: string | null;
  readonly resourceAddedAt: string | null;
  readonly resourceError: string | null;
  readonly createdAt: string;
}

export interface SaveDerivedModelInput {
  readonly derivedModelId?: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly analysisId: string;
  readonly baseModelVersionId: string;
  readonly derivedVersionNo: number;
  readonly outputFilename: string;
  readonly outputPath: string;
  readonly checksum: string;
  readonly appliedChanges?: readonly unknown[];
  readonly skippedChanges?: readonly unknown[];
}

export interface TransitionDerivedResourceInput {
  readonly status: ValuationResourceStatus;
  readonly fileName?: string | null;
  readonly pipelineJobId?: string | null;
  readonly documentId?: string | null;
  readonly errorMessage?: string | null;
}

export interface ValuationWatchRule {
  readonly ruleId: string;
  readonly datasetId: string;
  readonly seriesId: string | null;
  readonly name: string;
  readonly minMateriality: ValuationMateriality;
  readonly changeTypes: string[];
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpsertValuationWatchRuleInput {
  readonly ruleId?: string;
  readonly idempotencyKey?: string;
  readonly datasetId: string;
  readonly seriesId?: string | null;
  readonly name: string;
  readonly minMateriality?: ValuationMateriality;
  readonly changeTypes?: readonly string[];
  readonly active?: boolean;
}

export interface UpdateWatchRuleInput {
  readonly name?: string;
  readonly minMateriality?: ValuationMateriality;
  readonly changeTypes?: readonly string[];
  readonly active?: boolean;
}

export interface ValuationAlert {
  readonly alertId: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly ruleId: string | null;
  readonly changeId: string;
  readonly alertType: string;
  readonly priority: string;
  readonly title: string;
  readonly summary: string;
  readonly evidenceIds: string[];
  readonly status: ValuationAlertStatus;
  readonly snoozedUntil: string | null;
  readonly dedupeKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateValuationAlertInput {
  readonly alertId?: string;
  readonly datasetId: string;
  readonly seriesId: string;
  readonly ruleId?: string | null;
  readonly changeId: string;
  readonly alertType: string;
  readonly priority: string;
  readonly title: string;
  readonly summary: string;
  readonly evidenceIds?: readonly string[];
  readonly dedupeKey: string;
}

export interface ListAlertOptions extends PageOptions {
  readonly status?: ValuationAlertStatus;
  readonly seriesId?: string;
  readonly alertType?: string;
}

export interface LatestValuationMetricBundle {
  readonly snapshot: ValuationMarketSnapshot | null;
  readonly modelValues: ValuationMetricModelValue[];
  readonly actualValues: ValuationMetricActualValue[];
  readonly comparisons: ValuationMetricComparison[];
  readonly manualOverrides: ValuationMetricManualOverride[];
}

function requiredString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkflowStoreError(
      `Stored ${key} is not non-empty text`,
      "corrupt_json",
    );
  }
  return value;
}

function stringValue(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new WorkflowStoreError(`Stored ${key} is not text`, "corrupt_json");
  }
  return value;
}

function nullableString(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new WorkflowStoreError(`Stored ${key} is not text`, "corrupt_json");
  }
  return value;
}

function numberValue(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WorkflowStoreError(`Stored ${key} is not numeric`, "corrupt_json");
  }
  return value;
}

function nullableNumber(row: SqlRow, key: string): number | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WorkflowStoreError(`Stored ${key} is not numeric`, "corrupt_json");
  }
  return value;
}

function booleanValue(row: SqlRow, key: string): boolean {
  const value = numberValue(row, key);
  if (value !== 0 && value !== 1) {
    throw new WorkflowStoreError(`Stored ${key} is not boolean`, "corrupt_json");
  }
  return value === 1;
}

function finiteOrNull(value: number | null | undefined, field: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isFinite(value)) {
    throw new WorkflowStoreError(`${field} must be finite`, "invalid_argument");
  }
  return value;
}

function nonNegativeInteger(
  value: number | undefined,
  field: string,
  fallback = 0,
): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new WorkflowStoreError(
      `${field} must be a non-negative integer`,
      "invalid_argument",
    );
  }
  return normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WorkflowStoreError(
      `${field} must be a positive integer`,
      "invalid_argument",
    );
  }
  return value;
}

function confidenceValue(value: number | undefined): number {
  const normalized = value ?? 0.5;
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
    throw new WorkflowStoreError(
      "confidence must be between 0 and 1",
      "invalid_argument",
    );
  }
  return normalized;
}

function optionalInputText(
  value: string | null | undefined,
  field: string,
  maxLength = 8_000,
): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return requireText(value, field, maxLength);
}

function decodeStringArray(value: unknown, field: string): string[] {
  return decodeJsonArray(value).map((item) => {
    if (typeof item !== "string" || item.length === 0) {
      throw new WorkflowStoreError(
        `Stored ${field} contains a non-text value`,
        "corrupt_json",
      );
    }
    return item;
  });
}

function normalizeStringList(
  values: readonly string[] | undefined,
  field: string,
  maxItems = 100,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const normalized = requireText(value, field, 120);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
    if (result.length > maxItems) {
      throw new WorkflowStoreError(
        `${field} exceeds ${String(maxItems)} items`,
        "invalid_argument",
      );
    }
  }
  return result;
}

function assertIsoDate(value: string, field: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new WorkflowStoreError(`${field} must be an ISO date`, "invalid_argument");
  }
  return new Date(time).toISOString();
}

function assertSameScope(
  row: SqlRow,
  datasetId: string,
  seriesId: string,
  entity: string,
): void {
  if (
    requiredString(row, "dataset_id") !== datasetId ||
    requiredString(row, "series_id") !== seriesId
  ) {
    throw new WorkflowStoreError(
      `${entity} does not belong to the requested dataset and series`,
      "conflict",
    );
  }
}

function collectNestedEvidenceIds(value: JsonValue): string[] {
  const evidenceIds = new Set<string>();
  const visit = (candidate: JsonValue): void => {
    if (typeof candidate === "string") {
      if (isEvidenceId(candidate)) {
        evidenceIds.add(candidate);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item);
      }
      return;
    }
    if (candidate !== null && typeof candidate === "object") {
      for (const item of Object.values(candidate)) {
        visit(item);
      }
    }
  };
  visit(value);
  return [...evidenceIds].sort();
}

function mapSeries(row: SqlRow): ValuationModelSeries {
  const status = requiredString(row, "status");
  assertOneOf(status, SERIES_STATUSES, "stored series status");
  return {
    seriesId: requiredString(row, "series_id"),
    datasetId: requiredString(row, "dataset_id"),
    seriesKey: requiredString(row, "series_key"),
    name: requiredString(row, "name"),
    companyName: nullableString(row, "company_name"),
    companyTicker: nullableString(row, "company_ticker"),
    modelType: nullableString(row, "model_type"),
    currentModelVersionId: nullableString(row, "current_model_version_id"),
    currentVersionNo: numberValue(row, "current_version_no"),
    status,
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function mapVersion(row: SqlRow): ValuationModelVersion {
  return {
    modelVersionId: requiredString(row, "model_version_id"),
    seriesId: requiredString(row, "series_id"),
    datasetId: requiredString(row, "dataset_id"),
    docId: requiredString(row, "doc_id"),
    logicalDocId: nullableString(row, "logical_doc_id"),
    documentVersionNo: numberValue(row, "document_version_no"),
    parentModelVersionId: nullableString(row, "parent_model_version_id"),
    revertedToVersionId: nullableString(row, "reverted_to_version_id"),
    checksum: requiredString(row, "checksum"),
    snapshotHash: requiredString(row, "snapshot_hash"),
    originalFilename: requiredString(row, "original_filename"),
    documentDate: nullableString(row, "document_date"),
    modelType: nullableString(row, "model_type"),
    nodeCount: numberValue(row, "node_count"),
    formulaNodeCount: numberValue(row, "formula_node_count"),
    reviewRequiredCount: numberValue(row, "review_required_count"),
    analyzerVersion: requiredString(row, "analyzer_version"),
    createdAt: requiredString(row, "created_at"),
  };
}

function mapModelOverview(row: SqlRow): ValuationModelOverview {
  return {
    overviewId: requiredString(row, "overview_id"),
    datasetId: requiredString(row, "dataset_id"),
    seriesId: requiredString(row, "series_id"),
    modelVersionId: requiredString(row, "model_version_id"),
    docId: requiredString(row, "doc_id"),
    status: requiredString(row, "status"),
    overview: decodeJsonObject(row.overview_json),
    html: stringValue(row, "html"),
    overviewVersion: requiredString(row, "overview_version"),
    createdAt: requiredString(row, "created_at"),
  };
}

function mapAnalysisVersion(row: SqlRow): ValuationAnalysisVersion {
  return {
    analysisVersionId: requiredString(row, "analysis_version_id"),
    datasetId: requiredString(row, "dataset_id"),
    seriesId: requiredString(row, "series_id"),
    modelVersionId: requiredString(row, "model_version_id"),
    previousAnalysisVersionId: nullableString(
      row,
      "previous_analysis_version_id",
    ),
    status: requiredString(row, "status"),
    summaryMarkdown: requiredString(row, "summary_markdown"),
    analysis: decodeJsonObject(row.analysis_json),
    analyzerVersion: requiredString(row, "analyzer_version"),
    createdAt: requiredString(row, "created_at"),
  };
}

function mapNode(row: SqlRow): ValuationModelNode {
  const nodeKind = requiredString(row, "node_kind");
  assertOneOf(nodeKind, NODE_KINDS, "stored node kind");
  return {
    nodeId: requiredString(row, "node_id"),
    seriesId: requiredString(row, "series_id"),
    canonicalKey: requiredString(row, "canonical_key"),
    nodeKind,
    metricKey: requiredString(row, "metric_key"),
    displayName: requiredString(row, "display_name"),
    scope: requiredString(row, "scope"),
    period: nullableString(row, "period"),
    scenario: nullableString(row, "scenario"),
    firstSeenAt: requiredString(row, "first_seen_at"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function mapNodeValue(row: SqlRow): ValuationNodeValue {
  return {
    nodeValueId: requiredString(row, "node_value_id"),
    modelVersionId: requiredString(row, "model_version_id"),
    nodeId: requiredString(row, "node_id"),
    valueNumeric: nullableNumber(row, "value_numeric"),
    valueText: nullableString(row, "value_text"),
    unit: nullableString(row, "unit"),
    formula: nullableString(row, "formula"),
    formulaFingerprint: nullableString(row, "formula_fingerprint"),
    sheetName: requiredString(row, "sheet_name"),
    cellRef: requiredString(row, "cell_ref"),
    evidenceId: requiredString(row, "evidence_id"),
    qualityStatus: requiredString(row, "quality_status"),
    confidence: numberValue(row, "confidence"),
    metadata: decodeJsonObject(row.metadata_json),
    createdAt: requiredString(row, "created_at"),
  };
}

function mapChange(row: SqlRow): ValuationModelChange {
  const materiality = requiredString(row, "materiality");
  assertOneOf(materiality, MATERIALITIES, "stored change materiality");
  return {
    changeId: requiredString(row, "change_id"),
    datasetId: requiredString(row, "dataset_id"),
    seriesId: requiredString(row, "series_id"),
    fromModelVersionId: requiredString(row, "from_model_version_id"),
    toModelVersionId: requiredString(row, "to_model_version_id"),
    nodeId: requiredString(row, "node_id"),
    changeType: requiredString(row, "change_type"),
    materiality,
    summary: requiredString(row, "summary"),
    oldValue: decodeJsonObject(row.old_value_json),
    newValue: decodeJsonObject(row.new_value_json),
    absoluteChange: nullableNumber(row, "absolute_change"),
    relativeChange: nullableNumber(row, "relative_change"),
    evidenceIds: decodeStringArray(row.evidence_ids_json, "evidence_ids_json"),
    createdAt: requiredString(row, "created_at"),
  };
}

function mapMetricModelValue(row: SqlRow): ValuationMetricModelValue {
  return {
    modelMetricId: requiredString(row, "model_metric_id"),
    datasetId: requiredString(row, "dataset_id"),
    seriesId: requiredString(row, "series_id"),
    modelVersionId: requiredString(row, "model_version_id"),
    metricKey: requiredString(row, "metric_key"),
    valueNumeric: nullableNumber(row, "value_numeric"),
    unit: requiredString(row, "unit"),
    period: nullableString(row, "period"),
    status: requiredString(row, "status"),
    method: requiredString(row, "method"),
    source: nullableString(row, "source"),
    evidenceIds: decodeStringArray(row.evidence_ids_json, "evidence_ids_json"),
    qualityStatus: requiredString(row, "quality_status"),
    createdAt: requiredString(row, "created_at"),
  };
}

function mapSnapshot(row: SqlRow): ValuationMarketSnapshot {
  const status = requiredString(row, "status");
  assertOneOf(status, SNAPSHOT_STATUSES, "stored market snapshot status");
  return {
    snapshotId: requiredString(row, "snapshot_id"),
    datasetId: requiredString(row, "dataset_id"),
    seriesId: requiredString(row, "series_id"),
    modelVersionId: requiredString(row, "model_version_id"),
    companyName: nullableString(row, "company_name"),
    companyTicker: nullableString(row, "company_ticker"),
    provider: requiredString(row, "provider"),
    status,
    asOf: nullableString(row, "as_of"),
    errorMessage: nullableString(row, "error_message"),
    raw: decodeJsonObject(row.raw_json),
    createdAt: requiredString(row, "created_at"),
  };
}

function mapMetricActualValue(row: SqlRow): ValuationMetricActualValue {
  return {
    actualMetricId: requiredString(row, "actual_metric_id"),
    snapshotId: requiredString(row, "snapshot_id"),
    datasetId: requiredString(row, "dataset_id"),
    seriesId: requiredString(row, "series_id"),
    modelVersionId: requiredString(row, "model_version_id"),
    metricKey: requiredString(row, "metric_key"),
    valueNumeric: nullableNumber(row, "value_numeric"),
    unit: requiredString(row, "unit"),
    period: nullableString(row, "period"),
    status: requiredString(row, "status"),
    source: nullableString(row, "source"),
    observedAt: nullableString(row, "observed_at"),
    metadata: decodeJsonObject(row.metadata_json),
    createdAt: requiredString(row, "created_at"),
  };
}

function mapMetricComparison(row: SqlRow): ValuationMetricComparison {
  return {
    comparisonId: requiredString(row, "comparison_id"),
    datasetId: requiredString(row, "dataset_id"),
    seriesId: requiredString(row, "series_id"),
    modelVersionId: requiredString(row, "model_version_id"),
    snapshotId: requiredString(row, "snapshot_id"),
    metricKey: requiredString(row, "metric_key"),
    modelValue: nullableNumber(row, "model_value"),
    actualValue: nullableNumber(row, "actual_value"),
    absoluteGap: nullableNumber(row, "absolute_gap"),
    relativeGap: nullableNumber(row, "relative_gap"),
    severity: requiredString(row, "severity"),
    status: requiredString(row, "status"),
    explanation: stringValue(row, "explanation"),
    modelPeriod: nullableString(row, "model_period"),
    actualPeriod: nullableString(row, "actual_period"),
    modelSource: nullableString(row, "model_source"),
    actualSource: nullableString(row, "actual_source"),
    evidenceIds: decodeStringArray(row.evidence_ids_json, "evidence_ids_json"),
    createdAt: requiredString(row, "created_at"),
  };
}

function mapContextCard(row: SqlRow): ValuationContextCard {
  return {
    cardId: requiredString(row, "card_id"),
    datasetId: requiredString(row, "dataset_id"),
    seriesId: requiredString(row, "series_id"),
    modelVersionId: requiredString(row, "model_version_id"),
    sourceDocId: requiredString(row, "source_doc_id"),
    sourceFingerprint: requiredString(row, "source_fingerprint"),
    cardType: requiredString(row, "card_type"),
    title: requiredString(row, "title"),
    summary: requiredString(row, "summary"),
    insight: requiredString(row, "insight"),
    sourceName: requiredString(row, "source_name"),
    documentDate: nullableString(row, "document_date"),
    evidenceIds: decodeStringArray(row.evidence_ids_json, "evidence_ids_json"),
    provenance: decodeJsonObject(row.provenance_json),
    createdAt: requiredString(row, "created_at"),
  };
}

function mapImpactCard(row: SqlRow): ValuationImpactCard {
  const sourceKind = requiredString(row, "source_kind");
  if (sourceKind !== "control_job") {
    throw new WorkflowStoreError(
      "Stored impact-card source is not a control job",
      "corrupt_json",
    );
  }
  const direction = requiredString(row, "direction");
  assertOneOf(direction, IMPACT_DIRECTIONS, "stored impact direction");
  return {
    cardId: requiredString(row, "card_id"),
    datasetId: requiredString(row, "dataset_id"),
    seriesId: requiredString(row, "series_id"),
    modelVersionId: requiredString(row, "model_version_id"),
    sourceKind,
    sourceJobId: requiredString(row, "source_job_id"),
    sourceFingerprint: requiredString(row, "source_fingerprint"),
    ordinal: numberValue(row, "ordinal"),
    direction,
    horizon: requiredString(row, "horizon"),
    confidence: numberValue(row, "confidence"),
    title: requiredString(row, "title"),
    evidenceSummary: requiredString(row, "evidence_summary"),
    valuationImpact: requiredString(row, "valuation_impact"),
    affectedInputs: decodeJsonArray(row.affected_inputs_json),
    watchItems: decodeJsonArray(row.watch_items_json),
    sourceRefs: decodeJsonArray(row.source_refs_json),
    evidenceIds: decodeStringArray(row.evidence_ids_json, "evidence_ids_json"),
    provenance: decodeJsonObject(row.provenance_json),
    createdAt: requiredString(row, "created_at"),
  };
}

function mapMarketPriceBar(row: SqlRow): ValuationMarketPriceBar {
  return {
    barId: requiredString(row, "bar_id"),
    datasetId: requiredString(row, "dataset_id"),
    provider: requiredString(row, "provider"),
    providerSymbol: requiredString(row, "provider_symbol"),
    canonicalTicker: requiredString(row, "canonical_ticker"),
    exchange: requiredString(row, "exchange"),
    currency: requiredString(row, "currency"),
    tradeDate: requiredString(row, "trade_date"),
    open: nullableNumber(row, "open"),
    high: nullableNumber(row, "high"),
    low: nullableNumber(row, "low"),
    close: numberValue(row, "close"),
    volume: nullableNumber(row, "volume"),
    amount: nullableNumber(row, "amount"),
    adjustment: requiredString(row, "adjustment"),
    source: nullableString(row, "source"),
    sourceFingerprint: requiredString(row, "source_fingerprint"),
    evidenceIds: decodeStringArray(row.evidence_ids_json, "evidence_ids_json"),
    provenance: decodeJsonObject(row.provenance_json),
    fetchedAt: requiredString(row, "fetched_at"),
  };
}

function mapPriceComparison(row: SqlRow): ValuationPriceComparison {
  return {
    priceComparisonId: requiredString(row, "price_comparison_id"),
    snapshotId: requiredString(row, "snapshot_id"),
    datasetId: requiredString(row, "dataset_id"),
    seriesId: requiredString(row, "series_id"),
    modelVersionId: requiredString(row, "model_version_id"),
    provider: requiredString(row, "provider"),
    providerSymbol: nullableString(row, "provider_symbol"),
    currency: nullableString(row, "currency"),
    valuationDate: nullableString(row, "valuation_date"),
    benchmarkTradeDate: nullableString(row, "benchmark_trade_date"),
    benchmarkClose: nullableNumber(row, "benchmark_close"),
    latestTradeDate: nullableString(row, "latest_trade_date"),
    latestClose: nullableNumber(row, "latest_close"),
    targetPrice: nullableNumber(row, "target_price"),
    targetUnit: nullableString(row, "target_unit"),
    targetSource: nullableString(row, "target_source"),
    targetEvidenceId: nullableString(row, "target_evidence_id"),
    impliedUpside: nullableNumber(row, "implied_upside"),
    latestUpside: nullableNumber(row, "latest_upside"),
    status: requiredString(row, "status"),
    errorMessage: nullableString(row, "error_message"),
    metadata: decodeJsonObject(row.metadata_json),
    evidenceIds: decodeStringArray(row.evidence_ids_json, "evidence_ids_json"),
    sourceFingerprint: requiredString(row, "source_fingerprint"),
    provenance: decodeJsonObject(row.provenance_json),
    createdAt: requiredString(row, "created_at"),
  };
}

function mapManualOverride(row: SqlRow): ValuationMetricManualOverride {
  const qualityStatus = requiredString(row, "quality_status");
  assertOneOf(
    qualityStatus,
    MANUAL_QUALITY_STATUSES,
    "stored manual metric quality status",
  );
  return {
    overrideId: requiredString(row, "override_id"),
    datasetId: requiredString(row, "dataset_id"),
    seriesId: requiredString(row, "series_id"),
    modelVersionId: requiredString(row, "model_version_id"),
    metricKey: requiredString(row, "metric_key"),
    valueNumeric: numberValue(row, "value_numeric"),
    unit: requiredString(row, "unit"),
    period: requiredString(row, "period"),
    method: requiredString(row, "method"),
    source: requiredString(row, "source"),
    evidenceIds: decodeStringArray(row.evidence_ids_json, "evidence_ids_json"),
    derivation: requiredString(row, "derivation"),
    qualityStatus,
    reviewer: requiredString(row, "reviewer"),
    reviewNote: stringValue(row, "review_note"),
    active: booleanValue(row, "is_active"),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function mapAgentAnalysis(row: SqlRow): ValuationAgentAnalysis {
  const status = requiredString(row, "status");
  assertOneOf(status, ANALYSIS_STATUSES, "stored agent analysis status");
  return {
    analysisId: requiredString(row, "analysis_id"),
    datasetId: requiredString(row, "dataset_id"),
    seriesId: requiredString(row, "series_id"),
    baseModelVersionId: requiredString(row, "base_model_version_id"),
    comparisonModelVersionId: nullableString(row, "comparison_model_version_id"),
    status,
    focus: stringValue(row, "focus"),
    valuationMethod: nullableString(row, "valuation_method"),
    executiveSummary: nullableString(row, "executive_summary"),
    investmentConclusion: nullableString(row, "investment_conclusion"),
    analysis: decodeJsonObject(row.analysis_json),
    planner: decodeJsonObject(row.planner_json),
    evidenceIds: decodeStringArray(row.evidence_ids_json, "evidence_ids_json"),
    rawResponse: nullableString(row, "raw_response"),
    modelName: nullableString(row, "model_name"),
    agentVersion: requiredString(row, "agent_version"),
    errorMessage: nullableString(row, "error_message"),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
    completedAt: nullableString(row, "completed_at"),
  };
}

function mapDerivedModel(row: SqlRow): ValuationDerivedModel {
  const resourceStatus = requiredString(row, "resource_status");
  assertOneOf(resourceStatus, RESOURCE_STATUSES, "stored resource status");
  return {
    derivedModelId: requiredString(row, "derived_model_id"),
    datasetId: requiredString(row, "dataset_id"),
    seriesId: requiredString(row, "series_id"),
    analysisId: requiredString(row, "analysis_id"),
    baseModelVersionId: requiredString(row, "base_model_version_id"),
    derivedVersionNo: numberValue(row, "derived_version_no"),
    outputFilename: requiredString(row, "output_filename"),
    outputPath: requiredString(row, "output_path"),
    checksum: requiredString(row, "checksum"),
    appliedChanges: decodeJsonArray(row.applied_changes_json),
    skippedChanges: decodeJsonArray(row.skipped_changes_json),
    resourceFileName: nullableString(row, "resource_file_name"),
    resourcePipelineJobId: nullableString(row, "resource_pipeline_job_id"),
    resourceStatus,
    resourceDocId: nullableString(row, "resource_doc_id"),
    resourceAddedAt: nullableString(row, "resource_added_at"),
    resourceError: nullableString(row, "resource_error"),
    createdAt: requiredString(row, "created_at"),
  };
}

function mapWatchRule(row: SqlRow): ValuationWatchRule {
  const minMateriality = requiredString(row, "min_materiality");
  assertOneOf(
    minMateriality,
    MATERIALITIES,
    "stored watch rule materiality",
  );
  return {
    ruleId: requiredString(row, "rule_id"),
    datasetId: requiredString(row, "dataset_id"),
    seriesId: nullableString(row, "series_id"),
    name: requiredString(row, "name"),
    minMateriality,
    changeTypes: decodeStringArray(row.change_types_json, "change_types_json"),
    active: booleanValue(row, "active"),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function mapAlert(row: SqlRow): ValuationAlert {
  const status = requiredString(row, "status");
  assertOneOf(status, ALERT_STATUSES, "stored alert status");
  return {
    alertId: requiredString(row, "alert_id"),
    datasetId: requiredString(row, "dataset_id"),
    seriesId: requiredString(row, "series_id"),
    ruleId: nullableString(row, "rule_id"),
    changeId: requiredString(row, "change_id"),
    alertType: requiredString(row, "alert_type"),
    priority: requiredString(row, "priority"),
    title: requiredString(row, "title"),
    summary: requiredString(row, "summary"),
    evidenceIds: decodeStringArray(row.evidence_ids_json, "evidence_ids_json"),
    status,
    snoozedUntil: nullableString(row, "snoozed_until"),
    dedupeKey: requiredString(row, "dedupe_key"),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function countRows(
  database: DatabaseSync,
  sql: string,
  params: readonly (null | number | string)[],
): number {
  const row = toRecord(database.prepare(sql).get(...params));
  return numberValue(row, "total");
}

function rows(
  database: DatabaseSync,
  sql: string,
  params: readonly (null | number | string)[],
): SqlRow[] {
  return database.prepare(sql).all(...params).map(toRecord);
}

function ensureVersionScope(
  database: DatabaseSync,
  modelVersionId: string,
  datasetId: string,
  seriesId: string,
): SqlRow {
  const row = getRequiredRow(
    database,
    `SELECT dataset_id, series_id, model_version_id
     FROM valuation_model_versions
     WHERE model_version_id = ?`,
    [modelVersionId],
    "Valuation model version",
  );
  assertSameScope(row, datasetId, seriesId, "Valuation model version");
  return row;
}

function ensureSeries(
  database: DatabaseSync,
  datasetId: string,
  seriesId: string,
): SqlRow {
  return getRequiredRow(
    database,
    `SELECT * FROM valuation_model_series
     WHERE dataset_id = ? AND series_id = ?`,
    [datasetId, seriesId],
    "Valuation model series",
  );
}

function materialityRank(value: ValuationMateriality): number {
  return MATERIALITIES.indexOf(value);
}

function conflict(message: string): never {
  throw new WorkflowStoreError(message, "conflict");
}

function sourceFingerprint(value: string): string {
  const normalized = requireText(value, "sourceFingerprint", 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) {
    throw new WorkflowStoreError(
      "sourceFingerprint must be a 64-character SHA-256 digest",
      "invalid_argument",
    );
  }
  return normalized;
}

function calendarDate(value: string, field: string): string {
  const normalized = requireText(value, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new WorkflowStoreError(
      `${field} must use YYYY-MM-DD`,
      "invalid_argument",
    );
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalized
  ) {
    throw new WorkflowStoreError(`${field} is not a calendar date`, "invalid_argument");
  }
  return normalized;
}

function boundedTradeDateRange(
  from: string,
  to: string,
): { readonly from: string; readonly to: string } {
  const normalizedFrom = calendarDate(from, "tradeDateFrom");
  const normalizedTo = calendarDate(to, "tradeDateTo");
  const fromTime = Date.parse(`${normalizedFrom}T00:00:00.000Z`);
  const toTime = Date.parse(`${normalizedTo}T00:00:00.000Z`);
  const maximumRangeMs = 10 * 366 * 24 * 60 * 60 * 1_000;
  if (toTime < fromTime || toTime - fromTime > maximumRangeMs) {
    throw new WorkflowStoreError(
      "Market-price range must be ordered and no longer than ten years",
      "invalid_argument",
    );
  }
  return { from: normalizedFrom, to: normalizedTo };
}

function assertMarketPriceInvariants(input: {
  readonly open: number | null;
  readonly high: number | null;
  readonly low: number | null;
  readonly close: number;
  readonly volume: number | null;
  readonly amount: number | null;
}): void {
  if (
    (input.volume !== null && input.volume < 0) ||
    (input.amount !== null && input.amount < 0) ||
    (input.high !== null && input.high < input.close) ||
    (input.low !== null && input.low > input.close) ||
    (input.open !== null &&
      input.high !== null &&
      input.high < input.open) ||
    (input.open !== null &&
      input.low !== null &&
      input.low > input.open) ||
    (input.high !== null && input.low !== null && input.high < input.low)
  ) {
    throw new WorkflowStoreError(
      "OHLCV values violate market-price invariants",
      "invalid_argument",
    );
  }
}

function tableHasColumn(
  database: DatabaseSync,
  table: string,
  column: string,
): boolean {
  if (
    database
      .prepare(
        `SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?`,
      )
      .get(table) === undefined
  ) {
    return false;
  }
  return database
    .prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
    .all()
    .some((row) => String(toRecord(row).name) === column);
}

function evidenceReferenceExists(
  database: DatabaseSync,
  evidenceId: string,
): boolean {
  if (
    database
      .prepare(
        `SELECT 1 FROM workflow_store_evidence_references
         WHERE evidence_id=? LIMIT 1`,
      )
      .get(evidenceId) !== undefined
  ) {
    return true;
  }
  if (
    tableHasColumn(database, "evidence", "evidence_id") &&
    database
      .prepare(`SELECT 1 FROM evidence WHERE evidence_id=? LIMIT 1`)
      .get(evidenceId) !== undefined
  ) {
    return true;
  }
  const separator = evidenceId.indexOf(":");
  const kind = evidenceId.slice(0, separator);
  const rawId = evidenceId.slice(separator + 1);
  const candidates: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
    chunk: [["chunks", "chunk_id"]],
    fact: [["metric_facts", "fact_id"]],
    cell: [["excel_cells", "cell_id"]],
    page: [["pdf_pages", "page_id"]],
    document: [
      ["documents", "id"],
      ["documents", "doc_id"],
    ],
  };
  for (const [table, column] of candidates[kind] ?? []) {
    if (
      tableHasColumn(database, table, column) &&
      database
        .prepare(
          `SELECT 1 FROM "${table}" WHERE "${column}"=? LIMIT 1`,
        )
        .get(rawId) !== undefined
    ) {
      return true;
    }
  }
  return false;
}

function assertPlausibleManualMetric(
  metricKey: ValuationMetricKey,
  value: number,
): void {
  const plausible =
    metricKey === "forward_pe"
      ? value > 0 && value < 2_000
      : metricKey === "avg_turnover_amount_20d"
        ? value >= 0
        : value >= -10 && value <= 10;
  if (!plausible) {
    throw new WorkflowStoreError(
      `valueNumeric is implausible for ${metricKey}`,
      "invalid_argument",
    );
  }
}

export class ValuationRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public saveContextCard(
    input: SaveValuationContextCardInput,
  ): SaveResult<ValuationContextCard> {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const seriesId = requireText(input.seriesId, "seriesId", 240);
    const modelVersionId = requireText(
      input.modelVersionId,
      "modelVersionId",
      240,
    );
    const sourceDocId = requireText(input.sourceDocId, "sourceDocId", 240);
    const fingerprint = sourceFingerprint(input.sourceFingerprint);
    const cardType = requireText(input.cardType, "cardType", 120);
    const title = requireText(input.title, "title", 1_000);
    const summary = requireText(input.summary, "summary", 1_000_000);
    const insight = requireText(input.insight, "insight", 1_000_000);
    const sourceName = requireText(input.sourceName, "sourceName", 1_000);
    const documentDate = optionalInputText(
      input.documentDate,
      "documentDate",
      80,
    );
    const ids = normalizeEvidenceIds(input.evidenceIds);
    const evidenceJson = encodeJson(ids);
    const provenanceJson = encodeJson(input.provenance ?? {});
    const cardId =
      input.cardId === undefined
        ? stableId(
            "vcc",
            datasetId,
            modelVersionId,
            sourceDocId,
            cardType,
            fingerprint,
          )
        : requireText(input.cardId, "cardId", 240);

    return withTransaction(this.database, () => {
      ensureVersionScope(this.database, modelVersionId, datasetId, seriesId);
      const existingRaw = this.database
        .prepare(
          `SELECT * FROM valuation_context_cards
           WHERE card_id=?
              OR (
                model_version_id=? AND source_doc_id=?
                AND card_type=? AND source_fingerprint=?
              )
           ORDER BY CASE WHEN card_id=? THEN 0 ELSE 1 END
           LIMIT 1`,
        )
        .get(
          cardId,
          modelVersionId,
          sourceDocId,
          cardType,
          fingerprint,
          cardId,
        );
      if (existingRaw !== undefined) {
        const existing = mapContextCard(toRecord(existingRaw));
        if (
          (input.cardId !== undefined && existing.cardId !== cardId) ||
          existing.datasetId !== datasetId ||
          existing.seriesId !== seriesId ||
          existing.modelVersionId !== modelVersionId ||
          existing.sourceDocId !== sourceDocId ||
          existing.sourceFingerprint !== fingerprint ||
          existing.cardType !== cardType ||
          existing.title !== title ||
          existing.summary !== summary ||
          existing.insight !== insight ||
          existing.sourceName !== sourceName ||
          existing.documentDate !== documentDate ||
          encodeJson(existing.evidenceIds) !== evidenceJson ||
          encodeJson(existing.provenance) !== provenanceJson
        ) {
          conflict("Context-card source identity is immutable");
        }
        recordEvidenceReferences(
          this.database,
          "valuation-context-card",
          existing.cardId,
          ids,
        );
        return { value: existing, created: false };
      }
      const createdAt = nowIso();
      this.database
        .prepare(
          `INSERT INTO valuation_context_cards(
             card_id, dataset_id, series_id, model_version_id, source_doc_id,
             source_fingerprint, card_type, title, summary, insight,
             source_name, document_date, evidence_ids_json, provenance_json,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          cardId,
          datasetId,
          seriesId,
          modelVersionId,
          sourceDocId,
          fingerprint,
          cardType,
          title,
          summary,
          insight,
          sourceName,
          documentDate,
          evidenceJson,
          provenanceJson,
          createdAt,
        );
      recordEvidenceReferences(
        this.database,
        "valuation-context-card",
        cardId,
        ids,
        "supports",
        createdAt,
      );
      return {
        value: this.getContextCard(datasetId, cardId),
        created: true,
      };
    });
  }

  public getContextCard(
    datasetId: string,
    cardId: string,
  ): ValuationContextCard {
    return mapContextCard(
      getRequiredRow(
        this.database,
        `SELECT * FROM valuation_context_cards
         WHERE dataset_id=? AND card_id=?`,
        [
          requireText(datasetId, "datasetId", 240),
          requireText(cardId, "cardId", 240),
        ],
        "Valuation context card",
      ),
    );
  }

  public listContextCards(
    datasetId: string,
    options: ListValuationContextCardOptions = {},
  ): Page<ValuationContextCard> {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const seriesId =
      options.seriesId === undefined
        ? null
        : requireText(options.seriesId, "seriesId", 240);
    const modelVersionId =
      options.modelVersionId === undefined
        ? null
        : requireText(options.modelVersionId, "modelVersionId", 240);
    const sourceDocId =
      options.sourceDocId === undefined
        ? null
        : requireText(options.sourceDocId, "sourceDocId", 240);
    const page = pageOptions(options, 200);
    const params = [
      normalizedDatasetId,
      seriesId,
      seriesId,
      modelVersionId,
      modelVersionId,
      sourceDocId,
      sourceDocId,
    ] as const;
    const where = `dataset_id=?
      AND (? IS NULL OR series_id=?)
      AND (? IS NULL OR model_version_id=?)
      AND (? IS NULL OR source_doc_id=?)`;
    const items = rows(
      this.database,
      `SELECT * FROM valuation_context_cards
       WHERE ${where}
       ORDER BY created_at DESC, card_id
       LIMIT ? OFFSET ?`,
      [...params, page.limit, page.offset],
    ).map(mapContextCard);
    const total = countRows(
      this.database,
      `SELECT COUNT(*) AS total FROM valuation_context_cards WHERE ${where}`,
      params,
    );
    return pageResult(items, total, page);
  }

  public saveImpactCard(
    input: SaveValuationImpactCardInput,
  ): SaveResult<ValuationImpactCard> {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const seriesId = requireText(input.seriesId, "seriesId", 240);
    const modelVersionId = requireText(
      input.modelVersionId,
      "modelVersionId",
      240,
    );
    const sourceJobId = requireText(input.sourceJobId, "sourceJobId", 240);
    const fingerprint = sourceFingerprint(input.sourceFingerprint);
    const ordinal = nonNegativeInteger(input.ordinal, "ordinal");
    const direction = input.direction;
    assertOneOf(direction, IMPACT_DIRECTIONS, "direction");
    const horizon = requireText(input.horizon, "horizon", 240);
    const confidence = confidenceValue(input.confidence);
    const title = requireText(input.title, "title", 1_000);
    const evidenceSummary = requireText(
      input.evidenceSummary,
      "evidenceSummary",
      1_000_000,
    );
    const valuationImpact = requireText(
      input.valuationImpact,
      "valuationImpact",
      1_000_000,
    );
    const affectedInputsJson = encodeJson(input.affectedInputs ?? []);
    const watchItemsJson = encodeJson(input.watchItems ?? []);
    const sourceRefsJson = encodeJson(input.sourceRefs ?? []);
    const ids = normalizeEvidenceIds(input.evidenceIds);
    const evidenceJson = encodeJson(ids);
    const provenanceJson = encodeJson(input.provenance ?? {});
    const cardId =
      input.cardId === undefined
        ? stableId("vic", datasetId, sourceJobId, ordinal)
        : requireText(input.cardId, "cardId", 240);

    return withTransaction(this.database, () => {
      ensureVersionScope(this.database, modelVersionId, datasetId, seriesId);
      const existingRaw = this.database
        .prepare(
          `SELECT * FROM valuation_impact_cards
           WHERE card_id=?
              OR (
                source_kind='control_job' AND source_job_id=? AND ordinal=?
              )
           ORDER BY CASE WHEN card_id=? THEN 0 ELSE 1 END
           LIMIT 1`,
        )
        .get(cardId, sourceJobId, ordinal, cardId);
      if (existingRaw !== undefined) {
        const existing = mapImpactCard(toRecord(existingRaw));
        if (
          (input.cardId !== undefined && existing.cardId !== cardId) ||
          existing.datasetId !== datasetId ||
          existing.seriesId !== seriesId ||
          existing.modelVersionId !== modelVersionId ||
          existing.sourceJobId !== sourceJobId ||
          existing.sourceFingerprint !== fingerprint ||
          existing.ordinal !== ordinal ||
          existing.direction !== direction ||
          existing.horizon !== horizon ||
          existing.confidence !== confidence ||
          existing.title !== title ||
          existing.evidenceSummary !== evidenceSummary ||
          existing.valuationImpact !== valuationImpact ||
          encodeJson(existing.affectedInputs) !== affectedInputsJson ||
          encodeJson(existing.watchItems) !== watchItemsJson ||
          encodeJson(existing.sourceRefs) !== sourceRefsJson ||
          encodeJson(existing.evidenceIds) !== evidenceJson ||
          encodeJson(existing.provenance) !== provenanceJson
        ) {
          conflict("Impact-card control-job source identity is immutable");
        }
        recordEvidenceReferences(
          this.database,
          "valuation-impact-card",
          existing.cardId,
          ids,
        );
        return { value: existing, created: false };
      }
      const createdAt = nowIso();
      this.database
        .prepare(
          `INSERT INTO valuation_impact_cards(
             card_id, dataset_id, series_id, model_version_id, source_kind,
             source_job_id, source_fingerprint, ordinal, direction, horizon,
             confidence, title, evidence_summary, valuation_impact,
             affected_inputs_json, watch_items_json, source_refs_json,
             evidence_ids_json, provenance_json, created_at
           ) VALUES (
             ?, ?, ?, ?, 'control_job', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?
           )`,
        )
        .run(
          cardId,
          datasetId,
          seriesId,
          modelVersionId,
          sourceJobId,
          fingerprint,
          ordinal,
          direction,
          horizon,
          confidence,
          title,
          evidenceSummary,
          valuationImpact,
          affectedInputsJson,
          watchItemsJson,
          sourceRefsJson,
          evidenceJson,
          provenanceJson,
          createdAt,
        );
      recordEvidenceReferences(
        this.database,
        "valuation-impact-card",
        cardId,
        ids,
        "supports",
        createdAt,
      );
      return {
        value: this.getImpactCard(datasetId, cardId),
        created: true,
      };
    });
  }

  public getImpactCard(
    datasetId: string,
    cardId: string,
  ): ValuationImpactCard {
    return mapImpactCard(
      getRequiredRow(
        this.database,
        `SELECT * FROM valuation_impact_cards
         WHERE dataset_id=? AND card_id=?`,
        [
          requireText(datasetId, "datasetId", 240),
          requireText(cardId, "cardId", 240),
        ],
        "Valuation impact card",
      ),
    );
  }

  public listImpactCards(
    datasetId: string,
    options: ListValuationImpactCardOptions = {},
  ): Page<ValuationImpactCard> {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const seriesId =
      options.seriesId === undefined
        ? null
        : requireText(options.seriesId, "seriesId", 240);
    const modelVersionId =
      options.modelVersionId === undefined
        ? null
        : requireText(options.modelVersionId, "modelVersionId", 240);
    const sourceJobId =
      options.sourceJobId === undefined
        ? null
        : requireText(options.sourceJobId, "sourceJobId", 240);
    const page = pageOptions(options, 200);
    const params = [
      normalizedDatasetId,
      seriesId,
      seriesId,
      modelVersionId,
      modelVersionId,
      sourceJobId,
      sourceJobId,
    ] as const;
    const where = `dataset_id=?
      AND (? IS NULL OR series_id=?)
      AND (? IS NULL OR model_version_id=?)
      AND (? IS NULL OR source_job_id=?)`;
    const items = rows(
      this.database,
      `SELECT * FROM valuation_impact_cards
       WHERE ${where}
       ORDER BY created_at DESC, ordinal, card_id
       LIMIT ? OFFSET ?`,
      [...params, page.limit, page.offset],
    ).map(mapImpactCard);
    const total = countRows(
      this.database,
      `SELECT COUNT(*) AS total FROM valuation_impact_cards WHERE ${where}`,
      params,
    );
    return pageResult(items, total, page);
  }

  public saveMarketPriceBar(
    input: SaveValuationMarketPriceBarInput,
  ): SaveResult<ValuationMarketPriceBar> {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const provider = requireText(input.provider, "provider", 120);
    const providerSymbol = requireText(
      input.providerSymbol,
      "providerSymbol",
      120,
    );
    const canonicalTicker = requireText(
      input.canonicalTicker,
      "canonicalTicker",
      120,
    );
    const exchange = requireText(input.exchange, "exchange", 80);
    const currency = requireText(input.currency, "currency", 40);
    const tradeDate = calendarDate(input.tradeDate, "tradeDate");
    const open = finiteOrNull(input.open, "open");
    const high = finiteOrNull(input.high, "high");
    const low = finiteOrNull(input.low, "low");
    if (!Number.isFinite(input.close)) {
      throw new WorkflowStoreError("close must be finite", "invalid_argument");
    }
    const close = input.close;
    const volume = finiteOrNull(input.volume, "volume");
    const amount = finiteOrNull(input.amount, "amount");
    assertMarketPriceInvariants({ open, high, low, close, volume, amount });
    const adjustment = requireText(input.adjustment ?? "raw", "adjustment", 80);
    const source = optionalInputText(input.source, "source", 2_000);
    const fingerprint = sourceFingerprint(input.sourceFingerprint);
    const ids = normalizeEvidenceIds(input.evidenceIds);
    const evidenceJson = encodeJson(ids);
    const provenanceJson = encodeJson(input.provenance ?? {});
    const requestedFetchedAt =
      input.fetchedAt === undefined
        ? null
        : assertIsoDate(input.fetchedAt, "fetchedAt");
    const barId =
      input.barId === undefined
        ? stableId(
            "vpb",
            datasetId,
            provider,
            providerSymbol,
            tradeDate,
            adjustment,
          )
        : requireText(input.barId, "barId", 240);

    return withTransaction(this.database, () => {
      const existingRaw = this.database
        .prepare(
          `SELECT * FROM valuation_market_price_bars
           WHERE bar_id=?
              OR (
                dataset_id=? AND provider=? AND provider_symbol=?
                AND trade_date=? AND adjustment=?
              )
           ORDER BY CASE WHEN bar_id=? THEN 0 ELSE 1 END
           LIMIT 1`,
        )
        .get(
          barId,
          datasetId,
          provider,
          providerSymbol,
          tradeDate,
          adjustment,
          barId,
        );
      if (existingRaw !== undefined) {
        const existing = mapMarketPriceBar(toRecord(existingRaw));
        if (
          (input.barId !== undefined && existing.barId !== barId) ||
          existing.datasetId !== datasetId ||
          existing.provider !== provider ||
          existing.providerSymbol !== providerSymbol ||
          existing.canonicalTicker !== canonicalTicker ||
          existing.exchange !== exchange ||
          existing.currency !== currency ||
          existing.tradeDate !== tradeDate ||
          existing.open !== open ||
          existing.high !== high ||
          existing.low !== low ||
          existing.close !== close ||
          existing.volume !== volume ||
          existing.amount !== amount ||
          existing.adjustment !== adjustment ||
          existing.source !== source ||
          existing.sourceFingerprint !== fingerprint ||
          encodeJson(existing.evidenceIds) !== evidenceJson ||
          encodeJson(existing.provenance) !== provenanceJson ||
          (requestedFetchedAt !== null &&
            existing.fetchedAt !== requestedFetchedAt)
        ) {
          conflict("Market-price source identity is immutable");
        }
        recordEvidenceReferences(
          this.database,
          "valuation-market-price-bar",
          existing.barId,
          ids,
        );
        return { value: existing, created: false };
      }
      const fetchedAt = requestedFetchedAt ?? nowIso();
      this.database
        .prepare(
          `INSERT INTO valuation_market_price_bars(
             bar_id, dataset_id, provider, provider_symbol, canonical_ticker,
             exchange, currency, trade_date, open, high, low, close, volume,
             amount, adjustment, source, source_fingerprint,
             evidence_ids_json, provenance_json, fetched_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          barId,
          datasetId,
          provider,
          providerSymbol,
          canonicalTicker,
          exchange,
          currency,
          tradeDate,
          open,
          high,
          low,
          close,
          volume,
          amount,
          adjustment,
          source,
          fingerprint,
          evidenceJson,
          provenanceJson,
          fetchedAt,
        );
      recordEvidenceReferences(
        this.database,
        "valuation-market-price-bar",
        barId,
        ids,
        "supports",
        fetchedAt,
      );
      return {
        value: this.getMarketPriceBar(datasetId, barId),
        created: true,
      };
    });
  }

  public getMarketPriceBar(
    datasetId: string,
    barId: string,
  ): ValuationMarketPriceBar {
    return mapMarketPriceBar(
      getRequiredRow(
        this.database,
        `SELECT * FROM valuation_market_price_bars
         WHERE dataset_id=? AND bar_id=?`,
        [
          requireText(datasetId, "datasetId", 240),
          requireText(barId, "barId", 240),
        ],
        "Valuation market price bar",
      ),
    );
  }

  public listMarketPriceBars(
    datasetId: string,
    canonicalTicker: string,
    options: ListValuationMarketPriceBarOptions,
  ): Page<ValuationMarketPriceBar> {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const normalizedTicker = requireText(
      canonicalTicker,
      "canonicalTicker",
      120,
    );
    const range = boundedTradeDateRange(
      options.tradeDateFrom,
      options.tradeDateTo,
    );
    const provider =
      options.provider === undefined
        ? null
        : requireText(options.provider, "provider", 120);
    const adjustment =
      options.adjustment === undefined
        ? null
        : requireText(options.adjustment, "adjustment", 80);
    const page = pageOptions(options, 2_000);
    const params = [
      normalizedDatasetId,
      normalizedTicker,
      range.from,
      range.to,
      provider,
      provider,
      adjustment,
      adjustment,
    ] as const;
    const where = `dataset_id=? AND canonical_ticker=?
      AND trade_date BETWEEN ? AND ?
      AND (? IS NULL OR provider=?)
      AND (? IS NULL OR adjustment=?)`;
    const items = rows(
      this.database,
      `SELECT * FROM valuation_market_price_bars
       WHERE ${where}
       ORDER BY trade_date DESC, bar_id
       LIMIT ? OFFSET ?`,
      [...params, page.limit, page.offset],
    ).map(mapMarketPriceBar);
    const total = countRows(
      this.database,
      `SELECT COUNT(*) AS total
       FROM valuation_market_price_bars WHERE ${where}`,
      params,
    );
    return pageResult(items, total, page);
  }

  public savePriceComparison(
    input: SaveValuationPriceComparisonInput,
  ): SaveResult<ValuationPriceComparison> {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const seriesId = requireText(input.seriesId, "seriesId", 240);
    const modelVersionId = requireText(
      input.modelVersionId,
      "modelVersionId",
      240,
    );
    const snapshotId = requireText(input.snapshotId, "snapshotId", 240);
    const provider = requireText(input.provider, "provider", 120);
    const providerSymbol = optionalInputText(
      input.providerSymbol,
      "providerSymbol",
      120,
    );
    const currency = optionalInputText(input.currency, "currency", 40);
    const valuationDate = optionalInputText(
      input.valuationDate,
      "valuationDate",
      80,
    );
    const benchmarkTradeDate =
      input.benchmarkTradeDate === undefined ||
      input.benchmarkTradeDate === null ||
      input.benchmarkTradeDate === ""
        ? null
        : calendarDate(input.benchmarkTradeDate, "benchmarkTradeDate");
    const latestTradeDate =
      input.latestTradeDate === undefined ||
      input.latestTradeDate === null ||
      input.latestTradeDate === ""
        ? null
        : calendarDate(input.latestTradeDate, "latestTradeDate");
    const benchmarkClose = finiteOrNull(input.benchmarkClose, "benchmarkClose");
    const latestClose = finiteOrNull(input.latestClose, "latestClose");
    const targetPrice = finiteOrNull(input.targetPrice, "targetPrice");
    const targetUnit = optionalInputText(input.targetUnit, "targetUnit", 80);
    const targetSource = optionalInputText(
      input.targetSource,
      "targetSource",
      2_000,
    );
    const targetEvidenceId = optionalInputText(
      input.targetEvidenceId,
      "targetEvidenceId",
      240,
    );
    const ids = normalizeEvidenceIds([
      ...(input.evidenceIds ?? []),
      ...(targetEvidenceId === null ? [] : [targetEvidenceId]),
    ]);
    const impliedUpside = finiteOrNull(input.impliedUpside, "impliedUpside");
    const latestUpside = finiteOrNull(input.latestUpside, "latestUpside");
    const status = requireText(input.status, "status", 120);
    const errorMessage = optionalInputText(
      input.errorMessage,
      "errorMessage",
      8_000,
    );
    const metadataJson = encodeJson(input.metadata ?? {});
    const evidenceJson = encodeJson(ids);
    const fingerprint = sourceFingerprint(input.sourceFingerprint);
    const provenanceJson = encodeJson(input.provenance ?? {});
    const comparisonId =
      input.priceComparisonId === undefined
        ? stableId("vpc", datasetId, modelVersionId, snapshotId)
        : requireText(input.priceComparisonId, "priceComparisonId", 240);

    return withTransaction(this.database, () => {
      ensureVersionScope(this.database, modelVersionId, datasetId, seriesId);
      const snapshot = getRequiredRow(
        this.database,
        `SELECT dataset_id, series_id, model_version_id
         FROM valuation_market_snapshots WHERE snapshot_id=?`,
        [snapshotId],
        "Valuation market snapshot",
      );
      assertSameScope(snapshot, datasetId, seriesId, "Valuation market snapshot");
      if (requiredString(snapshot, "model_version_id") !== modelVersionId) {
        conflict("Valuation market snapshot belongs to another model version");
      }
      const existingRaw = this.database
        .prepare(
          `SELECT * FROM valuation_price_comparisons
           WHERE price_comparison_id=?
              OR (model_version_id=? AND snapshot_id=?)
           ORDER BY CASE WHEN price_comparison_id=? THEN 0 ELSE 1 END
           LIMIT 1`,
        )
        .get(comparisonId, modelVersionId, snapshotId, comparisonId);
      if (existingRaw !== undefined) {
        const existing = mapPriceComparison(toRecord(existingRaw));
        if (
          (input.priceComparisonId !== undefined &&
            existing.priceComparisonId !== comparisonId) ||
          existing.snapshotId !== snapshotId ||
          existing.datasetId !== datasetId ||
          existing.seriesId !== seriesId ||
          existing.modelVersionId !== modelVersionId ||
          existing.provider !== provider ||
          existing.providerSymbol !== providerSymbol ||
          existing.currency !== currency ||
          existing.valuationDate !== valuationDate ||
          existing.benchmarkTradeDate !== benchmarkTradeDate ||
          existing.benchmarkClose !== benchmarkClose ||
          existing.latestTradeDate !== latestTradeDate ||
          existing.latestClose !== latestClose ||
          existing.targetPrice !== targetPrice ||
          existing.targetUnit !== targetUnit ||
          existing.targetSource !== targetSource ||
          existing.targetEvidenceId !== targetEvidenceId ||
          existing.impliedUpside !== impliedUpside ||
          existing.latestUpside !== latestUpside ||
          existing.status !== status ||
          existing.errorMessage !== errorMessage ||
          encodeJson(existing.metadata) !== metadataJson ||
          encodeJson(existing.evidenceIds) !== evidenceJson ||
          existing.sourceFingerprint !== fingerprint ||
          encodeJson(existing.provenance) !== provenanceJson
        ) {
          conflict("Price-comparison source identity is immutable");
        }
        recordEvidenceReferences(
          this.database,
          "valuation-price-comparison",
          existing.priceComparisonId,
          ids,
        );
        return { value: existing, created: false };
      }
      const createdAt = nowIso();
      this.database
        .prepare(
          `INSERT INTO valuation_price_comparisons(
             price_comparison_id, snapshot_id, dataset_id, series_id,
             model_version_id, provider, provider_symbol, currency,
             valuation_date, benchmark_trade_date, benchmark_close,
             latest_trade_date, latest_close, target_price, target_unit,
             target_source, target_evidence_id, implied_upside, latest_upside,
             status, error_message, metadata_json, evidence_ids_json,
             source_fingerprint, provenance_json, created_at
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?
           )`,
        )
        .run(
          comparisonId,
          snapshotId,
          datasetId,
          seriesId,
          modelVersionId,
          provider,
          providerSymbol,
          currency,
          valuationDate,
          benchmarkTradeDate,
          benchmarkClose,
          latestTradeDate,
          latestClose,
          targetPrice,
          targetUnit,
          targetSource,
          targetEvidenceId,
          impliedUpside,
          latestUpside,
          status,
          errorMessage,
          metadataJson,
          evidenceJson,
          fingerprint,
          provenanceJson,
          createdAt,
        );
      recordEvidenceReferences(
        this.database,
        "valuation-price-comparison",
        comparisonId,
        ids,
        "supports",
        createdAt,
      );
      return {
        value: this.getPriceComparison(datasetId, comparisonId),
        created: true,
      };
    });
  }

  public getPriceComparison(
    datasetId: string,
    priceComparisonId: string,
  ): ValuationPriceComparison {
    return mapPriceComparison(
      getRequiredRow(
        this.database,
        `SELECT * FROM valuation_price_comparisons
         WHERE dataset_id=? AND price_comparison_id=?`,
        [
          requireText(datasetId, "datasetId", 240),
          requireText(priceComparisonId, "priceComparisonId", 240),
        ],
        "Valuation price comparison",
      ),
    );
  }

  public listPriceComparisons(
    datasetId: string,
    options: ListValuationPriceComparisonOptions = {},
  ): Page<ValuationPriceComparison> {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const seriesId =
      options.seriesId === undefined
        ? null
        : requireText(options.seriesId, "seriesId", 240);
    const modelVersionId =
      options.modelVersionId === undefined
        ? null
        : requireText(options.modelVersionId, "modelVersionId", 240);
    const snapshotId =
      options.snapshotId === undefined
        ? null
        : requireText(options.snapshotId, "snapshotId", 240);
    const page = pageOptions(options, 200);
    const params = [
      normalizedDatasetId,
      seriesId,
      seriesId,
      modelVersionId,
      modelVersionId,
      snapshotId,
      snapshotId,
    ] as const;
    const where = `dataset_id=?
      AND (? IS NULL OR series_id=?)
      AND (? IS NULL OR model_version_id=?)
      AND (? IS NULL OR snapshot_id=?)`;
    const items = rows(
      this.database,
      `SELECT * FROM valuation_price_comparisons
       WHERE ${where}
       ORDER BY created_at DESC, price_comparison_id
       LIMIT ? OFFSET ?`,
      [...params, page.limit, page.offset],
    ).map(mapPriceComparison);
    const total = countRows(
      this.database,
      `SELECT COUNT(*) AS total FROM valuation_price_comparisons WHERE ${where}`,
      params,
    );
    return pageResult(items, total, page);
  }

  public ensureDefaultWatchRule(datasetId: string): ValuationWatchRule {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const existing = this.database
      .prepare(
        `SELECT rule_id FROM valuation_watch_rules
         WHERE dataset_id=? AND series_id IS NULL
           AND name='自动追踪重大估值变化'
         ORDER BY created_at LIMIT 1`,
      )
      .get(normalizedDatasetId);
    return this.upsertWatchRule({
      datasetId: normalizedDatasetId,
      ...(existing === undefined
        ? {}
        : { ruleId: requiredString(toRecord(existing), "rule_id") }),
      name: "自动追踪重大估值变化",
      minMateriality: "medium",
      active: true,
    });
  }

  public upsertSeries(
    input: UpsertValuationSeriesInput,
  ): ValuationModelSeries {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const seriesKey = requireText(input.seriesKey, "seriesKey", 1_000);
    const name = requireText(input.name, "name", 500);
    const status = input.status ?? "active";
    assertOneOf(status, SERIES_STATUSES, "status");
    const requestedId =
      input.seriesId === undefined
        ? stableId("vms", datasetId, seriesKey)
        : requireText(input.seriesId, "seriesId", 240);
    const companyName = optionalInputText(input.companyName, "companyName", 500);
    const companyTicker = optionalInputText(
      input.companyTicker,
      "companyTicker",
      100,
    );
    const modelType = optionalInputText(input.modelType, "modelType", 120);

    return withTransaction(this.database, () => {
      const existingRaw = this.database
        .prepare(
          `SELECT * FROM valuation_model_series
           WHERE dataset_id = ? AND series_key = ?`,
        )
        .get(datasetId, seriesKey);
      const timestamp = nowIso();
      if (existingRaw === undefined) {
        this.database
          .prepare(
            `INSERT INTO valuation_model_series(
               series_id, dataset_id, series_key, name, company_name,
               company_ticker, model_type, current_model_version_id,
               current_version_no, status, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?)`,
          )
          .run(
            requestedId,
            datasetId,
            seriesKey,
            name,
            companyName,
            companyTicker,
            modelType,
            status,
            timestamp,
            timestamp,
          );
        return this.getSeries(datasetId, requestedId);
      }
      const existing = toRecord(existingRaw);
      const existingId = requiredString(existing, "series_id");
      if (input.seriesId !== undefined && existingId !== requestedId) {
        conflict("seriesId conflicts with the existing dataset and seriesKey");
      }
      this.database
        .prepare(
          `UPDATE valuation_model_series
           SET name = ?,
               company_name = COALESCE(?, company_name),
               company_ticker = COALESCE(?, company_ticker),
               model_type = COALESCE(?, model_type),
               status = ?,
               updated_at = ?
           WHERE series_id = ?`,
        )
        .run(
          name,
          companyName,
          companyTicker,
          modelType,
          status,
          timestamp,
          existingId,
        );
      return this.getSeries(datasetId, existingId);
    });
  }

  public getSeries(datasetId: string, seriesId: string): ValuationModelSeries {
    return mapSeries(
      getRequiredRow(
        this.database,
        `SELECT * FROM valuation_model_series
         WHERE dataset_id = ? AND series_id = ?`,
        [
          requireText(datasetId, "datasetId", 240),
          requireText(seriesId, "seriesId", 240),
        ],
        "Valuation model series",
      ),
    );
  }

  public listSeries(
    datasetId: string,
    options: PageOptions = {},
  ): Page<ValuationModelSeries> {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const page = pageOptions(options, 200);
    const items = rows(
      this.database,
      `SELECT * FROM valuation_model_series
       WHERE dataset_id = ?
       ORDER BY updated_at DESC, series_id
       LIMIT ? OFFSET ?`,
      [normalizedDatasetId, page.limit, page.offset],
    ).map(mapSeries);
    const total = countRows(
      this.database,
      `SELECT COUNT(*) AS total
       FROM valuation_model_series WHERE dataset_id = ?`,
      [normalizedDatasetId],
    );
    return pageResult(items, total, page);
  }

  public saveModelVersion(
    input: SaveValuationModelVersionInput,
  ): SaveResult<ValuationModelVersion> {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const seriesId = requireText(input.seriesId, "seriesId", 240);
    const docId = requireText(input.docId, "docId", 240);
    const analyzerVersion = requireText(
      input.analyzerVersion,
      "analyzerVersion",
      120,
    );
    const explicitIdempotencyKey =
      input.idempotencyKey === undefined
        ? null
        : requireText(input.idempotencyKey, "idempotencyKey", 500);
    const idempotencyPart =
      explicitIdempotencyKey ?? `${docId}\0${analyzerVersion}`;
    const modelVersionId =
      input.modelVersionId === undefined
        ? stableId("vmv", datasetId, seriesId, idempotencyPart)
        : requireText(input.modelVersionId, "modelVersionId", 240);
    const documentVersionNo = positiveInteger(
      input.documentVersionNo,
      "documentVersionNo",
    );
    const checksum = requireText(input.checksum, "checksum", 128);
    const snapshotHash = requireText(input.snapshotHash, "snapshotHash", 128);
    const originalFilename = requireText(
      input.originalFilename,
      "originalFilename",
      1_000,
    );
    const nodeCount = nonNegativeInteger(input.nodeCount, "nodeCount");
    const formulaNodeCount = nonNegativeInteger(
      input.formulaNodeCount,
      "formulaNodeCount",
    );
    const reviewRequiredCount = nonNegativeInteger(
      input.reviewRequiredCount,
      "reviewRequiredCount",
    );
    if (formulaNodeCount > nodeCount || reviewRequiredCount > nodeCount) {
      throw new WorkflowStoreError(
        "Formula and review counts cannot exceed nodeCount",
        "invalid_argument",
      );
    }
    const parentId = optionalInputText(
      input.parentModelVersionId,
      "parentModelVersionId",
      240,
    );
    const revertedId = optionalInputText(
      input.revertedToVersionId,
      "revertedToVersionId",
      240,
    );
    const logicalDocId = optionalInputText(
      input.logicalDocId,
      "logicalDocId",
      240,
    );
    const documentDate = optionalInputText(
      input.documentDate,
      "documentDate",
      80,
    );
    const modelType = optionalInputText(input.modelType, "modelType", 120);

    return withTransaction(this.database, () => {
      ensureSeries(this.database, datasetId, seriesId);
      if (parentId !== null) {
        ensureVersionScope(this.database, parentId, datasetId, seriesId);
      }
      if (revertedId !== null) {
        ensureVersionScope(this.database, revertedId, datasetId, seriesId);
      }
      const existingRaw = this.database
        .prepare(
          `SELECT * FROM valuation_model_versions
           WHERE model_version_id = ?
              OR (doc_id = ? AND analyzer_version = ?)
              OR (? IS NOT NULL AND idempotency_key = ?)
           ORDER BY CASE WHEN model_version_id = ? THEN 0 ELSE 1 END
           LIMIT 1`,
        )
        .get(
          modelVersionId,
          docId,
          analyzerVersion,
          explicitIdempotencyKey,
          explicitIdempotencyKey,
          modelVersionId,
        );
      if (existingRaw !== undefined) {
        const existing = mapVersion(toRecord(existingRaw));
        if (
          (input.modelVersionId !== undefined &&
            existing.modelVersionId !== modelVersionId) ||
          existing.datasetId !== datasetId ||
          existing.seriesId !== seriesId ||
          existing.docId !== docId ||
          existing.logicalDocId !== logicalDocId ||
          existing.parentModelVersionId !== parentId ||
          existing.revertedToVersionId !== revertedId ||
          existing.checksum !== checksum ||
          existing.snapshotHash !== snapshotHash ||
          existing.documentVersionNo !== documentVersionNo ||
          existing.originalFilename !== originalFilename ||
          existing.documentDate !== documentDate ||
          existing.modelType !== modelType ||
          existing.nodeCount !== nodeCount ||
          existing.formulaNodeCount !== formulaNodeCount ||
          existing.reviewRequiredCount !== reviewRequiredCount ||
          existing.analyzerVersion !== analyzerVersion
        ) {
          conflict("The model-version idempotency key was reused with different data");
        }
        return { value: existing, created: false };
      }
      const timestamp = nowIso();
      this.database
        .prepare(
          `INSERT INTO valuation_model_versions(
             model_version_id, series_id, dataset_id, doc_id, logical_doc_id,
             document_version_no, parent_model_version_id,
             reverted_to_version_id, checksum, snapshot_hash,
             original_filename, document_date, model_type, node_count,
             formula_node_count, review_required_count, analyzer_version,
             idempotency_key, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          modelVersionId,
          seriesId,
          datasetId,
          docId,
          logicalDocId,
          documentVersionNo,
          parentId,
          revertedId,
          checksum,
          snapshotHash,
          originalFilename,
          documentDate,
          modelType,
          nodeCount,
          formulaNodeCount,
          reviewRequiredCount,
          analyzerVersion,
          explicitIdempotencyKey,
          timestamp,
        );
      this.database
        .prepare(
          `UPDATE valuation_model_series
           SET current_model_version_id = ?,
               current_version_no = ?,
               updated_at = ?
           WHERE series_id = ?
             AND current_version_no <= ?`,
        )
        .run(
          modelVersionId,
          documentVersionNo,
          timestamp,
          seriesId,
          documentVersionNo,
        );
      return {
        value: this.getModelVersion(datasetId, modelVersionId),
        created: true,
      };
    });
  }

  public getModelVersion(
    datasetId: string,
    modelVersionId: string,
  ): ValuationModelVersion {
    return mapVersion(
      getRequiredRow(
        this.database,
        `SELECT * FROM valuation_model_versions
         WHERE dataset_id = ? AND model_version_id = ?`,
        [
          requireText(datasetId, "datasetId", 240),
          requireText(modelVersionId, "modelVersionId", 240),
        ],
        "Valuation model version",
      ),
    );
  }

  public getModelOverview(
    datasetId: string,
    seriesId: string,
    modelVersionId: string,
  ): ValuationModelOverview | null {
    const row = this.database
      .prepare(
        `SELECT *
         FROM valuation_model_overviews
         WHERE dataset_id = ?
           AND series_id = ?
           AND model_version_id = ?
         ORDER BY created_at DESC, overview_version DESC
         LIMIT 1`,
      )
      .get(
        requireText(datasetId, "datasetId", 240),
        requireText(seriesId, "seriesId", 240),
        requireText(modelVersionId, "modelVersionId", 240),
      );
    return row === undefined ? null : mapModelOverview(toRecord(row));
  }

  public listModelVersions(
    datasetId: string,
    seriesId: string,
    options: PageOptions = {},
  ): Page<ValuationModelVersion> {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const normalizedSeriesId = requireText(seriesId, "seriesId", 240);
    const page = pageOptions(options, 500);
    const items = rows(
      this.database,
      `SELECT * FROM valuation_model_versions
       WHERE dataset_id = ? AND series_id = ?
       ORDER BY document_version_no DESC, created_at DESC, model_version_id
       LIMIT ? OFFSET ?`,
      [normalizedDatasetId, normalizedSeriesId, page.limit, page.offset],
    ).map(mapVersion);
    const total = countRows(
      this.database,
      `SELECT COUNT(*) AS total FROM valuation_model_versions
       WHERE dataset_id = ? AND series_id = ?`,
      [normalizedDatasetId, normalizedSeriesId],
    );
    return pageResult(items, total, page);
  }

  public saveAnalysisVersion(
    input: SaveValuationAnalysisVersionInput,
  ): SaveResult<ValuationAnalysisVersion> {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const seriesId = requireText(input.seriesId, "seriesId", 240);
    const modelVersionId = requireText(
      input.modelVersionId,
      "modelVersionId",
      240,
    );
    const analyzerVersion = requireText(
      input.analyzerVersion,
      "analyzerVersion",
      120,
    );
    const analysisVersionId =
      input.analysisVersionId === undefined
        ? stableId("vav", modelVersionId, analyzerVersion)
        : requireText(input.analysisVersionId, "analysisVersionId", 240);
    const previousAnalysisVersionId = optionalInputText(
      input.previousAnalysisVersionId,
      "previousAnalysisVersionId",
      240,
    );
    const status = requireText(input.status ?? "completed", "status", 100);
    const summaryMarkdown = requireText(
      input.summaryMarkdown,
      "summaryMarkdown",
      1_000_000,
    );
    const analysisJson = encodeJson(input.analysis ?? {});
    const nestedEvidenceIds = collectNestedEvidenceIds(
      decodeJsonObject(analysisJson),
    );
    return withTransaction(this.database, () => {
      ensureVersionScope(
        this.database,
        modelVersionId,
        datasetId,
        seriesId,
      );
      if (previousAnalysisVersionId !== null) {
        const previous = getRequiredRow(
          this.database,
          `SELECT dataset_id, series_id FROM valuation_analysis_versions
           WHERE analysis_version_id=?`,
          [previousAnalysisVersionId],
          "Previous valuation analysis version",
        );
        assertSameScope(
          previous,
          datasetId,
          seriesId,
          "Previous valuation analysis version",
        );
      }
      const existingRaw = this.database
        .prepare(
          `SELECT * FROM valuation_analysis_versions
           WHERE analysis_version_id=?
              OR (model_version_id=? AND analyzer_version=?)
           ORDER BY CASE WHEN analysis_version_id=? THEN 0 ELSE 1 END
           LIMIT 1`,
        )
        .get(
          analysisVersionId,
          modelVersionId,
          analyzerVersion,
          analysisVersionId,
        );
      if (existingRaw !== undefined) {
        const existing = mapAnalysisVersion(toRecord(existingRaw));
        if (
          (input.analysisVersionId !== undefined &&
            existing.analysisVersionId !== analysisVersionId) ||
          existing.datasetId !== datasetId ||
          existing.seriesId !== seriesId ||
          existing.modelVersionId !== modelVersionId ||
          existing.previousAnalysisVersionId !== previousAnalysisVersionId ||
          existing.status !== status ||
          existing.summaryMarkdown !== summaryMarkdown ||
          encodeJson(existing.analysis) !== analysisJson ||
          existing.analyzerVersion !== analyzerVersion
        ) {
          conflict(
            "The valuation analysis version identity was reused with different data",
          );
        }
        recordEvidenceReferences(
          this.database,
          "valuation-analysis-version",
          existing.analysisVersionId,
          nestedEvidenceIds,
        );
        return { value: existing, created: false };
      }
      const createdAt = nowIso();
      this.database
        .prepare(
          `INSERT INTO valuation_analysis_versions(
             analysis_version_id, dataset_id, series_id, model_version_id,
             previous_analysis_version_id, status, summary_markdown,
             analysis_json, analyzer_version, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          analysisVersionId,
          datasetId,
          seriesId,
          modelVersionId,
          previousAnalysisVersionId,
          status,
          summaryMarkdown,
          analysisJson,
          analyzerVersion,
          createdAt,
        );
      recordEvidenceReferences(
        this.database,
        "valuation-analysis-version",
        analysisVersionId,
        nestedEvidenceIds,
        "supports",
        createdAt,
      );
      return {
        value: this.getAnalysisVersion(datasetId, analysisVersionId),
        created: true,
      };
    });
  }

  public getAnalysisVersion(
    datasetId: string,
    analysisVersionId: string,
  ): ValuationAnalysisVersion {
    return mapAnalysisVersion(
      getRequiredRow(
        this.database,
        `SELECT * FROM valuation_analysis_versions
         WHERE dataset_id=? AND analysis_version_id=?`,
        [
          requireText(datasetId, "datasetId", 240),
          requireText(analysisVersionId, "analysisVersionId", 240),
        ],
        "Valuation analysis version",
      ),
    );
  }

  public getAnalysisForModelVersion(
    datasetId: string,
    modelVersionId: string,
    analyzerVersion: string,
  ): ValuationAnalysisVersion | null {
    const row = this.database
      .prepare(
        `SELECT * FROM valuation_analysis_versions
         WHERE dataset_id=? AND model_version_id=? AND analyzer_version=?`,
      )
      .get(
        requireText(datasetId, "datasetId", 240),
        requireText(modelVersionId, "modelVersionId", 240),
        requireText(analyzerVersion, "analyzerVersion", 120),
      );
    return row === undefined ? null : mapAnalysisVersion(toRecord(row));
  }

  public listAnalysisVersions(
    datasetId: string,
    seriesId: string,
    options: PageOptions = {},
  ): Page<ValuationAnalysisVersion> {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const normalizedSeriesId = requireText(seriesId, "seriesId", 240);
    ensureSeries(this.database, normalizedDatasetId, normalizedSeriesId);
    const page = pageOptions(options, 500);
    const items = rows(
      this.database,
      `SELECT * FROM valuation_analysis_versions
       WHERE dataset_id=? AND series_id=?
       ORDER BY created_at DESC, analysis_version_id
       LIMIT ? OFFSET ?`,
      [
        normalizedDatasetId,
        normalizedSeriesId,
        page.limit,
        page.offset,
      ],
    ).map(mapAnalysisVersion);
    const total = countRows(
      this.database,
      `SELECT COUNT(*) AS total FROM valuation_analysis_versions
       WHERE dataset_id=? AND series_id=?`,
      [normalizedDatasetId, normalizedSeriesId],
    );
    return pageResult(items, total, page);
  }

  public upsertNode(input: UpsertValuationNodeInput): ValuationModelNode {
    const seriesId = requireText(input.seriesId, "seriesId", 240);
    const canonicalKey = requireText(input.canonicalKey, "canonicalKey", 1_000);
    const nodeKind = input.nodeKind;
    assertOneOf(nodeKind, NODE_KINDS, "nodeKind");
    const nodeId =
      input.nodeId === undefined
        ? stableId("vmn", seriesId, canonicalKey)
        : requireText(input.nodeId, "nodeId", 240);
    const timestamp = nowIso();
    return withTransaction(this.database, () => {
      const existingRaw = this.database
        .prepare(
          `SELECT * FROM valuation_model_nodes
           WHERE series_id = ? AND canonical_key = ?`,
        )
        .get(seriesId, canonicalKey);
      if (
        existingRaw !== undefined &&
        input.nodeId !== undefined &&
        requiredString(toRecord(existingRaw), "node_id") !== nodeId
      ) {
        conflict("nodeId conflicts with the existing series and canonicalKey");
      }
      this.database
        .prepare(
          `INSERT INTO valuation_model_nodes(
             node_id, series_id, canonical_key, node_kind, metric_key,
             display_name, scope, period, scenario, first_seen_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(series_id, canonical_key) DO UPDATE SET
             node_kind = excluded.node_kind,
             metric_key = excluded.metric_key,
             display_name = excluded.display_name,
             scope = excluded.scope,
             period = excluded.period,
             scenario = excluded.scenario,
             updated_at = excluded.updated_at`,
        )
        .run(
          nodeId,
          seriesId,
          canonicalKey,
          nodeKind,
          requireText(input.metricKey, "metricKey", 200),
          requireText(input.displayName, "displayName", 500),
          requireText(input.scope, "scope", 200),
          optionalInputText(input.period, "period", 100),
          optionalInputText(input.scenario, "scenario", 100),
          timestamp,
          timestamp,
        );
      return mapNode(
        getRequiredRow(
          this.database,
          `SELECT * FROM valuation_model_nodes
           WHERE series_id = ? AND canonical_key = ?`,
          [seriesId, canonicalKey],
          "Valuation model node",
        ),
      );
    });
  }

  public listNodes(
    seriesId: string,
    options: PageOptions = {},
  ): Page<ValuationModelNode> {
    const normalizedSeriesId = requireText(seriesId, "seriesId", 240);
    const page = pageOptions(options, 1_000);
    const items = rows(
      this.database,
      `SELECT * FROM valuation_model_nodes
       WHERE series_id = ?
       ORDER BY canonical_key, node_id
       LIMIT ? OFFSET ?`,
      [normalizedSeriesId, page.limit, page.offset],
    ).map(mapNode);
    const total = countRows(
      this.database,
      `SELECT COUNT(*) AS total FROM valuation_model_nodes WHERE series_id = ?`,
      [normalizedSeriesId],
    );
    return pageResult(items, total, page);
  }

  public saveNodeValue(
    input: SaveValuationNodeValueInput,
  ): SaveResult<ValuationNodeValue> {
    const modelVersionId = requireText(
      input.modelVersionId,
      "modelVersionId",
      240,
    );
    const nodeId = requireText(input.nodeId, "nodeId", 240);
    const nodeValueId =
      input.nodeValueId === undefined
        ? stableId("vmnv", modelVersionId, nodeId)
        : requireText(input.nodeValueId, "nodeValueId", 240);
    const evidenceIds = normalizeEvidenceIds([
      requireText(input.evidenceId, "evidenceId", 240),
    ]);
    const evidenceId = evidenceIds[0];
    if (evidenceId === undefined) {
      throw new WorkflowStoreError("evidenceId is required", "invalid_argument");
    }
    const valueNumeric = finiteOrNull(input.valueNumeric, "valueNumeric");
    const confidence = confidenceValue(input.confidence);
    const metadata = input.metadata ?? {};

    return withTransaction(this.database, () => {
      const scope = getRequiredRow(
        this.database,
        `SELECT v.series_id AS version_series_id,
                n.series_id AS node_series_id
         FROM valuation_model_versions v
         JOIN valuation_model_nodes n ON n.node_id = ?
         WHERE v.model_version_id = ?`,
        [nodeId, modelVersionId],
        "Valuation model node or version",
      );
      if (
        requiredString(scope, "version_series_id") !==
        requiredString(scope, "node_series_id")
      ) {
        conflict("The valuation node and model version belong to different series");
      }
      const existingRaw = this.database
        .prepare(
          `SELECT * FROM valuation_model_node_values
           WHERE model_version_id = ? AND node_id = ?`,
        )
        .get(modelVersionId, nodeId);
      const serializedMetadata = encodeJson(metadata);
      const valueText = optionalInputText(input.valueText, "valueText", 50_000);
      const unit = optionalInputText(input.unit, "unit", 100);
      const formula = optionalInputText(input.formula, "formula", 50_000);
      const fingerprint = optionalInputText(
        input.formulaFingerprint,
        "formulaFingerprint",
        256,
      );
      const sheetName = requireText(input.sheetName, "sheetName", 500);
      const cellRef = requireText(input.cellRef, "cellRef", 100);
      const qualityStatus = requireText(
        input.qualityStatus,
        "qualityStatus",
        120,
      );
      if (existingRaw !== undefined) {
        const existingRow = toRecord(existingRaw);
        if (
          requiredString(existingRow, "node_value_id") !== nodeValueId ||
          nullableNumber(existingRow, "value_numeric") !== valueNumeric ||
          nullableString(existingRow, "value_text") !== valueText ||
          nullableString(existingRow, "unit") !== unit ||
          nullableString(existingRow, "formula") !== formula ||
          nullableString(existingRow, "formula_fingerprint") !== fingerprint ||
          requiredString(existingRow, "sheet_name") !== sheetName ||
          requiredString(existingRow, "cell_ref") !== cellRef ||
          requiredString(existingRow, "evidence_id") !== evidenceId ||
          requiredString(existingRow, "quality_status") !== qualityStatus ||
          numberValue(existingRow, "confidence") !== confidence ||
          stringValue(existingRow, "metadata_json") !== serializedMetadata
        ) {
          conflict("A model-version node value is immutable once recorded");
        }
        return { value: mapNodeValue(existingRow), created: false };
      }
      const timestamp = nowIso();
      this.database
        .prepare(
          `INSERT INTO valuation_model_node_values(
             node_value_id, model_version_id, node_id, value_numeric,
             value_text, unit, formula, formula_fingerprint, sheet_name,
             cell_ref, evidence_id, quality_status, confidence, metadata_json,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          nodeValueId,
          modelVersionId,
          nodeId,
          valueNumeric,
          valueText,
          unit,
          formula,
          fingerprint,
          sheetName,
          cellRef,
          evidenceId,
          qualityStatus,
          confidence,
          serializedMetadata,
          timestamp,
        );
      recordEvidenceReferences(
        this.database,
        "valuation-node-value",
        nodeValueId,
        evidenceIds,
        "source",
        timestamp,
      );
      return {
        value: mapNodeValue(
          getRequiredRow(
            this.database,
            `SELECT * FROM valuation_model_node_values
             WHERE node_value_id = ?`,
            [nodeValueId],
            "Valuation model node value",
          ),
        ),
        created: true,
      };
    });
  }

  public listNodeValues(
    modelVersionId: string,
    options: PageOptions = {},
  ): Page<ValuationNodeValue> {
    const normalizedVersionId = requireText(
      modelVersionId,
      "modelVersionId",
      240,
    );
    const page = pageOptions(options, 1_000);
    const items = rows(
      this.database,
      `SELECT * FROM valuation_model_node_values
       WHERE model_version_id = ?
       ORDER BY node_id
       LIMIT ? OFFSET ?`,
      [normalizedVersionId, page.limit, page.offset],
    ).map(mapNodeValue);
    const total = countRows(
      this.database,
      `SELECT COUNT(*) AS total FROM valuation_model_node_values
       WHERE model_version_id = ?`,
      [normalizedVersionId],
    );
    return pageResult(items, total, page);
  }

  public recordChange(
    input: RecordValuationChangeInput,
  ): SaveResult<ValuationModelChange> {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const seriesId = requireText(input.seriesId, "seriesId", 240);
    const fromId = requireText(
      input.fromModelVersionId,
      "fromModelVersionId",
      240,
    );
    const toId = requireText(
      input.toModelVersionId,
      "toModelVersionId",
      240,
    );
    if (fromId === toId) {
      throw new WorkflowStoreError(
        "A change requires two different model versions",
        "invalid_argument",
      );
    }
    const nodeId = requireText(input.nodeId, "nodeId", 240);
    const changeType = requireText(input.changeType, "changeType", 120);
    const materiality = input.materiality;
    assertOneOf(materiality, MATERIALITIES, "materiality");
    const naturalKey =
      input.idempotencyKey === undefined
        ? `${fromId}\0${toId}\0${nodeId}\0${changeType}`
        : requireText(input.idempotencyKey, "idempotencyKey", 500);
    const changeId =
      input.changeId === undefined
        ? stableId("vmc", datasetId, seriesId, naturalKey)
        : requireText(input.changeId, "changeId", 240);
    const summary = requireText(input.summary, "summary", 20_000);
    const oldValue = input.oldValue ?? {};
    const newValue = input.newValue ?? {};
    const oldJson = encodeJson(oldValue);
    const newJson = encodeJson(newValue);
    const evidenceIds = normalizeEvidenceIds(input.evidenceIds);
    const evidenceJson = encodeJson(evidenceIds);

    return withTransaction(this.database, () => {
      ensureVersionScope(this.database, fromId, datasetId, seriesId);
      ensureVersionScope(this.database, toId, datasetId, seriesId);
      const node = getRequiredRow(
        this.database,
        `SELECT series_id FROM valuation_model_nodes WHERE node_id = ?`,
        [nodeId],
        "Valuation model node",
      );
      if (requiredString(node, "series_id") !== seriesId) {
        conflict("The change node belongs to a different model series");
      }
      const existingRaw = this.database
        .prepare(
          `SELECT * FROM valuation_model_changes
           WHERE (from_model_version_id = ? AND to_model_version_id = ?
                  AND node_id = ? AND change_type = ?)
              OR change_id = ?
           LIMIT 1`,
        )
        .get(fromId, toId, nodeId, changeType, changeId);
      if (existingRaw !== undefined) {
        const existing = toRecord(existingRaw);
        if (
          requiredString(existing, "dataset_id") !== datasetId ||
          requiredString(existing, "series_id") !== seriesId ||
          requiredString(existing, "materiality") !== materiality ||
          requiredString(existing, "summary") !== summary ||
          stringValue(existing, "old_value_json") !== oldJson ||
          stringValue(existing, "new_value_json") !== newJson ||
          stringValue(existing, "evidence_ids_json") !== evidenceJson
        ) {
          conflict("The change idempotency key was reused with different data");
        }
        return { value: mapChange(existing), created: false };
      }
      const timestamp = nowIso();
      this.database
        .prepare(
          `INSERT INTO valuation_model_changes(
             change_id, dataset_id, series_id, from_model_version_id,
             to_model_version_id, node_id, change_type, materiality, summary,
             old_value_json, new_value_json, absolute_change, relative_change,
             evidence_ids_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          changeId,
          datasetId,
          seriesId,
          fromId,
          toId,
          nodeId,
          changeType,
          materiality,
          summary,
          oldJson,
          newJson,
          finiteOrNull(input.absoluteChange, "absoluteChange"),
          finiteOrNull(input.relativeChange, "relativeChange"),
          evidenceJson,
          timestamp,
        );
      recordEvidenceReferences(
        this.database,
        "valuation-change",
        changeId,
        evidenceIds,
        "supports",
        timestamp,
      );
      const ruleRows = rows(
        this.database,
        `SELECT * FROM valuation_watch_rules
         WHERE dataset_id = ? AND active = 1
           AND (series_id IS NULL OR series_id = '' OR series_id = ?)
         ORDER BY created_at, rule_id`,
        [datasetId, seriesId],
      );
      for (const ruleRow of ruleRows) {
        const rule = mapWatchRule(ruleRow);
        if (materialityRank(materiality) < materialityRank(rule.minMateriality)) {
          continue;
        }
        if (
          rule.changeTypes.length > 0 &&
          !rule.changeTypes.includes(changeType)
        ) {
          continue;
        }
        this.createAlertInternal({
          datasetId,
          seriesId,
          ruleId: rule.ruleId,
          changeId,
          alertType: changeType,
          priority: materiality,
          title: input.alertTitle ?? summary.slice(0, 500),
          summary,
          evidenceIds,
          dedupeKey: stableId("valuation-alert-dedupe", rule.ruleId, changeId),
        });
      }
      return {
        value: mapChange(
          getRequiredRow(
            this.database,
            `SELECT * FROM valuation_model_changes WHERE change_id = ?`,
            [changeId],
            "Valuation model change",
          ),
        ),
        created: true,
      };
    });
  }

  public listChanges(
    datasetId: string,
    seriesId: string,
    options: PageOptions = {},
  ): Page<ValuationModelChange> {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const normalizedSeriesId = requireText(seriesId, "seriesId", 240);
    const page = pageOptions(options, 500);
    const items = rows(
      this.database,
      `SELECT * FROM valuation_model_changes
       WHERE dataset_id = ? AND series_id = ?
       ORDER BY created_at DESC, change_id
       LIMIT ? OFFSET ?`,
      [normalizedDatasetId, normalizedSeriesId, page.limit, page.offset],
    ).map(mapChange);
    const total = countRows(
      this.database,
      `SELECT COUNT(*) AS total FROM valuation_model_changes
       WHERE dataset_id = ? AND series_id = ?`,
      [normalizedDatasetId, normalizedSeriesId],
    );
    return pageResult(items, total, page);
  }

  public countChangesByMateriality(
    datasetId: string,
  ): Readonly<Partial<Record<ValuationMateriality, number>>> {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const counts: Partial<Record<ValuationMateriality, number>> = {};
    for (const row of rows(
      this.database,
      `SELECT materiality, COUNT(*) AS total
       FROM valuation_model_changes
       WHERE dataset_id = ?
       GROUP BY materiality`,
      [normalizedDatasetId],
    )) {
      const materiality = requiredString(row, "materiality");
      assertOneOf(materiality, MATERIALITIES, "materiality");
      counts[materiality] = numberValue(row, "total");
    }
    return counts;
  }

  public compareModelVersions(
    datasetId: string,
    seriesId: string,
    fromModelVersionId: string,
    toModelVersionId: string,
  ): ValuationVersionComparison {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const normalizedSeriesId = requireText(seriesId, "seriesId", 240);
    const fromId = requireText(
      fromModelVersionId,
      "fromModelVersionId",
      240,
    );
    const toId = requireText(toModelVersionId, "toModelVersionId", 240);
    const fromVersion = this.getModelVersion(normalizedDatasetId, fromId);
    const toVersion = this.getModelVersion(normalizedDatasetId, toId);
    if (
      fromVersion.seriesId !== normalizedSeriesId ||
      toVersion.seriesId !== normalizedSeriesId
    ) {
      throw new WorkflowStoreError(
        "Valuation versions belong to a different series",
        "invalid_argument",
      );
    }
    const changes = rows(
      this.database,
      `SELECT * FROM valuation_model_changes
       WHERE dataset_id=? AND series_id=?
         AND from_model_version_id=? AND to_model_version_id=?
       ORDER BY CASE materiality
         WHEN 'critical' THEN 3 WHEN 'high' THEN 2
         WHEN 'medium' THEN 1 ELSE 0 END DESC,
         created_at, change_id`,
      [normalizedDatasetId, normalizedSeriesId, fromId, toId],
    ).map(mapChange);
    const valueRows = (modelVersionId: string): ValuationNodeValue[] =>
      rows(
        this.database,
        `SELECT * FROM valuation_model_node_values
         WHERE model_version_id=? ORDER BY node_id`,
        [modelVersionId],
      ).map(mapNodeValue);
    return {
      series: this.getSeries(normalizedDatasetId, normalizedSeriesId),
      fromVersion,
      toVersion,
      changes,
      fromValues: valueRows(fromId),
      toValues: valueRows(toId),
    };
  }

  public upsertMetricModelValue(
    input: UpsertMetricModelValueInput,
  ): ValuationMetricModelValue {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const seriesId = requireText(input.seriesId, "seriesId", 240);
    const modelVersionId = requireText(
      input.modelVersionId,
      "modelVersionId",
      240,
    );
    const metricKey = requireText(input.metricKey, "metricKey", 200);
    if (!(metricKey in VALUATION_METRIC_DEFINITIONS)) {
      throw new WorkflowStoreError(
        `Unsupported valuation metric: ${metricKey}`,
        "invalid_argument",
      );
    }
    const metricDefinition =
      VALUATION_METRIC_DEFINITIONS[metricKey as ValuationMetricKey];
    const unit = requireText(input.unit, "unit", 100);
    if (unit !== metricDefinition.unit) {
      throw new WorkflowStoreError(
        `${metricKey} requires unit ${metricDefinition.unit}`,
        "invalid_argument",
      );
    }
    const modelMetricId =
      input.modelMetricId === undefined
        ? stableId("vmm", modelVersionId, metricKey)
        : requireText(input.modelMetricId, "modelMetricId", 240);
    const evidenceIds = normalizeEvidenceIds(input.evidenceIds);
    const timestamp = nowIso();
    return withTransaction(this.database, () => {
      ensureVersionScope(this.database, modelVersionId, datasetId, seriesId);
      this.database
        .prepare(
          `INSERT INTO valuation_metric_model_values(
             model_metric_id, dataset_id, series_id, model_version_id,
             metric_key, value_numeric, unit, period, status, method, source,
             evidence_ids_json, quality_status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(model_version_id, metric_key) DO UPDATE SET
             value_numeric = excluded.value_numeric,
             unit = excluded.unit,
             period = excluded.period,
             status = excluded.status,
             method = excluded.method,
             source = excluded.source,
             evidence_ids_json = excluded.evidence_ids_json,
             quality_status = excluded.quality_status,
             created_at = excluded.created_at`,
        )
        .run(
          modelMetricId,
          datasetId,
          seriesId,
          modelVersionId,
          metricKey,
          finiteOrNull(input.valueNumeric, "valueNumeric"),
          unit,
          optionalInputText(input.period, "period", 100),
          requireText(input.status, "status", 100),
          requireText(input.method, "method", 300),
          optionalInputText(input.source, "source", 2_000),
          encodeJson(evidenceIds),
          requireText(
            input.qualityStatus ?? "review_required",
            "qualityStatus",
            120,
          ),
          timestamp,
        );
      const saved = mapMetricModelValue(
        getRequiredRow(
          this.database,
          `SELECT * FROM valuation_metric_model_values
           WHERE model_version_id = ? AND metric_key = ?`,
          [modelVersionId, metricKey],
          "Valuation model metric",
        ),
      );
      replaceEvidenceReferences(
        this.database,
        "valuation-model-metric",
        saved.modelMetricId,
        evidenceIds,
        "supports",
        timestamp,
      );
      return saved;
    });
  }

  public listMetricModelValues(
    modelVersionId: string,
  ): ValuationMetricModelValue[] {
    return rows(
      this.database,
      `SELECT * FROM valuation_metric_model_values
       WHERE model_version_id = ?
       ORDER BY metric_key`,
      [requireText(modelVersionId, "modelVersionId", 240)],
    ).map(mapMetricModelValue);
  }

  public createMarketSnapshot(
    input: CreateMarketSnapshotInput,
  ): SaveResult<ValuationMarketSnapshot> {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const seriesId = requireText(input.seriesId, "seriesId", 240);
    const modelVersionId = requireText(
      input.modelVersionId,
      "modelVersionId",
      240,
    );
    const provider = requireText(input.provider, "provider", 200);
    const explicitIdempotencyKey =
      input.idempotencyKey === undefined
        ? null
        : requireText(input.idempotencyKey, "idempotencyKey", 500);
    const idempotencyKey =
      explicitIdempotencyKey ??
      `${modelVersionId}\0${provider}\0${input.asOf ?? "pending"}`;
    const snapshotId =
      input.snapshotId === undefined
        ? stableId("vmsnap", datasetId, seriesId, idempotencyKey)
        : requireText(input.snapshotId, "snapshotId", 240);
    const status = input.status ?? "pending";
    assertOneOf(status, SNAPSHOT_STATUSES, "status");
    const rawJson = encodeJson(input.raw ?? {});
    const companyName = optionalInputText(
      input.companyName,
      "companyName",
      500,
    );
    const companyTicker = optionalInputText(
      input.companyTicker,
      "companyTicker",
      100,
    );
    const asOf = optionalInputText(input.asOf, "asOf", 100);
    const errorMessage = optionalInputText(
      input.errorMessage,
      "errorMessage",
      4_000,
    );
    if (
      (status === "failed" || status === "unavailable") &&
      errorMessage === null
    ) {
      throw new WorkflowStoreError(
        `${status} snapshots require errorMessage`,
        "invalid_argument",
      );
    }
    return withTransaction(this.database, () => {
      ensureVersionScope(this.database, modelVersionId, datasetId, seriesId);
      const existingRaw = this.database
        .prepare(
          `SELECT * FROM valuation_market_snapshots
           WHERE snapshot_id = ?
              OR (? IS NOT NULL AND idempotency_key = ?)
           LIMIT 1`,
        )
        .get(snapshotId, explicitIdempotencyKey, explicitIdempotencyKey);
      if (existingRaw !== undefined) {
        const existing = mapSnapshot(toRecord(existingRaw));
        if (
          existing.snapshotId !== snapshotId ||
          existing.datasetId !== datasetId ||
          existing.seriesId !== seriesId ||
          existing.modelVersionId !== modelVersionId ||
          existing.companyName !== companyName ||
          existing.companyTicker !== companyTicker ||
          existing.provider !== provider ||
          existing.status !== status ||
          existing.asOf !== asOf ||
          existing.errorMessage !== errorMessage ||
          encodeJson(existing.raw) !== rawJson
        ) {
          conflict("The snapshot idempotency key was reused with different data");
        }
        return { value: existing, created: false };
      }
      this.database
        .prepare(
          `INSERT INTO valuation_market_snapshots(
             snapshot_id, dataset_id, series_id, model_version_id,
             company_name, company_ticker, provider, status, as_of,
             error_message, raw_json, idempotency_key, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          snapshotId,
          datasetId,
          seriesId,
          modelVersionId,
          companyName,
          companyTicker,
          provider,
          status,
          asOf,
          errorMessage,
          rawJson,
          explicitIdempotencyKey,
          nowIso(),
        );
      return {
        value: this.getMarketSnapshot(datasetId, snapshotId),
        created: true,
      };
    });
  }

  public getMarketSnapshot(
    datasetId: string,
    snapshotId: string,
  ): ValuationMarketSnapshot {
    return mapSnapshot(
      getRequiredRow(
        this.database,
        `SELECT * FROM valuation_market_snapshots
         WHERE dataset_id = ? AND snapshot_id = ?`,
        [
          requireText(datasetId, "datasetId", 240),
          requireText(snapshotId, "snapshotId", 240),
        ],
        "Valuation market snapshot",
      ),
    );
  }

  public transitionMarketSnapshot(
    datasetId: string,
    snapshotId: string,
    input: TransitionMarketSnapshotInput,
  ): ValuationMarketSnapshot {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const normalizedSnapshotId = requireText(snapshotId, "snapshotId", 240);
    const nextStatus = input.status;
    assertOneOf(nextStatus, SNAPSHOT_STATUSES, "status");
    return withTransaction(this.database, () => {
      const current = this.getMarketSnapshot(
        normalizedDatasetId,
        normalizedSnapshotId,
      );
      const allowed: Record<
        ValuationSnapshotStatus,
        readonly ValuationSnapshotStatus[]
      > = {
        pending: ["pending", "running", "completed", "failed", "unavailable"],
        running: ["running", "completed", "failed", "unavailable"],
        completed: ["completed"],
        failed: ["failed", "pending", "running"],
        unavailable: ["unavailable", "pending", "running"],
      };
      if (!allowed[current.status].includes(nextStatus)) {
        throw new WorkflowStoreError(
          `Market snapshot cannot transition from ${current.status} to ${nextStatus}`,
          "invalid_state",
        );
      }
      const nextRaw = input.raw === undefined ? current.raw : input.raw;
      const nextAsOf =
        input.asOf === undefined
          ? current.asOf
          : optionalInputText(input.asOf, "asOf", 100);
      const nextError =
        input.errorMessage === undefined
          ? nextStatus === "failed" || nextStatus === "unavailable"
            ? current.errorMessage
            : null
          : optionalInputText(input.errorMessage, "errorMessage", 4_000);
      if (
        (nextStatus === "failed" || nextStatus === "unavailable") &&
        nextError === null
      ) {
        throw new WorkflowStoreError(
          `${nextStatus} snapshots require errorMessage`,
          "invalid_argument",
        );
      }
      this.database
        .prepare(
          `UPDATE valuation_market_snapshots
           SET status = ?, as_of = ?, error_message = ?, raw_json = ?
           WHERE dataset_id = ? AND snapshot_id = ?`,
        )
        .run(
          nextStatus,
          nextAsOf,
          nextError,
          encodeJson(nextRaw),
          normalizedDatasetId,
          normalizedSnapshotId,
        );
      return this.getMarketSnapshot(
        normalizedDatasetId,
        normalizedSnapshotId,
      );
    });
  }

  public listMarketSnapshots(
    datasetId: string,
    seriesId: string,
    options: PageOptions = {},
  ): Page<ValuationMarketSnapshot> {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const normalizedSeriesId = requireText(seriesId, "seriesId", 240);
    const page = pageOptions(options, 500);
    const items = rows(
      this.database,
      `SELECT * FROM valuation_market_snapshots
       WHERE dataset_id = ? AND series_id = ?
       ORDER BY created_at DESC, snapshot_id DESC
       LIMIT ? OFFSET ?`,
      [normalizedDatasetId, normalizedSeriesId, page.limit, page.offset],
    ).map(mapSnapshot);
    const total = countRows(
      this.database,
      `SELECT COUNT(*) AS total FROM valuation_market_snapshots
       WHERE dataset_id = ? AND series_id = ?`,
      [normalizedDatasetId, normalizedSeriesId],
    );
    return pageResult(items, total, page);
  }

  public upsertMetricActualValue(
    input: UpsertMetricActualValueInput,
  ): ValuationMetricActualValue {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const seriesId = requireText(input.seriesId, "seriesId", 240);
    const modelVersionId = requireText(
      input.modelVersionId,
      "modelVersionId",
      240,
    );
    const snapshotId = requireText(input.snapshotId, "snapshotId", 240);
    const metricKey = requireText(input.metricKey, "metricKey", 200);
    const actualMetricId =
      input.actualMetricId === undefined
        ? stableId("vma", snapshotId, metricKey)
        : requireText(input.actualMetricId, "actualMetricId", 240);
    return withTransaction(this.database, () => {
      const snapshot = this.getMarketSnapshot(datasetId, snapshotId);
      if (
        snapshot.seriesId !== seriesId ||
        snapshot.modelVersionId !== modelVersionId
      ) {
        conflict("Metric actual value scope differs from its market snapshot");
      }
      this.database
        .prepare(
          `INSERT INTO valuation_metric_actual_values(
             actual_metric_id, snapshot_id, dataset_id, series_id,
             model_version_id, metric_key, value_numeric, unit, period,
             status, source, observed_at, metadata_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(snapshot_id, metric_key) DO UPDATE SET
             value_numeric = excluded.value_numeric,
             unit = excluded.unit,
             period = excluded.period,
             status = excluded.status,
             source = excluded.source,
             observed_at = excluded.observed_at,
             metadata_json = excluded.metadata_json,
             created_at = excluded.created_at`,
        )
        .run(
          actualMetricId,
          snapshotId,
          datasetId,
          seriesId,
          modelVersionId,
          metricKey,
          finiteOrNull(input.valueNumeric, "valueNumeric"),
          requireText(input.unit, "unit", 100),
          optionalInputText(input.period, "period", 100),
          requireText(input.status, "status", 100),
          optionalInputText(input.source, "source", 2_000),
          optionalInputText(input.observedAt, "observedAt", 100),
          encodeJson(input.metadata ?? {}),
          nowIso(),
        );
      return mapMetricActualValue(
        getRequiredRow(
          this.database,
          `SELECT * FROM valuation_metric_actual_values
           WHERE snapshot_id = ? AND metric_key = ?`,
          [snapshotId, metricKey],
          "Valuation actual metric",
        ),
      );
    });
  }

  public listMetricActualValues(
    snapshotId: string,
  ): ValuationMetricActualValue[] {
    return rows(
      this.database,
      `SELECT * FROM valuation_metric_actual_values
       WHERE snapshot_id = ? ORDER BY metric_key`,
      [requireText(snapshotId, "snapshotId", 240)],
    ).map(mapMetricActualValue);
  }

  public upsertMetricComparison(
    input: UpsertMetricComparisonInput,
  ): ValuationMetricComparison {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const seriesId = requireText(input.seriesId, "seriesId", 240);
    const modelVersionId = requireText(
      input.modelVersionId,
      "modelVersionId",
      240,
    );
    const snapshotId = requireText(input.snapshotId, "snapshotId", 240);
    const metricKey = requireText(input.metricKey, "metricKey", 200);
    const comparisonId =
      input.comparisonId === undefined
        ? stableId("vmcmp", modelVersionId, snapshotId, metricKey)
        : requireText(input.comparisonId, "comparisonId", 240);
    const evidenceIds = normalizeEvidenceIds(input.evidenceIds);
    const timestamp = nowIso();
    return withTransaction(this.database, () => {
      const snapshot = this.getMarketSnapshot(datasetId, snapshotId);
      if (
        snapshot.seriesId !== seriesId ||
        snapshot.modelVersionId !== modelVersionId
      ) {
        conflict("Metric comparison scope differs from its market snapshot");
      }
      this.database
        .prepare(
          `INSERT INTO valuation_metric_comparisons(
             comparison_id, dataset_id, series_id, model_version_id,
             snapshot_id, metric_key, model_value, actual_value, absolute_gap,
             relative_gap, severity, status, explanation, model_period,
             actual_period, model_source, actual_source, evidence_ids_json,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(model_version_id, snapshot_id, metric_key) DO UPDATE SET
             model_value = excluded.model_value,
             actual_value = excluded.actual_value,
             absolute_gap = excluded.absolute_gap,
             relative_gap = excluded.relative_gap,
             severity = excluded.severity,
             status = excluded.status,
             explanation = excluded.explanation,
             model_period = excluded.model_period,
             actual_period = excluded.actual_period,
             model_source = excluded.model_source,
             actual_source = excluded.actual_source,
             evidence_ids_json = excluded.evidence_ids_json,
             created_at = excluded.created_at`,
        )
        .run(
          comparisonId,
          datasetId,
          seriesId,
          modelVersionId,
          snapshotId,
          metricKey,
          finiteOrNull(input.modelValue, "modelValue"),
          finiteOrNull(input.actualValue, "actualValue"),
          finiteOrNull(input.absoluteGap, "absoluteGap"),
          finiteOrNull(input.relativeGap, "relativeGap"),
          requireText(input.severity, "severity", 100),
          requireText(input.status, "status", 100),
          String(input.explanation ?? "").slice(0, 20_000),
          optionalInputText(input.modelPeriod, "modelPeriod", 100),
          optionalInputText(input.actualPeriod, "actualPeriod", 100),
          optionalInputText(input.modelSource, "modelSource", 2_000),
          optionalInputText(input.actualSource, "actualSource", 2_000),
          encodeJson(evidenceIds),
          timestamp,
        );
      const saved = mapMetricComparison(
        getRequiredRow(
          this.database,
          `SELECT * FROM valuation_metric_comparisons
           WHERE model_version_id = ? AND snapshot_id = ? AND metric_key = ?`,
          [modelVersionId, snapshotId, metricKey],
          "Valuation metric comparison",
        ),
      );
      replaceEvidenceReferences(
        this.database,
        "valuation-metric-comparison",
        saved.comparisonId,
        evidenceIds,
        "supports",
        timestamp,
      );
      return saved;
    });
  }

  public listMetricComparisons(
    snapshotId: string,
  ): ValuationMetricComparison[] {
    return rows(
      this.database,
      `SELECT * FROM valuation_metric_comparisons
       WHERE snapshot_id = ? ORDER BY metric_key`,
      [requireText(snapshotId, "snapshotId", 240)],
    ).map(mapMetricComparison);
  }

  public upsertManualMetricOverride(
    input: UpsertManualMetricOverrideInput,
  ): ValuationMetricManualOverride {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const seriesId = requireText(input.seriesId, "seriesId", 240);
    const modelVersionId = requireText(
      input.modelVersionId,
      "modelVersionId",
      240,
    );
    const metricKey = requireText(input.metricKey, "metricKey", 200);
    if (!(metricKey in VALUATION_METRIC_DEFINITIONS)) {
      throw new WorkflowStoreError(
        `Unsupported valuation metric: ${metricKey}`,
        "invalid_argument",
      );
    }
    const metricDefinition =
      VALUATION_METRIC_DEFINITIONS[metricKey as ValuationMetricKey];
    const overrideId =
      input.overrideId === undefined
        ? stableId("vmmo", modelVersionId, metricKey)
        : requireText(input.overrideId, "overrideId", 240);
    const valueNumeric = finiteOrNull(input.valueNumeric, "valueNumeric");
    if (valueNumeric === null) {
      throw new WorkflowStoreError(
        "valueNumeric is required for a manual override",
        "invalid_argument",
      );
    }
    assertPlausibleManualMetric(metricKey as ValuationMetricKey, valueNumeric);
    const qualityStatus = input.qualityStatus ?? "manual_verified";
    assertOneOf(
      qualityStatus,
      MANUAL_QUALITY_STATUSES,
      "qualityStatus",
    );
    const evidenceIds = normalizeEvidenceIds(input.evidenceIds);
    if (evidenceIds.length === 0) {
      throw new WorkflowStoreError(
        "A manual metric override requires source evidence",
        "invalid_argument",
      );
    }
    if (evidenceIds.length < metricDefinition.minimumEvidence) {
      throw new WorkflowStoreError(
        `Insufficient source evidence for ${metricKey}`,
        "invalid_argument",
      );
    }
    const unresolvedEvidence = evidenceIds.filter(
      (evidenceId) => !evidenceReferenceExists(this.database, evidenceId),
    );
    if (unresolvedEvidence.length > 0) {
      throw new WorkflowStoreError(
        `Unresolved manual evidence: ${unresolvedEvidence.join(", ")}`,
        "invalid_argument",
      );
    }
    const unit = requireText(input.unit, "unit", 100);
    if (unit !== metricDefinition.unit) {
      throw new WorkflowStoreError(
        `${metricKey} requires unit ${metricDefinition.unit}`,
        "invalid_argument",
      );
    }
    const timestamp = nowIso();
    return withTransaction(this.database, () => {
      ensureVersionScope(this.database, modelVersionId, datasetId, seriesId);
      this.database
        .prepare(
          `INSERT INTO valuation_metric_manual_overrides(
             override_id, dataset_id, series_id, model_version_id, metric_key,
             value_numeric, unit, period, method, source, evidence_ids_json,
             derivation, quality_status, reviewer, review_note, is_active,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(model_version_id, metric_key) DO UPDATE SET
             value_numeric = excluded.value_numeric,
             unit = excluded.unit,
             period = excluded.period,
             method = excluded.method,
             source = excluded.source,
             evidence_ids_json = excluded.evidence_ids_json,
             derivation = excluded.derivation,
             quality_status = excluded.quality_status,
             reviewer = excluded.reviewer,
             review_note = excluded.review_note,
             is_active = 1,
             updated_at = excluded.updated_at`,
        )
        .run(
          overrideId,
          datasetId,
          seriesId,
          modelVersionId,
          metricKey,
          valueNumeric,
          unit,
          requireText(input.period, "period", 100),
          requireText(
            input.method ?? "manual_override:source_verified",
            "method",
            300,
          ),
          requireText(input.source, "source", 2_000),
          encodeJson(evidenceIds),
          requireText(input.derivation, "derivation", 20_000),
          qualityStatus,
          requireText(input.reviewer, "reviewer", 500),
          String(input.reviewNote ?? "").trim().slice(0, 4_000),
          timestamp,
          timestamp,
        );
      const saved = mapManualOverride(
        getRequiredRow(
          this.database,
          `SELECT * FROM valuation_metric_manual_overrides
           WHERE model_version_id = ? AND metric_key = ?`,
          [modelVersionId, metricKey],
          "Manual valuation metric override",
        ),
      );
      replaceEvidenceReferences(
        this.database,
        "valuation-metric-override",
        saved.overrideId,
        evidenceIds,
        "supports",
        timestamp,
      );
      return saved;
    });
  }

  public setManualMetricOverrideActive(
    datasetId: string,
    overrideId: string,
    active: boolean,
  ): ValuationMetricManualOverride {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const normalizedOverrideId = requireText(overrideId, "overrideId", 240);
    return withTransaction(this.database, () => {
      const result = this.database
        .prepare(
          `UPDATE valuation_metric_manual_overrides
           SET is_active = ?, updated_at = ?
           WHERE dataset_id = ? AND override_id = ?`,
        )
        .run(
          boolInt(active),
          nowIso(),
          normalizedDatasetId,
          normalizedOverrideId,
        );
      if (result.changes !== 1) {
        throw new WorkflowStoreError(
          "Manual valuation metric override was not found",
          "not_found",
        );
      }
      return mapManualOverride(
        getRequiredRow(
          this.database,
          `SELECT * FROM valuation_metric_manual_overrides
           WHERE dataset_id = ? AND override_id = ?`,
          [normalizedDatasetId, normalizedOverrideId],
          "Manual valuation metric override",
        ),
      );
    });
  }

  public listManualMetricOverrides(
    modelVersionId: string,
    activeOnly = false,
  ): ValuationMetricManualOverride[] {
    return rows(
      this.database,
      `SELECT * FROM valuation_metric_manual_overrides
       WHERE model_version_id = ?
         AND (? = 0 OR is_active = 1)
       ORDER BY updated_at DESC, metric_key`,
      [
        requireText(modelVersionId, "modelVersionId", 240),
        boolInt(activeOnly),
      ],
    ).map(mapManualOverride);
  }

  public createAgentAnalysis(
    input: CreateAgentAnalysisInput,
  ): SaveResult<ValuationAgentAnalysis> {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const seriesId = requireText(input.seriesId, "seriesId", 240);
    const baseId = requireText(
      input.baseModelVersionId,
      "baseModelVersionId",
      240,
    );
    const comparisonId = optionalInputText(
      input.comparisonModelVersionId,
      "comparisonModelVersionId",
      240,
    );
    const focus = String(input.focus ?? "").trim().slice(0, 2_000);
    const agentVersion = requireText(input.agentVersion, "agentVersion", 120);
    const explicitIdempotencyKey =
      input.idempotencyKey === undefined
        ? null
        : requireText(input.idempotencyKey, "idempotencyKey", 500);
    const idempotencyKey =
      explicitIdempotencyKey ??
      `${baseId}\0${comparisonId ?? ""}\0${focus}\0${agentVersion}`;
    const analysisId =
      input.analysisId === undefined
        ? stableId("vaa", datasetId, seriesId, idempotencyKey)
        : requireText(input.analysisId, "analysisId", 240);
    return withTransaction(this.database, () => {
      ensureVersionScope(this.database, baseId, datasetId, seriesId);
      if (comparisonId !== null) {
        ensureVersionScope(this.database, comparisonId, datasetId, seriesId);
      }
      const existingRaw = this.database
        .prepare(
          `SELECT * FROM valuation_agent_analyses
           WHERE analysis_id = ?
              OR (? IS NOT NULL AND idempotency_key = ?)
              OR (
                base_model_version_id = ?
                AND COALESCE(comparison_model_version_id, '') = ?
                AND focus = ?
                AND agent_version = ?
              )
           LIMIT 1`,
        )
        .get(
          analysisId,
          explicitIdempotencyKey,
          explicitIdempotencyKey,
          baseId,
          comparisonId ?? "",
          focus,
          agentVersion,
        );
      if (existingRaw !== undefined) {
        const existing = mapAgentAnalysis(toRecord(existingRaw));
        if (
          (input.analysisId !== undefined &&
            existing.analysisId !== analysisId) ||
          existing.datasetId !== datasetId ||
          existing.seriesId !== seriesId ||
          existing.baseModelVersionId !== baseId ||
          existing.comparisonModelVersionId !== comparisonId ||
          existing.focus !== focus ||
          existing.agentVersion !== agentVersion
        ) {
          conflict("The analysis idempotency key was reused with different data");
        }
        return { value: existing, created: false };
      }
      const timestamp = nowIso();
      this.database
        .prepare(
          `INSERT INTO valuation_agent_analyses(
             analysis_id, dataset_id, series_id, base_model_version_id,
             comparison_model_version_id, status, focus, valuation_method,
             executive_summary, investment_conclusion, analysis_json,
             planner_json, evidence_ids_json, raw_response, model_name,
             agent_version, error_message, idempotency_key, created_at,
             updated_at, completed_at
           ) VALUES (
             ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, '{}', '{}', '[]',
             NULL, NULL, ?, NULL, ?, ?, ?, NULL
           )`,
        )
        .run(
          analysisId,
          datasetId,
          seriesId,
          baseId,
          comparisonId,
          focus,
          agentVersion,
          explicitIdempotencyKey,
          timestamp,
          timestamp,
        );
      return {
        value: this.getAgentAnalysis(datasetId, analysisId),
        created: true,
      };
    });
  }

  public getAgentAnalysis(
    datasetId: string,
    analysisId: string,
  ): ValuationAgentAnalysis {
    return mapAgentAnalysis(
      getRequiredRow(
        this.database,
        `SELECT * FROM valuation_agent_analyses
         WHERE dataset_id = ? AND analysis_id = ?`,
        [
          requireText(datasetId, "datasetId", 240),
          requireText(analysisId, "analysisId", 240),
        ],
        "Valuation agent analysis",
      ),
    );
  }

  public transitionAgentAnalysis(
    datasetId: string,
    analysisId: string,
    input: TransitionAgentAnalysisInput,
  ): ValuationAgentAnalysis {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const normalizedAnalysisId = requireText(analysisId, "analysisId", 240);
    const nextStatus = input.status;
    assertOneOf(nextStatus, ANALYSIS_STATUSES, "status");
    return withTransaction(this.database, () => {
      const current = this.getAgentAnalysis(
        normalizedDatasetId,
        normalizedAnalysisId,
      );
      const allowed: Record<
        ValuationAnalysisStatus,
        readonly ValuationAnalysisStatus[]
      > = {
        pending: ["pending", "running", "failed"],
        running: ["running", "completed", "failed"],
        completed: ["completed"],
        failed: ["failed", "pending", "running"],
      };
      if (!allowed[current.status].includes(nextStatus)) {
        throw new WorkflowStoreError(
          `Agent analysis cannot transition from ${current.status} to ${nextStatus}`,
          "invalid_state",
        );
      }
      const evidenceIds =
        input.evidenceIds === undefined
          ? current.evidenceIds
          : normalizeEvidenceIds(input.evidenceIds);
      const analysis = input.analysis ?? current.analysis;
      const planner = input.planner ?? current.planner;
      const valuationMethod =
        input.valuationMethod === undefined
          ? current.valuationMethod
          : optionalInputText(input.valuationMethod, "valuationMethod", 300);
      const executiveSummary =
        input.executiveSummary === undefined
          ? current.executiveSummary
          : optionalInputText(
              input.executiveSummary,
              "executiveSummary",
              20_000,
            );
      const investmentConclusion =
        input.investmentConclusion === undefined
          ? current.investmentConclusion
          : optionalInputText(
              input.investmentConclusion,
              "investmentConclusion",
              20_000,
            );
      const errorMessage =
        input.errorMessage === undefined
          ? nextStatus === "failed"
            ? current.errorMessage
            : null
          : optionalInputText(input.errorMessage, "errorMessage", 4_000);
      const rawResponse =
        input.rawResponse === undefined
          ? current.rawResponse
          : optionalInputText(input.rawResponse, "rawResponse", 100_000);
      const modelName =
        input.modelName === undefined
          ? current.modelName
          : optionalInputText(input.modelName, "modelName", 300);
      if (nextStatus === "completed" && Object.keys(analysis).length === 0) {
        throw new WorkflowStoreError(
          "A completed analysis requires a non-empty analysis payload",
          "invalid_argument",
        );
      }
      if (nextStatus === "failed" && errorMessage === null) {
        throw new WorkflowStoreError(
          "A failed analysis requires errorMessage",
          "invalid_argument",
        );
      }
      if (current.status === "completed") {
        const unchanged =
          valuationMethod === current.valuationMethod &&
          executiveSummary === current.executiveSummary &&
          investmentConclusion === current.investmentConclusion &&
          encodeJson(analysis) === encodeJson(current.analysis) &&
          encodeJson(planner) === encodeJson(current.planner) &&
          encodeJson([...evidenceIds].sort()) ===
            encodeJson([...current.evidenceIds].sort()) &&
          rawResponse === current.rawResponse &&
          modelName === current.modelName &&
          errorMessage === current.errorMessage;
        if (!unchanged) {
          throw new WorkflowStoreError(
            "A completed agent analysis cannot be overwritten",
            "conflict",
          );
        }
        return current;
      }
      const timestamp = nowIso();
      const completedAt =
        nextStatus === "completed" || nextStatus === "failed" ? timestamp : null;
      this.database
        .prepare(
          `UPDATE valuation_agent_analyses
           SET status = ?, valuation_method = ?, executive_summary = ?,
               investment_conclusion = ?, analysis_json = ?, planner_json = ?,
               evidence_ids_json = ?, raw_response = ?, model_name = ?,
               error_message = ?, updated_at = ?, completed_at = ?
           WHERE dataset_id = ? AND analysis_id = ?`,
        )
        .run(
          nextStatus,
          valuationMethod,
          executiveSummary,
          investmentConclusion,
          encodeJson(analysis),
          encodeJson(planner),
          encodeJson(evidenceIds),
          rawResponse,
          modelName,
          errorMessage,
          timestamp,
          completedAt,
          normalizedDatasetId,
          normalizedAnalysisId,
        );
      replaceEvidenceReferences(
        this.database,
        "valuation-agent-analysis",
        normalizedAnalysisId,
        evidenceIds,
        "supports",
        timestamp,
      );
      return this.getAgentAnalysis(
        normalizedDatasetId,
        normalizedAnalysisId,
      );
    });
  }

  public listAgentAnalyses(
    datasetId: string,
    options: PageOptions & { readonly seriesId?: string } = {},
  ): Page<ValuationAgentAnalysis> {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const seriesId =
      options.seriesId === undefined
        ? null
        : requireText(options.seriesId, "seriesId", 240);
    const page = pageOptions(options, 200);
    const items = rows(
      this.database,
      `SELECT * FROM valuation_agent_analyses
       WHERE dataset_id = ? AND (? IS NULL OR series_id = ?)
       ORDER BY created_at DESC, analysis_id
       LIMIT ? OFFSET ?`,
      [
        normalizedDatasetId,
        seriesId,
        seriesId,
        page.limit,
        page.offset,
      ],
    ).map(mapAgentAnalysis);
    const total = countRows(
      this.database,
      `SELECT COUNT(*) AS total FROM valuation_agent_analyses
       WHERE dataset_id = ? AND (? IS NULL OR series_id = ?)`,
      [normalizedDatasetId, seriesId, seriesId],
    );
    return pageResult(items, total, page);
  }

  public saveDerivedModel(
    input: SaveDerivedModelInput,
  ): SaveResult<ValuationDerivedModel> {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const seriesId = requireText(input.seriesId, "seriesId", 240);
    const analysisId = requireText(input.analysisId, "analysisId", 240);
    const baseId = requireText(
      input.baseModelVersionId,
      "baseModelVersionId",
      240,
    );
    const checksum = requireText(input.checksum, "checksum", 128);
    const derivedModelId =
      input.derivedModelId === undefined
        ? stableId("vdm", analysisId, checksum)
        : requireText(input.derivedModelId, "derivedModelId", 240);
    const appliedJson = encodeJson(input.appliedChanges ?? []);
    const skippedJson = encodeJson(input.skippedChanges ?? []);
    return withTransaction(this.database, () => {
      const analysis = this.getAgentAnalysis(datasetId, analysisId);
      if (
        analysis.seriesId !== seriesId ||
        analysis.baseModelVersionId !== baseId ||
        analysis.status !== "completed"
      ) {
        throw new WorkflowStoreError(
          "A derived model requires a completed analysis in the same series and version",
          "invalid_state",
        );
      }
      const existingRaw = this.database
        .prepare(
          `SELECT * FROM valuation_derived_models
           WHERE analysis_id = ? OR derived_model_id = ? LIMIT 1`,
        )
        .get(analysisId, derivedModelId);
      if (existingRaw !== undefined) {
        const existingRow = toRecord(existingRaw);
        const existing = mapDerivedModel(existingRow);
        if (
          existing.datasetId !== datasetId ||
          existing.seriesId !== seriesId ||
          existing.baseModelVersionId !== baseId ||
          existing.checksum !== checksum ||
          stringValue(existingRow, "applied_changes_json") !== appliedJson ||
          stringValue(existingRow, "skipped_changes_json") !== skippedJson
        ) {
          conflict("An analysis can only produce one immutable derived model");
        }
        return { value: existing, created: false };
      }
      this.database
        .prepare(
          `INSERT INTO valuation_derived_models(
             derived_model_id, dataset_id, series_id, analysis_id,
             base_model_version_id, derived_version_no, output_filename,
             output_path, checksum, applied_changes_json, skipped_changes_json,
             resource_file_name, resource_pipeline_job_id, resource_status,
             resource_doc_id, resource_added_at, resource_error, created_at
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'not_added',
             NULL, NULL, NULL, ?
           )`,
        )
        .run(
          derivedModelId,
          datasetId,
          seriesId,
          analysisId,
          baseId,
          positiveInteger(input.derivedVersionNo, "derivedVersionNo"),
          requireText(input.outputFilename, "outputFilename", 1_000),
          requireText(input.outputPath, "outputPath", 8_000),
          checksum,
          appliedJson,
          skippedJson,
          nowIso(),
        );
      return {
        value: this.getDerivedModel(datasetId, derivedModelId),
        created: true,
      };
    });
  }

  public getDerivedModel(
    datasetId: string,
    derivedModelId: string,
  ): ValuationDerivedModel {
    return mapDerivedModel(
      getRequiredRow(
        this.database,
        `SELECT * FROM valuation_derived_models
         WHERE dataset_id = ? AND derived_model_id = ?`,
        [
          requireText(datasetId, "datasetId", 240),
          requireText(derivedModelId, "derivedModelId", 240),
        ],
        "Valuation derived model",
      ),
    );
  }

  public transitionDerivedResource(
    datasetId: string,
    derivedModelId: string,
    input: TransitionDerivedResourceInput,
  ): ValuationDerivedModel {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const normalizedDerivedId = requireText(
      derivedModelId,
      "derivedModelId",
      240,
    );
    const nextStatus = input.status;
    assertOneOf(nextStatus, RESOURCE_STATUSES, "status");
    return withTransaction(this.database, () => {
      const current = this.getDerivedModel(
        normalizedDatasetId,
        normalizedDerivedId,
      );
      const allowed: Record<
        ValuationResourceStatus,
        readonly ValuationResourceStatus[]
      > = {
        not_added: ["not_added", "queued"],
        queued: ["queued", "running", "completed", "failed"],
        running: ["running", "completed", "failed"],
        completed: ["completed"],
        failed: ["failed", "queued", "running"],
      };
      if (!allowed[current.resourceStatus].includes(nextStatus)) {
        throw new WorkflowStoreError(
          `Derived-model resource cannot transition from ${current.resourceStatus} to ${nextStatus}`,
          "invalid_state",
        );
      }
      const fileName =
        input.fileName === undefined
          ? current.resourceFileName
          : optionalInputText(input.fileName, "fileName", 1_000);
      const pipelineJobId =
        input.pipelineJobId === undefined
          ? current.resourcePipelineJobId
          : optionalInputText(input.pipelineJobId, "pipelineJobId", 240);
      const documentId =
        input.documentId === undefined
          ? current.resourceDocId
          : optionalInputText(input.documentId, "documentId", 240);
      const errorMessage =
        input.errorMessage === undefined
          ? nextStatus === "failed"
            ? current.resourceError
            : null
          : optionalInputText(input.errorMessage, "errorMessage", 4_000);
      if (nextStatus === "queued" && (fileName === null || pipelineJobId === null)) {
        throw new WorkflowStoreError(
          "Queued resource imports require fileName and pipelineJobId",
          "invalid_argument",
        );
      }
      if (nextStatus === "completed" && documentId === null) {
        throw new WorkflowStoreError(
          "Completed resource imports require documentId",
          "invalid_argument",
        );
      }
      if (nextStatus === "failed" && errorMessage === null) {
        throw new WorkflowStoreError(
          "Failed resource imports require errorMessage",
          "invalid_argument",
        );
      }
      this.database
        .prepare(
          `UPDATE valuation_derived_models
           SET resource_file_name = ?, resource_pipeline_job_id = ?,
               resource_status = ?, resource_doc_id = ?,
               resource_added_at = ?, resource_error = ?
           WHERE dataset_id = ? AND derived_model_id = ?`,
        )
        .run(
          fileName,
          pipelineJobId,
          nextStatus,
          nextStatus === "queued" ? null : documentId,
          nextStatus === "queued" || nextStatus === "completed"
            ? nowIso()
            : current.resourceAddedAt,
          errorMessage,
          normalizedDatasetId,
          normalizedDerivedId,
        );
      return this.getDerivedModel(
        normalizedDatasetId,
        normalizedDerivedId,
      );
    });
  }

  public listDerivedModels(
    datasetId: string,
    options: PageOptions & { readonly seriesId?: string } = {},
  ): Page<ValuationDerivedModel> {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const seriesId =
      options.seriesId === undefined
        ? null
        : requireText(options.seriesId, "seriesId", 240);
    const page = pageOptions(options, 200);
    const items = rows(
      this.database,
      `SELECT * FROM valuation_derived_models
       WHERE dataset_id = ? AND (? IS NULL OR series_id = ?)
       ORDER BY created_at DESC, derived_model_id
       LIMIT ? OFFSET ?`,
      [
        normalizedDatasetId,
        seriesId,
        seriesId,
        page.limit,
        page.offset,
      ],
    ).map(mapDerivedModel);
    const total = countRows(
      this.database,
      `SELECT COUNT(*) AS total FROM valuation_derived_models
       WHERE dataset_id = ? AND (? IS NULL OR series_id = ?)`,
      [normalizedDatasetId, seriesId, seriesId],
    );
    return pageResult(items, total, page);
  }

  public upsertWatchRule(
    input: UpsertValuationWatchRuleInput,
  ): ValuationWatchRule {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const seriesId = optionalInputText(input.seriesId, "seriesId", 240);
    const name = requireText(input.name, "name", 500);
    const minMateriality = input.minMateriality ?? "medium";
    assertOneOf(minMateriality, MATERIALITIES, "minMateriality");
    const idempotencyKey =
      input.idempotencyKey === undefined
        ? `${seriesId ?? "*"}\0${name}`
        : requireText(input.idempotencyKey, "idempotencyKey", 500);
    const adoptedRule =
      input.ruleId === undefined
        ? this.database
            .prepare(
              `SELECT rule_id FROM valuation_watch_rules
               WHERE dataset_id=? AND COALESCE(series_id, '')=COALESCE(?, '')
                 AND name=?
               ORDER BY created_at LIMIT 1`,
            )
            .get(datasetId, seriesId, name)
        : undefined;
    const ruleId =
      input.ruleId === undefined
        ? adoptedRule === undefined
          ? stableId("vwr", datasetId, idempotencyKey)
          : requiredString(toRecord(adoptedRule), "rule_id")
        : requireText(input.ruleId, "ruleId", 240);
    const changeTypes = normalizeStringList(input.changeTypes, "changeType");
    return withTransaction(this.database, () => {
      if (seriesId !== null) {
        ensureSeries(this.database, datasetId, seriesId);
      }
      const timestamp = nowIso();
      this.database
        .prepare(
          `INSERT INTO valuation_watch_rules(
             rule_id, dataset_id, series_id, name, min_materiality,
             change_types_json, active, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(rule_id) DO UPDATE SET
             name = excluded.name,
             min_materiality = excluded.min_materiality,
             change_types_json = excluded.change_types_json,
             active = excluded.active,
             updated_at = excluded.updated_at`,
        )
        .run(
          ruleId,
          datasetId,
          seriesId,
          name,
          minMateriality,
          encodeJson(changeTypes),
          boolInt(input.active ?? true),
          timestamp,
          timestamp,
        );
      const saved = mapWatchRule(
        getRequiredRow(
          this.database,
          `SELECT * FROM valuation_watch_rules
           WHERE dataset_id = ? AND rule_id = ?`,
          [datasetId, ruleId],
          "Valuation watch rule",
        ),
      );
      if (saved.seriesId !== seriesId) {
        conflict("The rule idempotency key belongs to a different series");
      }
      return saved;
    });
  }

  public updateWatchRule(
    datasetId: string,
    ruleId: string,
    input: UpdateWatchRuleInput,
  ): ValuationWatchRule {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const normalizedRuleId = requireText(ruleId, "ruleId", 240);
    return withTransaction(this.database, () => {
      const current = mapWatchRule(
        getRequiredRow(
          this.database,
          `SELECT * FROM valuation_watch_rules
           WHERE dataset_id = ? AND rule_id = ?`,
          [normalizedDatasetId, normalizedRuleId],
          "Valuation watch rule",
        ),
      );
      const materiality = input.minMateriality ?? current.minMateriality;
      assertOneOf(materiality, MATERIALITIES, "minMateriality");
      this.database
        .prepare(
          `UPDATE valuation_watch_rules
           SET name = ?, min_materiality = ?, change_types_json = ?,
               active = ?, updated_at = ?
           WHERE dataset_id = ? AND rule_id = ?`,
        )
        .run(
          input.name === undefined
            ? current.name
            : requireText(input.name, "name", 500),
          materiality,
          encodeJson(
            input.changeTypes === undefined
              ? current.changeTypes
              : normalizeStringList(input.changeTypes, "changeType"),
          ),
          boolInt(input.active ?? current.active),
          nowIso(),
          normalizedDatasetId,
          normalizedRuleId,
        );
      return mapWatchRule(
        getRequiredRow(
          this.database,
          `SELECT * FROM valuation_watch_rules
           WHERE dataset_id = ? AND rule_id = ?`,
          [normalizedDatasetId, normalizedRuleId],
          "Valuation watch rule",
        ),
      );
    });
  }

  public listWatchRules(
    datasetId: string,
    options: PageOptions = {},
  ): Page<ValuationWatchRule> {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const page = pageOptions(options, 500);
    const items = rows(
      this.database,
      `SELECT * FROM valuation_watch_rules
       WHERE dataset_id = ?
       ORDER BY created_at, rule_id
       LIMIT ? OFFSET ?`,
      [normalizedDatasetId, page.limit, page.offset],
    ).map(mapWatchRule);
    const total = countRows(
      this.database,
      `SELECT COUNT(*) AS total FROM valuation_watch_rules
       WHERE dataset_id = ?`,
      [normalizedDatasetId],
    );
    return pageResult(items, total, page);
  }

  public createAlert(
    input: CreateValuationAlertInput,
  ): SaveResult<ValuationAlert> {
    return withTransaction(this.database, () => this.createAlertInternal(input));
  }

  private createAlertInternal(
    input: CreateValuationAlertInput,
  ): SaveResult<ValuationAlert> {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const seriesId = requireText(input.seriesId, "seriesId", 240);
    const dedupeKey = requireText(input.dedupeKey, "dedupeKey", 500);
    const changeId = requireText(input.changeId, "changeId", 240);
    const alertType = requireText(input.alertType, "alertType", 120);
    const priority = requireText(input.priority, "priority", 100);
    assertOneOf(priority, MATERIALITIES, "priority");
    const title = requireText(input.title, "title", 500);
    const summary = requireText(input.summary, "summary", 20_000);
    const ruleId = optionalInputText(input.ruleId, "ruleId", 240);
    const alertId =
      input.alertId === undefined
        ? stableId("val", datasetId, dedupeKey)
        : requireText(input.alertId, "alertId", 240);
    const evidenceIds = normalizeEvidenceIds(input.evidenceIds);
    const existingRaw = this.database
      .prepare(
        `SELECT * FROM valuation_alerts
         WHERE dedupe_key = ? OR alert_id = ? LIMIT 1`,
      )
      .get(dedupeKey, alertId);
    if (existingRaw !== undefined) {
      const existing = mapAlert(toRecord(existingRaw));
      if (
        existing.datasetId !== datasetId ||
        existing.seriesId !== seriesId ||
        existing.ruleId !== ruleId ||
        existing.changeId !== changeId ||
        existing.alertType !== alertType ||
        existing.priority !== priority ||
        existing.title !== title ||
        existing.summary !== summary ||
        encodeJson([...existing.evidenceIds].sort()) !==
          encodeJson([...evidenceIds].sort())
      ) {
        conflict("The alert dedupe key was reused with different data");
      }
      return { value: existing, created: false };
    }
    ensureSeries(this.database, datasetId, seriesId);
    getRequiredRow(
      this.database,
      `SELECT change_id FROM valuation_model_changes
       WHERE dataset_id=? AND series_id=? AND change_id=?`,
      [datasetId, seriesId, changeId],
      "Valuation model change",
    );
    if (ruleId !== null) {
      const rule = getRequiredRow(
        this.database,
        `SELECT rule_id, series_id FROM valuation_watch_rules
         WHERE dataset_id = ? AND rule_id = ?`,
        [datasetId, ruleId],
        "Valuation watch rule",
      );
      const ruleSeriesId =
        rule.series_id === null ? null : requiredString(rule, "series_id");
      if (ruleSeriesId !== null && ruleSeriesId !== seriesId) {
        conflict("The valuation watch rule belongs to another series");
      }
    }
    const timestamp = nowIso();
    this.database
      .prepare(
        `INSERT INTO valuation_alerts(
           alert_id, dataset_id, series_id, rule_id, change_id, alert_type,
           priority, title, summary, evidence_ids_json, status, snoozed_until,
           dedupe_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', NULL, ?, ?, ?)`,
      )
      .run(
        alertId,
        datasetId,
        seriesId,
        ruleId,
        changeId,
        alertType,
        priority,
        title,
        summary,
        encodeJson(evidenceIds),
        dedupeKey,
        timestamp,
        timestamp,
      );
    recordEvidenceReferences(
      this.database,
      "valuation-alert",
      alertId,
      evidenceIds,
      "supports",
      timestamp,
    );
    return {
      value: mapAlert(
        getRequiredRow(
          this.database,
          `SELECT * FROM valuation_alerts WHERE alert_id = ?`,
          [alertId],
          "Valuation alert",
        ),
      ),
      created: true,
    };
  }

  public updateAlertStatus(
    datasetId: string,
    alertId: string,
    status: ValuationAlertStatus,
    snoozedUntil?: string | null,
  ): ValuationAlert {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const normalizedAlertId = requireText(alertId, "alertId", 240);
    assertOneOf(status, ALERT_STATUSES, "status");
    return withTransaction(this.database, () => {
      const current = mapAlert(
        getRequiredRow(
          this.database,
          `SELECT * FROM valuation_alerts
           WHERE dataset_id = ? AND alert_id = ?`,
          [normalizedDatasetId, normalizedAlertId],
          "Valuation alert",
        ),
      );
      const allowed: Record<
        ValuationAlertStatus,
        readonly ValuationAlertStatus[]
      > = {
        new: ["new", "acknowledged", "dismissed", "snoozed"],
        acknowledged: ["acknowledged", "dismissed", "new"],
        dismissed: ["dismissed", "new"],
        snoozed: ["snoozed", "new", "acknowledged", "dismissed"],
      };
      if (!allowed[current.status].includes(status)) {
        throw new WorkflowStoreError(
          `Alert cannot transition from ${current.status} to ${status}`,
          "invalid_state",
        );
      }
      let normalizedSnooze: string | null = null;
      if (status === "snoozed") {
        if (snoozedUntil === undefined || snoozedUntil === null) {
          throw new WorkflowStoreError(
            "snoozedUntil is required for a snoozed alert",
            "invalid_argument",
          );
        }
        normalizedSnooze = assertIsoDate(
          requireText(snoozedUntil, "snoozedUntil", 100),
          "snoozedUntil",
        );
        if (Date.parse(normalizedSnooze) <= Date.now()) {
          throw new WorkflowStoreError(
            "snoozedUntil must be in the future",
            "invalid_argument",
          );
        }
      }
      this.database
        .prepare(
          `UPDATE valuation_alerts
           SET status = ?, snoozed_until = ?, updated_at = ?
           WHERE dataset_id = ? AND alert_id = ?`,
        )
        .run(
          status,
          normalizedSnooze,
          nowIso(),
          normalizedDatasetId,
          normalizedAlertId,
        );
      return mapAlert(
        getRequiredRow(
          this.database,
          `SELECT * FROM valuation_alerts
           WHERE dataset_id = ? AND alert_id = ?`,
          [normalizedDatasetId, normalizedAlertId],
          "Valuation alert",
        ),
      );
    });
  }

  public releaseExpiredSnoozes(
    datasetId: string,
    at = new Date(),
  ): number {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const timestamp = nowIso(at);
    return withTransaction(this.database, () => {
      const result = this.database
        .prepare(
          `UPDATE valuation_alerts
           SET status = 'new', snoozed_until = NULL, updated_at = ?
           WHERE dataset_id = ? AND status = 'snoozed'
             AND snoozed_until IS NOT NULL AND snoozed_until <= ?`,
        )
        .run(timestamp, normalizedDatasetId, timestamp);
      return Number(result.changes);
    });
  }

  public listAlerts(
    datasetId: string,
    options: ListAlertOptions = {},
  ): Page<ValuationAlert> {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const status = options.status ?? null;
    if (status !== null) {
      assertOneOf(status, ALERT_STATUSES, "status");
    }
    const seriesId =
      options.seriesId === undefined
        ? null
        : requireText(options.seriesId, "seriesId", 240);
    const alertType =
      options.alertType === undefined
        ? null
        : requireText(options.alertType, "alertType", 120);
    const page = pageOptions(options, 500);
    const predicate = `
      dataset_id = ?
      AND (? IS NULL OR status = ?)
      AND (? IS NULL OR series_id = ?)
      AND (? IS NULL OR alert_type = ?)
    `;
    const params: (null | number | string)[] = [
      normalizedDatasetId,
      status,
      status,
      seriesId,
      seriesId,
      alertType,
      alertType,
    ];
    const items = rows(
      this.database,
      `SELECT * FROM valuation_alerts
       WHERE ${predicate}
       ORDER BY
         CASE priority
           WHEN 'critical' THEN 4
           WHEN 'high' THEN 3
           WHEN 'medium' THEN 2
           WHEN 'low' THEN 1
           ELSE 0
         END DESC,
         created_at DESC,
         alert_id
       LIMIT ? OFFSET ?`,
      [...params, page.limit, page.offset],
    ).map(mapAlert);
    const total = countRows(
      this.database,
      `SELECT COUNT(*) AS total FROM valuation_alerts WHERE ${predicate}`,
      params,
    );
    return pageResult(items, total, page);
  }

  public getLatestMetricBundle(
    datasetId: string,
    seriesId: string,
    modelVersionId: string,
  ): LatestValuationMetricBundle {
    const normalizedDatasetId = requireText(datasetId, "datasetId", 240);
    const normalizedSeriesId = requireText(seriesId, "seriesId", 240);
    const normalizedVersionId = requireText(
      modelVersionId,
      "modelVersionId",
      240,
    );
    ensureVersionScope(
      this.database,
      normalizedVersionId,
      normalizedDatasetId,
      normalizedSeriesId,
    );
    const snapshotRaw = this.database
      .prepare(
        `SELECT * FROM valuation_market_snapshots
         WHERE dataset_id = ? AND series_id = ? AND model_version_id = ?
         ORDER BY created_at DESC, snapshot_id DESC LIMIT 1`,
      )
      .get(normalizedDatasetId, normalizedSeriesId, normalizedVersionId);
    const snapshot =
      snapshotRaw === undefined ? null : mapSnapshot(toRecord(snapshotRaw));
    return {
      snapshot,
      modelValues: this.listMetricModelValues(normalizedVersionId),
      actualValues:
        snapshot === null ? [] : this.listMetricActualValues(snapshot.snapshotId),
      comparisons:
        snapshot === null ? [] : this.listMetricComparisons(snapshot.snapshotId),
      manualOverrides: this.listManualMetricOverrides(
        normalizedVersionId,
        false,
      ),
    };
  }
}
