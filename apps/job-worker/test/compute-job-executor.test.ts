import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ComputeRequest, ComputeResponse } from "@private-fund/contracts";

import {
  ComputeJobExecutor,
  ComputeJobResponseError,
  InvalidComputeJobError,
  InvalidComputeResultError,
  computeRequestForJob,
  validateComputeResult,
} from "../src/compute-job-executor.js";

function job(
  type: "document.ingest" | "valuation.extract" = "document.ingest",
  payload: Record<string, unknown> = {},
) {
  return {
    id: "job-1",
    tenantNamespace: "00000000-0000-4000-8000-000000000001",
    projectId: "project-1",
    type,
    payload: {
      inputPath: path.resolve("/tmp/document.pdf"),
      outputDirectory: path.resolve("/tmp/output"),
      ...payload,
    },
    attempt: 1,
  };
}

function completed(request: ComputeRequest): ComputeResponse {
  return {
    protocolVersion: 1,
    requestId: request.requestId,
    status: "completed",
    recordsFile: "records.ndjson",
    artifacts: [],
    metrics: {},
    error: null,
  };
}

describe("computeRequestForJob", () => {
  it("infers document extraction from the file extension", () => {
    expect(computeRequestForJob(job()).operation).toBe("extract_pdf");
    expect(
      computeRequestForJob(
        job("document.ingest", { inputPath: path.resolve("/tmp/model.xlsm") }),
      ).operation,
    ).toBe("extract_workbook");
  });

  it.each([
    "document.docx",
    "deck.pptx",
    "table.csv",
    "notes.md",
    "notes.markdown",
    "notes.txt",
  ])("maps %s ingestion to bounded generic document extraction", (filename) => {
    expect(
      computeRequestForJob(
        job("document.ingest", {
          inputPath: path.resolve("/tmp", filename),
        }),
      ).operation,
    ).toBe("extract_document");
  });

  it("accepts extract_document as an explicit contract operation", () => {
    expect(
      computeRequestForJob(
        job("document.ingest", {
          inputPath: path.resolve("/tmp/source.bin"),
          computeOperation: "extract_document",
        }),
      ).operation,
    ).toBe("extract_document");
  });

  it("maps valuation extraction to workbook extraction", () => {
    expect(
      computeRequestForJob(
        job("valuation.extract", {
          inputPath: path.resolve("/tmp/model.xlsx"),
        }),
      ).operation,
    ).toBe("extract_workbook");
  });

  it("uses a deterministic, bounded request id per attempt", () => {
    const first = computeRequestForJob(job());
    const second = computeRequestForJob(job());
    expect(first.requestId).toBe(second.requestId);
    expect(first.requestId).toMatch(/^compute:[a-f0-9]{64}$/);
  });

  it("rejects relative paths at the queue boundary", () => {
    expect(() =>
      computeRequestForJob(job("document.ingest", { inputPath: "relative.pdf" })),
    ).toThrow(InvalidComputeJobError);
  });
});

describe("ComputeJobExecutor", () => {
  it("passes the exact ComputeRequest to the compute transport", async () => {
    const execute = vi.fn(async (request: ComputeRequest) => completed(request));
    const authorize = vi.fn(async () => undefined);
    const executor = new ComputeJobExecutor({ execute }, { authorize });
    const response = await executor.execute(job());
    expect(response.status).toBe("completed");
    expect(authorize).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].jobId).toBe("job-1");
  });

  it("turns a failed response into a typed job error", async () => {
    const execute = vi.fn(async (request: ComputeRequest): Promise<ComputeResponse> => ({
      protocolVersion: 1,
      requestId: request.requestId,
      status: "failed",
      recordsFile: null,
      artifacts: [],
      metrics: { errorCode: "invalid_options" },
      error: "invalid options",
    }));
    const executor = new ComputeJobExecutor(
      { execute },
      { authorize: vi.fn(async () => undefined) },
    );
    await expect(executor.execute(job())).rejects.toMatchObject({
      name: "ComputeJobResponseError",
      retryable: false,
    } satisfies Partial<ComputeJobResponseError>);
  });

  it("marks provider network failures as retryable", async () => {
    const execute = vi.fn(async (request: ComputeRequest): Promise<ComputeResponse> => ({
      protocolVersion: 1,
      requestId: request.requestId,
      status: "failed",
      recordsFile: null,
      artifacts: [],
      metrics: { errorCode: "provider_network_error" },
      error: "provider offline",
    }));
    const executor = new ComputeJobExecutor(
      { execute },
      { authorize: vi.fn(async () => undefined) },
    );
    await expect(executor.execute(job())).rejects.toMatchObject({
      retryable: true,
    } satisfies Partial<ComputeJobResponseError>);
  });
});

