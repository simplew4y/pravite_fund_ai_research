import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";

import {
  evidenceDownloadUrl,
  fetchEvidence,
  fetchExcelSource,
  fetchPdfSourcePage,
} from "../../api/research";
import type { ExcelSourcePayload, ResearchEvidenceTrace } from "../../api/research";
import { Modal } from "../../components/Modal";
import { MonoLabel } from "../../components/MonoLabel";
import type { DictKey } from "../../i18n/dict";
import { useT } from "../../i18n/useT";

const KIND_LABEL: Record<ResearchEvidenceTrace["kind"], DictKey> = {
  chunk: "evidence.kind.chunk",
  fact: "evidence.kind.fact",
  cell: "evidence.kind.cell",
  page: "evidence.kind.page",
};

type ExcelRangePayload = Extract<ExcelSourcePayload, { mode: "range" }>;
type ExcelCell = ExcelRangePayload["cells"][number];
type ExcelSheet = Extract<ExcelSourcePayload, { mode: "workbook" }>["sheets"][number];

function DownloadLink({ projectId, evidenceId }: { projectId: string; evidenceId: string }) {
  const { t } = useT();
  return (
    <a
      className="btn btn-secondary"
      href={evidenceDownloadUrl(projectId, evidenceId)}
      target="_blank"
      rel="noopener"
    >
      <Download size={14} /> {t("common.download")}
    </a>
  );
}

/** Source failures (e.g. 503 compute_unavailable) degrade to a download link. */
function SourceError({ projectId, evidenceId }: { projectId: string; evidenceId: string }) {
  const { t } = useT();
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <p className="error-text" style={{ margin: 0 }}>
        {t("common.error")}
      </p>
      <DownloadLink projectId={projectId} evidenceId={evidenceId} />
    </div>
  );
}

function PdfSourceView({
  projectId,
  evidenceId,
  pageNumber,
  quote,
}: {
  projectId: string;
  evidenceId: string;
  pageNumber: number;
  quote: string;
}) {
  const { t } = useT();
  const page = useQuery({
    queryKey: ["evidence-pdf", projectId, evidenceId, pageNumber],
    queryFn: () => fetchPdfSourcePage(projectId, evidenceId, pageNumber, quote),
  });

  if (page.isPending) return <p className="text-muted">{t("common.loading")}</p>;
  if (page.isError) return <SourceError projectId={projectId} evidenceId={evidenceId} />;

  return (
    <div style={{ position: "relative" }}>
      <img src={page.data.imageUrl} style={{ width: "100%" }} alt="" />
      {page.data.highlights.map((highlight, index) => (
        <div
          key={index}
          style={{
            position: "absolute",
            left: `${String(highlight.xPct)}%`,
            top: `${String(highlight.yPct)}%`,
            width: `${String(highlight.widthPct)}%`,
            height: `${String(highlight.heightPct)}%`,
            background: "rgba(255,193,7,0.35)",
            border: "1px solid rgba(255,152,0,0.8)",
            pointerEvents: "none",
          }}
        />
      ))}
    </div>
  );
}

function SheetSummaryRow({ sheet }: { sheet: ExcelSheet }) {
  return (
    <div className="doc-row">
      <span className="title">{sheet.sheetName}</span>
      <MonoLabel>{sheet.usedRange ?? ""}</MonoLabel>
      <span className="text-muted">{sheet.nonEmptyCellCount}</span>
    </div>
  );
}

