import type {
  AppendSessionJournalEvent,
  JournalBlobReference,
  Project,
  Session,
  SessionEvent,
  SessionEventType,
  SessionJournalEvent,
} from "@private-fund/contracts";

export interface UserRecord {
  readonly id: string;
  readonly dataNamespace: string;
  readonly email: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectRecord extends Project {
  readonly userId: string;
  readonly tenantNamespace: string;
  readonly deletedAt: string | null;
  readonly retainedUntil: string | null;
}

export interface ProjectLifecycleEventRecord {
  readonly eventId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly action: "tombstoned" | "restored";
  readonly deletedAt: string;
  readonly retainedUntil: string;
  readonly occurredAt: string;
}

export interface SessionRecord extends Session {
  readonly userId: string;
  readonly tenantNamespace: string;
  readonly model: string | null;
  readonly piSessionFile: string | null;
  readonly deletedAt: string | null;
}

export type OperationStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export interface OperationRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: string;
  readonly status: OperationStatus;
  readonly idempotencyKey: string;
  readonly request: Record<string, unknown>;
  readonly result: unknown;
  readonly error: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

export interface AppendSessionEventInput {
  readonly sessionId: string;
  readonly type: SessionEventType;
  readonly payload: Record<string, unknown>;
  readonly operationId?: string | null;
  readonly timestamp?: string;
}

export type AppendSessionJournalEventInput = AppendSessionJournalEvent;

export interface AppendSessionJournalEventResult {
  readonly event: SessionJournalEvent;
  readonly created: boolean;
}

export interface SessionJournalOutboxRecord {
  readonly outboxId: number;
  readonly tenantNamespace: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly attemptCount: number;
  readonly lastError: string | null;
}

export interface SessionJournalIntegrityReport {
  readonly valid: boolean;
  readonly eventCount: number;
  readonly checkedThroughSequence: number;
  readonly lastEventHash: string | null;
  readonly issue: string | null;
}

export interface CreateOperationResult {
  readonly operation: OperationRecord;
  readonly created: boolean;
}

export type {
  JournalBlobReference,
  Project,
  Session,
  SessionEvent,
  SessionJournalEvent,
};
