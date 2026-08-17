import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  open,
  realpath,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import type { ComputeResponse } from "@private-fund/contracts";
import {
  createResearchStore,
  openProjectDatabase,
  type DocumentVersionRecord,
  type ProjectDatabase,
  type ResearchStore,
} from "@private-fund/research-store";

import {
  finalizeProjectionRecords,
  projectRecord,
  type GenericProjectionRecordState,
  type ProjectionRecordState,
} from "./records.js";
import {
  ComputeProjectionError,
  type ComputeProjectionHandler,
  type ComputeProjectionResult,
  type ComputeResultProjectorPort,
  type DocumentProjectionOperation,
  type DocumentProjectionResult,
  type GenericDocumentFormat,
  type ProjectionExecutionOptions,
  type ProjectionJob,
} from "./types.js";

const DEFAULT_MAX_RECORDS_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RECORDS = 2_000_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const TENANT_NAMESPACE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const ARTIFACT_SHA256 = /^sha256:[a-f0-9]{64}$/;

export interface ComputeResultProjectorOptions {
  readonly dataRoot: string;
  readonly maxRecordsBytes?: number;
  readonly maxLineBytes?: number;
  readonly maxRecords?: number;
  readonly handlers?: readonly ComputeProjectionHandler[];
}

interface ProjectPaths {
  readonly projectRoot: string;
  readonly realProjectRoot: string;
}

interface DocumentProjectionContext extends ProjectPaths {
  readonly operation: DocumentProjectionOperation;
  readonly documentVersionId: string;
  readonly sourceSha256: string;
  readonly inputPath: string;
  readonly outputDirectory: string;
  readonly recordsPath: string;
  readonly recordsArtifact: ComputeResponse["artifacts"][number];
}

interface NdjsonStats {
  readonly bytes: number;
  readonly count: number;
  readonly checksum: string;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return resolved;
}

function projectionError(
  message: string,
  code:
    | "invalid_projection_job"
    | "projection_path_violation"
    | "projection_integrity_mismatch"
    | "projection_record_invalid"
    | "projection_limit_exceeded"
    | "projection_database_error",
  retryable = false,
  cause?: unknown,
): ComputeProjectionError {
  return new ComputeProjectionError(
    message,
    code,
    retryable,
    cause === undefined ? undefined : { cause },
  );
}

function pathIsWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function requireWithin(
  candidate: string,
  root: string,
  label: string,
): string {
  const resolved = path.resolve(candidate);
  if (!pathIsWithin(resolved, path.resolve(root))) {
    throw projectionError(
      `${label} escapes its tenant project directory`,
      "projection_path_violation",
    );
  }
  return resolved;
}

function requireWithinProject(
  candidate: string,
  projectRoot: string,
  realProjectRoot: string,
  label: string,
): string {
  const resolved = path.resolve(candidate);
  if (
    !pathIsWithin(resolved, path.resolve(projectRoot)) &&
    !pathIsWithin(resolved, path.resolve(realProjectRoot))
  ) {
    throw projectionError(
      `${label} escapes its tenant project directory`,
      "projection_path_violation",
    );
  }
  return resolved;
}

function payloadString(
  payload: Record<string, unknown>,
  key: string,
): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw projectionError(
      `Compute job payload.${key} must be a non-empty string`,
      "invalid_projection_job",
    );
  }
  return value;
}

function metricInteger(
  response: ComputeResponse,
  key: string,
): number {
  const value = response.metrics[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw projectionError(
      `Compute metrics.${key} must be a non-negative integer`,
      "projection_integrity_mismatch",
    );
  }
  return value;
}

function genericFormatForPath(inputPath: string): GenericDocumentFormat {
  switch (path.extname(inputPath).toLowerCase()) {
    case ".docx":
      return "docx";
    case ".pptx":
      return "pptx";
    case ".csv":
      return "csv";
    case ".md":
    case ".markdown":
      return "markdown";
    case ".txt":
      return "text";
    default:
      throw projectionError(
        "extract_document input has an unsupported file extension",
        "invalid_projection_job",
      );
  }
}

function metricGenericFormat(
  response: ComputeResponse,
  inputPath: string,
): GenericDocumentFormat {
  const expected = genericFormatForPath(inputPath);
  if (response.metrics.format !== expected) {
    throw projectionError(
      "Compute metrics.format does not match the registered document",
      "projection_integrity_mismatch",
    );
  }
  return expected;
}

