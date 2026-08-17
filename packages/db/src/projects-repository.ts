import type { DatabaseSync } from "node:sqlite";

import type { Clock } from "@private-fund/core";
import {
  ConflictError,
  NotFoundError,
  isoNow,
  newId,
  systemClock,
} from "@private-fund/core";

import type { SqlRow } from "./rows.js";
import {
  rowNullableString,
  rowString,
} from "./rows.js";
import { withTransaction } from "./transaction.js";
import type {
  ProjectLifecycleEventRecord,
  ProjectRecord,
} from "./types.js";
import { UsersRepository } from "./users-repository.js";

export const PROJECT_TOMBSTONE_RETENTION_DAYS = 90;
export const PROJECT_TOMBSTONE_RETENTION_MILLISECONDS =
  PROJECT_TOMBSTONE_RETENTION_DAYS * 24 * 60 * 60 * 1_000;

export interface CreateProjectInput {
  readonly id?: string;
  readonly name: string;
  readonly companyName?: string | null;
  readonly ticker?: string | null;
}

export interface UpdateProjectInput {
  readonly name?: string;
  readonly companyName?: string | null;
  readonly ticker?: string | null;
}

const PROJECT_COLUMNS = `
  p.id,
  p.user_id AS userId,
  u.data_namespace AS tenantNamespace,
  p.name,
  p.company_name AS companyName,
  p.ticker,
  p.created_at AS createdAt,
  p.updated_at AS updatedAt,
  p.deleted_at AS deletedAt,
  p.retained_until AS retainedUntil
`;

function mapProject(row: SqlRow): ProjectRecord {
  return {
    id: rowString(row, "id"),
    userId: rowString(row, "userId"),
    tenantNamespace: rowString(row, "tenantNamespace"),
    name: rowString(row, "name"),
    companyName: rowNullableString(row, "companyName"),
    ticker: rowNullableString(row, "ticker"),
    createdAt: rowString(row, "createdAt"),
    updatedAt: rowString(row, "updatedAt"),
    deletedAt: rowNullableString(row, "deletedAt"),
    retainedUntil: rowNullableString(row, "retainedUntil"),
  };
}

const PROJECT_LIFECYCLE_EVENT_COLUMNS = `
  event_id AS eventId,
  project_id AS projectId,
  user_id AS userId,
  action,
  deleted_at AS deletedAt,
  retained_until AS retainedUntil,
  occurred_at AS occurredAt
`;

function mapProjectLifecycleEvent(
  row: SqlRow,
): ProjectLifecycleEventRecord {
  const action = rowString(row, "action");
  if (action !== "tombstoned" && action !== "restored") {
    throw new Error("Stored project lifecycle action is invalid");
  }
  return {
    eventId: rowString(row, "eventId"),
    projectId: rowString(row, "projectId"),
    userId: rowString(row, "userId"),
    action,
    deletedAt: rowString(row, "deletedAt"),
    retainedUntil: rowString(row, "retainedUntil"),
    occurredAt: rowString(row, "occurredAt"),
  };
}

export class ProjectsRepository {
  private readonly users: UsersRepository;

