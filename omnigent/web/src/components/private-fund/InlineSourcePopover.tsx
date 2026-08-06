import {
  AlertCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FileSearch,
  Loader2,
  MapPin,
  Maximize2,
  Minus,
  Plus,
  Table2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { PdfSourceSelection } from "@/shell/FileViewerContext";
import { cn } from "@/lib/utils";
import { hostFetch } from "@/lib/host";
import { readActivePrivateFundProjectId } from "@/lib/privateFundApi";

type PdfPage = {
  page_no: number;
  file_name: string;
  image_url: string;
  highlights: Array<{ x_pct: number; y_pct: number; width_pct: number; height_pct: number }>;
  matched: boolean;
};

type ExcelCell = {
  cell_ref: string;
  row_index: number;
  col_index: number;
  display_value: string | null;
  raw_value: string | null;
  formula: string | null;
};

type ExcelPayload = {
  kind: "excel";
  mode: "workbook" | "sheet" | "range";
  file_name: string;
  stored_path: string;
  range_ref?: string;
  requested_range_ref?: string;
  sheet?: { sheet_name: string; used_range: string; summary: string | null };
  sheets?: Array<{
    sheet_name: string;
    used_range: string;
    non_empty_cell_count: number;
    summary: string | null;
  }>;
  regions?: Array<{
    cell_range: string;
    region_type: string;
    non_empty_cell_count: number;
    summary: string | null;
  }>;
  cells?: ExcelCell[];
  nearby_cells?: ExcelCell[];
  empty_reason?: "requested_range_empty" | "cell_index_unavailable" | null;
  total_non_empty_cell_count?: number;
  window?: {
    row_start: number;
    col_start: number;
    truncated: boolean;
    previous_row_start: number | null;
    next_row_start: number | null;
    previous_col_start: number | null;
    next_col_start: number | null;
  };
};

type SourceState =
  | { status: "idle" | "loading" }
  | { status: "error"; message: string }
  | { status: "pdf"; page: PdfPage }
  | { status: "excel"; source: ExcelPayload };

function isExcel(source: PdfSourceSelection): boolean {
  return source.kind === "excel" || Boolean(source.workbookName);
}

function sourceRequest(
  source: PdfSourceSelection,
  excelWindow: { row?: number; col?: number } = {},
): { kind: "pdf" | "excel"; url: string } {
  if (isExcel(source)) {
    const params = new URLSearchParams();
    if (source.workbookName) params.set("workbook_name", source.workbookName);
    if (source.sheetName) params.set("sheet_name", source.sheetName);
    if (source.rangeRef) params.set("range_ref", source.rangeRef);
    if (excelWindow.row) params.set("window_row", String(excelWindow.row));
    if (excelWindow.col) params.set("window_col", String(excelWindow.col));
    const datasetId = source.datasetId || readActivePrivateFundProjectId();
    if (datasetId) params.set("dataset_id", datasetId);
    return { kind: "excel", url: `/v1/private-fund/excel/source/range?${params}` };
  }
  const params = new URLSearchParams({ page_no: String(source.pageNo ?? 1) });
  if (source.quote) params.set("quote", source.quote);
  if (source.pdfPath) params.set("pdf_path", source.pdfPath);
  if (source.pdfName) params.set("pdf_name", source.pdfName);
  if (source.evidenceId) params.set("evidence_id", source.evidenceId);
  if (source.datasetId) params.set("dataset_id", source.datasetId);
  return { kind: "pdf", url: `/v1/private-fund/pdf/source/page?${params}` };
}

function sourceLabel(source: PdfSourceSelection): string {
  if (isExcel(source)) {
    if (source.sheetName && source.rangeRef) return `${source.sheetName}!${source.rangeRef}`;
    return source.sheetName || source.workbookName || "Excel 来源";
  }
  return source.pageEnd && source.pageEnd !== source.pageNo
    ? `第 ${source.pageNo}–${source.pageEnd} 页`
    : `第 ${source.pageNo ?? 1} 页`;
}

function errorMessage(error: unknown): string {
  if (error instanceof TypeError) return "网络连接失败，无法加载引用来源。";
  return error instanceof Error ? error.message : "无法读取原始文档";
}

function ExcelOriginal({
  source,
  onNavigateWindow,
}: {
  source: ExcelPayload;
  onNavigateWindow: (row?: number, col?: number) => void;
}) {
  const cells = source.cells ?? [];
  const nearbyCells = source.nearby_cells ?? [];
  const window = source.window;
  return (
    <div className="space-y-2 p-3">
      <div className="flex items-start gap-2 rounded-lg bg-[var(--pf-panel-subtle)] p-2 text-[11px]">
        <MapPin className="mt-0.5 size-3.5 shrink-0 text-[var(--pf-accent-ink)]" />
        <div className="min-w-0">
          <p className="font-medium text-[var(--pf-ink)]">
            {source.sheet?.sheet_name || "工作簿"}
            {source.range_ref ? ` · ${source.range_ref}` : ""}
          </p>
          <p className="mt-0.5 break-all font-mono text-[9px] text-[var(--pf-ink-muted)]">
            {source.stored_path}
          </p>
        </div>
      </div>
      {source.mode === "workbook" ? (
        <div className="max-h-[48vh] overflow-auto rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)]">
          <table className="w-full border-collapse text-[10px]">
            <thead className="sticky top-0 bg-[var(--pf-panel-subtle)] text-[var(--pf-ink-secondary)]">
              <tr>
                <th className="px-2 py-1.5 text-left">工作表</th>
                <th className="px-2 py-1.5 text-left">使用范围</th>
                <th className="px-2 py-1.5 text-right">非空格</th>
              </tr>
            </thead>
            <tbody>
              {(source.sheets ?? []).map((sheet) => (
                <tr className="border-t border-[var(--pf-line)]" key={sheet.sheet_name}>
                  <td className="px-2 py-1.5 font-medium">{sheet.sheet_name}</td>
                  <td className="px-2 py-1.5 font-mono">{sheet.used_range || "空"}</td>
                  <td className="px-2 py-1.5 text-right">{sheet.non_empty_cell_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : source.mode === "sheet" ? (
        <div className="space-y-2">
          {source.sheet?.summary && (
            <p className="whitespace-pre-wrap rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] p-2 text-[10px] text-[var(--pf-ink-secondary)]">
              {source.sheet.summary}
            </p>
          )}
          <div className="max-h-[40vh] overflow-auto rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)]">
            <table className="w-full border-collapse text-[10px]">
              <thead className="sticky top-0 bg-[var(--pf-panel-subtle)] text-[var(--pf-ink-secondary)]">
                <tr>
                  <th className="px-2 py-1.5 text-left">区域</th>
                  <th className="px-2 py-1.5 text-left">类型</th>
                  <th className="px-2 py-1.5 text-right">非空格</th>
                </tr>
              </thead>
              <tbody>
                {(source.regions ?? []).map((region) => (
                  <tr
                    className="border-t border-[var(--pf-line)]"
                    key={`${region.region_type}-${region.cell_range}`}
                  >
                    <td className="px-2 py-1.5 font-mono">{region.cell_range}</td>
                    <td className="px-2 py-1.5">{region.region_type}</td>
                    <td className="px-2 py-1.5 text-right">{region.non_empty_cell_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : cells.length > 0 ? (
        <>
          {(window?.truncated || source.requested_range_ref !== source.range_ref) && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] px-2 py-1.5 text-[9px] text-[var(--pf-ink-muted)]">
              <span>
                原引用 {source.requested_range_ref ?? source.range_ref} · 当前 {source.range_ref} ·
                {cells.length}/{source.total_non_empty_cell_count ?? cells.length} 个非空格
              </span>
              {window && (
                <div className="flex items-center gap-1">
                  <ExcelWindowButton
                    disabled={window.previous_col_start == null}
                    label="查看左侧列"
                    onClick={() =>
                      onNavigateWindow(window.row_start, window.previous_col_start ?? undefined)
                    }
                  >
                    <ChevronLeft className="size-3" />
                  </ExcelWindowButton>
                  <ExcelWindowButton
                    disabled={window.previous_row_start == null}
                    label="查看上方行"
                    onClick={() =>
                      onNavigateWindow(window.previous_row_start ?? undefined, window.col_start)
                    }
                  >
                    <ChevronUp className="size-3" />
                  </ExcelWindowButton>
                  <ExcelWindowButton
                    disabled={window.next_row_start == null}
                    label="查看下方行"
                    onClick={() =>
                      onNavigateWindow(window.next_row_start ?? undefined, window.col_start)
                    }
                  >
                    <ChevronDown className="size-3" />
                  </ExcelWindowButton>
                  <ExcelWindowButton
                    disabled={window.next_col_start == null}
                    label="查看右侧列"
                    onClick={() =>
                      onNavigateWindow(window.row_start, window.next_col_start ?? undefined)
                    }
                  >
                    <ChevronRight className="size-3" />
                  </ExcelWindowButton>
                </div>
              )}
            </div>
          )}
          <div className="max-h-[48vh] overflow-auto rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)]">
            <table className="w-full border-collapse text-[10px]">
              <thead className="sticky top-0 bg-[var(--pf-panel-subtle)] text-[var(--pf-ink-secondary)]">
                <tr>
                  <th className="px-2 py-1.5 text-left">单元格</th>
                  <th className="px-2 py-1.5 text-left">原始值</th>
                  <th className="px-2 py-1.5 text-left">公式</th>
                </tr>
              </thead>
              <tbody>
                {cells.map((cell) => (
                  <tr className="border-t border-[var(--pf-line)]" key={cell.cell_ref}>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[var(--pf-accent-ink)]">
                      {cell.cell_ref}
                    </td>
                    <td className="px-2 py-1.5">{cell.display_value ?? cell.raw_value ?? ""}</td>
                    <td className="px-2 py-1.5 font-mono text-[var(--pf-ink-muted)]">
                      {cell.formula ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="rounded-lg border border-dashed p-3 text-xs text-[var(--pf-ink-muted)]">
          <p>
            {source.empty_reason === "cell_index_unavailable"
              ? "该工作表有内容，但缺少逐格索引；请重新运行索引。"
              : "引用范围内没有非空单元格。"}
          </p>
          {nearbyCells.length > 0 && (
            <div className="mt-2 max-h-40 overflow-auto rounded border border-[var(--pf-line)] bg-[var(--pf-panel-raised)]">
              {nearbyCells.map((cell) => (
                <div
                  className="grid grid-cols-[64px_1fr] gap-2 border-t border-[var(--pf-line)] px-2 py-1 first:border-t-0"
                  key={cell.cell_ref}
                >
                  <span className="font-mono text-[var(--pf-accent-ink)]">{cell.cell_ref}</span>
                  <span>{cell.display_value ?? cell.raw_value ?? cell.formula ?? ""}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ExcelWindowButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: React.ReactNode;
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="rounded border border-[var(--pf-line)] bg-[var(--pf-panel)] p-0.5 text-[var(--pf-ink)] hover:bg-[var(--pf-panel-subtle)] disabled:opacity-30"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

export function InlineSourcePopover({
  source,
  href,
  children,
  className,
  presentation = "popover",
}: {
  source: PdfSourceSelection;
  href?: string;
  children: React.ReactNode;
  className?: string;
  presentation?: "popover" | "dialog";
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SourceState>({ status: "idle" });
  const [retryKey, setRetryKey] = useState(0);
  const [pdfZoom, setPdfZoom] = useState(1);
  const [excelWindow, setExcelWindow] = useState<{ row?: number; col?: number }>({});
  const triggerRef = useRef<HTMLAnchorElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const request = useMemo(() => sourceRequest(source, excelWindow), [excelWindow, source]);

  useEffect(() => setExcelWindow({}), [source.workbookName, source.sheetName, source.rangeRef]);
  useEffect(() => setPdfZoom(1), [source.evidenceId, source.pageNo, source.pdfName]);

  useEffect(() => {
    if (!open || presentation === "dialog") return;

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const eventPath = event.composedPath();
      if (
        (triggerRef.current && eventPath.includes(triggerRef.current)) ||
        (contentRef.current && eventPath.includes(contentRef.current))
      ) {
        return;
      }
      setOpen(false);
    };

    // The workflow canvas stops pointer events while handling node selection and
    // panning. Capture at window level so clicking anywhere on that canvas still
    // dismisses this independently portalled popover.
    window.addEventListener("pointerdown", closeOnOutsidePointerDown, true);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointerDown, true);
  }, [open, presentation]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    hostFetch(request.url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { detail?: string } | null;
          if (response.status === 403) {
            throw new Error("没有权限读取该引用文件，请确认项目访问权限。");
          }
          if (response.status === 404) {
            throw new Error("引用文件不存在或已被删除，请前往资料管理确认文件状态。");
          }
          if (response.status >= 500) {
            throw new Error("引用来源服务暂时不可用，请稍后重试。");
          }
          throw new Error(payload?.detail || response.statusText || "无法读取原始文档");
        }
        return response.json() as Promise<PdfPage | ExcelPayload>;
      })
      .then((payload) =>
        setState(
          request.kind === "pdf"
            ? { status: "pdf", page: payload as PdfPage }
            : { status: "excel", source: payload as ExcelPayload },
        ),
      )
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", message: errorMessage(error) });
      });
    return () => controller.abort();
  }, [open, request.kind, request.url, retryKey]);

  if (presentation === "dialog") {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <button
            className={className}
            data-source-citation="true"
            title="点击查看原始文档"
            type="button"
          >
            {children}
          </button>
        </DialogTrigger>
        <DialogContent className="flex h-[max(360px,calc(100dvh-400px))] w-[max(640px,calc(100vw-400px))] max-w-none flex-col gap-0 overflow-hidden rounded-lg p-0 sm:max-w-none">
          <DialogHeader className="shrink-0 border-b border-[var(--pf-line)] px-4 py-3 pr-12">
            <div className="flex min-w-0 items-center gap-2">
              {isExcel(source) ? (
                <Table2 className="size-4 shrink-0 text-[var(--pf-accent-ink)]" />
              ) : (
                <FileSearch className="size-4 shrink-0 text-[var(--pf-accent-ink)]" />
              )}
              <DialogTitle className="text-sm">原始文档</DialogTitle>
              {state.status === "pdf" && (
                <div
                  aria-label="PDF 缩放控制"
                  className="ml-auto flex items-center gap-1 rounded-md border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] p-0.5"
                  role="group"
                >
                  <button
                    aria-label="缩小 PDF"
                    className="rounded p-1.5 hover:bg-[var(--pf-panel-subtle)] disabled:opacity-35"
                    disabled={pdfZoom <= 0.75}
                    onClick={() => setPdfZoom((value) => Math.max(0.75, value - 0.25))}
                    type="button"
                  >
                    <Minus className="size-3.5" />
                  </button>
                  <span className="w-11 text-center text-[10px] tabular-nums text-[var(--pf-ink-secondary)]">
                    {Math.round(pdfZoom * 100)}%
                  </span>
                  <button
                    aria-label="放大 PDF"
                    className="rounded p-1.5 hover:bg-[var(--pf-panel-subtle)] disabled:opacity-35"
                    disabled={pdfZoom >= 2.5}
                    onClick={() => setPdfZoom((value) => Math.min(2.5, value + 0.25))}
                    type="button"
                  >
                    <Plus className="size-3.5" />
                  </button>
                  <button
                    aria-label="适合窗口宽度"
                    className="rounded p-1.5 hover:bg-[var(--pf-panel-subtle)]"
                    onClick={() => setPdfZoom(1)}
                    title="适合窗口宽度"
                    type="button"
                  >
                    <Maximize2 className="size-3.5" />
                  </button>
                </div>
              )}
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[9px]",
                  state.status !== "pdf" && "ml-auto",
                  (state.status === "idle" || state.status === "loading") &&
                    "bg-[var(--pf-panel-subtle)] text-[var(--pf-ink-muted)]",
                  (state.status === "pdf" || state.status === "excel") &&
                    "bg-emerald-500/10 text-emerald-700",
                  state.status === "error" && "bg-red-500/10 text-red-700",
                )}
                role="status"
              >
                {state.status === "idle" || state.status === "loading"
                  ? "加载中"
                  : state.status === "pdf" || state.status === "excel"
                    ? "加载成功"
                    : "加载失败"}
              </span>
            </div>
            <DialogDescription className="truncate text-[11px]">
              {source.pdfName || source.workbookName || "项目资料"} · {sourceLabel(source)}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto bg-[var(--pf-panel-subtle)]">
            {(state.status === "idle" || state.status === "loading") && (
              <div
                aria-live="polite"
                className="flex h-full min-h-44 items-center justify-center gap-2 text-xs text-[var(--pf-ink-muted)]"
                role="status"
              >
                <Loader2 className="size-4 animate-spin" />
                正在读取原始文档…
              </div>
            )}
            {state.status === "error" && (
              <div className="min-h-32 space-y-3 p-4 text-xs" role="alert">
                <div className="flex items-start gap-2 text-red-700">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span className="break-words">{state.message}</span>
                </div>
                <div className="flex flex-wrap gap-2 pl-6">
                  <button
                    className="rounded-md border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] px-2.5 py-1 text-[var(--pf-ink)] hover:bg-[var(--pf-panel-subtle)]"
                    onClick={() => setRetryKey((value) => value + 1)}
                    type="button"
                  >
                    重试加载
                  </button>
                  <a
                    className="rounded-md px-2.5 py-1 text-[var(--pf-accent-ink)] hover:bg-[var(--pf-panel-subtle)] hover:underline"
                    href={`/?private_fund_project=${encodeURIComponent(source.datasetId || readActivePrivateFundProjectId() || "")}`}
                  >
                    前往资料管理
                  </a>
                </div>
              </div>
            )}
            {state.status === "pdf" && (
              <div className="min-w-full p-2 sm:p-3">
                <div
                  className="relative overflow-hidden rounded-lg border border-[var(--pf-line)] bg-white shadow-sm"
                  data-pdf-page-container="true"
                  style={{ width: `${pdfZoom * 100}%` }}
                >
                  <img
                    alt={`${state.page.file_name} 第 ${state.page.page_no} 页`}
                    className="block h-auto w-full select-none"
                    src={state.page.image_url}
                  />
                  {state.page.matched &&
                    state.page.highlights.map((highlight, index) => (
                      <span
                        aria-hidden
                        className="pointer-events-none absolute rounded-sm border border-amber-500/80 bg-amber-300/35"
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
            {state.status === "excel" && (
              <ExcelOriginal
                onNavigateWindow={(row, col) => setExcelWindow({ row, col })}
                source={state.source}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <a
          className={className}
          data-source-citation="true"
          href={href}
          onClick={(event) => {
            event.preventDefault();
            setOpen((current) => !current);
          }}
          ref={triggerRef}
          title="点击查看原始文档"
        >
          {children}
        </a>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(560px,calc(100vw-24px))] gap-0 overflow-hidden p-0"
        sideOffset={8}
      >
        <div className="contents" ref={contentRef}>
          <PopoverHeader className="border-b border-[var(--pf-line)] px-3 py-2.5">
            <PopoverTitle className="flex items-center gap-2 text-xs">
              {isExcel(source) ? (
                <Table2 className="size-4 text-[var(--pf-accent-ink)]" />
              ) : (
                <FileSearch className="size-4 text-[var(--pf-accent-ink)]" />
              )}
              原始文档
            </PopoverTitle>
            <PopoverDescription className="truncate text-[10px]">
              {source.pdfName || source.workbookName || "项目资料"} · {sourceLabel(source)}
            </PopoverDescription>
            <span
              className={cn(
                "ml-auto rounded-full px-2 py-0.5 text-[9px]",
                (state.status === "idle" || state.status === "loading") &&
                  "bg-[var(--pf-panel-subtle)] text-[var(--pf-ink-muted)]",
                (state.status === "pdf" || state.status === "excel") &&
                  "bg-emerald-500/10 text-emerald-700",
                state.status === "error" && "bg-red-500/10 text-red-700",
              )}
              role="status"
            >
              {state.status === "idle" || state.status === "loading"
                ? "加载中"
                : state.status === "pdf" || state.status === "excel"
                  ? "加载成功"
                  : "加载失败"}
            </span>
          </PopoverHeader>
          <div className="max-h-[68vh] overflow-auto bg-[var(--pf-panel-subtle)]">
            {(state.status === "idle" || state.status === "loading") && (
              <div
                role="status"
                aria-live="polite"
                className="flex h-44 items-center justify-center gap-2 text-xs text-[var(--pf-ink-muted)]"
              >
                <Loader2 className="size-4 animate-spin" />
                正在读取原始文档…
              </div>
            )}
            {state.status === "error" && (
              <div role="alert" className="min-h-32 space-y-3 p-4 text-xs">
                <div className="flex items-start gap-2 text-red-700">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span className="break-words">{state.message}</span>
                </div>
                <div className="flex flex-wrap gap-2 pl-6">
                  <button
                    type="button"
                    className="rounded-md border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] px-2.5 py-1 text-[var(--pf-ink)] hover:bg-[var(--pf-panel-subtle)]"
                    onClick={() => setRetryKey((value) => value + 1)}
                  >
                    重试加载
                  </button>
                  <a
                    className="rounded-md px-2.5 py-1 text-[var(--pf-accent-ink)] hover:bg-[var(--pf-panel-subtle)] hover:underline"
                    href={`/?private_fund_project=${encodeURIComponent(source.datasetId || readActivePrivateFundProjectId() || "")}`}
                  >
                    前往资料管理
                  </a>
                </div>
              </div>
            )}
            {state.status === "pdf" && (
              <div className="p-2.5">
                <div className="relative overflow-hidden rounded-lg border border-[var(--pf-line)] bg-white shadow-sm">
                  <img
                    alt={`${state.page.file_name} 第 ${state.page.page_no} 页`}
                    className="block h-auto w-full select-none"
                    src={state.page.image_url}
                  />
                  {state.page.matched &&
                    state.page.highlights.map((highlight, index) => (
                      <span
                        aria-hidden
                        className={cn(
                          "pointer-events-none absolute rounded-sm border border-amber-500/80 bg-amber-300/35",
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
            {state.status === "excel" && (
              <ExcelOriginal
                onNavigateWindow={(row, col) => setExcelWindow({ row, col })}
                source={state.source}
              />
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
