import { AlertCircleIcon, FileSearchIcon, Loader2, Table2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { PdfSourceSelection } from "./FileViewerContext";

interface PdfSourceHighlight {
  x_pct: number;
  y_pct: number;
  width_pct: number;
  height_pct: number;
}

interface PdfSourcePage {
  page_no: number;
  file_name: string;
  image_url: string;
  image_width: number;
  image_height: number;
  highlights: PdfSourceHighlight[];
  matched: boolean;
}

interface ExcelSourceSheet {
  sheet_name: string;
  sheet_role: string;
  used_range: string;
  row_count: number;
  col_count: number;
  non_empty_cell_count: number;
  formula_count: number;
  formula_density: number;
  summary: string | null;
}

interface ExcelSourceRegion {
  region_type: string;
  cell_range: string;
  row_count: number;
  col_count: number;
  non_empty_cell_count: number;
  formula_count: number;
  summary: string | null;
}

interface ExcelSourceCell {
  cell_ref: string;
  row_index: number;
  col_index: number;
  display_value: string | null;
  raw_value: string | null;
  formula: string | null;
  cached_value: string | null;
  row_label: string | null;
  col_label: string | null;
  period: string | null;
  unit: string | null;
  is_formula: boolean;
}

interface ExcelSourcePayload {
  kind: "excel";
  mode: "workbook" | "sheet" | "range";
  file_name: string;
  stored_path: string;
  sheet?: ExcelSourceSheet;
  sheets?: ExcelSourceSheet[];
  regions?: ExcelSourceRegion[];
  range_ref?: string;
  row_min?: number;
  row_max?: number;
  col_min?: number;
  col_max?: number;
  column_labels?: string[];
  cells?: ExcelSourceCell[];
}

type PdfSourceState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready-pdf"; page: PdfSourcePage }
  | { status: "ready-excel"; source: ExcelSourcePayload };

function isExcelSelection(selection: PdfSourceSelection): boolean {
  return selection.kind === "excel" || !!selection.workbookName;
}

function buildPdfSourceUrl(selection: PdfSourceSelection): string {
  const params = new URLSearchParams({ page_no: String(selection.pageNo ?? 1) });
  if (selection.quote) params.set("quote", selection.quote);
  if (selection.pdfPath) params.set("pdf_path", selection.pdfPath);
  if (selection.pdfName) params.set("pdf_name", selection.pdfName);
  if (selection.evidenceId) params.set("evidence_id", selection.evidenceId);
  if (selection.datasetId) params.set("dataset_id", selection.datasetId);
  return `/v1/private-fund/pdf/source/page?${params.toString()}`;
}

function buildExcelSourceUrl(selection: PdfSourceSelection): string {
  const params = new URLSearchParams();
  if (selection.workbookName) params.set("workbook_name", selection.workbookName);
  if (selection.sheetName) params.set("sheet_name", selection.sheetName);
  if (selection.rangeRef) params.set("range_ref", selection.rangeRef);
  if (selection.datasetId) params.set("dataset_id", selection.datasetId);
  return `/v1/private-fund/excel/source/range?${params.toString()}`;
}

function buildSourceRequest(selection: PdfSourceSelection): { kind: "pdf" | "excel"; url: string } {
  return isExcelSelection(selection)
    ? { kind: "excel", url: buildExcelSourceUrl(selection) }
    : { kind: "pdf", url: buildPdfSourceUrl(selection) };
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return "Could not render source.";
}

export function PdfSourcePanel({ selection }: { selection: PdfSourceSelection | null }) {
  const [state, setState] = useState<PdfSourceState>({ status: "idle" });
  const request = useMemo(() => (selection ? buildSourceRequest(selection) : null), [selection]);

  useEffect(() => {
    if (!request) {
      setState({ status: "idle" });
      return;
    }

    const controller = new AbortController();
    setState({ status: "loading" });
    fetch(request.url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          let detail = response.statusText;
          try {
            const payload = (await response.json()) as { detail?: string };
            detail = payload.detail || detail;
          } catch {
            // Keep the HTTP status text fallback.
          }
          throw new Error(detail);
        }
        return request.kind === "excel"
          ? (response.json() as Promise<ExcelSourcePayload>)
          : (response.json() as Promise<PdfSourcePage>);
      })
      .then((payload) => {
        if (request.kind === "excel") {
          setState({ status: "ready-excel", source: payload as ExcelSourcePayload });
        } else {
          setState({ status: "ready-pdf", page: payload as PdfSourcePage });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: errorMessage(error) });
      });

    return () => controller.abort();
  }, [request]);

  const pageLabel =
    selection?.label ??
    (selection
      ? isExcelSelection(selection)
        ? selection.rangeRef
          ? `${selection.sheetName ?? "Sheet"}!${selection.rangeRef}`
          : selection.sheetName ?? selection.workbookName ?? "Excel source"
        : selection.pageEnd && selection.pageNo && selection.pageEnd !== selection.pageNo
          ? `p.${selection.pageNo}-${selection.pageEnd}`
          : `p.${selection.pageNo ?? 1}`
      : "Source");
  const isExcel = !!selection && isExcelSelection(selection);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        {isExcel ? (
          <Table2 className="size-4 text-muted-foreground" />
        ) : (
          <FileSearchIcon className="size-4 text-muted-foreground" />
        )}
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{pageLabel}</div>
          {state.status === "ready-pdf" && (
            <div className="truncate text-xs text-muted-foreground">{state.page.file_name}</div>
          )}
          {state.status === "ready-excel" && (
            <div className="truncate text-xs text-muted-foreground">{state.source.file_name}</div>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-muted/20">
        {state.status === "idle" && (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            No source selected
          </div>
        )}

        {state.status === "loading" && (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Rendering source
          </div>
        )}

        {state.status === "error" && (
          <div className="flex h-full items-center justify-center px-4">
            <div className="flex max-w-sm items-start gap-2 text-sm text-destructive">
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 break-words">{state.message}</span>
            </div>
          </div>
        )}

        {state.status === "ready-pdf" && (
          <div className="mx-auto w-full max-w-[920px] p-3">
            <div className="relative overflow-hidden rounded-md border border-border bg-background">
              <img
                alt={`${state.page.file_name} page ${state.page.page_no}`}
                className="block h-auto w-full select-none"
                src={state.page.image_url}
              />
              {state.page.highlights.map((highlight, index) => (
                <div
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute rounded-[2px] border border-amber-500/80 bg-amber-300/35 shadow-[0_0_0_1px_rgba(245,158,11,0.18)]",
                    !state.page.matched && "hidden",
                  )}
                  key={`${highlight.x_pct}-${highlight.y_pct}-${index}`}
                  style={{
                    left: `${highlight.x_pct}%`,
                    top: `${highlight.y_pct}%`,
                    width: `${highlight.width_pct}%`,
                    height: `${highlight.height_pct}%`,
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {state.status === "ready-excel" && <ExcelSourceView source={state.source} />}
      </div>
    </div>
  );
}

function ExcelSourceView({ source }: { source: ExcelSourcePayload }) {
  if (source.mode === "range" && source.sheet && source.cells) {
    return <ExcelRangeView source={source} />;
  }

  if (source.mode === "sheet" && source.sheet) {
    return (
      <div className="p-3">
        <ExcelSheetSummary sheet={source.sheet} />
        {(source.regions ?? []).length > 0 && (
          <div className="mt-4 overflow-auto rounded-md border border-border bg-background">
            <table className="min-w-full border-collapse text-xs">
              <thead className="bg-muted/60 text-muted-foreground">
                <tr>
                  <th className="border-b border-border px-2 py-1.5 text-left font-medium">Range</th>
                  <th className="border-b border-border px-2 py-1.5 text-left font-medium">Type</th>
                  <th className="border-b border-border px-2 py-1.5 text-right font-medium">Cells</th>
                  <th className="border-b border-border px-2 py-1.5 text-left font-medium">Summary</th>
                </tr>
              </thead>
              <tbody>
                {(source.regions ?? []).map((region) => (
                  <tr key={`${region.region_type}-${region.cell_range}`} className="border-t border-border/70">
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono">{region.cell_range}</td>
                    <td className="whitespace-nowrap px-2 py-1.5">{region.region_type}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right">
                      {region.non_empty_cell_count}
                    </td>
                    <td className="min-w-[220px] px-2 py-1.5 text-muted-foreground">
                      {region.summary}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-3">
      <div className="overflow-auto rounded-md border border-border bg-background">
        <table className="min-w-full border-collapse text-xs">
          <thead className="bg-muted/60 text-muted-foreground">
            <tr>
              <th className="border-b border-border px-2 py-1.5 text-left font-medium">Sheet</th>
              <th className="border-b border-border px-2 py-1.5 text-left font-medium">Role</th>
              <th className="border-b border-border px-2 py-1.5 text-left font-medium">Used Range</th>
              <th className="border-b border-border px-2 py-1.5 text-right font-medium">Cells</th>
              <th className="border-b border-border px-2 py-1.5 text-left font-medium">Summary</th>
            </tr>
          </thead>
          <tbody>
            {(source.sheets ?? []).map((sheet) => (
              <tr key={sheet.sheet_name} className="border-t border-border/70">
                <td className="whitespace-nowrap px-2 py-1.5 font-medium">{sheet.sheet_name}</td>
                <td className="whitespace-nowrap px-2 py-1.5">{sheet.sheet_role}</td>
                <td className="whitespace-nowrap px-2 py-1.5 font-mono">{sheet.used_range}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right">
                  {sheet.non_empty_cell_count}
                </td>
                <td className="min-w-[220px] px-2 py-1.5 text-muted-foreground">{sheet.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ExcelSheetSummary({ sheet }: { sheet: ExcelSourceSheet }) {
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <div className="text-sm font-medium text-foreground">{sheet.sheet_name}</div>
      <div>
        {sheet.sheet_role} · {sheet.used_range} · {sheet.non_empty_cell_count} cells ·{" "}
        {sheet.formula_count} formulas
      </div>
      {sheet.summary && <div className="whitespace-pre-wrap">{sheet.summary}</div>}
    </div>
  );
}

function ExcelRangeView({ source }: { source: ExcelSourcePayload }) {
  const rowMin = source.row_min ?? 1;
  const rowMax = source.row_max ?? rowMin;
  const colMin = source.col_min ?? 1;
  const colMax = source.col_max ?? colMin;
  const cells = new Map<string, ExcelSourceCell>();
  for (const cell of source.cells ?? []) {
    cells.set(`${cell.row_index}:${cell.col_index}`, cell);
  }
  const columnLabels = source.column_labels ?? [];
  const rows = Array.from({ length: rowMax - rowMin + 1 }, (_, index) => rowMin + index);
  const cols = Array.from({ length: colMax - colMin + 1 }, (_, index) => colMin + index);

  return (
    <div className="flex min-h-full flex-col p-3">
      {source.sheet && <ExcelSheetSummary sheet={source.sheet} />}
      <div className="mt-3 min-h-0 overflow-auto rounded-md border border-border bg-background">
        <table className="min-w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-muted text-muted-foreground">
            <tr>
              <th className="sticky left-0 z-20 w-12 border-r border-b border-border bg-muted px-2 py-1.5 text-right font-medium">
                #
              </th>
              {cols.map((colIndex, index) => (
                <th
                  className="min-w-[92px] border-r border-b border-border px-2 py-1.5 text-center font-medium last:border-r-0"
                  key={colIndex}
                >
                  {columnLabels[index] ?? colIndex}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((rowIndex) => (
              <tr key={rowIndex} className="border-t border-border/70">
                <th className="sticky left-0 border-r border-border bg-muted/70 px-2 py-1.5 text-right font-medium text-muted-foreground">
                  {rowIndex}
                </th>
                {cols.map((colIndex) => {
                  const cell = cells.get(`${rowIndex}:${colIndex}`);
                  const value = cellDisplayValue(cell);
                  return (
                    <td
                      className={cn(
                        "max-w-[240px] border-r border-border/70 px-2 py-1.5 align-top last:border-r-0",
                        cell?.is_formula && "bg-amber-50/45 dark:bg-amber-950/15",
                      )}
                      key={colIndex}
                      title={cellTitle(cell)}
                    >
                      <div className="min-h-4 whitespace-pre-wrap break-words">
                        {value || <span aria-hidden>&nbsp;</span>}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function cellDisplayValue(cell: ExcelSourceCell | undefined): string {
  if (!cell) return "";
  return cell.display_value ?? cell.cached_value ?? cell.raw_value ?? "";
}

function cellTitle(cell: ExcelSourceCell | undefined): string | undefined {
  if (!cell) return undefined;
  const lines = [cell.cell_ref];
  if (cell.formula) lines.push(`Formula: ${cell.formula}`);
  if (cell.row_label) lines.push(`Row: ${cell.row_label}`);
  if (cell.col_label) lines.push(`Column: ${cell.col_label}`);
  if (cell.period) lines.push(`Period: ${cell.period}`);
  if (cell.unit) lines.push(`Unit: ${cell.unit}`);
  return lines.join("\n");
}
