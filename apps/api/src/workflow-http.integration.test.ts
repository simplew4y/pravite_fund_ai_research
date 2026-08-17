import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TenantIdentity } from "@private-fund/contracts";
import {
  createControlRepositories,
  openControlDatabase,
  type ControlDatabase,
} from "@private-fund/db";

import type {
  AgentEvent,
  AgentWorkerPort,
  StartAgentSessionInput,
} from "./agent-supervisor.js";
import { createApiApp } from "./app.js";
import type { ApiConfig } from "./config.js";
import { DevelopmentIdentityProvider } from "./identity.js";
import {
  RepositoryJobService,
  RepositoryProjectService,
  RepositorySessionService,
} from "./repository-services.js";
import { ProjectResearchStoreManager } from "./research-stores.js";
import { RepositoryProjectWorkflowService } from "./workflow-service.js";

const ALPHA: TenantIdentity = {
  userId: "workflow-http-alpha",
  dataNamespace: "00000000-0000-4000-8000-0000000000d1",
};

const BETA: TenantIdentity = {
  userId: "workflow-http-beta",
  dataNamespace: "00000000-0000-4000-8000-0000000000d2",
};

class IdleAgentWorker implements AgentWorkerPort {
  public async start(_input: StartAgentSessionInput): Promise<void> {}

  public async prompt(
    _sessionId: string,
    _operationId: string,
    _content: string,
  ): Promise<void> {}

  public async steer(): Promise<void> {}

  public async compact(): Promise<void> {}

  public async interrupt(): Promise<void> {}

  public async dispose(): Promise<void> {}

  public subscribe(_listener: (event: AgentEvent) => void): () => void {
    return () => undefined;
  }

  public async stop(): Promise<void> {}
}

type ApiApp = Awaited<ReturnType<typeof createApiApp>>;

interface WorkflowHarness {
  readonly database: ControlDatabase;
  readonly stores: ProjectResearchStoreManager;
  readonly sessions: RepositorySessionService;
  readonly alpha: ApiApp;
  readonly beta: ApiApp;
  close(): Promise<void>;
}

function configFor(
  dataRoot: string,
  identity: TenantIdentity,
): ApiConfig {
  return {
    host: "127.0.0.1",
    port: 6768,
    dataRoot,
    controlDatabase: path.join(dataRoot, "control.sqlite3"),
    auth: {
      mode: "development",
      userId: identity.userId,
      dataNamespace: identity.dataNamespace,
    },
    agentWorkerEntry: path.join(dataRoot, "unused-agent-worker.mjs"),
  };
}

async function createHarness(
  dataRoot: string,
): Promise<WorkflowHarness> {
  const database = openControlDatabase(
    path.join(dataRoot, "control.sqlite3"),
  );
  const repositories = createControlRepositories(database);
  repositories.users.upsertCloudShadow(ALPHA);
  repositories.users.upsertCloudShadow(BETA);
  const projects = new RepositoryProjectService(repositories);
  const jobs = new RepositoryJobService(database);
  const sessions = new RepositorySessionService({
    repositories,
    worker: new IdleAgentWorker(),
  });
  const stores = new ProjectResearchStoreManager();
  const workflow = new RepositoryProjectWorkflowService(
    repositories,
    stores,
    jobs,
  );
  const alpha = await createApiApp(configFor(dataRoot, ALPHA), {
    identityProvider: new DevelopmentIdentityProvider(ALPHA),
    projects,
    sessions,
    jobs,
    workflow,
  });
  const beta = await createApiApp(configFor(dataRoot, BETA), {
    identityProvider: new DevelopmentIdentityProvider(BETA),
    projects,
    sessions,
    jobs,
    workflow,
  });
  let closed = false;
  return {
    database,
    stores,
    sessions,
    alpha,
    beta,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await Promise.all([alpha.close(), beta.close()]);
      sessions.dispose();
      stores.close();
      database.close();
    },
  };
}

