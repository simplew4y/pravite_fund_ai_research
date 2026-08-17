import { afterEach, describe, expect, it } from "vitest";

import {
  SESSION_ATTACHMENT_MAX_COUNT,
  SESSION_ATTACHMENT_MAX_TOTAL_BYTES,
} from "@private-fund/contracts";
import { NotFoundError } from "@private-fund/core";

import {
  createControlRepositories,
  openControlDatabase,
  runMigrations,
  type ControlDatabase,
} from "../src/index.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const FIXED_TIME = "2026-07-31T04:00:00.000Z";

function resourceId(index: number): string {
  return `resource_${index.toString(16).padStart(32, "0")}`;
}

function attachmentPath(
  sessionId: string,
  id: string,
  extension = "txt",
): string {
  return `session-attachments/${sessionId}/objects/${id}.${extension}`;
}

describe("session resources repository", () => {
  let database: ControlDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  function setup() {
    database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(
      database,
      () => new Date(FIXED_TIME),
    );
    repositories.users.upsertCloudShadow({
      userId: "user-a",
      dataNamespace: TENANT_A,
    });
    repositories.users.upsertCloudShadow({
      userId: "user-b",
      dataNamespace: TENANT_B,
    });
    const projectA = repositories.projects.createForTenant(TENANT_A, {
      id: "project-a",
      name: "Alpha",
    });
    const projectB = repositories.projects.createForTenant(TENANT_B, {
      id: "project-b",
      name: "Beta",
    });
    const sessionA = repositories.sessions.createForTenant(TENANT_A, {
      id: "session-a",
      projectId: projectA.id,
    });
    const sessionA2 = repositories.sessions.createForTenant(TENANT_A, {
      id: "session-a-two",
      projectId: projectA.id,
    });
    const sessionB = repositories.sessions.createForTenant(TENANT_B, {
      id: "session-b",
      projectId: projectB.id,
    });
    return { repositories, sessionA, sessionA2, sessionB };
  }

  it("applies v4 idempotently with the canonical resource table", () => {
    database = openControlDatabase(":memory:");
    const first = runMigrations(database);
    expect(runMigrations(database)).toEqual(first);
    expect(first).toContainEqual(
      expect.objectContaining({
        version: 4,
        name: "tenant_safe_session_resources",
      }),
    );
    expect(
      database
        .prepare(
          `SELECT name
           FROM sqlite_schema
           WHERE type = 'table' AND name = 'session_resources'`,
        )
        .get(),
    ).toEqual({ name: "session_resources" });
  });

  it("stores opaque attachment metadata, emits events, and soft deletes", () => {
    const { repositories, sessionA } = setup();
    const id = resourceId(1);
    const created = repositories.sessionResources.createAttachmentForTenant(
      TENANT_A,
      sessionA.id,
      {
        id,
        filename: "notes.txt",
        relativePath: attachmentPath(sessionA.id, id),
        mimeType: "text/plain",
        sizeBytes: 12,
        sha256: "a".repeat(64),
      },
    );
    expect(created).toMatchObject({
      id,
      kind: "attachment",
      lifecycle: "active",
      sessionId: sessionA.id,
      projectId: "project-a",
      relativePath: attachmentPath(sessionA.id, id),
    });
    expect(
      repositories.sessionResources.attachmentUsageForTenant(
        TENANT_A,
        sessionA.id,
      ),
    ).toEqual({ count: 1, totalBytes: 12 });
    expect(
      repositories.sessionEvents
        .replayForTenant(TENANT_A, sessionA.id, 1)
        .map((event) => event.type),
    ).toEqual(["session.resource.created"]);

    const deleted =
      repositories.sessionResources.markAttachmentDeletedForTenant(
        TENANT_A,
        sessionA.id,
        id,
      );
    expect(deleted).toMatchObject({
      lifecycle: "deleted",
      deletedAt: FIXED_TIME,
      deletedByUserId: "user-a",
    });
    expect(
      repositories.sessionResources.findAttachmentForTenant(
        TENANT_A,
        sessionA.id,
        id,
      ),
    ).toBeNull();
    expect(
      repositories.sessionResources.getAttachmentForTenant(
        TENANT_A,
        sessionA.id,
        id,
        true,
      ),
    ).toMatchObject({
      relativePath: attachmentPath(sessionA.id, id),
      sha256: "a".repeat(64),
    });
    expect(
      repositories.sessionResources.listForTenant(
        TENANT_A,
        sessionA.id,
        { lifecycle: "deleted" },
      ).items,
    ).toHaveLength(1);
    expect(
      repositories.sessionEvents
        .replayForTenant(TENANT_A, sessionA.id, 1)
        .map((event) => event.type),
    ).toEqual([
      "session.resource.created",
      "session.resource.deleted",
    ]);
  });

  it("stores idempotent, project-snapshot typed references only", () => {
    const { repositories, sessionA } = setup();
    const asset = repositories.sessionResources.createResearchAssetForTenant(
      TENANT_A,
      sessionA.id,
      {
        id: resourceId(2),
        name: "Investment memo",
        referenceId: "asset-alpha",
        referenceVersionId: "assetv-alpha-1",
      },
    );
    expect(asset).toMatchObject({
      created: true,
      resource: {
        kind: "research_asset",
        referenceId: "asset-alpha",
        referenceVersionId: "assetv-alpha-1",
      },
    });
    expect(
      repositories.sessionResources.createResearchAssetForTenant(
        TENANT_A,
        sessionA.id,
        {
          id: resourceId(3),
          name: "Renamed memo",
          referenceId: "asset-alpha",
          referenceVersionId: "assetv-alpha-1",
        },
      ),
    ).toMatchObject({
      created: false,
      resource: { id: resourceId(2), name: "Investment memo" },
    });
    expect(
      repositories.sessionResources.createDocumentReferenceForTenant(
        TENANT_A,
        sessionA.id,
        {
          id: resourceId(4),
          name: "Annual report",
          referenceId: "doc-alpha",
          referenceVersionId: "ver-alpha-1",
        },
      ),
    ).toMatchObject({
      created: true,
      resource: { kind: "document_reference" },
    });
    expect(
      repositories.sessionResources.listForTenant(
        TENANT_A,
        sessionA.id,
        { lifecycle: "active" },
      ),
    ).toMatchObject({
      total: 2,
      items: expect.arrayContaining([
        expect.objectContaining({ kind: "research_asset" }),
        expect.objectContaining({ kind: "document_reference" }),
      ]),
    });
  });

  it("fails closed across tenant and session boundaries", () => {
    const { repositories, sessionA, sessionA2, sessionB } = setup();
    const id = resourceId(5);
    repositories.sessionResources.createAttachmentForTenant(
      TENANT_A,
      sessionA.id,
      {
        id,
        filename: "private.txt",
        relativePath: attachmentPath(sessionA.id, id),
        mimeType: "text/plain",
        sizeBytes: 7,
        sha256: "b".repeat(64),
      },
    );
    expect(() =>
      repositories.sessionResources.getForTenant(
        TENANT_B,
        sessionA.id,
        id,
      ),
    ).toThrow(NotFoundError);
    expect(() =>
      repositories.sessionResources.getForTenant(
        TENANT_A,
        sessionA2.id,
        id,
      ),
    ).toThrow(NotFoundError);
    expect(() =>
      repositories.sessionResources.markDeletedForTenant(
        TENANT_B,
        sessionB.id,
        id,
      ),
    ).toThrow(NotFoundError);
    expect(
      repositories.sessionResources.getForTenant(
        TENANT_A,
        sessionA.id,
        id,
      ).lifecycle,
    ).toBe("active");
  });

  it("enforces count, aggregate bytes, normalized paths, and immutability", () => {
    const { repositories, sessionA, sessionA2 } = setup();
    expect(() =>
      repositories.sessionResources.createAttachmentForTenant(
        TENANT_A,
        sessionA.id,
        {
          id: resourceId(6),
          filename: "bad.txt",
          relativePath: "../secret.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          sha256: "c".repeat(64),
        },
      ),
    ).toThrow(RangeError);

    for (let index = 0; index < SESSION_ATTACHMENT_MAX_COUNT; index += 1) {
      const id = resourceId(100 + index);
      repositories.sessionResources.createAttachmentForTenant(
        TENANT_A,
        sessionA.id,
        {
          id,
          filename: `${String(index)}.txt`,
          relativePath: attachmentPath(sessionA.id, id),
          mimeType: "text/plain",
          sizeBytes: 1,
          sha256: index.toString(16).padStart(64, "0"),
        },
      );
    }
    const overflowId = resourceId(999);
    expect(() =>
      repositories.sessionResources.createAttachmentForTenant(
        TENANT_A,
        sessionA.id,
        {
          id: overflowId,
          filename: "overflow.txt",
          relativePath: attachmentPath(sessionA.id, overflowId),
          mimeType: "text/plain",
          sizeBytes: 1,
          sha256: "d".repeat(64),
        },
      ),
    ).toThrow(
      expect.objectContaining({ code: "session_attachment_count_limit" }),
    );

    const chunk = SESSION_ATTACHMENT_MAX_TOTAL_BYTES / 4;
    for (let index = 0; index < 4; index += 1) {
      const id = resourceId(1_000 + index);
      repositories.sessionResources.createAttachmentForTenant(
        TENANT_A,
        sessionA2.id,
        {
          id,
          filename: `${String(index)}.pdf`,
          relativePath: attachmentPath(sessionA2.id, id, "pdf"),
          mimeType: "application/pdf",
          sizeBytes: chunk,
          sha256: (index + 10).toString(16).padStart(64, "0"),
        },
      );
    }
    const aggregateOverflowId = resourceId(2_000);
    expect(() =>
      repositories.sessionResources.createAttachmentForTenant(
        TENANT_A,
        sessionA2.id,
        {
          id: aggregateOverflowId,
          filename: "overflow.pdf",
          relativePath: attachmentPath(
            sessionA2.id,
            aggregateOverflowId,
            "pdf",
          ),
          mimeType: "application/pdf",
          sizeBytes: 1,
          sha256: "e".repeat(64),
        },
      ),
    ).toThrow(
      expect.objectContaining({ code: "session_attachment_storage_limit" }),
    );
    expect(() =>
      database!
        .prepare(
          `UPDATE session_resources
           SET name = 'mutated.txt'
           WHERE id = ?`,
        )
        .run(resourceId(100)),
    ).toThrow();
  });

  it("bulk cleanup affects only the addressed tenant session", () => {
    const { repositories, sessionA, sessionA2 } = setup();
    for (const [index, session] of [sessionA, sessionA2].entries()) {
      const id = resourceId(3_000 + index);
      repositories.sessionResources.createAttachmentForTenant(
        TENANT_A,
        session.id,
        {
          id,
          filename: "cleanup.txt",
          relativePath: attachmentPath(session.id, id),
          mimeType: "text/plain",
          sizeBytes: 1,
          sha256: (index + 20).toString(16).padStart(64, "0"),
        },
      );
    }
    expect(
      repositories.sessionResources.markAllDeletedForTenant(
        TENANT_A,
        sessionA.id,
      ),
    ).toEqual({
      deletedCount: 1,
      deletedAt: FIXED_TIME,
    });
    expect(
      repositories.sessionResources.listForTenant(
        TENANT_A,
        sessionA.id,
      ).total,
    ).toBe(0);
    expect(
      repositories.sessionResources.listForTenant(
        TENANT_A,
        sessionA2.id,
      ).total,
    ).toBe(1);
  });
});
