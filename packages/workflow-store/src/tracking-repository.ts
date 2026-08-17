import type { DatabaseSync } from "node:sqlite";

import {
  assertOneOf,
  boolInt,
  decodeJsonArray,
  decodeJsonObject,
  encodeJson,
  getRequiredRow,
  normalizeEvidenceIds,
  nowIso,
  numberOrNull,
  pageOptions,
  pageResult,
  recordEvidenceReferences,
  requireText,
  stableId,
  toRecord,
  withTransaction,
  WorkflowStoreError,
  type JsonValue,
  type Page,
  type PageOptions,
  type SqlRow,
} from "./shared.js";

export const TRACKING_ITEM_TYPES = [
  "thesis",
  "assumption",
  "risk",
  "catalyst",
  "metric",
  "question",
] as const;
export type TrackingItemType = (typeof TRACKING_ITEM_TYPES)[number];

export const TRACKING_ALERT_STATUSES = [
  "new",
  "acknowledged",
  "dismissed",
  "snoozed",
] as const;
export type TrackingAlertStatus = (typeof TRACKING_ALERT_STATUSES)[number];

export const TRACKING_PRIORITIES = [
  "low",
  "medium",
  "high",
  "critical",
] as const;
export type TrackingPriority = (typeof TRACKING_PRIORITIES)[number];

export interface MemoSectionInput {
  readonly sectionKey: string;
  readonly title: string;
  readonly content: string;
  readonly evidenceIds?: readonly string[];
  readonly needsReview?: boolean;
}

export interface SaveMemoVersionInput {
  readonly datasetId: string;
  readonly topic: string;
  readonly title?: string;
  readonly asOfDate: string;
  readonly sourceType: string;
  readonly status?: string;
  readonly contentHash: string;
  readonly markdownPath?: string | null;
  readonly htmlPath?: string | null;
  readonly pdfPath?: string | null;
  readonly sourceResponseId?: string | null;
  readonly revisionOfVersionId?: string | null;
  readonly documentVersions?: readonly JsonValue[];
  readonly inputs?: Readonly<Record<string, JsonValue>>;
  readonly sections?: readonly MemoSectionInput[];
  readonly idempotencyKey?: string;
  readonly createdAt?: string;
}

export interface AttachMemoArtifactsInput {
  readonly markdownPath: string;
  readonly htmlPath: string;
  readonly pdfPath?: string | null;
}

export interface MemoSectionRecord {
  readonly sectionId: string;
  readonly memoVersionId: string;
  readonly sectionKey: string;
  readonly title: string;
  readonly sortOrder: number;
  readonly content: string;
  readonly evidenceIds: readonly string[];
  readonly needsReview: boolean;
  readonly createdAt: string;
}

export interface MemoVersionRecord {
  readonly memoVersionId: string;
  readonly seriesId: string;
  readonly datasetId: string;
  readonly topic: string;
  readonly seriesTitle: string;
  readonly versionNo: number;
  readonly revisionOfVersionId: string | null;
  readonly asOfDate: string;
  readonly sourceType: string;
  readonly status: string;
  readonly markdownPath: string | null;
  readonly htmlPath: string | null;
  readonly pdfPath: string | null;
  readonly sourceResponseId: string | null;
  readonly documentVersions: readonly JsonValue[];
  readonly inputs: Readonly<Record<string, JsonValue>>;
  readonly contentHash: string;
  readonly idempotencyKey: string | null;
  readonly sections: readonly MemoSectionRecord[];
  readonly createdAt: string;
}

export interface MemoSeriesRecord {
  readonly seriesId: string;
  readonly datasetId: string;
  readonly seriesKey: string;
  readonly topic: string;
  readonly title: string;
  readonly currentVersionNo: number;
  readonly currentMemoVersionId: string | null;
  readonly versionCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoSectionChange {
  readonly sectionKey: string;
  readonly title: string;
  readonly changeType: "added" | "changed" | "not_mentioned" | "unchanged";
  readonly similarity: number;
  readonly oldContent: string;
  readonly newContent: string;
  readonly oldEvidenceIds: readonly string[];
  readonly newEvidenceIds: readonly string[];
}

export interface AppendItemVersionInput {
  readonly datasetId: string;
  readonly itemType: TrackingItemType;
  readonly canonicalKey: string;
  readonly title: string;
  readonly status?: string;
  readonly asOfDate?: string | null;
  readonly sourcePublishedAt?: string | null;
  readonly observedAt?: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly content: string;
  readonly stance?: string;
  readonly state?: string;
  readonly valueNumeric?: number | null;
  readonly valueText?: string | null;
  readonly unit?: string | null;
  readonly period?: string | null;
  readonly scenario?: string | null;
  readonly probability?: string | null;
  readonly impact?: TrackingPriority;
  readonly confidence?: number;
  readonly expectedStart?: string | null;
  readonly expectedEnd?: string | null;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly evidenceIds?: readonly string[];
  readonly idempotencyKey?: string;
  readonly change?: {
    readonly changeType: string;
    readonly materiality: TrackingPriority;
    readonly summary: string;
    readonly details?: Readonly<Record<string, JsonValue>>;
  };
}

export interface ItemVersionRecord {
  readonly itemVersionId: string;
  readonly itemId: string;
  readonly versionNo: number;
  readonly asOfDate: string | null;
  readonly sourcePublishedAt: string | null;
  readonly observedAt: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly content: string;
  readonly stance: string;
  readonly state: string;
  readonly valueNumeric: number | null;
  readonly valueText: string | null;
  readonly unit: string | null;
  readonly period: string | null;
  readonly scenario: string | null;
  readonly probability: string | null;
  readonly impact: TrackingPriority;
  readonly confidence: number;
  readonly expectedStart: string | null;
  readonly expectedEnd: string | null;
  readonly metadata: Readonly<Record<string, JsonValue>>;
  readonly evidenceIds: readonly string[];
  readonly idempotencyKey: string | null;
  readonly createdAt: string;
}

export interface ResearchItemRecord {
  readonly itemId: string;
  readonly datasetId: string;
  readonly itemType: TrackingItemType;
  readonly canonicalKey: string;
  readonly title: string;
  readonly status: string;
  readonly currentVersionNo: number;
  readonly currentVersionId: string | null;
  readonly currentVersion: ItemVersionRecord | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChangeEventRecord {
  readonly changeEventId: string;
  readonly datasetId: string;
  readonly itemId: string;
  readonly oldVersionId: string | null;
  readonly newVersionId: string;
  readonly changeType: string;
  readonly materiality: TrackingPriority;
  readonly summary: string;
  readonly details: Readonly<Record<string, JsonValue>>;
  readonly idempotencyKey: string | null;
  readonly createdAt: string;
}

export interface ObservationRecord {
  readonly observationId: string;
  readonly itemId: string;
  readonly itemVersionId: string | null;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly content: string;
  readonly evidenceIds: readonly string[];
  readonly extracted: Readonly<Record<string, JsonValue>>;
  readonly observedAt: string;
  readonly idempotencyKey: string | null;
}

export interface ItemTimeline {
  readonly item: ResearchItemRecord;
  readonly versions: readonly ItemVersionRecord[];
  readonly changes: readonly ChangeEventRecord[];
  readonly observations: readonly ObservationRecord[];
}

export interface WatchRuleRecord {
  readonly ruleId: string;
  readonly datasetId: string;
  readonly name: string;
  readonly targetType: TrackingItemType | "all";
  readonly targetItemId: string | null;
  readonly query: Readonly<Record<string, JsonValue>>;
  readonly minPriority: TrackingPriority;
  readonly frequency: string;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpsertWatchRuleInput {
  readonly ruleId?: string;
  readonly datasetId: string;
  readonly name: string;
  readonly targetType: TrackingItemType | "all";
  readonly targetItemId?: string | null;
  readonly query?: Readonly<Record<string, JsonValue>>;
  readonly minPriority?: TrackingPriority;
  readonly frequency?: string;
  readonly active?: boolean;
}

export interface TrackingAlertRecord {
  readonly alertId: string;
  readonly datasetId: string;
  readonly ruleId: string | null;
  readonly itemId: string;
  readonly changeEventId: string | null;
  readonly alertType: string;
  readonly priority: TrackingPriority;
  readonly title: string;
  readonly summary: string;
  readonly whyItMatters: string;
  readonly evidenceIds: readonly string[];
  readonly status: TrackingAlertStatus;
  readonly dueAt: string | null;
  readonly snoozedUntil: string | null;
  readonly dedupeKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateTrackingAlertInput {
  readonly datasetId: string;
  readonly ruleId?: string | null;
  readonly itemId: string;
  readonly changeEventId?: string | null;
  readonly alertType: string;
  readonly priority: TrackingPriority;
  readonly title: string;
  readonly summary: string;
  readonly whyItMatters?: string;
  readonly evidenceIds?: readonly string[];
  readonly dueAt?: string | null;
  readonly dedupeKey: string;
}

export interface ListItemsOptions extends PageOptions {
  readonly itemType?: TrackingItemType;
  readonly status?: string;
}

export interface ListAlertsOptions extends PageOptions {
  readonly status?: TrackingAlertStatus;
}

type Clock = () => Date;

function stringValue(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new WorkflowStoreError(`Database column ${key} is corrupt`, "corrupt_json");
  }
  return value;
}

function nullableString(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new WorkflowStoreError(`Database column ${key} is corrupt`, "corrupt_json");
  }
  return value;
}

function numericValue(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WorkflowStoreError(`Database column ${key} is corrupt`, "corrupt_json");
  }
  return value;
}

function decodeEvidence(value: unknown): string[] {
  const decoded = decodeJsonArray(value, "evidence IDs");
  if (!decoded.every((item) => typeof item === "string")) {
    throw new WorkflowStoreError("Stored Evidence ID list is corrupt", "corrupt_json");
  }
  return decoded as string[];
}

function canonicalSeriesKey(topic: string): string {
  return topic
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replaceAll(/[\s_/]+/gu, " ")
    .slice(0, 180);
}

function bigrams(value: string): Set<string> {
  const normalized = value.normalize("NFKC").replaceAll(/\s+/gu, " ").trim();
  if (normalized.length < 2) {
    return new Set(normalized.length === 0 ? [] : [normalized]);
  }
  const result = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    result.add(normalized.slice(index, index + 2));
  }
  return result;
}