describe("canonical workflow HTTP acceptance", () => {
  let dataRoot: string;
  let harness: WorkflowHarness;

  beforeEach(async () => {
    dataRoot = await mkdtemp(
      path.join(tmpdir(), "pf-workflow-http-"),
    );
    harness = await createHarness(dataRoot);
  });

  afterEach(async () => {
    await harness.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("preserves workflow state, structured versions, assumption history and current report content", async () => {
    const projectResponse = await harness.alpha.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Non-empty workflow acceptance" },
    });
    expect(projectResponse.statusCode, projectResponse.body).toBe(201);
    const projectId = projectResponse.json<{ id: string }>().id;
    const workflowUrl = `/v1/projects/${projectId}/workflow`;

    const getResponse = await harness.alpha.inject({
      method: "GET",
      url: workflowUrl,
    });
    expect(getResponse.statusCode, getResponse.body).toBe(200);
    const initial = getResponse.json<{
      workflow: { workflowId: string; currentNodeId: string | null };
      nodes: Array<{
        nodeId: string;
        status: string;
        currentVersionNo: number;
      }>;
      dependencies: unknown[];
      context: { nodeIds: string[] };
    }>();
    expect(initial.nodes).toHaveLength(9);
    expect(initial.dependencies).toHaveLength(10);
    expect(initial.context.nodeIds).toEqual([]);
    expect(
      initial.nodes.find((node) => node.nodeId === "source-review"),
    ).toMatchObject({ status: "ready", currentVersionNo: 0 });

    const initializeResponse = await harness.alpha.inject({
      method: "POST",
      url: `${workflowUrl}/initialize`,
      payload: { workflowType: "agentic_research_graph_v2" },
    });
    expect(initializeResponse.statusCode, initializeResponse.body).toBe(
      200,
    );
    expect(
      initializeResponse.json<{ nodes: unknown[] }>().nodes,
    ).toHaveLength(9);

    const blockedStart = await harness.alpha.inject({
      method: "POST",
      url: `${workflowUrl}/nodes/business-analysis/start`,
      payload: {
        idempotencyKey: "business-before-source",
        inputManifest: { trigger: "acceptance" },
      },
    });
    expect(blockedStart.statusCode, blockedStart.body).toBe(409);
    expect(blockedStart.json()).toMatchObject({
      error: "workflow_invalid_state",
    });

    const contextResponse = await harness.alpha.inject({
      method: "POST",
      url: `${workflowUrl}/context`,
      payload: {
        nodeIds: ["business-analysis", "source-review"],
      },
    });
    expect(contextResponse.statusCode, contextResponse.body).toBe(200);
    expect(contextResponse.json()).toMatchObject({
      context: {
        nodeIds: ["business-analysis", "source-review"],
      },
    });

    const currentNodeResponse = await harness.alpha.inject({
      method: "POST",
      url: `${workflowUrl}/current-node`,
      payload: { nodeId: "source-review" },
    });
    expect(currentNodeResponse.statusCode, currentNodeResponse.body).toBe(
      200,
    );
    expect(currentNodeResponse.json()).toMatchObject({
      workflow: { currentNodeId: "source-review" },
    });

    const unknownCurrentNode = await harness.alpha.inject({
      method: "POST",
      url: `${workflowUrl}/current-node`,
      payload: { nodeId: "unknown-node" },
    });
    expect(unknownCurrentNode.statusCode, unknownCurrentNode.body).toBe(
      404,
    );

    const firstStart = await harness.alpha.inject({
      method: "POST",
      url: `${workflowUrl}/nodes/source-review/start`,
      payload: {
        idempotencyKey: "source-version-1",
        inputManifest: {
          documentSignature: "sha256:source-v1",
          documentVersions: ["document-version-1"],
        },
        promptSnapshot: "核对第一版资料。",
        modelName: "pi-workflow-test",
      },
    });
    expect(firstStart.statusCode, firstStart.body).toBe(200);
    const firstVersion = firstStart.json<{
      nodeVersion: {
        nodeVersionId: string;
        versionNo: number;
        status: string;
      };
    }>().nodeVersion;
    expect(firstVersion).toMatchObject({
      versionNo: 1,
      status: "running",
    });

    const idempotentStart = await harness.alpha.inject({
      method: "POST",
      url: `${workflowUrl}/nodes/source-review/start`,
      payload: {
        idempotencyKey: "source-version-1",
        inputManifest: {
          documentSignature: "sha256:source-v1",
          documentVersions: ["document-version-1"],
        },
        promptSnapshot: "核对第一版资料。",
        modelName: "pi-workflow-test",
      },
    });
    expect(idempotentStart.statusCode, idempotentStart.body).toBe(200);
    expect(idempotentStart.json()).toMatchObject({
      nodeVersion: { nodeVersionId: firstVersion.nodeVersionId },
    });

    const structuredOutput = {
      content_blocks: [
        {
          type: "metrics",
          title: "资料覆盖",
          evidence_ids: [],
          items: [
            {
              label: "当前文件",
              value: "2",
              unit: "份",
              sentiment: "positive",
            },
          ],
        },
        {
          type: "table",
          title: "资料清单",
          columns: [
            { key: "name", label: "文件" },
            { key: "status", label: "状态", align: "right" },
          ],
          rows: [
            { name: "年报.pdf", status: "已校验" },
            { name: "模型.xlsx", status: "已校验" },
          ],
        },
      ],
      sourceSummary: {
        files: 2,
        pages: 128,
      },
    };
    const firstComplete = await harness.alpha.inject({
      method: "POST",
      url: `${workflowUrl}/nodes/source-review/complete`,
      payload: {
        nodeVersionId: firstVersion.nodeVersionId,
        outputMarkdown: "第一版资料审阅已完成。",
        structuredOutput,
        evidenceIds: [],
        sourceResponseId: "response-source-v1",
        modelName: "pi-workflow-test",
      },
    });
    expect(firstComplete.statusCode, firstComplete.body).toBe(200);
    expect(firstComplete.json()).toMatchObject({
      nodeVersion: {
        nodeVersionId: firstVersion.nodeVersionId,
        versionNo: 1,
        status: "completed",
        outputMarkdown: "第一版资料审阅已完成。",
        structuredOutput,
        inputManifest: {
          documentSignature: "sha256:source-v1",
          documentVersions: ["document-version-1"],
        },
      },
    });
    expect(
      firstComplete
        .json<{
          workflow: {
            nodes: Array<{ nodeId: string; status: string }>;
          };
        }>()
        .workflow.nodes.find(
          (node) => node.nodeId === "business-analysis",
        ),
    ).toMatchObject({ status: "ready" });

    const businessStart = await harness.alpha.inject({
      method: "POST",
      url: `${workflowUrl}/nodes/business-analysis/start`,
      payload: {
        idempotencyKey: "business-version-1",
        inputManifest: {
          upstreamNodeVersionId: firstVersion.nodeVersionId,
        },
      },
    });
    expect(businessStart.statusCode, businessStart.body).toBe(200);
    const businessVersionId = businessStart.json<{
      nodeVersion: { nodeVersionId: string };
    }>().nodeVersion.nodeVersionId;
    const businessComplete = await harness.alpha.inject({
      method: "POST",
      url: `${workflowUrl}/nodes/business-analysis/complete`,
      payload: {
        nodeVersionId: businessVersionId,
        outputMarkdown: "经营质量稳健，现金流覆盖扩张投入。",
        structuredOutput: {
          contentBlocks: [
            {
              type: "markdown",
              title: "经营结论",
              markdown: "经营质量稳健，现金流覆盖扩张投入。",
            },
          ],
        },
        evidenceIds: [],
      },
    });
    expect(businessComplete.statusCode, businessComplete.body).toBe(200);

    for (const [index, content] of [
      "收入增速未来两年维持在 18% 左右。",
      "毛利率在基准情景下保持 31%。",
    ].entries()) {
      const assumptionResponse = await harness.alpha.inject({
        method: "POST",
        url: `${workflowUrl}/nodes/source-review/assumptions`,
        payload: {
          idempotencyKey: `source-assumption-${String(index + 1)}`,
          content,
          sourceResponseId: `response-assumption-${String(index + 1)}`,
          evidenceIds: [],
        },
      });
      expect(
        assumptionResponse.statusCode,
        assumptionResponse.body,
      ).toBe(200);
      expect(assumptionResponse.json()).toMatchObject({
        assumption: {
          nodeId: "source-review",
          content,
          status: "active",
        },
      });
    }

    const firstAssumptionPage = await harness.alpha.inject({
      method: "GET",
      url:
        `${workflowUrl}/nodes/source-review/assumptions` +
        "?limit=1&offset=0&status=active",
    });
    expect(
      firstAssumptionPage.statusCode,
      firstAssumptionPage.body,
    ).toBe(200);
    expect(firstAssumptionPage.json()).toMatchObject({
      total: 2,
      limit: 1,
      offset: 0,
      hasMore: true,
      items: [{ nodeId: "source-review", status: "active" }],
    });
    const secondAssumptionPage = await harness.alpha.inject({
      method: "GET",
      url:
        `${workflowUrl}/nodes/source-review/assumptions` +
        "?limit=1&offset=1",
    });
    expect(
      secondAssumptionPage.statusCode,
      secondAssumptionPage.body,
    ).toBe(200);
    expect(secondAssumptionPage.json()).toMatchObject({
      total: 2,
      limit: 1,
      offset: 1,
      hasMore: false,
    });
    expect(
      firstAssumptionPage.json<{ items: Array<{ assumptionId: string }> }>()
        .items[0]!.assumptionId,
    ).not.toBe(
      secondAssumptionPage.json<{
        items: Array<{ assumptionId: string }>;
      }>().items[0]!.assumptionId,
    );

    const staleWorkflow = await harness.alpha.inject({
      method: "GET",
      url: workflowUrl,
    });
    expect(
      staleWorkflow
        .json<{
          nodes: Array<{ nodeId: string; status: string }>;
        }>()
        .nodes.find((node) => node.nodeId === "business-analysis"),
    ).toMatchObject({ status: "stale" });

    const secondStart = await harness.alpha.inject({
      method: "POST",
      url: `${workflowUrl}/nodes/source-review/start`,
      payload: {
        idempotencyKey: "source-version-2",
        inputManifest: {
          documentSignature: "sha256:source-v2",
          documentVersions: [
            "document-version-1",
            "document-version-2",
          ],
        },
      },
    });
    expect(secondStart.statusCode, secondStart.body).toBe(200);
    const secondVersion = secondStart.json<{
      nodeVersion: { nodeVersionId: string; versionNo: number };
    }>().nodeVersion;
    expect(secondVersion.versionNo).toBe(2);
    const secondComplete = await harness.alpha.inject({
      method: "POST",
      url: `${workflowUrl}/nodes/source-review/complete`,
      payload: {
        nodeVersionId: secondVersion.nodeVersionId,
        outputMarkdown: "第二版资料审阅已完成。",
        structuredOutput: {
          content_blocks: [
            {
              type: "markdown",
              title: "第二版结论",
              markdown: "新增模型文件已纳入。",
            },
          ],
        },
        evidenceIds: [],
      },
    });
    expect(secondComplete.statusCode, secondComplete.body).toBe(200);

    const latestVersionPage = await harness.alpha.inject({
      method: "GET",
      url:
        `${workflowUrl}/nodes/source-review/versions` +
        "?limit=1&offset=0",
    });
    expect(latestVersionPage.statusCode, latestVersionPage.body).toBe(
      200,
    );
    expect(latestVersionPage.json()).toMatchObject({
      total: 2,
      limit: 1,
      offset: 0,
      hasMore: true,
      items: [
        {
          nodeVersionId: secondVersion.nodeVersionId,
          versionNo: 2,
          outputMarkdown: "第二版资料审阅已完成。",
          structuredOutput: {
            content_blocks: [
              {
                type: "markdown",
                title: "第二版结论",
                markdown: "新增模型文件已纳入。",
              },
            ],
          },
        },
      ],
    });
    const previousVersionPage = await harness.alpha.inject({
      method: "GET",
      url:
        `${workflowUrl}/nodes/source-review/versions` +
        "?limit=1&offset=1",
    });
    expect(
      previousVersionPage.statusCode,
      previousVersionPage.body,
    ).toBe(200);
    expect(previousVersionPage.json()).toMatchObject({
      total: 2,
      limit: 1,
      offset: 1,
      hasMore: false,
      items: [
        {
          nodeVersionId: firstVersion.nodeVersionId,
          versionNo: 1,
          structuredOutput,
        },
      ],
    });

    const investmentReportOne = await harness.alpha.inject({
      method: "POST",
      url: `${workflowUrl}/reports`,
      payload: {
        idempotencyKey: "investment-report-v1",
        reportType: "investment_report",
        title: "全量迁移投资报告",
        markdown: "# 第一版投资报告\n\n初步结论。",
        nodeVersions: {
          "source-review": firstVersion.nodeVersionId,
        },
        documentVersions: [
          {
            documentId: "document-1",
            versionId: "document-version-1",
          },
        ],
      },
    });
    expect(
      investmentReportOne.statusCode,
      investmentReportOne.body,
    ).toBe(201);
    const investmentReportTwo = await harness.alpha.inject({
      method: "POST",
      url: `${workflowUrl}/reports`,
      payload: {
        idempotencyKey: "investment-report-v2",
        reportType: "investment_report",
        title: "全量迁移投资报告",
        markdown: "# 第二版投资报告\n\n最终结论与风险边界。",
        nodeVersions: {
          "source-review": secondVersion.nodeVersionId,
          "business-analysis": businessVersionId,
        },
        documentVersions: [
          {
            documentId: "document-1",
            versionId: "document-version-2",
          },
        ],
      },
    });
    expect(
      investmentReportTwo.statusCode,
      investmentReportTwo.body,
    ).toBe(201);
    const riskReport = await harness.alpha.inject({
      method: "POST",
      url: `${workflowUrl}/reports`,
      payload: {
        idempotencyKey: "risk-report-v1",
        reportType: "risk_report",
        title: "风险专题报告",
        markdown: "# 风险专题报告\n\n需求与价格风险。",
        nodeVersions: {
          "source-review": secondVersion.nodeVersionId,
        },
        documentVersions: [],
      },
    });
    expect(riskReport.statusCode, riskReport.body).toBe(201);

    const reportPages = await Promise.all(
      [0, 1].map(async (offset) =>
        harness.alpha.inject({
          method: "GET",
          url: `${workflowUrl}/reports?limit=1&offset=${String(offset)}`,
        }),
      ),
    );
    for (const [offset, response] of reportPages.entries()) {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        total: 2,
        limit: 1,
        offset,
        hasMore: offset === 0,
        items: [
          {
            currentVersionNo: expect.any(Number),
            currentVersion: {
              reportVersionId: expect.any(String),
              markdown: expect.any(String),
              nodeVersions: expect.any(Object),
              documentVersions: expect.any(Array),
            },
          },
        ],
      });
    }
    const reports = reportPages.flatMap((response) =>
      response.json<{
        items: Array<{
          reportType: string;
          currentVersionNo: number;
          currentVersion: {
            versionNo: number;
            markdown: string;
            nodeVersions: Record<string, string>;
            documentVersions: unknown[];
          };
        }>;
      }>().items,
    );
    expect(
      reports.find(
        (report) => report.reportType === "investment_report",
      ),
    ).toEqual(
      expect.objectContaining({
        currentVersionNo: 2,
        currentVersion: expect.objectContaining({
          versionNo: 2,
          markdown: "# 第二版投资报告\n\n最终结论与风险边界。",
          nodeVersions: {
            "source-review": secondVersion.nodeVersionId,
            "business-analysis": businessVersionId,
          },
          documentVersions: [
            {
              documentId: "document-1",
              versionId: "document-version-2",
            },
          ],
        }),
      }),
    );

    const crossTenantRequests = [
      { method: "GET", url: workflowUrl },
      {
        method: "POST",
        url: `${workflowUrl}/initialize`,
        payload: {},
      },
      {
        method: "POST",
        url: `${workflowUrl}/context`,
        payload: { nodeIds: ["source-review"] },
      },
      {
        method: "POST",
        url: `${workflowUrl}/current-node`,
        payload: { nodeId: "source-review" },
      },
      {
        method: "POST",
        url: `${workflowUrl}/nodes/source-review/start`,
        payload: {
          idempotencyKey: "cross-tenant-start",
          inputManifest: {},
        },
      },
      {
        method: "POST",
        url: `${workflowUrl}/nodes/source-review/complete`,
        payload: {
          outputMarkdown: "Cross-tenant write",
          structuredOutput: {},
          evidenceIds: [],
        },
      },
      {
        method: "POST",
        url: `${workflowUrl}/nodes/source-review/assumptions`,
        payload: {
          idempotencyKey: "cross-tenant-assumption",
          content: "Cross-tenant assumption",
          evidenceIds: [],
        },
      },
      {
        method: "GET",
        url: `${workflowUrl}/nodes/source-review/assumptions`,
      },
      {
        method: "GET",
        url: `${workflowUrl}/nodes/source-review/versions`,
      },
      {
        method: "GET",
        url: `${workflowUrl}/reports`,
      },
    ] as const;
    for (const request of crossTenantRequests) {
      const response = await harness.beta.inject(request);
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ error: "not_found" });
    }
  });
});
