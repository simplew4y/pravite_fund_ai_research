import path from "node:path";

import {
  AuthoritativeObsidianReconciler,
  AuthoritativeObsidianRenderer,
  ObsidianProjector,
  type ObsidianProjectionDrainResult,
  type ObsidianReconcileResult,
} from "@private-fund/obsidian-projector";
import {
  openProjectDatabase,
  type ProjectDatabase,
} from "@private-fund/research-store";
import {
  createWorkflowStore,
  type ProjectionStatus,
  type WorkflowStore,
} from "@private-fund/workflow-store";

import type {
  CatalogProject,
  ObsidianProjectCatalog,
} from "./catalog.js";
import { ensureSecureProjectRoot } from "./project-path.js";

export type RunnerStatus =
  | "starting"
  | "ready"
  | "degraded"
  | "stopping"
  | "stopped";

export interface ProjectCycleHealth {
  readonly tenantId: string;
  readonly projectId: string;
  readonly datasetId: string;
  readonly status: "ready" | "degraded";
  readonly recovered: number;
  readonly reconcile: ObsidianReconcileResult | null;
  readonly drain: ObsidianProjectionDrainResult;
  readonly projection: ProjectionStatus;
  readonly error: string | null;
  readonly completedAt: string;
}

export interface RunnerHealth {
  readonly status: RunnerStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly lastCycleStartedAt: string | null;
  readonly lastCycleCompletedAt: string | null;
  readonly cycleCount: number;
  readonly projectsDiscovered: number;
  readonly totals: {
    readonly recovered: number;
    readonly reconciled: number;
    readonly processed: number;
    readonly completed: number;
    readonly queued: number;
    readonly failed: number;
    readonly stale: number;
    readonly written: number;
    readonly unchanged: number;
    readonly archived: number;
  };
  readonly projects: readonly ProjectCycleHealth[];
  readonly lastError: string | null;
}

interface MutableTotals {
  recovered: number;
  reconciled: number;
  processed: number;
  completed: number;
  queued: number;
  failed: number;
  stale: number;
  written: number;
  unchanged: number;
  archived: number;
}

export interface RunnerEvent {
  readonly event:
    | "cycle_completed"
    | "project_cycle_completed"
    | "project_cycle_error"
    | "runner_error"
    | "runner_stopped";
  readonly at: string;
  readonly tenantId?: string;
  readonly projectId?: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface ObsidianOutboxRunnerOptions {
  readonly dataRoot: string;
  readonly catalog: ObsidianProjectCatalog;
  readonly managedRootRelative: string;
  readonly projectorVersion: string;
  readonly pollIntervalMs: number;
  readonly reconcileIntervalMs: number;
  readonly staleLeaseMs: number;
  readonly maxDrainEvents: number;
  readonly maxAttempts: number;
  readonly maxNoteBytes: number;
  readonly clock?: () => Date;
  readonly onEvent?: (event: RunnerEvent) => void;
}

interface ProjectRuntime {
  readonly binding: CatalogProject;
  readonly projectRoot: string;
  readonly database: ProjectDatabase;
  readonly store: WorkflowStore;
  readonly projector: ObsidianProjector;
  readonly reconciler: AuthoritativeObsidianReconciler;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function runtimeKey(project: CatalogProject): string {
  return `${project.tenantId}\0${project.projectId}`;
}

function emptyTotals(): MutableTotals {
  return {
    recovered: 0,
    reconciled: 0,
    processed: 0,
    completed: 0,
    queued: 0,
    failed: 0,
    stale: 0,
    written: 0,
    unchanged: 0,
    archived: 0,
  };
}

function emptyDrain(datasetId: string): ObsidianProjectionDrainResult {
  return {
    datasetId,
    processed: 0,
    completed: 0,
    queued: 0,
    failed: 0,
    stale: 0,
    written: 0,
    unchanged: 0,
    archived: 0,
  };
}

function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class ObsidianOutboxRunner {
  readonly #options: ObsidianOutboxRunnerOptions;
  readonly #clock: () => Date;
  readonly #runtimes = new Map<string, ProjectRuntime>();
  readonly #lastReconcile = new Map<string, number>();
  #runningCycle = false;
  #closed = false;
  #health: RunnerHealth;

  public constructor(options: ObsidianOutboxRunnerOptions) {
    this.#options = options;
    this.#clock = options.clock ?? (() => new Date());
    const startedAt = this.#now();
    this.#health = {
      status: "starting",
      startedAt,
      updatedAt: startedAt,
      lastCycleStartedAt: null,
      lastCycleCompletedAt: null,
      cycleCount: 0,
      projectsDiscovered: 0,
      totals: emptyTotals(),
      projects: [],
      lastError: null,
    };
  }

