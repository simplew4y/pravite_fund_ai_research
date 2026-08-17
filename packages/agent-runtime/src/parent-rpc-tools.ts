import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

import type { ParentToolRpcClient } from "./parent-tool-rpc.js";
import { WhitelistedToolRegistry } from "./tool-registry.js";
import type { HarnessStartInput } from "./types.js";

export const PARENT_RPC_TOOL_NAMES = [
  "workspace.list",
  "workspace.read",
  "workspace.search",
  "workspace.write",
  "evidence.search",
  "evidence.get",
  "job.enqueue",
  "job.get",
] as const;

const Identifier = Type.String({
  minLength: 1,
  maxLength: 160,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});

const WorkspaceCollection = Type.Union([
  Type.Literal("sources"),
  Type.Literal("research"),
  Type.Literal("reports"),
  Type.Literal("models"),
]);

const WorkspaceWritableCollection = Type.Union([
  Type.Literal("research"),
  Type.Literal("notes"),
]);

const AgentCursor = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: "^[A-Za-z0-9._:=-]+$",
});

const EvidenceType = Type.Union([
  Type.Literal("chunk"),
  Type.Literal("fact"),
  Type.Literal("cell"),
]);

const EvidenceId = Type.String({
  minLength: 1,
  maxLength: 500,
  pattern: "^[^\\u0000-\\u001F\\u007F/\\\\]+$",
});

const JobType = Type.Union([
  Type.Literal("document.ingest"),
  Type.Literal("memo.generate"),
  Type.Literal("report.generate"),
  Type.Literal("tracking.scan"),
  Type.Literal("valuation.extract"),
  Type.Literal("valuation.compare"),
  Type.Literal("valuation.derive"),
  Type.Literal("market.refresh"),
  Type.Literal("obsidian.project"),
]);

const AgentJobFormat = Type.Union([
  Type.Literal("markdown"),
  Type.Literal("pdf"),
  Type.Literal("xlsx"),
  Type.Literal("json"),
]);

export const parentRpcToolParameterSchemas = {
  "workspace.list": Type.Object(
    {
      collection: WorkspaceCollection,
      parentId: Type.Optional(Identifier),
      cursor: Type.Optional(AgentCursor),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    { additionalProperties: false },
  ),
  "workspace.read": Type.Object(
    {
      resourceId: Identifier,
      offset: Type.Optional(
        Type.Integer({ minimum: 0, maximum: 10_000_000 }),
      ),
      maxCharacters: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 50_000 }),
      ),
    },
    { additionalProperties: false },
  ),
  "workspace.search": Type.Object(
    {
      query: Type.String({ minLength: 1, maxLength: 4_000 }),
      collections: Type.Optional(
        Type.Array(WorkspaceCollection, { minItems: 1, maxItems: 4 }),
      ),
      cursor: Type.Optional(AgentCursor),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    { additionalProperties: false },
  ),
  "workspace.write": Type.Object(
    {
      collection: WorkspaceWritableCollection,
      resourceId: Type.Optional(Identifier),
      title: Type.String({ minLength: 1, maxLength: 300 }),
      content: Type.String({ maxLength: 200_000 }),
      expectedVersion: Type.Optional(Identifier),
      idempotencyKey: Identifier,
    },
    { additionalProperties: false },
  ),
  "evidence.search": Type.Object(
    {
      query: Type.String({ minLength: 1, maxLength: 4_000 }),
      documentIds: Type.Optional(
        Type.Array(Identifier, { maxItems: 100 }),
      ),
      evidenceTypes: Type.Optional(
        Type.Array(EvidenceType, { minItems: 1, maxItems: 3 }),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    },
    { additionalProperties: false },
  ),
  "evidence.get": Type.Object(
    {
      evidenceIds: Type.Array(EvidenceId, {
        minItems: 1,
        maxItems: 100,
      }),
    },
    { additionalProperties: false },
  ),
  "job.enqueue": Type.Object(
    {
      type: JobType,
      sourceIds: Type.Optional(
        Type.Array(Identifier, { maxItems: 100 }),
      ),
      instruction: Type.Optional(
        Type.String({ minLength: 1, maxLength: 20_000 }),
      ),
      outputFormat: Type.Optional(AgentJobFormat),
      idempotencyKey: Identifier,
    },
    { additionalProperties: false },
  ),
  "job.get": Type.Object(
    {
      jobId: Identifier,
    },
    { additionalProperties: false },
  ),
} as const;

interface RpcToolSpec<TParameters extends TSchema> {
  name: (typeof PARENT_RPC_TOOL_NAMES)[number];
  label: string;
  description: string;
  parameters: TParameters;
  executionMode: "parallel" | "sequential";
}

function createRpcTool<TParameters extends TSchema>(
  client: ParentToolRpcClient,
  context: Readonly<HarnessStartInput>,
  spec: RpcToolSpec<TParameters>,
): ToolDefinition {
  return defineTool({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    executionMode: spec.executionMode,
    execute: async (toolCallId, parameters, signal) => {
      const response = await client.request({
        sessionId: context.sessionId,
        toolCallId,
        tool: spec.name,
        arguments: parameters as Record<string, unknown>,
        ...(signal === undefined ? {} : { signal }),
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.result),
          },
        ],
        details: {
          requestId: response.requestId,
          tool: spec.name,
        },
      };
    },
  });
}

