import { afterEach, describe, expect, it } from "vitest";

import type { CreateGlobalUploadBatchRequest } from "@private-fund/contracts";
import {
  ConflictError,
  NotFoundError,
} from "@private-fund/core";

import {
  createControlRepositories,
  openControlDatabase,
  runMigrations,
  type ControlDatabase,
  type ControlRepositories,
} from "../src/index.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const START_TIME = Date.parse("2026-07-31T00:00:00.000Z");

type UploadItemInput = CreateGlobalUploadBatchRequest["items"][number];

function uploadItem(
  suffix: string,
  overrides: Partial<UploadItemInput> = {},
): UploadItemInput {
  const digestCharacter = (
    [...suffix].reduce(
      (total, character) => total + character.codePointAt(0)!,
      0,
    ) % 16
  ).toString(16);
  return {
    originalFilename: `${suffix}.pdf`,
    stagedRelativePath: `inbox/${suffix}/source.pdf`,
    fileType: "pdf",
    mimeType: "application/pdf",
    fileSize: 1_024,
    sha256: digestCharacter.repeat(64),
    ...overrides,
  };
}

describe("tenant-safe global uploads repository", () => {
  let database: ControlDatabase | undefined;
  let repositories: ControlRepositories;
  let clockTick = 0;

  afterEach(() => {
    database?.close();
    database = undefined;
    clockTick = 0;
  });

  function setup(): ControlRepositories {
    database = openControlDatabase(":memory:");
    repositories = createControlRepositories(database, () => {
      const date = new Date(START_TIME + clockTick * 1_000);
      clockTick += 1;
      return date;
    });
    repositories.users.create({
      id: "user-a",
      dataNamespace: TENANT_A,
    });
    repositories.users.create({
      id: "user-b",
      dataNamespace: TENANT_B,
    });
    return repositories;
  }

  function createProject(
    tenantNamespace: string,
    id: string,
  ): string {
    return repositories.projects.createForTenant(tenantNamespace, {
      id,
      name: id,
      companyName: `${id} company`,
    }).id;
  }

  function createBatch(
    tenantNamespace: string,
    idempotencyKey: string,
    items: UploadItemInput[] = [uploadItem(idempotencyKey)],
  ) {
    return repositories.uploads.createBatchForTenant(tenantNamespace, {
      idempotencyKey,
      actorId: `actor-${tenantNamespace}`,
      items,
    });
  }

  function insertJob(
    id: string,
    tenantNamespace: string,
    projectId: string,
  ): void {
    const timestamp = "2026-07-31T01:00:00.000Z";
    database!
      .prepare(
        `INSERT INTO jobs(
           id,
           tenant_namespace,
           project_id,
           type,
           status,
           payload_json,
           result_json,
           attempt,
           max_attempts,
           lease_owner,
           lease_expires_at,
           idempotency_key,
           available_at,
           created_at,
           started_at,
           updated_at,
           completed_at,
           error
         ) VALUES (
           ?, ?, ?, 'document.ingest', 'queued', '{}', NULL,
           0, 3, NULL, NULL, ?, ?, ?, NULL, ?, NULL, NULL
         )`,
      )
      .run(
        id,
        tenantNamespace,
        projectId,
        `idempotency-${id}`,
        timestamp,
        timestamp,
        timestamp,
      );
  }

  it("applies migration v3 idempotently with canonical upload tables", () => {
    setup();
    const first = runMigrations(database!);
    const second = runMigrations(database!);
    expect(first).toEqual(second);
    expect(first.find((migration) => migration.version === 3)).toMatchObject({
      version: 3,
      name: "tenant_safe_global_uploads",
    });

    const tables = database!
      .prepare(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'table' AND name LIKE 'upload_%'
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual([
      "upload_audit_events",
      "upload_batches",
      "upload_items",
    ]);

    const columns = database!
      .prepare("PRAGMA table_info(upload_items)")
      .all()
      .map((row) => row.name);
    expect(columns).toContain("staged_relative_path");
    expect(columns).not.toContain("staged_path");
    expect(columns).not.toContain("client_path");
  });

  it("creates opaque, idempotent batches and paginates without tenant leaks", () => {
    setup();
    const input = {
      idempotencyKey: "batch-create-1",
      actorId: "actor-a",
      items: [
        uploadItem("a1"),
        uploadItem("a2", {
          stagedRelativePath: "inbox/a2/nested/source.pdf",
          fileSize: 2_048,
        }),
      ],
    } satisfies CreateGlobalUploadBatchRequest;
    const first = repositories.uploads.createBatchForTenant(
      TENANT_A,
      input,
    );

    expect(first.created).toBe(true);
    expect(first.batch.batchId).toMatch(/^upb_[a-f0-9]{32}$/u);
    expect(first.batch.fileCount).toBe(2);
    expect(first.batch.status).toBe("queued");
    expect(first.batch.items).toHaveLength(2);
    expect(first.batch.items[0]?.itemId).toMatch(
      /^upi_[a-f0-9]{32}$/u,
    );
    expect(
      first.batch.items.every(
        (item) =>
          !item.stagedRelativePath.startsWith("/") &&
          !item.stagedRelativePath.includes("\\"),
      ),
    ).toBe(true);

    const replay = repositories.uploads.createBatchForTenant(
      TENANT_A,
      input,
    );
    expect(replay.created).toBe(false);
    expect(replay.batch.batchId).toBe(first.batch.batchId);
    expect(
      repositories.uploads.listAuditForTenant(TENANT_A).total,
    ).toBe(1);

    expect(() =>
      repositories.uploads.createBatchForTenant(TENANT_A, {
        ...input,
        items: [uploadItem("changed")],
      }),
    ).toThrow(ConflictError);

    const firstPage = repositories.uploads.listItemsForTenant(TENANT_A, {
      batchId: first.batch.batchId,
      limit: 1,
      offset: 0,
    });
    const secondPage = repositories.uploads.listItemsForTenant(TENANT_A, {
      batchId: first.batch.batchId,
      limit: 1,
      offset: 1,
    });
    expect(firstPage).toMatchObject({
      total: 2,
      limit: 1,
      offset: 0,
      hasMore: true,
    });
    expect(secondPage).toMatchObject({
      total: 2,
      limit: 1,
      offset: 1,
      hasMore: false,
    });
    expect(secondPage.items[0]?.itemId).not.toBe(
      firstPage.items[0]?.itemId,
    );

    createBatch(TENANT_A, "batch-create-2");
    const batchPage = repositories.uploads.listBatchesForTenant(TENANT_A, {
      limit: 1,
      offset: 0,
    });
    expect(batchPage).toMatchObject({
      total: 2,
      limit: 1,
      offset: 0,
      hasMore: true,
    });

    expect(() =>
      repositories.uploads.getBatchForTenant(
        TENANT_B,
        first.batch.batchId,
      ),
    ).toThrow(NotFoundError);
    expect(() =>
      repositories.uploads.getItemForTenant(
        TENANT_B,
        first.batch.items[0]!.itemId,
      ),
    ).toThrow(NotFoundError);
    expect(repositories.uploads.listBatchesForTenant(TENANT_B).total).toBe(
      0,
    );
    expect(repositories.uploads.listItemsForTenant(TENANT_B).total).toBe(
      0,
    );
    expect(repositories.uploads.listAuditForTenant(TENANT_B).total).toBe(
      0,
    );
    const tenantAAudit =
      repositories.uploads.listAuditForTenant(TENANT_A).items[0]!;
    expect(() =>
      repositories.uploads.getAuditForTenant(
        TENANT_B,
        tenantAAudit.auditId,
      ),
    ).toThrow(NotFoundError);
  });

  it("routes only reviewable items and validates the project before mutation", () => {
    setup();
    const projectA = createProject(TENANT_A, "project-a");
    const projectA2 = createProject(TENANT_A, "project-a-2");
    const projectB = createProject(TENANT_B, "project-b");
    const created = createBatch(TENANT_A, "route-batch").batch;
    const itemId = created.items[0]!.itemId;

    expect(() =>
      repositories.uploads.routeItemForTenant(TENANT_A, itemId, {
        projectId: projectA,
        idempotencyKey: "route-too-soon",
      }),
    ).toThrow(ConflictError);

    repositories.uploads.transitionBatchForTenant(
      TENANT_A,
      created.batchId,
      {
        status: "identifying",
        idempotencyKey: "batch-identifying",
      },
    );
    repositories.uploads.transitionItemForTenant(TENANT_A, itemId, {
      status: "identifying",
      idempotencyKey: "item-identifying",
      candidateProjects: [
        {
          projectId: projectA,
          projectName: "Project A",
          companyName: "A",
          ticker: null,
          score: 0.7,
          method: "classifier",
        },
      ],
    });
    repositories.uploads.transitionItemForTenant(TENANT_A, itemId, {
      status: "needs_review",
      idempotencyKey: "item-review",
    });
    repositories.uploads.transitionBatchForTenant(
      TENANT_A,
      created.batchId,
      {
        status: "needs_review",
        idempotencyKey: "batch-review",
      },
    );

    const auditCountBefore = repositories.uploads.listAuditForTenant(
      TENANT_A,
    ).total;
    expect(() =>
      repositories.uploads.routeItemForTenant(TENANT_A, itemId, {
        projectId: projectB,
        idempotencyKey: "cross-tenant-route",
      }),
    ).toThrow(NotFoundError);
    expect(
      repositories.uploads.getItemForTenant(TENANT_A, itemId).status,
    ).toBe("needs_review");
    expect(
      repositories.uploads.listAuditForTenant(TENANT_A).total,
    ).toBe(auditCountBefore);

    const routed = repositories.uploads.routeItemForTenant(
      TENANT_A,
      itemId,
      {
        projectId: projectA,
        idempotencyKey: "manual-route-1",
        actorId: "reviewer-a",
      },
    );
    expect(routed).toMatchObject({
      status: "routing",
      targetProjectId: projectA,
      routeConfidence: 1,
      routeMethod: "manual",
      errorMessage: null,
      pipelineJobId: null,
      documentId: null,
    });
    expect(
      repositories.uploads.getBatchForTenant(
        TENANT_A,
        created.batchId,
      ).status,
    ).toBe("indexing");

    const replay = repositories.uploads.routeItemForTenant(
      TENANT_A,
      itemId,
      {
        projectId: projectA,
        idempotencyKey: "manual-route-1",
        actorId: "reviewer-a",
      },
    );
    expect(replay.targetProjectId).toBe(projectA);
    expect(
      repositories.uploads.listAuditForTenant(TENANT_A).total,
    ).toBe(auditCountBefore + 1);

    expect(() =>
      repositories.uploads.routeItemForTenant(TENANT_A, itemId, {
        projectId: projectA2,
        idempotencyKey: "manual-route-1",
        actorId: "reviewer-a",
      }),
    ).toThrow(ConflictError);
    expect(() =>
      repositories.uploads.routeItemForTenant(TENANT_A, itemId, {
        projectId: projectA,
        idempotencyKey: "manual-route-again",
      }),
    ).toThrow(ConflictError);

    const failedBatch = createBatch(
      TENANT_A,
      "failed-route-batch",
    ).batch;
    const failedItemId = failedBatch.items[0]!.itemId;
    repositories.uploads.transitionBatchForTenant(
      TENANT_A,
      failedBatch.batchId,
      {
        status: "failed",
        message: "worker unavailable",
        idempotencyKey: "failed-route-batch-state",
      },
    );
    const failed = repositories.uploads.transitionItemForTenant(
      TENANT_A,
      failedItemId,
      {
        status: "failed",
        errorMessage: "worker unavailable",
        idempotencyKey: "failed-route-item-state",
      },
    );
    expect(failed.finishedAt).not.toBeNull();
    const recovered = repositories.uploads.routeItemForTenant(
      TENANT_A,
      failedItemId,
      {
        projectId: projectA,
        idempotencyKey: "failed-route-recovery",
      },
    );
    expect(recovered).toMatchObject({
      status: "routing",
      targetProjectId: projectA,
      errorMessage: null,
      finishedAt: null,
    });
    expect(
      repositories.uploads.getBatchForTenant(
        TENANT_A,
        failedBatch.batchId,
      ).status,
    ).toBe("indexing");
  });

  it("enforces item and batch state machines with scoped project/job links", () => {
    setup();
    const projectA = createProject(TENANT_A, "project-a");
    const projectA2 = createProject(TENANT_A, "project-a-2");
    const projectB = createProject(TENANT_B, "project-b");
    insertJob("job-a", TENANT_A, projectA);
    insertJob("job-a-2", TENANT_A, projectA2);
    insertJob("job-b", TENANT_B, projectB);
    const created = createBatch(TENANT_A, "state-batch").batch;
    const itemId = created.items[0]!.itemId;

    expect(() =>
      repositories.uploads.transitionItemForTenant(TENANT_A, itemId, {
        status: "completed",
        idempotencyKey: "invalid-jump",
        targetProjectId: projectA,
      }),
    ).toThrow(ConflictError);
    expect(() =>
      repositories.uploads.transitionItemForTenant(TENANT_A, itemId, {
        status: "identifying",
        idempotencyKey: "cross-candidate",
        candidateProjects: [
          {
            projectId: projectB,
            projectName: "B",
            companyName: null,
            ticker: null,
            score: 0.2,
            method: "classifier",
          },
        ],
      }),
    ).toThrow(NotFoundError);
    expect(
      repositories.uploads.getItemForTenant(TENANT_A, itemId).status,
    ).toBe("uploaded");

    const identifyingInput = {
      status: "identifying",
      idempotencyKey: "identify-valid",
      companyName: "Company A",
      companyConfidence: 0.95,
      companyDetectionMethod: "metadata",
    } as const;
    repositories.uploads.transitionItemForTenant(
      TENANT_A,
      itemId,
      identifyingInput,
    );
    const auditAfterIdentifying =
      repositories.uploads.listAuditForTenant(TENANT_A).total;
    repositories.uploads.transitionItemForTenant(
      TENANT_A,
      itemId,
      identifyingInput,
    );
    expect(
      repositories.uploads.listAuditForTenant(TENANT_A).total,
    ).toBe(auditAfterIdentifying);
    expect(() =>
      repositories.uploads.transitionItemForTenant(TENANT_A, itemId, {
        ...identifyingInput,
        companyConfidence: 0.5,
      }),
    ).toThrow(ConflictError);
    expect(() =>
      repositories.uploads.transitionItemForTenant(TENANT_A, itemId, {
        status: "routing",
        idempotencyKey: "wrong-project-job",
        targetProjectId: projectA,
        pipelineJobId: "job-a-2",
      }),
    ).toThrow(NotFoundError);
    expect(() =>
      repositories.uploads.transitionItemForTenant(TENANT_A, itemId, {
        status: "routing",
        idempotencyKey: "cross-tenant-job",
        targetProjectId: projectA,
        pipelineJobId: "job-b",
      }),
    ).toThrow(NotFoundError);

    const routing = repositories.uploads.transitionItemForTenant(
      TENANT_A,
      itemId,
      {
        status: "routing",
        idempotencyKey: "routing-valid",
        targetProjectId: projectA,
        routeConfidence: 0.99,
        routeMethod: "automatic",
        pipelineJobId: "job-a",
        documentId: "document-a",
      },
    );
    expect(routing).toMatchObject({
      targetProjectId: projectA,
      pipelineJobId: "job-a",
      documentId: "document-a",
    });
    repositories.uploads.transitionItemForTenant(TENANT_A, itemId, {
      status: "routed",
      idempotencyKey: "routed-valid",
    });
    repositories.uploads.transitionItemForTenant(TENANT_A, itemId, {
      status: "indexing",
      idempotencyKey: "indexing-valid",
    });
    const completed = repositories.uploads.transitionItemForTenant(
      TENANT_A,
      itemId,
      {
        status: "completed",
        idempotencyKey: "completed-valid",
      },
    );
    expect(completed.finishedAt).not.toBeNull();
    expect(() =>
      repositories.uploads.transitionItemForTenant(TENANT_A, itemId, {
        status: "failed",
        idempotencyKey: "terminal-reopen",
        errorMessage: "cannot reopen",
      }),
    ).toThrow(ConflictError);

    expect(() =>
      repositories.uploads.transitionBatchForTenant(
        TENANT_A,
        created.batchId,
        {
          status: "completed",
          idempotencyKey: "batch-invalid-jump",
        },
      ),
    ).toThrow(ConflictError);
    repositories.uploads.transitionBatchForTenant(
      TENANT_A,
      created.batchId,
      {
        status: "identifying",
        idempotencyKey: "batch-identify",
      },
    );
    repositories.uploads.transitionBatchForTenant(
      TENANT_A,
      created.batchId,
      {
        status: "routing",
        idempotencyKey: "batch-routing",
      },
    );
    repositories.uploads.transitionBatchForTenant(
      TENANT_A,
      created.batchId,
      {
        status: "indexing",
        idempotencyKey: "batch-indexing",
      },
    );
    const completedBatch =
      repositories.uploads.transitionBatchForTenant(
        TENANT_A,
        created.batchId,
        {
          status: "completed",
          idempotencyKey: "batch-completed",
        },
      );
    expect(completedBatch.finishedAt).not.toBeNull();
  });

  it("rolls back failed mutations and keeps SQL-level safety constraints active", () => {
    setup();
    const projectA = createProject(TENANT_A, "project-a");
    const projectB = createProject(TENANT_B, "project-b");
    insertJob("sql-guard-job-b", TENANT_B, projectB);
    const created = createBatch(TENANT_A, "sql-guards").batch;
    const itemId = created.items[0]!.itemId;

    const before = repositories.uploads.listAuditForTenant(TENANT_A).total;
    expect(() =>
      repositories.uploads.transitionItemForTenant(TENANT_A, itemId, {
        status: "routing",
        idempotencyKey: "missing-identifying-step",
        targetProjectId: projectA,
      }),
    ).toThrow(ConflictError);
    expect(
      repositories.uploads.listAuditForTenant(TENANT_A).total,
    ).toBe(before);
    expect(
      repositories.uploads.getItemForTenant(TENANT_A, itemId).status,
    ).toBe("uploaded");

    expect(() =>
      database!
        .prepare(
          `UPDATE upload_items
           SET target_project_id = ?
           WHERE id = ?`,
        )
        .run(projectB, itemId),
    ).toThrow(/upload_project_tenant_mismatch/u);
    expect(() =>
      database!
        .prepare(
          `UPDATE upload_items
           SET candidate_projects_json = ?
           WHERE id = ?`,
        )
        .run(
          JSON.stringify([
            {
              projectId: projectB,
              projectName: "Cross tenant",
              companyName: null,
              ticker: null,
              score: 1,
              method: "unsafe",
            },
          ]),
          itemId,
        ),
    ).toThrow(/upload_candidate_project_tenant_mismatch/u);
    expect(() =>
      database!
        .prepare(
          `UPDATE upload_items
           SET target_project_id = ?,
               pipeline_job_id = ?
           WHERE id = ?`,
        )
        .run(projectA, "sql-guard-job-b", itemId),
    ).toThrow(/upload_job_scope_mismatch/u);
    expect(
      repositories.uploads.getItemForTenant(TENANT_A, itemId),
    ).toMatchObject({
      targetProjectId: null,
      pipelineJobId: null,
      candidateProjects: [],
    });
    expect(() =>
      database!
        .prepare(
          `UPDATE upload_items
           SET staged_relative_path = '/tmp/leak.pdf'
           WHERE id = ?`,
        )
        .run(itemId),
    ).toThrow(/upload_item_file_identity_is_immutable/u);
    expect(() =>
      database!
        .prepare(
          `UPDATE upload_items
           SET status = 'completed',
               target_project_id = ?,
               finished_at = ?
           WHERE id = ?`,
        )
        .run(projectA, "2026-07-31T02:00:00.000Z", itemId),
    ).toThrow(/invalid_upload_item_status_transition/u);

    const audit = repositories.uploads.listAuditForTenant(TENANT_A)
      .items[0]!;
    expect(() =>
      database!
        .prepare(
          `UPDATE upload_audit_events
           SET details_json = '{}'
           WHERE id = ?`,
        )
        .run(audit.auditId),
    ).toThrow(/upload_audit_event_is_immutable/u);
  });
});
