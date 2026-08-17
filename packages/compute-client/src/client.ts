import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  computeRequestSchema,
  computeResponseSchema,
  computeWorkerHealthSchema,
  type ComputeRequest,
  type ComputeResponse,
  type ComputeWorkerHealth,
} from "@private-fund/contracts";

import {
  ComputeAbortedError,
  ComputeArtifactIntegrityError,
  ComputeConfigurationError,
  ComputeProcessError,
  ComputeProtocolError,
  ComputeTimeoutError,
} from "./errors.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;
const TERMINATION_GRACE_MS = 1_000;

export type { ComputeWorkerHealth } from "@private-fund/contracts";

export interface ComputeClientOptions {
  /** Executable invoked directly with shell=false. */
  readonly command: string;
  /** Arguments placed before the worker mode flag (`--once` or `--health`). */
  readonly arguments?: readonly string[];
  readonly cwd?: string;
  /**
   * Explicit child environment additions. The default environment intentionally
   * forwards no API keys or application credentials.
   */
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly verifyArtifacts?: boolean;
}

export interface PythonComputeClientOptions
  extends Omit<ComputeClientOptions, "command" | "arguments"> {
  readonly workerScript: string;
  readonly pythonExecutable?: string;
  readonly pythonArguments?: readonly string[];
}

export interface ComputeExecutionOptions {
  readonly signal?: AbortSignal;
}

interface ProcessResult {
  readonly line: string;
  readonly stderr: string;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new ComputeConfigurationError(`${name} must be a positive integer`);
  }
  return resolved;
}

function childEnvironment(
  additions: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    SYSTEMROOT: process.env.SYSTEMROOT,
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
  };
  for (const [key, value] of Object.entries(additions ?? {})) {
    environment[key] = value;
  }
  return environment;
}

function parseStrictSingleNdjsonLine(buffer: Buffer): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throw new ComputeProtocolError(
      "Compute worker stdout was not valid UTF-8",
      error,
    );
  }
  if (!decoded.endsWith("\n")) {
    throw new ComputeProtocolError(
      "Compute worker stdout must end with an NDJSON newline",
    );
  }
  let line = decoded.slice(0, -1);
  if (line.endsWith("\r")) {
    line = line.slice(0, -1);
  }
  if (!line || line.includes("\n") || line.includes("\r")) {
    throw new ComputeProtocolError(
      "Compute worker must emit exactly one non-empty NDJSON record",
    );
  }
  return line;
}

