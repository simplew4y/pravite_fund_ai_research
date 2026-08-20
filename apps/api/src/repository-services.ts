import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";

import type {
  CreateProjectRequest,
  CreateSessionRequest,
  DeleteSessionResponse,
  EnqueueJobRequest,
  ForkSessionRequest,
  Job,
  ListSessionChildrenQuery,
  ListJobsQuery,
  ModelGatewayAccess,
  Operation,
  Project,
  SendMessageRequest,
  Session,
  SessionChild,
  SessionChildrenPage,
  SessionEvent,
  SessionLabelsResponse,
  UpdateProjectRequest,
  UpdateSessionRequest,
} from "@private-fund/contracts";
import {
  ConflictError,
  DomainError,
  assertPathWithin,
  ensureDirectoryWithin,
  newId,
  type TenantContext,
} from "@private-fund/core";
import {
  ProjectsRepository,
  type ControlRepositories,
  type OperationRecord,
  type SessionRecord,
} from "@private-fund/db";
import { DurableJobQueue } from "@private-fund/job-queue";

import type {
  AgentEvent,
  AgentWorkerPort,
  StartAgentSessionInput,
} from "./agent-supervisor.js";
import type {
  JobService,
  ProjectService,
  SessionService,
} from "./dependencies.js";

type SessionListener = (event: SessionEvent) => void;

export interface AgentToolSessionContext {
  readonly tenant: TenantContext;
  readonly session: SessionRecord;
  readonly projectId: string;
  readonly projectRoot: string;
}

function publicProject(
  project: ReturnType<ControlRepositories["projects"]["getForTenant"]>,
): Project {
  return {
    id: project.id,
    name: project.name,
    companyName: project.companyName,
    ticker: project.ticker,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function publicSession(session: SessionRecord): Session {
  return {
    id: session.id,
    projectId: session.projectId,
    title: session.title,
    status: session.status,
    archivedAt: session.archivedAt,
    forkedFromSessionId: session.forkedFromSessionId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastSequence: session.lastSequence,
  };
}

function publicChildSession(session: SessionRecord): SessionChild {
  if (session.forkedFromSessionId === null) {
    throw new DomainError(
      "Child session has invalid fork lineage",
      "invalid_fork_lineage",
      500,
    );
  }
  return {
    ...publicSession(session),
    forkedFromSessionId: session.forkedFromSessionId,
  };
}

function publicSessionLabels(session: SessionRecord): SessionLabelsResponse {
  const lifecycle: "active" | "archived" =
    session.archivedAt === null ? "active" : "archived";
  if (session.forkedFromSessionId === null) {
    return {
      id: session.id,
      labels: {
        "private_fund.project_id": session.projectId,
        "private_fund.lifecycle": lifecycle,
        "private_fund.lineage": "root",
      },
    };
  }
  return {
    id: session.id,
    labels: {
      "private_fund.project_id": session.projectId,
      "private_fund.lifecycle": lifecycle,
      "private_fund.lineage": "fork",
      "private_fund.forked_from_session_id": session.forkedFromSessionId,
    },
  };
}

export class RepositoryProjectService implements ProjectService {
  public constructor(private readonly repositories: ControlRepositories) {}

  public async list(tenant: TenantContext): Promise<Project[]> {
    return this.repositories.projects
      .listForTenant(tenant.dataNamespace)
      .map(publicProject);
  }

  public async create(
    tenant: TenantContext,
    input: CreateProjectRequest,
  ): Promise<Project> {
    this.requireTenantUser(tenant);
    const project = this.repositories.projects.createForTenant(
      tenant.dataNamespace,
      {
        name: input.name,
        ...(input.companyName === undefined
          ? {}
          : { companyName: input.companyName }),
        ...(input.ticker === undefined ? {} : { ticker: input.ticker }),
      },
    );
    await ensureDirectoryWithin(
      path.join(tenant.projectsRoot, project.id, "workspace"),
      tenant.root,
    );
    return publicProject(project);
  }

  public async get(
    tenant: TenantContext,
    projectId: string,
  ): Promise<Project | null> {
    const project = this.repositories.projects.findForTenant(
      tenant.dataNamespace,
      projectId,
    );
    return project === null ? null : publicProject(project);
  }

  public async update(
    tenant: TenantContext,
    projectId: string,
    input: UpdateProjectRequest,
  ): Promise<Project | null> {
    this.requireTenantUser(tenant);
    if (
      this.repositories.projects.findForTenant(tenant.dataNamespace, projectId) ===
      null
    ) {
      return null;
    }
    const updated = this.repositories.projects.updateForTenant(
      tenant.dataNamespace,
      projectId,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.companyName === undefined
          ? {}
          : { companyName: input.companyName }),
        ...(input.ticker === undefined ? {} : { ticker: input.ticker }),
      },
    );
    return publicProject(updated);
  }

  public async remove(
    tenant: TenantContext,
    projectId: string,
  ): Promise<boolean> {
    return this.repositories.projects.deleteForTenant(
      tenant.dataNamespace,
      projectId,
    );
  }

  private requireTenantUser(tenant: TenantContext): void {
    const user = this.repositories.users.findById(tenant.userId);
    if (
      user === null ||
      user.dataNamespace !== tenant.dataNamespace
    ) {
      throw new DomainError(
        "Authenticated user has no local tenant record",
        "tenant_not_initialized",
        409,
      );
    }
  }
}

