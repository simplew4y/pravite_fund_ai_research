import { createHash } from "node:crypto";

import type {
  EvidenceKind,
  EvidenceLocator,
  PutEvidenceInput,
  ResearchStore,
} from "@private-fund/research-store";

import {
  ComputeProjectionError,
  type DocumentProjectionOperation,
  type GenericDocumentFormat,
  type ProjectionJob,
} from "./types.js";

type JsonObject = Record<string, unknown>;

export interface ProjectionRecordState {
  readonly operation: DocumentProjectionOperation;
  readonly sourceName: string;
  readonly documentVersionId: string;
  readonly job: ProjectionJob;
  readonly store: ResearchStore;
  readonly expectedPageCount?: number;
  readonly expectedSheetCount?: number;
  readonly expectedCellCount?: number;
  recordCount: number;
  evidenceCount: number;
  pdfTextPageCount: number;
  workbookSeen: boolean;
  currentSheet: string | null;
  currentSheetBounds: {
    readonly maxRow: number;
    readonly maxColumn: number;
  } | null;
  readonly worksheetBounds: Map<
    string,
    {
      readonly maxRow: number;
      readonly maxColumn: number;
      nonEmptyCellCount: number;
      formulaCount: number;
    }
  >;
  readonly pageNumbers: Set<number>;
  readonly declaredSheets: Set<string>;
  readonly worksheetNames: Set<string>;
  readonly cellKeys: Set<string>;
  readonly generic: GenericProjectionRecordState | null;
}

export interface GenericProjectionRecordState {
  readonly expectedFormat: GenericDocumentFormat;
  readonly expectedTextRecordCount: number;
  readonly expectedTextChars: number;
  readonly expectedRecordTypeCounts: Readonly<Record<string, number>>;
  headerSeen: boolean;
  textRecordCount: number;
  textChars: number;
  nonWhitespaceTextCount: number;
  readonly recordTypeCounts: Map<string, number>;
  readonly evidenceKeys: Set<string>;
  paragraphCount: number;
  tableCount: number;
  tableCellCount: number;
  currentTable: {
    readonly tableNumber: number;
    readonly rowCount: number;
    lastRow: number;
    lastColumn: number;
  } | null;
  slideCount: number;
  slideTextCount: number;
  currentSlide: {
    readonly slideNumber: number;
    readonly textBlockCount: number;
    textCount: number;
  } | null;
  csvRowCount: number;
  csvCellCount: number;
  currentCsvRow: {
    readonly rowNumber: number;
    readonly cellCount: number;
    readonly lineStart: number;
    readonly lineEnd: number;
    cellNumber: number;
  } | null;
  headingCount: number;
  blockCount: number;
  lineCount: number;
  lastLineEnd: number;
}

function invalid(message: string): never {
  throw new ComputeProjectionError(
    message,
    "projection_record_invalid",
    false,
  );
}

function record(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function exactKeys(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!(key in value)) {
      invalid(`Compute record is missing ${key}`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalid(`Compute record contains unsupported field ${key}`);
    }
  }
}

function text(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum
  ) {
    return invalid(
      `${label} must be ${allowEmpty ? "a" : "a non-empty"} bounded string`,
    );
  }
  return value;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return invalid(`${label} must be an integer in the supported range`);
  }
  return value;
}

function finitePositive(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return invalid(`${label} must be a positive finite number`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    return invalid(`${label} must be a boolean`);
  }
  return value;
}

function nullableText(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  if (value === null) {
    return null;
  }
  return text(value, label, maximum, true);
}

function finiteBbox(value: unknown, label: string): [
  number,
  number,
  number,
  number,
] {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every(
      (coordinate) =>
        typeof coordinate === "number" && Number.isFinite(coordinate),
    )
  ) {
    return invalid(`${label} must contain four finite coordinates`);
  }
  return value as [number, number, number, number];
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function ensureSourceName(value: unknown, expected: string): void {
  if (text(value, "sourceName", 1_000) !== expected) {
    invalid("Compute record sourceName does not match inputPath");
  }
}

function putEvidence(
  state: ProjectionRecordState,
  input: PutEvidenceInput,
): void {
  state.store.evidence.put(input);
  state.evidenceCount += 1;
}

function parsePdfBlock(value: unknown): {
  readonly blockNumber: number;
  readonly blockType: number;
  readonly bbox: [number, number, number, number];
  readonly text: string;
} {
  const block = record(value, "PDF block");
  exactKeys(block, ["blockNumber", "blockType", "bbox", "text"]);
  return {
    blockNumber: integer(block.blockNumber, "blockNumber", 0),
    blockType: integer(block.blockType, "blockType", 0),
    bbox: finiteBbox(block.bbox, "block bbox"),
    text: text(block.text, "block text", 5_000_000, true),
  };
}

