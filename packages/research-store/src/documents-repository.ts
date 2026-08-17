import { createHash } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { Clock } from "@private-fund/core";
import {
  ConflictError,
  NotFoundError,
  assertPathWithin,
  isoNow,
  systemClock,
} from "@private-fund/core";

import { ProjectDatabase } from "./database.js";
import { encodeJson } from "./json.js";
import type { SqlRow } from "./rows.js";
import {
  nullableString,
  numberValue,
  objectValue,
  stringValue,
} from "./rows.js";
import { withProjectTransaction } from "./transaction.js";
import type {
  DocumentLifecycle,
  DocumentRecord,
  DocumentStatus,
  DocumentVersionRecord,
  DocumentVersionStatus,
  Page,
  PageOptions,
  RegisterDocumentVersionInput,
  RegisterDocumentVersionResult,
  RemoveDocumentsResult,
} from "./types.js";

const DOCUMENT_COLUMNS = `
  id,
  logical_key AS logicalKey,
  source_root AS sourceRoot,
  source_relpath AS sourceRelpath,
  title,
  status,
  current_version_id AS currentVersionId,
  current_version_no AS currentVersionNo,
  metadata_json AS metadataJson,
  created_at AS createdAt,
  updated_at AS updatedAt,
  deleted_at AS deletedAt
`;