function similarity(left: string, right: string): number {
  if (left === right) {
    return 1;
  }
  const a = bigrams(left);
  const b = bigrams(right);
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let common = 0;
  for (const token of a) {
    if (b.has(token)) {
      common += 1;
    }
  }
  return Number(((2 * common) / (a.size + b.size)).toFixed(4));
}

export class TrackingRepository {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly clock: Clock = () => new Date(),
  ) {}

  private now(): string {
    return nowIso(this.clock());
  }

  private sections(memoVersionId: string): MemoSectionRecord[] {
    return this.database
      .prepare(
        `SELECT * FROM research_memo_sections
         WHERE memo_version_id=? ORDER BY sort_order, section_id`,
      )
      .all(memoVersionId)
      .map((row) => {
        const value = toRecord(row);
        return {
          sectionId: stringValue(value, "section_id"),
          memoVersionId: stringValue(value, "memo_version_id"),
          sectionKey: stringValue(value, "section_key"),
          title: stringValue(value, "title"),
          sortOrder: numericValue(value, "sort_order"),
          content: stringValue(value, "content"),
          evidenceIds: decodeEvidence(value.evidence_ids_json),
          needsReview: numericValue(value, "needs_review") === 1,
          createdAt: stringValue(value, "created_at"),
        };
      });
  }

  private memoVersion(row: SqlRow): MemoVersionRecord {
    const memoVersionId = stringValue(row, "memo_version_id");
    return {
      memoVersionId,
      seriesId: stringValue(row, "series_id"),
      datasetId: stringValue(row, "dataset_id"),
      topic: stringValue(row, "topic"),
      seriesTitle: stringValue(row, "series_title"),
      versionNo: numericValue(row, "version_no"),
      revisionOfVersionId: nullableString(row, "revision_of_version_id"),
      asOfDate: stringValue(row, "as_of_date"),
      sourceType: stringValue(row, "source_type"),
      status: stringValue(row, "status"),
      markdownPath: nullableString(row, "markdown_path"),
      htmlPath: nullableString(row, "html_path"),
      pdfPath: nullableString(row, "pdf_path"),
      sourceResponseId: nullableString(row, "source_response_id"),
      documentVersions: decodeJsonArray(row.document_versions_json),
      inputs: decodeJsonObject(row.input_json),
      contentHash: stringValue(row, "content_hash"),
      idempotencyKey: nullableString(row, "idempotency_key"),
      sections: this.sections(memoVersionId),
      createdAt: stringValue(row, "created_at"),
    };
  }

  public saveMemoVersion(
    input: SaveMemoVersionInput,
  ): { readonly record: MemoVersionRecord; readonly created: boolean } {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const topic = requireText(input.topic, "topic", 500);
    const seriesKey = canonicalSeriesKey(topic) || "综合投研";
    const title = requireText(input.title ?? topic, "title", 500);
    const asOfDate = requireText(input.asOfDate, "asOfDate", 40);
    const sourceType = requireText(input.sourceType, "sourceType", 100);
    const contentHash = requireText(input.contentHash, "contentHash", 128);
    const status = requireText(input.status ?? "completed", "status", 80);
    const idempotencyKey = requireText(
      input.idempotencyKey ??
        stableId("memo", datasetId, seriesKey, contentHash, sourceType),
      "idempotencyKey",
      240,
    );
    const evidenceBySection = (input.sections ?? []).map((section) => ({
      ...section,
      sectionKey: requireText(section.sectionKey, "sectionKey", 160),
      title: requireText(section.title, "section title", 500),
      content: String(section.content ?? ""),
      evidenceIds: normalizeEvidenceIds(section.evidenceIds),
    }));
    if (
      new Set(evidenceBySection.map((section) => section.sectionKey)).size !==
      evidenceBySection.length
    ) {
      throw new WorkflowStoreError(
        "Memo section keys must be unique",
        "invalid_argument",
      );
    }
    const createdAt = input.createdAt ?? this.now();

    return withTransaction(this.database, () => {
      const existing = this.database
        .prepare(
          `SELECT v.*, s.dataset_id, s.topic, s.title AS series_title
           FROM research_memo_versions v
           JOIN research_memo_series s ON s.series_id=v.series_id
           WHERE v.idempotency_key=?
              OR (
                s.dataset_id=? AND s.series_key=?
                AND v.content_hash=? AND v.source_type=?
              )
           ORDER BY CASE WHEN v.idempotency_key=? THEN 0 ELSE 1 END
           LIMIT 1`,
        )
        .get(
          idempotencyKey,
          datasetId,
          seriesKey,
          contentHash,
          sourceType,
          idempotencyKey,
        );
      if (existing !== undefined) {
        const row = toRecord(existing);
        const record = this.memoVersion(row);
        if (nullableString(row, "idempotency_key") === idempotencyKey) {
          const expectedSections = evidenceBySection.map((section, index) => ({
            sectionKey: section.sectionKey,
            title: section.title,
            sortOrder: index + 1,
            content: section.content,
            evidenceIds: [...section.evidenceIds].sort(),
            needsReview:
              section.needsReview ?? section.evidenceIds.length === 0,
          }));
          const storedSections = record.sections.map((section) => ({
            sectionKey: section.sectionKey,
            title: section.title,
            sortOrder: section.sortOrder,
            content: section.content,
            evidenceIds: [...section.evidenceIds].sort(),
            needsReview: section.needsReview,
          }));
          if (
            record.datasetId !== datasetId ||
            record.topic !== topic ||
            record.seriesTitle !== title ||
            record.asOfDate !== asOfDate ||
            record.sourceType !== sourceType ||
            record.status !== status ||
            record.contentHash !== contentHash ||
            record.markdownPath !== (input.markdownPath ?? null) ||
            record.htmlPath !== (input.htmlPath ?? null) ||
            record.pdfPath !== (input.pdfPath ?? null) ||
            record.sourceResponseId !== (input.sourceResponseId ?? null) ||
            (input.revisionOfVersionId !== undefined &&
              record.revisionOfVersionId !==
                input.revisionOfVersionId) ||
            (input.createdAt !== undefined &&
              record.createdAt !== input.createdAt) ||
            encodeJson(record.documentVersions) !==
              encodeJson(input.documentVersions ?? []) ||
            encodeJson(record.inputs) !== encodeJson(input.inputs ?? {}) ||
            encodeJson(storedSections) !== encodeJson(expectedSections)
          ) {
            throw new WorkflowStoreError(
              "Memo idempotency key was reused with different data",
              "conflict",
            );
          }
        }
        return { record, created: false };
      }
      const seriesId = stableId("ms", datasetId, seriesKey);
      this.database
        .prepare(
          `INSERT INTO research_memo_series
             (series_id, dataset_id, series_key, topic, title,
              current_version_no, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(dataset_id, series_key) DO UPDATE SET
             topic=excluded.topic, title=excluded.title, updated_at=excluded.updated_at`,
        )
        .run(seriesId, datasetId, seriesKey, topic, title, createdAt, createdAt);
      const series = getRequiredRow(
        this.database,
        `SELECT * FROM research_memo_series WHERE dataset_id=? AND series_key=?`,
        [datasetId, seriesKey],
        "memo series",
      );
      const actualSeriesId = stringValue(series, "series_id");
      const versionNo =
        Number(
          toRecord(
            this.database
              .prepare(
                `SELECT COALESCE(MAX(version_no), 0) AS value
                 FROM research_memo_versions WHERE series_id=?`,
              )
              .get(actualSeriesId),
          ).value,
        ) + 1;
      const revisionOf =
        input.revisionOfVersionId ??
        nullableString(
          toRecord(
            this.database
              .prepare(
                `SELECT memo_version_id FROM research_memo_versions
                 WHERE series_id=? ORDER BY version_no DESC LIMIT 1`,
              )
              .get(actualSeriesId) ?? { memo_version_id: null },
          ),
          "memo_version_id",
        );
      if (revisionOf !== null) {
        const revision = this.database
          .prepare(
            `SELECT 1 FROM research_memo_versions
             WHERE memo_version_id=? AND series_id=?`,
          )
          .get(revisionOf, actualSeriesId);
        if (revision === undefined) {
          throw new WorkflowStoreError(
            "Memo revision does not belong to the series",
            "invalid_argument",
          );
        }
      }
      const memoVersionId = stableId(
        "mv",
        actualSeriesId,
        versionNo,
        contentHash,
      );
      this.database
        .prepare(
          `INSERT INTO research_memo_versions
             (memo_version_id, series_id, version_no, revision_of_version_id,
              as_of_date, source_type, status, markdown_path, html_path, pdf_path,
              source_response_id, document_versions_json, input_json, content_hash,
              idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          memoVersionId,
          actualSeriesId,
          versionNo,
          revisionOf,
          asOfDate,
          sourceType,
          status,
          input.markdownPath ?? null,
          input.htmlPath ?? null,
          input.pdfPath ?? null,
          input.sourceResponseId ?? null,
          encodeJson(input.documentVersions ?? []),
          encodeJson(input.inputs ?? {}),
          contentHash,
          idempotencyKey,
          createdAt,
        );
      const insertSection = this.database.prepare(
        `INSERT INTO research_memo_sections
           (section_id, memo_version_id, section_key, title, sort_order, content,
            evidence_ids_json, needs_review, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const [index, section] of evidenceBySection.entries()) {
        const sectionId = stableId("msec", memoVersionId, section.sectionKey);
        insertSection.run(
          sectionId,
          memoVersionId,
          section.sectionKey,
          section.title,
          index + 1,
          section.content,
          encodeJson(section.evidenceIds),
          boolInt(section.needsReview ?? section.evidenceIds.length === 0),
          createdAt,
        );
        recordEvidenceReferences(
          this.database,
          "memo-section",
          sectionId,
          section.evidenceIds,
          "supports",
          createdAt,
        );
      }
      this.database
        .prepare(
          `UPDATE research_memo_series
           SET current_version_no=?, topic=?, title=?, updated_at=? WHERE series_id=?`,
        )
        .run(versionNo, topic, title, createdAt, actualSeriesId);
      const row = getRequiredRow(
        this.database,
        `SELECT v.*, s.dataset_id, s.topic, s.title AS series_title
         FROM research_memo_versions v
         JOIN research_memo_series s ON s.series_id=v.series_id
         WHERE v.memo_version_id=?`,
        [memoVersionId],
        "memo version",
      );
      return { record: this.memoVersion(row), created: true };
    });
  }

  public getMemoVersion(
    datasetId: string,
    memoVersionId: string,
  ): MemoVersionRecord {
    return this.memoVersion(
      getRequiredRow(
        this.database,
        `SELECT v.*, s.dataset_id, s.topic, s.title AS series_title
         FROM research_memo_versions v
         JOIN research_memo_series s ON s.series_id=v.series_id
         WHERE s.dataset_id=? AND v.memo_version_id=?`,
        [datasetId, memoVersionId],
        "memo version",
      ),
    );
  }

  public attachMemoArtifacts(
    datasetId: string,
    memoVersionId: string,
    input: AttachMemoArtifactsInput,
  ): MemoVersionRecord {
    const normalizedDatasetId = requireText(
      datasetId,
      "datasetId",
      240,
    );
    const normalizedMemoVersionId = requireText(
      memoVersionId,
      "memoVersionId",
      240,
    );
    const markdownPath = requireText(
      input.markdownPath,
      "markdownPath",
      8_000,
    );
    const htmlPath = requireText(input.htmlPath, "htmlPath", 8_000);
    const pdfPath =
      input.pdfPath === undefined || input.pdfPath === null
        ? null
        : requireText(input.pdfPath, "pdfPath", 8_000);
    return withTransaction(this.database, () => {
      const current = this.getMemoVersion(
        normalizedDatasetId,
        normalizedMemoVersionId,
      );
      for (const [label, existing, requested] of [
        ["markdownPath", current.markdownPath, markdownPath],
        ["htmlPath", current.htmlPath, htmlPath],
        ["pdfPath", current.pdfPath, pdfPath],
      ] as const) {
        if (
          existing !== null &&
          existing !== requested
        ) {
          throw new WorkflowStoreError(
            `${label} is immutable once attached to a Memo version`,
            "conflict",
          );
        }
      }
      this.database
        .prepare(
          `UPDATE research_memo_versions
           SET markdown_path=COALESCE(markdown_path, ?),
               html_path=COALESCE(html_path, ?),
               pdf_path=COALESCE(pdf_path, ?)
           WHERE memo_version_id=?`,
        )
        .run(
          markdownPath,
          htmlPath,
          pdfPath,
          normalizedMemoVersionId,
        );
      return this.getMemoVersion(
        normalizedDatasetId,
        normalizedMemoVersionId,
      );
    });
  }

  public listMemoVersions(
    datasetId: string,
    options: PageOptions & { readonly seriesId?: string } = {},
  ): Page<MemoVersionRecord> {
    const page = pageOptions(options);
    const filters = ["s.dataset_id=?"];
    const params: (number | string)[] = [datasetId];
    if (options.seriesId !== undefined) {
      filters.push("v.series_id=?");
      params.push(options.seriesId);
    }
    const where = filters.join(" AND ");
    const total = Number(
      toRecord(
        this.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM research_memo_versions v
             JOIN research_memo_series s ON s.series_id=v.series_id
             WHERE ${where}`,
          )
          .get(...params),
      ).count,
    );
    const records = this.database
      .prepare(
        `SELECT v.*, s.dataset_id, s.topic, s.title AS series_title
         FROM research_memo_versions v
         JOIN research_memo_series s ON s.series_id=v.series_id
         WHERE ${where}
         ORDER BY v.created_at DESC, v.version_no DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, page.limit, page.offset)
      .map((row) => this.memoVersion(toRecord(row)));
    return pageResult(records, total, page);
  }

  public listMemoSeries(
    datasetId: string,
    options: PageOptions = {},
  ): Page<MemoSeriesRecord> {
    const page = pageOptions(options);
    const total = Number(
      toRecord(
        this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM research_memo_series WHERE dataset_id=?`,
          )
          .get(datasetId),
      ).count,
    );
    const records = this.database
      .prepare(
        `SELECT s.*,
           (SELECT COUNT(*) FROM research_memo_versions v
            WHERE v.series_id=s.series_id) AS version_count,
           (SELECT memo_version_id FROM research_memo_versions v
            WHERE v.series_id=s.series_id ORDER BY version_no DESC LIMIT 1)
             AS current_memo_version_id
         FROM research_memo_series s
         WHERE s.dataset_id=?
         ORDER BY s.updated_at DESC, s.series_id
         LIMIT ? OFFSET ?`,
      )
      .all(datasetId, page.limit, page.offset)
      .map((raw) => {
        const row = toRecord(raw);
        return {
          seriesId: stringValue(row, "series_id"),
          datasetId: stringValue(row, "dataset_id"),
          seriesKey: stringValue(row, "series_key"),
          topic: stringValue(row, "topic"),
          title: stringValue(row, "title"),
          currentVersionNo: numericValue(row, "current_version_no"),
          currentMemoVersionId: nullableString(row, "current_memo_version_id"),
          versionCount: numericValue(row, "version_count"),
          createdAt: stringValue(row, "created_at"),
          updatedAt: stringValue(row, "updated_at"),
        };
      });
    return pageResult(records, total, page);
  }

  public compareMemoVersions(
    datasetId: string,
    fromVersionId: string,
    toVersionId: string,
  ): {
    readonly fromVersion: MemoVersionRecord;
    readonly toVersion: MemoVersionRecord;
    readonly sectionChanges: readonly MemoSectionChange[];
    readonly itemChanges: readonly ChangeEventRecord[];
  } {
    const fromVersion = this.getMemoVersion(datasetId, fromVersionId);
    const toVersion = this.getMemoVersion(datasetId, toVersionId);
    if (fromVersion.seriesId !== toVersion.seriesId) {
      throw new WorkflowStoreError(
        "Memo versions belong to different series",
        "invalid_argument",
      );
    }
    const left = new Map(
      fromVersion.sections.map((section) => [section.sectionKey, section]),
    );
    const right = new Map(
      toVersion.sections.map((section) => [section.sectionKey, section]),
    );
    const sectionChanges: MemoSectionChange[] = [];
    for (const sectionKey of [...new Set([...left.keys(), ...right.keys()])].sort()) {
      const oldSection = left.get(sectionKey);
      const newSection = right.get(sectionKey);
      const score =
        oldSection === undefined || newSection === undefined
          ? 0
          : similarity(oldSection.content, newSection.content);
      const changeType =
        oldSection === undefined
          ? "added"
          : newSection === undefined
            ? "not_mentioned"
            : score >= 0.985
              ? "unchanged"
              : "changed";
      sectionChanges.push({
        sectionKey,
        title: newSection?.title ?? oldSection?.title ?? sectionKey,
        changeType,
        similarity: score,
        oldContent: oldSection?.content ?? "",
        newContent: newSection?.content ?? "",
        oldEvidenceIds: oldSection?.evidenceIds ?? [],
        newEvidenceIds: newSection?.evidenceIds ?? [],
      });
    }
    const itemChanges = this.database
      .prepare(
        `SELECT change_event.*
         FROM research_change_events AS change_event
         JOIN research_item_versions AS item_version
           ON item_version.item_version_id = change_event.new_version_id
         WHERE change_event.dataset_id = ?
           AND item_version.source_type = 'memo'
           AND item_version.source_id = ?
         ORDER BY change_event.created_at, change_event.change_event_id`,
      )
      .all(datasetId, toVersionId)
      .map((row) => this.changeEvent(toRecord(row)));
    return { fromVersion, toVersion, sectionChanges, itemChanges };
  }

  public deleteMemoVersion(
    datasetId: string,
    memoVersionId: string,
  ): boolean {
    return withTransaction(this.database, () => {
      const row = this.database
        .prepare(
          `SELECT v.series_id FROM research_memo_versions v
           JOIN research_memo_series s ON s.series_id=v.series_id
           WHERE s.dataset_id=? AND v.memo_version_id=?`,
        )
        .get(datasetId, memoVersionId);
      if (row === undefined) {
        return false;
      }
      const seriesId = stringValue(toRecord(row), "series_id");
      this.database
        .prepare(
          `DELETE FROM workflow_store_evidence_references
           WHERE owner_type='memo-section' AND owner_id IN
             (SELECT section_id FROM research_memo_sections WHERE memo_version_id=?)`,
        )
        .run(memoVersionId);
      // Legacy Python tables did not declare foreign keys. Perform the
      // relationship cleanup explicitly so deletion behaves identically for
      // adopted databases and newly created STRICT databases.
      this.database
        .prepare(
          `UPDATE research_memo_versions
           SET revision_of_version_id=NULL
           WHERE revision_of_version_id=?`,
        )
        .run(memoVersionId);
      this.database
        .prepare(
          `DELETE FROM research_memo_sections WHERE memo_version_id=?`,
        )
        .run(memoVersionId);
      this.database
        .prepare(`DELETE FROM research_memo_versions WHERE memo_version_id=?`)
        .run(memoVersionId);
      const latest = this.database
        .prepare(
          `SELECT version_no FROM research_memo_versions
           WHERE series_id=? ORDER BY version_no DESC LIMIT 1`,
        )
        .get(seriesId);
      if (latest === undefined) {
        this.database
          .prepare(`DELETE FROM research_memo_series WHERE series_id=?`)
          .run(seriesId);
      } else {
        this.database
          .prepare(
            `UPDATE research_memo_series
             SET current_version_no=?, updated_at=? WHERE series_id=?`,
          )
          .run(
            numericValue(toRecord(latest), "version_no"),
            this.now(),
            seriesId,
          );
      }
      return true;
    });
  }

  private itemVersion(row: SqlRow): ItemVersionRecord {
    const itemVersionId = stringValue(row, "item_version_id");
    const evidenceIds = this.database
      .prepare(
        `SELECT evidence_id FROM research_item_evidence
         WHERE item_version_id=? ORDER BY evidence_id`,
      )
      .all(itemVersionId)
      .map((entry) => stringValue(toRecord(entry), "evidence_id"));
    return {
      itemVersionId,
      itemId: stringValue(row, "item_id"),
      versionNo: numericValue(row, "version_no"),
      asOfDate: nullableString(row, "as_of_date"),
      sourcePublishedAt: nullableString(row, "source_published_at"),
      observedAt: stringValue(row, "observed_at"),
      sourceType: stringValue(row, "source_type"),
      sourceId: stringValue(row, "source_id"),
      content: stringValue(row, "content"),
      stance: stringValue(row, "stance"),
      state: stringValue(row, "state"),
      valueNumeric:
        row.value_numeric === null ? null : numericValue(row, "value_numeric"),
      valueText: nullableString(row, "value_text"),
      unit: nullableString(row, "unit"),
      period: nullableString(row, "period"),
      scenario: nullableString(row, "scenario"),
      probability: nullableString(row, "probability"),
      impact: stringValue(row, "impact") as TrackingPriority,
      confidence: numericValue(row, "confidence"),
      expectedStart: nullableString(row, "expected_start"),
      expectedEnd: nullableString(row, "expected_end"),
      metadata: decodeJsonObject(row.metadata_json),
      evidenceIds,
      idempotencyKey: nullableString(row, "idempotency_key"),
      createdAt: stringValue(row, "created_at"),
    };
  }

  private item(row: SqlRow): ResearchItemRecord {
    const versionId = nullableString(row, "current_version_id");
    const version =
      versionId === null
        ? null
        : this.database
            .prepare(
              `SELECT * FROM research_item_versions WHERE item_version_id=?`,
            )
            .get(versionId);
    const itemType = stringValue(row, "item_type");
    assertOneOf(itemType, TRACKING_ITEM_TYPES, "itemType");
    return {
      itemId: stringValue(row, "item_id"),
      datasetId: stringValue(row, "dataset_id"),
      itemType,
      canonicalKey: stringValue(row, "canonical_key"),
      title: stringValue(row, "title"),
      status: stringValue(row, "status"),
      currentVersionNo: numericValue(row, "current_version_no"),
      currentVersionId: versionId,
      currentVersion:
        version === undefined ? null : this.itemVersion(toRecord(version)),
      firstSeenAt: stringValue(row, "first_seen_at"),
      lastSeenAt: stringValue(row, "last_seen_at"),
      createdAt: stringValue(row, "created_at"),
      updatedAt: stringValue(row, "updated_at"),
    };
  }

  public appendItemVersion(
    input: AppendItemVersionInput,
  ): {
    readonly item: ResearchItemRecord;
    readonly version: ItemVersionRecord;
    readonly change: ChangeEventRecord | null;
    readonly created: boolean;
  } {
    assertOneOf(input.itemType, TRACKING_ITEM_TYPES, "itemType");
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const canonicalKey = requireText(input.canonicalKey, "canonicalKey", 500);
    const title = requireText(input.title, "title", 500);
    const sourceType = requireText(input.sourceType, "sourceType", 100);
    const sourceId = requireText(input.sourceId, "sourceId", 500);
    const content = requireText(input.content, "content", 100_000);
    const state = requireText(input.state ?? input.status ?? "active", "state", 80);
    const status = requireText(input.status ?? state, "status", 80);
    const stance = requireText(input.stance ?? "neutral", "stance", 80);
    const impact = input.impact ?? "medium";
    assertOneOf(impact, TRACKING_PRIORITIES, "impact");
    const confidence = input.confidence ?? 0.5;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new WorkflowStoreError(
        "confidence must be between 0 and 1",
        "invalid_argument",
      );
    }
    const evidenceIds = normalizeEvidenceIds(input.evidenceIds);
    const observedAt = input.observedAt ?? this.now();
    const idempotencyKey = requireText(
      input.idempotencyKey ??
        stableId(
          "item-version",
          datasetId,
          input.itemType,
          canonicalKey,
          sourceType,
          sourceId,
          content,
        ),
      "idempotencyKey",
      240,
    );

    return withTransaction(this.database, () => {
      const duplicate = this.database
        .prepare(
          `SELECT iv.*
           FROM research_item_versions iv
           JOIN research_items i ON i.item_id=iv.item_id
           WHERE iv.idempotency_key=?
              OR (
                i.dataset_id=? AND i.item_type=? AND i.canonical_key=?
                AND iv.source_type=? AND iv.source_id=? AND iv.content=?
              )
           ORDER BY CASE WHEN iv.idempotency_key=? THEN 0 ELSE 1 END
           LIMIT 1`,
        )
        .get(
          idempotencyKey,
          datasetId,
          input.itemType,
          canonicalKey,
          sourceType,
          sourceId,
          content,
          idempotencyKey,
        );
      if (duplicate !== undefined) {
        const version = this.itemVersion(toRecord(duplicate));
        const item = this.item(
          getRequiredRow(
            this.database,
            `SELECT * FROM research_items WHERE item_id=?`,
            [version.itemId],
            "research item",
          ),
        );
        const changeRow = this.database
          .prepare(
            `SELECT * FROM research_change_events WHERE new_version_id=?
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(version.itemVersionId);
        const existingChange =
          changeRow === undefined
            ? null
            : this.changeEvent(toRecord(changeRow));
        if (version.idempotencyKey === idempotencyKey) {
          const expectedNumeric = numberOrNull(
            input.valueNumeric,
            "valueNumeric",
          );
          const requestedChange = input.change;
          const changeDiffers =
            requestedChange === undefined
              ? existingChange !== null
              : existingChange === null ||
                existingChange.changeType !== requestedChange.changeType ||
                existingChange.materiality !== requestedChange.materiality ||
                existingChange.summary !== requestedChange.summary ||
                encodeJson(existingChange.details) !==
                  encodeJson(requestedChange.details ?? {});
          if (
            item.datasetId !== datasetId ||
            item.itemType !== input.itemType ||
            item.canonicalKey !== canonicalKey ||
            version.asOfDate !== (input.asOfDate ?? null) ||
            version.sourcePublishedAt !==
              (input.sourcePublishedAt ?? null) ||
            (input.observedAt !== undefined &&
              version.observedAt !== observedAt) ||
            version.sourceType !== sourceType ||
            version.sourceId !== sourceId ||
            version.content !== content ||
            version.state !== state ||
            version.stance !== stance ||
            version.valueNumeric !== expectedNumeric ||
            version.valueText !== (input.valueText ?? null) ||
            version.unit !== (input.unit ?? null) ||
            version.period !== (input.period ?? null) ||
            version.scenario !== (input.scenario ?? null) ||
            version.probability !== (input.probability ?? null) ||
            version.impact !== impact ||
            version.confidence !== confidence ||
            version.expectedStart !== (input.expectedStart ?? null) ||
            version.expectedEnd !== (input.expectedEnd ?? null) ||
            encodeJson(version.metadata) !== encodeJson(input.metadata ?? {}) ||
            encodeJson([...version.evidenceIds].sort()) !==
              encodeJson([...evidenceIds].sort()) ||
            changeDiffers
          ) {
            throw new WorkflowStoreError(
              "Item-version idempotency key was reused with different data",
              "conflict",
            );
          }
        }
        return {
          item,
          version,
          change: existingChange,
          created: false,
        };
      }
      const stableItemId = stableId(
        "ri",
        datasetId,
        input.itemType,
        canonicalKey,
      );
      this.database
        .prepare(
          `INSERT OR IGNORE INTO research_items
             (item_id, dataset_id, item_type, canonical_key, title, status,
              current_version_no, current_version_id, first_seen_at, last_seen_at,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)`,
        )
        .run(
          stableItemId,
          datasetId,
          input.itemType,
          canonicalKey,
          title,
          status,
          observedAt,
          observedAt,
          observedAt,
          observedAt,
        );
      const itemRow = getRequiredRow(
        this.database,
        `SELECT * FROM research_items
         WHERE dataset_id=? AND item_type=? AND canonical_key=?`,
        [datasetId, input.itemType, canonicalKey],
        "research item",
      );
      const itemId = stringValue(itemRow, "item_id");
      const oldVersionId = nullableString(itemRow, "current_version_id");
      const versionNo = numericValue(itemRow, "current_version_no") + 1;
      const itemVersionId = stableId(
        "riv",
        itemId,
        versionNo,
        idempotencyKey,
      );
      this.database
        .prepare(
          `INSERT INTO research_item_versions
             (item_version_id, item_id, version_no, as_of_date, source_published_at,
              observed_at, source_type, source_id, content, stance, state,
              value_numeric, value_text, unit, period, scenario, probability, impact,
              confidence, expected_start, expected_end, metadata_json,
              idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          itemVersionId,
          itemId,
          versionNo,
          input.asOfDate ?? null,
          input.sourcePublishedAt ?? null,
          observedAt,
          sourceType,
          sourceId,
          content,
          stance,
          state,
          numberOrNull(input.valueNumeric, "valueNumeric"),
          input.valueText ?? null,
          input.unit ?? null,
          input.period ?? null,
          input.scenario ?? null,
          input.probability ?? null,
          impact,
          confidence,
          input.expectedStart ?? null,
          input.expectedEnd ?? null,
          encodeJson(input.metadata ?? {}),
          idempotencyKey,
          observedAt,
        );
      const evidenceStatement = this.database.prepare(
        `INSERT INTO research_item_evidence
           (item_version_id, evidence_id, relation_type)
         VALUES (?, ?, 'supports')`,
      );
      for (const evidenceId of evidenceIds) {
        evidenceStatement.run(itemVersionId, evidenceId);
      }
      recordEvidenceReferences(
        this.database,
        "research-item-version",
        itemVersionId,
        evidenceIds,
        "supports",
        observedAt,
      );
      this.database
        .prepare(
          `UPDATE research_items
           SET title=?, status=?, current_version_no=?, current_version_id=?,
               last_seen_at=?, updated_at=?
           WHERE item_id=?`,
        )
        .run(
          title,
          status,
          versionNo,
          itemVersionId,
          observedAt,
          observedAt,
          itemId,
        );
      let change: ChangeEventRecord | null = null;
      if (input.change !== undefined) {
        change = this.insertChangeEvent({
          datasetId,
          itemId,
          oldVersionId,
          newVersionId: itemVersionId,
          changeType: input.change.changeType,
          materiality: input.change.materiality,
          summary: input.change.summary,
          ...(input.change.details === undefined
            ? {}
            : { details: input.change.details }),
          createdAt: observedAt,
        });
      }
      const version = this.itemVersion(
        getRequiredRow(
          this.database,
          `SELECT * FROM research_item_versions WHERE item_version_id=?`,
          [itemVersionId],
          "item version",
        ),
      );
      const item = this.item(
        getRequiredRow(
          this.database,
          `SELECT * FROM research_items WHERE item_id=?`,
          [itemId],
          "research item",
        ),
      );
      return { item, version, change, created: true };
    });
  }

  public getItem(datasetId: string, itemId: string): ResearchItemRecord {
    return this.item(
      getRequiredRow(
        this.database,
        `SELECT * FROM research_items WHERE dataset_id=? AND item_id=?`,
        [datasetId, itemId],
        "research item",
      ),
    );
  }

  public listItems(
    datasetId: string,
    options: ListItemsOptions = {},
  ): Page<ResearchItemRecord> {
    const page = pageOptions(options);
    const filters = ["dataset_id=?"];
    const params: (number | string)[] = [datasetId];
    if (options.itemType !== undefined) {
      filters.push("item_type=?");
      params.push(options.itemType);
    }
    if (options.status !== undefined) {
      filters.push("status=?");
      params.push(options.status);
    }
    const where = filters.join(" AND ");
    const total = Number(
      toRecord(
        this.database
          .prepare(`SELECT COUNT(*) AS count FROM research_items WHERE ${where}`)
          .get(...params),
      ).count,
    );
    const records = this.database
      .prepare(
        `SELECT * FROM research_items WHERE ${where}
         ORDER BY updated_at DESC, item_id LIMIT ? OFFSET ?`,
      )
      .all(...params, page.limit, page.offset)
      .map((row) => this.item(toRecord(row)));
    return pageResult(records, total, page);
  }

  public addRelation(
    datasetId: string,
    fromItemId: string,
    toItemId: string,
    relationType: string,
  ): { readonly created: boolean } {
    if (fromItemId === toItemId) {
      throw new WorkflowStoreError(
        "An item cannot relate to itself",
        "invalid_argument",
      );
    }
    return withTransaction(this.database, () => {
      this.getItem(datasetId, fromItemId);
      this.getItem(datasetId, toItemId);
      const result = this.database
        .prepare(
          `INSERT OR IGNORE INTO research_item_relations
             (from_item_id, to_item_id, relation_type, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          fromItemId,
          toItemId,
          requireText(relationType, "relationType", 80),
          this.now(),
        );
      return { created: result.changes === 1 };
    });
  }

  private observation(row: SqlRow): ObservationRecord {
    return {
      observationId: stringValue(row, "observation_id"),
      itemId: stringValue(row, "item_id"),
      itemVersionId: nullableString(row, "item_version_id"),
      sourceType: stringValue(row, "source_type"),
      sourceId: stringValue(row, "source_id"),
      content: stringValue(row, "content"),
      evidenceIds: decodeEvidence(row.evidence_ids_json),
      extracted: decodeJsonObject(row.extracted_json),
      observedAt: stringValue(row, "observed_at"),
      idempotencyKey: nullableString(row, "idempotency_key"),
    };
  }

  public recordObservation(input: {
    readonly datasetId: string;
    readonly itemId: string;
    readonly itemVersionId?: string | null;
    readonly sourceType: string;
    readonly sourceId: string;
    readonly content: string;
    readonly evidenceIds?: readonly string[];
    readonly extracted?: Readonly<Record<string, JsonValue>>;
    readonly observedAt?: string;
    readonly idempotencyKey?: string;
  }): { readonly record: ObservationRecord; readonly created: boolean } {
    const sourceType = requireText(input.sourceType, "sourceType", 100);
    const sourceId = requireText(input.sourceId, "sourceId", 500);
    const content = requireText(input.content, "content", 100_000);
    const evidenceIds = normalizeEvidenceIds(input.evidenceIds);
    const idempotencyKey = requireText(
      input.idempotencyKey ??
        stableId(
          "observation",
          input.itemId,
          sourceType,
          sourceId,
          content,
        ),
      "idempotencyKey",
      240,
    );
    const observedAt = input.observedAt ?? this.now();
    return withTransaction(this.database, () => {
      this.getItem(input.datasetId, input.itemId);
      if (input.itemVersionId !== undefined && input.itemVersionId !== null) {
        const version = this.database
          .prepare(
            `SELECT 1 FROM research_item_versions
             WHERE item_version_id=? AND item_id=?`,
          )
          .get(input.itemVersionId, input.itemId);
        if (version === undefined) {
          throw new WorkflowStoreError(
            "Observation item version does not belong to item",
            "invalid_argument",
          );
        }
      }
      const existing = this.database
        .prepare(
          `SELECT * FROM research_tracking_observations
           WHERE idempotency_key=?
              OR (
                item_id=? AND source_type=? AND source_id=? AND content=?
              )
           ORDER BY CASE WHEN idempotency_key=? THEN 0 ELSE 1 END
           LIMIT 1`,
        )
        .get(
          idempotencyKey,
          input.itemId,
          sourceType,
          sourceId,
          content,
          idempotencyKey,
        );
      if (existing !== undefined) {
        const record = this.observation(toRecord(existing));
        if (
          record.idempotencyKey === idempotencyKey &&
          (record.itemId !== input.itemId ||
            record.itemVersionId !== (input.itemVersionId ?? null) ||
            record.sourceType !== sourceType ||
            record.sourceId !== sourceId ||
            record.content !== content ||
            (input.observedAt !== undefined &&
              record.observedAt !== observedAt) ||
            encodeJson(record.extracted) !== encodeJson(input.extracted ?? {}) ||
            encodeJson([...record.evidenceIds].sort()) !==
              encodeJson([...evidenceIds].sort()))
        ) {
          throw new WorkflowStoreError(
            "Observation idempotency key was reused with different data",
            "conflict",
          );
        }
        return { record, created: false };
      }
      const observationId = stableId("rto", idempotencyKey);
      this.database
        .prepare(
          `INSERT INTO research_tracking_observations
             (observation_id, item_id, item_version_id, source_type, source_id,
              content, evidence_ids_json, extracted_json, observed_at, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          observationId,
          input.itemId,
          input.itemVersionId ?? null,
          sourceType,
          sourceId,
          content,
          encodeJson(evidenceIds),
          encodeJson(input.extracted ?? {}),
          observedAt,
          idempotencyKey,
        );
      recordEvidenceReferences(
        this.database,
        "tracking-observation",
        observationId,
        evidenceIds,
        "supports",
        observedAt,
      );
      return {
        record: this.observation(
          getRequiredRow(
            this.database,
            `SELECT * FROM research_tracking_observations WHERE observation_id=?`,
            [observationId],
            "tracking observation",
          ),
        ),
        created: true,
      };
    });
  }

  private changeEvent(row: SqlRow): ChangeEventRecord {
    return {
      changeEventId: stringValue(row, "change_event_id"),
      datasetId: stringValue(row, "dataset_id"),
      itemId: stringValue(row, "item_id"),
      oldVersionId: nullableString(row, "old_version_id"),
      newVersionId: stringValue(row, "new_version_id"),
      changeType: stringValue(row, "change_type"),
      materiality: stringValue(row, "materiality") as TrackingPriority,
      summary: stringValue(row, "summary"),
      details: decodeJsonObject(row.details_json),
      idempotencyKey: nullableString(row, "idempotency_key"),
      createdAt: stringValue(row, "created_at"),
    };
  }

  private insertChangeEvent(input: {
    readonly datasetId: string;
    readonly itemId: string;
    readonly oldVersionId: string | null;
    readonly newVersionId: string;
    readonly changeType: string;
    readonly materiality: TrackingPriority;
    readonly summary: string;
    readonly details?: Readonly<Record<string, JsonValue>>;
    readonly idempotencyKey?: string;
    readonly createdAt: string;
  }): ChangeEventRecord {
    assertOneOf(input.materiality, TRACKING_PRIORITIES, "materiality");
    const changeType = requireText(input.changeType, "changeType", 100);
    const idempotencyKey = requireText(
      input.idempotencyKey ??
        stableId("change", input.itemId, input.newVersionId, changeType),
      "idempotencyKey",
      240,
    );
    const existing = this.database
      .prepare(
        `SELECT * FROM research_change_events
         WHERE idempotency_key=?
            OR (
              item_id=? AND new_version_id=? AND change_type=?
            )
         ORDER BY CASE WHEN idempotency_key=? THEN 0 ELSE 1 END
         LIMIT 1`,
      )
      .get(
        idempotencyKey,
        input.itemId,
        input.newVersionId,
        changeType,
        idempotencyKey,
      );
    if (existing !== undefined) {
      const record = this.changeEvent(toRecord(existing));
      if (
        record.idempotencyKey === idempotencyKey &&
        (record.datasetId !== input.datasetId ||
          record.itemId !== input.itemId ||
          record.oldVersionId !== input.oldVersionId ||
          record.newVersionId !== input.newVersionId ||
          record.changeType !== changeType ||
          record.materiality !== input.materiality ||
          record.summary !== input.summary ||
          encodeJson(record.details) !== encodeJson(input.details ?? {}))
      ) {
        throw new WorkflowStoreError(
          "Change-event idempotency key was reused with different data",
          "conflict",
        );
      }
      return record;
    }
    const changeEventId = stableId("rce", idempotencyKey);
    this.database
      .prepare(
        `INSERT INTO research_change_events
           (change_event_id, dataset_id, item_id, old_version_id, new_version_id,
            change_type, materiality, summary, details_json, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        changeEventId,
        input.datasetId,
        input.itemId,
        input.oldVersionId,
        input.newVersionId,
        changeType,
        input.materiality,
        requireText(input.summary, "summary", 4_000),
        encodeJson(input.details ?? {}),
        idempotencyKey,
        input.createdAt,
      );
    return this.changeEvent(
      getRequiredRow(
        this.database,
        `SELECT * FROM research_change_events WHERE change_event_id=?`,
        [changeEventId],
        "change event",
      ),
    );
  }

  public recordChangeEvent(input: {
    readonly datasetId: string;
    readonly itemId: string;
    readonly oldVersionId?: string | null;
    readonly newVersionId: string;
    readonly changeType: string;
    readonly materiality: TrackingPriority;
    readonly summary: string;
    readonly details?: Readonly<Record<string, JsonValue>>;
    readonly idempotencyKey?: string;
  }): ChangeEventRecord {
    return withTransaction(this.database, () => {
      this.getItem(input.datasetId, input.itemId);
      const version = this.database
        .prepare(
          `SELECT 1 FROM research_item_versions
           WHERE item_version_id=? AND item_id=?`,
        )
        .get(input.newVersionId, input.itemId);
      if (version === undefined) {
        throw new WorkflowStoreError(
          "New item version does not belong to item",
          "invalid_argument",
        );
      }
      if (input.oldVersionId !== undefined && input.oldVersionId !== null) {
        const oldVersion = this.database
          .prepare(
            `SELECT 1 FROM research_item_versions
             WHERE item_version_id=? AND item_id=?`,
          )
          .get(input.oldVersionId, input.itemId);
        if (oldVersion === undefined) {
          throw new WorkflowStoreError(
            "Old item version does not belong to item",
            "invalid_argument",
          );
        }
      }
      return this.insertChangeEvent({
        datasetId: input.datasetId,
        itemId: input.itemId,
        oldVersionId: input.oldVersionId ?? null,
        newVersionId: input.newVersionId,
        changeType: input.changeType,
        materiality: input.materiality,
        summary: input.summary,
        ...(input.details === undefined ? {} : { details: input.details }),
        ...(input.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: input.idempotencyKey }),
        createdAt: this.now(),
      });
    });
  }

  public getItemTimeline(datasetId: string, itemId: string): ItemTimeline {
    const item = this.getItem(datasetId, itemId);
    const versions = this.database
      .prepare(
        `SELECT * FROM research_item_versions
         WHERE item_id=? ORDER BY version_no`,
      )
      .all(itemId)
      .map((row) => this.itemVersion(toRecord(row)));
    const changes = this.database
      .prepare(
        `SELECT * FROM research_change_events
         WHERE item_id=? ORDER BY created_at, change_event_id`,
      )
      .all(itemId)
      .map((row) => this.changeEvent(toRecord(row)));
    const observations = this.database
      .prepare(
        `SELECT * FROM research_tracking_observations
         WHERE item_id=? ORDER BY observed_at, observation_id`,
      )
      .all(itemId)
      .map((row) => this.observation(toRecord(row)));
    return { item, versions, changes, observations };
  }

  private watchRule(row: SqlRow): WatchRuleRecord {
    const targetType = stringValue(row, "target_type");
    assertOneOf(targetType, [...TRACKING_ITEM_TYPES, "all"] as const, "targetType");
    return {
      ruleId: stringValue(row, "rule_id"),
      datasetId: stringValue(row, "dataset_id"),
      name: stringValue(row, "name"),
      targetType,
      targetItemId: nullableString(row, "target_item_id"),
      query: decodeJsonObject(row.query_json),
      minPriority: stringValue(row, "min_priority") as TrackingPriority,
      frequency: stringValue(row, "frequency"),
      active: numericValue(row, "active") === 1,
      createdAt: stringValue(row, "created_at"),
      updatedAt: stringValue(row, "updated_at"),
    };
  }

  public ensureDefaultWatchRules(datasetId: string): readonly WatchRuleRecord[] {
    const definitions = [
      { targetType: "risk" as const, name: "自动追踪重大风险" },
      { targetType: "catalyst" as const, name: "自动追踪重要催化剂" },
    ];
    return definitions.map((definition) =>
      this.upsertWatchRule({
        datasetId,
        ruleId: stableId("wr", datasetId, definition.targetType, "default"),
        name: definition.name,
        targetType: definition.targetType,
        minPriority: "medium",
        frequency: "on_ingest",
        active: true,
      }),
    );
  }

  public upsertWatchRule(input: UpsertWatchRuleInput): WatchRuleRecord {
    assertOneOf(
      input.targetType,
      [...TRACKING_ITEM_TYPES, "all"] as const,
      "targetType",
    );
    const minPriority = input.minPriority ?? "medium";
    assertOneOf(minPriority, TRACKING_PRIORITIES, "minPriority");
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const name = requireText(input.name, "name", 500);
    const targetItemId = input.targetItemId ?? null;
    if (targetItemId !== null) {
      this.getItem(datasetId, targetItemId);
    }
    const adoptedRule =
      input.ruleId === undefined
        ? this.database
            .prepare(
              `SELECT rule_id FROM research_watch_rules
               WHERE dataset_id=? AND name=? AND target_type=?
                 AND COALESCE(target_item_id, '')=COALESCE(?, '')
               ORDER BY created_at LIMIT 1`,
            )
            .get(datasetId, name, input.targetType, targetItemId)
        : undefined;
    const ruleId =
      input.ruleId ??
      (adoptedRule === undefined
        ? undefined
        : stringValue(toRecord(adoptedRule), "rule_id")) ??
      stableId("wr", datasetId, name, input.targetType, targetItemId);
    const now = this.now();
    return withTransaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO research_watch_rules
             (rule_id, dataset_id, name, target_type, target_item_id, query_json,
              min_priority, frequency, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(rule_id) DO UPDATE SET
             name=excluded.name,
             target_type=excluded.target_type,
             target_item_id=excluded.target_item_id,
             query_json=excluded.query_json,
             min_priority=excluded.min_priority,
             frequency=excluded.frequency,
             active=excluded.active,
             updated_at=excluded.updated_at
           WHERE research_watch_rules.dataset_id=excluded.dataset_id`,
        )
        .run(
          ruleId,
          datasetId,
          name,
          input.targetType,
          targetItemId,
          encodeJson(input.query ?? {}),
          minPriority,
          requireText(input.frequency ?? "on_ingest", "frequency", 100),
          boolInt(input.active ?? true),
          now,
          now,
        );
      return this.watchRule(
        getRequiredRow(
          this.database,
          `SELECT * FROM research_watch_rules
           WHERE dataset_id=? AND rule_id=?`,
          [datasetId, ruleId],
          "watch rule",
        ),
      );
    });
  }

  public listWatchRules(
    datasetId: string,
    options: PageOptions = {},
  ): Page<WatchRuleRecord> {
    const page = pageOptions(options);
    const total = Number(
      toRecord(
        this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM research_watch_rules WHERE dataset_id=?`,
          )
          .get(datasetId),
      ).count,
    );
    const records = this.database
      .prepare(
        `SELECT * FROM research_watch_rules WHERE dataset_id=?
         ORDER BY created_at, rule_id LIMIT ? OFFSET ?`,
      )
      .all(datasetId, page.limit, page.offset)
      .map((row) => this.watchRule(toRecord(row)));
    return pageResult(records, total, page);
  }

  private alert(row: SqlRow): TrackingAlertRecord {
    return {
      alertId: stringValue(row, "alert_id"),
      datasetId: stringValue(row, "dataset_id"),
      ruleId: nullableString(row, "rule_id"),
      itemId: stringValue(row, "item_id"),
      changeEventId: nullableString(row, "change_event_id"),
      alertType: stringValue(row, "alert_type"),
      priority: stringValue(row, "priority") as TrackingPriority,
      title: stringValue(row, "title"),
      summary: stringValue(row, "summary"),
      whyItMatters: stringValue(row, "why_it_matters"),
      evidenceIds: decodeEvidence(row.evidence_ids_json),
      status: stringValue(row, "status") as TrackingAlertStatus,
      dueAt: nullableString(row, "due_at"),
      snoozedUntil: nullableString(row, "snoozed_until"),
      dedupeKey: stringValue(row, "dedupe_key"),
      createdAt: stringValue(row, "created_at"),
      updatedAt: stringValue(row, "updated_at"),
    };
  }

  public createAlert(
    input: CreateTrackingAlertInput,
  ): { readonly record: TrackingAlertRecord; readonly created: boolean } {
    assertOneOf(input.priority, TRACKING_PRIORITIES, "priority");
    const evidenceIds = normalizeEvidenceIds(input.evidenceIds);
    const dedupeKey = requireText(input.dedupeKey, "dedupeKey", 500);
    const now = this.now();
    return withTransaction(this.database, () => {
      this.getItem(input.datasetId, input.itemId);
      const existing = this.database
        .prepare(`SELECT * FROM research_alerts WHERE dedupe_key=?`)
        .get(dedupeKey);
      if (existing !== undefined) {
        const record = this.alert(toRecord(existing));
        if (
          record.datasetId !== input.datasetId ||
          record.ruleId !== (input.ruleId ?? null) ||
          record.itemId !== input.itemId ||
          record.changeEventId !== (input.changeEventId ?? null) ||
          record.alertType !== input.alertType ||
          record.priority !== input.priority ||
          record.title !== input.title ||
          record.summary !== input.summary ||
          encodeJson([...record.evidenceIds].sort()) !==
            encodeJson([...evidenceIds].sort())
        ) {
          throw new WorkflowStoreError(
            "Alert dedupe key was reused with different data",
            "conflict",
          );
        }
        return { record, created: false };
      }
      const alertId = stableId("ral", input.datasetId, dedupeKey);
      this.database
        .prepare(
          `INSERT INTO research_alerts
             (alert_id, dataset_id, rule_id, item_id, change_event_id, alert_type,
              priority, title, summary, why_it_matters, evidence_ids_json, status,
              due_at, snoozed_until, dedupe_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, NULL, ?, ?, ?)`,
        )
        .run(
          alertId,
          input.datasetId,
          input.ruleId ?? null,
          input.itemId,
          input.changeEventId ?? null,
          requireText(input.alertType, "alertType", 100),
          input.priority,
          requireText(input.title, "title", 500),
          requireText(input.summary, "summary", 4_000),
          String(input.whyItMatters ?? ""),
          encodeJson(evidenceIds),
          input.dueAt ?? null,
          dedupeKey,
          now,
          now,
        );
      recordEvidenceReferences(
        this.database,
        "tracking-alert",
        alertId,
        evidenceIds,
        "supports",
        now,
      );
      return {
        record: this.alert(
          getRequiredRow(
            this.database,
            `SELECT * FROM research_alerts WHERE alert_id=?`,
            [alertId],
            "tracking alert",
          ),
        ),
        created: true,
      };
    });
  }

  public transitionAlert(
    datasetId: string,
    alertId: string,
    status: TrackingAlertStatus,
    options: { readonly snoozedUntil?: string | null } = {},
  ): TrackingAlertRecord {
    assertOneOf(status, TRACKING_ALERT_STATUSES, "status");
    let snoozedUntil: string | null = null;
    if (status === "snoozed") {
      const raw = requireText(
        options.snoozedUntil,
        "snoozedUntil",
        80,
      );
      const timestamp = new Date(raw);
      if (!Number.isFinite(timestamp.getTime())) {
        throw new WorkflowStoreError(
          "snoozedUntil must be an ISO-8601 timestamp",
          "invalid_argument",
        );
      }
      snoozedUntil = timestamp.toISOString();
    }
    return withTransaction(this.database, () => {
      const current = this.alert(
        getRequiredRow(
          this.database,
          `SELECT * FROM research_alerts WHERE dataset_id=? AND alert_id=?`,
          [datasetId, alertId],
          "tracking alert",
        ),
      );
      const allowed: Record<TrackingAlertStatus, readonly TrackingAlertStatus[]> = {
        new: ["new", "acknowledged", "dismissed", "snoozed"],
        acknowledged: ["new", "acknowledged", "dismissed", "snoozed"],
        dismissed: ["new", "dismissed"],
        snoozed: ["new", "acknowledged", "dismissed", "snoozed"],
      };
      if (!allowed[current.status].includes(status)) {
        throw new WorkflowStoreError(
          `Alert cannot transition from ${current.status} to ${status}`,
          "invalid_state",
        );
      }
      this.database
        .prepare(
          `UPDATE research_alerts
           SET status=?, snoozed_until=?, updated_at=?
           WHERE dataset_id=? AND alert_id=?`,
        )
        .run(status, snoozedUntil, this.now(), datasetId, alertId);
      return this.alert(
        getRequiredRow(
          this.database,
          `SELECT * FROM research_alerts WHERE alert_id=?`,
          [alertId],
          "tracking alert",
        ),
      );
    });
  }

  public reopenDueAlerts(datasetId: string, at: Date = this.clock()): number {
    const timestamp = nowIso(at);
    return Number(
      this.database
        .prepare(
          `UPDATE research_alerts
           SET status='new', snoozed_until=NULL, updated_at=?
           WHERE dataset_id=? AND status='snoozed'
             AND snoozed_until IS NOT NULL AND snoozed_until<=?`,
        )
        .run(timestamp, datasetId, timestamp).changes,
    );
  }

  public listAlerts(
    datasetId: string,
    options: ListAlertsOptions = {},
  ): Page<TrackingAlertRecord> {
    const page = pageOptions(options);
    const filters = ["dataset_id=?"];
    const params: (number | string)[] = [datasetId];
    if (options.status !== undefined) {
      filters.push("status=?");
      params.push(options.status);
    }
    const where = filters.join(" AND ");
    const total = Number(
      toRecord(
        this.database
          .prepare(`SELECT COUNT(*) AS count FROM research_alerts WHERE ${where}`)
          .get(...params),
      ).count,
    );
    const records = this.database
      .prepare(
        `SELECT * FROM research_alerts WHERE ${where}
         ORDER BY CASE priority
           WHEN 'critical' THEN 3 WHEN 'high' THEN 2
           WHEN 'medium' THEN 1 ELSE 0 END DESC,
           created_at DESC, alert_id
         LIMIT ? OFFSET ?`,
      )
      .all(...params, page.limit, page.offset)
      .map((row) => this.alert(toRecord(row)));
    return pageResult(records, total, page);
  }

  public overview(datasetId: string): {
    readonly datasetId: string;
    readonly counts: Readonly<Record<string, number>>;
    readonly unreadAlertCount: number;
  } {
    const counts: Record<string, number> = {};
    for (const raw of this.database
      .prepare(
        `SELECT item_type, COUNT(*) AS count FROM research_items
         WHERE dataset_id=? GROUP BY item_type`,
      )
      .all(datasetId)) {
      const row = toRecord(raw);
      counts[stringValue(row, "item_type")] = numericValue(row, "count");
    }
    const unreadAlertCount = Number(
      toRecord(
        this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM research_alerts
             WHERE dataset_id=? AND status='new'`,
          )
          .get(datasetId),
      ).count,
    );
    return { datasetId, counts, unreadAlertCount };
  }
}
