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
import { AssetContextRepository } from "./asset-context-repository.js";
import {
  EvidenceRepository,
} from "./evidence-repository.js";
import {
  decodeArray,
  encodeJson,
} from "./json.js";
import type { SqlRow } from "./rows.js";
import {
  nullableString,
  numberValue,
  objectValue,
  stringValue,
} from "./rows.js";
import { withProjectTransaction } from "./transaction.js";
import {
  pageValues,
} from "./documents-repository.js";
import type {
  Page,
  PageOptions,
  ResearchAssetEvidenceReference,
  ResearchAssetRecord,
  ResearchAssetStatus,
  ResearchAssetVersionRecord,
  ResolvedResearchAssetVersion,
  SaveResearchAssetInput,
  SaveResearchAssetResult,
} from "./types.js";

const ASSET_COLUMNS = `
  id,
  asset_type AS assetType,
  title,
  status,
  current_version_id AS currentVersionId,
  current_version_no AS currentVersionNo,
  created_at AS createdAt,
  updated_at AS updatedAt,
  archived_at AS archivedAt,
  deleted_at AS deletedAt
`;

const ASSET_VERSION_COLUMNS = `
  id,
  asset_id AS assetId,
  version_no AS versionNo,
  status,
  summary,
  content_markdown AS contentMarkdown,
  content_hash AS contentHash,
  source_response_id AS sourceResponseId,
  structured_content_json AS structuredContentJson,
  metadata_json AS metadataJson,
  tags_json AS tagsJson,
  created_at AS createdAt
`;

const REFERENCE_COLUMNS = `
  asset_version_id AS assetVersionId,
  evidence_id AS evidenceId,
  relation_type AS relationType,
  quote,
  created_at AS createdAt
`;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mapAsset(row: SqlRow): ResearchAssetRecord {
  return {
    id: stringValue(row, "id"),
    assetType: stringValue(row, "assetType"),
    title: stringValue(row, "title"),
    status: stringValue(row, "status") as ResearchAssetStatus,
    currentVersionId: nullableString(row, "currentVersionId"),
    currentVersionNo: numberValue(row, "currentVersionNo"),
    createdAt: stringValue(row, "createdAt"),
    updatedAt: stringValue(row, "updatedAt"),
    archivedAt: nullableString(row, "archivedAt"),
    deletedAt: nullableString(row, "deletedAt"),
  };
}

function mapAssetVersion(row: SqlRow): ResearchAssetVersionRecord {
  const tags = decodeArray(stringValue(row, "tagsJson"));
  if (!tags.every((tag) => typeof tag === "string")) {
    throw new Error("Stored research asset tags are invalid");
  }
  return {
    id: stringValue(row, "id"),
    assetId: stringValue(row, "assetId"),
    versionNo: numberValue(row, "versionNo"),
    status: stringValue(row, "status") as ResearchAssetStatus,
    summary: stringValue(row, "summary"),
    contentMarkdown: stringValue(row, "contentMarkdown"),
    contentHash: stringValue(row, "contentHash"),
    sourceResponseId: nullableString(row, "sourceResponseId"),
    structuredContent: objectValue(row, "structuredContentJson"),
    metadata: objectValue(row, "metadataJson"),
    tags,
    createdAt: stringValue(row, "createdAt"),
  };
}

function mapReference(row: SqlRow): ResearchAssetEvidenceReference {
  return {
    assetVersionId: stringValue(row, "assetVersionId"),
    evidenceId: stringValue(row, "evidenceId"),
    relationType: stringValue(row, "relationType"),
    quote: nullableString(row, "quote"),
    createdAt: stringValue(row, "createdAt"),
  };
}

function normalizeTags(tags: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const tag of tags) {
    const value = tag.normalize("NFKC").trim().slice(0, 80);
    if (value && !normalized.includes(value)) {
      normalized.push(value);
    }
    if (normalized.length >= 100) {
      break;
    }
  }
  return normalized;
}

