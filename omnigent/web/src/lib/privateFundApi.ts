import { authenticatedFetch } from "./identity";

export const PRIVATE_FUND_DATASET_ID_LABEL_KEY = "private_fund.dataset_id";
export const PRIVATE_FUND_DATASET_NAME_LABEL_KEY = "private_fund.dataset_name";
export const ACTIVE_PRIVATE_FUND_PROJECT_STORAGE_KEY = "omnigent.privateFund.activeProject";
export const ACTIVE_PRIVATE_FUND_PROJECT_CHANGED_EVENT =
  "omnigent.privateFund.activeProjectChanged";
export const PRIVATE_FUND_RESEARCH_MODE_STORAGE_KEY = "omnigent.privateFund.researchMode";
export const PRIVATE_FUND_CONTEXT_START = "<!-- omnigent-private-fund-context:start -->";
export const PRIVATE_FUND_CONTEXT_END = "<!-- omnigent-private-fund-context:end -->";

export type PrivateFundResearchMode = "standard" | "deep";

export function wrapPrivateFundPromptContext(context: string): string {
  const normalized = context.trim();
  if (!normalized) return "";
  return `${PRIVATE_FUND_CONTEXT_START}\n${normalized}\n${PRIVATE_FUND_CONTEXT_END}\n\n`;
}

export interface PrivateFundPipelineJob {
  jobId: string;
  datasetId: string;
  status: "queued" | "running" | "completed" | "failed" | string;
  createdAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  message?: string | null;
  result?: unknown;
}

export interface PrivateFundGlobalUploadCandidate {
  datasetId: string;
  projectName: string;
  companyName: string;
  companyTicker: string;
  score: number;
  method: string;
}

