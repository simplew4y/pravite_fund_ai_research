import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

import type {
  ComputeResponse,
  DeleteResearchAssetsRequest,
  ExcelSourceCell,
  ExcelSourcePayload,
  ExcelSourceQuery,
  ExcelSourceSheet,
  PdfSourceHighlight,
  PdfSourcePage,
  PdfSourcePageQuery,
  RegisterDocumentVersionRequest,
  SaveResearchAssetRequest,
  UpdateResearchAssetContextRequest,
  UpdateResearchAssetLifecycleRequest,
} from "@private-fund/contracts";
import {
  DomainError,
  assertPathWithin,
  ensureDirectoryWithin,
  newId,
  type TenantContext,
} from "@private-fund/core";
import type { ControlRepositories } from "@private-fund/db";
import type {
  EvidenceRecord,
  EvidenceTrace,
  ExcelEvidenceCell,
  ExcelEvidenceSheetStats,
  ResearchStore,
} from "@private-fund/research-store";

import type {
  JobService,
  ResearchService,
  UploadResearchDocumentInput,
} from "./dependencies.js";
import { ProjectResearchStoreManager } from "./research-stores.js";
import {
  openSecureProjectFile,
  type OpenedFileResource,
} from "./secure-files.js";

const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
const SUPPORTED_UPLOAD_EXTENSIONS = new Set([
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

const DEFAULT_UPLOAD_MIME_TYPES = new Map<string, string>([
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

const COMPATIBLE_UPLOAD_MIME_TYPES = new Map<string, ReadonlySet<string>>([
  [".csv", new Set(["text/csv", "application/csv", "text/plain"])],
  [".md", new Set(["text/markdown", "text/x-markdown", "text/plain"])],
  [
    ".markdown",
    new Set(["text/markdown", "text/x-markdown", "text/plain"]),
  ],
]);

// New uploads are intentionally limited to OOXML workbooks, but migrated
// evidence can still originate from legacy .xls and CSV sources. The preview
// reads the canonical cell index, so it remains valid without reopening those
// source formats.
const EXCEL_FILE_TYPES = new Set([
  "xlsx",
  "xlsm",
  "xltx",
  "xltm",
  "xls",
  "csv",
]);
const EXCEL_MAX_ROW = 1_048_576;
const EXCEL_MAX_COLUMN = 16_384;
const EXCEL_SOURCE_MAX_GRID_CELLS = 4_000;
const EXCEL_SOURCE_MAX_ROWS = 200;
const EXCEL_SOURCE_MAX_COLUMNS = 80;
const EXCEL_SOURCE_NEARBY_RADIUS = 8;
const PDF_RENDER_DPI = 144;
const PDF_RENDER_MAX_PIXELS = 32_000_000;

export interface SourcePreviewComputeTransport {
  execute(request: {
    readonly protocolVersion: 1;
    readonly requestId: string;
    readonly jobId: string;
    readonly operation: "render_pdf_page";
    readonly inputPath: string;
    readonly outputDirectory: string;
    readonly options: Readonly<Record<string, unknown>>;
  }): Promise<ComputeResponse>;
}

interface ExcelRangeBounds {
  readonly rowMin: number;
  readonly rowMax: number;
  readonly columnMin: number;
  readonly columnMax: number;
}

interface ExcelWindow {
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly columnStart: number;
  readonly columnEnd: number;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly truncated: boolean;
  readonly displayRangeRef: string;
  readonly previousRowStart: number | null;
  readonly nextRowStart: number | null;
  readonly previousColumnStart: number | null;
  readonly nextColumnStart: number | null;
}

interface RenderedPdfPage {
  readonly outputDirectory: string;
  readonly imagePath: string;
  readonly imageSize: number;
  readonly imageSha256: string;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly pageCount: number;
}

function excelColumnIndex(column: string): number {
  let value = 0;
  for (const character of column.toUpperCase()) {
    if (character < "A" || character > "Z") {
      throw new DomainError(
        `Invalid Excel column: ${column}`,
        "invalid_excel_range",
        400,
      );
    }
    value = value * 26 + character.charCodeAt(0) - 64;
  }
  return value;
}

function excelColumnLabel(index: number): string {
  if (
    !Number.isSafeInteger(index) ||
    index < 1 ||
    index > EXCEL_MAX_COLUMN
  ) {
    throw new DomainError(
      "Excel column is outside worksheet limits",
      "invalid_excel_range",
      400,
    );
  }
  let value = index;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function excelRangeRef(bounds: ExcelRangeBounds): string {
  const start = `${excelColumnLabel(bounds.columnMin)}${String(bounds.rowMin)}`;
  const end = `${excelColumnLabel(bounds.columnMax)}${String(bounds.rowMax)}`;
  return start === end ? start : `${start}:${end}`;
}

function parseExcelRange(value: string): ExcelRangeBounds {
  const normalized = value.normalize("NFKC").trim().replaceAll("$", "");
  const match =
    /^([A-Za-z]{1,3})([1-9][0-9]{0,6})(?::([A-Za-z]{1,3})([1-9][0-9]{0,6}))?$/u.exec(
      normalized,
    );
  if (match === null) {
    throw new DomainError(
      `Invalid Excel range: ${value}`,
      "invalid_excel_range",
      400,
    );
  }
  const firstColumn = excelColumnIndex(match[1]!);
  const firstRow = Number(match[2]);
  const secondColumn = excelColumnIndex(match[3] ?? match[1]!);
  const secondRow = Number(match[4] ?? match[2]);
  const bounds = {
    rowMin: Math.min(firstRow, secondRow),
    rowMax: Math.max(firstRow, secondRow),
    columnMin: Math.min(firstColumn, secondColumn),
    columnMax: Math.max(firstColumn, secondColumn),
  };
  if (
    bounds.rowMax > EXCEL_MAX_ROW ||
    bounds.columnMax > EXCEL_MAX_COLUMN
  ) {
    throw new DomainError(
      `Excel range exceeds worksheet limits: ${value}`,
      "invalid_excel_range",
      400,
    );
  }
  return bounds;
}

function excelRangeWindow(
  bounds: ExcelRangeBounds,
  cursor: {
    readonly row?: number;
    readonly column?: number;
  },
): ExcelWindow {
  const requestedRows = bounds.rowMax - bounds.rowMin + 1;
  const requestedColumns =
    bounds.columnMax - bounds.columnMin + 1;
  const pageColumns = Math.min(
    requestedColumns,
    EXCEL_SOURCE_MAX_COLUMNS,
  );
  const pageRows = Math.min(
    requestedRows,
    EXCEL_SOURCE_MAX_ROWS,
    Math.max(
      1,
      Math.floor(EXCEL_SOURCE_MAX_GRID_CELLS / pageColumns),
    ),
  );
  const rowStart = Math.min(
    Math.max(cursor.row ?? bounds.rowMin, bounds.rowMin),
    bounds.rowMax,
  );
  const columnStart = Math.min(
    Math.max(cursor.column ?? bounds.columnMin, bounds.columnMin),
    bounds.columnMax,
  );
  const rowEnd = Math.min(bounds.rowMax, rowStart + pageRows - 1);
  const columnEnd = Math.min(
    bounds.columnMax,
    columnStart + pageColumns - 1,
  );
  const windowBounds = {
    rowMin: rowStart,
    rowMax: rowEnd,
    columnMin: columnStart,
    columnMax: columnEnd,
  };
  return {
    rowStart,
    rowEnd,
    columnStart,
    columnEnd,
    rowCount: rowEnd - rowStart + 1,
    columnCount: columnEnd - columnStart + 1,
    truncated:
      rowStart > bounds.rowMin ||
      rowEnd < bounds.rowMax ||
      columnStart > bounds.columnMin ||
      columnEnd < bounds.columnMax,
    displayRangeRef: excelRangeRef(windowBounds),
    previousRowStart:
      rowStart > bounds.rowMin
        ? Math.max(bounds.rowMin, rowStart - pageRows)
        : null,
    nextRowStart: rowEnd < bounds.rowMax ? rowEnd + 1 : null,
    previousColumnStart:
      columnStart > bounds.columnMin
        ? Math.max(bounds.columnMin, columnStart - pageColumns)
        : null,
    nextColumnStart:
      columnEnd < bounds.columnMax ? columnEnd + 1 : null,
  };
}

function normalizedSheetName(value: string): string {
  let normalized = value
    .normalize("NFKC")
    .replaceAll("\u00a0", " ")
    .trim();
  if (
    normalized.length >= 2 &&
    normalized.startsWith("'") &&
    normalized.endsWith("'")
  ) {
    normalized = normalized.slice(1, -1).replaceAll("''", "'");
  }
  return normalized
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
}

function optionalPositiveInteger(
  value: unknown,
  maximum: number,
): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
    ? value
    : null;
}

function sourcePreviewSheets(
  metadata: Readonly<Record<string, unknown>>,
): Array<{
  sheetName: string;
  maxRow: number;
  maxColumn: number;
  usedRange: string | null;
  nonEmptyCellCount: number;
  formulaCount: number;
}> {
  const preview = metadata.sourcePreview;
  if (
    typeof preview !== "object" ||
    preview === null ||
    Array.isArray(preview) ||
    (preview as Record<string, unknown>).kind !== "excel"
  ) {
    return [];
  }
  const sheets = (preview as Record<string, unknown>).sheets;
  if (!Array.isArray(sheets)) {
    return [];
  }
  const result = [];
  for (const candidate of sheets.slice(0, 16_384)) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      continue;
    }
    const item = candidate as Record<string, unknown>;
    const sheetName =
      typeof item.sheetName === "string"
        ? item.sheetName.normalize("NFKC").trim()
        : "";
    const maxRow = optionalPositiveInteger(
      item.maxRow,
      EXCEL_MAX_ROW,
    );
    const maxColumn = optionalPositiveInteger(
      item.maxColumn,
      EXCEL_MAX_COLUMN,
    );
    const nonEmptyCellCount = optionalPositiveInteger(
      item.nonEmptyCellCount,
      Number.MAX_SAFE_INTEGER,
    );
    const formulaCount = optionalPositiveInteger(
      item.formulaCount,
      Number.MAX_SAFE_INTEGER,
    );
    const usedRange =
      item.usedRange === null ||
      (typeof item.usedRange === "string" &&
        item.usedRange.length <= 80)
        ? item.usedRange
        : null;
    if (
      !sheetName ||
      sheetName.length > 500 ||
      maxRow === null ||
      maxColumn === null ||
      nonEmptyCellCount === null ||
      formulaCount === null
    ) {
      continue;
    }
    result.push({
      sheetName,
      maxRow,
      maxColumn,
      usedRange,
      nonEmptyCellCount,
      formulaCount,
    });
  }
  return result;
}

function excelSheet(
  stats: ExcelEvidenceSheetStats | undefined,
  projected:
    | ReturnType<typeof sourcePreviewSheets>[number]
    | undefined,
  fallbackName: string,
): ExcelSourceSheet {
  const sheetName = projected?.sheetName ?? stats?.sheetName ?? fallbackName;
  const rowCount = projected?.maxRow ?? stats?.rowMax ?? 0;
  const columnCount =
    projected?.maxColumn ?? stats?.columnMax ?? 0;
  const nonEmptyCellCount =
    stats?.nonEmptyCellCount ?? projected?.nonEmptyCellCount ?? 0;
  const formulaCount =
    stats?.formulaCount ?? projected?.formulaCount ?? 0;
  const actualBounds =
    stats === undefined
      ? null
      : {
          rowMin: stats.rowMin,
          rowMax: stats.rowMax,
          columnMin: stats.columnMin,
          columnMax: stats.columnMax,
        };
  const usedRange =
    projected?.usedRange ??
    (actualBounds === null ? null : excelRangeRef(actualBounds));
  return {
    sheetName,
    sheetRole: "worksheet",
    usedRange,
    rowCount,
    columnCount,
    nonEmptyCellCount,
    formulaCount,
    formulaDensity:
      nonEmptyCellCount === 0
        ? 0
        : Math.min(1, formulaCount / nonEmptyCellCount),
    summary: null,
  };
}

function excelCell(cell: ExcelEvidenceCell): ExcelSourceCell {
  return {
    evidenceId: cell.evidence.evidenceId,
    cellRef:
      cell.evidence.cellRef ??
      `${excelColumnLabel(cell.columnIndex)}${String(cell.rowIndex)}`,
    rowIndex: cell.rowIndex,
    columnIndex: cell.columnIndex,
    displayValue:
      cell.evidence.displayValue ??
      cell.evidence.locator.displayValue ??
      null,
    rawValue:
      cell.evidence.rawValue ??
      cell.evidence.locator.rawValue ??
      null,
    numericValue: cell.numericValue,
    formula:
      cell.evidence.formula ??
      cell.evidence.locator.formula ??
      null,
    cachedValue: cell.cachedValue,
    numberFormat: cell.numberFormat,
    rowLabel: cell.rowLabel,
    columnLabel: cell.columnLabel,
    period: cell.period,
    unit: cell.unit,
    isFormula:
      (cell.evidence.formula ??
        cell.evidence.locator.formula ??
        null) !== null,
  };
}

function finitePositive(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
    ? value
    : null;
}

function pdfPageDimensions(page: EvidenceRecord): {
  width: number;
  height: number;
} {
  const width = finitePositive(page.metadata.width);
  const height = finitePositive(page.metadata.height);
  if (width !== null && height !== null) {
    return { width, height };
  }
  if (
    page.bbox !== null &&
    page.bbox[2] > page.bbox[0] &&
    page.bbox[3] > page.bbox[1]
  ) {
    return {
      width: page.bbox[2] - page.bbox[0],
      height: page.bbox[3] - page.bbox[1],
    };
  }
  throw new DomainError(
    "PDF page dimensions are unavailable",
    "pdf_page_metadata_unavailable",
    409,
  );
}

function normalizedMatchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}%]+/gu, "");
}

