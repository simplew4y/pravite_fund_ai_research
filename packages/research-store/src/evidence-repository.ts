import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { Clock } from "@private-fund/core";
import {
  ConflictError,
  NotFoundError,
  isoNow,
  systemClock,
} from "@private-fund/core";

import { ProjectDatabase } from "./database.js";
import {
  mapDocument,
  mapVersion,
  pageValues,
} from "./documents-repository.js";
import {
  decodeArray,
  decodeObject,
  encodeJson,
} from "./json.js";
import type { SqlRow } from "./rows.js";
import {
  nullableNumber,
  nullableString,
  numberValue,
  objectValue,
  stringValue,
} from "./rows.js";
import { withProjectTransaction } from "./transaction.js";
import type {
  DocumentTextPreviewContent,
  EvidenceKind,
  EvidenceLocator,
  EvidenceRecord,
  EvidenceSearchHit,
  EvidenceSearchOptions,
  EvidenceTrace,
  ExcelEvidenceCell,
  ExcelEvidenceSheetStats,
  Page,
  PageOptions,
  PutEvidenceInput,
  PutEvidenceResult,
  SearchBackend,
} from "./types.js";

const EVIDENCE_COLUMNS = `
  evidence_id AS evidenceId,
  kind,
  document_version_id AS documentVersionId,
  title,
  summary,
  original_text AS originalText,
  content_hash AS contentHash,
  source_locator_json AS sourceLocatorJson,
  page_start AS pageStart,
  page_end AS pageEnd,
  page_numbers_json AS pageNumbersJson,
  bbox_json AS bboxJson,
  slide_start AS slideStart,
  slide_end AS slideEnd,
  sheet_name AS sheetName,
  cell_range AS cellRange,
  cell_ref AS cellRef,
  heading_path AS headingPath,
  formula,
  display_value AS displayValue,
  raw_value AS rawValue,
  metadata_json AS metadataJson,
  created_at AS createdAt
`;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mapBbox(value: string | null): [
  number,
  number,
  number,
  number,
] | null {
  if (value === null) {
    return null;
  }
  const decoded = decodeArray(value);
  if (
    decoded.length !== 4 ||
    !decoded.every(
      (coordinate) =>
        typeof coordinate === "number" && Number.isFinite(coordinate),
    )
  ) {
    throw new Error("Stored evidence bbox is invalid");
  }
  return decoded as [number, number, number, number];
}

function mapEvidence(row: SqlRow): EvidenceRecord {
  return {
    evidenceId: stringValue(row, "evidenceId"),
    kind: stringValue(row, "kind") as EvidenceKind,
    documentVersionId: stringValue(row, "documentVersionId"),
    title: nullableString(row, "title"),
    summary: nullableString(row, "summary"),
    originalText: stringValue(row, "originalText"),
    contentHash: stringValue(row, "contentHash"),
    locator: decodeObject(
      stringValue(row, "sourceLocatorJson"),
    ) as EvidenceLocator,
    pageStart: nullableNumber(row, "pageStart"),
    pageEnd: nullableNumber(row, "pageEnd"),
    bbox: mapBbox(nullableString(row, "bboxJson")),
    sheetName: nullableString(row, "sheetName"),
    cellRange: nullableString(row, "cellRange"),
    cellRef: nullableString(row, "cellRef"),
    formula: nullableString(row, "formula"),
    displayValue: nullableString(row, "displayValue"),
    rawValue: nullableString(row, "rawValue"),
    metadata: objectValue(row, "metadataJson"),
    createdAt: stringValue(row, "createdAt"),
  };
}

function metadataInteger(
  metadata: Record<string, unknown>,
  ...keys: readonly string[]
): number | null {
  for (const key of keys) {
    const value = metadata[key];
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > 0
    ) {
      return value;
    }
  }
  return null;
}

function metadataText(
  metadata: Record<string, unknown>,
  ...keys: readonly string[]
): string | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

