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
  type JsonValue,
  type ValuationMateriality,
  type ValuationNodeValue,
  type WorkflowStore,
  WorkflowStoreError,
  withTransaction,
} from "@private-fund/workflow-store";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_NDJSON_BYTES = 256 * 1024 * 1024;
const MAX_WORKBOOK_BYTES = 512 * 1024 * 1024;
const CHECKSUM = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;

type Artifact = ComputeResponse["artifacts"][number];
type JsonObject = Record<string, unknown>;

interface VerifiedArtifact {
  readonly descriptor: Artifact;
  readonly absolutePath: string;
  readonly bytes: Buffer | null;
}

interface WorkbookCell {
  readonly sheet: string;
  readonly coordinate: string;
  readonly row: number;
  readonly column: number;
  readonly value: JsonValue;
  readonly formula: string | null;
  readonly cachedValue: JsonValue;
  readonly dataType: string;
  readonly numberFormat: string;
}

interface WorkbookRecords {
  readonly sourceName: string;
  readonly sheets: readonly string[];
  readonly cells: readonly WorkbookCell[];
}

interface MarketBar {
  readonly tradeDate: string;
  readonly open: number | null;
  readonly high: number | null;
  readonly low: number | null;
  readonly close: number;
  readonly volume: number | null;
  readonly amount: number | null;
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

function nullableText(
  value: unknown,
  label: string,
  maximum = 20_000,
): string | null {
  if (value === null) return null;
  return text(value, label, maximum);
}

function integer(
  value: unknown,
  label: string,
  minimum = 0,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw projectionError(
      `${label} must be an integer in range`,
      "projection_record_invalid",
    );
  }
  return value;
}

function finiteOrNull(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw projectionError(
      `${label} must be a finite number or null`,
      "projection_record_invalid",
    );
  }
  return value;
}

function jsonValue(value: unknown, label: string): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => jsonValue(item, label));
  }
  if (typeof value === "object" && value !== null) {
    const object: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      object[key] = jsonValue(item, label);
    }
    return object;
  }
  throw projectionError(
    `${label} is not JSON serializable`,
    "projection_record_invalid",
  );
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

async function ndjsonArtifact(
  context: ExtensionProjectionContext,
  descriptor: Artifact,
  maximumRecords: number,
): Promise<JsonObject[]> {
  const verified = await verifiedArtifact(context, descriptor, {
    maximumBytes: MAX_NDJSON_BYTES,
    loadBytes: true,
    mediaType: "application/x-ndjson",
  });
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      verified.bytes!,
    );
  } catch (error) {
    throw projectionError(
      "Compute NDJSON artifact is not valid UTF-8",
      "projection_record_invalid",
      false,
      error,
    );
  }
  const lines = decoded.endsWith("\n")
    ? decoded.slice(0, -1).split("\n")
    : decoded.split("\n");
  if (decoded.length === 0) lines.splice(0);
  if (lines.length > maximumRecords) {
    throw projectionError(
      "Compute NDJSON artifact exceeds its record limit",
      "projection_limit_exceeded",
    );
  }
  return lines.map((line, index) => {
    if (!line || Buffer.byteLength(line) > 8 * 1024 * 1024) {
      throw projectionError(
        `Compute NDJSON line ${String(index + 1)} is empty or too large`,
        "projection_limit_exceeded",
      );
    }
    try {
      return record(
        JSON.parse(line),
        `Compute NDJSON line ${String(index + 1)}`,
      );
    } catch (error) {
      if (error instanceof ComputeProjectionError) throw error;
      throw projectionError(
        `Compute NDJSON line ${String(index + 1)} is invalid JSON`,
        "projection_record_invalid",
        false,
        error,
      );
    }
  });
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

function workbookValue(value: unknown, label: string): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  const object = record(value, label);
  if (
    object.encoding === "base64" &&
    typeof object.data === "string" &&
    object.data.length <= 20_000_000 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(object.data)
  ) {
    return {
      encoding: "base64",
      data: object.data,
    };
  }
  throw projectionError(
    `${label} is not a supported workbook value`,
    "projection_record_invalid",
  );
}

