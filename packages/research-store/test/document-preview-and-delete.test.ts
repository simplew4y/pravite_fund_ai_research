import { describe, expect, it } from "vitest";

import { ConflictError, NotFoundError } from "@private-fund/core";

import {
  createResearchStore,
  openInMemoryProjectDatabase,
} from "../src/index.js";

const FIXED_TIME = "2026-07-31T04:00:00.000Z";

function setup() {
  const clock = () => new Date(FIXED_TIME);
  const database = openInMemoryProjectDatabase({
    clock,
    preferredSearchBackend: "deterministic",
  });
  return {
    database,
    store: createResearchStore(database, clock),
  };
}

describe("document text preview and atomic deletion", () => {
  it("builds a bounded non-empty preview in projection insertion order", () => {
    const { database, store } = setup();
    const registered = store.documents.registerVersion({
      sourceRelpath: "annual.md",
      title: "Annual",
      originalFilename: "annual.md",
      storedPath: "/tmp/annual.md",
      fileType: "md",
      sha256: "a".repeat(64),
      fileSize: 64,
    });
    for (const [index, originalText] of [
      ["first", "# Alpha"],
      ["second", "<img src=x onerror=alert(1)>"],
      ["third", "Durable evidence."],
    ] as const) {
      store.evidence.put({
        evidenceId: `chunk:${index}`,
        kind: "chunk",
        documentVersionId: registered.version.id,
        originalText,
      });
    }

    expect(
      store.evidence.textPreviewForVersion(registered.version.id),
    ).toEqual({
      chunkCount: 3,
      contentMarkdown:
        "# Alpha\n\n<img src=x onerror=alert(1)>\n\nDurable evidence.",
      truncated: false,
    });
    expect(
      store.evidence.textPreviewForVersion(registered.version.id, {
        maxCharacters: 16,
      }),
    ).toEqual({
      chunkCount: 3,
      contentMarkdown: "# Alpha\n\n<img sr",
      truncated: true,
    });
    database.close();
  });

  it("validates the whole identity set before an atomic idempotent removal", () => {
    const { database, store } = setup();
    const first = store.documents.registerVersion({
      sourceRelpath: "first.md",
      title: "First",
      originalFilename: "same-name.md",
      storedPath: "/tmp/first.md",
      fileType: "md",
      sha256: "b".repeat(64),
      fileSize: 10,
      status: "parsing",
      activate: false,
    });
    const second = store.documents.registerVersion({
      sourceRelpath: "second.md",
      title: "Second",
      originalFilename: "same-name.md",
      storedPath: "/tmp/second.md",
      fileType: "md",
      sha256: "c".repeat(64),
      fileSize: 11,
      status: "parsing",
      activate: false,
    });

    expect(() =>
      store.documents.markRemovedMany([
        first.document.id,
        "doc_missing",
      ]),
    ).toThrow(NotFoundError);
    expect(store.documents.getById(first.document.id).status).toBe(
      "active",
    );

    const removed = store.documents.markRemovedMany([
      first.document.id,
      second.document.id,
    ]);
    expect(removed.deletedDocumentIds).toEqual([
      first.document.id,
      second.document.id,
    ]);
    expect(removed.documents.map((document) => document.status)).toEqual([
      "removed",
      "removed",
    ]);
    expect(
      store.documents.getVersion(first.version.id).lifecycle,
    ).toBe("removed");
    expect(() =>
      store.documents.updateVersionStatus(first.version.id, "indexed"),
    ).toThrow(ConflictError);

    const replay = store.documents.markRemovedMany([
      first.document.id,
      second.document.id,
    ]);
    expect(replay.deletedDocumentIds).toEqual([]);
    expect(replay.alreadyRemovedDocumentIds).toEqual([
      first.document.id,
      second.document.id,
    ]);
    database.close();
  });
});
