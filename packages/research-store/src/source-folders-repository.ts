import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { Clock } from "@private-fund/core";
import {
  ConflictError,
  DomainError,
  NotFoundError,
  isoNow,
  systemClock,
} from "@private-fund/core";

import { ProjectDatabase } from "./database.js";
import { encodeJson } from "./json.js";
import {
  nullableString,
  numberValue,
  objectValue,
  stringValue,
  type SqlRow,
} from "./rows.js";
import { withProjectTransaction } from "./transaction.js";

const MAX_FOLDERS = 10_000;
const MAX_TREE_DEPTH = 32;
const FOLDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;

export interface SourceFolderRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly normalizedName: string;
  readonly folderKind: string;
  readonly classificationKey: string | null;
  readonly sortOrder: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface SourceFolderTreeEntry extends SourceFolderRecord {
  readonly depth: number;
  readonly path: readonly string[];
  readonly childCount: number;
  readonly documentCount: number;
}

export interface CreateSourceFolderInput {
  readonly folderId?: string;
  readonly parentId?: string | null;
  readonly name: string;
  readonly folderKind?: string;
  readonly classificationKey?: string | null;
  readonly sortOrder?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface UpdateSourceFolderInput {
  readonly parentId?: string | null;
  readonly name?: string;
  readonly folderKind?: string;
  readonly classificationKey?: string | null;
  readonly sortOrder?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SourceFolderAssignment {
  readonly documentId: string;
  readonly folderId: string;
  readonly assignmentSource: string;
  readonly classificationKey: string | null;
  readonly legacyFileName: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly assignedAt: string;
  readonly updatedAt: string;
}

export interface AssignSourceDocumentInput {
  readonly assignmentSource?: string;
  readonly classificationKey?: string | null;
  readonly legacyFileName?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

const FOLDER_COLUMNS = `
  id,
  parent_id AS parentId,
  name,
  normalized_name AS normalizedName,
  folder_kind AS folderKind,
  classification_key AS classificationKey,
  sort_order AS sortOrder,
  metadata_json AS metadataJson,
  created_at AS createdAt,
  updated_at AS updatedAt,
  deleted_at AS deletedAt
`;

const ASSIGNMENT_COLUMNS = `
  document_id AS documentId,
  folder_id AS folderId,
  assignment_source AS assignmentSource,
  classification_key AS classificationKey,
  legacy_file_name AS legacyFileName,
  metadata_json AS metadataJson,
  assigned_at AS assignedAt,
  updated_at AS updatedAt
`;

function asDatabase(
  value: ProjectDatabase | DatabaseSync,
): DatabaseSync {
  return value instanceof ProjectDatabase ? value.connection : value;
}

function mapFolder(row: SqlRow): SourceFolderRecord {
  return {
    id: stringValue(row, "id"),
    parentId: nullableString(row, "parentId"),
    name: stringValue(row, "name"),
    normalizedName: stringValue(row, "normalizedName"),
    folderKind: stringValue(row, "folderKind"),
    classificationKey: nullableString(row, "classificationKey"),
    sortOrder: numberValue(row, "sortOrder"),
    metadata: objectValue(row, "metadataJson"),
    createdAt: stringValue(row, "createdAt"),
    updatedAt: stringValue(row, "updatedAt"),
    deletedAt: nullableString(row, "deletedAt"),
  };
}

function mapAssignment(row: SqlRow): SourceFolderAssignment {
  return {
    documentId: stringValue(row, "documentId"),
    folderId: stringValue(row, "folderId"),
    assignmentSource: stringValue(row, "assignmentSource"),
    classificationKey: nullableString(row, "classificationKey"),
    legacyFileName: nullableString(row, "legacyFileName"),
    metadata: objectValue(row, "metadataJson"),
    assignedAt: stringValue(row, "assignedAt"),
    updatedAt: stringValue(row, "updatedAt"),
  };
}

export function normalizeSourceFolderName(value: string): {
  readonly name: string;
  readonly normalizedName: string;
} {
  const name = value.normalize("NFKC").replaceAll(/\s+/gu, " ").trim();
  if (
    name.length === 0 ||
    name.length > 200 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new RangeError("Source folder name is invalid");
  }
  return {
    name,
    normalizedName: name.toLocaleLowerCase("en-US"),
  };
}

function identifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!FOLDER_ID.test(normalized)) {
    throw new RangeError(`${field} is invalid`);
  }
  return normalized;
}

function boundedText(
  value: string,
  field: string,
  maximum: number,
): string {
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new RangeError(
      `${field} must contain between 1 and ${String(maximum)} characters`,
    );
  }
  return normalized;
}

