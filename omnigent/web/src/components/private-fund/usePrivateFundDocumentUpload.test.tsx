import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getPrivateFundPipelineJob,
  runPrivateFundPipeline,
  type PrivateFundPipelineJob,
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

function pipelineJob(jobId: string, status: string, message?: string): PrivateFundPipelineJob {
  return { jobId, datasetId: "阳光电源", status, message };
}

function uploadResult(
  jobs: PrivateFundPipelineJob[],
  job: PrivateFundPipelineJob | null = jobs[0] ?? null,
): Awaited<ReturnType<typeof uploadPrivateFundFiles>> {
  return {
    project: {} as never,
    files: [],
    jobs,
    job,
  } as Awaited<ReturnType<typeof uploadPrivateFundFiles>>;
}

describe("usePrivateFundDocumentUpload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(uploadPrivateFundFiles).mockResolvedValue(
      uploadResult([], pipelineJob("job-upload", "queued")),
    );
    vi.mocked(runPrivateFundPipeline).mockResolvedValue(pipelineJob("job-upload", "queued"));
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
    fireEvent.change(screen.getByLabelText("选择资料文档"), {
      target: { files: [pdf] },
    });

    await waitFor(() => expect(uploadPrivateFundFiles).toHaveBeenCalledWith("阳光电源", [pdf]));
    expect(runPrivateFundPipeline).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "索引完成后可关闭" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();

    finish({ jobId: "job-upload", datasetId: "阳光电源", status: "completed" });
    expect(await screen.findByText("索引已完成")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "完成" })).toBeEnabled();
  });

  it("waits for every canonical upload job before completing", async () => {
    const files = [
      new File(["a"], "A.pdf", { type: "application/pdf" }),
      new File(["b"], "B.pdf", { type: "application/pdf" }),
      new File(["c"], "C.pdf", { type: "application/pdf" }),
      new File(["d"], "D.pdf", { type: "application/pdf" }),
    ];
    const jobs = files.map((_, index) => pipelineJob(`job-${index + 1}`, "queued"));
    vi.mocked(uploadPrivateFundFiles).mockResolvedValueOnce(uploadResult(jobs));
    vi.mocked(getPrivateFundPipelineJob).mockImplementation(async (jobId) =>
      pipelineJob(jobId, "completed"),
    );
    renderFixture();

    fireEvent.click(screen.getByRole("button", { name: "打开左侧上传" }));
    fireEvent.change(screen.getByLabelText("选择资料文档"), {
      target: { files },
    });

    expect(await screen.findByText("索引已完成")).toBeInTheDocument();
    expect(getPrivateFundPipelineJob).toHaveBeenCalledTimes(4);
    expect(vi.mocked(getPrivateFundPipelineJob).mock.calls.map(([jobId]) => jobId)).toEqual([
      "job-1",
      "job-2",
      "job-3",
      "job-4",
    ]);
    expect(runPrivateFundPipeline).not.toHaveBeenCalled();
  });

  it.each(["failed", "cancelled"])(
    "fails the whole upload on a %s job after the other jobs reach terminal state",
    async (terminalStatus) => {
      const first = new File(["a"], "A.pdf", { type: "application/pdf" });
      const second = new File(["b"], "B.pdf", { type: "application/pdf" });
      vi.mocked(uploadPrivateFundFiles).mockResolvedValueOnce(
        uploadResult([pipelineJob("job-ok", "queued"), pipelineJob("job-bad", "running")]),
      );
      vi.mocked(getPrivateFundPipelineJob).mockImplementation(async (jobId) =>
        jobId === "job-ok"
          ? pipelineJob(jobId, "completed")
          : pipelineJob(jobId, terminalStatus, `B.pdf: ${terminalStatus}`),
      );
      renderFixture();

      fireEvent.click(screen.getByRole("button", { name: "打开左侧上传" }));
      fireEvent.change(screen.getByLabelText("选择资料文档"), {
        target: { files: [first, second] },
      });

      expect(await screen.findByText(`B.pdf: ${terminalStatus}`)).toBeInTheDocument();
      expect(screen.getByText("索引失败，请重试")).toBeInTheDocument();
      expect(
        vi
          .mocked(getPrivateFundPipelineJob)
          .mock.calls.map(([jobId]) => jobId)
          .sort(),
      ).toEqual(["job-bad", "job-ok"]);
      expect(runPrivateFundPipeline).not.toHaveBeenCalled();
    },
  );

  it("keeps the explicit pipeline-start fallback for old upload services", async () => {
    vi.mocked(uploadPrivateFundFiles).mockResolvedValueOnce(uploadResult([], null));
    vi.mocked(runPrivateFundPipeline).mockResolvedValueOnce(pipelineJob("job-fallback", "queued"));
    vi.mocked(getPrivateFundPipelineJob).mockResolvedValueOnce(
      pipelineJob("job-fallback", "completed"),
    );
    renderFixture();

    fireEvent.click(screen.getByRole("button", { name: "打开左侧上传" }));
    const pdf = new File(["pdf"], "fallback.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("选择资料文档"), {
      target: { files: [pdf] },
    });

    expect(await screen.findByText("索引已完成")).toBeInTheDocument();
    expect(runPrivateFundPipeline).toHaveBeenCalledWith("阳光电源");
    expect(getPrivateFundPipelineJob).toHaveBeenCalledWith("job-fallback");
  });
});