function projectPdfRecord(
  value: JsonObject,
  state: ProjectionRecordState,
): void {
  exactKeys(
    value,
    [
      "recordType",
      "sourceName",
      "pageNumber",
      "width",
      "height",
      "rotation",
      "text",
    ],
    ["blocks"],
  );
  if (value.recordType !== "pdf_page") {
    invalid("PDF extraction may only contain pdf_page records");
  }
  ensureSourceName(value.sourceName, state.sourceName);
  const pageNumber = integer(
    value.pageNumber,
    "pageNumber",
    1,
    10_000_000,
  );
  if (state.pageNumbers.has(pageNumber)) {
    invalid(`PDF extraction contains duplicate page ${String(pageNumber)}`);
  }
  if (
    state.expectedPageCount !== undefined &&
    pageNumber > state.expectedPageCount
  ) {
    invalid("PDF pageNumber exceeds metrics.pageCount");
  }
  state.pageNumbers.add(pageNumber);
  const width = finitePositive(value.width, "page width");
  const height = finitePositive(value.height, "page height");
  const rotation = integer(value.rotation, "rotation", 0, 359);
  if (![0, 90, 180, 270].includes(rotation)) {
    invalid("PDF rotation must be a right-angle rotation");
  }
  const originalText = text(
    value.text,
    "PDF page text",
    5_000_000,
    true,
  );
  const blocks =
    value.blocks === undefined
      ? undefined
      : Array.isArray(value.blocks)
        ? value.blocks.map(parsePdfBlock)
        : invalid("PDF blocks must be an array");
  if (
    blocks !== undefined &&
    new Set(blocks.map((block) => block.blockNumber)).size !==
      blocks.length
  ) {
    invalid("PDF blocks must have unique blockNumber values");
  }
  if (originalText.trim().length > 0) {
    state.pdfTextPageCount += 1;
  }
  putEvidence(state, {
    evidenceId: `page:${state.documentVersionId}.${String(pageNumber)}`,
    kind: "page",
    documentVersionId: state.documentVersionId,
    title: `${state.sourceName} · Page ${String(pageNumber)}`,
    originalText,
    locator: {
      sourceRef: state.sourceName,
      displayText: `${state.sourceName} · Page ${String(pageNumber)}`,
      pageStart: pageNumber,
      pageEnd: pageNumber,
      pageNumbers: [pageNumber],
      bbox: [0, 0, width, height],
    },
    metadata: {
      projectionVersion: 1,
      recordType: "pdf_page",
      width,
      height,
      rotation,
      ...(blocks === undefined ? {} : { blocks }),
    },
  });
}

type WorkbookValue =
  | null
  | string
  | boolean
  | number
  | {
      readonly encoding: "base64";
      readonly data: string;
    };

function workbookValue(value: unknown, label: string): WorkbookValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  ) {
    return value;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const object = value as JsonObject;
    exactKeys(object, ["encoding", "data"]);
    if (
      object.encoding === "base64" &&
      typeof object.data === "string" &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(object.data)
    ) {
      return { encoding: "base64", data: object.data };
    }
  }
  return invalid(`${label} is not a lossless supported workbook value`);
}

function displayWorkbookValue(value: WorkbookValue): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return `[base64:${value.data}]`;
}

function clipped(value: string, maximum: number): {
  readonly value: string;
  readonly truncated: boolean;
} {
  if (value.length <= maximum) {
    return { value, truncated: false };
  }
  return {
    value: value.slice(0, maximum),
    truncated: true,
  };
}

function excelColumnNumber(coordinate: string): number {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(coordinate);
  if (match === null) {
    return invalid("Workbook coordinate is not a valid A1 cell");
  }
  let column = 0;
  for (const character of match[1]!) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }
  if (column > 16_384 || Number(match[2]) > 1_048_576) {
    return invalid("Workbook coordinate exceeds Excel worksheet limits");
  }
  return column;
}

function projectWorkbookHeader(
  value: JsonObject,
  state: ProjectionRecordState,
): void {
  exactKeys(value, [
    "recordType",
    "sourceName",
    "sheetNames",
    "keepVba",
  ]);
  if (state.recordCount !== 1 || state.workbookSeen) {
    invalid("Workbook header must be the first and only workbook record");
  }
  if (value.recordType !== "workbook") {
    invalid("Workbook extraction must begin with a workbook record");
  }
  ensureSourceName(value.sourceName, state.sourceName);
  if (
    !Array.isArray(value.sheetNames) ||
    value.sheetNames.length === 0
  ) {
    invalid("Workbook sheetNames must be a non-empty array");
  }
  for (const item of value.sheetNames) {
    const sheet = text(item, "sheet name", 500);
    if (state.declaredSheets.has(sheet)) {
      invalid(`Workbook declares duplicate sheet ${sheet}`);
    }
    state.declaredSheets.add(sheet);
  }
  boolean(value.keepVba, "keepVba");
  state.workbookSeen = true;
}

function projectWorksheetRecord(
  value: JsonObject,
  state: ProjectionRecordState,
): void {
  exactKeys(value, [
    "recordType",
    "sheet",
    "maxRow",
    "maxColumn",
  ]);
  if (!state.workbookSeen) {
    invalid("Worksheet record precedes workbook header");
  }
  const sheet = text(value.sheet, "worksheet sheet", 500);
  if (!state.declaredSheets.has(sheet)) {
    invalid(`Worksheet ${sheet} was not declared by workbook header`);
  }
  if (state.worksheetNames.has(sheet)) {
    invalid(`Workbook contains duplicate worksheet record ${sheet}`);
  }
  const maxRow = integer(
    value.maxRow,
    "worksheet maxRow",
    0,
    1_048_576,
  );
  const maxColumn = integer(
    value.maxColumn,
    "worksheet maxColumn",
    0,
    16_384,
  );
  state.worksheetNames.add(sheet);
  state.currentSheet = sheet;
  state.currentSheetBounds = { maxRow, maxColumn };
  state.worksheetBounds.set(sheet, {
    maxRow,
    maxColumn,
    nonEmptyCellCount: 0,
    formulaCount: 0,
  });
}

