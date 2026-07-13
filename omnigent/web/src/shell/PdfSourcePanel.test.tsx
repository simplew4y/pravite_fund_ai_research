import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PdfSourcePanel } from "./PdfSourcePanel";

const sheet = {
  sheet_name: "Table",
  sheet_role: "data",
  used_range: "A1:B2",
  row_count: 2,
  col_count: 2,
  non_empty_cell_count: 4,
  formula_count: 1,
  formula_density: 0.25,
  summary: "核心财务数据",
};

describe("PdfSourcePanel Excel explorer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("drills from workbook to sheet, region, and cells", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const params = new URL(url, "http://localhost").searchParams;
      const rangeRef = params.get("range_ref");
      const sheetName = params.get("sheet_name");
      const payload = rangeRef
        ? {
            kind: "excel",
            mode: "range",
            file_name: "300274 v44.xlsx",
            stored_path: "/dataset/raw/300274 v44.xlsx",
            sheet,
            range_ref: rangeRef,
            row_min: 1,
            row_max: 2,
            col_min: 1,
            col_max: 2,
            column_labels: ["A", "B"],
            cells: [
              {
                cell_ref: "B2",
                row_index: 2,
                col_index: 2,
                display_value: "31.4%",
                raw_value: "0.314",
                formula: "=B1/A1",
                cached_value: "0.314",
                row_label: "毛利率",
                col_label: "2026Q1",
                period: "2026Q1",
                unit: "%",
                is_formula: true,
              },
            ],
          }
        : sheetName
          ? {
              kind: "excel",
              mode: "sheet",
              file_name: "300274 v44.xlsx",
              stored_path: "/dataset/raw/300274 v44.xlsx",
              sheet,
              regions: [
                {
                  region_type: "table",
                  cell_range: "A1:B2",
                  row_count: 2,
                  col_count: 2,
                  non_empty_cell_count: 4,
                  formula_count: 1,
                  summary: "毛利率表",
                },
              ],
            }
          : {
              kind: "excel",
              mode: "workbook",
              file_name: "300274 v44.xlsx",
              stored_path: "/dataset/raw/300274 v44.xlsx",
              sheets: [sheet],
            };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <PdfSourcePanel
        selection={{
          kind: "excel",
          workbookName: "300274 v44.xlsx",
          datasetId: "阳光电源",
        }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Table" }));
    await waitFor(() =>
      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("sheet_name=Table"),
    );
    fireEvent.click(await screen.findByRole("button", { name: "A1:B2" }));
    expect(await screen.findByText("31.4%")).toBeInTheDocument();
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("range_ref=A1%3AB2");
    expect(screen.getByRole("button", { name: "返回工作表" })).toBeInTheDocument();
  });

  it("pages through a large cited range instead of failing the render", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const params = new URL(url, "http://localhost").searchParams;
      const windowRow = params.get("window_row");
      const secondPage = windowRow === "109";
      return new Response(
        JSON.stringify({
          kind: "excel",
          mode: "range",
          file_name: "large-model.xlsm",
          stored_path: "/dataset/raw/large-model.xlsm",
          sheet: { ...sheet, sheet_name: "Hermes in Charts", used_range: "A1:AK213" },
          requested_range_ref: "A1:AK213",
          range_ref: secondPage ? "A106:AK213" : "A1:AK108",
          row_min: secondPage ? 106 : 1,
          row_max: secondPage ? 213 : 108,
          col_min: 1,
          col_max: 37,
          column_labels: Array.from({ length: 37 }, (_, index) => String(index + 1)),
          total_non_empty_cell_count: 2,
          cells: [
            {
              cell_ref: secondPage ? "AK213" : "A1",
              row_index: secondPage ? 213 : 1,
              col_index: secondPage ? 37 : 1,
              display_value: secondPage ? "Tail" : "Header",
              raw_value: secondPage ? "Tail" : "Header",
              formula: null,
              cached_value: null,
              row_label: null,
              col_label: null,
              period: null,
              unit: null,
              is_formula: false,
            },
          ],
          window: {
            row_start: secondPage ? 106 : 1,
            row_end: secondPage ? 213 : 108,
            col_start: 1,
            col_end: 37,
            row_count: 108,
            col_count: 37,
            truncated: true,
            display_range_ref: secondPage ? "A106:AK213" : "A1:AK108",
            previous_row_start: secondPage ? 1 : null,
            next_row_start: secondPage ? null : 109,
            previous_col_start: null,
            next_col_start: null,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <PdfSourcePanel
        selection={{
          kind: "excel",
          workbookName: "large-model.xlsm",
          sheetName: "Hermes in Charts",
          rangeRef: "A1:AK213",
          datasetId: "新项目",
        }}
      />,
    );

    expect(await screen.findByText("Header")).toBeInTheDocument();
    expect(screen.getByText(/原引用 A1:AK213 · 当前显示 A1:AK108/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看下方行" }));
    expect(await screen.findByText("Tail")).toBeInTheDocument();
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("window_row=109");
  });
});
