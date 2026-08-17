import {
  payloadClassificationSchema,
  sessionEventSourceKindSchema,
  sessionEventTypeSchema,
  sessionJournalEventSchema,
  type JournalBlobReference,
  type PayloadClassification,
  type SessionEventSourceKind,
  type SessionJournalEvent,
} from "@private-fund/contracts";
import {
  canonicalJsonSha256,
  canonicalizeJson,
  sha256Hex,
} from "@private-fund/core";

import {
  computeSessionJournalEventHash,
  computeSessionJournalPayloadHash,
  computeSessionJournalRequestHash,
} from "./integrity.js";
import {
  SESSION_PROJECTION_VERSION,
  SessionProjectionError,
  type IndexableJournalReference,
  type NormalizedMessageItem,
  type NormalizedOperationItem,
  type NormalizedToolItem,
  type NormalizedTranscriptItem,
  type OperationRecoveryState,
  type ProjectSessionJournalInput,
  type ProjectedBlobReference,
  type ProjectedPayload,
  type ProjectionCheckpointBlocker,
  type ProjectionCriticalRegistry,
  type SessionProjectionCheckpoint,
  type SessionProjectionResult,
  type SessionRecoverySnapshot,
  type SeenJournalEvent,
  type ToolRecoveryState,
  type TrajectoryEvent,
  type VersionedTrajectory,
  type VersionedTranscript,
} from "./types.js";

export const DEFAULT_CRITICAL_EVENT_PREFIXES = Object.freeze([
  "message.",
  "operation.",
  "tool.",
  "session.",
  "model.request.",
  "authority.",
  "security.",
  "journal.",
  "checkpoint.",
] as const);

/**
 * Events understood by projection version 1. Some are trajectory-only; being
 * known means the event can safely pass a checkpoint even when no transcript
 * reducer is needed for it.
 */
export const DEFAULT_KNOWN_SESSION_EVENT_TYPES = Object.freeze([
  "agent.bash.delta",
  "agent.queue.updated",
  "agent.retry.completed",
  "agent.retry.started",
  "agent.run.ended",
  "agent.turn.completed",
  "agent.turn.started",
  "assistant.start",
  "assistant.text_end",
  "assistant.text_start",
  "assistant.thinking_end",
  "assistant.thinking_start",
  "assistant.toolcall_delta",
  "assistant.toolcall_end",
  "assistant.toolcall_start",
  "compaction.completed",
  "compaction.started",
  "message.assistant.completed",
  "message.assistant.delta",
  "message.completed",
  "message.started",
  "message.thinking.delta",
  "message.user",
  "model.request.snapshot",
  "model.stream.aborted",
  "model.stream.completed",
  "model.stream.error",
  "operation.cancelled",
  "operation.completed",
  "operation.failed",
  "operation.interrupted",
  "operation.queued",
  "operation.running",
  "operation.started",
  "operation.timed_out",
  "session.created",
  "session.entry.appended",
  "session.fork.created",
  "session.forked",
  "session.info.changed",
  "session.recovery.failed",
  "session.resource.created",
  "session.resource.deleted",
  "session.status",
  "session.thinking.changed",
  "summarization.retry.completed",
  "summarization.retry.scheduled",
  "summarization.retry.started",
  "tool.completed",
  "tool.failed",
  "tool.progress",
  "tool.started",
  "usage.updated",
] as const);

const ALL_CLASSIFICATIONS = Object.freeze([
  "public",
  "internal",
  "confidential",
  "restricted",
] as const satisfies readonly PayloadClassification[]);

const ALL_SOURCE_KINDS = Object.freeze([
  "user",
  "system",
  "agent",
  "model",
  "tool",
  "subagent",
  "context",
  "runtime",
  "migration",
] as const satisfies readonly SessionEventSourceKind[]);

const SHA256 = /^[a-f0-9]{64}$/u;
const CRITICAL_PREFIX = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*\.$/u;

interface ProjectionPolicy {
  readonly allowedClassifications: readonly PayloadClassification[];
  readonly allowedSet: ReadonlySet<PayloadClassification>;
  readonly trajectorySources: readonly SessionEventSourceKind[];
  readonly trajectorySourceSet: ReadonlySet<SessionEventSourceKind>;
  readonly fingerprint: string;
}

interface PreparedRegistry {
  readonly knownEventTypes: ReadonlySet<string>;
  readonly criticalPrefixes: readonly string[];
  readonly fingerprint: string;
}

