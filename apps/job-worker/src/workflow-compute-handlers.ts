import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  open,
  realpath,
} from "node:fs/promises";
import path from "node:path";

import type {
  ComputeResponse,
  JobType,
} from "@private-fund/contracts";
import {
  ComputeProjectionError,
  type ComputeProjectionHandler,
  type ComputeProjectionResult,
  type ExtensionProjectionContext,
  type ProjectionJob,
} from "@private-fund/compute-projector";
import {
  createResearchStore,
  openProjectDatabase,
  type ResearchStore,
} from "@private-fund/research-store";
import {
  createWorkflowStore,
  type WorkflowStore,
  withTransaction,
} from "@private-fund/workflow-store";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_WORKBOOK_BYTES = 512 * 1024 * 1024;
const CHECKSUM = /^sha256:[a-f0-9]{64}$/;

type Artifact = ComputeResponse["artifacts"][number];
type JsonObject = Record<string, unknown>;

interface VerifiedArtifact {
  readonly descriptor: Artifact;
  readonly absolutePath: string;
  readonly bytes: Buffer | null;
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

function record(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw projectionError(
      `${label} must be a JSON object`,
      "projection_record_invalid",
    );
  }
  return value as JsonObject;
}

function text(
  value: unknown,
  label: string,
  maximum = 20_000,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw projectionError(
      `${label} must be a non-empty bounded string`,
      "projection_record_invalid",
    );
  }
  return value;
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function payloadString(job: ProjectionJob, name: string): string {
  const value = job.payload[name];
  if (typeof value !== "string" || value.length === 0) {
    throw projectionError(
      `Compute projection payload.${name} must be a non-empty string`,
      "invalid_projection_job",
    );
  }
  return value;
}

function optionalPayloadString(
  job: ProjectionJob,
  name: string,
): string | null {
  const value = job.payload[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw projectionError(
      `Compute projection payload.${name} must be a string or null`,
      "invalid_projection_job",
    );
  }
  return value;
}

function artifactByPath(
  response: ComputeResponse,
  artifactPath: string,
): Artifact {
  const matches = response.artifacts.filter(
    (artifact) => artifact.path === artifactPath,
  );
  if (matches.length !== 1) {
    throw projectionError(
      "Compute artifact path must resolve exactly once",
      "projection_integrity_mismatch",
    );
  }
  return matches[0]!;
}

