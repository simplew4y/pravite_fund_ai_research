import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PrivateFundAsset } from "@/lib/privateFundApi";
import { ResearchAssetLibrary } from "./ResearchAssetLibrary";

const assets: PrivateFundAsset[] = [
  {
    assetId: "document:report",
    assetType: "document",
    displayGroup: "source",
    displayLabel: "资料",
    title: "交流会原文.pdf",
    summary: "PDF · 12 个可检索片段",
    contentMarkdown: "",
    format: "pdf",
    status: "indexed",
    sourceKind: "document",
    tags: [],
    versionNo: 1,
    evidenceCount: 12,
    metadata: {
      doc_type: "financial_valuation_data",
      doc_subtype: "annual_report",
      doc_type_confidence: 0.97,
    },
    updatedAt: "2026-07-10T00:00:00Z",
  },
  {
    assetId: "asset_info",
    assetType: "information",
    displayGroup: "answer_note",
    displayLabel: "回答笔记",
    title: "管理层网络安全观点",
    summary: "电网稳定性比网络攻击更值得关注",
    contentMarkdown: "电网稳定性不足。",
    format: "markdown",
    status: "completed",
    sourceKind: "saved_information",
    tags: ["勾选信息"],
    versionNo: 1,
    evidenceCount: 0,
    metadata: {},
    updatedAt: "2026-07-12T00:00:00Z",
  },
];

const memoAsset = (
  assetId: string,
  seriesId: string,
  title: string,
  versionNo: number,
  updatedAt: string,
): PrivateFundAsset => ({
  assetId,
  assetType: "memo",
  displayGroup: "memo",
  displayLabel: "Memo",
  title,
  summary: `Memo v${versionNo}`,
  contentMarkdown: `# ${title}`,
  format: "markdown",
  status: "completed",
  sourceKind: "memo",
  tags: [],
  versionNo,
  evidenceCount: versionNo,
  metadata: { series_id: seriesId, memo_version_id: assetId },
  updatedAt,
});

