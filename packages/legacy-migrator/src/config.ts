import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { LegacyMigrationError } from "./errors.js";
import {
  isPathWithin,
  requireDestinationPathWithin,
  requireExistingPathWithin,
  requireExistingRoot,
  resolveThroughExistingAncestor,
} from "./path-policy.js";
import { stableSha256 } from "./stable.js";
import { tableExists } from "./sqlite.js";
import type {
  LegacyMigrationConfig,
  LegacyProjectMapping,
  LegacyTenantMapping,
  ResolvedProjectMapping,
} from "./types.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface RegistryProject {
  readonly datasetId: string;
  readonly name: string | null;
  readonly companyName: string | null;
  readonly ticker: string | null;
}

export interface ResolvedMigrationConfig {
  readonly legacyRoot: string;
  readonly destinationDataRoot: string;
  readonly baselinePath: string;
  readonly controlDatabase: string;
  readonly checkpointDatabase: string;
  readonly reportPath: string | null;
  readonly dryRun: boolean;
  readonly configSha256: string;
  readonly projects: readonly ResolvedProjectMapping[];
}

function requiredText(value: unknown, field: string, maximum = 500): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LegacyMigrationError(`${field} is required`, "invalid_config");
  }
  const normalized = value.trim();
  if (normalized.length > maximum || normalized.includes("\0")) {
    throw new LegacyMigrationError(`${field} is invalid`, "invalid_config");
  }
  return normalized;
}

function optionalText(
  value: unknown,
  field: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, field, maximum);
}

function registryProjects(datasetRoot: string): ReadonlyMap<string, RegistryProject> {
  const filename = path.join(datasetRoot, "datasets.sqlite3");
  if (!existsSync(filename)) return new Map();
  const database = new DatabaseSync(filename, {
    allowExtension: false,
    readOnly: true,
    timeout: 5_000,
  });
  try {
    database.exec("PRAGMA query_only=ON");
    if (!tableExists(database, "datasets")) return new Map();
    const columns = new Set(
      database
        .prepare('PRAGMA table_info("datasets")')
        .all()
        .map((row) => String(row.name)),
    );
    if (!columns.has("dataset_id")) {
      throw new LegacyMigrationError(
        `Legacy registry ${filename} has no dataset_id column`,
        "legacy_schema",
      );
    }
    const expression = (column: string): string =>
      columns.has(column) ? `"${column}"` : "NULL";
    const result = new Map<string, RegistryProject>();
    for (const row of database
      .prepare(
        `SELECT dataset_id,
                ${expression("name")} AS name,
                ${expression("company_name")} AS company_name,
                ${expression("company_ticker")} AS company_ticker
         FROM datasets`,
      )
      .all()) {
      const datasetId = String(row.dataset_id ?? "");
      if (!datasetId) {
        throw new LegacyMigrationError(
          `Legacy registry ${filename} contains an empty dataset_id`,
          "legacy_schema",
        );
      }
      result.set(datasetId, {
        datasetId,
        name: typeof row.name === "string" ? row.name : null,
        companyName:
          typeof row.company_name === "string" ? row.company_name : null,
        ticker:
          typeof row.company_ticker === "string" ? row.company_ticker : null,
      });
    }
    return result;
  } finally {
    database.close();
  }
}

