import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQuery, stubFetch } from "../../test-utils";
import { DocumentPreview } from "./DocumentPreview";

const textPreview = {
  kind: "document_text",
  documentId: "d-1",
  documentVersionId: "v-2",
  fileName: "2025年报.pdf",
  fileType: "pdf",
  chunkCount: 3,
  contentMarkdown: "# 2025 年报\n营收同比增长 20%。",
  truncated: true,
};

const versionRow = {
  id: "v-1",
  documentId: "d-1",
  versionNo: 1,
  supersedesVersionId: null,
  sha256: "a".repeat(64),
  originalFilename: "2025年报_v1.pdf",
  storedPath: "projects/p-1/docs/2025年报_v1.pdf",
  fileType: "pdf",
  mimeType: "application/pdf",
  fileSize: 20_480,
  status: "indexed",
  lifecycle: "superseded",
  parserName: "pdf-parser",
  parserVersion: "1.0.0",
  metadata: {},
  createdAt: "2026-08-10T08:30:00.000Z",
  updatedAt: "2026-08-10T08:30:00.000Z",
};

const versionsPage = {
  items: [
    versionRow,
    {
      ...versionRow,
      id: "v-2",
      versionNo: 2,
      supersedesVersionId: "v-1",
      originalFilename: "2025年报_v2.pdf",
      status: "failed",
      lifecycle: "failed_attempt",
      createdAt: "2026-08-16T09:00:00.000Z",
    },
  ],
  total: 2,
  hasMore: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DocumentPreview", () => {
  it("renders the markdown text preview and marks truncation", async () => {
    stubFetch({
      "GET /v1/projects/p-1/documents/d-1/text-preview": textPreview,
    });
    renderWithQuery(
      <DocumentPreview projectId="p-1" documentId="d-1" title="2025 年报" onClose={vi.fn()} />,
    );
    expect(await screen.findByText(/营收同比增长 20%/)).toBeInTheDocument();
    expect(screen.getByText("…")).toBeInTheDocument();
  });

  it("lists version rows with status tags on the versions tab", async () => {
    stubFetch({
      "GET /v1/projects/p-1/documents/d-1/text-preview": textPreview,
      "GET /v1/projects/p-1/documents/d-1/versions": versionsPage,
    });
    renderWithQuery(
      <DocumentPreview projectId="p-1" documentId="d-1" title="2025 年报" onClose={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "历史版本" }));
    expect(await screen.findByText("v1 · 2025年报_v1.pdf")).toBeInTheDocument();
    expect(screen.getByText("v2 · 2025年报_v2.pdf")).toBeInTheDocument();
    expect(screen.getByText("已索引").className).toContain("tag-neutral");
    expect(screen.getByText("失败").className).toContain("tag-outline");
    const rowLinks = screen
      .getAllByTitle("下载")
      .filter((element) => element.classList.contains("btn-icon"));
    expect(rowLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/v1/projects/p-1/documents/d-1/download?versionId=v-1",
      "/v1/projects/p-1/documents/d-1/download?versionId=v-2",
    ]);
  });

  it("falls back to an error message with a download link when the preview 404s", async () => {
    stubFetch({});
    renderWithQuery(
      <DocumentPreview projectId="p-1" documentId="d-1" title="2025 年报" onClose={vi.fn()} />,
    );
    expect(await screen.findByText("加载失败")).toBeInTheDocument();
    const downloads = screen.getAllByText("下载");
    expect(downloads.length).toBe(2);
    expect(downloads[1]?.getAttribute("href")).toBe(
      "/v1/projects/p-1/documents/d-1/download",
    );
  });
});
