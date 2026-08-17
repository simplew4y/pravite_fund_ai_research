import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import type { ComputeRequest } from "@private-fund/contracts";

import {
  InvalidComputeJobError,
  type ComputeJob,
} from "./compute-job-executor.js";

export interface ComputePathPolicy {
  authorize(job: ComputeJob, request: ComputeRequest): Promise<void>;
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function requireWithin(candidate: string, root: string, field: string): string {
  const resolved = path.resolve(candidate);
  if (!isWithin(resolved, path.resolve(root))) {
    throw new InvalidComputeJobError(
      `Compute job ${field} escapes its tenant project directory`,
    );
  }
  return resolved;
}

function requireWithinProject(
  candidate: string,
  logicalProjectRoot: string,
  realProjectRoot: string,
  field: string,
): string {
  const resolved = path.resolve(candidate);
  if (
    !isWithin(resolved, logicalProjectRoot) &&
    !isWithin(resolved, realProjectRoot)
  ) {
    throw new InvalidComputeJobError(
      `Compute job ${field} escapes its tenant project directory`,
    );
  }
  return resolved;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function ensureDirectoryWithoutSymlinks(
  realProjectRoot: string,
  relativeDirectory: string,
): Promise<void> {
  let current = realProjectRoot;
  for (const segment of relativeDirectory.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw new InvalidComputeJobError(
          "Compute job outputDirectory may not traverse symbolic links",
        );
      }
      if (!entry.isDirectory()) {
        throw new InvalidComputeJobError(
          "Compute job outputDirectory traverses a non-directory entry",
        );
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        // Another local worker may have created the same directory. Re-check
        // with lstat so a concurrently inserted symlink is never followed.
        if (!isMissing(mkdirError) && (mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw mkdirError;
        }
        const entry = await lstat(current);
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new InvalidComputeJobError(
            "Compute job outputDirectory could not be created safely",
          );
        }
      }
    }
  }
}

/**
 * Enforces the platform layout:
 * data/users/{tenantNamespace}/projects/{projectId}/...
 *
 * The policy is deliberately held in the TypeScript control plane. The Python
 * worker receives already-authorized absolute paths and remains tenant-agnostic.
 */
export class TenantProjectComputePathPolicy implements ComputePathPolicy {
  readonly #dataRoot: string;

  public constructor(dataRoot: string) {
    if (!path.isAbsolute(dataRoot)) {
      throw new InvalidComputeJobError("Compute dataRoot must be absolute");
    }
    this.#dataRoot = path.resolve(dataRoot);
  }

  public async authorize(
    job: ComputeJob,
    request: ComputeRequest,
  ): Promise<void> {
    const projectRoot = path.resolve(
      this.#dataRoot,
      "users",
      job.tenantNamespace,
      "projects",
      job.projectId,
    );
    requireWithin(projectRoot, this.#dataRoot, "project root");
    let realDataRoot: string;
    let realProjectRoot: string;
    try {
      [realDataRoot, realProjectRoot] = await Promise.all([
        realpath(this.#dataRoot),
        realpath(projectRoot),
      ]);
    } catch (error) {
      throw new InvalidComputeJobError(
        `Compute project directory does not exist: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!isWithin(realProjectRoot, realDataRoot)) {
      throw new InvalidComputeJobError(
        "Compute project directory resolves outside dataRoot",
      );
    }
    // macOS and symlinked deployments may expose a logical project root
    // (for example /var/...) while secure file opening returns its canonical
    // realpath (/private/var/...). Both names are accepted only after proving
    // that the project itself resolves inside the canonical data root.
    const lexicalInput = requireWithinProject(
      request.inputPath,
      projectRoot,
      realProjectRoot,
      "inputPath",
    );
    const lexicalOutput = requireWithinProject(
      request.outputDirectory,
      projectRoot,
      realProjectRoot,
      "outputDirectory",
    );
    let realInput: string;
    try {
      realInput = await realpath(lexicalInput);
    } catch (error) {
      throw new InvalidComputeJobError(
        `Compute input does not exist: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!isWithin(realInput, realProjectRoot)) {
      throw new InvalidComputeJobError(
        "Compute inputPath resolves outside its tenant project directory",
      );
    }
    const inputStat = await lstat(lexicalInput);
    if (!inputStat.isFile() || inputStat.isSymbolicLink()) {
      throw new InvalidComputeJobError(
        "Compute inputPath must be a regular non-symbolic-link file",
      );
    }

    const outputRoot = isWithin(lexicalOutput, projectRoot)
      ? projectRoot
      : realProjectRoot;
    const relativeOutput = path.relative(outputRoot, lexicalOutput);
    await ensureDirectoryWithoutSymlinks(realProjectRoot, relativeOutput);
    const realOutput = await realpath(lexicalOutput);
    if (!isWithin(realOutput, realProjectRoot)) {
      throw new InvalidComputeJobError(
        "Compute outputDirectory resolves outside its tenant project directory",
      );
    }
  }
}
