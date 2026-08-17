import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  openProjectDatabase,
  type ProjectDatabase,
} from "@private-fund/research-store";
import { createWorkflowStore } from "@private-fund/workflow-store";

import { writeLegacyAgentRunReconciliation } from "./agent-run-reconciliation.js";
import { loadBaseline } from "./baseline.js";
import {
  migrateLegacyBusinessJobs,
  plannedLegacyBusinessJobReports,
  reconcileLegacyBusinessJobs,
} from "./business-job-migration.js";
import { MigrationCheckpointStore } from "./checkpoint.js";
import {
  ensureControlMapping,
  preflightControlMapping,
  verifyControlMapping,
} from "./control.js";
import { resolveMigrationConfig } from "./config.js";
import { WORKFLOW_DOMAIN_TABLES } from "./domain-tables.js";
import { errorMessage } from "./errors.js";
import {
  migrateFiles,
  preflightFiles,
  reconcileFiles,
} from "./files.js";
import {
  assertDestinationManifest,
  createMigrationManifest,
  writeMigrationManifest,
  type MigrationManifest,
} from "./manifest.js";
import { prepareDestinationDirectory } from "./path-policy.js";
import {
  plannedTableReports,
  reconcileMigratedDatabase,
  reconcileNormalizedResearch,
  researchPhaseTables,
  workflowPhaseTables,
} from "./reconcile.js";
import {
  closeLegacyDatabase,
  inspectSource,
  openLegacyDatabase,
  type SourceInspection,
} from "./source.js";
import {
  createConsistentSnapshot,
  makeDatabasePublishable,
  prepareStagingPath,
  publishDatabaseWithoutOverwrite,
  rewriteStagingIdentity,
  verifySnapshot,
} from "./snapshot.js";
import {
  migrationId,
  stableJson,
  stableSha256,
} from "./stable.js";
import type {
  BaselineCoverage,
  LegacyMigrationConfig,
  LegacyMigrationReport,
  LegacyMigrationResult,
  MigrationPhase,
  PhaseReport,
  ProjectMigrationReport,
  ResolvedProjectMapping,
  RunLegacyMigrationOptions,
  TableReconciliation,
} from "./types.js";

interface PhaseContents {
  readonly tables?: readonly TableReconciliation[];
  readonly files?: PhaseReport["files"];
  readonly warnings?: readonly string[];
}

interface ExecutionContext {
  readonly checkpoint: MigrationCheckpointStore;
  readonly checkpointConfigSha256: string;
  readonly sourceFingerprint: string;
  readonly mapping: ResolvedProjectMapping;
  readonly options: RunLegacyMigrationOptions;
  readonly now: () => string;
  readonly reports: PhaseReport[];
}

const MIGRATION_IMPLEMENTATION_VERSION = 2;

function isoNow(options: RunLegacyMigrationOptions): string {
  return (options.now?.() ?? new Date()).toISOString();
}

function completedPhase(
  phase: MigrationPhase,
  attempt: number,
  startedAt: string,
  completedAt: string,
  contents: PhaseContents,
): PhaseReport {
  return {
    phase,
    status: "completed",
    attempt,
    startedAt,
    completedAt,
    tables: contents.tables ?? [],
    files: contents.files ?? [],
    warnings: contents.warnings ?? [],
    error: null,
  };
}

function failedPhase(
  phase: MigrationPhase,
  attempt: number,
  startedAt: string,
  completedAt: string,
  error: unknown,
): PhaseReport {
  return {
    phase,
    status: "failed",
    attempt,
    startedAt,
    completedAt,
    tables: [],
    files: [],
    warnings: [],
    error: errorMessage(error),
  };
}

function plannedPhase(
  phase: MigrationPhase,
  timestamp: string,
  contents: PhaseContents = {},
): PhaseReport {
  return {
    phase,
    status: "planned",
    attempt: 0,
    startedAt: timestamp,
    completedAt: timestamp,
    tables: contents.tables ?? [],
    files: contents.files ?? [],
    warnings: contents.warnings ?? [],
    error: null,
  };
}