async function verifiedArtifact(
  context: ExtensionProjectionContext,
  descriptor: Artifact,
  options: {
    readonly maximumBytes: number;
    readonly loadBytes?: boolean;
    readonly mediaType?: string | RegExp;
  },
): Promise<VerifiedArtifact> {
  if (
    !descriptor.path ||
    descriptor.path.includes("\0") ||
    descriptor.path.includes("\\") ||
    path.isAbsolute(descriptor.path) ||
    !CHECKSUM.test(descriptor.checksum) ||
    !Number.isSafeInteger(descriptor.size) ||
    descriptor.size < 0
  ) {
    throw projectionError(
      "Compute artifact descriptor is invalid",
      "projection_integrity_mismatch",
    );
  }
  if (descriptor.size > options.maximumBytes) {
    throw projectionError(
      "Compute artifact exceeds its projection byte limit",
      "projection_limit_exceeded",
    );
  }
  if (
    typeof options.mediaType === "string" &&
    descriptor.mediaType.toLowerCase() !== options.mediaType.toLowerCase()
  ) {
    throw projectionError(
      "Compute artifact has an unexpected media type",
      "projection_integrity_mismatch",
    );
  }
  if (
    options.mediaType instanceof RegExp &&
    !options.mediaType.test(descriptor.mediaType.toLowerCase())
  ) {
    throw projectionError(
      "Compute artifact has an unexpected media type",
      "projection_integrity_mismatch",
    );
  }
  const outputDirectory = payloadString(context.job, "outputDirectory");
  if (!path.isAbsolute(outputDirectory)) {
    throw projectionError(
      "Projection outputDirectory must be absolute",
      "invalid_projection_job",
    );
  }
  const lexicalOutput = path.resolve(outputDirectory);
  const lexicalArtifact = path.resolve(lexicalOutput, descriptor.path);
  if (
    (!isWithin(lexicalOutput, context.projectRoot) &&
      !isWithin(lexicalOutput, context.realProjectRoot)) ||
    !isWithin(lexicalArtifact, lexicalOutput)
  ) {
    throw projectionError(
      "Compute artifact escapes the project output directory",
      "projection_path_violation",
    );
  }
  let actualOutput: string;
  let actualArtifact: string;
  try {
    [actualOutput, actualArtifact] = await Promise.all([
      realpath(lexicalOutput),
      realpath(lexicalArtifact),
    ]);
  } catch (error) {
    throw projectionError(
      "Compute artifact does not exist",
      "projection_integrity_mismatch",
      false,
      error,
    );
  }
  if (
    !isWithin(actualOutput, context.realProjectRoot) ||
    !isWithin(actualArtifact, actualOutput) ||
    !isWithin(actualArtifact, context.realProjectRoot)
  ) {
    throw projectionError(
      "Compute artifact resolves outside the tenant project",
      "projection_path_violation",
    );
  }
  const flags =
    constants.O_RDONLY |
    (typeof constants.O_NOFOLLOW === "number"
      ? constants.O_NOFOLLOW
      : 0);
  const file = await open(actualArtifact, flags);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== descriptor.size) {
      throw projectionError(
        "Compute artifact size or type changed before projection",
        "projection_integrity_mismatch",
      );
    }
    const digest = createHash("sha256");
    let bytes: Buffer | null = null;
    if (options.loadBytes === true) {
      bytes = await file.readFile();
      digest.update(bytes);
    } else {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (position < before.size) {
        context.signal?.throwIfAborted();
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, before.size - position),
          position,
        );
        if (bytesRead === 0) {
          throw projectionError(
            "Compute artifact ended during integrity attestation",
            "projection_integrity_mismatch",
          );
        }
        digest.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    }
    context.signal?.throwIfAborted();
    const after = await file.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      `sha256:${digest.digest("hex")}` !== descriptor.checksum ||
      (await realpath(actualArtifact)) !== actualArtifact
    ) {
      throw projectionError(
        "Compute artifact failed checksum or stability attestation",
        "projection_integrity_mismatch",
      );
    }
    return { descriptor, absolutePath: actualArtifact, bytes };
  } finally {
    await file.close();
  }
}

async function jsonArtifact(
  context: ExtensionProjectionContext,
  descriptor: Artifact,
): Promise<JsonObject> {
  const verified = await verifiedArtifact(context, descriptor, {
    maximumBytes: MAX_JSON_BYTES,
    loadBytes: true,
    mediaType: "application/json",
  });
  try {
    return record(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          verified.bytes!,
        ),
      ),
      "Compute JSON artifact",
    );
  } catch (error) {
    if (error instanceof ComputeProjectionError) throw error;
    throw projectionError(
      "Compute JSON artifact is invalid",
      "projection_record_invalid",
      false,
      error,
    );
  }
}

