import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createPythonComputeClient } from "@private-fund/compute-client";
import { ComputeResultProjector } from "@private-fund/compute-projector";
import { DurableJobQueue } from "@private-fund/job-queue";
import {
  createResearchStore,
  openProjectDatabase,
} from "@private-fund/research-store";

import type { ApiConfig } from "../../api/src/config.js";
import {
  createApiRuntime,
  type ApiRuntime,
} from "../../api/src/main.js";
import { ComputeJobExecutor } from "../src/compute-job-executor.js";
import { TenantProjectComputePathPolicy } from "../src/path-policy.js";
import { JobWorker } from "../src/worker.js";

const TENANT = "00000000-0000-4000-8000-0000000000c3";
const AGENT_WORKER_ENTRY = fileURLToPath(
  new URL(
    "../../api/test/fixtures/fake-agent-worker.mjs",
    import.meta.url,
  ),
);
const PYTHON_WORKER = fileURLToPath(
  new URL(
    "../../../python/compute-worker/worker.py",
    import.meta.url,
  ),
);
const PYTHON_EXECUTABLE = fileURLToPath(
  new URL(
    "../../../python/compute-worker/.venv/bin/python",
    import.meta.url,
  ),
);

function multipartMarkdown(
  filename: string,
  contents: string,
): { boundary: string; payload: Buffer } {
  const boundary = "----upload-ingest-crash-recovery";
  return {
    boundary,
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="files"; filename="${filename}"\r\n` +
          "Content-Type: text/markdown\r\n\r\n",
      ),
      Buffer.from(contents, "utf8"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function researchState(
  projectRoot: string,
  versionId: string,
): {
  evidenceCount: number;
  distinctEvidenceCount: number;
  versionStatus: string;
  versionLifecycle: string;
} {
  const database = openProjectDatabase({
    projectRoot,
    databasePath: path.join("data", "research.sqlite3"),
    preferredSearchBackend: "deterministic",
  });
  try {
    const counts = database.connection
      .prepare(
        `SELECT COUNT(*) AS count,
                COUNT(DISTINCT evidence_id) AS distinctCount
         FROM evidence
         WHERE document_version_id = ?`,
      )
      .get(versionId);
    const version = createResearchStore(
      database,
    ).documents.getVersion(versionId);
    return {
      evidenceCount: Number(counts?.count ?? -1),
      distinctEvidenceCount: Number(counts?.distinctCount ?? -1),
      versionStatus: version.status,
      versionLifecycle: version.lifecycle,
    };
  } finally {
    database.close();
  }
}

describe("upload to document.ingest crash recovery", () => {
  let runtime: ApiRuntime | undefined;
  let dataRoot: string | undefined;

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    if (dataRoot !== undefined) {
      await rm(dataRoot, { recursive: true, force: true });
      dataRoot = undefined;
    }
  });

  it("replays a committed golden projection exactly once after the first worker dies before queue completion", async () => {
    dataRoot = await mkdtemp(
      path.join(tmpdir(), "pf-upload-ingest-recovery-"),
    );
    const config: ApiConfig = {
      host: "127.0.0.1",
      port: 6768,
      dataRoot,
      controlDatabase: path.join(dataRoot, "control.sqlite3"),
      auth: {
        mode: "development",
        userId: "upload-ingest-owner",
        dataNamespace: TENANT,
      },
      agentWorkerEntry: AGENT_WORKER_ENTRY,
    };
    runtime = await createApiRuntime(config);
    const projectResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Golden ingest recovery" },
    });
    expect(projectResponse.statusCode, projectResponse.body).toBe(201);
    const project = projectResponse.json<{ id: string }>();
    const source =
      "# Golden thesis\n\nCrash recovery preserves Evidence.\n";
    const multipart = multipartMarkdown("golden.md", source);
    const uploadResponse = await runtime.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/documents/upload`,
      headers: {
        "content-type": `multipart/form-data; boundary=${multipart.boundary}`,
      },
      payload: multipart.payload,
    });
    expect(uploadResponse.statusCode, uploadResponse.body).toBe(202);
    const uploaded = uploadResponse.json<{
      uploads: Array<{
        document: { id: string };
        version: { id: string };
        job: {
          id: string;
          status: string;
          payload: Record<string, unknown>;
        };
      }>;
    }>().uploads[0]!;
    expect(uploaded.job).toMatchObject({
      status: "queued",
      payload: {
        documentId: uploaded.document.id,
        documentVersionId: uploaded.version.id,
      },
    });
    expect(path.isAbsolute(String(uploaded.job.payload.inputPath))).toBe(
      true,
    );
    expect(
      path.isAbsolute(String(uploaded.job.payload.outputDirectory)),
    ).toBe(true);

    let clockMilliseconds = Date.now() + 1_000;
    const queue = new DurableJobQueue(
      runtime.database,
      () => new Date(clockMilliseconds),
    );
    const executor = new ComputeJobExecutor(
      createPythonComputeClient({
        workerScript: PYTHON_WORKER,
        pythonExecutable: PYTHON_EXECUTABLE,
        timeoutMs: 10_000,
      }),
      new TenantProjectComputePathPolicy(dataRoot),
    );
    const projector = new ComputeResultProjector({ dataRoot });

    const abandoned = queue.claim({
      workerId: "worker-that-crashes",
      types: ["document.ingest"],
      leaseDurationMs: 1_000,
    });
    expect(abandoned).toMatchObject({
      id: uploaded.job.id,
      status: "running",
      attempt: 1,
    });
    if (abandoned === null) {
      throw new Error("The API-produced ingest job was not claimable");
    }
    const firstResponse = await executor.execute(abandoned);
    const firstProjection = await projector.project(
      abandoned,
      firstResponse,
    );
    expect(firstProjection).toMatchObject({
      kind: "document",
      documentVersionId: uploaded.version.id,
      evidenceCount: 2,
      status: "indexed",
    });

    const projectRoot = path.join(
      dataRoot,
      "users",
      TENANT,
      "projects",
      project.id,
    );
    expect(
      researchState(projectRoot, uploaded.version.id),
    ).toEqual({
      evidenceCount: 2,
      distinctEvidenceCount: 2,
      versionStatus: "indexed",
      versionLifecycle: "active",
    });
    expect(
      queue.getForTenant(TENANT, uploaded.job.id),
    ).toMatchObject({
      status: "running",
      attempt: 1,
      leaseOwner: "worker-that-crashes",
    });

    clockMilliseconds += 2_000;
    expect(queue.requeueExpired()).toBe(1);
    expect(
      queue.getForTenant(TENANT, uploaded.job.id),
    ).toMatchObject({
      status: "queued",
      attempt: 1,
      leaseOwner: null,
    });

    const recoveryWorker = new JobWorker(
      queue,
      executor,
      projector,
      {
        workerId: "worker-after-restart",
        leaseDurationMs: 5_000,
        retryBaseDelayMs: 1,
      },
    );
    await expect(recoveryWorker.runOnce()).resolves.toBe(true);
    expect(
      queue.getForTenant(TENANT, uploaded.job.id),
    ).toMatchObject({
      status: "completed",
      attempt: 2,
      leaseOwner: null,
      error: null,
    });
    expect(
      researchState(projectRoot, uploaded.version.id),
    ).toEqual({
      evidenceCount: 2,
      distinctEvidenceCount: 2,
      versionStatus: "indexed",
      versionLifecycle: "active",
    });

    const preview = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/documents/${uploaded.document.id}` +
        `/text-preview?versionId=${uploaded.version.id}`,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      kind: "document_text",
      documentId: uploaded.document.id,
      documentVersionId: uploaded.version.id,
      fileName: "golden.md",
      fileType: "md",
      chunkCount: 2,
      contentMarkdown:
        "Golden thesis\n\nCrash recovery preserves Evidence.",
      truncated: false,
    });
    const jobResponse = await runtime.app.inject({
      method: "GET",
      url: `/v1/jobs/${uploaded.job.id}`,
    });
    expect(jobResponse.statusCode, jobResponse.body).toBe(200);
    expect(jobResponse.json()).toMatchObject({
      id: uploaded.job.id,
      status: "completed",
      attempt: 2,
    });
  });
});
