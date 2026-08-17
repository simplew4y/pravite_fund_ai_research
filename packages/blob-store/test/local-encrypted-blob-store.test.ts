import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { JournalBlobReference } from "@private-fund/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BlobAbortError,
  BlobFormatError,
  BlobIntegrityError,
  BlobKeyUnavailableError,
  BlobNotFoundError,
  BlobStoreClosedError,
  BlobTenantScopeError,
  BlobTombstonedError,
  NodeLocalEncryptedBlobStore,
  type TenantEncryptionKey,
  type TenantKeyResolver,
} from "../src/index.js";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const PLAINTEXT = Buffer.from(
  "Confidential recurring-revenue evidence for the investment memo.",
  "utf8",
);

function keyBytes(seed: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(seed).digest());
}

class MemoryTenantKeyResolver implements TenantKeyResolver {
  readonly #active = new Map<string, string>();
  readonly #keys = new Map<string, Map<string, Uint8Array>>();

  setActive(tenantId: string, keyId: string, key: Uint8Array): void {
    let tenantKeys = this.#keys.get(tenantId);
    if (tenantKeys === undefined) {
      tenantKeys = new Map();
      this.#keys.set(tenantId, tenantKeys);
    }
    tenantKeys.set(keyId, Uint8Array.from(key));
    this.#active.set(tenantId, keyId);
  }

  getActiveKey(tenantId: string): TenantEncryptionKey {
    const keyId = this.#active.get(tenantId);
    const key = keyId === undefined
      ? undefined
      : this.#keys.get(tenantId)?.get(keyId);
    if (keyId === undefined || key === undefined) {
      throw new Error("test key unavailable");
    }
    return { keyId, key: Uint8Array.from(key) };
  }

  getKey(tenantId: string, keyId: string): TenantEncryptionKey | null {
    const key = this.#keys.get(tenantId)?.get(keyId);
    return key === undefined
      ? null
      : { keyId, key: Uint8Array.from(key) };
  }

  destroyKey(tenantId: string, keyId: string): void {
    this.#keys.get(tenantId)?.delete(keyId);
  }
}

async function listFilesRecursively(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursively(target));
    } else {
      files.push(target);
    }
  }
  return files.sort();
}

async function onlyBlobPath(root: string): Promise<string> {
  const blobs = (await listFilesRecursively(root)).filter((file) =>
    file.endsWith(".pfblob"),
  );
  expect(blobs).toHaveLength(1);
  return blobs[0]!;
}

async function captureError(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected operation to reject");
}

function createPausedSource(firstChunk: Uint8Array): {
  readonly source: AsyncIterable<Uint8Array>;
  readonly waiting: Promise<void>;
  readonly wasReturned: () => boolean;
} {
  let nextCount = 0;
  let returned = false;
  let notifyWaiting!: () => void;
  const waiting = new Promise<void>((resolve) => {
    notifyWaiting = resolve;
  });
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          nextCount += 1;
          if (nextCount === 1) {
            return Promise.resolve({ done: false, value: firstChunk });
          }
          notifyWaiting();
          return new Promise<IteratorResult<Uint8Array>>(() => undefined);
        },
        return(): Promise<IteratorResult<Uint8Array>> {
          returned = true;
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
  return { source, waiting, wasReturned: () => returned };
}