function projectCellRecord(
  value: JsonObject,
  state: ProjectionRecordState,
): void {
  exactKeys(value, [
    "recordType",
    "sheet",
    "coordinate",
    "row",
    "column",
    "value",
    "formula",
    "cachedValue",
    "dataType",
    "numberFormat",
  ]);
  if (!state.workbookSeen || state.currentSheet === null) {
    invalid("Cell record precedes its worksheet record");
  }
  const sheet = text(value.sheet, "cell sheet", 500);
  if (sheet !== state.currentSheet) {
    invalid("Cell record is not grouped under its worksheet");
  }
  const coordinate = text(value.coordinate, "cell coordinate", 100);
  const coordinateColumn = excelColumnNumber(coordinate);
  const coordinateRow = Number(
    /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(coordinate)![2],
  );
  const row = integer(value.row, "cell row", 1, 1_048_576);
  const column = integer(value.column, "cell column", 1, 16_384);
  if (row !== coordinateRow || column !== coordinateColumn) {
    invalid("Cell row/column do not match coordinate");
  }
  if (
    state.currentSheetBounds === null ||
    row > state.currentSheetBounds.maxRow ||
    column > state.currentSheetBounds.maxColumn
  ) {
    invalid("Cell lies outside its worksheet declared bounds");
  }
  const cellKey = `${sheet}\0${coordinate}`;
  if (state.cellKeys.has(cellKey)) {
    invalid(`Workbook contains duplicate cell ${sheet}!${coordinate}`);
  }
  state.cellKeys.add(cellKey);
  const rawValue = workbookValue(value.value, "cell value");
  const formula = nullableText(value.formula, "cell formula", 20_000);
  const cachedValue = workbookValue(value.cachedValue, "cached cell value");
  const dataType = text(value.dataType, "cell dataType", 100, true);
  const numberFormat = text(
    value.numberFormat,
    "cell numberFormat",
    2_000,
    true,
  );
  const rawText = displayWorkbookValue(rawValue);
  const displayed =
    formula !== null && cachedValue !== null
      ? displayWorkbookValue(cachedValue)
      : rawText;
  const clippedDisplay = clipped(displayed, 20_000);
  const clippedRaw = clipped(rawText, 100_000);
  const clippedCached =
    cachedValue === null
      ? null
      : clipped(displayWorkbookValue(cachedValue), 100_000);
  const numericValue =
    typeof cachedValue === "number"
      ? cachedValue
      : typeof rawValue === "number"
        ? rawValue
        : null;
  const sheetBounds = state.worksheetBounds.get(sheet);
  if (sheetBounds === undefined) {
    invalid("Cell record has no canonical worksheet bounds");
  }
  sheetBounds.nonEmptyCellCount += 1;
  if (formula !== null) {
    sheetBounds.formulaCount += 1;
  }
  const stableId = stableHash(
    `${state.documentVersionId}\0${sheet}\0${coordinate}`,
  ).slice(0, 48);
  putEvidence(state, {
    evidenceId: `cell:${stableId}`,
    kind: "cell",
    documentVersionId: state.documentVersionId,
    title: `${sheet}!${coordinate}`,
    originalText: `${sheet}!${coordinate}: ${displayed}`,
    locator: {
      sourceRef: state.sourceName,
      displayText: `${state.sourceName} · ${sheet}!${coordinate}`,
      sheetName: sheet,
      cellRange: coordinate,
      cellRef: coordinate,
      ...(formula === null ? {} : { formula }),
      displayValue: clippedDisplay.value,
      rawValue: clippedRaw.value,
    },
    metadata: {
      projectionVersion: 1,
      recordType: "cell",
      row,
      column,
      dataType,
      numberFormat,
      numericValue,
      cachedValue: clippedCached?.value ?? null,
      cachedValueTruncated: clippedCached?.truncated ?? false,
      displayValueTruncated: clippedDisplay.truncated,
      rawValueTruncated: clippedRaw.truncated,
    },
  });
}

function projectWorkbookRecord(
  value: JsonObject,
  state: ProjectionRecordState,
): void {
  switch (value.recordType) {
    case "workbook":
      projectWorkbookHeader(value, state);
      break;
    case "worksheet":
      projectWorksheetRecord(value, state);
      break;
    case "cell":
      projectCellRecord(value, state);
      break;
    default:
      invalid("Workbook extraction contains an unsupported recordType");
  }
}

function requireGenericState(
  state: ProjectionRecordState,
): GenericProjectionRecordState {
  if (state.generic === null) {
    return invalid("Generic document projection state is missing");
  }
  return state.generic;
}

function unicodeLength(value: string): number {
  let count = 0;
  for (const _character of value) {
    count += 1;
  }
  return count;
}

function genericEvidence(
  state: ProjectionRecordState,
  kind: EvidenceKind,
  semanticKey: string,
  input: Omit<
    PutEvidenceInput,
    "evidenceId" | "kind" | "documentVersionId"
  >,
): void {
  const generic = requireGenericState(state);
  const stableId = stableHash(
    `${state.documentVersionId}\0${generic.expectedFormat}\0${semanticKey}`,
  ).slice(0, 48);
  const evidenceId = `${kind}:${stableId}`;
  if (generic.evidenceKeys.has(evidenceId)) {
    invalid(`Generic extraction contains duplicate locator ${semanticKey}`);
  }
  generic.evidenceKeys.add(evidenceId);
  putEvidence(state, {
    evidenceId,
    kind,
    documentVersionId: state.documentVersionId,
    ...input,
  });
}

