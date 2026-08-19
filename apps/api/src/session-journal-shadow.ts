import type { DatabaseSync } from "node:sqlite";

import type { SessionEvent } from "@private-fund/contracts";
import type {
  SessionEventsRepository,
  SessionJournalIntegrityReport,
  SessionJournalRepository,
} from "@private-fund/db";
import { withTransaction } from "@private-fund/db";

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

export type SessionJournalMode = "shadow" | "authority";

export interface ShadowSessionJournalOptions {
  readonly database: DatabaseSync;
  readonly sessionEvents: SessionEventsRepository;
  readonly sessionJournal: SessionJournalRepository;
  readonly enabled: boolean;
  /**
   * shadow: the legacy table is authoritative; the journal mirrors lazily
   * and mirror failures never break the user path.
   * authority: the journal is authoritative; every durable event is written
   * to both tables in one transaction and a journal failure rejects the
   * write outright (fail closed).
   */
  readonly mode?: SessionJournalMode;
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
  readonly #database: DatabaseSync;
  readonly #enabled: boolean;
  readonly #mode: SessionJournalMode;
  readonly #onError: (error: unknown, sessionId: string) => void;
  readonly #cursors = new Map<string, number>();
  #failureCount = 0;
  #syncedCount = 0;

  constructor(options: ShadowSessionJournalOptions) {
    this.#database = options.database;
    this.#sessionEvents = options.sessionEvents;
    this.#sessionJournal = options.sessionJournal;
    this.#enabled = options.enabled;
    this.#mode = options.mode ?? "shadow";
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

  get mode(): SessionJournalMode {
    return this.#mode;
  }

  /**
   * Authority-mode write path: append the legacy UI projection and its
   * journal fact in ONE transaction. The mirror uses the exact shadow-sync
   * envelope (same idempotency key, source and payload), so flipping modes
   * in either direction never conflicts with existing rows.
   *
   * In shadow mode this degrades to the legacy append plus a lazy,
   * failure-tolerant sync — the historical behaviour.
   */
  appendWithMirror(
    tenantNamespace: string,
    appendLegacy: () => SessionEvent,
  ): SessionEvent {
    if (!this.#enabled || this.#mode !== "authority") {
      const event = appendLegacy();
      if (this.#enabled) this.sync(tenantNamespace, event.sessionId);
      return event;
    }
    const event = withTransaction(this.#database, () => {
      const appended = appendLegacy();
      // Backfill rows written outside this path (session.created and fork
      // copies are inserted inside the sessions repository transaction), so
      // the mirrored stream keeps the exact legacy order.
      this.#catchUp(tenantNamespace, appended.sessionId, appended.sequence - 1);
      this.#append(tenantNamespace, appended);
      this.#syncedCount += 1;
      return appended;
    });
    // Advance the watermark only after the transaction committed; a rolled
    // back mirror must not leave the cursor ahead of the journal.
    this.#cursors.set(
      this.#cursorKey(tenantNamespace, event.sessionId),
      event.sequence,
    );
    return event;
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
    try {
      const { appended, cursor } = this.#catchUp(
        tenantNamespace,
        sessionId,
        Number.MAX_SAFE_INTEGER,
      );
      this.#cursors.set(this.#cursorKey(tenantNamespace, sessionId), cursor);
      this.#syncedCount += appended;
      return appended;
    } catch (error) {
      this.#failureCount += 1;
      this.#onError(error, sessionId);
      return 0;
    }
  }

  /** Mirror every legacy event with sequence <= through (idempotent). */
  #catchUp(
    tenantNamespace: string,
    sessionId: string,
    through: number,
  ): { appended: number; cursor: number } {
    let appended = 0;
    let after = this.#mirrorCursor(tenantNamespace, sessionId);
    while (after < through) {
      const batch = this.#sessionEvents.replayForTenant(
        tenantNamespace,
        sessionId,
        after,
        SYNC_BATCH,
      );
      if (batch.length === 0) break;
      for (const event of batch) {
        if (event.sequence > through) break;
        this.#append(tenantNamespace, event);
        appended += 1;
        after = event.sequence;
      }
      if (
        batch.length < SYNC_BATCH ||
        batch[batch.length - 1]!.sequence > through
      ) {
        break;
      }
    }
    return { appended, cursor: after };
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

  #cursorKey(tenantNamespace: string, sessionId: string): string {
    return `${tenantNamespace}|${sessionId}`;
  }

  /**
   * Highest legacy sequence already mirrored. The journal interleaves tool
   * and model audit rows, so the watermark is the max shadowSequence among
   * shadow-sync rows — never the journal's own tail sequence.
   */
  #mirrorCursor(tenantNamespace: string, sessionId: string): number {
    const cached = this.#cursors.get(this.#cursorKey(tenantNamespace, sessionId));
    if (cached !== undefined) return cached;
    let tail = 0;
    let after = 0;
    for (;;) {
      const batch = this.#sessionJournal.replayForTenant(
        tenantNamespace,
        sessionId,
        after,
        SYNC_BATCH,
      );
      if (batch.length === 0) break;
      for (const event of batch) {
        if (event.source.version !== SHADOW_SOURCE_VERSION) continue;
        const mirrored = event.payload.shadowSequence;
        if (typeof mirrored === "number" && mirrored > tail) tail = mirrored;
      }
      after = batch[batch.length - 1]!.sequence;
      if (batch.length < SYNC_BATCH) break;
    }
    this.#cursors.set(this.#cursorKey(tenantNamespace, sessionId), tail);
    return tail;
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
