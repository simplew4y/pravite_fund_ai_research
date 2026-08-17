import path from "node:path";

import type {
  CompleteWorkflowNodeRequest,
  CreateWorkflowAssumptionRequest,
  CreateWorkflowReportRequest,
  InitializeWorkflowRequest,
  SetWorkflowContextRequest,
  StartWorkflowNodeRequest,
} from "@private-fund/contracts";
import {
  DomainError,
  assertPathWithin,
  type TenantContext,
} from "@private-fund/core";
import type { ControlRepositories } from "@private-fund/db";
import {
  WorkflowStoreError,
  type WorkflowRepository,
} from "@private-fund/workflow-store";

import type {
  JobService,
  ProjectWorkflowService,
} from "./dependencies.js";
import { ProjectResearchStoreManager } from "./research-stores.js";
import { writeNewOrIdenticalProjectFile } from "./secure-files.js";

const DEFAULT_NODES = [
  {
    nodeId: "source-review",
    nodeType: "source",
    title: "资料审阅",
    objective: "确认资料范围、版本、解析质量与缺失项",
    summary: "资料版本、解析质量与覆盖范围",
    positionNo: 10,
    x: 0,
    y: 280,
    tone: "sage",
    kind: "source",
    dependencies: [],
  },
  {
    nodeId: "business-analysis",
    nodeType: "analysis",
    title: "经营分析",
    objective: "分析增长质量、盈利能力、现金流和竞争格局",
    summary: "增长、盈利、现金流与竞争格局",
    positionNo: 20,
    x: 240,
    y: 280,
    tone: "mist",
    kind: "analysis",
    dependencies: ["source-review"],
  },
  {
    nodeId: "core-assumptions",
    nodeType: "assumption",
    title: "核心假设",
    objective: "固化关键经营假设、证据、不确定性和待验证项",
    summary: "关键变量、证据与待验证项",
    positionNo: 30,
    x: 480,
    y: 280,
    tone: "sand",
    kind: "assumption",
    dependencies: ["business-analysis"],
  },
  {
    nodeId: "scenario-analysis",
    nodeType: "scenario_group",
    title: "情景分析",
    objective: "定义防守、基准和进取情景的共同变量",
    summary: "统一情景变量与边界条件",
    positionNo: 40,
    x: 720,
    y: 280,
    tone: "blue",
    kind: "scenario",
    dependencies: ["core-assumptions"],
  },
  {
    nodeId: "defensive-scenario",
    nodeType: "scenario",
    title: "防守情景",
    objective: "评估需求、价格或利润率低于预期时的结果",
    summary: "下行情景及风险暴露",
    positionNo: 50,
    x: 960,
    y: 100,
    tone: "coral",
    kind: "defensive",
    dependencies: ["scenario-analysis"],
  },
  {
    nodeId: "base-scenario",
    nodeType: "scenario",
    title: "基准情景",
    objective: "形成当前证据支持度最高的经营与估值情景",
    summary: "最可能情景与关键变量",
    positionNo: 60,
    x: 960,
    y: 280,
    tone: "blue",
    kind: "base",
    dependencies: ["scenario-analysis"],
  },
  {
    nodeId: "growth-scenario",
    nodeType: "scenario",
    title: "进取情景",
    objective: "评估需求、份额或盈利能力超预期时的结果",
    summary: "上行情景与兑现条件",
    positionNo: 70,
    x: 960,
    y: 460,
    tone: "coral",
    kind: "growth",
    dependencies: ["scenario-analysis"],
  },
  {
    nodeId: "valuation",
    nodeType: "valuation",
    title: "估值",
    objective: "基于三个情景形成估值区间和敏感性分析",
    summary: "多情景估值与敏感性",
    positionNo: 80,
    x: 1200,
    y: 280,
    tone: "lilac",
    kind: "valuation",
    dependencies: [
      "defensive-scenario",
      "base-scenario",
      "growth-scenario",
    ],
  },
  {
    nodeId: "investment-conclusion",
    nodeType: "conclusion",
    title: "投资结论",
    objective: "形成结论、风险、催化剂和待跟踪事项",
    summary: "结论、风险、催化剂与跟踪项",
    positionNo: 90,
    x: 1440,
    y: 280,
    tone: "lilac",
    kind: "conclusion",
    dependencies: ["valuation"],
  },
] as const;

