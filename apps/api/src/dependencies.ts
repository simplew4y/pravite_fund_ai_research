import type { TenantContext } from "@private-fund/core";
import type {
  CloudAccountClient,
  CloudAuthService,
  SessionCipher,
} from "@private-fund/auth";
import type {
  AddDerivedModelToResourcesRequest,
  AssignSourceFolderDocumentRequest,
  CreateSessionDocumentReferenceResourceRequest,
  CreateSessionResearchAssetResourceRequest,
  CreateSourceFolderRequest,
  CreateProjectRequest,
  CreateSessionRequest,
  UpdateProjectRequest,
  DeleteSessionResourceResponse,
  DeleteSessionResourcesResponse,
  DeleteSessionResponse,
  DeleteResearchAssetsRequest,
  DeleteResearchDocumentsRequest,
  DeleteResearchDocumentsResponse,
  CreateTrackingWatchRuleRequest,
  CreateValuationAgentAnalysisRequest,
  CreateValuationWatchRuleRequest,
  DeriveValuationModelRequest,
  EnqueueJobRequest,
  ExcelSourcePayload,
  ExcelSourceQuery,
  ForkSessionRequest,
  GenerateMemoRequest,
  GlobalUploadBatchDetail,
  GlobalUploadBatchPage,
  GlobalUploadItemPage,
  Job,
  ListMemoVersionsQuery,
  ListSessionChildrenQuery,
  MemoArtifactFormat,
  ListTrackingAlertsQuery,
  ListTrackingItemsQuery,
  ListValuationAlertsQuery,
  ListValuationResourcesQuery,
  ListJobsQuery,
  ListGlobalUploadBatchesQuery,
  ListGlobalUploadItemsQuery,
  ListSessionAttachmentsQuery,
  ListSessionResourcesQuery,
  Operation,
  ModelGatewayAccess,
  PdfSourcePage,
  PdfSourcePageQuery,
  Project,
  RegisterDocumentVersionRequest,
  ResearchAsset,
  ResearchAssetEvidenceReference,
  ResearchAssetVersion,
  ResearchDocument,
  ResearchDocumentVersion,
  DocumentTextPreview,
  ResearchEvidenceTrace,
  SourceFolder,
  SourceFolderAssignment,
  SourceFolderTreeEntry,
  SaveResearchAssetRequest,
  SendMessageRequest,
  Session,
  SessionAttachmentPage,
  SessionChildrenPage,
  SessionEvent,
  SessionLabelsResponse,
  SessionResource,
  SessionResourcePage,
  TenantIdentity,
  RunTrackingScanRequest,
  RouteGlobalUploadItemRequest,
  RunValuationTrackingRequest,
  TrackingPageQuery,
  TransitionTrackingAlertRequest,
  TransitionValuationAlertRequest,
  UpdateResearchAssetContextRequest,
  UpdateResearchAssetLifecycleRequest,
  UpdateSessionRequest,
  UpdateSourceFolderRequest,
  UpdateTrackingWatchRuleRequest,
  UpdateValuationWatchRuleRequest,
  ValuationPageQuery,
} from "@private-fund/contracts";
import type { OpenedFileResource } from "./secure-files.js";

export interface RequestIdentityProvider {
  authenticate(
    cookieValue: string | undefined,
  ): Promise<{ identity: TenantIdentity; replacementCookie?: string }>;
}

export interface ProjectService {
  list(tenant: TenantContext): Promise<Project[]>;
  create(tenant: TenantContext, input: CreateProjectRequest): Promise<Project>;
  get(tenant: TenantContext, projectId: string): Promise<Project | null>;
  update(
    tenant: TenantContext,
    projectId: string,
    input: UpdateProjectRequest,
  ): Promise<Project | null>;
  remove(tenant: TenantContext, projectId: string): Promise<boolean>;
}

