import type { DatabaseSync } from "node:sqlite";

export interface CatalogProject {
  readonly tenantId: string;
  readonly tenantNamespace: string;
  readonly projectId: string;
  readonly datasetId: string;
}

export interface ObsidianProjectCatalog {
  listProjects(): readonly CatalogProject[];
}

type Row = Record<string, unknown>;

function requiredText(row: Row, key: string): string {
  const value = row[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 240 ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new Error(`Control catalog column ${key} is invalid`);
  }
  return value;
}

export class SqliteObsidianProjectCatalog implements ObsidianProjectCatalog {
  public constructor(private readonly database: DatabaseSync) {}

  public listProjects(): readonly CatalogProject[] {
    return this.database
      .prepare(
        `SELECT u.id AS tenant_id,
                u.data_namespace AS tenant_namespace,
                p.id AS project_id
         FROM projects AS p
         JOIN users AS u ON u.id=p.user_id
         ORDER BY u.data_namespace, p.id`,
      )
      .all()
      .map((raw) => {
        const row = raw as Row;
        const projectId = requiredText(row, "project_id");
        return {
          tenantId: requiredText(row, "tenant_id"),
          tenantNamespace: requiredText(row, "tenant_namespace"),
          projectId,
          datasetId: projectId,
        };
      });
  }
}
