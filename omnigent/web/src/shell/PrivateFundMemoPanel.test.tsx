import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivateFundAsset, PrivateFundAssetCatalog } from "@/lib/privateFundApi";
import type { PrivateFundGenerationRequest } from "./PrivateFundShellContext";
import { PrivateFundAssetsContent, PrivateFundMemoContent } from "./PrivateFundMemoPanel";

const assetsCatalogRef: { current: PrivateFundAssetCatalog } = {
  current: { assets: [], contextAssetIds: [] },
};
const setContextSpy = vi.fn();

vi.mock("@/hooks/usePrivateFundProjects", () => ({
  usePrivateFundProject: () => ({
    data: { project: { datasetId: "solar", name: "阳光电源" }, files: [] },
    isLoading: false,
  }),
  usePrivateFundAssets: () => ({ data: assetsCatalogRef.current, isLoading: false }),
  usePrivateFundWorkflow: () => ({ data: { nodes: [] }, isLoading: false }),
}));

vi.mock("@/lib/privateFundApi", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/privateFundApi")>();
  return {
    ...original,
    deletePrivateFundAssets: vi.fn(),
    getPrivateFundAssets: vi.fn(async () => assetsCatalogRef.current),
    savePrivateFundAsset: vi.fn(async () => assetsCatalogRef.current),
    setPrivateFundAssetContext: (...args: unknown[]) => setContextSpy(...args),
  };
});

vi.mock("@/components/private-fund/RichNodeContent", () => ({
  RichNodeContent: () => <div>Rich node</div>,
}));

function asset(overrides: Partial<PrivateFundAsset> = {}): PrivateFundAsset {
  return {
    assetId: "asset-1",
    assetType: "information",
    title: "海外业务结论",
    summary: "海外收入保持增长",
    contentMarkdown: "海外收入保持增长。",
    format: "markdown",
    status: "ready",
    sourceKind: "response",
    tags: ["可信来源"],
    versionNo: 1,
    evidenceCount: 2,
    metadata: {
      conversationId: "conv-1",
      responseId: "response-1",
      trustedMemoSource: true,
    },
    ...overrides,
  };
}

function renderWithQueryClient(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
  assetsCatalogRef.current = { assets: [asset()], contextAssetIds: ["asset-1"] };
  setContextSpy.mockReset();
  setContextSpy.mockResolvedValue(assetsCatalogRef.current);
});

afterEach(cleanup);

describe("PrivateFundMemoContent", () => {
  it("uses persisted trusted assets and dispatches the real memo skill", () => {
    const onGenerate = vi.fn<(request: PrivateFundGenerationRequest) => boolean>(() => true);
    renderWithQueryClient(
      <PrivateFundMemoContent
        conversationId="conv-1"
        datasetId="solar"
        datasetName="阳光电源"
        onGenerate={onGenerate}
      />,
    );

    expect(screen.getByText("海外业务结论")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("主题、时间范围或重点问题（可选）"), {
      target: { value: "重点分析海外盈利质量" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成" }));

    expect(onGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "skill",
        name: "private-fund-memo",
        args: expect.stringContaining("重点分析海外盈利质量"),
      }),
    );
    const request = onGenerate.mock.calls[0]![0];
    expect(request.kind).toBe("skill");
    if (request.kind !== "skill") throw new Error("Expected a skill generation request");
    expect(request.args).toContain("dataset_id: solar");
  });
});

describe("PrivateFundAssetsContent", () => {
  it("renders compact asset rows and updates backend context", async () => {
    assetsCatalogRef.current = { assets: [asset({ assetType: "analysis" })], contextAssetIds: [] };
    renderWithQueryClient(
      <PrivateFundAssetsContent
        datasetId="solar"
        datasetName="阳光电源"
        onGenerate={vi.fn(() => true)}
      />,
    );

    expect(screen.getByText("海外业务结论")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "将 海外业务结论 加入上下文" }));
    await waitFor(() => expect(setContextSpy).toHaveBeenCalledWith("solar", ["asset-1"]));
  });

  it("dispatches research-node generation without exposing dataset context in visible text", () => {
    const onGenerate = vi.fn<(request: PrivateFundGenerationRequest) => boolean>(() => true);
    renderWithQueryClient(
      <PrivateFundAssetsContent datasetId="solar" datasetName="阳光电源" onGenerate={onGenerate} />,
    );

    fireEvent.change(screen.getByPlaceholderText("补充主题或口径（可选）"), {
      target: { value: "分析利润率变化" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成" }));

    const request = onGenerate.mock.calls[0]![0];
    expect(request.kind).toBe("message");
    if (request.kind !== "message") throw new Error("Expected a message generation request");
    expect(request.prompt).toContain("分析利润率变化");
    expect(request.prompt).toContain("dataset_id: solar");
  });
});