export interface SessionService {
  list(
    tenant: TenantContext,
    projectId?: string,
    includeArchived?: boolean,
  ): Promise<Session[]>;
  create(tenant: TenantContext, input: CreateSessionRequest): Promise<Session>;
  get(tenant: TenantContext, sessionId: string): Promise<Session | null>;
  children(
    tenant: TenantContext,
    sessionId: string,
    query: ListSessionChildrenQuery,
  ): Promise<SessionChildrenPage>;
  labels(
    tenant: TenantContext,
    sessionId: string,
  ): Promise<SessionLabelsResponse>;
  update(
    tenant: TenantContext,
    sessionId: string,
    input: UpdateSessionRequest,
  ): Promise<Session>;
  fork(
    tenant: TenantContext,
    sessionId: string,
    input: ForkSessionRequest,
  ): Promise<Session>;
  remove(
    tenant: TenantContext,
    sessionId: string,
  ): Promise<DeleteSessionResponse>;
  sendMessage(
    tenant: TenantContext,
    sessionId: string,
    input: SendMessageRequest,
    modelGatewayAccess?: ModelGatewayAccess,
  ): Promise<{ operationId: string }>;
  steer(tenant: TenantContext, sessionId: string, content: string): Promise<void>;
  compact(
    tenant: TenantContext,
    sessionId: string,
    customInstructions?: string,
  ): Promise<void>;
  interrupt(tenant: TenantContext, sessionId: string): Promise<void>;
  events(
    tenant: TenantContext,
    sessionId: string,
    after: number,
    limit: number,
  ): Promise<SessionEvent[]>;
  operation(
    tenant: TenantContext,
    sessionId: string,
    operationId: string,
  ): Promise<Operation | null>;
  operations(
    tenant: TenantContext,
    sessionId: string,
  ): Promise<Operation[]>;
  subscribe(
    tenant: TenantContext,
    sessionId: string,
    listener: (event: SessionEvent) => void,
  ): () => void;
}

export interface JobService {
  enqueue(
    tenant: TenantContext,
    input: EnqueueJobRequest,
  ): Promise<{ job: Job; created: boolean }>;
  get(tenant: TenantContext, jobId: string): Promise<Job | null>;
  list(tenant: TenantContext, query: ListJobsQuery): Promise<Job[]>;
  cancel(tenant: TenantContext, jobId: string): Promise<Job | null>;
}

export interface ResearchPage<T> {
  readonly items: T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
}

export interface UploadResearchDocumentInput {
  readonly filename: string;
  readonly mimeType: string | null;
  readonly contents: AsyncIterable<Uint8Array | string>;
}

