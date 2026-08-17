import type { DatabaseSync } from "node:sqlite";

import type { Session } from "@private-fund/contracts";
import type { Clock } from "@private-fund/core";
import {
  ConflictError,
  NotFoundError,
  isoNow,
  newId,
  systemClock,
} from "@private-fund/core";

import { encodeJson } from "./json.js";
import type { SqlRow } from "./rows.js";
import {
  rowNullableString,
  rowNumber,
  rowString,
} from "./rows.js";
import { withTransaction } from "./transaction.js";
import type { SessionRecord } from "./types.js";

export interface CreateSessionInput {
  readonly id?: string;
  readonly projectId: string;
  readonly title?: string;
  readonly model?: string | null;
  readonly piSessionFile?: string | null;
  readonly forkedFromSessionId?: string | null;
}

export interface ListSessionChildrenOptions {
  readonly limit: number;
  readonly offset: number;
  readonly includeArchived: boolean;
}

export interface SessionChildrenPageRecord {
  readonly items: SessionRecord[];
  readonly total: number;
}

const SESSION_COLUMNS = `
  s.id,
  s.user_id AS userId,
  u.data_namespace AS tenantNamespace,
  s.project_id AS projectId,
  s.title,
  s.model,
  s.pi_session_file AS piSessionFile,
  s.status,
  s.archived_at AS archivedAt,
  s.deleted_at AS deletedAt,
  s.forked_from_session_id AS forkedFromSessionId,
  s.last_sequence AS lastSequence,
  s.created_at AS createdAt,
  s.updated_at AS updatedAt
`;

function mapSession(row: SqlRow): SessionRecord {
  return {
    id: rowString(row, "id"),
    userId: rowString(row, "userId"),
    tenantNamespace: rowString(row, "tenantNamespace"),
    projectId: rowString(row, "projectId"),
    title: rowString(row, "title"),
    model: rowNullableString(row, "model"),
    piSessionFile: rowNullableString(row, "piSessionFile"),
    status: rowString(row, "status") as Session["status"],
    archivedAt: rowNullableString(row, "archivedAt"),
    deletedAt: rowNullableString(row, "deletedAt"),
    forkedFromSessionId: rowNullableString(row, "forkedFromSessionId"),
    lastSequence: rowNumber(row, "lastSequence"),
    createdAt: rowString(row, "createdAt"),
    updatedAt: rowString(row, "updatedAt"),
  };
}

export class SessionsRepository {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {}