function metricRecordTypeCounts(
  response: ComputeResponse,
  format: GenericDocumentFormat,
  expectedRecordCount: number,
  expectedTextRecordCount: number,
): Readonly<Record<string, number>> {
  const raw = response.metrics.recordTypeCounts;
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw)
  ) {
    throw projectionError(
      "Compute metrics.recordTypeCounts must be an object",
      "projection_integrity_mismatch",
    );
  }
  const allowed = new Set(
    format === "docx"
      ? ["document", "table", "text"]
      : format === "pptx"
        ? ["document", "slide", "text"]
        : format === "csv"
          ? ["document", "row", "text"]
          : ["document", "text"],
  );
  const counts: Record<string, number> = {};
  let total = 0;
  for (const [recordType, count] of Object.entries(raw)) {
    if (
      !allowed.has(recordType) ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      throw projectionError(
        "Compute metrics.recordTypeCounts contains invalid data",
        "projection_integrity_mismatch",
      );
    }
    counts[recordType] = count;
    total += count;
    if (!Number.isSafeInteger(total)) {
      throw projectionError(
        "Compute metrics.recordTypeCounts total is unsafe",
        "projection_integrity_mismatch",
      );
    }
  }
  if (
    total !== expectedRecordCount ||
    counts.document !== 1 ||
    (counts.text ?? 0) !== expectedTextRecordCount
  ) {
    throw projectionError(
      "Compute record type counts disagree with common metrics",
      "projection_integrity_mismatch",
    );
  }
  return counts;
}

function validateOptionalGenericMetrics(
  response: ComputeResponse,
  state: GenericProjectionRecordState,
): void {
  const expected: Record<string, number> =
    state.expectedFormat === "docx"
      ? {
          paragraphCount: state.paragraphCount,
          tableCount: state.tableCount,
          tableCellCount: state.tableCellCount,
        }
      : state.expectedFormat === "pptx"
        ? {
            slideCount: state.slideCount,
            slideTextCount: state.slideTextCount,
          }
        : state.expectedFormat === "csv"
          ? {
              rowCount: state.csvRowCount,
              cellCount: state.csvCellCount,
            }
          : state.expectedFormat === "markdown"
            ? {
                headingCount: state.headingCount,
                blockCount: state.blockCount,
              }
            : { lineCount: state.lineCount };
  for (const [key, actual] of Object.entries(expected)) {
    if (
      response.metrics[key] !== undefined &&
      metricInteger(response, key) !== actual
    ) {
      throw projectionError(
        `Compute metrics.${key} disagrees with projected records`,
        "projection_integrity_mismatch",
      );
    }
  }
}

function operationForDocumentJob(
  payload: Record<string, unknown>,
  inputPath: string,
): DocumentProjectionOperation {
  const inferred: DocumentProjectionOperation = (() => {
    switch (path.extname(inputPath).toLowerCase()) {
    case ".pdf":
      return "extract_pdf";
    case ".docx":
    case ".pptx":
    case ".csv":
    case ".md":
    case ".markdown":
    case ".txt":
      return "extract_document";
    case ".xlsx":
    case ".xlsm":
    case ".xltx":
    case ".xltm":
      return "extract_workbook";
    default:
      throw projectionError(
        "document.ingest input has no supported projection format",
        "invalid_projection_job",
      );
    }
  })();
  const explicit = payload.computeOperation;
  if (explicit === undefined) {
    return inferred;
  }
  if (
    explicit !== "extract_pdf" &&
    explicit !== "extract_document" &&
    explicit !== "extract_workbook"
  ) {
    throw projectionError(
      "document.ingest may only project extraction operations",
      "invalid_projection_job",
    );
  }
  if (explicit !== inferred) {
    throw projectionError(
      "document.ingest computeOperation does not match its source format",
      "invalid_projection_job",
    );
  }
  return explicit;
}

function safeRelativeArtifact(
  outputDirectory: string,
  artifactPath: string,
): string {
  if (
    artifactPath.length === 0 ||
    artifactPath.includes("\0") ||
    artifactPath.includes("\\") ||
    path.isAbsolute(artifactPath)
  ) {
    throw projectionError(
      "recordsFile must be a safe relative POSIX path",
      "projection_path_violation",
    );
  }
  return requireWithin(
    path.resolve(outputDirectory, artifactPath),
    outputDirectory,
    "recordsFile",
  );
}

