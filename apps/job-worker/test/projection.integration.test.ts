import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { ComputeResponse } from "@private-fund/contracts";
import { createPythonComputeClient } from "@private-fund/compute-client";
import { ComputeResultProjector } from "@private-fund/compute-projector";
import type { DurableJob } from "@private-fund/job-queue";
import {
  createResearchStore,
  openProjectDatabase,
} from "@private-fund/research-store";

import { loadJobWorkerConfig } from "../src/config.js";
import { ComputeJobExecutor } from "../src/compute-job-executor.js";
import { TenantProjectComputePathPolicy } from "../src/path-policy.js";
import { JobWorker, type JobQueuePort } from "../src/worker.js";

const TENANT = "00000000-0000-4000-8000-000000000011";
const PROJECT = "project-worker";
const pythonWorker = fileURLToPath(
  new URL("../../../python/compute-worker/worker.py", import.meta.url),
);
const temporaryDirectories: string[] = [];

async function fixture(): Promise<{
  readonly dataRoot: string;
  readonly projectRoot: string;
  readonly versionId: string;
  readonly job: DurableJob;
  readonly validResponse: ComputeResponse;
  readonly invalidResponse: ComputeResponse;
}> {
  const dataRoot = await mkdtemp(
    path.join(tmpdir(), "job-worker-projector-"),
  );
  temporaryDirectories.push(dataRoot);
  const projectRoot = path.join(
    dataRoot,
    "users",
    TENANT,
    "projects",
    PROJECT,
  );
  const inputPath = path.join(projectRoot, "sources", "source.pdf");
  const outputDirectory = path.join(
    projectRoot,
    "artifacts",
    "job-worker",
  );
  await Promise.all([
    mkdir(path.dirname(inputPath), { recursive: true }),
    mkdir(outputDirectory, { recursive: true }),
  ]);
  const source = "%PDF-worker-integration";
  await writeFile(inputPath, source, "utf8");
  const sourceSha256 = createHash("sha256")
    .update(source)
    .digest("hex");
  const database = openProjectDatabase({
    projectRoot,
    databasePath: path.join("data", "research.sqlite3"),
    preferredSearchBackend: "deterministic",
  });
  let versionId: string;
  let documentId: string;
  try {
    const registered = createResearchStore(
      database,
    ).documents.registerVersion({
      logicalKey: "worker:source.pdf",
      sourceRoot: "test",
      sourceRelpath: "source.pdf",
      title: "Worker source",
      originalFilename: "source.pdf",
      storedPath: path.relative(projectRoot, inputPath),
      fileType: "pdf",
      sha256: sourceSha256,
      fileSize: Buffer.byteLength(source),
      status: "parsing",
      activate: false,
    });
    versionId = registered.version.id;
    documentId = registered.document.id;
  } finally {
    database.close();
  }

  const job: DurableJob = {
    id: "job-worker-1",
    tenantNamespace: TENANT,
    projectId: PROJECT,
    type: "document.ingest",
    status: "running",
    payload: {
      inputPath,
      outputDirectory,
      documentId,
      documentVersionId: versionId,
      sourceSha256,
    },
    attempt: 1,
    maxAttempts: 3,
    leaseOwner: "worker-1",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    idempotencyKey: `document-ingest:${versionId}`,
    availableAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    result: null,
    error: null,
  };

  const makeResponse = async (
    records: readonly Record<string, unknown>[],
    filename: string,
  ): Promise<ComputeResponse> => {
    const contents = `${records
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`;
    await writeFile(
      path.join(outputDirectory, filename),
      contents,
      "utf8",
    );
    return {
      protocolVersion: 1,
      requestId: `request-${filename}`,
      status: "completed",
      recordsFile: filename,
      artifacts: [
        {
          path: filename,
          mediaType: "application/x-ndjson",
          checksum: `sha256:${createHash("sha256")
            .update(contents)
            .digest("hex")}`,
          size: Buffer.byteLength(contents),
        },
      ],
      metrics: {
        inputChecksum: `sha256:${sourceSha256}`,
        pageCount: records.length,
        extractedPageCount: records.length,
        recordCount: records.length,
        recordsBytes: Buffer.byteLength(contents),
      },
      error: null,
    };
  };
  const page = (pageNumber: number): Record<string, unknown> => ({
    recordType: "pdf_page",
    sourceName: "source.pdf",
    pageNumber,
    width: 100,
    height: 100,
    rotation: 0,
    text: `page ${String(pageNumber)}`,
  });
  return {
    dataRoot,
    projectRoot,
    versionId,
    job,
    validResponse: await makeResponse([page(1)], "valid.ndjson"),
    invalidResponse: await makeResponse(
      [page(1), page(1)],
      "invalid.ndjson",
    ),
  };
}

