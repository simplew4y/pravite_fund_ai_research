import type { DatabaseSync } from "node:sqlite";

import {
  runWorkflowStoreMigrations,
  type RunWorkflowStoreMigrationsOptions,
  type WorkflowStoreMigrationResult,
} from "./migrations.js";
import {
  ObsidianRepository,
  type ObsidianRepositoryOptions,
} from "./obsidian-repository.js";
import { TrackingRepository } from "./tracking-repository.js";
import { ValuationRepository } from "./valuation-repository.js";
import {
  WorkflowRepository,
  type WorkflowRepositoryOptions,
} from "./workflow-repository.js";

export interface CreateWorkflowStoreOptions {
  readonly clock?: () => Date;
  readonly migration?: RunWorkflowStoreMigrationsOptions;
  readonly obsidian?: Omit<ObsidianRepositoryOptions, "clock">;
}

export interface WorkflowStore {
  readonly database: DatabaseSync;
  readonly migration: WorkflowStoreMigrationResult;
  readonly tracking: TrackingRepository;
  readonly valuation: ValuationRepository;
  readonly workflow: WorkflowRepository;
  readonly obsidian: ObsidianRepository;
}

export function createWorkflowStore(
  database: DatabaseSync,
  options: CreateWorkflowStoreOptions = {},
): WorkflowStore {
  const migration = runWorkflowStoreMigrations(database, options.migration);
  const workflowOptions: WorkflowRepositoryOptions =
    options.clock === undefined ? {} : { clock: options.clock };
  const obsidianOptions: ObsidianRepositoryOptions = {
    ...options.obsidian,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  };
  return {
    database,
    migration,
    tracking: new TrackingRepository(database, options.clock),
    valuation: new ValuationRepository(database),
    workflow: new WorkflowRepository(database, workflowOptions),
    obsidian: new ObsidianRepository(database, obsidianOptions),
  };
}