export interface PrivateFundGlobalUploadItem {
  itemId: string;
  batchId: string;
  fileName: string;
  fileType: string;
  size: number;
  checksum: string;
  status: string;
  companyName: string;
  companyTicker: string;
  companyConfidence: number;
  companyDetectionMethod: string;
  matchedDatasetId?: string | null;
  matchedProjectName: string;
  projectMatchConfidence: number;
  projectMatchMethod: string;
  candidateProjects: PrivateFundGlobalUploadCandidate[];
  pipelineJobId?: string | null;
  errorMessage?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface PrivateFundGlobalUploadBatch {
  batchId: string;
  status: string;
  fileCount: number;
  message: string;
  counts: Record<string, number>;
  items: PrivateFundGlobalUploadItem[];
  createdAt?: string | null;
  updatedAt?: string | null;
  finishedAt?: string | null;
}

export interface PrivateFundTokenUsage {
  datasetId: string;
  sessionCount: number;
  sessionsWithTokenUsage: number;
  sessionsWithTotalTokens: number;
  sessionsWithCost: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  totalCostUsd: number | null;
}

export interface PrivateFundProject {
  datasetId: string;
  name: string;
  status: string;
  sourceDir?: string | null;
  datasetRoot?: string | null;
  uploadsDir?: string | null;
  companyName?: string | null;
  companyTicker?: string | null;
  fileCount: number;
  uploadCount: number;
  documentCount: number;
  indexedDocumentCount: number;
  failedDocumentCount: number;
  chunkCount: number;
  indexCount: number;
  memoCount: number;
  latestMemoPath?: string | null;
  latestMemoName?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  indexReady: boolean;
  latestJob?: PrivateFundPipelineJob | null;
  tokenUsage?: PrivateFundTokenUsage | null;
}

export interface PrivateFundFile {
  name: string;
  fileType: string;
  size: number;
  uploadedAt?: string | null;
  sourcePath?: string | null;
  status: string;
  docId?: string | null;
  chunkCount: number;
  errorMessage?: string | null;
  storedPath?: string | null;
  docType?: string;
  docSubtype?: string | null;
  docTypeConfidence?: number;
  classificationStatus?: "pending" | "accepted" | "needs_review" | "company_conflict" | string;
  classificationMethod?: string | null;
  companyName?: string | null;
  companyTicker?: string | null;
  companyConfidence?: number;
}

export interface PrivateFundSourceFolderFile {
  fileName: string;
  assignment: "auto" | "manual";
}

export interface PrivateFundSourceFolder {
  folderId: string;
  name: string;
  kind: "auto" | "custom" | "system";
  classificationKey?: string | null;
  files: PrivateFundSourceFolderFile[];
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PrivateFundSourceFolderTree {
  datasetId: string;
  folders: PrivateFundSourceFolder[];
}

export type PrivateFundAssetType =
  | "document"
  | "information"
  | "analysis"
  | "metrics"
  | "table"
  | "chart"
  | "infographic"
  | "memo"
  | string;

export type PrivateFundDisplayGroup =
  | "source"
  | "answer_note"
  | "research_note"
  | "memo"
  | "report"
  | "other";

export interface PrivateFundAsset {
  assetId: string;
  assetType: PrivateFundAssetType;
  title: string;
  summary: string;
  contentMarkdown: string;
  format: string;
  status: string;
  sourceKind: string;
  sourceId?: string | null;
  tags: string[];
  createdAt?: string | null;
  updatedAt?: string | null;
  versionNo: number;
  evidenceCount: number;
  fileType?: string | null;
  storedPath?: string | null;
  metadata: Record<string, unknown>;
  /** User-facing catalog group (资料 / 回答笔记 / 研究笔记 / Memo / …). */
  displayGroup: PrivateFundDisplayGroup;
  displayLabel: string;
}

export function inferDisplayGroup(assetType: string, sourceKind = ""): PrivateFundDisplayGroup {
  if (assetType === "document" || sourceKind === "document") return "source";
  if (assetType === "information" || sourceKind === "saved_information") return "answer_note";
  if (assetType === "analysis" || sourceKind === "research_node") return "research_note";
  if (sourceKind === "research_node_block") return "research_note";
  if (assetType === "memo" || sourceKind === "memo") return "memo";
  if (assetType === "report" || sourceKind === "equity_report") return "report";
  if (["metrics", "table", "chart", "infographic"].includes(assetType)) return "research_note";
  return "other";
}

export function displayLabelForGroup(group: PrivateFundDisplayGroup, assetType = ""): string {
  switch (group) {
    case "source":
      return "资料";
    case "answer_note":
      return "回答笔记";
    case "research_note":
      return assetType === "analysis" || !assetType ? "研究笔记" : "研究笔记";
    case "memo":
      return "Memo";
    case "report":
      return "专业研报";
    default:
      return assetType || "条目";
  }
}

/** Collapse legacy block:* context ids onto parent research notes. */
export function normalizeContextAssetIds(assetIds: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of assetIds) {
    let id = String(raw || "").trim();
    if (!id) continue;
    if (id.startsWith("block:")) {
      const rest = id.slice("block:".length);
      const idx = rest.lastIndexOf(":");
      const nodeId = idx >= 0 ? rest.slice(0, idx) : rest;
      if (nodeId) id = `node:${nodeId}`;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export interface PrivateFundAssetCatalog {
  assets: PrivateFundAsset[];
  contextAssetIds: string[];
}

export type PrivateFundResearchNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "stale"
  | "failed";

export type PrivateFundRichContentBlock =
  | { type: "markdown"; title?: string; markdown: string; evidenceIds?: string[] }
  | {
      type: "metrics";
      title?: string;
      evidenceIds?: string[];
      items: Array<{
        label: string;
        value: string;
        unit?: string;
        delta?: string;
        sentiment?: "positive" | "negative" | "neutral";
      }>;
    }
  | {
      type: "table";
      title?: string;
      evidenceIds?: string[];
      columns: Array<{ key: string; label: string; align?: "left" | "right" }>;
      rows: Array<Record<string, string>>;
    }
  | {
      type: "chart";
      title?: string;
      evidenceIds?: string[];
      chart_type: "line" | "bar";
      x_key: string;
      series: Array<{ key: string; label: string }>;
      data: Array<Record<string, string | number | null>>;
      y_unit?: string;
      source_note?: string;
    }
  | { type: "html"; title?: string; html: string; height?: number; evidenceIds?: string[] };

export interface PrivateFundEvidenceSource {
  evidenceId: string;
  relationType: string;
  citation: string;
  documentName: string;
  sourcePath?: string | null;
  storedPath?: string | null;
  pageStart?: number | null;
  pageEnd?: number | null;
  slideStart?: number | null;
  slideEnd?: number | null;
  sheetName?: string | null;
  cellRange?: string | null;
  headingPath?: string | null;
  excerpt?: string | null;
  sourceUrl?: string | null;
  markdownCitation?: string | null;
}

export interface PrivateFundResearchNode {
  nodeId: string;
  nodeType: string;
  title: string;
  objective: string;
  summary: string;
  status: PrivateFundResearchNodeStatus;
  currentVersionNo: number;
  positionNo: number;
  x: number;
  y: number;
  tone: "sage" | "mist" | "sand" | "coral" | "blue" | "lilac";
  kind:
    | "source"
    | "analysis"
    | "assumption"
    | "scenario"
    | "defensive"
    | "base"
    | "growth"
    | "valuation"
    | "conclusion";
  assumptionCount: number;
  latestOutput?: string | null;
  contentBlocks: PrivateFundRichContentBlock[];
  evidenceSources?: PrivateFundEvidenceSource[];
}

export interface PrivateFundResearchEdge {
  edgeId: string;
  source: string;
  target: string;
  dependencyType: string;
}

export interface PrivateFundResearchWorkflow {
  workflowId: string;
  datasetId: string;
  workflowType: string;
  status: string;
  currentNodeId: string;
  createdAt: string;
  updatedAt: string;
  contextNodeIds: string[];
  nodes: PrivateFundResearchNode[];
  edges: PrivateFundResearchEdge[];
}

export interface PrivateFundResearchReportVersion {
  reportId: string;
  reportVersionId: string;
  versionNo: number;
  title: string;
  markdown: string;
  nodeVersions: Record<string, string>;
  documentVersions: Array<Record<string, unknown>>;
  createdAt: string;
}

export interface PrivateFundTrackingJob {
  jobId: string;
  jobType: string;
  sourceId: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  lastError?: string | null;
  result?: Record<string, unknown> | null;
}

export interface PrivateFundResearchItemVersion {
  itemVersionId: string;
  versionNo: number;
  asOfDate?: string | null;
  sourcePublishedAt?: string | null;
  observedAt: string;
  sourceType: string;
  sourceId: string;
  content: string;
  stance: string;
  state: string;
  valueNumeric?: number | null;
  valueText?: string | null;
  unit?: string | null;
  period?: string | null;
  scenario?: string | null;
  probability?: string | null;
  impact: string;
  confidence: number;
  expectedStart?: string | null;
  expectedEnd?: string | null;
  evidenceIds: string[];
  evidenceSources?: PrivateFundTrackingEvidenceSource[];
  metadata?: Record<string, unknown>;
  title?: string;
  fieldChanges: Array<{
    field: string;
    label: string;
    before: unknown;
    after: unknown;
    changeKind: "added" | "removed" | "changed";
  }>;
}

export interface PrivateFundTrackingEvidenceSource {
  evidenceId: string;
  citation: string;
  documentName: string;
  excerpt: string;
  fullContent: string;
  sourceUrl?: string | null;
  pageStart?: number | null;
  pageEnd?: number | null;
  sheetName?: string | null;
  cellRange?: string | null;
}

export interface PrivateFundResearchItem {
  itemId: string;
  itemType: string;
  canonicalKey: string;
  title: string;
  status: string;
  currentVersionNo: number;
  currentVersionId?: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  currentVersion?: PrivateFundResearchItemVersion | null;
  archivedAt?: string | null;
  archiveReason?: string | null;
  qualityIssue?: string | null;
}

export interface PrivateFundResearchAlert {
  alertId: string;
  ruleId?: string | null;
  itemId: string;
  changeEventId?: string | null;
  alertType: string;
  priority: string;
  title: string;
  summary: string;
  whyItMatters: string;
  evidenceIds: string[];
  status: string;
  dueAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrivateFundWatchRule {
  ruleId: string;
  name: string;
  targetType: string;
  targetItemId?: string | null;
  query: Record<string, unknown>;
  minPriority: string;
  frequency: string;
  active: boolean;
}

export interface PrivateFundMemoSeries {
  seriesId: string;
  topic: string;
  title: string;
  currentVersionNo: number;
  versionCount: number;
  currentMemoVersionId?: string | null;
  updatedAt: string;
}

export interface PrivateFundMemoVersion {
  memoVersionId: string;
  seriesId: string;
  versionNo: number;
  revisionOfVersionId?: string | null;
  asOfDate: string;
  status: string;
  topic: string;
  seriesTitle: string;
  markdownPath?: string | null;
  htmlPath?: string | null;
  pdfPath?: string | null;
  createdAt: string;
  sections: Array<{
    sectionId: string;
    sectionKey: string;
    title: string;
    content: string;
    evidenceIds: string[];
    needsReview: boolean;
  }>;
}

export interface PrivateFundMemoComparison {
  fromVersion: PrivateFundMemoVersion;
  toVersion: PrivateFundMemoVersion;
  sectionChanges: Array<{
    sectionKey: string;
    title: string;
    changeType: string;
    similarity: number;
    oldContent: string;
    newContent: string;
    oldEvidenceIds: string[];
    newEvidenceIds: string[];
  }>;
  itemChanges: Array<Record<string, unknown>>;
}

export interface PrivateFundTrackingOverview {
  datasetId: string;
  schemaVersion: number;
  rebuildRequired: boolean;
  legacyItemCount: number;
  counts: Record<string, number>;
  unreadAlertCount: number;
  qualityCounts: Record<string, number>;
  governanceCounts: {
    activeUnqualified: number;
    archived: number;
  };
  items: PrivateFundResearchItem[];
  alerts: PrivateFundResearchAlert[];
  watchRules: PrivateFundWatchRule[];
  jobs: PrivateFundTrackingJob[];
  memoSeries: PrivateFundMemoSeries[];
  memoVersions: PrivateFundMemoVersion[];
}

export interface PrivateFundValuationTrackingJob {
  jobId: string;
  jobType: string;
  sourceId: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  lastError?: string | null;
  result?: Record<string, unknown> | null;
  payload?: Record<string, unknown>;
}

export interface PrivateFundValuationAnalysis {
  analysisVersionId: string;
  status: string;
  summaryMarkdown: string;
  analysis: Record<string, unknown>;
  analyzerVersion: string;
  createdAt: string;
}

export interface PrivateFundValuationModelVersion {
  modelVersionId: string;
  documentVersionNo: number;
  originalFilename: string;
  nodeCount: number;
  formulaNodeCount: number;
  reviewRequiredCount: number;
  revertedToVersionId?: string | null;
  createdAt: string;
  analysis?: PrivateFundValuationAnalysis | null;
}

export interface PrivateFundValuationOverviewValue {
  period: string;
  value: number | null;
  valueText?: string;
  evidenceId: string;
  source: string;
  qualityStatus?: string;
  confidence?: number;
}

export interface PrivateFundValuationStatementTable {
  statementType: string;
  title: string;
  sheetName: string;
  periods: string[];
  rows: Array<{
    metricKey: string;
    metricName: string;
    unit: string;
    rowIndex: number;
    values: Array<PrivateFundValuationOverviewValue | null>;
  }>;
  sourceRefs: string[];
}

export interface PrivateFundValuationTrendSeries {
  metricKey: string;
  label: string;
  statementType: string;
  unit: string;
  sheetName: string;
  values: PrivateFundValuationOverviewValue[];
}

export interface PrivateFundValuationKeyMetric {
  metricKey: string;
  label: string;
  period: string;
  valueNumeric: number | null;
  valueText: string;
  unit: string;
  evidenceId: string;
  source: string;
}

export interface PrivateFundValuationModelOverview {
  overviewId: string;
  datasetId: string;
  seriesId: string;
  modelVersionId: string;
  docId: string;
  status: string;
  overviewVersion: string;
  createdAt: string;
  html: string;
  overview: {
    schemaVersion: number;
    modelName: string;
    companyName: string;
    companyTicker: string;
    modelVersionNo: number;
    modelType: string;
    originalFilename: string;
    generatedAt: string;
    summary: {
      detectedStatements: string[];
      missingStatements: string[];
      statementCount: number;
      trendCount: number;
      keyMetricCount: number;
      periodStart: string;
      periodEnd: string;
      periods: string[];
      factCount: number;
      reviewRequiredCount: number;
      qualityFlags: string[];
    };
    keyMetrics: PrivateFundValuationKeyMetric[];
    trends: PrivateFundValuationTrendSeries[];
    statements: PrivateFundValuationStatementTable[];
  };
}

export interface PrivateFundValuationMetricComparison {
  comparisonId: string;
  metricKey: string;
  label: string;
  unit: "percent" | "percentage_point" | "multiple" | "currency" | string;
  description: string;
  modelValue: number | null;
  actualValue: number | null;
  absoluteGap: number | null;
  relativeGap: number | null;
  severity: "normal" | "warning" | "critical" | "unavailable" | string;
  status: string;
  explanation: string;
  modelPeriod: string;
  actualPeriod: string;
  modelSource: string;
  modelMethod?: string;
  actualSource: string;
  modelQualityStatus: string;
  evidenceIds: string[];
  createdAt: string;
}

export interface PrivateFundValuationMetricTimelinePeriod {
  period: string;
  label: string;
  status: string;
  modelAvailableCount: number;
  actualAvailableCount: number;
  comparedCount: number;
  alertCount: number;
  observedAt: string;
  comparisons: PrivateFundValuationMetricComparison[];
}

export interface PrivateFundValuationMetricTimeline {
  defaultPeriod: string;
  latestPeriod: string;
  periods: PrivateFundValuationMetricTimelinePeriod[];
}

export interface PrivateFundValuationMarketSnapshot {
  label: string;
  period?: string;
  errorMessage?: string;
  asOf: string;
  status: string;
  modelAvailableCount: number;
  actualAvailableCount: number;
  comparedCount: number;
  periodMismatchCount: number;
  comparisons: PrivateFundValuationMetricComparison[];
}

export interface PrivateFundMarketDataProviderAttempt {
  provider: string;
  status: string;
  fieldsFound: string[];
  errorMessage: string;
  durationMs: number;
}

export interface PrivateFundValuationMarketDataStatus {
  snapshotId: string;
  provider: string;
  status: string;
  asOf: string;
  errorMessage: string;
  providerAttempts: PrivateFundMarketDataProviderAttempt[];
  createdAt: string;
  isStale: boolean;
  identitySnapshot: Record<string, unknown>;
}

export interface PrivateFundValuationPriceComparison {
  priceComparisonId: string;
  snapshotId: string;
  provider: string;
  providerSymbol: string;
  currency: string;
  valuationDate: string;
  benchmarkTradeDate: string;
  benchmarkClose: number | null;
  latestTradeDate: string;
  latestClose: number | null;
  targetPrice: number | null;
  targetUnit: string;
  targetSource: string;
  targetEvidenceId: string;
  impliedUpside: number | null;
  latestUpside: number | null;
  status: string;
  errorMessage: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface PrivateFundValuationContextCard {
  cardId: string;
  cardType: string;
  title: string;
  summary: string;
  insight: string;
  sourceName: string;
  documentDate: string;
  evidenceIds: string[];
}

export interface PrivateFundValuationImpactCard {
  cardId: string;
  direction: "up" | "down" | "mixed";
  horizon: string;
  confidence: number;
  title: string;
  evidenceSummary: string;
  valuationImpact: string;
  affectedInputs: string[];
  watchItems: string[];
  sourceRefs: string[];
  evidenceIds: string[];
  evidenceLocations: Array<Record<string, unknown>>;
  createdAt: string;
}

export interface PrivateFundValuationImpactAnalysis {
  runId: string;
  status: string;
  sourceFingerprint: string;
  extractorVersion: string;
  skillName: string;
  analysisSummary: string;
  warnings: string[];
  cards: PrivateFundValuationImpactCard[];
  errorMessage: string;
  updatedAt: string;
}

export interface PrivateFundValuationMetricAnalysis {
  marketData: PrivateFundValuationMarketDataStatus;
  metricComparisons: PrivateFundValuationMetricComparison[];
  marketSnapshot?: PrivateFundValuationMarketSnapshot;
  metricTimeline?: PrivateFundValuationMetricTimeline;
  contextCards: PrivateFundValuationContextCard[];
  valuationImpacts: PrivateFundValuationImpactAnalysis;
}

export interface PrivateFundValuationModelIdentityAudit {
  auditId: string;
  oldCompanyName?: string | null;
  oldCompanyTicker?: string | null;
  newCompanyName?: string | null;
  newCompanyTicker?: string | null;
  changeSource: string;
  actor: string;
  validationStatus: string;
  validationReasons: string[];
  candidate: Record<string, unknown>;
  createdAt: string;
}

export interface PrivateFundValuationSecurityCandidate {
  securityId: string;
  market: string;
  exchange: string;
  companyName: string;
  ticker: string;
  source: string;
  sourceUpdatedAt: string;
  label: string;
}

export interface PrivateFundValuationModelSeries {
  seriesId: string;
  seriesKey: string;
  name: string;
  companyName?: string | null;
  companyTicker?: string | null;
  identitySource?: string | null;
  identityStatus?: string | null;
  identityUpdatedAt?: string | null;
  identityAudit: PrivateFundValuationModelIdentityAudit[];
  modelType?: string | null;
  currentModelVersionId?: string | null;
  currentVersionNo: number;
  versionCount: number;
  status: string;
  updatedAt: string;
  currentVersion?: PrivateFundValuationModelVersion | null;
  versions: PrivateFundValuationModelVersion[];
  metricAnalysis: PrivateFundValuationMetricAnalysis;
}

export interface PrivateFundValuationChange {
  canonicalKey: string;
  nodeId?: string | null;
  nodeKind?: string | null;
  metricKey?: string | null;
  displayName: string;
  scope?: string | null;
  period?: string | null;
  scenario?: string | null;
  changeType: string;
  materiality: string;
  summary: string;
  oldValue: Record<string, unknown>;
  newValue: Record<string, unknown>;
  absoluteChange?: number | null;
  relativeChange?: number | null;
  evidenceIds: string[];
}

export interface PrivateFundValuationAlert {
  alertId: string;
  seriesId: string;
  ruleId?: string | null;
  changeId: string;
  alertType: string;
  priority: string;
  title: string;
  summary: string;
  evidenceIds: string[];
  status: string;
  snoozedUntil?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrivateFundValuationWatchRule {
  ruleId: string;
  seriesId?: string | null;
  name: string;
  minMateriality: string;
  changeTypes: string[];
  active: boolean;
}

export interface PrivateFundValuationAgentFinding {
  title: string;
  detail: string;
  impact: string;
  confidence: number;
  evidenceIds: string[];
}

export interface PrivateFundValuationAgentEvidence {
  evidenceId: string;
  kind: string;
  label: string;
  source: string;
  detail: string;
  nodeId?: string | null;
  writable?: boolean;
}

export interface PrivateFundValuationRecommendedChange {
  nodeId: string;
  displayName: string;
  metricKey: string;
  period?: string | null;
  scenario?: string | null;
  currentValueNumeric?: number | null;
  currentValueText?: string | null;
  proposedValueNumeric?: number | null;
  proposedValueText?: string | null;
  unit?: string | null;
  rationale: string;
  confidence: number;
  evidenceIds: string[];
  writable: boolean;
  sheetName?: string | null;
  cellRef?: string | null;
  formula?: string | null;
}

export interface PrivateFundValuationAgentAnalysis {
  analysisId: string;
  datasetId: string;
  seriesId: string;
  baseModelVersionId: string;
  comparisonModelVersionId?: string | null;
  status: string;
  focus: string;
  valuationMethod: string;
  executiveSummary: string;
  investmentConclusion: string;
  keyFindings: PrivateFundValuationAgentFinding[];
  evidenceChain: PrivateFundValuationAgentFinding[];
  recommendedChanges: PrivateFundValuationRecommendedChange[];
  risks: PrivateFundValuationAgentFinding[];
  openQuestions: string[];
  selectedEvidence: PrivateFundValuationAgentEvidence[];
  planner: Record<string, unknown>;
  evidenceIds: string[];
  modelName: string;
  agentVersion: string;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

export interface PrivateFundValuationDerivedModel {
  derivedModelId: string;
  datasetId: string;
  seriesId: string;
  analysisId: string;
  baseModelVersionId: string;
  derivedVersionNo: number;
  outputFilename: string;
  outputPath: string;
  checksum: string;
  appliedChanges: Array<Record<string, unknown>>;
  skippedChanges: Array<Record<string, unknown>>;
  resourceFileName?: string | null;
  resourcePipelineJobId?: string | null;
  resourceStatus: "not_added" | "queued" | "running" | "completed" | "failed" | string;
  resourceDocId?: string | null;
  resourceAddedAt?: string | null;
  resourceError?: string | null;
  createdAt: string;
}

export interface PrivateFundValuationResourceImport {
  derivedModel: PrivateFundValuationDerivedModel;
  job: PrivateFundPipelineJob | null;
  status: string;
  fileName: string;
  alreadyAdded: boolean;
  copied: boolean;
}

export interface PrivateFundValuationTrackingOverview {
  datasetId: string;
  series: PrivateFundValuationModelSeries[];
  alerts: PrivateFundValuationAlert[];
  metricAlerts: PrivateFundValuationAlert[];
  watchRules: PrivateFundValuationWatchRule[];
  jobs: PrivateFundValuationTrackingJob[];
  agentAnalyses: PrivateFundValuationAgentAnalysis[];
  derivedModels: PrivateFundValuationDerivedModel[];
  unreadAlertCount: number;
  unreadMetricAlertCount: number;
  changeCounts: Record<string, number>;
  analyzerVersion: string;
}

export interface PrivateFundValuationComparison {
  series: PrivateFundValuationModelSeries;
  fromVersion: PrivateFundValuationModelVersion;
  toVersion: PrivateFundValuationModelVersion;
  changes: PrivateFundValuationChange[];
}

export interface PrivateFundResearchItemTimeline {
  item: PrivateFundResearchItem;
  versions: PrivateFundResearchItemVersion[];
  changes: Array<Record<string, unknown>>;
  observations: Array<Record<string, unknown>>;
}

interface PipelineJobWire {
  job_id: string;
  dataset_id?: string | null;
  status: string;
  created_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  message?: string | null;
  result?: unknown;
}

interface GlobalUploadCandidateWire {
  dataset_id: string;
  project_name: string;
  company_name?: string | null;
  company_ticker?: string | null;
  score?: number | null;
  method?: string | null;
}

interface GlobalUploadItemWire {
  item_id: string;
  batch_id: string;
  file_name: string;
  file_type: string;
  size: number;
  checksum: string;
  status: string;
  company_name?: string | null;
  company_ticker?: string | null;
  company_confidence?: number | null;
  company_detection_method?: string | null;
  matched_dataset_id?: string | null;
  matched_project_name?: string | null;
  project_match_confidence?: number | null;
  project_match_method?: string | null;
  candidate_projects?: GlobalUploadCandidateWire[];
  pipeline_job_id?: string | null;
  error_message?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface GlobalUploadBatchWire {
  batch_id: string;
  status: string;
  file_count?: number | null;
  message?: string | null;
  counts?: Record<string, number>;
  items?: GlobalUploadItemWire[];
  created_at?: string | null;
  updated_at?: string | null;
  finished_at?: string | null;
}

interface PrivateFundTokenUsageWire {
  dataset_id: string;
  session_count?: number | null;
  sessions_with_token_usage?: number | null;
  sessions_with_total_tokens?: number | null;
  sessions_with_cost?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  total_cost_usd?: number | null;
}

interface ProjectWire {
  dataset_id: string;
  name: string;
  status: string;
  source_dir?: string | null;
  dataset_root?: string | null;
  uploads_dir?: string | null;
  company_name?: string | null;
  company_ticker?: string | null;
  file_count?: number | null;
  upload_count?: number | null;
  document_count?: number | null;
  indexed_document_count?: number | null;
  failed_document_count?: number | null;
  chunk_count?: number | null;
  index_count?: number | null;
  memo_count?: number | null;
  latest_memo_path?: string | null;
  latest_memo_name?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  index_ready?: boolean | null;
  latest_job?: PipelineJobWire | null;
  token_usage?: PrivateFundTokenUsageWire | null;
}

interface FileWire {
  name: string;
  file_type: string;
  size: number;
  uploaded_at?: string | null;
  source_path?: string | null;
  status: string;
  doc_id?: string | null;
  chunk_count?: number | null;
  error_message?: string | null;
  stored_path?: string | null;
  doc_type?: string | null;
  doc_subtype?: string | null;
  doc_type_confidence?: number | null;
  classification_status?: string | null;
  classification_method?: string | null;
  company_name?: string | null;
  company_ticker?: string | null;
  company_confidence?: number | null;
}

interface SourceFolderTreeWire {
  dataset_id: string;
  folders: Array<{
    folder_id: string;
    name: string;
    kind: "auto" | "custom" | "system";
    classification_key?: string | null;
    files?: Array<{
      file_name: string;
      assignment: "auto" | "manual";
    }>;
    file_count?: number | null;
    created_at: string;
    updated_at: string;
  }>;
}

interface AssetWire {
  asset_id: string;
  asset_type: string;
  title: string;
  summary?: string | null;
  content_markdown?: string | null;
  format?: string | null;
  status?: string | null;
  source_kind?: string | null;
  source_id?: string | null;
  tags?: string[] | null;
  created_at?: string | null;
  updated_at?: string | null;
  version_no?: number | null;
  evidence_count?: number | null;
  file_type?: string | null;
  stored_path?: string | null;
  metadata?: Record<string, unknown> | null;
  display_group?: string | null;
  display_label?: string | null;
}

interface AssetCatalogWire {
  assets: AssetWire[];
  context_asset_ids?: string[];
}

interface ResearchWorkflowWire {
  workflow_id: string;
  dataset_id: string;
  workflow_type: string;
  status: string;
  current_node_id: string;
  created_at: string;
  updated_at: string;
}

interface ResearchNodeWire {
  node_id: string;
  node_type: string;
  title: string;
  objective: string;
  summary: string;
  status: PrivateFundResearchNodeStatus;
  current_version_no: number;
  position_no: number;
  x: number;
  y: number;
  tone: PrivateFundResearchNode["tone"];
  kind: PrivateFundResearchNode["kind"];
  assumption_count?: number | null;
  latest_output?: string | null;
  content_blocks?: Array<PrivateFundRichContentBlock & { evidence_ids?: string[] }> | null;
  evidence_sources?: Array<{
    evidence_id: string;
    relation_type: string;
    citation: string;
    document_name: string;
    source_path?: string | null;
    stored_path?: string | null;
    page_start?: number | null;
    page_end?: number | null;
    slide_start?: number | null;
    slide_end?: number | null;
    sheet_name?: string | null;
    cell_range?: string | null;
    heading_path?: string | null;
    excerpt?: string | null;
    source_url?: string | null;
    markdown_citation?: string | null;
  }>;
}

interface ResearchEdgeWire {
  edge_id: string;
  source: string;
  target: string;
  dependency_type: string;
}

interface ResearchWorkflowPayloadWire {
  workflow: ResearchWorkflowWire;
  nodes: ResearchNodeWire[];
  edges: ResearchEdgeWire[];
  context_node_ids?: string[];
}

interface ResearchItemVersionWire {
  item_version_id: string;
  version_no: number;
  as_of_date?: string | null;
  source_published_at?: string | null;
  observed_at: string;
  source_type: string;
  source_id: string;
  content: string;
  stance: string;
  state: string;
  value_numeric?: number | null;
  value_text?: string | null;
  unit?: string | null;
  period?: string | null;
  scenario?: string | null;
  probability?: string | null;
  impact: string;
  confidence: number;
  expected_start?: string | null;
  expected_end?: string | null;
  evidence_ids?: string[];
  evidence_sources?: Array<{
    evidence_id: string;
    citation: string;
    document_name: string;
    excerpt: string;
    full_content?: string | null;
    source_url?: string | null;
    page_start?: number | null;
    page_end?: number | null;
    sheet_name?: string | null;
    cell_range?: string | null;
  }>;
  metadata?: Record<string, unknown>;
  title?: string | null;
  field_changes?: Array<{
    field: string;
    label: string;
    before?: unknown;
    after?: unknown;
    change_kind: "added" | "removed" | "changed";
  }>;
}

interface ResearchItemWire {
  item_id: string;
  item_type: string;
  canonical_key: string;
  title: string;
  status: string;
  current_version_no: number;
  current_version_id?: string | null;
  first_seen_at: string;
  last_seen_at: string;
  current_version?: ResearchItemVersionWire | null;
  archived_at?: string | null;
  archive_reason?: string | null;
  quality_issue?: string | null;
}

interface ResearchAlertWire {
  alert_id: string;
  rule_id?: string | null;
  item_id: string;
  change_event_id?: string | null;
  alert_type: string;
  priority: string;
  title: string;
  summary: string;
  why_it_matters?: string | null;
  evidence_ids?: string[];
  status: string;
  due_at?: string | null;
  created_at: string;
  updated_at: string;
}

interface WatchRuleWire {
  rule_id: string;
  name: string;
  target_type: string;
  target_item_id?: string | null;
  query?: Record<string, unknown>;
  min_priority: string;
  frequency: string;
  active: boolean | number;
}

interface TrackingJobWire {
  job_id: string;
  job_type: string;
  source_id: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  last_error?: string | null;
  result?: Record<string, unknown> | null;
}

interface MemoSectionWire {
  section_id: string;
  section_key: string;
  title: string;
  content: string;
  evidence_ids?: string[];
  needs_review: boolean | number;
}

interface MemoVersionWire {
  memo_version_id: string;
  series_id: string;
  version_no: number;
  revision_of_version_id?: string | null;
  as_of_date: string;
  status: string;
  topic: string;
  series_title: string;
  markdown_path?: string | null;
  html_path?: string | null;
  pdf_path?: string | null;
  created_at: string;
  sections?: MemoSectionWire[];
}

interface MemoSeriesWire {
  series_id: string;
  topic: string;
  title: string;
  current_version_no: number;
  version_count: number;
  current_memo_version_id?: string | null;
  updated_at: string;
}

interface TrackingOverviewWire {
  dataset_id: string;
  schema_version?: number;
  rebuild_required?: boolean;
  legacy_item_count?: number;
  counts?: Record<string, number>;
  unread_alert_count?: number;
  quality_counts?: Record<string, number>;
  governance_counts?: {
    active_unqualified?: number;
    archived?: number;
  };
  items?: ResearchItemWire[];
  alerts?: ResearchAlertWire[];
  watch_rules?: WatchRuleWire[];
  jobs?: TrackingJobWire[];
  memo_series?: MemoSeriesWire[];
  memo_versions?: MemoVersionWire[];
}

interface ValuationTrackingJobWire {
  job_id: string;
  job_type: string;
  source_id: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  last_error?: string | null;
  result?: Record<string, unknown> | null;
  payload?: Record<string, unknown>;
}

interface ValuationAnalysisWire {
  analysis_version_id: string;
  status: string;
  summary_markdown: string;
  analysis?: Record<string, unknown>;
  analyzer_version: string;
  created_at: string;
}

interface ValuationModelVersionWire {
  model_version_id: string;
  document_version_no: number;
  original_filename: string;
  node_count: number;
  formula_node_count: number;
  review_required_count: number;
  reverted_to_version_id?: string | null;
  created_at: string;
  analysis?: ValuationAnalysisWire | null;
}

interface ValuationOverviewValueWire {
  period: string;
  value: number | null;
  value_text?: string;
  evidence_id: string;
  source: string;
  quality_status?: string;
  confidence?: number;
}

interface ValuationModelOverviewWire {
  overview_id: string;
  dataset_id: string;
  series_id: string;
  model_version_id: string;
  doc_id: string;
  status: string;
  overview_version: string;
  created_at: string;
  html: string;
  overview?: {
    schema_version?: number;
    model_name?: string;
    company_name?: string;
    company_ticker?: string;
    model_version_no?: number;
    model_type?: string;
    original_filename?: string;
    generated_at?: string;
    summary?: {
      detected_statements?: string[];
      missing_statements?: string[];
      statement_count?: number;
      trend_count?: number;
      key_metric_count?: number;
      period_start?: string;
      period_end?: string;
      periods?: string[];
      fact_count?: number;
      review_required_count?: number;
      quality_flags?: string[];
    };
    key_metrics?: Array<{
      metric_key: string;
      label: string;
      period?: string;
      value_numeric?: number | null;
      value_text?: string;
      unit?: string;
      evidence_id?: string;
      source?: string;
    }>;
    trends?: Array<{
      metric_key: string;
      label: string;
      statement_type: string;
      unit?: string;
      sheet_name: string;
      values?: ValuationOverviewValueWire[];
    }>;
    statements?: Array<{
      statement_type: string;
      title: string;
      sheet_name: string;
      periods?: string[];
      rows?: Array<{
        metric_key?: string;
        metric_name: string;
        unit?: string;
        row_index?: number;
        values?: Array<ValuationOverviewValueWire | null>;
      }>;
      source_refs?: string[];
    }>;
  };
}

interface ValuationModelSeriesWire {
  series_id: string;
  series_key: string;
  name: string;
  company_name?: string | null;
  company_ticker?: string | null;
  identity_source?: string | null;
  identity_status?: string | null;
  identity_updated_at?: string | null;
  identity_audit?: ValuationModelIdentityAuditWire[];
  model_type?: string | null;
  current_model_version_id?: string | null;
  current_version_no: number;
  version_count?: number;
  status: string;
  updated_at: string;
  current_version?: ValuationModelVersionWire | null;
  versions?: ValuationModelVersionWire[];
  metric_analysis?: ValuationMetricAnalysisWire;
}

interface ValuationModelIdentityAuditWire {
  audit_id: string;
  old_company_name?: string | null;
  old_company_ticker?: string | null;
  new_company_name?: string | null;
  new_company_ticker?: string | null;
  change_source: string;
  actor: string;
  validation_status: string;
  validation_reasons?: string[];
  candidate?: Record<string, unknown>;
  created_at: string;
}

interface ValuationSecurityCandidateWire {
  security_id: string;
  market: string;
  exchange: string;
  company_name: string;
  ticker: string;
  source: string;
  source_updated_at: string;
  label?: string;
}

interface ValuationMetricComparisonWire {
  comparison_id?: string;
  metric_key: string;
  label: string;
  unit: string;
  description?: string;
  model_value?: number | null;
  actual_value?: number | null;
  absolute_gap?: number | null;
  relative_gap?: number | null;
  severity: string;
  status: string;
  explanation?: string;
  model_period?: string | null;
  actual_period?: string | null;
  model_source?: string | null;
  model_method?: string | null;
  actual_source?: string | null;
  model_quality_status?: string | null;
  evidence_ids?: string[];
  created_at?: string | null;
}

interface ValuationMetricTimelinePeriodWire {
  period: string;
  label?: string;
  status?: string;
  model_available_count?: number;
  actual_available_count?: number;
  compared_count?: number;
  alert_count?: number;
  observed_at?: string | null;
  comparisons?: ValuationMetricComparisonWire[];
}

interface ValuationMetricTimelineWire {
  default_period?: string | null;
  latest_period?: string | null;
  periods?: ValuationMetricTimelinePeriodWire[];
}

interface ValuationMarketSnapshotWire {
  label?: string | null;
  period?: string | null;
  error_message?: string | null;
  as_of?: string | null;
  status?: string | null;
  model_available_count?: number | null;
  actual_available_count?: number | null;
  compared_count?: number | null;
  period_mismatch_count?: number | null;
  comparisons?: ValuationMetricComparisonWire[];
}

interface ValuationMarketDataProviderAttemptWire {
  provider?: string | null;
  status?: string | null;
  fields_found?: string[] | null;
  error_message?: string | null;
  duration_ms?: number | null;
}

interface ValuationMarketDataStatusWire {
  snapshot_id?: string;
  provider?: string;
  status?: string;
  as_of?: string | null;
  error_message?: string | null;
  provider_attempts?: ValuationMarketDataProviderAttemptWire[] | null;
  created_at?: string | null;
  is_stale?: boolean | number | null;
  identity_snapshot?: Record<string, unknown> | null;
}

interface ValuationContextCardWire {
  card_id: string;
  card_type: string;
  title: string;
  summary: string;
  insight: string;
  source_name: string;
  document_date?: string | null;
  evidence_ids?: string[];
}

interface ValuationImpactCardWire {
  card_id: string;
  direction: "up" | "down" | "mixed";
  horizon: string;
  confidence: number;
  title: string;
  evidence_summary: string;
  valuation_impact: string;
  affected_inputs?: string[];
  watch_items?: string[];
  source_refs?: string[];
  evidence_ids?: string[];
  evidence_locations?: Array<Record<string, unknown>>;
  created_at?: string | null;
}

interface ValuationImpactAnalysisWire {
  run_id?: string;
  status?: string;
  source_fingerprint?: string;
  extractor_version?: string;
  skill_name?: string;
  analysis_summary?: string;
  warnings?: string[];
  cards?: ValuationImpactCardWire[];
  error_message?: string | null;
  updated_at?: string | null;
}

interface ValuationMetricAnalysisWire {
  market_data?: ValuationMarketDataStatusWire;
  metric_comparisons?: ValuationMetricComparisonWire[];
  market_snapshot?: ValuationMarketSnapshotWire;
  metric_timeline?: ValuationMetricTimelineWire;
  context_cards?: ValuationContextCardWire[];
  valuation_impacts?: ValuationImpactAnalysisWire;
}

interface ValuationChangeWire {
  canonical_key: string;
  node_id?: string | null;
  node_kind?: string | null;
  metric_key?: string | null;
  display_name: string;
  scope?: string | null;
  period?: string | null;
  scenario?: string | null;
  change_type: string;
  materiality: string;
  summary: string;
  old_value?: Record<string, unknown>;
  new_value?: Record<string, unknown>;
  absolute_change?: number | null;
  relative_change?: number | null;
  evidence_ids?: string[];
}

interface ValuationAlertWire {
  alert_id: string;
  series_id: string;
  rule_id?: string | null;
  change_id: string;
  alert_type: string;
  priority: string;
  title: string;
  summary: string;
  evidence_ids?: string[];
  status: string;
  snoozed_until?: string | null;
  created_at: string;
  updated_at: string;
}

interface ValuationWatchRuleWire {
  rule_id: string;
  series_id?: string | null;
  name: string;
  min_materiality: string;
  change_types?: string[];
  active: boolean | number;
}

interface ValuationAgentFindingWire {
  title?: string;
  claim?: string;
  detail?: string;
  reasoning?: string;
  impact?: string;
  confidence?: number;
  evidence_ids?: string[];
}

interface ValuationAgentEvidenceWire {
  evidence_id: string;
  kind?: string;
  label?: string;
  source?: string;
  detail?: string;
  node_id?: string | null;
  writable?: boolean | number;
}

interface ValuationRecommendedChangeWire {
  node_id: string;
  display_name?: string;
  metric_key?: string;
  period?: string | null;
  scenario?: string | null;
  current_value_numeric?: number | null;
  current_value_text?: string | null;
  proposed_value_numeric?: number | null;
  proposed_value_text?: string | null;
  unit?: string | null;
  rationale?: string;
  confidence?: number;
  evidence_ids?: string[];
  writable?: boolean | number;
  sheet_name?: string | null;
  cell_ref?: string | null;
  formula?: string | null;
}

interface ValuationAgentAnalysisWire {
  analysis_id: string;
  dataset_id: string;
  series_id: string;
  base_model_version_id: string;
  comparison_model_version_id?: string | null;
  status: string;
  focus?: string;
  valuation_method?: string;
  executive_summary?: string;
  investment_conclusion?: string;
  analysis?: {
    key_findings?: ValuationAgentFindingWire[];
    evidence_chain?: ValuationAgentFindingWire[];
    recommended_changes?: ValuationRecommendedChangeWire[];
    risks?: ValuationAgentFindingWire[];
    open_questions?: string[];
    selected_evidence?: ValuationAgentEvidenceWire[];
  };
  planner?: Record<string, unknown>;
  evidence_ids?: string[];
  model_name?: string;
  agent_version?: string;
  error_message?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
}

interface ValuationDerivedModelWire {
  derived_model_id: string;
  dataset_id: string;
  series_id: string;
  analysis_id: string;
  base_model_version_id: string;
  derived_version_no: number;
  output_filename: string;
  output_path: string;
  checksum: string;
  applied_changes?: Array<Record<string, unknown>>;
  skipped_changes?: Array<Record<string, unknown>>;
  resource_file_name?: string | null;
  resource_pipeline_job_id?: string | null;
  resource_status?: string | null;
  resource_doc_id?: string | null;
  resource_added_at?: string | null;
  resource_error?: string | null;
  created_at: string;
}

interface ValuationTrackingOverviewWire {
  dataset_id: string;
  series?: ValuationModelSeriesWire[];
  alerts?: ValuationAlertWire[];
  metric_alerts?: ValuationAlertWire[];
  watch_rules?: ValuationWatchRuleWire[];
  jobs?: ValuationTrackingJobWire[];
  agent_analyses?: ValuationAgentAnalysisWire[];
  derived_models?: ValuationDerivedModelWire[];
  unread_alert_count?: number;
  unread_metric_alert_count?: number;
  change_counts?: Record<string, number>;
  analyzer_version: string;
}

function jobFromWire(job: PipelineJobWire | null | undefined): PrivateFundPipelineJob | null {
  if (!job) return null;
  return {
    jobId: job.job_id,
    datasetId: job.dataset_id ?? "",
    status: job.status,
    createdAt: job.created_at ?? null,
    startedAt: job.started_at ?? null,
    finishedAt: job.finished_at ?? null,
    message: job.message ?? null,
    result: job.result,
  };
}

function globalUploadBatchFromWire(batch: GlobalUploadBatchWire): PrivateFundGlobalUploadBatch {
  return {
    batchId: batch.batch_id,
    status: batch.status,
    fileCount: batch.file_count ?? 0,
    message: batch.message ?? "",
    counts: batch.counts ?? {},
    items: (batch.items ?? []).map((item) => ({
      itemId: item.item_id,
      batchId: item.batch_id,
      fileName: item.file_name,
      fileType: item.file_type,
      size: item.size,
      checksum: item.checksum,
      status: item.status,
      companyName: item.company_name ?? "",
      companyTicker: item.company_ticker ?? "",
      companyConfidence: item.company_confidence ?? 0,
      companyDetectionMethod: item.company_detection_method ?? "",
      matchedDatasetId: item.matched_dataset_id ?? null,
      matchedProjectName: item.matched_project_name ?? "",
      projectMatchConfidence: item.project_match_confidence ?? 0,
      projectMatchMethod: item.project_match_method ?? "",
      candidateProjects: (item.candidate_projects ?? []).map((candidate) => ({
        datasetId: candidate.dataset_id,
        projectName: candidate.project_name,
        companyName: candidate.company_name ?? "",
        companyTicker: candidate.company_ticker ?? "",
        score: candidate.score ?? 0,
        method: candidate.method ?? "",
      })),
      pipelineJobId: item.pipeline_job_id ?? null,
      errorMessage: item.error_message ?? null,
      createdAt: item.created_at ?? null,
      updatedAt: item.updated_at ?? null,
    })),
    createdAt: batch.created_at ?? null,
    updatedAt: batch.updated_at ?? null,
    finishedAt: batch.finished_at ?? null,
  };
}

export function privateFundTokenUsageFromWire(
  usage: PrivateFundTokenUsageWire | null | undefined,
): PrivateFundTokenUsage | null {
  if (!usage) return null;
  return {
    datasetId: usage.dataset_id,
    sessionCount: usage.session_count ?? 0,
    sessionsWithTokenUsage: usage.sessions_with_token_usage ?? 0,
    sessionsWithTotalTokens: usage.sessions_with_total_tokens ?? 0,
    sessionsWithCost: usage.sessions_with_cost ?? 0,
    inputTokens: usage.input_tokens ?? null,
    outputTokens: usage.output_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? null,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? null,
    totalCostUsd: usage.total_cost_usd ?? null,
  };
}

function projectFromWire(project: ProjectWire): PrivateFundProject {
  return {
    datasetId: project.dataset_id,
    name: project.name,
    status: project.status,
    sourceDir: project.source_dir ?? null,
    datasetRoot: project.dataset_root ?? null,
    uploadsDir: project.uploads_dir ?? null,
    companyName: project.company_name ?? null,
    companyTicker: project.company_ticker ?? null,
    fileCount: project.file_count ?? 0,
    uploadCount: project.upload_count ?? 0,
    documentCount: project.document_count ?? 0,
    indexedDocumentCount: project.indexed_document_count ?? 0,
    failedDocumentCount: project.failed_document_count ?? 0,
    chunkCount: project.chunk_count ?? 0,
    indexCount: project.index_count ?? 0,
    memoCount: project.memo_count ?? 0,
    latestMemoPath: project.latest_memo_path ?? null,
    latestMemoName: project.latest_memo_name ?? null,
    createdAt: project.created_at ?? null,
    updatedAt: project.updated_at ?? null,
    indexReady: Boolean(project.index_ready),
    latestJob: jobFromWire(project.latest_job),
    tokenUsage: privateFundTokenUsageFromWire(project.token_usage),
  };
}

function fileFromWire(file: FileWire): PrivateFundFile {
  return {
    name: file.name,
    fileType: file.file_type,
    size: file.size,
    uploadedAt: file.uploaded_at ?? null,
    sourcePath: file.source_path ?? null,
    status: file.status,
    docId: file.doc_id ?? null,
    chunkCount: file.chunk_count ?? 0,
    errorMessage: file.error_message ?? null,
    storedPath: file.stored_path ?? null,
    docType: file.doc_type ?? "unknown",
    docSubtype: file.doc_subtype ?? null,
    docTypeConfidence: file.doc_type_confidence ?? 0,
    classificationStatus: file.classification_status ?? "pending",
    classificationMethod: file.classification_method ?? null,
    companyName: file.company_name ?? null,
    companyTicker: file.company_ticker ?? null,
    companyConfidence: file.company_confidence ?? 0,
  };
}

function sourceFolderTreeFromWire(payload: SourceFolderTreeWire): PrivateFundSourceFolderTree {
  return {
    datasetId: payload.dataset_id,
    folders: payload.folders.map((folder) => ({
      folderId: folder.folder_id,
      name: folder.name,
      kind: folder.kind,
      classificationKey: folder.classification_key ?? null,
      files: (folder.files ?? []).map((file) => ({
        fileName: file.file_name,
        assignment: file.assignment,
      })),
      fileCount: folder.file_count ?? folder.files?.length ?? 0,
      createdAt: folder.created_at,
      updatedAt: folder.updated_at,
    })),
  };
}

function assetCatalogFromWire(payload: AssetCatalogWire): PrivateFundAssetCatalog {
  return {
    assets: payload.assets.map((asset) => {
      const sourceKind = asset.source_kind ?? "saved_information";
      const group =
        (asset.display_group as PrivateFundDisplayGroup | undefined) ||
        inferDisplayGroup(asset.asset_type, sourceKind);
      return {
        assetId: asset.asset_id,
        assetType: asset.asset_type,
        title: asset.title,
        summary: asset.summary ?? "",
        contentMarkdown: asset.content_markdown ?? "",
        format: asset.format ?? "markdown",
        status: asset.status ?? "completed",
        sourceKind,
        sourceId: asset.source_id ?? null,
        tags: asset.tags ?? [],
        createdAt: asset.created_at ?? null,
        updatedAt: asset.updated_at ?? null,
        versionNo: asset.version_no ?? 1,
        evidenceCount: asset.evidence_count ?? 0,
        fileType: asset.file_type ?? null,
        storedPath: asset.stored_path ?? null,
        metadata: asset.metadata ?? {},
        displayGroup: group,
        displayLabel: asset.display_label || displayLabelForGroup(group, asset.asset_type),
      };
    }),
    contextAssetIds: normalizeContextAssetIds(payload.context_asset_ids ?? []),
  };
}

function researchWorkflowFromWire(
  payload: ResearchWorkflowPayloadWire,
): PrivateFundResearchWorkflow {
  return {
    workflowId: payload.workflow.workflow_id,
    datasetId: payload.workflow.dataset_id,
    workflowType: payload.workflow.workflow_type,
    status: payload.workflow.status,
    currentNodeId: payload.workflow.current_node_id,
    createdAt: payload.workflow.created_at,
    updatedAt: payload.workflow.updated_at,
    contextNodeIds: payload.context_node_ids ?? [],
    nodes: payload.nodes.map((node) => ({
      nodeId: node.node_id,
      nodeType: node.node_type,
      title: node.title,
      objective: node.objective,
      summary: node.summary,
      status: node.status,
      currentVersionNo: node.current_version_no,
      positionNo: node.position_no,
      x: node.x,
      y: node.y,
      tone: node.tone,
      kind: node.kind,
      assumptionCount: node.assumption_count ?? 0,
      latestOutput: node.latest_output ?? null,
      contentBlocks: (node.content_blocks ?? []).map((block) => ({
        ...block,
        evidenceIds: block.evidence_ids ?? [],
      })),
      evidenceSources: (node.evidence_sources ?? []).map((source) => ({
        evidenceId: source.evidence_id,
        relationType: source.relation_type,
        citation: source.citation,
        documentName: source.document_name,
        sourcePath: source.source_path ?? null,
        storedPath: source.stored_path ?? null,
        pageStart: source.page_start ?? null,
        pageEnd: source.page_end ?? null,
        slideStart: source.slide_start ?? null,
        slideEnd: source.slide_end ?? null,
        sheetName: source.sheet_name ?? null,
        cellRange: source.cell_range ?? null,
        headingPath: source.heading_path ?? null,
        excerpt: source.excerpt ?? null,
        sourceUrl: source.source_url ?? null,
        markdownCitation: source.markdown_citation ?? null,
      })),
    })),
    edges: payload.edges.map((edge) => ({
      edgeId: edge.edge_id,
      source: edge.source,
      target: edge.target,
      dependencyType: edge.dependency_type,
    })),
  };
}

function researchItemVersionFromWire(
  version: ResearchItemVersionWire,
): PrivateFundResearchItemVersion {
  return {
    itemVersionId: version.item_version_id,
    versionNo: version.version_no,
    asOfDate: version.as_of_date ?? null,
    sourcePublishedAt: version.source_published_at ?? null,
    observedAt: version.observed_at,
    sourceType: version.source_type,
    sourceId: version.source_id,
    content: version.content,
    stance: version.stance,
    state: version.state,
    valueNumeric: version.value_numeric ?? null,
    valueText: version.value_text ?? null,
    unit: version.unit ?? null,
    period: version.period ?? null,
    scenario: version.scenario ?? null,
    probability: version.probability ?? null,
    impact: version.impact,
    confidence: version.confidence,
    expectedStart: version.expected_start ?? null,
    expectedEnd: version.expected_end ?? null,
    evidenceIds: version.evidence_ids ?? [],
    evidenceSources: (version.evidence_sources ?? []).map((source) => ({
      evidenceId: source.evidence_id,
      citation: source.citation,
      documentName: source.document_name,
      excerpt: source.excerpt,
      fullContent: source.full_content ?? source.excerpt,
      sourceUrl: source.source_url ?? null,
      pageStart: source.page_start ?? null,
      pageEnd: source.page_end ?? null,
      sheetName: source.sheet_name ?? null,
      cellRange: source.cell_range ?? null,
    })),
    metadata: version.metadata ?? {},
    title: version.title ?? undefined,
    fieldChanges: (version.field_changes ?? []).map((change) => ({
      field: change.field,
      label: change.label,
      before: change.before,
      after: change.after,
      changeKind: change.change_kind,
    })),
  };
}

function researchItemFromWire(item: ResearchItemWire): PrivateFundResearchItem {
  return {
    itemId: item.item_id,
    itemType: item.item_type,
    canonicalKey: item.canonical_key,
    title: item.title,
    status: item.status,
    currentVersionNo: item.current_version_no,
    currentVersionId: item.current_version_id ?? null,
    firstSeenAt: item.first_seen_at,
    lastSeenAt: item.last_seen_at,
    currentVersion: item.current_version ? researchItemVersionFromWire(item.current_version) : null,
    archivedAt: item.archived_at ?? null,
    archiveReason: item.archive_reason ?? null,
    qualityIssue: item.quality_issue ?? null,
  };
}

function researchAlertFromWire(alert: ResearchAlertWire): PrivateFundResearchAlert {
  return {
    alertId: alert.alert_id,
    ruleId: alert.rule_id ?? null,
    itemId: alert.item_id,
    changeEventId: alert.change_event_id ?? null,
    alertType: alert.alert_type,
    priority: alert.priority,
    title: alert.title,
    summary: alert.summary,
    whyItMatters: alert.why_it_matters ?? "",
    evidenceIds: alert.evidence_ids ?? [],
    status: alert.status,
    dueAt: alert.due_at ?? null,
    createdAt: alert.created_at,
    updatedAt: alert.updated_at,
  };
}

function watchRuleFromWire(rule: WatchRuleWire): PrivateFundWatchRule {
  return {
    ruleId: rule.rule_id,
    name: rule.name,
    targetType: rule.target_type,
    targetItemId: rule.target_item_id ?? null,
    query: rule.query ?? {},
    minPriority: rule.min_priority,
    frequency: rule.frequency,
    active: Boolean(rule.active),
  };
}

function trackingJobFromWire(job: TrackingJobWire): PrivateFundTrackingJob {
  return {
    jobId: job.job_id,
    jobType: job.job_type,
    sourceId: job.source_id,
    status: job.status,
    attemptCount: job.attempt_count,
    maxAttempts: job.max_attempts,
    createdAt: job.created_at,
    startedAt: job.started_at ?? null,
    finishedAt: job.finished_at ?? null,
    lastError: job.last_error ?? null,
    result: job.result ?? null,
  };
}

function memoVersionFromWire(version: MemoVersionWire): PrivateFundMemoVersion {
  return {
    memoVersionId: version.memo_version_id,
    seriesId: version.series_id,
    versionNo: version.version_no,
    revisionOfVersionId: version.revision_of_version_id ?? null,
    asOfDate: version.as_of_date,
    status: version.status,
    topic: version.topic,
    seriesTitle: version.series_title,
    markdownPath: version.markdown_path ?? null,
    htmlPath: version.html_path ?? null,
    pdfPath: version.pdf_path ?? null,
    createdAt: version.created_at,
    sections: (version.sections ?? []).map((section) => ({
      sectionId: section.section_id,
      sectionKey: section.section_key,
      title: section.title,
      content: section.content,
      evidenceIds: section.evidence_ids ?? [],
      needsReview: Boolean(section.needs_review),
    })),
  };
}

function trackingOverviewFromWire(payload: TrackingOverviewWire): PrivateFundTrackingOverview {
  return {
    datasetId: payload.dataset_id,
    schemaVersion: payload.schema_version ?? 1,
    rebuildRequired: Boolean(payload.rebuild_required),
    legacyItemCount: payload.legacy_item_count ?? 0,
    counts: payload.counts ?? {},
    unreadAlertCount: payload.unread_alert_count ?? 0,
    qualityCounts: payload.quality_counts ?? {},
    governanceCounts: {
      activeUnqualified: payload.governance_counts?.active_unqualified ?? 0,
      archived: payload.governance_counts?.archived ?? 0,
    },
    items: (payload.items ?? []).map(researchItemFromWire),
    alerts: (payload.alerts ?? []).map(researchAlertFromWire),
    watchRules: (payload.watch_rules ?? []).map(watchRuleFromWire),
    jobs: (payload.jobs ?? []).map(trackingJobFromWire),
    memoSeries: (payload.memo_series ?? []).map((series) => ({
      seriesId: series.series_id,
      topic: series.topic,
      title: series.title,
      currentVersionNo: series.current_version_no,
      versionCount: series.version_count,
      currentMemoVersionId: series.current_memo_version_id ?? null,
      updatedAt: series.updated_at,
    })),
    memoVersions: (payload.memo_versions ?? []).map(memoVersionFromWire),
  };
}

function valuationTrackingJobFromWire(
  job: ValuationTrackingJobWire,
): PrivateFundValuationTrackingJob {
  return {
    jobId: job.job_id,
    jobType: job.job_type,
    sourceId: job.source_id,
    status: job.status,
    attemptCount: job.attempt_count,
    maxAttempts: job.max_attempts,
    createdAt: job.created_at,
    startedAt: job.started_at ?? null,
    finishedAt: job.finished_at ?? null,
    lastError: job.last_error ?? null,
    result: job.result ?? null,
    payload: job.payload ?? {},
  };
}

function valuationAnalysisFromWire(analysis: ValuationAnalysisWire): PrivateFundValuationAnalysis {
  return {
    analysisVersionId: analysis.analysis_version_id,
    status: analysis.status,
    summaryMarkdown: analysis.summary_markdown,
    analysis: analysis.analysis ?? {},
    analyzerVersion: analysis.analyzer_version,
    createdAt: analysis.created_at,
  };
}

function valuationModelVersionFromWire(
  version: ValuationModelVersionWire,
): PrivateFundValuationModelVersion {
  return {
    modelVersionId: version.model_version_id,
    documentVersionNo: version.document_version_no,
    originalFilename: version.original_filename,
    nodeCount: version.node_count,
    formulaNodeCount: version.formula_node_count,
    reviewRequiredCount: version.review_required_count,
    revertedToVersionId: version.reverted_to_version_id ?? null,
    createdAt: version.created_at,
    analysis: version.analysis ? valuationAnalysisFromWire(version.analysis) : null,
  };
}

function valuationOverviewValueFromWire(
  value: ValuationOverviewValueWire,
): PrivateFundValuationOverviewValue {
  return {
    period: value.period,
    value: value.value,
    valueText: value.value_text,
    evidenceId: value.evidence_id,
    source: value.source,
    qualityStatus: value.quality_status,
    confidence: value.confidence,
  };
}

function valuationModelOverviewFromWire(
  item: ValuationModelOverviewWire,
): PrivateFundValuationModelOverview {
  const overview = item.overview ?? {};
  const summary = overview.summary ?? {};
  return {
    overviewId: item.overview_id,
    datasetId: item.dataset_id,
    seriesId: item.series_id,
    modelVersionId: item.model_version_id,
    docId: item.doc_id,
    status: item.status,
    overviewVersion: item.overview_version,
    createdAt: item.created_at,
    html: item.html,
    overview: {
      schemaVersion: overview.schema_version ?? 1,
      modelName: overview.model_name ?? "估值模型",
      companyName: overview.company_name ?? "",
      companyTicker: overview.company_ticker ?? "",
      modelVersionNo: overview.model_version_no ?? 0,
      modelType: overview.model_type ?? "",
      originalFilename: overview.original_filename ?? "",
      generatedAt: overview.generated_at ?? item.created_at,
      summary: {
        detectedStatements: summary.detected_statements ?? [],
        missingStatements: summary.missing_statements ?? [],
        statementCount: summary.statement_count ?? 0,
        trendCount: summary.trend_count ?? 0,
        keyMetricCount: summary.key_metric_count ?? 0,
        periodStart: summary.period_start ?? "",
        periodEnd: summary.period_end ?? "",
        periods: summary.periods ?? [],
        factCount: summary.fact_count ?? 0,
        reviewRequiredCount: summary.review_required_count ?? 0,
        qualityFlags: summary.quality_flags ?? [],
      },
      keyMetrics: (overview.key_metrics ?? []).map((metric) => ({
        metricKey: metric.metric_key,
        label: metric.label,
        period: metric.period ?? "",
        valueNumeric: metric.value_numeric ?? null,
        valueText: metric.value_text ?? "",
        unit: metric.unit ?? "",
        evidenceId: metric.evidence_id ?? "",
        source: metric.source ?? "",
      })),
      trends: (overview.trends ?? []).map((trend) => ({
        metricKey: trend.metric_key,
        label: trend.label,
        statementType: trend.statement_type,
        unit: trend.unit ?? "",
        sheetName: trend.sheet_name,
        values: (trend.values ?? []).map(valuationOverviewValueFromWire),
      })),
      statements: (overview.statements ?? []).map((statement) => ({
        statementType: statement.statement_type,
        title: statement.title,
        sheetName: statement.sheet_name,
        periods: statement.periods ?? [],
        rows: (statement.rows ?? []).map((row) => ({
          metricKey: row.metric_key ?? "",
          metricName: row.metric_name,
          unit: row.unit ?? "",
          rowIndex: row.row_index ?? 0,
          values: (row.values ?? []).map((value) =>
            value ? valuationOverviewValueFromWire(value) : null,
          ),
        })),
        sourceRefs: statement.source_refs ?? [],
      })),
    },
  };
}

function valuationMetricComparisonFromWire(
  metric: ValuationMetricComparisonWire,
): PrivateFundValuationMetricComparison {
  return {
    comparisonId: metric.comparison_id ?? "",
    metricKey: metric.metric_key,
    label: metric.label,
    unit: metric.unit,
    description: metric.description ?? "",
    modelValue: metric.model_value ?? null,
    actualValue: metric.actual_value ?? null,
    absoluteGap: metric.absolute_gap ?? null,
    relativeGap: metric.relative_gap ?? null,
    severity: metric.severity,
    status: metric.status,
    explanation: metric.explanation ?? "",
    modelPeriod: metric.model_period ?? "",
    actualPeriod: metric.actual_period ?? "",
    modelSource: metric.model_source ?? "",
    modelMethod: metric.model_method ?? "",
    actualSource: metric.actual_source ?? "",
    modelQualityStatus: metric.model_quality_status ?? "",
    evidenceIds: metric.evidence_ids ?? [],
    createdAt: metric.created_at ?? "",
  };
}

function valuationModelSeriesFromWire(
  series: ValuationModelSeriesWire,
): PrivateFundValuationModelSeries {
  const metricAnalysis = series.metric_analysis ?? {};
  const marketData = metricAnalysis.market_data ?? {};
  return {
    seriesId: series.series_id,
    seriesKey: series.series_key,
    name: series.name,
    companyName: series.company_name ?? null,
    companyTicker: series.company_ticker ?? null,
    identitySource: series.identity_source ?? null,
    identityStatus: series.identity_status ?? null,
    identityUpdatedAt: series.identity_updated_at ?? null,
    identityAudit: (series.identity_audit ?? []).map((audit) => ({
      auditId: audit.audit_id,
      oldCompanyName: audit.old_company_name ?? null,
      oldCompanyTicker: audit.old_company_ticker ?? null,
      newCompanyName: audit.new_company_name ?? null,
      newCompanyTicker: audit.new_company_ticker ?? null,
      changeSource: audit.change_source,
      actor: audit.actor,
      validationStatus: audit.validation_status,
      validationReasons: audit.validation_reasons ?? [],
      candidate: audit.candidate ?? {},
      createdAt: audit.created_at,
    })),
    modelType: series.model_type ?? null,
    currentModelVersionId: series.current_model_version_id ?? null,
    currentVersionNo: series.current_version_no,
    versionCount: series.version_count ?? series.versions?.length ?? 0,
    status: series.status,
    updatedAt: series.updated_at,
    currentVersion: series.current_version
      ? valuationModelVersionFromWire(series.current_version)
      : null,
    versions: (series.versions ?? []).map(valuationModelVersionFromWire),
    metricAnalysis: {
      marketData: {
        snapshotId: marketData.snapshot_id ?? "",
        provider: marketData.provider ?? "",
        status: marketData.status ?? "pending",
        asOf: marketData.as_of ?? "",
        errorMessage: marketData.error_message ?? "",
        isStale: Boolean(marketData.is_stale),
        identitySnapshot: marketData.identity_snapshot ?? {},
        providerAttempts: (marketData.provider_attempts ?? []).map((attempt) => ({
          provider: attempt.provider ?? "",
          status: attempt.status ?? "",
          fieldsFound: attempt.fields_found ?? [],
          errorMessage: attempt.error_message ?? "",
          durationMs: attempt.duration_ms ?? 0,
        })),
        createdAt: marketData.created_at ?? "",
      },
      metricComparisons: (metricAnalysis.metric_comparisons ?? []).map(
        valuationMetricComparisonFromWire,
      ),
      marketSnapshot: {
        label: metricAnalysis.market_snapshot?.label ?? "当前市场快照",
        asOf: metricAnalysis.market_snapshot?.as_of ?? "",
        status: metricAnalysis.market_snapshot?.status ?? "unavailable",
        modelAvailableCount: metricAnalysis.market_snapshot?.model_available_count ?? 0,
        actualAvailableCount: metricAnalysis.market_snapshot?.actual_available_count ?? 0,
        comparedCount: metricAnalysis.market_snapshot?.compared_count ?? 0,
        periodMismatchCount: metricAnalysis.market_snapshot?.period_mismatch_count ?? 0,
        comparisons: (metricAnalysis.market_snapshot?.comparisons ?? []).map(
          valuationMetricComparisonFromWire,
        ),
      },
      metricTimeline: {
        defaultPeriod: metricAnalysis.metric_timeline?.default_period ?? "",
        latestPeriod: metricAnalysis.metric_timeline?.latest_period ?? "",
        periods: (metricAnalysis.metric_timeline?.periods ?? []).map((period) => ({
          period: period.period,
          label: period.label ?? period.period,
          status: period.status ?? "unavailable",
          modelAvailableCount: period.model_available_count ?? 0,
          actualAvailableCount: period.actual_available_count ?? 0,
          comparedCount: period.compared_count ?? 0,
          alertCount: period.alert_count ?? 0,
          observedAt: period.observed_at ?? "",
          comparisons: (period.comparisons ?? []).map(valuationMetricComparisonFromWire),
        })),
      },
      contextCards: (metricAnalysis.context_cards ?? []).map((card) => ({
        cardId: card.card_id,
        cardType: card.card_type,
        title: card.title,
        summary: card.summary,
        insight: card.insight,
        sourceName: card.source_name,
        documentDate: card.document_date ?? "",
        evidenceIds: card.evidence_ids ?? [],
      })),
      valuationImpacts: {
        runId: metricAnalysis.valuation_impacts?.run_id ?? "",
        status: metricAnalysis.valuation_impacts?.status ?? "pending",
        sourceFingerprint: metricAnalysis.valuation_impacts?.source_fingerprint ?? "",
        extractorVersion: metricAnalysis.valuation_impacts?.extractor_version ?? "",
        skillName: metricAnalysis.valuation_impacts?.skill_name ?? "",
        analysisSummary: metricAnalysis.valuation_impacts?.analysis_summary ?? "",
        warnings: metricAnalysis.valuation_impacts?.warnings ?? [],
        cards: (metricAnalysis.valuation_impacts?.cards ?? []).map((card) => ({
          cardId: card.card_id,
          direction: card.direction,
          horizon: card.horizon,
          confidence: card.confidence,
          title: card.title,
          evidenceSummary: card.evidence_summary,
          valuationImpact: card.valuation_impact,
          affectedInputs: card.affected_inputs ?? [],
          watchItems: card.watch_items ?? [],
          sourceRefs: card.source_refs ?? [],
          evidenceIds: card.evidence_ids ?? [],
          evidenceLocations: card.evidence_locations ?? [],
          createdAt: card.created_at ?? "",
        })),
        errorMessage: metricAnalysis.valuation_impacts?.error_message ?? "",
        updatedAt: metricAnalysis.valuation_impacts?.updated_at ?? "",
      },
    },
  };
}

function valuationChangeFromWire(change: ValuationChangeWire): PrivateFundValuationChange {
  return {
    canonicalKey: change.canonical_key,
    nodeId: change.node_id ?? null,
    nodeKind: change.node_kind ?? null,
    metricKey: change.metric_key ?? null,
    displayName: change.display_name,
    scope: change.scope ?? null,
    period: change.period ?? null,
    scenario: change.scenario ?? null,
    changeType: change.change_type,
    materiality: change.materiality,
    summary: change.summary,
    oldValue: change.old_value ?? {},
    newValue: change.new_value ?? {},
    absoluteChange: change.absolute_change ?? null,
    relativeChange: change.relative_change ?? null,
    evidenceIds: change.evidence_ids ?? [],
  };
}

function valuationAlertFromWire(alert: ValuationAlertWire): PrivateFundValuationAlert {
  return {
    alertId: alert.alert_id,
    seriesId: alert.series_id,
    ruleId: alert.rule_id ?? null,
    changeId: alert.change_id,
    alertType: alert.alert_type,
    priority: alert.priority,
    title: alert.title,
    summary: alert.summary,
    evidenceIds: alert.evidence_ids ?? [],
    status: alert.status,
    snoozedUntil: alert.snoozed_until ?? null,
    createdAt: alert.created_at,
    updatedAt: alert.updated_at,
  };
}

function valuationWatchRuleFromWire(rule: ValuationWatchRuleWire): PrivateFundValuationWatchRule {
  return {
    ruleId: rule.rule_id,
    seriesId: rule.series_id ?? null,
    name: rule.name,
    minMateriality: rule.min_materiality,
    changeTypes: rule.change_types ?? [],
    active: Boolean(rule.active),
  };
}

function valuationAgentFindingFromWire(
  finding: ValuationAgentFindingWire,
): PrivateFundValuationAgentFinding {
  return {
    title: finding.title ?? finding.claim ?? "分析结论",
    detail: finding.detail ?? finding.reasoning ?? "",
    impact: finding.impact ?? "medium",
    confidence: finding.confidence ?? 0.5,
    evidenceIds: finding.evidence_ids ?? [],
  };
}

function valuationAgentAnalysisFromWire(
  item: ValuationAgentAnalysisWire,
): PrivateFundValuationAgentAnalysis {
  const analysis = item.analysis ?? {};
  return {
    analysisId: item.analysis_id,
    datasetId: item.dataset_id,
    seriesId: item.series_id,
    baseModelVersionId: item.base_model_version_id,
    comparisonModelVersionId: item.comparison_model_version_id ?? null,
    status: item.status,
    focus: item.focus ?? "",
    valuationMethod: item.valuation_method ?? "",
    executiveSummary: item.executive_summary ?? "",
    investmentConclusion: item.investment_conclusion ?? "",
    keyFindings: (analysis.key_findings ?? []).map(valuationAgentFindingFromWire),
    evidenceChain: (analysis.evidence_chain ?? []).map(valuationAgentFindingFromWire),
    recommendedChanges: (analysis.recommended_changes ?? []).map((change) => ({
      nodeId: change.node_id,
      displayName: change.display_name ?? change.metric_key ?? change.node_id,
      metricKey: change.metric_key ?? "",
      period: change.period ?? null,
      scenario: change.scenario ?? null,
      currentValueNumeric: change.current_value_numeric ?? null,
      currentValueText: change.current_value_text ?? null,
      proposedValueNumeric: change.proposed_value_numeric ?? null,
      proposedValueText: change.proposed_value_text ?? null,
      unit: change.unit ?? null,
      rationale: change.rationale ?? "",
      confidence: change.confidence ?? 0.5,
      evidenceIds: change.evidence_ids ?? [],
      writable: Boolean(change.writable),
      sheetName: change.sheet_name ?? null,
      cellRef: change.cell_ref ?? null,
      formula: change.formula ?? null,
    })),
    risks: (analysis.risks ?? []).map(valuationAgentFindingFromWire),
    openQuestions: analysis.open_questions ?? [],
    selectedEvidence: (analysis.selected_evidence ?? []).map((evidence) => ({
      evidenceId: evidence.evidence_id,
      kind: evidence.kind ?? "unknown",
      label: evidence.label ?? evidence.evidence_id,
      source: evidence.source ?? "",
      detail: evidence.detail ?? "",
      nodeId: evidence.node_id ?? null,
      writable: Boolean(evidence.writable),
    })),
    planner: item.planner ?? {},
    evidenceIds: item.evidence_ids ?? [],
    modelName: item.model_name ?? "",
    agentVersion: item.agent_version ?? "",
    errorMessage: item.error_message ?? null,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    completedAt: item.completed_at ?? null,
  };
}

function valuationDerivedModelFromWire(
  item: ValuationDerivedModelWire,
): PrivateFundValuationDerivedModel {
  return {
    derivedModelId: item.derived_model_id,
    datasetId: item.dataset_id,
    seriesId: item.series_id,
    analysisId: item.analysis_id,
    baseModelVersionId: item.base_model_version_id,
    derivedVersionNo: item.derived_version_no,
    outputFilename: item.output_filename,
    outputPath: item.output_path,
    checksum: item.checksum,
    appliedChanges: item.applied_changes ?? [],
    skippedChanges: item.skipped_changes ?? [],
    resourceFileName: item.resource_file_name ?? null,
    resourcePipelineJobId: item.resource_pipeline_job_id ?? null,
    resourceStatus: item.resource_status ?? "not_added",
    resourceDocId: item.resource_doc_id ?? null,
    resourceAddedAt: item.resource_added_at ?? null,
    resourceError: item.resource_error ?? null,
    createdAt: item.created_at,
  };
}

function valuationTrackingOverviewFromWire(
  payload: ValuationTrackingOverviewWire,
): PrivateFundValuationTrackingOverview {
  return {
    datasetId: payload.dataset_id,
    series: (payload.series ?? []).map(valuationModelSeriesFromWire),
    alerts: (payload.alerts ?? []).map(valuationAlertFromWire),
    metricAlerts: (payload.metric_alerts ?? []).map(valuationAlertFromWire),
    watchRules: (payload.watch_rules ?? []).map(valuationWatchRuleFromWire),
    jobs: (payload.jobs ?? []).map(valuationTrackingJobFromWire),
    agentAnalyses: (payload.agent_analyses ?? []).map(valuationAgentAnalysisFromWire),
    derivedModels: (payload.derived_models ?? []).map(valuationDerivedModelFromWire),
    unreadAlertCount: payload.unread_alert_count ?? 0,
    unreadMetricAlertCount: payload.unread_metric_alert_count ?? 0,
    changeCounts: payload.change_counts ?? {},
    analyzerVersion: payload.analyzer_version,
  };
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === "string") message = body.detail;
  } catch {
    // Keep the status-line fallback.
  }
  throw new Error(message);
}

export async function listPrivateFundProjects(): Promise<PrivateFundProject[]> {
  const body = await jsonOrThrow<{ projects: ProjectWire[] }>(
    await authenticatedFetch("/v1/private-fund/projects"),
  );
  return body.projects.map(projectFromWire);
}

export async function getPrivateFundProject(
  datasetId: string,
): Promise<{ project: PrivateFundProject; files: PrivateFundFile[] }> {
  const body = await jsonOrThrow<{ project: ProjectWire; files: FileWire[] }>(
    await authenticatedFetch(`/v1/private-fund/projects/${encodeURIComponent(datasetId)}`),
  );
  return {
    project: projectFromWire(body.project),
    files: body.files.map(fileFromWire),
  };
}

export async function deletePrivateFundProject(datasetId: string): Promise<void> {
  await jsonOrThrow<{ deleted_dataset_id: string }>(
    await authenticatedFetch(`/v1/private-fund/projects/${encodeURIComponent(datasetId)}`, {
      method: "DELETE",
    }),
  );
}

export async function updatePrivateFundProject(
  datasetId: string,
  input: {
    name: string;
    companyName?: string;
    companyTicker?: string;
  },
): Promise<PrivateFundProject> {
  const body = await jsonOrThrow<{ project: ProjectWire }>(
    await authenticatedFetch(`/v1/private-fund/projects/${encodeURIComponent(datasetId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        company_name: input.companyName ?? "",
        company_ticker: input.companyTicker ?? "",
      }),
    }),
  );
  return projectFromWire(body.project);
}

export async function getPrivateFundAssets(datasetId: string): Promise<PrivateFundAssetCatalog> {
  const payload = await jsonOrThrow<AssetCatalogWire>(
    await authenticatedFetch(`/v1/private-fund/projects/${encodeURIComponent(datasetId)}/assets`),
  );
  return assetCatalogFromWire(payload);
}

export async function savePrivateFundAsset(
  datasetId: string,
  input: {
    assetType?: string;
    title: string;
    summary?: string;
    contentMarkdown: string;
    sourceResponseId?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  },
): Promise<PrivateFundAssetCatalog> {
  const payload = await jsonOrThrow<AssetCatalogWire>(
    await authenticatedFetch(`/v1/private-fund/projects/${encodeURIComponent(datasetId)}/assets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        asset_type: input.assetType ?? "information",
        title: input.title,
        summary: input.summary ?? "",
        content_markdown: input.contentMarkdown,
        source_response_id: input.sourceResponseId,
        tags: input.tags ?? [],
        metadata: input.metadata ?? {},
      }),
    }),
  );
  return assetCatalogFromWire(payload);
}

export async function setPrivateFundAssetContext(
  datasetId: string,
  assetIds: string[],
): Promise<PrivateFundAssetCatalog> {
  const payload = await jsonOrThrow<AssetCatalogWire>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/assets/context`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset_ids: normalizeContextAssetIds(assetIds) }),
      },
    ),
  );
  return assetCatalogFromWire(payload);
}

export async function deletePrivateFundAssets(
  datasetId: string,
  assetIds: string[],
): Promise<PrivateFundAssetCatalog> {
  const payload = await jsonOrThrow<AssetCatalogWire>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/assets/delete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset_ids: assetIds }),
      },
    ),
  );
  return assetCatalogFromWire(payload);
}

export async function createPrivateFundProject(input: {
  name: string;
  datasetId?: string;
  companyName?: string;
  companyTicker?: string;
}): Promise<PrivateFundProject> {
  const body = await jsonOrThrow<{ project: ProjectWire }>(
    await authenticatedFetch("/v1/private-fund/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        dataset_id: input.datasetId ?? "",
        company_name: input.companyName ?? "",
        company_ticker: input.companyTicker ?? "",
      }),
    }),
  );
  return projectFromWire(body.project);
}

export async function uploadPrivateFundFilesGlobally(
  files: File[],
): Promise<PrivateFundGlobalUploadBatch> {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  const body = await jsonOrThrow<{ batch: GlobalUploadBatchWire }>(
    await authenticatedFetch("/v1/private-fund/uploads", {
      method: "POST",
      body: form,
    }),
  );
  return globalUploadBatchFromWire(body.batch);
}

export async function getPrivateFundGlobalUploadBatch(
  batchId: string,
): Promise<PrivateFundGlobalUploadBatch> {
  const body = await jsonOrThrow<{ batch: GlobalUploadBatchWire }>(
    await authenticatedFetch(`/v1/private-fund/upload-batches/${encodeURIComponent(batchId)}`),
  );
  return globalUploadBatchFromWire(body.batch);
}

export async function listPrivateFundGlobalUploadBatches(
  limit = 20,
): Promise<PrivateFundGlobalUploadBatch[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  const body = await jsonOrThrow<{ batches: GlobalUploadBatchWire[] }>(
    await authenticatedFetch(`/v1/private-fund/upload-batches?${params.toString()}`),
  );
  return body.batches.map(globalUploadBatchFromWire);
}

export async function routePrivateFundGlobalUploadItem(
  itemId: string,
  datasetId: string,
): Promise<PrivateFundGlobalUploadBatch> {
  const body = await jsonOrThrow<{ batch: GlobalUploadBatchWire }>(
    await authenticatedFetch(`/v1/private-fund/upload-items/${encodeURIComponent(itemId)}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset_id: datasetId }),
    }),
  );
  return globalUploadBatchFromWire(body.batch);
}

