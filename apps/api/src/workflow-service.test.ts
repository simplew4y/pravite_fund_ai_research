import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TenantIdentity } from "@private-fund/contracts";
import { buildTenantContext } from "@private-fund/core";
import {
  createControlRepositories,
  openControlDatabase,
} from "@private-fund/db";

import {
  RepositoryJobService,
  RepositoryProjectService,
} from "./repository-services.js";
import { ProjectResearchStoreManager } from "./research-stores.js";
import { RepositoryProjectWorkflowService } from "./workflow-service.js";

const ALPHA: TenantIdentity = {
  userId: "workflow-alpha",
  dataNamespace: "00000000-0000-4000-8000-0000000000c1",
};
const BETA: TenantIdentity = {
  userId: "workflow-beta",
  dataNamespace: "00000000-0000-4000-8000-0000000000c2",
};

describe("repository project workflow service", () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-workflow-service-"));
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("initializes the canonical graph, enforces dependencies and resolves evidence", async () => {
    const database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(database);
    repositories.users.upsertCloudShadow(ALPHA);
    repositories.users.upsertCloudShadow(BETA);
    const alpha = buildTenantContext(dataRoot, ALPHA);
    const beta = buildTenantContext(dataRoot, BETA);
    const projects = new RepositoryProjectService(repositories);
    const project = await projects.create(alpha, {
      name: "Workflow evidence project",
    });
    const stores = new ProjectResearchStoreManager();
    const workflows = new RepositoryProjectWorkflowService(
      repositories,
      stores,
      new RepositoryJobService(database),
    );

    const initialized = await workflows.initialize(alpha, project.id, {
      workflowType: "agentic_research_graph_v2",
    });
    expect(initialized.nodes).toHaveLength(9);
    expect(
      initialized.nodes.find((node) => node.nodeId === "source-review"),
    ).toMatchObject({ status: "ready" });
    expect(
      initialized.nodes.find((node) => node.nodeId === "business-analysis"),
    ).toMatchObject({ status: "pending" });
    await expect(
      workflows.startNode(alpha, project.id, "business-analysis", {
        inputManifest: {},
      }),
    ).rejects.toMatchObject({ code: "workflow_invalid_state" });

    const started = await workflows.startNode(
      alpha,
      project.id,
      "source-review",
      {
        idempotencyKey: "source-review-run-1",
        inputManifest: {},
      },
    );
    expect(started.nodeVersion.status).toBe("running");
    await expect(
      workflows.completeNode(alpha, project.id, "source-review", {
        outputMarkdown: "资料已经审阅。",
        structuredOutput: {},
        evidenceIds: ["page:does-not-exist"],
      }),
    ).rejects.toMatchObject({ code: "invalid_evidence_reference" });

    const projectRoot = path.join(alpha.projectsRoot, project.id);
    const research = stores.get(projectRoot);
    const source = Buffer.from("source-page");
    const registered = research.documents.registerVersion({
      sourceRelpath: "source.pdf",
      title: "Source",
      originalFilename: "source.pdf",
      storedPath: path.join("sources", "source.pdf"),
      fileType: "pdf",
      mimeType: "application/pdf",
      sha256: createHash("sha256").update(source).digest("hex"),
      fileSize: source.byteLength,
      status: "indexed",
      activate: true,
    });
    research.evidence.put({
      evidenceId: "page:source-v1-p1",
      kind: "page",
      documentVersionId: registered.version.id,
      originalText: "原始资料第一页",
      locator: { pageStart: 1, pageEnd: 1 },
    });

    const completed = await workflows.completeNode(
      alpha,
      project.id,
      "source-review",
      {
        nodeVersionId: started.nodeVersion.nodeVersionId,
        outputMarkdown: "资料已经审阅。",
        structuredOutput: {},
        evidenceIds: ["page:source-v1-p1"],
      },
    );
    expect(completed.nodeVersion).toMatchObject({
      status: "completed",
      evidenceIds: ["page:source-v1-p1"],
    });
    expect(
      completed.workflow.nodes.find(
        (node) => node.nodeId === "business-analysis",
      ),
    ).toMatchObject({ status: "ready" });

    const report = await workflows.createReport(alpha, project.id, {
      idempotencyKey: "investment-report-v1",
      reportType: "investment_report",
      title: "投资研究报告",
      documentVersions: [registered.version.id],
    });
    expect(report.report.currentVersionNo).toBe(1);
    expect(report.version.versionNo).toBe(1);
    expect(report.job).toMatchObject({
      type: "report.generate",
      status: "queued",
      payload: {
        sourceKind: "workflow-report",
        reportVersionId: report.version.reportVersionId,
        computeOperation: "render_report",
      },
    });
    expect(path.isAbsolute(String(report.job.payload.inputPath))).toBe(true);
    await expect(
      readFile(String(report.job.payload.inputPath), "utf8"),
    ).resolves.toBe(report.version.markdown);

    await expect(
      workflows.snapshot(beta, project.id),
    ).rejects.toMatchObject({ code: "not_found" });

    stores.close();
    database.close();
  });
});