async function markdownFixture(): Promise<{
  readonly dataRoot: string;
  readonly projectRoot: string;
  readonly versionId: string;
  readonly job: DurableJob;
}> {
  const dataRoot = await mkdtemp(
    path.join(tmpdir(), "job-worker-markdown-"),
  );
  temporaryDirectories.push(dataRoot);
  const projectRoot = path.join(
    dataRoot,
    "users",
    TENANT,
    "projects",
    `${PROJECT}-markdown`,
  );
  const inputPath = path.join(projectRoot, "sources", "source.md");
  const outputDirectory = path.join(
    projectRoot,
    "artifacts",
    "markdown-job",
  );
  await Promise.all([
    mkdir(path.dirname(inputPath), { recursive: true }),
    mkdir(outputDirectory, { recursive: true }),
  ]);
  const source = "# Thesis\n\nDurable evidence.\n";
  await writeFile(inputPath, source, "utf8");
  const sourceSha256 = createHash("sha256")
    .update(source)
    .digest("hex");
  const database = openProjectDatabase({
    projectRoot,
    databasePath: path.join("data", "research.sqlite3"),
    preferredSearchBackend: "deterministic",
  });
  let versionId: string;
  let documentId: string;
  try {
    const registration = createResearchStore(
      database,
    ).documents.registerVersion({
      logicalKey: "worker:source.md",
      sourceRoot: "test",
      sourceRelpath: "source.md",
      title: "Markdown source",
      originalFilename: "source.md",
      storedPath: path.relative(projectRoot, inputPath),
      fileType: "md",
      sha256: sourceSha256,
      fileSize: Buffer.byteLength(source),
      status: "parsing",
      activate: false,
    });
    versionId = registration.version.id;
    documentId = registration.document.id;
  } finally {
    database.close();
  }
  const now = new Date().toISOString();
  return {
    dataRoot,
    projectRoot,
    versionId,
    job: {
      id: "job-worker-markdown",
      tenantNamespace: TENANT,
      projectId: `${PROJECT}-markdown`,
      type: "document.ingest",
      status: "running",
      payload: {
        inputPath,
        outputDirectory,
        documentId,
        documentVersionId: versionId,
        sourceSha256,
      },
      attempt: 1,
      maxAttempts: 3,
      leaseOwner: "worker-1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: `document-ingest:${versionId}`,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: null,
      result: null,
      error: null,
    },
  };
}

function researchState(
  projectRoot: string,
  versionId: string,
): {
  readonly evidenceCount: number;
  readonly versionStatus: string;
} {
  const database = openProjectDatabase({
    projectRoot,
    databasePath: path.join("data", "research.sqlite3"),
    preferredSearchBackend: "deterministic",
  });
  try {
    const row = database.connection
      .prepare("SELECT COUNT(*) AS count FROM evidence")
      .get();
    return {
      evidenceCount: Number(row?.count ?? -1),
      versionStatus: createResearchStore(
        database,
      ).documents.getVersion(versionId).status,
    };
  } finally {
    database.close();
  }
}

