import { createHash } from "node:crypto";
import path from "node:path";

import type {
  AddDerivedModelToResourcesRequest,
  CreateTrackingWatchRuleRequest,
  CreateValuationAgentAnalysisRequest,
  CreateValuationWatchRuleRequest,
  DeriveValuationModelRequest,
  GenerateMemoRequest,
  ListMemoVersionsQuery,
  MemoArtifactFormat,
  ListTrackingAlertsQuery,
  ListTrackingItemsQuery,
  ListValuationAlertsQuery,
  ListValuationResourcesQuery,
  RunTrackingScanRequest,
  RunValuationTrackingRequest,
  TrackingPageQuery,
  TransitionTrackingAlertRequest,
  TransitionValuationAlertRequest,
  UpdateTrackingWatchRuleRequest,
  UpdateValuationWatchRuleRequest,
  ValuationPageQuery,
} from "@private-fund/contracts";
import {
  DomainError,
  assertPathWithin,
  type TenantContext,
} from "@private-fund/core";
import type { ControlRepositories } from "@private-fund/db";
import {
  WorkflowStoreError,
  type JsonValue,
  type TrackingRepository,
  type ValuationDerivedModel,
  type ValuationRepository,
  type WatchRuleRecord,
} from "@private-fund/workflow-store";

import type {
  JobService,
  ProjectInsightsService,
} from "./dependencies.js";
import { ProjectResearchStoreManager } from "./research-stores.js";
import {
  mimeTypeForFilename,
  openSecureProjectFile,
  writeNewOrIdenticalProjectFile,
  type OpenedFileResource,
} from "./secure-files.js";

const WORKBOOK_TYPES = new Set(["xlsx", "xlsm", "xltx", "xltm"]);

