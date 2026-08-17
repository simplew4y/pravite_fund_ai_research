import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { TenantIdentity } from "@private-fund/contracts";
import { buildTenantContext } from "@private-fund/core";
import {
  createControlRepositories,
  openControlDatabase,
} from "@private-fund/db";
import { DurableJobQueue } from "@private-fund/job-queue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RepositoryGlobalUploadService } from "./global-upload-service.js";
import {
  RepositoryJobService,
  RepositoryProjectService,
} from "./repository-services.js";
import { RepositoryResearchService } from "./research-service.js";
import { ProjectResearchStoreManager } from "./research-stores.js";

const ALPHA: TenantIdentity = {
  userId: "upload-alpha",
  dataNamespace: "00000000-0000-4000-8000-0000000000a1",
};
const BETA: TenantIdentity = {
  userId: "upload-beta",
  dataNamespace: "00000000-0000-4000-8000-0000000000b2",
};

async function* fileStream(
  filename: string,
  contents: string,
  mimeType = "application/pdf",
) {
  yield {
    filename,
    mimeType,
    contents: (async function* () {
      yield Buffer.from(contents, "utf8");
    })(),
  };
}

describe("RepositoryGlobalUploadService", () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-global-upload-"));
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("stages immutably, auto-routes a high-confidence file and follows its durable job", async () => {
    const database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(database);
    repositories.users.upsertCloudShadow(ALPHA);
    repositories.users.upsertCloudShadow(BETA);
    const alpha = buildTenantContext(dataRoot, ALPHA);
    const beta = buildTenantContext(dataRoot, BETA);
    const projects = new RepositoryProjectService(repositories);
    const project = await projects.create(alpha, {
      name: "Tesla research",
      companyName: "Tesla, Inc.",
      ticker: "TSLA",
    });
    const stores = new ProjectResearchStoreManager();
    const jobs = new RepositoryJobService(database);
    const research = new RepositoryResearchService(
      repositories,
      stores,
      jobs,
    );
    const uploads = new RepositoryGlobalUploadService(
      repositories,
      research,
      jobs,
    );

    const batch = await uploads.create(alpha, {
      idempotencyKey: "global-upload-auto-1",
      files: fileStream(
        "TSLA annual report.pdf",
        "%PDF-1.7\nTesla annual report",
      ),
    });

    expect(batch).toMatchObject({
      status: "indexing",
      fileCount: 1,
      items: [
        {
          status: "indexing",
          targetProjectId: project.id,
          routeMethod: "filename_ticker",
          documentId: expect.any(String),
          pipelineJobId: expect.any(String),
        },
      ],
    });
    expect(
      repositories.uploads.listBatchesForTenant(beta.dataNamespace),
    ).toMatchObject({ total: 0, items: [] });
    expect(() =>
      repositories.uploads.getBatchForTenant(
        beta.dataNamespace,
        batch.batchId,
      ),
    ).toThrowError(expect.objectContaining({ code: "not_found" }));

    const replay = await uploads.create(alpha, {
      idempotencyKey: "global-upload-auto-1",
      files: fileStream(
        "TSLA annual report.pdf",
        "%PDF-1.7\nTesla annual report",
      ),
    });
    expect(replay.batchId).toBe(batch.batchId);

    const queue = new DurableJobQueue(database);
    const claimed = queue.claim({
      workerId: "test-ingest-worker",
      leaseDurationMs: 60_000,
      types: ["document.ingest"],
    });
    expect(claimed?.id).toBe(batch.items[0]?.pipelineJobId);
    queue.complete({
      jobId: claimed!.id,
      workerId: "test-ingest-worker",
      result: { documentVersionId: claimed!.payload.documentVersionId },
    });

    await expect(uploads.getBatch(alpha, batch.batchId)).resolves.toMatchObject({
      status: "completed",
      counts: { completed: 1 },
      items: [{ status: "completed", targetProjectId: project.id }],
    });

    stores.close();
    database.close();
  });

  it("keeps ambiguous files in review and rejects cross-tenant manual routing", async () => {
    const database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(database);
    repositories.users.upsertCloudShadow(ALPHA);
    repositories.users.upsertCloudShadow(BETA);
    const alpha = buildTenantContext(dataRoot, ALPHA);
    const beta = buildTenantContext(dataRoot, BETA);
    const projects = new RepositoryProjectService(repositories);
    const alphaProject = await projects.create(alpha, {
      name: "Alpha portfolio",
    });
    const betaProject = await projects.create(beta, {
      name: "Beta portfolio",
    });
    const stores = new ProjectResearchStoreManager();
    const jobs = new RepositoryJobService(database);
    const research = new RepositoryResearchService(
      repositories,
      stores,
      jobs,
    );
    const uploads = new RepositoryGlobalUploadService(
      repositories,
      research,
      jobs,
    );
    const batch = await uploads.create(alpha, {
      idempotencyKey: "global-upload-review-1",
      files: fileStream("unclassified.pdf", "%PDF-1.7\nunknown issuer"),
    });
    const item = batch.items[0]!;

    expect(batch).toMatchObject({
      status: "needs_review",
      counts: { needs_review: 1 },
    });
    await expect(
      uploads.routeItem(beta, item.itemId, {
        projectId: betaProject.id,
        idempotencyKey: "cross-tenant-route",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      uploads.routeItem(alpha, item.itemId, {
        projectId: betaProject.id,
        idempotencyKey: "wrong-project-route",
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    await expect(
      uploads.routeItem(alpha, item.itemId, {
        projectId: alphaProject.id,
        idempotencyKey: "manual-route-alpha",
      }),
    ).resolves.toMatchObject({
      status: "indexing",
      items: [
        {
          status: "indexing",
          targetProjectId: alphaProject.id,
          routeMethod: "manual",
        },
      ],
    });

    stores.close();
    database.close();
  });

  it("rejects unsafe names and mismatched MIME types before persistence", async () => {
    const database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(database);
    repositories.users.upsertCloudShadow(ALPHA);
    const alpha = buildTenantContext(dataRoot, ALPHA);
    const stores = new ProjectResearchStoreManager();
    const jobs = new RepositoryJobService(database);
    const research = new RepositoryResearchService(
      repositories,
      stores,
      jobs,
    );
    const uploads = new RepositoryGlobalUploadService(
      repositories,
      research,
      jobs,
    );

    await expect(
      uploads.create(alpha, {
        idempotencyKey: "unsafe-name",
        files: fileStream("../escape.pdf", "unsafe"),
      }),
    ).rejects.toMatchObject({ code: "invalid_upload_filename" });
    await expect(
      uploads.create(alpha, {
        idempotencyKey: "mime-mismatch",
        files: fileStream(
          "report.docx",
          "not-a-docx",
          "application/pdf",
        ),
      }),
    ).rejects.toMatchObject({ code: "document_mime_mismatch" });
    expect(
      repositories.uploads.listBatchesForTenant(alpha.dataNamespace),
    ).toMatchObject({ total: 0, items: [] });

    stores.close();
    database.close();
  });
});
