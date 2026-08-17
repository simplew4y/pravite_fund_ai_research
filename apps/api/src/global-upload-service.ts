import { createHash } from "node:crypto";
import {
  link,
  lstat,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";

import {
  GLOBAL_UPLOAD_BATCH_LIMIT_BYTES,
  GLOBAL_UPLOAD_FILE_LIMIT_BYTES,
  type GlobalUploadBatchDetail,
  type GlobalUploadBatchPage,
  type GlobalUploadItem,
  type GlobalUploadItemPage,
  type GlobalUploadProjectCandidate,
  type ListGlobalUploadBatchesQuery,
  type ListGlobalUploadItemsQuery,
  type RouteGlobalUploadItemRequest,
} from "@private-fund/contracts";
import {
  assertPathWithin,
  DomainError,
  ensureDirectoryWithin,
  newId,
  type TenantContext,
} from "@private-fund/core";
import type { ControlRepositories } from "@private-fund/db";

import type {
  JobService,
  ResearchService,
} from "./dependencies.js";

const MAX_FILES_PER_BATCH = 20;
const SUPPORTED_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".pptx",
  ".csv",
  ".md",
  ".markdown",
  ".txt",
  ".xlsx",
  ".xlsm",
  ".xltx",
  ".xltm",
]);

const MIME_BY_EXTENSION = new Map<string, string>([
  [".pdf", "application/pdf"],
  [
    ".docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [
    ".pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  [".csv", "text/csv"],
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".txt", "text/plain"],
  [
    ".xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  [".xlsm", "application/vnd.ms-excel.sheet.macroEnabled.12"],
  [
    ".xltx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  ],
  [".xltm", "application/vnd.ms-excel.template.macroEnabled.12"],
]);

const COMPATIBLE_MIME_TYPES = new Map<string, ReadonlySet<string>>([
  [".csv", new Set(["text/csv", "application/csv", "text/plain"])],
  [".md", new Set(["text/markdown", "text/x-markdown", "text/plain"])],
  [
    ".markdown",
    new Set(["text/markdown", "text/x-markdown", "text/plain"]),
  ],
]);

const ACTIVE_ITEM_STATUSES = new Set([
  "uploaded",
  "identifying",
  "routing",
  "routed",
  "indexing",
]);
const SUCCESS_ITEM_STATUSES = new Set([
  "completed",
  "completed_with_warnings",
  "duplicate",
]);

export interface GlobalUploadFileInput {
  readonly filename: string;
  readonly mimeType: string | null;
  readonly contents: AsyncIterable<Uint8Array | string>;
}

export interface CreateGlobalUploadInput {
  readonly idempotencyKey: string;
  readonly files: AsyncIterable<GlobalUploadFileInput>;
}

interface StoredUpload {
  readonly originalFilename: string;
  readonly stagedRelativePath: string;
  readonly fileType: string;
  readonly mimeType: string;
  readonly fileSize: number;
  readonly sha256: string;
}

function normalizeFilename(value: string): string {
  const filename = value.normalize("NFKC").trim();
  if (
    filename.length === 0 ||
    filename.length > 255 ||
    Buffer.byteLength(filename, "utf8") > 1_000 ||
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(filename)
  ) {
    throw new DomainError(
      "Uploaded filename is invalid",
      "invalid_upload_filename",
      400,
    );
  }
  return filename;
}

function normalizeMimeType(
  extension: string,
  value: string | null,
): string {
  const expected = MIME_BY_EXTENSION.get(extension);
  if (expected === undefined) {
    throw new DomainError(
      `Unsupported document type: ${extension || "extensionless"}`,
      "unsupported_document_type",
      415,
    );
  }
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (
    normalized.length === 0 ||
    normalized === "application/octet-stream"
  ) {
    return expected;
  }
  const compatible =
    COMPATIBLE_MIME_TYPES.get(extension) ??
    new Set([expected.toLowerCase()]);
  if (!compatible.has(normalized)) {
    throw new DomainError(
      `Upload MIME type ${normalized} does not match ${extension}`,
      "document_mime_mismatch",
      415,
    );
  }
  return normalized;
}

function normalizeIdentity(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, "");
}

function candidateProjects(
  filename: string,
  projects: ReturnType<ControlRepositories["projects"]["listForTenant"]>,
): GlobalUploadProjectCandidate[] {
  const filenameKey = normalizeIdentity(filename);
  const candidates: GlobalUploadProjectCandidate[] = [];
  for (const project of projects) {
    const ticker = normalizeIdentity(project.ticker);
    const company = normalizeIdentity(project.companyName);
    const name = normalizeIdentity(project.name);
    let score = 0;
    let method = "";
    if (ticker.length >= 2 && filenameKey.includes(ticker)) {
      score = 0.99;
      method = "filename_ticker";
    } else if (company.length >= 2 && filenameKey.includes(company)) {
      score = 0.97;
      method = "filename_company";
    } else if (name.length >= 2 && filenameKey.includes(name)) {
      score = 0.94;
      method = "filename_project";
    }
    if (score > 0) {
      candidates.push({
        projectId: project.id,
        projectName: project.name,
        companyName: project.companyName,
        ticker: project.ticker,
        score,
        method,
      });
    }
  }
  return candidates
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.projectName.localeCompare(right.projectName),
    )
    .slice(0, 8);
}