describe("validateComputeResult", () => {
  const artifact = (
    artifactPath: string,
    mediaType: string,
  ): ComputeResponse["artifacts"][number] => ({
    path: artifactPath,
    mediaType,
    checksum:
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    size: 0,
  });
  const request = (
    operation: ComputeRequest["operation"],
  ): ComputeRequest => ({
    protocolVersion: 1,
    requestId: "request-validate",
    jobId: "job-validate",
    operation,
    inputPath: "/tmp/input",
    outputDirectory: "/tmp/output",
    options: {},
  });

  it("accepts bounded generic document NDJSON metrics", () => {
    expect(() =>
      validateComputeResult(request("extract_document"), {
        protocolVersion: 1,
        requestId: "request-validate",
        status: "completed",
        recordsFile: "document-records.ndjson",
        artifacts: [
          {
            ...artifact(
              "document-records.ndjson",
              "application/x-ndjson",
            ),
            size: 500,
          },
        ],
        metrics: {
          inputChecksum:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          inputBytes: 100,
          format: "docx",
          recordCount: 4,
          textRecordCount: 2,
          textChars: 20,
          recordsBytes: 500,
          recordTypeCounts: {
            document: 1,
            table: 1,
            text: 2,
          },
        },
        error: null,
      }),
    ).not.toThrow();
  });

  it("rejects generic document results without bounded NDJSON metrics", () => {
    expect(() =>
      validateComputeResult(request("extract_document"), {
        protocolVersion: 1,
        requestId: "request-validate",
        status: "completed",
        recordsFile: "document-records.ndjson",
        artifacts: [
          artifact("document-records.ndjson", "application/json"),
        ],
        metrics: {
          inputChecksum:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          inputBytes: 100,
          format: "docx",
          recordCount: 4,
          textRecordCount: 2,
          textChars: 20,
          recordsBytes: 500,
          recordTypeCounts: {
            document: 1,
            table: 1,
            text: 2,
          },
        },
        error: null,
      }),
    ).toThrow(InvalidComputeResultError);
  });

  it("rejects inconsistent generic document count and artifact metrics", () => {
    expect(() =>
      validateComputeResult(request("extract_document"), {
        protocolVersion: 1,
        requestId: "request-validate",
        status: "completed",
        recordsFile: "document-records.ndjson",
        artifacts: [
          {
            ...artifact(
              "document-records.ndjson",
              "application/x-ndjson",
            ),
            size: 499,
          },
        ],
        metrics: {
          inputChecksum:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          inputBytes: 100,
          format: "docx",
          recordCount: 4,
          textRecordCount: 2,
          textChars: 20,
          recordsBytes: 500,
          recordTypeCounts: {
            document: 1,
            text: 2,
          },
        },
        error: null,
      }),
    ).toThrow(InvalidComputeResultError);
  });

  it("accepts normalized market records and manifest", () => {
    expect(() =>
      validateComputeResult(request("fetch_market_data"), {
        protocolVersion: 1,
        requestId: "request-validate",
        status: "completed",
        recordsFile: "market.ndjson",
        artifacts: [
          artifact("market.ndjson", "application/x-ndjson"),
          artifact("manifest.json", "application/json"),
        ],
        metrics: {
          provider: "fixture",
          adjustment: "raw",
          barCount: 3,
        },
        error: null,
      }),
    ).not.toThrow();
  });

  it("rejects a derived workbook without a no-overwrite attestation", () => {
    expect(() =>
      validateComputeResult(request("derive_workbook"), {
        protocolVersion: 1,
        requestId: "request-validate",
        status: "completed",
        recordsFile: "manifest.json",
        artifacts: [
          artifact(
            "derived.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          ),
          artifact("manifest.json", "application/json"),
        ],
        metrics: { changeCount: 1, sourceOverwritten: true },
        error: null,
      }),
    ).toThrow(InvalidComputeResultError);
  });

  it("rejects a report claiming a generated PDF without a PDF artifact", () => {
    expect(() =>
      validateComputeResult(request("render_report"), {
        protocolVersion: 1,
        requestId: "request-validate",
        status: "completed",
        recordsFile: "manifest.json",
        artifacts: [
          artifact("report.md", "text/markdown; charset=utf-8"),
          artifact("report.html", "text/html; charset=utf-8"),
          artifact("manifest.json", "application/json"),
        ],
        metrics: { pdfStatus: "generated" },
        error: null,
      }),
    ).toThrow(InvalidComputeResultError);
  });

  it("rejects a rendered page without a PNG artifact", () => {
    expect(() =>
      validateComputeResult(request("render_pdf_page"), {
        protocolVersion: 1,
        requestId: "request-validate",
        status: "completed",
        recordsFile: "manifest.json",
        artifacts: [artifact("manifest.json", "application/json")],
        metrics: {
          pageNumber: 1,
          pageCount: 1,
          width: 100,
          height: 100,
        },
        error: null,
      }),
    ).toThrow(InvalidComputeResultError);
  });
});