function precisePdfBbox(
  bbox: readonly number[] | null,
  pageWidth: number,
  pageHeight: number,
): [number, number, number, number] | null {
  if (
    bbox === null ||
    bbox.length !== 4 ||
    !bbox.every((coordinate) => Number.isFinite(coordinate))
  ) {
    return null;
  }
  const xMin = bbox[0]!;
  const yMin = bbox[1]!;
  const xMax = bbox[2]!;
  const yMax = bbox[3]!;
  if (
    xMin < 0 ||
    yMin < 0 ||
    xMax <= xMin ||
    yMax <= yMin ||
    xMax > pageWidth ||
    yMax > pageHeight
  ) {
    return null;
  }
  const coversPage =
    xMin <= 0.5 &&
    yMin <= 0.5 &&
    xMax >= pageWidth - 0.5 &&
    yMax >= pageHeight - 0.5;
  return coversPage ? null : [xMin, yMin, xMax, yMax];
}

function pageBlocks(
  page: EvidenceRecord,
): Array<{
  text: string;
  bbox: [number, number, number, number];
}> {
  const blocks = page.metadata.blocks;
  if (!Array.isArray(blocks)) {
    return [];
  }
  const result = [];
  for (const value of blocks.slice(0, 10_000)) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      continue;
    }
    const item = value as Record<string, unknown>;
    if (
      typeof item.text !== "string" ||
      !Array.isArray(item.bbox) ||
      item.bbox.length !== 4 ||
      !item.bbox.every(
        (coordinate) =>
          typeof coordinate === "number" &&
          Number.isFinite(coordinate),
      )
    ) {
      continue;
    }
    result.push({
      text: item.text,
      bbox: item.bbox as [number, number, number, number],
    });
  }
  return result;
}