function sourceLocator(
  state: ProjectionRecordState,
  displayText: string,
  additional: EvidenceLocator = {},
): EvidenceLocator {
  return {
    sourceRef: state.sourceName,
    displayText: clipped(displayText, 2_000).value,
    ...additional,
  };
}

function lineRange(
  locator: JsonObject,
  label: string,
): {
  readonly lineStart: number;
  readonly lineEnd: number;
} {
  const lineStart = integer(
    locator.lineStart,
    `${label} lineStart`,
    1,
  );
  const lineEnd = integer(
    locator.lineEnd,
    `${label} lineEnd`,
    lineStart,
  );
  return { lineStart, lineEnd };
}

function recordGenericText(
  generic: GenericProjectionRecordState,
  value: string,
): void {
  generic.textRecordCount += 1;
  generic.textChars += unicodeLength(value);
  if (!Number.isSafeInteger(generic.textChars)) {
    invalid("Generic extraction text character count is unsafe");
  }
  if (value.trim().length > 0) {
    generic.nonWhitespaceTextCount += 1;
  }
}

function projectGenericHeader(
  value: JsonObject,
  state: ProjectionRecordState,
): void {
  const generic = requireGenericState(state);
  exactKeys(value, ["recordType", "format", "sourceName"]);
  if (state.recordCount !== 1 || generic.headerSeen) {
    invalid("Generic document header must be the first and only header");
  }
  if (value.recordType !== "document") {
    invalid("Generic extraction must begin with a document record");
  }
  if (value.format !== generic.expectedFormat) {
    invalid("Generic document header format does not match compute metrics");
  }
  ensureSourceName(value.sourceName, state.sourceName);
  generic.headerSeen = true;
}

function finishDocxTable(generic: GenericProjectionRecordState): void {
  generic.currentTable = null;
}

function projectDocxTable(
  value: JsonObject,
  state: ProjectionRecordState,
): void {
  const generic = requireGenericState(state);
  exactKeys(value, ["recordType", "rowCount", "locator"]);
  const locator = record(value.locator, "DOCX table locator");
  exactKeys(locator, ["kind", "tableNumber"]);
  if (locator.kind !== "docx_table") {
    invalid("DOCX table locator kind is invalid");
  }
  finishDocxTable(generic);
  const tableNumber = integer(
    locator.tableNumber,
    "DOCX tableNumber",
    1,
  );
  if (tableNumber !== generic.tableCount + 1) {
    invalid("DOCX table numbers must be contiguous");
  }
  const rowCount = integer(value.rowCount, "DOCX rowCount", 0);
  generic.tableCount = tableNumber;
  generic.currentTable = {
    tableNumber,
    rowCount,
    lastRow: 0,
    lastColumn: 0,
  };
  genericEvidence(state, "chunk", `docx_table:${String(tableNumber)}`, {
    title: `Table ${String(tableNumber)}`,
    originalText: "",
    locator: sourceLocator(
      state,
      `${state.sourceName} · Table ${String(tableNumber)}`,
      { headingPath: `Table ${String(tableNumber)}` },
    ),
    metadata: {
      projectionVersion: 1,
      recordType: "table",
      format: "docx",
      sourceRecordLocator: {
        kind: "docx_table",
        tableNumber,
      },
      rowCount,
    },
  });
}

