import type {
  ComputeResponse,
  Job,
} from "@private-fund/contracts";

export type DocumentProjectionOperation =
  | "extract_pdf"
  | "extract_document"
  | "extract_workbook";

export type GenericDocumentFormat =
  | "docx"
  | "pptx"
  | "csv"
  | "markdown"
  | "text";

export interface ProjectionJob
  extends Pick<
    Job,
    "id" | "type" | "payload" | "tenantNamespace" | "projectId"
  > {}

export interface ProjectionExecutionOptions {
  readonly signal?: AbortSignal;
}

export interface DocumentProjectionResult {
  readonly kind: "document";
  readonly documentVersionId: string;
  readonly evidenceCount: number;
  readonly status: "indexed" | "needs_ocr";
  readonly recordsBytes: number;
  readonly recordsChecksum: string;
}

export interface DeferredProjectionResult {
  readonly kind: "deferred";
  readonly jobType: ProjectionJob["type"];
  readonly reason: "no_registered_handler";
}

export type ComputeProjectionResult =
  | DocumentProjectionResult
  | DeferredProjectionResult
  | {
      readonly kind: "extension";
      readonly handler: string;
      readonly details?: unknown;
    };

export interface ExtensionProjectionContext {
  readonly job: ProjectionJob;
  readonly response: ComputeResponse;
  readonly projectRoot: string;
  readonly realProjectRoot: string;
  readonly signal?: AbortSignal;
}

/**
 * Extension point for market, report and future compute outputs.
 *
 * No default extension writes Evidence: a handler must deliberately map an
 * auditable source record into its own domain store.
 */
export interface ComputeProjectionHandler {
  readonly name: string;
  supports(job: ProjectionJob): boolean;
  project(
    context: ExtensionProjectionContext,
  ): Promise<ComputeProjectionResult>;
}

export interface ComputeResultProjectorPort {
  project(
    job: ProjectionJob,
    response: ComputeResponse,
    execution?: ProjectionExecutionOptions,
  ): Promise<ComputeProjectionResult>;
}

export type ProjectionErrorCode =
  | "invalid_projection_job"
  | "projection_path_violation"
  | "projection_integrity_mismatch"
  | "projection_record_invalid"
  | "projection_limit_exceeded"
  | "projection_database_error";

export class ComputeProjectionError extends Error {
  public constructor(
    message: string,
    public readonly code: ProjectionErrorCode,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ComputeProjectionError";
  }
}
