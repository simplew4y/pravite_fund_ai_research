import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "./config.js";
import { createApiRuntime, type ApiRuntime } from "./main.js";

const WORKER_ENTRY = fileURLToPath(
  new URL("../test/fixtures/fake-agent-worker.mjs", import.meta.url),
);
const ALPHA_NAMESPACE = "00000000-0000-4000-8000-0000000000e1";
const BETA_NAMESPACE = "00000000-0000-4000-8000-0000000000e2";

function configFor(
  dataRoot: string,
  userId: string,
  dataNamespace: string,
): ApiConfig {
  return {
    host: "127.0.0.1",
    port: 6768,
    dataRoot,
    controlDatabase: path.join(dataRoot, "control.sqlite3"),
    auth: {
      mode: "development",
      userId,
      dataNamespace,
    },
    agentWorkerEntry: WORKER_ENTRY,
  };
}

describe("canonical research registration, assets, and durable jobs", () => {
  let alpha: ApiRuntime | undefined;
  let beta: ApiRuntime | undefined;
  let dataRoot: string | undefined;

  afterEach(async () => {
    await beta?.close();
    await alpha?.close();
    if (dataRoot !== undefined) {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("serves non-empty, idempotent, filtered data without crossing tenant boundaries", async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-research-control-"));
    alpha = await createApiRuntime(
      configFor(dataRoot, "research-control-alpha", ALPHA_NAMESPACE),
    );
    beta = await createApiRuntime(
      configFor(dataRoot, "research-control-beta", BETA_NAMESPACE),
    );

    const projectResponse = await alpha.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: {
        name: "Seeded canonical research",
        companyName: "Canonical Research Co.",
        ticker: "CRC",
      },
    });
    expect(projectResponse.statusCode, projectResponse.body).toBe(201);
    const project = projectResponse.json<{ id: string }>();

    const projectRoot = path.join(
      dataRoot,
      "users",
      ALPHA_NAMESPACE,
      "projects",
      project.id,
    );
    const storedPath = path.join("sources", "manual", "annual.pdf");
    const absolutePath = path.join(projectRoot, storedPath);
    const contents = Buffer.from(
      "%PDF-1.7\ncanonical document registration fixture\n",
      "utf8",
    );
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, { flag: "wx", mode: 0o600 });
    const canonicalAbsolutePath = await realpath(absolutePath);
    const sha256 = createHash("sha256").update(contents).digest("hex");
    const registration = {
      logicalKey: "manual:annual.pdf",
      sourceRoot: "manual",
      sourceRelpath: "annual.pdf",
      title: "Annual report",
      originalFilename: "annual.pdf",
      storedPath,
      fileType: "pdf",
      mimeType: "application/pdf",
      sha256,
      fileSize: contents.byteLength,
      status: "indexed",
      parserName: "acceptance-fixture",
      parserVersion: "1",
      metadata: {
        owner: "research-control-alpha",
        source: "canonical-registration-acceptance",
      },
      activate: true,
    };

    const firstRegistration = await alpha.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/documents/register`,
      payload: registration,
    });
    expect(
      firstRegistration.statusCode,
      firstRegistration.body,
    ).toBe(201);
    const registered = firstRegistration.json<{
      document: {
        id: string;
        currentVersionId: string;
        currentVersionNo: number;
        logicalKey: string;
        sourceRelpath: string;
      };
      version: {
        id: string;
        sha256: string;
        storedPath: string;
        status: string;
        lifecycle: string;
        metadata: Record<string, unknown>;
      };
      created: boolean;
    }>();
    expect(registered).toMatchObject({
      document: {
        currentVersionNo: 1,
        logicalKey: registration.logicalKey,
        sourceRelpath: registration.sourceRelpath,
      },
      version: {
        sha256,
        storedPath: canonicalAbsolutePath,
        status: "indexed",
        lifecycle: "active",
        metadata: registration.metadata,
      },
      created: true,
    });
    expect(registered.document.currentVersionId).toBe(
      registered.version.id,
    );

    const duplicateRegistration = await alpha.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/documents/register`,
      payload: registration,
    });
    expect(
      duplicateRegistration.statusCode,
      duplicateRegistration.body,
    ).toBe(200);
    expect(duplicateRegistration.json()).toMatchObject({
      document: {
        id: registered.document.id,
        currentVersionNo: 1,
      },
      version: {
        id: registered.version.id,
        sha256,
      },
      created: false,
    });

    const crossTenantRegistration = await beta.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/documents/register`,
      payload: registration,
    });
    expect(
      crossTenantRegistration.statusCode,
      crossTenantRegistration.body,
    ).toBe(404);
    expect(crossTenantRegistration.json()).toMatchObject({
      error: "not_found",
    });

    const assetInput = {
      assetId: "asset:seeded-thesis",
      assetType: "investment_thesis",
      title: "Seeded investment thesis",
      status: "completed",
      summary: "A non-empty canonical research asset.",
      contentMarkdown: "# Thesis\n\nEvidence-backed durable growth.",
      sourceResponseId: null,
      structuredContent: {
        rating: "outperform",
        confidence: 0.82,
      },
      metadata: {
        author: "research-control-alpha",
      },
      tags: ["thesis", "seeded"],
      evidence: [],
    };
    const firstAsset = await alpha.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/assets`,
      payload: assetInput,
    });
    expect(firstAsset.statusCode, firstAsset.body).toBe(201);
    const asset = firstAsset.json<{
      asset: {
        id: string;
        assetType: string;
        title: string;
        currentVersionNo: number;
      };
      version: {
        id: string;
        contentMarkdown: string;
        structuredContent: Record<string, unknown>;
        tags: string[];
      };
      references: unknown[];
      created: boolean;
    }>();
    expect(asset).toMatchObject({
      asset: {
        id: assetInput.assetId,
        assetType: assetInput.assetType,
        title: assetInput.title,
        currentVersionNo: 1,
      },
      version: {
        contentMarkdown: assetInput.contentMarkdown,
        structuredContent: assetInput.structuredContent,
        tags: assetInput.tags,
      },
      references: [],
      created: true,
    });

    const duplicateAsset = await alpha.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/assets`,
      payload: assetInput,
    });
    expect(duplicateAsset.statusCode, duplicateAsset.body).toBe(200);
    expect(duplicateAsset.json()).toMatchObject({
      asset: {
        id: assetInput.assetId,
        currentVersionNo: 1,
      },
      version: { id: asset.version.id },
      created: false,
    });

    const assetPage = await alpha.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/assets?limit=1&offset=0`,
    });
    expect(assetPage.statusCode, assetPage.body).toBe(200);
    expect(assetPage.json()).toMatchObject({
      items: [
        {
          id: assetInput.assetId,
          assetType: assetInput.assetType,
          title: assetInput.title,
          currentVersionNo: 1,
        },
      ],
      total: 1,
      limit: 1,
      offset: 0,
      hasMore: false,
    });

    const crossTenantAssetPage = await beta.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/assets`,
    });
    expect(
      crossTenantAssetPage.statusCode,
      crossTenantAssetPage.body,
    ).toBe(404);
    expect(crossTenantAssetPage.json()).toMatchObject({
      error: "not_found",
    });

    const firstJob = await alpha.app.inject({
      method: "POST",
      url: "/v1/jobs",
      payload: {
        projectId: project.id,
        type: "document.ingest",
        payload: {
          documentId: registered.document.id,
          documentVersionId: registered.version.id,
          inputPath: storedPath,
          outputDirectory: `artifacts/ingest/${registered.version.id}`,
          sourceSha256: sha256,
        },
        idempotencyKey: `document-ingest:${registered.version.id}`,
        maxAttempts: 4,
      },
    });
    expect(firstJob.statusCode, firstJob.body).toBe(201);
    const enqueued = firstJob.json<{
      job: {
        id: string;
        tenantNamespace: string;
        projectId: string;
        type: string;
        status: string;
        attempt: number;
        maxAttempts: number;
        payload: Record<string, unknown>;
      };
      created: boolean;
    }>();
    expect(enqueued).toMatchObject({
      job: {
        tenantNamespace: ALPHA_NAMESPACE,
        projectId: project.id,
        type: "document.ingest",
        status: "queued",
        attempt: 0,
        maxAttempts: 4,
        payload: {
          documentId: registered.document.id,
          documentVersionId: registered.version.id,
          sourceSha256: sha256,
        },
      },
      created: true,
    });

    const duplicateJob = await alpha.app.inject({
      method: "POST",
      url: "/v1/jobs",
      payload: {
        projectId: project.id,
        type: "document.ingest",
        payload: {
          documentId: registered.document.id,
          documentVersionId: registered.version.id,
          inputPath: storedPath,
          outputDirectory: `artifacts/ingest/${registered.version.id}`,
          sourceSha256: sha256,
        },
        idempotencyKey: `document-ingest:${registered.version.id}`,
        maxAttempts: 4,
      },
    });
    expect(duplicateJob.statusCode, duplicateJob.body).toBe(200);
    expect(duplicateJob.json()).toMatchObject({
      job: { id: enqueued.job.id },
      created: false,
    });

    const secondJob = await alpha.app.inject({
      method: "POST",
      url: "/v1/jobs",
      payload: {
        projectId: project.id,
        type: "tracking.scan",
        payload: { trigger: "acceptance-fixture" },
        idempotencyKey: `tracking-scan:${project.id}:fixture`,
        maxAttempts: 2,
      },
    });
    expect(secondJob.statusCode, secondJob.body).toBe(201);

    const filteredJobs = await alpha.app.inject({
      method: "GET",
      url:
        `/v1/jobs?projectId=${project.id}` +
        "&type=document.ingest&status=queued&limit=1",
    });
    expect(filteredJobs.statusCode, filteredJobs.body).toBe(200);
    expect(filteredJobs.json()).toMatchObject({
      jobs: [
        {
          id: enqueued.job.id,
          projectId: project.id,
          type: "document.ingest",
          status: "queued",
        },
      ],
    });

    const jobDetail = await alpha.app.inject({
      method: "GET",
      url: `/v1/jobs/${enqueued.job.id}`,
    });
    expect(jobDetail.statusCode, jobDetail.body).toBe(200);
    expect(jobDetail.json()).toMatchObject(enqueued.job);

    const crossTenantJob = await beta.app.inject({
      method: "GET",
      url: `/v1/jobs/${enqueued.job.id}`,
    });
    expect(crossTenantJob.statusCode, crossTenantJob.body).toBe(404);
    expect(crossTenantJob.json()).toMatchObject({ error: "not_found" });

    const crossTenantJobs = await beta.app.inject({
      method: "GET",
      url: `/v1/jobs?projectId=${project.id}`,
    });
    expect(crossTenantJobs.statusCode, crossTenantJobs.body).toBe(200);
    expect(crossTenantJobs.json()).toEqual({ jobs: [] });
  });
});
