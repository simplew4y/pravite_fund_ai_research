import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  openProjectDatabase,
} from "@private-fund/research-store";
import {
  createWorkflowStore,
  DEFAULT_OBSIDIAN_PROJECTOR_VERSION,
} from "@private-fund/workflow-store";
import { afterEach, describe, expect, it } from "vitest";

import type {
  CatalogProject,
  ObsidianProjectCatalog,
} from "../src/catalog.js";
import { ensureSecureProjectRoot } from "../src/project-path.js";
import {
  ObsidianOutboxRunner,
  type ObsidianOutboxRunnerOptions,
  type RunnerEvent,
} from "../src/runner.js";

const PROJECT: CatalogProject = {
  tenantId: "tenant-a",
  tenantNamespace: "00000000-0000-4000-8000-000000000001",
  projectId: "project-a",
  datasetId: "project-a",
};
const NOW = new Date("2030-07-31T08:00:00.000Z");

class StaticCatalog implements ObsidianProjectCatalog {
  public constructor(private readonly projects: readonly CatalogProject[]) {}

  public listProjects(): readonly CatalogProject[] {
    return this.projects;
  }
}

function options(
  dataRoot: string,
  events: RunnerEvent[] = [],
): ObsidianOutboxRunnerOptions {
  return {
    dataRoot,
    catalog: new StaticCatalog([PROJECT]),
    managedRootRelative: "obsidian/managed",
    projectorVersion: DEFAULT_OBSIDIAN_PROJECTOR_VERSION,
    pollIntervalMs: 10,
    reconcileIntervalMs: 60_000,
    staleLeaseMs: 60_000,
    maxDrainEvents: 20,
    maxAttempts: 4,
    maxNoteBytes: 8 * 1024 * 1024,
    clock: () => new Date(NOW),
    onEvent: (event) => {
      events.push(event);
    },
  };
}

async function seedMemo(
  dataRoot: string,
  staleRunning: boolean,
): Promise<string> {
  const projectRoot = await ensureSecureProjectRoot(dataRoot, PROJECT);
  const database = openProjectDatabase({
    projectRoot,
    databasePath: path.join("data", "research.sqlite3"),
  });
  try {
    const store = createWorkflowStore(database.connection, {
      clock: () => new Date(NOW),
    });
    const memo = store.tracking.saveMemoVersion({
      datasetId: PROJECT.datasetId,
      topic: "Runner integration",
      title: "Runner integration memo",
      asOfDate: "2030-07-31",
      sourceType: "test",
      contentHash: "runner-memo-hash",
      sections: [
        {
          sectionKey: "conclusion",
          title: "Conclusion",
          content: "The durable outbox runner recovered this projection.",
          evidenceIds: ["fact:runner"],
        },
      ],
    }).record;
    store.obsidian.reconcileDataset(PROJECT.datasetId);
    const event = store.obsidian.listEvents({
      datasetId: PROJECT.datasetId,
      entityType: "memo-series",
    }).items[0];
    if (event === undefined) {
      throw new Error("Memo reconciliation did not create an event");
    }
    if (staleRunning) {
      const claimed = store.obsidian.claimNext({
        datasetId: PROJECT.datasetId,
        availableAt: NOW.toISOString(),
      });
      if (claimed === null) {
        throw new Error("Memo event was not claimable");
      }
      database.connection
        .prepare(
          `UPDATE obsidian_sync_outbox
           SET locked_at='2030-07-31T00:00:00.000Z'
           WHERE event_id=?`,
        )
        .run(claimed.eventId);
    }
    return memo.seriesId;
  } finally {
    database.close();
  }
}

async function managedMarkdown(projectRoot: string): Promise<string> {
  const directory = path.join(projectRoot, "obsidian", "managed", "memos");
  const files = await readdir(directory);
  const markdown = files.find((file) => file.endsWith(".md"));
  if (markdown === undefined) {
    throw new Error("No managed Memo markdown was written");
  }
  return readFile(path.join(directory, markdown), "utf8");
}

