import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  ComputeArtifactIntegrityError,
  ComputeClient,
  ComputeConfigurationError,
  ComputeProtocolError,
  ComputeTimeoutError,
  createPythonComputeClient,
} from "../src/index.js";

const fixture = fileURLToPath(
  new URL("./fixtures/fake-worker.mjs", import.meta.url),
);
const pythonWorker = fileURLToPath(
  new URL("../../../python/compute-worker/worker.py", import.meta.url),
);
const marketFixture = fileURLToPath(
  new URL(
    "../../../python/compute-worker/tests/fixtures/market_a_share.json",
    import.meta.url,
  ),
);
const reportFixture = fileURLToPath(
  new URL(
    "../../../python/compute-worker/tests/fixtures/research_report.md",
    import.meta.url,
  ),
);
const temporaryDirectories: string[] = [];

async function makeRequest() {
  const root = await mkdtemp(path.join(tmpdir(), "compute-client-"));
  temporaryDirectories.push(root);
  const inputPath = path.join(root, "input.pdf");
  await writeFile(inputPath, "%PDF-fixture", "utf8");
  return {
    protocolVersion: 1 as const,
    requestId: "request-1",
    jobId: "job-1",
    operation: "extract_pdf" as const,
    inputPath,
    outputDirectory: path.join(root, "output"),
    options: {},
  };
}

function client(mode: string, timeoutMs = 5_000): ComputeClient {
  return new ComputeClient({
    command: process.execPath,
    arguments: [fixture, mode],
    timeoutMs,
  });
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("ComputeClient", () => {
  it("checks process health without sending a ComputeRequest", async () => {
    const health = await client("success").health();
    expect(health.status).toBe("ok");
    expect(health.implementedOperations).toContain("extract_pdf");
    expect(health.dependencies).toEqual({
      pymupdf: true,
      openpyxl: true,
    });
  });

  it("executes one request and verifies the artifact checksum", async () => {
    const request = await makeRequest();
    const response = await client("success").execute(request);
    expect(response.status).toBe("completed");
    expect(response.recordsFile).toBe("records.ndjson");
    expect(response.artifacts).toHaveLength(1);
  });

  it("returns a protocol-level failed response to the caller", async () => {
    const request = await makeRequest();
    const response = await client("failed").execute(request);
    expect(response.status).toBe("failed");
    expect(response.metrics.errorCode).toBe("unsupported_operation");
  });

  it("rejects stdout containing more than one NDJSON record", async () => {
    const request = await makeRequest();
    await expect(client("noise").execute(request)).rejects.toBeInstanceOf(
      ComputeProtocolError,
    );
  });

  it("rejects a response for another request", async () => {
    const request = await makeRequest();
    await expect(client("mismatch").execute(request)).rejects.toThrow(
      "requestId mismatch",
    );
  });

  it("rejects an artifact whose checksum does not match", async () => {
    const request = await makeRequest();
    await expect(client("bad-checksum").execute(request)).rejects.toBeInstanceOf(
      ComputeArtifactIntegrityError,
    );
  });

  it("terminates a worker that exceeds its deadline", async () => {
    const request = await makeRequest();
    await expect(client("hang", 50).execute(request)).rejects.toBeInstanceOf(
      ComputeTimeoutError,
    );
  });

  it("rejects relative paths before spawning", async () => {
    const request = await makeRequest();
    await expect(
      client("success").execute({
        ...request,
        inputPath: "input.pdf",
      }),
    ).rejects.toBeInstanceOf(ComputeConfigurationError);
  });

  it("interoperates with the real Python worker market fixture", async () => {
    const request = await makeRequest();
    const python = createPythonComputeClient({
      workerScript: pythonWorker,
      timeoutMs: 5_000,
    });
    const health = await python.health();
    expect(health.worker).toBe("private-fund-compute-worker");
    expect(health.implementedOperations).toContain("extract_document");
    expect(health.contractOperations).toEqual(health.implementedOperations);
    expect(
      health.capabilities.extract_document.boundedExtraction,
    ).toBe(true);
    const response = await python.execute({
      ...request,
      operation: "fetch_market_data",
      inputPath: marketFixture,
    });
    expect(response.status).toBe("completed");
    expect(response.metrics.provider).toBe("fixture");
    expect(response.metrics.barCount).toBe(3);
  });

  it("interoperates with deterministic Python report rendering", async () => {
    const request = await makeRequest();
    const python = createPythonComputeClient({
      workerScript: pythonWorker,
      timeoutMs: 5_000,
    });
    const response = await python.execute({
      ...request,
      operation: "render_report",
      inputPath: reportFixture,
      outputDirectory: path.join(path.dirname(request.outputDirectory), "report-output"),
      options: { renderPdf: false },
    });
    expect(response.status).toBe("completed");
    expect(response.metrics.pdfStatus).toBe("disabled");
    expect(response.artifacts.map((artifact) => artifact.mediaType)).toContain(
      "text/html; charset=utf-8",
    );
  });
});
