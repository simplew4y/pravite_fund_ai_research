import type { SessionEvent } from "@private-fund/contracts";
import type {
  SessionEventsRepository,
  SessionJournalIntegrityReport,
  SessionJournalRepository,
} from "@private-fund/db";

import type { SessionEventSourceKind } from "@private-fund/contracts";

const SHADOW_SOURCE_VERSION = "shadow-sync/1";
const SYNC_BATCH = 500;

/** Derive the journal source kind from a durable event's type prefix. */
export function shadowSourceKind(eventType: string): SessionEventSourceKind {
  if (eventType === "message.user") return "user";
  const prefix = eventType.split(".", 1)[0];
  switch (prefix) {
    case "tool":
      return "tool";
    case "model":
    case "usage":
      return "model";
    case "message":
    case "agent":
    case "compaction":
    case "summarization":
      return "agent";
    default:
      return "runtime";
  }
}

export function shadowIdempotencyKey(
  sessionId: string,
  sequence: number,
): string {
  return `shadow-${sessionId}-${String(sequence)}`;
}

export interface ShadowSessionJournalOptions {
  readonly sessionEvents: SessionEventsRepository;
  readonly sessionJournal: SessionJournalRepository;
  readonly enabled: boolean;
  readonly onError?: (error: unknown, sessionId: string) => void;
}

/**
 * Phase 1 shadow writer: lazily reconciles the legacy `session_events`
 * stream into the append-only Session Journal (hash chain, idempotency).
 *
 * Reconciliation instead of per-writer hooks because sequence 1
 * (`session.created`) is inserted directly by the sessions repository inside
 * its create/fork transactions — copying "everything after the journal's
 * last sequence" covers every writer and is idempotent by construction.
 *
 * Shadow-phase contract: sync failures MUST NOT break the user path; they
 * are counted and reported, never thrown.
 */
export class ShadowSessionJournal {
  readonly #sessionEvents: SessionEventsRepository;
  readonly #sessionJournal: SessionJournalRepository;
  readonly #enabled: boolean;
  readonly #onError: (error: unknown, sessionId: string) => void;
  #failureCount = 0;
  #syncedCount = 0;

  constructor(options: ShadowSessionJournalOptions) {
    this.#sessionEvents = options.sessionEvents;
    this.#sessionJournal = options.sessionJournal;
    this.#enabled = options.enabled;
    this.#onError =
      options.onError ??
      ((error, sessionId) => {
        console.error(
          `Session Journal shadow sync failed for ${sessionId}`,
          error,
        );
      });
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get failureCount(): number {
    return this.#failureCount;
  }

  get syncedCount(): number {
    return this.#syncedCount;
  }

  /**
   * Copy legacy events newer than the journal's tail into the journal.
   * Returns the number of events appended; never throws.
   */
  sync(tenantNamespace: string, sessionId: string): number {
    if (!this.#enabled) return 0;
    let appended = 0;
    try {
      let after = this.#journalTail(tenantNamespace, sessionId);
      for (;;) {
        const batch = this.#sessionEvents.replayForTenant(
          tenantNamespace,
          sessionId,
          after,
          SYNC_BATCH,
        );
        if (batch.length === 0) break;
        for (const event of batch) {
          this.#append(tenantNamespace, event);
          appended += 1;
        }
        after = batch[batch.length - 1]!.sequence;
        if (batch.length < SYNC_BATCH) break;
      }
      this.#syncedCount += appended;
      return appended;
    } catch (error) {
      this.#failureCount += 1;
      this.#onError(error, sessionId);
      return appended;
    }
  }

  verify(
    tenantNamespace: string,
    sessionId: string,
  ): SessionJournalIntegrityReport {
    return this.#sessionJournal.verifyIntegrityForTenant(
      tenantNamespace,
      sessionId,
    );
  }

  #journalTail(tenantNamespace: string, sessionId: string): number {
    let tail = 0;
    for (;;) {
      const batch = this.#sessionJournal.replayForTenant(
        tenantNamespace,
        sessionId,
        tail,
        SYNC_BATCH,
      );
      if (batch.length === 0) return tail;
      tail = batch[batch.length - 1]!.sequence;
      if (batch.length < SYNC_BATCH) return tail;
    }
  }

  #append(tenantNamespace: string, event: SessionEvent): void {
    this.#sessionJournal.appendForTenant(tenantNamespace, {
      sessionId: event.sessionId,
      type: event.type,
      timestamp: event.timestamp,
      operationId: event.operationId,
      turnId: null,
      stepId: null,
      source: {
        kind: shadowSourceKind(event.type),
        id: null,
        version: SHADOW_SOURCE_VERSION,
      },
      causationEventId: null,
      idempotencyKey: shadowIdempotencyKey(event.sessionId, event.sequence),
      classification: "internal",
      payload: { ...event.payload, shadowSequence: event.sequence },
      blobReferences: [],
      schemaVersion: 1,
    });
  }
}
