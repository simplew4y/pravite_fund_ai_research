import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { TenantIdentity } from "@private-fund/contracts";
import { buildTenantContext } from "@private-fund/core";
import {
  createControlRepositories,
  openControlDatabase,
} from "@private-fund/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RepositoryProjectService } from "./repository-services.js";
import { ProjectResearchStoreManager } from "./research-stores.js";
import { RepositorySourceFolderService } from "./source-folder-service.js";

const ALPHA: TenantIdentity = {
  userId: "source-folder-alpha",
  dataNamespace: "00000000-0000-4000-8000-0000000000a1",
};
const BETA: TenantIdentity = {
  userId: "source-folder-beta",
  dataNamespace: "00000000-0000-4000-8000-0000000000b2",
};

describe("RepositorySourceFolderService", () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-source-folder-api-"));
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("manages a normalized tree and one folder assignment per document", async () => {
    const database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(database);
    repositories.users.upsertCloudShadow(ALPHA);
    const tenant = buildTenantContext(dataRoot, ALPHA);
    const projects = new RepositoryProjectService(repositories);
    const project = await projects.create(tenant, {
      name: "Source folder project",
    });
    const stores = new ProjectResearchStoreManager();
    const service = new RepositorySourceFolderService(
      repositories,
      stores,
    );

    const root = await service.create(tenant, project.id, {
      name: "Financials",
      folderKind: "manual",
      sortOrder: 10,
      metadata: {},
    });
    const child = await service.create(tenant, project.id, {
      parentId: root.folder.id,
      name: "Quarterly",
      folderKind: "classification",
      classificationKey: "financials.quarterly",
      sortOrder: 1,
      metadata: { owner: "research" },
    });
    const projectStore = stores.get(
      path.join(tenant.projectsRoot, project.id),
    );
    const registered = projectStore.documents.registerVersion({
      logicalKey: "upload:q1.pdf",
      sourceRoot: "upload",
      sourceRelpath: "q1.pdf",
      title: "Q1",
      originalFilename: "q1.pdf",
      storedPath: "sources/objects/q1.pdf",
      fileType: "pdf",
      mimeType: "application/pdf",
      sha256: "a".repeat(64),
      fileSize: 42,
      status: "indexed",
      metadata: {},
    });

    const assigned = await service.assignDocument(
      tenant,
      project.id,
      child.folder.id,
      {
        documentId: registered.document.id,
        assignmentSource: "manual",
        classificationKey: "financials.quarterly",
        metadata: { confidence: 1 },
      },
    );

    expect(assigned.created).toBe(true);
    expect(
      await service.listAssignments(
        tenant,
        project.id,
        child.folder.id,
      ),
    ).toEqual([assigned.assignment]);
    expect(await service.listTree(tenant, project.id)).toEqual([
      expect.objectContaining({
        id: root.folder.id,
        depth: 0,
        path: ["Financials"],
        childCount: 1,
        documentCount: 0,
      }),
      expect.objectContaining({
        id: child.folder.id,
        depth: 1,
        path: ["Financials", "Quarterly"],
        childCount: 0,
        documentCount: 1,
      }),
    ]);

    await expect(
      service.remove(tenant, project.id, child.folder.id),
    ).rejects.toMatchObject({ code: "source_folder_not_empty" });
    await expect(
      service.unassignDocument(
        tenant,
        project.id,
        child.folder.id,
        registered.document.id,
      ),
    ).resolves.toBe(true);
    await expect(
      service.unassignDocument(
        tenant,
        project.id,
        child.folder.id,
        registered.document.id,
      ),
    ).resolves.toBe(false);
    await expect(
      service.remove(tenant, project.id, child.folder.id),
    ).resolves.toMatchObject({
      id: child.folder.id,
      deletedAt: expect.any(String),
    });

    stores.close();
    database.close();
  });

  it("fails closed when a tenant addresses another tenant's project", async () => {
    const database = openControlDatabase(":memory:");
    const repositories = createControlRepositories(database);
    repositories.users.upsertCloudShadow(ALPHA);
    repositories.users.upsertCloudShadow(BETA);
    const alpha = buildTenantContext(dataRoot, ALPHA);
    const beta = buildTenantContext(dataRoot, BETA);
    const projects = new RepositoryProjectService(repositories);
    const project = await projects.create(alpha, {
      name: "Alpha-only project",
    });
    const stores = new ProjectResearchStoreManager();
    const service = new RepositorySourceFolderService(
      repositories,
      stores,
    );

    await expect(service.listTree(beta, project.id)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      service.create(beta, project.id, {
        name: "Cross tenant",
        folderKind: "manual",
        sortOrder: 0,
        metadata: {},
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    stores.close();
    database.close();
  });
});
