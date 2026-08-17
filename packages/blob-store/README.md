# Local encrypted blob store

`@private-fund/blob-store` persists journal payload blobs without accepting a
caller-provided filesystem path. Its public reference is the existing
`JournalBlobReference` contract.

## Security and durability decisions

- Blob IDs bind tenant scope, plaintext SHA-256, MIME type, and classification.
  A hash or blob ID is an address, never authorization; every operation also
  requires the tenant ID and re-derives the scoped ID.
- Payloads use AES-256-GCM with a fresh 96-bit IV. The versioned header is GCM
  additional authenticated data. The fixed trailer binds plaintext size/hash
  and the scoped blob digest, all of which are revalidated after decryption.
- The resolver receives the tenant ID on every key lookup. Raw key bytes are
  copied briefly, zeroed after cipher construction, never logged, and never
  written to metadata. `keyId` is explicitly non-secret routing metadata.
- Streaming writes use a mode-0600 temporary file in the final object's
  directory. The file is fully written and fsynced before atomic rename, and
  the directory is synced after publication. Cancellation and failures unlink
  the temporary file.
- Same-content writes are idempotent. An existing object is fully authenticated
  before it is reused; corrupted content is never silently overwritten.
- Tombstone and purge accept only a validated opaque reference. Retention is a
  dry run by default and requires `confirm: true` for deletion. Tenant key
  destruction additionally requires `confirmIrreversible: true` and resolver
  support.
- Orphan sweeping recognizes only the store's strict UUID temporary filename.
  It cannot select official `.pfblob` objects or tombstone files.
- `dispose()` stops admission immediately and resolves only after all admitted
  operations finish. Callers should abort stalled input streams before shutdown
  if bounded shutdown is required.

The store is an in-process local provider. Host-level filesystem permissions
and the key resolver remain security boundaries; the content hash is not one.
