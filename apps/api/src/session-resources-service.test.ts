import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SESSION_ATTACHMENT_MAX_TEXT_BYTES,
  type TenantIdentity,
} from "@private-fund/contracts";
import { buildTenantContext, type TenantContext } from "@private-fund/core";
import {
  createControlRepositories,
  openControlDatabase,
  type ControlDatabase,
  type ControlRepositories,
} from "@private-fund/db";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { ProjectResearchStoreManager } from "./research-stores.js";
import { RepositorySessionResourcesService } from "./session-resources-service.js";

const ALPHA: TenantIdentity = {
  userId: "resource-alpha",
  dataNamespace: "00000000-0000-4000-8000-0000000000a1",
};
const BETA: TenantIdentity = {
  userId: "resource-beta",
  dataNamespace: "00000000-0000-4000-8000-0000000000b2",
};

async function* bytes(
  ...values: readonly Uint8Array[]
): AsyncIterable<Uint8Array> {
  for (const value of values) {
    yield value;
  }
}

describe("RepositorySessionResourcesService", () => {
  let dataRoot: string;
  let database: ControlDatabase;
  let repositories: ControlRepositories;
  let stores: ProjectResearchStoreManager;
  let service: RepositorySessionResourcesService;
  let alpha: TenantContext;
  let beta: TenantContext;
  let projectId: string;
  let sessionId: string;
  let secondSessionId: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-session-resources-"));
    database = openControlDatabase(":memory:");
    repositories = createControlRepositories(database);
    repositories.users.upsertCloudShadow(ALPHA);
    repositories.users.upsertCloudShadow(BETA);
    alpha = buildTenantContext(dataRoot, ALPHA);
    beta = buildTenantContext(dataRoot, BETA);
    projectId = repositories.projects.createForTenant(
      alpha.dataNamespace,
      {
        id: "project-alpha",
        name: "Alpha",
      },
    ).id;
    sessionId = repositories.sessions.createForTenant(
      alpha.dataNamespace,
      {
        id: "session-alpha",
        projectId,
      },
    ).id;
    secondSessionId = repositories.sessions.createForTenant(
      alpha.dataNamespace,
      {
        id: "session-alpha-two",
        projectId,
      },
    ).id;
    await mkdir(path.join(alpha.projectsRoot, projectId), {
      recursive: true,
      mode: 0o700,
    });
    stores = new ProjectResearchStoreManager();
    service = new RepositorySessionResourcesService(
      repositories,
      stores,
    );
  });

  afterEach(async () => {
    stores.close();
    database.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("publishes an opaque immutable attachment and opens an attested handle", async () => {
    const contents = Buffer.from("# Investment notes\n\nAlpha.", "utf8");
    const expectedSha256 = createHash("sha256")
      .update(contents)
      .digest("hex");
    const attachment = await service.uploadAttachment(alpha, sessionId, {
      filename: "投资笔记.md",
      mimeType: "TEXT/MARKDOWN; charset=UTF-8",
      contents: bytes(contents.subarray(0, 5), contents.subarray(5)),
    });

    expect(attachment).toMatchObject({
      object: "session.resource",
      kind: "attachment",
      lifecycle: "active",
      sessionId,
      projectId,
      name: "投资笔记.md",
      attachment: {
        filename: "投资笔记.md",
        mimeType: "text/markdown",
        bytes: contents.byteLength,
        sha256: expectedSha256,
      },
    });
    expect(attachment.id).toMatch(/^resource_[a-f0-9]{32}$/u);
    expect(JSON.stringify(attachment)).not.toContain("relativePath");
    expect(JSON.stringify(attachment)).not.toContain(
      "session-attachments/",
    );

    const stored =
      repositories.sessionResources.getAttachmentForTenant(
        alpha.dataNamespace,
        sessionId,
        attachment.id,
      );
    expect(stored.relativePath).toBe(
      `session-attachments/${sessionId}/objects/${attachment.id}.md`,
    );
    expect(path.isAbsolute(stored.relativePath)).toBe(false);
    await expect(
      readFile(path.join(alpha.root, stored.relativePath)),
    ).resolves.toEqual(contents);

    const opened = await service.openAttachmentContent(
      alpha,
      sessionId,
      attachment.id,
    );
    expect(opened).toMatchObject({
      filename: "投资笔记.md",
      mimeType: "text/markdown",
      size: contents.byteLength,
      sha256: expectedSha256,
      etag: `"sha256-${expectedSha256}"`,
    });
    await expect(opened.handle.readFile()).resolves.toEqual(contents);
    await opened.handle.close();

    await expect(
      service.listAttachments(alpha, sessionId),
    ).resolves.toMatchObject({
      total: 1,
      items: [expect.objectContaining({ id: attachment.id })],
    });
    await expect(
      service.getResource(alpha, sessionId, attachment.id),
    ).resolves.toEqual(attachment);
  });

  it("soft deletes while retaining recoverable metadata and immutable bytes", async () => {
    const attachment = await service.uploadAttachment(alpha, sessionId, {
      filename: "notes.txt",
      mimeType: "text/plain",
      contents: bytes(Buffer.from("retained bytes", "utf8")),
    });
    const stored =
      repositories.sessionResources.getAttachmentForTenant(
        alpha.dataNamespace,
        sessionId,
        attachment.id,
      );
    const absolutePath = path.join(alpha.root, stored.relativePath);

    await expect(
      service.deleteAttachment(alpha, sessionId, attachment.id),
    ).resolves.toMatchObject({
      id: attachment.id,
      object: "session.resource.deleted",
      kind: "attachment",
      deleted: true,
      deletedAt: expect.any(String),
    });
    await expect(
      service.getAttachment(alpha, sessionId, attachment.id),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.openAttachmentContent(alpha, sessionId, attachment.id),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(readFile(absolutePath, "utf8")).resolves.toBe(
      "retained bytes",
    );
    await expect(
      service.listAttachments(alpha, sessionId, {
        lifecycle: "deleted",
      }),
    ).resolves.toMatchObject({
      total: 1,
      items: [
        expect.objectContaining({
          id: attachment.id,
          lifecycle: "deleted",
          deletedAt: expect.any(String),
        }),
      ],
    });
  });

  it("rejects unsafe names, unsupported types, MIME mismatches, and bad signatures", async () => {
    await expect(
      service.uploadAttachment(alpha, sessionId, {
        filename: "../secret.txt",
        mimeType: "text/plain",
        contents: bytes(Buffer.from("no")),
      }),
    ).rejects.toBeDefined();
    await expect(
      service.uploadAttachment(alpha, sessionId, {
        filename: "archive.zip",
        mimeType: "application/zip",
        contents: bytes(Buffer.from("PK")),
      }),
    ).rejects.toMatchObject({
      code: "unsupported_attachment_type",
      statusCode: 415,
    });
    await expect(
      service.uploadAttachment(alpha, sessionId, {
        filename: "photo.png",
        mimeType: "image/jpeg",
        contents: bytes(Buffer.from("not an image")),
      }),
    ).rejects.toMatchObject({
      code: "attachment_mime_mismatch",
      statusCode: 415,
    });
    await expect(
      service.uploadAttachment(alpha, sessionId, {
        filename: "photo.png",
        mimeType: "image/png",
        contents: bytes(Buffer.from("not an image")),
      }),
    ).rejects.toMatchObject({
      code: "attachment_content_mismatch",
      statusCode: 415,
    });
    await expect(
      service.uploadAttachment(alpha, sessionId, {
        filename: "paper.pdf",
        mimeType: "application/pdf",
        contents: bytes(Buffer.from("not a pdf")),
      }),
    ).rejects.toMatchObject({
      code: "attachment_content_mismatch",
      statusCode: 415,
    });
    await expect(
      service.uploadAttachment(alpha, sessionId, {
        filename: "binary.txt",
        mimeType: "text/plain",
        contents: bytes(Buffer.from([0xff, 0xfe, 0x00])),
      }),
    ).rejects.toMatchObject({
      code: "attachment_content_mismatch",
      statusCode: 415,
    });
    expect(
      repositories.sessionResources.listForTenant(
        alpha.dataNamespace,
        sessionId,
      ).total,
    ).toBe(0);
  });

  it("enforces the text cap while removing unpublished temporary files", async () => {
    await expect(
      service.uploadAttachment(alpha, sessionId, {
        filename: "large.txt",
        mimeType: "text/plain",
        contents: bytes(
          Buffer.alloc(SESSION_ATTACHMENT_MAX_TEXT_BYTES, 0x61),
          Buffer.from("b"),
        ),
      }),
    ).rejects.toMatchObject({
      code: "attachment_too_large",
      statusCode: 413,
    });
    expect(
      repositories.sessionResources.listForTenant(
        alpha.dataNamespace,
        sessionId,
      ).total,
    ).toBe(0);
    const incoming = path.join(
      alpha.root,
      "session-attachments",
      sessionId,
      ".incoming",
    );
    await expect(access(incoming)).resolves.toBeUndefined();
    await expect(readdir(incoming)).resolves.toEqual([]);
  });

  it("rolls back an unregistered publication and rejects symlinked storage directories", async () => {
    const createSpy = vi.spyOn(
      repositories.sessionResources,
      "createAttachmentForTenant",
    ).mockImplementationOnce(() => {
      throw new Error("simulated registration failure");
    });
    await expect(
      service.uploadAttachment(alpha, sessionId, {
        filename: "atomic.txt",
        mimeType: "text/plain",
        contents: bytes(Buffer.from("atomic")),
      }),
    ).rejects.toThrow("simulated registration failure");
    const objects = path.join(
      alpha.root,
      "session-attachments",
      sessionId,
      "objects",
    );
    await expect(readdir(objects)).resolves.toEqual([]);
    createSpy.mockRestore();

    const unsafeTenant = buildTenantContext(
      path.join(dataRoot, "unsafe-data"),
      ALPHA,
    );
    await mkdir(unsafeTenant.root, { recursive: true, mode: 0o700 });
    const outside = path.join(dataRoot, "outside-attachments");
    await mkdir(outside, { recursive: true });
    await symlink(
      outside,
      path.join(unsafeTenant.root, "session-attachments"),
    );
    await expect(
      service.uploadAttachment(unsafeTenant, sessionId, {
        filename: "escape.txt",
        mimeType: "text/plain",
        contents: bytes(Buffer.from("escape")),
      }),
    ).rejects.toMatchObject({ code: "unsafe_attachment_storage" });
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("fails closed for another tenant, another session, corruption, and symlink replacement", async () => {
    const attachment = await service.uploadAttachment(alpha, sessionId, {
      filename: "private.txt",
      mimeType: "text/plain",
      contents: bytes(Buffer.from("private", "utf8")),
    });
    await expect(
      service.getAttachment(beta, sessionId, attachment.id),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.getAttachment(alpha, secondSessionId, attachment.id),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.deleteAttachment(beta, sessionId, attachment.id),
    ).rejects.toMatchObject({ code: "not_found" });

    const stored =
      repositories.sessionResources.getAttachmentForTenant(
        alpha.dataNamespace,
        sessionId,
        attachment.id,
      );
    const destination = path.join(alpha.root, stored.relativePath);
    await writeFile(destination, "changed");
    await expect(
      service.openAttachmentContent(alpha, sessionId, attachment.id),
    ).rejects.toMatchObject({ code: "file_integrity_mismatch" });

    const outside = path.join(dataRoot, "outside-secret.txt");
    await writeFile(outside, "private");
    await unlink(destination);
    await symlink(outside, destination);
    await expect(
      service.openAttachmentContent(alpha, sessionId, attachment.id),
    ).rejects.toMatchObject({ code: "file_not_found" });
    expect(
      repositories.sessionResources.getAttachmentForTenant(
        alpha.dataNamespace,
        sessionId,
        attachment.id,
      ).lifecycle,
    ).toBe("active");
  });

  it("snapshots project-scoped research asset and document versions", async () => {
    const projectRoot = path.join(alpha.projectsRoot, projectId);
    const store = stores.get(projectRoot);
    const savedAsset = store.assets.saveVersion({
      assetId: "asset-alpha",
      assetType: "memo",
      title: "Alpha memo",
      status: "completed",
      contentMarkdown: "# Alpha",
      summary: "summary",
      structuredContent: {},
      metadata: {},
      tags: [],
      evidence: [],
    });
    const source = path.join(projectRoot, "sources", "report.pdf");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "%PDF-1.7\nreport");
    const document = store.documents.registerVersion({
      documentId: "doc-alpha",
      logicalKey: "upload:report.pdf",
      sourceRoot: "upload",
      sourceRelpath: "report.pdf",
      title: "Annual report",
      originalFilename: "report.pdf",
      storedPath: "sources/report.pdf",
      fileType: "pdf",
      mimeType: "application/pdf",
      sha256: createHash("sha256")
        .update("%PDF-1.7\nreport")
        .digest("hex"),
      fileSize: Buffer.byteLength("%PDF-1.7\nreport"),
      status: "indexed",
      activate: true,
      metadata: {},
    });

    await expect(
      service.addResearchAssetResource(alpha, sessionId, {
        assetId: savedAsset.asset.id,
      }),
    ).resolves.toMatchObject({
      kind: "research_asset",
      researchAsset: {
        assetId: savedAsset.asset.id,
        versionId: savedAsset.version.id,
      },
    });
    await expect(
      service.addDocumentReferenceResource(alpha, sessionId, {
        documentId: document.document.id,
      }),
    ).resolves.toMatchObject({
      kind: "document_reference",
      documentReference: {
        documentId: document.document.id,
        versionId: document.version.id,
      },
    });
    await expect(
      service.listResources(alpha, sessionId),
    ).resolves.toMatchObject({
      total: 2,
      items: expect.arrayContaining([
        expect.objectContaining({ kind: "research_asset" }),
        expect.objectContaining({ kind: "document_reference" }),
      ]),
    });

    const otherProject = repositories.projects.createForTenant(
      alpha.dataNamespace,
      {
        id: "project-other",
        name: "Other",
      },
    );
    const otherSession = repositories.sessions.createForTenant(
      alpha.dataNamespace,
      {
        id: "session-other",
        projectId: otherProject.id,
      },
    );
    await mkdir(path.join(alpha.projectsRoot, otherProject.id), {
      recursive: true,
    });
    await expect(
      service.addResearchAssetResource(alpha, otherSession.id, {
        assetId: savedAsset.asset.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.addDocumentReferenceResource(alpha, otherSession.id, {
        documentId: document.document.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("bulk cleanup remains scoped to one session and retains deleted metadata", async () => {
    const first = await service.uploadAttachment(alpha, sessionId, {
      filename: "first.txt",
      mimeType: "text/plain",
      contents: bytes(Buffer.from("first")),
    });
    const second = await service.uploadAttachment(alpha, secondSessionId, {
      filename: "second.txt",
      mimeType: "text/plain",
      contents: bytes(Buffer.from("second")),
    });
    await expect(
      service.deleteResources(alpha, sessionId),
    ).resolves.toMatchObject({
      sessionId,
      object: "session.resources.cleaned",
      cleaned: true,
      deletedCount: 1,
    });
    await expect(
      service.getResource(alpha, sessionId, first.id),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.getResource(alpha, secondSessionId, second.id),
    ).resolves.toMatchObject({ id: second.id, lifecycle: "active" });
    await expect(
      service.listResources(alpha, sessionId, {
        lifecycle: "deleted",
      }),
    ).resolves.toMatchObject({
      total: 1,
      items: [expect.objectContaining({ id: first.id })],
    });
  });
});
