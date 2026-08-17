import {
  constants as fsConstants,
  type Dirent,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type {
  JournalBlobReference,
  PayloadClassification,
} from "@private-fund/contracts";

import {
  BlobAbortError,
  BlobFormatError,
  BlobIntegrityError,
  BlobIoError,
  BlobKeyDestructionUnsupportedError,
  BlobKeyError,
  BlobKeyUnavailableError,
  BlobNotFoundError,
  BlobReferenceError,
  BlobRequestError,
  BlobSizeLimitError,
  BlobStoreClosedError,
  BlobStoreError,
  BlobTenantScopeError,
  BlobTombstonedError,
} from "./errors.js";
import type {
  BlobWriteSource,
  DeleteBlobRequest,
  DeleteBlobResult,
  DestroyTenantKeyRequest,
  LocalEncryptedBlobStore,
  LocalEncryptedBlobStoreOptions,
  PutBlobRequest,
  ReadBlobRequest,
  ReadBlobResult,
  RetentionFailure,
  RetentionRequest,
  RetentionResult,
  SweepOrphanTempsRequest,
  SweepOrphanTempsResult,
  TenantEncryptionKey,
} from "./types.js";

const FORMAT_NAME = "private-fund-local-encrypted-blob";
const FORMAT_VERSION = 1;
const ALGORITHM = "aes-256-gcm";
const MAGIC = Buffer.from("PFBLOB01", "ascii");
const PREFIX_FIXED_BYTES = MAGIC.byteLength + 4;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const SHA256_BYTES = 32;
const SIZE_BYTES = 8;
const TRAILER_BYTES =
  AUTH_TAG_BYTES + SIZE_BYTES + SHA256_BYTES + SHA256_BYTES;
const MAX_HEADER_BYTES = 16 * 1024;
const DEFAULT_MAX_BLOB_BYTES = 512 * 1024 * 1024;
const IO_CHUNK_BYTES = 64 * 1024;
const BLOB_ID_PREFIX = "blob_v1_";
const BLOB_ID_PATTERN = /^blob_v1_([0-9a-f]{64})$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const REASON_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const TEMP_FILE_PATTERN = /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.part$/u;
const OFFICIAL_FILE_PATTERN = /^([0-9a-f]{64})\.pfblob$/u;
const TENANT_DIRECTORY_PATTERN = /^[0-9a-f]{64}$/u;

const CLASSIFICATIONS: Readonly<Record<PayloadClassification, true>> = {
  public: true,
  internal: true,
  confidential: true,
  restricted: true,
};

interface StoredHeader {
  readonly format: typeof FORMAT_NAME;
  readonly version: typeof FORMAT_VERSION;
  readonly algorithm: typeof ALGORITHM;
  readonly tenantScopeHash: string;
  readonly keyId: string;
  readonly iv: string;
  readonly mimeType: string;
  readonly classification: PayloadClassification;
}

interface StoredTrailer {
  readonly authTag: Buffer;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly blobDigest: string;
}

interface DecodedBlob {
  readonly reference: JournalBlobReference;
  readonly bytes: Uint8Array | null;
}

interface StorePaths {
  readonly tenantDirectory: string;
  readonly objectDirectory: string;
}

type StoreState = "open" | "closing" | "closed";

function isNodeErrorWithCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}

function sha256Hex(...values: readonly (string | Uint8Array)[]): string {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(value);
  }
  return hash.digest("hex");
}

function tenantScopeHash(tenantId: string): string {
  return sha256Hex("private-fund-blob-tenant-v1\0", tenantId);
}

function blobDigest(
  tenantHash: string,
  contentHash: string,
  mimeType: string,
  classification: PayloadClassification,
): string {
  return sha256Hex(
    "private-fund-blob-id-v1\0",
    Buffer.from(tenantHash, "hex"),
    Buffer.from(contentHash, "hex"),
    "\0",
    mimeType,
    "\0",
    classification,
  );
}

function blobIdFromDigest(digest: string): string {
  return `${BLOB_ID_PREFIX}${digest}`;
}

function assertTenantId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.trim() !== value ||
    value.includes("\0")
  ) {
    throw new BlobRequestError("Tenant scope is invalid");
  }
}

function assertMimeType(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new BlobRequestError("Blob MIME type is invalid");
  }
}

function assertClassification(
  value: unknown,
): asserts value is PayloadClassification {
  if (
    typeof value !== "string" ||
    !Object.prototype.hasOwnProperty.call(CLASSIFICATIONS, value)
  ) {
    throw new BlobRequestError("Blob classification is invalid");
  }
}

function assertKeyId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !KEY_ID_PATTERN.test(value)) {
    throw new BlobKeyError();
  }
}

function assertReasonCode(value: unknown): asserts value is string {
  if (typeof value !== "string" || !REASON_CODE_PATTERN.test(value)) {
    throw new BlobRequestError("Deletion reason code is invalid");
  }
}

function assertSafeLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BlobRequestError(`${label} must be a non-negative safe integer`);
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new BlobAbortError();
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new BlobFormatError();
  }
}

function normalizeReference(value: unknown): JournalBlobReference {
  if (!isPlainObject(value)) {
    throw new BlobReferenceError();
  }
  const expectedKeys = [
    "blobId",
    "sha256",
    "sizeBytes",
    "mimeType",
    "classification",
  ] as const;
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== [...expectedKeys].sort()[index])
  ) {
    throw new BlobReferenceError();
  }
  if (
    typeof value.blobId !== "string" ||
    !BLOB_ID_PATTERN.test(value.blobId) ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256) ||
    typeof value.sizeBytes !== "number" ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 0
  ) {
    throw new BlobReferenceError();
  }
  try {
    assertMimeType(value.mimeType);
    assertClassification(value.classification);
  } catch {
    throw new BlobReferenceError();
  }
  return Object.freeze({
    blobId: value.blobId,
    sha256: value.sha256,
    sizeBytes: value.sizeBytes,
    mimeType: value.mimeType,
    classification: value.classification,
  });
}

function referenceFor(
  tenantHash: string,
  contentHash: string,
  sizeBytes: number,
  mimeType: string,
  classification: PayloadClassification,
): JournalBlobReference {
  const digest = blobDigest(
    tenantHash,
    contentHash,
    mimeType,
    classification,
  );
  return Object.freeze({
    blobId: blobIdFromDigest(digest),
    sha256: contentHash,
    sizeBytes,
    mimeType,
    classification,
  });
}

function assertReferenceTenantScope(
  tenantHash: string,
  reference: JournalBlobReference,
): string {
  const expectedDigest = blobDigest(
    tenantHash,
    reference.sha256,
    reference.mimeType,
    reference.classification,
  );
  const match = BLOB_ID_PATTERN.exec(reference.blobId);
  if (match?.[1] !== expectedDigest) {
    throw new BlobTenantScopeError();
  }
  return expectedDigest;
}

function validateEncryptionKey(
  value: TenantEncryptionKey,
  expectedKeyId?: string,
): { readonly keyId: string; readonly key: Buffer } {
  if (!isPlainObject(value)) {
    throw new BlobKeyError();
  }
  assertKeyId(value.keyId);
  if (
    expectedKeyId !== undefined &&
    value.keyId !== expectedKeyId
  ) {
    throw new BlobKeyError();
  }
  if (!(value.key instanceof Uint8Array) || value.key.byteLength !== 32) {
    throw new BlobKeyError();
  }
  return { keyId: value.keyId, key: Buffer.from(value.key) };
}

function encodeHeader(header: StoredHeader): Buffer {
  const encoded = Buffer.from(JSON.stringify(header), "utf8");
  if (encoded.byteLength > MAX_HEADER_BYTES) {
    throw new BlobFormatError();
  }
  const fixed = Buffer.alloc(PREFIX_FIXED_BYTES);
  MAGIC.copy(fixed, 0);
  fixed.writeUInt32BE(encoded.byteLength, MAGIC.byteLength);
  return Buffer.concat([fixed, encoded]);
}

function parseHeader(encoded: Buffer): StoredHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded));
  } catch {
    throw new BlobFormatError();
  }
  if (!isPlainObject(parsed)) {
    throw new BlobFormatError();
  }
  assertExactKeys(parsed, [
    "format",
    "version",
    "algorithm",
    "tenantScopeHash",
    "keyId",
    "iv",
    "mimeType",
    "classification",
  ]);
  if (
    parsed.format !== FORMAT_NAME ||
    parsed.version !== FORMAT_VERSION ||
    parsed.algorithm !== ALGORITHM ||
    typeof parsed.tenantScopeHash !== "string" ||
    !SHA256_PATTERN.test(parsed.tenantScopeHash) ||
    typeof parsed.iv !== "string"
  ) {
    throw new BlobFormatError();
  }
  try {
    assertKeyId(parsed.keyId);
    assertMimeType(parsed.mimeType);
    assertClassification(parsed.classification);
  } catch {
    throw new BlobFormatError();
  }
  let iv: Buffer;
  try {
    iv = Buffer.from(parsed.iv, "base64url");
  } catch {
    throw new BlobFormatError();
  }
  if (
    iv.byteLength !== IV_BYTES ||
    iv.toString("base64url") !== parsed.iv
  ) {
    throw new BlobFormatError();
  }
  return {
    format: FORMAT_NAME,
    version: FORMAT_VERSION,
    algorithm: ALGORITHM,
    tenantScopeHash: parsed.tenantScopeHash,
    keyId: parsed.keyId,
    iv: parsed.iv,
    mimeType: parsed.mimeType,
    classification: parsed.classification,
  };
}