export async function uploadPrivateFundFiles(
  datasetId: string,
  files: File[],
): Promise<{
  project: PrivateFundProject;
  files: PrivateFundFile[];
  job: PrivateFundPipelineJob | null;
}> {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  const body = await jsonOrThrow<{
    project: ProjectWire;
    files: FileWire[];
    job?: PipelineJobWire | null;
  }>(
    await authenticatedFetch(`/v1/private-fund/projects/${encodeURIComponent(datasetId)}/files`, {
      method: "POST",
      body: form,
    }),
  );
  return {
    project: projectFromWire(body.project),
    files: body.files.map(fileFromWire),
    job: jobFromWire(body.job),
  };
}

export async function deletePrivateFundFile(
  datasetId: string,
  fileName: string,
): Promise<{ project: PrivateFundProject; files: PrivateFundFile[] }> {
  const body = await jsonOrThrow<{ project: ProjectWire; files: FileWire[] }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/files/${encodeURIComponent(fileName)}`,
      { method: "DELETE" },
    ),
  );
  return {
    project: projectFromWire(body.project),
    files: body.files.map(fileFromWire),
  };
}

export async function deletePrivateFundFiles(
  datasetId: string,
  fileNames: string[],
): Promise<{ project: PrivateFundProject; files: PrivateFundFile[] }> {
  const body = await jsonOrThrow<{ project: ProjectWire; files: FileWire[] }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/files/delete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_names: fileNames }),
      },
    ),
  );
  return {
    project: projectFromWire(body.project),
    files: body.files.map(fileFromWire),
  };
}

export async function getPrivateFundSourceFolders(
  datasetId: string,
): Promise<PrivateFundSourceFolderTree> {
  const body = await jsonOrThrow<SourceFolderTreeWire>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/source-folders`,
    ),
  );
  return sourceFolderTreeFromWire(body);
}

