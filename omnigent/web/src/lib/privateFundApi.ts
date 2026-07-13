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