function encodeTrailer(
  authTag: Uint8Array,
  sizeBytes: number,
  contentHash: string,
  digest: string,
): Buffer {
  const trailer = Buffer.alloc(TRAILER_BYTES);
  Buffer.from(authTag).copy(trailer, 0);
  trailer.writeBigUInt64BE(BigInt(sizeBytes), AUTH_TAG_BYTES);
  Buffer.from(contentHash, "hex").copy(
    trailer,
    AUTH_TAG_BYTES + SIZE_BYTES,
  );
  Buffer.from(digest, "hex").copy(
    trailer,
    AUTH_TAG_BYTES + SIZE_BYTES + SHA256_BYTES,
  );
  return trailer;
}

function parseTrailer(value: Buffer): StoredTrailer {
  if (value.byteLength !== TRAILER_BYTES) {
    throw new BlobFormatError();
  }
  const size = value.readBigUInt64BE(AUTH_TAG_BYTES);
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BlobFormatError();
  }
  return {
    authTag: Buffer.from(value.subarray(0, AUTH_TAG_BYTES)),
    sizeBytes: Number(size),
    sha256: value
      .subarray(AUTH_TAG_BYTES + SIZE_BYTES, AUTH_TAG_BYTES + SIZE_BYTES + SHA256_BYTES)
      .toString("hex"),
    blobDigest: value
      .subarray(AUTH_TAG_BYTES + SIZE_BYTES + SHA256_BYTES)
      .toString("hex"),
  };
}

async function writeAll(handle: FileHandle, value: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const result = await handle.write(
      value,
      offset,
      value.byteLength - offset,
      null,
    );
    if (result.bytesWritten <= 0) {
      throw new BlobIoError();
    }
    offset += result.bytesWritten;
  }
}

async function readExact(
  handle: FileHandle,
  length: number,
  position: number,
): Promise<Buffer> {
  const result = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = await handle.read(
      result,
      offset,
      length - offset,
      position + offset,
    );
    if (read.bytesRead <= 0) {
      throw new BlobFormatError();
    }
    offset += read.bytesRead;
  }
  return result;
}

function asyncIteratorFor(
  source: BlobWriteSource,
): AsyncIterator<Uint8Array> {
  if (source instanceof Uint8Array) {
    let emitted = false;
    return {
      next: async () => {
        if (emitted) {
          return { done: true, value: undefined };
        }
        emitted = true;
        return { done: false, value: source };
      },
      return: async () => ({ done: true, value: undefined }),
    };
  }
  if (
    source === null ||
    typeof source !== "object" ||
    !(Symbol.asyncIterator in source) ||
    typeof source[Symbol.asyncIterator] !== "function"
  ) {
    throw new BlobRequestError("Blob source must be bytes or an async iterable");
  }
  return source[Symbol.asyncIterator]();
}

