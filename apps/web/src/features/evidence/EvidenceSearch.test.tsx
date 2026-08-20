import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQuery, stubFetch } from "../../test-utils";
import { EvidenceSearch } from "./EvidenceSearch";

const documentRow = {
  id: "d-1",
  logicalKey: "annual-2025",
  sourceRoot: null,
  sourceRelpath: "docs/2025年报.pdf",
  title: "2025 年年度报告.pdf",
  status: "active",
  currentVersionId: "v-1",
  currentVersionNo: 1,
  metadata: {},
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
  deletedAt: null,
};

const documentVersion = {
  id: "v-1",
  documentId: "d-1",
  versionNo: 1,
  supersedesVersionId: null,
  sha256: "b".repeat(64),
  originalFilename: "2025年报.pdf",
  storedPath: "/data/docs/2025年报.pdf",
  fileType: "pdf",
  mimeType: "application/pdf",
  fileSize: 1024,
  status: "indexed",
  lifecycle: "active",
  parserName: null,
  parserVersion: null,
  metadata: {},
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
};

const trace = {
  evidenceId: "chunk:ev-1",
  kind: "chunk",
  documentVersionId: "v-1",
  title: null,
  summary: null,
  originalText: "营业收入同比增长 24%，主要来自海外市场放量。",
  contentHash: "a".repeat(64),
  locator: { pageStart: 3, pageEnd: 3 },
  pageStart: 3,
  pageEnd: 3,
  bbox: null,
  sheetName: null,
  cellRange: null,
  cellRef: null,
  formula: null,
  displayValue: null,
  rawValue: null,
  metadata: {},
  createdAt: "2026-08-16T00:00:00.000Z",
  document: documentRow,
  documentVersion,
};

const resultPage = {
  items: [{ evidence: trace, score: 0.92 }],
  total: 1,
  hasMore: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("EvidenceSearch", () => {
  it("queries only after the 400ms debounce and renders hits", async () => {
    vi.useFakeTimers();
    const calls = stubFetch({
      "GET /v1/projects/p-1/evidence/search": resultPage,
    });
    renderWithQuery(<EvidenceSearch projectId="p-1" onOpen={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("搜索证据原文…"), {
      target: { value: "营收" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(399);
    });
    expect(calls.length).toBe(0);

    // 1ms crosses the debounce boundary; the query effect dispatches when
    // this act exits, so a second act flushes the timer-scheduled
    // react-query notification before real timers return.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.useRealTimers();

    expect(
      await screen.findByText("营业收入同比增长 24%，主要来自海外市场放量。"),
    ).toBeInTheDocument();
    expect(screen.getByText("段落")).toBeInTheDocument();
    expect(screen.getByText("2025 年年度报告.pdf")).toBeInTheDocument();
    expect(calls.length).toBe(1);
    expect(calls[0]?.path).toBe("/v1/projects/p-1/evidence/search");
  });

  it("calls onOpen with the evidenceId when a row is clicked", async () => {
    stubFetch({ "GET /v1/projects/p-1/evidence/search": resultPage });
    const onOpen = vi.fn();
    renderWithQuery(<EvidenceSearch projectId="p-1" onOpen={onOpen} />);

    await userEvent.type(screen.getByPlaceholderText("搜索证据原文…"), "营收");
    const row = await screen.findByText(
      "营业收入同比增长 24%，主要来自海外市场放量。",
      {},
      { timeout: 3000 },
    );
    await userEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith("chunk:ev-1");
  });

  it("shows the empty state when the search has no hits", async () => {
    stubFetch({
      "GET /v1/projects/p-1/evidence/search": { items: [], total: 0, hasMore: false },
    });
    renderWithQuery(<EvidenceSearch projectId="p-1" onOpen={vi.fn()} />);

    await userEvent.type(screen.getByPlaceholderText("搜索证据原文…"), "空空");
    expect(await screen.findByText("暂无数据", {}, { timeout: 3000 })).toBeInTheDocument();
  });
});
