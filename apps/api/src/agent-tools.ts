import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  agentToolArgumentsSchemas,
  type AgentToolRequestMessage,
  type EvidenceGetArguments,
  type EvidenceSearchArguments,
  type WorkspaceResourceKind,
} from "@private-fund/contracts";
import {
  ConflictError,
  DomainError,
  NotFoundError,
  assertPathWithin,
  ensureDirectoryWithin,
} from "@private-fund/core";

import type { AgentToolRequestHandler } from "./agent-supervisor.js";
import type {
  JobService,
} from "./dependencies.js";
import type {
  AgentToolSessionContext,
  RepositorySessionService,
} from "./repository-services.js";

type WorkspaceCollection =
  | "sources"
  | "research"
  | "reports"
  | "models"
  | "notes";

interface ResourceEntry {
  readonly resourceId: string;
  readonly collection: WorkspaceCollection;
  readonly absolutePath: string;
  readonly name: string;
  readonly kind: WorkspaceResourceKind;
}

export interface AgentEvidenceToolPort {
  search(
    context: AgentToolSessionContext,
    input: EvidenceSearchArguments,
    signal: AbortSignal,
  ): Promise<unknown>;
  get(
    context: AgentToolSessionContext,
    input: EvidenceGetArguments,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface RepositoryAgentToolHandlerOptions {
  readonly sessions: RepositorySessionService;
  readonly jobs: JobService;
  readonly evidence?: AgentEvidenceToolPort;
}

const TEXT_EXTENSIONS = new Set([
  ".csv",
  ".html",
  ".json",
  ".md",
  ".ndjson",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const MAX_READABLE_FILE_BYTES = 20 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILES = 2_000;
const MAX_SEARCH_TOTAL_BYTES = 20 * 1024 * 1024;

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function resourceId(
  collection: WorkspaceCollection,
  relativePath: string,
): string {
  return `resource:${hash(`${collection}\0${relativePath}`).slice(0, 40)}`;
}

function versionId(contents: string | Buffer): string {
  return `version:${hash(contents)}`;
}

function mediaType(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case ".md":
      return "text/markdown";
    case ".html":
      return "text/html";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".xml":
      return "application/xml";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    default:
      return "text/plain";
  }
}

function resourceKind(
  collection: WorkspaceCollection,
  isDirectory: boolean,
): WorkspaceResourceKind {
  if (isDirectory) return "folder";
  switch (collection) {
    case "sources":
      return "document";
    case "reports":
      return "report";
    case "models":
      return "model";
    case "notes":
      return "note";
    case "research":
      return "research_asset";
  }
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^offset:(\d+)$/.exec(cursor);
  const offset = match?.[1] === undefined ? NaN : Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new DomainError(
      "Invalid workspace cursor",
      "invalid_request",
      400,
    );
  }
  return offset;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DomainError("Tool request was cancelled", "cancelled", 499);
  }
}

export class RepositoryAgentToolHandler
  implements AgentToolRequestHandler
{
  readonly #sessions: RepositorySessionService;
  readonly #jobs: JobService;
  readonly #evidence: AgentEvidenceToolPort | undefined;
  readonly #resources = new Map<string, Map<string, ResourceEntry>>();

  public constructor(options: RepositoryAgentToolHandlerOptions) {
    this.#sessions = options.sessions;
    this.#jobs = options.jobs;
    this.#evidence = options.evidence;
  }

  public async execute(
    request: AgentToolRequestMessage,
    signal: AbortSignal,
  ): Promise<unknown> {
    throwIfAborted(signal);
    const context = this.#sessions.agentToolContext(request.sessionId);
    if (context === null) {
      throw new DomainError(
        "Agent session has no authenticated tool context",
        "forbidden",
        403,
      );
    }
    switch (request.tool) {
      case "workspace.list":
        return this.#list(
          context,
          agentToolArgumentsSchemas["workspace.list"].parse(
            request.arguments,
          ),
          signal,
        );
      case "workspace.read":
        return this.#read(
          context,
          agentToolArgumentsSchemas["workspace.read"].parse(
            request.arguments,
          ),
          signal,
        );
      case "workspace.search":
        return this.#search(
          context,
          agentToolArgumentsSchemas["workspace.search"].parse(
            request.arguments,
          ),
          signal,
        );
      case "workspace.write":
        return this.#write(
          context,
          agentToolArgumentsSchemas["workspace.write"].parse(
            request.arguments,
          ),
          signal,
        );
      case "evidence.search":
        return this.#searchEvidence(
          context,
          agentToolArgumentsSchemas["evidence.search"].parse(
            request.arguments,
          ),
          signal,
        );
      case "evidence.get":
        return this.#getEvidence(
          context,
          agentToolArgumentsSchemas["evidence.get"].parse(
            request.arguments,
          ),
          signal,
        );
      case "job.enqueue":
        return this.#enqueueJob(
          context,
          agentToolArgumentsSchemas["job.enqueue"].parse(
            request.arguments,
          ),
        );
      case "job.get":
        return this.#getJob(
          context,
          agentToolArgumentsSchemas["job.get"].parse(
            request.arguments,
          ).jobId,
        );
    }
  }

  async #list(
    context: AgentToolSessionContext,
    input: ReturnType<
      typeof agentToolArgumentsSchemas["workspace.list"]["parse"]
    >,
    signal: AbortSignal,
  ): Promise<unknown> {
    const collection = input.collection;
    const collectionRoot = await this.#collectionRoot(
      context,
      collection,
    );
    let directory = collectionRoot;
    if (input.parentId !== undefined) {
      const parent = await this.#resolveResource(
        context,
        input.parentId,
        signal,
      );
      if (parent.kind !== "folder" || parent.collection !== collection) {
        throw new NotFoundError("Workspace folder");
      }
      directory = parent.absolutePath;
    }
    const entries = await this.#directoryEntries(
      context,
      collection,
      directory,
      signal,
    );
    const offset = parseCursor(input.cursor);
    const limit = input.limit ?? 50;
    const selected = entries.slice(offset, offset + limit);
    const items = await Promise.all(
      selected.map(async (entry) => {
        throwIfAborted(signal);
        const details = await stat(entry.absolutePath);
        const version =
          entry.kind === "folder"
            ? null
            : versionId(await readFile(entry.absolutePath));
        return {
          resourceId: entry.resourceId,
          name: entry.name,
          kind: entry.kind,
          version,
          size: entry.kind === "folder" ? null : details.size,
          updatedAt: details.mtime.toISOString(),
        };
      }),
    );
    const nextOffset = offset + selected.length;
    return {
      items,
      nextCursor:
        nextOffset < entries.length ? `offset:${String(nextOffset)}` : null,
    };
  }

  async #read(
    context: AgentToolSessionContext,
    input: ReturnType<
      typeof agentToolArgumentsSchemas["workspace.read"]["parse"]
    >,
    signal: AbortSignal,
  ): Promise<unknown> {
    const entry = await this.#resolveResource(
      context,
      input.resourceId,
      signal,
    );
    if (entry.kind === "folder") {
      throw new DomainError(
        "Folders cannot be read as text",
        "invalid_request",
        400,
      );
    }
    if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      throw new DomainError(
        "Resource is not a supported text format",
        "invalid_request",
        400,
      );
    }
    const safeFile = await this.#realFileWithin(
      entry.absolutePath,
      context.projectRoot,
    );
    const details = await stat(safeFile);
    if (details.size > MAX_READABLE_FILE_BYTES) {
      throw new DomainError(
        "Resource is too large for an agent read",
        "invalid_request",
        413,
      );
    }
    throwIfAborted(signal);
    const content = await readFile(safeFile, "utf8");
    const offset = input.offset ?? 0;
    const maxCharacters = input.maxCharacters ?? 20_000;
    const segment = content.slice(offset, offset + maxCharacters);
    const nextOffset =
      offset + segment.length < content.length
        ? offset + segment.length
        : null;
    return {
      resourceId: entry.resourceId,
      name: entry.name,
      content: segment,
      version: versionId(content),
      mediaType: mediaType(entry.name),
      truncated: nextOffset !== null,
      nextOffset,
    };
  }

  async #search(
    context: AgentToolSessionContext,
    input: ReturnType<
      typeof agentToolArgumentsSchemas["workspace.search"]["parse"]
    >,
    signal: AbortSignal,
  ): Promise<unknown> {
    const collections = input.collections ?? [
      "sources",
      "research",
      "reports",
      "models",
    ];
    const query = input.query.toLocaleLowerCase();
    const allFiles: ResourceEntry[] = [];
    for (const collection of collections) {
      const root = await this.#collectionRoot(context, collection);
      await this.#walkFiles(
        context,
        collection,
        root,
        allFiles,
        signal,
      );
      if (allFiles.length >= MAX_SEARCH_FILES) break;
    }

    let totalBytes = 0;
    const hits: Array<{
      resourceId: string;
      name: string;
      kind: WorkspaceResourceKind;
      snippet: string;
      score: number;
    }> = [];
    for (const entry of allFiles) {
      throwIfAborted(signal);
      if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      const details = await stat(entry.absolutePath);
      if (
        details.size > MAX_SEARCH_FILE_BYTES ||
        totalBytes + details.size > MAX_SEARCH_TOTAL_BYTES
      ) {
        continue;
      }
      totalBytes += details.size;
      const content = await readFile(entry.absolutePath, "utf8");
      const lower = content.toLocaleLowerCase();
      const index = lower.indexOf(query);
      const nameMatch = entry.name.toLocaleLowerCase().includes(query);
      if (index < 0 && !nameMatch) continue;
      const start = index < 0 ? 0 : Math.max(0, index - 240);
      const snippet = content.slice(start, start + 800);
      hits.push({
        resourceId: entry.resourceId,
        name: entry.name,
        kind: entry.kind,
        snippet,
        score: index === 0 || nameMatch ? 1 : 0.75,
      });
    }
    hits.sort(
      (left, right) =>
        right.score - left.score ||
        left.name.localeCompare(right.name),
    );
    const offset = parseCursor(input.cursor);
    const limit = input.limit ?? 25;
    const selected = hits.slice(offset, offset + limit);
    return {
      hits: selected,
      nextCursor:
        offset + selected.length < hits.length
          ? `offset:${String(offset + selected.length)}`
          : null,
    };
  }

  async #write(
    context: AgentToolSessionContext,
    input: ReturnType<
      typeof agentToolArgumentsSchemas["workspace.write"]["parse"]
    >,
    signal: AbortSignal,
  ): Promise<unknown> {
    const collection = input.collection;
    const root = await this.#collectionRoot(context, collection);
    let target: string;
    let existing: ResourceEntry | null = null;
    if (input.resourceId !== undefined) {
      existing = await this.#resolveResource(
        context,
        input.resourceId,
        signal,
      );
      if (
        existing.kind === "folder" ||
        existing.collection !== collection
      ) {
        throw new NotFoundError("Writable workspace resource");
      }
      target = existing.absolutePath;
    } else {
      const titleSlug = input.title
        .normalize("NFKC")
        .toLocaleLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
      const basename =
        `${titleSlug || "resource"}-` +
        `${hash(input.idempotencyKey).slice(0, 16)}.md`;
      target = assertPathWithin(path.join(root, basename), root);
    }

    let currentContent: string | null = null;
    try {
      const details = await lstat(target);
      if (details.isSymbolicLink() || !details.isFile()) {
        throw new DomainError(
          "Writable resource target is not a regular file",
          "forbidden",
          403,
        );
      }
      currentContent = await readFile(target, "utf8");
    } catch (error) {
      if (
        error instanceof DomainError ||
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        throw error;
      }
    }

    if (currentContent !== null) {
      const currentVersion = versionId(currentContent);
      if (
        input.expectedVersion !== undefined &&
        input.expectedVersion !== currentVersion
      ) {
        throw new ConflictError(
          "Workspace resource version changed",
          "resource_version_conflict",
        );
      }
      if (existing === null && currentContent !== input.content) {
        throw new ConflictError(
          "Idempotency key already created different content",
          "idempotency_conflict",
        );
      }
      if (currentContent === input.content) {
        const registered = this.#registerResource(
          context,
          collection,
          target,
          false,
        );
        return {
          resourceId: registered.resourceId,
          version: currentVersion,
          created: false,
          updatedAt: (await stat(target)).mtime.toISOString(),
        };
      }
    } else if (input.expectedVersion !== undefined) {
      throw new ConflictError(
        "Workspace resource no longer exists",
        "resource_version_conflict",
      );
    }

    throwIfAborted(signal);
    const temporary = assertPathWithin(
      `${target}.tmp-${randomUUID()}`,
      root,
    );
    try {
      await writeFile(temporary, input.content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      throwIfAborted(signal);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    const registered = this.#registerResource(
      context,
      collection,
      target,
      false,
    );
    return {
      resourceId: registered.resourceId,
      version: versionId(input.content),
      created: currentContent === null,
      updatedAt: (await stat(target)).mtime.toISOString(),
    };
  }

  async #searchEvidence(
    context: AgentToolSessionContext,
    input: EvidenceSearchArguments,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.#evidence === undefined) {
      throw new DomainError(
        "Evidence search is not initialized",
        "unavailable",
        503,
      );
    }
    return this.#evidence.search(context, input, signal);
  }

  async #getEvidence(
    context: AgentToolSessionContext,
    input: EvidenceGetArguments,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.#evidence === undefined) {
      throw new DomainError(
        "Evidence lookup is not initialized",
        "unavailable",
        503,
      );
    }
    return this.#evidence.get(context, input, signal);
  }

  async #enqueueJob(
    context: AgentToolSessionContext,
    input: ReturnType<
      typeof agentToolArgumentsSchemas["job.enqueue"]["parse"]
    >,
  ): Promise<unknown> {
    const result = await this.#jobs.enqueue(context.tenant, {
      projectId: context.projectId,
      type: input.type,
      payload: {
        sourceIds: input.sourceIds ?? [],
        instruction: input.instruction ?? null,
        outputFormat: input.outputFormat ?? null,
      },
      idempotencyKey: input.idempotencyKey,
      maxAttempts: 3,
    });
    return {
      jobId: result.job.id,
      status: result.job.status,
    };
  }

  async #getJob(
    context: AgentToolSessionContext,
    jobId: string,
  ): Promise<unknown> {
    const job = await this.#jobs.get(context.tenant, jobId);
    if (job === null || job.projectId !== context.projectId) {
      throw new NotFoundError("Job");
    }
    const progress =
      job.status === "queued"
        ? 0
        : job.status === "running"
          ? Math.min(0.95, job.attempt / Math.max(1, job.maxAttempts))
          : 1;
    const resultSummary =
      job.result === null
        ? null
        : JSON.stringify(job.result).slice(0, 20_000);
    return {
      jobId: job.id,
      type: job.type,
      status: job.status,
      progress,
      resultSummary,
      error: job.error?.slice(0, 4_000) ?? null,
    };
  }

  async #collectionRoot(
    context: AgentToolSessionContext,
    collection: WorkspaceCollection,
  ): Promise<string> {
    return ensureDirectoryWithin(
      path.join(context.projectRoot, collection),
      context.projectRoot,
    );
  }

  async #directoryEntries(
    context: AgentToolSessionContext,
    collection: WorkspaceCollection,
    directory: string,
    signal: AbortSignal,
  ): Promise<ResourceEntry[]> {
    const rows = await readdir(directory, { withFileTypes: true });
    const entries: ResourceEntry[] = [];
    for (const row of rows) {
      throwIfAborted(signal);
      if (row.isSymbolicLink() || (!row.isDirectory() && !row.isFile())) {
        continue;
      }
      const absolutePath = assertPathWithin(
        path.join(directory, row.name),
        context.projectRoot,
      );
      entries.push(
        this.#registerResource(
          context,
          collection,
          absolutePath,
          row.isDirectory(),
        ),
      );
    }
    entries.sort(
      (left, right) =>
        Number(left.kind !== "folder") -
          Number(right.kind !== "folder") ||
        left.name.localeCompare(right.name),
    );
    return entries;
  }

  async #walkFiles(
    context: AgentToolSessionContext,
    collection: WorkspaceCollection,
    directory: string,
    output: ResourceEntry[],
    signal: AbortSignal,
  ): Promise<void> {
    if (output.length >= MAX_SEARCH_FILES) return;
    const entries = await this.#directoryEntries(
      context,
      collection,
      directory,
      signal,
    );
    for (const entry of entries) {
      if (output.length >= MAX_SEARCH_FILES) return;
      if (entry.kind === "folder") {
        await this.#walkFiles(
          context,
          collection,
          entry.absolutePath,
          output,
          signal,
        );
      } else {
        output.push(entry);
      }
    }
  }

  #registerResource(
    context: AgentToolSessionContext,
    collection: WorkspaceCollection,
    absolutePath: string,
    isDirectory: boolean,
  ): ResourceEntry {
    const relativePath = path.relative(
      path.join(context.projectRoot, collection),
      absolutePath,
    );
    const entry: ResourceEntry = {
      resourceId: resourceId(collection, relativePath),
      collection,
      absolutePath,
      name: path.basename(absolutePath),
      kind: resourceKind(collection, isDirectory),
    };
    const registry =
      this.#resources.get(context.session.id) ??
      new Map<string, ResourceEntry>();
    registry.set(entry.resourceId, entry);
    this.#resources.set(context.session.id, registry);
    return entry;
  }

  async #resolveResource(
    context: AgentToolSessionContext,
    id: string,
    signal: AbortSignal,
  ): Promise<ResourceEntry> {
    const existing = this.#resources.get(context.session.id)?.get(id);
    if (existing !== undefined) {
      return existing;
    }
    for (const collection of [
      "sources",
      "research",
      "reports",
      "models",
      "notes",
    ] as const) {
      const root = await this.#collectionRoot(context, collection);
      const files: ResourceEntry[] = [];
      await this.#walkFiles(
        context,
        collection,
        root,
        files,
        signal,
      );
      const resolved = this.#resources.get(context.session.id)?.get(id);
      if (resolved !== undefined) {
        return resolved;
      }
    }
    throw new NotFoundError("Workspace resource");
  }

  async #realFileWithin(
    candidate: string,
    root: string,
  ): Promise<string> {
    const details = await lstat(candidate);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new DomainError(
        "Resource is not a regular file",
        "forbidden",
        403,
      );
    }
    const [realCandidate, realRoot] = await Promise.all([
      realpath(candidate),
      realpath(root),
    ]);
    assertPathWithin(realCandidate, realRoot);
    return candidate;
  }
}