export async function createPrivateFundSourceFolder(
  datasetId: string,
  name: string,
): Promise<PrivateFundSourceFolderTree> {
  const body = await jsonOrThrow<SourceFolderTreeWire>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/source-folders`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      },
    ),
  );
  return sourceFolderTreeFromWire(body);
}

export async function renamePrivateFundSourceFolder(
  datasetId: string,
  folderId: string,
  name: string,
): Promise<PrivateFundSourceFolderTree> {
  const body = await jsonOrThrow<SourceFolderTreeWire>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/source-folders/${encodeURIComponent(folderId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      },
    ),
  );
  return sourceFolderTreeFromWire(body);
}

export async function deletePrivateFundSourceFolder(
  datasetId: string,
  folderId: string,
): Promise<PrivateFundSourceFolderTree> {
  const body = await jsonOrThrow<SourceFolderTreeWire>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/source-folders/${encodeURIComponent(folderId)}`,
      { method: "DELETE" },
    ),
  );
  return sourceFolderTreeFromWire(body);
}

export async function movePrivateFundSourceFile(
  datasetId: string,
  fileName: string,
  folderId: string | null,
): Promise<PrivateFundSourceFolderTree> {
  const body = await jsonOrThrow<SourceFolderTreeWire>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/source-folders/move-file`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_name: fileName, folder_id: folderId }),
      },
    ),
  );
  return sourceFolderTreeFromWire(body);
}

export async function activatePrivateFundProject(datasetId: string): Promise<void> {
  await jsonOrThrow(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/activate`,
      { method: "POST" },
    ),
  );
}

