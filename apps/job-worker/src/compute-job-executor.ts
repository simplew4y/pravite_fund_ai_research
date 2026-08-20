import { createHash } from "node:crypto";
import path from "node:path";

import type {
  ComputeRequest,
  ComputeResponse,
  Job,
} from "@private-fund/contracts";
import type {
  ComputeClient,
  ComputeExecutionOptions,
} from "@private-fund/compute-client";

type ComputeOperation = ComputeRequest["operation"];

export type ComputeBackedJobType =
  | "document.ingest"
  | "report.generate";

export const COMPUTE_BACKED_JOB_TYPES: readonly ComputeBackedJobType[] = [
  "document.ingest",
  "report.generate",
];

export interface ComputeJob
  extends Pick<
    Job,
    "id" | "type" | "payload" | "attempt" | "tenantNamespace" | "projectId"
  > {}

export interface ComputeTransport {
  execute(
    request: ComputeRequest,
    execution?: ComputeExecutionOptions,
  ): Promise<ComputeResponse>;
}

export interface ComputePathAuthorizer {
  authorize(job: ComputeJob, request: ComputeRequest): Promise<void>;
}

export class InvalidComputeJobError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidComputeJobError";
  }
}

export class InvalidComputeResultError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidComputeResultError";
  }
}

export class ComputeJobResponseError extends Error {
  public constructor(
    public readonly response: ComputeResponse,
    public readonly retryable: boolean,
  ) {
    super(response.error ?? "Compute worker returned a failed response");
    this.name = "ComputeJobResponseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadString(
  payload: Record<string, unknown>,
  name: string,
): string {
  const value = payload[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidComputeJobError(
      `Compute job payload.${name} must be a non-empty string`,
    );
  }
  return value;
}

function inferDocumentOperation(inputPath: string): ComputeOperation {
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
      throw new InvalidComputeJobError(
        `No compute extractor is registered for ${path.extname(inputPath) || "an extensionless document"}`,
      );
  }
}

function operationForJob(
  job: ComputeJob,
  inputPath: string,
): ComputeOperation {
  const explicit = job.payload.computeOperation;
  if (explicit !== undefined) {
    if (
      explicit !== "extract_pdf" &&
      explicit !== "extract_document" &&
      explicit !== "render_pdf_page" &&
      explicit !== "extract_workbook" &&
      explicit !== "render_report"
    ) {
      throw new InvalidComputeJobError(
        "Compute job payload.computeOperation is not a contract operation",
      );
    }
    return explicit;
  }

  switch (job.type) {
    case "document.ingest":
      return inferDocumentOperation(inputPath);
    case "report.generate":
      return "render_report";
    default:
      throw new InvalidComputeJobError(
        `Job type ${job.type} is not backed by the compute worker`,
      );
  }
}

function requestIdFor(job: ComputeJob): string {
  const digest = createHash("sha256")
    .update(`${job.id}:${String(job.attempt)}`)
    .digest("hex");
  return `compute:${digest}`;
}

function retryableResponse(response: ComputeResponse): boolean {
  const errorCode = response.metrics.errorCode;
  return (
    errorCode === "compute_failed" ||
    errorCode === "worker_error" ||
    errorCode === "dependency_unavailable" ||
    errorCode === "provider_network_error"
  );
}

function artifactWithMediaType(
  response: ComputeResponse,
  predicate: (mediaType: string) => boolean,
): ComputeResponse["artifacts"][number] | undefined {
  return response.artifacts.find((artifact) =>
    predicate(artifact.mediaType.toLowerCase()),
  );
}

function recordsArtifact(response: ComputeResponse) {
  if (response.recordsFile === null) {
    throw new InvalidComputeResultError(
      "Completed compute response is missing recordsFile",
    );
  }
  const artifact = response.artifacts.find(
    (candidate) => candidate.path === response.recordsFile,
  );
  if (artifact === undefined) {
    throw new InvalidComputeResultError(
      "Completed compute recordsFile is not an artifact",
    );
  }
  return artifact;
}

function nonNegativeMetric(
  response: ComputeResponse,
  name: string,
): number {
  const value = response.metrics[name];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new InvalidComputeResultError(
      `Compute response metrics.${name} must be a non-negative integer`,
    );
  }
  return value;
}

