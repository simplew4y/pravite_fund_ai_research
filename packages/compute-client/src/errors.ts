export type ComputeClientErrorCode =
  | "configuration_error"
  | "worker_spawn_failed"
  | "worker_process_failed"
  | "worker_timeout"
  | "worker_aborted"
  | "protocol_error"
  | "artifact_integrity_error";

export class ComputeClientError extends Error {
  public readonly code: ComputeClientErrorCode;

  public constructor(
    message: string,
    code: ComputeClientErrorCode,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
    this.name = "ComputeClientError";
  }
}

export class ComputeConfigurationError extends ComputeClientError {
  public constructor(message: string) {
    super(message, "configuration_error");
    this.name = "ComputeConfigurationError";
  }
}

export class ComputeProcessError extends ComputeClientError {
  public constructor(
    message: string,
    code: "worker_spawn_failed" | "worker_process_failed",
    public readonly stderr: string,
    cause?: unknown,
  ) {
    super(message, code, cause);
    this.name = "ComputeProcessError";
  }
}

export class ComputeTimeoutError extends ComputeClientError {
  public constructor(public readonly timeoutMs: number) {
    super(
      `Compute worker did not respond within ${timeoutMs}ms`,
      "worker_timeout",
    );
    this.name = "ComputeTimeoutError";
  }
}

export class ComputeAbortedError extends ComputeClientError {
  public constructor() {
    super("Compute worker invocation was aborted", "worker_aborted");
    this.name = "ComputeAbortedError";
  }
}

export class ComputeProtocolError extends ComputeClientError {
  public constructor(message: string, cause?: unknown) {
    super(message, "protocol_error", cause);
    this.name = "ComputeProtocolError";
  }
}

export class ComputeArtifactIntegrityError extends ComputeClientError {
  public constructor(message: string, cause?: unknown) {
    super(message, "artifact_integrity_error", cause);
    this.name = "ComputeArtifactIntegrityError";
  }
}
