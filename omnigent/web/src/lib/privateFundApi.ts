import { authenticatedFetch } from "./identity";

export const PRIVATE_FUND_DATASET_ID_LABEL_KEY = "private_fund.dataset_id";
export const PRIVATE_FUND_DATASET_NAME_LABEL_KEY = "private_fund.dataset_name";
export const ACTIVE_PRIVATE_FUND_PROJECT_STORAGE_KEY = "omnigent.privateFund.activeProject";
export const ACTIVE_PRIVATE_FUND_PROJECT_CHANGED_EVENT =
  "omnigent.privateFund.activeProjectChanged";

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
        body: JSON.stringify({ reset: true, recursive: true }),
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

export function privateFundProjectPreamble(project: PrivateFundProject): string {
  return [
    `当前会话必须基于私募投研资料项目「${project.name}」回答。`,
    `dataset_id: ${project.datasetId}`,
    "如果资料索引未完成，请先提示需要运行该项目的 pipeline；回答和 memo 生成都要优先使用该项目的本地资料、索引和 citation。",
    "",
  ].join("\n");
}