export class RepositoryProjectWorkflowService
  implements ProjectWorkflowService
{
  public constructor(
    private readonly repositories: ControlRepositories,
    private readonly stores: ProjectResearchStoreManager,
    private readonly jobs: JobService,
  ) {}

  public async initialize(
    tenant: TenantContext,
    projectId: string,
    input: InitializeWorkflowRequest,
  ) {
    return this.call(() => {
      const repository = this.repository(tenant, projectId);
      const workflow = repository.getOrCreateWorkflow({
        datasetId: projectId,
        workflowType: input.workflowType,
      });
      for (const node of DEFAULT_NODES) {
        repository.createNode({
          workflowId: workflow.workflowId,
          idempotencyKey: `default:${node.nodeId}:v1`,
          nodeId: node.nodeId,
          nodeType: node.nodeType,
          title: node.title,
          objective: node.objective,
          summary: node.summary,
          positionNo: node.positionNo,
          x: node.x,
          y: node.y,
          tone: node.tone,
          kind: node.kind,
          dependencies: node.dependencies.map((nodeId) => ({
            nodeId,
            dependencyType: "completion" as const,
          })),
        });
      }
      return repository.getSnapshot(workflow.workflowId);
    });
  }

  public async snapshot(tenant: TenantContext, projectId: string) {
    return this.initialize(tenant, projectId, {
      workflowType: "agentic_research_graph_v2",
    });
  }

  public async selectCurrentNode(
    tenant: TenantContext,
    projectId: string,
    nodeId: string | null,
  ) {
    return this.call(() => {
      const repository = this.repository(tenant, projectId);
      const workflow = this.workflow(repository, projectId);
      repository.selectCurrentNode(workflow.workflowId, nodeId);
      return repository.getSnapshot(workflow.workflowId);
    });
  }

  public async setContext(
    tenant: TenantContext,
    projectId: string,
    input: SetWorkflowContextRequest,
  ) {
    return this.call(() => {
      const repository = this.repository(tenant, projectId);
      const workflow = this.workflow(repository, projectId);
      repository.setContext(workflow.workflowId, input.nodeIds);
      return repository.getSnapshot(workflow.workflowId);
    });
  }

  public async startNode(
    tenant: TenantContext,
    projectId: string,
    nodeId: string,
    input: StartWorkflowNodeRequest,
  ) {
    return this.call(() => {
      const repository = this.repository(tenant, projectId);
      const workflow = this.workflow(repository, projectId);
      const nodeVersion = repository.startNode({
        workflowId: workflow.workflowId,
        nodeId,
        ...(input.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: input.idempotencyKey }),
        inputManifest: input.inputManifest,
        ...(input.promptSnapshot === undefined
          ? {}
          : { promptSnapshot: input.promptSnapshot }),
        ...(input.modelName === undefined
          ? {}
          : { modelName: input.modelName }),
      });
      return {
        workflow: repository.getSnapshot(workflow.workflowId),
        nodeVersion,
      };
    });
  }

  public async completeNode(
    tenant: TenantContext,
    projectId: string,
    nodeId: string,
    input: CompleteWorkflowNodeRequest,
  ) {
    return this.call(() => {
      this.validateEvidence(
        tenant,
        projectId,
        input.evidenceIds,
      );
      const repository = this.repository(tenant, projectId);
      const workflow = this.workflow(repository, projectId);
      const nodeVersion = repository.completeNode({
        workflowId: workflow.workflowId,
        nodeId,
        ...(input.nodeVersionId === undefined
          ? {}
          : { nodeVersionId: input.nodeVersionId }),
        outputMarkdown: input.outputMarkdown,
        structuredOutput: input.structuredOutput,
        evidenceIds: input.evidenceIds,
        ...(input.sourceResponseId === undefined
          ? {}
          : { sourceResponseId: input.sourceResponseId }),
        ...(input.modelName === undefined
          ? {}
          : { modelName: input.modelName }),
      });
      return {
        workflow: repository.getSnapshot(workflow.workflowId),
        nodeVersion,
      };
    });
  }

  public async createAssumption(
    tenant: TenantContext,
    projectId: string,
    nodeId: string,
    input: CreateWorkflowAssumptionRequest,
  ) {
    return this.call(() => {
      this.validateEvidence(
        tenant,
        projectId,
        input.evidenceIds,
      );
      const repository = this.repository(tenant, projectId);
      const workflow = this.workflow(repository, projectId);
      const assumption = repository.createAssumption({
        workflowId: workflow.workflowId,
        nodeId,
        idempotencyKey: input.idempotencyKey,
        content: input.content,
        ...(input.sourceResponseId === undefined
          ? {}
          : { sourceResponseId: input.sourceResponseId }),
        evidenceIds: input.evidenceIds,
      });
      return {
        workflow: repository.getSnapshot(workflow.workflowId),
        assumption,
      };
    });
  }

  public async assumptions(
    tenant: TenantContext,
    projectId: string,
    nodeId: string,
    options: {
      limit: number;
      offset: number;
      status?: "active" | "resolved" | "dismissed";
    },
  ) {
    return this.call(() => {
      const repository = this.repository(tenant, projectId);
      const workflow = this.workflow(repository, projectId);
      repository.getNode(workflow.workflowId, nodeId);
      return repository.listAssumptions(workflow.workflowId, {
        nodeId,
        limit: options.limit,
        offset: options.offset,
        ...(options.status === undefined
          ? {}
          : { status: options.status }),
      });
    });
  }

  public async nodeVersions(
    tenant: TenantContext,
    projectId: string,
    nodeId: string,
    options: { limit: number; offset: number },
  ) {
    return this.call(() => {
      const repository = this.repository(tenant, projectId);
      const workflow = this.workflow(repository, projectId);
      return repository.listNodeVersions(
        workflow.workflowId,
        nodeId,
        options,
      );
    });
  }

  public async reports(
    tenant: TenantContext,
    projectId: string,
    options: { limit: number; offset: number },
  ) {
    return this.call(() => {
      const repository = this.repository(tenant, projectId);
      const workflow = this.workflow(repository, projectId);
      const reports = repository.listReports(
        workflow.workflowId,
        options,
      );
      return {
        ...reports,
        items: reports.items.map((report) => {
          if (report.currentVersionNo === 0) {
            return { ...report, currentVersion: null };
          }
          const currentVersion = repository.listReportVersions(
            report.reportId,
            { limit: 1, offset: 0 },
          ).items[0];
          if (
            currentVersion === undefined ||
            currentVersion.versionNo !== report.currentVersionNo
          ) {
            throw new WorkflowStoreError(
              `Report ${report.reportId} does not have its declared current version`,
              "corrupt_json",
            );
          }
          return { ...report, currentVersion };
        }),
      };
    });
  }

  public async createReport(
    tenant: TenantContext,
    projectId: string,
    input: CreateWorkflowReportRequest,
  ) {
    const created = this.call(() => {
      const repository = this.repository(tenant, projectId);
      const workflow = this.workflow(repository, projectId);
      const version = repository.createReportVersion({
        workflowId: workflow.workflowId,
        reportType: input.reportType,
        title: input.title,
        idempotencyKey: input.idempotencyKey,
        ...(input.markdown === undefined
          ? {}
          : { markdown: input.markdown }),
        ...(input.nodeVersions === undefined
          ? {}
          : { nodeVersions: input.nodeVersions }),
        ...(input.documentVersions === undefined
          ? {}
          : { documentVersions: input.documentVersions }),
      });
      return {
        report: repository.getReport(version.reportId),
        version,
      };
    });
    const projectRoot = this.projectRoot(tenant, projectId);
    const sourcePath = await writeNewOrIdenticalProjectFile(
      projectRoot,
      path.posix.join(
        "artifacts",
        "reports",
        "sources",
        `${created.version.reportVersionId}.md`,
      ),
      Buffer.from(created.version.markdown, "utf8"),
    );
    const queued = await this.jobs.enqueue(tenant, {
      projectId,
      type: "report.generate",
      payload: {
        datasetId: projectId,
        sourceKind: "workflow-report",
        reportVersionId: created.version.reportVersionId,
        inputPath: sourcePath,
        outputDirectory: path.join(
          projectRoot,
          "artifacts",
          "report-renders",
          created.version.reportVersionId,
        ),
        computeOperation: "render_report",
        options: {
          title: created.report.title,
          outputBasename: `report-${String(created.version.versionNo)}`,
          renderPdf: true,
          requirePdf: false,
        },
      },
      idempotencyKey: `${input.idempotencyKey}:render:${created.version.reportVersionId}`,
      maxAttempts: 3,
    });
    return {
      ...created,
      job: queued.job,
      created: queued.created,
    };
  }

  private workflow(
    repository: WorkflowRepository,
    projectId: string,
  ) {
    return repository.getOrCreateWorkflow({
      datasetId: projectId,
      workflowType: "agentic_research_graph_v2",
    });
  }

  private repository(
    tenant: TenantContext,
    projectId: string,
  ): WorkflowRepository {
    return this.stores.getWorkflow(
      this.projectRoot(tenant, projectId),
    ).workflow;
  }

  private validateEvidence(
    tenant: TenantContext,
    projectId: string,
    evidenceIds: readonly string[],
  ): void {
    if (evidenceIds.length === 0) {
      return;
    }
    const projectRoot = this.projectRoot(tenant, projectId);
    const evidence = this.stores.get(projectRoot).evidence;
    for (const evidenceId of evidenceIds) {
      if (evidence.find(evidenceId) === null) {
        throw new DomainError(
          `Evidence reference does not resolve in this project: ${evidenceId}`,
          "invalid_evidence_reference",
          400,
        );
      }
    }
  }

  private projectRoot(
    tenant: TenantContext,
    projectId: string,
  ): string {
    this.repositories.projects.getForTenant(
      tenant.dataNamespace,
      projectId,
    );
    return assertPathWithin(
      path.join(tenant.projectsRoot, projectId),
      tenant.root,
    );
  }

  private call<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (!(error instanceof WorkflowStoreError)) {
        throw error;
      }
      const status =
        error.code === "not_found"
          ? 404
          : error.code === "conflict" ||
              error.code === "invalid_state"
            ? 409
            : error.code === "corrupt_json"
              ? 500
              : 400;
      throw new DomainError(
        error.message,
        `workflow_${error.code}`,
        status,
      );
    }
  }
}