export interface ResearchService {
  listDocuments(
    tenant: TenantContext,
    projectId: string,
    options: { limit: number; offset: number },
  ): Promise<ResearchPage<ResearchDocument>>;
  registerDocument(
    tenant: TenantContext,
    projectId: string,
    input: RegisterDocumentVersionRequest,
  ): Promise<{
    document: ResearchDocument;
    version: ResearchDocumentVersion;
    created: boolean;
  }>;
  uploadDocument(
    tenant: TenantContext,
    projectId: string,
    input: UploadResearchDocumentInput,
  ): Promise<{
    document: ResearchDocument;
    version: ResearchDocumentVersion;
    job: Job;
    created: boolean;
  }>;
  documentVersions(
    tenant: TenantContext,
    projectId: string,
    documentId: string,
    options: { limit: number; offset: number },
  ): Promise<ResearchPage<ResearchDocumentVersion>>;
  openDocumentFile(
    tenant: TenantContext,
    projectId: string,
    documentId: string,
    versionId?: string,
  ): Promise<OpenedFileResource>;
  documentTextPreview(
    tenant: TenantContext,
    projectId: string,
    documentId: string,
    versionId?: string,
  ): Promise<DocumentTextPreview>;
  removeDocument(
    tenant: TenantContext,
    projectId: string,
    documentId: string,
  ): Promise<ResearchDocument | null>;
  removeDocuments(
    tenant: TenantContext,
    projectId: string,
    input: DeleteResearchDocumentsRequest,
  ): Promise<DeleteResearchDocumentsResponse>;
  searchEvidence(
    tenant: TenantContext,
    projectId: string,
    options: {
      query: string;
      kinds?: readonly ("chunk" | "fact" | "cell" | "page")[];
      limit: number;
      offset: number;
      includeHistorical: boolean;
    },
  ): Promise<
    ResearchPage<{
      evidence: ResearchEvidenceTrace;
      score: number;
    }>
  >;
  evidence(
    tenant: TenantContext,
    projectId: string,
    evidenceId: string,
  ): Promise<ResearchEvidenceTrace | null>;
  openEvidenceFile(
    tenant: TenantContext,
    projectId: string,
    evidenceId: string,
  ): Promise<OpenedFileResource>;
  excelSource(
    tenant: TenantContext,
    projectId: string,
    evidenceId: string,
    query: ExcelSourceQuery,
  ): Promise<ExcelSourcePayload>;
  pdfSourcePage(
    tenant: TenantContext,
    projectId: string,
    evidenceId: string,
    pageNumber: number,
    query: PdfSourcePageQuery,
  ): Promise<PdfSourcePage>;
  openPdfSourcePageImage(
    tenant: TenantContext,
    projectId: string,
    evidenceId: string,
    pageNumber: number,
  ): Promise<OpenedFileResource>;
  listAssets(
    tenant: TenantContext,
    projectId: string,
    options: { limit: number; offset: number },
  ): Promise<ResearchPage<ResearchAsset>>;
  saveAsset(
    tenant: TenantContext,
    projectId: string,
    input: SaveResearchAssetRequest,
  ): Promise<{
    asset: ResearchAsset;
    version: ResearchAssetVersion;
    references: ResearchAssetEvidenceReference[];
    created: boolean;
  }>;
  asset(
    tenant: TenantContext,
    projectId: string,
    assetId: string,
  ): Promise<{
    asset: ResearchAsset;
    version: ResearchAssetVersion | null;
    references: ResearchAssetEvidenceReference[];
  } | null>;
  assetVersions(
    tenant: TenantContext,
    projectId: string,
    assetId: string,
    options: { limit: number; offset: number },
  ): Promise<ResearchPage<ResearchAssetVersion>>;
  assetContext(
    tenant: TenantContext,
    projectId: string,
  ): Promise<{ assetIds: string[] }>;
  updateAssetContext(
    tenant: TenantContext,
    projectId: string,
    input: UpdateResearchAssetContextRequest,
  ): Promise<{ assetIds: string[] }>;
  updateAssetLifecycle(
    tenant: TenantContext,
    projectId: string,
    assetId: string,
    input: UpdateResearchAssetLifecycleRequest,
  ): Promise<ResearchAsset>;
  deleteAssets(
    tenant: TenantContext,
    projectId: string,
    input: DeleteResearchAssetsRequest,
  ): Promise<{
    deletedAssetIds: string[];
    retainedVersions: number;
    assetIds: string[];
  }>;
}

export interface SourceFolderService {
  listTree(
    tenant: TenantContext,
    projectId: string,
  ): Promise<readonly SourceFolderTreeEntry[]>;
  create(
    tenant: TenantContext,
    projectId: string,
    input: CreateSourceFolderRequest,
  ): Promise<{ readonly folder: SourceFolder; readonly created: boolean }>;
  update(
    tenant: TenantContext,
    projectId: string,
    folderId: string,
    input: UpdateSourceFolderRequest,
  ): Promise<SourceFolder>;
  remove(
    tenant: TenantContext,
    projectId: string,
    folderId: string,
  ): Promise<SourceFolder>;
  assignDocument(
    tenant: TenantContext,
    projectId: string,
    folderId: string,
    input: AssignSourceFolderDocumentRequest,
  ): Promise<{
    readonly assignment: SourceFolderAssignment;
    readonly created: boolean;
  }>;
  unassignDocument(
    tenant: TenantContext,
    projectId: string,
    folderId: string,
    documentId: string,
  ): Promise<boolean>;
  listAssignments(
    tenant: TenantContext,
    projectId: string,
    folderId?: string,
  ): Promise<readonly SourceFolderAssignment[]>;
}

export interface GlobalUploadFileInput {
  readonly filename: string;
  readonly mimeType: string | null;
  readonly contents: AsyncIterable<Uint8Array | string>;
}