function projectDocxText(
  value: JsonObject,
  state: ProjectionRecordState,
): void {
  const generic = requireGenericState(state);
  exactKeys(
    value,
    ["recordType", "text", "locator"],
    ["paragraphStyle"],
  );
  const originalText = text(
    value.text,
    "DOCX text",
    5_000_000,
    true,
  );
  const locator = record(value.locator, "DOCX text locator");
  const locatorKind = text(locator.kind, "DOCX locator kind", 100);
  recordGenericText(generic, originalText);

  if (locatorKind === "docx_paragraph") {
    finishDocxTable(generic);
    exactKeys(locator, ["kind", "paragraphNumber"]);
    const paragraphNumber = integer(
      locator.paragraphNumber,
      "DOCX paragraphNumber",
      1,
    );
    if (paragraphNumber !== generic.paragraphCount + 1) {
      invalid("DOCX paragraph numbers must be contiguous");
    }
    generic.paragraphCount = paragraphNumber;
    const paragraphStyle =
      value.paragraphStyle === undefined
        ? null
        : text(
            value.paragraphStyle,
            "DOCX paragraphStyle",
            2_000,
          );
    genericEvidence(
      state,
      "chunk",
      `docx_paragraph:${String(paragraphNumber)}`,
      {
        title: `Paragraph ${String(paragraphNumber)}`,
        originalText,
        locator: sourceLocator(
          state,
          `${state.sourceName} · Paragraph ${String(paragraphNumber)}`,
          { headingPath: `Paragraph ${String(paragraphNumber)}` },
        ),
        metadata: {
          projectionVersion: 1,
          recordType: "text",
          format: "docx",
          sourceRecordLocator: {
            kind: "docx_paragraph",
            paragraphNumber,
          },
          ...(paragraphStyle === null ? {} : { paragraphStyle }),
        },
      },
    );
    return;
  }

  if (locatorKind !== "docx_table_cell") {
    invalid("DOCX text locator kind is unsupported");
  }
  exactKeys(locator, [
    "kind",
    "tableNumber",
    "rowNumber",
    "columnNumber",
    "columnSpan",
  ]);
  if (value.paragraphStyle !== undefined) {
    invalid("DOCX table cells may not contain paragraphStyle");
  }
  const tableNumber = integer(
    locator.tableNumber,
    "DOCX table cell tableNumber",
    1,
  );
  const currentTable = generic.currentTable;
  if (
    currentTable === null ||
    tableNumber !== currentTable.tableNumber
  ) {
    invalid("DOCX table cell is not grouped under its table");
  }
  const rowNumber = integer(
    locator.rowNumber,
    "DOCX table cell rowNumber",
    1,
  );
  const columnNumber = integer(
    locator.columnNumber,
    "DOCX table cell columnNumber",
    1,
  );
  const columnSpan = integer(
    locator.columnSpan,
    "DOCX table cell columnSpan",
    1,
  );
  if (rowNumber > currentTable.rowCount) {
    invalid("DOCX table cell row exceeds table rowCount");
  }
  if (
    rowNumber < currentTable.lastRow ||
    (rowNumber === currentTable.lastRow &&
      columnNumber !== currentTable.lastColumn + 1) ||
    (rowNumber > currentTable.lastRow && columnNumber !== 1)
  ) {
    invalid("DOCX table cells must be in row-major contiguous order");
  }
  currentTable.lastRow = rowNumber;
  currentTable.lastColumn = columnNumber;
  generic.tableCellCount += 1;
  const cellRef = `${excelColumnName(columnNumber)}${String(rowNumber)}`;
  const clippedDisplay = clipped(originalText, 20_000);
  const clippedRaw = clipped(originalText, 100_000);
  genericEvidence(
    state,
    "cell",
    `docx_table_cell:${String(tableNumber)}:${String(rowNumber)}:${String(columnNumber)}`,
    {
      title: `Table ${String(tableNumber)} · ${cellRef}`,
      originalText,
      locator: sourceLocator(
        state,
        `${state.sourceName} · Table ${String(tableNumber)} · ${cellRef}`,
        {
          sheetName: `Table ${String(tableNumber)}`,
          cellRange: cellRef,
          cellRef,
          displayValue: clippedDisplay.value,
          rawValue: clippedRaw.value,
        },
      ),
      metadata: {
        projectionVersion: 1,
        recordType: "text",
        format: "docx",
        sourceRecordLocator: {
          kind: "docx_table_cell",
          tableNumber,
          rowNumber,
          columnNumber,
          columnSpan,
        },
        displayValueTruncated: clippedDisplay.truncated,
        rawValueTruncated: clippedRaw.truncated,
      },
    },
  );
}

function finishPptxSlide(generic: GenericProjectionRecordState): void {
  if (
    generic.currentSlide !== null &&
    generic.currentSlide.textCount !==
      generic.currentSlide.textBlockCount
  ) {
    invalid("PPTX slide text records do not match textBlockCount");
  }
  generic.currentSlide = null;
}

function projectPptxSlide(
  value: JsonObject,
  state: ProjectionRecordState,
): void {
  const generic = requireGenericState(state);
  exactKeys(value, ["recordType", "textBlockCount", "locator"]);
  const locator = record(value.locator, "PPTX slide locator");
  exactKeys(locator, ["kind", "slideNumber", "part"]);
  if (locator.kind !== "pptx_slide") {
    invalid("PPTX slide locator kind is invalid");
  }
  finishPptxSlide(generic);
  const slideNumber = integer(
    locator.slideNumber,
    "PPTX slideNumber",
    1,
  );
  if (slideNumber !== generic.slideCount + 1) {
    invalid("PPTX slide numbers must be contiguous");
  }
  const textBlockCount = integer(
    value.textBlockCount,
    "PPTX textBlockCount",
    0,
  );
  const part = text(locator.part, "PPTX slide part", 4_000);
  if (
    !part.startsWith("ppt/slides/") ||
    part.includes("\\") ||
    part.includes("\0") ||
    part.split("/").some((component) => component === "..")
  ) {
    invalid("PPTX slide part is not a safe package path");
  }
  generic.slideCount = slideNumber;
  generic.currentSlide = {
    slideNumber,
    textBlockCount,
    textCount: 0,
  };
  genericEvidence(state, "page", `pptx_slide:${String(slideNumber)}`, {
    title: `Slide ${String(slideNumber)}`,
    originalText: "",
    locator: sourceLocator(
      state,
      `${state.sourceName} · Slide ${String(slideNumber)}`,
      {
        slideStart: slideNumber,
        slideEnd: slideNumber,
      },
    ),
    metadata: {
      projectionVersion: 1,
      recordType: "slide",
      format: "pptx",
      sourceRecordLocator: {
        kind: "pptx_slide",
        slideNumber,
        part,
      },
      textBlockCount,
    },
  });
}