async function checkpointedPhase(
  context: ExecutionContext,
  phase: MigrationPhase,
  verifyCompleted: () => void | Promise<void>,
  action: () => PhaseContents | Promise<PhaseContents>,
): Promise<PhaseReport> {
  const previous = context.checkpoint.findCompleted(
    context.mapping.mappingKey,
    phase,
    context.sourceFingerprint,
    context.checkpointConfigSha256,
  );
  if (previous !== null) {
    await verifyCompleted();
    context.reports.push(previous);
    return previous;
  }

  const startedAt = context.now();
  const attempt = context.checkpoint.start(
    context.mapping.mappingKey,
    phase,
    context.sourceFingerprint,
    context.checkpointConfigSha256,
    startedAt,
  );
  let report: PhaseReport;
  try {
    const contents = await action();
    report = completedPhase(
      phase,
      attempt,
      startedAt,
      context.now(),
      contents,
    );
    context.checkpoint.complete(context.mapping.mappingKey, report);
    context.reports.push(report);
  } catch (error) {
    report = failedPhase(
      phase,
      attempt,
      startedAt,
      context.now(),
      error,
    );
    context.checkpoint.fail(context.mapping.mappingKey, report);
    context.reports.push(report);
    throw error;
  }
  await context.options.hooks?.afterPhase?.(phase, context.mapping);
  return report;
}

function openMigratedDatabaseReadOnly(filename: string): DatabaseSync {
  const database = new DatabaseSync(filename, {
    allowExtension: false,
    readOnly: true,
    timeout: 30_000,
  });
  database.exec("PRAGMA query_only=ON");
  database.exec("PRAGMA trusted_schema=OFF");
  return database;
}

function reconcileTarget(
  source: DatabaseSync,
  mapping: ResolvedProjectMapping,
  inspection: SourceInspection,
  manifest: MigrationManifest,
): readonly TableReconciliation[] {
  assertDestinationManifest(mapping.destinationResearchDatabase, manifest);
  const destination = openMigratedDatabaseReadOnly(
    mapping.destinationResearchDatabase,
  );
  try {
    return reconcileMigratedDatabase(
      source,
      destination,
      mapping,
      inspection,
    );
  } finally {
    destination.close();
  }
}

