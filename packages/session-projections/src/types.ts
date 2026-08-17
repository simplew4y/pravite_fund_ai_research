import type {
  JournalBlobReference,
  PayloadClassification,
  SessionEventSource,
  SessionEventSourceKind,
  SessionJournalEvent,
} from "@private-fund/contracts";

export const SESSION_PROJECTION_VERSION = 1 as const;

export type ProjectionRedactionReason =
  | "classification_not_allowed"
  | "restricted_payload"
  | "reasoning_payload";

export type ProjectedPayload =
  | {
      readonly visibility: "visible";
      readonly value: Readonly<Record<string, unknown>>;
    }
  | {
      readonly visibility: "redacted";
      readonly reason: ProjectionRedactionReason;
    };

export interface ProjectedBlobReference {
  readonly kind: "journal_blob";
  readonly classification: PayloadClassification;
  readonly allowed: boolean;
  readonly blobId: string | null;
  readonly sha256: string | null;
  readonly sizeBytes: number | null;
  readonly mimeType: string | null;
}

export interface TrajectoryEvent {
  readonly eventId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: string;
  readonly operationId: string | null;
  readonly turnId: string | null;
  readonly stepId: string | null;
  readonly source: SessionEventSource;
  readonly causationEventId: string | null;
  readonly classification: PayloadClassification;
  readonly payload: ProjectedPayload;
  readonly blobReferences: readonly ProjectedBlobReference[];
  readonly knownType: boolean;
  readonly criticalType: boolean;
}

export interface VersionedTrajectory {
  readonly projectionVersion: typeof SESSION_PROJECTION_VERSION;
  readonly sourceFilter: readonly SessionEventSourceKind[];
  readonly events: readonly TrajectoryEvent[];
}

interface NormalizedTranscriptBase {
  readonly eventId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly operationId: string | null;
  readonly turnId: string | null;
  readonly classification: PayloadClassification;
  readonly redacted: boolean;
}

export interface NormalizedMessageItem extends NormalizedTranscriptBase {
  readonly kind: "message";
  readonly role: "user" | "assistant";
  readonly status: "delta" | "completed";
  readonly content: string | null;
}

export interface NormalizedToolItem extends NormalizedTranscriptBase {
  readonly kind: "tool";
  readonly toolCallId: string | null;
  readonly toolName: string | null;
  readonly status: "started" | "progress" | "completed" | "failed";
}

export interface NormalizedOperationItem extends NormalizedTranscriptBase {
  readonly kind: "operation";
  readonly status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "interrupted"
    | "cancelled"
    | "timed_out";
}

export type NormalizedTranscriptItem =
  | NormalizedMessageItem
  | NormalizedToolItem
  | NormalizedOperationItem;

export interface VersionedTranscript {
  readonly projectionVersion: typeof SESSION_PROJECTION_VERSION;
  readonly items: readonly NormalizedTranscriptItem[];
}

export interface OperationRecoveryState {
  readonly operationId: string;
  readonly status: NormalizedOperationItem["status"];
  readonly eventId: string;
  readonly sequence: number;
}

export interface ToolRecoveryState {
  readonly toolCallId: string;
  readonly toolName: string | null;
  readonly status: NormalizedToolItem["status"];
  readonly eventId: string;
  readonly sequence: number;
}

export interface IndexableJournalReference {
  readonly kind: "journal_blob";
  readonly sessionId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly sourceKind: SessionEventSourceKind;
  readonly classification: PayloadClassification;
  readonly allowed: boolean;
  readonly blobId: string | null;
  readonly sha256: string | null;
  readonly sizeBytes: number | null;
  readonly mimeType: string | null;
}

export interface SeenJournalEvent {
  readonly eventId: string;
  readonly eventHash: string;
  readonly sequence: number;
}

export interface ProjectionCheckpointBlocker {
  readonly code: "unknown_critical_event";
  readonly eventId: string;
  readonly sequence: number;
  readonly type: string;
}

