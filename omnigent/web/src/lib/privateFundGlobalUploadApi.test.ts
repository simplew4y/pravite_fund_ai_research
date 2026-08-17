import { afterEach, describe, expect, it, vi } from "vitest";

import { authenticatedFetch } from "./identity";
import {
  getPrivateFundGlobalUploadBatch,
  listPrivateFundGlobalUploadBatches,
  routePrivateFundGlobalUploadItem,
  uploadPrivateFundFilesGlobally,
} from "./privateFundApi";

vi.mock("./identity", () => ({ authenticatedFetch: vi.fn() }));

const BATCH_ID = `upb_${"a".repeat(32)}`;
const ITEM_ID = `upi_${"b".repeat(32)}`;
const TENANT_NAMESPACE = "11111111-1111-4111-8111-111111111111";
const CREATED_AT = "2026-08-17T00:00:00.000Z";

const BATCH_SUMMARY = {
  batchId: BATCH_ID,
  tenantNamespace: TENANT_NAMESPACE,
  status: "needs_review",
  fileCount: 1,
  message: "Review required",
  idempotencyKey: "server-only-batch-key",
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  finishedAt: null,
};

const BATCH_DETAIL = {
  ...BATCH_SUMMARY,
  counts: { needs_review: 1 },
  items: [
    {
      itemId: ITEM_ID,
      batchId: BATCH_ID,
      tenantNamespace: TENANT_NAMESPACE,
      originalFilename: "annual.pdf",
      stagedRelativePath: "objects/aa/server-only.pdf",
      fileType: "pdf",
      mimeType: "application/pdf",
      fileSize: 10,
      sha256: "c".repeat(64),
      status: "needs_review",
      companyName: "阳光电源股份有限公司",
      ticker: "300274.SZ",
      companyConfidence: 0.96,
      companyDetectionMethod: "document_identity",
      targetProjectId: "sungrow",
      routeConfidence: 0.94,
      routeMethod: "company_identity",
      candidateProjects: [
        {
          projectId: "sungrow",
          projectName: "阳光电源",
          companyName: "阳光电源股份有限公司",
          ticker: "300274.SZ",
          score: 0.94,
          method: "company_identity",
        },
      ],
      pipelineJobId: null,
      documentId: "doc-1",
      errorMessage: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      finishedAt: null,
    },
  ],
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.resetAllMocks());

describe("private-fund global upload requests", () => {
  it("uploads through the canonical endpoint with a multipart idempotency key", async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(response({ batch: BATCH_DETAIL }, 202));
    const file = new File(["pdf"], "annual.pdf", { type: "application/pdf" });

    const batch = await uploadPrivateFundFilesGlobally([file]);

    const [url, init] = vi.mocked(authenticatedFetch).mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(url).toBe("/v1/uploads");
    expect(init?.method).toBe("POST");
    const form = init?.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) throw new Error("Expected multipart form data");
    expect(form.getAll("files")).toEqual([file]);
    expect(headers.get("Idempotency-Key")).toMatch(/^private-fund-web:global-upload:/);
    expect(headers.has("Content-Type")).toBe(false);
    expect(batch.items[0]).toMatchObject({
      fileName: "annual.pdf",
      checksum: "c".repeat(64),
      companyName: "阳光电源股份有限公司",
      matchedDatasetId: "sungrow",
      matchedProjectName: "阳光电源",
      candidateProjects: [{ datasetId: "sungrow", projectName: "阳光电源" }],
    });
    expect(batch).not.toHaveProperty("tenantNamespace");
    expect(batch).not.toHaveProperty("idempotencyKey");
    expect(batch.items[0]).not.toHaveProperty("tenantNamespace");
    expect(batch.items[0]).not.toHaveProperty("stagedRelativePath");
    expect(batch.items[0]).not.toHaveProperty("documentId");
    expect(batch.items[0]).not.toHaveProperty("mimeType");
  });

  it("hydrates canonical batch summaries so restored history contains its items", async () => {
    vi.mocked(authenticatedFetch)
      .mockResolvedValueOnce(
        response({
          items: [BATCH_SUMMARY],
          total: 1,
          limit: 5,
          offset: 0,
          hasMore: false,
        }),
      )
      .mockResolvedValueOnce(response({ batch: BATCH_DETAIL }))
      .mockResolvedValueOnce(response({ batch: BATCH_DETAIL }));

    const batches = await listPrivateFundGlobalUploadBatches(5);
    const batch = await getPrivateFundGlobalUploadBatch(BATCH_ID);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.items).toHaveLength(1);
    expect(batch.items[0]?.itemId).toBe(ITEM_ID);
    expect(authenticatedFetch).toHaveBeenNthCalledWith(1, "/v1/uploads/batches?limit=5&offset=0");
    expect(authenticatedFetch).toHaveBeenNthCalledWith(2, `/v1/uploads/batches/${BATCH_ID}`);
    expect(authenticatedFetch).toHaveBeenNthCalledWith(3, `/v1/uploads/batches/${BATCH_ID}`);
  });

  it("routes through the canonical endpoint with a deterministic retry key", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(async () => response({ batch: BATCH_DETAIL }));

    await routePrivateFundGlobalUploadItem(ITEM_ID, "sungrow");
    await routePrivateFundGlobalUploadItem(ITEM_ID, "sungrow");

    const expectedBody = {
      projectId: "sungrow",
      idempotencyKey: `private-fund-web:global-route:${ITEM_ID}:sungrow`,
    };
    for (const [url, init] of vi.mocked(authenticatedFetch).mock.calls) {
      expect(url).toBe(`/v1/uploads/items/${ITEM_ID}/route`);
      expect(init).toEqual(
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(expectedBody),
        }),
      );
    }
  });
});
