import type {
  JournalBlobReference,
  PayloadClassification,
} from "@private-fund/contracts";

export type MaybePromise<T> = T | Promise<T>;

export interface TenantEncryptionKey {
  /** Stable, non-secret identifier used to resolve a key during reads. */
  readonly keyId: string;
  /** Exactly 32 bytes. The store copies this value and never persists it. */
  readonly key: Uint8Array;
}

export interface TenantKeyResolver {
  getActiveKey(tenantId: string): MaybePromise<TenantEncryptionKey>;
  getKey(
    tenantId: string,
    keyId: string,
  ): MaybePromise<TenantEncryptionKey | null>;
  destroyKey?(
    tenantId: string,
    keyId: string,
  ): MaybePromise<void>;
}

export type BlobWriteSource = Uint8Array | AsyncIterable<Uint8Array>;

export interface PutBlobRequest {
  readonly tenantId: string;
  readonly source: BlobWriteSource;
  readonly mimeType: string;
  readonly classification: PayloadClassification;
  readonly signal?: AbortSignal;
}

export interface ReadBlobRequest {
  readonly tenantId: string;
  readonly reference: JournalBlobReference;
  readonly signal?: AbortSignal;
}

export interface ReadBlobResult {
  readonly reference: JournalBlobReference;
  readonly bytes: Uint8Array;
}

export type DeleteBlobMode = "tombstone" | "purge";

export interface DeleteBlobRequest {
  readonly tenantId: string;
  readonly reference: JournalBlobReference;
  readonly mode: DeleteBlobMode;
  /** A bounded machine-readable reason. It is never interpreted as a path. */
  readonly reasonCode?: string;
  readonly signal?: AbortSignal;
}

export interface DeleteBlobResult {
  readonly blobId: string;
  readonly mode: DeleteBlobMode;
  readonly status: "deleted" | "already_tombstoned" | "already_absent";
}

export interface DestroyTenantKeyRequest {
  readonly tenantId: string;
  readonly keyId: string;
  /** Explicit acknowledgement because key destruction is irreversible. */
  readonly confirmIrreversible: true;
}

export interface SweepOrphanTempsRequest {
  /** Only controlled temporary names older than this duration are removed. */
  readonly olderThanMs: number;
  readonly signal?: AbortSignal;
}

export interface SweepOrphanTempsResult {
  readonly examined: number;
  readonly removed: number;
}

export interface RetentionRequest {
  readonly tenantId: string;
  readonly olderThan: Date;
  readonly classifications?: readonly PayloadClassification[];
  readonly mode: DeleteBlobMode;
  /** Retention is dry-run unless both dryRun=false and confirm=true. */
  readonly dryRun?: boolean;
  readonly confirm?: true;
  readonly signal?: AbortSignal;
}

export interface RetentionFailure {
  readonly blobId: string;
  readonly code: string;
}

export interface RetentionResult {
  readonly examined: number;
  readonly eligible: number;
  readonly deleted: number;
  readonly dryRun: boolean;
  readonly failures: readonly RetentionFailure[];
}

export interface LocalEncryptedBlobStoreOptions {
  readonly rootDirectory: string;
  readonly keyResolver: TenantKeyResolver;
  /** Limits writes, stored as bytes. Defaults to 512 MiB. */
  readonly maxBlobBytes?: number;
  /** Limits allocation by read(). Defaults to maxBlobBytes. */
  readonly maxReadBytes?: number;
  /** Injectable clock for deterministic retention/tombstone tests. */
  readonly now?: () => Date;
}

export interface LocalEncryptedBlobStore {
  put(request: PutBlobRequest): Promise<JournalBlobReference>;
  read(request: ReadBlobRequest): Promise<ReadBlobResult>;
  delete(request: DeleteBlobRequest): Promise<DeleteBlobResult>;
  applyRetention(request: RetentionRequest): Promise<RetentionResult>;
  sweepOrphanTemps(
    request: SweepOrphanTempsRequest,
  ): Promise<SweepOrphanTempsResult>;
  destroyTenantKey(request: DestroyTenantKeyRequest): Promise<void>;
  dispose(): Promise<void>;
}
