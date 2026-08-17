import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ExcelSourcePayload,
  PdfSourcePage,
} from "@private-fund/contracts";

import type { ApiConfig } from "./config.js";
import { createApiRuntime, type ApiRuntime } from "./main.js";
import { ProjectResearchStoreManager } from "./research-stores.js";

const AGENT_WORKER_ENTRY = fileURLToPath(
  new URL("../test/fixtures/fake-agent-worker.mjs", import.meta.url),
);
const COMPUTE_WORKER_ENTRY = fileURLToPath(
  new URL(
    "../../../python/compute-worker/worker.py",
    import.meta.url,
  ),
);
const COMPUTE_PYTHON = fileURLToPath(
  new URL(
    "../../../python/compute-worker/.venv/bin/python",
    import.meta.url,
  ),
);
const PDF_FIXTURE = fileURLToPath(
  new URL(
    "../../../omnigent/tests/resources/test.pdf",
    import.meta.url,
  ),
);
const DATA_NAMESPACE = "00000000-0000-4000-8000-000000000081";

function checksum(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

function runtimeConfig(
  dataRoot: string,
  userId: string,
  dataNamespace: string,
): ApiConfig {
  return {
    host: "127.0.0.1",
    port: 6768,
    dataRoot,
    controlDatabase: path.join(dataRoot, "control.sqlite3"),
    auth: {
      mode: "development",
      userId,
      dataNamespace,
    },
    agentWorkerEntry: AGENT_WORKER_ENTRY,
    sourcePreviewCompute: {
      pythonExecutable: COMPUTE_PYTHON,
      workerEntry: COMPUTE_WORKER_ENTRY,
      timeoutMilliseconds: 30_000,
    },
  };
}

describe("canonical Excel and PDF source previews", () => {
  let runtime: ApiRuntime | undefined;
  let otherRuntime: ApiRuntime | undefined;
  let dataRoot: string | undefined;

  afterEach(async () => {
    await otherRuntime?.close();
    await runtime?.close();
    if (dataRoot !== undefined) {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("serves Evidence-anchored Excel ranges and rendered PDF pages without legacy routes", async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-source-preview-"));
    runtime = await createApiRuntime(
      runtimeConfig(dataRoot, "source-preview-user", DATA_NAMESPACE),
    );
    const projectResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Source preview acceptance" },
    });
    expect(projectResponse.statusCode, projectResponse.body).toBe(201);
    const project = projectResponse.json<{ id: string }>();
    const projectRoot = path.join(
      dataRoot,
      "users",
      DATA_NAMESPACE,
      "projects",
      project.id,
    );
    const sourceDirectory = path.join(projectRoot, "sources");
    await mkdir(sourceDirectory, { recursive: true });

    const workbookBytes = Buffer.from(
      "immutable canonical workbook fixture",
      "utf8",
    );
    const workbookPath = path.join(sourceDirectory, "model.xlsx");
    await writeFile(workbookPath, workbookBytes);
    const pdfBytes = await readFile(PDF_FIXTURE);
    const pdfPath = path.join(sourceDirectory, "report.pdf");
    await writeFile(pdfPath, pdfBytes);

    const stores = new ProjectResearchStoreManager();
    const store = stores.get(projectRoot);
    const workbook = store.documents.registerVersion({
      documentId: "doc_excel_preview",
      logicalKey: "source-preview:excel",
      sourceRoot: "fixture",
      sourceRelpath: "model.xlsx",
      title: "Valuation model",
      originalFilename: "model.xlsx",
      storedPath: path.relative(projectRoot, workbookPath),
      fileType: "xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sha256: checksum(workbookBytes),
      fileSize: workbookBytes.byteLength,
      status: "indexed",
      metadata: {
        sourcePreview: {
          version: 1,
          kind: "excel",
          sheets: [
            {
              sheetName: "DCF",
              maxRow: 500,
              maxColumn: 26,
              usedRange: "A1:Z500",
              nonEmptyCellCount: 2,
              formulaCount: 1,
            },
            {
              sheetName: "Empty",
              maxRow: 0,
              maxColumn: 0,
              usedRange: null,
              nonEmptyCellCount: 0,
              formulaCount: 0,
            },
          ],
        },
      },
    });
    store.evidence.put({
      evidenceId: "cell:excel-anchor",
      kind: "cell",
      documentVersionId: workbook.version.id,
      title: "Revenue",
      originalText: "DCF!B2: 120",
      locator: {
        sheetName: "DCF",
        cellRange: "B2",
        cellRef: "B2",
        displayValue: "120",
        rawValue: "120",
      },
      metadata: {
        row: 2,
        column: 2,
        numericValue: 120,
        cachedValue: null,
        numberFormat: "0",
        rowLabel: "Revenue",
        columnLabel: "2027E",
        period: "2027E",
        unit: "CNYm",
      },
    });
    store.evidence.put({
      evidenceId: "cell:excel-tail",
      kind: "cell",
      documentVersionId: workbook.version.id,
      title: "Terminal value",
      originalText: "DCF!Z500: 31.4%",
      locator: {
        sheetName: "DCF",
        cellRange: "Z500",
        cellRef: "Z500",
        formula: "=Y500/X500",
        displayValue: "31.4%",
        rawValue: "0.314",
      },
      metadata: {
        row: 500,
        column: 26,
        cachedValue: "0.314",
        numberFormat: "0.0%",
      },
    });

    const pdf = store.documents.registerVersion({
      documentId: "doc_pdf_preview",
      logicalKey: "source-preview:pdf",
      sourceRoot: "fixture",
      sourceRelpath: "report.pdf",
      title: "Research report",
      originalFilename: "report.pdf",
      storedPath: path.relative(projectRoot, pdfPath),
      fileType: "pdf",
      mimeType: "application/pdf",
      sha256: checksum(pdfBytes),
      fileSize: pdfBytes.byteLength,
      status: "indexed",
    });
    store.evidence.put({
      evidenceId: "page:pdf-page-1",
      kind: "page",
      documentVersionId: pdf.version.id,
      title: "Page 1",
      originalText: "Canonical private fund source",
      locator: {
        pageStart: 1,
        pageEnd: 1,
        pageNumbers: [1],
        bbox: [0, 0, 612, 792],
      },
      metadata: {
        width: 612,
        height: 792,
        rotation: 0,
        blocks: [
          {
            blockNumber: 0,
            blockType: 0,
            bbox: [72, 72, 300, 110],
            text: "Canonical private fund source",
          },
        ],
      },
    });
    stores.close();

    const workbookResponse = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/evidence/cell%3Aexcel-anchor/` +
        "source/excel",
    });
    expect(workbookResponse.statusCode, workbookResponse.body).toBe(200);
    const workbookPayload =
      workbookResponse.json<ExcelSourcePayload>();
    expect(workbookPayload).toMatchObject({
      kind: "excel",
      mode: "workbook",
      documentId: "doc_excel_preview",
      anchorEvidenceId: "cell:excel-anchor",
      sheets: [
        {
          sheetName: "DCF",
          usedRange: "A1:Z500",
          nonEmptyCellCount: 2,
          formulaCount: 1,
        },
        {
          sheetName: "Empty",
          usedRange: null,
          nonEmptyCellCount: 0,
        },
      ],
    });

    const sheetResponse = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/evidence/cell%3Aexcel-anchor/` +
        "source/excel?sheetName=%27DCF%27",
    });
    expect(sheetResponse.statusCode, sheetResponse.body).toBe(200);
    expect(sheetResponse.json()).toMatchObject({
      mode: "sheet",
      regions: [
        {
          regionType: "used-range",
          cellRange: "A1:Z500",
        },
      ],
    });

    const rangeResponse = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/evidence/cell%3Aexcel-anchor/` +
        "source/excel?sheetName=DCF&rangeRef=A1%3AB2",
    });
    expect(rangeResponse.statusCode, rangeResponse.body).toBe(200);
    expect(rangeResponse.json()).toMatchObject({
      mode: "range",
      requestedRangeRef: "A1:B2",
      rangeRef: "A1:B2",
      totalNonEmptyCellCount: 1,
      cells: [
        {
          evidenceId: "cell:excel-anchor",
          cellRef: "B2",
          rowIndex: 2,
          columnIndex: 2,
          displayValue: "120",
          numericValue: 120,
          rowLabel: "Revenue",
          columnLabel: "2027E",
        },
      ],
    });

    const sparseResponse = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/evidence/cell%3Aexcel-anchor/` +
        "source/excel?sheetName=DCF&rangeRef=C3%3AZ500",
    });
    expect(sparseResponse.statusCode, sparseResponse.body).toBe(200);
    const sparse =
      sparseResponse.json<Extract<ExcelSourcePayload, { mode: "range" }>>();
    expect(sparse.window.rowStart).toBeGreaterThan(1);
    expect(sparse.window.columnStart).toBeGreaterThan(1);
    expect(sparse.cells).toEqual([
      expect.objectContaining({
        evidenceId: "cell:excel-tail",
        cellRef: "Z500",
        formula: "=Y500/X500",
        isFormula: true,
      }),
    ]);
    expect(
      sparse.window.rowCount * sparse.window.columnCount,
    ).toBeLessThanOrEqual(4_000);

    const invalidRange = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/evidence/cell%3Aexcel-anchor/` +
        "source/excel?sheetName=DCF&rangeRef=A0%3AB2",
    });
    expect(invalidRange.statusCode).toBe(400);

    const pdfResponse = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/evidence/page%3Apdf-page-1/` +
        "source/pdf/pages/1?quote=Canonical%20private%20fund%20source",
    });
    expect(pdfResponse.statusCode, pdfResponse.body).toBe(200);
    const pdfPayload = pdfResponse.json<PdfSourcePage>();
    expect(pdfPayload).toMatchObject({
      kind: "pdf",
      documentId: "doc_pdf_preview",
      anchorEvidenceId: "page:pdf-page-1",
      pageEvidenceId: "page:pdf-page-1",
      pageNumber: 1,
      pageCount: 1,
      fileName: "report.pdf",
      imageWidth: 1224,
      imageHeight: 1584,
      pageWidth: 612,
      pageHeight: 792,
      matched: true,
      highlightSource: {
        mode: "page_block",
        evidenceId: "page:pdf-page-1",
      },
    });
    expect(pdfPayload.imageUrl).toBe(
      `/v1/projects/${project.id}/evidence/page%3Apdf-page-1/source/pdf/pages/1/image`,
    );
    expect(pdfPayload.highlights[0]?.xPct).toBeCloseTo(
      (72 / 612) * 100,
      5,
    );
    expect(pdfPayload.highlights[0]?.yPct).toBeCloseTo(
      (72 / 792) * 100,
      5,
    );

    const imageResponse = await runtime.app.inject({
      method: "GET",
      url: pdfPayload.imageUrl,
      headers: { range: "bytes=0-7" },
    });
    expect(imageResponse.statusCode, imageResponse.body).toBe(206);
    expect(imageResponse.headers).toMatchObject({
      "accept-ranges": "bytes",
      "content-type": "image/png",
      "content-range": expect.stringMatching(/^bytes 0-7\/\d+$/u),
      "x-content-type-options": "nosniff",
    });
    expect(imageResponse.rawPayload).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    const unsatisfiableImage = await runtime.app.inject({
      method: "GET",
      url: pdfPayload.imageUrl,
      headers: { range: "bytes=999999999-" },
    });
    expect(unsatisfiableImage.statusCode).toBe(416);
    expect(unsatisfiableImage.headers["content-range"]).toMatch(
      /^bytes \*\/\d+$/u,
    );

    const missingPage = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/evidence/page%3Apdf-page-1/` +
        "source/pdf/pages/2",
    });
    expect(missingPage.statusCode).toBe(404);
    const invalidPage = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/evidence/page%3Apdf-page-1/` +
        "source/pdf/pages/0",
    });
    expect(invalidPage.statusCode).toBe(400);

    await writeFile(pdfPath, Buffer.from("%PDF-1.7\ntampered\n"));
    const tamperedSource = await runtime.app.inject({
      method: "GET",
      url: pdfPayload.imageUrl,
    });
    expect(tamperedSource.statusCode).toBe(409);
    await writeFile(pdfPath, pdfBytes);

    otherRuntime = await createApiRuntime(
      runtimeConfig(
        dataRoot,
        "other-source-preview-user",
        "00000000-0000-4000-8000-000000000082",
      ),
    );
    for (const url of [
      `/v1/projects/${project.id}/evidence/cell%3Aexcel-anchor/source/excel`,
      `/v1/projects/${project.id}/evidence/page%3Apdf-page-1/source/pdf/pages/1`,
      `/v1/projects/${project.id}/evidence/page%3Apdf-page-1/source/pdf/pages/1/image`,
    ]) {
      const response = await otherRuntime.app.inject({
        method: "GET",
        url,
      });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(404);
    }
  }, 60_000);
});
