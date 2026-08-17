import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "./config.js";
import { createApiRuntime, type ApiRuntime } from "./main.js";

const WORKER_ENTRY = fileURLToPath(
  new URL("../test/fixtures/fake-agent-worker.mjs", import.meta.url),
);

function multipartFile(
  filename: string,
  mediaType: string,
  contents: Buffer,
): { readonly boundary: string; readonly payload: Buffer } {
  const boundary = "----private-fund-asset-context-test";
  return {
    boundary,
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="files"; filename="${filename}"\r\n` +
          `Content-Type: ${mediaType}\r\n\r\n`,
      ),
      contents,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

describe("canonical unified asset context", () => {
  let runtime: ApiRuntime | undefined;
  let dataRoot: string | undefined;

  afterEach(async () => {
    await runtime?.close();
    if (dataRoot !== undefined) {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("validates project-local documents and assets and removes inactive selections", async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-asset-context-"));
    const config: ApiConfig = {
      host: "127.0.0.1",
      port: 6768,
      dataRoot,
      controlDatabase: path.join(dataRoot, "control.sqlite3"),
      auth: {
        mode: "development",
        userId: "asset-context-user",
        dataNamespace: "00000000-0000-4000-8000-000000000077",
      },
      agentWorkerEntry: WORKER_ENTRY,
    };
    runtime = await createApiRuntime(config);

    const firstProjectResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Context owner" },
    });
    expect(
      firstProjectResponse.statusCode,
      firstProjectResponse.body,
    ).toBe(201);
    const firstProject = firstProjectResponse.json<{ id: string }>();
    const secondProjectResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Other project" },
    });
    expect(
      secondProjectResponse.statusCode,
      secondProjectResponse.body,
    ).toBe(201);
    const secondProject = secondProjectResponse.json<{ id: string }>();

    const upload = multipartFile(
      "annual.pdf",
      "application/pdf",
      Buffer.from("%PDF-1.7\ncontext source\n"),
    );
    const uploadResponse = await runtime.app.inject({
      method: "POST",
      url: `/v1/projects/${firstProject.id}/documents/upload`,
      headers: {
        "content-type": `multipart/form-data; boundary=${upload.boundary}`,
      },
      payload: upload.payload,
    });
    expect(uploadResponse.statusCode, uploadResponse.body).toBe(202);
    const documentId = uploadResponse.json<{
      uploads: Array<{ document: { id: string } }>;
    }>().uploads[0]!.document.id;

    const assetResponse = await runtime.app.inject({
      method: "POST",
      url: `/v1/projects/${firstProject.id}/assets`,
      payload: {
        assetId: "node:investment-thesis",
        assetType: "analysis",
        title: "Investment thesis",
        status: "completed",
        summary: "Durable context",
        contentMarkdown: "# Investment thesis",
        structuredContent: {},
        metadata: {},
        tags: [],
        evidence: [],
      },
    });
    expect(assetResponse.statusCode, assetResponse.body).toBe(201);

    const orderedIds = [
      `document:${documentId}`,
      "node:investment-thesis",
    ];
    const replaceResponse = await runtime.app.inject({
      method: "PUT",
      url: `/v1/projects/${firstProject.id}/assets/context`,
      payload: { assetIds: orderedIds },
    });
    expect(replaceResponse.statusCode, replaceResponse.body).toBe(200);
    expect(replaceResponse.json()).toEqual({ assetIds: orderedIds });

    const getResponse = await runtime.app.inject({
      method: "GET",
      url: `/v1/projects/${firstProject.id}/assets/context`,
    });
    expect(getResponse.statusCode, getResponse.body).toBe(200);
    expect(getResponse.json()).toEqual({ assetIds: orderedIds });

    const duplicateResponse = await runtime.app.inject({
      method: "PUT",
      url: `/v1/projects/${firstProject.id}/assets/context`,
      payload: {
        assetIds: [
          "node:investment-thesis",
          "node:investment-thesis",
        ],
      },
    });
    expect(
      duplicateResponse.statusCode,
      duplicateResponse.body,
    ).toBe(400);
    expect(duplicateResponse.json()).toMatchObject({
      error: "invalid_request",
    });

    const unknownResponse = await runtime.app.inject({
      method: "PUT",
      url: `/v1/projects/${firstProject.id}/assets/context`,
      payload: { assetIds: ["node:unknown"] },
    });
    expect(unknownResponse.statusCode, unknownResponse.body).toBe(404);
    expect(unknownResponse.json()).toMatchObject({ error: "not_found" });

    const crossProjectResponse = await runtime.app.inject({
      method: "PUT",
      url: `/v1/projects/${secondProject.id}/assets/context`,
      payload: { assetIds: orderedIds },
    });
    expect(
      crossProjectResponse.statusCode,
      crossProjectResponse.body,
    ).toBe(404);
    expect(crossProjectResponse.json()).toMatchObject({
      error: "not_found",
    });

    const removeDocumentResponse = await runtime.app.inject({
      method: "DELETE",
      url: `/v1/projects/${firstProject.id}/documents/${documentId}`,
    });
    expect(
      removeDocumentResponse.statusCode,
      removeDocumentResponse.body,
    ).toBe(200);
    const afterDocumentRemoval = await runtime.app.inject({
      method: "GET",
      url: `/v1/projects/${firstProject.id}/assets/context`,
    });
    expect(afterDocumentRemoval.json()).toEqual({
      assetIds: ["node:investment-thesis"],
    });

    const archiveAssetResponse = await runtime.app.inject({
      method: "PATCH",
      url:
        `/v1/projects/${firstProject.id}/assets/` +
        "node:investment-thesis",
      payload: { archived: true },
    });
    expect(
      archiveAssetResponse.statusCode,
      archiveAssetResponse.body,
    ).toBe(200);
    const afterAssetArchive = await runtime.app.inject({
      method: "GET",
      url: `/v1/projects/${firstProject.id}/assets/context`,
    });
    expect(afterAssetArchive.json()).toEqual({ assetIds: [] });

    const inactiveResponse = await runtime.app.inject({
      method: "PUT",
      url: `/v1/projects/${firstProject.id}/assets/context`,
      payload: { assetIds: orderedIds },
    });
    expect(inactiveResponse.statusCode, inactiveResponse.body).toBe(409);
    expect(inactiveResponse.json()).toMatchObject({
      error: "asset_context_conflict",
    });
  });
});
