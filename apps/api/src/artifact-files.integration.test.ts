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

import type { ApiConfig } from "./config.js";
import { createApiRuntime, type ApiRuntime } from "./main.js";
import { ProjectResearchStoreManager } from "./research-stores.js";

const WORKER_ENTRY = fileURLToPath(
  new URL("../test/fixtures/fake-agent-worker.mjs", import.meta.url),
);
const DATA_NAMESPACE = "00000000-0000-4000-8000-000000000076";

function sha256(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

describe("canonical artifact file routes", () => {
  let runtime: ApiRuntime | undefined;
  let otherTenantRuntime: ApiRuntime | undefined;
  let dataRoot: string | undefined;

  afterEach(async () => {
    await otherTenantRuntime?.close();
    await runtime?.close();
    if (dataRoot !== undefined) {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("serves immutable Evidence, memo, and derived-model artifacts and replays resource import", async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-artifact-files-"));
    const config: ApiConfig = {
      host: "127.0.0.1",
      port: 6768,
      dataRoot,
      controlDatabase: path.join(dataRoot, "control.sqlite3"),
      auth: {
        mode: "development",
        userId: "artifact-test-user",
        dataNamespace: DATA_NAMESPACE,
      },
      agentWorkerEntry: WORKER_ENTRY,
    };
    runtime = await createApiRuntime(config);

    const projectResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: {
        name: "Artifact acceptance",
        companyName: "Artifact Co.",
        ticker: "600000",
      },
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

    const sourceBytes = Buffer.from(
      "canonical evidence workbook bytes",
      "utf8",
    );
    const sourcePath = path.join(projectRoot, "sources", "base.xlsx");
    const memoMarkdown = Buffer.from(
      "# 投资备忘录\n\n结论由 canonical Evidence 支持。",
      "utf8",
    );
    const memoPdf = Buffer.from("%PDF-1.7\nmemo artifact\n", "utf8");
    const memoMarkdownPath = path.join(
      projectRoot,
      "artifacts",
      "memos",
      "memo.md",
    );
    const memoPdfPath = path.join(
      projectRoot,
      "artifacts",
      "memos",
      "memo.pdf",
    );
    const derivedBytes = Buffer.from("derived workbook bytes", "utf8");
    const derivedPath = path.join(
      projectRoot,
      "artifacts",
      "valuation",
      "derived.xlsx",
    );
    await Promise.all([
      mkdir(path.dirname(sourcePath), { recursive: true }),
      mkdir(path.dirname(memoMarkdownPath), { recursive: true }),
      mkdir(path.dirname(derivedPath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(sourcePath, sourceBytes),
      writeFile(memoMarkdownPath, memoMarkdown),
      writeFile(memoPdfPath, memoPdf),
      writeFile(derivedPath, derivedBytes),
    ]);

    const seeder = new ProjectResearchStoreManager();
    const research = seeder.get(projectRoot);
    const workflow = seeder.getWorkflow(projectRoot);
    const document = research.documents.registerVersion({
      logicalKey: "valuation:base",
      sourceRoot: "upload",
      sourceRelpath: "base.xlsx",
      title: "Base workbook",
      originalFilename: "base.xlsx",
      storedPath: path.relative(projectRoot, sourcePath),
      fileType: "xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sha256: sha256(sourceBytes),
      fileSize: sourceBytes.byteLength,
      status: "indexed",
      activate: true,
    });
    const evidence = research.evidence.put({
      evidenceId: "cell:artifact-dcf-b7",
      kind: "cell",
      documentVersionId: document.version.id,
      title: "Target price",
      originalText: "Target price | 2026E | 42.5",
      locator: {
        displayText: "Base workbook DCF!B7",
        sheetName: "DCF",
        cellRange: "B7",
        cellRef: "B7",
        formula: "=NPV(B2:B6)",
        displayValue: "42.5",
        rawValue: "=NPV(B2:B6)",
      },
      metadata: { unit: "CNY", numericValue: 42.5 },
    }).evidence;
    const memo = workflow.tracking.saveMemoVersion({
      datasetId: project.id,
      topic: "综合投研",
      title: "投资备忘录",
      asOfDate: "2026-07-31",
      sourceType: "agent_generated",
      contentHash: sha256(memoMarkdown),
      markdownPath: path.relative(projectRoot, memoMarkdownPath),
      pdfPath: path.relative(projectRoot, memoPdfPath),
      documentVersions: [{ id: document.version.id }],
      idempotencyKey: "artifact-memo-version",
      sections: [
        {
          sectionKey: "conclusion",
          title: "结论",
          content: "结论由 canonical Evidence 支持。",
          evidenceIds: [evidence.evidenceId],
        },
      ],
    }).record;
    const series = workflow.valuation.upsertSeries({
      datasetId: project.id,
      seriesKey: "base-model",
      name: "Base model",
      companyTicker: "600000",
    });
    const model = workflow.valuation.saveModelVersion({
      datasetId: project.id,
      seriesId: series.seriesId,
      docId: document.version.id,
      logicalDocId: document.document.id,
      documentVersionNo: document.version.versionNo,
      checksum: document.version.sha256,
      snapshotHash: "b".repeat(64),
      originalFilename: document.version.originalFilename,
      analyzerVersion: "artifact-test",
    }).value;
    const analysis = workflow.valuation.createAgentAnalysis({
      datasetId: project.id,
      seriesId: series.seriesId,
      baseModelVersionId: model.modelVersionId,
      agentVersion: "pi-agent-v1",
      idempotencyKey: "artifact-analysis",
    }).value;
    workflow.valuation.transitionAgentAnalysis(
      project.id,
      analysis.analysisId,
      { status: "running" },
    );
    workflow.valuation.transitionAgentAnalysis(
      project.id,
      analysis.analysisId,
      {
        status: "completed",
        analysis: { recommendedChanges: [] },
      },
    );
    const derived = workflow.valuation.saveDerivedModel({
      datasetId: project.id,
      seriesId: series.seriesId,
      analysisId: analysis.analysisId,
      baseModelVersionId: model.modelVersionId,
      derivedVersionNo: 1,
      outputFilename: "derived.xlsx",
      outputPath: path.relative(projectRoot, derivedPath),
      checksum: sha256(derivedBytes),
      appliedChanges: [],
      skippedChanges: [],
    }).value;
    seeder.close();

    const evidencePreview = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/evidence/` +
        `${encodeURIComponent(evidence.evidenceId)}/preview`,
      headers: { range: "bytes=10-17" },
    });
    expect(evidencePreview.statusCode, evidencePreview.body).toBe(206);
    expect(evidencePreview.rawPayload).toEqual(sourceBytes.subarray(10, 18));
    expect(evidencePreview.headers["content-disposition"]).toContain("inline");

    const memoPreview = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/tracking/memos/` +
        `${memo.memoVersionId}/preview?format=markdown`,
    });
    expect(memoPreview.statusCode, memoPreview.body).toBe(200);
    expect(memoPreview.rawPayload).toEqual(memoMarkdown);
    expect(memoPreview.headers["content-disposition"]).toContain("inline");

    const memoDownload = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/tracking/memos/` +
        `${memo.memoVersionId}/download?format=pdf`,
    });
    expect(memoDownload.statusCode, memoDownload.body).toBe(200);
    expect(memoDownload.rawPayload).toEqual(memoPdf);
    expect(memoDownload.headers).toMatchObject({
      "content-type": "application/pdf",
      "x-content-type-options": "nosniff",
    });
    expect(memoDownload.headers["content-disposition"]).toContain(
      "attachment",
    );

    const derivedDownload = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/valuation/derived-models/` +
        `${derived.derivedModelId}/download`,
      headers: { range: "bytes=0-6" },
    });
    expect(derivedDownload.statusCode, derivedDownload.body).toBe(206);
    expect(derivedDownload.rawPayload).toEqual(
      derivedBytes.subarray(0, 7),
    );
    expect(derivedDownload.headers["content-disposition"]).toContain(
      "attachment",
    );

    const importUrl =
      `/v1/projects/${project.id}/valuation/derived-models/` +
      `${derived.derivedModelId}/resources`;
    const firstImport = await runtime.app.inject({
      method: "POST",
      url: importUrl,
      payload: { idempotencyKey: "artifact-resource-import" },
    });
    expect(firstImport.statusCode, firstImport.body).toBe(202);
    expect(firstImport.json()).toMatchObject({
      created: true,
      derivedModel: {
        derivedModelId: derived.derivedModelId,
        resourceStatus: "queued",
      },
      job: { type: "document.ingest", status: "queued" },
    });
    const firstImportBody = firstImport.json<{
      document: { id: string };
      job: { id: string };
    }>();
    const replayImport = await runtime.app.inject({
      method: "POST",
      url: importUrl,
      payload: { idempotencyKey: "artifact-resource-import" },
    });
    expect(replayImport.statusCode, replayImport.body).toBe(202);
    expect(replayImport.json()).toMatchObject({
      created: false,
      document: { id: firstImportBody.document.id },
      job: { id: firstImportBody.job.id },
    });

    otherTenantRuntime = await createApiRuntime({
      ...config,
      port: 6769,
      auth: {
        mode: "development",
        userId: "artifact-other-user",
        dataNamespace: "00000000-0000-4000-8000-000000000077",
      },
    });
    const privateArtifactUrls = [
      `/v1/projects/${project.id}/documents/${document.document.id}/preview`,
      `/v1/projects/${project.id}/documents/${document.document.id}/download`,
      `/v1/projects/${project.id}/evidence/${encodeURIComponent(evidence.evidenceId)}/preview`,
      `/v1/projects/${project.id}/evidence/${encodeURIComponent(evidence.evidenceId)}/download`,
      `/v1/projects/${project.id}/tracking/memos/${memo.memoVersionId}/preview?format=markdown`,
      `/v1/projects/${project.id}/tracking/memos/${memo.memoVersionId}/download?format=pdf`,
      `/v1/projects/${project.id}/valuation/derived-models/${derived.derivedModelId}/preview`,
      `/v1/projects/${project.id}/valuation/derived-models/${derived.derivedModelId}/download`,
    ];
    for (const url of privateArtifactUrls) {
      // eslint-disable-next-line no-await-in-loop
      const response = await otherTenantRuntime.app.inject({
        method: "GET",
        url,
      });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(404);
    }
    const crossTenantImport = await otherTenantRuntime.app.inject({
      method: "POST",
      url: importUrl,
      payload: { idempotencyKey: "cross-tenant-resource-import" },
    });
    expect(
      crossTenantImport.statusCode,
      crossTenantImport.body,
    ).toBe(404);

    await writeFile(derivedPath, Buffer.from("tampered", "utf8"));
    const tampered = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/projects/${project.id}/valuation/derived-models/` +
        `${derived.derivedModelId}/download`,
    });
    expect(tampered.statusCode).toBe(409);
    expect(tampered.json()).toMatchObject({
      error: "file_integrity_mismatch",
    });
    await expect(readFile(sourcePath)).resolves.toEqual(sourceBytes);
  });
});
