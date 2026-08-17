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
import type { SqlRow } from "./rows.js";
import {
  numberValue,
  stringValue,
} from "./rows.js";
import { withProjectTransaction } from "./transaction.js";

export type AssetContextResourceType = "document" | "research_asset";

export interface AssetContextResource {
  readonly resourceType: AssetContextResourceType;
  readonly resourceId: string;
  readonly contextId: string;
  readonly position: number;
  readonly selectedAt: string;
}

const DOCUMENT_CONTEXT_PREFIX = "document:";
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const RESEARCH_ASSET_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;

function databaseConnection(
  database: ProjectDatabase | DatabaseSync,
): DatabaseSync {
  return database instanceof ProjectDatabase
    ? database.connection
    : database;
}

export function parseAssetContextId(
  contextId: string,
): Pick<AssetContextResource, "resourceType" | "resourceId" | "contextId"> {
  if (contextId !== contextId.trim()) {
    throw new DomainError(
      "Asset context ids must not contain surrounding whitespace",
      "invalid_asset_context",
      400,
    );
  }
  if (contextId.startsWith(DOCUMENT_CONTEXT_PREFIX)) {
    const resourceId = contextId.slice(DOCUMENT_CONTEXT_PREFIX.length);
    if (!DOCUMENT_ID_PATTERN.test(resourceId)) {
      throw new DomainError(
        "Document context id is invalid",
        "invalid_asset_context",
        400,
      );
    }
    return {
      resourceType: "document",
      resourceId,
      contextId,
    };
  }
  if (!RESEARCH_ASSET_ID_PATTERN.test(contextId)) {
    throw new DomainError(
      "Research asset context id is invalid",
      "invalid_asset_context",
      400,
    );
  }
  return {
    resourceType: "research_asset",
    resourceId: contextId,
    contextId,
  };
}

export function formatAssetContextId(
  resourceType: AssetContextResourceType,
  resourceId: string,
): string {
  return resourceType === "document"
    ? `${DOCUMENT_CONTEXT_PREFIX}${resourceId}`
    : resourceId;
}

function mapContextResource(row: SqlRow): AssetContextResource {
  const resourceType = stringValue(
    row,
    "resourceType",
  ) as AssetContextResourceType;
  const resourceId = stringValue(row, "resourceId");
  return {
    resourceType,
    resourceId,
    contextId: formatAssetContextId(resourceType, resourceId),
    position: numberValue(row, "position"),
    selectedAt: stringValue(row, "selectedAt"),
  };
}

export class AssetContextRepository {
  private readonly database: DatabaseSync;

  public constructor(
    database: ProjectDatabase | DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {
    this.database = databaseConnection(database);
  }

  public list(): AssetContextResource[] {
    return this.database
      .prepare(
        `SELECT
           c.resource_type AS resourceType,
           c.resource_id AS resourceId,
           c.position,
           c.selected_at AS selectedAt
         FROM research_asset_context AS c
         LEFT JOIN documents AS d
           ON c.resource_type = 'document' AND d.id = c.resource_id
         LEFT JOIN research_assets AS a
           ON c.resource_type = 'research_asset' AND a.id = c.resource_id
         WHERE (
           c.resource_type = 'document'
           AND d.id IS NOT NULL
           AND d.status = 'active'
           AND d.deleted_at IS NULL
         ) OR (
           c.resource_type = 'research_asset'
           AND a.id IS NOT NULL
           AND a.status != 'archived'
           AND a.deleted_at IS NULL
         )
         ORDER BY c.position`,
      )
      .all()
      .map((row) => mapContextResource(row as SqlRow));
  }

  public listIds(): string[] {
    return this.list().map((resource) => resource.contextId);
  }

  public replace(contextIds: readonly string[]): string[] {
    if (contextIds.length > 1_000) {
      throw new DomainError(
        "Asset context cannot contain more than 1000 resources",
        "invalid_asset_context",
        400,
      );
    }
    const resources = contextIds.map(parseAssetContextId);
    const uniqueKeys = new Set(
      resources.map(
        ({ resourceType, resourceId }) => `${resourceType}\0${resourceId}`,
      ),
    );
    if (uniqueKeys.size !== resources.length) {
      throw new DomainError(
        "Asset context ids must not contain duplicates",
        "invalid_asset_context",
        400,
      );
    }

    return withProjectTransaction(this.database, () => {
      for (const resource of resources) {
        this.assertSelectable(resource.resourceType, resource.resourceId);
      }
      const current = this.listIds();
      if (
        current.length === resources.length &&
        current.every(
          (contextId, index) => contextId === resources[index]?.contextId,
        )
      ) {
        return current;
      }

      const now = isoNow(this.clock);
      this.database.prepare("DELETE FROM research_asset_context").run();
      const insert = this.database.prepare(
        `INSERT INTO research_asset_context(
           resource_type, resource_id, position, selected_at
         ) VALUES (?, ?, ?, ?)`,
      );
      for (const [position, resource] of resources.entries()) {
        insert.run(
          resource.resourceType,
          resource.resourceId,
          position,
          now,
        );
      }
      this.database
        .prepare(
          `INSERT INTO research_asset_audit_events(
             asset_id, event_type, payload_json, created_at
           ) VALUES (NULL, 'asset.context.replaced', ?, ?)`,
        )
        .run(
          encodeJson({
            previousAssetIds: current,
            assetIds: resources.map((resource) => resource.contextId),
            previousResourceIds: current,
            resourceIds: resources.map((resource) => resource.contextId),
          }),
          now,
        );
      return this.listIds();
    });
  }

  private assertSelectable(
    resourceType: AssetContextResourceType,
    resourceId: string,
  ): void {
    if (resourceType === "document") {
      const row = this.database
        .prepare(
          `SELECT status, deleted_at AS deletedAt
           FROM documents
           WHERE id = ?`,
        )
        .get(resourceId) as SqlRow | undefined;
      if (row === undefined) {
        throw new NotFoundError("Asset context document");
      }
      if (
        stringValue(row, "status") !== "active" ||
        row.deletedAt !== null
      ) {
        throw new ConflictError(
          "Removed or archived documents cannot be added to context",
          "asset_context_conflict",
        );
      }
      return;
    }

    const row = this.database
      .prepare(
        `SELECT status, deleted_at AS deletedAt
         FROM research_assets
         WHERE id = ?`,
      )
      .get(resourceId) as SqlRow | undefined;
    if (row === undefined) {
      throw new NotFoundError("Asset context research asset");
    }
    if (
      stringValue(row, "status") === "archived" ||
      row.deletedAt !== null
    ) {
      throw new ConflictError(
        "Archived or deleted research assets cannot be added to context",
        "asset_context_conflict",
      );
    }
  }
}