async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<T>> {
  assertNotAborted(signal);
  if (signal === undefined) {
    return iterator.next();
  }
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      finish(() => reject(new BlobAbortError()));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    let pending: Promise<IteratorResult<T>>;
    try {
      pending = Promise.resolve(iterator.next());
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    void pending.then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function pathKind(
  target: string,
): Promise<"missing" | "file" | "other"> {
  try {
    const information = await lstat(target);
    return information.isFile() && !information.isSymbolicLink()
      ? "file"
      : "other";
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return "missing";
    }
    throw error;
  }
}

async function unlinkIfPresent(target: string): Promise<boolean> {
  try {
    await unlink(target);
    return true;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (
      isNodeErrorWithCode(error, "EINVAL") ||
      isNodeErrorWithCode(error, "ENOTSUP") ||
      isNodeErrorWithCode(error, "EPERM")
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function errorCode(error: unknown): string {
  return error instanceof BlobStoreError
    ? error.code
    : "blob_io_failure";
}

function safeStoreError(error: unknown): BlobStoreError {
  if (error instanceof BlobStoreError) {
    return error;
  }
  return new BlobIoError();
}

export class NodeLocalEncryptedBlobStore
  implements LocalEncryptedBlobStore
{
  readonly #rootDirectory: string;
  readonly #keyResolver: LocalEncryptedBlobStoreOptions["keyResolver"];
  readonly #maxBlobBytes: number;
  readonly #maxReadBytes: number;
  readonly #now: () => Date;
  readonly #blobLocks = new Map<string, Promise<void>>();
  readonly #drainWaiters = new Set<() => void>();
  #state: StoreState = "open";
  #activeOperations = 0;
  #disposePromise: Promise<void> | null = null;

  constructor(options: LocalEncryptedBlobStoreOptions) {
    if (!isPlainObject(options)) {
      throw new BlobRequestError("Blob store options are invalid");
    }
    if (
      typeof options.rootDirectory !== "string" ||
      options.rootDirectory.trim().length === 0
    ) {
      throw new BlobRequestError("Blob store root directory is invalid");
    }
    const resolvedRoot = path.resolve(options.rootDirectory);
    if (resolvedRoot === path.parse(resolvedRoot).root) {
      throw new BlobRequestError("Filesystem root cannot be used as blob root");
    }
    if (
      options.keyResolver === null ||
      typeof options.keyResolver !== "object" ||
      typeof options.keyResolver.getActiveKey !== "function" ||
      typeof options.keyResolver.getKey !== "function"
    ) {
      throw new BlobRequestError("Tenant key resolver is invalid");
    }
    const maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
    const maxReadBytes = options.maxReadBytes ?? maxBlobBytes;
    assertSafeLimit(maxBlobBytes, "maxBlobBytes");
    assertSafeLimit(maxReadBytes, "maxReadBytes");
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new BlobRequestError("Blob store clock is invalid");
    }
    this.#rootDirectory = resolvedRoot;
    this.#keyResolver = options.keyResolver;
    this.#maxBlobBytes = maxBlobBytes;
    this.#maxReadBytes = maxReadBytes;
    this.#now = options.now ?? (() => new Date());
  }

  async put(request: PutBlobRequest): Promise<JournalBlobReference> {
    const finish = this.#beginOperation();
    try {
      return await this.#put(request);
    } catch (error) {
      throw safeStoreError(error);
    } finally {
      finish();
    }
  }

  async read(request: ReadBlobRequest): Promise<ReadBlobResult> {
    const finish = this.#beginOperation();
    try {
      assertTenantId(request.tenantId);
      assertNotAborted(request.signal);
      const reference = normalizeReference(request.reference);
      const tenantHash = tenantScopeHash(request.tenantId);
      const digest = assertReferenceTenantScope(tenantHash, reference);
      const paths = this.#pathsForTenantHash(tenantHash);
      const decoded = await this.#readStoredAtPath({
        tenantId: request.tenantId,
        tenantHash,
        filePath: path.join(paths.objectDirectory, `${digest}.pfblob`),
        expectedReference: reference,
        collectBytes: true,
        signal: request.signal,
      });
      if (decoded.bytes === null) {
        throw new BlobIntegrityError();
      }
      return Object.freeze({
        reference: decoded.reference,
        bytes: decoded.bytes,
      });
    } catch (error) {
      throw safeStoreError(error);
    } finally {
      finish();
    }
  }

  async delete(request: DeleteBlobRequest): Promise<DeleteBlobResult> {
    const finish = this.#beginOperation();
    try {
      assertTenantId(request.tenantId);
      assertNotAborted(request.signal);
      if (request.mode !== "tombstone" && request.mode !== "purge") {
        throw new BlobRequestError("Blob deletion mode is invalid");
      }
      if (request.reasonCode !== undefined) {
        assertReasonCode(request.reasonCode);
      }
      const reference = normalizeReference(request.reference);
      const tenantHash = tenantScopeHash(request.tenantId);
      const digest = assertReferenceTenantScope(tenantHash, reference);
      return await this.#withBlobLock(`${tenantHash}:${digest}`, () =>
        this.#deleteUnlocked(
          tenantHash,
          reference,
          request.mode,
          request.reasonCode,
          request.signal,
        ),
      );
    } catch (error) {
      throw safeStoreError(error);
    } finally {
      finish();
    }
  }

  async applyRetention(request: RetentionRequest): Promise<RetentionResult> {
    const finish = this.#beginOperation();
    try {
      assertTenantId(request.tenantId);
      assertNotAborted(request.signal);
      if (!(request.olderThan instanceof Date) || !Number.isFinite(request.olderThan.getTime())) {
        throw new BlobRequestError("Retention cutoff is invalid");
      }
      if (request.mode !== "tombstone" && request.mode !== "purge") {
        throw new BlobRequestError("Retention deletion mode is invalid");
      }
      const dryRun = request.dryRun ?? true;
      if (!dryRun && request.confirm !== true) {
        throw new BlobRequestError(
          "Non-dry-run retention requires explicit confirmation",
        );
      }
      const classifications = request.classifications === undefined
        ? null
        : new Set(
            request.classifications.map((classification) => {
              assertClassification(classification);
              return classification;
            }),
          );
      const tenantHash = tenantScopeHash(request.tenantId);
      const paths = this.#pathsForTenantHash(tenantHash);
      let entries: Dirent[];
      try {
        entries = await readdir(paths.objectDirectory, { withFileTypes: true });
      } catch (error) {
        if (isNodeErrorWithCode(error, "ENOENT")) {
          return Object.freeze({
            examined: 0,
            eligible: 0,
            deleted: 0,
            dryRun,
            failures: Object.freeze([]),
          });
        }
        throw error;
      }
      let examined = 0;
      let eligible = 0;
      let deleted = 0;
      const failures: RetentionFailure[] = [];
      for (const entry of entries) {
        assertNotAborted(request.signal);
        const match = OFFICIAL_FILE_PATTERN.exec(entry.name);
        if (match === null || !entry.isFile() || entry.isSymbolicLink()) {
          continue;
        }
        examined += 1;
        const filePath = path.join(paths.objectDirectory, entry.name);
        const opaqueBlobId = blobIdFromDigest(match[1]!);
        try {
          const information = await stat(filePath);
          if (information.mtimeMs >= request.olderThan.getTime()) {
            continue;
          }
          const decoded = await this.#readStoredAtPath({
            tenantId: request.tenantId,
            tenantHash,
            filePath,
            expectedReference: null,
            collectBytes: false,
            signal: request.signal,
          });
          if (
            classifications !== null &&
            !classifications.has(decoded.reference.classification)
          ) {
            continue;
          }
          eligible += 1;
          if (!dryRun) {
            const digest = assertReferenceTenantScope(
              tenantHash,
              decoded.reference,
            );
            const result = await this.#withBlobLock(
              `${tenantHash}:${digest}`,
              () =>
                this.#deleteUnlocked(
                  tenantHash,
                  decoded.reference,
                  request.mode,
                  "retention_policy",
                  request.signal,
                ),
            );
            if (result.status === "deleted") {
              deleted += 1;
            }
          }
        } catch (error) {
          if (error instanceof BlobAbortError) {
            throw error;
          }
          failures.push(
            Object.freeze({ blobId: opaqueBlobId, code: errorCode(error) }),
          );
        }
      }
      return Object.freeze({
        examined,
        eligible,
        deleted,
        dryRun,
        failures: Object.freeze(failures),
      });
    } catch (error) {
      throw safeStoreError(error);
    } finally {
      finish();
    }
  }

  async sweepOrphanTemps(
    request: SweepOrphanTempsRequest,
  ): Promise<SweepOrphanTempsResult> {
    const finish = this.#beginOperation();
    try {
      assertSafeLimit(request.olderThanMs, "olderThanMs");
      assertNotAborted(request.signal);
      const tenantRoot = path.join(this.#rootDirectory, "tenants");
      let tenantEntries: Dirent[];
      try {
        tenantEntries = await readdir(tenantRoot, { withFileTypes: true });
      } catch (error) {
        if (isNodeErrorWithCode(error, "ENOENT")) {
          return Object.freeze({ examined: 0, removed: 0 });
        }
        throw error;
      }
      const cutoff = this.#now().getTime() - request.olderThanMs;
      let examined = 0;
      let removed = 0;
      for (const tenantEntry of tenantEntries) {
        assertNotAborted(request.signal);
        if (
          !tenantEntry.isDirectory() ||
          tenantEntry.isSymbolicLink() ||
          !TENANT_DIRECTORY_PATTERN.test(tenantEntry.name)
        ) {
          continue;
        }
        const objectDirectory = path.join(
          tenantRoot,
          tenantEntry.name,
          "objects",
        );
        let objectEntries: Dirent[];
        try {
          objectEntries = await readdir(objectDirectory, {
            withFileTypes: true,
          });
        } catch (error) {
          if (isNodeErrorWithCode(error, "ENOENT")) {
            continue;
          }
          throw error;
        }
        for (const entry of objectEntries) {
          assertNotAborted(request.signal);
          if (!TEMP_FILE_PATTERN.test(entry.name)) {
            continue;
          }
          examined += 1;
          if (!entry.isFile() || entry.isSymbolicLink()) {
            continue;
          }
          const target = path.join(objectDirectory, entry.name);
          const information = await lstat(target);
          if (
            !information.isFile() ||
            information.isSymbolicLink() ||
            information.mtimeMs > cutoff
          ) {
            continue;
          }
          if (await unlinkIfPresent(target)) {
            removed += 1;
          }
        }
        if (removed > 0) {
          await syncDirectory(objectDirectory);
        }
      }
      return Object.freeze({ examined, removed });
    } catch (error) {
      throw safeStoreError(error);
    } finally {
      finish();
    }
  }

  async destroyTenantKey(request: DestroyTenantKeyRequest): Promise<void> {
    const finish = this.#beginOperation();
    try {
      assertTenantId(request.tenantId);
      assertKeyId(request.keyId);
      if (request.confirmIrreversible !== true) {
        throw new BlobRequestError(
          "Key destruction requires explicit irreversible confirmation",
        );
      }
      if (this.#keyResolver.destroyKey === undefined) {
        throw new BlobKeyDestructionUnsupportedError();
      }
      try {
        await this.#keyResolver.destroyKey(request.tenantId, request.keyId);
      } catch {
        throw new BlobIoError();
      }
    } catch (error) {
      throw safeStoreError(error);
    } finally {
      finish();
    }
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== null) {
      return this.#disposePromise;
    }
    this.#state = "closing";
    this.#disposePromise = (async () => {
      if (this.#activeOperations > 0) {
        await new Promise<void>((resolve) => {
          this.#drainWaiters.add(resolve);
        });
      }
      this.#state = "closed";
    })();
    return this.#disposePromise;
  }

  async #put(request: PutBlobRequest): Promise<JournalBlobReference> {
    assertTenantId(request.tenantId);
    assertMimeType(request.mimeType);
    assertClassification(request.classification);
    assertNotAborted(request.signal);
    const iterator = asyncIteratorFor(request.source);
    const tenantHash = tenantScopeHash(request.tenantId);
    const paths = this.#pathsForTenantHash(tenantHash);
    await mkdir(paths.objectDirectory, { recursive: true, mode: 0o700 });
    assertNotAborted(request.signal);

    let resolvedKey: TenantEncryptionKey;
    try {
      resolvedKey = await this.#keyResolver.getActiveKey(request.tenantId);
    } catch {
      throw new BlobKeyUnavailableError();
    }
    const key = validateEncryptionKey(resolvedKey);
    const iv = randomBytes(IV_BYTES);
    const header: StoredHeader = {
      format: FORMAT_NAME,
      version: FORMAT_VERSION,
      algorithm: ALGORITHM,
      tenantScopeHash: tenantHash,
      keyId: key.keyId,
      iv: iv.toString("base64url"),
      mimeType: request.mimeType,
      classification: request.classification,
    };
    const prefix = encodeHeader(header);
    const temporaryPath = path.join(
      paths.objectDirectory,
      `.tmp-${randomUUID()}.part`,
    );
    let handle: FileHandle | undefined;
    let movedToFinal = false;
    let iteratorDone = false;
    try {
      handle = await open(
        temporaryPath,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      await writeAll(handle, prefix);
      let cipher;
      try {
        cipher = createCipheriv(ALGORITHM, key.key, iv, {
          authTagLength: AUTH_TAG_BYTES,
        });
      } finally {
        key.key.fill(0);
      }
      cipher.setAAD(prefix);
      const contentHasher = createHash("sha256");
      let sizeBytes = 0;
      while (true) {
        const next = await nextWithAbort(iterator, request.signal);
        if (next.done) {
          iteratorDone = true;
          break;
        }
        const chunk = next.value;
        if (!(chunk instanceof Uint8Array)) {
          throw new BlobRequestError(
            "Blob stream yielded a non-byte chunk",
          );
        }
        sizeBytes += chunk.byteLength;
        if (
          !Number.isSafeInteger(sizeBytes) ||
          sizeBytes > this.#maxBlobBytes
        ) {
          throw new BlobSizeLimitError();
        }
        assertNotAborted(request.signal);
        contentHasher.update(chunk);
        const encrypted = cipher.update(chunk);
        if (encrypted.byteLength > 0) {
          await writeAll(handle, encrypted);
        }
      }
      assertNotAborted(request.signal);
      const finalCiphertext = cipher.final();
      if (finalCiphertext.byteLength > 0) {
        await writeAll(handle, finalCiphertext);
      }
      const contentHash = contentHasher.digest("hex");
      const reference = referenceFor(
        tenantHash,
        contentHash,
        sizeBytes,
        request.mimeType,
        request.classification,
      );
      const digest = BLOB_ID_PATTERN.exec(reference.blobId)?.[1];
      if (digest === undefined) {
        throw new BlobIntegrityError();
      }
      await writeAll(
        handle,
        encodeTrailer(cipher.getAuthTag(), sizeBytes, contentHash, digest),
      );
      await handle.sync();
      await handle.close();
      handle = undefined;
      assertNotAborted(request.signal);

      const finalPath = path.join(
        paths.objectDirectory,
        `${digest}.pfblob`,
      );
      const tombstonePath = path.join(
        paths.objectDirectory,
        `${digest}.tombstone`,
      );
      await this.#withBlobLock(`${tenantHash}:${digest}`, async () => {
        assertNotAborted(request.signal);
        const tombstoneKind = await pathKind(tombstonePath);
        if (tombstoneKind !== "missing") {
          if (tombstoneKind !== "file") {
            throw new BlobIntegrityError();
          }
          throw new BlobTombstonedError();
        }
        const finalKind = await pathKind(finalPath);
        if (finalKind === "other") {
          throw new BlobIntegrityError();
        }
        if (finalKind === "file") {
          await this.#readStoredAtPath({
            tenantId: request.tenantId,
            tenantHash,
            filePath: finalPath,
            expectedReference: reference,
            collectBytes: false,
            signal: request.signal,
          });
          return;
        }
        await rename(temporaryPath, finalPath);
        movedToFinal = true;
        await syncDirectory(paths.objectDirectory);
      });
      return reference;
    } finally {
      if (!iteratorDone && iterator.return !== undefined) {
        void Promise.resolve(iterator.return()).catch(() => undefined);
      }
      await handle?.close().catch(() => undefined);
      if (!movedToFinal) {
        await unlinkIfPresent(temporaryPath).catch(() => undefined);
      }
    }
  }

  async #readStoredAtPath(input: {
    readonly tenantId: string;
    readonly tenantHash: string;
    readonly filePath: string;
    readonly expectedReference: JournalBlobReference | null;
    readonly collectBytes: boolean;
    readonly signal: AbortSignal | undefined;
  }): Promise<DecodedBlob> {
    assertNotAborted(input.signal);
    const digestFromName = OFFICIAL_FILE_PATTERN.exec(
      path.basename(input.filePath),
    )?.[1];
    if (digestFromName === undefined) {
      throw new BlobReferenceError();
    }
    const tombstonePath = path.join(
      path.dirname(input.filePath),
      `${digestFromName}.tombstone`,
    );
    const tombstoneKind = await pathKind(tombstonePath);
    if (tombstoneKind === "file") {
      throw new BlobTombstonedError();
    }
    if (tombstoneKind === "other") {
      throw new BlobIntegrityError();
    }
    const fileKind = await pathKind(input.filePath);
    if (fileKind === "missing") {
      throw new BlobNotFoundError();
    }
    if (fileKind !== "file") {
      throw new BlobIntegrityError();
    }

    let handle: FileHandle | undefined;
    try {
      handle = await open(
        input.filePath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      const information = await handle.stat();
      if (!information.isFile() || information.size < PREFIX_FIXED_BYTES + TRAILER_BYTES) {
        throw new BlobFormatError();
      }
      const fixed = await readExact(handle, PREFIX_FIXED_BYTES, 0);
      if (!timingSafeEqual(fixed.subarray(0, MAGIC.byteLength), MAGIC)) {
        throw new BlobFormatError();
      }
      const headerLength = fixed.readUInt32BE(MAGIC.byteLength);
      if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES) {
        throw new BlobFormatError();
      }
      const prefixLength = PREFIX_FIXED_BYTES + headerLength;
      if (information.size < prefixLength + TRAILER_BYTES) {
        throw new BlobFormatError();
      }
      const encodedHeader = await readExact(
        handle,
        headerLength,
        PREFIX_FIXED_BYTES,
      );
      const prefix = Buffer.concat([fixed, encodedHeader]);
      const header = parseHeader(encodedHeader);
      if (header.tenantScopeHash !== input.tenantHash) {
        throw new BlobTenantScopeError();
      }
      const trailerPosition = information.size - TRAILER_BYTES;
      const ciphertextLength = trailerPosition - prefixLength;
      if (ciphertextLength < 0) {
        throw new BlobFormatError();
      }
      const trailer = parseTrailer(
        await readExact(handle, TRAILER_BYTES, trailerPosition),
      );
      if (trailer.sizeBytes !== ciphertextLength) {
        throw new BlobIntegrityError();
      }
      const reference = referenceFor(
        input.tenantHash,
        trailer.sha256,
        trailer.sizeBytes,
        header.mimeType,
        header.classification,
      );
      if (
        trailer.blobDigest !== digestFromName ||
        reference.blobId !== blobIdFromDigest(trailer.blobDigest)
      ) {
        throw new BlobIntegrityError();
      }
      if (
        input.expectedReference !== null &&
        (reference.blobId !== input.expectedReference.blobId ||
          reference.sha256 !== input.expectedReference.sha256 ||
          reference.sizeBytes !== input.expectedReference.sizeBytes ||
          reference.mimeType !== input.expectedReference.mimeType ||
          reference.classification !== input.expectedReference.classification)
      ) {
        throw new BlobIntegrityError();
      }
      if (input.collectBytes && trailer.sizeBytes > this.#maxReadBytes) {
        throw new BlobSizeLimitError();
      }
      assertNotAborted(input.signal);
      let resolvedKey: TenantEncryptionKey | null;
      try {
        resolvedKey = await this.#keyResolver.getKey(
          input.tenantId,
          header.keyId,
        );
      } catch {
        throw new BlobKeyUnavailableError();
      }
      if (resolvedKey === null) {
        throw new BlobKeyUnavailableError();
      }
      const key = validateEncryptionKey(resolvedKey, header.keyId);
      let decipher;
      try {
        decipher = createDecipheriv(
          ALGORITHM,
          key.key,
          Buffer.from(header.iv, "base64url"),
          { authTagLength: AUTH_TAG_BYTES },
        );
      } finally {
        key.key.fill(0);
      }
      decipher.setAAD(prefix);
      decipher.setAuthTag(trailer.authTag);
      const hasher = createHash("sha256");
      const plaintext: Buffer[] = [];
      let plaintextBytes = 0;
      let readPosition = prefixLength;
      let remaining = ciphertextLength;
      try {
        while (remaining > 0) {
          assertNotAborted(input.signal);
          const length = Math.min(remaining, IO_CHUNK_BYTES);
          const encrypted = await readExact(handle, length, readPosition);
          const decrypted = decipher.update(encrypted);
          hasher.update(decrypted);
          plaintextBytes += decrypted.byteLength;
          if (input.collectBytes && decrypted.byteLength > 0) {
            plaintext.push(decrypted);
          }
          readPosition += length;
          remaining -= length;
        }
        assertNotAborted(input.signal);
        const finalPlaintext = decipher.final();
        hasher.update(finalPlaintext);
        plaintextBytes += finalPlaintext.byteLength;
        if (input.collectBytes && finalPlaintext.byteLength > 0) {
          plaintext.push(finalPlaintext);
        }
      } catch (error) {
        if (error instanceof BlobAbortError) {
          throw error;
        }
        throw new BlobIntegrityError();
      }
      const computedHash = hasher.digest();
      const storedHash = Buffer.from(trailer.sha256, "hex");
      if (
        plaintextBytes !== trailer.sizeBytes ||
        !timingSafeEqual(computedHash, storedHash)
      ) {
        throw new BlobIntegrityError();
      }
      return Object.freeze({
        reference,
        bytes: input.collectBytes
          ? Uint8Array.from(Buffer.concat(plaintext, plaintextBytes))
          : null,
      });
    } catch (error) {
      if (
        isNodeErrorWithCode(error, "ENOENT") ||
        isNodeErrorWithCode(error, "ENOTDIR")
      ) {
        throw new BlobNotFoundError();
      }
      if (isNodeErrorWithCode(error, "ELOOP")) {
        throw new BlobIntegrityError();
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #deleteUnlocked(
    tenantHash: string,
    reference: JournalBlobReference,
    mode: "tombstone" | "purge",
    reasonCode: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<DeleteBlobResult> {
    assertNotAborted(signal);
    const digest = assertReferenceTenantScope(tenantHash, reference);
    const paths = this.#pathsForTenantHash(tenantHash);
    const finalPath = path.join(paths.objectDirectory, `${digest}.pfblob`);
    const tombstonePath = path.join(
      paths.objectDirectory,
      `${digest}.tombstone`,
    );
    const finalKind = await pathKind(finalPath);
    const tombstoneKind = await pathKind(tombstonePath);
    if (finalKind === "other" || tombstoneKind === "other") {
      throw new BlobIntegrityError();
    }
    if (mode === "purge") {
      const removedBlob = await unlinkIfPresent(finalPath);
      const removedTombstone = await unlinkIfPresent(tombstonePath);
      if (removedBlob || removedTombstone) {
        await syncDirectory(paths.objectDirectory);
      }
      return Object.freeze({
        blobId: reference.blobId,
        mode,
        status: removedBlob || removedTombstone ? "deleted" : "already_absent",
      });
    }
    if (tombstoneKind === "file") {
      if (finalKind === "file") {
        await unlinkIfPresent(finalPath);
        await syncDirectory(paths.objectDirectory);
      }
      return Object.freeze({
        blobId: reference.blobId,
        mode,
        status: "already_tombstoned",
      });
    }
    if (finalKind === "missing") {
      return Object.freeze({
        blobId: reference.blobId,
        mode,
        status: "already_absent",
      });
    }
    const temporaryPath = path.join(
      paths.objectDirectory,
      `.tmp-${randomUUID()}.part`,
    );
    let handle: FileHandle | undefined;
    let markerCommitted = false;
    try {
      const marker = Buffer.from(
        `${JSON.stringify({
          format: "private-fund-blob-tombstone",
          version: 1,
          blobId: reference.blobId,
          deletedAt: this.#now().toISOString(),
          reasonCode: reasonCode ?? "unspecified",
        })}\n`,
        "utf8",
      );
      handle = await open(
        temporaryPath,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      await writeAll(handle, marker);
      await handle.sync();
      await handle.close();
      handle = undefined;
      assertNotAborted(signal);
      await rename(temporaryPath, tombstonePath);
      markerCommitted = true;
      await syncDirectory(paths.objectDirectory);
      await unlinkIfPresent(finalPath);
      await syncDirectory(paths.objectDirectory);
      return Object.freeze({
        blobId: reference.blobId,
        mode,
        status: "deleted",
      });
    } finally {
      await handle?.close().catch(() => undefined);
      if (!markerCommitted) {
        await unlinkIfPresent(temporaryPath).catch(() => undefined);
      }
    }
  }

  #pathsForTenantHash(tenantHash: string): StorePaths {
    const tenantDirectory = path.join(
      this.#rootDirectory,
      "tenants",
      tenantHash,
    );
    return {
      tenantDirectory,
      objectDirectory: path.join(tenantDirectory, "objects"),
    };
  }

  #beginOperation(): () => void {
    if (this.#state !== "open") {
      throw new BlobStoreClosedError();
    }
    this.#activeOperations += 1;
    let finished = false;
    return () => {
      if (finished) {
        return;
      }
      finished = true;
      this.#activeOperations -= 1;
      if (this.#activeOperations === 0) {
        for (const resolve of this.#drainWaiters) {
          resolve();
        }
        this.#drainWaiters.clear();
      }
    };
  }

  async #withBlobLock<T>(
    lockKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#blobLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#blobLocks.set(lockKey, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#blobLocks.get(lockKey) === current) {
        this.#blobLocks.delete(lockKey);
      }
    }
  }
}

export function createLocalEncryptedBlobStore(
  options: LocalEncryptedBlobStoreOptions,
): LocalEncryptedBlobStore {
  return new NodeLocalEncryptedBlobStore(options);
}