function workbookRecords(
  records: readonly JsonObject[],
  expectedSourceName: string,
): WorkbookRecords {
  if (records.length === 0 || records[0]?.recordType !== "workbook") {
    throw projectionError(
      "Workbook records must start with a workbook header",
      "projection_record_invalid",
    );
  }
  const header = records[0]!;
  const sourceName = text(header.sourceName, "workbook sourceName", 1_000);
  if (sourceName !== expectedSourceName) {
    throw projectionError(
      "Workbook sourceName does not match inputPath",
      "projection_integrity_mismatch",
    );
  }
  if (
    !Array.isArray(header.sheetNames) ||
    header.sheetNames.length === 0 ||
    !header.sheetNames.every(
      (value) => typeof value === "string" && value.length > 0,
    )
  ) {
    throw projectionError(
      "Workbook sheetNames are invalid",
      "projection_record_invalid",
    );
  }
  const sheets = header.sheetNames as string[];
  if (new Set(sheets).size !== sheets.length) {
    throw projectionError(
      "Workbook contains duplicate sheet declarations",
      "projection_record_invalid",
    );
  }
  const cells: WorkbookCell[] = [];
  const seenCells = new Set<string>();
  let activeSheet: string | null = null;
  let maxRow = 0;
  let maxColumn = 0;
  for (const value of records.slice(1)) {
    if (value.recordType === "worksheet") {
      activeSheet = text(value.sheet, "worksheet sheet", 500);
      if (!sheets.includes(activeSheet)) {
        throw projectionError(
          "Worksheet was not declared by its workbook",
          "projection_record_invalid",
        );
      }
      maxRow = integer(value.maxRow, "worksheet maxRow");
      maxColumn = integer(value.maxColumn, "worksheet maxColumn");
      continue;
    }
    if (value.recordType !== "cell" || activeSheet === null) {
      throw projectionError(
        "Workbook contains a cell outside a worksheet",
        "projection_record_invalid",
      );
    }
    const sheet = text(value.sheet, "cell sheet", 500);
    const coordinate = text(value.coordinate, "cell coordinate", 100);
    const row = integer(value.row, "cell row", 1);
    const column = integer(value.column, "cell column", 1);
    if (
      sheet !== activeSheet ||
      row > maxRow ||
      column > maxColumn ||
      !/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(coordinate)
    ) {
      throw projectionError(
        "Workbook cell locator is inconsistent",
        "projection_record_invalid",
      );
    }
    const key = `${sheet}\0${coordinate}`;
    if (seenCells.has(key)) {
      throw projectionError(
        "Workbook contains duplicate cells",
        "projection_record_invalid",
      );
    }
    seenCells.add(key);
    cells.push({
      sheet,
      coordinate,
      row,
      column,
      value: workbookValue(value.value, "cell value"),
      formula: nullableText(value.formula, "cell formula"),
      cachedValue: workbookValue(value.cachedValue, "cached value"),
      dataType:
        value.dataType === ""
          ? ""
          : text(value.dataType, "cell dataType", 100),
      numberFormat:
        value.numberFormat === ""
          ? ""
          : text(value.numberFormat, "cell numberFormat", 2_000),
    });
  }
  return { sourceName, sheets, cells };
}

function evidenceIdForCell(
  documentVersionId: string,
  sheet: string,
  coordinate: string,
): string {
  return `cell:${createHash("sha256")
    .update(`${documentVersionId}\0${sheet}\0${coordinate}`)
    .digest("hex")
    .slice(0, 48)}`;
}

function displayCellValue(cell: WorkbookCell): JsonValue {
  return cell.formula !== null && cell.cachedValue !== null
    ? cell.cachedValue
    : cell.value;
}