function normalizedReferences(
  references: SaveResearchAssetInput["evidence"],
): {
  evidenceId: string;
  relationType: string;
  quote: string | null;
}[] {
  const byKey = new Map<
    string,
    { evidenceId: string; relationType: string; quote: string | null }
  >();
  for (const reference of references ?? []) {
    const evidenceId = reference.evidenceId.trim();
    const relationType = (reference.relationType ?? "supports").trim();
    const quote = reference.quote?.trim().slice(0, 20_000) || null;
    if (!evidenceId || !relationType || relationType.length > 80) {
      throw new RangeError("Research asset evidence reference is invalid");
    }
    const key = `${evidenceId}\0${relationType}`;
    const existing = byKey.get(key);
    if (existing !== undefined && existing.quote !== quote) {
      throw new ConflictError(
        "Duplicate evidence reference has different quotes",
        "asset_reference_conflict",
      );
    }
    byKey.set(key, { evidenceId, relationType, quote });
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.evidenceId.localeCompare(right.evidenceId) ||
      left.relationType.localeCompare(right.relationType),
  );
}

export class ResearchAssetsRepository {
  private readonly database: DatabaseSync;
  private readonly evidence: EvidenceRepository;
  private readonly context: AssetContextRepository;

  public constructor(
    database: ProjectDatabase | DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {
    this.database =
      database instanceof ProjectDatabase ? database.connection : database;
    this.evidence = new EvidenceRepository(database, clock);
    this.context = new AssetContextRepository(database, clock);
  }

  public saveVersion(
    input: SaveResearchAssetInput,
  ): SaveResearchAssetResult {
    const assetType = input.assetType.normalize("NFKC").trim();
    const title = input.title.normalize("NFKC").trim();
    if (!assetType || assetType.length > 80) {
      throw new RangeError("assetType must contain between 1 and 80 characters");
    }
    if (!title || title.length > 500) {
      throw new RangeError("title must contain between 1 and 500 characters");
    }
    if (input.contentMarkdown.length > 1_000_000) {
      throw new RangeError("contentMarkdown must not exceed 1000000 characters");
    }
    const assetId =
      input.assetId ??
      `asset_${hash(`${assetType}\0${title}`).slice(0, 32)}`;
    if (
      assetId.length < 1 ||
      assetId.length > 240 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(assetId)
    ) {
      throw new RangeError("assetId is invalid");
    }
    const status = input.status ?? "completed";
    const summary = (input.summary ?? "").trim().slice(0, 20_000);
    const structuredContent = input.structuredContent ?? {};
    const metadata = input.metadata ?? {};
    const tags = normalizeTags(input.tags ?? []);
    const references = normalizedReferences(input.evidence);
    const revisionHash = hash(
      encodeJson({
        status,
        summary,
        contentMarkdown: input.contentMarkdown,
        sourceResponseId: input.sourceResponseId ?? null,
        structuredContent,
        metadata,
        tags,
        evidence: references,
      }),
    );

    return withProjectTransaction(this.database, () => {
      for (const reference of references) {
        this.evidence.get(reference.evidenceId);
      }
      const existingAsset = this.find(assetId);
      const now = isoNow(this.clock);
      if (existingAsset === null) {
        this.database
          .prepare(
            `INSERT INTO research_assets(
               id, asset_type, title, status, current_version_id,
               current_version_no, created_at, updated_at, archived_at
             ) VALUES (?, ?, ?, ?, NULL, 0, ?, ?, ?)`,
          )
          .run(
            assetId,
            assetType,
            title,
            status,
            now,
            now,
            status === "archived" ? now : null,
          );
      } else if (existingAsset.assetType !== assetType) {
        throw new ConflictError(
          "Research asset type cannot change between versions",
          "asset_type_conflict",
        );
      } else if (existingAsset.deletedAt !== null) {
        throw new ConflictError(
          "A deleted research asset cannot receive new versions",
          "asset_deleted",
        );
      }

      const duplicate = this.database
        .prepare(
          `SELECT ${ASSET_VERSION_COLUMNS}
           FROM research_asset_versions
           WHERE asset_id = ? AND content_hash = ?`,
        )
        .get(assetId, revisionHash);
      if (duplicate !== undefined) {
        const version = mapAssetVersion(duplicate);
        return {
          asset: this.get(assetId),
          version,
          references: this.listEvidenceReferences(version.id),
          created: false,
        };
      }

      const versionNo =
        (this.database
          .prepare(
            `SELECT COALESCE(MAX(version_no), 0) AS maximum
             FROM research_asset_versions
             WHERE asset_id = ?`,
          )
          .get(assetId)?.maximum as number | undefined ?? 0) + 1;
      const versionId = `assetv_${hash(
        `${assetId}\0${String(versionNo)}\0${revisionHash}`,
      ).slice(0, 32)}`;
      this.database
        .prepare(
          `INSERT INTO research_asset_versions(
             id, asset_id, version_no, status, summary, content_markdown,
             content_hash, source_response_id, structured_content_json,
             metadata_json, tags_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          versionId,
          assetId,
          versionNo,
          status,
          summary,
          input.contentMarkdown,
          revisionHash,
          input.sourceResponseId ?? null,
          encodeJson(structuredContent),
          encodeJson(metadata),
          encodeJson(tags),
          now,
        );
      const insertReference = this.database.prepare(
        `INSERT INTO research_asset_evidence(
           asset_version_id, evidence_id, relation_type, quote, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const reference of references) {
        insertReference.run(
          versionId,
          reference.evidenceId,
          reference.relationType,
          reference.quote,
          now,
        );
      }
      this.database
        .prepare(
          `UPDATE research_assets
           SET title = ?, status = ?, current_version_id = ?,
               current_version_no = ?, updated_at = ?,
               archived_at = CASE WHEN ? = 'archived' THEN ? ELSE NULL END
           WHERE id = ?`,
        )
        .run(
          title,
          status,
          versionId,
          versionNo,
          now,
          status,
          now,
          assetId,
        );
      return {
        asset: this.get(assetId),
        version: this.getVersion(versionId),
        references: this.listEvidenceReferences(versionId),
        created: true,
      };
    });
  }

  public find(assetId: string): ResearchAssetRecord | null {
    const row = this.database
      .prepare(
        `SELECT ${ASSET_COLUMNS}
         FROM research_assets
         WHERE id = ?`,
      )
      .get(assetId);
    return row === undefined ? null : mapAsset(row);
  }

  public get(assetId: string): ResearchAssetRecord {
    const asset = this.find(assetId);
    if (asset === null) {
      throw new NotFoundError("Research asset");
    }
    return asset;
  }

  public getVersion(versionId: string): ResearchAssetVersionRecord {
    const row = this.database
      .prepare(
        `SELECT ${ASSET_VERSION_COLUMNS}
         FROM research_asset_versions
         WHERE id = ?`,
      )
      .get(versionId);
    if (row === undefined) {
      throw new NotFoundError("Research asset version");
    }
    return mapAssetVersion(row);
  }

  public getCurrentVersion(
    assetId: string,
  ): ResearchAssetVersionRecord | null {
    const row = this.database
      .prepare(
        `SELECT ${ASSET_VERSION_COLUMNS}
         FROM research_asset_versions
         WHERE id = (
           SELECT current_version_id FROM research_assets WHERE id = ?
         )`,
      )
      .get(assetId);
    return row === undefined ? null : mapAssetVersion(row);
  }

  public resolveVersion(versionId: string): ResolvedResearchAssetVersion {
    const version = this.getVersion(versionId);
    const references = this.listEvidenceReferences(versionId);
    return {
      version,
      references,
      evidence: references.map((reference) =>
        this.evidence.trace(reference.evidenceId),
      ),
    };
  }

  public listEvidenceReferences(
    versionId: string,
  ): ResearchAssetEvidenceReference[] {
    return this.database
      .prepare(
        `SELECT ${REFERENCE_COLUMNS}
         FROM research_asset_evidence
         WHERE asset_version_id = ?
         ORDER BY evidence_id, relation_type`,
      )
      .all(versionId)
      .map(mapReference);
  }

  public list(
    options: PageOptions & {
      readonly status?: ResearchAssetStatus;
      readonly assetType?: string;
    } = {},
  ): Page<ResearchAssetRecord> {
    const { limit, offset } = pageValues(options);
    const clauses: string[] = ["deleted_at IS NULL"];
    const parameters: string[] = [];
    if (options.status !== undefined) {
      clauses.push("status = ?");
      parameters.push(options.status);
    }
    if (options.assetType !== undefined) {
      clauses.push("asset_type = ?");
      parameters.push(options.assetType);
    }
    const where = ` WHERE ${clauses.join(" AND ")}`;
    const totalRow = this.database
      .prepare(`SELECT COUNT(*) AS total FROM research_assets${where}`)
      .get(...parameters)!;
    const items = this.database
      .prepare(
        `SELECT ${ASSET_COLUMNS}
         FROM research_assets${where}
         ORDER BY updated_at DESC, id
         LIMIT ? OFFSET ?`,
      )
      .all(...parameters, limit, offset)
      .map(mapAsset);
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
    assetId: string,
    options: PageOptions = {},
  ): Page<ResearchAssetVersionRecord> {
    this.get(assetId);
    const { limit, offset } = pageValues(options);
    const totalRow = this.database
      .prepare(
        `SELECT COUNT(*) AS total
         FROM research_asset_versions
         WHERE asset_id = ?`,
      )
      .get(assetId)!;
    const items = this.database
      .prepare(
        `SELECT ${ASSET_VERSION_COLUMNS}
         FROM research_asset_versions
         WHERE asset_id = ?
         ORDER BY version_no DESC
         LIMIT ? OFFSET ?`,
      )
      .all(assetId, limit, offset)
      .map(mapAssetVersion);
    const total = numberValue(totalRow, "total");
    return {
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
  }

  public setStatus(
    assetId: string,
    status: ResearchAssetStatus,
  ): ResearchAssetRecord {
    return withProjectTransaction(this.database, () => {
      const current = this.get(assetId);
      if (current.deletedAt !== null) {
        throw new ConflictError(
          "A deleted research asset cannot change status",
          "asset_deleted",
        );
      }
      if (current.status === status) {
        return current;
      }
      const now = isoNow(this.clock);
      this.database
        .prepare(
          `UPDATE research_assets
           SET status = ?, updated_at = ?,
               archived_at = CASE WHEN ? = 'archived' THEN ? ELSE NULL END
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(status, now, status, now, assetId);
      if (status === "archived") {
        this.database
          .prepare(
            `DELETE FROM research_asset_context
             WHERE resource_type = 'research_asset' AND resource_id = ?`,
          )
          .run(assetId);
      }
      this.insertAuditEvent(assetId, "asset.status.changed", {
        previousStatus: current.status,
        status,
      }, now);
      return this.get(assetId);
    });
  }

  public listContext(): string[] {
    return this.context.listIds();
  }

  public replaceContext(assetIds: readonly string[]): string[] {
    return this.context.replace(assetIds);
  }

  public markDeleted(assetId: string): ResearchAssetRecord {
    return withProjectTransaction(this.database, () => {
      const current = this.get(assetId);
      if (current.deletedAt !== null) {
        return current;
      }
      const now = isoNow(this.clock);
      this.database
        .prepare(
          `DELETE FROM research_asset_context
           WHERE resource_type = 'research_asset' AND resource_id = ?`,
        )
        .run(assetId);
      this.database
        .prepare(
          `UPDATE research_assets
           SET status = 'archived', archived_at = COALESCE(archived_at, ?),
               deleted_at = ?, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(now, now, now, assetId);
      this.insertAuditEvent(assetId, "asset.deleted", {
        retainedCurrentVersionId: current.currentVersionId,
        retainedVersionCount: current.currentVersionNo,
      }, now);
      return this.get(assetId);
    });
  }

  private insertAuditEvent(
    assetId: string | null,
    eventType: string,
    payload: Record<string, unknown>,
    createdAt: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO research_asset_audit_events(
           asset_id, event_type, payload_json, created_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(assetId, eventType, encodeJson(payload), createdAt);
  }
}

export {
  mapAsset,
  mapAssetVersion,
  mapReference,
};