function genericDocumentMetrics(
  response: ComputeResponse,
  records: ComputeResponse["artifacts"][number],
): void {
  const inputChecksum = response.metrics.inputChecksum;
  if (
    typeof inputChecksum !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(inputChecksum)
  ) {
    throw new InvalidComputeResultError(
      "extract_document metrics.inputChecksum must be a SHA-256 checksum",
    );
  }
  nonNegativeMetric(response, "inputBytes");
  const recordCount = nonNegativeMetric(response, "recordCount");
  const textRecordCount = nonNegativeMetric(
    response,
    "textRecordCount",
  );
  nonNegativeMetric(response, "textChars");
  const recordsBytes = nonNegativeMetric(response, "recordsBytes");
  if (recordsBytes !== records.size) {
    throw new InvalidComputeResultError(
      "extract_document metrics.recordsBytes must match the records artifact",
    );
  }

  const rawCounts = response.metrics.recordTypeCounts;
  if (!isRecord(rawCounts)) {
    throw new InvalidComputeResultError(
      "extract_document metrics.recordTypeCounts must be an object",
    );
  }
  let total = 0;
  for (const value of Object.values(rawCounts)) {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new InvalidComputeResultError(
        "extract_document record type counts must be non-negative integers",
      );
    }
    total += value;
  }
  if (
    total !== recordCount ||
    rawCounts.document !== 1 ||
    (rawCounts.text ?? 0) !== textRecordCount
  ) {
    throw new InvalidComputeResultError(
      "extract_document record count metrics are inconsistent",
    );
  }
}

export function validateComputeResult(
  request: ComputeRequest,
  response: ComputeResponse,
): void {
  if (response.status !== "completed") {
    return;
  }
  if (response.error !== null) {
    throw new InvalidComputeResultError(
      "Completed compute response may not contain an error",
    );
  }
  if (
    request.operation === "extract_pdf" ||
    request.operation === "extract_workbook"
  ) {
    return;
  }
  const records = recordsArtifact(response);
  const jsonManifest = artifactWithMediaType(
    response,
    (mediaType) => mediaType === "application/json",
  );

  switch (request.operation) {
    case "extract_document": {
      const format = response.metrics.format;
      if (
        records.mediaType.toLowerCase() !== "application/x-ndjson" ||
        !["docx", "pptx", "csv", "markdown", "text"].includes(
          String(format),
        )
      ) {
        throw new InvalidComputeResultError(
          "extract_document must return bounded document NDJSON",
        );
      }
      genericDocumentMetrics(response, records);
      break;
    }
    case "render_pdf_page": {
      if (
        records.mediaType.toLowerCase() !== "application/json" ||
        jsonManifest === undefined ||
        artifactWithMediaType(response, (type) => type === "image/png") ===
          undefined
      ) {
        throw new InvalidComputeResultError(
          "render_pdf_page must return a PNG and JSON manifest",
        );
      }
      nonNegativeMetric(response, "pageNumber");
      nonNegativeMetric(response, "pageCount");
      nonNegativeMetric(response, "width");
      nonNegativeMetric(response, "height");
      break;
    }
    case "render_report": {
      const markdown = artifactWithMediaType(response, (type) =>
        type.startsWith("text/markdown"),
      );
      const html = artifactWithMediaType(response, (type) =>
        type.startsWith("text/html"),
      );
      const pdf = artifactWithMediaType(
        response,
        (type) => type === "application/pdf",
      );
      const pdfStatus = response.metrics.pdfStatus;
      if (
        records.mediaType.toLowerCase() !== "application/json" ||
        jsonManifest === undefined ||
        markdown === undefined ||
        html === undefined ||
        !["generated", "unavailable", "disabled"].includes(
          String(pdfStatus),
        ) ||
        (pdfStatus === "generated" && pdf === undefined) ||
        (pdfStatus !== "generated" && pdf !== undefined)
      ) {
        throw new InvalidComputeResultError(
          "render_report returned an inconsistent artifact set",
        );
      }
      break;
    }
    default:
      break;
  }
}

export function computeRequestForJob(job: ComputeJob): ComputeRequest {
  if (!isRecord(job.payload)) {
    throw new InvalidComputeJobError("Compute job payload must be an object");
  }
  const inputPath = payloadString(job.payload, "inputPath");
  const outputDirectory = payloadString(job.payload, "outputDirectory");
  if (!path.isAbsolute(inputPath)) {
    throw new InvalidComputeJobError(
      "Compute job payload.inputPath must be absolute",
    );
  }
  if (!path.isAbsolute(outputDirectory)) {
    throw new InvalidComputeJobError(
      "Compute job payload.outputDirectory must be absolute",
    );
  }
  const rawOptions = job.payload.options ?? {};
  if (!isRecord(rawOptions)) {
    throw new InvalidComputeJobError(
      "Compute job payload.options must be an object",
    );
  }
  return {
    protocolVersion: 1,
    requestId: requestIdFor(job),
    jobId: job.id,
    operation: operationForJob(job, inputPath),
    inputPath,
    outputDirectory,
    options: rawOptions,
  };
}

export class ComputeJobExecutor {
  public constructor(
    private readonly compute: ComputeTransport | ComputeClient,
    private readonly pathAuthorizer: ComputePathAuthorizer,
  ) {}

  public async execute(
    job: ComputeJob,
    execution: ComputeExecutionOptions = {},
  ): Promise<ComputeResponse> {
    const request = computeRequestForJob(job);
    await this.pathAuthorizer.authorize(job, request);
    const response = await this.compute.execute(request, execution);
    if (response.status === "failed") {
      throw new ComputeJobResponseError(
        response,
        retryableResponse(response),
      );
    }
    validateComputeResult(request, response);
    return response;
  }
}