function percentHighlight(
  bbox: [number, number, number, number],
  pageWidth: number,
  pageHeight: number,
): PdfSourceHighlight {
  const [xMin, yMin, xMax, yMax] = bbox;
  return {
    xPct: Math.max(0, Math.min(100, (xMin / pageWidth) * 100)),
    yPct: Math.max(0, Math.min(100, (yMin / pageHeight) * 100)),
    widthPct: Math.max(
      0,
      Math.min(100, ((xMax - xMin) / pageWidth) * 100),
    ),
    heightPct: Math.max(
      0,
      Math.min(100, ((yMax - yMin) / pageHeight) * 100),
    ),
  };
}

function pdfHighlights(
  anchor: EvidenceTrace,
  page: EvidenceRecord,
  pageNumber: number,
  query: string | undefined,
  dimensions: { width: number; height: number },
): {
  highlights: PdfSourceHighlight[];
  mode: "evidence_bbox" | "page_block" | "none";
} {
  const anchorCoversPage =
    (anchor.pageStart === null || anchor.pageStart <= pageNumber) &&
    (anchor.pageEnd === null || anchor.pageEnd >= pageNumber);
  const anchorBbox =
    anchorCoversPage
      ? precisePdfBbox(anchor.bbox, dimensions.width, dimensions.height)
      : null;
  if (anchorBbox !== null) {
    return {
      highlights: [
        percentHighlight(
          anchorBbox,
          dimensions.width,
          dimensions.height,
        ),
      ],
      mode: "evidence_bbox",
    };
  }

  const matchQuery =
    query?.trim() ||
    (anchor.evidenceId === page.evidenceId
      ? ""
      : anchor.originalText.trim());
  const normalizedQuery = normalizedMatchText(matchQuery);
  if (normalizedQuery.length < 2) {
    return { highlights: [], mode: "none" };
  }
  const matches = pageBlocks(page)
    .filter((block) => {
      const normalizedBlock = normalizedMatchText(block.text);
      return (
        normalizedBlock.length >= 2 &&
        (normalizedBlock.includes(normalizedQuery) ||
          (normalizedBlock.length >= 4 &&
            normalizedQuery.includes(normalizedBlock)))
      );
    })
    .map((block) =>
      precisePdfBbox(
        block.bbox,
        dimensions.width,
        dimensions.height,
      ),
    )
    .filter(
      (
        bbox,
      ): bbox is [number, number, number, number] => bbox !== null,
    )
    .slice(0, 100)
    .map((bbox) =>
      percentHighlight(
        bbox,
        dimensions.width,
        dimensions.height,
      ),
    );
  return {
    highlights: matches,
    mode: matches.length > 0 ? "page_block" : "none",
  };
}

async function hashFile(filename: string): Promise<{
  sha256: string;
  size: number;
}> {
  const digest = createHash("sha256");
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filename);
    stream.on("data", (chunk: string | Buffer) => {
      size += Buffer.byteLength(chunk);
      digest.update(chunk);
    });
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return { sha256: digest.digest("hex"), size };
}

export class RepositoryResearchService implements ResearchService {
  readonly #pdfRenders = new Map<string, Promise<RenderedPdfPage>>();

  public constructor(
    private readonly repositories: ControlRepositories,
    private readonly stores: ProjectResearchStoreManager,
    private readonly jobs: JobService,
    private readonly compute?: SourcePreviewComputeTransport,
  ) {}

