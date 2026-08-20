import { z } from "zod";

import { query, requestJson } from "./http";

/**
 * Research workflow (agentic_research_graph_v2): a fixed 9-node graph
 * (source review → analysis → assumptions → 3 scenarios → valuation →
 * conclusion). Response records come from the workflow store and are not in
 * @private-fund/contracts, so we validate the fields we render, loosely.
 * All endpoints 503 (workflow_store_disabled) when the store is off.
 */
const workflowNodeSchema = z
  .object({
    nodeId: z.string(),
    nodeType: z.string().default(""),
    title: z.string(),
    objective: z.string().default(""),
    summary: z.string().default(""),
    status: z.string(),
    currentVersionNo: z.number().default(0),
    positionNo: z.number().default(0),
    x: z.number().default(0),
    y: z.number().default(0),
    tone: z.string().default(""),
    kind: z.string().default(""),
  })
  .loose();

export type WorkflowNode = z.infer<typeof workflowNodeSchema>;

const workflowSnapshotSchema = z
  .object({
    workflow: z
      .object({
        workflowId: z.string(),
        status: z.string(),
        currentNodeId: z.string().nullable(),
      })
      .loose(),
    nodes: z.array(workflowNodeSchema),
    dependencies: z
      .array(
        z.object({ nodeId: z.string(), dependsOnNodeId: z.string() }).loose(),
      )
      .default([]),
    context: z.object({ nodeIds: z.array(z.string()).default([]) }).loose(),
  })
  .loose();

export type WorkflowSnapshot = z.infer<typeof workflowSnapshotSchema>;

/** GET is initialize-on-read: the default graph is created on first call. */
export function fetchWorkflow(projectId: string): Promise<WorkflowSnapshot> {
  return requestJson(`/v1/projects/${projectId}/workflow`, workflowSnapshotSchema);
}

export function setCurrentNode(
  projectId: string,
  nodeId: string | null,
): Promise<WorkflowSnapshot> {
  return requestJson(
    `/v1/projects/${projectId}/workflow/current-node`,
    workflowSnapshotSchema,
    { method: "POST", body: { nodeId } },
  );
}

export function setWorkflowContext(
  projectId: string,
  nodeIds: string[],
): Promise<WorkflowSnapshot> {
  return requestJson(
    `/v1/projects/${projectId}/workflow/context`,
    workflowSnapshotSchema,
    { method: "POST", body: { nodeIds } },
  );
}

const nodeActionResponseSchema = z
  .object({ workflow: workflowSnapshotSchema })
  .loose();

export function startNode(
  projectId: string,
  nodeId: string,
): Promise<WorkflowSnapshot> {
  return requestJson(
    `/v1/projects/${projectId}/workflow/nodes/${nodeId}/start`,
    nodeActionResponseSchema,
    { method: "POST", body: {} },
  ).then((result) => result.workflow);
}

export function completeNode(
  projectId: string,
  nodeId: string,
  outputMarkdown: string,
): Promise<WorkflowSnapshot> {
  return requestJson(
    `/v1/projects/${projectId}/workflow/nodes/${nodeId}/complete`,
    nodeActionResponseSchema,
    { method: "POST", body: { outputMarkdown } },
  ).then((result) => result.workflow);
}

const looseRecord = z.record(z.string(), z.unknown());

function page() {
  return z.object({ items: z.array(looseRecord).default([]) }).loose();
}

export function listAssumptions(
  projectId: string,
  nodeId: string,
): Promise<Record<string, unknown>[]> {
  return requestJson(
    `/v1/projects/${projectId}/workflow/nodes/${nodeId}/assumptions${query({ limit: 100 })}`,
    page(),
  ).then((result) => result.items);
}

export function addAssumption(
  projectId: string,
  nodeId: string,
  content: string,
): Promise<unknown> {
  return requestJson(
    `/v1/projects/${projectId}/workflow/nodes/${nodeId}/assumptions`,
    z.unknown(),
    {
      method: "POST",
      body: { idempotencyKey: `assumption-${crypto.randomUUID()}`, content },
    },
  );
}

export function listNodeVersions(
  projectId: string,
  nodeId: string,
): Promise<Record<string, unknown>[]> {
  return requestJson(
    `/v1/projects/${projectId}/workflow/nodes/${nodeId}/versions${query({ limit: 20 })}`,
    page(),
  ).then((result) => result.items);
}

export function listReports(projectId: string): Promise<Record<string, unknown>[]> {
  return requestJson(
    `/v1/projects/${projectId}/workflow/reports${query({ limit: 20 })}`,
    page(),
  ).then((result) => result.items);
}

export function createReport(
  projectId: string,
  title: string,
  markdown: string,
): Promise<unknown> {
  return requestJson(`/v1/projects/${projectId}/workflow/reports`, z.unknown(), {
    method: "POST",
    body: {
      idempotencyKey: `report-${crypto.randomUUID()}`,
      title,
      markdown,
    },
  });
}