function registerRpcTool<TParameters extends TSchema>(
  registry: WhitelistedToolRegistry,
  client: ParentToolRpcClient,
  spec: RpcToolSpec<TParameters>,
): void {
  registry.register({
    name: spec.name,
    create: (context) => createRpcTool(client, context, spec),
  });
}

export function createParentRpcToolRegistry(
  client: ParentToolRpcClient,
): WhitelistedToolRegistry {
  const registry = new WhitelistedToolRegistry(PARENT_RPC_TOOL_NAMES);

  registerRpcTool(registry, client, {
    name: "workspace.list",
    label: "List workspace resources",
    description:
      "List authorized project resources by logical collection and opaque resource ID.",
    parameters: parentRpcToolParameterSchemas["workspace.list"],
    executionMode: "parallel",
  });
  registerRpcTool(registry, client, {
    name: "workspace.read",
    label: "Read workspace resource",
    description:
      "Read a bounded segment of an authorized resource using its opaque resource ID.",
    parameters: parentRpcToolParameterSchemas["workspace.read"],
    executionMode: "parallel",
  });
  registerRpcTool(registry, client, {
    name: "workspace.search",
    label: "Search workspace",
    description:
      "Search authorized project resources without filesystem or network access.",
    parameters: parentRpcToolParameterSchemas["workspace.search"],
    executionMode: "parallel",
  });
  registerRpcTool(registry, client, {
    name: "workspace.write",
    label: "Write workspace resource",
    description:
      "Create or update an authorized research or note resource using an idempotency key.",
    parameters: parentRpcToolParameterSchemas["workspace.write"],
    executionMode: "sequential",
  });
  registerRpcTool(registry, client, {
    name: "evidence.search",
    label: "Search evidence",
    description:
      "Search project evidence candidates; the parent enforces project ownership.",
    parameters: parentRpcToolParameterSchemas["evidence.search"],
    executionMode: "parallel",
  });
  registerRpcTool(registry, client, {
    name: "evidence.get",
    label: "Get evidence",
    description:
      "Read bounded evidence details by opaque evidence IDs for source verification.",
    parameters: parentRpcToolParameterSchemas["evidence.get"],
    executionMode: "parallel",
  });
  registerRpcTool(registry, client, {
    name: "job.enqueue",
    label: "Enqueue project job",
    description:
      "Enqueue an authorized durable project job with bounded logical inputs.",
    parameters: parentRpcToolParameterSchemas["job.enqueue"],
    executionMode: "sequential",
  });
  registerRpcTool(registry, client, {
    name: "job.get",
    label: "Get project job",
    description:
      "Read the status of an authorized durable project job by opaque job ID.",
    parameters: parentRpcToolParameterSchemas["job.get"],
    executionMode: "parallel",
  });

  return registry;
}
