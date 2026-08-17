import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runWorkflowStoreMigrations } from "../src/migrations.js";
import {
  WorkflowRepository,
  type NodeVersion,
} from "../src/workflow-repository.js";

describe("WorkflowRepository", () => {
  let database: DatabaseSync;
  let now: Date;
  let repository: WorkflowRepository;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys=ON");
    runWorkflowStoreMigrations(database);
    now = new Date("2026-07-30T01:00:00.000Z");
    repository = new WorkflowRepository(database, {
      clock: () => new Date(now),
    });
  });

  afterEach(() => {
    database.close();
  });

  it("creates a stable workflow and participates in an outer transaction", () => {
    const first = repository.getOrCreateWorkflow({
      datasetId: "dataset-a",
    });
    const repeated = repository.getOrCreateWorkflow({
      datasetId: "dataset-a",
    });

    expect(repeated).toEqual(first);
    expect(repository.listWorkflows({ datasetId: "dataset-a" }).total).toBe(1);

    database.exec("BEGIN");
    repository.getOrCreateWorkflow({
      datasetId: "rolled-back",
      workflowType: "custom",
    });
    database.exec("ROLLBACK");

    expect(repository.listWorkflows({ datasetId: "rolled-back" }).total).toBe(
      0,
    );
  });

  it("runs nodes through versions, preserves Evidence IDs, and marks all descendants stale", () => {
    const workflow = repository.getOrCreateWorkflow({
      datasetId: "dataset-a",
    });
    const source = repository.createNode({
      workflowId: workflow.workflowId,
      idempotencyKey: "source",
      nodeType: "source",
      title: "资料审阅",
    });
    const analysis = repository.createNode({
      workflowId: workflow.workflowId,
      idempotencyKey: "analysis",
      nodeType: "analysis",
      title: "经营分析",
      dependencies: [{ nodeId: source.nodeId }],
    });
    const conclusion = repository.createNode({
      workflowId: workflow.workflowId,
      idempotencyKey: "conclusion",
      nodeType: "conclusion",
      title: "投资结论",
      dependencies: [{ nodeId: analysis.nodeId }],
    });

    expect(source.status).toBe("ready");
    expect(analysis.status).toBe("pending");
    expect(() =>
      repository.startNode({
        workflowId: workflow.workflowId,
        nodeId: analysis.nodeId,
      }),
    ).toThrow(/pending|dependencies are not complete/i);

    const sourceV1 = repository.startNode({
      workflowId: workflow.workflowId,
      nodeId: source.nodeId,
      idempotencyKey: "source-version-1",
      inputManifest: { documents: ["document:doc-v1"] },
      modelName: "pi-agent",
    });
    const repeatedStart = repository.startNode({
      workflowId: workflow.workflowId,
      nodeId: source.nodeId,
      idempotencyKey: "source-version-1",
      inputManifest: { documents: ["document:doc-v1"] },
      modelName: "pi-agent",
    });
    expect(repeatedStart.nodeVersionId).toBe(sourceV1.nodeVersionId);

    const sourceCompleted = repository.completeNode({
      workflowId: workflow.workflowId,
      nodeId: source.nodeId,
      nodeVersionId: sourceV1.nodeVersionId,
      outputMarkdown: "资料已审阅。",
      structuredOutput: { coverage: 0.98 },
      evidenceIds: ["chunk:raw.case-sensitive_ID", "fact:revenue-2026"],
    });
    expect(sourceCompleted.evidenceIds).toEqual([
      "chunk:raw.case-sensitive_ID",
      "fact:revenue-2026",
    ]);
    expect(
      repository.completeNode({
        workflowId: workflow.workflowId,
        nodeId: source.nodeId,
        nodeVersionId: sourceV1.nodeVersionId,
        outputMarkdown: "资料已审阅。",
        structuredOutput: { coverage: 0.98 },
        evidenceIds: ["fact:revenue-2026", "chunk:raw.case-sensitive_ID"],
      }).nodeVersionId,
    ).toBe(sourceV1.nodeVersionId);
    expect(() =>
      repository.completeNode({
        workflowId: workflow.workflowId,
        nodeId: source.nodeId,
        nodeVersionId: sourceV1.nodeVersionId,
        outputMarkdown: "资料已审阅。",
        structuredOutput: { coverage: 0.98 },
        evidenceIds: ["fact:different"],
      }),
    ).toThrow(/cannot be overwritten/i);
    expect(
      repository.startNode({
        workflowId: workflow.workflowId,
        nodeId: source.nodeId,
        idempotencyKey: "source-version-1",
        inputManifest: { documents: ["document:doc-v1"] },
        modelName: "pi-agent",
      }).nodeVersionId,
    ).toBe(sourceV1.nodeVersionId);
    expect(repository.getNode(workflow.workflowId, analysis.nodeId).status).toBe(
      "ready",
    );

    const complete = (nodeId: string, output: string): NodeVersion => {
      repository.startNode({ workflowId: workflow.workflowId, nodeId });
      return repository.completeNode({
        workflowId: workflow.workflowId,
        nodeId,
        outputMarkdown: output,
      });
    };
    complete(analysis.nodeId, "经营质量改善。");
    complete(conclusion.nodeId, "维持关注。");
    expect(
      repository.removeDependency({
        workflowId: workflow.workflowId,
        nodeId: conclusion.nodeId,
        dependsOnNodeId: analysis.nodeId,
      }),
    ).toBe(true);
    expect(
      repository.getNode(workflow.workflowId, conclusion.nodeId).status,
    ).toBe("stale");
    repository.addDependency({
      workflowId: workflow.workflowId,
      nodeId: conclusion.nodeId,
      dependsOnNodeId: analysis.nodeId,
    });

    now = new Date("2026-07-30T02:00:00.000Z");
    repository.startNode({
      workflowId: workflow.workflowId,
      nodeId: source.nodeId,
      idempotencyKey: "source-version-2",
    });
    repository.completeNode({
      workflowId: workflow.workflowId,
      nodeId: source.nodeId,
      outputMarkdown: "资料出现新版本。",
    });

    expect(repository.getNode(workflow.workflowId, analysis.nodeId).status).toBe(
      "stale",
    );
    expect(
      repository.getNode(workflow.workflowId, conclusion.nodeId).status,
    ).toBe("stale");
    expect(
      repository.listNodeVersions(workflow.workflowId, source.nodeId, {
        limit: 1,
      }),
    ).toMatchObject({
      total: 2,
      limit: 1,
      hasMore: true,
    });
    expect(
      database
        .prepare(
          `SELECT evidence_id FROM workflow_store_evidence_references
           WHERE owner_type='workflow-node-version' ORDER BY evidence_id`,
        )
        .all()
        .map((row) => (row as { evidence_id: string }).evidence_id),
    ).toEqual(["chunk:raw.case-sensitive_ID", "fact:revenue-2026"]);
  });

  it("rejects dependency cycles and atomically preserves context order", () => {
    const workflow = repository.getOrCreateWorkflow({
      datasetId: "dataset-a",
    });
    const first = repository.createNode({
      workflowId: workflow.workflowId,
      idempotencyKey: "first",
      nodeType: "analysis",
      title: "First",
    });
    const second = repository.createNode({
      workflowId: workflow.workflowId,
      idempotencyKey: "second",
      nodeType: "analysis",
      title: "Second",
      dependencies: [{ nodeId: first.nodeId }],
    });
    const third = repository.createNode({
      workflowId: workflow.workflowId,
      idempotencyKey: "third",
      nodeType: "analysis",
      title: "Third",
      dependencies: [{ nodeId: second.nodeId }],
    });

    expect(() =>
      repository.addDependency({
        workflowId: workflow.workflowId,
        nodeId: first.nodeId,
        dependsOnNodeId: third.nodeId,
      }),
    ).toThrow(/cycle/i);

    const selected = repository.setContext(workflow.workflowId, [
      third.nodeId,
      first.nodeId,
      third.nodeId,
      second.nodeId,
    ]);
    expect(selected.nodeIds).toEqual([
      third.nodeId,
      first.nodeId,
      second.nodeId,
    ]);
    expect(repository.getContext(workflow.workflowId)).toEqual(selected);
    expect(
      repository.selectCurrentNode(workflow.workflowId, second.nodeId)
        .currentNodeId,
    ).toBe(second.nodeId);

    database.exec("BEGIN");
    repository.setContext(workflow.workflowId, [first.nodeId]);
    database.exec("ROLLBACK");
    expect(repository.getContext(workflow.workflowId)).toEqual(selected);
  });

  it("uses deterministic assumption idempotency and enforces its state machine", () => {
    const workflow = repository.getOrCreateWorkflow({
      datasetId: "dataset-a",
    });
    const node = repository.createNode({
      workflowId: workflow.workflowId,
      idempotencyKey: "assumption-node",
      nodeType: "assumption",
      title: "核心假设",
    });
    const assumption = repository.createAssumption({
      workflowId: workflow.workflowId,
      nodeId: node.nodeId,
      idempotencyKey: "revenue-growth",
      content: "收入增长率保持在 15%。",
      evidenceIds: ["cell:DCF!B12"],
    });
    const repeated = repository.createAssumption({
      workflowId: workflow.workflowId,
      nodeId: node.nodeId,
      idempotencyKey: "revenue-growth",
      content: "收入增长率保持在 15%。",
      evidenceIds: ["cell:DCF!B12"],
    });

    expect(repeated).toEqual(assumption);
    expect(assumption.evidenceIds).toEqual(["cell:DCF!B12"]);
    expect(
      repository.transitionAssumption(assumption.assumptionId, "resolved")
        .status,
    ).toBe("resolved");
    expect(() =>
      repository.transitionAssumption(assumption.assumptionId, "dismissed"),
    ).toThrow(/cannot transition/i);
    expect(() =>
      repository.transitionAssumption(assumption.assumptionId, "active"),
    ).toThrow(/cannot transition/i);
    expect(() =>
      repository.createAssumption({
        workflowId: workflow.workflowId,
        nodeId: node.nodeId,
        idempotencyKey: "revenue-growth",
        content: "不同假设。",
      }),
    ).toThrow(/idempotency key/i);
  });

  it("snapshots reports idempotently and decodes stored JSON strictly", () => {
    const workflow = repository.getOrCreateWorkflow({
      datasetId: "dataset-a",
    });
    const node = repository.createNode({
      workflowId: workflow.workflowId,
      idempotencyKey: "report-node",
      nodeType: "analysis",
      title: "经营分析",
    });
    repository.startNode({
      workflowId: workflow.workflowId,
      nodeId: node.nodeId,
    });
    const completed = repository.completeNode({
      workflowId: workflow.workflowId,
      nodeId: node.nodeId,
      outputMarkdown: "收入与现金流同步改善。",
    });

    const report = repository.createReportVersion({
      workflowId: workflow.workflowId,
      idempotencyKey: "report-run-1",
      title: "Demo 投资报告",
      documentVersions: [{ documentId: "document:doc-v1", version: 1 }],
    });
    const repeated = repository.createReportVersion({
      workflowId: workflow.workflowId,
      idempotencyKey: "report-run-1",
      title: "Demo 投资报告",
      documentVersions: [{ documentId: "document:doc-v1", version: 1 }],
    });

    expect(repeated).toEqual(report);
    expect(report.nodeVersions[node.nodeId]).toBe(completed.nodeVersionId);
    expect(report.documentVersions).toEqual([
      { documentId: "document:doc-v1", version: 1 },
    ]);
    expect(report.markdown).toContain("收入与现金流同步改善");
    expect(repository.listReportVersions(report.reportId, { limit: 1 })).toMatchObject(
      {
        total: 1,
        hasMore: false,
      },
    );
    expect(() =>
      repository.createReportVersion({
        workflowId: workflow.workflowId,
        idempotencyKey: "report-run-1",
        title: "Demo 投资报告",
        markdown: "# Changed",
      }),
    ).toThrow(/idempotency key/i);
    repository.transitionWorkflow(workflow.workflowId, "archived");
    expect(
      repository.createReportVersion({
        workflowId: workflow.workflowId,
        idempotencyKey: "report-run-1",
        title: "Demo 投资报告",
        documentVersions: [{ documentId: "document:doc-v1", version: 1 }],
      }),
    ).toEqual(report);

    database.exec("PRAGMA ignore_check_constraints=ON");
    database
      .prepare(
        "UPDATE research_report_versions SET node_versions_json='not-json' WHERE report_version_id=?",
      )
      .run(report.reportVersionId);
    expect(() => repository.getReportVersion(report.reportVersionId)).toThrow(
      /stored json is invalid/i,
    );
  });

  it("paginates workflows and makes archived workflows read-only", () => {
    const first = repository.getOrCreateWorkflow({
      datasetId: "dataset-a",
    });
    repository.getOrCreateWorkflow({ datasetId: "dataset-b" });
    repository.getOrCreateWorkflow({ datasetId: "dataset-c" });

    expect(repository.listWorkflows({ limit: 2, offset: 1 })).toMatchObject({
      total: 3,
      limit: 2,
      offset: 1,
      hasMore: false,
    });
    repository.transitionWorkflow(first.workflowId, "archived");
    expect(() =>
      repository.createNode({
        workflowId: first.workflowId,
        idempotencyKey: "blocked",
        nodeType: "analysis",
        title: "Blocked",
      }),
    ).toThrow(/read-only/i);
    expect(() =>
      repository.transitionWorkflow(first.workflowId, "active"),
    ).toThrow(/cannot transition/i);
  });
});