  public async listDocuments(
    tenant: TenantContext,
    projectId: string,
    options: { limit: number; offset: number },
  ) {
    return this.store(tenant, projectId).documents.list(options);
  }

  public async registerDocument(
    tenant: TenantContext,
    projectId: string,
    input: RegisterDocumentVersionRequest,
  ) {
    const projectRoot = this.projectRoot(tenant, projectId);
    if (path.isAbsolute(input.storedPath)) {
      throw new DomainError(
        "storedPath must be relative to the project",
        "invalid_document_path",
        400,
      );
    }
    const candidate = assertPathWithin(
      path.resolve(projectRoot, input.storedPath),
      projectRoot,
    );
    const details = await lstat(candidate).catch(() => null);
    if (
      details === null ||
      !details.isFile() ||
      details.isSymbolicLink()
    ) {
      throw new DomainError(
        "Stored document file was not found",
        "document_file_not_found",
        404,
      );
    }
    const [realCandidate, realProjectRoot] = await Promise.all([
      realpath(candidate),
      realpath(projectRoot),
    ]);
    assertPathWithin(realCandidate, realProjectRoot);
    const actual = await hashFile(candidate);
    if (
      actual.sha256 !== input.sha256.toLowerCase() ||
      actual.size !== input.fileSize
    ) {
      throw new DomainError(
        "Document checksum or size does not match the stored file",
        "document_integrity_mismatch",
        409,
      );
    }

    return this.stores.get(projectRoot).documents.registerVersion({
      ...(input.documentId === undefined
        ? {}
        : { documentId: input.documentId }),
      ...(input.logicalKey === undefined
        ? {}
        : { logicalKey: input.logicalKey }),
      ...(input.sourceRoot === undefined
        ? {}
        : { sourceRoot: input.sourceRoot }),
      sourceRelpath: input.sourceRelpath,
      title: input.title,
      originalFilename: input.originalFilename,
      storedPath: input.storedPath,
      fileType: input.fileType,
      ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
      sha256: actual.sha256,
      fileSize: actual.size,
      status: input.status,
      ...(input.parserName === undefined
        ? {}
        : { parserName: input.parserName }),
      ...(input.parserVersion === undefined
        ? {}
        : { parserVersion: input.parserVersion }),
      metadata: input.metadata,
      ...(input.activate === undefined ? {} : { activate: input.activate }),
    });
  }