function optionalText(
  value: string | null | undefined,
  field: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null || value.trim() === "") {
    return null;
  }
  return boundedText(value, field, maximum);
}

function sortOrder(value: number | undefined): number {
  const normalized = value ?? 0;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < -1_000_000 ||
    normalized > 1_000_000
  ) {
    throw new RangeError("sortOrder is outside the supported range");
  }
  return normalized;
}

function constraintConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}

export class SourceFoldersRepository {
  private readonly database: DatabaseSync;

  public constructor(
    database: ProjectDatabase | DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {
    this.database = asDatabase(database);
  }

  public create(
    input: CreateSourceFolderInput,
  ): { readonly folder: SourceFolderRecord; readonly created: boolean } {
    const parentId =
      input.parentId === undefined || input.parentId === null
        ? null
        : identifier(input.parentId, "parentId");
    const normalized = normalizeSourceFolderName(input.name);
    const folderKind = boundedText(
      input.folderKind ?? "manual",
      "folderKind",
      80,
    );
    const classificationKey = optionalText(
      input.classificationKey,
      "classificationKey",
      240,
    );
    const order = sortOrder(input.sortOrder);
    const metadataJson = encodeJson(input.metadata ?? {});
    const explicitId =
      input.folderId === undefined
        ? null
        : identifier(input.folderId, "folderId");

    return withProjectTransaction(this.database, () => {
      if (parentId !== null) {
        this.get(parentId);
      }
      const natural = this.database
        .prepare(
          `SELECT ${FOLDER_COLUMNS}
           FROM source_folders
           WHERE parent_id IS ? AND normalized_name=? AND deleted_at IS NULL`,
        )
        .get(parentId, normalized.normalizedName);
      if (natural !== undefined) {
        const existing = mapFolder(natural);
        if (
          (explicitId !== null && existing.id !== explicitId) ||
          existing.name !== normalized.name ||
          existing.folderKind !== folderKind ||
          existing.classificationKey !== classificationKey ||
          existing.sortOrder !== order ||
          encodeJson(existing.metadata) !== metadataJson
        ) {
          throw new ConflictError(
            "A source folder with this sibling name already exists",
            "source_folder_name_conflict",
          );
        }
        return { folder: existing, created: false };
      }
      const folderId = explicitId ?? `folder_${randomUUID().replaceAll("-", "")}`;
      const existingById = this.find(folderId, true);
      if (existingById !== null) {
        throw new ConflictError(
          "Source folder ID is already in use",
          "source_folder_id_conflict",
        );
      }
      const timestamp = isoNow(this.clock);
      try {
        this.database
          .prepare(
            `INSERT INTO source_folders(
               id, parent_id, name, normalized_name, folder_kind,
               classification_key, sort_order, metadata_json,
               created_at, updated_at, deleted_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            folderId,
            parentId,
            normalized.name,
            normalized.normalizedName,
            folderKind,
            classificationKey,
            order,
            metadataJson,
            timestamp,
            timestamp,
          );
      } catch (error) {
        if (constraintConflict(error)) {
          throw new ConflictError(
            "Source folder identity or classification key conflicts",
            "source_folder_conflict",
          );
        }
        throw error;
      }
      this.assertDepth(folderId, parentId);
      this.audit(folderId, "created", {
        parentId,
        name: normalized.name,
        folderKind,
        classificationKey,
      });
      return { folder: this.get(folderId), created: true };
    });
  }

  public find(
    folderId: string,
    includeDeleted = false,
  ): SourceFolderRecord | null {
    const row = this.database
      .prepare(
        `SELECT ${FOLDER_COLUMNS}
         FROM source_folders
         WHERE id=? AND (?=1 OR deleted_at IS NULL)`,
      )
      .get(identifier(folderId, "folderId"), includeDeleted ? 1 : 0);
    return row === undefined ? null : mapFolder(row);
  }

  public get(
    folderId: string,
    includeDeleted = false,
  ): SourceFolderRecord {
    const folder = this.find(folderId, includeDeleted);
    if (folder === null) {
      throw new NotFoundError("Source folder");
    }
    return folder;
  }

  public listTree(): readonly SourceFolderTreeEntry[] {
    const rows = this.database
      .prepare(
        `SELECT ${FOLDER_COLUMNS},
                (
                  SELECT COUNT(*) FROM source_folders child
                  WHERE child.parent_id=source_folders.id
                    AND child.deleted_at IS NULL
                ) AS childCount,
                (
                  SELECT COUNT(*) FROM source_folder_assignments assignment
                  WHERE assignment.folder_id=source_folders.id
                ) AS documentCount
         FROM source_folders
         WHERE deleted_at IS NULL
         ORDER BY sort_order, normalized_name, id`,
      )
      .all();
    if (rows.length > MAX_FOLDERS) {
      throw new DomainError(
        "Source folder tree exceeds its configured bound",
        "source_folder_limit_exceeded",
        409,
      );
    }
    const values = rows.map((row) => ({
      folder: mapFolder(row),
      childCount: numberValue(row, "childCount"),
      documentCount: numberValue(row, "documentCount"),
    }));
    const byParent = new Map<string | null, typeof values>();
    for (const value of values) {
      const siblings = byParent.get(value.folder.parentId) ?? [];
      siblings.push(value);
      byParent.set(value.folder.parentId, siblings);
    }
    const result: SourceFolderTreeEntry[] = [];
    const visited = new Set<string>();
    const visit = (
      parentId: string | null,
      parentPath: readonly string[],
      depth: number,
    ): void => {
      if (depth > MAX_TREE_DEPTH) {
        throw new DomainError(
          "Source folder tree exceeds its depth bound",
          "source_folder_depth_exceeded",
          409,
        );
      }
      for (const value of byParent.get(parentId) ?? []) {
        if (visited.has(value.folder.id)) {
          throw new DomainError(
            "Source folder tree contains a cycle",
            "corrupt_database",
            500,
          );
        }
        visited.add(value.folder.id);
        const folderPath = [...parentPath, value.folder.name];
        result.push({
          ...value.folder,
          depth,
          path: folderPath,
          childCount: value.childCount,
          documentCount: value.documentCount,
        });
        visit(value.folder.id, folderPath, depth + 1);
      }
    };
    visit(null, [], 0);
    if (visited.size !== values.length) {
      throw new DomainError(
        "Source folder tree contains an orphan or cycle",
        "corrupt_database",
        500,
      );
    }
    return result;
  }

  public update(
    folderId: string,
    input: UpdateSourceFolderInput,
  ): SourceFolderRecord {
    const normalizedFolderId = identifier(folderId, "folderId");
    return withProjectTransaction(this.database, () => {
      const current = this.get(normalizedFolderId);
      const parentId =
        input.parentId === undefined
          ? current.parentId
          : input.parentId === null
            ? null
            : identifier(input.parentId, "parentId");
      if (parentId === normalizedFolderId) {
        throw new ConflictError(
          "A source folder cannot be its own parent",
          "source_folder_cycle",
        );
      }
      if (parentId !== null) {
        this.get(parentId);
        const descendant = this.database
          .prepare(
            `WITH RECURSIVE descendants(id) AS (
               SELECT id FROM source_folders WHERE id=?
               UNION ALL
               SELECT child.id
               FROM source_folders child
               JOIN descendants parent ON child.parent_id=parent.id
               WHERE child.deleted_at IS NULL
             )
             SELECT 1 FROM descendants WHERE id=? LIMIT 1`,
          )
          .get(normalizedFolderId, parentId);
        if (descendant !== undefined) {
          throw new ConflictError(
            "Moving this source folder would create a cycle",
            "source_folder_cycle",
          );
        }
      }
      const normalized =
        input.name === undefined
          ? {
              name: current.name,
              normalizedName: current.normalizedName,
            }
          : normalizeSourceFolderName(input.name);
      const folderKind =
        input.folderKind === undefined
          ? current.folderKind
          : boundedText(input.folderKind, "folderKind", 80);
      const classificationKey =
        input.classificationKey === undefined
          ? current.classificationKey
          : optionalText(
              input.classificationKey,
              "classificationKey",
              240,
            );
      const order =
        input.sortOrder === undefined
          ? current.sortOrder
          : sortOrder(input.sortOrder);
      const metadata =
        input.metadata === undefined ? current.metadata : input.metadata;
      this.assertDepth(normalizedFolderId, parentId);
      try {
        this.database
          .prepare(
            `UPDATE source_folders
             SET parent_id=?, name=?, normalized_name=?, folder_kind=?,
                 classification_key=?, sort_order=?, metadata_json=?,
                 updated_at=?
             WHERE id=? AND deleted_at IS NULL`,
          )
          .run(
            parentId,
            normalized.name,
            normalized.normalizedName,
            folderKind,
            classificationKey,
            order,
            encodeJson(metadata),
            isoNow(this.clock),
            normalizedFolderId,
          );
      } catch (error) {
        if (constraintConflict(error)) {
          throw new ConflictError(
            "Source folder identity or sibling name conflicts",
            "source_folder_conflict",
          );
        }
        throw error;
      }
      this.audit(normalizedFolderId, "updated", {
        fromParentId: current.parentId,
        toParentId: parentId,
        fromName: current.name,
        toName: normalized.name,
      });
      return this.get(normalizedFolderId);
    });
  }

  public remove(folderId: string): SourceFolderRecord {
    const normalizedFolderId = identifier(folderId, "folderId");
    return withProjectTransaction(this.database, () => {
      this.get(normalizedFolderId);
      const child = this.database
        .prepare(
          `SELECT 1 FROM source_folders
           WHERE parent_id=? AND deleted_at IS NULL LIMIT 1`,
        )
        .get(normalizedFolderId);
      const assignment = this.database
        .prepare(
          `SELECT 1 FROM source_folder_assignments
           WHERE folder_id=? LIMIT 1`,
        )
        .get(normalizedFolderId);
      if (child !== undefined || assignment !== undefined) {
        throw new ConflictError(
          "Source folder must be empty before it can be removed",
          "source_folder_not_empty",
        );
      }
      const timestamp = isoNow(this.clock);
      this.database
        .prepare(
          `UPDATE source_folders
           SET deleted_at=?, updated_at=?
           WHERE id=? AND deleted_at IS NULL`,
        )
        .run(timestamp, timestamp, normalizedFolderId);
      this.audit(normalizedFolderId, "removed", {});
      return this.get(normalizedFolderId, true);
    });
  }

  public assignDocument(
    documentId: string,
    folderId: string,
    input: AssignSourceDocumentInput = {},
  ): {
    readonly assignment: SourceFolderAssignment;
    readonly created: boolean;
  } {
    const normalizedDocumentId = identifier(documentId, "documentId");
    const normalizedFolderId = identifier(folderId, "folderId");
    const assignmentSource = boundedText(
      input.assignmentSource ?? "manual",
      "assignmentSource",
      100,
    );
    const classificationKey = optionalText(
      input.classificationKey,
      "classificationKey",
      240,
    );
    const legacyFileName = optionalText(
      input.legacyFileName,
      "legacyFileName",
      1_000,
    );
    const metadataJson = encodeJson(input.metadata ?? {});
    return withProjectTransaction(this.database, () => {
      if (
        this.database
          .prepare(
            `SELECT 1 FROM documents
             WHERE id=? AND status='active' AND deleted_at IS NULL`,
          )
          .get(normalizedDocumentId) === undefined
      ) {
        throw new NotFoundError("Research document");
      }
      this.get(normalizedFolderId);
      const existing = this.findAssignment(normalizedDocumentId);
      if (
        existing !== null &&
        existing.folderId === normalizedFolderId &&
        existing.assignmentSource === assignmentSource &&
        existing.classificationKey === classificationKey &&
        existing.legacyFileName === legacyFileName &&
        encodeJson(existing.metadata) === metadataJson
      ) {
        return { assignment: existing, created: false };
      }
      const timestamp = isoNow(this.clock);
      this.database
        .prepare(
          `INSERT INTO source_folder_assignments(
             document_id, folder_id, assignment_source, classification_key,
             legacy_file_name, metadata_json, assigned_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(document_id) DO UPDATE SET
             folder_id=excluded.folder_id,
             assignment_source=excluded.assignment_source,
             classification_key=excluded.classification_key,
             legacy_file_name=excluded.legacy_file_name,
             metadata_json=excluded.metadata_json,
             updated_at=excluded.updated_at`,
        )
        .run(
          normalizedDocumentId,
          normalizedFolderId,
          assignmentSource,
          classificationKey,
          legacyFileName,
          metadataJson,
          existing?.assignedAt ?? timestamp,
          timestamp,
        );
      this.audit(normalizedFolderId, existing === null ? "assigned" : "moved", {
        documentId: normalizedDocumentId,
        fromFolderId: existing?.folderId ?? null,
        assignmentSource,
      });
      return {
        assignment: this.getAssignment(normalizedDocumentId),
        created: existing === null,
      };
    });
  }

  public unassignDocument(documentId: string): boolean {
    const normalizedDocumentId = identifier(documentId, "documentId");
    return withProjectTransaction(this.database, () => {
      const existing = this.findAssignment(normalizedDocumentId);
      if (existing === null) {
        return false;
      }
      this.database
        .prepare(
          "DELETE FROM source_folder_assignments WHERE document_id=?",
        )
        .run(normalizedDocumentId);
      this.audit(existing.folderId, "unassigned", {
        documentId: normalizedDocumentId,
      });
      return true;
    });
  }

  public findAssignment(
    documentId: string,
  ): SourceFolderAssignment | null {
    const row = this.database
      .prepare(
        `SELECT ${ASSIGNMENT_COLUMNS}
         FROM source_folder_assignments
         WHERE document_id=?`,
      )
      .get(identifier(documentId, "documentId"));
    return row === undefined ? null : mapAssignment(row);
  }

  public getAssignment(documentId: string): SourceFolderAssignment {
    const assignment = this.findAssignment(documentId);
    if (assignment === null) {
      throw new NotFoundError("Source folder assignment");
    }
    return assignment;
  }

  public listAssignments(
    folderId?: string,
  ): readonly SourceFolderAssignment[] {
    const normalizedFolderId =
      folderId === undefined ? null : identifier(folderId, "folderId");
    if (normalizedFolderId !== null) {
      this.get(normalizedFolderId);
    }
    const rows = this.database
      .prepare(
        `SELECT ${ASSIGNMENT_COLUMNS}
         FROM source_folder_assignments
         WHERE (? IS NULL OR folder_id=?)
         ORDER BY folder_id, document_id
         LIMIT ?`,
      )
      .all(normalizedFolderId, normalizedFolderId, MAX_FOLDERS + 1);
    if (rows.length > MAX_FOLDERS) {
      throw new DomainError(
        "Source folder assignments exceed their configured bound",
        "source_folder_limit_exceeded",
        409,
      );
    }
    return rows.map(mapAssignment);
  }

  private assertDepth(folderId: string, parentId: string | null): void {
    const ancestorDepth =
      parentId === null
        ? 0
        : Number(
            this.database
              .prepare(
                `WITH RECURSIVE ancestors(id, parent_id, depth) AS (
                   SELECT id, parent_id, 1
                   FROM source_folders
                   WHERE id=? AND deleted_at IS NULL
                   UNION ALL
                   SELECT parent.id, parent.parent_id, child.depth + 1
                   FROM source_folders parent
                   JOIN ancestors child ON child.parent_id=parent.id
                   WHERE parent.deleted_at IS NULL
                 )
                 SELECT COALESCE(MAX(depth), 0) AS depth FROM ancestors`,
              )
              .get(parentId)?.depth ?? 0,
          );
    const subtreeDepth = Number(
      this.database
        .prepare(
          `WITH RECURSIVE descendants(id, depth) AS (
             SELECT id, 1 FROM source_folders WHERE id=?
             UNION ALL
             SELECT child.id, parent.depth + 1
             FROM source_folders child
             JOIN descendants parent ON child.parent_id=parent.id
             WHERE child.deleted_at IS NULL
           )
           SELECT COALESCE(MAX(depth), 1) AS depth FROM descendants`,
        )
        .get(folderId)?.depth ?? 1,
    );
    if (ancestorDepth + subtreeDepth > MAX_TREE_DEPTH) {
      throw new ConflictError(
        `Source folder nesting may not exceed ${String(MAX_TREE_DEPTH)} levels`,
        "source_folder_depth_exceeded",
      );
    }
  }

  private audit(
    folderId: string,
    eventType: string,
    payload: Readonly<Record<string, unknown>>,
  ): void {
    this.database
      .prepare(
        `INSERT INTO source_folder_audit_events(
           folder_id, event_type, payload_json, created_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(folderId, eventType, encodeJson(payload), isoNow(this.clock));
  }
}
