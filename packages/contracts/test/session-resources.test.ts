import { describe, expect, it } from "vitest";

import {
  listSessionResourcesQuerySchema,
  sessionAttachmentResourceSchema,
  sessionResourceSchema,
  uploadSessionAttachmentMetadataSchema,
} from "../src/session-resources.js";

const BASE = {
  id: `resource_${"a".repeat(32)}`,
  object: "session.resource" as const,
  sessionId: "session-alpha",
  projectId: "project-alpha",
  lifecycle: "active" as const,
  name: "notes.md",
  createdAt: "2026-07-31T01:02:03.000Z",
  updatedAt: "2026-07-31T01:02:03.000Z",
  deletedAt: null,
};

describe("session resource contracts", () => {
  it("accepts only the three canonical typed resource kinds", () => {
    const attachment = {
      ...BASE,
      kind: "attachment" as const,
      attachment: {
        filename: "notes.md",
        mimeType: "text/markdown",
        bytes: 42,
        sha256: "b".repeat(64),
      },
    };
    expect(sessionAttachmentResourceSchema.parse(attachment)).toEqual(
      attachment,
    );
    expect(sessionResourceSchema.safeParse(attachment).success).toBe(true);
    expect(
      sessionResourceSchema.safeParse({
        ...BASE,
        kind: "terminal",
        terminal: { id: "terminal-1" },
      }).success,
    ).toBe(false);
    expect(
      sessionResourceSchema.safeParse({
        ...BASE,
        kind: "environment",
        environment: { path: "/tmp/session" },
      }).success,
    ).toBe(false);
  });

  it("rejects path-like filenames and active content metadata leaks", () => {
    expect(
      uploadSessionAttachmentMetadataSchema.safeParse({
        filename: "../secret.txt",
        mimeType: "text/plain",
      }).success,
    ).toBe(false);
    expect(
      sessionAttachmentResourceSchema.safeParse({
        ...BASE,
        kind: "attachment",
        attachment: {
          filename: "notes.md",
          mimeType: "text/markdown",
          bytes: 42,
          sha256: "b".repeat(64),
        },
        relativePath: "session-attachments/private",
      }).success,
    ).toBe(false);
  });

  it("normalizes bounded list pagination", () => {
    expect(listSessionResourcesQuerySchema.parse({})).toEqual({
      lifecycle: "active",
      limit: 50,
      offset: 0,
    });
    expect(
      listSessionResourcesQuerySchema.parse({
        kind: "document_reference",
        lifecycle: "deleted",
        limit: "200",
        offset: "4",
      }),
    ).toEqual({
      kind: "document_reference",
      lifecycle: "deleted",
      limit: 200,
      offset: 4,
    });
    expect(
      listSessionResourcesQuerySchema.safeParse({ limit: 201 }).success,
    ).toBe(false);
  });
});