function automaticCandidate(
  candidates: readonly GlobalUploadProjectCandidate[],
): GlobalUploadProjectCandidate | null {
  const first = candidates[0];
  if (first === undefined || first.score < 0.98) {
    return null;
  }
  const secondScore = candidates[1]?.score ?? 0;
  return first.score - secondScore >= 0.05 ? first : null;
}

async function writeUpload(
  filename: string,
  contents: AsyncIterable<Uint8Array | string>,
  maximumBytes: number,
): Promise<{ readonly sha256: string; readonly size: number }> {
  const handle = await open(filename, "wx", 0o600);
  const digest = createHash("sha256");
  let size = 0;
  try {
    for await (const value of contents) {
      const chunk =
        typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
      size += chunk.byteLength;
      if (size > maximumBytes) {
        throw new DomainError(
          `Uploaded file exceeds ${String(maximumBytes)} bytes`,
          "upload_too_large",
          413,
        );
      }
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = await handle.write(
          chunk,
          offset,
          chunk.byteLength - offset,
          null,
        );
        if (written.bytesWritten === 0) {
          throw new Error("Upload writer made no progress");
        }
        offset += written.bytesWritten;
      }
    }
    if (size === 0) {
      throw new DomainError("Uploaded file is empty", "empty_upload", 400);
    }
    await handle.sync();
    return { sha256: digest.digest("hex"), size };
  } catch (error) {
    await rm(filename, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
}

async function inspectFile(
  filename: string,
): Promise<{ readonly sha256: string; readonly size: number }> {
  const handle = await open(filename, "r");
  const digest = createHash("sha256");
  let size = 0;
  let position = 0;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new DomainError(
        "Staged upload is not a regular file",
        "upload_object_invalid",
        409,
      );
    }
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const result = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        position,
      );
      if (result.bytesRead === 0) break;
      digest.update(buffer.subarray(0, result.bytesRead));
      size += result.bytesRead;
      position += result.bytesRead;
    }
    return { sha256: digest.digest("hex"), size };
  } finally {
    await handle.close();
  }
}

async function* readHandle(
  handle: Awaited<ReturnType<typeof open>>,
): AsyncGenerator<Uint8Array> {
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  for (;;) {
    const result = await handle.read(
      buffer,
      0,
      buffer.byteLength,
      position,
    );
    if (result.bytesRead === 0) return;
    position += result.bytesRead;
    yield buffer.subarray(0, result.bytesRead);
  }
}