function statusMetadata(
  version: DocumentVersionRecord,
  input: {
    readonly jobId: string;
    readonly operation: DocumentProjectionOperation;
    readonly status: "indexed" | "needs_ocr";
    readonly evidenceCount: number;
    readonly recordsBytes: number;
    readonly recordsChecksum: string;
    readonly metrics: Readonly<Record<string, unknown>>;
    readonly sourcePreview?: Readonly<Record<string, unknown>>;
  },
): Record<string, unknown> {
  return {
    ...version.metadata,
    computeProjection: {
      version: 1,
      jobId: input.jobId,
      operation: input.operation,
      status: input.status,
      evidenceCount: input.evidenceCount,
      recordsBytes: input.recordsBytes,
      recordsChecksum: input.recordsChecksum,
      metrics: input.metrics,
    },
    ...(input.sourcePreview === undefined
      ? {}
      : { sourcePreview: input.sourcePreview }),
  };
}

function excelColumnName(column: number): string {
  let remaining = column;
  let result = "";
  while (remaining > 0) {
    remaining -= 1;
    result =
      String.fromCharCode(65 + (remaining % 26)) + result;
    remaining = Math.floor(remaining / 26);
  }
  return result;
}

function workbookSourcePreview(
  state: ProjectionRecordState,
): Readonly<Record<string, unknown>> | undefined {
  if (state.operation !== "extract_workbook") {
    return undefined;
  }
  return {
    version: 1,
    kind: "excel",
    sheets: [...state.declaredSheets].map((sheetName) => {
      const bounds = state.worksheetBounds.get(sheetName);
      if (bounds === undefined) {
        throw projectionError(
          "Workbook preview metadata is missing worksheet bounds",
          "projection_record_invalid",
        );
      }
      return {
        sheetName,
        maxRow: bounds.maxRow,
        maxColumn: bounds.maxColumn,
        usedRange:
          bounds.maxRow === 0 || bounds.maxColumn === 0
            ? null
            : `A1:${excelColumnName(bounds.maxColumn)}${String(bounds.maxRow)}`,
        nonEmptyCellCount: bounds.nonEmptyCellCount,
        formulaCount: bounds.formulaCount,
      };
    }),
  };
}

function rollback(database: ProjectDatabase): void {
  if (database.connection.isTransaction) {
    database.connection.exec("ROLLBACK");
  }
}