const VERSION_COLUMNS = `
  id,
  document_id AS documentId,
  version_no AS versionNo,
  supersedes_version_id AS supersedesVersionId,
  sha256,
  original_filename AS originalFilename,
  stored_path AS storedPath,
  file_type AS fileType,
  mime_type AS mimeType,
  file_size AS fileSize,
  status,
  lifecycle,
  parser_name AS parserName,
  parser_version AS parserVersion,
  metadata_json AS metadataJson,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeDocumentSourceRelpath(value: string): string {
  const components = value
    .normalize("NFKC")
    .replaceAll("\\", "/")
    .split("/")
    .filter((component) => component.length > 0 && component !== ".");
  if (components.some((component) => component === "..")) {
    throw new RangeError("sourceRelpath must not contain parent traversal");
  }
  const normalized = components.join("/");
  if (!normalized || normalized.length > 4_000) {
    throw new RangeError(
      "sourceRelpath must contain between 1 and 4000 characters",
    );
  }
  return normalized;
}

function mapDocument(row: SqlRow): DocumentRecord {
  return {
    id: stringValue(row, "id"),
    logicalKey: stringValue(row, "logicalKey"),
    sourceRoot: nullableString(row, "sourceRoot"),
    sourceRelpath: stringValue(row, "sourceRelpath"),
    title: stringValue(row, "title"),
    status: stringValue(row, "status") as DocumentStatus,
    currentVersionId: nullableString(row, "currentVersionId"),
    currentVersionNo: numberValue(row, "currentVersionNo"),
    metadata: objectValue(row, "metadataJson"),
    createdAt: stringValue(row, "createdAt"),
    updatedAt: stringValue(row, "updatedAt"),
    deletedAt: nullableString(row, "deletedAt"),
  };
}

function mapVersion(row: SqlRow): DocumentVersionRecord {
  return {
    id: stringValue(row, "id"),
    documentId: stringValue(row, "documentId"),
    versionNo: numberValue(row, "versionNo"),
    supersedesVersionId: nullableString(row, "supersedesVersionId"),
    sha256: stringValue(row, "sha256"),
    originalFilename: stringValue(row, "originalFilename"),
    storedPath: stringValue(row, "storedPath"),
    fileType: stringValue(row, "fileType"),
    mimeType: nullableString(row, "mimeType"),
    fileSize: numberValue(row, "fileSize"),
    status: stringValue(row, "status") as DocumentVersionStatus,
    lifecycle: stringValue(row, "lifecycle") as DocumentLifecycle,
    parserName: nullableString(row, "parserName"),
    parserVersion: nullableString(row, "parserVersion"),
    metadata: objectValue(row, "metadataJson"),
    createdAt: stringValue(row, "createdAt"),
    updatedAt: stringValue(row, "updatedAt"),
  };
}

function pageValues(options: PageOptions): {
  limit: number;
  offset: number;
} {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError("limit must contain between 1 and 500 rows");
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("offset must be a non-negative integer");
  }
  return { limit, offset };
}

function asDatabase(
  value: ProjectDatabase | DatabaseSync,
): {
  connection: DatabaseSync;
  projectRoot: string | null;
} {
  return value instanceof ProjectDatabase
    ? { connection: value.connection, projectRoot: value.projectRoot }
    : { connection: value, projectRoot: null };
}

export class DocumentsRepository {
  private readonly database: DatabaseSync;
  private readonly projectRoot: string | null;

  public constructor(
    database: ProjectDatabase | DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {
    const resolved = asDatabase(database);
    this.database = resolved.connection;
    this.projectRoot = resolved.projectRoot;
  }

  public registerVersion(
    input: RegisterDocumentVersionInput,
  ): RegisterDocumentVersionResult {
    const sourceRelpath = normalizeDocumentSourceRelpath(input.sourceRelpath);
    const logicalKey = (input.logicalKey ?? `path:${sourceRelpath}`).trim();
    if (!logicalKey || logicalKey.length > 1_000) {
      throw new RangeError("logicalKey must contain between 1 and 1000 characters");
    }
    const documentId =
      input.documentId ?? `doc_${hash(logicalKey).slice(0, 32)}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(documentId)) {
      throw new RangeError("documentId is invalid");
    }
    const sha256 = input.sha256.toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new RangeError("sha256 must be a 64-character hexadecimal digest");
    }
    const title = input.title.trim();
    const originalFilename = input.originalFilename.trim();
    const fileType = input.fileType.trim().toLowerCase().replace(/^\./, "");
    if (!title || title.length > 500) {
      throw new RangeError("title must contain between 1 and 500 characters");
    }
    if (!originalFilename || originalFilename.length > 1_000) {
      throw new RangeError(
        "originalFilename must contain between 1 and 1000 characters",
      );
    }
    if (!fileType || fileType.length > 100) {
      throw new RangeError("fileType must contain between 1 and 100 characters");
    }
    if (!Number.isSafeInteger(input.fileSize) || input.fileSize < 0) {
      throw new RangeError("fileSize must be a non-negative integer");
    }
    const storedPath =
      this.projectRoot === null
        ? input.storedPath
        : assertPathWithin(
            path.isAbsolute(input.storedPath)
              ? path.resolve(input.storedPath)
              : path.resolve(this.projectRoot, input.storedPath),
            this.projectRoot,
          );
    if (!storedPath || storedPath.length > 8_000) {
      throw new RangeError("storedPath must contain between 1 and 8000 characters");
    }
    const metadataJson = encodeJson(input.metadata ?? {});
    const status = input.status ?? "indexed";
    const activate =
      input.activate ??
      ["indexed", "needs_ocr", "review_required"].includes(status);

    return withProjectTransaction(this.database, () => {
      const existingDocument = this.findByLogicalKey(logicalKey);
      if (
        existingDocument !== null &&
        existingDocument.id !== documentId
      ) {
        throw new ConflictError(
          "logicalKey is already assigned to another document",
          "logical_document_conflict",
        );
      }
      const now = isoNow(this.clock);
      if (existingDocument === null) {
        this.database
          .prepare(
            `INSERT INTO documents(
               id, logical_key, source_root, source_relpath, title, status,
               current_version_id, current_version_no, metadata_json,
               created_at, updated_at, deleted_at
             ) VALUES (?, ?, ?, ?, ?, 'active', NULL, 0, ?, ?, ?, NULL)`,
          )
          .run(
            documentId,
            logicalKey,
            input.sourceRoot ?? null,
            sourceRelpath,
            title,
            metadataJson,
            now,
            now,
          );
      } else {
        this.database
          .prepare(
            `UPDATE documents
             SET source_root = ?, source_relpath = ?, title = ?,
                 metadata_json = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            input.sourceRoot === undefined
              ? existingDocument.sourceRoot
              : input.sourceRoot,
            sourceRelpath,
            title,
            metadataJson,
            now,
            documentId,
          );
      }

      const duplicate = this.database
        .prepare(
          `SELECT ${VERSION_COLUMNS}
           FROM document_versions
           WHERE document_id = ? AND sha256 = ?
           ORDER BY version_no
           LIMIT 1`,
        )
        .get(documentId, sha256);
      if (duplicate !== undefined) {
        return {
          document: this.getById(documentId),
          version: mapVersion(duplicate),
          created: false,
        };
      }

      const latest = this.database
        .prepare(
          `SELECT ${VERSION_COLUMNS}
           FROM document_versions
           WHERE document_id = ?
           ORDER BY version_no DESC
           LIMIT 1`,
        )
        .get(documentId);
      const versionNo =
        latest === undefined ? 1 : numberValue(latest, "versionNo") + 1;
      const supersedesVersionId =
        latest === undefined ? null : stringValue(latest, "id");
      const versionId = `ver_${hash(
        `${documentId}\0${String(versionNo)}\0${sha256}`,
      ).slice(0, 32)}`;
      const lifecycle: DocumentLifecycle = activate
        ? "active"
        : status === "failed"
          ? "failed_attempt"
          : "pending";
      this.database
        .prepare(
          `INSERT INTO document_versions(
             id, document_id, version_no, supersedes_version_id, sha256,
             original_filename, stored_path, file_type, mime_type, file_size,
             status, lifecycle, parser_name, parser_version, metadata_json,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          versionId,
          documentId,
          versionNo,
          supersedesVersionId,
          sha256,
          originalFilename,
          storedPath,
          fileType,
          input.mimeType ?? null,
          input.fileSize,
          status,
          lifecycle,
          input.parserName ?? null,
          input.parserVersion ?? null,
          metadataJson,
          now,
          now,
        );
      if (activate) {
        this.activateVersionInternal(documentId, versionId, versionNo, now);
      }
      return {
        document: this.getById(documentId),
        version: this.getVersion(versionId),
        created: true,
      };
    });
  }

  public updateVersionStatus(
    versionId: string,
    status: DocumentVersionStatus,
    options: {
      readonly activate?: boolean;
      readonly metadata?: Record<string, unknown>;
    } = {},
  ): DocumentVersionRecord {
    return withProjectTransaction(this.database, () => {
      const current = this.getVersion(versionId);
      const document = this.getById(current.documentId);
      const now = isoNow(this.clock);
      const activate =
        options.activate ??
        ["indexed", "needs_ocr", "review_required"].includes(status);
      if (activate && document.status === "removed") {
        throw new ConflictError(
          "Removed documents cannot activate a version",
          "document_removed",
        );
      }
      this.database
        .prepare(
          `UPDATE document_versions
           SET status = ?,
               lifecycle = CASE
                 WHEN ? THEN 'removed'
                 WHEN ? THEN 'active'
                 WHEN ? = 'failed' THEN 'failed_attempt'
                 ELSE lifecycle
               END,
               metadata_json = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          status,
          document.status === "removed" ? 1 : 0,
          activate ? 1 : 0,
          status,
          options.metadata === undefined
            ? encodeJson(current.metadata)
            : encodeJson(options.metadata),
          now,
          versionId,
        );
      if (activate) {
        this.activateVersionInternal(
          current.documentId,
          versionId,
          current.versionNo,
          now,
        );
      }
      return this.getVersion(versionId);
    });
  }

  public getById(documentId: string): DocumentRecord {
    const row = this.database
      .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = ?`)
      .get(documentId);
    if (row === undefined) {
      throw new NotFoundError("Document");
    }
    return mapDocument(row);
  }

  public findByLogicalKey(logicalKey: string): DocumentRecord | null {
    const row = this.database
      .prepare(
        `SELECT ${DOCUMENT_COLUMNS}
         FROM documents
         WHERE logical_key = ?`,
      )
      .get(logicalKey);
    return row === undefined ? null : mapDocument(row);
  }

  public getVersion(versionId: string): DocumentVersionRecord {
    const row = this.database
      .prepare(
        `SELECT ${VERSION_COLUMNS}
         FROM document_versions
         WHERE id = ?`,
      )
      .get(versionId);
    if (row === undefined) {
      throw new NotFoundError("Document version");
    }
    return mapVersion(row);
  }

  public getCurrentVersion(documentId: string): DocumentVersionRecord | null {
    const row = this.database
      .prepare(
        `SELECT ${VERSION_COLUMNS}
         FROM document_versions
         WHERE id = (
           SELECT current_version_id FROM documents WHERE id = ?
         )`,
      )
      .get(documentId);
    return row === undefined ? null : mapVersion(row);
  }

  public list(
    options: PageOptions & { readonly status?: DocumentStatus } = {},
  ): Page<DocumentRecord> {
    const { limit, offset } = pageValues(options);
    const where = options.status === undefined ? "" : " WHERE status = ?";
    const parameters =
      options.status === undefined ? [] : [options.status];
    const totalRow = this.database
      .prepare(`SELECT COUNT(*) AS total FROM documents${where}`)
      .get(...parameters)!;
    const items = this.database
      .prepare(
        `SELECT ${DOCUMENT_COLUMNS}
         FROM documents${where}
         ORDER BY updated_at DESC, id
         LIMIT ? OFFSET ?`,
      )
      .all(...parameters, limit, offset)
      .map(mapDocument);
    const total = numberValue(totalRow, "total");
    return {
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
  }

  public listVersions(
    documentId: string,
    options: PageOptions = {},
  ): Page<DocumentVersionRecord> {
    this.getById(documentId);
    const { limit, offset } = pageValues(options);
    const totalRow = this.database
      .prepare(
        `SELECT COUNT(*) AS total
         FROM document_versions
         WHERE document_id = ?`,
      )
      .get(documentId)!;
    const items = this.database
      .prepare(
        `SELECT ${VERSION_COLUMNS}
         FROM document_versions
         WHERE document_id = ?
         ORDER BY version_no DESC
         LIMIT ? OFFSET ?`,
      )
      .all(documentId, limit, offset)
      .map(mapVersion);
    const total = numberValue(totalRow, "total");
    return {
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
  }

  public markRemoved(documentId: string): DocumentRecord {
    return this.markRemovedMany([documentId]).documents[0]!;
  }

  public markRemovedMany(
    documentIds: readonly string[],
  ): RemoveDocumentsResult {
    if (documentIds.length < 1 || documentIds.length > 500) {
      throw new RangeError(
        "documentIds must contain between 1 and 500 identifiers",
      );
    }
    if (new Set(documentIds).size !== documentIds.length) {
      throw new RangeError("documentIds must not contain duplicates");
    }
    return withProjectTransaction(this.database, () => {
      const current = documentIds.map((documentId) =>
        this.getById(documentId),
      );
      const now = isoNow(this.clock);
      const deletedDocumentIds: string[] = [];
      const alreadyRemovedDocumentIds: string[] = [];
      for (const document of current) {
        if (document.status === "removed") {
          alreadyRemovedDocumentIds.push(document.id);
          continue;
        }
        this.database
          .prepare(
            `UPDATE document_versions
             SET lifecycle = 'removed', updated_at = ?
             WHERE document_id = ? AND lifecycle <> 'removed'`,
          )
          .run(now, document.id);
        this.database
          .prepare(
            `UPDATE documents
             SET status = 'removed', current_version_id = NULL,
                 current_version_no = 0, updated_at = ?, deleted_at = ?
             WHERE id = ?`,
          )
          .run(now, now, document.id);
        this.database
          .prepare(
            `DELETE FROM research_asset_context
             WHERE resource_type = 'document' AND resource_id = ?`,
          )
          .run(document.id);
        deletedDocumentIds.push(document.id);
      }
      return {
        documents: documentIds.map((documentId) =>
          this.getById(documentId),
        ),
        deletedDocumentIds,
        alreadyRemovedDocumentIds,
      };
    });
  }

  private activateVersionInternal(
    documentId: string,
    versionId: string,
    versionNo: number,
    timestamp: string,
  ): void {
    this.database
      .prepare(
        `UPDATE document_versions
         SET lifecycle = 'superseded', updated_at = ?
         WHERE document_id = ? AND id <> ? AND lifecycle = 'active'`,
      )
      .run(timestamp, documentId, versionId);
    this.database
      .prepare(
        `UPDATE document_versions
         SET lifecycle = 'active', updated_at = ?
         WHERE id = ?`,
      )
      .run(timestamp, versionId);
    this.database
      .prepare(
        `UPDATE documents
         SET status = 'active', current_version_id = ?,
             current_version_no = ?, updated_at = ?, deleted_at = NULL
         WHERE id = ?`,
      )
      .run(versionId, versionNo, timestamp, documentId);
  }
}

export {
  mapDocument,
  mapVersion,
  pageValues,
};