function displayText(value: JsonValue): string {
  if (value === null) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

function allModelVersions(
  workflow: WorkflowStore,
  datasetId: string,
  seriesId: string,
) {
  const versions = [];
  for (let offset = 0; ; offset += 500) {
    const page = workflow.valuation.listModelVersions(
      datasetId,
      seriesId,
      { limit: 500, offset },
    );
    versions.push(...page.items);
    if (!page.hasMore) return versions;
  }
}

function allNodeValues(
  workflow: WorkflowStore,
  modelVersionId: string,
): ValuationNodeValue[] {
  const values: ValuationNodeValue[] = [];
  for (let offset = 0; ; offset += 1_000) {
    const page = workflow.valuation.listNodeValues(modelVersionId, {
      limit: 1_000,
      offset,
    });
    values.push(...page.items);
    if (!page.hasMore) return values;
  }
}

function changeMateriality(
  previous: ValuationNodeValue,
  current: ValuationNodeValue,
): {
  readonly materiality: ValuationMateriality;
  readonly absoluteChange: number | null;
  readonly relativeChange: number | null;
} {
  if (
    previous.valueNumeric === null ||
    current.valueNumeric === null
  ) {
    return {
      materiality: "medium",
      absoluteChange: null,
      relativeChange: null,
    };
  }
  const absoluteChange =
    current.valueNumeric - previous.valueNumeric;
  const relativeChange =
    previous.valueNumeric === 0
      ? null
      : absoluteChange / Math.abs(previous.valueNumeric);
  const magnitude =
    relativeChange === null
      ? Math.abs(absoluteChange)
      : Math.abs(relativeChange);
  return {
    materiality:
      magnitude >= 0.25
        ? "critical"
        : magnitude >= 0.1
          ? "high"
          : magnitude >= 0.03
            ? "medium"
            : "low",
    absoluteChange,
    relativeChange,
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
    return (
      job.type === "valuation.extract" ||
      job.type === "valuation.derive" ||
      job.type === "market.refresh" ||
      job.type === "report.generate"
    );
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
      case "valuation.extract":
        return this.#valuationExtract(context);
      case "valuation.derive":
        return this.#valuationDerive(context);
      case "market.refresh":
        return this.#marketRefresh(context);
      case "report.generate":
        return this.#reportGenerate(context);
      default:
        throw projectionError(
          "Workflow handler received an unsupported job",
          "invalid_projection_job",
        );
    }
  }

  async #valuationExtract(
    context: ExtensionProjectionContext,
  ): Promise<ComputeProjectionResult> {
    const documentId = payloadString(context.job, "documentId");
    const documentVersionId = payloadString(
      context.job,
      "documentVersionId",
    );
    if (
      !IDENTIFIER.test(documentId) ||
      !IDENTIFIER.test(documentVersionId)
    ) {
      throw projectionError(
        "Valuation document identity is invalid",
        "invalid_projection_job",
      );
    }
    const inputChecksum = text(
      context.response.metrics.inputChecksum,
      "metrics.inputChecksum",
      71,
    );
    if (!CHECKSUM.test(inputChecksum)) {
      throw projectionError(
        "Valuation input checksum is invalid",
        "projection_integrity_mismatch",
      );
    }
    const inputPath = await attestInput(context, inputChecksum);
    if (context.response.recordsFile === null) {
      throw projectionError(
        "Valuation extraction has no records file",
        "projection_integrity_mismatch",
      );
    }
    const descriptor = artifactByPath(
      context.response,
      context.response.recordsFile,
    );
    const rawRecords = await ndjsonArtifact(context, descriptor, 2_000_000);
    if (
      integer(
        context.response.metrics.recordCount,
        "metrics.recordCount",
      ) !== rawRecords.length
    ) {
      throw projectionError(
        "Valuation record count does not match its artifact",
        "projection_integrity_mismatch",
      );
    }
    const parsed = workbookRecords(rawRecords, path.basename(inputPath));
    if (
      integer(
        context.response.metrics.sheetCount,
        "metrics.sheetCount",
      ) !== parsed.sheets.length ||
      integer(
        context.response.metrics.cellCount,
        "metrics.cellCount",
      ) !== parsed.cells.length
    ) {
      throw projectionError(
        "Valuation workbook metrics do not match its records",
        "projection_integrity_mismatch",
      );
    }

    const stores = openStores(context);
    try {
      const document = stores.research.documents.getById(documentId);
      const version =
        stores.research.documents.getVersion(documentVersionId);
      if (
        version.documentId !== document.id ||
        `sha256:${version.sha256}` !== inputChecksum ||
        (await realpath(
          path.isAbsolute(version.storedPath)
            ? version.storedPath
            : path.join(context.projectRoot, version.storedPath),
        )) !== inputPath
      ) {
        throw projectionError(
          "Valuation extraction is not bound to its registered document version",
          "projection_integrity_mismatch",
        );
      }
      const database = stores.workflow.database;
      database.exec("BEGIN IMMEDIATE");
      try {
        const valuation = stores.workflow.valuation;
        const series = valuation.upsertSeries({
        datasetId: context.job.projectId,
        seriesKey: `document:${document.logicalKey}`,
        name: document.title,
        companyName:
          typeof document.metadata.companyName === "string"
            ? document.metadata.companyName
            : null,
        companyTicker:
          typeof document.metadata.ticker === "string"
            ? document.metadata.ticker
            : null,
        modelType:
          typeof document.metadata.docSubtype === "string"
            ? document.metadata.docSubtype
            : "workbook",
      });
        const knownVersions = allModelVersions(
        stores.workflow,
        context.job.projectId,
        series.seriesId,
      );
        const existing = knownVersions.find(
        (candidate) =>
          candidate.docId === version.id &&
          candidate.analyzerVersion === "ts-workbook-extractor-v1",
      );
        const parentModelVersionId =
        existing?.parentModelVersionId ??
        (series.currentModelVersionId === existing?.modelVersionId
          ? null
          : series.currentModelVersionId);
        const formulaCount = parsed.cells.filter(
        (cell) => cell.formula !== null,
      ).length;
        const modelVersion = valuation.saveModelVersion({
          datasetId: context.job.projectId,
          seriesId: series.seriesId,
          docId: version.id,
          logicalDocId: document.id,
          documentVersionNo: version.versionNo,
          parentModelVersionId,
          checksum: version.sha256,
          snapshotHash: descriptor.checksum,
          originalFilename: version.originalFilename,
          modelType: series.modelType,
          nodeCount: parsed.cells.length,
          formulaNodeCount: formulaCount,
          reviewRequiredCount: 0,
          analyzerVersion: "ts-workbook-extractor-v1",
          idempotencyKey: `valuation-extract:${version.id}:v1`,
        }).value;
        const evidenceIds: string[] = [];
        for (const cell of parsed.cells) {
          context.signal?.throwIfAborted();
          const evidenceId = evidenceIdForCell(
            version.id,
            cell.sheet,
            cell.coordinate,
          );
          if (stores.research.evidence.find(evidenceId) === null) {
            throw projectionError(
              `Valuation cell Evidence is not indexed yet: ${evidenceId}`,
              "projection_integrity_mismatch",
              true,
            );
          }
          evidenceIds.push(evidenceId);
          const displayed = displayCellValue(cell);
          const numeric =
            typeof displayed === "number" ? displayed : null;
          const node = valuation.upsertNode({
            seriesId: series.seriesId,
            canonicalKey: `${cell.sheet}!${cell.coordinate}`,
            nodeKind: cell.formula === null ? "other" : "forecast",
            metricKey: `${cell.sheet}.${cell.coordinate}`.slice(0, 200),
            displayName: `${cell.sheet}!${cell.coordinate}`,
            scope: "workbook",
          });
          valuation.saveNodeValue({
            modelVersionId: modelVersion.modelVersionId,
            nodeId: node.nodeId,
            valueNumeric: numeric,
            valueText: displayText(displayed).slice(0, 50_000),
            unit: cell.numberFormat || null,
            formula: cell.formula,
            formulaFingerprint:
              cell.formula === null
                ? null
                : createHash("sha256")
                    .update(cell.formula)
                    .digest("hex"),
            sheetName: cell.sheet,
            cellRef: cell.coordinate,
            evidenceId,
            qualityStatus: "verified",
            confidence: 1,
            metadata: {
              rawValue: cell.value,
              cachedValue: cell.cachedValue,
              dataType: cell.dataType,
              numberFormat: cell.numberFormat,
              row: cell.row,
              column: cell.column,
            },
          });
        }
        valuation.saveAnalysisVersion({
          datasetId: context.job.projectId,
          seriesId: series.seriesId,
          modelVersionId: modelVersion.modelVersionId,
          previousAnalysisVersionId:
            parentModelVersionId === null
              ? null
              : valuation.getAnalysisForModelVersion(
                    context.job.projectId,
                    parentModelVersionId,
                    "ts-workbook-extractor-v1",
                  )?.analysisVersionId ?? null,
          status: "completed",
          summaryMarkdown: [
            `# ${document.title}`,
            "",
            `- 工作表：${String(parsed.sheets.length)}`,
            `- 单元格：${String(parsed.cells.length)}`,
            `- 公式单元格：${String(formulaCount)}`,
          ].join("\n"),
          analysis: {
            schemaVersion: 1,
            sheets: parsed.sheets,
            evidence_ids: evidenceIds,
          },
          analyzerVersion: "ts-workbook-extractor-v1",
        });

        let changeCount = 0;
        if (
          parentModelVersionId !== null &&
          parentModelVersionId !== modelVersion.modelVersionId
        ) {
          const prior = new Map(
            allNodeValues(
              stores.workflow,
              parentModelVersionId,
            ).map((value) => [value.nodeId, value]),
          );
          for (const current of allNodeValues(
            stores.workflow,
            modelVersion.modelVersionId,
          )) {
            const previous = prior.get(current.nodeId);
            if (
              previous === undefined ||
              JSON.stringify({
                valueNumeric: previous.valueNumeric,
                valueText: previous.valueText,
                formula: previous.formula,
              }) ===
                JSON.stringify({
                  valueNumeric: current.valueNumeric,
                  valueText: current.valueText,
                  formula: current.formula,
                })
            ) {
              continue;
            }
            const impact = changeMateriality(previous, current);
            valuation.recordChange({
              datasetId: context.job.projectId,
              seriesId: series.seriesId,
              fromModelVersionId: parentModelVersionId,
              toModelVersionId: modelVersion.modelVersionId,
              nodeId: current.nodeId,
              changeType:
                previous.formula !== current.formula
                  ? "formula_changed"
                  : "value_changed",
              materiality: impact.materiality,
              summary: `${current.sheetName}!${current.cellRef} changed`,
              oldValue: {
                valueNumeric: previous.valueNumeric,
                valueText: previous.valueText,
                formula: previous.formula,
              },
              newValue: {
                valueNumeric: current.valueNumeric,
                valueText: current.valueText,
                formula: current.formula,
              },
              absoluteChange: impact.absoluteChange,
              relativeChange: impact.relativeChange,
              evidenceIds: [
                previous.evidenceId,
                current.evidenceId,
              ],
            });
            changeCount += 1;
          }
        }
        database.exec("COMMIT");
        return {
          kind: "extension",
          handler: this.name,
          details: {
            operation: "valuation.extract",
            seriesId: series.seriesId,
            modelVersionId: modelVersion.modelVersionId,
            nodeCount: parsed.cells.length,
            formulaNodeCount: formulaCount,
            changeCount,
          },
        };
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      stores.close();
    }
  }

  async #valuationDerive(
    context: ExtensionProjectionContext,
  ): Promise<ComputeProjectionResult> {
    const analysisId = payloadString(context.job, "analysisId");
    const baseModelVersionId = payloadString(
      context.job,
      "baseModelVersionId",
    );
    const inputChecksum = text(
      context.response.metrics.inputChecksum,
      "metrics.inputChecksum",
      71,
    );
    if (!CHECKSUM.test(inputChecksum)) {
      throw projectionError(
        "Derived model input checksum is invalid",
        "projection_integrity_mismatch",
      );
    }
    await attestInput(context, inputChecksum);
    if (context.response.recordsFile === null) {
      throw projectionError(
        "Derived model has no manifest",
        "projection_integrity_mismatch",
      );
    }
    const manifestDescriptor = artifactByPath(
      context.response,
      context.response.recordsFile,
    );
    const manifest = await jsonArtifact(context, manifestDescriptor);
    if (
      manifest.operation !== "derive_workbook" ||
      manifest.sourceChecksum !== inputChecksum ||
      manifest.sourceOverwritten !== false ||
      !Array.isArray(manifest.changes)
    ) {
      throw projectionError(
        "Derived workbook manifest is inconsistent",
        "projection_integrity_mismatch",
      );
    }
    const changes: readonly unknown[] = manifest.changes;
    const output = record(manifest.output, "derived workbook output");
    const outputPath = text(output.path, "derived output path", 1_000);
    const outputDescriptor = artifactByPath(
      context.response,
      outputPath,
    );
    const verifiedOutput = await verifiedArtifact(
      context,
      outputDescriptor,
      {
        maximumBytes: MAX_WORKBOOK_BYTES,
        mediaType:
          /application\/vnd\.(?:openxmlformats-officedocument\.spreadsheetml\.sheet|ms-excel\.sheet\.macroenabled\.12)/,
      },
    );
    if (
      output.checksum !== outputDescriptor.checksum ||
      output.size !== outputDescriptor.size
    ) {
      throw projectionError(
        "Derived workbook output differs from its manifest",
        "projection_integrity_mismatch",
      );
    }

    const stores = openStores(context);
    try {
      return withTransaction(stores.workflow.database, () => {
        const analysis = stores.workflow.valuation.getAgentAnalysis(
          context.job.projectId,
          analysisId,
        );
        if (
          analysis.status !== "completed" ||
          analysis.baseModelVersionId !== baseModelVersionId
        ) {
          throw projectionError(
            "Derived workbook is not bound to a completed analysis",
            "projection_integrity_mismatch",
          );
        }
        const base = stores.workflow.valuation.getModelVersion(
          context.job.projectId,
          baseModelVersionId,
        );
        if (
          base.seriesId !== analysis.seriesId ||
          `sha256:${base.checksum}` !== inputChecksum
        ) {
          throw projectionError(
            "Derived workbook source does not match its base model",
            "projection_integrity_mismatch",
          );
        }
        const derived = [];
        for (let offset = 0; ; offset += 200) {
          const page = stores.workflow.valuation.listDerivedModels(
            context.job.projectId,
            { seriesId: analysis.seriesId, limit: 200, offset },
          );
          derived.push(...page.items);
          if (!page.hasMore) break;
        }
        const existing = derived.find(
          (candidate) => candidate.analysisId === analysisId,
        );
        const derivedVersionNo =
          existing?.derivedVersionNo ??
          Math.max(0, ...derived.map((item) => item.derivedVersionNo)) + 1;
        const saved = stores.workflow.valuation.saveDerivedModel({
          datasetId: context.job.projectId,
          seriesId: analysis.seriesId,
          analysisId,
          baseModelVersionId,
          derivedVersionNo,
          outputFilename: path.basename(verifiedOutput.absolutePath),
          outputPath: relativeProjectPath(
            verifiedOutput.absolutePath,
            context.realProjectRoot,
          ),
          checksum: outputDescriptor.checksum,
          appliedChanges: changes,
          skippedChanges: [],
        });
        const asset = stores.research.assets.saveVersion({
          assetId: `valuation-derived:${saved.value.derivedModelId}`,
          assetType: "valuation-derived-model",
          title: saved.value.outputFilename,
          status: "completed",
          summary: `由估值分析 ${analysisId} 安全派生的工作簿`,
          contentMarkdown: [
            `# ${saved.value.outputFilename}`,
            "",
            `- 基础模型：${baseModelVersionId}`,
            `- 分析：${analysisId}`,
            `- 修改数：${String(changes.length)}`,
          ].join("\n"),
          metadata: {
            outputPath: saved.value.outputPath,
            checksum: saved.value.checksum,
            analysisId,
            baseModelVersionId,
          },
          tags: ["valuation", "derived-model"],
          evidence: analysis.evidenceIds.map((evidenceId) => ({
            evidenceId,
            relationType: "supports",
          })),
        });
        return {
          kind: "extension",
          handler: this.name,
          details: {
            operation: "valuation.derive",
            derivedModelId: saved.value.derivedModelId,
            assetId: asset.asset.id,
            outputPath: saved.value.outputPath,
            changeCount: changes.length,
          },
        };
      });
    } finally {
      stores.close();
    }
  }

  async #marketRefresh(
    context: ExtensionProjectionContext,
  ): Promise<ComputeProjectionResult> {
    const seriesId = payloadString(context.job, "seriesId");
    const modelVersionId = payloadString(
      context.job,
      "modelVersionId",
    );
    const snapshotId = payloadString(context.job, "snapshotId");
    const inputChecksum = text(
      context.response.metrics.inputChecksum,
      "metrics.inputChecksum",
      71,
    );
    if (!CHECKSUM.test(inputChecksum)) {
      throw projectionError(
        "Market descriptor checksum is invalid",
        "projection_integrity_mismatch",
      );
    }
    await attestInput(context, inputChecksum);
    if (context.response.recordsFile === null) {
      throw projectionError(
        "Market refresh has no records file",
        "projection_integrity_mismatch",
      );
    }
    const records = await ndjsonArtifact(
      context,
      artifactByPath(context.response, context.response.recordsFile),
      100_001,
    );
    if (
      records.length === 0 ||
      records[0]?.recordType !== "market_metadata"
    ) {
      throw projectionError(
        "Market records must start with metadata",
        "projection_record_invalid",
      );
    }
    const metadata = records[0]!;
    const provider = text(metadata.provider, "market provider", 200);
    const ticker = text(
      metadata.canonicalTicker,
      "canonical ticker",
      100,
    );
    const retrievedAt = text(
      metadata.retrievedAt,
      "retrievedAt",
      100,
    );
    const bars: MarketBar[] = records.slice(1).map((raw) => {
      if (
        raw.recordType !== "market_bar" ||
        raw.provider !== provider ||
        raw.canonicalTicker !== ticker ||
        raw.adjustment !== "raw"
      ) {
        throw projectionError(
          "Market bar metadata is inconsistent",
          "projection_record_invalid",
        );
      }
      return {
        tradeDate: text(raw.tradeDate, "tradeDate", 20),
        open: finiteOrNull(raw.open, "open"),
        high: finiteOrNull(raw.high, "high"),
        low: finiteOrNull(raw.low, "low"),
        close:
          finiteOrNull(raw.close, "close") ??
          (() => {
            throw projectionError(
              "Market close is required",
              "projection_record_invalid",
            );
          })(),
        volume: finiteOrNull(raw.volume, "volume"),
        amount: finiteOrNull(raw.amount, "amount"),
      };
    });
    if (
      integer(context.response.metrics.barCount, "metrics.barCount") !==
        bars.length ||
      integer(
        context.response.metrics.recordCount,
        "metrics.recordCount",
      ) !== records.length
    ) {
      throw projectionError(
        "Market metrics do not match normalized bars",
        "projection_integrity_mismatch",
      );
    }

    const stores = openStores(context);
    try {
      return withTransaction(stores.workflow.database, () => {
        const valuation = stores.workflow.valuation;
        const series = valuation.getSeries(
          context.job.projectId,
          seriesId,
        );
        const version = valuation.getModelVersion(
          context.job.projectId,
          modelVersionId,
        );
        if (
          version.seriesId !== seriesId ||
          (series.companyTicker !== null &&
            series.companyTicker.toUpperCase() !== ticker.toUpperCase() &&
            !ticker.startsWith(series.companyTicker.toUpperCase()))
        ) {
          throw projectionError(
            "Market response is not bound to its valuation series",
            "projection_integrity_mismatch",
          );
        }
        let snapshot;
        try {
          snapshot = valuation.getMarketSnapshot(
            context.job.projectId,
            snapshotId,
          );
        } catch (error) {
          if (
            !(error instanceof WorkflowStoreError) ||
            error.code !== "not_found"
          ) {
            throw error;
          }
          snapshot = valuation.createMarketSnapshot({
            snapshotId,
            idempotencyKey: `market:${context.job.id}`,
            datasetId: context.job.projectId,
            seriesId,
            modelVersionId,
            companyName: series.companyName,
            companyTicker: ticker,
            provider,
            status: "pending",
          }).value;
        }
        if (
          snapshot.seriesId !== seriesId ||
          snapshot.modelVersionId !== modelVersionId ||
          snapshot.provider !== provider
        ) {
          throw projectionError(
            "Market snapshot scope is inconsistent",
            "projection_integrity_mismatch",
          );
        }
        if (snapshot.status !== "completed") {
          if (snapshot.status !== "running") {
            snapshot = valuation.transitionMarketSnapshot(
              context.job.projectId,
              snapshotId,
              { status: "running" },
            );
          }
          snapshot = valuation.transitionMarketSnapshot(
            context.job.projectId,
            snapshotId,
            {
              status: "completed",
              asOf:
                bars.at(-1)?.tradeDate ??
                text(metadata.endDate, "market endDate", 20),
              raw: {
                schemaVersion: 1,
                provider,
                ticker,
                retrievedAt,
                bars,
              },
            },
          );
        }
        const latest = bars.at(-1);
        let metricCount = 0;
        if (latest !== undefined) {
          valuation.upsertMetricActualValue({
            snapshotId,
            datasetId: context.job.projectId,
            seriesId,
            modelVersionId,
            metricKey: "latest_close",
            valueNumeric: latest.close,
            unit: text(metadata.currency, "market currency", 20),
            period: latest.tradeDate,
            status: "available",
            source: text(metadata.source, "market source", 2_000),
            observedAt: retrievedAt,
            metadata: { adjustment: "raw" },
          });
          metricCount += 1;
        }
        const turnoverWindow = bars
          .slice(-20)
          .map((bar) => bar.amount)
          .filter((value): value is number => value !== null);
        if (turnoverWindow.length > 0) {
          valuation.upsertMetricActualValue({
            snapshotId,
            datasetId: context.job.projectId,
            seriesId,
            modelVersionId,
            metricKey: "avg_turnover_amount_20d",
            valueNumeric:
              turnoverWindow.reduce((sum, value) => sum + value, 0) /
              turnoverWindow.length,
            unit: text(metadata.currency, "market currency", 20),
            period: bars.at(-1)?.tradeDate ?? null,
            status:
              turnoverWindow.length === 20 ? "available" : "partial",
            source: text(metadata.source, "market source", 2_000),
            observedAt: retrievedAt,
            metadata: {
              adjustment: "raw",
              observationCount: turnoverWindow.length,
            },
          });
          metricCount += 1;
        }
        for (const modelMetric of valuation.listMetricModelValues(
          modelVersionId,
        )) {
          const actual = valuation
            .listMetricActualValues(snapshotId)
            .find((candidate) => candidate.metricKey === modelMetric.metricKey);
          if (actual === undefined) continue;
          const absoluteGap =
            modelMetric.valueNumeric === null ||
            actual.valueNumeric === null
              ? null
              : actual.valueNumeric - modelMetric.valueNumeric;
          const relativeGap =
            absoluteGap === null ||
            modelMetric.valueNumeric === null ||
            modelMetric.valueNumeric === 0
              ? null
              : absoluteGap / Math.abs(modelMetric.valueNumeric);
          const magnitude = Math.abs(relativeGap ?? 0);
          valuation.upsertMetricComparison({
            datasetId: context.job.projectId,
            seriesId,
            modelVersionId,
            snapshotId,
            metricKey: modelMetric.metricKey,
            modelValue: modelMetric.valueNumeric,
            actualValue: actual.valueNumeric,
            absoluteGap,
            relativeGap,
            severity:
              magnitude >= 0.25
                ? "critical"
                : magnitude >= 0.1
                  ? "high"
                  : magnitude >= 0.03
                    ? "medium"
                    : "low",
            status: "completed",
            explanation: "模型指标与同口径行情实际值的确定性比较。",
            modelPeriod: modelMetric.period,
            actualPeriod: actual.period,
            modelSource: modelMetric.source,
            actualSource: actual.source,
            evidenceIds: modelMetric.evidenceIds,
          });
        }
        return {
          kind: "extension",
          handler: this.name,
          details: {
            operation: "market.refresh",
            snapshotId: snapshot.snapshotId,
            barCount: bars.length,
            metricCount,
          },
        };
      });
    } finally {
      stores.close();
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
        if (sourceKind === "workflow-report") {
        const reportVersionId = payloadString(
          context.job,
          "reportVersionId",
        );
        const version =
          stores.workflow.workflow.getReportVersion(reportVersionId);
        const report = stores.workflow.workflow.getReport(
          version.reportId,
        );
        const workflow = stores.workflow.workflow.getWorkflow(
          report.workflowId,
        );
        if (
          workflow.datasetId !== context.job.projectId ||
          `sha256:${createHash("sha256")
            .update(version.markdown)
            .digest("hex")}` !== inputChecksum
        ) {
          throw projectionError(
            "Rendered report input does not match its immutable workflow report version",
            "projection_integrity_mismatch",
          );
        }
        const evidenceIds = [
          ...new Set(
            [...version.markdown.matchAll(
              /\b(?:chunk|fact|cell|page):[A-Za-z0-9_.-]+/gu,
            )].map((match) => match[0]!),
          ),
        ].filter(
          (evidenceId) =>
            stores.research.evidence.find(evidenceId) !== null,
        );
        const asset = stores.research.assets.saveVersion({
          assetId: `report:${report.reportId}`,
          assetType: "report",
          title: report.title,
          status: "completed",
          summary: version.markdown.slice(0, 2_000),
          contentMarkdown: version.markdown,
          structuredContent: {
            reportId: report.reportId,
            reportVersionId,
            versionNo: version.versionNo,
          },
          metadata: { artifacts: outputs },
          tags: ["report", report.reportType],
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
            reportVersionId,
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
  "valuation.extract",
  "valuation.derive",
  "market.refresh",
  "report.generate",
];