async function migrateNewProjectDatabase(
  source: DatabaseSync,
  inspection: SourceInspection,
  manifest: MigrationManifest,
  destinationDataRoot: string,
  context: ExecutionContext,
): Promise<readonly TableReconciliation[]> {
  const mapping = context.mapping;
  const stagingPath = prepareStagingPath(
    mapping,
    destinationDataRoot,
    randomUUID(),
  );
  let projectDatabase: ProjectDatabase | undefined;
  let stagingConnection: DatabaseSync | undefined;
  let workflowStarted:
    | { readonly attempt: number; readonly startedAt: string }
    | undefined;
  try {
    const researchStartedAt = context.now();
    const researchAttempt = context.checkpoint.start(
      mapping.mappingKey,
      "research",
      inspection.sourceFingerprint,
      context.checkpointConfigSha256,
      researchStartedAt,
    );
    try {
      const snapshotMethod = await createConsistentSnapshot(
        source,
        stagingPath,
        mapping.legacyCollectionDatabase,
      );
      stagingConnection = new DatabaseSync(stagingPath, {
        allowExtension: false,
        enableForeignKeyConstraints: false,
        timeout: 30_000,
      });
      verifySnapshot(source, stagingConnection, inspection);
      rewriteStagingIdentity(
        stagingConnection,
        mapping,
        inspection.filePlans,
      );
      stagingConnection.close();
      stagingConnection = undefined;

      projectDatabase = openProjectDatabase({
        projectRoot: mapping.destinationProjectRoot,
        databasePath: stagingPath,
        preferredSearchBackend: "deterministic",
        timeoutMs: 30_000,
      });
      const researchTables = reconcileNormalizedResearch(
        source,
        projectDatabase.connection,
        mapping,
      );
      const researchReport = completedPhase(
        "research",
        researchAttempt,
        researchStartedAt,
        context.now(),
        {
          tables: researchTables,
          warnings: [`consistent_snapshot=${snapshotMethod}`],
        },
      );
      context.checkpoint.complete(mapping.mappingKey, researchReport);
      context.reports.push(researchReport);
    } catch (error) {
      const report = failedPhase(
        "research",
        researchAttempt,
        researchStartedAt,
        context.now(),
        error,
      );
      context.checkpoint.fail(mapping.mappingKey, report);
      context.reports.push(report);
      throw error;
    }

    await context.options.hooks?.afterPhase?.("research", mapping);

    const workflowStartedAt = context.now();
    const workflowAttempt = context.checkpoint.start(
      mapping.mappingKey,
      "workflow",
      inspection.sourceFingerprint,
      context.checkpointConfigSha256,
      workflowStartedAt,
    );
    workflowStarted = {
      attempt: workflowAttempt,
      startedAt: workflowStartedAt,
    };
    let allTables: readonly TableReconciliation[];
    try {
      createWorkflowStore(projectDatabase.connection, {
        migration: { now: new Date(workflowStartedAt) },
      });
      writeLegacyAgentRunReconciliation(
        source,
        projectDatabase.connection,
        mapping,
        inspection.sourceFingerprint,
        workflowStartedAt,
      );
      allTables = reconcileMigratedDatabase(
        source,
        projectDatabase.connection,
        mapping,
        inspection,
      );
      writeMigrationManifest(
        projectDatabase.connection,
        manifest,
        context.now(),
      );
      makeDatabasePublishable(
        projectDatabase.connection,
        stagingPath,
      );
      projectDatabase = undefined;
      publishDatabaseWithoutOverwrite(
        stagingPath,
        mapping.destinationResearchDatabase,
        destinationDataRoot,
      );
      const workflowReport = completedPhase(
        "workflow",
        workflowAttempt,
        workflowStartedAt,
        context.now(),
        { tables: workflowPhaseTables(allTables) },
      );
      context.checkpoint.complete(mapping.mappingKey, workflowReport);
      context.reports.push(workflowReport);
      workflowStarted = undefined;
    } catch (error) {
      const report = failedPhase(
        "workflow",
        workflowAttempt,
        workflowStartedAt,
        context.now(),
        error,
      );
      context.checkpoint.fail(mapping.mappingKey, report);
      context.reports.push(report);
      workflowStarted = undefined;
      throw error;
    }
    await context.options.hooks?.afterPhase?.("workflow", mapping);
    return allTables;
  } finally {
    if (
      workflowStarted !== undefined &&
      projectDatabase !== undefined
    ) {
      const report = failedPhase(
        "workflow",
        workflowStarted.attempt,
        workflowStarted.startedAt,
        context.now(),
        "Workflow migration was interrupted",
      );
      context.checkpoint.fail(mapping.mappingKey, report);
    }
    stagingConnection?.close();
    projectDatabase?.close();
    rmSync(stagingPath, { force: true });
    rmSync(`${stagingPath}-wal`, { force: true });
    rmSync(`${stagingPath}-shm`, { force: true });
  }
}

async function ensureProjectDatabase(
  source: DatabaseSync,
  inspection: SourceInspection,
  manifest: MigrationManifest,
  destinationState: "missing" | "matching",
  destinationDataRoot: string,
  context: ExecutionContext,
): Promise<readonly TableReconciliation[]> {
  if (destinationState === "matching") {
    const tables = reconcileTarget(
      source,
      context.mapping,
      inspection,
      manifest,
    );
    await checkpointedPhase(
      context,
      "research",
      () => {
        reconcileTarget(
          source,
          context.mapping,
          inspection,
          manifest,
        );
      },
      () => ({ tables: researchPhaseTables(tables) }),
    );
    await checkpointedPhase(
      context,
      "workflow",
      () => {
        reconcileTarget(
          source,
          context.mapping,
          inspection,
          manifest,
        );
      },
      () => ({ tables: workflowPhaseTables(tables) }),
    );
    return tables;
  }
  return migrateNewProjectDatabase(
    source,
    inspection,
    manifest,
    destinationDataRoot,
    context,
  );
}

