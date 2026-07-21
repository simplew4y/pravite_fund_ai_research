import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getPrivateFundPipelineJob,
  runPrivateFundPipeline,
  uploadPrivateFundFiles,
} from "@/lib/privateFundApi";
import { PrivateFundUploadDialog } from "./PrivateFundUploadDialog";
import { usePrivateFundDocumentUpload } from "./usePrivateFundDocumentUpload";

vi.mock("@/lib/privateFundApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privateFundApi")>();
  return {
    ...actual,
    getPrivateFundPipelineJob: vi.fn(),
    runPrivateFundPipeline: vi.fn(),
    uploadPrivateFundFiles: vi.fn(),
  };
});

function UploadFixture() {
  const upload = usePrivateFundDocumentUpload("阳光电源");
  return (
    <>
      <button onClick={upload.openDialog} type="button">
        打开左侧上传
      </button>
      <PrivateFundUploadDialog {...upload.dialogProps} />
    </>
  );
}

function renderFixture() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UploadFixture />
    </QueryClientProvider>,
  );
}

describe("usePrivateFundDocumentUpload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(uploadPrivateFundFiles).mockResolvedValue({
      project: {} as never,
      files: [],
      job: {
        jobId: "job-upload",
        datasetId: "阳光电源",
        status: "queued",
      },
    });
    vi.mocked(runPrivateFundPipeline).mockResolvedValue({
      jobId: "job-upload",
      datasetId: "阳光电源",
      status: "queued",
    });
  });

  it("keeps the dialog locked until the real pipeline job completes", async () => {
    let finish!: (value: Awaited<ReturnType<typeof getPrivateFundPipelineJob>>) => void;
    vi.mocked(getPrivateFundPipelineJob).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderFixture();

    fireEvent.click(screen.getByRole("button", { name: "打开左侧上传" }));
    const pdf = new File(["pdf"], "新增交流会.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("在弹窗中选择资料文档"), {
      target: { files: [pdf] },
    });

    await waitFor(() => expect(uploadPrivateFundFiles).toHaveBeenCalledWith("阳光电源", [pdf]));
    expect(runPrivateFundPipeline).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "索引完成后可关闭" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();

    finish({ jobId: "job-upload", datasetId: "阳光电源", status: "completed" });
    expect(await screen.findByText("索引构建完成")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "完成并关闭" })).toBeEnabled();
  });
});
