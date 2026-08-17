export const MIGRATION_PHASES = [
  "control",
  "files",
  "research",
  "workflow",
  "reconcile",
] as const;

export type MigrationPhase = (typeof MIGRATION_PHASES)[number];

export interface LegacyProjectMapping {
  /**
   * Dataset ID in the legacy tenant's datasets.sqlite3 and collection DB.
   * Ownership is never inferred from a directory name.
   */
  readonly legacyDatasetId: string;
  /** Globally unique project ID in the TypeScript control DB. */
  readonly projectId: string;
  /**
   * Explicit override for non-standard layouts. It must remain inside
   * legacyRoot. Defaults to <legacyDatasetRoot>/<legacyDatasetId>.
   */
  readonly legacyProjectRoot?: string;
  /**
   * Explicit override for non-standard layouts. It must remain inside
   * legacyRoot. Defaults to <legacyProjectRoot>/meta/collection.sqlite3.
   */
  readonly legacyCollectionDatabase?: string;
  /** Required only when no matching row exists in the legacy registry. */
  readonly name?: string;
  readonly companyName?: string | null;
  readonly ticker?: string | null;
}

export interface LegacyTenantMapping {
  /**
   * Legacy data namespace. This is an ownership assertion, not a value that
   * the migrator is allowed to discover or synthesize.
   */
  readonly legacyNamespace: string;
  readonly legacyDatasetRoot: string;
  readonly userId: string;
  /** UUID namespace used by the TypeScript control plane. */
  readonly dataNamespace: string;
  readonly email?: string | null;
  readonly projects: readonly LegacyProjectMapping[];
}

export interface LegacyMigrationConfig {
  readonly schemaVersion: 1;
  readonly legacyRoot: string;
  readonly destinationDataRoot: string;
  readonly baselinePath: string;
  readonly tenants: readonly LegacyTenantMapping[];
  readonly controlDatabase?: string;
  readonly checkpointDatabase?: string;
  readonly reportPath?: string;
  readonly dryRun?: boolean;
}

export interface ResolvedProjectMapping {
  readonly mappingKey: string;
  readonly legacyNamespace: string;
  readonly legacyDatasetId: string;
  readonly legacyDatasetRoot: string;
  readonly legacyProjectRoot: string;
  readonly legacyCollectionDatabase: string;
  readonly userId: string;
  readonly dataNamespace: string;
  readonly email: string | null;
  readonly projectId: string;
  readonly name: string;
  readonly companyName: string | null;
  readonly ticker: string | null;
  readonly destinationProjectRoot: string;
  readonly destinationResearchDatabase: string;
  readonly destinationWorkflowDatabase: string;
}

export interface TableReconciliation {
  readonly table: string;
  readonly mode: "native" | "normalized" | "preserved";
  readonly sourceRows: number;
  readonly destinationRows: number;
  readonly sourceChecksum: string;
  readonly destinationChecksum: string;
  readonly matched: boolean;
}

export interface FileReconciliation {
  readonly legacyDocumentVersionId: string;
  readonly sourcePath: string | null;
  readonly destinationPath: string | null;
  readonly destinationRelativePath: string;
  readonly size: number;
  readonly sha256: string | null;
  readonly status: "copied" | "already-present" | "metadata-only" | "planned";
}

export interface PhaseReport {
  readonly phase: MigrationPhase;
  readonly status: "planned" | "completed" | "failed";
  readonly attempt: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly tables: readonly TableReconciliation[];
  readonly files: readonly FileReconciliation[];
  readonly warnings: readonly string[];
  readonly error: string | null;
}

export interface ProjectMigrationReport {
  readonly mappingKey: string;
  readonly legacyNamespace: string;
  readonly legacyDatasetId: string;
  readonly userId: string;
  readonly dataNamespace: string;
  readonly projectId: string;
  readonly sourceFingerprint: string;
  readonly manifestSha256: string;
  readonly destinationDatabase: string;
  readonly status: "planned" | "completed" | "failed";
  readonly phases: readonly PhaseReport[];
}

export interface BaselineCoverage {
  readonly schemaVersion: number;
  readonly sha256: string;
  readonly declaredTables: readonly string[];
  readonly nativeWorkflowTables: readonly string[];
  readonly preservedWorkflowTables: readonly string[];
}

export interface LegacyMigrationReport {
  readonly reportSchemaVersion: 1;
  readonly migrationId: string;
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: "planned" | "completed" | "failed";
  readonly configSha256: string;
  readonly baseline: BaselineCoverage;
  readonly projects: readonly ProjectMigrationReport[];
  readonly errors: readonly string[];
  readonly legacyDataDeleted: false;
}

export interface LegacyMigrationResult {
  readonly report: LegacyMigrationReport;
  readonly reportPath: string | null;
}

export interface LegacyMigrationHooks {
  /**
   * Test/operations hook invoked only after a durable phase checkpoint exists.
   * Throwing simulates an interruption; rerunning resumes from the checkpoint.
   */
  readonly afterPhase?: (
    phase: MigrationPhase,
    mapping: ResolvedProjectMapping,
  ) => void | Promise<void>;
}

export interface RunLegacyMigrationOptions {
  readonly now?: () => Date;
  readonly hooks?: LegacyMigrationHooks;
}