export async function runPrivateFundPipeline(datasetId: string): Promise<PrivateFundPipelineJob> {
  const body = await jsonOrThrow<{ job: PipelineJobWire }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/pipeline`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reset: false, recursive: true }),
      },
    ),
  );
  return jobFromWire(body.job)!;
}

export async function getPrivateFundPipelineJob(jobId: string): Promise<PrivateFundPipelineJob> {
  const body = await jsonOrThrow<{ job: PipelineJobWire }>(
    await authenticatedFetch(`/v1/private-fund/pipeline-jobs/${encodeURIComponent(jobId)}`),
  );
  return jobFromWire(body.job)!;
}

export async function getPrivateFundWorkflow(
  datasetId: string,
): Promise<PrivateFundResearchWorkflow> {
  const payload = await jsonOrThrow<ResearchWorkflowPayloadWire>(
    await authenticatedFetch(`/v1/private-fund/projects/${encodeURIComponent(datasetId)}/workflow`),
  );
  return researchWorkflowFromWire(payload);
}

export async function getPrivateFundTrackingOverview(
  datasetId: string,
): Promise<PrivateFundTrackingOverview> {
  const payload = await jsonOrThrow<TrackingOverviewWire>(
    await authenticatedFetch(`/v1/private-fund/projects/${encodeURIComponent(datasetId)}/tracking`),
  );
  return trackingOverviewFromWire(payload);
}

export async function getPrivateFundResearchItemGovernance(
  datasetId: string,
  archiveStatus: "active" | "archived",
): Promise<PrivateFundResearchItem[]> {
  const payload = await jsonOrThrow<{ items?: ResearchItemWire[] }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/research-items-governance?archive_status=${archiveStatus}`,
    ),
  );
  return (payload.items ?? []).map(researchItemFromWire);
}