export class RepositoryProjectInsightsService
  implements ProjectInsightsService
{
  public constructor(
    private readonly repositories: ControlRepositories,
    private readonly stores: ProjectResearchStoreManager,
    private readonly jobs: JobService,
  ) {}

  public async trackingOverview(
    tenant: TenantContext,
    projectId: string,
    options: TrackingPageQuery,
  ) {
    return this.call(() => {
      const repository = this.tracking(tenant, projectId);
      repository.ensureDefaultWatchRules(projectId);
      repository.reopenDueAlerts(projectId);
      return {
        overview: repository.overview(projectId),
        items: repository.listItems(projectId, options),
        alerts: repository.listAlerts(projectId, options),
        watchRules: repository.listWatchRules(projectId, options),
        memoSeries: repository.listMemoSeries(projectId, options),
        memoVersions: repository.listMemoVersions(projectId, options),
      };
    });
  }

  public async runTracking(
    tenant: TenantContext,
    projectId: string,
    input: RunTrackingScanRequest,
  ) {
    this.projectRoot(tenant, projectId);
    return this.jobs.enqueue(tenant, {
      projectId,
      type: "tracking.scan",
      payload: {
        action: "scan",
        datasetId: projectId,
        includeHistory: input.includeHistory,
      },
      idempotencyKey: input.idempotencyKey,
      maxAttempts: 3,
    });
  }

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

  public async trackingItems(
    tenant: TenantContext,
    projectId: string,
    query: ListTrackingItemsQuery,
  ) {
    return this.call(() =>
      this.tracking(tenant, projectId).listItems(projectId, {
        ...(query.itemType === undefined
          ? {}
          : { itemType: query.itemType }),
        ...(query.status === undefined ? {} : { status: query.status }),
        limit: query.limit,
        offset: query.offset,
      }),
    );
  }

  public async trackingItemTimeline(
    tenant: TenantContext,
    projectId: string,
    itemId: string,
  ) {
    return this.call(() =>
      this.tracking(tenant, projectId).getItemTimeline(projectId, itemId),
    );
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

  public async trackingWatchRules(
    tenant: TenantContext,
    projectId: string,
    query: TrackingPageQuery,
  ) {
    return this.call(() => {
      const repository = this.tracking(tenant, projectId);
      repository.ensureDefaultWatchRules(projectId);
      return repository.listWatchRules(projectId, query);
    });
  }

  public async createTrackingWatchRule(
    tenant: TenantContext,
    projectId: string,
    input: CreateTrackingWatchRuleRequest,
  ) {
    return this.call(() =>
      this.tracking(tenant, projectId).upsertWatchRule({
        datasetId: projectId,
        ...(input.ruleId === undefined ? {} : { ruleId: input.ruleId }),
        name: input.name,
        targetType: input.targetType,
        ...(input.targetItemId === undefined
          ? {}
          : { targetItemId: input.targetItemId }),
        query: input.query as Readonly<Record<string, JsonValue>>,
        minPriority: input.minPriority,
        frequency: input.frequency,
        active: input.active,
      }),
    );
  }

  public async updateTrackingWatchRule(
    tenant: TenantContext,
    projectId: string,
    ruleId: string,
    input: UpdateTrackingWatchRuleRequest,
  ) {
    return this.call(() => {
      const repository = this.tracking(tenant, projectId);
      const current = this.findTrackingWatchRule(
        repository,
        projectId,
        ruleId,
      );
      return repository.upsertWatchRule({
        datasetId: projectId,
        ruleId,
        name: input.name ?? current.name,
        targetType: input.targetType ?? current.targetType,
        targetItemId:
          input.targetItemId === undefined
            ? current.targetItemId
            : input.targetItemId,
        query:
          input.query === undefined
            ? current.query
            : (input.query as Readonly<Record<string, JsonValue>>),
        minPriority: input.minPriority ?? current.minPriority,
        frequency: input.frequency ?? current.frequency,
        active: input.active ?? current.active,
      });
    });
  }

  public async trackingAlerts(
    tenant: TenantContext,
    projectId: string,
    query: ListTrackingAlertsQuery,
  ) {
    return this.call(() => {
      const repository = this.tracking(tenant, projectId);
      repository.reopenDueAlerts(projectId);
      return repository.listAlerts(projectId, {
        ...(query.status === undefined ? {} : { status: query.status }),
        limit: query.limit,
        offset: query.offset,
      });
    });
  }

  public async transitionTrackingAlert(
    tenant: TenantContext,
    projectId: string,
    alertId: string,
    input: TransitionTrackingAlertRequest,
  ) {
    return this.call(() =>
      this.tracking(tenant, projectId).transitionAlert(
        projectId,
        alertId,
        input.status,
        input.snoozedUntil === undefined
          ? {}
          : { snoozedUntil: input.snoozedUntil },
      ),
    );
  }

  public async valuationOverview(
    tenant: TenantContext,
    projectId: string,
    options: ValuationPageQuery,
  ) {
    return this.call(() => {
      const repository = this.valuation(tenant, projectId);
      repository.ensureDefaultWatchRule(projectId);
      repository.releaseExpiredSnoozes(projectId);
      return {
        series: repository.listSeries(projectId, options),
        watchRules: repository.listWatchRules(projectId, options),
        alerts: repository.listAlerts(projectId, options),
        analyses: repository.listAgentAnalyses(projectId, options),
        derivedModels: repository.listDerivedModels(projectId, options),
        changeCounts: repository.countChangesByMateriality(projectId),
      };
    });
  }

  public async runValuationTracking(
    tenant: TenantContext,
    projectId: string,
    input: RunValuationTrackingRequest,
  ) {
    const projectRoot = this.projectRoot(tenant, projectId);
    const documents = this.stores.get(projectRoot).documents;
    const page = documents.list({ status: "active", limit: 500, offset: 0 });
    const enqueued = [];
    for (const document of page.items) {
      const version = documents.getCurrentVersion(document.id);
      if (
        version === null ||
        !WORKBOOK_TYPES.has(version.fileType.toLowerCase())
      ) {
        continue;
      }
      const openedSource = await openSecureProjectFile(
        projectRoot,
        version.storedPath,
        {
          filename: version.originalFilename,
          mimeType: version.mimeType,
          expectedSize: version.fileSize,
          expectedSha256: version.sha256,
        },
      );
      const inputPath = openedSource.absolutePath;
      await openedSource.handle.close();
      const result = await this.jobs.enqueue(tenant, {
        projectId,
        type: "valuation.extract",
        payload: {
          action: "extract",
          datasetId: projectId,
          documentId: document.id,
          documentVersionId: version.id,
          inputPath,
          outputDirectory: path.join(
            projectRoot,
            "data",
            "jobs",
            `valuation-extract-${version.id}`,
          ),
          computeOperation: "extract_workbook",
          options: {
            documentId: document.id,
            documentVersionId: version.id,
            includeHistory: input.includeHistory,
          },
        },
        idempotencyKey: `${input.idempotencyKey}:extract:${version.id}`,
        maxAttempts: 3,
      });
      enqueued.push(result);
    }
    const marketJobs = [];
    if (input.refreshMarket) {
      const valuation = this.valuation(tenant, projectId);
      const firstSeriesPage = valuation.listSeries(projectId, {
        limit: 200,
        offset: 0,
      });
      const series = [...firstSeriesPage.items];
      while (series.length < firstSeriesPage.total) {
        const nextPage = valuation.listSeries(projectId, {
          limit: 200,
          offset: series.length,
        });
        if (nextPage.items.length === 0) {
          break;
        }
        series.push(...nextPage.items);
      }
      const endDate = new Date();
      const startDate = new Date(endDate);
      startDate.setUTCFullYear(startDate.getUTCFullYear() - 1);
      for (const item of series) {
        if (
          item.companyTicker === null ||
          item.currentModelVersionId === null
        ) {
          continue;
        }
        const requestDigest = createHash("sha256")
          .update(
            `${input.idempotencyKey}\0${item.seriesId}\0${item.currentModelVersionId}`,
          )
          .digest("hex")
          .slice(0, 32);
        const snapshotId = `snapshot_${requestDigest}`;
        const descriptor = {
          schemaVersion: 1,
          provider: "akshare",
          ticker: item.companyTicker,
          startDate: startDate.toISOString().slice(0, 10),
          endDate: endDate.toISOString().slice(0, 10),
          datasetId: projectId,
          seriesId: item.seriesId,
          modelVersionId: item.currentModelVersionId,
          snapshotId,
        };
        const descriptorPath =
          await writeNewOrIdenticalProjectFile(
            projectRoot,
            path.posix.join(
              "artifacts",
              "requests",
              "market",
              `${requestDigest}.json`,
            ),
            Buffer.from(
              `${JSON.stringify(descriptor, null, 2)}\n`,
              "utf8",
            ),
          );
        marketJobs.push(
          await this.jobs.enqueue(tenant, {
            projectId,
            type: "market.refresh",
            payload: {
              action: "refresh",
              datasetId: projectId,
              seriesId: item.seriesId,
              modelVersionId: item.currentModelVersionId,
              snapshotId,
              inputPath: descriptorPath,
              outputDirectory: path.join(
                projectRoot,
                "artifacts",
                "market",
                snapshotId,
              ),
              computeOperation: "fetch_market_data",
              options: {
                provider: descriptor.provider,
                ticker: descriptor.ticker,
                startDate: descriptor.startDate,
                endDate: descriptor.endDate,
              },
            },
            idempotencyKey: `${input.idempotencyKey}:market:${item.seriesId}:${item.currentModelVersionId}`,
            maxAttempts: 3,
          }),
        );
      }
    }
    return {
      jobs: enqueued,
      marketJobs,
      refreshMarketRequested: input.refreshMarket,
      refreshMarketEnqueued: marketJobs.length > 0,
      reason:
        input.refreshMarket && marketJobs.length === 0
          ? "No ticker-scoped valuation series with a current model version is available"
          : null,
    };
  }

  public async valuationSeries(
    tenant: TenantContext,
    projectId: string,
    options: ValuationPageQuery,
  ) {
    return this.call(() =>
      this.valuation(tenant, projectId).listSeries(projectId, options),
    );
  }

  public async valuationModelVersions(
    tenant: TenantContext,
    projectId: string,
    seriesId: string,
    options: ValuationPageQuery,
  ) {
    return this.call(() =>
      this.valuation(tenant, projectId).listModelVersions(
        projectId,
        seriesId,
        options,
      ),
    );
  }

  public async compareValuationVersions(
    tenant: TenantContext,
    projectId: string,
    seriesId: string,
    fromVersionId: string,
    toVersionId: string,
  ) {
    return this.call(() =>
      this.valuation(tenant, projectId).compareModelVersions(
        projectId,
        seriesId,
        fromVersionId,
        toVersionId,
      ),
    );
  }

  public async valuationModelOverview(
    tenant: TenantContext,
    projectId: string,
    seriesId: string,
    modelVersionId: string,
  ) {
    return this.call(() => {
      const repository = this.valuation(tenant, projectId);
      const series = repository.getSeries(projectId, seriesId);
      const version = repository.getModelVersion(projectId, modelVersionId);
      if (version.seriesId !== seriesId) {
        throw new WorkflowStoreError(
          "Valuation model version belongs to another series",
          "not_found",
        );
      }
      const materializedOverview = repository.getModelOverview(
        projectId,
        seriesId,
        modelVersionId,
      );
      const analyses = repository.listAnalysisVersions(
        projectId,
        seriesId,
        { limit: 500, offset: 0 },
      );
      return {
        series,
        version,
        materializedOverview,
        nodes: repository.listNodes(seriesId, {
          limit: 1_000,
          offset: 0,
        }),
        values: repository.listNodeValues(modelVersionId, {
          limit: 1_000,
          offset: 0,
        }),
        analysisVersions: {
          ...analyses,
          items: analyses.items.filter(
            (analysis) => analysis.modelVersionId === modelVersionId,
          ),
        },
        metrics: repository.getLatestMetricBundle(
          projectId,
          seriesId,
          modelVersionId,
        ),
      };
    });
  }

  public async valuationAnalyses(
    tenant: TenantContext,
    projectId: string,
    query: ListValuationResourcesQuery,
  ) {
    return this.call(() =>
      this.valuation(tenant, projectId).listAgentAnalyses(projectId, {
        ...(query.seriesId === undefined
          ? {}
          : { seriesId: query.seriesId }),
        limit: query.limit,
        offset: query.offset,
      }),
    );
  }

  public async valuationAnalysis(
    tenant: TenantContext,
    projectId: string,
    analysisId: string,
  ) {
    return this.call(() =>
      this.valuation(tenant, projectId).getAgentAnalysis(
        projectId,
        analysisId,
      ),
    );
  }

  public async createValuationAnalysis(
    tenant: TenantContext,
    projectId: string,
    seriesId: string,
    input: CreateValuationAgentAnalysisRequest,
  ) {
    const saved = this.call(() =>
      this.valuation(tenant, projectId).createAgentAnalysis({
        datasetId: projectId,
        seriesId,
        baseModelVersionId: input.baseModelVersionId,
        ...(input.comparisonModelVersionId === undefined
          ? {}
          : {
              comparisonModelVersionId:
                input.comparisonModelVersionId,
            }),
        focus: input.focus,
        agentVersion: input.agentVersion,
        idempotencyKey: input.idempotencyKey,
      }),
    );
    const queued = await this.jobs.enqueue(tenant, {
      projectId,
      type: "valuation.compare",
      payload: {
        action: "agent_analysis",
        datasetId: projectId,
        seriesId,
        analysisId: saved.value.analysisId,
        baseModelVersionId: input.baseModelVersionId,
        comparisonModelVersionId:
          input.comparisonModelVersionId ?? null,
        focus: input.focus,
        agentVersion: input.agentVersion,
      },
      idempotencyKey: `analysis:${input.idempotencyKey}`,
      maxAttempts: 3,
    });
    return { analysis: saved.value, job: queued.job, created: saved.created };
  }

  public async deriveValuationModel(
    tenant: TenantContext,
    projectId: string,
    analysisId: string,
    input: DeriveValuationModelRequest,
  ) {
    const analysis = this.call(() =>
      this.valuation(tenant, projectId).getAgentAnalysis(
        projectId,
        analysisId,
      ),
    );
    if (analysis.status !== "completed") {
      throw new DomainError(
        "Only a completed valuation analysis can derive a model",
        "valuation_analysis_not_completed",
        409,
      );
    }
    const projectRoot = this.projectRoot(tenant, projectId);
    const valuation = this.valuation(tenant, projectId);
    const baseModel = this.call(() =>
      valuation.getModelVersion(
        projectId,
        analysis.baseModelVersionId,
      ),
    );
    if (baseModel.seriesId !== analysis.seriesId) {
      throw new DomainError(
        "Valuation analysis base model belongs to another series",
        "valuation_analysis_model_mismatch",
        409,
      );
    }
    const changes = analysis.analysis.recommendedChanges;
    if (
      !Array.isArray(changes) ||
      changes.length === 0 ||
      !changes.every(
        (change) =>
          typeof change === "object" &&
          change !== null &&
          !Array.isArray(change),
      )
    ) {
      throw new DomainError(
        "Valuation analysis has no safe derivation changes",
        "valuation_derivation_changes_missing",
        409,
      );
    }
    const documents = this.stores.get(projectRoot).documents;
    const source = documents.getVersion(baseModel.docId);
    if (
      source.sha256 !== baseModel.checksum ||
      (baseModel.logicalDocId !== null &&
        source.documentId !== baseModel.logicalDocId)
    ) {
      throw new DomainError(
        "Valuation base workbook no longer matches its registered model",
        "valuation_source_mismatch",
        409,
      );
    }
    const extension = path.extname(source.originalFilename).toLowerCase();
    if (extension !== ".xlsx" && extension !== ".xlsm") {
      throw new DomainError(
        "Only XLSX and XLSM valuation models can be derived",
        "valuation_source_unsupported",
        415,
      );
    }
    const verified = await openSecureProjectFile(
      projectRoot,
      source.storedPath,
      {
        filename: source.originalFilename,
        mimeType: source.mimeType,
        expectedSize: source.fileSize,
        expectedSha256: source.sha256,
      },
    );
    await verified.handle.close();
    const safeAnalysisId = analysisId.replace(
      /[^A-Za-z0-9._-]/gu,
      "_",
    );
    return this.jobs.enqueue(tenant, {
      projectId,
      type: "valuation.derive",
      payload: {
        action: "derive",
        datasetId: projectId,
        seriesId: analysis.seriesId,
        analysisId,
        baseModelVersionId: analysis.baseModelVersionId,
        inputPath: verified.absolutePath,
        outputDirectory: path.join(
          projectRoot,
          "artifacts",
          "valuation",
          "derive",
          safeAnalysisId,
        ),
        computeOperation: "derive_workbook",
        options: {
          changes,
          outputFilename: `${path.basename(
            source.originalFilename,
            extension,
          )}-derived-${safeAnalysisId.slice(-24)}${extension}`,
        },
      },
      idempotencyKey: input.idempotencyKey,
      maxAttempts: 2,
    });
  }

  public async valuationDerivedModels(
    tenant: TenantContext,
    projectId: string,
    query: ListValuationResourcesQuery,
  ) {
    const page = this.call(() =>
      this.valuation(tenant, projectId).listDerivedModels(projectId, {
        ...(query.seriesId === undefined
          ? {}
          : { seriesId: query.seriesId }),
        limit: query.limit,
        offset: query.offset,
      }),
    );
    const items: ValuationDerivedModel[] = [];
    for (const item of page.items) {
      items.push(
        await this.reconcileDerivedResource(
          tenant,
          projectId,
          item,
        ),
      );
    }
    return { ...page, items };
  }

  public async openDerivedModelFile(
    tenant: TenantContext,
    projectId: string,
    derivedModelId: string,
  ): Promise<OpenedFileResource> {
    const projectRoot = this.projectRoot(tenant, projectId);
    const derived = this.call(() =>
      this.valuation(tenant, projectId).getDerivedModel(
        projectId,
        derivedModelId,
      ),
    );
    return openSecureProjectFile(projectRoot, derived.outputPath, {
      filename: derived.outputFilename,
      expectedSha256: derived.checksum,
      mimeType: mimeTypeForFilename(derived.outputFilename),
    });
  }

  public async addDerivedModelToResources(
    tenant: TenantContext,
    projectId: string,
    derivedModelId: string,
    input: AddDerivedModelToResourcesRequest,
  ) {
    const projectRoot = this.projectRoot(tenant, projectId);
    const valuation = this.valuation(tenant, projectId);
    const current = await this.reconcileDerivedResource(
      tenant,
      projectId,
      this.call(() =>
        valuation.getDerivedModel(projectId, derivedModelId),
      ),
    );
    const stores = this.stores.get(projectRoot);
    const logicalKey = `valuation-derived:${derivedModelId}`;
    const existingDocument = stores.documents.findByLogicalKey(logicalKey);

    if (current.resourceStatus === "completed") {
      return {
        derivedModel: current,
        document:
          current.resourceDocId === null
            ? existingDocument
            : stores.documents.getById(current.resourceDocId),
        job: null,
        created: false,
      };
    }
    if (
      (current.resourceStatus === "queued" ||
        current.resourceStatus === "running") &&
      current.resourcePipelineJobId !== null
    ) {
      return {
        derivedModel: current,
        document: existingDocument,
        job: await this.jobs.get(
          tenant,
          current.resourcePipelineJobId,
        ),
        created: false,
      };
    }

    const file = await this.openDerivedModelFile(
      tenant,
      projectId,
      derivedModelId,
    );
    try {
      const extension = path.extname(file.filename).toLowerCase();
      const registration = stores.documents.registerVersion({
        logicalKey,
        sourceRoot: "valuation-derived",
        sourceRelpath: file.filename,
        title: file.filename.slice(0, 500),
        originalFilename: file.filename,
        storedPath: file.absolutePath,
        fileType: extension.replace(/^\./u, "") || "xlsx",
        mimeType: file.mimeType,
        sha256: file.sha256,
        fileSize: file.size,
        status: "parsing",
        parserName: "private-fund-compute-worker",
        parserVersion: "1",
        metadata: {
          source: "valuation-derived-model",
          derivedModelId,
          analysisId: current.analysisId,
          baseModelVersionId: current.baseModelVersionId,
        },
        activate: false,
      });
      const queued = await this.jobs.enqueue(tenant, {
        projectId,
        type: "document.ingest",
        payload: {
          inputPath: file.absolutePath,
          outputDirectory: path.join(
            projectRoot,
            "artifacts",
            "ingest",
            registration.version.id,
          ),
          documentId: registration.document.id,
          documentVersionId: registration.version.id,
          sourceSha256: registration.version.sha256,
          sourceDerivedModelId: derivedModelId,
        },
        idempotencyKey: input.idempotencyKey,
        maxAttempts: 3,
      });
      const derivedModel = this.call(() =>
        valuation.transitionDerivedResource(
          projectId,
          derivedModelId,
          {
            status: "queued",
            fileName: file.filename,
            pipelineJobId: queued.job.id,
          },
        ),
      );
      return {
        derivedModel,
        document: registration.document,
        documentVersion: registration.version,
        job: queued.job,
        created: queued.created,
      };
    } finally {
      await file.handle.close().catch(() => undefined);
    }
  }

  public async valuationWatchRules(
    tenant: TenantContext,
    projectId: string,
    options: ValuationPageQuery,
  ) {
    return this.call(() => {
      const repository = this.valuation(tenant, projectId);
      repository.ensureDefaultWatchRule(projectId);
      return repository.listWatchRules(projectId, options);
    });
  }

  public async createValuationWatchRule(
    tenant: TenantContext,
    projectId: string,
    input: CreateValuationWatchRuleRequest,
  ) {
    return this.call(() =>
      this.valuation(tenant, projectId).upsertWatchRule({
        datasetId: projectId,
        ...(input.ruleId === undefined ? {} : { ruleId: input.ruleId }),
        ...(input.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: input.idempotencyKey }),
        ...(input.seriesId === undefined
          ? {}
          : { seriesId: input.seriesId }),
        name: input.name,
        minMateriality: input.minMateriality,
        changeTypes: input.changeTypes,
        active: input.active,
      }),
    );
  }

  public async updateValuationWatchRule(
    tenant: TenantContext,
    projectId: string,
    ruleId: string,
    input: UpdateValuationWatchRuleRequest,
  ) {
    return this.call(() =>
      this.valuation(tenant, projectId).updateWatchRule(
        projectId,
        ruleId,
        {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.minMateriality === undefined
            ? {}
            : { minMateriality: input.minMateriality }),
          ...(input.changeTypes === undefined
            ? {}
            : { changeTypes: input.changeTypes }),
          ...(input.active === undefined ? {} : { active: input.active }),
        },
      ),
    );
  }

  public async valuationAlerts(
    tenant: TenantContext,
    projectId: string,
    query: ListValuationAlertsQuery,
  ) {
    return this.call(() => {
      const repository = this.valuation(tenant, projectId);
      repository.releaseExpiredSnoozes(projectId);
      return repository.listAlerts(projectId, {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.seriesId === undefined
          ? {}
          : { seriesId: query.seriesId }),
        ...(query.alertType === undefined
          ? {}
          : { alertType: query.alertType }),
        limit: query.limit,
        offset: query.offset,
      });
    });
  }

  public async transitionValuationAlert(
    tenant: TenantContext,
    projectId: string,
    alertId: string,
    input: TransitionValuationAlertRequest,
  ) {
    return this.call(() =>
      this.valuation(tenant, projectId).updateAlertStatus(
        projectId,
        alertId,
        input.status,
        input.snoozedUntil,
      ),
    );
  }

  private findTrackingWatchRule(
    repository: TrackingRepository,
    projectId: string,
    ruleId: string,
  ): WatchRuleRecord {
    let offset = 0;
    for (;;) {
      const page = repository.listWatchRules(projectId, {
        limit: 500,
        offset,
      });
      const found = page.items.find((rule) => rule.ruleId === ruleId);
      if (found !== undefined) {
        return found;
      }
      if (!page.hasMore) {
        throw new WorkflowStoreError(
          "Tracking watch rule was not found",
          "not_found",
        );
      }
      offset += page.items.length;
    }
  }

  private async reconcileDerivedResource(
    tenant: TenantContext,
    projectId: string,
    current: ValuationDerivedModel,
  ): Promise<ValuationDerivedModel> {
    if (
      (current.resourceStatus !== "queued" &&
        current.resourceStatus !== "running") ||
      current.resourcePipelineJobId === null
    ) {
      return current;
    }
    const job = await this.jobs.get(
      tenant,
      current.resourcePipelineJobId,
    );
    if (job === null || job.status === "queued") {
      return current;
    }
    const valuation = this.valuation(tenant, projectId);
    if (job.status === "running") {
      return current.resourceStatus === "running"
        ? current
        : this.call(() =>
            valuation.transitionDerivedResource(
              projectId,
              current.derivedModelId,
              { status: "running" },
            ),
          );
    }
    if (job.status === "completed") {
      const logicalKey = `valuation-derived:${current.derivedModelId}`;
      const document = this.stores
        .get(this.projectRoot(tenant, projectId))
        .documents.findByLogicalKey(logicalKey);
      if (document !== null) {
        return this.call(() =>
          valuation.transitionDerivedResource(
            projectId,
            current.derivedModelId,
            {
              status: "completed",
              documentId: document.id,
            },
          ),
        );
      }
    }
    return this.call(() =>
      valuation.transitionDerivedResource(
        projectId,
        current.derivedModelId,
        {
          status: "failed",
          errorMessage:
            job.error ??
            (job.status === "completed"
              ? "Resource pipeline completed without its registered document"
              : `Resource pipeline job was ${job.status}`),
        },
      ),
    );
  }

  private tracking(
    tenant: TenantContext,
    projectId: string,
  ): TrackingRepository {
    return this.stores.getWorkflow(
      this.projectRoot(tenant, projectId),
    ).tracking;
  }

  private valuation(
    tenant: TenantContext,
    projectId: string,
  ): ValuationRepository {
    return this.stores.getWorkflow(
      this.projectRoot(tenant, projectId),
    ).valuation;
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
