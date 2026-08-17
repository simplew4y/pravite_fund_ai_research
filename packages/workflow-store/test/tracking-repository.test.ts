import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  TrackingRepository,
  WorkflowStoreError,
  runWorkflowStoreMigrations,
} from "../src/index.js";

describe("TrackingRepository", () => {
  let database: DatabaseSync | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  function setup(): TrackingRepository {
    database = new DatabaseSync(":memory:");
    runWorkflowStoreMigrations(database, {
      now: new Date("2026-07-30T00:00:00.000Z"),
    });
    return new TrackingRepository(
      database,
      () => new Date("2026-07-30T12:00:00.000Z"),
    );
  }

  it("stores immutable memo series, versions, evidence and comparisons idempotently", () => {
    const repository = setup();
    const first = repository.saveMemoVersion({
      datasetId: "dataset-a",
      topic: "海外业务",
      asOfDate: "2026-06-30",
      sourceType: "agent_generated",
      contentHash: "sha256-first",
      markdownPath: "/project/memos/first.md",
      documentVersions: [{ id: "doc-v1" }],
      inputs: { mode: "deep" },
      sections: [
        {
          sectionKey: "risk",
          title: "主要风险",
          content: "海外认证仍在推进。",
          evidenceIds: ["chunk:chunk-1"],
        },
      ],
    });
    const duplicate = repository.saveMemoVersion({
      datasetId: "dataset-a",
      topic: "海外业务",
      asOfDate: "2026-06-30",
      sourceType: "agent_generated",
      contentHash: "sha256-first",
      markdownPath: "/project/memos/first.md",
      documentVersions: [{ id: "doc-v1" }],
      inputs: { mode: "deep" },
      sections: [
        {
          sectionKey: "risk",
          title: "主要风险",
          content: "海外认证仍在推进。",
          evidenceIds: ["chunk:chunk-1"],
        },
      ],
    });
    const second = repository.saveMemoVersion({
      datasetId: "dataset-a",
      topic: "海外业务",
      asOfDate: "2026-07-30",
      sourceType: "agent_generated",
      contentHash: "sha256-second",
      sections: [
        {
          sectionKey: "risk",
          title: "主要风险",
          content: "海外认证已经完成。",
          evidenceIds: ["fact:fact-2"],
        },
        {
          sectionKey: "catalyst",
          title: "催化剂",
          content: "新订单开始交付。",
          evidenceIds: ["chunk:chunk-3"],
        },
      ],
    });

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.record.memoVersionId).toBe(first.record.memoVersionId);
    expect(second.record.versionNo).toBe(2);
    expect(second.record.revisionOfVersionId).toBe(first.record.memoVersionId);
    expect(repository.listMemoSeries("dataset-a").items[0]).toMatchObject({
      versionCount: 2,
      currentVersionNo: 2,
    });
    expect(
      repository.listMemoVersions("dataset-a", { limit: 1 }).hasMore,
    ).toBe(true);

    repository.appendItemVersion({
      datasetId: "dataset-a",
      itemType: "risk",
      canonicalKey: "memo-linked-risk",
      title: "备忘录关联风险",
      sourceType: "document",
      sourceId: "doc-before-memo",
      content: "风险仍待确认",
    });
    const memoLinkedChange = repository.appendItemVersion({
      datasetId: "dataset-a",
      itemType: "risk",
      canonicalKey: "memo-linked-risk",
      title: "备忘录关联风险",
      sourceType: "memo",
      sourceId: second.record.memoVersionId,
      content: "风险已经确认",
      change: {
        changeType: "status_changed",
        materiality: "high",
        summary: "备忘录确认了风险状态",
        details: { source: "memo-comparison" },
      },
    });

    const comparison = repository.compareMemoVersions(
      "dataset-a",
      first.record.memoVersionId,
      second.record.memoVersionId,
    );
    expect(
      Object.fromEntries(
        comparison.sectionChanges.map((change) => [
          change.sectionKey,
          change.changeType,
        ]),
      ),
    ).toEqual({ catalyst: "added", risk: "changed" });
    expect(comparison.itemChanges).toEqual([
      expect.objectContaining({
        changeEventId: memoLinkedChange.change?.changeEventId,
        newVersionId: memoLinkedChange.version.itemVersionId,
        changeType: "status_changed",
        materiality: "high",
        summary: "备忘录确认了风险状态",
        details: { source: "memo-comparison" },
      }),
    ]);

    const evidence = database
      ?.prepare(
        `SELECT owner_type, owner_id, evidence_id
         FROM workflow_store_evidence_references ORDER BY evidence_id`,
      )
      .all();
    expect(evidence).toHaveLength(3);
    expect(evidence?.map((row) => row.evidence_id)).toEqual([
      "chunk:chunk-1",
      "chunk:chunk-3",
      "fact:fact-2",
    ]);

    // Adopted Python tables have no foreign keys, so deletion must not rely
    // on ON DELETE CASCADE/SET NULL.
    database?.exec("PRAGMA foreign_keys=OFF");
    expect(
      repository.deleteMemoVersion(
        "dataset-a",
        first.record.memoVersionId,
      ),
    ).toBe(true);
    expect(
      database
        ?.prepare(
          `SELECT COUNT(*) AS count FROM research_memo_sections
           WHERE memo_version_id=?`,
        )
        .get(first.record.memoVersionId)?.count,
    ).toBe(0);
    expect(
      repository.getMemoVersion(
        "dataset-a",
        second.record.memoVersionId,
      ).revisionOfVersionId,
    ).toBeNull();
  });

  it("keeps item history, observations, relations and alert lifecycle transactional", () => {
    const repository = setup();
    const first = repository.appendItemVersion({
      datasetId: "dataset-a",
      itemType: "risk",
      canonicalKey: "overseas-certification",
      title: "海外认证",
      sourceType: "document",
      sourceId: "doc-v1",
      content: "认证尚未完成",
      state: "monitoring",
      evidenceIds: ["chunk:chunk-1"],
    });
    const duplicate = repository.appendItemVersion({
      datasetId: "dataset-a",
      itemType: "risk",
      canonicalKey: "overseas-certification",
      title: "海外认证",
      sourceType: "document",
      sourceId: "doc-v1",
      content: "认证尚未完成",
      state: "monitoring",
      evidenceIds: ["chunk:chunk-1"],
    });
    const second = repository.appendItemVersion({
      datasetId: "dataset-a",
      itemType: "risk",
      canonicalKey: "overseas-certification",
      title: "海外认证",
      sourceType: "document",
      sourceId: "doc-v2",
      content: "认证已经完成",
      state: "resolved",
      impact: "high",
      evidenceIds: ["fact:fact-2"],
      change: {
        changeType: "status_changed",
        materiality: "high",
        summary: "海外认证状态由跟踪中变为已解决",
        details: { old: "monitoring", next: "resolved" },
      },
    });

    expect(duplicate.created).toBe(false);
    expect(second.version.versionNo).toBe(2);
    expect(second.change?.changeType).toBe("status_changed");

    const observation = repository.recordObservation({
      datasetId: "dataset-a",
      itemId: first.item.itemId,
      itemVersionId: second.version.itemVersionId,
      sourceType: "memo",
      sourceId: "memo-v2",
      content: "投委会确认认证完成",
      evidenceIds: ["chunk:chunk-3"],
      extracted: { confidence: 0.9 },
    });
    expect(observation.created).toBe(true);
    expect(
      repository.recordObservation({
        datasetId: "dataset-a",
        itemId: first.item.itemId,
        itemVersionId: second.version.itemVersionId,
        sourceType: "memo",
        sourceId: "memo-v2",
        content: "投委会确认认证完成",
        evidenceIds: ["chunk:chunk-3"],
        extracted: { confidence: 0.9 },
      }).created,
    ).toBe(false);

    const catalyst = repository.appendItemVersion({
      datasetId: "dataset-a",
      itemType: "catalyst",
      canonicalKey: "new-orders",
      title: "新订单交付",
      sourceType: "document",
      sourceId: "doc-v2",
      content: "新订单开始交付",
      evidenceIds: ["chunk:chunk-4"],
    });
    expect(
      repository.addRelation(
        "dataset-a",
        catalyst.item.itemId,
        first.item.itemId,
        "mitigates",
      ).created,
    ).toBe(true);

    const rule = repository.ensureDefaultWatchRules("dataset-a")[0];
    expect(rule).toBeDefined();
    const alert = repository.createAlert({
      datasetId: "dataset-a",
      ruleId: rule?.ruleId,
      itemId: first.item.itemId,
      changeEventId: second.change?.changeEventId,
      alertType: "status_changed",
      priority: "high",
      title: "海外认证状态变化",
      summary: "认证已完成",
      evidenceIds: ["fact:fact-2"],
      dedupeKey: "risk-status-v2",
    });
    expect(alert.created).toBe(true);
    expect(
      repository.createAlert({
        datasetId: "dataset-a",
        ruleId: rule?.ruleId,
        itemId: first.item.itemId,
        changeEventId: second.change?.changeEventId,
        alertType: "status_changed",
        priority: "high",
        title: "海外认证状态变化",
        summary: "认证已完成",
        evidenceIds: ["fact:fact-2"],
        dedupeKey: "risk-status-v2",
      }).created,
    ).toBe(false);
    const snoozed = repository.transitionAlert(
      "dataset-a",
      alert.record.alertId,
      "snoozed",
      { snoozedUntil: "2026-08-01T00:00:00Z" },
    );
    expect(snoozed.status).toBe("snoozed");
    expect(
      repository.reopenDueAlerts(
        "dataset-a",
        new Date("2026-08-02T00:00:00Z"),
      ),
    ).toBe(1);
    expect(repository.listAlerts("dataset-a").items[0]?.status).toBe("new");

    const timeline = repository.getItemTimeline(
      "dataset-a",
      first.item.itemId,
    );
    expect(timeline.versions.map((version) => version.versionNo)).toEqual([1, 2]);
    expect(timeline.changes).toHaveLength(1);
    expect(timeline.observations).toHaveLength(1);
    expect(repository.overview("dataset-a")).toMatchObject({
      counts: { catalyst: 1, risk: 1 },
      unreadAlertCount: 1,
    });
  });

  it("rolls back partial writes when JSON is not strictly serializable", () => {
    const repository = setup();
    expect(() =>
      repository.appendItemVersion({
        datasetId: "dataset-a",
        itemType: "metric",
        canonicalKey: "revenue",
        title: "收入",
        sourceType: "document",
        sourceId: "doc-v1",
        content: "收入增长",
        evidenceIds: ["fact:fact-1"],
        metadata: { invalid: Number.NaN },
      }),
    ).toThrowError(WorkflowStoreError);
    expect(
      database
        ?.prepare(`SELECT COUNT(*) AS count FROM research_items`)
        .get()?.count,
    ).toBe(0);
  });
});
