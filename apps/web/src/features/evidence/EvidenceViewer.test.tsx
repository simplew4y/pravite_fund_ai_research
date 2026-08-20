import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQuery, stubFetch } from "../../test-utils";
import { EvidenceViewer } from "./EvidenceViewer";

const documentFixture = {
  id: "d-1",
  logicalKey: "annual-2025",
  sourceRoot: null,
  sourceRelpath: "docs/annual.pdf",
  title: "2025 年度报告.pdf",
  status: "active",
  currentVersionId: "v-1",
  currentVersionNo: 1,
  metadata: {},
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
  deletedAt: null,
};

const pdfVersionFixture = {
  id: "v-1",
  documentId: "d-1",
  versionNo: 1,
  supersedesVersionId: null,
  sha256: "a".repeat(64),
  originalFilename: "annual.pdf",
  storedPath: "store/annual.pdf",
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

function traceFixture(overrides: Record<string, unknown>) {
  return {
    evidenceId: "chunk:abc",
    kind: "chunk",
    documentVersionId: "v-1",
    title: "营收段落",
    summary: null,
    originalText: "2025 年营业收入同比增长 18%。",
    contentHash: "b".repeat(64),
    locator: {},
    pageStart: null,
    pageEnd: null,
    bbox: null,
    sheetName: null,
    cellRange: null,
    cellRef: null,
    formula: null,
    displayValue: null,
    rawValue: null,
    metadata: {},
    createdAt: "2026-08-16T00:00:00.000Z",
    document: documentFixture,
    documentVersion: pdfVersionFixture,
    ...overrides,
  };
}

const pdfPageFixture = {
  kind: "pdf",
  documentId: "d-1",
  documentVersionId: "v-1",
  anchorEvidenceId: "chunk:abc",
  pageEvidenceId: "page:d-1:3",
  pageNumber: 3,
  pageCount: 120,
  fileName: "annual.pdf",
  imageUrl: "/v1/files/page-3.png",
  imageWidth: 1240,
  imageHeight: 1754,
  pageWidth: 595,
  pageHeight: 842,
  highlights: [{ xPct: 10, yPct: 20, widthPct: 60, heightPct: 5 }],
  matched: true,
  highlightSource: { mode: "evidence_bbox", evidenceId: "chunk:abc" },
};

function excelCell(
  evidenceId: string,
  cellRef: string,
  rowIndex: number,
  columnIndex: number,
  displayValue: string,
) {
  return {
    evidenceId,
    cellRef,
    rowIndex,
    columnIndex,
    displayValue,
    rawValue: displayValue,
    numericValue: null,
    formula: null,
    cachedValue: null,
    numberFormat: null,
    rowLabel: null,
    columnLabel: null,
    period: null,
    unit: null,
    isFormula: false,
  };
}

const excelRangeFixture = {
  kind: "excel",
  documentId: "d-1",
  documentVersionId: "v-2",
  anchorEvidenceId: "cell:xyz",
  fileName: "model.xlsx",
  mode: "range",
  sheet: {
    sheetName: "IS",
    sheetRole: "statement",
    usedRange: "A1:F40",
    rowCount: 40,
    columnCount: 6,
    nonEmptyCellCount: 120,
    formulaCount: 12,
    formulaDensity: 0.1,
    summary: null,
  },
  requestedRangeRef: "B2:C3",
  rangeRef: "B2:C3",
  requestedRowMin: 2,
  requestedRowMax: 3,
  requestedColumnMin: 2,
  requestedColumnMax: 3,
  rowMin: 2,
  rowMax: 3,
  columnMin: 2,
  columnMax: 3,
  columnLabels: ["B", "C"],
  cells: [
    excelCell("cell:xyz", "B2", 2, 2, "1,234"),
    excelCell("cell:other", "C3", 3, 3, "5,678"),
  ],
  nearbyCells: [],
  emptyReason: null,
  totalNonEmptyCellCount: 2,
  window: {
    rowStart: 2,
    rowEnd: 3,
    columnStart: 2,
    columnEnd: 3,
    rowCount: 2,
    columnCount: 2,
    truncated: false,
    displayRangeRef: "B2:C3",
    previousRowStart: null,
    nextRowStart: null,
    previousColumnStart: null,
    nextColumnStart: null,
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EvidenceViewer", () => {
  it("renders a pdf chunk with original text and the page image", async () => {
    stubFetch({
      "GET /v1/projects/p-1/evidence/chunk%3Aabc": traceFixture({ pageStart: 3, pageEnd: 3 }),
      "GET /v1/projects/p-1/evidence/chunk%3Aabc/source/pdf/pages/3": pdfPageFixture,
    });
    const { container } = renderWithQuery(
      <EvidenceViewer projectId="p-1" evidenceId="chunk:abc" onClose={() => undefined} />,
    );
    expect(await screen.findByText("2025 年营业收入同比增长 18%。")).toBeInTheDocument();
    expect(screen.getByText("段落")).toBeInTheDocument();
    await waitFor(() => {
      expect(container.querySelector("img")).not.toBeNull();
    });
    expect(container.querySelector("img")).toHaveAttribute("src", "/v1/files/page-3.png");
  });

  it("renders an excel range table with the anchor cell highlighted", async () => {
    stubFetch({
      "GET /v1/projects/p-1/evidence/cell%3Axyz": traceFixture({
        evidenceId: "cell:xyz",
        kind: "cell",
        documentVersionId: "v-2",
        sheetName: "IS",
        cellRange: "B2:C3",
        cellRef: "B2",
        originalText: "净利润 1,234",
        documentVersion: {
          ...pdfVersionFixture,
          id: "v-2",
          fileType: "xlsx",
          originalFilename: "model.xlsx",
          mimeType: null,
        },
      }),
      "GET /v1/projects/p-1/evidence/cell%3Axyz/source/excel": excelRangeFixture,
    });
    renderWithQuery(
      <EvidenceViewer projectId="p-1" evidenceId="cell:xyz" onClose={() => undefined} />,
    );
    const anchorValue = await screen.findByText("1,234");
    expect(screen.getByText("5,678")).toBeInTheDocument();
    expect(anchorValue.closest("td")).toHaveStyle({ background: "#fff3cd" });
    expect(screen.getByText("5,678").closest("td")).not.toHaveStyle({
      background: "#fff3cd",
    });
  });

  it("falls back to the download link when no source view applies", async () => {
    stubFetch({
      "GET /v1/projects/p-1/evidence/chunk%3Aabc": traceFixture({
        documentVersion: {
          ...pdfVersionFixture,
          fileType: "docx",
          originalFilename: "notes.docx",
          mimeType: null,
        },
      }),
    });
    renderWithQuery(
      <EvidenceViewer projectId="p-1" evidenceId="chunk:abc" onClose={() => undefined} />,
    );
    expect(
      await screen.findByText("该证据类型暂不支持原文定位，可下载源文件查看"),
    ).toBeInTheDocument();
    expect(screen.getByText("下载").closest("a")).toHaveAttribute(
      "href",
      "/v1/projects/p-1/evidence/chunk%3Aabc/download",
    );
  });

  it("calls onClose from the modal close button", async () => {
    stubFetch({
      "GET /v1/projects/p-1/evidence/chunk%3Aabc": traceFixture({}),
    });
    const onClose = vi.fn();
    renderWithQuery(
      <EvidenceViewer projectId="p-1" evidenceId="chunk:abc" onClose={onClose} />,
    );
    await screen.findByText("2025 年营业收入同比增长 18%。");
    await userEvent.click(screen.getByLabelText("关闭"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