describe("NodeLocalEncryptedBlobStore", () => {
  let root: string;
  let resolver: MemoryTenantKeyResolver;
  let stores: NodeLocalEncryptedBlobStore[];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "private-fund-blob-store-"));
    resolver = new MemoryTenantKeyResolver();
    resolver.setActive(TENANT_A, "tenant-a-key-v1", keyBytes("tenant-a-v1"));
    resolver.setActive(TENANT_B, "tenant-b-key-v1", keyBytes("tenant-b-v1"));
    stores = [];
  });

  afterEach(async () => {
    await Promise.all(stores.map((store) => store.dispose()));
    await rm(root, { recursive: true, force: true });
  });

  function createStore(
    keyResolver: TenantKeyResolver = resolver,
    options: { readonly now?: () => Date } = {},
  ): NodeLocalEncryptedBlobStore {
    const store = new NodeLocalEncryptedBlobStore({
      rootDirectory: root,
      keyResolver,
      maxBlobBytes: 1024 * 1024,
      maxReadBytes: 1024 * 1024,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    stores.push(store);
    return store;
  }

  async function putDefault(
    store: NodeLocalEncryptedBlobStore,
    tenantId = TENANT_A,
    source: Uint8Array | AsyncIterable<Uint8Array> = PLAINTEXT,
  ): Promise<JournalBlobReference> {
    return store.put({
      tenantId,
      source,
      mimeType: "text/plain; charset=utf-8",
      classification: "confidential",
    });
  }

  it("round-trips streamed bytes and stores only encrypted payload", async () => {
    const store = createStore();
    const source = (async function* (): AsyncGenerator<Uint8Array> {
      yield PLAINTEXT.subarray(0, 17);
      yield PLAINTEXT.subarray(17);
    })();

    const reference = await putDefault(store, TENANT_A, source);
    const result = await store.read({ tenantId: TENANT_A, reference });

    expect(Buffer.from(result.bytes)).toEqual(PLAINTEXT);
    expect(result.reference).toEqual(reference);
    expect(reference).toEqual({
      blobId: expect.stringMatching(/^blob_v1_[0-9a-f]{64}$/u),
      sha256: createHash("sha256").update(PLAINTEXT).digest("hex"),
      sizeBytes: PLAINTEXT.byteLength,
      mimeType: "text/plain; charset=utf-8",
      classification: "confidential",
    });

    const stored = await readFile(await onlyBlobPath(root));
    expect(stored.includes(PLAINTEXT)).toBe(false);
    expect(stored.includes(Buffer.from(keyBytes("tenant-a-v1")))).toBe(false);
  });

  it("deduplicates repeated tenant-scoped content and metadata", async () => {
    const store = createStore();

    const first = await putDefault(store);
    const second = await putDefault(store);

    expect(second).toEqual(first);
    expect(
      (await listFilesRecursively(root)).filter((file) =>
        file.endsWith(".pfblob"),
      ),
    ).toHaveLength(1);
  });

  it("isolates IDs, paths, and authorization between tenants", async () => {
    const store = createStore();

    const tenantAReference = await putDefault(store, TENANT_A);
    const tenantBReference = await putDefault(store, TENANT_B);

    expect(tenantBReference.sha256).toBe(tenantAReference.sha256);
    expect(tenantBReference.blobId).not.toBe(tenantAReference.blobId);
    await expect(
      store.read({ tenantId: TENANT_B, reference: tenantAReference }),
    ).rejects.toBeInstanceOf(BlobTenantScopeError);
    await expect(
      store.read({ tenantId: TENANT_A, reference: tenantBReference }),
    ).rejects.toBeInstanceOf(BlobTenantScopeError);
  });

  it("fails closed when the tenant key is wrong", async () => {
    const writer = createStore();
    const reference = await putDefault(writer);
    await writer.dispose();
    const wrongResolver = new MemoryTenantKeyResolver();
    wrongResolver.setActive(
      TENANT_A,
      "tenant-a-key-v1",
      keyBytes("wrong-key-material"),
    );
    const reader = createStore(wrongResolver);

    await expect(
      reader.read({ tenantId: TENANT_A, reference }),
    ).rejects.toBeInstanceOf(BlobIntegrityError);
  });

  it("detects ciphertext and reference metadata tampering", async () => {
    const store = createStore();
    const reference = await putDefault(store);
    const storedPath = await onlyBlobPath(root);
    const stored = await readFile(storedPath);
    const headerLength = stored.readUInt32BE(8);
    const ciphertextOffset = 12 + headerLength;
    stored[ciphertextOffset] = stored[ciphertextOffset]! ^ 0x40;
    await writeFile(storedPath, stored);

    await expect(
      store.read({ tenantId: TENANT_A, reference }),
    ).rejects.toBeInstanceOf(BlobIntegrityError);

    const untamperedStore = createStore();
    await rm(root, { recursive: true, force: true });
    const secondReference = await putDefault(untamperedStore);
    await expect(
      untamperedStore.read({
        tenantId: TENANT_A,
        reference: {
          ...secondReference,
          sizeBytes: secondReference.sizeBytes + 1,
        },
      }),
    ).rejects.toBeInstanceOf(BlobIntegrityError);
  });

  it("aborts partial streaming writes and removes the temporary file", async () => {
    const store = createStore();
    const controller = new AbortController();
    const paused = createPausedSource(Buffer.from("partial plaintext"));
    const pending = store.put({
      tenantId: TENANT_A,
      source: paused.source,
      mimeType: "application/octet-stream",
      classification: "restricted",
      signal: controller.signal,
    });
    await paused.waiting;

    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(BlobAbortError);
    await Promise.resolve();
    expect(paused.wasReturned()).toBe(true);
    expect(
      (await listFilesRecursively(root)).filter(
        (file) => file.endsWith(".part") || file.endsWith(".pfblob"),
      ),
    ).toEqual([]);
  });

  it("makes concurrent writes of the same content idempotent", async () => {
    const firstStore = createStore();
    const secondStore = createStore();

    const references = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        putDefault(index % 2 === 0 ? firstStore : secondStore),
      ),
    );

    expect(new Set(references.map((reference) => reference.blobId)).size).toBe(1);
    expect(
      (await listFilesRecursively(root)).filter((file) =>
        file.endsWith(".pfblob"),
      ),
    ).toHaveLength(1);
    expect(
      (await listFilesRecursively(root)).filter((file) =>
        file.endsWith(".part"),
      ),
    ).toEqual([]);
  });

  it("reports a missing blob without accepting arbitrary paths", async () => {
    const store = createStore();
    const reference = await putDefault(store);
    await unlink(await onlyBlobPath(root));

    await expect(
      store.read({ tenantId: TENANT_A, reference }),
    ).rejects.toBeInstanceOf(BlobNotFoundError);
    await expect(
      store.read({
        tenantId: TENANT_A,
        reference: {
          ...reference,
          blobId: "../../outside",
        },
      }),
    ).rejects.toMatchObject({ code: "blob_reference_invalid" });
    await expect(
      store.put({
        tenantId: TENANT_A,
        source: PLAINTEXT,
        mimeType: "text/plain",
        classification: "toString" as unknown as "internal",
      }),
    ).rejects.toMatchObject({ code: "blob_request_invalid" });
  });

  it("awaits active work during dispose and rejects every new operation", async () => {
    const store = createStore();
    const controller = new AbortController();
    const paused = createPausedSource(Buffer.from("active write"));
    const write = store.put({
      tenantId: TENANT_A,
      source: paused.source,
      mimeType: "application/octet-stream",
      classification: "internal",
      signal: controller.signal,
    });
    await paused.waiting;

    let disposed = false;
    const disposal = store.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    await expect(putDefault(store)).rejects.toBeInstanceOf(
      BlobStoreClosedError,
    );

    controller.abort();
    await expect(write).rejects.toBeInstanceOf(BlobAbortError);
    await disposal;
    expect(disposed).toBe(true);
    await expect(putDefault(store)).rejects.toBeInstanceOf(
      BlobStoreClosedError,
    );
  });

  it("sweeps only old controlled temp names and preserves official objects", async () => {
    const fixedNow = new Date("2026-08-16T12:00:00.000Z");
    const store = createStore(resolver, { now: () => fixedNow });
    await putDefault(store);
    const objectDirectory = path.dirname(await onlyBlobPath(root));
    const oldTemp = path.join(
      objectDirectory,
      ".tmp-00000000-0000-4000-8000-000000000001.part",
    );
    const youngTemp = path.join(
      objectDirectory,
      ".tmp-00000000-0000-4000-8000-000000000002.part",
    );
    const lookalike = path.join(objectDirectory, "keep-me.part");
    await writeFile(oldTemp, "old");
    await writeFile(youngTemp, "young");
    await writeFile(lookalike, "not controlled");
    const oldTime = new Date(fixedNow.getTime() - 120_000);
    await utimes(oldTemp, oldTime, oldTime);
    await utimes(youngTemp, fixedNow, fixedNow);

    await expect(
      store.sweepOrphanTemps({ olderThanMs: 60_000 }),
    ).resolves.toEqual({ examined: 2, removed: 1 });

    await expect(access(oldTemp)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(youngTemp)).resolves.toBeUndefined();
    await expect(access(lookalike)).resolves.toBeUndefined();
    await expect(access(await onlyBlobPath(root))).resolves.toBeUndefined();
  });

  it("never exposes key or resolver secrets in errors", async () => {
    const writer = createStore();
    const reference = await putDefault(writer);
    await writer.dispose();
    const secret = "TOP_SECRET_KMS_TOKEN_NEVER_EXPOSE";
    const leakingResolver: TenantKeyResolver = {
      getActiveKey() {
        throw new Error(`resolver failed with ${secret}`);
      },
      getKey() {
        throw new Error(`resolver failed with ${secret}`);
      },
    };
    const reader = createStore(leakingResolver);

    const readError = await captureError(
      reader.read({ tenantId: TENANT_A, reference }),
    );
    expect(readError).toBeInstanceOf(BlobKeyUnavailableError);
    expect(`${readError.message}\n${readError.stack ?? ""}\n${JSON.stringify(readError)}`)
      .not.toContain(secret);

    const putError = await captureError(putDefault(reader));
    expect(putError).toBeInstanceOf(BlobKeyUnavailableError);
    expect(`${putError.message}\n${putError.stack ?? ""}\n${JSON.stringify(putError)}`)
      .not.toContain(secret);
  });

  it("supports idempotent tombstone, purge, and controlled resurrection", async () => {
    const store = createStore();
    const reference = await putDefault(store);

    await expect(
      store.delete({
        tenantId: TENANT_A,
        reference,
        mode: "tombstone",
        reasonCode: "user_requested",
      }),
    ).resolves.toMatchObject({ status: "deleted" });
    await expect(
      store.read({ tenantId: TENANT_A, reference }),
    ).rejects.toBeInstanceOf(BlobTombstonedError);
    await expect(putDefault(store)).rejects.toBeInstanceOf(
      BlobTombstonedError,
    );
    await expect(
      store.delete({ tenantId: TENANT_A, reference, mode: "tombstone" }),
    ).resolves.toMatchObject({ status: "already_tombstoned" });

    await expect(
      store.delete({ tenantId: TENANT_A, reference, mode: "purge" }),
    ).resolves.toMatchObject({ status: "deleted" });
    await expect(putDefault(store)).resolves.toEqual(reference);
  });

  it("keeps retention dry-run by default and requires confirmation to delete", async () => {
    const fixedNow = new Date("2026-08-16T12:00:00.000Z");
    const store = createStore(resolver, { now: () => fixedNow });
    const reference = await putDefault(store);
    const cutoff = new Date(Date.now() + 60_000);

    await expect(
      store.applyRetention({
        tenantId: TENANT_A,
        olderThan: cutoff,
        classifications: ["confidential"],
        mode: "tombstone",
      }),
    ).resolves.toMatchObject({
      examined: 1,
      eligible: 1,
      deleted: 0,
      dryRun: true,
    });
    await expect(
      store.read({ tenantId: TENANT_A, reference }),
    ).resolves.toMatchObject({ reference });

    await expect(
      store.applyRetention({
        tenantId: TENANT_A,
        olderThan: cutoff,
        classifications: ["confidential"],
        mode: "tombstone",
        dryRun: false,
      }),
    ).rejects.toMatchObject({ code: "blob_request_invalid" });
    await expect(
      store.applyRetention({
        tenantId: TENANT_A,
        olderThan: cutoff,
        classifications: ["confidential"],
        mode: "tombstone",
        dryRun: false,
        confirm: true,
      }),
    ).resolves.toMatchObject({ deleted: 1, dryRun: false });
    await expect(
      store.read({ tenantId: TENANT_A, reference }),
    ).rejects.toBeInstanceOf(BlobTombstonedError);
  });

  it("delegates explicitly confirmed tenant key destruction", async () => {
    const store = createStore();
    const reference = await putDefault(store);

    await store.destroyTenantKey({
      tenantId: TENANT_A,
      keyId: "tenant-a-key-v1",
      confirmIrreversible: true,
    });

    await expect(
      store.read({ tenantId: TENANT_A, reference }),
    ).rejects.toBeInstanceOf(BlobKeyUnavailableError);
  });

  it("rejects corrupted format version before attempting decryption", async () => {
    const store = createStore();
    const reference = await putDefault(store);
    const storedPath = await onlyBlobPath(root);
    const stored = await readFile(storedPath);
    const headerLength = stored.readUInt32BE(8);
    const headerStart = 12;
    const header = JSON.parse(
      stored.subarray(headerStart, headerStart + headerLength).toString("utf8"),
    ) as Record<string, unknown>;
    header.version = 2;
    const replacement = Buffer.from(JSON.stringify(header), "utf8");
    expect(replacement.byteLength).toBe(headerLength);
    replacement.copy(stored, headerStart);
    await writeFile(storedPath, stored);

    await expect(
      store.read({ tenantId: TENANT_A, reference }),
    ).rejects.toBeInstanceOf(BlobFormatError);
  });
});