function normalizedFailure(error: unknown): ComputeProjectionError {
  if (error instanceof ComputeProjectionError) {
    return error;
  }
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "";
  const retryable =
    code.startsWith("SQLITE_BUSY") ||
    code.startsWith("SQLITE_LOCKED") ||
    code.startsWith("SQLITE_IOERR") ||
    code === "EIO" ||
    code === "EMFILE" ||
    code === "ENFILE";
  return projectionError(
    `Compute result projection failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
    code.startsWith("SQLITE_")
      ? "projection_database_error"
      : "projection_record_invalid",
    retryable,
    error,
  );
}

async function markFailed(
  store: ResearchStore,
  version: DocumentVersionRecord,
  job: ProjectionJob,
  operation: DocumentProjectionOperation,
  error: ComputeProjectionError,
): Promise<void> {
  if (version.status === "indexed" || version.status === "needs_ocr") {
    return;
  }
  store.documents.updateVersionStatus(version.id, "failed", {
    activate: false,
    metadata: {
      ...version.metadata,
      computeProjection: {
        version: 1,
        jobId: job.id,
        operation,
        status: "failed",
        errorCode: error.code,
        error: error.message.slice(0, 20_000),
      },
    },
  });
}

function parseJsonLine(line: Buffer, lineNumber: number): unknown {
  if (line.length > 0 && line.at(-1) === 13) {
    line = line.subarray(0, line.length - 1);
  }
  if (line.length === 0) {
    throw projectionError(
      `NDJSON line ${String(lineNumber)} is empty`,
      "projection_record_invalid",
    );
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(line);
  } catch (error) {
    throw projectionError(
      `NDJSON line ${String(lineNumber)} is not valid UTF-8`,
      "projection_record_invalid",
      false,
      error,
    );
  }
  try {
    return JSON.parse(decoded) as unknown;
  } catch (error) {
    throw projectionError(
      `NDJSON line ${String(lineNumber)} is not valid JSON`,
      "projection_record_invalid",
      false,
      error,
    );
  }
}

async function streamNdjson(
  file: FileHandle,
  options: {
    readonly maxBytes: number;
    readonly maxLineBytes: number;
    readonly maxRecords: number;
    readonly signal?: AbortSignal;
  },
  onRecord: (value: unknown) => void,
): Promise<NdjsonStats> {
  const digest = createHash("sha256");
  let bytes = 0;
  let count = 0;
  let lineBytes = 0;
  let lineParts: Buffer[] = [];

  const consumeLine = (): void => {
    count += 1;
    if (count > options.maxRecords) {
      throw projectionError(
        `NDJSON exceeds ${String(options.maxRecords)} records`,
        "projection_limit_exceeded",
      );
    }
    const line = Buffer.concat(lineParts, lineBytes);
    lineParts = [];
    lineBytes = 0;
    onRecord(parseJsonLine(line, count));
  };

  const stream = file.createReadStream({
    autoClose: false,
    highWaterMark: 64 * 1024,
  });
  try {
    for await (const rawChunk of stream) {
      options.signal?.throwIfAborted();
      const chunk = Buffer.isBuffer(rawChunk)
        ? rawChunk
        : Buffer.from(rawChunk);
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        throw projectionError(
          `NDJSON exceeds ${String(options.maxBytes)} bytes`,
          "projection_limit_exceeded",
        );
      }
      digest.update(chunk);
      let start = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] !== 10) {
          continue;
        }
        const fragment = chunk.subarray(start, index);
        lineBytes += fragment.length;
        if (lineBytes > options.maxLineBytes) {
          throw projectionError(
            `NDJSON line exceeds ${String(options.maxLineBytes)} bytes`,
            "projection_limit_exceeded",
          );
        }
        lineParts.push(fragment);
        consumeLine();
        start = index + 1;
      }
      if (start < chunk.length) {
        const fragment = chunk.subarray(start);
        lineBytes += fragment.length;
        if (lineBytes > options.maxLineBytes) {
          throw projectionError(
            `NDJSON line exceeds ${String(options.maxLineBytes)} bytes`,
            "projection_limit_exceeded",
          );
        }
        lineParts.push(fragment);
      }
    }
    options.signal?.throwIfAborted();
    if (lineBytes > 0) {
      consumeLine();
    }
    return {
      bytes,
      count,
      checksum: `sha256:${digest.digest("hex")}`,
    };
  } finally {
    stream.destroy();
  }
}

async function attestSourceFile(
  sourcePath: string,
  expectedSize: number,
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<void> {
  const openFlags =
    constants.O_RDONLY |
    (typeof constants.O_NOFOLLOW === "number"
      ? constants.O_NOFOLLOW
      : 0);
  let sourceFile: FileHandle | undefined;
  try {
    sourceFile = await open(sourcePath, openFlags);
    const sourceStat = await sourceFile.stat();
    if (
      !sourceStat.isFile() ||
      sourceStat.size !== expectedSize
    ) {
      throw projectionError(
        "Registered document source size or type changed before projection",
        "projection_integrity_mismatch",
      );
    }
    const digest = createHash("sha256");
    const stream = sourceFile.createReadStream({
      autoClose: false,
      highWaterMark: 1024 * 1024,
    });
    try {
      for await (const rawChunk of stream) {
        signal?.throwIfAborted();
        digest.update(
          Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk),
        );
      }
      signal?.throwIfAborted();
    } finally {
      stream.destroy();
    }
    if (digest.digest("hex") !== expectedSha256) {
      throw projectionError(
        "Registered document source checksum changed before projection",
        "projection_integrity_mismatch",
      );
    }
    const currentRealPath = await realpath(sourcePath);
    if (currentRealPath !== sourcePath) {
      throw projectionError(
        "Registered document source path changed during attestation",
        "projection_path_violation",
      );
    }
  } catch (error) {
    if (error instanceof ComputeProjectionError) {
      throw error;
    }
    if (signal?.aborted) {
      throw error;
    }
    throw projectionError(
      "Could not attest the registered document source",
      "projection_integrity_mismatch",
      false,
      error,
    );
  } finally {
    await sourceFile?.close().catch(() => undefined);
  }
}

export class ComputeResultProjector implements ComputeResultProjectorPort {
  readonly #dataRoot: string;
  readonly #maxRecordsBytes: number;
  readonly #maxLineBytes: number;
  readonly #maxRecords: number;
  readonly #handlers: readonly ComputeProjectionHandler[];

  public constructor(options: ComputeResultProjectorOptions) {
    if (!path.isAbsolute(options.dataRoot)) {
      throw new RangeError("Compute projector dataRoot must be absolute");
    }
    this.#dataRoot = path.resolve(options.dataRoot);
    this.#maxRecordsBytes = positiveInteger(
      options.maxRecordsBytes,
      DEFAULT_MAX_RECORDS_BYTES,
      "maxRecordsBytes",
    );
    this.#maxLineBytes = positiveInteger(
      options.maxLineBytes,
      DEFAULT_MAX_LINE_BYTES,
      "maxLineBytes",
    );
    this.#maxRecords = positiveInteger(
      options.maxRecords,
      DEFAULT_MAX_RECORDS,
      "maxRecords",
    );
    this.#handlers = [...(options.handlers ?? [])];
  }

  public async project(
    job: ProjectionJob,
    response: ComputeResponse,
    execution: ProjectionExecutionOptions = {},
  ): Promise<ComputeProjectionResult> {
    execution.signal?.throwIfAborted();
    if (
      !IDENTIFIER.test(job.id) ||
      !IDENTIFIER.test(job.projectId) ||
      !TENANT_NAMESPACE.test(job.tenantNamespace)
    ) {
      throw projectionError(
        "Projection job has an invalid job, tenant or project identifier",
        "invalid_projection_job",
      );
    }
    if (response.status !== "completed" || response.error !== null) {
      throw projectionError(
        "Only completed compute results may be projected",
        "projection_integrity_mismatch",
      );
    }
    const paths = await this.#projectPaths(job);
    if (job.type === "document.ingest") {
      return this.#projectDocument(job, response, paths, execution);
    }
    const handler = this.#handlers.find((candidate) =>
      candidate.supports(job),
    );
    if (handler !== undefined) {
      return handler.project({
        job,
        response,
        ...paths,
        ...(execution.signal === undefined
          ? {}
          : { signal: execution.signal }),
      });
    }
    return {
      kind: "deferred",
      jobType: job.type,
      reason: "no_registered_handler",
    };
  }

  async #projectPaths(job: ProjectionJob): Promise<ProjectPaths> {
    const projectRoot = requireWithin(
      path.join(
        this.#dataRoot,
        "users",
        job.tenantNamespace,
        "projects",
        job.projectId,
      ),
      this.#dataRoot,
      "project root",
    );
    try {
      const [realDataRoot, realProjectRoot] = await Promise.all([
        realpath(this.#dataRoot),
        realpath(projectRoot),
      ]);
      if (!pathIsWithin(realProjectRoot, realDataRoot)) {
        throw projectionError(
          "Project root resolves outside dataRoot",
          "projection_path_violation",
        );
      }
      return { projectRoot, realProjectRoot };
    } catch (error) {
      if (error instanceof ComputeProjectionError) {
        throw error;
      }
      throw projectionError(
        "Projection project directory does not exist",
        "projection_path_violation",
        false,
        error,
      );
    }
  }

  async #documentContext(
    job: ProjectionJob,
    response: ComputeResponse,
    paths: ProjectPaths,
  ): Promise<DocumentProjectionContext> {
    const documentVersionId = payloadString(
      job.payload,
      "documentVersionId",
    );
    if (!IDENTIFIER.test(documentVersionId)) {
      throw projectionError(
        "documentVersionId is invalid",
        "invalid_projection_job",
      );
    }
    const sourceSha256 = payloadString(job.payload, "sourceSha256");
    if (!SHA256.test(sourceSha256)) {
      throw projectionError(
        "sourceSha256 must be a canonical SHA-256 digest",
        "invalid_projection_job",
      );
    }
    const inputPath = payloadString(job.payload, "inputPath");
    const outputDirectory = payloadString(job.payload, "outputDirectory");
    if (!path.isAbsolute(inputPath) || !path.isAbsolute(outputDirectory)) {
      throw projectionError(
        "Projection inputPath and outputDirectory must be absolute",
        "invalid_projection_job",
      );
    }
    const lexicalInput = requireWithinProject(
      inputPath,
      paths.projectRoot,
      paths.realProjectRoot,
      "inputPath",
    );
    const lexicalOutput = requireWithinProject(
      outputDirectory,
      paths.projectRoot,
      paths.realProjectRoot,
      "outputDirectory",
    );
    if (response.recordsFile === null) {
      throw projectionError(
        "Document extraction is missing recordsFile",
        "projection_integrity_mismatch",
      );
    }
    const matchingArtifacts = response.artifacts.filter(
      (artifact) => artifact.path === response.recordsFile,
    );
    if (matchingArtifacts.length !== 1) {
      throw projectionError(
        "recordsFile must identify exactly one artifact",
        "projection_integrity_mismatch",
      );
    }
    const recordsArtifact = matchingArtifacts[0]!;
    if (
      recordsArtifact.mediaType.toLowerCase() !== "application/x-ndjson" ||
      !ARTIFACT_SHA256.test(recordsArtifact.checksum) ||
      !Number.isSafeInteger(recordsArtifact.size) ||
      recordsArtifact.size < 0
    ) {
      throw projectionError(
        "Document records artifact descriptor is invalid",
        "projection_integrity_mismatch",
      );
    }
    if (recordsArtifact.size > this.#maxRecordsBytes) {
      throw projectionError(
        `Document records artifact exceeds ${String(this.#maxRecordsBytes)} bytes`,
        "projection_limit_exceeded",
      );
    }
    const lexicalRecords = safeRelativeArtifact(
      lexicalOutput,
      response.recordsFile,
    );
    let realInput: string;
    let realOutput: string;
    let realRecords: string;
    try {
      [realInput, realOutput, realRecords] = await Promise.all([
        realpath(lexicalInput),
        realpath(lexicalOutput),
        realpath(lexicalRecords),
      ]);
    } catch (error) {
      throw projectionError(
        "Projection input, output or records file does not exist",
        "projection_integrity_mismatch",
        false,
        error,
      );
    }
    if (
      !pathIsWithin(realInput, paths.realProjectRoot) ||
      !pathIsWithin(realOutput, paths.realProjectRoot) ||
      !pathIsWithin(realRecords, realOutput) ||
      !pathIsWithin(realRecords, paths.realProjectRoot)
    ) {
      throw projectionError(
        "Projection paths resolve outside their tenant project",
        "projection_path_violation",
      );
    }
    const operation = operationForDocumentJob(job.payload, inputPath);
    return {
      ...paths,
      operation,
      documentVersionId,
      sourceSha256,
      inputPath: realInput,
      outputDirectory: realOutput,
      recordsPath: realRecords,
      recordsArtifact,
    };
  }

  async #projectDocument(
    job: ProjectionJob,
    response: ComputeResponse,
    paths: ProjectPaths,
    execution: ProjectionExecutionOptions,
  ): Promise<DocumentProjectionResult> {
    const context = await this.#documentContext(job, response, paths);
    let database: ProjectDatabase;
    try {
      database = openProjectDatabase({
        projectRoot: context.projectRoot,
        databasePath: path.join("data", "research.sqlite3"),
      });
    } catch (error) {
      throw projectionError(
        "Could not open project research database",
        "projection_database_error",
        true,
        error,
      );
    }
    const store = createResearchStore(database);
    let version: DocumentVersionRecord | undefined;
    let recordsFile: FileHandle | undefined;
    try {
      try {
        version = store.documents.getVersion(context.documentVersionId);
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "not_found"
        ) {
          throw normalizedFailure(error);
        }
        throw projectionError(
          "documentVersionId is not registered in the tenant project",
          "projection_integrity_mismatch",
          false,
          error,
        );
      }
      const payloadDocumentId = job.payload.documentId;
      if (
        payloadDocumentId !== undefined &&
        (typeof payloadDocumentId !== "string" ||
          !IDENTIFIER.test(payloadDocumentId) ||
          payloadDocumentId !== version.documentId)
      ) {
        throw projectionError(
          "Task documentId does not match documentVersionId",
          "projection_integrity_mismatch",
        );
      }
      if (
        version.sha256 !== context.sourceSha256 ||
        response.metrics.inputChecksum !==
          `sha256:${context.sourceSha256}`
      ) {
        throw projectionError(
          "Task, document version and compute input checksums do not match",
          "projection_integrity_mismatch",
        );
      }
      let realVersionPath: string;
      try {
        realVersionPath = await realpath(
          path.isAbsolute(version.storedPath)
            ? version.storedPath
            : path.join(context.projectRoot, version.storedPath),
        );
      } catch (error) {
        throw projectionError(
          "Document version source file does not exist",
          "projection_integrity_mismatch",
          false,
          error,
        );
      }
      if (
        realVersionPath !== context.inputPath ||
        !pathIsWithin(realVersionPath, context.realProjectRoot)
      ) {
        throw projectionError(
          "Compute inputPath is not the registered document version file",
          "projection_integrity_mismatch",
        );
      }
      await attestSourceFile(
        context.inputPath,
        version.fileSize,
        context.sourceSha256,
        execution.signal,
      );
      const sourceName = path.basename(context.inputPath);
      const expectedRecordCount = metricInteger(response, "recordCount");
      const expectedRecordsBytes = metricInteger(response, "recordsBytes");
      if (
        expectedRecordsBytes !== context.recordsArtifact.size ||
        expectedRecordCount > this.#maxRecords
      ) {
        throw projectionError(
          "Compute record metrics exceed limits or disagree with artifact",
          expectedRecordCount > this.#maxRecords
            ? "projection_limit_exceeded"
            : "projection_integrity_mismatch",
        );
      }

      let expectedPageCount: number | undefined;
      let expectedSheetCount: number | undefined;
      let expectedCellCount: number | undefined;
      let genericState: GenericProjectionRecordState | null = null;
      if (context.operation === "extract_pdf") {
        expectedPageCount = metricInteger(response, "pageCount");
        const extractedPageCount = metricInteger(
          response,
          "extractedPageCount",
        );
        if (
          extractedPageCount !== expectedPageCount ||
          expectedRecordCount !== expectedPageCount
        ) {
          throw projectionError(
            "Document PDF extraction must cover every page exactly once",
            "projection_integrity_mismatch",
          );
        }
      } else if (context.operation === "extract_workbook") {
        expectedSheetCount = metricInteger(response, "sheetCount");
        expectedCellCount = metricInteger(response, "cellCount");
        const visitedCellCount = metricInteger(
          response,
          "visitedCellCount",
        );
        if (
          typeof response.metrics.macrosPresent !== "boolean" ||
          visitedCellCount < expectedCellCount ||
          expectedRecordCount !==
            1 + expectedSheetCount + expectedCellCount
        ) {
          throw projectionError(
            "Workbook extraction metrics are inconsistent",
            "projection_integrity_mismatch",
          );
        }
      } else {
        const expectedFormat = metricGenericFormat(
          response,
          context.inputPath,
        );
        const expectedInputBytes = metricInteger(
          response,
          "inputBytes",
        );
        const expectedTextRecordCount = metricInteger(
          response,
          "textRecordCount",
        );
        const expectedTextChars = metricInteger(
          response,
          "textChars",
        );
        if (
          expectedInputBytes !== version.fileSize ||
          expectedTextRecordCount > expectedRecordCount
        ) {
          throw projectionError(
            "Generic document metrics disagree with the registered source",
            "projection_integrity_mismatch",
          );
        }
        genericState = {
          expectedFormat,
          expectedTextRecordCount,
          expectedTextChars,
          expectedRecordTypeCounts: metricRecordTypeCounts(
            response,
            expectedFormat,
            expectedRecordCount,
            expectedTextRecordCount,
          ),
          headerSeen: false,
          textRecordCount: 0,
          textChars: 0,
          nonWhitespaceTextCount: 0,
          recordTypeCounts: new Map(),
          evidenceKeys: new Set(),
          paragraphCount: 0,
          tableCount: 0,
          tableCellCount: 0,
          currentTable: null,
          slideCount: 0,
          slideTextCount: 0,
          currentSlide: null,
          csvRowCount: 0,
          csvCellCount: 0,
          currentCsvRow: null,
          headingCount: 0,
          blockCount: 0,
          lineCount: 0,
          lastLineEnd: 0,
        };
      }

      const openFlags =
        constants.O_RDONLY |
        (typeof constants.O_NOFOLLOW === "number"
          ? constants.O_NOFOLLOW
          : 0);
      try {
        recordsFile = await open(context.recordsPath, openFlags);
      } catch (error) {
        throw projectionError(
          "Could not safely open document records artifact",
          "projection_integrity_mismatch",
          false,
          error,
        );
      }
      if ((await realpath(context.recordsPath)) !== context.recordsPath) {
        throw projectionError(
          "Document records artifact path changed before projection",
          "projection_path_violation",
        );
      }
      const recordsStat = await recordsFile.stat();
      if (
        !recordsStat.isFile() ||
        recordsStat.size !== context.recordsArtifact.size
      ) {
        throw projectionError(
          "Document records artifact size or type changed before projection",
          "projection_integrity_mismatch",
        );
      }

      const state: ProjectionRecordState = {
        operation: context.operation,
        sourceName,
        documentVersionId: context.documentVersionId,
        job,
        store,
        ...(expectedPageCount === undefined
          ? {}
          : { expectedPageCount }),
        ...(expectedSheetCount === undefined
          ? {}
          : { expectedSheetCount }),
        ...(expectedCellCount === undefined
          ? {}
          : { expectedCellCount }),
        recordCount: 0,
        evidenceCount: 0,
        pdfTextPageCount: 0,
        workbookSeen: false,
        currentSheet: null,
        currentSheetBounds: null,
        worksheetBounds: new Map(),
        pageNumbers: new Set(),
        declaredSheets: new Set(),
        worksheetNames: new Set(),
        cellKeys: new Set(),
        generic: genericState,
      };

      database.connection.exec("BEGIN IMMEDIATE");
      let stats: NdjsonStats;
      let status: "indexed" | "needs_ocr";
      try {
        stats = await streamNdjson(
          recordsFile,
          {
            maxBytes: this.#maxRecordsBytes,
            maxLineBytes: this.#maxLineBytes,
            maxRecords: this.#maxRecords,
            ...(execution.signal === undefined
              ? {}
              : { signal: execution.signal }),
          },
          (value) => {
            execution.signal?.throwIfAborted();
            projectRecord(value, state);
          },
        );
        if (
          stats.bytes !== expectedRecordsBytes ||
          stats.count !== expectedRecordCount ||
          stats.checksum !== context.recordsArtifact.checksum
        ) {
          throw projectionError(
            "Streamed records do not match compute artifact attestations",
            "projection_integrity_mismatch",
          );
        }
        status = finalizeProjectionRecords(state).status;
        if (state.generic !== null) {
          validateOptionalGenericMetrics(response, state.generic);
        }
        const sourcePreview = workbookSourcePreview(state);
        store.documents.updateVersionStatus(version.id, status, {
          activate: true,
          metadata: statusMetadata(version, {
            jobId: job.id,
            operation: context.operation,
            status,
            evidenceCount: state.evidenceCount,
            recordsBytes: stats.bytes,
            recordsChecksum: stats.checksum,
            metrics: response.metrics,
            ...(sourcePreview === undefined
              ? {}
              : { sourcePreview }),
          }),
        });
        database.connection.exec("COMMIT");
      } catch (error) {
        rollback(database);
        throw error;
      }
      return {
        kind: "document",
        documentVersionId: context.documentVersionId,
        evidenceCount: state.evidenceCount,
        status,
        recordsBytes: stats.bytes,
        recordsChecksum: stats.checksum,
      };
    } catch (error) {
      rollback(database);
      if (
        version !== undefined &&
        !execution.signal?.aborted
      ) {
        const failure = normalizedFailure(error);
        try {
          await markFailed(
            store,
            version,
            job,
            context.operation,
            failure,
          );
        } catch (markError) {
          throw projectionError(
            `Projection failed and document failure status could not be stored: ${failure.message}`,
            "projection_database_error",
            true,
            new AggregateError([failure, markError]),
          );
        }
        throw failure;
      }
      throw error;
    } finally {
      await recordsFile?.close().catch(() => undefined);
      database.close();
    }
  }
}