function resolveProject(
  legacyRoot: string,
  destinationDataRoot: string,
  tenant: LegacyTenantMapping,
  project: LegacyProjectMapping,
  datasetRoot: string,
  registry: ReadonlyMap<string, RegistryProject>,
): ResolvedProjectMapping {
  const legacyDatasetId = requiredText(
    project.legacyDatasetId,
    "projects[].legacyDatasetId",
    160,
  );
  const projectId = requiredText(project.projectId, "projects[].projectId", 160);
  const defaultProjectRoot = path.join(datasetRoot, legacyDatasetId);
  const requestedProjectRoot =
    project.legacyProjectRoot === undefined
      ? defaultProjectRoot
      : path.isAbsolute(project.legacyProjectRoot)
        ? project.legacyProjectRoot
        : path.join(datasetRoot, project.legacyProjectRoot);
  const legacyProjectRoot = requireExistingPathWithin(
    requestedProjectRoot,
    legacyRoot,
    `legacy project root ${legacyDatasetId}`,
  );
  const requestedCollection =
    project.legacyCollectionDatabase === undefined
      ? path.join(legacyProjectRoot, "meta", "collection.sqlite3")
      : path.isAbsolute(project.legacyCollectionDatabase)
        ? project.legacyCollectionDatabase
        : path.join(legacyProjectRoot, project.legacyCollectionDatabase);
  const legacyCollectionDatabase = requireExistingPathWithin(
    requestedCollection,
    legacyRoot,
    `legacy collection database ${legacyDatasetId}`,
  );
  const registryRow = registry.get(legacyDatasetId);
  const explicitName = optionalText(project.name, "projects[].name", 200);
  const registryName = optionalText(registryRow?.name, "legacy dataset name", 200);
  const name = explicitName ?? registryName;
  if (name === null) {
    throw new LegacyMigrationError(
      `Project ${legacyDatasetId} has no name in its explicit mapping or registry`,
      "mapping_required",
    );
  }
  const dataNamespace = requiredText(
    tenant.dataNamespace,
    "tenants[].dataNamespace",
    36,
  );
  return {
    mappingKey: `${requiredText(tenant.legacyNamespace, "tenants[].legacyNamespace", 200)}:${legacyDatasetId}`,
    legacyNamespace: tenant.legacyNamespace.trim(),
    legacyDatasetId,
    legacyDatasetRoot: datasetRoot,
    legacyProjectRoot,
    legacyCollectionDatabase,
    userId: requiredText(tenant.userId, "tenants[].userId", 320),
    dataNamespace,
    email: optionalText(tenant.email, "tenants[].email", 500),
    projectId,
    name,
    companyName:
      optionalText(project.companyName, "projects[].companyName", 300) ??
      optionalText(registryRow?.companyName, "legacy company name", 300),
    ticker:
      optionalText(project.ticker, "projects[].ticker", 40) ??
      optionalText(registryRow?.ticker, "legacy ticker", 40),
    destinationProjectRoot: path.join(
      destinationDataRoot,
      "users",
      dataNamespace,
      "projects",
      projectId,
    ),
    destinationResearchDatabase: path.join(
      destinationDataRoot,
      "users",
      dataNamespace,
      "projects",
      projectId,
      "data",
      "research.sqlite3",
    ),
    destinationWorkflowDatabase: path.join(
      destinationDataRoot,
      "users",
      dataNamespace,
      "projects",
      projectId,
      "data",
      "research.sqlite3",
    ),
  };
}

function assertUnique(
  values: readonly [string, string][],
  label: string,
): void {
  const owners = new Map<string, string>();
  for (const [value, owner] of values) {
    const previous = owners.get(value);
    if (previous !== undefined) {
      throw new LegacyMigrationError(
        `${label} ${value} is assigned to both ${previous} and ${owner}`,
        "mapping_required",
      );
    }
    owners.set(value, owner);
  }
}

function assertAllDatasetsMapped(
  tenant: LegacyTenantMapping,
  registry: ReadonlyMap<string, RegistryProject>,
): void {
  const mapped = new Set(tenant.projects.map((project) => project.legacyDatasetId));
  const missing = [...registry.keys()].filter((datasetId) => !mapped.has(datasetId));
  if (missing.length > 0) {
    throw new LegacyMigrationError(
      `Legacy namespace ${tenant.legacyNamespace} has unmapped datasets: ${missing.sort().join(", ")}`,
      "mapping_required",
    );
  }
}

