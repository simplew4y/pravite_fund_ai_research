import path from "node:path";

import type {
  AssignSourceFolderDocumentRequest,
  CreateSourceFolderRequest,
  SourceFolder,
  SourceFolderAssignment,
  SourceFolderTreeEntry,
  UpdateSourceFolderRequest,
} from "@private-fund/contracts";
import {
  assertPathWithin,
  NotFoundError,
  type TenantContext,
} from "@private-fund/core";
import type { ControlRepositories } from "@private-fund/db";

import type { SourceFolderService } from "./dependencies.js";
import { ProjectResearchStoreManager } from "./research-stores.js";

export class RepositorySourceFolderService implements SourceFolderService {
  public constructor(
    private readonly repositories: ControlRepositories,
    private readonly stores: ProjectResearchStoreManager,
  ) {}

  public async listTree(
    tenant: TenantContext,
    projectId: string,
  ): Promise<readonly SourceFolderTreeEntry[]> {
    return this.store(tenant, projectId).sourceFolders.listTree().map(
      (folder) => ({
        ...folder,
        path: [...folder.path],
      }),
    );
  }

  public async create(
    tenant: TenantContext,
    projectId: string,
    input: CreateSourceFolderRequest,
  ): Promise<{ readonly folder: SourceFolder; readonly created: boolean }> {
    return this.store(tenant, projectId).sourceFolders.create({
      ...(input.parentId === undefined
        ? {}
        : { parentId: input.parentId }),
      name: input.name,
      folderKind: input.folderKind,
      ...(input.classificationKey === undefined
        ? {}
        : { classificationKey: input.classificationKey }),
      sortOrder: input.sortOrder,
      metadata: input.metadata,
    });
  }

  public async update(
    tenant: TenantContext,
    projectId: string,
    folderId: string,
    input: UpdateSourceFolderRequest,
  ): Promise<SourceFolder> {
    return this.store(tenant, projectId).sourceFolders.update(folderId, {
      ...(input.parentId === undefined
        ? {}
        : { parentId: input.parentId }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.folderKind === undefined
        ? {}
        : { folderKind: input.folderKind }),
      ...(input.classificationKey === undefined
        ? {}
        : { classificationKey: input.classificationKey }),
      ...(input.sortOrder === undefined
        ? {}
        : { sortOrder: input.sortOrder }),
      ...(input.metadata === undefined
        ? {}
        : { metadata: input.metadata }),
    });
  }

  public async remove(
    tenant: TenantContext,
    projectId: string,
    folderId: string,
  ): Promise<SourceFolder> {
    return this.store(tenant, projectId).sourceFolders.remove(folderId);
  }

  public async assignDocument(
    tenant: TenantContext,
    projectId: string,
    folderId: string,
    input: AssignSourceFolderDocumentRequest,
  ): Promise<{
    readonly assignment: SourceFolderAssignment;
    readonly created: boolean;
  }> {
    return this.store(tenant, projectId).sourceFolders.assignDocument(
      input.documentId,
      folderId,
      {
        assignmentSource: input.assignmentSource,
        ...(input.classificationKey === undefined
          ? {}
          : { classificationKey: input.classificationKey }),
        metadata: input.metadata,
      },
    );
  }

  public async unassignDocument(
    tenant: TenantContext,
    projectId: string,
    folderId: string,
    documentId: string,
  ): Promise<boolean> {
    const sourceFolders = this.store(tenant, projectId).sourceFolders;
    sourceFolders.get(folderId);
    const assignment = sourceFolders.findAssignment(documentId);
    if (assignment === null) {
      return false;
    }
    if (assignment.folderId !== folderId) {
      throw new NotFoundError("Source folder assignment");
    }
    return sourceFolders.unassignDocument(documentId);
  }

  public async listAssignments(
    tenant: TenantContext,
    projectId: string,
    folderId?: string,
  ): Promise<readonly SourceFolderAssignment[]> {
    return this.store(tenant, projectId).sourceFolders.listAssignments(
      folderId,
    );
  }

  private store(tenant: TenantContext, projectId: string) {
    this.repositories.projects.getForTenant(
      tenant.dataNamespace,
      projectId,
    );
    const projectRoot = assertPathWithin(
      path.join(tenant.projectsRoot, projectId),
      tenant.root,
    );
    return this.stores.get(projectRoot);
  }
}