  public async uploadDocument(
    tenant: TenantContext,
    projectId: string,
    input: UploadResearchDocumentInput,
  ) {
    const originalFilename = normalizeUploadFilename(input.filename);
    const extension = path.extname(originalFilename).toLowerCase();
    if (!SUPPORTED_UPLOAD_EXTENSIONS.has(extension)) {
      throw new DomainError(
        `Unsupported document type: ${extension || "extensionless"}`,
        "unsupported_document_type",
        415,
      );
    }
    const mimeType = normalizeUploadMimeType(extension, input.mimeType);

    const projectRoot = this.projectRoot(tenant, projectId);
    const incomingDirectory = await ensureDirectoryWithin(
      path.join(projectRoot, "sources", ".incoming"),
      tenant.root,
    );
    const temporaryPath = path.join(
      incomingDirectory,
      `${newId("upload")}.part`,
    );
    const uploaded = await writeUpload(
      temporaryPath,
      input.contents,
      MAX_UPLOAD_BYTES,
    );

    let absoluteStoredPath: string | undefined;
    let registered = false;
    try {
      const objectDirectory = await ensureDirectoryWithin(
        path.join(
          projectRoot,
          "sources",
          "objects",
          uploaded.sha256.slice(0, 2),
        ),
        tenant.root,
      );
      const objectName = `${uploaded.sha256}_${newId("blob")}${extension}`;
      absoluteStoredPath = path.join(objectDirectory, objectName);
      await rename(temporaryPath, absoluteStoredPath);
      const storedPath = path.relative(projectRoot, absoluteStoredPath);

      const registration = await this.registerDocument(tenant, projectId, {
        logicalKey: `upload:${originalFilename.toLocaleLowerCase("en-US")}`,
        sourceRoot: "upload",
        sourceRelpath: originalFilename,
        title: documentTitle(originalFilename),
        originalFilename,
        storedPath,
        fileType: extension.slice(1),
        mimeType,
        sha256: uploaded.sha256,
        fileSize: uploaded.size,
        status: "parsing",
        parserName: "private-fund-compute-worker",
        parserVersion: "1",
        metadata: {
          ingestionSource: "multipart_upload",
          uploadedAt: new Date().toISOString(),
        },
        activate: false,
      });
      registered = true;

      if (!registration.created) {
        await rm(absoluteStoredPath, { force: true });
      }
      const jobInputPath = registration.created
        ? storedPath
        : path.relative(
            await realpath(projectRoot),
            await realpath(registration.version.storedPath),
          );
      if (
        jobInputPath.length === 0 ||
        path.isAbsolute(jobInputPath) ||
        jobInputPath === ".." ||
        jobInputPath.startsWith(`..${path.sep}`)
      ) {
        throw new DomainError(
          "Registered document path escapes its project",
          "invalid_document_path",
          409,
        );
      }
      const job = await this.jobs.enqueue(tenant, {
        projectId,
        type: "document.ingest",
        payload: {
          inputPath: jobInputPath,
          outputDirectory: path.join(
            "artifacts",
            "ingest",
            registration.version.id,
          ),
          documentId: registration.document.id,
          documentVersionId: registration.version.id,
          sourceSha256: registration.version.sha256,
        },
        idempotencyKey: `document-ingest:${registration.version.id}`,
        maxAttempts: 3,
      });
      return {
        ...registration,
        job: job.job,
      };
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (!registered && absoluteStoredPath !== undefined) {
        await rm(absoluteStoredPath, { force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  public async documentVersions(
    tenant: TenantContext,
    projectId: string,
    documentId: string,
    options: { limit: number; offset: number },
  ) {
    return this.store(tenant, projectId).documents.listVersions(
      documentId,
      options,
    );
  }

  public async openDocumentFile(
    tenant: TenantContext,
    projectId: string,
    documentId: string,
    versionId?: string,
  ): Promise<OpenedFileResource> {
    const projectRoot = this.projectRoot(tenant, projectId);
    const documents = this.stores.get(projectRoot).documents;
    const document = documents.getById(documentId);
    if (document.status === "removed") {
      throw new DomainError(
        "Document not found",
        "not_found",
        404,
      );
    }
    const version =
      versionId === undefined
        ? (documents.getCurrentVersion(documentId) ??
          documents.listVersions(documentId, {
            limit: 1,
            offset: 0,
          }).items[0] ??
          null)
        : documents.getVersion(versionId);
    if (version === null || version.documentId !== documentId) {
      throw new DomainError(
        "Document version not found",
        "not_found",
        404,
      );
    }
    return openSecureProjectFile(projectRoot, version.storedPath, {
      filename: version.originalFilename,
      mimeType: version.mimeType,
      expectedSize: version.fileSize,
      expectedSha256: version.sha256,
    });
  }

  public async documentTextPreview(
    tenant: TenantContext,
    projectId: string,
    documentId: string,
    versionId?: string,
  ) {
    const store = this.store(tenant, projectId);
    const document = store.documents.getById(documentId);
    if (document.status === "removed" || document.deletedAt !== null) {
      throw new DomainError("Document not found", "not_found", 404);
    }
    const version =
      versionId === undefined
        ? (store.documents.getCurrentVersion(documentId) ??
          store.documents.listVersions(documentId, {
            limit: 1,
            offset: 0,
          }).items[0] ??
          null)
        : store.documents.getVersion(versionId);
    if (version === null || version.documentId !== documentId) {
      throw new DomainError(
        "Document version not found",
        "not_found",
        404,
      );
    }
    return {
      kind: "document_text" as const,
      documentId: document.id,
      documentVersionId: version.id,
      fileName: version.originalFilename,
      fileType: version.fileType,
      ...store.evidence.textPreviewForVersion(version.id, {
        maxChunks: 400,
        maxCharacters: 200_000,
      }),
    };
  }

  public async removeDocument(
    tenant: TenantContext,
    projectId: string,
    documentId: string,
  ) {
    const documents = this.store(tenant, projectId).documents;
    try {
      return documents.markRemoved(documentId);
    } catch (error) {
      if (
        error instanceof DomainError &&
        error.code === "not_found"
      ) {
        return null;
      }
      throw error;
    }
  }

  public async removeDocuments(
    tenant: TenantContext,
    projectId: string,
    input: { documentIds: string[] },
  ) {
    const removed = this.store(
      tenant,
      projectId,
    ).documents.markRemovedMany(input.documentIds);
    return {
      documents: [...removed.documents],
      deletedDocumentIds: [...removed.deletedDocumentIds],
      alreadyRemovedDocumentIds: [
        ...removed.alreadyRemovedDocumentIds,
      ],
    };
  }

  public async searchEvidence(
    tenant: TenantContext,
    projectId: string,
    options: {
      query: string;
      kinds?: readonly ("chunk" | "fact" | "cell" | "page")[];
      limit: number;
      offset: number;
      includeHistorical: boolean;
    },
  ) {
    return this.store(tenant, projectId).evidence.search(options);
  }

  public async evidence(
    tenant: TenantContext,
    projectId: string,
    evidenceId: string,
  ) {
    try {
      return this.store(tenant, projectId).evidence.trace(evidenceId);
    } catch (error) {
      if (
        error instanceof DomainError &&
        error.code === "not_found"
      ) {
        return null;
      }
      throw error;
    }
  }

  public async openEvidenceFile(
    tenant: TenantContext,
    projectId: string,
    evidenceId: string,
  ): Promise<OpenedFileResource> {
    const projectRoot = this.projectRoot(tenant, projectId);
    const trace = this.stores.get(projectRoot).evidence.trace(evidenceId);
    if (trace.document.status === "removed") {
      throw new DomainError(
        "Evidence source not found",
        "not_found",
        404,
      );
    }
    return openSecureProjectFile(
      projectRoot,
      trace.documentVersion.storedPath,
      {
        filename: trace.documentVersion.originalFilename,
        mimeType: trace.documentVersion.mimeType,
        expectedSize: trace.documentVersion.fileSize,
        expectedSha256: trace.documentVersion.sha256,
      },
    );
  }

  public async excelSource(
    tenant: TenantContext,
    projectId: string,
    evidenceId: string,
    query: ExcelSourceQuery,
  ): Promise<ExcelSourcePayload> {
    const anchor = this.sourceEvidence(
      tenant,
      projectId,
      evidenceId,
    );
    if (!EXCEL_FILE_TYPES.has(anchor.documentVersion.fileType)) {
      throw new DomainError(
        "Evidence source is not a supported Excel workbook",
        "unsupported_source_preview",
        415,
      );
    }
    const store = this.store(tenant, projectId);
    const stats = store.evidence.listExcelSheetStats(
      anchor.documentVersionId,
    );
    const projectedSheets = sourcePreviewSheets(
      anchor.documentVersion.metadata,
    );
    const statsByName = new Map(
      stats.map((item) => [normalizedSheetName(item.sheetName), item]),
    );
    const projectedByName = new Map(
      projectedSheets.map((item) => [
        normalizedSheetName(item.sheetName),
        item,
      ]),
    );
    const orderedNames = [
      ...projectedSheets.map((item) => item.sheetName),
      ...stats
        .filter(
          (item) =>
            !projectedByName.has(normalizedSheetName(item.sheetName)),
        )
        .map((item) => item.sheetName),
    ];
    const sheets = orderedNames.map((sheetName) => {
      const key = normalizedSheetName(sheetName);
      return excelSheet(
        statsByName.get(key),
        projectedByName.get(key),
        sheetName,
      );
    });
    const base = {
      kind: "excel" as const,
      documentId: anchor.document.id,
      documentVersionId: anchor.documentVersionId,
      anchorEvidenceId: anchor.evidenceId,
      fileName: anchor.documentVersion.originalFilename,
    };

    if (query.sheetName === undefined) {
      return {
        ...base,
        mode: "workbook",
        sheets,
      };
    }

    const requestedSheetKey = normalizedSheetName(query.sheetName);
    const selectedSheet = sheets.find(
      (candidate) =>
        normalizedSheetName(candidate.sheetName) === requestedSheetKey,
    );
    if (selectedSheet === undefined) {
      throw new DomainError(
        `Worksheet not found: ${query.sheetName}`,
        "source_sheet_not_found",
        404,
      );
    }
    if (query.rangeRef === undefined) {
      const regions =
        selectedSheet.usedRange === null
          ? []
          : [
              {
                regionType: "used-range",
                cellRange: selectedSheet.usedRange,
                rowCount: Math.max(1, selectedSheet.rowCount),
                columnCount: Math.max(1, selectedSheet.columnCount),
                nonEmptyCellCount: selectedSheet.nonEmptyCellCount,
                formulaCount: selectedSheet.formulaCount,
                summary: null,
              },
            ];
      return {
        ...base,
        mode: "sheet",
        sheet: selectedSheet,
        regions,
      };
    }

    const requestedBounds = parseExcelRange(query.rangeRef);
    const rangeCount = store.evidence.countExcelCellsInRange(
      anchor.documentVersionId,
      selectedSheet.sheetName,
      requestedBounds,
    );
    let window = excelRangeWindow(requestedBounds, {
      ...(query.windowRow === undefined
        ? {}
        : { row: query.windowRow }),
      ...(query.windowColumn === undefined
        ? {}
        : { column: query.windowColumn }),
    });
    if (
      query.windowRow === undefined &&
      query.windowColumn === undefined &&
      rangeCount > 0
    ) {
      const firstCell = store.evidence.listExcelCellsInRange(
        anchor.documentVersionId,
        selectedSheet.sheetName,
        requestedBounds,
        1,
      )[0];
      if (
        firstCell !== undefined &&
        (firstCell.rowIndex < window.rowStart ||
          firstCell.rowIndex > window.rowEnd ||
          firstCell.columnIndex < window.columnStart ||
          firstCell.columnIndex > window.columnEnd)
      ) {
        window = excelRangeWindow(requestedBounds, {
          row: Math.max(requestedBounds.rowMin, firstCell.rowIndex - 1),
          column: Math.max(
            requestedBounds.columnMin,
            firstCell.columnIndex - 1,
          ),
        });
      }
    }
    const windowBounds = {
      rowMin: window.rowStart,
      rowMax: window.rowEnd,
      columnMin: window.columnStart,
      columnMax: window.columnEnd,
    };
    const cells = store.evidence
      .listExcelCellsInRange(
        anchor.documentVersionId,
        selectedSheet.sheetName,
        windowBounds,
      )
      .map(excelCell);
    const emptyReason =
      rangeCount > 0
        ? null
        : selectedSheet.nonEmptyCellCount > 0
          ? "requested_range_empty" as const
          : "cell_index_unavailable" as const;
    const nearbyCells =
      rangeCount > 0
        ? []
        : store.evidence
            .listExcelCellsInRange(
              anchor.documentVersionId,
              selectedSheet.sheetName,
              {
                rowMin: Math.max(
                  1,
                  requestedBounds.rowMin - EXCEL_SOURCE_NEARBY_RADIUS,
                ),
                rowMax: Math.min(
                  EXCEL_MAX_ROW,
                  requestedBounds.rowMax + EXCEL_SOURCE_NEARBY_RADIUS,
                ),
                columnMin: Math.max(
                  1,
                  requestedBounds.columnMin -
                    EXCEL_SOURCE_NEARBY_RADIUS,
                ),
                columnMax: Math.min(
                  EXCEL_MAX_COLUMN,
                  requestedBounds.columnMax +
                    EXCEL_SOURCE_NEARBY_RADIUS,
                ),
              },
              120,
            )
            .map(excelCell);
    return {
      ...base,
      mode: "range",
      sheet: selectedSheet,
      requestedRangeRef: query.rangeRef,
      rangeRef: window.displayRangeRef,
      requestedRowMin: requestedBounds.rowMin,
      requestedRowMax: requestedBounds.rowMax,
      requestedColumnMin: requestedBounds.columnMin,
      requestedColumnMax: requestedBounds.columnMax,
      rowMin: window.rowStart,
      rowMax: window.rowEnd,
      columnMin: window.columnStart,
      columnMax: window.columnEnd,
      columnLabels: Array.from(
        {
          length: window.columnEnd - window.columnStart + 1,
        },
        (_, index) => excelColumnLabel(window.columnStart + index),
      ),
      cells,
      nearbyCells,
      emptyReason,
      totalNonEmptyCellCount: rangeCount,
      window,
    };
  }

  public async pdfSourcePage(
    tenant: TenantContext,
    projectId: string,
    evidenceId: string,
    pageNumber: number,
    query: PdfSourcePageQuery,
  ): Promise<PdfSourcePage> {
    const context = this.pdfSourceContext(
      tenant,
      projectId,
      evidenceId,
      pageNumber,
    );
    const rendered = await this.renderPdfPage(
      tenant,
      projectId,
      context.anchor,
      pageNumber,
    );
    const dimensions = pdfPageDimensions(context.page);
    const highlight = pdfHighlights(
      context.anchor,
      context.page,
      pageNumber,
      query.quote,
      dimensions,
    );
    return {
      kind: "pdf",
      documentId: context.anchor.document.id,
      documentVersionId: context.anchor.documentVersionId,
      anchorEvidenceId: context.anchor.evidenceId,
      pageEvidenceId: context.page.evidenceId,
      pageNumber,
      pageCount: rendered.pageCount,
      fileName: context.anchor.documentVersion.originalFilename,
      imageUrl:
        `/v1/projects/${encodeURIComponent(projectId)}/evidence/` +
        `${encodeURIComponent(evidenceId)}/source/pdf/pages/` +
        `${String(pageNumber)}/image`,
      imageWidth: rendered.imageWidth,
      imageHeight: rendered.imageHeight,
      pageWidth: dimensions.width,
      pageHeight: dimensions.height,
      highlights: highlight.highlights,
      matched: highlight.highlights.length > 0,
      highlightSource: {
        mode: highlight.mode,
        evidenceId: context.anchor.evidenceId,
      },
    };
  }

  public async openPdfSourcePageImage(
    tenant: TenantContext,
    projectId: string,
    evidenceId: string,
    pageNumber: number,
  ): Promise<OpenedFileResource> {
    const context = this.pdfSourceContext(
      tenant,
      projectId,
      evidenceId,
      pageNumber,
    );
    const rendered = await this.renderPdfPage(
      tenant,
      projectId,
      context.anchor,
      pageNumber,
    );
    const stem = path.basename(
      context.anchor.documentVersion.originalFilename,
      path.extname(context.anchor.documentVersion.originalFilename),
    );
    return openSecureProjectFile(
      this.projectRoot(tenant, projectId),
      rendered.imagePath,
      {
        filename: `${stem}-p${String(pageNumber)}.png`,
        mimeType: "image/png",
        expectedSize: rendered.imageSize,
        expectedSha256: rendered.imageSha256,
      },
    );
  }

  public async listAssets(
    tenant: TenantContext,
    projectId: string,
    options: { limit: number; offset: number },
  ) {
    return this.store(tenant, projectId).assets.list(options);
  }

  public async saveAsset(
    tenant: TenantContext,
    projectId: string,
    input: SaveResearchAssetRequest,
  ) {
    return this.store(tenant, projectId).assets.saveVersion({
      ...(input.assetId === undefined ? {} : { assetId: input.assetId }),
      assetType: input.assetType,
      title: input.title,
      status: input.status,
      summary: input.summary,
      contentMarkdown: input.contentMarkdown,
      ...(input.sourceResponseId === undefined
        ? {}
        : { sourceResponseId: input.sourceResponseId }),
      structuredContent: input.structuredContent,
      metadata: input.metadata,
      tags: input.tags,
      evidence: input.evidence.map((reference) => ({
        evidenceId: reference.evidenceId,
        relationType: reference.relationType,
        ...(reference.quote === undefined
          ? {}
          : { quote: reference.quote }),
      })),
    });
  }

  public async asset(
    tenant: TenantContext,
    projectId: string,
    assetId: string,
  ) {
    const assets = this.store(tenant, projectId).assets;
    const asset = assets.find(assetId);
    if (asset === null || asset.deletedAt !== null) return null;
    const version = assets.getCurrentVersion(assetId);
    return {
      asset,
      version,
      references:
        version === null
          ? []
          : assets.listEvidenceReferences(version.id),
    };
  }

  public async assetVersions(
    tenant: TenantContext,
    projectId: string,
    assetId: string,
    options: { limit: number; offset: number },
  ) {
    const assets = this.store(tenant, projectId).assets;
    const asset = assets.get(assetId);
    if (asset.deletedAt !== null) {
      throw new DomainError(
        "Research asset not found",
        "not_found",
        404,
      );
    }
    return assets.listVersions(
      assetId,
      options,
    );
  }

  public async assetContext(
    tenant: TenantContext,
    projectId: string,
  ) {
    return {
      assetIds: this.store(tenant, projectId).assetContext.listIds(),
    };
  }

  public async updateAssetContext(
    tenant: TenantContext,
    projectId: string,
    input: UpdateResearchAssetContextRequest,
  ) {
    return {
      assetIds: this.store(tenant, projectId).assetContext.replace(
        input.assetIds,
      ),
    };
  }

  public async updateAssetLifecycle(
    tenant: TenantContext,
    projectId: string,
    assetId: string,
    input: UpdateResearchAssetLifecycleRequest,
  ) {
    const assets = this.store(tenant, projectId).assets;
    const current = assets.get(assetId);
    if (current.deletedAt !== null) {
      throw new DomainError(
        "Research asset not found",
        "not_found",
        404,
      );
    }
    if (input.archived) {
      return assets.setStatus(assetId, "archived");
    }
    const version = assets.getCurrentVersion(assetId);
    return assets.setStatus(
      assetId,
      version === null || version.status === "archived"
        ? "completed"
        : version.status,
    );
  }

  public async deleteAssets(
    tenant: TenantContext,
    projectId: string,
    input: DeleteResearchAssetsRequest,
  ) {
    const assets = this.store(tenant, projectId).assets;
    const current = input.assetIds.map((assetId) => assets.get(assetId));
    const visible = current.filter((asset) => asset.deletedAt === null);
    if (visible.length !== current.length) {
      throw new DomainError(
        "Research asset not found",
        "not_found",
        404,
      );
    }
    for (const asset of visible) {
      assets.markDeleted(asset.id);
    }
    return {
      deletedAssetIds: visible.map((asset) => asset.id),
      retainedVersions: visible.reduce(
        (total, asset) => total + asset.currentVersionNo,
        0,
      ),
      assetIds: assets.listContext(),
    };
  }

  private sourceEvidence(
    tenant: TenantContext,
    projectId: string,
    evidenceId: string,
  ): EvidenceTrace {
    const trace = this.store(tenant, projectId).evidence.trace(evidenceId);
    if (
      trace.document.status === "removed" ||
      trace.document.deletedAt !== null ||
      trace.documentVersion.lifecycle === "removed"
    ) {
      throw new DomainError(
        "Evidence source not found",
        "not_found",
        404,
      );
    }
    return trace;
  }

  private pdfSourceContext(
    tenant: TenantContext,
    projectId: string,
    evidenceId: string,
    pageNumber: number,
  ): {
    anchor: EvidenceTrace;
    page: EvidenceRecord;
  } {
    if (
      !Number.isSafeInteger(pageNumber) ||
      pageNumber < 1 ||
      pageNumber > 1_000_000
    ) {
      throw new DomainError(
        "PDF page number is outside the supported range",
        "invalid_pdf_page",
        400,
      );
    }
    const anchor = this.sourceEvidence(
      tenant,
      projectId,
      evidenceId,
    );
    if (
      anchor.documentVersion.fileType !== "pdf" &&
      anchor.documentVersion.mimeType?.toLowerCase() !==
        "application/pdf"
    ) {
      throw new DomainError(
        "Evidence source is not a PDF",
        "unsupported_source_preview",
        415,
      );
    }
    const page = this.store(tenant, projectId).evidence.findPdfPage(
      anchor.documentVersionId,
      pageNumber,
    );
    if (page === null) {
      throw new DomainError(
        `PDF page ${String(pageNumber)} is not indexed`,
        "pdf_page_not_found",
        404,
      );
    }
    return { anchor, page };
  }

  private async renderPdfPage(
    tenant: TenantContext,
    projectId: string,
    anchor: EvidenceTrace,
    pageNumber: number,
  ): Promise<RenderedPdfPage> {
    if (this.compute === undefined) {
      throw new DomainError(
        "PDF page rendering compute sidecar is unavailable",
        "compute_unavailable",
        503,
      );
    }
    const cacheKey = [
      tenant.dataNamespace,
      projectId,
      anchor.documentVersionId,
      anchor.documentVersion.sha256,
      String(pageNumber),
      String(PDF_RENDER_DPI),
    ].join("\0");
    const cached = this.#pdfRenders.get(cacheKey);
    if (cached !== undefined) {
      const projectRoot = this.projectRoot(tenant, projectId);
      const source = await openSecureProjectFile(
        projectRoot,
        anchor.documentVersion.storedPath,
        {
          filename: anchor.documentVersion.originalFilename,
          mimeType: anchor.documentVersion.mimeType,
          expectedSize: anchor.documentVersion.fileSize,
          expectedSha256: anchor.documentVersion.sha256,
        },
      );
      await source.handle.close();
      return cached;
    }
    const rendering = this.executePdfRender(
      tenant,
      projectId,
      anchor,
      pageNumber,
    );
    this.#pdfRenders.set(cacheKey, rendering);
    try {
      return await rendering;
    } catch (error) {
      if (this.#pdfRenders.get(cacheKey) === rendering) {
        this.#pdfRenders.delete(cacheKey);
      }
      throw error;
    }
  }

  private async executePdfRender(
    tenant: TenantContext,
    projectId: string,
    anchor: EvidenceTrace,
    pageNumber: number,
  ): Promise<RenderedPdfPage> {
    const projectRoot = this.projectRoot(tenant, projectId);
    const source = await openSecureProjectFile(
      projectRoot,
      anchor.documentVersion.storedPath,
      {
        filename: anchor.documentVersion.originalFilename,
        mimeType: anchor.documentVersion.mimeType,
        expectedSize: anchor.documentVersion.fileSize,
        expectedSha256: anchor.documentVersion.sha256,
      },
    );
    const outputDirectory = await ensureDirectoryWithin(
      path.join(
        projectRoot,
        "artifacts",
        "source-previews",
        "pdf",
        anchor.documentVersionId,
        anchor.documentVersion.sha256,
        `page-${String(pageNumber).padStart(6, "0")}-${String(PDF_RENDER_DPI)}dpi`,
      ),
      tenant.root,
    );
    let response: ComputeResponse;
    try {
      response = await this.compute!.execute({
        protocolVersion: 1,
        requestId: newId("pdf_preview_request"),
        jobId: newId("pdf_preview"),
        operation: "render_pdf_page",
        inputPath: source.absolutePath,
        outputDirectory,
        options: {
          pageNumber,
          dpi: PDF_RENDER_DPI,
          maxPixels: PDF_RENDER_MAX_PIXELS,
        },
      });
    } catch {
      throw new DomainError(
        "PDF page rendering sidecar failed",
        "compute_unavailable",
        503,
      );
    } finally {
      await source.handle.close().catch(() => undefined);
    }
    if (response.status === "failed") {
      const errorCode =
        typeof response.metrics.errorCode === "string"
          ? response.metrics.errorCode
          : "compute_failed";
      const status =
        errorCode === "invalid_options"
          ? 400
          : errorCode === "artifact_conflict"
            ? 409
            : errorCode === "dependency_unavailable"
              ? 503
              : 422;
      throw new DomainError(
        response.error ?? "PDF page rendering failed",
        `pdf_render_${errorCode}`,
        status,
      );
    }
    if (
      response.error !== null ||
      response.metrics.inputChecksum !==
        `sha256:${anchor.documentVersion.sha256}`
    ) {
      throw new DomainError(
        "PDF renderer source attestation does not match Evidence",
        "file_integrity_mismatch",
        409,
      );
    }
    const imageArtifacts = response.artifacts.filter(
      (artifact) => artifact.mediaType.toLowerCase() === "image/png",
    );
    const manifestArtifacts = response.artifacts.filter(
      (artifact) =>
        artifact.mediaType.toLowerCase() === "application/json",
    );
    const image = imageArtifacts[0];
    if (
      imageArtifacts.length !== 1 ||
      manifestArtifacts.length !== 1 ||
      image === undefined ||
      response.recordsFile !== manifestArtifacts[0]?.path ||
      !/^sha256:[a-f0-9]{64}$/u.test(image.checksum)
    ) {
      throw new DomainError(
        "PDF renderer returned an invalid artifact set",
        "compute_protocol_error",
        502,
      );
    }
    const imageWidth = optionalPositiveInteger(
      response.metrics.width,
      1_000_000,
    );
    const imageHeight = optionalPositiveInteger(
      response.metrics.height,
      1_000_000,
    );
    const pageCount = optionalPositiveInteger(
      response.metrics.pageCount,
      1_000_000,
    );
    if (
      imageWidth === null ||
      imageWidth === 0 ||
      imageHeight === null ||
      imageHeight === 0 ||
      pageCount === null ||
      pageCount === 0 ||
      pageNumber > pageCount
    ) {
      throw new DomainError(
        "PDF renderer returned invalid page metrics",
        "compute_protocol_error",
        502,
      );
    }
    const imagePath = assertPathWithin(
      path.resolve(outputDirectory, image.path),
      outputDirectory,
    );
    return {
      outputDirectory,
      imagePath,
      imageSize: image.size,
      imageSha256: image.checksum.slice("sha256:".length),
      imageWidth,
      imageHeight,
      pageCount,
    };
  }

  private store(tenant: TenantContext, projectId: string) {
    return this.stores.get(this.projectRoot(tenant, projectId));
  }

  private projectRoot(
    tenant: TenantContext,
    projectId: string,
  ): string {
    this.repositories.projects.getForTenant(
      tenant.dataNamespace,
      projectId,
    );
    return assertPathWithin(
      path.join(tenant.projectsRoot, projectId),
      tenant.root,
    );
  }
}

function normalizeUploadMimeType(
  extension: string,
  value: string | null,
): string {
  const expected = DEFAULT_UPLOAD_MIME_TYPES.get(extension);
  if (expected === undefined) {
    throw new DomainError(
      "Unsupported document type",
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
    COMPATIBLE_UPLOAD_MIME_TYPES.get(extension) ??
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

function normalizeUploadFilename(value: string): string {
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

function documentTitle(filename: string): string {
  const extension = path.extname(filename);
  const stem = filename.slice(0, Math.max(0, filename.length - extension.length));
  return (stem.trim() || filename).slice(0, 500);
}

async function writeUpload(
  filename: string,
  contents: AsyncIterable<Uint8Array | string>,
  maximumBytes: number,
): Promise<{ sha256: string; size: number }> {
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
        const result = await handle.write(
          chunk,
          offset,
          chunk.byteLength - offset,
          null,
        );
        if (result.bytesWritten === 0) {
          throw new Error("Upload writer made no progress");
        }
        offset += result.bytesWritten;
      }
    }
    if (size === 0) {
      throw new DomainError(
        "Uploaded file is empty",
        "empty_upload",
        400,
      );
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