function metadataNumber(
  metadata: Record<string, unknown>,
  ...keys: readonly string[]
): number | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function mapExcelCell(row: SqlRow): ExcelEvidenceCell {
  const evidence = mapEvidence(row);
  const rowIndex = metadataInteger(
    evidence.metadata,
    "row",
    "row_index",
  );
  const columnIndex = metadataInteger(
    evidence.metadata,
    "column",
    "col_index",
  );
  if (rowIndex === null || columnIndex === null) {
    throw new Error("Stored Excel cell coordinates are invalid");
  }
  return {
    evidence,
    rowIndex,
    columnIndex,
    numericValue: metadataNumber(
      evidence.metadata,
      "numericValue",
      "numeric_value",
    ),
    cachedValue: metadataText(evidence.metadata, "cachedValue", "cached_value"),
    numberFormat: metadataText(
      evidence.metadata,
      "numberFormat",
      "number_format",
    ),
    rowLabel: metadataText(evidence.metadata, "rowLabel", "row_label"),
    columnLabel: metadataText(
      evidence.metadata,
      "columnLabel",
      "col_label",
    ),
    period: metadataText(evidence.metadata, "period"),
    unit: metadataText(evidence.metadata, "unit"),
  };
}

function optionalText(
  value: string | undefined,
  label: string,
  max: number,
): string | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim();
  if (normalized.length > max) {
    throw new RangeError(`${label} must not exceed ${String(max)} characters`);
  }
  return normalized || null;
}

