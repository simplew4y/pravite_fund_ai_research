export type DocumentStatus = "active" | "removed" | "archived";
export type DocumentVersionStatus =
  | "parsing"
  | "indexed"
  | "needs_ocr"
  | "failed"
  | "review_required";
export type DocumentLifecycle =
  | "pending"
  | "active"
  | "superseded"
  | "removed"
  | "failed_attempt";

export interface DocumentRecord {
  readonly id: string;
  readonly logicalKey: string;
  readonly sourceRoot: string | null;
  readonly sourceRelpath: string;
  readonly title: string;
  readonly status: DocumentStatus;
  readonly currentVersionId: string | null;
  readonly currentVersionNo: number;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface DocumentVersionRecord {
  readonly id: string;
  readonly documentId: string;
  readonly versionNo: number;
  readonly supersedesVersionId: string | null;
  readonly sha256: string;
  readonly originalFilename: string;
  readonly storedPath: string;
  readonly fileType: string;
  readonly mimeType: string | null;
  readonly fileSize: number;
  readonly status: DocumentVersionStatus;
  readonly lifecycle: DocumentLifecycle;
  readonly parserName: string | null;
  readonly parserVersion: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RegisterDocumentVersionInput {
  readonly documentId?: string;
  readonly logicalKey?: string;
  readonly sourceRoot?: string | null;
  readonly sourceRelpath: string;
  readonly title: string;
  readonly originalFilename: string;
  readonly storedPath: string;
  readonly fileType: string;
  readonly mimeType?: string | null;
  readonly sha256: string;
  readonly fileSize: number;
  readonly status?: DocumentVersionStatus;
  readonly parserName?: string | null;
  readonly parserVersion?: string | null;
  readonly metadata?: Record<string, unknown>;
  readonly activate?: boolean;
}

export interface RegisterDocumentVersionResult {
  readonly document: DocumentRecord;
  readonly version: DocumentVersionRecord;
  readonly created: boolean;
}

export interface RemoveDocumentsResult {
  readonly documents: readonly DocumentRecord[];
  readonly deletedDocumentIds: readonly string[];
  readonly alreadyRemovedDocumentIds: readonly string[];
}

export interface DocumentTextPreviewContent {
  readonly chunkCount: number;
  readonly contentMarkdown: string;
  readonly truncated: boolean;
}

export type EvidenceKind = "chunk" | "fact" | "cell" | "page";

export interface EvidenceLocator {
  readonly displayText?: string;
  readonly sourceRef?: string;
  readonly pageStart?: number;
  readonly pageEnd?: number;
  readonly pageNumbers?: number[];
  readonly bbox?: [number, number, number, number];
  readonly slideStart?: number;
  readonly slideEnd?: number;
  readonly sheetName?: string;
  readonly cellRange?: string;
  readonly cellRef?: string;
  readonly headingPath?: string;
  readonly formula?: string;
  readonly displayValue?: string;
  readonly rawValue?: string;
}

export interface EvidenceRecord {
  readonly evidenceId: string;
  readonly kind: EvidenceKind;
  readonly documentVersionId: string;
  readonly title: string | null;
  readonly summary: string | null;
  readonly originalText: string;
  readonly contentHash: string;
  readonly locator: EvidenceLocator;
  readonly pageStart: number | null;
  readonly pageEnd: number | null;
  readonly bbox: [number, number, number, number] | null;
  readonly sheetName: string | null;
  readonly cellRange: string | null;
  readonly cellRef: string | null;
  readonly formula: string | null;
  readonly displayValue: string | null;
  readonly rawValue: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
}

export interface PutEvidenceInput {
  readonly evidenceId: string;
  readonly kind: EvidenceKind;
  readonly documentVersionId: string;
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly originalText: string;
  readonly locator?: EvidenceLocator;
  readonly metadata?: Record<string, unknown>;
}

export interface PutEvidenceResult {
  readonly evidence: EvidenceRecord;
  readonly created: boolean;
}

export interface EvidenceTrace extends EvidenceRecord {
  readonly document: DocumentRecord;
  readonly documentVersion: DocumentVersionRecord;
}

export interface ExcelEvidenceCell {
  readonly evidence: EvidenceRecord;
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly numericValue: number | null;
  readonly cachedValue: string | null;
  readonly numberFormat: string | null;
  readonly rowLabel: string | null;
  readonly columnLabel: string | null;
  readonly period: string | null;
  readonly unit: string | null;
}

export interface ExcelEvidenceSheetStats {
  readonly sheetName: string;
  readonly rowMin: number;
  readonly rowMax: number;
  readonly columnMin: number;
  readonly columnMax: number;
  readonly nonEmptyCellCount: number;
  readonly formulaCount: number;
}

export type ResearchAssetStatus =
  | "draft"
  | "running"
  | "completed"
  | "stale"
  | "failed"
  | "archived";

export interface ResearchAssetRecord {
  readonly id: string;
  readonly assetType: string;
  readonly title: string;
  readonly status: ResearchAssetStatus;
  readonly currentVersionId: string | null;
  readonly currentVersionNo: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
}

export interface ResearchAssetVersionRecord {
  readonly id: string;
  readonly assetId: string;
  readonly versionNo: number;
  readonly status: ResearchAssetStatus;
  readonly summary: string;
  readonly contentMarkdown: string;
  readonly contentHash: string;
  readonly sourceResponseId: string | null;
  readonly structuredContent: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
  readonly tags: string[];
  readonly createdAt: string;
}

export interface ResearchAssetEvidenceReference {
  readonly assetVersionId: string;
  readonly evidenceId: string;
  readonly relationType: string;
  readonly quote: string | null;
  readonly createdAt: string;
}

export interface SaveResearchAssetInput {
  readonly assetId?: string;
  readonly assetType: string;
  readonly title: string;
  readonly status?: ResearchAssetStatus;
  readonly summary?: string;
  readonly contentMarkdown: string;
  readonly sourceResponseId?: string | null;
  readonly structuredContent?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
  readonly tags?: readonly string[];
  readonly evidence?: readonly {
    readonly evidenceId: string;
    readonly relationType?: string;
    readonly quote?: string | null;
  }[];
}

export interface SaveResearchAssetResult {
  readonly asset: ResearchAssetRecord;
  readonly version: ResearchAssetVersionRecord;
  readonly references: ResearchAssetEvidenceReference[];
  readonly created: boolean;
}

export interface ResolvedResearchAssetVersion {
  readonly version: ResearchAssetVersionRecord;
  readonly references: ResearchAssetEvidenceReference[];
  readonly evidence: EvidenceTrace[];
}

export interface PageOptions {
  readonly limit?: number;
  readonly offset?: number;
}

export interface Page<T> {
  readonly items: T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
}

export type SearchBackend =
  | "fts5-trigram"
  | "fts5-unicode61"
  | "deterministic";

export interface EvidenceSearchOptions extends PageOptions {
  readonly query: string;
  readonly kinds?: readonly EvidenceKind[];
  readonly includeHistorical?: boolean;
}

export interface EvidenceSearchHit {
  readonly evidence: EvidenceTrace;
  readonly score: number;
}