export function resolveMigrationConfig(
  config: LegacyMigrationConfig,
): ResolvedMigrationConfig {
  if (config.schemaVersion !== 1 || !Array.isArray(config.tenants)) {
    throw new LegacyMigrationError(
      "Migration config must have schemaVersion 1 and a tenants array",
      "invalid_config",
    );
  }
  if (config.tenants.length === 0) {
    throw new LegacyMigrationError(
      "At least one explicit tenant mapping is required",
      "mapping_required",
    );
  }
  const legacyRoot = requireExistingRoot(config.legacyRoot, "legacyRoot");
  const destinationDataRoot = resolveThroughExistingAncestor(
    requiredText(config.destinationDataRoot, "destinationDataRoot", 8_000),
  );
  if (
    isPathWithin(destinationDataRoot, legacyRoot) ||
    isPathWithin(legacyRoot, destinationDataRoot)
  ) {
    throw new LegacyMigrationError(
      "Legacy and destination roots must not overlap",
      "path_boundary",
    );
  }
  const baselinePath = path.resolve(
    requiredText(config.baselinePath, "baselinePath", 8_000),
  );
  if (!existsSync(baselinePath)) {
    throw new LegacyMigrationError(
      `baselinePath does not exist: ${baselinePath}`,
      "invalid_config",
    );
  }
  const projects: ResolvedProjectMapping[] = [];
  for (const tenant of config.tenants) {
    const namespace = requiredText(
      tenant.legacyNamespace,
      "tenants[].legacyNamespace",
      200,
    );
    const dataNamespace = requiredText(
      tenant.dataNamespace,
      "tenants[].dataNamespace",
      36,
    );
    if (!UUID_PATTERN.test(dataNamespace)) {
      throw new LegacyMigrationError(
        `Explicit destination namespace for ${namespace} is not a UUID`,
        "invalid_config",
      );
    }
    if (!Array.isArray(tenant.projects) || tenant.projects.length === 0) {
      throw new LegacyMigrationError(
        `Legacy namespace ${namespace} has no explicit project mappings`,
        "mapping_required",
      );
    }
    const requestedDatasetRoot = path.isAbsolute(tenant.legacyDatasetRoot)
      ? tenant.legacyDatasetRoot
      : path.join(legacyRoot, tenant.legacyDatasetRoot);
    const datasetRoot = requireExistingPathWithin(
      requestedDatasetRoot,
      legacyRoot,
      `legacy dataset root ${namespace}`,
    );
    const registry = registryProjects(datasetRoot);
    assertAllDatasetsMapped(tenant, registry);
    for (const project of tenant.projects) {
      projects.push(
        resolveProject(
          legacyRoot,
          destinationDataRoot,
          tenant,
          project,
          datasetRoot,
          registry,
        ),
      );
    }
  }
  assertUnique(
    projects.map((project) => [project.mappingKey, project.projectId]),
    "legacy mapping",
  );
  assertUnique(
    projects.map((project) => [project.projectId, project.mappingKey]),
    "destination project ID",
  );
  assertUnique(
    projects.map((project) => [
      project.legacyCollectionDatabase,
      project.mappingKey,
    ]),
    "legacy collection database",
  );

  const namespaceOwners = new Map<string, string>();
  const userNamespaces = new Map<string, string>();
  for (const project of projects) {
    const owner = namespaceOwners.get(project.dataNamespace);
    if (owner !== undefined && owner !== project.userId) {
      throw new LegacyMigrationError(
        `Destination namespace ${project.dataNamespace} has multiple users`,
        "mapping_required",
      );
    }
    namespaceOwners.set(project.dataNamespace, project.userId);
    const namespace = userNamespaces.get(project.userId);
    if (namespace !== undefined && namespace !== project.dataNamespace) {
      throw new LegacyMigrationError(
        `Destination user ${project.userId} has multiple namespaces`,
        "mapping_required",
      );
    }
    userNamespaces.set(project.userId, project.dataNamespace);
  }

  const controlDatabase = requireDestinationPathWithin(
    path.resolve(config.controlDatabase ?? path.join(destinationDataRoot, "control.sqlite3")),
    destinationDataRoot,
    "controlDatabase",
  );
  const checkpointDatabase = requireDestinationPathWithin(
    path.resolve(
      config.checkpointDatabase ??
        path.join(destinationDataRoot, "migration", "legacy-migration.sqlite3"),
    ),
    destinationDataRoot,
    "checkpointDatabase",
  );
  const reportPath =
    config.reportPath === undefined
      ? null
      : requireDestinationPathWithin(
          path.resolve(config.reportPath),
          destinationDataRoot,
          "reportPath",
        );
  for (const project of projects) {
    requireDestinationPathWithin(
      project.destinationProjectRoot,
      destinationDataRoot,
      "destination project root",
    );
  }

  const canonicalForHash = {
    schemaVersion: 1,
    legacyRoot,
    destinationDataRoot,
    baselinePath,
    controlDatabase,
    checkpointDatabase,
    projects: projects.map((project) => ({
      mappingKey: project.mappingKey,
      legacyNamespace: project.legacyNamespace,
      legacyDatasetId: project.legacyDatasetId,
      legacyCollectionDatabase: project.legacyCollectionDatabase,
      userId: project.userId,
      dataNamespace: project.dataNamespace,
      email: project.email,
      projectId: project.projectId,
      name: project.name,
      companyName: project.companyName,
      ticker: project.ticker,
      destinationProjectRoot: project.destinationProjectRoot,
    })),
  };
  return {
    legacyRoot,
    destinationDataRoot,
    baselinePath,
    controlDatabase,
    checkpointDatabase,
    reportPath,
    dryRun: config.dryRun ?? false,
    configSha256: stableSha256(canonicalForHash),
    projects,
  };
}