  public health(): RunnerHealth {
    return structuredClone(this.#health);
  }

  public async cycle(): Promise<RunnerHealth> {
    if (this.#closed) {
      throw new Error("Obsidian outbox runner is closed");
    }
    if (this.#runningCycle) {
      throw new Error("Obsidian outbox runner cycle is already running");
    }
    this.#runningCycle = true;
    const cycleStartedAt = this.#now();
    try {
      const projects = [...this.#options.catalog.listProjects()];
      const activeKeys = new Set(projects.map(runtimeKey));
      for (const [key, runtime] of this.#runtimes) {
        if (!activeKeys.has(key)) {
          runtime.database.close();
          this.#runtimes.delete(key);
          this.#lastReconcile.delete(key);
        }
      }
      const projectResults: ProjectCycleHealth[] = [];
      for (const project of projects) {
        projectResults.push(await this.#processProject(project));
      }
      const totals = emptyTotals();
      for (const project of projectResults) {
        totals.recovered += project.recovered;
        totals.reconciled += project.reconcile?.newlyEnqueued ?? 0;
        totals.processed += project.drain.processed;
        totals.completed += project.drain.completed;
        totals.queued += project.drain.queued;
        totals.failed += project.drain.failed;
        totals.stale += project.drain.stale;
        totals.written += project.drain.written;
        totals.unchanged += project.drain.unchanged;
        totals.archived += project.drain.archived;
      }
      const degraded = projectResults.some(
        (project) => project.status === "degraded",
      );
      const completedAt = this.#now();
      this.#health = {
        ...this.#health,
        status: degraded ? "degraded" : "ready",
        updatedAt: completedAt,
        lastCycleStartedAt: cycleStartedAt,
        lastCycleCompletedAt: completedAt,
        cycleCount: this.#health.cycleCount + 1,
        projectsDiscovered: projects.length,
        totals,
        projects: projectResults,
        lastError:
          projectResults.find((project) => project.error !== null)?.error ??
          null,
      };
      this.#emit("cycle_completed", {
        projects: projects.length,
        status: this.#health.status,
        totals,
      });
      return this.health();
    } catch (error) {
      const at = this.#now();
      this.#health = {
        ...this.#health,
        status: "degraded",
        updatedAt: at,
        lastCycleStartedAt: cycleStartedAt,
        lastCycleCompletedAt: at,
        cycleCount: this.#health.cycleCount + 1,
        lastError: errorMessage(error),
      };
      this.#emit("runner_error", { error: errorMessage(error) });
      throw error;
    } finally {
      this.#runningCycle = false;
    }
  }

