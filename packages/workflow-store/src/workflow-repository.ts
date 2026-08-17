import type { DatabaseSync } from "node:sqlite";

import {
  WorkflowStoreError,
  assertOneOf,
  decodeJsonArray,
  decodeJsonObject,
  encodeJson,
  normalizeEvidenceIds,
  nowIso,
  pageOptions,
  pageResult,
  recordEvidenceReferences,
  requireText,
  stableId,
  toRecord,
  withTransaction,
  type JsonValue,
  type Page,
  type PageOptions,
  type SqlRow,
} from "./shared.js";

export const WORKFLOW_STATUSES = [
  "active",
  "paused",
  "completed",
  "archived",
] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const NODE_STATUSES = [
  "pending",
  "ready",
  "running",
  "completed",
  "stale",
  "failed",
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const NODE_VERSION_STATUSES = ["running", "completed", "failed"] as const;
export type NodeVersionStatus = (typeof NODE_VERSION_STATUSES)[number];

export const DEPENDENCY_TYPES = ["completion", "context"] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

export const ASSUMPTION_STATUSES = [
  "active",
  "resolved",
  "dismissed",
] as const;
export type AssumptionStatus = (typeof ASSUMPTION_STATUSES)[number];

export interface Workflow {
  readonly workflowId: string;
  readonly datasetId: string;
  readonly workflowType: string;
  readonly status: WorkflowStatus;
  readonly currentNodeId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowNode {
  readonly workflowId: string;
  readonly nodeId: string;
  readonly nodeType: string;
  readonly title: string;
  readonly objective: string;
  readonly summary: string;
  readonly status: NodeStatus;
  readonly currentVersionNo: number;
  readonly positionNo: number;
  readonly x: number;
  readonly y: number;
  readonly tone: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowDependency {
  readonly workflowId: string;
  readonly nodeId: string;
  readonly dependsOnNodeId: string;
  readonly dependencyType: DependencyType;
}

export interface NodeVersion {
  readonly nodeVersionId: string;
  readonly workflowId: string;
  readonly nodeId: string;
  readonly versionNo: number;
  readonly status: NodeVersionStatus;
  readonly inputManifest: Record<string, JsonValue>;
  readonly outputMarkdown: string | null;
  readonly structuredOutput: Record<string, JsonValue> | null;
  readonly promptSnapshot: string | null;
  readonly modelName: string | null;
  readonly sourceResponseId: string | null;
  readonly idempotencyKey: string | null;
  readonly evidenceIds: string[];
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface WorkflowContext {
  readonly workflowId: string;
  readonly nodeIds: string[];
}

export interface Assumption {
  readonly assumptionId: string;
  readonly workflowId: string;
  readonly nodeId: string;
  readonly content: string;
  readonly sourceResponseId: string | null;
  readonly status: AssumptionStatus;
  readonly evidenceIds: string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ResearchReport {
  readonly reportId: string;
  readonly workflowId: string;
  readonly reportType: string;
  readonly title: string;
  readonly currentVersionNo: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReportVersion {
  readonly reportVersionId: string;
  readonly reportId: string;
  readonly versionNo: number;
  readonly nodeVersions: Record<string, JsonValue>;
  readonly documentVersions: JsonValue[];
  readonly markdown: string;
  readonly createdAt: string;
}

export interface WorkflowSnapshot {
  readonly workflow: Workflow;
  readonly nodes: WorkflowNode[];
  readonly dependencies: WorkflowDependency[];
  readonly context: WorkflowContext;
}

export interface CreateNodeInput {
  readonly workflowId: string;
  readonly idempotencyKey: string;
  readonly nodeId?: string;
  readonly nodeType: string;
  readonly title: string;
  readonly objective?: string;
  readonly summary?: string;
  readonly dependencies?: readonly {
    readonly nodeId: string;
    readonly dependencyType?: DependencyType;
  }[];
  readonly positionNo?: number;
  readonly x?: number;
  readonly y?: number;
  readonly tone?: string;
  readonly kind?: string;
}

export interface StartNodeInput {
  readonly workflowId: string;
  readonly nodeId: string;
  readonly idempotencyKey?: string;
  readonly inputManifest?: Record<string, unknown>;
  readonly promptSnapshot?: string | null;
  readonly modelName?: string | null;
}

export interface CompleteNodeInput {
  readonly workflowId: string;
  readonly nodeId: string;
  readonly nodeVersionId?: string;
  readonly outputMarkdown: string;
  readonly structuredOutput?: Record<string, unknown>;
  readonly evidenceIds?: readonly string[];
  readonly sourceResponseId?: string | null;
  readonly modelName?: string | null;
}

export interface CreateAssumptionInput {
  readonly workflowId: string;
  readonly nodeId: string;
  readonly idempotencyKey: string;
  readonly content: string;
  readonly sourceResponseId?: string | null;
  readonly evidenceIds?: readonly string[];
}

export interface CreateReportVersionInput {
  readonly workflowId: string;
  readonly reportType?: string;
  readonly title: string;
  readonly idempotencyKey: string;
  readonly markdown?: string;
  readonly nodeVersions?: Record<string, unknown>;
  readonly documentVersions?: readonly unknown[];
}

export interface WorkflowRepositoryOptions {
  readonly clock?: () => Date;
}

const WORKFLOW_TRANSITIONS: Readonly<
  Record<WorkflowStatus, readonly WorkflowStatus[]>
> = {
  active: ["paused", "completed", "archived"],
  paused: ["active", "completed", "archived"],
  completed: ["active", "archived"],
  archived: [],
};

const ASSUMPTION_TRANSITIONS: Readonly<
  Record<AssumptionStatus, readonly AssumptionStatus[]>
> = {
  active: ["resolved", "dismissed"],
  resolved: [],
  dismissed: [],
};

function textColumn(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new WorkflowStoreError(`Column ${key} is not text`, "corrupt_json");
  }
  return value;
}

function optionalTextColumn(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new WorkflowStoreError(`Column ${key} is not nullable text`, "corrupt_json");
  }
  return value;
}

function numberColumn(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WorkflowStoreError(`Column ${key} is not numeric`, "corrupt_json");
  }
  return value;
}

function mapWorkflow(row: SqlRow): Workflow {
  const status = textColumn(row, "status");
  assertOneOf(status, WORKFLOW_STATUSES, "stored workflow status");
  return {
    workflowId: textColumn(row, "workflow_id"),
    datasetId: textColumn(row, "dataset_id"),
    workflowType: textColumn(row, "workflow_type"),
    status,
    currentNodeId: optionalTextColumn(row, "current_node_id"),
    createdAt: textColumn(row, "created_at"),
    updatedAt: textColumn(row, "updated_at"),
  };
}

function mapNode(row: SqlRow): WorkflowNode {
  const status = textColumn(row, "status");
  assertOneOf(status, NODE_STATUSES, "stored node status");
  return {
    workflowId: textColumn(row, "workflow_id"),
    nodeId: textColumn(row, "node_id"),
    nodeType: textColumn(row, "node_type"),
    title: textColumn(row, "title"),
    objective: textColumn(row, "objective"),
    summary: textColumn(row, "summary"),
    status,
    currentVersionNo: numberColumn(row, "current_version_no"),
    positionNo: numberColumn(row, "position_no"),
    x: numberColumn(row, "x"),
    y: numberColumn(row, "y"),
    tone: textColumn(row, "tone"),
    kind: textColumn(row, "kind"),
    createdAt: textColumn(row, "created_at"),
    updatedAt: textColumn(row, "updated_at"),
  };
}

function mapDependency(row: SqlRow): WorkflowDependency {
  const dependencyType = textColumn(row, "dependency_type");
  assertOneOf(dependencyType, DEPENDENCY_TYPES, "stored dependency type");
  return {
    workflowId: textColumn(row, "workflow_id"),
    nodeId: textColumn(row, "node_id"),
    dependsOnNodeId: textColumn(row, "depends_on_node_id"),
    dependencyType,
  };
}

function mapReport(row: SqlRow): ResearchReport {
  return {
    reportId: textColumn(row, "report_id"),
    workflowId: textColumn(row, "workflow_id"),
    reportType: textColumn(row, "report_type"),
    title: textColumn(row, "title"),
    currentVersionNo: numberColumn(row, "current_version_no"),
    createdAt: textColumn(row, "created_at"),
    updatedAt: textColumn(row, "updated_at"),
  };
}

function uniqueStrings(values: readonly string[], field: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = requireText(value, field, 240);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

export class WorkflowRepository {
  readonly #database: DatabaseSync;
  readonly #clock: () => Date;

  public constructor(
    database: DatabaseSync,
    options: WorkflowRepositoryOptions = {},
  ) {
    this.#database = database;
    this.#clock = options.clock ?? (() => new Date());
  }

  public getOrCreateWorkflow(input: {
    readonly datasetId: string;
    readonly workflowType?: string;
  }): Workflow {
    const datasetId = requireText(input.datasetId, "datasetId", 240);
    const workflowType = requireText(
      input.workflowType ?? "agentic_research_graph_v2",
      "workflowType",
      120,
    );
    return withTransaction(this.#database, () => {
      const existing = this.#database
        .prepare(
          `SELECT * FROM research_workflows
           WHERE dataset_id=? AND workflow_type=?`,
        )
        .get(datasetId, workflowType);
      if (existing !== undefined) {
        return mapWorkflow(toRecord(existing));
      }
      const workflowId = stableId("wf", datasetId, workflowType);
      const now = this.#now();
      this.#database
        .prepare(
          `INSERT INTO research_workflows
             (workflow_id, dataset_id, workflow_type, status, current_node_id,
              created_at, updated_at)
           VALUES (?, ?, ?, 'active', NULL, ?, ?)`,
        )
        .run(workflowId, datasetId, workflowType, now, now);
      return this.getWorkflow(workflowId);
    });
  }

  public getWorkflow(workflowId: string): Workflow {
    const id = requireText(workflowId, "workflowId", 240);
    const row = this.#database
      .prepare("SELECT * FROM research_workflows WHERE workflow_id=?")
      .get(id);
    if (row === undefined) {
      throw new WorkflowStoreError(`Workflow ${id} was not found`, "not_found");
    }
    return mapWorkflow(toRecord(row));
  }

  public listWorkflows(
    options: PageOptions & {
      readonly datasetId?: string;
      readonly status?: WorkflowStatus;
    } = {},
  ): Page<Workflow> {
    const page = pageOptions(options);
    const predicates: string[] = [];
    const parameters: string[] = [];
    if (options.datasetId !== undefined) {
      predicates.push("dataset_id=?");
      parameters.push(requireText(options.datasetId, "datasetId", 240));
    }
    if (options.status !== undefined) {
      assertOneOf(options.status, WORKFLOW_STATUSES, "status");
      predicates.push("status=?");
      parameters.push(options.status);
    }
    const where = predicates.length === 0 ? "" : `WHERE ${predicates.join(" AND ")}`;
    const count = toRecord(
      this.#database
        .prepare(`SELECT COUNT(*) AS count FROM research_workflows ${where}`)
        .get(...parameters),
    );
    const rows = this.#database
      .prepare(
        `SELECT * FROM research_workflows ${where}
         ORDER BY updated_at DESC, workflow_id LIMIT ? OFFSET ?`,
      )
      .all(...parameters, page.limit, page.offset);
    return pageResult(
      rows.map((row) => mapWorkflow(toRecord(row))),
      numberColumn(count, "count"),
      page,
    );
  }

  public transitionWorkflow(
    workflowId: string,
    nextStatus: WorkflowStatus,
  ): Workflow {
    assertOneOf(nextStatus, WORKFLOW_STATUSES, "nextStatus");
    return withTransaction(this.#database, () => {
      const current = this.getWorkflow(workflowId);
      if (current.status === nextStatus) {
        return current;
      }
      if (!WORKFLOW_TRANSITIONS[current.status].includes(nextStatus)) {
        throw new WorkflowStoreError(
          `Workflow cannot transition from ${current.status} to ${nextStatus}`,
          "invalid_state",
        );
      }
      this.#database
        .prepare(
          "UPDATE research_workflows SET status=?, updated_at=? WHERE workflow_id=?",
        )
        .run(nextStatus, this.#now(), current.workflowId);
      return this.getWorkflow(current.workflowId);
    });
  }

  public createNode(input: CreateNodeInput): WorkflowNode {
    const workflowId = requireText(input.workflowId, "workflowId", 240);
    const idempotencyKey = requireText(
      input.idempotencyKey,
      "idempotencyKey",
      500,
    );
    const nodeId =
      input.nodeId === undefined
        ? stableId("node", workflowId, idempotencyKey)
        : requireText(input.nodeId, "nodeId", 240);
    const nodeType = requireText(input.nodeType, "nodeType", 120);
    const title = requireText(input.title, "title", 500);
    const objective = requireText(input.objective ?? title, "objective", 8_000);
    const summary = requireText(input.summary ?? objective, "summary", 8_000);
    const tone = requireText(input.tone ?? "mist", "tone", 80);
    const kind = requireText(input.kind ?? nodeType, "kind", 80);
    const dependencies = input.dependencies ?? [];

    return withTransaction(this.#database, () => {
      this.#assertWritableWorkflow(workflowId);
      const existing = this.#database
        .prepare(
          "SELECT * FROM research_nodes WHERE workflow_id=? AND node_id=?",
        )
        .get(workflowId, nodeId);
      if (existing !== undefined) {
        const node = mapNode(toRecord(existing));
        if (
          node.nodeType !== nodeType ||
          node.title !== title ||
          node.objective !== objective ||
          node.summary !== summary
        ) {
          throw new WorkflowStoreError(
            `Idempotency key ${idempotencyKey} was reused for a different node`,
            "conflict",
          );
        }
        return node;
      }
      const normalizedDependencies = new Map<string, DependencyType>();
      for (const dependency of dependencies) {
        const parentId = requireText(dependency.nodeId, "dependency.nodeId", 240);
        if (parentId === nodeId) {
          throw new WorkflowStoreError(
            "A node cannot depend on itself",
            "invalid_argument",
          );
        }
        const dependencyType = dependency.dependencyType ?? "completion";
        assertOneOf(dependencyType, DEPENDENCY_TYPES, "dependencyType");
        this.#getNodeInWorkflow(workflowId, parentId);
        normalizedDependencies.set(parentId, dependencyType);
      }
      const positionNo =
        input.positionNo ??
        numberColumn(
          toRecord(
            this.#database
              .prepare(
                `SELECT COALESCE(MAX(position_no), 0) + 10 AS position_no
                 FROM research_nodes WHERE workflow_id=?`,
              )
              .get(workflowId),
          ),
          "position_no",
        );
      if (!Number.isSafeInteger(positionNo)) {
        throw new WorkflowStoreError(
          "positionNo must be a safe integer",
          "invalid_argument",
        );
      }
      const x = input.x ?? 0;
      const y = input.y ?? positionNo * 12;
      this.#assertFiniteNumber(x, "x");
      this.#assertFiniteNumber(y, "y");
      const status: NodeStatus =
        normalizedDependencies.size === 0 ||
        this.#allCompletionDependenciesCompleted(
          workflowId,
          [...normalizedDependencies.entries()],
        )
          ? "ready"
          : "pending";
      const now = this.#now();
      this.#database
        .prepare(
          `INSERT INTO research_nodes
             (workflow_id, node_id, node_type, title, objective, summary, status,
              current_version_no, position_no, x, y, tone, kind, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workflowId,
          nodeId,
          nodeType,
          title,
          objective,
          summary,
          status,
          positionNo,
          x,
          y,
          tone,
          kind,
          now,
          now,
        );
      const insertDependency = this.#database.prepare(
        `INSERT INTO research_node_dependencies
           (workflow_id, node_id, depends_on_node_id, dependency_type)
         VALUES (?, ?, ?, ?)`,
      );
      for (const [parentId, dependencyType] of normalizedDependencies) {
        insertDependency.run(workflowId, nodeId, parentId, dependencyType);
      }
      return this.#getNodeInWorkflow(workflowId, nodeId);
    });
  }

  public getNode(workflowId: string, nodeId: string): WorkflowNode {
    return this.#getNodeInWorkflow(
      requireText(workflowId, "workflowId", 240),
      requireText(nodeId, "nodeId", 240),
    );
  }

  public listNodes(
    workflowId: string,
    options: PageOptions & { readonly status?: NodeStatus } = {},
  ): Page<WorkflowNode> {
    const id = requireText(workflowId, "workflowId", 240);
    this.getWorkflow(id);
    const page = pageOptions(options);
    const parameters: (number | string)[] = [id];
    let filter = "";
    if (options.status !== undefined) {
      assertOneOf(options.status, NODE_STATUSES, "status");
      filter = " AND status=?";
      parameters.push(options.status);
    }
    const count = toRecord(
      this.#database
        .prepare(
          `SELECT COUNT(*) AS count FROM research_nodes
           WHERE workflow_id=?${filter}`,
        )
        .get(...parameters),
    );
    const rows = this.#database
      .prepare(
        `SELECT * FROM research_nodes WHERE workflow_id=?${filter}
         ORDER BY position_no, node_id LIMIT ? OFFSET ?`,
      )
      .all(...parameters, page.limit, page.offset);
    return pageResult(
      rows.map((row) => mapNode(toRecord(row))),
      numberColumn(count, "count"),
      page,
    );
  }

  public addDependency(input: {
    readonly workflowId: string;
    readonly nodeId: string;
    readonly dependsOnNodeId: string;
    readonly dependencyType?: DependencyType;
  }): WorkflowDependency {
    const workflowId = requireText(input.workflowId, "workflowId", 240);
    const nodeId = requireText(input.nodeId, "nodeId", 240);
    const dependsOnNodeId = requireText(
      input.dependsOnNodeId,
      "dependsOnNodeId",
      240,
    );
    const dependencyType = input.dependencyType ?? "completion";
    assertOneOf(dependencyType, DEPENDENCY_TYPES, "dependencyType");
    if (nodeId === dependsOnNodeId) {
      throw new WorkflowStoreError(
        "A node cannot depend on itself",
        "invalid_argument",
      );
    }
    return withTransaction(this.#database, () => {
      this.#assertWritableWorkflow(workflowId);
      const node = this.#getNodeInWorkflow(workflowId, nodeId);
      this.#getNodeInWorkflow(workflowId, dependsOnNodeId);
      if (node.status === "running") {
        throw new WorkflowStoreError(
          "Dependencies cannot change while a node is running",
          "invalid_state",
        );
      }
      if (this.#wouldCreateCycle(workflowId, nodeId, dependsOnNodeId)) {
        throw new WorkflowStoreError(
          "The dependency would create a cycle",
          "invalid_argument",
        );
      }
      this.#database
        .prepare(
          `INSERT INTO research_node_dependencies
             (workflow_id, node_id, depends_on_node_id, dependency_type)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(workflow_id, node_id, depends_on_node_id)
           DO UPDATE SET dependency_type=excluded.dependency_type`,
        )
        .run(workflowId, nodeId, dependsOnNodeId, dependencyType);
      this.#invalidateAfterDependencyChange(workflowId, nodeId);
      return {
        workflowId,
        nodeId,
        dependsOnNodeId,
        dependencyType,
      };
    });
  }

  public removeDependency(input: {
    readonly workflowId: string;
    readonly nodeId: string;
    readonly dependsOnNodeId: string;
  }): boolean {
    const workflowId = requireText(input.workflowId, "workflowId", 240);
    const nodeId = requireText(input.nodeId, "nodeId", 240);
    const dependsOnNodeId = requireText(
      input.dependsOnNodeId,
      "dependsOnNodeId",
      240,
    );
    return withTransaction(this.#database, () => {
      this.#assertWritableWorkflow(workflowId);
      const node = this.#getNodeInWorkflow(workflowId, nodeId);
      if (node.status === "running") {
        throw new WorkflowStoreError(
          "Dependencies cannot change while a node is running",
          "invalid_state",
        );
      }
      const result = this.#database
        .prepare(
          `DELETE FROM research_node_dependencies
           WHERE workflow_id=? AND node_id=? AND depends_on_node_id=?`,
        )
        .run(workflowId, nodeId, dependsOnNodeId);
      this.#invalidateAfterDependencyChange(workflowId, nodeId);
      return result.changes > 0;
    });
  }

  public listDependencies(
    workflowId: string,
    options: PageOptions & { readonly nodeId?: string } = {},
  ): Page<WorkflowDependency> {
    const id = requireText(workflowId, "workflowId", 240);
    this.getWorkflow(id);
    const page = pageOptions(options);
    const parameters: (number | string)[] = [id];
    let filter = "";
    if (options.nodeId !== undefined) {
      filter = " AND node_id=?";
      parameters.push(requireText(options.nodeId, "nodeId", 240));
    }
    const count = toRecord(
      this.#database
        .prepare(
          `SELECT COUNT(*) AS count FROM research_node_dependencies
           WHERE workflow_id=?${filter}`,
        )
        .get(...parameters),
    );
    const rows = this.#database
      .prepare(
        `SELECT * FROM research_node_dependencies
         WHERE workflow_id=?${filter}
         ORDER BY node_id, depends_on_node_id LIMIT ? OFFSET ?`,
      )
      .all(...parameters, page.limit, page.offset);
    return pageResult(
      rows.map((row) => mapDependency(toRecord(row))),
      numberColumn(count, "count"),
      page,
    );
  }

  public setContext(workflowId: string, nodeIds: readonly string[]): WorkflowContext {
    const id = requireText(workflowId, "workflowId", 240);
    const uniqueNodeIds = uniqueStrings(nodeIds, "nodeId");
    return withTransaction(this.#database, () => {
      this.#assertWritableWorkflow(id);
      for (const nodeId of uniqueNodeIds) {
        this.#getNodeInWorkflow(id, nodeId);
      }
      this.#database
        .prepare("DELETE FROM research_workflow_context WHERE workflow_id=?")
        .run(id);
      const insert = this.#database.prepare(
        `INSERT INTO research_workflow_context
           (workflow_id, node_id, selected_at) VALUES (?, ?, ?)`,
      );
      const selectedAt = this.#clock();
      if (!Number.isFinite(selectedAt.getTime())) {
        throw new WorkflowStoreError(
          "Clock returned an invalid date",
          "invalid_argument",
        );
      }
      for (const [index, nodeId] of uniqueNodeIds.entries()) {
        insert.run(
          id,
          nodeId,
          new Date(selectedAt.getTime() + index).toISOString(),
        );
      }
      return { workflowId: id, nodeIds: uniqueNodeIds };
    });
  }

  public getContext(workflowId: string): WorkflowContext {
    const id = requireText(workflowId, "workflowId", 240);
    this.getWorkflow(id);
    const rows = this.#database
      .prepare(
        `SELECT node_id FROM research_workflow_context
         WHERE workflow_id=? ORDER BY selected_at, node_id`,
      )
      .all(id);
    return {
      workflowId: id,
      nodeIds: rows.map((row) => textColumn(toRecord(row), "node_id")),
    };
  }

  public selectCurrentNode(workflowId: string, nodeId: string | null): Workflow {
    const id = requireText(workflowId, "workflowId", 240);
    const normalizedNodeId =
      nodeId === null ? null : requireText(nodeId, "nodeId", 240);
    return withTransaction(this.#database, () => {
      this.#assertWritableWorkflow(id);
      if (normalizedNodeId !== null) {
        this.#getNodeInWorkflow(id, normalizedNodeId);
      }
      this.#database
        .prepare(
          "UPDATE research_workflows SET current_node_id=?, updated_at=? WHERE workflow_id=?",
        )
        .run(normalizedNodeId, this.#now(), id);
      return this.getWorkflow(id);
    });
  }

  public startNode(input: StartNodeInput): NodeVersion {
    const workflowId = requireText(input.workflowId, "workflowId", 240);
    const nodeId = requireText(input.nodeId, "nodeId", 240);
    const idempotencyKey =
      input.idempotencyKey === undefined
        ? null
        : stableId(
            "idem_nv",
            workflowId,
            nodeId,
            requireText(input.idempotencyKey, "idempotencyKey", 500),
          );
    const inputManifest = input.inputManifest ?? {};
    const encodedManifest = encodeJson(inputManifest);
    return withTransaction(this.#database, () => {
      if (idempotencyKey !== null) {
        const retried = this.#database
          .prepare(
            `SELECT * FROM research_node_versions
             WHERE idempotency_key=?`,
          )
          .get(idempotencyKey);
        if (retried !== undefined) {
          const version = toRecord(retried);
          if (
            textColumn(version, "workflow_id") !== workflowId ||
            textColumn(version, "node_id") !== nodeId ||
            textColumn(version, "input_manifest_json") !== encodedManifest ||
            optionalTextColumn(version, "prompt_snapshot") !==
              (input.promptSnapshot ?? null) ||
            optionalTextColumn(version, "model_name") !==
              (input.modelName ?? null)
          ) {
            throw new WorkflowStoreError(
              "The node idempotency key was reused with different inputs",
              "conflict",
            );
          }
          return this.#mapNodeVersion(version);
        }
      }
      this.#assertWritableWorkflow(workflowId);
      const node = this.#getNodeInWorkflow(workflowId, nodeId);
      if (node.status === "running") {
        const existing = this.#database
          .prepare(
            `SELECT * FROM research_node_versions
             WHERE workflow_id=? AND node_id=? AND status='running'
             ORDER BY version_no DESC LIMIT 1`,
          )
          .get(workflowId, nodeId);
        if (existing === undefined) {
          throw new WorkflowStoreError(
            "Node is running without a running version",
            "invalid_state",
          );
        }
        const running = toRecord(existing);
        const runningKey = optionalTextColumn(running, "idempotency_key");
        if (idempotencyKey !== null && runningKey === null) {
          this.#database
            .prepare(
              `UPDATE research_node_versions SET idempotency_key=?
               WHERE node_version_id=? AND idempotency_key IS NULL`,
            )
            .run(idempotencyKey, textColumn(running, "node_version_id"));
          return this.getNodeVersion(textColumn(running, "node_version_id"));
        }
        if (idempotencyKey !== null && runningKey !== idempotencyKey) {
          throw new WorkflowStoreError(
            "Node is already running under another idempotency key",
            "conflict",
          );
        }
        return this.#mapNodeVersion(running);
      }
      if (!["ready", "completed", "stale", "failed"].includes(node.status)) {
        throw new WorkflowStoreError(
          `Node cannot start from ${node.status}`,
          "invalid_state",
        );
      }
      if (
        !this.#allCompletionDependenciesCompleted(
          workflowId,
          this.#dependencyEntries(workflowId, nodeId),
        )
      ) {
        throw new WorkflowStoreError(
          "Completion dependencies are not complete",
          "invalid_state",
        );
      }
      const versionNo = numberColumn(
        toRecord(
          this.#database
            .prepare(
              `SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no
               FROM research_node_versions WHERE workflow_id=? AND node_id=?`,
            )
            .get(workflowId, nodeId),
        ),
        "version_no",
      );
      const nodeVersionId = stableId("nv", workflowId, nodeId, versionNo);
      const now = this.#now();
      this.#database
        .prepare(
          `INSERT INTO research_node_versions
             (node_version_id, workflow_id, node_id, version_no, status,
              input_manifest_json, output_markdown, structured_output_json,
              prompt_snapshot, model_name, source_response_id, idempotency_key,
              created_at, completed_at)
           VALUES (?, ?, ?, ?, 'running', ?, NULL, NULL, ?, ?, NULL, ?, ?, NULL)`,
        )
        .run(
          nodeVersionId,
          workflowId,
          nodeId,
          versionNo,
          encodedManifest,
          input.promptSnapshot ?? null,
          input.modelName ?? null,
          idempotencyKey,
          now,
        );
      this.#database
        .prepare(
          "UPDATE research_nodes SET status='running', updated_at=? WHERE workflow_id=? AND node_id=?",
        )
        .run(now, workflowId, nodeId);
      this.#database
        .prepare(
          "UPDATE research_workflows SET current_node_id=?, updated_at=? WHERE workflow_id=?",
        )
        .run(nodeId, now, workflowId);
      return this.getNodeVersion(nodeVersionId);
    });
  }

  public completeNode(input: CompleteNodeInput): NodeVersion {
    const workflowId = requireText(input.workflowId, "workflowId", 240);
    const nodeId = requireText(input.nodeId, "nodeId", 240);
    const outputMarkdown = requireText(
      input.outputMarkdown,
      "outputMarkdown",
      1_000_000,
    );
    const structuredOutput = encodeJson(input.structuredOutput ?? {});
    const evidenceIds = normalizeEvidenceIds(input.evidenceIds);
    return withTransaction(this.#database, () => {
      this.#assertWritableWorkflow(workflowId);
      const node = this.#getNodeInWorkflow(workflowId, nodeId);
      let versionRow: SqlRow;
      if (input.nodeVersionId !== undefined) {
        versionRow = this.#getNodeVersionRow(
          requireText(input.nodeVersionId, "nodeVersionId", 240),
        );
      } else {
        const row = this.#database
          .prepare(
            `SELECT * FROM research_node_versions
             WHERE workflow_id=? AND node_id=? AND status='running'
             ORDER BY version_no DESC LIMIT 1`,
          )
          .get(workflowId, nodeId);
        if (row === undefined) {
          throw new WorkflowStoreError(
            "Node has no running version to complete",
            "invalid_state",
          );
        }
        versionRow = toRecord(row);
      }
      if (
        textColumn(versionRow, "workflow_id") !== workflowId ||
        textColumn(versionRow, "node_id") !== nodeId
      ) {
        throw new WorkflowStoreError(
          "Node version belongs to another node",
          "invalid_argument",
        );
      }
      const currentStatus = textColumn(versionRow, "status");
      if (currentStatus === "completed") {
        const existingOutput = optionalTextColumn(versionRow, "output_markdown");
        const existingStructured = optionalTextColumn(
          versionRow,
          "structured_output_json",
        );
        const existingEvidenceIds = this.#database
          .prepare(
            `SELECT evidence_id FROM research_node_evidence
             WHERE node_version_id=? ORDER BY evidence_id`,
          )
          .all(textColumn(versionRow, "node_version_id"))
          .map((row) => textColumn(toRecord(row), "evidence_id"));
        if (
          existingOutput !== outputMarkdown ||
          existingStructured !== structuredOutput ||
          (input.evidenceIds !== undefined &&
            encodeJson(existingEvidenceIds) !==
              encodeJson([...evidenceIds].sort())) ||
          (input.sourceResponseId !== undefined &&
            optionalTextColumn(versionRow, "source_response_id") !==
              input.sourceResponseId) ||
          (input.modelName !== undefined &&
            optionalTextColumn(versionRow, "model_name") !== input.modelName)
        ) {
          throw new WorkflowStoreError(
            "A completed node version cannot be overwritten",
            "conflict",
          );
        }
        return this.#mapNodeVersion(versionRow);
      }
      if (currentStatus !== "running" || node.status !== "running") {
        throw new WorkflowStoreError(
          "Only a running node version can be completed",
          "invalid_state",
        );
      }
      const nodeVersionId = textColumn(versionRow, "node_version_id");
      const versionNo = numberColumn(versionRow, "version_no");
      const now = this.#now();
      this.#database
        .prepare(
          `UPDATE research_node_versions
           SET status='completed', output_markdown=?, structured_output_json=?,
               source_response_id=?, model_name=COALESCE(?, model_name),
               completed_at=?
           WHERE node_version_id=?`,
        )
        .run(
          outputMarkdown,
          structuredOutput,
          input.sourceResponseId ?? null,
          input.modelName ?? null,
          now,
          nodeVersionId,
        );
      const insertEvidence = this.#database.prepare(
        `INSERT OR IGNORE INTO research_node_evidence
           (node_version_id, evidence_id, relation_type)
         VALUES (?, ?, 'supports')`,
      );
      for (const evidenceId of evidenceIds) {
        insertEvidence.run(nodeVersionId, evidenceId);
      }
      recordEvidenceReferences(
        this.#database,
        "workflow-node-version",
        nodeVersionId,
        evidenceIds,
        "supports",
        now,
      );
      this.#database
        .prepare(
          `UPDATE research_nodes
           SET status='completed', current_version_no=?, updated_at=?
           WHERE workflow_id=? AND node_id=?`,
        )
        .run(versionNo, now, workflowId, nodeId);
      this.#markDescendantsStale(workflowId, nodeId, now);
      this.#refreshPendingNodes(workflowId, now);
      return this.getNodeVersion(nodeVersionId);
    });
  }

  public failNode(input: {
    readonly workflowId: string;
    readonly nodeId: string;
    readonly nodeVersionId?: string;
    readonly error: string;
  }): NodeVersion {
    const workflowId = requireText(input.workflowId, "workflowId", 240);
    const nodeId = requireText(input.nodeId, "nodeId", 240);
    const errorMessage = requireText(input.error, "error", 20_000);
    return withTransaction(this.#database, () => {
      this.#assertWritableWorkflow(workflowId);
      const node = this.#getNodeInWorkflow(workflowId, nodeId);
      const row =
        input.nodeVersionId === undefined
          ? this.#database
              .prepare(
                `SELECT * FROM research_node_versions
                 WHERE workflow_id=? AND node_id=? AND status='running'
                 ORDER BY version_no DESC LIMIT 1`,
              )
              .get(workflowId, nodeId)
          : this.#database
              .prepare(
                "SELECT * FROM research_node_versions WHERE node_version_id=?",
              )
              .get(requireText(input.nodeVersionId, "nodeVersionId", 240));
      if (row === undefined) {
        throw new WorkflowStoreError(
          "Node has no running version to fail",
          "invalid_state",
        );
      }
      const version = toRecord(row);
      if (
        textColumn(version, "workflow_id") !== workflowId ||
        textColumn(version, "node_id") !== nodeId ||
        textColumn(version, "status") !== "running" ||
        node.status !== "running"
      ) {
        throw new WorkflowStoreError(
          "Only the running version can fail",
          "invalid_state",
        );
      }
      const nodeVersionId = textColumn(version, "node_version_id");
      const now = this.#now();
      this.#database
        .prepare(
          `UPDATE research_node_versions
           SET status='failed', structured_output_json=?, completed_at=?
           WHERE node_version_id=?`,
        )
        .run(encodeJson({ error: errorMessage }), now, nodeVersionId);
      this.#database
        .prepare(
          "UPDATE research_nodes SET status='failed', updated_at=? WHERE workflow_id=? AND node_id=?",
        )
        .run(now, workflowId, nodeId);
      return this.getNodeVersion(nodeVersionId);
    });
  }

  public getNodeVersion(nodeVersionId: string): NodeVersion {
    return this.#mapNodeVersion(
      this.#getNodeVersionRow(
        requireText(nodeVersionId, "nodeVersionId", 240),
      ),
    );
  }

  public listNodeVersions(
    workflowId: string,
    nodeId: string,
    options: PageOptions = {},
  ): Page<NodeVersion> {
    const workflow = requireText(workflowId, "workflowId", 240);
    const node = requireText(nodeId, "nodeId", 240);
    this.#getNodeInWorkflow(workflow, node);
    const page = pageOptions(options);
    const count = toRecord(
      this.#database
        .prepare(
          `SELECT COUNT(*) AS count FROM research_node_versions
           WHERE workflow_id=? AND node_id=?`,
        )
        .get(workflow, node),
    );
    const rows = this.#database
      .prepare(
        `SELECT * FROM research_node_versions
         WHERE workflow_id=? AND node_id=?
         ORDER BY version_no DESC LIMIT ? OFFSET ?`,
      )
      .all(workflow, node, page.limit, page.offset);
    return pageResult(
      rows.map((row) => this.#mapNodeVersion(toRecord(row))),
      numberColumn(count, "count"),
      page,
    );
  }

  public createAssumption(input: CreateAssumptionInput): Assumption {
    const workflowId = requireText(input.workflowId, "workflowId", 240);
    const nodeId = requireText(input.nodeId, "nodeId", 240);
    const idempotencyKey = requireText(
      input.idempotencyKey,
      "idempotencyKey",
      500,
    );
    const content = requireText(input.content, "content", 100_000);
    const evidenceIds = normalizeEvidenceIds(input.evidenceIds);
    const assumptionId = stableId(
      "asm",
      workflowId,
      nodeId,
      idempotencyKey,
    );
    return withTransaction(this.#database, () => {
      this.#assertWritableWorkflow(workflowId);
      this.#getNodeInWorkflow(workflowId, nodeId);
      const existing = this.#database
        .prepare(
          "SELECT * FROM research_assumptions WHERE assumption_id=?",
        )
        .get(assumptionId);
      if (existing !== undefined) {
        const assumption = this.#mapAssumption(toRecord(existing));
        if (
          assumption.content !== content ||
          assumption.sourceResponseId !== (input.sourceResponseId ?? null)
        ) {
          throw new WorkflowStoreError(
            `Idempotency key ${idempotencyKey} was reused for another assumption`,
            "conflict",
          );
        }
        return assumption;
      }
      const now = this.#now();
      this.#database
        .prepare(
          `INSERT INTO research_assumptions
             (assumption_id, workflow_id, node_id, content, source_response_id,
              status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          assumptionId,
          workflowId,
          nodeId,
          content,
          input.sourceResponseId ?? null,
          now,
          now,
        );
      recordEvidenceReferences(
        this.#database,
        "workflow-assumption",
        assumptionId,
        evidenceIds,
        "supports",
        now,
      );
      this.#markDescendantsStale(workflowId, nodeId, now);
      return this.getAssumption(assumptionId);
    });
  }

  public getAssumption(assumptionId: string): Assumption {
    const id = requireText(assumptionId, "assumptionId", 240);
    const row = this.#database
      .prepare("SELECT * FROM research_assumptions WHERE assumption_id=?")
      .get(id);
    if (row === undefined) {
      throw new WorkflowStoreError(
        `Assumption ${id} was not found`,
        "not_found",
      );
    }
    return this.#mapAssumption(toRecord(row));
  }

  public transitionAssumption(
    assumptionId: string,
    nextStatus: AssumptionStatus,
  ): Assumption {
    assertOneOf(nextStatus, ASSUMPTION_STATUSES, "nextStatus");
    return withTransaction(this.#database, () => {
      const current = this.getAssumption(assumptionId);
      this.#assertWritableWorkflow(current.workflowId);
      if (current.status === nextStatus) {
        return current;
      }
      if (!ASSUMPTION_TRANSITIONS[current.status].includes(nextStatus)) {
        throw new WorkflowStoreError(
          `Assumption cannot transition from ${current.status} to ${nextStatus}`,
          "invalid_state",
        );
      }
      const now = this.#now();
      this.#database
        .prepare(
          "UPDATE research_assumptions SET status=?, updated_at=? WHERE assumption_id=?",
        )
        .run(nextStatus, now, current.assumptionId);
      this.#markDescendantsStale(current.workflowId, current.nodeId, now);
      return this.getAssumption(current.assumptionId);
    });
  }

  public listAssumptions(
    workflowId: string,
    options: PageOptions & {
      readonly nodeId?: string;
      readonly status?: AssumptionStatus;
    } = {},
  ): Page<Assumption> {
    const id = requireText(workflowId, "workflowId", 240);
    this.getWorkflow(id);
    const page = pageOptions(options);
    const predicates = ["workflow_id=?"];
    const parameters: (number | string)[] = [id];
    if (options.nodeId !== undefined) {
      predicates.push("node_id=?");
      parameters.push(requireText(options.nodeId, "nodeId", 240));
    }
    if (options.status !== undefined) {
      assertOneOf(options.status, ASSUMPTION_STATUSES, "status");
      predicates.push("status=?");
      parameters.push(options.status);
    }
    const where = predicates.join(" AND ");
    const count = toRecord(
      this.#database
        .prepare(
          `SELECT COUNT(*) AS count FROM research_assumptions WHERE ${where}`,
        )
        .get(...parameters),
    );
    const rows = this.#database
      .prepare(
        `SELECT * FROM research_assumptions WHERE ${where}
         ORDER BY created_at DESC, assumption_id LIMIT ? OFFSET ?`,
      )
      .all(...parameters, page.limit, page.offset);
    return pageResult(
      rows.map((row) => this.#mapAssumption(toRecord(row))),
      numberColumn(count, "count"),
      page,
    );
  }

  public createReportVersion(input: CreateReportVersionInput): ReportVersion {
    const workflowId = requireText(input.workflowId, "workflowId", 240);
    const reportType = requireText(
      input.reportType ?? "investment_memo",
      "reportType",
      120,
    );
    const title = requireText(input.title, "title", 500);
    const idempotencyKey = requireText(
      input.idempotencyKey,
      "idempotencyKey",
      500,
    );
    const reportId = stableId("report", workflowId, reportType);
    const reportVersionId = stableId("rv", reportId, idempotencyKey);
    return withTransaction(this.#database, () => {
      const existing = this.#database
        .prepare(
          "SELECT * FROM research_report_versions WHERE report_version_id=?",
        )
        .get(reportVersionId);
      if (existing !== undefined) {
        const row = toRecord(existing);
        if (
          (input.nodeVersions !== undefined &&
            textColumn(row, "node_versions_json") !==
              encodeJson(input.nodeVersions)) ||
          (input.documentVersions !== undefined &&
            textColumn(row, "document_versions_json") !==
              encodeJson(input.documentVersions)) ||
          (input.markdown !== undefined &&
            textColumn(row, "markdown") !==
              requireText(input.markdown, "markdown", 2_000_000))
        ) {
          throw new WorkflowStoreError(
            `Idempotency key ${idempotencyKey} was reused for another report version`,
            "conflict",
          );
        }
        return this.#mapReportVersion(row);
      }
      this.#assertWritableWorkflow(workflowId);
      const now = this.#now();
      this.#database
        .prepare(
          `INSERT INTO research_reports
             (report_id, workflow_id, report_type, title, current_version_no,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(report_id) DO NOTHING`,
        )
        .run(reportId, workflowId, reportType, title, now, now);
      const report = this.getReport(reportId);
      if (report.workflowId !== workflowId || report.reportType !== reportType) {
        throw new WorkflowStoreError(
          "Report identity collides with another workflow",
          "conflict",
        );
      }
      const nodeVersions =
        input.nodeVersions ?? this.#currentNodeVersions(workflowId);
      const documentVersions = input.documentVersions ?? [];
      const encodedNodeVersions = encodeJson(nodeVersions);
      const encodedDocumentVersions = encodeJson(documentVersions);
      const markdown =
        input.markdown === undefined
          ? this.#renderReportMarkdown(workflowId, title)
          : requireText(input.markdown, "markdown", 2_000_000);
      const versionNo = numberColumn(
        toRecord(
          this.#database
            .prepare(
              `SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no
               FROM research_report_versions WHERE report_id=?`,
            )
            .get(reportId),
        ),
        "version_no",
      );
      this.#database
        .prepare(
          `INSERT INTO research_report_versions
             (report_version_id, report_id, version_no, node_versions_json,
              document_versions_json, markdown, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          reportVersionId,
          reportId,
          versionNo,
          encodedNodeVersions,
          encodedDocumentVersions,
          markdown,
          stableId("idem_rv", reportId, idempotencyKey),
          now,
        );
      this.#database
        .prepare(
          `UPDATE research_reports
           SET title=?, current_version_no=?, updated_at=? WHERE report_id=?`,
        )
        .run(title, versionNo, now, reportId);
      return this.getReportVersion(reportVersionId);
    });
  }

  public getReport(reportId: string): ResearchReport {
    const id = requireText(reportId, "reportId", 240);
    const row = this.#database
      .prepare("SELECT * FROM research_reports WHERE report_id=?")
      .get(id);
    if (row === undefined) {
      throw new WorkflowStoreError(`Report ${id} was not found`, "not_found");
    }
    return mapReport(toRecord(row));
  }

  public listReports(
    workflowId: string,
    options: PageOptions & { readonly reportType?: string } = {},
  ): Page<ResearchReport> {
    const id = requireText(workflowId, "workflowId", 240);
    this.getWorkflow(id);
    const page = pageOptions(options);
    const parameters: (number | string)[] = [id];
    let filter = "";
    if (options.reportType !== undefined) {
      filter = " AND report_type=?";
      parameters.push(requireText(options.reportType, "reportType", 120));
    }
    const count = toRecord(
      this.#database
        .prepare(
          `SELECT COUNT(*) AS count FROM research_reports
           WHERE workflow_id=?${filter}`,
        )
        .get(...parameters),
    );
    const rows = this.#database
      .prepare(
        `SELECT * FROM research_reports WHERE workflow_id=?${filter}
         ORDER BY updated_at DESC, report_id LIMIT ? OFFSET ?`,
      )
      .all(...parameters, page.limit, page.offset);
    return pageResult(
      rows.map((row) => mapReport(toRecord(row))),
      numberColumn(count, "count"),
      page,
    );
  }

  public getReportVersion(reportVersionId: string): ReportVersion {
    const id = requireText(reportVersionId, "reportVersionId", 240);
    const row = this.#database
      .prepare(
        "SELECT * FROM research_report_versions WHERE report_version_id=?",
      )
      .get(id);
    if (row === undefined) {
      throw new WorkflowStoreError(
        `Report version ${id} was not found`,
        "not_found",
      );
    }
    return this.#mapReportVersion(toRecord(row));
  }

  public listReportVersions(
    reportId: string,
    options: PageOptions = {},
  ): Page<ReportVersion> {
    const id = requireText(reportId, "reportId", 240);
    this.getReport(id);
    const page = pageOptions(options);
    const count = toRecord(
      this.#database
        .prepare(
          "SELECT COUNT(*) AS count FROM research_report_versions WHERE report_id=?",
        )
        .get(id),
    );
    const rows = this.#database
      .prepare(
        `SELECT * FROM research_report_versions WHERE report_id=?
         ORDER BY version_no DESC LIMIT ? OFFSET ?`,
      )
      .all(id, page.limit, page.offset);
    return pageResult(
      rows.map((row) => this.#mapReportVersion(toRecord(row))),
      numberColumn(count, "count"),
      page,
    );
  }

  public getSnapshot(workflowId: string): WorkflowSnapshot {
    const workflow = this.getWorkflow(workflowId);
    return {
      workflow,
      nodes: this.listNodes(workflow.workflowId, { limit: 500 }).items,
      dependencies: this.listDependencies(workflow.workflowId, {
        limit: 500,
      }).items,
      context: this.getContext(workflow.workflowId),
    };
  }

  #now(): string {
    return nowIso(this.#clock());
  }

  #assertWritableWorkflow(workflowId: string): Workflow {
    const workflow = this.getWorkflow(workflowId);
    if (workflow.status === "archived") {
      throw new WorkflowStoreError(
        "Archived workflows are read-only",
        "invalid_state",
      );
    }
    return workflow;
  }

  #getNodeInWorkflow(workflowId: string, nodeId: string): WorkflowNode {
    const row = this.#database
      .prepare(
        "SELECT * FROM research_nodes WHERE workflow_id=? AND node_id=?",
      )
      .get(workflowId, nodeId);
    if (row === undefined) {
      throw new WorkflowStoreError(
        `Node ${nodeId} was not found in workflow ${workflowId}`,
        "not_found",
      );
    }
    return mapNode(toRecord(row));
  }

  #getNodeVersionRow(nodeVersionId: string): SqlRow {
    const row = this.#database
      .prepare(
        "SELECT * FROM research_node_versions WHERE node_version_id=?",
      )
      .get(nodeVersionId);
    if (row === undefined) {
      throw new WorkflowStoreError(
        `Node version ${nodeVersionId} was not found`,
        "not_found",
      );
    }
    return toRecord(row);
  }

  #mapNodeVersion(row: SqlRow): NodeVersion {
    const status = textColumn(row, "status");
    assertOneOf(status, NODE_VERSION_STATUSES, "stored node version status");
    const nodeVersionId = textColumn(row, "node_version_id");
    const structuredJson = optionalTextColumn(row, "structured_output_json");
    const evidenceRows = this.#database
      .prepare(
        `SELECT evidence_id FROM research_node_evidence
         WHERE node_version_id=? ORDER BY evidence_id`,
      )
      .all(nodeVersionId);
    return {
      nodeVersionId,
      workflowId: textColumn(row, "workflow_id"),
      nodeId: textColumn(row, "node_id"),
      versionNo: numberColumn(row, "version_no"),
      status,
      inputManifest: decodeJsonObject(textColumn(row, "input_manifest_json")),
      outputMarkdown: optionalTextColumn(row, "output_markdown"),
      structuredOutput:
        structuredJson === null ? null : decodeJsonObject(structuredJson),
      promptSnapshot: optionalTextColumn(row, "prompt_snapshot"),
      modelName: optionalTextColumn(row, "model_name"),
      sourceResponseId: optionalTextColumn(row, "source_response_id"),
      idempotencyKey: optionalTextColumn(row, "idempotency_key"),
      evidenceIds: evidenceRows.map((evidenceRow) =>
        textColumn(toRecord(evidenceRow), "evidence_id"),
      ),
      createdAt: textColumn(row, "created_at"),
      completedAt: optionalTextColumn(row, "completed_at"),
    };
  }

  #mapAssumption(row: SqlRow): Assumption {
    const status = textColumn(row, "status");
    assertOneOf(status, ASSUMPTION_STATUSES, "stored assumption status");
    const assumptionId = textColumn(row, "assumption_id");
    const evidenceRows = this.#database
      .prepare(
        `SELECT evidence_id FROM workflow_store_evidence_references
         WHERE owner_type='workflow-assumption' AND owner_id=?
         ORDER BY evidence_id`,
      )
      .all(assumptionId);
    return {
      assumptionId,
      workflowId: textColumn(row, "workflow_id"),
      nodeId: textColumn(row, "node_id"),
      content: textColumn(row, "content"),
      sourceResponseId: optionalTextColumn(row, "source_response_id"),
      status,
      evidenceIds: evidenceRows.map((evidenceRow) =>
        textColumn(toRecord(evidenceRow), "evidence_id"),
      ),
      createdAt: textColumn(row, "created_at"),
      updatedAt: textColumn(row, "updated_at"),
    };
  }

  #mapReportVersion(row: SqlRow): ReportVersion {
    return {
      reportVersionId: textColumn(row, "report_version_id"),
      reportId: textColumn(row, "report_id"),
      versionNo: numberColumn(row, "version_no"),
      nodeVersions: decodeJsonObject(textColumn(row, "node_versions_json")),
      documentVersions: decodeJsonArray(
        textColumn(row, "document_versions_json"),
      ),
      markdown: textColumn(row, "markdown"),
      createdAt: textColumn(row, "created_at"),
    };
  }

  #dependencyEntries(
    workflowId: string,
    nodeId: string,
  ): [string, DependencyType][] {
    return this.#database
      .prepare(
        `SELECT depends_on_node_id, dependency_type
         FROM research_node_dependencies WHERE workflow_id=? AND node_id=?`,
      )
      .all(workflowId, nodeId)
      .map((row) => {
        const record = toRecord(row);
        const dependencyType = textColumn(record, "dependency_type");
        assertOneOf(
          dependencyType,
          DEPENDENCY_TYPES,
          "stored dependency type",
        );
        return [
          textColumn(record, "depends_on_node_id"),
          dependencyType,
        ];
      });
  }

  #allCompletionDependenciesCompleted(
    workflowId: string,
    dependencies: readonly (readonly [string, DependencyType])[],
  ): boolean {
    for (const [nodeId, dependencyType] of dependencies) {
      if (
        dependencyType === "completion" &&
        this.#getNodeInWorkflow(workflowId, nodeId).status !== "completed"
      ) {
        return false;
      }
    }
    return true;
  }

  #refreshNodeReadiness(workflowId: string, nodeId: string): void {
    const node = this.#getNodeInWorkflow(workflowId, nodeId);
    if (!["pending", "ready"].includes(node.status)) {
      return;
    }
    const nextStatus: NodeStatus = this.#allCompletionDependenciesCompleted(
      workflowId,
      this.#dependencyEntries(workflowId, nodeId),
    )
      ? "ready"
      : "pending";
    this.#database
      .prepare(
        "UPDATE research_nodes SET status=?, updated_at=? WHERE workflow_id=? AND node_id=?",
      )
      .run(nextStatus, this.#now(), workflowId, nodeId);
  }

  #invalidateAfterDependencyChange(
    workflowId: string,
    nodeId: string,
  ): void {
    const node = this.#getNodeInWorkflow(workflowId, nodeId);
    if (node.currentVersionNo === 0) {
      this.#refreshNodeReadiness(workflowId, nodeId);
      return;
    }
    const now = this.#now();
    this.#database
      .prepare(
        `UPDATE research_nodes SET status='stale', updated_at=?
         WHERE workflow_id=? AND node_id=?`,
      )
      .run(now, workflowId, nodeId);
    this.#markDescendantsStale(workflowId, nodeId, now);
  }

  #refreshPendingNodes(workflowId: string, timestamp: string): void {
    const rows = this.#database
      .prepare(
        `SELECT node_id FROM research_nodes
         WHERE workflow_id=? AND status IN ('pending', 'ready')`,
      )
      .all(workflowId);
    const update = this.#database.prepare(
      "UPDATE research_nodes SET status=?, updated_at=? WHERE workflow_id=? AND node_id=?",
    );
    for (const row of rows) {
      const nodeId = textColumn(toRecord(row), "node_id");
      const ready = this.#allCompletionDependenciesCompleted(
        workflowId,
        this.#dependencyEntries(workflowId, nodeId),
      );
      update.run(ready ? "ready" : "pending", timestamp, workflowId, nodeId);
    }
  }

  #wouldCreateCycle(
    workflowId: string,
    nodeId: string,
    dependsOnNodeId: string,
  ): boolean {
    const row = this.#database
      .prepare(
        `WITH RECURSIVE ancestors(node_id) AS (
           SELECT ?
           UNION
           SELECT d.depends_on_node_id
           FROM research_node_dependencies d
           JOIN ancestors a ON a.node_id=d.node_id
           WHERE d.workflow_id=?
         )
         SELECT 1 AS found FROM ancestors WHERE node_id=? LIMIT 1`,
      )
      .get(dependsOnNodeId, workflowId, nodeId);
    return row !== undefined;
  }

  #markDescendantsStale(
    workflowId: string,
    sourceNodeId: string,
    timestamp: string,
  ): void {
    const rows = this.#database
      .prepare(
        `WITH RECURSIVE descendants(node_id) AS (
           SELECT node_id FROM research_node_dependencies
           WHERE workflow_id=? AND depends_on_node_id=?
           UNION
           SELECT d.node_id
           FROM research_node_dependencies d
           JOIN descendants x ON x.node_id=d.depends_on_node_id
           WHERE d.workflow_id=?
         )
         SELECT node_id FROM descendants`,
      )
      .all(workflowId, sourceNodeId, workflowId);
    const update = this.#database.prepare(
      `UPDATE research_nodes
       SET status=CASE WHEN current_version_no > 0 THEN 'stale' ELSE 'pending' END,
           updated_at=?
       WHERE workflow_id=? AND node_id=? AND status<>'running'`,
    );
    for (const row of rows) {
      update.run(
        timestamp,
        workflowId,
        textColumn(toRecord(row), "node_id"),
      );
    }
  }

  #currentNodeVersions(workflowId: string): Record<string, string> {
    const rows = this.#database
      .prepare(
        `SELECT n.node_id, v.node_version_id
         FROM research_nodes n
         JOIN research_node_versions v
           ON v.workflow_id=n.workflow_id
          AND v.node_id=n.node_id
          AND v.version_no=n.current_version_no
         WHERE n.workflow_id=? AND n.current_version_no>0
         ORDER BY n.position_no, n.node_id`,
      )
      .all(workflowId);
    return Object.fromEntries(
      rows.map((row) => {
        const record = toRecord(row);
        return [
          textColumn(record, "node_id"),
          textColumn(record, "node_version_id"),
        ];
      }),
    );
  }

  #renderReportMarkdown(workflowId: string, title: string): string {
    const rows = this.#database
      .prepare(
        `SELECT n.title, v.output_markdown
         FROM research_nodes n
         JOIN research_node_versions v
           ON v.workflow_id=n.workflow_id
          AND v.node_id=n.node_id
          AND v.version_no=n.current_version_no
         WHERE n.workflow_id=? AND n.status IN ('completed', 'stale')
         ORDER BY n.position_no, n.node_id`,
      )
      .all(workflowId);
    const sections = [`# ${title}`];
    for (const row of rows) {
      const record = toRecord(row);
      sections.push(
        "",
        `## ${textColumn(record, "title")}`,
        "",
        optionalTextColumn(record, "output_markdown") ?? "",
      );
    }
    return `${sections.join("\n").trim()}\n`;
  }

  #assertFiniteNumber(value: number, field: string): void {
    if (!Number.isFinite(value)) {
      throw new WorkflowStoreError(
        `${field} must be finite`,
        "invalid_argument",
      );
    }
  }
}
