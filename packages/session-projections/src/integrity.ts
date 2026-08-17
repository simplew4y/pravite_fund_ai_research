import type { SessionJournalEvent } from "@private-fund/contracts";
import { canonicalJsonSha256 } from "@private-fund/core";

type JournalRequestHashInput = Pick<
  SessionJournalEvent,
  | "schemaVersion"
  | "type"
  | "operationId"
  | "turnId"
  | "stepId"
  | "source"
  | "causationEventId"
  | "classification"
  | "payloadHash"
  | "blobReferences"
>;

/** Mirrors the canonical payload hash used by the append-only Journal writer. */
export function computeSessionJournalPayloadHash(
  payload: Readonly<Record<string, unknown>>,
): string {
  return canonicalJsonSha256(payload);
}

/**
 * Mirrors the Journal's semantic idempotency request hash without importing
 * the DB package. Storage identity, timestamp and sequence are deliberately not
 * request semantics.
 */
export function computeSessionJournalRequestHash(
  event: JournalRequestHashInput,
): string {
  return canonicalJsonSha256({
    schemaVersion: event.schemaVersion,
    type: event.type,
    operationId: event.operationId,
    turnId: event.turnId,
    stepId: event.stepId,
    source: event.source,
    causationEventId: event.causationEventId,
    classification: event.classification,
    payloadHash: event.payloadHash,
    blobReferences: event.blobReferences,
  });
}

/** Mirrors the Journal event-chain hash over every durable field except itself. */
export function computeSessionJournalEventHash(
  event: Omit<SessionJournalEvent, "eventHash">,
): string {
  return canonicalJsonSha256(event);
}