async function attestInput(
  context: ExtensionProjectionContext,
  expectedChecksum: string,
): Promise<string> {
  const inputPath = payloadString(context.job, "inputPath");
  if (!path.isAbsolute(inputPath)) {
    throw projectionError(
      "Projection inputPath must be absolute",
      "invalid_projection_job",
    );
  }
  const lexical = path.resolve(inputPath);
  if (
    !isWithin(lexical, context.projectRoot) &&
    !isWithin(lexical, context.realProjectRoot)
  ) {
    throw projectionError(
      "Projection inputPath escapes the project",
      "projection_path_violation",
    );
  }
  const actual = await realpath(lexical).catch((error: unknown) => {
    throw projectionError(
      "Projection inputPath does not exist",
      "projection_integrity_mismatch",
      false,
      error,
    );
  });
  if (!isWithin(actual, context.realProjectRoot)) {
    throw projectionError(
      "Projection inputPath resolves outside the project",
      "projection_path_violation",
    );
  }
  const flags =
    constants.O_RDONLY |
    (typeof constants.O_NOFOLLOW === "number"
      ? constants.O_NOFOLLOW
      : 0);
  const file = await open(actual, flags);
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > MAX_WORKBOOK_BYTES) {
      throw projectionError(
        "Projection input is not a bounded regular file",
        "projection_limit_exceeded",
      );
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < stats.size) {
      context.signal?.throwIfAborted();
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, stats.size - position),
        position,
      );
      if (bytesRead === 0) {
        throw projectionError(
          "Projection input ended during checksum attestation",
          "projection_integrity_mismatch",
        );
      }
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (
      `sha256:${digest.digest("hex")}` !== expectedChecksum ||
      (await realpath(actual)) !== actual
    ) {
      throw projectionError(
        "Projection input checksum changed",
        "projection_integrity_mismatch",
      );
    }
    return actual;
  } finally {
    await file.close();
  }
}

function openStores(context: ExtensionProjectionContext): {
  readonly research: ResearchStore;
  readonly workflow: WorkflowStore;
  readonly close: () => void;
} {
  let database;
  try {
    database = openProjectDatabase({
      projectRoot: context.projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
    });
  } catch (error) {
    throw projectionError(
      "Could not open project stores for compute projection",
      "projection_database_error",
      true,
      error,
    );
  }
  return {
    research: createResearchStore(database),
    workflow: createWorkflowStore(database.connection),
    close: () => database.close(),
  };
}

function relativeProjectPath(
  absolutePath: string,
  projectRoot: string,
): string {
  if (!isWithin(absolutePath, projectRoot)) {
    throw projectionError(
      "Projected artifact path escapes projectRoot",
      "projection_path_violation",
    );
  }
  return path.relative(projectRoot, absolutePath).split(path.sep).join("/");
}

