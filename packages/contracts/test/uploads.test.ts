import { describe, expect, it } from "vitest";

import {
  GLOBAL_UPLOAD_BATCH_LIMIT_BYTES,
  GLOBAL_UPLOAD_FILE_LIMIT_BYTES,
  createGlobalUploadBatchRequestSchema,
  globalUploadBatchIdSchema,
  globalUploadItemIdSchema,
  globalUploadStagedRelativePathSchema,
  listGlobalUploadAuditQuerySchema,
  listGlobalUploadItemsQuerySchema,
  routeGlobalUploadItemRequestSchema,
  transitionGlobalUploadItemRequestSchema,
} from "../src/index.js";

describe("global upload contracts", () => {
  it("accepts bounded server-relative staged metadata and normalizes hashes", () => {
    const request = createGlobalUploadBatchRequestSchema.parse({
      idempotencyKey: "upload-request-1",
      items: [
        {
          originalFilename: "annual report.pdf",
          stagedRelativePath: "inbox/token-a/source.pdf",
          fileType: "PDF",
          mimeType: "application/pdf",
          fileSize: 42,
          sha256: "A".repeat(64),
        },
      ],
    });

    expect(request.items[0]).toMatchObject({
      fileType: "pdf",
      sha256: "a".repeat(64),
      stagedRelativePath: "inbox/token-a/source.pdf",
    });
  });

  it("rejects absolute, client-drive, traversal and duplicate staged paths", () => {
    for (const unsafe of [
      "/tmp/source.pdf",
      "C:/Users/alice/source.pdf",
      "../source.pdf",
      "inbox/../source.pdf",
      "inbox\\source.pdf",
    ]) {
      expect(() =>
        globalUploadStagedRelativePathSchema.parse(unsafe),
      ).toThrow();
    }
    expect(() =>
      createGlobalUploadBatchRequestSchema.parse({
        idempotencyKey: "duplicate-path",
        items: [
          {
            originalFilename: "a.pdf",
            stagedRelativePath: "inbox/shared.pdf",
            fileType: "pdf",
            mimeType: "application/pdf",
            fileSize: 1,
            sha256: "a".repeat(64),
          },
          {
            originalFilename: "b.pdf",
            stagedRelativePath: "inbox/shared.pdf",
            fileType: "pdf",
            mimeType: "application/pdf",
            fileSize: 1,
            sha256: "b".repeat(64),
          },
        ],
      }),
    ).toThrow(/unique/u);
  });

  it("uses opaque IDs and bounded paginated route/list requests", () => {
    expect(
      globalUploadBatchIdSchema.parse(
        "upb_0123456789abcdef0123456789abcdef",
      ),
    ).toContain("upb_");
    expect(
      globalUploadItemIdSchema.parse(
        "upi_0123456789abcdef0123456789abcdef",
      ),
    ).toContain("upi_");
    expect(() => globalUploadBatchIdSchema.parse("batch-1")).toThrow();
    expect(
      listGlobalUploadItemsQuerySchema.parse({
        status: "needs_review",
        limit: "25",
        offset: "50",
      }),
    ).toMatchObject({ limit: 25, offset: 50 });
    expect(
      routeGlobalUploadItemRequestSchema.parse({
        projectId: "project-a",
        idempotencyKey: "manual-route-1",
      }),
    ).toMatchObject({ projectId: "project-a" });
    expect(
      listGlobalUploadAuditQuerySchema.parse({
        batchId: "upb_0123456789abcdef0123456789abcdef",
        limit: "10",
        offset: "20",
      }),
    ).toMatchObject({ limit: 10, offset: 20 });
  });

  it("enforces per-file and per-batch byte limits plus safe MIME metadata", () => {
    const base = {
      originalFilename: "source.pdf",
      stagedRelativePath: "inbox/source.pdf",
      fileType: "pdf",
      mimeType: "application/pdf",
      sha256: "a".repeat(64),
    };
    expect(() =>
      createGlobalUploadBatchRequestSchema.parse({
        idempotencyKey: "oversized-file",
        items: [
          {
            ...base,
            fileSize: GLOBAL_UPLOAD_FILE_LIMIT_BYTES + 1,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      createGlobalUploadBatchRequestSchema.parse({
        idempotencyKey: "oversized-batch",
        items: Array.from({ length: 5 }, (_, index) => ({
          ...base,
          originalFilename: `${String(index)}.pdf`,
          stagedRelativePath: `inbox/${String(index)}.pdf`,
          fileSize: GLOBAL_UPLOAD_FILE_LIMIT_BYTES,
        })),
      }),
    ).toThrow(
      `Upload batch exceeds the ${String(
        GLOBAL_UPLOAD_BATCH_LIMIT_BYTES / (1024 * 1024 * 1024),
      )} GiB limit`,
    );
    expect(() =>
      createGlobalUploadBatchRequestSchema.parse({
        idempotencyKey: "unsafe-mime",
        items: [
          {
            ...base,
            mimeType: "application/pdf\nX-Injected: true",
            fileSize: 1,
          },
        ],
      }),
    ).toThrow();
  });

  it("requires a durable error reason whenever an item enters failed", () => {
    expect(() =>
      transitionGlobalUploadItemRequestSchema.parse({
        status: "failed",
        idempotencyKey: "failure-1",
      }),
    ).toThrow(/errorMessage/u);
    expect(
      transitionGlobalUploadItemRequestSchema.parse({
        status: "failed",
        idempotencyKey: "failure-2",
        errorMessage: "classifier timed out",
      }),
    ).toMatchObject({
      status: "failed",
      errorMessage: "classifier timed out",
    });
  });
});
