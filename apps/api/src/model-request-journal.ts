import {
  journalBlobReferenceSchema,
  modelProviderEventSchema,
  modelRequestSnapshotSchema,
  type JournalBlobReference,
  type ModelProviderEvent,
  type ModelRequestSnapshot,
  type PayloadClassification,
} from "@private-fund/contracts";
import {
  canonicalJsonSha256,
  canonicalizeJson,
  sha256Hex,
} from "@private-fund/core";
import type { SessionJournalRepository } from "@private-fund/db";
import type {
  ModelProviderEventCommit,
  ModelRequestCommitReceipt,
  ModelRequestJournal,
} from "@private-fund/model-runtime";

export const MODEL_AUDIT_PAYLOAD_SCHEMA_VERSION = 1 as const;

export interface ModelAuditBlobWriteInput {
  readonly tenantNamespace: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly classification: PayloadClassification;
  readonly mimeType: "application/json";
  readonly bytes: Uint8Array;
}

export interface ModelAuditBlobWriter {
  write(input: ModelAuditBlobWriteInput): Promise<JournalBlobReference>;
}

export interface RepositoryModelRequestJournalOptions {
  readonly tenantNamespace: string;
  readonly repository: SessionJournalRepository;
  readonly sourceVersion: string;
  readonly inlineLimitBytes?: number;
  readonly blobWriter?: ModelAuditBlobWriter;
}

export class ModelAuditPayloadRequiredError extends Error {
  public readonly code = "model_audit_blob_required";

  public constructor() {
    super("The model audit payload requires an approved encrypted Blob writer");
    this.name = "ModelAuditPayloadRequiredError";
  }
}

export class ModelAuditBlobIntegrityError extends Error {
  public readonly code = "model_audit_blob_integrity_mismatch";

  public constructor() {
    super("The model audit Blob writer returned inconsistent integrity metadata");
    this.name = "ModelAuditBlobIntegrityError";
  }
}

interface StoredAuditPayload {
  readonly payload: Record<string, unknown>;
  readonly blobReferences: readonly JournalBlobReference[];
}

const CLASSIFICATION_RANK: Readonly<Record<PayloadClassification, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

function requiredSnapshotClassification(
  snapshot: ModelRequestSnapshot,
): PayloadClassification {
  let classification: PayloadClassification = "internal";
  for (const source of snapshot.sourceManifest) {
    if (
      CLASSIFICATION_RANK[source.classification] >
      CLASSIFICATION_RANK[classification]
    ) {
      classification = source.classification;
    }
  }
  return classification;
}

function expectedEventClassification(
  event: ModelProviderEvent,
): PayloadClassification {
  return event.type === "delta" && event.channel === "reasoning"
    ? "restricted"
    : "confidential";
}

function eventType(event: ModelProviderEvent): string {
  switch (event.type) {
    case "delta":
      return event.channel === "reasoning"
        ? "message.thinking.delta"
        : "message.assistant.delta";
    case "tool_call":
      return "assistant.toolcall_end";
    case "usage":
      return "usage.updated";
    case "final":
      return "model.stream.completed";
    case "error":
      return "model.stream.error";
    case "aborted":
      return "model.stream.aborted";
  }
}