async function migrateProject(
  mapping: ResolvedProjectMapping,
  config: ReturnType<typeof resolveMigrationConfig>,
  baseline: BaselineCoverage,
  checkpoint: MigrationCheckpointStore | null,
  options: RunLegacyMigrationOptions,
  errors: string[],
): Promise<ProjectMigrationReport> {
  const phases: PhaseReport[] = [];
  let sourceFingerprint = "";
  let manifestSha256 = "";
  let source: DatabaseSync | undefined;
  try {
    source = openLegacyDatabase(mapping.legacyCollectionDatabase);
    const inspection = inspectSource(
      source,
      mapping,
      config.legacyRoot,
    );
    sourceFingerprint = inspection.sourceFingerprint;
    const manifest = createMigrationManifest(
      mapping,
      sourceFingerprint,
      config.configSha256,
      baseline,
    );
    manifestSha256 = manifest.sha256;

    const destinationState = assertDestinationManifest(
      mapping.destinationResearchDatabase,
      manifest,
    );
    const plannedFiles = preflightFiles(inspection.filePlans);
    preflightControlMapping(config.controlDatabase, mapping);

    if (config.dryRun) {
      let plannedTables = plannedTableReports(inspection);
      if (destinationState === "matching") {
        plannedTables = reconcileTarget(
          source,
          mapping,
          inspection,
          manifest,
        );
        reconcileFiles(inspection.filePlans);
      }
      const timestamp = isoNow(options);
      phases.push(
        plannedPhase("control", timestamp),
        plannedPhase("files", timestamp, { files: plannedFiles }),
        plannedPhase("research", timestamp, {
          tables: researchPhaseTables(plannedTables),
        }),
        plannedPhase("workflow", timestamp, {
          tables: workflowPhaseTables(plannedTables),
        }),
        plannedPhase("reconcile", timestamp, {
          tables: [
            ...plannedTables,
            ...plannedLegacyBusinessJobReports(source),
          ],
          files: plannedFiles,
        }),
      );
      return {
        mappingKey: mapping.mappingKey,
        legacyNamespace: mapping.legacyNamespace,
        legacyDatasetId: mapping.legacyDatasetId,
        userId: mapping.userId,
        dataNamespace: mapping.dataNamespace,
        projectId: mapping.projectId,
        sourceFingerprint,
        manifestSha256,
        destinationDatabase: mapping.destinationResearchDatabase,
        status: "planned",
        phases,
      };
    }

    if (checkpoint === null) {
      throw new Error("Execution checkpoint store is unavailable");
    }
    const checkpointConfigSha256 = stableSha256({
      implementationVersion: MIGRATION_IMPLEMENTATION_VERSION,
      configSha256: config.configSha256,
      baselineSha256: baseline.sha256,
    });
    const context: ExecutionContext = {
      checkpoint,
      checkpointConfigSha256,
      sourceFingerprint,
      mapping,
      options,
      now: () => isoNow(options),
      reports: phases,
    };

    await checkpointedPhase(
      context,
      "control",
      () => {
        verifyControlMapping(config.controlDatabase, mapping);
      },
      () => {
        ensureControlMapping(
          config.controlDatabase,
          mapping,
          isoNow(options),
        );
        return {};
      },
    );
    await checkpointedPhase(
      context,
      "files",
      () => {
        reconcileFiles(inspection.filePlans);
      },
      () => ({
        files: migrateFiles(
          inspection.filePlans,
          mapping.destinationProjectRoot,
          config.destinationDataRoot,
        ),
      }),
    );

    await ensureProjectDatabase(
      source,
      inspection,
      manifest,
      destinationState,
      config.destinationDataRoot,
      context,
    );

    await checkpointedPhase(
      context,
      "reconcile",
      () => {
        verifyControlMapping(config.controlDatabase, mapping);
        reconcileFiles(inspection.filePlans);
        reconcileTarget(source!, mapping, inspection, manifest);
        reconcileLegacyBusinessJobs(
          source!,
          config.controlDatabase,
          mapping,
          inspection.sourceFingerprint,
        );
      },
      () => {
        verifyControlMapping(config.controlDatabase, mapping);
        const files = reconcileFiles(inspection.filePlans);
        const projectTables = reconcileTarget(
          source!,
          mapping,
          inspection,
          manifest,
        );
        const controlTables = migrateLegacyBusinessJobs(
          source!,
          config.controlDatabase,
          mapping,
          inspection.sourceFingerprint,
          isoNow(options),
        );
        return {
          tables: [...projectTables, ...controlTables],
          files,
        };
      },
    );

    return {
      mappingKey: mapping.mappingKey,
      legacyNamespace: mapping.legacyNamespace,
      legacyDatasetId: mapping.legacyDatasetId,
      userId: mapping.userId,
      dataNamespace: mapping.dataNamespace,
      projectId: mapping.projectId,
      sourceFingerprint,
      manifestSha256,
      destinationDatabase: mapping.destinationResearchDatabase,
      status: "completed",
      phases,
    };
  } catch (error) {
    errors.push(`${mapping.mappingKey}: ${errorMessage(error)}`);
    return {
      mappingKey: mapping.mappingKey,
      legacyNamespace: mapping.legacyNamespace,
      legacyDatasetId: mapping.legacyDatasetId,
      userId: mapping.userId,
      dataNamespace: mapping.dataNamespace,
      projectId: mapping.projectId,
      sourceFingerprint,
      manifestSha256,
      destinationDatabase: mapping.destinationResearchDatabase,
      status: "failed",
      phases,
    };
  } finally {
    if (source !== undefined) closeLegacyDatabase(source);
  }
}

