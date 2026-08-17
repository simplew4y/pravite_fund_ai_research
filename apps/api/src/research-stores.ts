import path from "node:path";

import type {
  EvidenceGetArguments,
  EvidenceSearchArguments,
} from "@private-fund/contracts";
import { NotFoundError } from "@private-fund/core";
import {
  createResearchStore,
  openProjectDatabase,
  type ProjectDatabase,
  type ResearchStore,
} from "@private-fund/research-store";
import {
  createWorkflowStore,
  type WorkflowStore,
} from "@private-fund/workflow-store";

import type { AgentEvidenceToolPort } from "./agent-tools.js";
import type { AgentToolSessionContext } from "./repository-services.js";

interface OpenStore {
  readonly database: ProjectDatabase;
  readonly store: ResearchStore;
  readonly workflow: WorkflowStore;
}

export class ProjectResearchStoreManager {
  readonly #open = new Map<string, OpenStore>();

  public get(projectRoot: string): ResearchStore {
    return this.open(projectRoot).store;
  }

  public getWorkflow(projectRoot: string): WorkflowStore {
    return this.open(projectRoot).workflow;
  }

  private open(projectRoot: string): OpenStore {
    const existing = this.#open.get(projectRoot);
    if (existing !== undefined) {
      return existing;
    }
    const database = openProjectDatabase({
      projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
    });
    const store = createResearchStore(database);
    const workflow = createWorkflowStore(database.connection);
    const opened = { database, store, workflow };
    this.#open.set(projectRoot, opened);
    return opened;
  }

  public close(): void {
    for (const open of this.#open.values()) {
      open.database.close();
    }
    this.#open.clear();
  }
}

function normalizedScore(score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  return Math.min(1, score / (score + 1));
}

function locator(trace: ReturnType<ResearchStore["evidence"]["trace"]>) {
  return {
    page: trace.pageStart,
    sheet: trace.sheetName,
    cellRange: trace.cellRange ?? trace.cellRef,
    section: trace.locator.headingPath ?? null,
  };
}

export class ResearchStoreEvidenceTools implements AgentEvidenceToolPort {
  public constructor(
    private readonly stores: ProjectResearchStoreManager,
  ) {}

  public async search(
    context: AgentToolSessionContext,
    input: EvidenceSearchArguments,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const store = this.stores.get(context.projectRoot);
    const kinds = input.evidenceTypes ?? ["chunk", "fact", "cell"];
    const requestedDocuments = new Set(input.documentIds ?? []);
    const requestedLimit = input.limit ?? 20;
    const page = store.evidence.search({
      query: input.query,
      kinds,
      limit: Math.min(200, Math.max(requestedLimit, requestedLimit * 4)),
      offset: 0,
    });
    const hits = [];
    for (const hit of page.items) {
      signal.throwIfAborted();
      const trace = hit.evidence;
      if (
        requestedDocuments.size > 0 &&
        !requestedDocuments.has(trace.document.id)
      ) {
        continue;
      }
      hits.push({
        evidenceId: trace.evidenceId,
        documentId: trace.document.id,
        type: trace.kind,
        excerpt: (
          trace.summary ??
          trace.originalText
        ).slice(0, 8_000),
        score: normalizedScore(hit.score),
        locator: locator(trace),
      });
      if (hits.length >= requestedLimit) break;
    }
    return { hits };
  }

  public async get(
    context: AgentToolSessionContext,
    input: EvidenceGetArguments,
    signal: AbortSignal,
  ): Promise<unknown> {
    const store = this.stores.get(context.projectRoot);
    const items = input.evidenceIds.map((evidenceId) => {
      signal.throwIfAborted();
      const trace = store.evidence.trace(evidenceId);
      if (
        trace.kind !== "chunk" &&
        trace.kind !== "fact" &&
        trace.kind !== "cell"
      ) {
        throw new NotFoundError("Evidence");
      }
      return {
        evidenceId: trace.evidenceId,
        documentId: trace.document.id,
        type: trace.kind,
        content: trace.originalText.slice(0, 50_000),
        locator: locator(trace),
        version: trace.documentVersion.id,
      };
    });
    return { items };
  }
}
