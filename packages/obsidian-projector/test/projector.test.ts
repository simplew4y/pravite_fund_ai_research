import { DatabaseSync } from "node:sqlite";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ObsidianRepository,
  runWorkflowStoreMigrations,
  type ObsidianOutboxEvent,
} from "@private-fund/workflow-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MANAGED_BEGIN,
  ProjectionCrashSimulationError,
  USER_END,
  ObsidianProjector,
  type ObsidianProjectionNote,
  type ObsidianProjectionRenderer,
} from "../src/index.js";

describe("ObsidianProjector", () => {
  let database: DatabaseSync;
  let repository: ObsidianRepository;
  let projectRoot: string;
  let temporaryRoot: string;
  let now: Date;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "obsidian-projector-"),
    );
    projectRoot = path.join(temporaryRoot, "tenant-a-project-a");
    await mkdir(projectRoot);
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys=ON");
    runWorkflowStoreMigrations(database);
    now = new Date("2026-07-31T01:00:00.000Z");
    repository = new ObsidianRepository(database, {
      clock: () => new Date(now),
      retryDelaysMs: [0],
    });
  });

  afterEach(async () => {
    database.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  function note(
    body: string,
    overrides: Partial<ObsidianProjectionNote> = {},
  ): ObsidianProjectionNote {
    return {
      relativePath: "memos/company-a.md",
      title: "Company A memo",
      body,
      evidence: [
        {
          evidenceId: "fact:zeta",
          relation: "supports",
          label: "Zeta",
        },
        {
          evidenceId: "chunk:alpha",
          relation: "context",
          label: "Alpha",
        },
        {
          evidenceId: "fact:zeta",
          relation: "supports",
          label: "Zeta",
        },
      ],
      metadata: {
        as_of_date: "2026-07-31",
        confidence: 0.9,
      },
      ...overrides,
    };
  }

  function rendererFor(
    factory: (event: ObsidianOutboxEvent) => ObsidianProjectionNote = () =>
      note("## Conclusion\n\nRevenue quality improved."),
  ): ObsidianProjectionRenderer {
    return ({ event }) => ({ notes: [factory(event)] });
  }

  function projector(
    renderer: ObsidianProjectionRenderer = rendererFor(),
    overrides: Partial<ConstructorParameters<typeof ObsidianProjector>[0]> = {},
  ): ObsidianProjector {
    return new ObsidianProjector({
      repository,
      binding: {
        tenantId: "tenant-a",
        projectId: "project-a",
        datasetId: "dataset-a",
        projectRoot,
      },
      renderer,
      managedRootRelative: "vault/投研知识库",
      ...overrides,
    });
  }

  function enqueue(
    sourceVersion: string,
    eventType = "upsert",
  ): ObsidianOutboxEvent {
    return repository.enqueue({
      datasetId: "dataset-a",
      entityType: "memo-series",
      entityId: "memo-a",
      sourceVersion,
      eventType,
    });
  }

  function targetPath(): string {
    return path.join(
      projectRoot,
      "vault",
      "投研知识库",
      "memos",
      "company-a.md",
    );
  }

  it("writes deterministic provenance and evidence then commits registry and event", async () => {
    const event = enqueue("1");

    const delivery = await projector().processNext();

    expect(delivery).toMatchObject({
      eventId: event.eventId,
      status: "completed",
      written: 1,
      unchanged: 0,
      archived: 0,
      paths: ["vault/投研知识库/memos/company-a.md"],
    });
    const content = await readFile(targetPath(), "utf8");
    expect(content).toContain('dataset_id: "dataset-a"');
    expect(content).toContain('project_id: "project-a"');
    expect(content).toContain('tenant_id: "tenant-a"');
    expect(content).toContain(`projection_event_id: "${event.eventId}"`);
    expect(content).toContain('projection_event_type: "upsert"');
    expect(content).toContain(
      'registry_path: "vault/投研知识库/memos/company-a.md"',
    );
    expect(content).toContain(
      'source_system: "private-fund-control-plane"',
    );
    expect(content).toContain('source_version: "1"');
    expect(content).toContain(MANAGED_BEGIN);
    expect(content).toContain(
      "- `chunk:alpha` — context — Alpha\n- `fact:zeta` — supports — Zeta",
    );
    expect(content.indexOf("as_of_date:")).toBeLessThan(
      content.indexOf("confidence:"),
    );
    const registry = repository.findRegistryByPath(
      "vault/投研知识库/memos/company-a.md",
    );
    expect(registry).toMatchObject({
      datasetId: "dataset-a",
      entityType: "memo-series",
      entityId: "memo-a",
      sourceVersion: "1",
      syncStatus: "synced",
    });
    expect(repository.getEvent(event.eventId)).toMatchObject({
      status: "completed",
      result: {
        archived: 0,
        paths: ["vault/投研知识库/memos/company-a.md"],
        unchanged: 0,
        written: 1,
      },
    });
  });

  it("retries transient rendering failures and then completes idempotently", async () => {
    enqueue("1");
    let calls = 0;
    const renderer: ObsidianProjectionRenderer = ({ event }) => {
      calls += 1;
      if (calls === 1) {
        throw new Error("source database is temporarily busy");
      }
      return { notes: [note(`event ${event.eventId}`)] };
    };
    const worker = projector(renderer);

    expect(await worker.processNext()).toMatchObject({
      status: "queued",
      error: expect.stringMatching(/temporarily busy/i),
    });
    expect(await worker.processNext()).toMatchObject({
      status: "completed",
      written: 1,
    });
    expect(repository.listEvents({ datasetId: "dataset-a" }).items[0])
      .toMatchObject({
        status: "completed",
        attemptCount: 2,
      });
  });

  it("adopts an exact crash artifact after lease recovery without rewriting it", async () => {
    const event = enqueue("1");
    let crashed = false;
    const crashing = projector(rendererFor(), {
      lifecycle: {
        afterAtomicRename: () => {
          if (!crashed) {
            crashed = true;
            throw new ProjectionCrashSimulationError(
              "crash after file fsync and rename",
            );
          }
        },
      },
    });

    await expect(crashing.processNext()).rejects.toThrow(
      /crash after file fsync/i,
    );
    const crashContent = await readFile(targetPath(), "utf8");
    expect(repository.getEvent(event.eventId).status).toBe("running");
    expect(
      repository.listRegistry({ datasetId: "dataset-a" }).total,
    ).toBe(0);

    now = new Date("2026-07-31T01:10:00.000Z");
    expect(
      repository.recoverStaleEvents({
        datasetId: "dataset-a",
        staleBefore: "2026-07-31T01:09:00.000Z",
        availableAt: now.toISOString(),
      }),
    ).toBe(1);
    expect(await projector().processNext()).toMatchObject({
      status: "completed",
      written: 0,
      unchanged: 1,
    });
    expect(await readFile(targetPath(), "utf8")).toBe(crashContent);
    expect(
      repository.findRegistryByPath(
        "vault/投研知识库/memos/company-a.md",
      ),
    ).toMatchObject({ sourceVersion: "1", syncStatus: "synced" });
  });

  it("blocks the stale lease at the pre-rename fence", async () => {
    const event = enqueue("1");
    let replacementLease = "";
    const staleWorker = projector(rendererFor(), {
      lifecycle: {
        beforeAtomicRename: () => {
          expect(
            repository.recoverStaleEvents({
              datasetId: "dataset-a",
              staleBefore: "2026-07-31T01:01:00.000Z",
              availableAt: now.toISOString(),
            }),
          ).toBe(1);
          replacementLease =
            repository.claimNext({ datasetId: "dataset-a" })?.leaseToken ?? "";
        },
      },
    });

    expect(await staleWorker.processNext()).toMatchObject({
      eventId: event.eventId,
      status: "stale",
    });
    await expect(readFile(targetPath(), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(replacementLease).not.toBe("");
    expect(repository.getEvent(event.eventId)).toMatchObject({
      status: "running",
      leaseToken: replacementLease,
      attemptCount: 2,
    });
  });

  it("fences the final registry commit when a lease is stolen after rename", async () => {
    const event = enqueue("1");
    let replacementLease = "";
    let injected = false;
    const staleWorker = projector(rendererFor(), {
      lifecycle: {
        beforeDatabaseCommit: () => {
          if (injected) {
            return;
          }
          injected = true;
          expect(
            repository.recoverStaleEvents({
              datasetId: "dataset-a",
              staleBefore: "2026-07-31T01:01:00.000Z",
              availableAt: now.toISOString(),
            }),
          ).toBe(1);
          replacementLease =
            repository.claimNext({ datasetId: "dataset-a" })?.leaseToken ?? "";
        },
      },
    });

    expect(await staleWorker.processNext()).toMatchObject({
      eventId: event.eventId,
      status: "stale",
    });
    expect(await readFile(targetPath(), "utf8")).toContain(
      `projection_event_id: "${event.eventId}"`,
    );
    expect(
      repository.listRegistry({ datasetId: "dataset-a" }).total,
    ).toBe(0);
    expect(repository.getEvent(event.eventId)).toMatchObject({
      status: "running",
      leaseToken: replacementLease,
    });

    now = new Date("2026-07-31T01:02:00.000Z");
    expect(
      repository.recoverStaleEvents({
        datasetId: "dataset-a",
        staleBefore: "2026-07-31T01:01:00.000Z",
        availableAt: now.toISOString(),
      }),
    ).toBe(1);
    expect(await projector().processNext()).toMatchObject({
      status: "completed",
      written: 0,
      unchanged: 1,
    });
  });

  it("rejects traversal and never writes outside the bound project", async () => {
    enqueue("1");
    const outside = path.join(temporaryRoot, "escaped.md");

    expect(
      await projector(
        rendererFor(() =>
          note("escape", { relativePath: "../../../escaped.md" }),
        ),
      ).processNext(),
    ).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/relative POSIX path|unsafe path segment/i),
    });
    await expect(readFile(outside, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a symlink in the managed directory chain", async () => {
    const outside = path.join(temporaryRoot, "other-project");
    await mkdir(outside);
    await symlink(outside, path.join(projectRoot, "vault"));
    enqueue("1");

    expect(await projector().processNext()).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/symlink/i),
    });
    await expect(
      readFile(path.join(outside, "投研知识库", "memos", "company-a.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlink at the final note target", async () => {
    const outside = path.join(temporaryRoot, "other-project-note.md");
    await writeFile(outside, "# Other project\n", "utf8");
    await mkdir(path.dirname(targetPath()), { recursive: true });
    await symlink(outside, targetPath());
    enqueue("1");

    expect(await projector().processNext()).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/symbolic link/i),
    });
    expect(await readFile(outside, "utf8")).toBe("# Other project\n");
  });

  it("refuses to overwrite an unregistered external file", async () => {
    await mkdir(path.dirname(targetPath()), { recursive: true });
    await writeFile(targetPath(), "# Analyst-owned note\n", "utf8");
    enqueue("1");

    expect(await projector().processNext()).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/frontmatter|unregistered/i),
    });
    expect(await readFile(targetPath(), "utf8")).toBe(
      "# Analyst-owned note\n",
    );
  });

  it("preserves analyst blocks but detects external managed-region rewrites", async () => {
    enqueue("1");
    await projector().processNext();
    const initial = await readFile(targetPath(), "utf8");
    await writeFile(
      targetPath(),
      initial.replace(
        "This section is owned by analysts",
        "Long-term view: margins still need quarterly validation.\n>\n> This section is owned by analysts",
      ),
      "utf8",
    );
    enqueue("2");
    expect(
      await projector(
        rendererFor(() => note("## Conclusion\n\nVersion two.")),
      ).processNext(),
    ).toMatchObject({ status: "completed", written: 1 });
    const versionTwo = await readFile(targetPath(), "utf8");
    expect(versionTwo).toContain(
      "Long-term view: margins still need quarterly validation.",
    );

    const externallyChanged = versionTwo.replace(
      "## Conclusion",
      "## Externally rewritten conclusion",
    );
    await writeFile(targetPath(), externallyChanged, "utf8");
    enqueue("3");
    expect(
      await projector(
        rendererFor(() => note("## Conclusion\n\nVersion three.")),
      ).processNext(),
    ).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/externally modified/i),
    });
    expect(await readFile(targetPath(), "utf8")).toBe(externallyChanged);
  });

  it("will not replace a registry identity rooted outside its managed namespace", async () => {
    repository.upsertRegistry({
      datasetId: "dataset-a",
      entityType: "memo-series",
      entityId: "memo-a",
      sourceVersion: "legacy",
      notePath: "legacy-vault/company-a.md",
      contentHash: "legacy-content",
      managedHash: "legacy-managed",
      syncStatus: "synced",
    });
    enqueue("1");

    expect(await projector().processNext()).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/outside the configured managed root/i),
    });
    expect(
      repository.findRegistryByPath("legacy-vault/company-a.md"),
    ).toMatchObject({ sourceVersion: "legacy" });
    await expect(readFile(targetPath(), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("archives prior content and writes a tombstone instead of deleting", async () => {
    enqueue("1");
    await projector().processNext();
    const original = await readFile(targetPath(), "utf8");
    const tombstone = enqueue("2", "tombstone");

    expect(
      await projector(
        rendererFor(() =>
          note("Superseded by the authoritative database.", {
            disposition: "tombstone",
          }),
        ),
      ).processNext(),
    ).toMatchObject({
      status: "completed",
      written: 1,
      archived: 1,
    });
    const archive = path.join(
      projectRoot,
      "vault",
      "投研知识库",
      "_archive",
      "memos",
      "company-a",
      `${tombstone.eventId}.md`,
    );
    expect(await readFile(archive, "utf8")).toBe(original);
    const tombstoneContent = await readFile(targetPath(), "utf8");
    expect(tombstoneContent).toContain("Archived projection");
    expect(tombstoneContent).toContain(
      `archived_path: "vault/投研知识库/_archive/memos/company-a/${tombstone.eventId}.md"`,
    );
    expect(tombstoneContent.trimEnd().endsWith(USER_END)).toBe(true);
  });

  it("forces delete events through tombstone archival even when omitted by the renderer", async () => {
    enqueue("1");
    await projector().processNext();
    const original = await readFile(targetPath(), "utf8");
    const deleted = enqueue("2", "delete");

    expect(
      await projector(
        rendererFor(() => note("Removed from the active knowledge view.")),
      ).processNext(),
    ).toMatchObject({
      status: "completed",
      written: 1,
      archived: 1,
    });
    expect(await readFile(targetPath(), "utf8")).toContain(
      'disposition: "tombstone"',
    );
    expect(
      await readFile(
        path.join(
          projectRoot,
          "vault",
          "投研知识库",
          "_archive",
          "memos",
          "company-a",
          `${deleted.eventId}.md`,
        ),
        "utf8",
      ),
    ).toBe(original);
  });

  it("does not claim another dataset's event", async () => {
    repository.enqueue({
      datasetId: "dataset-b",
      entityType: "memo-series",
      entityId: "memo-b",
      sourceVersion: "1",
    });

    expect(await projector().processNext()).toBeNull();
    expect(repository.listEvents({ datasetId: "dataset-b" }).items[0])
      .toMatchObject({ status: "queued", attemptCount: 0 });
  });
});