function queueFor(
  job: DurableJob,
  onComplete: () => void,
  onFail: () => void,
): JobQueuePort & {
  readonly complete: ReturnType<typeof vi.fn>;
  readonly fail: ReturnType<typeof vi.fn>;
} {
  return {
    claim: vi.fn(() => job),
    heartbeat: vi.fn(() => job),
    complete: vi.fn(() => {
      onComplete();
      return { ...job, status: "completed" as const };
    }),
    fail: vi.fn(() => {
      onFail();
      return { ...job, status: "failed" as const };
    }),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JobWorker durable projection ordering", () => {
  it("commits Evidence and version status before queue.complete", async () => {
    const value = await fixture();
    let observedAtComplete:
      | ReturnType<typeof researchState>
      | undefined;
    const queue = queueFor(
      value.job,
      () => {
        observedAtComplete = researchState(
          value.projectRoot,
          value.versionId,
        );
      },
      () => undefined,
    );
    const worker = new JobWorker(
      queue,
      { execute: vi.fn(async () => value.validResponse) },
      new ComputeResultProjector({ dataRoot: value.dataRoot }),
      { workerId: "worker-1" },
    );

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(observedAtComplete).toEqual({
      evidenceCount: 1,
      versionStatus: "indexed",
    });
    expect(queue.complete).toHaveBeenCalledOnce();
    expect(queue.fail).not.toHaveBeenCalled();
  });

  it("runs real Python Markdown compute through projection before durable completion", async () => {
    const value = await markdownFixture();
    let observedAtComplete:
      | ReturnType<typeof researchState>
      | undefined;
    const queue = queueFor(
      value.job,
      () => {
        observedAtComplete = researchState(
          value.projectRoot,
          value.versionId,
        );
      },
      () => undefined,
    );
    const executor = new ComputeJobExecutor(
      createPythonComputeClient({
        workerScript: pythonWorker,
        timeoutMs: 5_000,
      }),
      new TenantProjectComputePathPolicy(value.dataRoot),
    );
    const worker = new JobWorker(
      queue,
      executor,
      new ComputeResultProjector({ dataRoot: value.dataRoot }),
      { workerId: "worker-1" },
    );

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(observedAtComplete).toEqual({
      evidenceCount: 2,
      versionStatus: "indexed",
    });
    expect(queue.complete).toHaveBeenCalledOnce();
    expect(queue.fail).not.toHaveBeenCalled();
  });

  it("rolls back Evidence, records failure and never completes the queue job", async () => {
    const value = await fixture();
    let observedAtFail:
      | ReturnType<typeof researchState>
      | undefined;
    const queue = queueFor(
      value.job,
      () => undefined,
      () => {
        observedAtFail = researchState(
          value.projectRoot,
          value.versionId,
        );
      },
    );
    const worker = new JobWorker(
      queue,
      { execute: vi.fn(async () => value.invalidResponse) },
      new ComputeResultProjector({ dataRoot: value.dataRoot }),
      { workerId: "worker-1" },
    );

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(observedAtFail).toEqual({
      evidenceCount: 0,
      versionStatus: "failed",
    });
    expect(queue.complete).not.toHaveBeenCalled();
    expect(queue.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: value.job.id,
        retry: false,
      }),
    );
  });
});

describe("loadJobWorkerConfig projection bounds", () => {
  it("loads independently bounded projector limits from environment", () => {
    const config = loadJobWorkerConfig(
      {
        PRIVATE_FUND_PROJECTION_MAX_RECORDS_BYTES: "4096",
        PRIVATE_FUND_PROJECTION_MAX_LINE_BYTES: "1024",
        PRIVATE_FUND_PROJECTION_MAX_RECORDS: "99",
      },
      "/tmp/private-fund-config",
    );
    expect(config).toMatchObject({
      projectionMaxRecordsBytes: 4096,
      projectionMaxLineBytes: 1024,
      projectionMaxRecords: 99,
    });
  });

  it("rejects disabled or nonsensical projector limits", () => {
    expect(() =>
      loadJobWorkerConfig({
        PRIVATE_FUND_PROJECTION_MAX_RECORDS: "0",
      }),
    ).toThrow(
      "PRIVATE_FUND_PROJECTION_MAX_RECORDS must be a positive integer",
    );
  });
});