  public constructor(
    private readonly database: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {
    this.users = new UsersRepository(database, clock);
  }

  public createForTenant(
    tenantNamespace: string,
    input: CreateProjectInput,
  ): ProjectRecord {
    const user = this.users.getByNamespace(tenantNamespace);
    const id = input.id ?? newId("project");
    const name = input.name.trim();
    if (name.length === 0 || name.length > 200) {
      throw new RangeError("Project name must contain between 1 and 200 characters");
    }
    const now = isoNow(this.clock);
    this.database
      .prepare(
        `INSERT INTO projects(
           id, user_id, name, company_name, ticker, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        user.id,
        name,
        input.companyName ?? null,
        input.ticker ?? null,
        now,
        now,
      );
    return this.getForTenant(tenantNamespace, id);
  }

  public findForTenant(
    tenantNamespace: string,
    projectId: string,
  ): ProjectRecord | null {
    const row = this.database
      .prepare(
        `SELECT ${PROJECT_COLUMNS}
         FROM projects AS p
         JOIN users AS u ON u.id = p.user_id
         WHERE u.data_namespace = ? AND p.id = ?
           AND p.deleted_at IS NULL`,
      )
      .get(tenantNamespace, projectId);
    return row === undefined ? null : mapProject(row);
  }

  public findIncludingDeletedForTenant(
    tenantNamespace: string,
    projectId: string,
  ): ProjectRecord | null {
    const row = this.database
      .prepare(
        `SELECT ${PROJECT_COLUMNS}
         FROM projects AS p
         JOIN users AS u ON u.id = p.user_id
         WHERE u.data_namespace = ? AND p.id = ?`,
      )
      .get(tenantNamespace, projectId);
    return row === undefined ? null : mapProject(row);
  }

  public getForTenant(
    tenantNamespace: string,
    projectId: string,
  ): ProjectRecord {
    const project = this.findForTenant(tenantNamespace, projectId);
    if (project === null) {
      throw new NotFoundError("Project");
    }
    return project;
  }

  public listForTenant(tenantNamespace: string): ProjectRecord[] {
    return this.database
      .prepare(
        `SELECT ${PROJECT_COLUMNS}
         FROM projects AS p
         JOIN users AS u ON u.id = p.user_id
         WHERE u.data_namespace = ?
           AND p.deleted_at IS NULL
         ORDER BY p.updated_at DESC, p.id`,
      )
      .all(tenantNamespace)
      .map(mapProject);
  }

  public updateForTenant(
    tenantNamespace: string,
    projectId: string,
    input: UpdateProjectInput,
  ): ProjectRecord {
    const current = this.getForTenant(tenantNamespace, projectId);
    const name = input.name?.trim() ?? current.name;
    if (name.length === 0 || name.length > 200) {
      throw new RangeError("Project name must contain between 1 and 200 characters");
    }
    const now = isoNow(this.clock);
    this.database
      .prepare(
        `UPDATE projects
         SET name = ?, company_name = ?, ticker = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      )
      .run(
        name,
        input.companyName === undefined
          ? current.companyName
          : input.companyName,
        input.ticker === undefined ? current.ticker : input.ticker,
        now,
        projectId,
        current.userId,
      );
    return this.getForTenant(tenantNamespace, projectId);
  }

  public deleteForTenant(
    tenantNamespace: string,
    projectId: string,
  ): boolean {
    return withTransaction(this.database, () => {
      const project = this.findForTenant(tenantNamespace, projectId);
      if (project === null) {
        return false;
      }

      const activeSession = this.database
        .prepare(
          `SELECT 1
           FROM sessions AS s
           WHERE s.project_id = ?
             AND s.user_id = ?
             AND s.deleted_at IS NULL
             AND (
               s.archived_at IS NULL
               OR s.status = 'running'
               OR EXISTS (
                 SELECT 1
                 FROM operations AS o
                 WHERE o.session_id = s.id
                   AND o.status IN ('queued', 'running')
               )
             )
           LIMIT 1`,
        )
        .get(project.id, project.userId);
      if (activeSession !== undefined) {
        throw new ConflictError(
          "Cannot delete a project while it has active sessions",
          "project_has_active_sessions",
        );
      }

      const activeJob = this.database
        .prepare(
          `SELECT 1
           FROM jobs
           WHERE project_id = ?
             AND tenant_namespace = ?
             AND status IN ('queued', 'running')
           LIMIT 1`,
        )
        .get(project.id, tenantNamespace);
      if (activeJob !== undefined) {
        throw new ConflictError(
          "Cannot delete a project while it has queued or running jobs",
          "project_has_active_jobs",
        );
      }

      const now = this.clock();
      const deletedAt = now.toISOString();
      const retainedUntil = new Date(
        now.getTime() + PROJECT_TOMBSTONE_RETENTION_MILLISECONDS,
      ).toISOString();
      const result = this.database
        .prepare(
          `UPDATE projects
           SET deleted_at = ?, retained_until = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        )
        .run(
          deletedAt,
          retainedUntil,
          deletedAt,
          project.id,
          project.userId,
        );
      if (result.changes !== 1) {
        throw new ConflictError(
          "Project changed while it was being deleted",
          "concurrent_project_update",
        );
      }
      this.insertLifecycleEvent(
        project,
        "tombstoned",
        deletedAt,
        retainedUntil,
        deletedAt,
      );
      return true;
    });
  }

  public restoreForTenant(
    tenantNamespace: string,
    projectId: string,
  ): ProjectRecord {
    return withTransaction(this.database, () => {
      const project = this.findIncludingDeletedForTenant(
        tenantNamespace,
        projectId,
      );
      if (
        project === null ||
        project.deletedAt === null ||
        project.retainedUntil === null
      ) {
        throw new NotFoundError("Deleted project");
      }
      const restoredAt = isoNow(this.clock);
      if (restoredAt > project.retainedUntil) {
        throw new ConflictError(
          "Project recovery retention window has expired",
          "project_retention_expired",
        );
      }
      const result = this.database
        .prepare(
          `UPDATE projects
           SET deleted_at = NULL, retained_until = NULL, updated_at = ?
           WHERE id = ? AND user_id = ? AND deleted_at = ?`,
        )
        .run(
          restoredAt,
          project.id,
          project.userId,
          project.deletedAt,
        );
      if (result.changes !== 1) {
        throw new ConflictError(
          "Project changed while it was being restored",
          "concurrent_project_update",
        );
      }
      this.insertLifecycleEvent(
        project,
        "restored",
        project.deletedAt,
        project.retainedUntil,
        restoredAt,
      );
      return this.getForTenant(tenantNamespace, projectId);
    });
  }

  public listLifecycleEventsForTenant(
    tenantNamespace: string,
    projectId: string,
  ): ProjectLifecycleEventRecord[] {
    const project = this.findIncludingDeletedForTenant(
      tenantNamespace,
      projectId,
    );
    if (project === null) {
      throw new NotFoundError("Project");
    }
    return this.database
      .prepare(
        `SELECT ${PROJECT_LIFECYCLE_EVENT_COLUMNS}
         FROM project_lifecycle_events
         WHERE project_id = ? AND user_id = ?
         ORDER BY occurred_at, event_id`,
      )
      .all(project.id, project.userId)
      .map(mapProjectLifecycleEvent);
  }

  private insertLifecycleEvent(
    project: ProjectRecord,
    action: ProjectLifecycleEventRecord["action"],
    deletedAt: string,
    retainedUntil: string,
    occurredAt: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO project_lifecycle_events(
           event_id, project_id, user_id, action,
           deleted_at, retained_until, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("project-lifecycle"),
        project.id,
        project.userId,
        action,
        deletedAt,
        retainedUntil,
        occurredAt,
      );
  }
}