function ExcelRangeTable({ payload }: { payload: ExcelRangePayload }) {
  const rows = new Map<number, Map<number, ExcelCell>>();
  for (const cell of payload.cells) {
    const row = rows.get(cell.rowIndex) ?? new Map<number, ExcelCell>();
    row.set(cell.columnIndex, cell);
    rows.set(cell.rowIndex, row);
  }
  const rowIndexes = [...rows.keys()].sort((a, b) => a - b);

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>
            {payload.columnLabels.map((label, columnOffset) => (
              <th
                key={payload.columnMin + columnOffset}
                style={{ padding: "2px 8px", textAlign: "left" }}
              >
                <MonoLabel>{label}</MonoLabel>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowIndexes.map((rowIndex) => {
            const row = rows.get(rowIndex);
            return (
              <tr key={rowIndex}>
                {payload.columnLabels.map((_label, columnOffset) => {
                  const columnIndex = payload.columnMin + columnOffset;
                  const cell = row?.get(columnIndex);
                  const isAnchor =
                    cell !== undefined && cell.evidenceId === payload.anchorEvidenceId;
                  return (
                    <td
                      key={columnIndex}
                      style={{
                        padding: "2px 8px",
                        ...(isAnchor ? { background: "#fff3cd" } : {}),
                      }}
                    >
                      {cell ? cell.displayValue ?? cell.rawValue ?? "" : ""}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ExcelSourceView({
  projectId,
  evidenceId,
  trace,
}: {
  projectId: string;
  evidenceId: string;
  trace: ResearchEvidenceTrace;
}) {
  const { t } = useT();
  const sheetName = trace.sheetName;
  const rangeRef = trace.cellRange ?? trace.cellRef;
  const source = useQuery({
    queryKey: ["evidence-excel", projectId, evidenceId, sheetName, rangeRef],
    queryFn: () =>
      fetchExcelSource(projectId, evidenceId, {
        ...(sheetName ? { sheetName } : {}),
        ...(rangeRef ? { rangeRef } : {}),
      }),
  });

  if (source.isPending) return <p className="text-muted">{t("common.loading")}</p>;
  if (source.isError) return <SourceError projectId={projectId} evidenceId={evidenceId} />;

  const payload = source.data;
  if (payload.mode === "range") return <ExcelRangeTable payload={payload} />;
  if (payload.mode === "workbook") {
    return (
      <div>
        {payload.sheets.map((sheet) => (
          <SheetSummaryRow key={sheet.sheetName} sheet={sheet} />
        ))}
        {payload.sheets.length === 0 ? <p className="text-muted">{t("common.empty")}</p> : null}
      </div>
    );
  }
  return <SheetSummaryRow sheet={payload.sheet} />;
}

function TraceBody({
  projectId,
  evidenceId,
  trace,
}: {
  projectId: string;
  evidenceId: string;
  trace: ResearchEvidenceTrace;
}) {
  const { t } = useT();
  const pageNumber =
    trace.pageStart ?? trace.locator.pageStart ?? trace.locator.pageNumbers?.[0];

  const locatorParts: string[] = [];
  if (pageNumber !== undefined) {
    locatorParts.push(`${t("evidence.page")} ${String(pageNumber)}`);
  }
  if (trace.sheetName) locatorParts.push(`${t("evidence.sheet")} ${trace.sheetName}`);
  const range = trace.cellRange ?? trace.cellRef;
  if (range) locatorParts.push(range);

  function renderSource() {
    if (trace.documentVersion.fileType === "pdf" && pageNumber !== undefined) {
      return (
        <PdfSourceView
          projectId={projectId}
          evidenceId={evidenceId}
          pageNumber={pageNumber}
          quote={trace.originalText.slice(0, 600)}
        />
      );
    }
    if (trace.kind === "cell" || trace.sheetName) {
      return <ExcelSourceView projectId={projectId} evidenceId={evidenceId} trace={trace} />;
    }
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <p className="text-muted" style={{ margin: 0 }}>
          {t("evidence.noPreview")}
        </p>
        <DownloadLink projectId={projectId} evidenceId={evidenceId} />
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className="tag tag-neutral">{t(KIND_LABEL[trace.kind])}</span>
        <span style={{ fontWeight: 600 }}>{trace.document.title}</span>
        {locatorParts.length > 0 ? <MonoLabel>{locatorParts.join(" · ")}</MonoLabel> : null}
      </div>
      <pre style={{ whiteSpace: "pre-wrap" }}>{trace.originalText}</pre>
      {renderSource()}
    </div>
  );
}

export function EvidenceViewer({
  projectId,
  evidenceId,
  onClose,
}: {
  projectId: string;
  evidenceId: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const trace = useQuery({
    queryKey: ["evidence", projectId, evidenceId],
    queryFn: () => fetchEvidence(projectId, evidenceId),
  });

  return (
    <Modal title={t("evidence.viewer")} onClose={onClose} wide>
      {trace.isPending ? <p className="text-muted">{t("common.loading")}</p> : null}
      {trace.isError ? <p className="error-text">{t("common.error")}</p> : null}
      {trace.data ? (
        <TraceBody projectId={projectId} evidenceId={evidenceId} trace={trace.data} />
      ) : null}
    </Modal>
  );
}
