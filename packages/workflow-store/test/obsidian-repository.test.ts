import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runWorkflowStoreMigrations } from "../src/migrations.js";
import { ObsidianRepository } from "../src/obsidian-repository.js";

describe("ObsidianRepository", () => {
  let database: DatabaseSync;
  let now: Date;
  let repository: ObsidianRepository;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys=ON");
    runWorkflowStoreMigrations(database);
    now = new Date("2026-07-30T01:00:00.000Z");
    repository = new ObsidianRepository(database, {
      clock: () => new Date(now),
      retryDelaysMs: [30_000, 120_000],
    });
  });

  afterEach(() => {
    database.close();
  });

  it("enqueues idempotently inside the caller transaction", () => {
    const event = repository.enqueue({
      datasetId: "dataset-a",
      entityType: "memo-series",
      entityId: "memo-1",
      sourceVersion: "3",
      payload: { evidenceIds: ["chunk:raw-ID"] },
    });
    const repeated = repository.enqueue({
      datasetId: "dataset-a",
      entityType: "memo-series",
      entityId: "memo-1",
      sourceVersion: "3",
      payload: { evidenceIds: ["chunk:raw-ID"] },
    });

    expect(repeated).toEqual(event);
    expect(event.status).toBe("queued");
    expect(event.payload).toEqual({ evidenceIds: ["chunk:raw-ID"] });
    expect(() =>
      repository.enqueue({
        datasetId: "dataset-a",
        entityType: "memo-series",
        entityId: "memo-1",
        sourceVersion: "3",
        payload: { changed: true },
      }),
    ).toThrow(/different payload/i);

    database.exec("BEGIN");
    repository.enqueue({
      datasetId: "dataset-a",
      entityType: "valuation-series",
      entityId: "valuation-rollback",
      sourceVersion: "1",
    });
    database.exec("ROLLBACK");
    expect(
      repository.listEvents({ entityType: "valuation-series" }).total,
    ).toBe(0);
  });

  it("reconciles durable memo and valuation series without duplicate events", () => {
    database.exec(`
      INSERT INTO research_memo_series
        (series_id, dataset_id, series_key, topic, title, current_version_no,
         created_at, updated_at)
      VALUES
        ('memo-series-1', 'dataset-a', 'memo', 'Memo', 'Memo', 2, 'now', 'now');
      INSERT INTO valuation_model_series
        (series_id, dataset_id, series_key, name, current_version_no,
         status, created_at, updated_at)
      VALUES
        ('valuation-series-1', 'dataset-a', 'valuation', 'Valuation', 3,
         'active', 'now', 'now');
    `);

    expect(repository.reconcileDataset("dataset-a")).toBe(2);
    expect(repository.reconcileDataset("dataset-a")).toBe(0);
    expect(
      repository
        .listEvents({ datasetId: "dataset-a" })
        .items.map((event) => [event.entityType, event.sourceVersion])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
    ).toEqual([
      ["memo-series", "2"],
      ["valuation-series", "3"],
    ]);
  });

  it("claims in order and completes a running event idempotently", () => {
    repository.enqueue({
      datasetId: "dataset-a",
      entityType: "memo-series",
      entityId: "later",
      sourceVersion: "1",
      availableAt: "2026-07-30T01:05:00.000Z",
    });
    const ready = repository.enqueue({
      datasetId: "dataset-a",
      entityType: "memo-series",
      entityId: "ready",
      sourceVersion: "1",
    });

    const claimed = repository.claimNext({ datasetId: "dataset-a" });
    expect(claimed).toMatchObject({
      eventId: ready.eventId,
      status: "running",
      attemptCount: 1,
      lockedAt: "2026-07-30T01:00:00.000Z",
    });
    expect(claimed?.leaseToken).toBeTypeOf("string");
    const leaseToken = claimed?.leaseToken ?? "";
    const completed = repository.completeEvent(ready.eventId, leaseToken, {
      written: 2,
      paths: ["投研知识库/Memo.md"],
    });
    expect(completed).toMatchObject({
      status: "completed",
      result: {
        written: 2,
        paths: ["投研知识库/Memo.md"],
      },
    });
    expect(
      repository.completeEvent(
        ready.eventId,
        leaseToken,
        completed.result ?? {},
      ),
    ).toEqual(completed);
    expect(() =>
      repository.completeEvent(ready.eventId, leaseToken, { written: 3 }),
    ).toThrow(/cannot be overwritten/i);
    expect(repository.claimNext({ datasetId: "dataset-a" })).toBeNull();
  });

  it("serializes deliveries for one entity while allowing unrelated work", () => {
    const first = repository.enqueue({
      datasetId: "dataset-a",
      entityType: "memo-series",
      entityId: "same-note",
      sourceVersion: "1",
    });
    now = new Date("2026-07-30T01:00:01.000Z");
    const second = repository.enqueue({
      datasetId: "dataset-a",
      entityType: "memo-series",
      entityId: "same-note",
      sourceVersion: "2",
    });
    const unrelated = repository.enqueue({
      datasetId: "dataset-a",
      entityType: "memo-series",
      entityId: "other-note",
      sourceVersion: "1",
    });

    const firstClaim = repository.claimNext({ datasetId: "dataset-a" });
    expect(firstClaim?.eventId).toBe(first.eventId);
    const unrelatedClaim = repository.claimNext({ datasetId: "dataset-a" });
    expect(unrelatedClaim?.eventId).toBe(unrelated.eventId);
    expect(
      repository
        .listEvents({ datasetId: "dataset-a" })
        .items.find((event) => event.eventId === second.eventId),
    ).toMatchObject({ status: "queued", attemptCount: 0 });

    repository.completeEvent(
      first.eventId,
      firstClaim?.leaseToken ?? "",
      { written: 1 },
    );
    repository.completeEvent(
      unrelated.eventId,
      unrelatedClaim?.leaseToken ?? "",
      { written: 1 },
    );
    expect(
      repository.claimNext({ datasetId: "dataset-a" })?.eventId,
    ).toBe(second.eventId);
  });

  it("retries with bounded backoff and becomes failed when attempts are exhausted", () => {
    const queued = repository.enqueue({
      datasetId: "dataset-a",
      entityType: "valuation-series",
      entityId: "valuation-1",
      sourceVersion: "2",
      maxAttempts: 2,
    });
    const firstClaim = repository.claimNext({ datasetId: "dataset-a" });

    const retry = repository.failEvent(
      queued.eventId,
      firstClaim?.leaseToken ?? "",
      "vault unavailable",
    );
    expect(retry).toMatchObject({
      status: "queued",
      attemptCount: 1,
      availableAt: "2026-07-30T01:00:30.000Z",
      lastError: "vault unavailable",
    });
    expect(repository.claimNext({ datasetId: "dataset-a" })).toBeNull();

    now = new Date("2026-07-30T01:00:30.000Z");
    const secondClaim = repository.claimNext({ datasetId: "dataset-a" });
    expect(secondClaim).toMatchObject({
      status: "running",
      attemptCount: 2,
    });
    const failed = repository.failEvent(
      queued.eventId,
      secondClaim?.leaseToken ?? "",
      "still unavailable",
    );
    expect(failed).toMatchObject({
      status: "failed",
      attemptCount: 2,
      finishedAt: "2026-07-30T01:00:30.000Z",
    });
    expect(() =>
      repository.failEvent(
        queued.eventId,
        secondClaim?.leaseToken ?? "",
        "again",
      ),
    ).toThrow(
      /lease is no longer owned|cannot fail from failed/i,
    );
  });

  it("recovers expired leases without exceeding the retry budget", () => {
    const retryable = repository.enqueue({
      datasetId: "dataset-a",
      entityType: "memo-series",
      entityId: "retryable",
      sourceVersion: "1",
      maxAttempts: 2,
    });
    const firstClaim = repository.claimNext({ datasetId: "dataset-a" });
    now = new Date("2026-07-30T01:10:00.000Z");
    expect(
      repository.recoverStaleEvents({
        datasetId: "dataset-a",
        staleBefore: "2026-07-30T01:05:00.000Z",
      }),
    ).toBe(1);
    expect(repository.getEvent(retryable.eventId)).toMatchObject({
      status: "queued",
      lockedAt: null,
      lastError: "worker lease expired",
    });

    const secondClaim = repository.claimNext({ datasetId: "dataset-a" });
    expect(secondClaim?.leaseToken).not.toBe(firstClaim?.leaseToken);
    expect(() =>
      repository.completeEvent(
        retryable.eventId,
        firstClaim?.leaseToken ?? "",
        { staleWorker: true },
      ),
    ).toThrow(/lease is no longer owned/i);
    now = new Date("2026-07-30T01:20:00.000Z");
    expect(
      repository.recoverStaleEvents({
        datasetId: "dataset-a",
        staleBefore: "2026-07-30T01:15:00.000Z",
      }),
    ).toBe(1);
    expect(repository.getEvent(retryable.eventId).status).toBe("failed");
  });

  it("maintains one registry source version and detects note path conflicts", () => {
    const first = repository.upsertRegistry({
      datasetId: "dataset-a",
      entityType: "memo-series",
      entityId: "memo-1",
      sourceVersion: "1",
      notePath: "投研知识库/Memo首页.md",
      contentHash: "content-v1",
      managedHash: "managed-v1",
      syncStatus: "synced",
    });
    expect(first.syncStatus).toBe("synced");

    const second = repository.upsertRegistry({
      datasetId: "dataset-a",
      entityType: "memo-series",
      entityId: "memo-1",
      sourceVersion: "2",
      notePath: "投研知识库/Memo首页.md",
      contentHash: "content-v2",
      managedHash: "managed-v2",
      syncStatus: "conflict",
      lastError: "managed region changed",
    });
    expect(second.sourceVersion).toBe("2");
    expect(
      repository.listRegistry({
        datasetId: "dataset-a",
        entityType: "memo-series",
        entityId: "memo-1",
      }).items,
    ).toEqual([second]);
    expect(
      repository.findRegistryByPath("投研知识库/Memo首页.md"),
    ).toEqual(second);

    expect(() =>
      repository.upsertRegistry({
        datasetId: "dataset-b",
        entityType: "valuation-series",
        entityId: "valuation-1",
        sourceVersion: "1",
        notePath: second.notePath,
        contentHash: "different",
        managedHash: "different",
        syncStatus: "synced",
      }),
    ).toThrow(/registered to another source/i);
    expect(() =>
      repository.findRegistryByPath("../outside.md"),
    ).toThrow(/vault-relative/i);

    const status = repository.projectionStatus("dataset-a");
    expect(status.notes).toEqual({ conflict: 1 });
  });

  it("atomically fences registry publication with outbox completion", () => {
    const event = repository.enqueue({
      datasetId: "dataset-a",
      entityType: "memo-series",
      entityId: "memo-atomic",
      sourceVersion: "1",
    });
    const claimed = repository.claimNext({ datasetId: "dataset-a" });
    repository.upsertRegistry({
      datasetId: "dataset-a",
      entityType: "other",
      entityId: "owner",
      sourceVersion: "1",
      notePath: "投研知识库/conflict.md",
      contentHash: "owner-content",
      managedHash: "owner-managed",
      syncStatus: "synced",
    });

    expect(() =>
      repository.completeProjection(
        event.eventId,
        claimed?.leaseToken ?? "",
        {
          registryEntries: [
            {
              datasetId: "dataset-a",
              entityType: "memo-series",
              entityId: "memo-atomic",
              sourceVersion: "1",
              notePath: "投研知识库/first.md",
              contentHash: "first-content",
              managedHash: "first-managed",
              syncStatus: "synced",
            },
            {
              datasetId: "dataset-a",
              entityType: "memo-series",
              entityId: "memo-atomic",
              sourceVersion: "1",
              notePath: "投研知识库/conflict.md",
              contentHash: "second-content",
              managedHash: "second-managed",
              syncStatus: "synced",
            },
          ],
          result: { written: 2 },
        },
      ),
    ).toThrow(/registered to another source/i);
    expect(
      repository.findRegistryByPath("投研知识库/first.md"),
    ).toBeNull();
    expect(repository.getEvent(event.eventId)).toMatchObject({
      status: "running",
      leaseToken: claimed?.leaseToken,
    });

    const completed = repository.completeProjection(
      event.eventId,
      claimed?.leaseToken ?? "",
      {
        registryEntries: [
          {
            datasetId: "dataset-a",
            entityType: "memo-series",
            entityId: "memo-atomic",
            sourceVersion: "1",
            notePath: "投研知识库/first.md",
            contentHash: "first-content",
            managedHash: "first-managed",
            syncStatus: "synced",
          },
        ],
        result: { written: 1 },
      },
    );
    expect(completed.status).toBe("completed");
    expect(
      repository.findRegistryByPath("投研知识库/first.md"),
    ).toMatchObject({ entityId: "memo-atomic" });
  });

  it("paginates events and rejects corrupt persisted JSON", () => {
    for (const entityId of ["one", "two", "three"]) {
      repository.enqueue({
        datasetId: "dataset-a",
        entityType: "memo-series",
        entityId,
        sourceVersion: "1",
      });
    }
    expect(
      repository.listEvents({
        datasetId: "dataset-a",
        limit: 2,
        offset: 1,
      }),
    ).toMatchObject({
      total: 3,
      limit: 2,
      offset: 1,
      hasMore: false,
    });

    const eventId = repository.listEvents({ limit: 1 }).items[0]?.eventId;
    expect(eventId).toBeTypeOf("string");
    database.exec("PRAGMA ignore_check_constraints=ON");
    database
      .prepare(
        "UPDATE obsidian_sync_outbox SET payload_json='not-json' WHERE event_id=?",
      )
      .run(eventId ?? "");
    expect(() => repository.getEvent(eventId ?? "")).toThrow(
      /stored json is invalid/i,
    );
  });
});
