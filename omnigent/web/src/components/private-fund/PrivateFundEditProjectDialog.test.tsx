import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type PrivateFundProject,
  updatePrivateFundProject,
} from "@/lib/privateFundApi";
import { PrivateFundEditProjectDialog } from "./PrivateFundEditProjectDialog";

vi.mock("@/lib/privateFundApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privateFundApi")>();
  return {
    ...actual,
    updatePrivateFundProject: vi.fn(),
  };
});

const project: PrivateFundProject = {
  datasetId: "dataset_internal_id",
  name: "阳光电源",
  status: "completed",
  companyName: "阳光电源",
  companyTicker: "",
  fileCount: 2,
  uploadCount: 2,
  documentCount: 2,
  indexedDocumentCount: 2,
  failedDocumentCount: 0,
  chunkCount: 10,
  indexCount: 1,
  memoCount: 0,
  indexReady: true,
};

describe("PrivateFundEditProjectDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updatePrivateFundProject).mockResolvedValue({
      ...project,
      companyTicker: "300274",
    });
  });

  it("edits project identity without exposing or changing the dataset id", async () => {
    const onOpenChange = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <PrivateFundEditProjectDialog
          open
          project={project}
          onOpenChange={onOpenChange}
        />
      </QueryClientProvider>,
    );

    expect(screen.queryByText(/Dataset ID/i)).toBeNull();
    expect(screen.getByLabelText("项目名称")).toHaveValue("阳光电源");
    fireEvent.change(screen.getByLabelText("股票代码"), {
      target: { value: "300274" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(updatePrivateFundProject).toHaveBeenCalledWith("dataset_internal_id", {
        name: "阳光电源",
        companyName: "阳光电源",
        companyTicker: "300274",
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
