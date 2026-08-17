import {
  mkdir,
  mkdtemp,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ComputeRequest } from "@private-fund/contracts";

import { InvalidComputeJobError } from "../src/compute-job-executor.js";
import { TenantProjectComputePathPolicy } from "../src/path-policy.js";

const tenantNamespace = "00000000-0000-4000-8000-000000000001";
const projectId = "project-1";
const temporaryDirectories: string[] = [];

async function fixture() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "compute-policy-"));
  temporaryDirectories.push(dataRoot);
  const projectRoot = path.join(
    dataRoot,
    "users",
    tenantNamespace,
    "projects",
    projectId,
  );
  await mkdir(path.join(projectRoot, "raw"), { recursive: true });
  const inputPath = path.join(projectRoot, "raw", "source.pdf");
  await writeFile(inputPath, "%PDF-fixture", "utf8");
  const job = {
    id: "job-1",
    tenantNamespace,
    projectId,
    type: "document.ingest" as const,
    payload: {},
    attempt: 1,
  };
  const request: ComputeRequest = {
    protocolVersion: 1,
    requestId: "request-1",
    jobId: job.id,
    operation: "extract_pdf",
    inputPath,
    outputDirectory: path.join(projectRoot, "derived", "job-1"),
    options: {},
  };
  return { dataRoot, projectRoot, job, request };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("TenantProjectComputePathPolicy", () => {
  it("authorizes project-contained input and creates a safe output directory", async () => {
    const { dataRoot, job, request } = await fixture();
    const policy = new TenantProjectComputePathPolicy(dataRoot);
    await expect(policy.authorize(job, request)).resolves.toBeUndefined();
  });

  it("accepts canonical realpaths for a logically aliased project root", async () => {
    const { dataRoot, projectRoot, job, request } = await fixture();
    const policy = new TenantProjectComputePathPolicy(dataRoot);
    const realProjectRoot = await realpath(projectRoot);
    await expect(
      policy.authorize(job, {
        ...request,
        inputPath: await realpath(request.inputPath),
        outputDirectory: path.join(
          realProjectRoot,
          "canonical-derived",
          "job-1",
        ),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects lexical paths outside the tenant project", async () => {
    const { dataRoot, job, request } = await fixture();
    const policy = new TenantProjectComputePathPolicy(dataRoot);
    await expect(
      policy.authorize(job, {
        ...request,
        inputPath: path.join(dataRoot, "outside.pdf"),
      }),
    ).rejects.toBeInstanceOf(InvalidComputeJobError);
  });

  it("rejects output directories reached through a symlink", async () => {
    const { dataRoot, projectRoot, job, request } = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), "compute-policy-outside-"));
    temporaryDirectories.push(outside);
    await symlink(outside, path.join(projectRoot, "linked-output"));
    const policy = new TenantProjectComputePathPolicy(dataRoot);
    await expect(
      policy.authorize(job, {
        ...request,
        outputDirectory: path.join(projectRoot, "linked-output", "job-1"),
      }),
    ).rejects.toBeInstanceOf(InvalidComputeJobError);
  });
});