function transitionKey(
  batchId: string,
  status: string,
  updatedAt: string,
): string {
  const version = createHash("sha256")
    .update(updatedAt)
    .digest("hex")
    .slice(0, 16);
  return `upload-batch:${batchId}:${status}:${version}`;
}

export class RepositoryGlobalUploadService {
  public constructor(
    private readonly repositories: ControlRepositories,
    private readonly research: ResearchService,
    private readonly jobs: JobService,
  ) {}

  public async create(
    tenant: TenantContext,
    input: CreateGlobalUploadInput,
  ): Promise<GlobalUploadBatchDetail> {
    const uploadsRoot = await ensureDirectoryWithin(
      path.join(tenant.root, "uploads"),
      tenant.root,
    );
    const incoming = await ensureDirectoryWithin(
      path.join(uploadsRoot, ".incoming", newId("request")),
      tenant.root,
    );
    const stored: StoredUpload[] = [];
    let totalBytes = 0;
    try {
      let index = 0;
      for await (const file of input.files) {
        index += 1;
        if (index > MAX_FILES_PER_BATCH) {
          throw new DomainError(
            `Upload batches support at most ${String(MAX_FILES_PER_BATCH)} files`,
            "upload_file_limit",
            413,
          );
        }
        const originalFilename = normalizeFilename(file.filename);
        const extension = path.extname(originalFilename).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(extension)) {
          throw new DomainError(
            `Unsupported document type: ${extension || "extensionless"}`,
            "unsupported_document_type",
            415,
          );
        }
        const mimeType = normalizeMimeType(extension, file.mimeType);
        const temporaryPath = assertPathWithin(
          path.join(incoming, `${String(index).padStart(4, "0")}.part`),
          tenant.root,
        );
        const written = await writeUpload(
          temporaryPath,
          file.contents,
          Math.min(
            GLOBAL_UPLOAD_FILE_LIMIT_BYTES,
            GLOBAL_UPLOAD_BATCH_LIMIT_BYTES - totalBytes,
          ),
        );
        totalBytes += written.size;
        if (totalBytes > GLOBAL_UPLOAD_BATCH_LIMIT_BYTES) {
          throw new DomainError(
            "Upload batch exceeds the 1 GiB limit",
            "upload_batch_too_large",
            413,
          );
        }
        const relative = path.posix.join(
          "objects",
          written.sha256.slice(0, 2),
          written.sha256,
          `${String(index).padStart(4, "0")}${extension}`,
        );
        const objectDirectory = await ensureDirectoryWithin(
          path.join(uploadsRoot, path.dirname(relative)),
          tenant.root,
        );
        const objectPath = assertPathWithin(
          path.join(objectDirectory, path.basename(relative)),
          tenant.root,
        );
        try {
          await link(temporaryPath, objectPath);
        } catch (error) {
          if (
            typeof error !== "object" ||
            error === null ||
            !("code" in error) ||
            error.code !== "EEXIST"
          ) {
            throw error;
          }
          const existing = await inspectFile(objectPath);
          if (
            existing.sha256 !== written.sha256 ||
            existing.size !== written.size
          ) {
            throw new DomainError(
              "A staged upload object failed integrity verification",
              "upload_object_integrity_mismatch",
              409,
            );
          }
        }
        await rm(temporaryPath, { force: true });
        stored.push({
          originalFilename,
          stagedRelativePath: relative,
          fileType: extension.slice(1),
          mimeType,
          fileSize: written.size,
          sha256: written.sha256,
        });
      }
      if (stored.length === 0) {
        throw new DomainError(
          "At least one file is required",
          "empty_upload",
          400,
        );
      }
      const created = this.repositories.uploads.createBatchForTenant(
        tenant.dataNamespace,
        {
          idempotencyKey: input.idempotencyKey,
          actorId: tenant.userId,
          items: stored,
        },
      );
      if (!created.created) {
        return this.reconcileBatch(tenant, created.batch.batchId);
      }
      return this.identifyAndRoute(tenant, created.batch);
    } finally {
      await rm(incoming, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  public async getBatch(
    tenant: TenantContext,
    batchId: string,
  ): Promise<GlobalUploadBatchDetail> {
    return this.reconcileBatch(tenant, batchId);
  }

  public async listBatches(
    tenant: TenantContext,
    query: Partial<ListGlobalUploadBatchesQuery>,
  ): Promise<GlobalUploadBatchPage> {
    const page = this.repositories.uploads.listBatchesForTenant(
      tenant.dataNamespace,
      query,
    );
    for (const batch of page.items) {
      if (
        batch.status !== "completed" &&
        batch.status !== "completed_with_errors" &&
        batch.status !== "failed"
      ) {
        await this.reconcileBatch(tenant, batch.batchId);
      }
    }
    return this.repositories.uploads.listBatchesForTenant(
      tenant.dataNamespace,
      query,
    );
  }

  public async listItems(
    tenant: TenantContext,
    query: Partial<ListGlobalUploadItemsQuery>,
  ): Promise<GlobalUploadItemPage> {
    const page = this.repositories.uploads.listItemsForTenant(
      tenant.dataNamespace,
      query,
    );
    for (const batchId of new Set(page.items.map((item) => item.batchId))) {
      await this.reconcileBatch(tenant, batchId);
    }
    return this.repositories.uploads.listItemsForTenant(
      tenant.dataNamespace,
      query,
    );
  }

  public async routeItem(
    tenant: TenantContext,
    itemId: string,
    input: RouteGlobalUploadItemRequest,
  ): Promise<GlobalUploadBatchDetail> {
    const routed = this.repositories.uploads.routeItemForTenant(
      tenant.dataNamespace,
      itemId,
      {
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
        actorId: tenant.userId,
      },
    );
    await this.ingestRoutedItem(
      tenant,
      routed,
      `${input.idempotencyKey}:ingest`,
    );
    return this.reconcileBatch(tenant, routed.batchId);
  }

  private async identifyAndRoute(
    tenant: TenantContext,
    created: GlobalUploadBatchDetail,
  ): Promise<GlobalUploadBatchDetail> {
    let batch = this.repositories.uploads.transitionBatchForTenant(
      tenant.dataNamespace,
      created.batchId,
      {
        status: "identifying",
        message: "Identifying project candidates",
        idempotencyKey: `identify:${created.batchId}`,
        actorId: tenant.userId,
      },
    );
    const projects = this.repositories.projects.listForTenant(
      tenant.dataNamespace,
    );
    const automatic: Array<{
      readonly item: GlobalUploadItem;
      readonly candidate: GlobalUploadProjectCandidate;
    }> = [];
    for (const item of batch.items) {
      const candidates = candidateProjects(item.originalFilename, projects);
      const top = candidates[0];
      const identifying =
        this.repositories.uploads.transitionItemForTenant(
          tenant.dataNamespace,
          item.itemId,
          {
            status: "identifying",
            idempotencyKey: `identify:${created.batchId}:${item.itemId}:start`,
            actorId: tenant.userId,
            candidateProjects: candidates,
            companyName: top?.companyName ?? null,
            ticker: top?.ticker ?? null,
            companyConfidence: top?.score ?? 0,
            companyDetectionMethod: top?.method ?? null,
          },
        );
      const review = this.repositories.uploads.transitionItemForTenant(
        tenant.dataNamespace,
        identifying.itemId,
        {
          status: "needs_review",
          idempotencyKey: `identify:${created.batchId}:${item.itemId}:review`,
          actorId: tenant.userId,
        },
      );
      const candidate = automaticCandidate(candidates);
      if (candidate !== null) {
        automatic.push({ item: review, candidate });
      }
    }

    if (automatic.length === 0) {
      return this.repositories.uploads.transitionBatchForTenant(
        tenant.dataNamespace,
        created.batchId,
        {
          status: "needs_review",
          message: "Choose a project for each unmatched file",
          idempotencyKey: `identify:${created.batchId}:needs-review`,
          actorId: tenant.userId,
        },
      );
    }

    for (const { item, candidate } of automatic) {
      const routing =
        this.repositories.uploads.transitionItemForTenant(
          tenant.dataNamespace,
          item.itemId,
          {
            status: "routing",
            idempotencyKey: `auto-route:${item.itemId}:${candidate.projectId}`,
            actorId: tenant.userId,
            targetProjectId: candidate.projectId,
            routeConfidence: candidate.score,
            routeMethod: candidate.method,
          },
        );
      batch = this.repositories.uploads.getBatchForTenant(
        tenant.dataNamespace,
        created.batchId,
      );
      if (batch.status === "identifying") {
        batch = this.repositories.uploads.transitionBatchForTenant(
          tenant.dataNamespace,
          created.batchId,
          {
            status: "routing",
            message: "Routing high-confidence uploads",
            idempotencyKey: `auto-route:${created.batchId}:routing`,
            actorId: tenant.userId,
          },
        );
      }
      await this.ingestRoutedItem(
        tenant,
        routing,
        `auto-route:${item.itemId}:${candidate.projectId}:ingest`,
      );
    }
    return this.reconcileBatch(tenant, created.batchId);
  }

  private async ingestRoutedItem(
    tenant: TenantContext,
    item: GlobalUploadItem,
    idempotencyKey: string,
  ): Promise<void> {
    if (item.targetProjectId === null) {
      throw new DomainError(
        "Upload item has no target project",
        "upload_project_required",
        409,
      );
    }
    try {
      const handle = await this.openStagedFile(tenant, item);
      try {
        const uploaded = await this.research.uploadDocument(
          tenant,
          item.targetProjectId,
          {
            filename: item.originalFilename,
            mimeType: item.mimeType,
            contents: readHandle(handle),
          },
        );
        this.repositories.uploads.transitionItemForTenant(
          tenant.dataNamespace,
          item.itemId,
          {
            status: "indexing",
            idempotencyKey,
            actorId: tenant.userId,
            targetProjectId: item.targetProjectId,
            routeConfidence: item.routeConfidence,
            routeMethod: item.routeMethod,
            pipelineJobId: uploaded.job.id,
            documentId: uploaded.document.id,
            errorMessage: null,
          },
        );
      } finally {
        await handle.close();
      }
      const batch = this.repositories.uploads.getBatchForTenant(
        tenant.dataNamespace,
        item.batchId,
      );
      if (batch.status === "routing" || batch.status === "needs_review") {
        this.repositories.uploads.transitionBatchForTenant(
          tenant.dataNamespace,
          item.batchId,
          {
            status: "indexing",
            message: "Document ingestion is queued",
            idempotencyKey: transitionKey(
              item.batchId,
              "indexing",
              batch.updatedAt,
            ),
            actorId: tenant.userId,
          },
        );
      }
    } catch (error) {
      const current = this.repositories.uploads.getItemForTenant(
        tenant.dataNamespace,
        item.itemId,
      );
      if (
        current.status === "routing" ||
        current.status === "routed" ||
        current.status === "indexing"
      ) {
        this.repositories.uploads.transitionItemForTenant(
          tenant.dataNamespace,
          item.itemId,
          {
            status: "failed",
            idempotencyKey: `${idempotencyKey}:failed`,
            actorId: tenant.userId,
            errorMessage: "Routing or document ingestion failed",
          },
        );
      }
      // Intake has already succeeded at this point. Keep the durable item and
      // let the batch converge to completed_with_errors so callers can inspect
      // and retry it instead of turning a recoverable per-file failure into an
      // opaque request-level 500.
      void error;
    }
  }

  private async reconcileBatch(
    tenant: TenantContext,
    batchId: string,
  ): Promise<GlobalUploadBatchDetail> {
    let batch = this.repositories.uploads.getBatchForTenant(
      tenant.dataNamespace,
      batchId,
    );
    for (const item of batch.items) {
      if (item.status !== "indexing" || item.pipelineJobId === null) {
        continue;
      }
      const job = await this.jobs.get(tenant, item.pipelineJobId);
      if (job === null) {
        this.repositories.uploads.transitionItemForTenant(
          tenant.dataNamespace,
          item.itemId,
          {
            status: "failed",
            idempotencyKey: `upload-job:${item.pipelineJobId}:missing`,
            actorId: tenant.userId,
            errorMessage: "The document ingestion job is unavailable",
          },
        );
      } else if (job.status === "completed") {
        this.repositories.uploads.transitionItemForTenant(
          tenant.dataNamespace,
          item.itemId,
          {
            status: "completed",
            idempotencyKey: `upload-job:${job.id}:completed`,
            actorId: tenant.userId,
          },
        );
      } else if (job.status === "failed" || job.status === "cancelled") {
        this.repositories.uploads.transitionItemForTenant(
          tenant.dataNamespace,
          item.itemId,
          {
            status: "failed",
            idempotencyKey: `upload-job:${job.id}:${job.status}`,
            actorId: tenant.userId,
            errorMessage: "Document ingestion did not complete",
          },
        );
      }
    }
    batch = this.repositories.uploads.getBatchForTenant(
      tenant.dataNamespace,
      batchId,
    );
    const statuses = batch.items.map((item) => item.status);
    let target:
      | "indexing"
      | "needs_review"
      | "completed"
      | "completed_with_errors"
      | null = null;
    if (statuses.some((status) => ACTIVE_ITEM_STATUSES.has(status))) {
      if (
        statuses.some(
          (status) =>
            status === "routing" ||
            status === "routed" ||
            status === "indexing",
        )
      ) {
        target = "indexing";
      }
    } else if (statuses.some((status) => status === "needs_review")) {
      target = "needs_review";
    } else if (statuses.every((status) => SUCCESS_ITEM_STATUSES.has(status))) {
      target = "completed";
    } else if (
      statuses.every(
        (status) =>
          SUCCESS_ITEM_STATUSES.has(status) || status === "failed",
      )
    ) {
      target = "completed_with_errors";
    }
    if (target !== null && batch.status !== target) {
      batch = this.repositories.uploads.transitionBatchForTenant(
        tenant.dataNamespace,
        batchId,
        {
          status: target,
          message:
            target === "completed"
              ? "All routed files completed ingestion"
              : target === "completed_with_errors"
                ? "One or more files failed ingestion"
                : target === "needs_review"
                  ? "Choose a project for each unmatched file"
                  : "Document ingestion is running",
          idempotencyKey: transitionKey(
            batchId,
            target,
            batch.updatedAt,
          ),
          actorId: tenant.userId,
        },
      );
    }
    return batch;
  }

  private async openStagedFile(
    tenant: TenantContext,
    item: GlobalUploadItem,
  ) {
    const uploadsRoot = assertPathWithin(
      path.join(tenant.root, "uploads"),
      tenant.root,
    );
    const candidate = assertPathWithin(
      path.join(uploadsRoot, item.stagedRelativePath),
      uploadsRoot,
    );
    const details = await lstat(candidate).catch(() => null);
    if (
      details === null ||
      !details.isFile() ||
      details.isSymbolicLink()
    ) {
      throw new DomainError(
        "Staged upload is unavailable",
        "upload_object_unavailable",
        410,
      );
    }
    const [realCandidate, realRoot] = await Promise.all([
      realpath(candidate),
      realpath(uploadsRoot),
    ]);
    assertPathWithin(realCandidate, realRoot);
    const actual = await inspectFile(realCandidate);
    if (actual.sha256 !== item.sha256 || actual.size !== item.fileSize) {
      throw new DomainError(
        "Staged upload failed integrity verification",
        "upload_object_integrity_mismatch",
        409,
      );
    }
    return open(realCandidate, "r");
  }
}