function assertAbsoluteRequestPaths(request: ComputeRequest): void {
  if (!path.isAbsolute(request.inputPath)) {
    throw new ComputeConfigurationError("ComputeRequest.inputPath must be absolute");
  }
  if (!path.isAbsolute(request.outputDirectory)) {
    throw new ComputeConfigurationError(
      "ComputeRequest.outputDirectory must be absolute",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHealth(value: unknown): ComputeWorkerHealth {
  const parsed = computeWorkerHealthSchema.safeParse(value);
  if (!parsed.success) {
    throw new ComputeProtocolError(
      "Compute worker returned an invalid health record",
    );
  }
  return parsed.data;
}

function pathIsWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveComputeArtifactPath(
  outputDirectory: string,
  artifactPath: string,
): string {
  if (
    !artifactPath ||
    artifactPath.includes("\0") ||
    path.isAbsolute(artifactPath)
  ) {
    throw new ComputeArtifactIntegrityError(
      "Compute artifact path must be a non-empty relative path",
    );
  }
  const root = path.resolve(outputDirectory);
  const candidate = path.resolve(root, artifactPath);
  if (!pathIsWithin(candidate, root)) {
    throw new ComputeArtifactIntegrityError(
      "Compute artifact path escapes outputDirectory",
    );
  }
  return candidate;
}

async function sha256(pathname: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(pathname)) {
    digest.update(chunk as Buffer);
  }
  return `sha256:${digest.digest("hex")}`;
}

async function verifyResponseArtifacts(
  request: ComputeRequest,
  response: ComputeResponse,
): Promise<void> {
  if (response.status !== "completed") {
    return;
  }
  let realOutputDirectory: string;
  try {
    realOutputDirectory = await realpath(request.outputDirectory);
  } catch (error) {
    throw new ComputeArtifactIntegrityError(
      "Compute outputDirectory does not exist after a completed response",
      error,
    );
  }

  const artifactPaths = new Set<string>();
  for (const artifact of response.artifacts) {
    if (artifactPaths.has(artifact.path)) {
      throw new ComputeArtifactIntegrityError(
        `Compute response contains duplicate artifact path: ${artifact.path}`,
      );
    }
    artifactPaths.add(artifact.path);
    const lexicalPath = resolveComputeArtifactPath(
      request.outputDirectory,
      artifact.path,
    );
    let realArtifact: string;
    try {
      realArtifact = await realpath(lexicalPath);
    } catch (error) {
      throw new ComputeArtifactIntegrityError(
        `Compute artifact does not exist: ${artifact.path}`,
        error,
      );
    }
    if (!pathIsWithin(realArtifact, realOutputDirectory)) {
      throw new ComputeArtifactIntegrityError(
        `Compute artifact resolves outside outputDirectory: ${artifact.path}`,
      );
    }
    const artifactStat = await stat(realArtifact);
    if (!artifactStat.isFile()) {
      throw new ComputeArtifactIntegrityError(
        `Compute artifact is not a regular file: ${artifact.path}`,
      );
    }
    if (artifactStat.size !== artifact.size) {
      throw new ComputeArtifactIntegrityError(
        `Compute artifact size mismatch: ${artifact.path}`,
      );
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(artifact.checksum)) {
      throw new ComputeArtifactIntegrityError(
        `Compute artifact checksum is not canonical SHA-256: ${artifact.path}`,
      );
    }
    const actualChecksum = await sha256(realArtifact);
    if (actualChecksum !== artifact.checksum) {
      throw new ComputeArtifactIntegrityError(
        `Compute artifact checksum mismatch: ${artifact.path}`,
      );
    }
  }

  if (response.recordsFile !== null) {
    resolveComputeArtifactPath(request.outputDirectory, response.recordsFile);
    if (!artifactPaths.has(response.recordsFile)) {
      throw new ComputeArtifactIntegrityError(
        "Compute recordsFile is not present in artifacts",
      );
    }
  }
}

export class ComputeClient {
  readonly #command: string;
  readonly #arguments: readonly string[];
  readonly #cwd: string | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #timeoutMs: number;
  readonly #maxStdoutBytes: number;
  readonly #maxStderrBytes: number;
  readonly #verifyArtifacts: boolean;

  public constructor(options: ComputeClientOptions) {
    if (!options.command.trim()) {
      throw new ComputeConfigurationError("command must be non-empty");
    }
    this.#command = options.command;
    this.#arguments = [...(options.arguments ?? [])];
    this.#cwd = options.cwd;
    this.#environment = childEnvironment(options.environment);
    this.#timeoutMs = positiveInteger(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      "timeoutMs",
    );
    this.#maxStdoutBytes = positiveInteger(
      options.maxStdoutBytes,
      DEFAULT_MAX_STDOUT_BYTES,
      "maxStdoutBytes",
    );
    this.#maxStderrBytes = positiveInteger(
      options.maxStderrBytes,
      DEFAULT_MAX_STDERR_BYTES,
      "maxStderrBytes",
    );
    this.#verifyArtifacts = options.verifyArtifacts ?? true;
  }

  public async health(
    execution: ComputeExecutionOptions = {},
  ): Promise<ComputeWorkerHealth> {
    const result = await this.#invoke("--health", undefined, execution.signal);
    let value: unknown;
    try {
      value = JSON.parse(result.line);
    } catch (error) {
      throw new ComputeProtocolError(
        "Compute worker health output was not JSON",
        error,
      );
    }
    return parseHealth(value);
  }

  public async execute(
    request: ComputeRequest,
    execution: ComputeExecutionOptions = {},
  ): Promise<ComputeResponse> {
    const validated = computeRequestSchema.parse(request);
    assertAbsoluteRequestPaths(validated);
    const requestLine = `${JSON.stringify(validated)}\n`;
    const result = await this.#invoke("--once", requestLine, execution.signal);

    let rawResponse: unknown;
    try {
      rawResponse = JSON.parse(result.line);
    } catch (error) {
      throw new ComputeProtocolError(
        "Compute worker response was not JSON",
        error,
      );
    }

    const parsed = computeResponseSchema.safeParse(rawResponse);
    if (!parsed.success) {
      throw new ComputeProtocolError(
        `Compute worker response did not match ComputeResponse: ${parsed.error.message}`,
      );
    }
    const response = parsed.data;
    if (response.requestId !== validated.requestId) {
      throw new ComputeProtocolError(
        `Compute worker response requestId mismatch: expected ${validated.requestId}`,
      );
    }
    if (this.#verifyArtifacts) {
      await verifyResponseArtifacts(validated, response);
    }
    return response;
  }

  async #invoke(
    mode: "--once" | "--health",
    input: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ProcessResult> {
    if (signal?.aborted) {
      throw new ComputeAbortedError();
    }

    return new Promise<ProcessResult>((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let terminationTimer: NodeJS.Timeout | undefined;

      const child = spawn(this.#command, [...this.#arguments, mode], {
        cwd: this.#cwd,
        env: this.#environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      const terminate = (): void => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        child.kill("SIGTERM");
        terminationTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, TERMINATION_GRACE_MS);
        terminationTimer.unref();
      };

      const finishError = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        terminate();
        reject(error);
      };

      const onAbort = (): void => {
        finishError(new ComputeAbortedError());
      };

      const timeout = setTimeout(() => {
        finishError(new ComputeTimeoutError(this.#timeoutMs));
      }, this.#timeoutMs);
      timeout.unref();
      signal?.addEventListener("abort", onAbort, { once: true });

      child.once("error", (error) => {
        finishError(
          new ComputeProcessError(
            `Failed to spawn compute worker: ${error.message}`,
            "worker_spawn_failed",
            Buffer.concat(stderrChunks).toString("utf8"),
            error,
          ),
        );
      });

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > this.#maxStdoutBytes) {
          finishError(
            new ComputeProtocolError(
              `Compute worker stdout exceeded ${this.#maxStdoutBytes} bytes`,
            ),
          );
          return;
        }
        stdoutChunks.push(chunk);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > this.#maxStderrBytes) {
          finishError(
            new ComputeProcessError(
              `Compute worker stderr exceeded ${this.#maxStderrBytes} bytes`,
              "worker_process_failed",
              Buffer.concat(stderrChunks).toString("utf8"),
            ),
          );
          return;
        }
        stderrChunks.push(chunk);
      });

      child.stdin.on("error", (error) => {
        finishError(
          new ComputeProcessError(
            `Failed to write compute request: ${error.message}`,
            "worker_process_failed",
            Buffer.concat(stderrChunks).toString("utf8"),
            error,
          ),
        );
      });

      child.once("close", (code, childSignal) => {
        if (terminationTimer !== undefined) {
          clearTimeout(terminationTimer);
        }
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (code !== 0) {
          reject(
            new ComputeProcessError(
              `Compute worker exited with code ${String(code)}${
                childSignal === null ? "" : ` (${childSignal})`
              }`,
              "worker_process_failed",
              stderr,
            ),
          );
          return;
        }
        let line: string;
        try {
          line = parseStrictSingleNdjsonLine(Buffer.concat(stdoutChunks));
        } catch (error) {
          reject(error);
          return;
        }
        resolve({ line, stderr });
      });

      if (input === undefined) {
        child.stdin.end();
      } else {
        child.stdin.end(input, "utf8");
      }
    });
  }
}

export function createPythonComputeClient(
  options: PythonComputeClientOptions,
): ComputeClient {
  if (!path.isAbsolute(options.workerScript)) {
    throw new ComputeConfigurationError("workerScript must be absolute");
  }
  return new ComputeClient({
    command: options.pythonExecutable ?? "python3",
    arguments: [...(options.pythonArguments ?? []), options.workerScript],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.environment === undefined
      ? {}
      : { environment: options.environment }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxStdoutBytes === undefined
      ? {}
      : { maxStdoutBytes: options.maxStdoutBytes }),
    ...(options.maxStderrBytes === undefined
      ? {}
      : { maxStderrBytes: options.maxStderrBytes }),
    ...(options.verifyArtifacts === undefined
      ? {}
      : { verifyArtifacts: options.verifyArtifacts }),
  });
}