export class RepositoryJobService implements JobService {
  readonly #queue: DurableJobQueue;
  readonly #projects: ProjectsRepository;

  public constructor(
    database: ConstructorParameters<typeof DurableJobQueue>[0],
  ) {
    this.#queue = new DurableJobQueue(database);
    this.#projects = new ProjectsRepository(database);
  }

  public async enqueue(
    tenant: TenantContext,
    input: EnqueueJobRequest,
  ): Promise<{ job: Job; created: boolean }> {
    const payload = await this.#canonicalizeProjectPaths(
      tenant,
      input.projectId,
      input.payload,
    );
    return this.#queue.enqueue({
      tenantNamespace: tenant.dataNamespace,
      projectId: input.projectId,
      type: input.type,
      payload,
      idempotencyKey: input.idempotencyKey,
      maxAttempts: input.maxAttempts,
    });
  }

  public async get(
    tenant: TenantContext,
    jobId: string,
  ): Promise<Job | null> {
    try {
      return this.#queue.getForTenant(tenant.dataNamespace, jobId);
    } catch (error) {
      if (
        error instanceof DomainError &&
        error.code === "not_found"
      ) {
        return null;
      }
      throw error;
    }
  }

  public async list(
    tenant: TenantContext,
    query: ListJobsQuery,
  ): Promise<Job[]> {
    return this.#queue.listForTenant(tenant.dataNamespace, {
      ...(query.projectId === undefined
        ? {}
        : { projectId: query.projectId }),
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.status === undefined ? {} : { status: query.status }),
      limit: query.limit,
    });
  }

  public async cancel(
    tenant: TenantContext,
    jobId: string,
  ): Promise<Job | null> {
    if ((await this.get(tenant, jobId)) === null) {
      return null;
    }
    return this.#queue.cancelForTenant(tenant.dataNamespace, jobId);
  }

  async #canonicalizeProjectPaths(
    tenant: TenantContext,
    projectId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.#projects.getForTenant(
      tenant.dataNamespace,
      projectId,
    );
    const projectRoot = assertPathWithin(
      path.join(tenant.projectsRoot, projectId),
      tenant.root,
    );
    const realProjectRoot = await realpath(projectRoot);
    const canonical = { ...payload };
    for (const key of ["inputPath", "outputDirectory"] as const) {
      const value = canonical[key];
      if (value === undefined) {
        continue;
      }
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new DomainError(
          `Job payload.${key} must be a non-empty path`,
          "invalid_job_payload",
          400,
        );
      }
      const unresolved = path.isAbsolute(value)
        ? path.resolve(value)
        : path.resolve(projectRoot, value);
      try {
        canonical[key] = assertPathWithin(unresolved, projectRoot);
      } catch (logicalRootError) {
        try {
          canonical[key] = assertPathWithin(
            unresolved,
            realProjectRoot,
          );
        } catch {
          throw logicalRootError;
        }
      }
    }
    return canonical;
  }
}

export interface SessionJournalShadowPort {
  sync(tenantNamespace: string, sessionId: string): number;
  appendWithMirror(
    tenantNamespace: string,
    appendLegacy: () => SessionEvent,
  ): SessionEvent;
}

export interface RepositorySessionServiceOptions {
  readonly repositories: ControlRepositories;
  readonly worker: AgentWorkerPort;
  /** Phase 1 shadow writer: reconciles events into the Session Journal. */
  readonly journalShadow?: SessionJournalShadowPort;
  readonly onEventError?: (error: unknown, event: AgentEvent) => void;
  readonly onWorkerFailureError?: (
    error: unknown,
    workerError: Error,
  ) => void;
}