function normalizedLocator(locator: EvidenceLocator): EvidenceLocator {
  const result: {
    displayText?: string;
    sourceRef?: string;
    pageStart?: number;
    pageEnd?: number;
    pageNumbers?: number[];
    bbox?: [number, number, number, number];
    slideStart?: number;
    slideEnd?: number;
    sheetName?: string;
    cellRange?: string;
    cellRef?: string;
    headingPath?: string;
    formula?: string;
    displayValue?: string;
    rawValue?: string;
  } = {};
  const copyText = (
    key: keyof EvidenceLocator,
    max: number,
  ): void => {
    const value = locator[key];
    if (value === undefined) {
      return;
    }
    if (typeof value !== "string") {
      throw new TypeError(`${key} must be a string`);
    }
    if (value.length > max) {
      throw new RangeError(`${key} must not exceed ${String(max)} characters`);
    }
    (result as Record<string, unknown>)[key] = value;
  };
  for (const [key, max] of [
    ["displayText", 2_000],
    ["sourceRef", 4_000],
    ["sheetName", 500],
    ["cellRange", 200],
    ["cellRef", 100],
    ["headingPath", 2_000],
    ["formula", 20_000],
    ["displayValue", 20_000],
    ["rawValue", 100_000],
  ] as const) {
    copyText(key, max);
  }
  const copyPositiveInteger = (
    key: "pageStart" | "pageEnd" | "slideStart" | "slideEnd",
  ): void => {
    const value = locator[key];
    if (value === undefined) {
      return;
    }
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${key} must be a positive integer`);
    }
    result[key] = value;
  };
  copyPositiveInteger("pageStart");
  copyPositiveInteger("pageEnd");
  copyPositiveInteger("slideStart");
  copyPositiveInteger("slideEnd");
  if (
    result.pageStart !== undefined &&
    result.pageEnd !== undefined &&
    result.pageEnd < result.pageStart
  ) {
    throw new RangeError("pageEnd must not precede pageStart");
  }
  if (
    result.slideStart !== undefined &&
    result.slideEnd !== undefined &&
    result.slideEnd < result.slideStart
  ) {
    throw new RangeError("slideEnd must not precede slideStart");
  }
  if (locator.pageNumbers !== undefined) {
    if (
      !Array.isArray(locator.pageNumbers) ||
      !locator.pageNumbers.every(
        (page) => Number.isSafeInteger(page) && page > 0,
      )
    ) {
      throw new RangeError("pageNumbers must contain positive integers");
    }
    result.pageNumbers = [...locator.pageNumbers];
  }
  if (locator.bbox !== undefined) {
    if (
      !Array.isArray(locator.bbox) ||
      locator.bbox.length !== 4 ||
      !locator.bbox.every(
        (coordinate) =>
          typeof coordinate === "number" && Number.isFinite(coordinate),
      )
    ) {
      throw new RangeError("bbox must contain four finite numbers");
    }
    result.bbox = [...locator.bbox] as [
      number,
      number,
      number,
      number,
    ];
  }
  return result;
}

function readBackend(database: DatabaseSync): SearchBackend {
  const row = database
    .prepare(
      `SELECT value FROM project_store_settings
       WHERE key = 'search_backend'`,
    )
    .get();
  const value = row?.value;
  if (
    value === "fts5-trigram" ||
    value === "fts5-unicode61" ||
    value === "deterministic"
  ) {
    return value;
  }
  throw new Error("Project database search backend is invalid");
}

function searchTerms(query: string, trigram: boolean): string[] {
  const normalized = query.normalize("NFKC").toLocaleLowerCase();
  const groups =
    normalized.match(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu) ?? [];
  const terms: string[] = [];
  for (const group of groups) {
    if (/\p{Script=Han}/u.test(group) && group.length > (trigram ? 3 : 2)) {
      const gramSize = trigram ? 3 : 2;
      for (let index = 0; index <= group.length - gramSize; index += 1) {
        terms.push(group.slice(index, index + gramSize));
      }
    } else if (!trigram || group.length >= 3) {
      terms.push(group);
    }
  }
  return [...new Set(terms)].slice(0, 32);
}

function ftsQuery(terms: readonly string[]): string {
  return terms
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" OR ");
}

export class EvidenceRepository {
  private readonly database: DatabaseSync;
  public readonly searchBackend: SearchBackend;

  public constructor(
    database: ProjectDatabase | DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {
    this.database =
      database instanceof ProjectDatabase ? database.connection : database;
    this.searchBackend =
      database instanceof ProjectDatabase
        ? database.searchBackend
        : readBackend(database);
  }

  public put(input: PutEvidenceInput): PutEvidenceResult {
    if (
      !/^(chunk|fact|cell|page):[A-Za-z0-9_.-]+$/.test(input.evidenceId) ||
      !input.evidenceId.startsWith(`${input.kind}:`)
    ) {
      throw new RangeError(
        "evidenceId must use its kind prefix and a stable identifier",
      );
    }
    const locator = normalizedLocator(input.locator ?? {});
    const title = optionalText(input.title ?? undefined, "title", 2_000);
    const summary = optionalText(input.summary ?? undefined, "summary", 20_000);
    const contentHash = hash(input.originalText);
    const locatorJson = encodeJson(locator);
    const metadataJson = encodeJson(input.metadata ?? {});

    return withProjectTransaction(this.database, () => {
      const version = this.database
        .prepare("SELECT 1 FROM document_versions WHERE id = ?")
        .get(input.documentVersionId);
      if (version === undefined) {
        throw new NotFoundError("Document version");
      }
      const existing = this.find(input.evidenceId);
      if (existing !== null) {
        if (
          existing.documentVersionId !== input.documentVersionId ||
          existing.kind !== input.kind ||
          existing.contentHash !== contentHash ||
          existing.title !== title ||
          existing.summary !== summary ||
          encodeJson(existing.locator) !== locatorJson ||
          encodeJson(existing.metadata) !== metadataJson
        ) {
          throw new ConflictError(
            "Evidence ID is already assigned to different source data",
            "evidence_id_conflict",
          );
        }
        return { evidence: existing, created: false };
      }

      const pageNumbers = locator.pageNumbers;
      const bbox = locator.bbox;
      this.database
        .prepare(
          `INSERT INTO evidence(
             evidence_id, kind, document_version_id, title, summary,
             original_text, content_hash, source_locator_json,
             page_start, page_end, page_numbers_json, bbox_json,
             slide_start, slide_end, sheet_name, cell_range, cell_ref,
             heading_path, formula, display_value, raw_value,
             metadata_json, created_at
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           )`,
        )
        .run(
          input.evidenceId,
          input.kind,
          input.documentVersionId,
          title,
          summary,
          input.originalText,
          contentHash,
          locatorJson,
          locator.pageStart ?? null,
          locator.pageEnd ?? null,
          pageNumbers === undefined ? null : encodeJson(pageNumbers),
          bbox === undefined ? null : encodeJson(bbox),
          locator.slideStart ?? null,
          locator.slideEnd ?? null,
          locator.sheetName ?? null,
          locator.cellRange ?? null,
          locator.cellRef ?? null,
          locator.headingPath ?? null,
          locator.formula ?? null,
          locator.displayValue ?? null,
          locator.rawValue ?? null,
          metadataJson,
          isoNow(this.clock),
        );
      return { evidence: this.get(input.evidenceId), created: true };
    });
  }

  public putMany(inputs: readonly PutEvidenceInput[]): PutEvidenceResult[] {
    return withProjectTransaction(this.database, () =>
      inputs.map((input) => this.put(input)),
    );
  }

  public find(evidenceId: string): EvidenceRecord | null {
    const row = this.database
      .prepare(
        `SELECT ${EVIDENCE_COLUMNS}
         FROM evidence
         WHERE evidence_id = ?`,
      )
      .get(evidenceId);
    return row === undefined ? null : mapEvidence(row);
  }

  public get(evidenceId: string): EvidenceRecord {
    const evidence = this.find(evidenceId);
    if (evidence === null) {
      throw new NotFoundError("Evidence");
    }
    return evidence;
  }

  public trace(evidenceId: string): EvidenceTrace {
    const row = this.database
      .prepare(
        `SELECT
           ${EVIDENCE_COLUMNS.split("\n")
             .map((line) =>
               line.trim()
                 ? `e.${line.trim().replace(/,$/, "")}`
                 : "",
             )
             .filter(Boolean)
             .join(",\n")},
           v.id AS version_id,
           v.document_id AS version_documentId,
           v.version_no AS version_versionNo,
           v.supersedes_version_id AS version_supersedesVersionId,
           v.sha256 AS version_sha256,
           v.original_filename AS version_originalFilename,
           v.stored_path AS version_storedPath,
           v.file_type AS version_fileType,
           v.mime_type AS version_mimeType,
           v.file_size AS version_fileSize,
           v.status AS version_status,
           v.lifecycle AS version_lifecycle,
           v.parser_name AS version_parserName,
           v.parser_version AS version_parserVersion,
           v.metadata_json AS version_metadataJson,
           v.created_at AS version_createdAt,
           v.updated_at AS version_updatedAt,
           d.id AS document_id,
           d.logical_key AS document_logicalKey,
           d.source_root AS document_sourceRoot,
           d.source_relpath AS document_sourceRelpath,
           d.title AS document_title,
           d.status AS document_status,
           d.current_version_id AS document_currentVersionId,
           d.current_version_no AS document_currentVersionNo,
           d.metadata_json AS document_metadataJson,
           d.created_at AS document_createdAt,
           d.updated_at AS document_updatedAt,
           d.deleted_at AS document_deletedAt
         FROM evidence AS e
         JOIN document_versions AS v ON v.id = e.document_version_id
         JOIN documents AS d ON d.id = v.document_id
         WHERE e.evidence_id = ?`,
      )
      .get(evidenceId);
    if (row === undefined) {
      throw new NotFoundError("Evidence");
    }
    const evidence = mapEvidence(row);
    const versionRow: SqlRow = {
      id: row.version_id ?? null,
      documentId: row.version_documentId ?? null,
      versionNo: row.version_versionNo ?? null,
      supersedesVersionId: row.version_supersedesVersionId ?? null,
      sha256: row.version_sha256 ?? null,
      originalFilename: row.version_originalFilename ?? null,
      storedPath: row.version_storedPath ?? null,
      fileType: row.version_fileType ?? null,
      mimeType: row.version_mimeType ?? null,
      fileSize: row.version_fileSize ?? null,
      status: row.version_status ?? null,
      lifecycle: row.version_lifecycle ?? null,
      parserName: row.version_parserName ?? null,
      parserVersion: row.version_parserVersion ?? null,
      metadataJson: row.version_metadataJson ?? null,
      createdAt: row.version_createdAt ?? null,
      updatedAt: row.version_updatedAt ?? null,
    };
    const documentRow: SqlRow = {
      id: row.document_id ?? null,
      logicalKey: row.document_logicalKey ?? null,
      sourceRoot: row.document_sourceRoot ?? null,
      sourceRelpath: row.document_sourceRelpath ?? null,
      title: row.document_title ?? null,
      status: row.document_status ?? null,
      currentVersionId: row.document_currentVersionId ?? null,
      currentVersionNo: row.document_currentVersionNo ?? null,
      metadataJson: row.document_metadataJson ?? null,
      createdAt: row.document_createdAt ?? null,
      updatedAt: row.document_updatedAt ?? null,
      deletedAt: row.document_deletedAt ?? null,
    };
    return {
      ...evidence,
      documentVersion: mapVersion(versionRow),
      document: mapDocument(documentRow),
    };
  }

  public listForVersion(
    versionId: string,
    options: PageOptions & { readonly kinds?: readonly EvidenceKind[] } = {},
  ): Page<EvidenceRecord> {
    if (
      this.database
        .prepare("SELECT 1 FROM document_versions WHERE id = ?")
        .get(versionId) === undefined
    ) {
      throw new NotFoundError("Document version");
    }
    const { limit, offset } = pageValues(options);
    const kinds = options.kinds ?? [];
    const kindClause =
      kinds.length === 0
        ? ""
        : ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
    const totalRow = this.database
      .prepare(
        `SELECT COUNT(*) AS total
         FROM evidence
         WHERE document_version_id = ?${kindClause}`,
      )
      .get(versionId, ...kinds)!;
    const items = this.database
      .prepare(
        `SELECT ${EVIDENCE_COLUMNS}
         FROM evidence
         WHERE document_version_id = ?${kindClause}
         ORDER BY evidence_id
         LIMIT ? OFFSET ?`,
      )
      .all(versionId, ...kinds, limit, offset)
      .map(mapEvidence);
    const total = numberValue(totalRow, "total");
    return {
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
  }

  public textPreviewForVersion(
    versionId: string,
    options: {
      readonly maxChunks?: number;
      readonly maxCharacters?: number;
    } = {},
  ): DocumentTextPreviewContent {
    if (
      this.database
        .prepare("SELECT 1 FROM document_versions WHERE id = ?")
        .get(versionId) === undefined
    ) {
      throw new NotFoundError("Document version");
    }
    const maxChunks = options.maxChunks ?? 400;
    const maxCharacters = options.maxCharacters ?? 200_000;
    if (
      !Number.isSafeInteger(maxChunks) ||
      maxChunks < 1 ||
      maxChunks > 400
    ) {
      throw new RangeError("maxChunks must contain between 1 and 400 rows");
    }
    if (
      !Number.isSafeInteger(maxCharacters) ||
      maxCharacters < 1 ||
      maxCharacters > 200_000
    ) {
      throw new RangeError(
        "maxCharacters must contain between 1 and 200000 characters",
      );
    }
    const rows = this.database
      .prepare(
        `SELECT substr(original_text, 1, ?) AS originalText,
                length(original_text) AS originalLength
         FROM evidence
         WHERE document_version_id = ?
         ORDER BY rowid
         LIMIT ?`,
      )
      .all(maxCharacters + 1, versionId, maxChunks + 1);
    const content: string[] = [];
    let characterCount = 0;
    let truncated = rows.length > maxChunks;
    for (const row of rows.slice(0, maxChunks)) {
      const original =
        typeof row.originalText === "string" ? row.originalText : "";
      const normalized = original.trim();
      if (normalized.length === 0) {
        continue;
      }
      const separatorLength = content.length === 0 ? 0 : 2;
      const remaining =
        maxCharacters - characterCount - separatorLength;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const clipped = normalized.slice(0, remaining);
      if (content.length > 0) {
        characterCount += 2;
      }
      content.push(clipped);
      characterCount += clipped.length;
      if (
        clipped.length < normalized.length ||
        (typeof row.originalLength === "number" &&
          row.originalLength > original.length)
      ) {
        truncated = true;
        break;
      }
    }
    if (characterCount >= maxCharacters) {
      truncated = true;
    }
    return {
      chunkCount: Math.min(rows.length, maxChunks),
      contentMarkdown: content.join("\n\n"),
      truncated,
    };
  }

  public listExcelSheetStats(
    versionId: string,
  ): ExcelEvidenceSheetStats[] {
    const rows = this.database
      .prepare(
        `SELECT
           sheet_name AS sheetName,
           MIN(CAST(COALESCE(
             json_extract(metadata_json, '$.row'),
             json_extract(metadata_json, '$.row_index')
           ) AS INTEGER)) AS rowMin,
           MAX(CAST(COALESCE(
             json_extract(metadata_json, '$.row'),
             json_extract(metadata_json, '$.row_index')
           ) AS INTEGER)) AS rowMax,
           MIN(CAST(COALESCE(
             json_extract(metadata_json, '$.column'),
             json_extract(metadata_json, '$.col_index')
           ) AS INTEGER)) AS columnMin,
           MAX(CAST(COALESCE(
             json_extract(metadata_json, '$.column'),
             json_extract(metadata_json, '$.col_index')
           ) AS INTEGER)) AS columnMax,
           COUNT(*) AS nonEmptyCellCount,
           SUM(CASE
             WHEN formula IS NOT NULL AND length(formula) > 0 THEN 1
             ELSE 0
           END) AS formulaCount
         FROM evidence
         WHERE document_version_id = ?
           AND kind = 'cell'
           AND sheet_name IS NOT NULL
           AND COALESCE(
             json_extract(metadata_json, '$.row'),
             json_extract(metadata_json, '$.row_index')
           ) IS NOT NULL
           AND COALESCE(
             json_extract(metadata_json, '$.column'),
             json_extract(metadata_json, '$.col_index')
           ) IS NOT NULL
         GROUP BY sheet_name COLLATE NOCASE
         ORDER BY sheet_name COLLATE NOCASE`,
      )
      .all(versionId);
    return rows.map((row) => {
      const stats = {
        sheetName: stringValue(row, "sheetName"),
        rowMin: numberValue(row, "rowMin"),
        rowMax: numberValue(row, "rowMax"),
        columnMin: numberValue(row, "columnMin"),
        columnMax: numberValue(row, "columnMax"),
        nonEmptyCellCount: numberValue(row, "nonEmptyCellCount"),
        formulaCount: numberValue(row, "formulaCount"),
      };
      if (
        stats.rowMin < 1 ||
        stats.rowMax > 1_048_576 ||
        stats.columnMin < 1 ||
        stats.columnMax > 16_384
      ) {
        throw new Error("Stored Excel sheet coordinates are invalid");
      }
      return stats;
    });
  }

  public countExcelCellsInRange(
    versionId: string,
    sheetName: string,
    bounds: {
      readonly rowMin: number;
      readonly rowMax: number;
      readonly columnMin: number;
      readonly columnMax: number;
    },
  ): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS total
         FROM evidence
         WHERE document_version_id = ?
           AND kind = 'cell'
           AND sheet_name = ? COLLATE NOCASE
           AND CAST(COALESCE(
             json_extract(metadata_json, '$.row'),
             json_extract(metadata_json, '$.row_index')
           ) AS INTEGER) BETWEEN ? AND ?
           AND CAST(COALESCE(
             json_extract(metadata_json, '$.column'),
             json_extract(metadata_json, '$.col_index')
           ) AS INTEGER) BETWEEN ? AND ?`,
      )
      .get(
        versionId,
        sheetName,
        bounds.rowMin,
        bounds.rowMax,
        bounds.columnMin,
        bounds.columnMax,
      );
    return numberValue(row!, "total");
  }

  public listExcelCellsInRange(
    versionId: string,
    sheetName: string,
    bounds: {
      readonly rowMin: number;
      readonly rowMax: number;
      readonly columnMin: number;
      readonly columnMax: number;
    },
    limit = 4_000,
  ): ExcelEvidenceCell[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4_000) {
      throw new RangeError("Excel cell limit must be between 1 and 4000");
    }
    return this.database
      .prepare(
        `SELECT ${EVIDENCE_COLUMNS}
         FROM evidence
         WHERE document_version_id = ?
           AND kind = 'cell'
           AND sheet_name = ? COLLATE NOCASE
           AND CAST(COALESCE(
             json_extract(metadata_json, '$.row'),
             json_extract(metadata_json, '$.row_index')
           ) AS INTEGER) BETWEEN ? AND ?
           AND CAST(COALESCE(
             json_extract(metadata_json, '$.column'),
             json_extract(metadata_json, '$.col_index')
           ) AS INTEGER) BETWEEN ? AND ?
         ORDER BY
           CAST(COALESCE(
             json_extract(metadata_json, '$.row'),
             json_extract(metadata_json, '$.row_index')
           ) AS INTEGER),
           CAST(COALESCE(
             json_extract(metadata_json, '$.column'),
             json_extract(metadata_json, '$.col_index')
           ) AS INTEGER),
           evidence_id
         LIMIT ?`,
      )
      .all(
        versionId,
        sheetName,
        bounds.rowMin,
        bounds.rowMax,
        bounds.columnMin,
        bounds.columnMax,
        limit,
      )
      .map(mapExcelCell);
  }

  public findPdfPage(
    versionId: string,
    pageNumber: number,
  ): EvidenceRecord | null {
    if (
      !Number.isSafeInteger(pageNumber) ||
      pageNumber < 1 ||
      pageNumber > 1_000_000
    ) {
      throw new RangeError("PDF page number is outside the supported range");
    }
    const row = this.database
      .prepare(
        `SELECT ${EVIDENCE_COLUMNS}
         FROM evidence
         WHERE document_version_id = ?
           AND kind = 'page'
           AND page_start = ?
           AND page_end = ?
         ORDER BY evidence_id
         LIMIT 1`,
      )
      .get(versionId, pageNumber, pageNumber);
    return row === undefined ? null : mapEvidence(row);
  }

  public search(options: EvidenceSearchOptions): Page<EvidenceSearchHit> {
    const query = options.query.normalize("NFKC").trim();
    if (!query) {
      throw new RangeError("Search query must not be empty");
    }
    const { limit, offset } = pageValues(options);
    const normalizedOptions = { ...options, query, limit, offset };
    if (this.searchBackend !== "deterministic") {
      try {
        const result = this.searchFts(normalizedOptions);
        if (result.total > 0) {
          return result;
        }
      } catch {
        // A valid FTS database can still reject a tokenizer-specific query.
        // The deterministic path guarantees stable behavior for every input.
      }
    }
    return this.searchDeterministically(normalizedOptions);
  }

  private searchFts(
    options: EvidenceSearchOptions & { limit: number; offset: number },
  ): Page<EvidenceSearchHit> {
    const terms = searchTerms(
      options.query,
      this.searchBackend === "fts5-trigram",
    );
    if (terms.length === 0) {
      return this.searchDeterministically(options);
    }
    const match = ftsQuery(terms);
    const kinds = options.kinds ?? [];
    const kindClause =
      kinds.length === 0
        ? ""
        : ` AND e.kind IN (${kinds.map(() => "?").join(", ")})`;
    const currentClause = options.includeHistorical
      ? ""
      : " AND d.current_version_id = e.document_version_id";
    const baseParameters = [match, ...kinds];
    const totalRow = this.database
      .prepare(
        `SELECT COUNT(*) AS total
         FROM evidence_fts
         JOIN evidence AS e
           ON e.evidence_id = evidence_fts.evidence_id
         JOIN document_versions AS v ON v.id = e.document_version_id
         JOIN documents AS d ON d.id = v.document_id
         WHERE evidence_fts MATCH ?${kindClause}${currentClause}`,
      )
      .get(...baseParameters)!;
    const ranked = this.database
      .prepare(
        `SELECT e.evidence_id AS evidenceId,
                -bm25(evidence_fts, 0.0, 3.0, 2.0, 1.0) AS score
         FROM evidence_fts
         JOIN evidence AS e
           ON e.evidence_id = evidence_fts.evidence_id
         JOIN document_versions AS v ON v.id = e.document_version_id
         JOIN documents AS d ON d.id = v.document_id
         WHERE evidence_fts MATCH ?${kindClause}${currentClause}
         ORDER BY bm25(evidence_fts, 0.0, 3.0, 2.0, 1.0),
                  e.evidence_id
         LIMIT ? OFFSET ?`,
      )
      .all(...baseParameters, options.limit, options.offset);
    const items = ranked.map((row) => ({
      evidence: this.trace(stringValue(row, "evidenceId")),
      score: Number(row.score),
    }));
    const total = numberValue(totalRow, "total");
    return {
      items,
      total,
      limit: options.limit,
      offset: options.offset,
      hasMore: options.offset + items.length < total,
    };
  }

  private searchDeterministically(
    options: EvidenceSearchOptions & { limit: number; offset: number },
  ): Page<EvidenceSearchHit> {
    const terms = searchTerms(options.query, false);
    const kinds = options.kinds ?? [];
    const kindClause =
      kinds.length === 0
        ? ""
        : ` AND e.kind IN (${kinds.map(() => "?").join(", ")})`;
    const currentClause = options.includeHistorical
      ? ""
      : " AND d.current_version_id = e.document_version_id";
    const rows = this.database
      .prepare(
        `SELECT e.evidence_id AS evidenceId, e.title, e.summary,
                e.original_text AS originalText,
                e.source_locator_json AS locatorJson
         FROM evidence AS e
         JOIN document_versions AS v ON v.id = e.document_version_id
         JOIN documents AS d ON d.id = v.document_id
         WHERE 1 = 1${kindClause}${currentClause}
         ORDER BY e.evidence_id`,
      )
      .all(...kinds);
    const exact = options.query.toLocaleLowerCase();
    const scored = rows
      .map((row) => {
        const title = (nullableString(row, "title") ?? "").toLocaleLowerCase();
        const summary = (
          nullableString(row, "summary") ?? ""
        ).toLocaleLowerCase();
        const original = stringValue(row, "originalText").toLocaleLowerCase();
        const locator = stringValue(row, "locatorJson").toLocaleLowerCase();
        let score = original.includes(exact) ? 10 : 0;
        for (const term of terms) {
          if (title.includes(term)) score += 4;
          if (summary.includes(term)) score += 3;
          if (original.includes(term)) score += 2;
          if (locator.includes(term)) score += 1;
        }
        return {
          evidenceId: stringValue(row, "evidenceId"),
          score,
        };
      })
      .filter((item) => item.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.evidenceId.localeCompare(right.evidenceId),
      );
    const pageRows = scored.slice(
      options.offset,
      options.offset + options.limit,
    );
    const items = pageRows.map((item) => ({
      evidence: this.trace(item.evidenceId),
      score: item.score,
    }));
    return {
      items,
      total: scored.length,
      limit: options.limit,
      offset: options.offset,
      hasMore: options.offset + items.length < scored.length,
    };
  }
}

export { mapEvidence };
