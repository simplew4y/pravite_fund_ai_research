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
  kind: "system" | "custom";
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
  counts: Record<string, number>;
  unreadAlertCount: number;
  items: PrivateFundResearchItem[];
  alerts: PrivateFundResearchAlert[];
  watchRules: PrivateFundWatchRule[];
  jobs: PrivateFundTrackingJob[];
  memoSeries: PrivateFundMemoSeries[];
  memoVersions: PrivateFundMemoVersion[];
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
    kind: "system" | "custom";
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
  counts?: Record<string, number>;
  unread_alert_count?: number;
  items?: ResearchItemWire[];
  alerts?: ResearchAlertWire[];
  watch_rules?: WatchRuleWire[];
  jobs?: TrackingJobWire[];
  memo_series?: MemoSeriesWire[];
  memo_versions?: MemoVersionWire[];
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
    assets: payload.assets.map((asset) => ({
      assetId: asset.asset_id,
      assetType: asset.asset_type,
      title: asset.title,
      summary: asset.summary ?? "",
      contentMarkdown: asset.content_markdown ?? "",
      format: asset.format ?? "markdown",
      status: asset.status ?? "completed",
      sourceKind: asset.source_kind ?? "saved_information",
      sourceId: asset.source_id ?? null,
      tags: asset.tags ?? [],
      createdAt: asset.created_at ?? null,
      updatedAt: asset.updated_at ?? null,
      versionNo: asset.version_no ?? 1,
      evidenceCount: asset.evidence_count ?? 0,
      fileType: asset.file_type ?? null,
      storedPath: asset.stored_path ?? null,
      metadata: asset.metadata ?? {},
    })),
    contextAssetIds: payload.context_asset_ids ?? [],
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
    counts: payload.counts ?? {},
    unreadAlertCount: payload.unread_alert_count ?? 0,
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
        body: JSON.stringify({ asset_ids: assetIds }),
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
        dataset_id: input.datasetId,
        company_name: input.companyName ?? "",
        company_ticker: input.companyTicker ?? "",
      }),
    }),
  );
  return projectFromWire(body.project);
}

export async function uploadPrivateFundFiles(
  datasetId: string,
  files: File[],
): Promise<{ project: PrivateFundProject; files: PrivateFundFile[] }> {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  const body = await jsonOrThrow<{ project: ProjectWire; files: FileWire[] }>(
    await authenticatedFetch(`/v1/private-fund/projects/${encodeURIComponent(datasetId)}/files`, {
      method: "POST",
      body: form,
    }),
  );
  return {
    project: projectFromWire(body.project),
    files: body.files.map(fileFromWire),
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

export async function runPrivateFundTracking(datasetId: string): Promise<PrivateFundTrackingJob> {
  const body = await jsonOrThrow<{ job: TrackingJobWire }>(
    await authenticatedFetch(
      `/v1/private-fund/projects/${encodeURIComponent(datasetId)}/tracking/run`,
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