  public createForTenant(
    tenantNamespace: string,
    input: CreateSessionInput,
  ): SessionRecord {
    const tenantProject = this.database
      .prepare(
        `SELECT p.user_id AS userId
         FROM projects AS p
         JOIN users AS u ON u.id = p.user_id
         WHERE p.id = ? AND u.data_namespace = ?
           AND p.deleted_at IS NULL`,
      )
      .get(input.projectId, tenantNamespace);
    if (tenantProject === undefined) {
      throw new NotFoundError("Project");
    }

    const id = input.id ?? newId("session");
    if (
      input.forkedFromSessionId !== null &&
      input.forkedFromSessionId !== undefined
    ) {
      const source = this.findForTenant(
        tenantNamespace,
        input.forkedFromSessionId,
      );
      if (source === null) {
        throw new NotFoundError("Fork source session");
      }
      if (source.projectId !== input.projectId) {
        throw new ConflictError(
          "Fork source session belongs to a different project",
          "fork_project_mismatch",
        );
      }
      if (source.id === id) {
        throw new ConflictError(
          "A session cannot be its own fork source",
          "invalid_fork_lineage",
        );
      }
    }
    const title = input.title?.trim() ?? "";
    if (title.length > 300) {
      throw new RangeError("Session title must not exceed 300 characters");
    }
    const timestamp = isoNow(this.clock);
    const userId = String(tenantProject.userId);

    withTransaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO sessions(
             id, user_id, project_id, title, model, pi_session_file,
             status, last_sequence, archived_at, deleted_at,
             forked_from_session_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'idle', 0, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          id,
          userId,
          input.projectId,
          title,
          input.model ?? null,
          input.piSessionFile ?? null,
          input.forkedFromSessionId ?? null,
          timestamp,
          timestamp,
        );

      this.database
        .prepare(
          `INSERT INTO session_events(
             session_id, sequence, type, timestamp, operation_id, payload_json
           ) VALUES (?, 1, 'session.created', ?, NULL, ?)`,
        )
        .run(
          id,
          timestamp,
          encodeJson({
            projectId: input.projectId,
            title,
            forkedFromSessionId: input.forkedFromSessionId ?? null,
          }),
        );
    });

    return this.getForTenant(tenantNamespace, id);
  }

  public findForTenant(
    tenantNamespace: string,
    sessionId: string,
  ): SessionRecord | null {
    const row = this.database
      .prepare(
        `SELECT ${SESSION_COLUMNS}
         FROM sessions AS s
         JOIN users AS u ON u.id = s.user_id
         JOIN projects AS p
           ON p.id = s.project_id AND p.user_id = s.user_id
         WHERE s.id = ? AND u.data_namespace = ?
           AND s.deleted_at IS NULL
           AND p.deleted_at IS NULL`,
      )
      .get(sessionId, tenantNamespace);
    return row === undefined ? null : mapSession(row);
  }

  public getForTenant(
    tenantNamespace: string,
    sessionId: string,
  ): SessionRecord {
    const session = this.findForTenant(tenantNamespace, sessionId);
    if (session === null) {
      throw new NotFoundError("Session");
    }
    return session;
  }

  public listForProject(
    tenantNamespace: string,
    projectId: string,
  ): SessionRecord[] {
    return this.listForTenant(tenantNamespace, projectId);
  }

  public listForTenant(
    tenantNamespace: string,
    projectId?: string,
    includeArchived = false,
  ): SessionRecord[] {
    const projectClause =
      projectId === undefined ? "" : " AND s.project_id = ?";
    const archivedClause =
      includeArchived ? "" : " AND s.archived_at IS NULL";
    const parameters =
      projectId === undefined
        ? [tenantNamespace]
        : [tenantNamespace, projectId];
    return this.database
      .prepare(
        `SELECT ${SESSION_COLUMNS}
         FROM sessions AS s
         JOIN users AS u ON u.id = s.user_id
         JOIN projects AS p
           ON p.id = s.project_id AND p.user_id = s.user_id
         WHERE u.data_namespace = ?
           AND s.deleted_at IS NULL${archivedClause}${projectClause}
           AND p.deleted_at IS NULL
         ORDER BY s.updated_at DESC, s.id`,
      )
      .all(...parameters)
      .map(mapSession);
  }

  public listChildrenForTenant(
    tenantNamespace: string,
    parentSessionId: string,
    options: ListSessionChildrenOptions,
  ): SessionChildrenPageRecord {
    const parent = this.getForTenant(tenantNamespace, parentSessionId);
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 500
    ) {
      throw new RangeError("Child-session limit must be between 1 and 500");
    }
    if (!Number.isSafeInteger(options.offset) || options.offset < 0) {
      throw new RangeError("Child-session offset must be non-negative");
    }

    const archivedClause = options.includeArchived
      ? ""
      : " AND s.archived_at IS NULL";
    const parameters = [
      tenantNamespace,
      parent.id,
      parent.projectId,
    ];
    const totalRow = this.database
      .prepare(
        `SELECT COUNT(*) AS total
         FROM sessions AS s
         JOIN users AS u ON u.id = s.user_id
         WHERE u.data_namespace = ?
           AND s.forked_from_session_id = ?
           AND s.project_id = ?
           AND s.deleted_at IS NULL${archivedClause}`,
      )
      .get(...parameters);
    if (totalRow === undefined) {
      throw new Error("Failed to count child sessions");
    }

    const items = this.database
      .prepare(
        `SELECT ${SESSION_COLUMNS}
         FROM sessions AS s
         JOIN users AS u ON u.id = s.user_id
         WHERE u.data_namespace = ?
           AND s.forked_from_session_id = ?
           AND s.project_id = ?
           AND s.deleted_at IS NULL${archivedClause}
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(
        ...parameters,
        options.limit,
        options.offset,
      )
      .map(mapSession);
    return {
      items,
      total: rowNumber(totalRow as SqlRow, "total"),
    };
  }

  public renameForTenant(
    tenantNamespace: string,
    sessionId: string,
    title: string,
  ): SessionRecord {
    const normalized = title.normalize("NFKC").trim();
    if (normalized.length > 300) {
      throw new RangeError("Session title must not exceed 300 characters");
    }
    return withTransaction(this.database, () => {
      const current = this.getForTenant(tenantNamespace, sessionId);
      if (current.title === normalized) {
        return current;
      }
      const timestamp = isoNow(this.clock);
      this.database
        .prepare(
          `UPDATE sessions
           SET title = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        )
        .run(normalized, timestamp, sessionId, current.userId);
      this.insertLifecycleEvent(
        current,
        "session.renamed",
        timestamp,
        { title: normalized, previousTitle: current.title },
      );
      return this.getForTenant(tenantNamespace, sessionId);
    });
  }

  public setArchivedForTenant(
    tenantNamespace: string,
    sessionId: string,
    archived: boolean,
  ): SessionRecord {
    return withTransaction(this.database, () => {
      const current = this.getForTenant(tenantNamespace, sessionId);
      if ((current.archivedAt !== null) === archived) {
        return current;
      }
      const timestamp = isoNow(this.clock);
      this.database
        .prepare(
          `UPDATE sessions
           SET archived_at = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        )
        .run(
          archived ? timestamp : null,
          timestamp,
          sessionId,
          current.userId,
        );
      this.insertLifecycleEvent(
        current,
        archived ? "session.archived" : "session.unarchived",
        timestamp,
        { archived, archivedAt: archived ? timestamp : null },
      );
      return this.getForTenant(tenantNamespace, sessionId);
    });
  }

  public markDeletedForTenant(
    tenantNamespace: string,
    sessionId: string,
  ): SessionRecord {
    return withTransaction(this.database, () => {
      const current = this.getForTenant(tenantNamespace, sessionId);
      const timestamp = isoNow(this.clock);
      this.insertLifecycleEvent(
        current,
        "session.deleted",
        timestamp,
        { deletedAt: timestamp },
      );
      this.database
        .prepare(
          `UPDATE sessions
           SET deleted_at = ?, archived_at = COALESCE(archived_at, ?),
               updated_at = ?
           WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        )
        .run(
          timestamp,
          timestamp,
          timestamp,
          sessionId,
          current.userId,
        );
      return this.getIncludingDeletedForTenant(
        tenantNamespace,
        sessionId,
      );
    });
  }

  public appendForkEventForTenant(
    tenantNamespace: string,
    sessionId: string,
    type: "session.fork.created" | "session.forked",
    payload: Record<string, unknown>,
  ): SessionRecord {
    return withTransaction(this.database, () => {
      const current = this.getForTenant(tenantNamespace, sessionId);
      this.insertLifecycleEvent(
        current,
        type,
        isoNow(this.clock),
        payload,
      );
      return this.getForTenant(tenantNamespace, sessionId);
    });
  }

  public setStatusForTenant(
    tenantNamespace: string,
    sessionId: string,
    status: Session["status"],
  ): SessionRecord {
    return withTransaction(this.database, () => {
      const current = this.getForTenant(tenantNamespace, sessionId);
      if (current.status === status) {
        return current;
      }
      const timestamp = isoNow(this.clock);
      this.database
        .prepare(
          `UPDATE sessions
           SET status = ?, updated_at = ?
           WHERE id = ? AND user_id = ?`,
        )
        .run(status, timestamp, sessionId, current.userId);
      this.database
        .prepare(
          `INSERT INTO session_events(
             session_id, sequence, type, timestamp, operation_id, payload_json
           ) VALUES (?, ?, 'session.status', ?, NULL, ?)`,
        )
        .run(
          sessionId,
          current.lastSequence + 1,
          timestamp,
          encodeJson({ status }),
        );
      return this.getForTenant(tenantNamespace, sessionId);
    });
  }

  public setPiSessionFileForTenant(
    tenantNamespace: string,
    sessionId: string,
    piSessionFile: string | null,
  ): SessionRecord {
    const current = this.getForTenant(tenantNamespace, sessionId);
    this.database
      .prepare(
        `UPDATE sessions
         SET pi_session_file = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(
        piSessionFile,
        isoNow(this.clock),
        sessionId,
        current.userId,
      );
    return this.getForTenant(tenantNamespace, sessionId);
  }

  private getIncludingDeletedForTenant(
    tenantNamespace: string,
    sessionId: string,
  ): SessionRecord {
    const row = this.database
      .prepare(
        `SELECT ${SESSION_COLUMNS}
         FROM sessions AS s
         JOIN users AS u ON u.id = s.user_id
         WHERE s.id = ? AND u.data_namespace = ?`,
      )
      .get(sessionId, tenantNamespace);
    if (row === undefined) {
      throw new NotFoundError("Session");
    }
    return mapSession(row);
  }

  private insertLifecycleEvent(
    current: SessionRecord,
    type: string,
    timestamp: string,
    payload: Record<string, unknown>,
  ): void {
    this.database
      .prepare(
        `INSERT INTO session_events(
           session_id, sequence, type, timestamp, operation_id, payload_json
         ) VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        current.id,
        current.lastSequence + 1,
        type,
        timestamp,
        encodeJson(payload),
      );
  }
}