async function mutatePrivateFundResearchItemGovernance(
  datasetId: string,
  action: "archive" | "restore" | "purge",
  itemIds: string[],
): Promise<Record<string, unknown>> {
  return jsonOrThrow<Record<string, unknown>>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/research-items-governance/${action}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_ids: itemIds }),
      },
    ),
  );
}

export const archivePrivateFundResearchItems = (datasetId: string, itemIds: string[]) =>
  mutatePrivateFundResearchItemGovernance(datasetId, "archive", itemIds);

export const restorePrivateFundResearchItems = (datasetId: string, itemIds: string[]) =>
  mutatePrivateFundResearchItemGovernance(datasetId, "restore", itemIds);

export const purgePrivateFundResearchItems = (datasetId: string, itemIds: string[]) =>
  mutatePrivateFundResearchItemGovernance(datasetId, "purge", itemIds);

export async function runPrivateFundTracking(datasetId: string): Promise<PrivateFundTrackingJob> {
  const body = await jsonOrThrow<{ job: TrackingJobWire }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/tracking/run`,
      { method: "POST" },
    ),
  );
  return trackingJobFromWire(body.job);
}

export async function rebuildPrivateFundTracking(
  datasetId: string,
): Promise<PrivateFundTrackingJob> {
  const body = await jsonOrThrow<{ job: TrackingJobWire }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/tracking/rebuild`,
      { method: "POST" },
    ),
  );
  return trackingJobFromWire(body.job);
}

