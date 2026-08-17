import { describe, expect, it } from "vitest";

import { ConflictError } from "@private-fund/core";

import {
  createResearchStore,
  openInMemoryProjectDatabase,
} from "../src/index.js";

const FIXED_TIME = "2026-07-30T13:00:00.000Z";

function setup() {
  const database = openInMemoryProjectDatabase({
    clock: () => new Date(FIXED_TIME),
    preferredSearchBackend: "deterministic",
  });
  const store = createResearchStore(
    database,
    () => new Date(FIXED_TIME),
  );
  return { database, store };
}

describe("research store repositories", () => {
  it("deduplicates document hashes and preserves immutable version history", () => {
    const { database, store } = setup();
    const first = store.documents.registerVersion({
      sourceRelpath: "reports/company.pdf",
      title: "Company",
      originalFilename: "company.pdf",
      storedPath: "/tmp/company-v1.pdf",
      fileType: "pdf",
      sha256: "1".repeat(64),
      fileSize: 100,
    });
    const duplicate = store.documents.registerVersion({
      sourceRelpath: "reports/company.pdf",
      title: "Company",
      originalFilename: "company.pdf",
      storedPath: "/tmp/company-copy.pdf",
      fileType: "pdf",
      sha256: "1".repeat(64),
      fileSize: 100,
    });
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.version.id).toBe(first.version.id);

    const second = store.documents.registerVersion({
      sourceRelpath: "reports/company.pdf",
      title: "Company",
      originalFilename: "company.pdf",
      storedPath: "/tmp/company-v2.pdf",
      fileType: "pdf",
      sha256: "2".repeat(64),
      fileSize: 110,
    });
    expect(second.created).toBe(true);
    expect(second.version.versionNo).toBe(2);
    expect(second.version.supersedesVersionId).toBe(first.version.id);
    expect(store.documents.getVersion(first.version.id).lifecycle).toBe(
      "superseded",
    );
    expect(store.documents.getCurrentVersion(first.document.id)?.id).toBe(
      second.version.id,
    );
    expect(store.documents.listVersions(first.document.id).total).toBe(2);
    database.close();
  });

  it("stores exact evidence locations and rejects evidence-id reuse", () => {
    const { database, store } = setup();
    const document = store.documents.registerVersion({
      sourceRelpath: "model.xlsx",
      title: "Model",
      originalFilename: "model.xlsx",
      storedPath: "/tmp/model.xlsx",
      fileType: "xlsx",
      sha256: "3".repeat(64),
      fileSize: 500,
    });
    const input = {
      evidenceId: "cell:valuation-b7",
      kind: "cell" as const,
      documentVersionId: document.version.id,
      title: "Target price",
      originalText: "Target price | 2026E | 42.5",
      locator: {
        displayText: "Model DCF!B7",
        sheetName: "DCF",
        cellRange: "B7",
        cellRef: "B7",
        formula: "=NPV(B2:B6)",
        displayValue: "42.5",
        rawValue: "=NPV(B2:B6)",
      },
      metadata: { unit: "CNY", numericValue: 42.5 },
    };
    const first = store.evidence.put(input);
    const duplicate = store.evidence.put(input);
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);

    const trace = store.evidence.trace(input.evidenceId);
    expect(trace.documentVersion.sha256).toBe("3".repeat(64));
    expect(trace.document.sourceRelpath).toBe("model.xlsx");
    expect(trace.sheetName).toBe("DCF");
    expect(trace.cellRef).toBe("B7");
    expect(trace.formula).toBe("=NPV(B2:B6)");
    expect(trace.locator.rawValue).toBe("=NPV(B2:B6)");

    expect(() =>
      store.evidence.put({
        ...input,
        originalText: "Different claim",
      }),
    ).toThrow(ConflictError);
    expect(
      store.evidence.listForVersion(document.version.id, {
        kinds: ["cell"],
        limit: 1,
      }).total,
    ).toBe(1);
    database.close();
  });

  it("versions research assets with durable evidence references", () => {
    const { database, store } = setup();
    const document = store.documents.registerVersion({
      sourceRelpath: "source.pdf",
      title: "Source",
      originalFilename: "source.pdf",
      storedPath: "/tmp/source.pdf",
      fileType: "pdf",
      sha256: "4".repeat(64),
      fileSize: 100,
    });
    store.evidence.put({
      evidenceId: "chunk:growth",
      kind: "chunk",
      documentVersionId: document.version.id,
      originalText: "Revenue grew 20%.",
      locator: {
        pageStart: 5,
        pageEnd: 5,
        bbox: [10, 20, 300, 100],
      },
    });

    const firstInput = {
      assetId: "asset:thesis",
      assetType: "analysis",
      title: "Investment thesis",
      summary: "Initial view",
      contentMarkdown: "Revenue growth is strong.",
      tags: ["growth", "important"],
      evidence: [
        {
          evidenceId: "chunk:growth",
          relationType: "supports",
          quote: "Revenue grew 20%.",
        },
      ],
    };
    const first = store.assets.saveVersion(firstInput);
    const duplicate = store.assets.saveVersion(firstInput);
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.version.id).toBe(first.version.id);

    const second = store.assets.saveVersion({
      ...firstInput,
      summary: "Updated view",
      contentMarkdown: "Revenue growth is strong, but valuation is full.",
    });
    expect(second.version.versionNo).toBe(2);
    expect(second.asset.currentVersionId).toBe(second.version.id);
    const versions = store.assets.listVersions(first.asset.id, {
      limit: 1,
      offset: 0,
    });
    expect(versions.total).toBe(2);
    expect(versions.hasMore).toBe(true);

    const resolved = store.assets.resolveVersion(second.version.id);
    expect(resolved.references).toHaveLength(1);
    expect(resolved.evidence[0]?.pageStart).toBe(5);
    expect(resolved.evidence[0]?.documentVersion.id).toBe(document.version.id);
    expect(store.assets.setStatus(first.asset.id, "archived").archivedAt).toBe(
      FIXED_TIME,
    );
    database.close();
  });

  it("keeps asset context ordered and tombstones assets without deleting audit history", () => {
    const { database, store } = setup();
    const first = store.assets.saveVersion({
      assetId: "asset:first",
      assetType: "analysis",
      title: "First",
      contentMarkdown: "First immutable version",
    });
    const second = store.assets.saveVersion({
      assetId: "asset:second",
      assetType: "memo",
      title: "Second",
      contentMarkdown: "Second immutable version",
    });

    expect(
      store.assets.replaceContext([second.asset.id, first.asset.id]),
    ).toEqual([second.asset.id, first.asset.id]);
    expect(
      store.assets.replaceContext([second.asset.id, first.asset.id]),
    ).toEqual([second.asset.id, first.asset.id]);

    store.assets.setStatus(second.asset.id, "archived");
    expect(store.assets.listContext()).toEqual([first.asset.id]);
    expect(() =>
      store.assets.replaceContext([second.asset.id]),
    ).toThrow(ConflictError);

    const deleted = store.assets.markDeleted(first.asset.id);
    expect(deleted.deletedAt).toBe(FIXED_TIME);
    expect(deleted.status).toBe("archived");
    expect(store.assets.list().items).toEqual([
      expect.objectContaining({
        id: second.asset.id,
        status: "archived",
      }),
    ]);
    expect(store.assets.listVersions(first.asset.id).items).toHaveLength(1);
    expect(store.assets.getVersion(first.version.id).contentMarkdown).toBe(
      "First immutable version",
    );
    expect(
      database.connection
        .prepare(
          `SELECT event_type AS eventType
           FROM research_asset_audit_events
           ORDER BY event_id`,
        )
        .all()
        .map((row) => row.eventType),
    ).toEqual(
      expect.arrayContaining([
        "asset.context.replaced",
        "asset.status.changed",
        "asset.deleted",
      ]),
    );
    database.close();
  });

  it("enforces strict JSON before and inside SQLite transactions", () => {
    const { database, store } = setup();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      store.documents.registerVersion({
        sourceRelpath: "bad.pdf",
        title: "Bad",
        originalFilename: "bad.pdf",
        storedPath: "/tmp/bad.pdf",
        fileType: "pdf",
        sha256: "5".repeat(64),
        fileSize: 1,
        metadata: circular,
      }),
    ).toThrow(/circular/);
    expect(store.documents.list().total).toBe(0);

    const document = store.documents.registerVersion({
      sourceRelpath: "good.pdf",
      title: "Good",
      originalFilename: "good.pdf",
      storedPath: "/tmp/good.pdf",
      fileType: "pdf",
      sha256: "6".repeat(64),
      fileSize: 1,
    });
    expect(() =>
      database.connection
        .prepare(
          `UPDATE document_versions
           SET metadata_json = 'not-json'
           WHERE id = ?`,
        )
        .run(document.version.id),
    ).toThrow();
    expect(store.documents.getVersion(document.version.id).metadata).toEqual(
      {},
    );
    database.close();
  });
});
