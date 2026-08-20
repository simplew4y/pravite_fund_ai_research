import path from "node:path";

import type {
  GenerateMemoRequest,
  ListMemoVersionsQuery,
  MemoArtifactFormat,
} from "@private-fund/contracts";
import {
  DomainError,
  assertPathWithin,
  type TenantContext,
} from "@private-fund/core";
import type { ControlRepositories } from "@private-fund/db";
import {
  WorkflowStoreError,
  type TrackingRepository,
} from "@private-fund/workflow-store";

import type {
  JobService,
  ProjectInsightsService,
} from "./dependencies.js";
import { ProjectResearchStoreManager } from "./research-stores.js";
import {
  mimeTypeForFilename,
  openSecureProjectFile,
  type OpenedFileResource,
} from "./secure-files.js";

/**
 * Memo pipeline: generation jobs, version listing, structural compare and
 * artifact serving. The valuation/tracking/workflow features that used to
 * live here were removed pending a redesign; the workflow store stays as
 * the memo pipeline's storage substrate.
 */
export class RepositoryProjectInsightsService
  implements ProjectInsightsService
{
  public constructor(
    private readonly repositories: ControlRepositories,
    private readonly stores: ProjectResearchStoreManager,
    private readonly jobs: JobService,
  ) {}

  public async generateMemo(
    tenant: TenantContext,
    projectId: string,
    input: GenerateMemoRequest,
  ) {
    const projectRoot = this.projectRoot(tenant, projectId);
    if (input.evidenceIds !== undefined) {
      const evidence = this.stores.get(projectRoot).evidence;
      for (const evidenceId of input.evidenceIds) {
        if (evidence.find(evidenceId) === null) {
          throw new DomainError(
            `Evidence reference does not resolve in this project: ${evidenceId}`,
            "invalid_evidence_reference",
            400,
          );
        }
      }
    }
    return this.jobs.enqueue(tenant, {
      projectId,
      type: "memo.generate",
      payload: {
        datasetId: projectId,
        instruction: input.instruction,
        ...(input.topic === undefined ? {} : { topic: input.topic }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.evidenceIds === undefined
          ? {}
          : { evidenceIds: input.evidenceIds }),
      },
      idempotencyKey: input.idempotencyKey,
      maxAttempts: 3,
    });
  }

  public async memoSeries(
    tenant: TenantContext,
    projectId: string,
    query: ListMemoVersionsQuery,
  ) {
    return this.call(() => {
      const repository = this.tracking(tenant, projectId);
      return {
        series: repository.listMemoSeries(projectId, query),
        versions: repository.listMemoVersions(projectId, {
          ...(query.seriesId === undefined
            ? {}
            : { seriesId: query.seriesId }),
          limit: query.limit,
          offset: query.offset,
        }),
      };
    });
  }

  public async compareMemoVersions(
    tenant: TenantContext,
    projectId: string,
    fromVersionId: string,
    toVersionId: string,
  ) {
    return this.call(() =>
      this.tracking(tenant, projectId).compareMemoVersions(
        projectId,
        fromVersionId,
        toVersionId,
      ),
    );
  }

  public async openMemoArtifact(
    tenant: TenantContext,
    projectId: string,
    memoVersionId: string,
    format?: MemoArtifactFormat,
  ): Promise<OpenedFileResource> {
    const projectRoot = this.projectRoot(tenant, projectId);
    const memo = this.call(() =>
      this.tracking(tenant, projectId).getMemoVersion(
        projectId,
        memoVersionId,
      ),
    );
    const candidates: Record<MemoArtifactFormat, string | null> = {
      markdown: memo.markdownPath,
      html: memo.htmlPath,
      pdf: memo.pdfPath,
    };
    const selectedFormat =
      format ??
      (memo.htmlPath !== null
        ? "html"
        : memo.pdfPath !== null
          ? "pdf"
          : "markdown");
    const selectedPath = candidates[selectedFormat];
    if (selectedPath === null) {
      throw new DomainError(
        `Memo ${selectedFormat} artifact is not available`,
        "memo_artifact_not_found",
        404,
      );
    }
    return openSecureProjectFile(projectRoot, selectedPath, {
      filename: path.basename(selectedPath),
      mimeType: mimeTypeForFilename(selectedPath),
    });
  }

  private tracking(
    tenant: TenantContext,
    projectId: string,
  ): TrackingRepository {
    return this.stores.getWorkflow(
      this.projectRoot(tenant, projectId),
    ).tracking;
  }

  private projectRoot(
    tenant: TenantContext,
    projectId: string,
  ): string {
    this.repositories.projects.getForTenant(
      tenant.dataNamespace,
      projectId,
    );
    return assertPathWithin(
      path.join(tenant.projectsRoot, projectId),
      tenant.root,
    );
  }

  private call<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (!(error instanceof WorkflowStoreError)) {
        throw error;
      }
      const status =
        error.code === "not_found"
          ? 404
          : error.code === "conflict" ||
              error.code === "invalid_state"
            ? 409
            : error.code === "corrupt_json"
              ? 500
              : 400;
      throw new DomainError(
        error.message,
        `insights_${error.code}`,
        status,
      );
    }
  }
}