function projectPptxText(
  value: JsonObject,
  state: ProjectionRecordState,
): void {
  const generic = requireGenericState(state);
  exactKeys(value, ["recordType", "text", "locator"]);
  const originalText = text(
    value.text,
    "PPTX slide text",
    5_000_000,
    true,
  );
  const locator = record(value.locator, "PPTX text locator");
  exactKeys(locator, ["kind", "slideNumber", "textNumber"]);
  if (locator.kind !== "pptx_slide_text") {
    invalid("PPTX text locator kind is invalid");
  }
  const slideNumber = integer(
    locator.slideNumber,
    "PPTX text slideNumber",
    1,
  );
  const textNumber = integer(
    locator.textNumber,
    "PPTX textNumber",
    1,
  );
  const currentSlide = generic.currentSlide;
  if (
    currentSlide === null ||
    currentSlide.slideNumber !== slideNumber ||
    textNumber !== currentSlide.textCount + 1 ||
    textNumber > currentSlide.textBlockCount
  ) {
    invalid("PPTX text is not contiguous within its slide");
  }
  currentSlide.textCount = textNumber;
  generic.slideTextCount += 1;
  recordGenericText(generic, originalText);
  genericEvidence(
    state,
    "chunk",
    `pptx_slide_text:${String(slideNumber)}:${String(textNumber)}`,
    {
      title: `Slide ${String(slideNumber)} · Text ${String(textNumber)}`,
      originalText,
      locator: sourceLocator(
        state,
        `${state.sourceName} · Slide ${String(slideNumber)} · Text ${String(textNumber)}`,
        {
          slideStart: slideNumber,
          slideEnd: slideNumber,
          headingPath: `Slide ${String(slideNumber)}`,
        },
      ),
      metadata: {
        projectionVersion: 1,
        recordType: "text",
        format: "pptx",
        sourceRecordLocator: {
          kind: "pptx_slide_text",
          slideNumber,
          textNumber,
        },
      },
    },
  );
}

function finishCsvRow(generic: GenericProjectionRecordState): void {
  if (
    generic.currentCsvRow !== null &&
    generic.currentCsvRow.cellNumber !== generic.currentCsvRow.cellCount
  ) {
    invalid("CSV cell records do not match row cellCount");
  }
  generic.currentCsvRow = null;
}

function excelColumnName(column: number): string {
  let remaining = column;
  let name = "";
  while (remaining > 0) {
    remaining -= 1;
    name = String.fromCharCode(65 + (remaining % 26)) + name;
    remaining = Math.floor(remaining / 26);
  }
  return name;
}

function projectCsvRow(
  value: JsonObject,
  state: ProjectionRecordState,
): void {
  const generic = requireGenericState(state);
  exactKeys(value, ["recordType", "cellCount", "locator"]);
  const locator = record(value.locator, "CSV row locator");
  exactKeys(locator, [
    "kind",
    "rowNumber",
    "lineStart",
    "lineEnd",
  ]);
  if (locator.kind !== "csv_row") {
    invalid("CSV row locator kind is invalid");
  }
  finishCsvRow(generic);
  const rowNumber = integer(locator.rowNumber, "CSV rowNumber", 1);
  if (rowNumber !== generic.csvRowCount + 1) {
    invalid("CSV row numbers must be contiguous");
  }
  const cellCount = integer(
    value.cellCount,
    "CSV cellCount",
    0,
    250_000,
  );
  const range = lineRange(locator, "CSV row");
  if (range.lineStart <= generic.lastLineEnd) {
    invalid("CSV row source line ranges must be ordered");
  }
  generic.lastLineEnd = range.lineEnd;
  generic.csvRowCount = rowNumber;
  generic.currentCsvRow = {
    rowNumber,
    cellCount,
    ...range,
    cellNumber: 0,
  };
  genericEvidence(state, "chunk", `csv_row:${String(rowNumber)}`, {
    title: `CSV row ${String(rowNumber)}`,
    originalText: "",
    locator: sourceLocator(
      state,
      `${state.sourceName} · Row ${String(rowNumber)}`,
      {
        sheetName: "CSV",
        cellRange: `${String(rowNumber)}:${String(rowNumber)}`,
      },
    ),
    metadata: {
      projectionVersion: 1,
      recordType: "row",
      format: "csv",
      sourceRecordLocator: {
        kind: "csv_row",
        rowNumber,
        ...range,
      },
      cellCount,
    },
  });
}

function projectCsvCell(
  value: JsonObject,
  state: ProjectionRecordState,
): void {
  const generic = requireGenericState(state);
  exactKeys(value, ["recordType", "text", "locator"]);
  const originalText = text(
    value.text,
    "CSV cell text",
    5_000_000,
    true,
  );
  const locator = record(value.locator, "CSV cell locator");
  exactKeys(locator, [
    "kind",
    "rowNumber",
    "columnNumber",
    "lineStart",
    "lineEnd",
  ]);
  if (locator.kind !== "csv_cell") {
    invalid("CSV cell locator kind is invalid");
  }
  const rowNumber = integer(locator.rowNumber, "CSV cell rowNumber", 1);
  const columnNumber = integer(
    locator.columnNumber,
    "CSV cell columnNumber",
    1,
    250_000,
  );
  const range = lineRange(locator, "CSV cell");
  const currentRow = generic.currentCsvRow;
  if (
    currentRow === null ||
    rowNumber !== currentRow.rowNumber ||
    columnNumber !== currentRow.cellNumber + 1 ||
    columnNumber > currentRow.cellCount ||
    range.lineStart !== currentRow.lineStart ||
    range.lineEnd !== currentRow.lineEnd
  ) {
    invalid("CSV cell is not contiguous within its row");
  }
  currentRow.cellNumber = columnNumber;
  generic.csvCellCount += 1;
  recordGenericText(generic, originalText);
  const cellRef = `${excelColumnName(columnNumber)}${String(rowNumber)}`;
  const clippedDisplay = clipped(originalText, 20_000);
  const clippedRaw = clipped(originalText, 100_000);
  genericEvidence(
    state,
    "cell",
    `csv_cell:${String(rowNumber)}:${String(columnNumber)}`,
    {
      title: `CSV ${cellRef}`,
      originalText,
      locator: sourceLocator(
        state,
        `${state.sourceName} · ${cellRef}`,
        {
          sheetName: "CSV",
          cellRange: cellRef,
          cellRef,
          displayValue: clippedDisplay.value,
          rawValue: clippedRaw.value,
        },
      ),
      metadata: {
        projectionVersion: 1,
        recordType: "text",
        format: "csv",
        sourceRecordLocator: {
          kind: "csv_cell",
          rowNumber,
          columnNumber,
          ...range,
        },
        displayValueTruncated: clippedDisplay.truncated,
        rawValueTruncated: clippedRaw.truncated,
      },
    },
  );
}