function writeReportAtomically(
  filename: string,
  destinationDataRoot: string,
  report: LegacyMigrationReport,
): void {
  const directory = prepareDestinationDirectory(
    path.dirname(filename),
    destinationDataRoot,
  );
  const temporary = path.join(
    directory,
    `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, `${stableJson(report)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    const descriptor = openSync(temporary, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, filename);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function runLegacyMigration(
  input: LegacyMigrationConfig,
  options: RunLegacyMigrationOptions = {},
): Promise<LegacyMigrationResult> {
  const config = resolveMigrationConfig(input);
  const baseline = loadBaseline(
    config.baselinePath,
    WORKFLOW_DOMAIN_TABLES,
  );
  const startedAt = isoNow(options);
  const errors: string[] = [];
  const checkpoint = config.dryRun
    ? null
    : new MigrationCheckpointStore(
        config.checkpointDatabase,
        config.destinationDataRoot,
      );
  const projects: ProjectMigrationReport[] = [];
  try {
    for (const mapping of config.projects) {
      projects.push(
        await migrateProject(
          mapping,
          config,
          baseline,
          checkpoint,
          options,
          errors,
        ),
      );
    }
  } finally {
    checkpoint?.close();
  }

  const status: LegacyMigrationReport["status"] =
    errors.length > 0
      ? "failed"
      : config.dryRun
        ? "planned"
        : "completed";
  const report: LegacyMigrationReport = {
    reportSchemaVersion: 1,
    migrationId: migrationId(config.configSha256, startedAt),
    dryRun: config.dryRun,
    startedAt,
    completedAt: isoNow(options),
    status,
    configSha256: config.configSha256,
    baseline,
    projects,
    errors,
    legacyDataDeleted: false,
  };
  const writtenReportPath =
    config.dryRun || config.reportPath === null
      ? null
      : config.reportPath;
  if (writtenReportPath !== null) {
    writeReportAtomically(
      writtenReportPath,
      config.destinationDataRoot,
      report,
    );
  }
  return { report, reportPath: writtenReportPath };
}

export function loadMigrationConfig(filename: string): LegacyMigrationConfig {
  const source = readFileSync(filename, "utf8");
  try {
    return JSON.parse(source) as LegacyMigrationConfig;
  } catch (error) {
    throw new Error(`Migration config is not valid JSON: ${filename}`, {
      cause: error,
    });
  }
}