export async function getPrivateFundTrackingJob(
  datasetId: string,
  jobId: string,
): Promise<PrivateFundTrackingJob> {
  const body = await jsonOrThrow<{ job: TrackingJobWire }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/tracking/jobs/${encodeURIComponent(jobId)}`,
    ),
  );
  return trackingJobFromWire(body.job);
}

export async function getPrivateFundValuationTrackingOverview(
  datasetId: string,
): Promise<PrivateFundValuationTrackingOverview> {
  const payload = await jsonOrThrow<ValuationTrackingOverviewWire>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/valuation-tracking`,
    ),
  );
  return valuationTrackingOverviewFromWire(payload);
}

export async function getPrivateFundValuationPeriodMarket(
  datasetId: string,
  seriesId: string,
  modelVersionId: string,
  period: string,
): Promise<PrivateFundValuationMarketSnapshot> {
  const query = new URLSearchParams({
    series_id: seriesId,
    model_version_id: modelVersionId,
    period,
  });
  const snapshot = await jsonOrThrow<ValuationMarketSnapshotWire>(
    await authenticatedFetch(
      "/v1/private-fund/projects/" +
        encodeURIComponent(datasetId) +
        "/valuation-tracking/period-market?" +
        query,
    ),
  );
  return {
    label: snapshot.label ?? period + " 市场快照",
    period: snapshot.period ?? period,
    errorMessage: snapshot.error_message ?? "",
    asOf: snapshot.as_of ?? "",
    status: snapshot.status ?? "unavailable",
    modelAvailableCount: snapshot.model_available_count ?? 0,
    actualAvailableCount: snapshot.actual_available_count ?? 0,
    comparedCount: snapshot.compared_count ?? 0,
    periodMismatchCount: snapshot.period_mismatch_count ?? 0,
    comparisons: (snapshot.comparisons ?? []).map(valuationMetricComparisonFromWire),
  };
}

export async function runPrivateFundValuationTracking(
  datasetId: string,
  scope?: { seriesId?: string; modelVersionId?: string; documentIds?: string[] },
): Promise<PrivateFundValuationTrackingJob[]> {
  const query = new URLSearchParams();
  if (scope?.seriesId) query.set("series_id", scope.seriesId);
  if (scope?.modelVersionId) query.set("model_version_id", scope.modelVersionId);
  for (const documentId of scope?.documentIds ?? []) query.append("document_ids", documentId);
  const suffix = query.size ? `?${query.toString()}` : "";
  const body = await jsonOrThrow<{ jobs?: ValuationTrackingJobWire[] }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/valuation-tracking/run${suffix}`,
      { method: "POST" },
    ),
  );
  return (body.jobs ?? []).map(valuationTrackingJobFromWire);
}

export async function searchPrivateFundValuationSecurities(
  datasetId: string,
  query: string,
): Promise<PrivateFundValuationSecurityCandidate[]> {
  const params = new URLSearchParams({ query });
  const body = await jsonOrThrow<{ candidates?: ValuationSecurityCandidateWire[] }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/valuation-securities?${params}`,
    ),
  );
  return (body.candidates ?? []).map((candidate) => ({
    securityId: candidate.security_id,
    market: candidate.market,
    exchange: candidate.exchange,
    companyName: candidate.company_name,
    ticker: candidate.ticker,
    source: candidate.source,
    sourceUpdatedAt: candidate.source_updated_at,
    label: candidate.label ?? `${candidate.company_name}（${candidate.ticker}）`,
  }));
}

export async function updatePrivateFundValuationModelIdentity(
  datasetId: string,
  seriesId: string,
  input: { companyName: string; companyTicker: string; changeSource?: string },
): Promise<{
  series: PrivateFundValuationModelSeries | null;
  jobs: PrivateFundValuationTrackingJob[];
  auditId: string;
}> {
  const body = await jsonOrThrow<{
    series?: ValuationModelSeriesWire | null;
    jobs?: ValuationTrackingJobWire[];
    audit_id?: string;
  }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/valuation-models/${encodeURIComponent(seriesId)}/identity`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_name: input.companyName,
          company_ticker: input.companyTicker,
          change_source: input.changeSource ?? "manual_entry",
        }),
      },
    ),
  );
  return {
    series: body.series ? valuationModelSeriesFromWire(body.series) : null,
    jobs: (body.jobs ?? []).map(valuationTrackingJobFromWire),
    auditId: body.audit_id ?? "",
  };
}
export async function getPrivateFundValuationModelOverview(
  datasetId: string,
  seriesId: string,
  modelVersionId: string,
): Promise<PrivateFundValuationModelOverview> {
  const payload = await jsonOrThrow<ValuationModelOverviewWire>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/valuation-models/${encodeURIComponent(seriesId)}/versions/${encodeURIComponent(modelVersionId)}/overview`,
    ),
  );
  return valuationModelOverviewFromWire(payload);
}

export async function comparePrivateFundValuationModelVersions(
  datasetId: string,
  seriesId: string,
  fromVersion: string,
  toVersion: string,
): Promise<PrivateFundValuationComparison> {
  const params = new URLSearchParams({ from_version: fromVersion, to_version: toVersion });
  const payload = await jsonOrThrow<{
    series: ValuationModelSeriesWire;
    from_version: ValuationModelVersionWire;
    to_version: ValuationModelVersionWire;
    changes?: ValuationChangeWire[];
  }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/valuation-models/${encodeURIComponent(seriesId)}/compare?${params}`,
    ),
  );
  return {
    series: valuationModelSeriesFromWire(payload.series),
    fromVersion: valuationModelVersionFromWire(payload.from_version),
    toVersion: valuationModelVersionFromWire(payload.to_version),
    changes: (payload.changes ?? []).map(valuationChangeFromWire),
  };
}

export async function runPrivateFundValuationAgentAnalysis(
  datasetId: string,
  seriesId: string,
  input: {
    baseModelVersionId?: string;
    comparisonModelVersionId?: string;
    focus?: string;
  } = {},
): Promise<PrivateFundValuationAgentAnalysis> {
  const body = await jsonOrThrow<{ analysis: ValuationAgentAnalysisWire }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/valuation-models/${encodeURIComponent(seriesId)}/agent-analysis`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base_model_version_id: input.baseModelVersionId ?? "",
          comparison_model_version_id: input.comparisonModelVersionId ?? "",
          focus: input.focus ?? "",
        }),
      },
    ),
  );
  return valuationAgentAnalysisFromWire(body.analysis);
}

