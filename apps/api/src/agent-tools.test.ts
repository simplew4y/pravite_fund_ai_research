import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  agentToolResultSchemas,
  type AgentToolRequestMessage,
} from "@private-fund/contracts";
import { buildTenantContext } from "@private-fund/core";
import {
  createControlRepositories,
  openControlDatabase,
} from "@private-fund/db";
import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentEvent,
  AgentWorkerPort,
  StartAgentSessionInput,
} from "./agent-supervisor.js";
import { RepositoryAgentToolHandler } from "./agent-tools.js";
import {
  RepositoryJobService,
  RepositoryProjectService,
  RepositorySessionService,
} from "./repository-services.js";
import {
  ProjectResearchStoreManager,
  ResearchStoreEvidenceTools,
} from "./research-stores.js";

class ToolTestWorker implements AgentWorkerPort {
  readonly #listeners = new Set<(event: AgentEvent) => void>();

  public async start(_input: StartAgentSessionInput): Promise<void> {}
  public async prompt(): Promise<void> {}
  public async steer(): Promise<void> {}
  public async compact(): Promise<void> {}
  public async interrupt(): Promise<void> {}
  public async dispose(): Promise<void> {}
  public async stop(): Promise<void> {}

  public subscribe(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

function toolRequest(
  input: Pick<
    AgentToolRequestMessage,
    "sessionId" | "tool" | "arguments"
  >,
): AgentToolRequestMessage {
  return {
    type: "tool.request",
    protocolVersion: 1,
    requestId: `request-${input.tool.replaceAll(".", "-")}`,
    sessionId: input.sessionId,
    toolCallId: `call-${input.tool.replaceAll(".", "-")}`,
    tool: input.tool,
    arguments: input.arguments,
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
  };
}

describe("parent-side agent tools", () => {
  let temporaryRoot: string | undefined;
  let stores: ProjectResearchStoreManager | undefined;

  afterEach(async () => {
    stores?.close();
    if (temporaryRoot !== undefined) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("binds workspace, evidence and jobs to the authenticated session project", async () => {
    temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "pf-agent-tools-"),
    );
    const identity = {
      userId: "tool-user",
      dataNamespace: "00000000-0000-4000-8000-000000000077",
    };
    const tenant = buildTenantContext(temporaryRoot, identity);
    const database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(database);
    repositories.users.upsertCloudShadow(identity);
    const worker = new ToolTestWorker();
    const projects = new RepositoryProjectService(repositories);
    const jobs = new RepositoryJobService(database);
    const sessions = new RepositorySessionService({
      repositories,
      worker,
    });
    const project = await projects.create(tenant, { name: "Tool project" });
    const session = await sessions.create(tenant, {
      projectId: project.id,
    });
    await sessions.sendMessage(tenant, session.id, {
      content: "Initialize authenticated tool context",
      clientMessageId: "tool-context-message",
    });
    const context = sessions.agentToolContext(session.id);
    expect(context).not.toBeNull();
    if (context === null) throw new Error("tool context missing");

    const sourceDirectory = path.join(context.projectRoot, "sources");
    await mkdir(sourceDirectory, { recursive: true });
    const sourcePath = path.join(sourceDirectory, "source.txt");
    const sourceContent = "Revenue increased by 42 percent.";
    await writeFile(sourcePath, sourceContent, "utf8");

    stores = new ProjectResearchStoreManager();
    const research = stores.get(context.projectRoot);
    const document = research.documents.registerVersion({
      sourceRelpath: "sources/source.txt",
      title: "Source document",
      originalFilename: "source.txt",
      storedPath: "sources/source.txt",
      fileType: "txt",
      mimeType: "text/plain",
      sha256: createHash("sha256").update(sourceContent).digest("hex"),
      fileSize: Buffer.byteLength(sourceContent),
      status: "indexed",
    });
    research.evidence.put({
      evidenceId: "chunk:revenue-42",
      kind: "chunk",
      documentVersionId: document.version.id,
      originalText: sourceContent,
      locator: {
        pageStart: 1,
        headingPath: "Financial highlights",
      },
    });

    const handler = new RepositoryAgentToolHandler({
      sessions,
      jobs,
      evidence: new ResearchStoreEvidenceTools(stores),
    });
    const signal = new AbortController().signal;
    const listed = agentToolResultSchemas["workspace.list"].parse(
      await handler.execute(
        toolRequest({
          sessionId: session.id,
          tool: "workspace.list",
          arguments: { collection: "sources" },
        }),
        signal,
      ),
    );
    expect(listed.items).toHaveLength(1);

    const read = agentToolResultSchemas["workspace.read"].parse(
      await handler.execute(
        toolRequest({
          sessionId: session.id,
          tool: "workspace.read",
          arguments: {
            resourceId: listed.items[0]?.resourceId,
          },
        }),
        signal,
      ),
    );
    expect(read.content).toContain("42 percent");

    const evidence = agentToolResultSchemas["evidence.search"].parse(
      await handler.execute(
        toolRequest({
          sessionId: session.id,
          tool: "evidence.search",
          arguments: { query: "Revenue", limit: 10 },
        }),
        signal,
      ),
    );
    expect(evidence.hits[0]).toMatchObject({
      evidenceId: "chunk:revenue-42",
      documentId: document.document.id,
    });

    const enqueued = agentToolResultSchemas["job.enqueue"].parse(
      await handler.execute(
        toolRequest({
          sessionId: session.id,
          tool: "job.enqueue",
          arguments: {
            type: "memo.generate",
            sourceIds: [document.document.id],
            instruction: "Draft an evidence-backed memo",
            outputFormat: "markdown",
            idempotencyKey: "memo-from-tool-1",
          },
        }),
        signal,
      ),
    );
    const job = agentToolResultSchemas["job.get"].parse(
      await handler.execute(
        toolRequest({
          sessionId: session.id,
          tool: "job.get",
          arguments: { jobId: enqueued.jobId },
        }),
        signal,
      ),
    );
    expect(job).toMatchObject({
      jobId: enqueued.jobId,
      type: "memo.generate",
      status: "queued",
    });

    sessions.dispose();
    database.close();
  });
});
