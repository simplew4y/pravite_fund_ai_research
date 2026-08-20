import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPythonComputeClient } from "@private-fund/compute-client";
import { ComputeResultProjector } from "@private-fund/compute-projector";
import {
  createResearchStore,
  openProjectDatabase,
} from "@private-fund/research-store";
import { createWorkflowStore } from "@private-fund/workflow-store";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  ComputeJobExecutor,
  type ComputeJob,
} from "../src/compute-job-executor.js";
import { TenantProjectComputePathPolicy } from "../src/path-policy.js";
import { WorkflowComputeProjectionHandler } from "../src/workflow-compute-handlers.js";

const TENANT = "00000000-0000-4000-8000-000000000031";
const PROJECT = "workflow-compute-project";
const pythonWorker = fileURLToPath(
  new URL("../../../python/compute-worker/worker.py", import.meta.url),
);
const temporaryDirectories: string[] = [];

interface ProjectFixture {
  readonly dataRoot: string;
  readonly projectRoot: string;
}

function digest(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function projectFixture(): Promise<ProjectFixture> {
  const dataRoot = await mkdtemp(
    path.join(tmpdir(), "workflow-compute-handler-"),
  );
  temporaryDirectories.push(dataRoot);
  const projectRoot = path.join(
    dataRoot,
    "users",
    TENANT,
    "projects",
    PROJECT,
  );
  await mkdir(projectRoot, { recursive: true });
  return { dataRoot, projectRoot };
}

function computeJob(
  id: string,
  type: ComputeJob["type"],
  payload: Readonly<Record<string, unknown>>,
): ComputeJob {
  return {
    id,
    tenantNamespace: TENANT,
    projectId: PROJECT,
    type,
    payload,
    attempt: 1,
  };
}

function projector(dataRoot: string): ComputeResultProjector {
  return new ComputeResultProjector({
    dataRoot,
    handlers: [new WorkflowComputeProjectionHandler()],
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("WorkflowComputeProjectionHandler", () => {
  it("runs real report compute and attaches immutable memo artifacts", async () => {
    const fixture = await projectFixture();
    const inputPath = path.join(
      fixture.projectRoot,
      "reports",
      "memo-source.md",
    );
    const outputDirectory = path.join(
      fixture.projectRoot,
      "artifacts",
      "memo-render",
    );
    const markdown = [
      "# Alpha Investment Memo",
      "",
      "## Thesis",
      "",
      "Revenue remains resilient.",
    ].join("\n");
    await mkdir(path.dirname(inputPath), { recursive: true });
    await writeFile(inputPath, `${markdown}\n`, "utf8");

    const database = openProjectDatabase({
      projectRoot: fixture.projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
      preferredSearchBackend: "deterministic",
    });
    const memo = createWorkflowStore(
      database.connection,
    ).tracking.saveMemoVersion({
      datasetId: PROJECT,
      topic: "Alpha",
      title: "Alpha Investment Memo",
      asOfDate: "2026-07-31",
      sourceType: "pi-agent",
      contentHash: digest(`${markdown}\n`),
      markdownPath: path.relative(fixture.projectRoot, inputPath),
      sections: [
        {
          sectionKey: "thesis",
          title: "Thesis",
          content: "Revenue remains resilient.",
          evidenceIds: [],
        },
      ],
      idempotencyKey: "memo-alpha-2026-07-31",
    }).record;
    database.close();

    const job = computeJob("job-report-generate", "report.generate", {
      datasetId: PROJECT,
      sourceKind: "memo",
      memoVersionId: memo.memoVersionId,
      assetId: "memo-rendered-alpha",
      inputPath,
      outputDirectory,
      options: {
        renderPdf: false,
        outputBasename: "alpha-investment-memo",
      },
    });
    const executor = new ComputeJobExecutor(
      createPythonComputeClient({
        workerScript: pythonWorker,
        timeoutMs: 5_000,
      }),
      new TenantProjectComputePathPolicy(fixture.dataRoot),
    );
    const response = await executor.execute(job);
    const resultProjector = projector(fixture.dataRoot);

    await expect(resultProjector.project(job, response)).resolves.toMatchObject(
      {
        kind: "extension",
        details: {
          operation: "report.generate",
          sourceKind: "memo",
          memoVersionId: memo.memoVersionId,
          assetId: "memo-rendered-alpha",
        },
      },
    );
    await expect(resultProjector.project(job, response)).resolves.toMatchObject(
      {
        kind: "extension",
        details: { operation: "report.generate" },
      },
    );

    const projected = openProjectDatabase({
      projectRoot: fixture.projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
      preferredSearchBackend: "deterministic",
    });
    try {
      const attached = createWorkflowStore(
        projected.connection,
      ).tracking.getMemoVersion(PROJECT, memo.memoVersionId);
      expect(attached.markdownPath).toBe(
        path.relative(fixture.projectRoot, inputPath),
      );
      expect(attached.htmlPath).toBe(
        "artifacts/memo-render/alpha-investment-memo.html",
      );
      expect(attached.pdfPath).toBeNull();
      const assets = createResearchStore(projected).assets;
      expect(assets.get("memo-rendered-alpha")).toMatchObject({
        status: "completed",
        currentVersionNo: 1,
      });
      expect(
        assets.getCurrentVersion("memo-rendered-alpha"),
      ).toMatchObject({
        metadata: {
          memoVersionId: memo.memoVersionId,
          rendererVersion: expect.any(String),
        },
      });
    } finally {
      projected.close();
    }
  });

  it("rejects a non-memo report sourceKind as an invalid projection job", async () => {
    const fixture = await projectFixture();
    const inputPath = path.join(
      fixture.projectRoot,
      "reports",
      "workflow-report-source.md",
    );
    const outputDirectory = path.join(
      fixture.projectRoot,
      "artifacts",
      "workflow-report-render",
    );
    await mkdir(path.dirname(inputPath), { recursive: true });
    await writeFile(inputPath, "# Retired workflow report\n", "utf8");

    const job = computeJob(
      "job-workflow-report-generate",
      "report.generate",
      {
        datasetId: PROJECT,
        sourceKind: "workflow-report",
        reportVersionId: "report-version-retired",
        inputPath,
        outputDirectory,
        computeOperation: "render_report",
        options: {
          renderPdf: false,
          outputBasename: "retired-workflow-report",
        },
      },
    );
    const executor = new ComputeJobExecutor(
      createPythonComputeClient({
        workerScript: pythonWorker,
        timeoutMs: 5_000,
      }),
      new TenantProjectComputePathPolicy(fixture.dataRoot),
    );
    const response = await executor.execute(job);
    const resultProjector = projector(fixture.dataRoot);

    await expect(resultProjector.project(job, response)).rejects.toMatchObject({
      code: "invalid_projection_job",
      retryable: false,
    });
  });
});