export interface SessionRecoverySnapshot {
  readonly projectionVersion: typeof SESSION_PROJECTION_VERSION;
  readonly sessionId: string;
  readonly throughSequence: number;
  readonly lastEventHash: string | null;
  readonly policyFingerprint: string;
  readonly registryFingerprint: string;
  readonly allowedClassifications: readonly PayloadClassification[];
  readonly trajectory: VersionedTrajectory;
  readonly transcript: VersionedTranscript;
  readonly operationStates: readonly OperationRecoveryState[];
  readonly toolStates: readonly ToolRecoveryState[];
  readonly indexReferences: readonly IndexableJournalReference[];
  readonly seenEvents: readonly SeenJournalEvent[];
  readonly checkpointBlockers: readonly ProjectionCheckpointBlocker[];
}

export interface SessionProjectionCheckpoint {
  readonly schemaVersion: typeof SESSION_PROJECTION_VERSION;
  readonly throughSequence: number;
  readonly checksum: string;
  readonly snapshot: SessionRecoverySnapshot;
}

export interface SessionProjectionResult {
  readonly projectionVersion: typeof SESSION_PROJECTION_VERSION;
  readonly sessionId: string;
  readonly throughSequence: number;
  readonly lastEventHash: string | null;
  readonly trajectory: VersionedTrajectory;
  readonly transcript: VersionedTranscript;
  readonly operationStates: readonly OperationRecoveryState[];
  readonly toolStates: readonly ToolRecoveryState[];
  readonly indexReferences: readonly IndexableJournalReference[];
  readonly recoverySnapshot: SessionRecoverySnapshot;
  readonly checksum: string;
  readonly checkpoint: SessionProjectionCheckpoint | null;
  readonly checkpointBlockers: readonly ProjectionCheckpointBlocker[];
}

export interface ProjectionCriticalRegistry {
  /** Event types added to the built-in understood event registry. */
  readonly additionalKnownEventTypes?: readonly string[];
  /** Replaces the built-in critical namespace prefixes when supplied. */
  readonly criticalPrefixes?: readonly string[];
}

export type JournalBlobReader = (
  reference: JournalBlobReference,
  event: SessionJournalEvent,
) => Uint8Array | null | undefined | Promise<Uint8Array | null | undefined>;

export interface ProjectSessionJournalInput {
  readonly sessionId: string;
  readonly events: readonly SessionJournalEvent[];
  /** Required permission allowlist. Empty or absent at runtime exposes no payload. */
  readonly allowedClassifications: readonly PayloadClassification[];
  /** Source allowlist for trajectory only. Omission includes every known source kind. */
  readonly trajectorySources?: readonly SessionEventSourceKind[];
  readonly blobReader?: JournalBlobReader;
  readonly criticalRegistry?: ProjectionCriticalRegistry;
  /** Checkpoint and throughSequence must be supplied together. */
  readonly checkpoint?: SessionProjectionCheckpoint;
  readonly throughSequence?: number;
}

export type SessionProjectionErrorCode =
  | "invalid_input"
  | "invalid_permission_policy"
  | "invalid_critical_registry"
  | "checkpoint_pair_required"
  | "checkpoint_integrity_mismatch"
  | "checkpoint_policy_mismatch"
  | "mixed_session"
  | "sequence_order_mismatch"
  | "sequence_gap"
  | "previous_hash_mismatch"
  | "payload_hash_mismatch"
  | "request_hash_mismatch"
  | "event_hash_mismatch"
  | "duplicate_event_conflict"
  | "blob_reader_required"
  | "blob_read_failed"
  | "blob_missing"
  | "blob_integrity_mismatch";

export class SessionProjectionError extends Error {
  public constructor(
    message: string,
    public readonly code: SessionProjectionErrorCode,
    public readonly sequence: number | null = null,
    public readonly eventId: string | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionProjectionError";
  }
}