export interface GlobalUploadService {
  create(
    tenant: TenantContext,
    input: {
      readonly idempotencyKey: string;
      readonly files: AsyncIterable<GlobalUploadFileInput>;
    },
  ): Promise<GlobalUploadBatchDetail>;
  getBatch(
    tenant: TenantContext,
    batchId: string,
  ): Promise<GlobalUploadBatchDetail>;
  listBatches(
    tenant: TenantContext,
    query: Partial<ListGlobalUploadBatchesQuery>,
  ): Promise<GlobalUploadBatchPage>;
  listItems(
    tenant: TenantContext,
    query: Partial<ListGlobalUploadItemsQuery>,
  ): Promise<GlobalUploadItemPage>;
  routeItem(
    tenant: TenantContext,
    itemId: string,
    input: RouteGlobalUploadItemRequest,
  ): Promise<GlobalUploadBatchDetail>;
}

export interface UploadSessionAttachmentInput {
  readonly filename: string;
  readonly mimeType: string;
  readonly contents: AsyncIterable<Uint8Array>;
  readonly signal?: AbortSignal;
}

export interface SessionResourcesService {
  deleteResource(
    tenant: TenantContext,
    sessionId: string,
    resourceId: string,
  ): Promise<DeleteSessionResourceResponse>;
  listResources(
    tenant: TenantContext,
    sessionId: string,
    options?: Partial<ListSessionResourcesQuery>,
  ): Promise<SessionResourcePage>;
  getResource(
    tenant: TenantContext,
    sessionId: string,
    resourceId: string,
  ): Promise<SessionResource>;
  deleteResources(
    tenant: TenantContext,
    sessionId: string,
  ): Promise<DeleteSessionResourcesResponse>;
  listAttachments(
    tenant: TenantContext,
    sessionId: string,
    options?: Partial<ListSessionAttachmentsQuery>,
  ): Promise<SessionAttachmentPage>;
  getAttachment(
    tenant: TenantContext,
    sessionId: string,
    attachmentId: string,
  ): Promise<SessionResource>;
  uploadAttachment(
    tenant: TenantContext,
    sessionId: string,
    input: UploadSessionAttachmentInput,
  ): Promise<SessionResource>;
  deleteAttachment(
    tenant: TenantContext,
    sessionId: string,
    attachmentId: string,
  ): Promise<DeleteSessionResourceResponse>;
  openAttachmentContent(
    tenant: TenantContext,
    sessionId: string,
    attachmentId: string,
  ): Promise<OpenedFileResource>;
  addResearchAssetResource(
    tenant: TenantContext,
    sessionId: string,
    input: CreateSessionResearchAssetResourceRequest,
  ): Promise<SessionResource>;
  addDocumentReferenceResource(
    tenant: TenantContext,
    sessionId: string,
    input: CreateSessionDocumentReferenceResourceRequest,
  ): Promise<SessionResource>;
}

export interface ProjectInsightsService {
  generateMemo(
    tenant: TenantContext,
    projectId: string,
    input: GenerateMemoRequest,
  ): Promise<{ job: Job; created: boolean }>;
  memoSeries(
    tenant: TenantContext,
    projectId: string,
    query: ListMemoVersionsQuery,
  ): Promise<unknown>;
  compareMemoVersions(
    tenant: TenantContext,
    projectId: string,
    fromVersionId: string,
    toVersionId: string,
  ): Promise<unknown>;
  openMemoArtifact(
    tenant: TenantContext,
    projectId: string,
    memoVersionId: string,
    format?: MemoArtifactFormat,
  ): Promise<OpenedFileResource>;
}

export interface ApiDependencies {
  identityProvider: RequestIdentityProvider;
  projects: ProjectService;
  sessions: SessionService;
  jobs?: JobService;
  research?: ResearchService;
  sourceFolders?: SourceFolderService;
  globalUploads?: GlobalUploadService;
  sessionResources?: SessionResourcesService;
  insights?: ProjectInsightsService;
  cloudAccounts?: {
    client: CloudAccountClient;
    service: CloudAuthService;
    cipher: SessionCipher;
  };
  modelGatewayAccessIssuer?: import("./model-gateway-access.js").ModelGatewayAccessIssuer;
}