function idempotencyKey(value: unknown): string {
  return `model_${canonicalJsonSha256(value)}`;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

export class RepositoryModelRequestJournal implements ModelRequestJournal {
  readonly #tenantNamespace: string;
  readonly #repository: SessionJournalRepository;
  readonly #sourceVersion: string;
  readonly #inlineLimitBytes: number;
  readonly #blobWriter: ModelAuditBlobWriter | undefined;

  public constructor(options: RepositoryModelRequestJournalOptions) {
    if (options.tenantNamespace.trim().length === 0) {
      throw new TypeError("tenantNamespace must be non-empty");
    }
    if (
      options.sourceVersion.trim().length === 0 ||
      options.sourceVersion.length > 200
    ) {
      throw new TypeError("sourceVersion must contain between 1 and 200 characters");
    }
    this.#tenantNamespace = options.tenantNamespace;
    this.#repository = options.repository;
    this.#sourceVersion = options.sourceVersion;
    this.#inlineLimitBytes = positiveInteger(
      options.inlineLimitBytes ?? 64 * 1024,
      "inlineLimitBytes",
    );
    this.#blobWriter = options.blobWriter;
  }

  public async commitRequest(
    rawSnapshot: ModelRequestSnapshot,
    classification: PayloadClassification,
  ): Promise<ModelRequestCommitReceipt> {
    const snapshot = modelRequestSnapshotSchema.parse(rawSnapshot);
    if (
      CLASSIFICATION_RANK[classification] <
      CLASSIFICATION_RANK[requiredSnapshotClassification(snapshot)]
    ) {
      throw new TypeError("Model request audit classification is too weak");
    }
    const auditIdempotencyKey = idempotencyKey({
      kind: "model.request.snapshot",
      requestId: snapshot.requestId,
    });
    const stored = await this.#storePayload(
      snapshot.sessionId,
      auditIdempotencyKey,
      classification,
      snapshot,
    );
    const result = this.#repository.appendForTenant(this.#tenantNamespace, {
      schemaVersion: 1,
      sessionId: snapshot.sessionId,
      type: "model.request.snapshot",
      operationId: snapshot.operationId,
      turnId: snapshot.turnId,
      stepId: snapshot.stepId,
      source: {
        kind: "model",
        id: snapshot.providerId,
        version: this.#sourceVersion,
      },
      causationEventId: null,
      idempotencyKey: auditIdempotencyKey,
      classification,
      payload: stored.payload,
      blobReferences: [...stored.blobReferences],
    });
    return {
      eventId: result.event.eventId,
      sequence: result.event.sequence,
      created: result.created,
    };
  }

  public async commitProviderEvent(
    rawInput: ModelProviderEventCommit,
  ): Promise<void> {
    const snapshot = modelRequestSnapshotSchema.parse(rawInput.snapshot);
    const event = modelProviderEventSchema.parse(rawInput.event);
    positiveInteger(rawInput.requestSequence, "requestSequence");
    positiveInteger(rawInput.eventIndex, "eventIndex");
    if (rawInput.requestEventId.trim().length === 0) {
      throw new TypeError("requestEventId must be non-empty");
    }
    if (
      CLASSIFICATION_RANK[rawInput.classification] <
      CLASSIFICATION_RANK[expectedEventClassification(event)]
    ) {
      throw new TypeError("Model Provider event classification is too weak");
    }
    const auditIdempotencyKey = idempotencyKey({
      kind: "model.provider.event",
      requestId: snapshot.requestId,
      eventIndex: rawInput.eventIndex,
    });
    const stored = await this.#storePayload(
      snapshot.sessionId,
      auditIdempotencyKey,
      rawInput.classification,
      event,
    );
    this.#repository.appendForTenant(this.#tenantNamespace, {
      schemaVersion: 1,
      sessionId: snapshot.sessionId,
      type: eventType(event),
      operationId: snapshot.operationId,
      turnId: snapshot.turnId,
      stepId: snapshot.stepId,
      source: {
        kind: "model",
        id: snapshot.providerId,
        version: this.#sourceVersion,
      },
      causationEventId: rawInput.requestEventId,
      idempotencyKey: auditIdempotencyKey,
      classification: rawInput.classification,
      payload: stored.payload,
      blobReferences: [...stored.blobReferences],
    });
  }

  async #storePayload(
    sessionId: string,
    auditIdempotencyKey: string,
    classification: PayloadClassification,
    value: unknown,
  ): Promise<StoredAuditPayload> {
    const canonical = canonicalizeJson(value);
    const bytes = new TextEncoder().encode(canonical);
    const contentHash = sha256Hex(bytes);
    const requiresBlob =
      classification === "restricted" || bytes.byteLength > this.#inlineLimitBytes;
    if (!requiresBlob) {
      return {
        payload: {
          schemaVersion: MODEL_AUDIT_PAYLOAD_SCHEMA_VERSION,
          storage: "inline",
          contentHash,
          sizeBytes: bytes.byteLength,
          value: JSON.parse(canonical) as unknown,
        },
        blobReferences: [],
      };
    }
    if (this.#blobWriter === undefined) {
      throw new ModelAuditPayloadRequiredError();
    }

    let rawReference: JournalBlobReference;
    try {
      rawReference = await this.#blobWriter.write({
        tenantNamespace: this.#tenantNamespace,
        sessionId,
        idempotencyKey: auditIdempotencyKey,
        classification,
        mimeType: "application/json",
        bytes,
      });
    } catch {
      throw new ModelAuditPayloadRequiredError();
    }
    const reference = journalBlobReferenceSchema.parse(rawReference);
    if (
      reference.sha256 !== contentHash ||
      reference.sizeBytes !== bytes.byteLength ||
      reference.mimeType !== "application/json" ||
      reference.classification !== classification
    ) {
      throw new ModelAuditBlobIntegrityError();
    }
    return {
      payload: {
        schemaVersion: MODEL_AUDIT_PAYLOAD_SCHEMA_VERSION,
        storage: "blob",
        contentHash,
        sizeBytes: bytes.byteLength,
        blobId: reference.blobId,
      },
      blobReferences: [reference],
    };
  }
}
