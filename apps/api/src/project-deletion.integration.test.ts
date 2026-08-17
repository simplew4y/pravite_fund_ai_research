import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROJECT_TOMBSTONE_RETENTION_MILLISECONDS,
  ProjectsRepository,
  createControlRepositories,
} from "@private-fund/db";
import { DurableJobQueue } from "@private-fund/job-queue";
import { afterEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "./config.js";
import { createApiRuntime, type ApiRuntime } from "./main.js";
import { ProjectResearchStoreManager } from "./research-stores.js";

const WORKER_ENTRY = fileURLToPath(
  new URL("../test/fixtures/fake-agent-worker.mjs", import.meta.url),
);
const ALPHA_NAMESPACE = "00000000-0000-4000-8000-0000000000d1";
const BETA_NAMESPACE = "00000000-0000-4000-8000-0000000000d2";

function configFor(
  dataRoot: string,
  userId: string,
  dataNamespace: string,
): ApiConfig {
  return {
    host: "127.0.0.1",
    port: 6768,
    dataRoot,
    controlDatabase: path.join(dataRoot, "control.sqlite3"),
    auth: {
      mode: "development",
      userId,
      dataNamespace,
    },
    agentWorkerEntry: WORKER_ENTRY,
  };
}

describe("canonical project deletion", () => {
  let alpha: ApiRuntime | undefined;
  let beta: ApiRuntime | undefined;
  let dataRoot: string | undefined;

  afterEach(async () => {
    await beta?.close();
    await alpha?.close();
    if (dataRoot !== undefined) {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("tombstones without deleting files or history and fails closed across tenants and active work", async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-project-delete-"));
    alpha = await createApiRuntime(
      configFor(dataRoot, "project-delete-alpha", ALPHA_NAMESPACE),
    );
    beta = await createApiRuntime(
      configFor(dataRoot, "project-delete-beta", BETA_NAMESPACE),
    );

    const alphaProjectResponse = await alpha.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: {
        name: "Recoverable project",
        companyName: "Recoverable Co.",
        ticker: "RCV",
      },
    });
    expect(
      alphaProjectResponse.statusCode,
      alphaProjectResponse.body,
    ).toBe(201);
    const alphaProject = alphaProjectResponse.json<{ id: string }>();

    const betaProjectResponse = await beta.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Unrelated tenant project" },
    });
    expect(betaProjectResponse.statusCode, betaProjectResponse.body).toBe(201);
    const betaProject = betaProjectResponse.json<{ id: string }>();

    const projectRoot = path.join(
      dataRoot,
      "users",
      ALPHA_NAMESPACE,
      "projects",
      alphaProject.id,
    );
    const sentinelPath = path.join(projectRoot, "sources", "sentinel.txt");
    const sentinelContents =
      "project data and historical Evidence must survive tombstoning";
    await mkdir(path.dirname(sentinelPath), { recursive: true });
    await writeFile(sentinelPath, sentinelContents, "utf8");

    const seeder = new ProjectResearchStoreManager();
    const research = seeder.get(projectRoot);
    const document = research.documents.registerVersion({
      logicalKey: "project-delete-sentinel",
      sourceRoot: "upload",
      sourceRelpath: "sentinel.txt",
      title: "Deletion sentinel",
      originalFilename: "sentinel.txt",
      storedPath: path.relative(projectRoot, sentinelPath),
      fileType: "txt",
      mimeType: "text/plain",
      sha256: createHash("sha256")
        .update(sentinelContents)
        .digest("hex"),
      fileSize: Buffer.byteLength(sentinelContents),
      status: "indexed",
      activate: true,
    });
    const evidence = research.evidence.put({
      evidenceId: "chunk:project-delete-sentinel",
      kind: "chunk",
      documentVersionId: document.version.id,
      title: "Historical deletion evidence",
      originalText: sentinelContents,
      locator: {
        pageStart: 1,
        headingPath: "Deletion retention proof",
      },
    }).evidence;
    seeder.close();

    const beforeDeleteEvidence = await alpha.app.inject({
      method: "GET",
      url:
        `/v1/projects/${alphaProject.id}/evidence/` +
        encodeURIComponent(evidence.evidenceId),
    });
    expect(
      beforeDeleteEvidence.statusCode,
      beforeDeleteEvidence.body,
    ).toBe(200);

    const sessionResponse = await alpha.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        projectId: alphaProject.id,
        title: "Retained audit session",
      },
    });
    expect(sessionResponse.statusCode, sessionResponse.body).toBe(201);
    const session = sessionResponse.json<{ id: string }>();

    const repositories = createControlRepositories(alpha.database);
    const operation = repositories.operations.createForTenant(
      ALPHA_NAMESPACE,
      {
        sessionId: session.id,
        kind: "audit.completed",
        idempotencyKey: "retained-completed-operation",
        request: { purpose: "prove project deletion retains audit history" },
      },
    ).operation;
    repositories.operations.markRunningForTenant(
      ALPHA_NAMESPACE,
      operation.id,
    );
    repositories.operations.completeForTenant(
      ALPHA_NAMESPACE,
      operation.id,
      { retained: true },
    );

    const crossTenantDelete = await beta.app.inject({
      method: "DELETE",
      url: `/v1/projects/${alphaProject.id}`,
    });
    expect(crossTenantDelete.statusCode, crossTenantDelete.body).toBe(404);
    expect(crossTenantDelete.json()).toMatchObject({ error: "not_found" });
    expect(
      (
        await alpha.app.inject({
          method: "GET",
          url: `/v1/projects/${alphaProject.id}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await beta.app.inject({
          method: "GET",
          url: `/v1/projects/${betaProject.id}`,
        })
      ).statusCode,
    ).toBe(200);

    const activeSessionDelete = await alpha.app.inject({
      method: "DELETE",
      url: `/v1/projects/${alphaProject.id}`,
    });
    expect(
      activeSessionDelete.statusCode,
      activeSessionDelete.body,
    ).toBe(409);
    expect(activeSessionDelete.json()).toMatchObject({
      error: "project_has_active_sessions",
    });

    const archiveSession = await alpha.app.inject({
      method: "PATCH",
      url: `/v1/sessions/${session.id}`,
      payload: { archived: true },
    });
    expect(archiveSession.statusCode, archiveSession.body).toBe(200);

    const enqueueResponse = await alpha.app.inject({
      method: "POST",
      url: "/v1/jobs",
      payload: {
        projectId: alphaProject.id,
        type: "market.refresh",
        payload: { source: "project-delete-test" },
        idempotencyKey: "retained-completed-job",
        maxAttempts: 1,
      },
    });
    expect(enqueueResponse.statusCode, enqueueResponse.body).toBe(201);
    const enqueued = enqueueResponse.json<{
      job: { id: string; status: string };
    }>().job;
    expect(enqueued.status).toBe("queued");

    const queuedJobDelete = await alpha.app.inject({
      method: "DELETE",
      url: `/v1/projects/${alphaProject.id}`,
    });
    expect(queuedJobDelete.statusCode, queuedJobDelete.body).toBe(409);
    expect(queuedJobDelete.json()).toMatchObject({
      error: "project_has_active_jobs",
    });

    const queue = new DurableJobQueue(alpha.database);
    const claimed = queue.claim({
      workerId: "project-delete-worker",
      leaseDurationMs: 60_000,
      types: ["market.refresh"],
    });
    expect(claimed?.id).toBe(enqueued.id);

    const runningJobDelete = await alpha.app.inject({
      method: "DELETE",
      url: `/v1/projects/${alphaProject.id}`,
    });
    expect(runningJobDelete.statusCode, runningJobDelete.body).toBe(409);
    expect(runningJobDelete.json()).toMatchObject({
      error: "project_has_active_jobs",
    });

    queue.complete({
      jobId: enqueued.id,
      workerId: "project-delete-worker",
      result: { retained: true },
    });

    const deleteResponse = await alpha.app.inject({
      method: "DELETE",
      url: `/v1/projects/${alphaProject.id}`,
    });
    expect(deleteResponse.statusCode, deleteResponse.body).toBe(204);

    const repeatedDelete = await alpha.app.inject({
      method: "DELETE",
      url: `/v1/projects/${alphaProject.id}`,
    });
    expect(repeatedDelete.statusCode, repeatedDelete.body).toBe(404);
    expect(repeatedDelete.json()).toMatchObject({ error: "not_found" });

    const projectGet = await alpha.app.inject({
      method: "GET",
      url: `/v1/projects/${alphaProject.id}`,
    });
    expect(projectGet.statusCode, projectGet.body).toBe(404);
    const projectList = await alpha.app.inject({
      method: "GET",
      url: "/v1/projects",
    });
    expect(
      projectList
        .json<{ projects: Array<{ id: string }> }>()
        .projects.map((project) => project.id),
    ).not.toContain(alphaProject.id);

    const sessionGet = await alpha.app.inject({
      method: "GET",
      url: `/v1/sessions/${session.id}`,
    });
    expect(sessionGet.statusCode, sessionGet.body).toBe(404);
    const sessionEvents = await alpha.app.inject({
      method: "GET",
      url: `/v1/sessions/${session.id}/events?stream=0`,
    });
    expect(sessionEvents.statusCode, sessionEvents.body).toBe(404);
    const sessionList = await alpha.app.inject({
      method: "GET",
      url:
        "/v1/sessions?includeArchived=true&projectId=" +
        encodeURIComponent(alphaProject.id),
    });
    expect(sessionList.statusCode, sessionList.body).toBe(200);
    expect(sessionList.json()).toEqual({ sessions: [] });

    const hiddenEvidence = await alpha.app.inject({
      method: "GET",
      url:
        `/v1/projects/${alphaProject.id}/evidence/` +
        encodeURIComponent(evidence.evidenceId),
    });
    expect(hiddenEvidence.statusCode, hiddenEvidence.body).toBe(404);

    const retainedJob = await alpha.app.inject({
      method: "GET",
      url: `/v1/jobs/${enqueued.id}`,
    });
    expect(retainedJob.statusCode, retainedJob.body).toBe(200);
    expect(retainedJob.json()).toMatchObject({
      id: enqueued.id,
      projectId: alphaProject.id,
      status: "completed",
      result: { retained: true },
    });

    const tombstone = alpha.database
      .prepare(
        `SELECT deleted_at AS deletedAt, retained_until AS retainedUntil
         FROM projects
         WHERE id = ?`,
      )
      .get(alphaProject.id) as
      | { deletedAt: string; retainedUntil: string }
      | undefined;
    expect(tombstone).toBeDefined();
    expect(tombstone?.deletedAt).toEqual(expect.any(String));
    expect(tombstone?.retainedUntil).toEqual(expect.any(String));
    expect(
      new Date(tombstone?.retainedUntil ?? "").getTime() -
        new Date(tombstone?.deletedAt ?? "").getTime(),
    ).toBe(PROJECT_TOMBSTONE_RETENTION_MILLISECONDS);

    const retainedCounts = alpha.database
      .prepare(
        `SELECT
           (SELECT count(*) FROM sessions WHERE project_id = ?) AS sessions,
           (
             SELECT count(*)
             FROM session_events AS e
             JOIN sessions AS s ON s.id = e.session_id
             WHERE s.project_id = ?
           ) AS events,
           (
             SELECT count(*)
             FROM operations AS o
             JOIN sessions AS s ON s.id = o.session_id
             WHERE s.project_id = ?
           ) AS operations,
           (SELECT count(*) FROM jobs WHERE project_id = ?) AS jobs`,
      )
      .get(
        alphaProject.id,
        alphaProject.id,
        alphaProject.id,
        alphaProject.id,
      ) as Record<string, number> | undefined;
    expect(retainedCounts).toMatchObject({
      sessions: 1,
      operations: 1,
      jobs: 1,
    });
    expect(retainedCounts?.events).toBeGreaterThanOrEqual(2);

    expect(await readFile(sentinelPath, "utf8")).toBe(sentinelContents);
    const retainedResearch = new ProjectResearchStoreManager();
    expect(
      retainedResearch
        .get(projectRoot)
        .evidence.trace(evidence.evidenceId)
        .originalText,
    ).toBe(sentinelContents);
    retainedResearch.close();

    expect(() =>
      alpha?.database
        .prepare("DELETE FROM projects WHERE id = ?")
        .run(alphaProject.id),
    ).toThrow(/project_physical_delete_forbidden/);
    expect(
      (
        await beta.app.inject({
          method: "GET",
          url: `/v1/projects/${betaProject.id}`,
        })
      ).statusCode,
    ).toBe(200);

    const projects = new ProjectsRepository(alpha.database);
    const restored = projects.restoreForTenant(
      ALPHA_NAMESPACE,
      alphaProject.id,
    );
    expect(restored.deletedAt).toBeNull();
    expect(restored.retainedUntil).toBeNull();
    expect(
      projects
        .listLifecycleEventsForTenant(
          ALPHA_NAMESPACE,
          alphaProject.id,
        )
        .map((event) => event.action),
    ).toEqual(["tombstoned", "restored"]);

    expect(
      (
        await alpha.app.inject({
          method: "GET",
          url: `/v1/projects/${alphaProject.id}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await alpha.app.inject({
          method: "GET",
          url: `/v1/sessions/${session.id}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await alpha.app.inject({
          method: "GET",
          url:
            `/v1/projects/${alphaProject.id}/evidence/` +
            encodeURIComponent(evidence.evidenceId),
        })
      ).statusCode,
    ).toBe(200);
    expect(await readFile(sentinelPath, "utf8")).toBe(sentinelContents);
  });
});
