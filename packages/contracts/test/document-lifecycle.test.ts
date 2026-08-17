import { describe, expect, it } from "vitest";

import {
  deleteResearchDocumentsRequestSchema,
  documentTextPreviewSchema,
} from "../src/index.js";

describe("canonical document lifecycle contracts", () => {
  it("accepts a bounded non-empty structured preview", () => {
    expect(
      documentTextPreviewSchema.parse({
        kind: "document_text",
        documentId: "doc_annual",
        documentVersionId: "ver_annual_v1",
        fileName: "annual.md",
        fileType: "md",
        chunkCount: 2,
        contentMarkdown: "# Thesis\n\nDurable evidence.",
        truncated: false,
      }),
    ).toMatchObject({
      documentId: "doc_annual",
      chunkCount: 2,
    });
  });

  it("rejects ambiguous duplicate document identities before deletion", () => {
    expect(() =>
      deleteResearchDocumentsRequestSchema.parse({
        documentIds: ["doc_annual", "doc_annual"],
      }),
    ).toThrow("documentIds must not contain duplicates");
  });
});