export class WorkflowComputeProjectionHandler
  implements ComputeProjectionHandler
{
  public readonly name = "workflow-compute-v1";

  public supports(job: ProjectionJob): boolean {
    return job.type === "report.generate";
  }

  public async project(
    context: ExtensionProjectionContext,
  ): Promise<ComputeProjectionResult> {
    if (context.job.payload.datasetId !== context.job.projectId) {
      throw projectionError(
        "Compute business datasetId must match projectId",
        "invalid_projection_job",
      );
    }
    switch (context.job.type) {
      case "report.generate":
        return this.#reportGenerate(context);
      default:
        throw projectionError(
          "Workflow handler received an unsupported job",
          "invalid_projection_job",
        );
    }
  }

  async #reportGenerate(
    context: ExtensionProjectionContext,
  ): Promise<ComputeProjectionResult> {
    const sourceKind = payloadString(context.job, "sourceKind");
    const inputChecksum = text(
      context.response.metrics.inputChecksum,
      "metrics.inputChecksum",
      71,
    );
    if (!CHECKSUM.test(inputChecksum)) {
      throw projectionError(
        "Report source checksum is invalid",
        "projection_integrity_mismatch",
      );
    }
    await attestInput(context, inputChecksum);
    if (context.response.recordsFile === null) {
      throw projectionError(
        "Report render has no manifest",
        "projection_integrity_mismatch",
      );
    }
    const manifest = await jsonArtifact(
      context,
      artifactByPath(context.response, context.response.recordsFile),
    );
    if (
      manifest.operation !== "render_report" ||
      manifest.sourceChecksum !== inputChecksum ||
      !Array.isArray(manifest.outputs)
    ) {
      throw projectionError(
        "Report manifest is inconsistent",
        "projection_integrity_mismatch",
      );
    }
    const outputs: Array<{
      readonly path: string;
      readonly mediaType: string;
      readonly checksum: string;
      readonly size: number;
    }> = [];
    for (const rawOutput of manifest.outputs) {
      const output = record(rawOutput, "report output");
      const descriptor = artifactByPath(
        context.response,
        text(output.path, "report output path", 1_000),
      );
      if (
        output.checksum !== descriptor.checksum ||
        output.size !== descriptor.size ||
        output.mediaType !== descriptor.mediaType
      ) {
        throw projectionError(
          "Report output differs from its manifest",
          "projection_integrity_mismatch",
        );
      }
      const verified = await verifiedArtifact(context, descriptor, {
        maximumBytes:
          descriptor.mediaType === "application/pdf"
            ? 256 * 1024 * 1024
            : MAX_JSON_BYTES,
        mediaType: /^(?:text\/markdown|text\/html|application\/pdf)/,
      });
      outputs.push({
        path: relativeProjectPath(
          verified.absolutePath,
          context.realProjectRoot,
        ),
        mediaType: descriptor.mediaType,
        checksum: descriptor.checksum,
        size: descriptor.size,
      });
    }
    const markdownOutput = outputs.find((output) =>
      output.mediaType.toLowerCase().startsWith("text/markdown"),
    );
    const htmlOutput = outputs.find((output) =>
      output.mediaType.toLowerCase().startsWith("text/html"),
    );
    const pdfOutput = outputs.find(
      (output) => output.mediaType.toLowerCase() === "application/pdf",
    );
    if (markdownOutput === undefined || htmlOutput === undefined) {
      throw projectionError(
        "Report render is missing Markdown or HTML",
        "projection_integrity_mismatch",
      );
    }

    const stores = openStores(context);
    try {
      return withTransaction(stores.workflow.database, () => {
        if (sourceKind === "memo") {
        const memoVersionId = payloadString(
          context.job,
          "memoVersionId",
        );
        const memo = stores.workflow.tracking.getMemoVersion(
          context.job.projectId,
          memoVersionId,
        );
        if (`sha256:${memo.contentHash}` !== inputChecksum) {
          throw projectionError(
            "Rendered memo input does not match its immutable memo version",
            "projection_integrity_mismatch",
          );
        }
        stores.workflow.tracking.attachMemoArtifacts(
          context.job.projectId,
          memoVersionId,
          {
            markdownPath:
              memo.markdownPath ?? markdownOutput.path,
            htmlPath: htmlOutput.path,
            pdfPath: pdfOutput?.path ?? null,
          },
        );
        const evidenceIds = [
          ...new Set(
            memo.sections.flatMap((section) => section.evidenceIds),
          ),
        ];
        const assetId =
          optionalPayloadString(context.job, "assetId") ??
          `memo:${memo.seriesId}`;
        const asset = stores.research.assets.saveVersion({
          assetId,
          assetType: "memo",
          title: memo.seriesTitle,
          status: "completed",
          summary: memo.sections[0]?.content.slice(0, 2_000) ?? "",
          contentMarkdown: memo.sections
            .map(
              (section) =>
                `## ${section.title}\n\n${section.content}`,
            )
            .join("\n\n"),
          metadata: {
            memoVersionId,
            artifacts: outputs,
            rendererVersion:
              typeof manifest.rendererVersion === "string"
                ? manifest.rendererVersion
                : "unknown",
          },
          tags: ["memo", "research", "rendered"],
          evidence: evidenceIds.map((evidenceId) => ({
            evidenceId,
            relationType: "supports",
          })),
        });
        return {
          kind: "extension",
          handler: this.name,
          details: {
            operation: "report.generate",
            sourceKind,
            memoVersionId,
            assetId: asset.asset.id,
            artifacts: outputs,
          },
        };
      }
        throw projectionError(
          "Report sourceKind is unsupported",
          "invalid_projection_job",
        );
      });
    } finally {
      stores.close();
    }
  }
}

export const WORKFLOW_COMPUTE_JOB_TYPES: readonly JobType[] = [
  "report.generate",
];