export async function getPrivateFundValuationAgentAnalysis(
  datasetId: string,
  analysisId: string,
): Promise<PrivateFundValuationAgentAnalysis> {
  const body = await jsonOrThrow<{ analysis: ValuationAgentAnalysisWire }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/valuation-agent-analyses/${encodeURIComponent(analysisId)}`,
    ),
  );
  return valuationAgentAnalysisFromWire(body.analysis);
}

export async function derivePrivateFundValuationModel(
  datasetId: string,
  analysisId: string,
): Promise<PrivateFundValuationDerivedModel> {
  const body = await jsonOrThrow<{ derived_model: ValuationDerivedModelWire }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/valuation-agent-analyses/${encodeURIComponent(analysisId)}/derive-model`,
      { method: "POST" },
    ),
  );
  return valuationDerivedModelFromWire(body.derived_model);
}

export async function fetchPrivateFundValuationDerivedModelFile(
  datasetId: string,
  derivedModelId: string,
): Promise<Blob> {
  const response = await authenticatedFetch(
    `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/valuation-derived-models/${encodeURIComponent(derivedModelId)}/file`,
  );
  if (!response.ok) {
    await jsonOrThrow<never>(response);
  }
  return response.blob();
}

export async function addPrivateFundValuationDerivedModelToResources(
  datasetId: string,
  derivedModelId: string,
): Promise<PrivateFundValuationResourceImport> {
  const body = await jsonOrThrow<{
    derived_model: ValuationDerivedModelWire;
    job?: PipelineJobWire | null;
    resource_import: {
      status: string;
      file_name: string;
      already_added?: boolean;
      copied?: boolean;
    };
  }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/valuation-derived-models/${encodeURIComponent(derivedModelId)}/add-to-resources`,
      { method: "POST" },
    ),
  );
  return {
    derivedModel: valuationDerivedModelFromWire(body.derived_model),
    job: jobFromWire(body.job),
    status: body.resource_import.status,
    fileName: body.resource_import.file_name,
    alreadyAdded: Boolean(body.resource_import.already_added),
    copied: Boolean(body.resource_import.copied),
  };
}

export async function updatePrivateFundValuationAlert(
  datasetId: string,
  alertId: string,
  input: { status: "new" | "acknowledged" | "dismissed" | "snoozed"; snoozedUntil?: string },
): Promise<PrivateFundValuationAlert> {
  const body = await jsonOrThrow<{ alert: ValuationAlertWire }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/valuation-alerts/${encodeURIComponent(alertId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: input.status, snoozed_until: input.snoozedUntil }),
      },
    ),
  );
  return valuationAlertFromWire(body.alert);
}

export async function updatePrivateFundValuationWatchRule(
  datasetId: string,
  ruleId: string,
  input: Partial<{ active: boolean; minMateriality: string }>,
): Promise<PrivateFundValuationWatchRule> {
  const body = await jsonOrThrow<{ watch_rule: ValuationWatchRuleWire }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/valuation-watch-rules/${encodeURIComponent(ruleId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          active: input.active,
          min_materiality: input.minMateriality,
        }),
      },
    ),
  );
  return valuationWatchRuleFromWire(body.watch_rule);
}

export async function comparePrivateFundMemoVersions(
  datasetId: string,
  fromVersion: string,
  toVersion: string,
): Promise<PrivateFundMemoComparison> {
  const params = new URLSearchParams({ from_version: fromVersion, to_version: toVersion });
  const payload = await jsonOrThrow<{
    from_version: MemoVersionWire;
    to_version: MemoVersionWire;
    section_changes?: Array<{
      section_key: string;
      title: string;
      change_type: string;
      similarity: number;
      old_content?: string | null;
      new_content?: string | null;
      old_evidence_ids?: string[];
      new_evidence_ids?: string[];
    }>;
    item_changes?: Array<Record<string, unknown>>;
  }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/memo-comparisons?${params}`,
    ),
  );
  return {
    fromVersion: memoVersionFromWire(payload.from_version),
    toVersion: memoVersionFromWire(payload.to_version),
    sectionChanges: (payload.section_changes ?? []).map((change) => ({
      sectionKey: change.section_key,
      title: change.title,
      changeType: change.change_type,
      similarity: change.similarity,
      oldContent: change.old_content ?? "",
      newContent: change.new_content ?? "",
      oldEvidenceIds: change.old_evidence_ids ?? [],
      newEvidenceIds: change.new_evidence_ids ?? [],
    })),
    itemChanges: payload.item_changes ?? [],
  };
}

export async function getPrivateFundResearchItemTimeline(
  datasetId: string,
  itemId: string,
): Promise<PrivateFundResearchItemTimeline> {
  const payload = await jsonOrThrow<{
    item: ResearchItemWire;
    versions?: ResearchItemVersionWire[];
    changes?: Array<Record<string, unknown>>;
    observations?: Array<Record<string, unknown>>;
  }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/research-items/${encodeURIComponent(itemId)}/timeline`,
    ),
  );
  return {
    item: researchItemFromWire(payload.item),
    versions: (payload.versions ?? []).map(researchItemVersionFromWire),
    changes: payload.changes ?? [],
    observations: payload.observations ?? [],
  };
}

export async function updatePrivateFundAlert(
  datasetId: string,
  alertId: string,
  input: { status: "new" | "acknowledged" | "dismissed" | "snoozed"; snoozedUntil?: string },
): Promise<PrivateFundResearchAlert> {
  const body = await jsonOrThrow<{ alert: ResearchAlertWire }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/alerts/${encodeURIComponent(alertId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: input.status, snoozed_until: input.snoozedUntil }),
      },
    ),
  );
  return researchAlertFromWire(body.alert);
}

export async function createPrivateFundWatchRule(
  datasetId: string,
  input: {
    name: string;
    targetType: string;
    targetItemId?: string;
    query?: Record<string, unknown>;
    minPriority?: string;
    frequency?: string;
    active?: boolean;
  },
): Promise<PrivateFundWatchRule> {
  const body = await jsonOrThrow<{ watch_rule: WatchRuleWire }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/watch-rules`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: input.name,
          target_type: input.targetType,
          target_item_id: input.targetItemId,
          query: input.query ?? {},
          min_priority: input.minPriority ?? "medium",
          frequency: input.frequency ?? "on_ingest",
          active: input.active ?? true,
        }),
      },
    ),
  );
  return watchRuleFromWire(body.watch_rule);
}

export async function updatePrivateFundWatchRule(
  datasetId: string,
  ruleId: string,
  input: Partial<{
    name: string;
    targetType: string;
    targetItemId: string;
    query: Record<string, unknown>;
    minPriority: string;
    frequency: string;
    active: boolean;
  }>,
): Promise<PrivateFundWatchRule> {
  const body = await jsonOrThrow<{ watch_rule: WatchRuleWire }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/watch-rules/${encodeURIComponent(ruleId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: input.name,
          target_type: input.targetType,
          target_item_id: input.targetItemId,
          query: input.query,
          min_priority: input.minPriority,
          frequency: input.frequency,
          active: input.active,
        }),
      },
    ),
  );
  return watchRuleFromWire(body.watch_rule);
}

export async function selectPrivateFundWorkflowNode(
  datasetId: string,
  nodeId: string,
): Promise<PrivateFundResearchWorkflow> {
  const payload = await jsonOrThrow<ResearchWorkflowPayloadWire>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/workflow/current-node`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node_id: nodeId }),
      },
    ),
  );
  return researchWorkflowFromWire(payload);
}

export async function setPrivateFundWorkflowContext(
  datasetId: string,
  nodeIds: string[],
): Promise<PrivateFundResearchWorkflow> {
  const payload = await jsonOrThrow<ResearchWorkflowPayloadWire>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/workflow/context`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node_ids: nodeIds }),
      },
    ),
  );
  return researchWorkflowFromWire(payload);
}

export async function startPrivateFundWorkflowNode(
  datasetId: string,
  nodeId: string,
): Promise<PrivateFundResearchWorkflow> {
  const payload = await jsonOrThrow<ResearchWorkflowPayloadWire & { node_version: unknown }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/workflow/nodes/${encodeURIComponent(nodeId)}/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    ),
  );
  return researchWorkflowFromWire(payload);
}

export async function completePrivateFundWorkflowNode(
  datasetId: string,
  nodeId: string,
  input: {
    outputMarkdown: string;
    sourceResponseId?: string;
    evidenceIds?: string[];
  },
): Promise<PrivateFundResearchWorkflow> {
  const payload = await jsonOrThrow<ResearchWorkflowPayloadWire>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/workflow/nodes/${encodeURIComponent(nodeId)}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          output_markdown: input.outputMarkdown,
          source_response_id: input.sourceResponseId,
          evidence_ids: input.evidenceIds ?? [],
        }),
      },
    ),
  );
  return researchWorkflowFromWire(payload);
}

export async function addPrivateFundWorkflowAssumption(
  datasetId: string,
  nodeId: string,
  input: { content: string; sourceResponseId?: string },
): Promise<PrivateFundResearchWorkflow> {
  const payload = await jsonOrThrow<ResearchWorkflowPayloadWire>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/workflow/nodes/${encodeURIComponent(nodeId)}/assumptions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: input.content,
          source_response_id: input.sourceResponseId,
        }),
      },
    ),
  );
  return researchWorkflowFromWire(payload);
}

export async function createPrivateFundResearchReport(
  datasetId: string,
  title?: string,
): Promise<PrivateFundResearchReportVersion> {
  const body = await jsonOrThrow<{
    report: {
      report_id: string;
      report_version_id: string;
      version_no: number;
      title: string;
      markdown: string;
      node_versions: Record<string, string>;
      document_versions: Array<Record<string, unknown>>;
      created_at: string;
    };
  }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/workflow/reports`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      },
    ),
  );
  return {
    reportId: body.report.report_id,
    reportVersionId: body.report.report_version_id,
    versionNo: body.report.version_no,
    title: body.report.title,
    markdown: body.report.markdown,
    nodeVersions: body.report.node_versions,
    documentVersions: body.report.document_versions,
    createdAt: body.report.created_at,
  };
}

export function readActivePrivateFundProjectId(): string {
  try {
    return window.localStorage.getItem(ACTIVE_PRIVATE_FUND_PROJECT_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeActivePrivateFundProjectId(datasetId: string): void {
  try {
    if (datasetId) {
      window.localStorage.setItem(ACTIVE_PRIVATE_FUND_PROJECT_STORAGE_KEY, datasetId);
    } else {
      window.localStorage.removeItem(ACTIVE_PRIVATE_FUND_PROJECT_STORAGE_KEY);
    }
    window.dispatchEvent(
      new CustomEvent(ACTIVE_PRIVATE_FUND_PROJECT_CHANGED_EVENT, { detail: { datasetId } }),
    );
  } catch {
    // Local persistence is a convenience only.
  }
}

export function readPrivateFundResearchMode(): PrivateFundResearchMode {
  try {
    return window.localStorage.getItem(PRIVATE_FUND_RESEARCH_MODE_STORAGE_KEY) === "deep"
      ? "deep"
      : "standard";
  } catch {
    return "standard";
  }
}

export function writePrivateFundResearchMode(mode: PrivateFundResearchMode): void {
  try {
    window.localStorage.setItem(PRIVATE_FUND_RESEARCH_MODE_STORAGE_KEY, mode);
  } catch {
    // Local persistence is a convenience only.
  }
}

export function privateFundProjectPreamble(
  project: Pick<PrivateFundProject, "datasetId" | "name">,
  researchMode: PrivateFundResearchMode = "standard",
): string {
  const modeInstruction =
    researchMode === "deep"
      ? "研究级别：深度研究。扩大检索范围并提高 top_k，优先检索 metric_facts 并调用 source_detail，交叉核验 PDF 与 Excel 证据；按“结论—证据—不确定性—待复核”组织。"
      : "研究级别：常规研究。先检索本地结构化数据，回答保持简洁，并在证据不足时明确说明限制。";
  return [
    `当前会话必须基于私募投研资料项目「${project.name}」回答。`,
    `dataset_id: ${project.datasetId}`,
    modeInstruction,
    "所有资料状态、检索、source detail 和 memo 工具调用都必须显式使用上述 dataset_id；如果资料索引未完成，请先提示需要运行该项目的 pipeline。",
    "回答和 memo 生成都要优先使用该项目的本地资料、索引和 citation。",
    "任何关键结论，以及涉及公司事实、时间、金额、比例、估值、事件、管理层表述、政策、订单、业绩或利润率的陈述，都必须在对应陈述后紧跟可点击的 Markdown 引用（优先使用证据的 markdown_citation）。",
    "关键事实、时间、金额和事件必须逐条溯源；资料没有直接证据时，明确标注“资料未覆盖/需复核”，不得裸写或无证据扩写。",
    "勾选节点只是研究上下文，不等同于原始证据。上下文节点没有 evidence_sources 时必须重新调用 dataset_search 和 source_detail；禁止复制 [^1] 这类没有完整链接定义的裸脚注，也禁止在检索工具可用时声称系统无法获取引用链接。",
    "",
  ].join("\n");
}
