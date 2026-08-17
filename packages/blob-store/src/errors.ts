export type BlobStoreErrorCode =
  | "blob_store_closed"
  | "blob_request_invalid"
  | "blob_reference_invalid"
  | "blob_tenant_scope_mismatch"
  | "blob_not_found"
  | "blob_tombstoned"
  | "blob_integrity_failure"
  | "blob_format_invalid"
  | "blob_key_unavailable"
  | "blob_key_invalid"
  | "blob_key_destruction_unsupported"
  | "blob_aborted"
  | "blob_size_limit_exceeded"
  | "blob_io_failure";

export class BlobStoreError extends Error {
  readonly code: BlobStoreErrorCode;
  readonly retryable: boolean;

  constructor(
    code: BlobStoreErrorCode,
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = "BlobStoreError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class BlobStoreClosedError extends BlobStoreError {
  constructor() {
    super("blob_store_closed", "Blob store is closing or closed");
    this.name = "BlobStoreClosedError";
  }
}

export class BlobRequestError extends BlobStoreError {
  constructor(message = "Blob request is invalid") {
    super("blob_request_invalid", message);
    this.name = "BlobRequestError";
  }
}

export class BlobReferenceError extends BlobStoreError {
  constructor() {
    super("blob_reference_invalid", "Blob reference is invalid");
    this.name = "BlobReferenceError";
  }
}

export class BlobTenantScopeError extends BlobStoreError {
  constructor() {
    super(
      "blob_tenant_scope_mismatch",
      "Blob reference does not belong to the requested tenant scope",
    );
    this.name = "BlobTenantScopeError";
  }
}

export class BlobNotFoundError extends BlobStoreError {
  constructor() {
    super("blob_not_found", "Blob was not found");
    this.name = "BlobNotFoundError";
  }
}

export class BlobTombstonedError extends BlobStoreError {
  constructor() {
    super("blob_tombstoned", "Blob has been tombstoned");
    this.name = "BlobTombstonedError";
  }
}

export class BlobIntegrityError extends BlobStoreError {
  constructor() {
    super(
      "blob_integrity_failure",
      "Blob integrity validation failed",
    );
    this.name = "BlobIntegrityError";
  }
}

export class BlobFormatError extends BlobStoreError {
  constructor() {
    super("blob_format_invalid", "Blob storage format is invalid");
    this.name = "BlobFormatError";
  }
}

export class BlobKeyUnavailableError extends BlobStoreError {
  constructor() {
    super(
      "blob_key_unavailable",
      "Encryption key is unavailable for this blob",
    );
    this.name = "BlobKeyUnavailableError";
  }
}

export class BlobKeyError extends BlobStoreError {
  constructor() {
    super("blob_key_invalid", "Tenant encryption key is invalid");
    this.name = "BlobKeyError";
  }
}

export class BlobKeyDestructionUnsupportedError extends BlobStoreError {
  constructor() {
    super(
      "blob_key_destruction_unsupported",
      "Tenant key resolver does not support key destruction",
    );
    this.name = "BlobKeyDestructionUnsupportedError";
  }
}

export class BlobAbortError extends BlobStoreError {
  constructor() {
    super("blob_aborted", "Blob operation was aborted");
    this.name = "BlobAbortError";
  }
}

export class BlobSizeLimitError extends BlobStoreError {
  constructor() {
    super(
      "blob_size_limit_exceeded",
      "Blob exceeds the configured size limit",
    );
    this.name = "BlobSizeLimitError";
  }
}

export class BlobIoError extends BlobStoreError {
  constructor() {
    super("blob_io_failure", "Blob storage I/O failed", true);
    this.name = "BlobIoError";
  }
}