interface MutableProjectionState {
  throughSequence: number;
  lastEventHash: string | null;
  expectedSequence: number;
  readonly seenEventHashes: Map<string, SeenJournalEvent>;
  readonly trajectoryEvents: TrajectoryEvent[];
  readonly transcriptItems: NormalizedTranscriptItem[];
  readonly operationStates: Map<string, OperationRecoveryState>;
  readonly toolStates: Map<string, ToolRecoveryState>;
  readonly indexReferences: IndexableJournalReference[];
  readonly checkpointBlockers: ProjectionCheckpointBlocker[];
}

function projectionError(
  message: string,
  code: ConstructorParameters<typeof SessionProjectionError>[1],
  event?: Pick<SessionJournalEvent, "sequence" | "eventId">,
  options?: ErrorOptions,
): SessionProjectionError {
  return new SessionProjectionError(
    message,
    code,
    event?.sequence ?? null,
    event?.eventId ?? null,
    options,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalizeJson(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function uniqueInReferenceOrder<T extends string>(
  values: readonly T[],
  reference: readonly T[],
): readonly T[] {
  const selected = new Set(values);
  return Object.freeze(reference.filter((value) => selected.has(value)));
}

function preparePolicy(input: ProjectSessionJournalInput): ProjectionPolicy {
  const rawClassifications = (
    input as { readonly allowedClassifications?: unknown }
  ).allowedClassifications;
  const classifications = rawClassifications === undefined ? [] : rawClassifications;
  if (!Array.isArray(classifications)) {
    throw projectionError(
      "allowedClassifications must be an explicit array",
      "invalid_permission_policy",
    );
  }
  const parsedClassifications: PayloadClassification[] = [];
  for (const classification of classifications) {
    const parsed = payloadClassificationSchema.safeParse(classification);
    if (!parsed.success) {
      throw projectionError(
        "allowedClassifications contains an unsupported classification",
        "invalid_permission_policy",
      );
    }
    parsedClassifications.push(parsed.data);
  }
  const allowedClassifications = uniqueInReferenceOrder(
    parsedClassifications,
    ALL_CLASSIFICATIONS,
  );

  const rawSources = (
    input as { readonly trajectorySources?: unknown }
  ).trajectorySources;
  if (rawSources !== undefined && !Array.isArray(rawSources)) {
    throw projectionError(
      "trajectorySources must be an array when supplied",
      "invalid_permission_policy",
    );
  }
  const parsedSources: SessionEventSourceKind[] = [];
  for (const source of rawSources ?? ALL_SOURCE_KINDS) {
    const parsed = sessionEventSourceKindSchema.safeParse(source);
    if (!parsed.success) {
      throw projectionError(
        "trajectorySources contains an unsupported source kind",
        "invalid_permission_policy",
      );
    }
    parsedSources.push(parsed.data);
  }
  const trajectorySources = uniqueInReferenceOrder(
    parsedSources,
    ALL_SOURCE_KINDS,
  );
  const fingerprint = canonicalJsonSha256({
    projectionVersion: SESSION_PROJECTION_VERSION,
    allowedClassifications,
    trajectorySources,
    restrictedPayloadsInline: false,
  });
  return {
    allowedClassifications,
    allowedSet: new Set(allowedClassifications),
    trajectorySources,
    trajectorySourceSet: new Set(trajectorySources),
    fingerprint,
  };
}

function prepareRegistry(
  registry: ProjectionCriticalRegistry | undefined,
): PreparedRegistry {
  const knownEventTypes = new Set<string>(DEFAULT_KNOWN_SESSION_EVENT_TYPES);
  const additions = registry?.additionalKnownEventTypes ?? [];
  if (!Array.isArray(additions)) {
    throw projectionError(
      "additionalKnownEventTypes must be an array",
      "invalid_critical_registry",
    );
  }
  for (const eventType of additions) {
    const parsed = sessionEventTypeSchema.safeParse(eventType);
    if (!parsed.success) {
      throw projectionError(
        "additionalKnownEventTypes contains an invalid event type",
        "invalid_critical_registry",
      );
    }
    knownEventTypes.add(parsed.data);
  }

  const rawPrefixes = registry?.criticalPrefixes ?? DEFAULT_CRITICAL_EVENT_PREFIXES;
  if (!Array.isArray(rawPrefixes)) {
    throw projectionError(
      "criticalPrefixes must be an array",
      "invalid_critical_registry",
    );
  }
  const criticalPrefixes = [...new Set(rawPrefixes)].sort();
  if (
    criticalPrefixes.some(
      (prefix) => typeof prefix !== "string" || !CRITICAL_PREFIX.test(prefix),
    )
  ) {
    throw projectionError(
      "criticalPrefixes must be lowercase dotted namespace prefixes",
      "invalid_critical_registry",
    );
  }
  const sortedKnownEventTypes = [...knownEventTypes].sort();
  return {
    knownEventTypes,
    criticalPrefixes: Object.freeze(criticalPrefixes),
    fingerprint: canonicalJsonSha256({
      projectionVersion: SESSION_PROJECTION_VERSION,
      knownEventTypes: sortedKnownEventTypes,
      criticalPrefixes,
    }),
  };
}

function payloadIsVisible(
  classification: PayloadClassification,
  policy: ProjectionPolicy,
): boolean {
  return classification !== "restricted" && policy.allowedSet.has(classification);
}

function reasoningEventType(type: string): boolean {
  return (
    type.includes(".thinking.") ||
    type.endsWith(".thinking") ||
    type.includes(".reasoning.") ||
    type.endsWith(".reasoning")
  );
}

function sanitizeInlineReasoning(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (
        isRecord(entry) &&
        (entry.type === "thinking" ||
          entry.type === "reasoning" ||
          entry.type === "analysis")
      ) {
        return { type: entry.type, redacted: true };
      }
      return sanitizeInlineReasoning(entry);
    });
  }
  if (!isRecord(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
    result[key] =
      normalized === "rawreasoning" ||
      normalized === "chainofthought" ||
      normalized === "internalthinking"
        ? "[REDACTED]"
        : sanitizeInlineReasoning(child);
  }
  return result;
}

function eventPayloadIsVisible(
  event: Pick<TrajectoryEvent, "classification" | "type">,
  policy: ProjectionPolicy,
): boolean {
  return (
    !reasoningEventType(event.type) &&
    payloadIsVisible(event.classification, policy)
  );
}

function projectPayload(
  event: SessionJournalEvent,
  policy: ProjectionPolicy,
): ProjectedPayload {
  if (reasoningEventType(event.type)) {
    return Object.freeze({
      visibility: "redacted",
      reason: "reasoning_payload",
    });
  }
  if (event.classification === "restricted") {
    return Object.freeze({
      visibility: "redacted",
      reason: "restricted_payload",
    });
  }
  if (!policy.allowedSet.has(event.classification)) {
    return Object.freeze({
      visibility: "redacted",
      reason: "classification_not_allowed",
    });
  }
  const sanitized = sanitizeInlineReasoning(event.payload);
  if (!isRecord(sanitized)) {
    throw projectionError(
      "Session Journal payload sanitization changed the payload shape",
      "invalid_input",
      event,
    );
  }
  return deepFreeze({
    visibility: "visible",
    value: canonicalClone(sanitized),
  } as const);
}

function projectBlobReference(
  reference: JournalBlobReference,
  policy: ProjectionPolicy,
): ProjectedBlobReference {
  const allowed = payloadIsVisible(reference.classification, policy);
  return Object.freeze({
    kind: "journal_blob",
    classification: reference.classification,
    allowed,
    blobId: allowed ? reference.blobId : null,
    sha256: allowed ? reference.sha256 : null,
    sizeBytes: allowed ? reference.sizeBytes : null,
    mimeType: allowed ? reference.mimeType : null,
  });
}

function indexReference(
  event: SessionJournalEvent,
  reference: JournalBlobReference,
  policy: ProjectionPolicy,
): IndexableJournalReference {
  const projected = projectBlobReference(reference, policy);
  return Object.freeze({
    kind: "journal_blob",
    sessionId: event.sessionId,
    eventId: event.eventId,
    sequence: event.sequence,
    eventType: event.type,
    sourceKind: event.source.kind,
    classification: reference.classification,
    allowed: projected.allowed,
    blobId: projected.blobId,
    sha256: projected.sha256,
    sizeBytes: projected.sizeBytes,
    mimeType: projected.mimeType,
  });
}

function textFromContent(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const textParts: string[] = [];
  for (const block of value) {
    if (typeof block === "string") {
      textParts.push(block);
      continue;
    }
    if (!isRecord(block)) {
      continue;
    }
    const type = block.type;
    if (type === "thinking" || type === "reasoning" || type === "analysis") {
      continue;
    }
    if (
      type === "text" ||
      type === "input_text" ||
      type === "output_text"
    ) {
      if (typeof block.text === "string") {
        textParts.push(block.text);
      } else if (typeof block.content === "string") {
        textParts.push(block.content);
      }
    }
  }
  return textParts.length === 0 ? null : textParts.join("");
}

function messageText(payload: Readonly<Record<string, unknown>>): string | null {
  for (const key of ["content", "delta", "text"] as const) {
    const direct = textFromContent(payload[key]);
    if (direct !== null) {
      return direct;
    }
  }
  if (!isRecord(payload.message)) {
    return null;
  }
  return textFromContent(payload.message.content);
}

function transcriptBase(
  event: SessionJournalEvent,
  redacted: boolean,
): Pick<
  NormalizedMessageItem,
  | "eventId"
  | "sequence"
  | "timestamp"
  | "operationId"
  | "turnId"
  | "classification"
  | "redacted"
> {
  return {
    eventId: event.eventId,
    sequence: event.sequence,
    timestamp: event.timestamp,
    operationId: event.operationId,
    turnId: event.turnId,
    classification: event.classification,
    redacted,
  };
}

function messageRoleFromPayload(
  payload: Readonly<Record<string, unknown>>,
): "user" | "assistant" | null {
  if (!isRecord(payload.message)) {
    return null;
  }
  return payload.message.role === "user" || payload.message.role === "assistant"
    ? payload.message.role
    : null;
}

function normalizeTranscriptEvent(
  event: SessionJournalEvent,
  policy: ProjectionPolicy,
): NormalizedTranscriptItem | null {
  const visible = payloadIsVisible(event.classification, policy);
  const redacted = !visible;

  if (
    event.type === "message.user" ||
    event.type === "message.assistant.delta" ||
    event.type === "message.assistant.completed" ||
    event.type === "message.completed"
  ) {
    const role =
      event.type === "message.user"
        ? "user"
        : event.type === "message.completed"
          ? messageRoleFromPayload(event.payload)
          : "assistant";
    if (role === null) {
      return null;
    }
    return Object.freeze({
      kind: "message",
      ...transcriptBase(event, redacted),
      role,
      status: event.type === "message.assistant.delta" ? "delta" : "completed",
      content: visible ? messageText(event.payload) : null,
    });
  }

  const toolStatus: NormalizedToolItem["status"] | null =
    event.type === "tool.started"
      ? "started"
      : event.type === "tool.progress"
        ? "progress"
        : event.type === "tool.completed"
          ? "completed"
          : event.type === "tool.failed"
            ? "failed"
            : null;
  if (toolStatus !== null) {
    return Object.freeze({
      kind: "tool",
      ...transcriptBase(event, redacted),
      toolCallId:
        typeof event.payload.toolCallId === "string"
          ? event.payload.toolCallId
          : null,
      toolName:
        visible && typeof event.payload.toolName === "string"
          ? event.payload.toolName
          : null,
      status: toolStatus,
    });
  }

  const operationStatus: NormalizedOperationItem["status"] | null =
    event.type === "operation.queued"
      ? "queued"
      : event.type === "operation.started" || event.type === "operation.running"
        ? "running"
        : event.type === "operation.completed"
          ? "completed"
          : event.type === "operation.failed"
            ? "failed"
            : event.type === "operation.interrupted"
              ? "interrupted"
              : event.type === "operation.cancelled"
                ? "cancelled"
                : event.type === "operation.timed_out"
                  ? "timed_out"
                  : null;
  if (operationStatus !== null) {
    return Object.freeze({
      kind: "operation",
      ...transcriptBase(event, redacted),
      status: operationStatus,
    });
  }
  return null;
}

function verifyEventIntegrity(rawEvent: SessionJournalEvent): SessionJournalEvent {
  let event: SessionJournalEvent;
  try {
    event = sessionJournalEventSchema.parse(rawEvent);
  } catch (error) {
    throw projectionError(
      "Session Journal event does not match the durable schema",
      "invalid_input",
      isRecord(rawEvent) &&
        typeof rawEvent.sequence === "number" &&
        typeof rawEvent.eventId === "string"
        ? { sequence: rawEvent.sequence, eventId: rawEvent.eventId }
        : undefined,
      { cause: error },
    );
  }

  let payloadHash: string;
  let requestHash: string;
  let eventHash: string;
  try {
    payloadHash = computeSessionJournalPayloadHash(event.payload);
    requestHash = computeSessionJournalRequestHash(event);
    const { eventHash: _storedEventHash, ...withoutEventHash } = event;
    eventHash = computeSessionJournalEventHash(withoutEventHash);
  } catch (error) {
    throw projectionError(
      "Session Journal event contains non-canonical data",
      "payload_hash_mismatch",
      event,
      { cause: error },
    );
  }
  if (payloadHash !== event.payloadHash) {
    throw projectionError(
      "Session Journal payload hash does not match",
      "payload_hash_mismatch",
      event,
    );
  }
  if (requestHash !== event.requestHash) {
    throw projectionError(
      "Session Journal request hash does not match",
      "request_hash_mismatch",
      event,
    );
  }
  if (eventHash !== event.eventHash) {
    throw projectionError(
      "Session Journal event hash does not match",
      "event_hash_mismatch",
      event,
    );
  }
  return event;
}

async function verifyBlobReferences(
  event: SessionJournalEvent,
  input: ProjectSessionJournalInput,
  policy: ProjectionPolicy,
): Promise<void> {
  const readableReferences = event.blobReferences.filter((reference) =>
    payloadIsVisible(reference.classification, policy),
  );
  if (readableReferences.length === 0) {
    return;
  }
  if (input.blobReader === undefined) {
    throw projectionError(
      "A blob reader is required for referenced Journal payloads",
      "blob_reader_required",
      event,
    );
  }
  for (const reference of readableReferences) {
    let contents: Uint8Array | null | undefined;
    try {
      contents = await input.blobReader(reference, event);
    } catch (error) {
      throw projectionError(
        "Journal blob reader failed",
        "blob_read_failed",
        event,
        { cause: error },
      );
    }
    if (contents === null || contents === undefined) {
      throw projectionError(
        "A referenced Journal blob is missing",
        "blob_missing",
        event,
      );
    }
    if (!(contents instanceof Uint8Array)) {
      throw projectionError(
        "Journal blob reader must return bytes or an explicit missing value",
        "blob_read_failed",
        event,
      );
    }
    if (
      contents.byteLength !== reference.sizeBytes ||
      sha256Hex(contents) !== reference.sha256
    ) {
      throw projectionError(
        "Referenced Journal blob does not match its integrity metadata",
        "blob_integrity_mismatch",
        event,
      );
    }
  }
}

function checkpointIntegrityError(message: string): SessionProjectionError {
  return projectionError(message, "checkpoint_integrity_mismatch");
}

function assertCheckpointVisibility(
  snapshot: SessionRecoverySnapshot,
  policy: ProjectionPolicy,
): void {
  for (const event of snapshot.trajectory.events) {
    if (!policy.trajectorySourceSet.has(event.source.kind)) {
      throw checkpointIntegrityError(
        "Checkpoint trajectory violates its source filter",
      );
    }
    const shouldBeVisible = eventPayloadIsVisible(event, policy);
    if (
      (shouldBeVisible && event.payload.visibility !== "visible") ||
      (!shouldBeVisible && event.payload.visibility !== "redacted")
    ) {
      throw checkpointIntegrityError(
        "Checkpoint trajectory violates its classification policy",
      );
    }
  }
  for (const item of snapshot.transcript.items) {
    const shouldBeVisible = payloadIsVisible(item.classification, policy);
    if (item.redacted === shouldBeVisible) {
      throw checkpointIntegrityError(
        "Checkpoint transcript violates its classification policy",
      );
    }
    if (!shouldBeVisible) {
      if (item.kind === "message" && item.content !== null) {
        throw checkpointIntegrityError(
          "Checkpoint exposes a redacted message payload",
        );
      }
      if (item.kind === "tool" && item.toolName !== null) {
        throw checkpointIntegrityError(
          "Checkpoint exposes redacted tool metadata",
        );
      }
    }
  }
}

function restoreCheckpoint(
  input: ProjectSessionJournalInput,
  policy: ProjectionPolicy,
  registry: PreparedRegistry,
): MutableProjectionState {
  const checkpointSupplied = input.checkpoint !== undefined;
  const throughSequenceSupplied = input.throughSequence !== undefined;
  if (checkpointSupplied !== throughSequenceSupplied) {
    throw projectionError(
      "checkpoint and throughSequence must be supplied together",
      "checkpoint_pair_required",
    );
  }
  if (!checkpointSupplied || input.checkpoint === undefined) {
    return {
      throughSequence: 0,
      lastEventHash: null,
      expectedSequence: 1,
      seenEventHashes: new Map(),
      trajectoryEvents: [],
      transcriptItems: [],
      operationStates: new Map(),
      toolStates: new Map(),
      indexReferences: [],
      checkpointBlockers: [],
    };
  }

  const checkpoint: unknown = input.checkpoint;
  if (!isRecord(checkpoint) || !isRecord(checkpoint.snapshot)) {
    throw checkpointIntegrityError("Checkpoint must be a versioned data object");
  }
  if (
    checkpoint.schemaVersion !== SESSION_PROJECTION_VERSION ||
    typeof checkpoint.checksum !== "string" ||
    !SHA256.test(checkpoint.checksum) ||
    !Number.isSafeInteger(checkpoint.throughSequence) ||
    Number(checkpoint.throughSequence) < 0 ||
    checkpoint.throughSequence !== input.throughSequence
  ) {
    throw checkpointIntegrityError("Checkpoint envelope is invalid");
  }

  let checksum: string;
  try {
    checksum = canonicalJsonSha256(checkpoint.snapshot);
  } catch (error) {
    throw new SessionProjectionError(
      "Checkpoint snapshot is not canonical data",
      "checkpoint_integrity_mismatch",
      null,
      null,
      { cause: error },
    );
  }
  if (checksum !== checkpoint.checksum) {
    throw checkpointIntegrityError("Checkpoint checksum does not match");
  }

  const snapshot = canonicalClone(
    checkpoint.snapshot,
  ) as unknown as SessionRecoverySnapshot;
  if (
    snapshot.projectionVersion !== SESSION_PROJECTION_VERSION ||
    snapshot.sessionId !== input.sessionId ||
    snapshot.throughSequence !== input.throughSequence ||
    (snapshot.lastEventHash !== null &&
      (typeof snapshot.lastEventHash !== "string" ||
        !SHA256.test(snapshot.lastEventHash))) ||
    !Array.isArray(snapshot.allowedClassifications) ||
    !isRecord(snapshot.trajectory) ||
    snapshot.trajectory.projectionVersion !== SESSION_PROJECTION_VERSION ||
    !Array.isArray(snapshot.trajectory.sourceFilter) ||
    !Array.isArray(snapshot.trajectory.events) ||
    !isRecord(snapshot.transcript) ||
    snapshot.transcript.projectionVersion !== SESSION_PROJECTION_VERSION ||
    !Array.isArray(snapshot.transcript.items) ||
    !Array.isArray(snapshot.operationStates) ||
    !Array.isArray(snapshot.toolStates) ||
    !Array.isArray(snapshot.indexReferences) ||
    !Array.isArray(snapshot.seenEvents) ||
    !Array.isArray(snapshot.checkpointBlockers) ||
    snapshot.checkpointBlockers.length !== 0
  ) {
    throw checkpointIntegrityError("Checkpoint snapshot shape is invalid");
  }
  if (
    snapshot.policyFingerprint !== policy.fingerprint ||
    snapshot.registryFingerprint !== registry.fingerprint ||
    canonicalizeJson(snapshot.allowedClassifications) !==
      canonicalizeJson(policy.allowedClassifications) ||
    canonicalizeJson(snapshot.trajectory.sourceFilter) !==
      canonicalizeJson(policy.trajectorySources)
  ) {
    throw projectionError(
      "Checkpoint permission policy or event registry changed",
      "checkpoint_policy_mismatch",
    );
  }
  if (
    snapshot.seenEvents.length !== snapshot.throughSequence ||
    (snapshot.throughSequence === 0) !== (snapshot.lastEventHash === null)
  ) {
    throw checkpointIntegrityError("Checkpoint sequence history is incomplete");
  }

  const seenEventHashes = new Map<string, SeenJournalEvent>();
  for (let index = 0; index < snapshot.seenEvents.length; index += 1) {
    const seen = snapshot.seenEvents[index];
    if (
      seen === undefined ||
      !isRecord(seen) ||
      typeof seen.eventId !== "string" ||
      seen.eventId.length === 0 ||
      typeof seen.eventHash !== "string" ||
      !SHA256.test(seen.eventHash) ||
      seen.sequence !== index + 1 ||
      seenEventHashes.has(seen.eventId)
    ) {
      throw checkpointIntegrityError("Checkpoint event history is invalid");
    }
    seenEventHashes.set(
      seen.eventId,
      Object.freeze({
        eventId: seen.eventId,
        eventHash: seen.eventHash,
        sequence: seen.sequence,
      }),
    );
  }
  if (
    snapshot.throughSequence > 0 &&
    snapshot.seenEvents.at(-1)?.eventHash !== snapshot.lastEventHash
  ) {
    throw checkpointIntegrityError("Checkpoint head hash is inconsistent");
  }
  assertCheckpointVisibility(snapshot, policy);

  const operationStates = new Map<string, OperationRecoveryState>();
  for (const state of snapshot.operationStates) {
    if (
      !isRecord(state) ||
      typeof state.operationId !== "string" ||
      typeof state.eventId !== "string" ||
      !Number.isSafeInteger(state.sequence) ||
      (state.status !== "queued" &&
        state.status !== "running" &&
        state.status !== "completed" &&
        state.status !== "failed" &&
        state.status !== "interrupted" &&
        state.status !== "cancelled" &&
        state.status !== "timed_out")
    ) {
      throw checkpointIntegrityError("Checkpoint operation state is invalid");
    }
    operationStates.set(
      state.operationId,
      Object.freeze({
        operationId: state.operationId,
        status: state.status,
        eventId: state.eventId,
        sequence: state.sequence as number,
      }),
    );
  }
  const toolStates = new Map<string, ToolRecoveryState>();
  for (const state of snapshot.toolStates) {
    if (
      !isRecord(state) ||
      typeof state.toolCallId !== "string" ||
      (state.toolName !== null && typeof state.toolName !== "string") ||
      typeof state.eventId !== "string" ||
      !Number.isSafeInteger(state.sequence) ||
      (state.status !== "started" &&
        state.status !== "progress" &&
        state.status !== "completed" &&
        state.status !== "failed")
    ) {
      throw checkpointIntegrityError("Checkpoint tool state is invalid");
    }
    toolStates.set(
      state.toolCallId,
      Object.freeze({
        toolCallId: state.toolCallId,
        toolName: state.toolName,
        status: state.status,
        eventId: state.eventId,
        sequence: state.sequence as number,
      }),
    );
  }

  return {
    throughSequence: snapshot.throughSequence,
    lastEventHash: snapshot.lastEventHash,
    expectedSequence: snapshot.throughSequence + 1,
    seenEventHashes,
    trajectoryEvents: [...snapshot.trajectory.events],
    transcriptItems: [...snapshot.transcript.items],
    operationStates,
    toolStates,
    indexReferences: [...snapshot.indexReferences],
    checkpointBlockers: [],
  };
}

function updateRecoveryState(
  item: NormalizedTranscriptItem,
  state: MutableProjectionState,
): void {
  if (item.kind === "operation" && item.operationId !== null) {
    state.operationStates.set(
      item.operationId,
      Object.freeze({
        operationId: item.operationId,
        status: item.status,
        eventId: item.eventId,
        sequence: item.sequence,
      }),
    );
  }
  if (item.kind === "tool" && item.toolCallId !== null) {
    state.toolStates.set(
      item.toolCallId,
      Object.freeze({
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        status: item.status,
        eventId: item.eventId,
        sequence: item.sequence,
      }),
    );
  }
}

function applyEvent(
  event: SessionJournalEvent,
  state: MutableProjectionState,
  policy: ProjectionPolicy,
  registry: PreparedRegistry,
): void {
  const knownType = registry.knownEventTypes.has(event.type);
  const criticalType = registry.criticalPrefixes.some((prefix) =>
    event.type.startsWith(prefix),
  );
  if (!knownType && criticalType) {
    state.checkpointBlockers.push(
      Object.freeze({
        code: "unknown_critical_event",
        eventId: event.eventId,
        sequence: event.sequence,
        type: event.type,
      }),
    );
  }

  const projectedReferences = event.blobReferences.map((reference) =>
    projectBlobReference(reference, policy),
  );
  if (policy.trajectorySourceSet.has(event.source.kind)) {
    state.trajectoryEvents.push(
      deepFreeze({
        eventId: event.eventId,
        sessionId: event.sessionId,
        sequence: event.sequence,
        timestamp: event.timestamp,
        type: event.type,
        operationId: event.operationId,
        turnId: event.turnId,
        stepId: event.stepId,
        source: canonicalClone(event.source),
        causationEventId: event.causationEventId,
        classification: event.classification,
        payload: projectPayload(event, policy),
        blobReferences: projectedReferences,
        knownType,
        criticalType,
      }),
    );
  }

  const transcriptItem = normalizeTranscriptEvent(event, policy);
  if (transcriptItem !== null) {
    state.transcriptItems.push(transcriptItem);
    updateRecoveryState(transcriptItem, state);
  }
  for (const reference of event.blobReferences) {
    state.indexReferences.push(indexReference(event, reference, policy));
  }
}

function sortedOperationStates(
  states: ReadonlyMap<string, OperationRecoveryState>,
): readonly OperationRecoveryState[] {
  return Object.freeze(
    [...states.values()].sort((left, right) =>
      left.operationId < right.operationId
        ? -1
        : left.operationId > right.operationId
          ? 1
          : 0,
    ),
  );
}

function sortedToolStates(
  states: ReadonlyMap<string, ToolRecoveryState>,
): readonly ToolRecoveryState[] {
  return Object.freeze(
    [...states.values()].sort((left, right) =>
      left.toolCallId < right.toolCallId
        ? -1
        : left.toolCallId > right.toolCallId
          ? 1
          : 0,
    ),
  );
}

function buildResult(
  sessionId: string,
  state: MutableProjectionState,
  policy: ProjectionPolicy,
  registry: PreparedRegistry,
): SessionProjectionResult {
  const trajectory: VersionedTrajectory = deepFreeze({
    projectionVersion: SESSION_PROJECTION_VERSION,
    sourceFilter: policy.trajectorySources,
    events: [...state.trajectoryEvents],
  });
  const transcript: VersionedTranscript = deepFreeze({
    projectionVersion: SESSION_PROJECTION_VERSION,
    items: [...state.transcriptItems],
  });
  const operationStates = sortedOperationStates(state.operationStates);
  const toolStates = sortedToolStates(state.toolStates);
  const indexReferences = Object.freeze([...state.indexReferences]);
  const seenEvents = Object.freeze(
    [...state.seenEventHashes.values()].sort(
      (left, right) => left.sequence - right.sequence,
    ),
  );
  const checkpointBlockers = Object.freeze([...state.checkpointBlockers]);
  const recoverySnapshot: SessionRecoverySnapshot = deepFreeze({
    projectionVersion: SESSION_PROJECTION_VERSION,
    sessionId,
    throughSequence: state.throughSequence,
    lastEventHash: state.lastEventHash,
    policyFingerprint: policy.fingerprint,
    registryFingerprint: registry.fingerprint,
    allowedClassifications: policy.allowedClassifications,
    trajectory,
    transcript,
    operationStates,
    toolStates,
    indexReferences,
    seenEvents,
    checkpointBlockers,
  });
  const checksum = canonicalJsonSha256(recoverySnapshot);
  const checkpoint: SessionProjectionCheckpoint | null =
    checkpointBlockers.length === 0
      ? deepFreeze({
          schemaVersion: SESSION_PROJECTION_VERSION,
          throughSequence: state.throughSequence,
          checksum,
          snapshot: recoverySnapshot,
        })
      : null;
  return deepFreeze({
    projectionVersion: SESSION_PROJECTION_VERSION,
    sessionId,
    throughSequence: state.throughSequence,
    lastEventHash: state.lastEventHash,
    trajectory,
    transcript,
    operationStates,
    toolStates,
    indexReferences,
    recoverySnapshot,
    checksum,
    checkpoint,
    checkpointBlockers,
  });
}

/**
 * Deterministically rebuilds a Session projection from an integrity-checked
 * Journal stream. The only I/O hook is an explicit blob reader; blob bytes are
 * verified but are never embedded into transcript, trajectory or index output.
 */
export async function projectSessionJournal(
  input: ProjectSessionJournalInput,
): Promise<SessionProjectionResult> {
  if (
    typeof input.sessionId !== "string" ||
    input.sessionId.length === 0 ||
    !Array.isArray(input.events)
  ) {
    throw projectionError(
      "sessionId and an event array are required",
      "invalid_input",
    );
  }
  const policy = preparePolicy(input);
  const registry = prepareRegistry(input.criticalRegistry);
  const state = restoreCheckpoint(input, policy, registry);

  let previousInputSequence: number | null = null;
  for (const rawEvent of input.events) {
    const event = verifyEventIntegrity(rawEvent);
    if (event.sessionId !== input.sessionId) {
      throw projectionError(
        "Projection input mixes Session identities",
        "mixed_session",
        event,
      );
    }
    if (
      previousInputSequence !== null &&
      event.sequence < previousInputSequence
    ) {
      throw projectionError(
        "Projection input is not sorted by sequence",
        "sequence_order_mismatch",
        event,
      );
    }
    previousInputSequence = event.sequence;
    await verifyBlobReferences(event, input, policy);

    const seen = state.seenEventHashes.get(event.eventId);
    if (seen !== undefined) {
      if (seen.eventHash !== event.eventHash) {
        throw projectionError(
          "A Journal eventId was reused with a different hash",
          "duplicate_event_conflict",
          event,
        );
      }
      continue;
    }
    if (event.sequence !== state.expectedSequence) {
      throw projectionError(
        `Expected Journal sequence ${String(state.expectedSequence)}`,
        "sequence_gap",
        event,
      );
    }
    if (event.previousHash !== state.lastEventHash) {
      throw projectionError(
        "Session Journal previousHash does not match the projected head",
        "previous_hash_mismatch",
        event,
      );
    }

    applyEvent(event, state, policy, registry);
    const seenEvent = Object.freeze({
      eventId: event.eventId,
      eventHash: event.eventHash,
      sequence: event.sequence,
    });
    state.seenEventHashes.set(event.eventId, seenEvent);
    state.throughSequence = event.sequence;
    state.lastEventHash = event.eventHash;
    state.expectedSequence = event.sequence + 1;
  }

  return buildResult(input.sessionId, state, policy, registry);
}
