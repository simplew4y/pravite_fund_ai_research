import type {
  JsonValue,
  ObsidianOutboxEvent,
  ObsidianRepository,
} from "@private-fund/workflow-store";

export type ProjectionDisposition = "upsert" | "tombstone";

export interface ObsidianEvidenceReference {
  readonly evidenceId: string;
  readonly relation?: string;
  readonly label?: string;
}

export interface ProjectionNoteIdentity {
  readonly entityType: string;
  readonly entityId: string;
  readonly sourceVersion: string;
}

/**
 * A renderer supplies domain content while the projector owns provenance,
 * managed markers, path policy, conflict detection, and durable delivery.
 *
 * relativePath is always relative to the configured managedRootRelative. It
 * can never name a project-root path directly.
 */
export interface ObsidianProjectionNote {
  readonly relativePath: string;
  readonly title: string;
  readonly body: string;
  readonly disposition?: ProjectionDisposition;
  readonly evidence?: readonly ObsidianEvidenceReference[];
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly identity?: ProjectionNoteIdentity;
}

export interface ObsidianProjectionPlan {
  readonly notes: readonly ObsidianProjectionNote[];
}

export interface ObsidianProjectBinding {
  readonly tenantId: string;
  readonly projectId: string;
  readonly datasetId: string;
  readonly projectRoot: string;
}

export interface ObsidianProjectionRenderContext {
  readonly binding: ObsidianProjectBinding;
  readonly event: ObsidianOutboxEvent;
}

export type ObsidianProjectionRenderer = (
  context: ObsidianProjectionRenderContext,
) => ObsidianProjectionPlan | Promise<ObsidianProjectionPlan>;

export interface ProjectionLifecycleContext {
  readonly event: ObsidianOutboxEvent;
  readonly leaseToken: string;
  readonly registryPath: string;
  readonly targetPath: string;
  readonly temporaryPath: string;
}

/**
 * Lifecycle callbacks are primarily for fault-injection and observability.
 * Throw ProjectionCrashSimulationError to model process death without
 * acknowledging/failing the outbox event.
 */
export interface ObsidianProjectionLifecycle {
  readonly beforeAtomicRename?: (
    context: ProjectionLifecycleContext,
  ) => void | Promise<void>;
  readonly afterAtomicRename?: (
    context: ProjectionLifecycleContext,
  ) => void | Promise<void>;
  readonly beforeDatabaseCommit?: (
    context: {
      readonly event: ObsidianOutboxEvent;
      readonly leaseToken: string;
      readonly registryPaths: readonly string[];
    },
  ) => void | Promise<void>;
}

export interface ObsidianProjectorOptions {
  readonly repository: ObsidianRepository;
  readonly binding: ObsidianProjectBinding;
  readonly renderer: ObsidianProjectionRenderer;
  /**
   * Safe POSIX path relative to projectRoot. Every registry row and write is
   * constrained beneath this directory. Defaults to "obsidian/managed".
   */
  readonly managedRootRelative?: string;
  readonly projectorVersion?: string;
  readonly maxNoteBytes?: number;
  readonly lifecycle?: ObsidianProjectionLifecycle;
}

export type ObsidianProjectionDeliveryStatus =
  | "completed"
  | "queued"
  | "failed"
  | "stale";

export interface ObsidianProjectionDelivery {
  readonly eventId: string;
  readonly status: ObsidianProjectionDeliveryStatus;
  readonly written: number;
  readonly unchanged: number;
  readonly archived: number;
  readonly paths: readonly string[];
  readonly error?: string;
}

export interface ObsidianProjectionDrainResult {
  readonly datasetId: string;
  readonly processed: number;
  readonly completed: number;
  readonly queued: number;
  readonly failed: number;
  readonly stale: number;
  readonly written: number;
  readonly unchanged: number;
  readonly archived: number;
}

export interface ObsidianProjectorPort {
  processNext(): Promise<ObsidianProjectionDelivery | null>;
  drain(maxEvents?: number): Promise<ObsidianProjectionDrainResult>;
  recoverStale(staleBefore: string, availableAt?: string): number;
}

export class ObsidianProjectionError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | "invalid_projection"
      | "path_violation"
      | "managed_content_conflict"
      | "stale_lease"
      | "io_failure",
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ObsidianProjectionError";
  }
}

/**
 * Test/fault-injection sentinel: the projector deliberately leaves the event
 * running so normal stale-lease recovery exercises the real crash window.
 */
export class ProjectionCrashSimulationError extends Error {
  public constructor(message = "simulated projector crash") {
    super(message);
    this.name = "ProjectionCrashSimulationError";
  }
}