describe("ResearchAssetLibrary", () => {
  it("filters assets and adds a checked asset directly to the conversation context", () => {
    const setContext = vi.fn();
    render(
      <ResearchAssetLibrary
        assets={assets}
        contextAssetIds={[]}
        onDeleteAssets={vi.fn()}
        onOpenAsset={vi.fn()}
        onSetContext={setContext}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "条目类型" }), {
      target: { value: "document" },
    });
    expect(screen.getByText("交流会原文.pdf")).toBeInTheDocument();
    expect(screen.queryByText("管理层网络安全观点")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "加入上下文 交流会原文.pdf" }));
    expect(setContext).toHaveBeenCalledWith(["document:report"]);
  });

  it("supports search and card view without losing asset actions", () => {
    const open = vi.fn();
    render(
      <ResearchAssetLibrary
        assets={assets}
        contextAssetIds={["asset_info"]}
        onDeleteAssets={vi.fn()}
        onOpenAsset={open}
        onSetContext={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "搜索" }), {
      target: { value: "网络安全" },
    });
    fireEvent.click(screen.getByRole("button", { name: "卡片视图" }));
    fireEvent.click(screen.getByRole("button", { name: /管理层网络安全观点/ }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ assetId: "asset_info" }));
    expect(screen.getByText("已加入上下文")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "加入上下文 管理层网络安全观点" })).toBeChecked();
  });

  it("does not render the document upload entry in the right asset library", () => {
    render(
      <ResearchAssetLibrary
        assets={assets}
        contextAssetIds={[]}
        onDeleteAssets={vi.fn()}
        onOpenAsset={vi.fn()}
        onSetContext={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /上传/ })).toBeNull();
  });

  it("keeps conversation context separate from batch deletion selection", async () => {
    const deleteAssets = vi.fn().mockResolvedValue(undefined);
    const setContext = vi.fn();
    render(
      <ResearchAssetLibrary
        assets={assets}
        contextAssetIds={["asset_info"]}
        onDeleteAssets={deleteAssets}
        onOpenAsset={vi.fn()}
        onSetContext={setContext}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "条目类型" }), {
      target: { value: "document" },
    });
    expect(screen.queryByRole("button", { name: /删除管理选中/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "进入批量管理" }));
    expect(screen.getByRole("checkbox", { name: "选择管理 交流会原文.pdf" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "删除管理选中 0 项" })).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: "选择当前显示的全部管理条目" }));
    expect(setContext).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "选择管理 交流会原文.pdf" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "删除管理选中 1 项" }));
    expect(screen.getByRole("heading", { name: "删除 1 项？" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(deleteAssets).toHaveBeenCalledWith(["document:report"]));
    expect(screen.queryByTestId("asset-management-toolbar")).toBeNull();
    expect(screen.getByRole("button", { name: "进入批量管理" })).toBeInTheDocument();
  });

  it("supports compact type filtering and ascending or descending time sorting", () => {
    const setContext = vi.fn();
    const { rerender } = render(
      <ResearchAssetLibrary
        assets={assets}
        compact
        contextAssetIds={[]}
        onDeleteAssets={vi.fn()}
        onOpenAsset={vi.fn()}
        onSetContext={setContext}
        title="资产"
      />,
    );

    expect(
      screen
        .getAllByRole("button", { name: /打开资产/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["打开资产 管理层网络安全观点", "打开资产 交流会原文.pdf"]);

    fireEvent.change(screen.getByRole("combobox", { name: "排序" }), {
      target: { value: "oldest" },
    });
    expect(
      screen
        .getAllByRole("button", { name: /打开资产/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["打开资产 交流会原文.pdf", "打开资产 管理层网络安全观点"]);

    fireEvent.change(screen.getByRole("combobox", { name: "条目类型" }), {
      target: { value: "document" },
    });
    expect(screen.getByText("交流会原文.pdf")).toBeInTheDocument();
    expect(screen.queryByText("管理层网络安全观点")).toBeNull();

    fireEvent.change(screen.getByRole("combobox", { name: "资料类型" }), {
      target: { value: "financial_valuation_data" },
    });
    expect(screen.getByRole("button", { name: "打开资产 交流会原文.pdf" })).toHaveTextContent(
      "财报与估值数据",
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "加入上下文 交流会原文.pdf" }));
    expect(setContext).toHaveBeenCalledWith(["document:report"]);

    rerender(
      <ResearchAssetLibrary
        assets={assets}
        compact
        contextAssetIds={["document:report"]}
        onDeleteAssets={vi.fn()}
        onOpenAsset={vi.fn()}
        onSetContext={setContext}
        title="资产"
      />,
    );
    expect(screen.getByRole("checkbox", { name: "加入上下文 交流会原文.pdf" })).toBeChecked();
    expect(screen.queryByRole("button", { name: /删除管理选中/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "进入批量管理" }));
    expect(screen.queryByRole("checkbox", { name: "加入上下文 交流会原文.pdf" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "选择管理 交流会原文.pdf" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "删除管理选中 0 项" })).toBeDisabled();
  });

  it("groups Memo versions by series and opens the latest version by default", () => {
    const open = vi.fn();
    const openHistory = vi.fn();
    const memoAssets = [
      memoAsset("memo:v1", "series-overseas", "海外盈利质量 Memo", 1, "2026-07-01T00:00:00Z"),
      memoAsset("memo:v2", "series-overseas", "海外盈利质量 Memo", 2, "2026-07-10T00:00:00Z"),
      memoAsset("memo:risk-v1", "series-risk", "风险事项 Memo", 1, "2026-07-08T00:00:00Z"),
    ];

    render(
      <ResearchAssetLibrary
        assets={memoAssets}
        compact
        contextAssetIds={[]}
        onDeleteAssets={vi.fn()}
        onOpenAsset={open}
        onOpenMemoHistory={openHistory}
        onSetContext={vi.fn()}
        title="Memo"
        zone="memos"
      />,
    );

    expect(screen.getAllByText("海外盈利质量 Memo")).toHaveLength(1);
    expect(screen.getByText(/当前 v2 · 共 2 个版本/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开当前版本 海外盈利质量 Memo" }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ assetId: "memo:v2" }));

    fireEvent.click(screen.getByRole("button", { name: "查看版本记录 海外盈利质量 Memo" }));
    expect(screen.getByRole("button", { name: "打开 海外盈利质量 Memo v2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开 海外盈利质量 Memo v1" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "对比版本 海外盈利质量 Memo" }));
    expect(openHistory).toHaveBeenCalledWith("series-overseas");
    expect(screen.queryByRole("button", { name: "对比版本 风险事项 Memo" })).toBeNull();
  });

  it("keeps concrete Memo versions visible in batch management mode", () => {
    const memoAssets = [
      memoAsset("memo:v1", "series-overseas", "海外盈利质量 Memo", 1, "2026-07-01T00:00:00Z"),
      memoAsset("memo:v2", "series-overseas", "海外盈利质量 Memo", 2, "2026-07-10T00:00:00Z"),
    ];

    render(
      <ResearchAssetLibrary
        assets={memoAssets}
        compact
        contextAssetIds={[]}
        onDeleteAssets={vi.fn()}
        onOpenAsset={vi.fn()}
        onSetContext={vi.fn()}
        title="Memo"
        zone="memos"
      />,
    );

    expect(screen.getAllByText("海外盈利质量 Memo")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "进入批量管理" }));
    expect(screen.getAllByText("海外盈利质量 Memo")).toHaveLength(2);
    expect(
      screen.getAllByRole("checkbox", { name: "选择管理 海外盈利质量 Memo" }),
    ).toHaveLength(2);
  });
});
