import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PrivateFundAsset } from "@/lib/privateFundApi";
import { ResearchAssetLibrary } from "./ResearchAssetLibrary";

const assets: PrivateFundAsset[] = [
  {
    assetId: "document:report",
    assetType: "document",
    title: "交流会原文.pdf",
    summary: "PDF · 12 个可检索片段",
    contentMarkdown: "",
    format: "pdf",
    status: "indexed",
    sourceKind: "document",
    tags: [],
    versionNo: 1,
    evidenceCount: 12,
    metadata: {},
    updatedAt: "2026-07-10T00:00:00Z",
  },
  {
    assetId: "asset_info",
    assetType: "information",
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

describe("ResearchAssetLibrary", () => {
  it("filters assets and toggles the unified context basket", () => {
    const toggle = vi.fn();
    render(
      <ResearchAssetLibrary
        assets={assets}
        contextAssetIds={[]}
        onDeleteAssets={vi.fn()}
        onOpenAsset={vi.fn()}
        onSetContext={vi.fn()}
        onToggleContext={toggle}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "资产类型" }), {
      target: { value: "document" },
    });
    expect(screen.getByText("交流会原文.pdf")).toBeInTheDocument();
    expect(screen.queryByText("管理层网络安全观点")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "选择资产 交流会原文.pdf" }));
    expect(toggle).toHaveBeenCalledWith("document:report");
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
        onToggleContext={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "搜索资产" }), {
      target: { value: "网络安全" },
    });
    fireEvent.click(screen.getByRole("button", { name: "卡片视图" }));
    fireEvent.click(screen.getByRole("button", { name: /管理层网络安全观点/ }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ assetId: "asset_info" }));
    expect(screen.getByRole("checkbox", { name: "选择资产 管理层网络安全观点" })).toBeChecked();
  });

  it("does not render the document upload entry in the right asset library", () => {
    render(
      <ResearchAssetLibrary
        assets={assets}
        contextAssetIds={[]}
        onDeleteAssets={vi.fn()}
        onOpenAsset={vi.fn()}
        onSetContext={vi.fn()}
        onToggleContext={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /上传/ })).toBeNull();
  });

  it("uses the context basket as the single selection for bulk deletion", async () => {
    const deleteAssets = vi.fn().mockResolvedValue(undefined);
    const setContext = vi.fn();
    const toggleContext = vi.fn();
    const { rerender } = render(
      <ResearchAssetLibrary
        assets={assets}
        contextAssetIds={[]}
        onDeleteAssets={deleteAssets}
        onOpenAsset={vi.fn()}
        onSetContext={setContext}
        onToggleContext={toggleContext}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "资产类型" }), {
      target: { value: "document" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "全选当前资产" }));
    expect(setContext).toHaveBeenCalledWith(["document:report"]);
    expect(toggleContext).not.toHaveBeenCalled();

    rerender(
      <ResearchAssetLibrary
        assets={assets}
        contextAssetIds={["document:report"]}
        onDeleteAssets={deleteAssets}
        onOpenAsset={vi.fn()}
        onSetContext={setContext}
        onToggleContext={toggleContext}
      />,
    );
    expect(screen.getAllByRole("checkbox", { name: "选择资产 交流会原文.pdf" })).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: "选择资产 交流会原文.pdf" })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "删除已选资产 1 项" }));
    expect(screen.getByRole("heading", { name: "删除 1 项资产？" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    expect(deleteAssets).toHaveBeenCalledWith(["document:report"]);
  });
});