export class RepositorySessionService implements SessionService {
  readonly #repositories: ControlRepositories;
  readonly #worker: AgentWorkerPort;
  readonly #onEventError: (error: unknown, event: AgentEvent) => void;
  readonly #onWorkerFailureError: (
    error: unknown,
    workerError: Error,
  ) => void;
  readonly #listeners = new Map<string, Set<SessionListener>>();
  readonly #activeTenants = new Map<string, TenantContext>();
  readonly #dispatchingSessions = new Set<string>();
  readonly #journalShadow: SessionJournalShadowPort | null;
  readonly #activeCompactions = new Map<string, string>();
  readonly #reconciledCompactionSequences = new Map<string, number>();
  readonly #unsubscribeWorker: () => void;
  readonly #unsubscribeWorkerFailure: (() => void) | null;

  public constructor(options: RepositorySessionServiceOptions) {
    this.#repositories = options.repositories;
    this.#worker = options.worker;
    this.#journalShadow = options.journalShadow ?? null;
    this.#onEventError =
      options.onEventError ??
      ((error) => {
        console.error("Failed to persist an agent event", error);
      });
    this.#onWorkerFailureError =
      options.onWorkerFailureError ??
      ((error, workerError) => {
        console.error(
          "Failed to reconcile an exited agent worker",
          workerError,
          error,
        );
      });
    this.#unsubscribeWorker = this.#worker.subscribe((event) => {
      try {
        this.#handleAgentEvent(event);
      } catch (error) {
        this.#onEventError(error, event);
      }
    });
    this.#unsubscribeWorkerFailure =
      this.#worker.subscribeFailure?.((workerError) => {
        try {
          this.#handleAgentWorkerFailure(workerError);
        } catch (error) {
          this.#onWorkerFailureError(error, workerError);
        }
      }) ?? null;
  }

  public async list(
    tenant: TenantContext,
    projectId?: string,
    includeArchived = false,
  ): Promise<Session[]> {
    const sessions = this.#repositories.sessions.listForTenant(
      tenant.dataNamespace,
      projectId,
      includeArchived,
    );
    for (const session of sessions) {
      this.#reconcileInterruptedCompaction(tenant, session);
      this.#reconcileInterruptedOperation(tenant, session);
    }
    return this.#repositories.sessions
      .listForTenant(tenant.dataNamespace, projectId, includeArchived)
      .map(publicSession);
  }

  public async create(
    tenant: TenantContext,
    input: CreateSessionRequest,
  ): Promise<Session> {
    const sessionId = newId("session");
    const sessionDirectory = await ensureDirectoryWithin(
      tenant.sessionsRoot,
      tenant.root,
    );
    const sessionFile = assertPathWithin(
      path.join(sessionDirectory, `${sessionId}.jsonl`),
      tenant.root,
    );
    const session = this.#repositories.sessions.createForTenant(
      tenant.dataNamespace,
      {
        id: sessionId,
        projectId: input.projectId,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.model === undefined ? {} : { model: input.model }),
        piSessionFile: sessionFile,
      },
    );
    return publicSession(session);
  }

  public async get(
    tenant: TenantContext,
    sessionId: string,
  ): Promise<Session | null> {
    const session = this.#repositories.sessions.findForTenant(
      tenant.dataNamespace,
      sessionId,
    );
    if (session === null) {
      return null;
    }
    this.#reconcileInterruptedCompaction(tenant, session);
    this.#reconcileInterruptedOperation(tenant, session);
    return publicSession(
      this.#repositories.sessions.getForTenant(
        tenant.dataNamespace,
        sessionId,
      ),
    );
  }

  public async children(
    tenant: TenantContext,
    sessionId: string,
    query: ListSessionChildrenQuery,
  ): Promise<SessionChildrenPage> {
    const page = this.#repositories.sessions.listChildrenForTenant(
      tenant.dataNamespace,
      sessionId,
      query,
    );
    return {
      parentSessionId: sessionId,
      items: page.items.map(publicChildSession),
      total: page.total,
      limit: query.limit,
      offset: query.offset,
      hasMore: query.offset + page.items.length < page.total,
    };
  }

  public async labels(
    tenant: TenantContext,
    sessionId: string,
  ): Promise<SessionLabelsResponse> {
    return publicSessionLabels(
      this.#requireSession(tenant, sessionId),
    );
  }

  public async update(
    tenant: TenantContext,
    sessionId: string,
    input: UpdateSessionRequest,
  ): Promise<Session> {
    const before = this.#requireSession(tenant, sessionId);
    if (
      input.archived === true &&
      (before.status === "running" ||
        this.#activeCompactions.has(sessionId))
    ) {
      throw new ConflictError(
        "Cannot archive a session while an operation is running",
        "session_busy",
      );
    }
    if (input.archived === true) {
      await this.#disposeAgentIfActive(sessionId);
    }
    if (input.title !== undefined) {
      this.#repositories.sessions.renameForTenant(
        tenant.dataNamespace,
        sessionId,
        input.title,
      );
    }
    if (input.archived !== undefined) {
      this.#repositories.sessions.setArchivedForTenant(
        tenant.dataNamespace,
        sessionId,
        input.archived,
      );
    }
    this.#publishPersistedEvents(
      tenant,
      sessionId,
      before.lastSequence,
    );
    return publicSession(this.#requireSession(tenant, sessionId));
  }

  public async fork(
    tenant: TenantContext,
    sourceSessionId: string,
    input: ForkSessionRequest,
  ): Promise<Session> {
    const source = this.#requireSession(tenant, sourceSessionId);
    if (
      source.status === "running" ||
      this.#activeCompactions.has(sourceSessionId)
    ) {
      throw new ConflictError(
        "Cannot fork a session while an operation is running",
        "session_busy",
      );
    }
    await this.#disposeAgentIfActive(sourceSessionId);

    const sessionId = newId("session");
    const sessionDirectory = await ensureDirectoryWithin(
      tenant.sessionsRoot,
      tenant.root,
    );
    const destination = assertPathWithin(
      path.join(sessionDirectory, `${sessionId}.jsonl`),
      sessionDirectory,
    );
    const copied = await this.#copySessionFileForFork(
      tenant,
      source,
      destination,
    );
    try {
      const title =
        input.title ??
        `Fork of ${source.title.trim() || "session"}`.slice(0, 300);
      const created = this.#repositories.sessions.createForTenant(
        tenant.dataNamespace,
        {
          id: sessionId,
          projectId: source.projectId,
          title,
          model: input.model ?? source.model,
          piSessionFile: destination,
          forkedFromSessionId: source.id,
        },
      );

      let cursor = 0;
      while (cursor < source.lastSequence) {
        const events =
          this.#repositories.sessionEvents.replayForTenant(
            tenant.dataNamespace,
            source.id,
            cursor,
            5_000,
          );
        if (events.length === 0) {
          break;
        }
        for (const event of events) {
          cursor = event.sequence;
          if (!isForkHistoryEvent(event.type)) {
            continue;
          }
          this.#appendForkHistory(
            tenant.dataNamespace,
            {
              sessionId,
              type: event.type,
              payload: event.payload,
            },
          );
        }
      }
      this.#repositories.sessions.appendForkEventForTenant(
        tenant.dataNamespace,
        sessionId,
        "session.forked",
        {
          sourceSessionId: source.id,
          sourceLastSequence: source.lastSequence,
          historyFileCopied: copied,
        },
      );
      const sourceBefore = source.lastSequence;
      this.#repositories.sessions.appendForkEventForTenant(
        tenant.dataNamespace,
        source.id,
        "session.fork.created",
        {
          forkSessionId: sessionId,
          sourceLastSequence: source.lastSequence,
        },
      );
      this.#publishPersistedEvents(
        tenant,
        source.id,
        sourceBefore,
      );
      return publicSession(
        this.#repositories.sessions.getForTenant(
          tenant.dataNamespace,
          created.id,
        ),
      );
    } catch (error) {
      if (copied) {
        await rm(destination, { force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  public async remove(
    tenant: TenantContext,
    sessionId: string,
  ): Promise<DeleteSessionResponse> {
    const before = this.#requireSession(tenant, sessionId);
    if (
      before.status === "running" ||
      this.#activeCompactions.has(sessionId)
    ) {
      throw new ConflictError(
        "Cannot delete a session while an operation is running",
        "session_busy",
      );
    }
    await this.#disposeAgentIfActive(sessionId);
    const deleted = this.#repositories.sessions.markDeletedForTenant(
      tenant.dataNamespace,
      sessionId,
    );
    this.#publishPersistedEvents(
      tenant,
      sessionId,
      before.lastSequence,
    );
    this.#listeners.delete(
      this.#listenerKey(tenant.dataNamespace, sessionId),
    );
    if (deleted.deletedAt === null) {
      throw new Error("Deleted session has no deletion timestamp");
    }
    return {
      sessionId,
      deleted: true,
      deletedAt: deleted.deletedAt,
    };
  }

  public async sendMessage(
    tenant: TenantContext,
    sessionId: string,
    input: SendMessageRequest,
    modelGatewayAccess?: ModelGatewayAccess,
  ): Promise<{ operationId: string }> {
    const session = this.#requireInteractiveSession(tenant, sessionId);
    const idempotencyKey = input.clientMessageId ?? newId("message");
    if (
      session.status === "running" ||
      this.#dispatchingSessions.has(sessionId)
    ) {
      if (input.clientMessageId !== undefined) {
        const existing =
          this.#repositories.operations
            .listForSession(tenant.dataNamespace, sessionId)
            .find(
              (operation) =>
                operation.idempotencyKey === input.clientMessageId,
            );
        if (existing !== undefined) {
          const validated =
            this.#repositories.operations.createForTenant(
              tenant.dataNamespace,
              {
                sessionId,
                kind: "agent.prompt",
                idempotencyKey: input.clientMessageId,
                request: { content: input.content },
              },
            );
          return { operationId: validated.operation.id };
        }
      }
      throw new ConflictError(
        "Session already has a running operation",
        "session_busy",
      );
    }

    this.#dispatchingSessions.add(sessionId);
    let dispatchedOperation: OperationRecord | null = null;
    try {
      const created = this.#repositories.operations.createForTenant(
        tenant.dataNamespace,
        {
          sessionId,
          kind: "agent.prompt",
          idempotencyKey,
          request: { content: input.content },
        },
      );
      const operation = created.operation;
      if (!created.created) {
        return { operationId: operation.id };
      }
      dispatchedOperation = operation;

      this.#appendAndPublish(tenant, {
        sessionId,
        type: "message.user",
        operationId: operation.id,
        payload: {
          content: input.content,
          clientMessageId: input.clientMessageId ?? null,
        },
      });
      this.#repositories.operations.markRunningForTenant(
        tenant.dataNamespace,
        operation.id,
      );
      this.#setStatusAndPublish(tenant, sessionId, "running");

      await this.#ensureAgentSession(tenant, session, modelGatewayAccess);
      await this.#worker.prompt(sessionId, operation.id, input.content);
      return { operationId: operation.id };
    } catch (error) {
      if (dispatchedOperation !== null) {
        this.#failOperation(tenant, dispatchedOperation, error);
      }
      throw error;
    } finally {
      this.#dispatchingSessions.delete(sessionId);
    }
  }

  public async steer(
    tenant: TenantContext,
    sessionId: string,
    content: string,
  ): Promise<void> {
    const session = this.#requireInteractiveSession(tenant, sessionId);
    await this.#ensureAgentSession(tenant, session);
    // Steering is a real user turn: persist it before forwarding so the
    // transcript, replay and future context all contain the follow-up.
    this.#appendAndPublish(tenant, {
      sessionId: session.id,
      type: "message.user",
      payload: { content, steering: true },
    });
    await this.#worker.steer(sessionId, content);
  }

  public async interrupt(
    tenant: TenantContext,
    sessionId: string,
  ): Promise<void> {
    const session = this.#requireInteractiveSession(tenant, sessionId);
    await this.#ensureAgentSession(tenant, session);
    await this.#worker.interrupt(sessionId);
  }

  public async compact(
    tenant: TenantContext,
    sessionId: string,
    customInstructions?: string,
  ): Promise<void> {
    const session = this.#requireInteractiveSession(tenant, sessionId);
    if (
      session.status === "running" ||
      this.#activeCompactions.has(sessionId)
    ) {
      throw new ConflictError(
        "Cannot compact a session while an operation is running",
        "session_busy",
      );
    }
    const compactionId = newId("compaction");
    this.#activeCompactions.set(sessionId, compactionId);
    try {
      this.#appendAndPublish(tenant, {
        sessionId,
        type: "compaction.requested",
        payload: {
          compactionId,
          customInstructions: customInstructions !== undefined,
        },
      });
      await this.#ensureAgentSession(tenant, session);
      await this.#worker.compact(sessionId, customInstructions);
    } catch (error) {
      this.#activeCompactions.delete(sessionId);
      this.#appendAndPublish(tenant, {
        sessionId,
        type: "compaction.failed",
        payload: {
          compactionId,
          reason: "dispatch_failed",
          error: error instanceof Error ? error.message : String(error),
          recoverable: true,
        },
      });
      throw error;
    }
  }

  public async events(
    tenant: TenantContext,
    sessionId: string,
    after: number,
    limit: number,
  ): Promise<SessionEvent[]> {
    this.#requireSession(tenant, sessionId);
    this.#journalShadow?.sync(tenant.dataNamespace, sessionId);
    return this.#repositories.sessionEvents.replayForTenant(
      tenant.dataNamespace,
      sessionId,
      after,
      Math.min(limit, 5_000),
    );
  }

  public async operation(
    tenant: TenantContext,
    sessionId: string,
    operationId: string,
  ): Promise<Operation | null> {
    this.#requireSession(tenant, sessionId);
    try {
      const operation = this.#repositories.operations.getForTenant(
        tenant.dataNamespace,
        operationId,
      );
      return operation.sessionId === sessionId ? operation : null;
    } catch (error) {
      if (
        error instanceof DomainError &&
        error.code === "not_found"
      ) {
        return null;
      }
      throw error;
    }
  }

  public async operations(
    tenant: TenantContext,
    sessionId: string,
  ): Promise<Operation[]> {
    this.#requireSession(tenant, sessionId);
    return this.#repositories.operations.listForSession(
      tenant.dataNamespace,
      sessionId,
    );
  }

  public subscribe(
    tenant: TenantContext,
    sessionId: string,
    listener: SessionListener,
  ): () => void {
    this.#requireSession(tenant, sessionId);
    const key = this.#listenerKey(tenant.dataNamespace, sessionId);
    const listeners = this.#listeners.get(key) ?? new Set<SessionListener>();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.#listeners.delete(key);
      }
    };
  }

  public dispose(): void {
    this.#unsubscribeWorker();
    this.#unsubscribeWorkerFailure?.();
    this.#listeners.clear();
    this.#activeTenants.clear();
    this.#dispatchingSessions.clear();
    this.#activeCompactions.clear();
    this.#reconciledCompactionSequences.clear();
  }

  async #disposeAgentIfActive(sessionId: string): Promise<void> {
    if (!this.#activeTenants.has(sessionId)) {
      return;
    }
    await this.#worker.dispose(sessionId);
    this.#activeTenants.delete(sessionId);
  }

  async #copySessionFileForFork(
    tenant: TenantContext,
    source: SessionRecord,
    destination: string,
  ): Promise<boolean> {
    const sourcePath =
      source.piSessionFile ??
      path.join(tenant.sessionsRoot, `${source.id}.jsonl`);
    const sourceDetails = await lstat(sourcePath).catch(() => null);
    if (sourceDetails === null) {
      return false;
    }
    if (!sourceDetails.isFile() || sourceDetails.isSymbolicLink()) {
      throw new DomainError(
        "Session history file is not a regular file",
        "invalid_session_history",
        409,
      );
    }
    const [realSource, realSessionsRoot] = await Promise.all([
      realpath(sourcePath),
      realpath(tenant.sessionsRoot),
    ]);
    assertPathWithin(realSource, realSessionsRoot);
    await copyFile(realSource, destination, fsConstants.COPYFILE_EXCL);
    const after = await lstat(realSource);
    if (
      after.size !== sourceDetails.size ||
      after.mtimeMs !== sourceDetails.mtimeMs
    ) {
      await rm(destination, { force: true }).catch(() => undefined);
      throw new ConflictError(
        "Session history changed while it was being forked",
        "session_history_changed",
      );
    }
    return true;
  }

  #publishPersistedEvents(
    tenant: TenantContext,
    sessionId: string,
    afterSequence: number,
  ): void {
    let cursor = afterSequence;
    for (;;) {
      const events =
        this.#repositories.sessionEvents.replayForTenant(
          tenant.dataNamespace,
          sessionId,
          cursor,
          5_000,
        );
      for (const event of events) {
        cursor = event.sequence;
        this.#publish(tenant, event);
      }
      if (events.length < 5_000) {
        return;
      }
    }
  }

  public agentToolContext(sessionId: string): AgentToolSessionContext | null {
    const tenant = this.#activeTenants.get(sessionId);
    if (tenant === undefined) {
      return null;
    }
    const session = this.#repositories.sessions.findForTenant(
      tenant.dataNamespace,
      sessionId,
    );
    if (session === null) {
      return null;
    }
    return {
      tenant,
      session,
      projectId: session.projectId,
      projectRoot: assertPathWithin(
        path.join(tenant.projectsRoot, session.projectId),
        tenant.root,
      ),
    };
  }

  async #ensureAgentSession(
    tenant: TenantContext,
    session: SessionRecord,
    modelGatewayAccess?: ModelGatewayAccess,
  ): Promise<void> {
    const project = this.#repositories.projects.getForTenant(
      tenant.dataNamespace,
      session.projectId,
    );
    await mkdir(tenant.root, { recursive: true, mode: 0o700 });
    const workspace = await ensureDirectoryWithin(
      path.join(tenant.projectsRoot, project.id, "workspace"),
      tenant.root,
    );
    const sessionDirectory = await ensureDirectoryWithin(
      tenant.sessionsRoot,
      tenant.root,
    );
    const sessionFile = assertPathWithin(
      session.piSessionFile ??
        path.join(sessionDirectory, `${session.id}.jsonl`),
      tenant.root,
    );
    if (session.piSessionFile === null) {
      this.#repositories.sessions.setPiSessionFileForTenant(
        tenant.dataNamespace,
        session.id,
        sessionFile,
      );
    }

    this.#activeTenants.set(session.id, tenant);
    const start: StartAgentSessionInput = {
      sessionId: session.id,
      projectId: project.id,
      tenant: {
        userId: tenant.userId,
        dataNamespace: tenant.dataNamespace,
      },
      workspace,
      sessionFile,
      ...(session.model === null ? {} : { model: session.model }),
      ...(modelGatewayAccess === undefined
        ? {}
        : { modelGatewayAccess }),
    };
    if (
      modelGatewayAccess !== undefined &&
      (modelGatewayAccess.binding.userId !== tenant.userId ||
        modelGatewayAccess.binding.dataNamespace !== tenant.dataNamespace ||
        modelGatewayAccess.binding.projectId !== project.id ||
        modelGatewayAccess.binding.sessionId !== session.id)
    ) {
      throw new DomainError(
        "Model gateway access does not match the authenticated session",
        "model_gateway_binding_mismatch",
        403,
      );
    }
    await this.#worker.start(start);
  }

  #handleAgentEvent(event: AgentEvent): void {
    const tenant = this.#activeTenants.get(event.sessionId);
    if (tenant === undefined) {
      throw new DomainError(
        "Agent event has no authenticated tenant context",
        "orphan_agent_event",
        500,
      );
    }
    const session = this.#requireSession(tenant, event.sessionId);
    const operation =
      event.operationId === null
        ? null
        : this.#repositories.operations.getForTenant(
            tenant.dataNamespace,
            event.operationId,
          );
    if (operation !== null && operation.sessionId !== event.sessionId) {
      throw new ConflictError(
        "Agent event operation does not belong to its session",
        "agent_event_operation_mismatch",
      );
    }

    if (event.eventType === "message.user" && operation !== null) {
      return;
    }

    if (event.eventType === "session.status") {
      const status = event.payload.status;
      if (
        status !== "idle" &&
        status !== "running" &&
        status !== "interrupted" &&
        status !== "failed"
      ) {
        throw new DomainError(
          "Agent emitted an invalid session status",
          "invalid_agent_event",
          502,
        );
      }
      if (status === "idle" && operation !== null) {
        this.#completeOperation(tenant, operation);
      }
      this.#setStatusAndPublish(tenant, session.id, status);
      return;
    }

    if (event.eventType === "operation.interrupted" && operation !== null) {
      if (
        operation.status === "queued" ||
        operation.status === "running"
      ) {
        this.#repositories.operations.interruptForTenant(
          tenant.dataNamespace,
          operation.id,
        );
      }
      this.#appendAndPublish(tenant, {
        sessionId: session.id,
        type: event.eventType,
        operationId: operation.id,
        payload: event.payload,
      });
      this.#setStatusAndPublish(tenant, session.id, "interrupted");
      return;
    }

    if (event.eventType === "operation.failed" && operation !== null) {
      if (
        operation.status === "queued" ||
        operation.status === "running"
      ) {
        this.#repositories.operations.failForTenant(
          tenant.dataNamespace,
          operation.id,
          String(event.payload.error ?? "Agent operation failed"),
        );
      }
      this.#appendAndPublish(tenant, {
        sessionId: session.id,
        type: event.eventType,
        operationId: operation.id,
        payload: event.payload,
      });
      this.#setStatusAndPublish(tenant, session.id, "failed");
      return;
    }

    this.#appendAndPublish(tenant, {
      sessionId: session.id,
      type: event.eventType,
      operationId: event.operationId,
      payload: event.payload,
    });
    if (
      event.eventType === "compaction.completed" ||
      event.eventType === "compaction.failed"
    ) {
      this.#activeCompactions.delete(session.id);
    }
  }

  #handleAgentWorkerFailure(workerError: Error): void {
    for (const [sessionId, tenant] of [...this.#activeTenants]) {
      this.#activeTenants.delete(sessionId);
      this.#dispatchingSessions.delete(sessionId);
      const session = this.#repositories.sessions.findForTenant(
        tenant.dataNamespace,
        sessionId,
      );
      if (session === null) {
        this.#activeCompactions.delete(sessionId);
        continue;
      }

      const compactionId = this.#activeCompactions.get(sessionId);
      if (compactionId !== undefined) {
        this.#activeCompactions.delete(sessionId);
        this.#appendAndPublish(tenant, {
          sessionId,
          type: "compaction.failed",
          payload: {
            compactionId,
            reason: "agent_worker_exit",
            error: workerError.message,
            recoverable: true,
          },
        });
      }

      const pending = this.#repositories.operations
        .listForSession(tenant.dataNamespace, sessionId)
        .filter(
          (operation) =>
            operation.status === "queued" ||
            operation.status === "running",
        );
      for (const operation of pending) {
        this.#repositories.operations.failForTenant(
          tenant.dataNamespace,
          operation.id,
          workerError.message,
        );
        this.#appendAndPublish(tenant, {
          sessionId,
          type: "operation.failed",
          operationId: operation.id,
          payload: {
            error: workerError.message,
            reason: "agent_worker_exit",
            recoverable: true,
          },
        });
      }
      if (pending.length > 0 || session.status === "running") {
        this.#setStatusAndPublish(tenant, sessionId, "failed");
      }
    }
  }

  #completeOperation(
    tenant: TenantContext,
    operation: OperationRecord,
  ): void {
    if (
      operation.status !== "queued" &&
      operation.status !== "running"
    ) {
      return;
    }
    this.#repositories.operations.completeForTenant(
      tenant.dataNamespace,
      operation.id,
      { status: "completed" },
    );
    this.#appendAndPublish(tenant, {
      sessionId: operation.sessionId,
      type: "operation.completed",
      operationId: operation.id,
      payload: {},
    });
  }

  #failOperation(
    tenant: TenantContext,
    operation: OperationRecord,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    const latest = this.#repositories.operations.getForTenant(
      tenant.dataNamespace,
      operation.id,
    );
    if (latest.status === "queued" || latest.status === "running") {
      this.#repositories.operations.failForTenant(
        tenant.dataNamespace,
        operation.id,
        message,
      );
      this.#appendAndPublish(tenant, {
        sessionId: operation.sessionId,
        type: "operation.failed",
        operationId: operation.id,
        payload: { error: message },
      });
    }
    this.#setStatusAndPublish(tenant, operation.sessionId, "failed");
  }

  #setStatusAndPublish(
    tenant: TenantContext,
    sessionId: string,
    status: Session["status"],
  ): void {
    const before = this.#repositories.sessions.getForTenant(
      tenant.dataNamespace,
      sessionId,
    );
    const after = this.#repositories.sessions.setStatusForTenant(
      tenant.dataNamespace,
      sessionId,
      status,
    );
    if (after.lastSequence === before.lastSequence) {
      return;
    }
    const [event] = this.#repositories.sessionEvents.replayForTenant(
      tenant.dataNamespace,
      sessionId,
      before.lastSequence,
      1,
    );
    if (event !== undefined) {
      this.#publish(tenant, event);
    }
  }

  #appendAndPublish(
    tenant: TenantContext,
    input: {
      readonly sessionId: string;
      readonly type: string;
      readonly payload: Record<string, unknown>;
      readonly operationId?: string | null;
    },
  ): SessionEvent {
    const appendLegacy = (): SessionEvent =>
      this.#repositories.sessionEvents.appendForTenant(
        tenant.dataNamespace,
        input,
      );
    // Authority mode writes the journal fact and the UI projection in one
    // transaction (journal failure rejects the event); shadow mode keeps the
    // historical lazy mirror.
    const event =
      this.#journalShadow === null
        ? appendLegacy()
        : this.#journalShadow.appendWithMirror(
            tenant.dataNamespace,
            appendLegacy,
          );
    this.#publish(tenant, event);
    return event;
  }

  #appendForkHistory(
    tenantNamespace: string,
    input: {
      readonly sessionId: string;
      readonly type: string;
      readonly payload: Record<string, unknown>;
    },
  ): SessionEvent {
    const appendLegacy = (): SessionEvent =>
      this.#repositories.sessionEvents.appendForTenant(tenantNamespace, input);
    return this.#journalShadow === null
      ? appendLegacy()
      : this.#journalShadow.appendWithMirror(tenantNamespace, appendLegacy);
  }

  #publish(tenant: TenantContext, event: SessionEvent): void {
    const listeners = this.#listeners.get(
      this.#listenerKey(tenant.dataNamespace, event.sessionId),
    );
    if (listeners === undefined) {
      return;
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        continue;
      }
    }
  }

  #requireSession(
    tenant: TenantContext,
    sessionId: string,
  ): SessionRecord {
    const session = this.#repositories.sessions.getForTenant(
      tenant.dataNamespace,
      sessionId,
    );
    this.#reconcileInterruptedCompaction(tenant, session);
    this.#reconcileInterruptedOperation(tenant, session);
    return this.#repositories.sessions.getForTenant(
      tenant.dataNamespace,
      sessionId,
    );
  }

  #requireInteractiveSession(
    tenant: TenantContext,
    sessionId: string,
  ): SessionRecord {
    const session = this.#requireSession(tenant, sessionId);
    if (session.archivedAt !== null) {
      throw new ConflictError(
        "Archived sessions are read-only",
        "session_archived",
      );
    }
    if (this.#activeCompactions.has(sessionId)) {
      throw new ConflictError(
        "Session context compaction is still running",
        "session_busy",
      );
    }
    return session;
  }

  #listenerKey(tenantNamespace: string, sessionId: string): string {
    return `${tenantNamespace}:${sessionId}`;
  }

  #reconcileInterruptedCompaction(
    tenant: TenantContext,
    session: SessionRecord,
  ): void {
    if (this.#activeCompactions.has(session.id)) {
      return;
    }
    const key = this.#listenerKey(
      tenant.dataNamespace,
      session.id,
    );
    if (
      this.#reconciledCompactionSequences.get(key) ===
      session.lastSequence
    ) {
      return;
    }

    let cursor = 0;
    let pending:
      | {
          readonly compactionId: string;
          readonly sequence: number;
        }
      | null = null;
    for (;;) {
      const events =
        this.#repositories.sessionEvents.replayForTenant(
          tenant.dataNamespace,
          session.id,
          cursor,
          5_000,
        );
      for (const event of events) {
        cursor = event.sequence;
        if (event.type === "compaction.requested") {
          const rawCompactionId = event.payload["compactionId"];
          pending = {
            compactionId:
              typeof rawCompactionId === "string"
                ? rawCompactionId
                : `sequence:${String(event.sequence)}`,
            sequence: event.sequence,
          };
          continue;
        }
        if (
          pending !== null &&
          (event.type === "compaction.completed" ||
            event.type === "compaction.failed")
        ) {
          pending = null;
        }
      }
      if (events.length < 5_000) {
        break;
      }
    }

    if (pending !== null) {
      const recovered = this.#appendAndPublish(tenant, {
        sessionId: session.id,
        type: "compaction.failed",
        payload: {
          compactionId: pending.compactionId,
          reason: "control_plane_restart",
          error:
            "Control plane restarted before compaction emitted a terminal event",
          recoverable: true,
          requestedSequence: pending.sequence,
        },
      });
      this.#reconciledCompactionSequences.set(
        key,
        recovered.sequence,
      );
      return;
    }
    this.#reconciledCompactionSequences.set(
      key,
      session.lastSequence,
    );
  }

  #reconcileInterruptedOperation(
    tenant: TenantContext,
    session: SessionRecord,
  ): void {
    if (
      session.status !== "running" ||
      this.#activeTenants.has(session.id) ||
      this.#dispatchingSessions.has(session.id)
    ) {
      return;
    }

    const pending = this.#repositories.operations
      .listForSession(tenant.dataNamespace, session.id)
      .filter(
        (operation) =>
          operation.status === "queued" ||
          operation.status === "running",
      );
    const error =
      "Control plane restarted before the agent operation emitted a terminal event";
    for (const operation of pending) {
      this.#repositories.operations.failForTenant(
        tenant.dataNamespace,
        operation.id,
        error,
      );
      this.#appendAndPublish(tenant, {
        sessionId: session.id,
        type: "operation.failed",
        operationId: operation.id,
        payload: {
          error,
          reason: "control_plane_restart",
          recoverable: true,
        },
      });
    }
    if (pending.length === 0) {
      this.#appendAndPublish(tenant, {
        sessionId: session.id,
        type: "session.recovery.failed",
        payload: {
          error,
          reason: "control_plane_restart",
          recoverable: true,
        },
      });
    }
    this.#setStatusAndPublish(
      tenant,
      session.id,
      "failed",
    );
  }
}

function isForkHistoryEvent(type: string): boolean {
  return !(
    type.startsWith("session.") ||
    type.startsWith("operation.") ||
    type.startsWith("compaction.")
  );
}
