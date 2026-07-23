import { afterEach, describe, expect, it, vi } from "vitest";

import { authenticatedFetch } from "./identity";
import {
  getPrivateFundGlobalUploadBatch,
  listPrivateFundGlobalUploadBatches,
  routePrivateFundGlobalUploadItem,
  uploadPrivateFundFilesGlobally,
} from "./privateFundApi";

vi.mock("./identity", () => ({ authenticatedFetch: vi.fn() }));

const BATCH_WIRE = {
  batch_id: "upload-1",
  status: "needs_review",
  file_count: 1,
  counts: { needs_review: 1 },
  items: [
    {
      item_id: "file-1",
      batch_id: "upload-1",
      file_name: "annual.pdf",
      file_type: "pdf",
      size: 10,
      checksum: "abc",
      status: "needs_review",
      company_name: "阳光电源股份有限公司",
      company_ticker: "300274.SZ",
      company_confidence: 0.96,
      candidate_projects: [
        {
          dataset_id: "sungrow",
          project_name: "阳光电源",
          score: 0.94,
          method: "company_identity",
        },
      ],
    },
  ],
};

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.clearAllMocks());

describe("private-fund global upload requests", () => {
  it("uploads without a dataset id and maps per-file routing candidates", async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(response({ batch: BATCH_WIRE }));
    const file = new File(["pdf"], "annual.pdf", { type: "application/pdf" });

    const batch = await uploadPrivateFundFilesGlobally([file]);

    const [url, init] = vi.mocked(authenticatedFetch).mock.calls[0];
    expect(url).toBe("/v1/private-fund/uploads");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    expect(batch.items[0]).toMatchObject({
      fileName: "annual.pdf",
      companyName: "阳光电源股份有限公司",
      candidateProjects: [{ datasetId: "sungrow", projectName: "阳光电源" }],
    });
  });

  it("loads recent batches and routes a review item to the chosen project", async () => {
    vi.mocked(authenticatedFetch)
      .mockResolvedValueOnce(response({ batches: [BATCH_WIRE] }))
      .mockResolvedValueOnce(response({ batch: BATCH_WIRE }))
      .mockResolvedValueOnce(response({ batch: BATCH_WIRE }));

    await listPrivateFundGlobalUploadBatches(5);
    await getPrivateFundGlobalUploadBatch("upload-1");
    await routePrivateFundGlobalUploadItem("file-1", "sungrow");

    expect(authenticatedFetch).toHaveBeenNthCalledWith(
      1,
      "/v1/private-fund/upload-batches?limit=5",
    );
    expect(authenticatedFetch).toHaveBeenNthCalledWith(
      2,
      "/v1/private-fund/upload-batches/upload-1",
    );
    expect(authenticatedFetch).toHaveBeenNthCalledWith(
      3,
      "/v1/private-fund/upload-items/file-1/route",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ dataset_id: "sungrow" }),
      }),
    );
  });
});