describe("ObsidianOutboxRunner", () => {
  const temporaryRoots: string[] = [];
  const runners: ObsidianOutboxRunner[] = [];

  afterEach(async () => {
    for (const runner of runners) {
      runner.close();
    }
    for (const root of temporaryRoots) {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function temporaryRoot(): Promise<string> {
    const value = await mkdtemp(
      path.join(os.tmpdir(), "obsidian-worker-"),
    );
    temporaryRoots.push(value);
    return value;
  }

  it("recovers stale leases, reconciles, drains, and exposes projection health", async () => {
    const dataRoot = await temporaryRoot();
    await seedMemo(dataRoot, true);
    const events: RunnerEvent[] = [];
    const runner = new ObsidianOutboxRunner(options(dataRoot, events));
    runners.push(runner);

    const health = await runner.cycle();
    const projectRoot = await ensureSecureProjectRoot(dataRoot, PROJECT);

    expect(health.status).toBe("ready");
    expect(health.totals).toMatchObject({
      recovered: 1,
      processed: 1,
      completed: 1,
      failed: 0,
      written: 1,
    });
    expect(health.projects[0]?.projection.events.completed).toBe(1);
    expect(await managedMarkdown(projectRoot)).toContain(
      "The durable outbox runner recovered this projection.",
    );
    expect(events.map((event) => event.event)).toContain(
      "project_cycle_completed",
    );
  });

  it("marks unsupported events failed and degraded instead of swallowing them", async () => {
    const dataRoot = await temporaryRoot();
    const projectRoot = await ensureSecureProjectRoot(dataRoot, PROJECT);
    const database = openProjectDatabase({
      projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
    });
    try {
      const store = createWorkflowStore(database.connection, {
        clock: () => new Date(NOW),
      });
      store.obsidian.enqueue({
        datasetId: PROJECT.datasetId,
        entityType: "unsupported-object",
        entityId: "object-a",
        sourceVersion: "1",
      });
    } finally {
      database.close();
    }
    const runner = new ObsidianOutboxRunner(options(dataRoot));
    runners.push(runner);

    const health = await runner.cycle();

    expect(health.status).toBe("degraded");
    expect(health.totals.failed).toBe(1);
    expect(health.projects[0]?.projection.events.failed).toBe(1);
    expect(health.projects[0]?.error).toMatch(/terminal projection/u);
  });

  it("rejects a symlink tenant boundary before opening research.sqlite3", async () => {
    const dataRoot = await temporaryRoot();
    const outside = await temporaryRoot();
    await mkdir(path.join(dataRoot, "users"), { recursive: true });
    await symlink(
      outside,
      path.join(dataRoot, "users", PROJECT.tenantNamespace),
    );
    const runner = new ObsidianOutboxRunner(options(dataRoot));
    runners.push(runner);

    const health = await runner.cycle();

    expect(health.status).toBe("degraded");
    expect(health.projects[0]?.error).toMatch(/symbolic-link/u);
    await expect(
      readFile(path.join(outside, "data", "research.sqlite3")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("closes project databases and reaches stopped after abort", async () => {
    const dataRoot = await temporaryRoot();
    await seedMemo(dataRoot, false);
    const abort = new AbortController();
    const runEvents: RunnerEvent[] = [];
    const runnerOptions = options(dataRoot, runEvents);
    const runner = new ObsidianOutboxRunner({
      ...runnerOptions,
      onEvent: (event) => {
        runEvents.push(event);
        if (event.event === "cycle_completed") {
          abort.abort();
        }
      },
    });
    runners.push(runner);

    await runner.run(abort.signal);

    expect(runner.health().status).toBe("stopped");
    expect(runEvents.at(-1)?.event).toBe("runner_stopped");
    await expect(runner.cycle()).rejects.toThrow(/closed/u);
  });
});
