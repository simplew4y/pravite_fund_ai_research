import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { SessionEvent } from "@private-fund/contracts";

import type { ApiConfig } from "./config.js";
import { createApiRuntime, type ApiRuntime } from "./main.js";

const WORKER_ENTRY = "unused-agent-worker-entry";

async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 2_000;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    value = await read();
  }
  return value;
}

function multipartFile(
  filename: string,
  mediaType: string,
  contents: Buffer,
  fieldName = "files",
): { boundary: string; payload: Buffer } {
  const boundary = "----private-fund-upload-test";
  return {
    boundary,
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
          `Content-Type: ${mediaType}\r\n\r\n`,
      ),
      contents,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

import { startFakeChatServer } from "../test/fixtures/fake-chat-server.mjs";

let fakeChat: Awaited<ReturnType<typeof startFakeChatServer>> | undefined;

function fakeModelEndpoint(): { baseUrl: string; apiKey: string; model: string } {
  if (fakeChat === undefined) throw new Error("fake chat server not started");
  return { baseUrl: fakeChat.url, apiKey: "test-model-key", model: "fake-model" };
}

beforeAll(async () => {
  fakeChat = await startFakeChatServer();
});

afterAll(async () => {
  await fakeChat?.close();
  fakeChat = undefined;
});

describe("TypeScript control-plane runtime", () => {
  let runtime: ApiRuntime | undefined;
  let dataRoot: string | undefined;

  afterEach(async () => {
    await runtime?.close();
    if (dataRoot !== undefined) {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("runs project -> session -> Pi IPC -> durable replay end to end", async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-api-runtime-"));
    const config: ApiConfig = {
      host: "127.0.0.1",
      port: 6768,
      dataRoot,
      controlDatabase: path.join(dataRoot, "control.sqlite3"),
      auth: {
        mode: "development",
        userId: "integration-user",
        dataNamespace: "00000000-0000-4000-8000-000000000099",
      },
      agentWorkerEntry: WORKER_ENTRY,
    agentModel: fakeModelEndpoint(),
    };
    runtime = await createApiRuntime(config);

    const projectResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Integration project" },
    });
    expect(projectResponse.statusCode).toBe(201);
    const project = projectResponse.json<{ id: string }>();

    const sessionResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { projectId: project.id, title: "Integration session" },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const session = sessionResponse.json<{ id: string }>();

    const promptResponse = await runtime.app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/messages`,
      payload: {
        content: "Run the integration prompt",
        clientMessageId: "integration-message-1",
      },
    });
    expect(promptResponse.statusCode).toBe(202);
    const operation = promptResponse.json<{ operationId: string }>();

    const replay = await eventually(
      async () => {
        const response = await runtime?.app.inject({
          method: "GET",
          url: `/v1/sessions/${session.id}/events?stream=0`,
        });
        return response?.json<{ events: SessionEvent[] }>().events ?? [];
      },
      (events) =>
        events.some((event) => event.type === "operation.completed"),
    );
    expect(replay.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "message.user",
        "message.assistant.delta",
        "operation.completed",
      ]),
    );

    const operationResponse = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/sessions/${session.id}/operations/` +
        operation.operationId,
    });
    expect(operationResponse.statusCode).toBe(200);
    expect(operationResponse.json()).toMatchObject({
      id: operation.operationId,
      status: "completed",
    });
  });

  it("streams an immutable upload, registers its version and queues ingest", async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-api-upload-"));
    const tenantNamespace = "00000000-0000-4000-8000-000000000098";
    const config: ApiConfig = {
      host: "127.0.0.1",
      port: 6768,
      dataRoot,
      controlDatabase: path.join(dataRoot, "control.sqlite3"),
      auth: {
        mode: "development",
        userId: "upload-user",
        dataNamespace: tenantNamespace,
      },
      agentWorkerEntry: WORKER_ENTRY,
    agentModel: fakeModelEndpoint(),
    };
    runtime = await createApiRuntime(config);

    const projectResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Upload project" },
    });
    const project = projectResponse.json<{ id: string }>();
    const source = Buffer.from("%PDF-1.7\nimmutable-test-source\n");
    const multipart = multipartFile(
      "投资备忘录.pdf",
      "application/pdf",
      source,
    );
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
        created: boolean;
        document: { id: string };
        version: {
          id: string;
          storedPath: string;
          mimeType: string | null;
        };
        job: { id: string; status: string; payload: Record<string, unknown> };
      }>;
    }>().uploads[0]!;
    expect(uploaded.created).toBe(true);
    expect(uploaded.job.status).toBe("queued");
    expect(uploaded.job.payload.documentVersionId).toBe(uploaded.version.id);
    await expect(readFile(uploaded.version.storedPath)).resolves.toEqual(source);

    const documentsResponse = await runtime.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/documents`,
    });
    expect(documentsResponse.statusCode).toBe(200);
    expect(documentsResponse.json()).toMatchObject({
      total: 1,
      items: [{ sourceRelpath: "投资备忘录.pdf" }],
    });

    const createFolder = await runtime.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/source-folders`,
      payload: {
        name: "核心财报",
        folderKind: "manual",
        classificationKey: "core.financials",
      },
    });
    expect(createFolder.statusCode, createFolder.body).toBe(201);
    const folderId = createFolder.json<{
      folders: Array<{ id: string }>;
    }>().folders[0]!.id;

    const assignFolder = await runtime.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/source-folders/${folderId}/documents`,
      payload: {
        documentId: uploaded.document.id,
        assignmentSource: "manual",
      },
    });
    expect(assignFolder.statusCode, assignFolder.body).toBe(201);
    expect(assignFolder.json()).toMatchObject({
      folders: [{ id: folderId, documentCount: 1 }],
      assignments: [
        {
          documentId: uploaded.document.id,
          folderId,
          assignmentSource: "manual",
        },
      ],
    });

    const removeNonEmpty = await runtime.app.inject({
      method: "DELETE",
      url: `/v1/projects/${project.id}/source-folders/${folderId}`,
    });
    expect(removeNonEmpty.statusCode).toBe(409);
    expect(removeNonEmpty.json()).toMatchObject({
      error: "source_folder_not_empty",
    });

    const unassignFolder = await runtime.app.inject({
      method: "DELETE",
      url:
        `/v1/projects/${project.id}/source-folders/${folderId}/documents/` +
        uploaded.document.id,
    });
    expect(unassignFolder.statusCode, unassignFolder.body).toBe(200);
    expect(unassignFolder.json()).toMatchObject({ assignments: [] });

    const removeFolder = await runtime.app.inject({
      method: "DELETE",
      url: `/v1/projects/${project.id}/source-folders/${folderId}`,
    });
    expect(removeFolder.statusCode, removeFolder.body).toBe(200);
    expect(removeFolder.json()).toMatchObject({
      folders: [],
      assignments: [],
    });

    const preview = await runtime.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/documents/${uploaded.document.id}/preview?versionId=${uploaded.version.id}`,
      headers: { range: "bytes=5-11" },
    });
    expect(preview.statusCode, preview.body).toBe(206);
    expect(preview.rawPayload).toEqual(source.subarray(5, 12));
    expect(preview.headers).toMatchObject({
      "accept-ranges": "bytes",
      "content-length": "7",
      "content-range": `bytes 5-11/${String(source.byteLength)}`,
      "content-type": "application/pdf",
      "x-content-type-options": "nosniff",
    });
    expect(preview.headers["content-disposition"]).toContain("inline");

    const unsatisfiable = await runtime.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/documents/${uploaded.document.id}/download`,
      headers: { range: `bytes=${String(source.byteLength)}-` },
    });
    expect(unsatisfiable.statusCode).toBe(416);
    expect(unsatisfiable.headers["content-range"]).toBe(
      `bytes */${String(source.byteLength)}`,
    );

    const download = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/documents/${uploaded.document.id}` +
        `/download?versionId=${uploaded.version.id}`,
    });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.rawPayload).toEqual(source);
    expect(download.headers).toMatchObject({
      "accept-ranges": "bytes",
      "content-length": String(source.byteLength),
      "content-type": "application/pdf",
      "x-content-type-options": "nosniff",
    });
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.headers["content-disposition"]).toContain(
      encodeURIComponent("投资备忘录.pdf"),
    );

    const duplicateResponse = await runtime.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/documents/upload`,
      headers: {
        "content-type": `multipart/form-data; boundary=${multipart.boundary}`,
      },
      payload: multipart.payload,
    });
    expect(duplicateResponse.statusCode).toBe(202);
    expect(
      duplicateResponse.json<{
        uploads: Array<{ created: boolean; job: { id: string } }>;
      }>().uploads[0],
    ).toMatchObject({
      created: false,
      job: { id: uploaded.job.id },
    });

    const genericUploads = [
      {
        filename: "brief.docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      {
        filename: "deck.pptx",
        mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      },
      { filename: "data.csv", mime: "text/csv" },
      { filename: "notes.md", mime: "text/plain" },
      { filename: "appendix.markdown", mime: "text/markdown" },
      { filename: "readme.txt", mime: "application/octet-stream" },
    ] as const;
    for (const generic of genericUploads) {
      const body = multipartFile(
        generic.filename,
        generic.mime,
        Buffer.from(`fixture:${generic.filename}`, "utf8"),
      );
      const response = await runtime.app.inject({
        method: "POST",
        url: `/v1/projects/${project.id}/documents/upload`,
        headers: {
          "content-type": `multipart/form-data; boundary=${body.boundary}`,
        },
        payload: body.payload,
      });
      expect(response.statusCode, response.body).toBe(202);
      const entry = response.json<{
        uploads: Array<{
          version: { mimeType: string; storedPath: string };
          job: { type: string; payload: Record<string, unknown> };
        }>;
      }>().uploads[0]!;
      expect(entry.job.type).toBe("document.ingest");
      expect(entry.job.payload.inputPath).toEqual(
        expect.stringMatching(
          new RegExp(
            `${path.extname(generic.filename).replace(".", "\\.")}$`,
            "u",
          ),
        ),
      );
      expect(entry.version.mimeType).not.toBe("application/octet-stream");
    }

    const mismatched = multipartFile(
      "wrong.docx",
      "application/pdf",
      Buffer.from("not a docx"),
    );
    const mismatchResponse = await runtime.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/documents/upload`,
      headers: {
        "content-type": `multipart/form-data; boundary=${mismatched.boundary}`,
      },
      payload: mismatched.payload,
    });
    expect(mismatchResponse.statusCode).toBe(415);
    expect(mismatchResponse.json()).toMatchObject({
      error: "document_mime_mismatch",
    });
  });

  it("routes tenant-wide uploads through durable canonical batches", async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-api-global-upload-"));
    const config: ApiConfig = {
      host: "127.0.0.1",
      port: 6768,
      dataRoot,
      controlDatabase: path.join(dataRoot, "control.sqlite3"),
      auth: {
        mode: "development",
        userId: "global-upload-user",
        dataNamespace: "00000000-0000-4000-8000-000000000096",
      },
      agentWorkerEntry: WORKER_ENTRY,
    agentModel: fakeModelEndpoint(),
    };
    runtime = await createApiRuntime(config);

    const projectResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: {
        name: "Tesla research",
        companyName: "Tesla",
        ticker: "TSLA",
      },
    });
    expect(projectResponse.statusCode, projectResponse.body).toBe(201);
    const project = projectResponse.json<{ id: string }>();

    const automaticMultipart = multipartFile(
      "TSLA-quarterly-notes.md",
      "text/markdown",
      Buffer.from("# Tesla\nCanonical global upload."),
    );
    const automaticResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: {
        "content-type":
          `multipart/form-data; boundary=${automaticMultipart.boundary}`,
        "idempotency-key": "global-auto-1",
      },
      payload: automaticMultipart.payload,
    });
    expect(automaticResponse.statusCode, automaticResponse.body).toBe(202);
    const automatic = automaticResponse.json<{
      batch: {
        batchId: string;
        status: string;
        items: Array<{
          itemId: string;
          targetProjectId: string | null;
          pipelineJobId: string | null;
          documentId: string | null;
          status: string;
        }>;
      };
    }>().batch;
    expect(automatic).toMatchObject({
      status: "indexing",
      items: [
        {
          targetProjectId: project.id,
          status: "indexing",
        },
      ],
    });
    expect(automatic.items[0]?.pipelineJobId).toMatch(/^job_/u);
    expect(automatic.items[0]?.documentId).toMatch(/^doc_/u);

    const replayResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: {
        "content-type":
          `multipart/form-data; boundary=${automaticMultipart.boundary}`,
        "idempotency-key": "global-auto-1",
      },
      payload: automaticMultipart.payload,
    });
    expect(replayResponse.statusCode, replayResponse.body).toBe(202);
    expect(
      replayResponse.json<{ batch: { batchId: string } }>().batch.batchId,
    ).toBe(automatic.batchId);

    const unmatchedMultipart = multipartFile(
      "unmatched-company-notes.txt",
      "text/plain",
      Buffer.from("Manual project routing."),
    );
    const reviewResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: {
        "content-type":
          `multipart/form-data; boundary=${unmatchedMultipart.boundary}`,
        "idempotency-key": "global-review-1",
      },
      payload: unmatchedMultipart.payload,
    });
    expect(reviewResponse.statusCode, reviewResponse.body).toBe(202);
    const review = reviewResponse.json<{
      batch: {
        batchId: string;
        status: string;
        items: Array<{ itemId: string; status: string }>;
      };
    }>().batch;
    expect(review).toMatchObject({
      status: "needs_review",
      items: [{ status: "needs_review" }],
    });

    const routeResponse = await runtime.app.inject({
      method: "POST",
      url: `/v1/uploads/items/${review.items[0]!.itemId}/route`,
      payload: {
        projectId: project.id,
        idempotencyKey: "global-manual-route-1",
      },
    });
    expect(routeResponse.statusCode, routeResponse.body).toBe(200);
    expect(routeResponse.json()).toMatchObject({
      batch: {
        batchId: review.batchId,
        status: "indexing",
        items: [
          {
            targetProjectId: project.id,
            routeMethod: "manual",
            status: "indexing",
          },
        ],
      },
    });

    const detailResponse = await runtime.app.inject({
      method: "GET",
      url: `/v1/uploads/batches/${automatic.batchId}`,
    });
    expect(detailResponse.statusCode, detailResponse.body).toBe(200);
    expect(detailResponse.json()).toMatchObject({
      batch: { batchId: automatic.batchId },
    });

    const batchesResponse = await runtime.app.inject({
      method: "GET",
      url: "/v1/uploads/batches?limit=20",
    });
    expect(batchesResponse.statusCode, batchesResponse.body).toBe(200);
    expect(batchesResponse.json()).toMatchObject({
      total: 2,
      items: expect.arrayContaining([
        expect.objectContaining({ batchId: automatic.batchId }),
        expect.objectContaining({ batchId: review.batchId }),
      ]),
    });

    const itemsResponse = await runtime.app.inject({
      method: "GET",
      url: `/v1/uploads/items?projectId=${project.id}`,
    });
    expect(itemsResponse.statusCode, itemsResponse.body).toBe(200);
    expect(itemsResponse.json()).toMatchObject({
      total: 2,
      items: [
        expect.objectContaining({ targetProjectId: project.id }),
        expect.objectContaining({ targetProjectId: project.id }),
      ],
    });

    const missingKeyResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: {
        "content-type":
          `multipart/form-data; boundary=${unmatchedMultipart.boundary}`,
      },
      payload: unmatchedMultipart.payload,
    });
    expect(missingKeyResponse.statusCode).toBe(400);
    expect(missingKeyResponse.json()).toMatchObject({
      error: "idempotency_key_required",
    });
  });

  it("persists session attachments and version-pinned research resources", async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-api-resources-"));
    const config: ApiConfig = {
      host: "127.0.0.1",
      port: 6768,
      dataRoot,
      controlDatabase: path.join(dataRoot, "control.sqlite3"),
      auth: {
        mode: "development",
        userId: "resource-user",
        dataNamespace: "00000000-0000-4000-8000-000000000095",
      },
      agentWorkerEntry: WORKER_ENTRY,
    agentModel: fakeModelEndpoint(),
    };
    runtime = await createApiRuntime(config);

    const projectResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Session resource project" },
    });
    const project = projectResponse.json<{ id: string }>();
    const sessionResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { projectId: project.id, title: "Resource session" },
    });
    const session = sessionResponse.json<{ id: string }>();

    const attachmentContents = Buffer.from(
      "# Session note\nEvidence for the active conversation.\n",
    );
    const attachmentMultipart = multipartFile(
      "session-note.md",
      "text/markdown",
      attachmentContents,
      "file",
    );
    const attachmentResponse = await runtime.app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/attachments`,
      headers: {
        "content-type":
          `multipart/form-data; boundary=${attachmentMultipart.boundary}`,
      },
      payload: attachmentMultipart.payload,
    });
    expect(attachmentResponse.statusCode, attachmentResponse.body).toBe(201);
    const attachment = attachmentResponse.json<{
      id: string;
      kind: string;
      attachment: {
        filename: string;
        mimeType: string;
        bytes: number;
      };
    }>();
    expect(attachment).toMatchObject({
      kind: "attachment",
      attachment: {
        filename: "session-note.md",
        mimeType: "text/markdown",
        bytes: attachmentContents.byteLength,
      },
    });

    const contentResponse = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/sessions/${session.id}/attachments/${attachment.id}` +
        "/content",
      headers: { range: "bytes=2-12" },
    });
    expect(contentResponse.statusCode, contentResponse.body).toBe(206);
    expect(contentResponse.rawPayload).toEqual(
      attachmentContents.subarray(2, 13),
    );
    expect(contentResponse.headers["content-type"]).toBe("text/markdown");

    const documentMultipart = multipartFile(
      "session-source.pdf",
      "application/pdf",
      Buffer.from("%PDF-1.7\nSession source."),
    );
    const documentResponse = await runtime.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/documents/upload`,
      headers: {
        "content-type":
          `multipart/form-data; boundary=${documentMultipart.boundary}`,
      },
      payload: documentMultipart.payload,
    });
    const document = documentResponse.json<{
      uploads: Array<{
        document: { id: string };
        version: { id: string };
      }>;
    }>().uploads[0]!;
    const documentResourceResponse = await runtime.app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/resources/document-references`,
      payload: {
        documentId: document.document.id,
        versionId: document.version.id,
      },
    });
    expect(
      documentResourceResponse.statusCode,
      documentResourceResponse.body,
    ).toBe(201);
    expect(documentResourceResponse.json()).toMatchObject({
      kind: "document_reference",
      documentReference: {
        documentId: document.document.id,
        versionId: document.version.id,
      },
    });

    const assetResponse = await runtime.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/assets`,
      payload: {
        assetType: "note",
        title: "Pinned research note",
        contentMarkdown: "A version-pinned research resource.",
      },
    });
    expect(assetResponse.statusCode, assetResponse.body).toBe(201);
    const asset = assetResponse.json<{
      asset: { id: string };
      version: { id: string };
    }>();
    const assetResourceResponse = await runtime.app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/resources/research-assets`,
      payload: {
        assetId: asset.asset.id,
        versionId: asset.version.id,
      },
    });
    expect(
      assetResourceResponse.statusCode,
      assetResourceResponse.body,
    ).toBe(201);
    expect(assetResourceResponse.json()).toMatchObject({
      kind: "research_asset",
      researchAsset: {
        assetId: asset.asset.id,
        versionId: asset.version.id,
      },
    });

    const resourcesResponse = await runtime.app.inject({
      method: "GET",
      url: `/v1/sessions/${session.id}/resources?limit=20`,
    });
    expect(resourcesResponse.statusCode, resourcesResponse.body).toBe(200);
    expect(resourcesResponse.json()).toMatchObject({
      total: 3,
      items: expect.arrayContaining([
        expect.objectContaining({ id: attachment.id, kind: "attachment" }),
        expect.objectContaining({ kind: "document_reference" }),
        expect.objectContaining({ kind: "research_asset" }),
      ]),
    });

    const deleteAttachmentResponse = await runtime.app.inject({
      method: "DELETE",
      url: `/v1/sessions/${session.id}/attachments/${attachment.id}`,
    });
    expect(
      deleteAttachmentResponse.statusCode,
      deleteAttachmentResponse.body,
    ).toBe(200);
    expect(deleteAttachmentResponse.json()).toMatchObject({
      id: attachment.id,
      kind: "attachment",
      deleted: true,
    });

    const deletedContentResponse = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/sessions/${session.id}/attachments/${attachment.id}` +
        "/content",
    });
    expect(deletedContentResponse.statusCode).toBe(404);

    const cleanupResponse = await runtime.app.inject({
      method: "DELETE",
      url: `/v1/sessions/${session.id}/resources`,
    });
    expect(cleanupResponse.statusCode, cleanupResponse.body).toBe(200);
    expect(cleanupResponse.json()).toMatchObject({
      sessionId: session.id,
      cleaned: true,
      deletedCount: 2,
    });
  });

  it("runs the canonical research workflow state machine through HTTP", async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-api-workflow-"));
    const config: ApiConfig = {
      host: "127.0.0.1",
      port: 6768,
      dataRoot,
      controlDatabase: path.join(dataRoot, "control.sqlite3"),
      auth: {
        mode: "development",
        userId: "workflow-http-user",
        dataNamespace: "00000000-0000-4000-8000-000000000097",
      },
      agentWorkerEntry: WORKER_ENTRY,
    agentModel: fakeModelEndpoint(),
    };
    runtime = await createApiRuntime(config);
    const projectResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "HTTP workflow" },
    });
    const project = projectResponse.json<{ id: string }>();

    const initialResponse = await runtime.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/workflow`,
    });
    expect(initialResponse.statusCode).toBe(200);
    expect(
      initialResponse.json<{ nodes: unknown[] }>().nodes,
    ).toHaveLength(9);

    const startResponse = await runtime.app.inject({
      method: "POST",
      url:
        `/v1/projects/${project.id}/workflow/nodes/` +
        "source-review/start",
      payload: { idempotencyKey: "http-source-run-1" },
    });
    expect(startResponse.statusCode).toBe(200);
    const nodeVersionId = startResponse.json<{
      nodeVersion: { nodeVersionId: string };
    }>().nodeVersion.nodeVersionId;

    const completeResponse = await runtime.app.inject({
      method: "POST",
      url:
        `/v1/projects/${project.id}/workflow/nodes/` +
        "source-review/complete",
      payload: {
        nodeVersionId,
        outputMarkdown: "Source inventory completed.",
        evidenceIds: [],
      },
    });
    expect(completeResponse.statusCode).toBe(200);
    expect(
      completeResponse
        .json<{ workflow: { nodes: Array<{ nodeId: string; status: string }> } }>()
        .workflow.nodes.find((node) => node.nodeId === "business-analysis"),
    ).toMatchObject({ status: "ready" });

    const reportResponse = await runtime.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/workflow/reports`,
      payload: {
        idempotencyKey: "http-report-1",
        title: "HTTP 投资研究报告",
      },
    });
    expect(reportResponse.statusCode).toBe(201);
    expect(reportResponse.json()).toMatchObject({
      report: { currentVersionNo: 1 },
      version: { versionNo: 1 },
    });
  });
});
