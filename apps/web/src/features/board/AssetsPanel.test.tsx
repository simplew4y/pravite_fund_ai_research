import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQuery, stubFetch } from "../../test-utils";
import { useUiStore } from "../../store/ui";
import { AssetsPanel } from "./AssetsPanel";

const assetRow = {
  id: "a-1",
  assetType: "memo",
  title: "投资备忘录",
  status: "completed",
  currentVersionId: "av-1",
  currentVersionNo: 2,
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
};

const assetVersion = {
  id: "av-1",
  assetId: "a-1",
  versionNo: 2,
  status: "completed",
  summary: "核心结论摘要",
  contentMarkdown: "# 备忘录正文",
  contentHash: "a".repeat(64),
  sourceResponseId: null,
  structuredContent: {},
  metadata: {},
  tags: ["估值"],
  createdAt: "2026-08-17T00:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
  useUiStore.setState({ expandedSessionId: null, lang: "zh" });
});

describe("AssetsPanel", () => {
  it("lists assets with type and archived tags", async () => {
    stubFetch({
      "GET /v1/projects/p-1/assets": {
        items: [
          assetRow,
          {
            ...assetRow,
            id: "a-2",
            title: "行业对比",
            status: "archived",
            archivedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        total: 2,
      },
    });
    renderWithQuery(<AssetsPanel projectId="p-1" />);
    expect(await screen.findByText("投资备忘录")).toBeInTheDocument();
    expect(screen.getByText("行业对比")).toBeInTheDocument();
    expect(screen.getAllByText("memo")).toHaveLength(2);
    expect(screen.getByText("已归档")).toBeInTheDocument();
    expect(screen.getAllByText("08-17")).toHaveLength(2);
  });

  it("opens the detail modal with summary and markdown content", async () => {
    stubFetch({
      "GET /v1/projects/p-1/assets": { items: [assetRow], total: 1 },
      "GET /v1/projects/p-1/assets/a-1": { asset: assetRow, version: assetVersion },
    });
    renderWithQuery(<AssetsPanel projectId="p-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "打开" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(await screen.findByText("# 备忘录正文")).toBeInTheDocument();
    expect(screen.getByText("核心结论摘要")).toBeInTheDocument();
    // Opening the detail must not toggle the row checkbox through the label.
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("deletes selected assets via POST /assets/delete", async () => {
    const calls = stubFetch({
      "GET /v1/projects/p-1/assets": { items: [assetRow], total: 1 },
      "POST /v1/projects/p-1/assets/delete": {},
    });
    vi.stubGlobal("confirm", vi.fn(() => true));
    renderWithQuery(<AssetsPanel projectId="p-1" />);
    await userEvent.click(await screen.findByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "删除资产" }));
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: "POST",
        path: "/v1/projects/p-1/assets/delete",
        body: { assetIds: ["a-1"] },
      });
    });
  });

  it("adds selected assets to the expanded session context", async () => {
    useUiStore.setState({ expandedSessionId: "s-1" });
    const calls = stubFetch({
      "GET /v1/projects/p-1/assets": { items: [assetRow], total: 1 },
      "POST /v1/sessions/s-1/resources/research-assets": {},
    });
    renderWithQuery(<AssetsPanel projectId="p-1" />);
    await userEvent.click(await screen.findByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "加入上下文" }));
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: "POST",
        path: "/v1/sessions/s-1/resources/research-assets",
        body: { assetId: "a-1" },
      });
    });
  });
});
