import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getPrivateFundGlobalUploadBatch,
  listPrivateFundGlobalUploadBatches,
  routePrivateFundGlobalUploadItem,
  uploadPrivateFundFilesGlobally,
} from "@/lib/privateFundApi";
import { PrivateFundGlobalUploadDialog } from "./PrivateFundGlobalUploadDialog";
import { usePrivateFundGlobalUpload } from "./usePrivateFundGlobalUpload";

vi.mock("@/lib/privateFundApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privateFundApi")>();
  return {
    ...actual,
    getPrivateFundGlobalUploadBatch: vi.fn(),
    listPrivateFundGlobalUploadBatches: vi.fn(),
    routePrivateFundGlobalUploadItem: vi.fn(),
    uploadPrivateFundFilesGlobally: vi.fn(),
  };
});

const REVIEW_BATCH = {
  batchId: "upload-1",
  status: "needs_review",
  fileCount: 1,
  message: "",
  counts: { needs_review: 1 },
  items: [
    {
      itemId: "file-1",
      batchId: "upload-1",
      fileName: "2025年度报告.pdf",
      fileType: "pdf",
      size: 100,
      checksum: "abc",
      status: "needs_review",
      companyName: "阳光电源股份有限公司",
      companyTicker: "300274.SZ",
      companyConfidence: 0.96,
      companyDetectionMethod: "content_entity",
      matchedDatasetId: null,
      matchedProjectName: "",
      projectMatchConfidence: 0.94,
      projectMatchMethod: "company_identity",
      candidateProjects: [
        {
          datasetId: "sungrow",
          projectName: "阳光电源",
          companyName: "阳光电源股份有限公司",
          companyTicker: "300274.SZ",
          score: 0.94,
          method: "company_identity",
        },
      ],
      pipelineJobId: null,
      errorMessage: "No unique high-confidence project match was found.",
    },
  ],
};

const ACTIVE_BATCH = {
  ...REVIEW_BATCH,
  status: "identifying",
  counts: { identifying: 1 },
  items: [{ ...REVIEW_BATCH.items[0], status: "identifying", errorMessage: null }],
};

const COMPLETED_BATCH = {
  ...REVIEW_BATCH,
  status: "completed",
  counts: { completed: 1 },
  items: [
    {
      ...REVIEW_BATCH.items[0],
      status: "completed",
      matchedDatasetId: "sungrow",
      matchedProjectName: "阳光电源",
      errorMessage: null,
    },
  ],
};

function Fixture() {
  const upload = usePrivateFundGlobalUpload();
  return (
    <>
      <button type="button" onClick={upload.openDialog}>
        打开统一上传
      </button>
      <PrivateFundGlobalUploadDialog
        open={upload.open}
        batch={upload.batch}
        message={upload.message}
        projects={[
          {
            datasetId: "sungrow",
            name: "阳光电源",
            status: "ready",
            companyTicker: "300274.SZ",
            fileCount: 0,
            uploadCount: 0,
            documentCount: 0,
            indexedDocumentCount: 0,
            failedDocumentCount: 0,
            chunkCount: 0,
            indexCount: 0,
            memoCount: 0,
            indexReady: true,
          },
        ]}
        uploading={upload.isUploading}
        processing={upload.isProcessing}
        routing={upload.isRouting}
        progressPercent={upload.progressPercent}
        progressLabel={upload.progressLabel}
        onOpenChange={upload.setOpen}
        onSelectFiles={upload.selectFiles}
        onRoute={upload.routeItem}
        onStartAnotherBatch={upload.startAnotherBatch}
      />
    </>
  );
}

function renderFixture() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Fixture />
    </QueryClientProvider>,
  );
}

describe("usePrivateFundGlobalUpload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listPrivateFundGlobalUploadBatches).mockResolvedValue([]);
    vi.mocked(uploadPrivateFundFilesGlobally).mockResolvedValue(REVIEW_BATCH);
    vi.mocked(routePrivateFundGlobalUploadItem).mockResolvedValue({
      ...REVIEW_BATCH,
      status: "completed",
      counts: { completed: 1 },
      items: [
        {
          ...REVIEW_BATCH.items[0],
          status: "completed",
          matchedDatasetId: "sungrow",
          matchedProjectName: "阳光电源",
        },
      ],
    });
  });

  it("uploads without a selected project and lets the user route an ambiguous file", async () => {
    renderFixture();
    fireEvent.click(screen.getByRole("button", { name: "打开统一上传" }));
    const pdf = new File(["pdf"], "2025年度报告.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("在统一入口选择资料文档"), {
      target: { files: [pdf] },
    });

    await waitFor(() => expect(uploadPrivateFundFilesGlobally).toHaveBeenCalledWith([pdf]));
    expect(await screen.findByText("需要确认项目")).toBeInTheDocument();
    expect(screen.getByText(/阳光电源股份有限公司/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认归类" }));

    await waitFor(() =>
      expect(routePrivateFundGlobalUploadItem).toHaveBeenCalledWith("file-1", "sungrow"),
    );
    expect(await screen.findByText("已完成索引")).toBeInTheDocument();
    expect(getPrivateFundGlobalUploadBatch).not.toHaveBeenCalled();
  });

  it("keeps processing after the dialog closes and shows live progress when reopened", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(uploadPrivateFundFilesGlobally).mockResolvedValue(ACTIVE_BATCH);
      vi.mocked(getPrivateFundGlobalUploadBatch).mockResolvedValue(COMPLETED_BATCH);
      renderFixture();
      fireEvent.click(screen.getByRole("button", { name: "打开统一上传" }));
      const pdf = new File(["pdf"], "2025年度报告.pdf", { type: "application/pdf" });
      fireEvent.change(screen.getByLabelText("在统一入口选择资料文档"), {
        target: { files: [pdf] },
      });
      await act(async () => Promise.resolve());

      expect(screen.getByText(/后台处理中/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "转到后台" }));
      expect(screen.queryByLabelText("统一上传并自动归类资料")).not.toBeInTheDocument();

      await act(async () => vi.advanceTimersByTimeAsync(1500));
      expect(getPrivateFundGlobalUploadBatch).toHaveBeenCalledWith("upload-1");
      fireEvent.click(screen.getByRole("button", { name: "打开统一上传" }));
      expect(screen.getByText("已完成索引")).toBeInTheDocument();
      expect(screen.getByText(/处理完成 · 1\/1/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores an active background batch after the page mounts again", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(listPrivateFundGlobalUploadBatches).mockResolvedValue([ACTIVE_BATCH]);
      vi.mocked(getPrivateFundGlobalUploadBatch).mockResolvedValue(COMPLETED_BATCH);
      renderFixture();
      await act(async () => Promise.resolve());
      await act(async () => vi.advanceTimersByTimeAsync(1500));

      expect(getPrivateFundGlobalUploadBatch).toHaveBeenCalledWith("upload-1");
      fireEvent.click(screen.getByRole("button", { name: "打开统一上传" }));
      expect(screen.getByText("已完成索引")).toBeInTheDocument();
      expect(screen.getByText(/处理完成 · 1\/1/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