  public async run(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        try {
          await this.cycle();
        } catch {
          // cycle() persisted the failure in health and emitted an event.
        }
        await waitForPoll(this.#options.pollIntervalMs, signal);
      }
    } finally {
      const stoppingAt = this.#now();
      this.#health = {
        ...this.#health,
        status: "stopping",
        updatedAt: stoppingAt,
      };
      this.close();
      const stoppedAt = this.#now();
      this.#health = {
        ...this.#health,
        status: "stopped",
        updatedAt: stoppedAt,
      };
      this.#emit("runner_stopped", {});
    }
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const runtime of this.#runtimes.values()) {
      runtime.database.close();
    }
    this.#runtimes.clear();
    this.#lastReconcile.clear();
  }

  async #processProject(project: CatalogProject): Promise<ProjectCycleHealth> {
    const key = runtimeKey(project);
    try {
      const runtime = await this.#runtime(project);
      const now = this.#clock();
      const recovered = runtime.projector.recoverStale(
        new Date(now.getTime() - this.#options.staleLeaseMs).toISOString(),
        now.toISOString(),
      );
      let reconcile: ObsidianReconcileResult | null = null;
      const lastReconcile = this.#lastReconcile.get(key);
      if (
        lastReconcile === undefined ||
        now.getTime() - lastReconcile >= this.#options.reconcileIntervalMs
      ) {
        reconcile = runtime.reconciler.reconcile(project.datasetId);
        this.#lastReconcile.set(key, now.getTime());
      }
      const drain = await runtime.projector.drain(
        this.#options.maxDrainEvents,
      );
      const projection = runtime.store.obsidian.projectionStatus(
        project.datasetId,
        this.#options.projectorVersion,
      );
      const degraded =
        drain.failed > 0 ||
        drain.stale > 0 ||
        (projection.events.failed ?? 0) > 0;
      const result: ProjectCycleHealth = {
        tenantId: project.tenantId,
        projectId: project.projectId,
        datasetId: project.datasetId,
        status: degraded ? "degraded" : "ready",
        recovered,
        reconcile,
        drain,
        projection,
        error:
          degraded && (projection.events.failed ?? 0) > 0
            ? `${String(projection.events.failed)} terminal projection event(s)`
            : null,
        completedAt: this.#now(),
      };
      this.#emit(
        "project_cycle_completed",
        {
          recovered,
          reconcile,
          drain,
          projection,
          status: result.status,
        },
        project,
      );
      return result;
    } catch (error) {
      const existing = this.#runtimes.get(key);
      if (existing !== undefined) {
        existing.database.close();
        this.#runtimes.delete(key);
      }
      this.#lastReconcile.delete(key);
      const message = errorMessage(error);
      this.#emit("project_cycle_error", { error: message }, project);
      return {
        tenantId: project.tenantId,
        projectId: project.projectId,
        datasetId: project.datasetId,
        status: "degraded",
        recovered: 0,
        reconcile: null,
        drain: emptyDrain(project.datasetId),
        projection: {
          datasetId: project.datasetId,
          projectorVersion: this.#options.projectorVersion,
          events: {},
          notes: {},
        },
        error: message,
        completedAt: this.#now(),
      };
    }
  }

  async #runtime(project: CatalogProject): Promise<ProjectRuntime> {
    const key = runtimeKey(project);
    const projectRoot = await ensureSecureProjectRoot(
      this.#options.dataRoot,
      project,
    );
    const existing = this.#runtimes.get(key);
    if (
      existing !== undefined &&
      existing.projectRoot === projectRoot &&
      existing.binding.tenantNamespace === project.tenantNamespace &&
      existing.binding.datasetId === project.datasetId
    ) {
      return existing;
    }
    existing?.database.close();
    const database = openProjectDatabase({
      projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
    });
    try {
      const store = createWorkflowStore(database.connection, {
        clock: this.#clock,
        obsidian: {
          projectorVersion: this.#options.projectorVersion,
        },
      });
      const renderer = new AuthoritativeObsidianRenderer(store);
      const runtime: ProjectRuntime = {
        binding: project,
        projectRoot,
        database,
        store,
        projector: new ObsidianProjector({
          repository: store.obsidian,
          binding: {
            tenantId: project.tenantId,
            projectId: project.projectId,
            datasetId: project.datasetId,
            projectRoot,
          },
          renderer: renderer.render,
          managedRootRelative: this.#options.managedRootRelative,
          projectorVersion: this.#options.projectorVersion,
          maxNoteBytes: this.#options.maxNoteBytes,
        }),
        reconciler: new AuthoritativeObsidianReconciler(store, {
          projectorVersion: this.#options.projectorVersion,
          maxAttempts: this.#options.maxAttempts,
        }),
      };
      this.#runtimes.set(key, runtime);
      return runtime;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  #now(): string {
    const value = this.#clock();
    if (!Number.isFinite(value.getTime())) {
      throw new Error("Obsidian runner clock returned an invalid Date");
    }
    return value.toISOString();
  }

  #emit(
    event: RunnerEvent["event"],
    details: Readonly<Record<string, unknown>>,
    project?: CatalogProject,
  ): void {
    try {
      this.#options.onEvent?.({
        event,
        at: this.#now(),
        ...(project === undefined
          ? {}
          : {
              tenantId: project.tenantId,
              projectId: project.projectId,
            }),
        details,
      });
    } catch (error) {
      process.emitWarning(
        `Obsidian worker observability callback failed: ${errorMessage(error)}`,
        { code: "PRIVATE_FUND_OBSIDIAN_OBSERVABILITY_FAILURE" },
      );
    }
  }
}
