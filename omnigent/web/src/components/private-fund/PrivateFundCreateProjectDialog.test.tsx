import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  activatePrivateFundProject,
  createPrivateFundProject,
  type PrivateFundProject,
} from "@/lib/privateFundApi";
import { PrivateFundCreateProjectDialog } from "./PrivateFundCreateProjectDialog";

vi.mock("@/lib/privateFundApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privateFundApi")>();
  return {
    ...actual,
    activatePrivateFundProject: vi.fn(),
    createPrivateFundProject: vi.fn(),
  };
});

const createdProject: PrivateFundProject = {
  datasetId: "sungrow-new",
  name: "阳光电源新项目",
  status: "draft",
  sourceDir: null,
  datasetRoot: "/datasets/sungrow-new",
  uploadsDir: null,
  companyName: "阳光电源",
  companyTicker: "300274",
  fileCount: 0,
  uploadCount: 0,
  documentCount: 0,
  indexedDocumentCount: 0,
  failedDocumentCount: 0,
  chunkCount: 0,
  indexCount: 0,
  memoCount: 0,
  latestMemoPath: null,
  latestMemoName: null,
  createdAt: null,
  updatedAt: null,
  indexReady: false,
  latestJob: null,
};

describe("PrivateFundCreateProjectDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createPrivateFundProject).mockResolvedValue(createdProject);
    vi.mocked(activatePrivateFundProject).mockResolvedValue();
  });

  it("creates, activates and hands the project to the unified workbench", async () => {
    const onCreated = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <PrivateFundCreateProjectDialog onCreated={onCreated} onOpenChange={vi.fn()} open />
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByLabelText("研究项目名称"), {
      target: { value: "阳光电源新项目" },
    });
    fireEvent.change(screen.getByLabelText("研究项目 Dataset ID"), {
      target: { value: "sungrow-new" },
    });
    fireEvent.change(screen.getByLabelText("研究项目公司名称"), {
      target: { value: "阳光电源" },
    });
    fireEvent.change(screen.getByLabelText("研究项目股票代码"), {
      target: { value: "300274" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并进入工作台" }));

    await waitFor(() =>
      expect(createPrivateFundProject).toHaveBeenCalledWith({
        name: "阳光电源新项目",
        datasetId: "sungrow-new",
        companyName: "阳光电源",
        companyTicker: "300274",
      }),
    );
    expect(activatePrivateFundProject).toHaveBeenCalledWith("sungrow-new");
    expect(onCreated).toHaveBeenCalledWith(createdProject);
  });
});
