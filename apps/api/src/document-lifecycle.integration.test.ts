import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  createResearchStore,
  openProjectDatabase,
} from "@private-fund/research-store";

import type { ApiConfig } from "./config.js";
import { createApiRuntime, type ApiRuntime } from "./main.js";

const WORKER_ENTRY = fileURLToPath(
  new URL("../test/fixtures/fake-agent-worker.mjs", import.meta.url),
);
const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";

function multipartFile(
  filename: string,
  contents: string,
): { boundary: string; payload: Buffer } {
  const boundary = `----document-lifecycle-${filename.replaceAll(".", "-")}`;
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

function runtimeConfig(
  dataRoot: string,
  controlDatabase: string,
  userId: string,
  dataNamespace: string,
): ApiConfig {
  return {
    host: "127.0.0.1",
    port: 6768,
    dataRoot,
    controlDatabase,
    auth: {
      mode: "development",
      userId,
      dataNamespace,
    },
    agentWorkerEntry: WORKER_ENTRY,
  };
}

async function upload(
  runtime: ApiRuntime,
  projectId: string,
  filename: string,
  contents: string,
) {
  const multipart = multipartFile(filename, contents);
  const response = await runtime.app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/documents/upload`,
    headers: {
      "content-type": `multipart/form-data; boundary=${multipart.boundary}`,
    },
    payload: multipart.payload,
  });
  expect(response.statusCode, response.body).toBe(202);
  return response.json<{
    uploads: Array<{
      document: { id: string };
      version: { id: string };
    }>;
  }>().uploads[0]!;
}

describe("canonical document preview and identity lifecycle", () => {
  const runtimes: ApiRuntime[] = [];
  let dataRoot: string | undefined;

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
    if (dataRoot !== undefined) {
      await rm(dataRoot, { recursive: true, force: true });
      dataRoot = undefined;
    }
  });

  it("serves structured Evidence and deletes stable identities atomically, idempotently and per tenant", async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-document-lifecycle-"));
    const controlDatabase = path.join(dataRoot, "control.sqlite3");
    const owner = await createApiRuntime(
      runtimeConfig(
        dataRoot,
        controlDatabase,
        "document-owner",
        TENANT_A,
      ),
    );
    runtimes.push(owner);
    const projectResponse = await owner.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Document lifecycle" },
    });
    expect(projectResponse.statusCode, projectResponse.body).toBe(201);
    const project = projectResponse.json<{ id: string }>();

    const annual = await upload(
      owner,
      project.id,
      "annual.md",
      "# Investment thesis\n\nRevenue grew 20%.",
    );
    const appendix = await upload(
      owner,
      project.id,
      "appendix.md",
      "Durable appendix.",
    );
    const single = await upload(
      owner,
      project.id,
      "single.md",
      "Single source.",
    );

    const projectRoot = path.join(
      dataRoot,
      "users",
      TENANT_A,
      "projects",
      project.id,
    );
    const researchDatabase = openProjectDatabase({
      projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
      preferredSearchBackend: "deterministic",
    });
    try {
      const store = createResearchStore(researchDatabase);
      for (const [evidenceId, originalText] of [
        ["chunk:annual-heading", "# Investment thesis"],
        ["chunk:annual-fact", "Revenue grew 20%."],
        ["chunk:annual-hostile", "<img src=x onerror=alert(1)>"],
      ] as const) {
        store.evidence.put({
          evidenceId,
          kind: "chunk",
          documentVersionId: annual.version.id,
          originalText,
        });
      }
      store.documents.updateVersionStatus(annual.version.id, "indexed");
    } finally {
      researchDatabase.close();
    }

    const sourceBytes = await owner.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/documents/${annual.document.id}` +
        "/preview",
    });
    expect(sourceBytes.statusCode, sourceBytes.body).toBe(200);
    expect(sourceBytes.headers["content-type"]).toContain("text/markdown");
    expect(sourceBytes.body).toContain("# Investment thesis");

    const structured = await owner.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/documents/${annual.document.id}` +
        "/text-preview",
    });
    expect(structured.statusCode, structured.body).toBe(200);
    expect(structured.headers).toMatchObject({
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    expect(structured.headers["content-type"]).toContain(
      "application/json",
    );
    expect(structured.json()).toEqual({
      kind: "document_text",
      documentId: annual.document.id,
      documentVersionId: annual.version.id,
      fileName: "annual.md",
      fileType: "md",
      chunkCount: 3,
      contentMarkdown:
        "# Investment thesis\n\nRevenue grew 20%.\n\n<img src=x onerror=alert(1)>",
      truncated: false,
    });

    const outsider = await createApiRuntime(
      runtimeConfig(
        dataRoot,
        controlDatabase,
        "document-outsider",
        TENANT_B,
      ),
    );
    runtimes.push(outsider);
    for (const request of [
      {
        method: "GET" as const,
        url:
          `/v1/projects/${project.id}/documents/${annual.document.id}` +
          "/text-preview",
      },
      {
        method: "DELETE" as const,
        url: `/v1/projects/${project.id}/documents/${single.document.id}`,
      },
      {
        method: "POST" as const,
        url: `/v1/projects/${project.id}/documents/delete`,
        payload: {
          documentIds: [
            annual.document.id,
            appendix.document.id,
          ],
        },
      },
    ]) {
      const response = await outsider.app.inject(request);
      expect(response.statusCode, response.body).toBe(404);
    }

    const rejectedBatch = await owner.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/documents/delete`,
      payload: {
        documentIds: [annual.document.id, "doc_missing"],
      },
    });
    expect(rejectedBatch.statusCode, rejectedBatch.body).toBe(404);
    const unchanged = await owner.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/documents?limit=50&offset=0`,
    });
    expect(
      unchanged
        .json<{ items: Array<{ id: string; status: string }> }>()
        .items.filter((document) =>
          [annual.document.id, appendix.document.id].includes(document.id),
        )
        .map((document) => document.status),
    ).toEqual(["active", "active"]);

    const singleDelete = await owner.app.inject({
      method: "DELETE",
      url: `/v1/projects/${project.id}/documents/${single.document.id}`,
    });
    expect(singleDelete.statusCode, singleDelete.body).toBe(200);
    expect(singleDelete.json()).toMatchObject({
      id: single.document.id,
      status: "removed",
    });
    const singleReplay = await owner.app.inject({
      method: "DELETE",
      url: `/v1/projects/${project.id}/documents/${single.document.id}`,
    });
    expect(singleReplay.statusCode, singleReplay.body).toBe(200);
    expect(singleReplay.json()).toMatchObject({
      id: single.document.id,
      status: "removed",
    });

    const deleted = await owner.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/documents/delete`,
      payload: {
        documentIds: [
          annual.document.id,
          appendix.document.id,
        ],
      },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json()).toMatchObject({
      deletedDocumentIds: [
        annual.document.id,
        appendix.document.id,
      ],
      alreadyRemovedDocumentIds: [],
      documents: [
        { id: annual.document.id, status: "removed" },
        { id: appendix.document.id, status: "removed" },
      ],
    });
    const replay = await owner.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/documents/delete`,
      payload: {
        documentIds: [
          annual.document.id,
          appendix.document.id,
        ],
      },
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({
      deletedDocumentIds: [],
      alreadyRemovedDocumentIds: [
        annual.document.id,
        appendix.document.id,
      ],
    });
    const removedPreview = await owner.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/documents/${annual.document.id}` +
        "/text-preview",
    });
    expect(removedPreview.statusCode, removedPreview.body).toBe(404);
  });
});