function stringArray(
  value: unknown,
  label: string,
  maximumItems: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    return invalid(`${label} must be a bounded string array`);
  }
  return value.map((item) => text(item, label, 2_000, true));
}

function projectMarkdownText(
  value: JsonObject,
  state: ProjectionRecordState,
): void {
  const generic = requireGenericState(state);
  exactKeys(value, [
    "recordType",
    "text",
    "locator",
    "headingPath",
  ]);
  const originalText = text(
    value.text,
    "Markdown text",
    5_000_000,
    true,
  );
  const headingPath = stringArray(
    value.headingPath,
    "Markdown headingPath",
    32,
  );
  const locator = record(value.locator, "Markdown text locator");
  const locatorKind = text(
    locator.kind,
    "Markdown locator kind",
    100,
  );
  let semanticKey: string;
  let title: string;
  let rawLocator: Record<string, unknown>;
  if (locatorKind === "text_heading") {
    exactKeys(locator, [
      "kind",
      "headingNumber",
      "level",
      "lineStart",
      "lineEnd",
    ]);
    const headingNumber = integer(
      locator.headingNumber,
      "Markdown headingNumber",
      1,
    );
    if (headingNumber !== generic.headingCount + 1) {
      invalid("Markdown heading numbers must be contiguous");
    }
    generic.headingCount = headingNumber;
    const level = integer(locator.level, "Markdown heading level", 1, 6);
    const range = lineRange(locator, "Markdown heading");
    if (range.lineStart <= generic.lastLineEnd) {
      invalid("Markdown record source line ranges must be ordered");
    }
    generic.lastLineEnd = range.lineEnd;
    semanticKey = `markdown_heading:${String(headingNumber)}`;
    title = originalText || `Heading ${String(headingNumber)}`;
    rawLocator = {
      kind: "text_heading",
      headingNumber,
      level,
      ...range,
    };
  } else if (locatorKind === "text_block") {
    exactKeys(locator, [
      "kind",
      "blockNumber",
      "lineStart",
      "lineEnd",
    ]);
    const blockNumber = integer(
      locator.blockNumber,
      "Markdown blockNumber",
      1,
    );
    if (blockNumber !== generic.blockCount + 1) {
      invalid("Markdown block numbers must be contiguous");
    }
    generic.blockCount = blockNumber;
    const range = lineRange(locator, "Markdown block");
    if (range.lineStart <= generic.lastLineEnd) {
      invalid("Markdown record source line ranges must be ordered");
    }
    generic.lastLineEnd = range.lineEnd;
    semanticKey = `markdown_block:${String(blockNumber)}`;
    title = `Block ${String(blockNumber)}`;
    rawLocator = {
      kind: "text_block",
      blockNumber,
      ...range,
    };
  } else {
    invalid("Markdown text locator kind is unsupported");
  }
  recordGenericText(generic, originalText);
  const canonicalHeading = clipped(
    headingPath.filter((part) => part.length > 0).join(" > "),
    2_000,
  ).value;
  genericEvidence(state, "chunk", semanticKey, {
    title: clipped(title, 2_000).value,
    originalText,
    locator: sourceLocator(
      state,
      `${state.sourceName} · ${title}`,
      canonicalHeading.length === 0
        ? {}
        : { headingPath: canonicalHeading },
    ),
    metadata: {
      projectionVersion: 1,
      recordType: "text",
      format: "markdown",
      sourceRecordLocator: rawLocator,
      headingPath,
    },
  });
}

function projectPlainTextLine(
  value: JsonObject,
  state: ProjectionRecordState,
): void {
  const generic = requireGenericState(state);
  exactKeys(value, ["recordType", "text", "locator"]);
  const originalText = text(
    value.text,
    "Plain text line",
    5_000_000,
    true,
  );
  const locator = record(value.locator, "Plain text line locator");
  exactKeys(locator, [
    "kind",
    "lineNumber",
    "lineStart",
    "lineEnd",
  ]);
  if (locator.kind !== "text_line") {
    invalid("Plain text locator kind is invalid");
  }
  const lineNumber = integer(
    locator.lineNumber,
    "Plain text lineNumber",
    1,
  );
  const range = lineRange(locator, "Plain text line");
  if (
    lineNumber !== generic.lineCount + 1 ||
    range.lineStart !== lineNumber ||
    range.lineEnd !== lineNumber
  ) {
    invalid("Plain text line locators must be contiguous");
  }
  generic.lineCount = lineNumber;
  generic.lastLineEnd = lineNumber;
  recordGenericText(generic, originalText);
  genericEvidence(state, "chunk", `text_line:${String(lineNumber)}`, {
    title: `Line ${String(lineNumber)}`,
    originalText,
    locator: sourceLocator(
      state,
      `${state.sourceName} · Line ${String(lineNumber)}`,
    ),
    metadata: {
      projectionVersion: 1,
      recordType: "text",
      format: "text",
      sourceRecordLocator: {
        kind: "text_line",
        lineNumber,
        ...range,
      },
    },
  });
}

