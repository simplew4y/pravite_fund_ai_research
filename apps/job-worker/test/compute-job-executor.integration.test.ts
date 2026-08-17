import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPythonComputeClient } from "@private-fund/compute-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ComputeJobExecutor } from "../src/compute-job-executor.js";

const pythonWorker = fileURLToPath(
  new URL("../../../python/compute-worker/worker.py", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("generic document compute integration", () => {
  it("runs a Markdown ingest through the TS executor and real Python worker", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "document-ingest-"));
    temporaryDirectories.push(root);
    const inputPath = path.join(root, "source.md");
    const outputDirectory = path.join(root, "output");
    await writeFile(inputPath, "# Thesis\n\nDurable evidence.\n", "utf8");

    const authorize = vi.fn(async () => undefined);
    const executor = new ComputeJobExecutor(
      createPythonComputeClient({
        workerScript: pythonWorker,
        timeoutMs: 5_000,
      }),
      { authorize },
    );
    const response = await executor.execute({
      id: "job-document-integration",
      tenantNamespace: "00000000-0000-4000-8000-000000000001",
      projectId: "project-document-integration",
      type: "document.ingest",
      payload: { inputPath, outputDirectory },
      attempt: 1,
    });

    expect(response.status).toBe("completed");
    expect(response.recordsFile).toBe("document-records.ndjson");
    expect(response.metrics).toMatchObject({
      format: "markdown",
      recordCount: 3,
      textRecordCount: 2,
    });
    expect(authorize).toHaveBeenCalledOnce();
    expect(authorize.mock.calls[0]?.[1].operation).toBe("extract_document");

    const records = (await readFile(
      path.join(outputDirectory, "document-records.ndjson"),
      "utf8",
    ))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records[1]).toMatchObject({
      recordType: "text",
      text: "Thesis",
      locator: {
        kind: "text_heading",
        lineStart: 1,
        lineEnd: 1,
      },
    });
    expect(records[2]).toMatchObject({
      recordType: "text",
      text: "Durable evidence.",
    });
  });
});