function projectGenericRecord(
  value: JsonObject,
  state: ProjectionRecordState,
): void {
  const generic = requireGenericState(state);
  const recordType = text(
    value.recordType,
    "Generic recordType",
    100,
  );
  generic.recordTypeCounts.set(
    recordType,
    (generic.recordTypeCounts.get(recordType) ?? 0) + 1,
  );
  if (recordType === "document") {
    projectGenericHeader(value, state);
    return;
  }
  if (!generic.headerSeen) {
    invalid("Generic document data precedes its document header");
  }

  switch (generic.expectedFormat) {
    case "docx":
      if (recordType === "table") {
        projectDocxTable(value, state);
      } else if (recordType === "text") {
        projectDocxText(value, state);
      } else {
        invalid("DOCX extraction contains an unsupported recordType");
      }
      break;
    case "pptx":
      if (recordType === "slide") {
        projectPptxSlide(value, state);
      } else if (recordType === "text") {
        projectPptxText(value, state);
      } else {
        invalid("PPTX extraction contains an unsupported recordType");
      }
      break;
    case "csv":
      if (recordType === "row") {
        projectCsvRow(value, state);
      } else if (recordType === "text") {
        projectCsvCell(value, state);
      } else {
        invalid("CSV extraction contains an unsupported recordType");
      }
      break;
    case "markdown":
      if (recordType !== "text") {
        invalid("Markdown extraction contains an unsupported recordType");
      }
      projectMarkdownText(value, state);
      break;
    case "text":
      if (recordType !== "text") {
        invalid("Plain text extraction contains an unsupported recordType");
      }
      projectPlainTextLine(value, state);
      break;
  }
}

export function projectRecord(
  value: unknown,
  state: ProjectionRecordState,
): void {
  state.recordCount += 1;
  const object = record(value, "Compute record");
  if (state.operation === "extract_pdf") {
    projectPdfRecord(object, state);
  } else if (state.operation === "extract_workbook") {
    projectWorkbookRecord(object, state);
  } else {
    projectGenericRecord(object, state);
  }
}

export function finalizeProjectionRecords(
  state: ProjectionRecordState,
): {
  readonly status: "indexed" | "needs_ocr";
} {
  if (state.operation === "extract_pdf") {
    if (
      state.expectedPageCount === undefined ||
      state.recordCount !== state.expectedPageCount ||
      state.pageNumbers.size !== state.expectedPageCount
    ) {
      invalid("PDF records do not cover metrics.pageCount exactly");
    }
    for (
      let pageNumber = 1;
      pageNumber <= state.expectedPageCount;
      pageNumber += 1
    ) {
      if (!state.pageNumbers.has(pageNumber)) {
        invalid(`PDF records are missing page ${String(pageNumber)}`);
      }
    }
    return {
      status:
        state.expectedPageCount > 0 && state.pdfTextPageCount === 0
          ? "needs_ocr"
          : "indexed",
    };
  }

  if (state.operation === "extract_document") {
    const generic = requireGenericState(state);
    if (!generic.headerSeen) {
      invalid("Generic extraction is missing its document header");
    }
    finishDocxTable(generic);
    finishPptxSlide(generic);
    finishCsvRow(generic);
    if (
      generic.textRecordCount !== generic.expectedTextRecordCount ||
      generic.textChars !== generic.expectedTextChars
    ) {
      invalid("Generic text records do not match compute metrics");
    }
    const recordTypes = new Set([
      ...generic.recordTypeCounts.keys(),
      ...Object.keys(generic.expectedRecordTypeCounts),
    ]);
    for (const recordType of recordTypes) {
      if (
        (generic.recordTypeCounts.get(recordType) ?? 0) !==
        (generic.expectedRecordTypeCounts[recordType] ?? 0)
      ) {
        invalid("Generic record type counts do not match compute metrics");
      }
    }
    return {
      status:
        (generic.expectedFormat === "docx" ||
          generic.expectedFormat === "pptx") &&
        generic.nonWhitespaceTextCount === 0
          ? "needs_ocr"
          : "indexed",
    };
  }

  if (
    !state.workbookSeen ||
    state.expectedSheetCount === undefined ||
    state.expectedCellCount === undefined ||
    state.worksheetNames.size !== state.expectedSheetCount ||
    state.cellKeys.size !== state.expectedCellCount ||
    state.declaredSheets.size !== state.expectedSheetCount ||
    state.recordCount !==
      1 + state.expectedSheetCount + state.expectedCellCount
  ) {
    invalid("Workbook records do not match declared metrics");
  }
  for (const sheet of state.declaredSheets) {
    if (!state.worksheetNames.has(sheet)) {
      invalid(`Workbook records are missing worksheet ${sheet}`);
    }
  }
  return { status: "indexed" };
}
