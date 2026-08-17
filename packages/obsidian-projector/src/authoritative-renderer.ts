import { createHash } from "node:crypto";

import {
  encodeJson,
  stableId,
  WorkflowStoreError,
  type JsonValue,
  type MemoVersionRecord,
  type ObsidianOutboxEvent,
  type Page,
  type ReportVersion,
  type ResearchItemRecord,
  type ValuationAgentAnalysis,
  type ValuationAnalysisVersion,
  type ValuationDerivedModel,
  type ValuationModelSeries,
  type ValuationModelVersion,
  type ValuationNodeValue,
  type WorkflowStore,
} from "@private-fund/workflow-store";

import {
  ObsidianProjectionError,
  type ObsidianEvidenceReference,
  type ObsidianProjectionNote,
  type ObsidianProjectionPlan,
  type ObsidianProjectionRenderContext,
  type ObsidianProjectionRenderer,
} from "./types.js";

const MAX_EVIDENCE_REFERENCES = 10_000;
const MAX_TIMELINE_RECORDS = 200;
const TOMBSTONE_EVENT_TYPES = new Set([
  "archive",
  "delete",
  "deleted",
  "tombstone",
]);

type PageLoader<T> = (offset: number, limit: number) => Page<T>;

interface EvidenceResult {
  readonly references: readonly ObsidianEvidenceReference[];
  readonly truncated: boolean;
}

function portableEntityId(value: string): string {
  const readable = value
    .normalize("NFKC")
    .replaceAll(/[^A-Za-z0-9._-]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 96);
  const suffix = createHash("sha256")
    .update(value, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `${readable.length === 0 ? "entity" : readable}--${suffix}`;
}

function sanitizeManagedText(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("<!-- PRIVATE-FUND:", "&lt;!-- PRIVATE-FUND:");
}

function oneLine(value: string): string {
  return sanitizeManagedText(value).replaceAll(/\s+/gu, " ").trim();
}

function heading(value: string): string {
  return oneLine(value).replaceAll(/([\\`*_{}[\]()#+.!>|-])/gu, "\\$1");
}

function tableCell(value: string | number | null): string {
  if (value === null) {
    return "—";
  }
  return sanitizeManagedText(String(value))
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\n", "<br>");
}

function sortedJson(value: unknown): string {
  const normalized = JSON.parse(encodeJson(value)) as JsonValue;
  return JSON.stringify(normalized, null, 2);
}

function indentedJson(value: unknown): string {
  return sortedJson(value)
    .split("\n")
    .map((line) => `    ${sanitizeManagedText(line)}`)
    .join("\n");
}

function collectAll<T>(
  loader: PageLoader<T>,
  limit = 500,
): readonly T[] {
  const result: T[] = [];
  let offset = 0;
  for (;;) {
    const page = loader(offset, limit);
    result.push(...page.items);
    if (!page.hasMore) {
      return result;
    }
    const nextOffset = page.offset + page.items.length;
    if (page.items.length === 0 || nextOffset <= offset) {
      throw new ObsidianProjectionError(
        "Repository pagination did not make forward progress",
        "invalid_projection",
        false,
      );
    }
    offset = nextOffset;
  }
}

function evidence(
  ids: readonly string[],
  relation = "supports",
): EvidenceResult {
  const unique = [...new Set(ids)]
    .filter((id) => id.length > 0)
    .sort((left, right) => left.localeCompare(right));
  return {
    references: unique
      .slice(0, MAX_EVIDENCE_REFERENCES)
      .map((evidenceId) => ({ evidenceId, relation, label: evidenceId })),
    truncated: unique.length > MAX_EVIDENCE_REFERENCES,
  };
}

function nestedEvidenceIds(value: JsonValue): readonly string[] {
  const result: string[] = [];
  const visit = (current: JsonValue, key: string | null): void => {
    if (typeof current === "string") {
      if (
        key === "evidenceId" ||
        key === "evidence_id" ||
        key === "evidenceRef" ||
        key === "evidence_ref"
      ) {
        result.push(current);
      }
      return;
    }
    if (Array.isArray(current)) {
      if (key === "evidenceIds" || key === "evidence_ids") {
        for (const item of current) {
          if (typeof item === "string") {
            result.push(item);
          } else {
            visit(item, null);
          }
        }
        return;
      }
      for (const item of current) {
        visit(item, null);
      }
      return;
    }
    if (current !== null && typeof current === "object") {
      for (const [childKey, child] of Object.entries(current)) {
        visit(child, childKey);
      }
    }
  };
  visit(value, null);
  return result;
}

function appendEvidenceWarning(
  body: string,
  result: EvidenceResult,
): string {
  if (!result.truncated) {
    return body;
  }
  return [
    body,
    "",
    "> [!warning] Evidence reference limit",
    `> The authoritative entity contains more than ${String(MAX_EVIDENCE_REFERENCES)} Evidence references. The deterministic first ${String(MAX_EVIDENCE_REFERENCES)} IDs are projected; the full relation set remains in SQLite.`,
  ].join("\n");
}

function isTombstone(event: ObsidianOutboxEvent): boolean {
  return TOMBSTONE_EVENT_TYPES.has(event.eventType);
}

function sourceVersionNumber(event: ObsidianOutboxEvent): number {
  if (!/^[1-9]\d*$/u.test(event.sourceVersion)) {
    throw new ObsidianProjectionError(
      `${event.entityType} sourceVersion must be a positive integer`,
      "invalid_projection",
      false,
    );
  }
  return Number(event.sourceVersion);
}

function assertDataset(
  expectedDatasetId: string,
  actualDatasetId: string,
  entity: string,
): void {
  if (actualDatasetId !== expectedDatasetId) {
    throw new ObsidianProjectionError(
      `${entity} does not belong to the bound dataset`,
      "invalid_projection",
      false,
    );
  }
}

function findExactVersion<T>(
  values: readonly T[],
  version: number,
  versionOf: (value: T) => number,
  label: string,
): T {
  const found = values.find((value) => versionOf(value) === version);
  if (found === undefined) {
    throw new ObsidianProjectionError(
      `${label} version ${String(version)} is not present in the authoritative repository`,
      "invalid_projection",
      false,
    );
  }
  return found;
}

function artifactLines(version: MemoVersionRecord): readonly string[] {
  const values = [
    ["Markdown", version.markdownPath],
    ["HTML", version.htmlPath],
    ["PDF", version.pdfPath],
  ] as const;
  const present = values.filter(([, value]) => value !== null);
  if (present.length === 0) {
    return [];
  }
  return [
    "",
    "## Artifacts",
    "",
    ...present.map(
      ([label, value]) =>
        `- ${label}: \`${sanitizeManagedText(value ?? "")}\``,
    ),
  ];
}

function memoBody(version: MemoVersionRecord): {
  readonly body: string;
  readonly evidence: EvidenceResult;
} {
  const evidenceResult = evidence(
    version.sections.flatMap((section) => section.evidenceIds),
  );
  const sections =
    version.sections.length === 0
      ? [
          "",
          "> [!warning] No memo sections",
          "> The authoritative Memo version has no structured sections.",
        ]
      : version.sections.flatMap((section) => [
          "",
          `## ${heading(section.title)}`,
          "",
          ...(section.needsReview
            ? [
                "> [!warning] Review required",
                "> This section is marked as requiring analyst review.",
                "",
              ]
            : []),
          sanitizeManagedText(section.content),
        ]);
  const body = [
    `# ${heading(version.seriesTitle)}`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Topic | ${tableCell(version.topic)} |`,
    `| Version | ${tableCell(version.versionNo)} |`,
    `| As of | ${tableCell(version.asOfDate)} |`,
    `| Status | ${tableCell(version.status)} |`,
    `| Source | ${tableCell(version.sourceType)} |`,
    `| Content hash | \`${tableCell(version.contentHash)}\` |`,
    ...sections,
    ...artifactLines(version),
  ].join("\n");
  return {
    body: appendEvidenceWarning(body, evidenceResult),
    evidence: evidenceResult,
  };
}

function trackingBody(
  item: ResearchItemRecord,
  timeline: ReturnType<WorkflowStore["tracking"]["getItemTimeline"]>,
): {
  readonly body: string;
  readonly evidence: EvidenceResult;
} {
  const versions = timeline.versions.slice(-MAX_TIMELINE_RECORDS);
  const changes = timeline.changes.slice(-MAX_TIMELINE_RECORDS);
  const observations = timeline.observations.slice(-MAX_TIMELINE_RECORDS);
  const current = item.currentVersion;
  const evidenceResult = evidence([
    ...(current?.evidenceIds ?? []),
    ...versions.flatMap((version) => version.evidenceIds),
    ...observations.flatMap((observation) => observation.evidenceIds),
  ]);
  const truncation =
    timeline.versions.length > versions.length ||
    timeline.changes.length > changes.length ||
    timeline.observations.length > observations.length;
  const body = [
    `# ${heading(item.title)}`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Type | ${tableCell(item.itemType)} |`,
    `| Canonical key | \`${tableCell(item.canonicalKey)}\` |`,
    `| Status | ${tableCell(item.status)} |`,
    `| Current version | ${tableCell(item.currentVersionNo)} |`,
    `| First seen | ${tableCell(item.firstSeenAt)} |`,
    `| Last seen | ${tableCell(item.lastSeenAt)} |`,
    "",
    "## Current view",
    "",
    current === null
      ? "> No current item version is available."
      : sanitizeManagedText(current.content),
    ...(current === null
      ? []
      : [
          "",
          "| Attribute | Value |",
          "| --- | --- |",
          `| Stance | ${tableCell(current.stance)} |`,
          `| State | ${tableCell(current.state)} |`,
          `| Impact | ${tableCell(current.impact)} |`,
          `| Confidence | ${tableCell(current.confidence)} |`,
          `| Value | ${tableCell(current.valueNumeric ?? current.valueText)} |`,
          `| Unit | ${tableCell(current.unit)} |`,
          `| Period | ${tableCell(current.period)} |`,
          `| Scenario | ${tableCell(current.scenario)} |`,
        ]),
    "",
    "## Version history",
    "",
    "| Version | Observed at | Source | Impact | Evidence |",
    "| ---: | --- | --- | --- | ---: |",
    ...versions.map(
      (version) =>
        `| ${tableCell(version.versionNo)} | ${tableCell(version.observedAt)} | ${tableCell(`${version.sourceType}:${version.sourceId}`)} | ${tableCell(version.impact)} | ${tableCell(version.evidenceIds.length)} |`,
    ),
    "",
    "## Material changes",
    "",
    ...(changes.length === 0
      ? ["> No material changes are recorded."]
      : changes.map(
          (change) =>
            `- **${heading(change.materiality)} / ${heading(change.changeType)}** — ${sanitizeManagedText(change.summary)}`,
        )),
    "",
    "## Observations",
    "",
    ...(observations.length === 0
      ? ["> No source observations are recorded."]
      : observations.map(
          (observation) =>
            `- ${sanitizeManagedText(observation.observedAt)} · \`${sanitizeManagedText(observation.sourceType)}:${sanitizeManagedText(observation.sourceId)}\` — ${sanitizeManagedText(observation.content)}`,
        )),
    ...(truncation
      ? [
          "",
          "> [!info] Timeline window",
          `> Each timeline collection is limited to its latest ${String(MAX_TIMELINE_RECORDS)} records in this note. SQLite remains authoritative for the full history.`,
        ]
      : []),
  ].join("\n");
  return {
    body: appendEvidenceWarning(body, evidenceResult),
    evidence: evidenceResult,
  };
}

function modelValue(value: ValuationNodeValue | undefined): string {
  if (value === undefined) {
    return "—";
  }
  if (value.valueNumeric !== null) {
    return `${String(value.valueNumeric)}${value.unit === null ? "" : ` ${value.unit}`}`;
  }
  return value.valueText ?? "—";
}

function valuationModelBody(
  series: ValuationModelSeries,
  version: ValuationModelVersion,
  store: WorkflowStore,
): {
  readonly body: string;
  readonly evidence: EvidenceResult;
} {
  const nodes = collectAll((offset, limit) =>
    store.valuation.listNodes(series.seriesId, { offset, limit }),
  );
  const values = collectAll((offset, limit) =>
    store.valuation.listNodeValues(version.modelVersionId, { offset, limit }),
  );
  const byNode = new Map(values.map((value) => [value.nodeId, value]));
  const versionNodes = nodes.filter((node) => byNode.has(node.nodeId));
  const analyses = collectAll((offset, limit) =>
    store.valuation.listAnalysisVersions(
      series.datasetId,
      series.seriesId,
      { offset, limit },
    ),
  ).filter((analysis) => analysis.modelVersionId === version.modelVersionId);
  const evidenceResult = evidence(values.map((value) => value.evidenceId));
  const body = [
    `# ${heading(series.name)}`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Company | ${tableCell(series.companyName)} |`,
    `| Ticker | ${tableCell(series.companyTicker)} |`,
    `| Model type | ${tableCell(version.modelType ?? series.modelType)} |`,
    `| Model version | ${tableCell(version.documentVersionNo)} |`,
    `| Source document | \`${tableCell(version.docId)}\` |`,
    `| Original filename | ${tableCell(version.originalFilename)} |`,
    `| Checksum | \`${tableCell(version.checksum)}\` |`,
    `| Analyzer | ${tableCell(version.analyzerVersion)} |`,
    `| Review required | ${tableCell(version.reviewRequiredCount)} |`,
    "",
    "## Model nodes",
    "",
    "| Metric | Scope | Period | Scenario | Value | Formula | Cell | Quality |",
    "| --- | --- | --- | --- | ---: | --- | --- | --- |",
    ...versionNodes.map((node) => {
      const value = byNode.get(node.nodeId);
      return `| ${tableCell(node.displayName)} | ${tableCell(node.scope)} | ${tableCell(node.period)} | ${tableCell(node.scenario)} | ${tableCell(modelValue(value))} | ${tableCell(value?.formula ?? null)} | ${tableCell(value === undefined ? null : `${value.sheetName}!${value.cellRef}`)} | ${tableCell(value?.qualityStatus ?? null)} |`;
    }),
    "",
    "## Repository analyses",
    "",
    ...(analyses.length === 0
      ? ["> No analysis version is attached to this model version."]
      : analyses.flatMap((analysis) => [
          `### ${heading(analysis.analysisVersionId)}`,
          "",
          sanitizeManagedText(analysis.summaryMarkdown),
          "",
        ])),
  ].join("\n");
  return {
    body: appendEvidenceWarning(body, evidenceResult),
    evidence: evidenceResult,
  };
}

function agentAnalysisBody(
  analysis: ValuationAgentAnalysis,
): {
  readonly body: string;
  readonly evidence: EvidenceResult;
} {
  const evidenceResult = evidence(analysis.evidenceIds);
  const body = [
    `# Valuation analysis ${heading(analysis.analysisId)}`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Status | ${tableCell(analysis.status)} |`,
    `| Series | \`${tableCell(analysis.seriesId)}\` |`,
    `| Base model | \`${tableCell(analysis.baseModelVersionId)}\` |`,
    `| Comparison model | ${analysis.comparisonModelVersionId === null ? "—" : `\`${tableCell(analysis.comparisonModelVersionId)}\``} |`,
    `| Focus | ${tableCell(analysis.focus)} |`,
    `| Method | ${tableCell(analysis.valuationMethod)} |`,
    `| Agent version | ${tableCell(analysis.agentVersion)} |`,
    `| Model | ${tableCell(analysis.modelName)} |`,
    "",
    "## Executive summary",
    "",
    sanitizeManagedText(analysis.executiveSummary ?? "No executive summary."),
    "",
    "## Investment conclusion",
    "",
    sanitizeManagedText(
      analysis.investmentConclusion ?? "No investment conclusion.",
    ),
    ...(analysis.errorMessage === null
      ? []
      : [
          "",
          "## Failure",
          "",
          `> ${sanitizeManagedText(analysis.errorMessage)}`,
        ]),
    "",
    "## Structured analysis",
    "",
    indentedJson(analysis.analysis),
    "",
    "## Planner",
    "",
    indentedJson(analysis.planner),
  ].join("\n");
  return {
    body: appendEvidenceWarning(body, evidenceResult),
    evidence: evidenceResult,
  };
}

function analysisVersionBody(analysis: ValuationAnalysisVersion): string {
  return [
    `# Valuation repository analysis ${heading(analysis.analysisVersionId)}`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Status | ${tableCell(analysis.status)} |`,
    `| Series | \`${tableCell(analysis.seriesId)}\` |`,
    `| Model version | \`${tableCell(analysis.modelVersionId)}\` |`,
    `| Analyzer | ${tableCell(analysis.analyzerVersion)} |`,
    "",
    "## Summary",
    "",
    sanitizeManagedText(analysis.summaryMarkdown),
    "",
    "## Structured analysis",
    "",
    indentedJson(analysis.analysis),
  ].join("\n");
}

function derivedModelBody(model: ValuationDerivedModel): string {
  return [
    `# Derived valuation model ${heading(model.derivedModelId)}`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Series | \`${tableCell(model.seriesId)}\` |`,
    `| Analysis | \`${tableCell(model.analysisId)}\` |`,
    `| Base model | \`${tableCell(model.baseModelVersionId)}\` |`,
    `| Derived version | ${tableCell(model.derivedVersionNo)} |`,
    `| Output file | ${tableCell(model.outputFilename)} |`,
    `| Output path | \`${tableCell(model.outputPath)}\` |`,
    `| Checksum | \`${tableCell(model.checksum)}\` |`,
    `| Resource status | ${tableCell(model.resourceStatus)} |`,
    `| Resource document | ${model.resourceDocId === null ? "—" : `\`${tableCell(model.resourceDocId)}\``} |`,
    "",
    "## Applied changes",
    "",
    indentedJson(model.appliedChanges),
    "",
    "## Skipped changes",
    "",
    indentedJson(model.skippedChanges),
    ...(model.resourceError === null
      ? []
      : [
          "",
          "## Resource error",
          "",
          `> ${sanitizeManagedText(model.resourceError)}`,
        ]),
  ].join("\n");
}

function reportEvidence(
  report: ReportVersion,
  store: WorkflowStore,
  workflowId: string,
): EvidenceResult {
  const ids: string[] = [];
  for (const [nodeId, value] of Object.entries(report.nodeVersions)) {
    if (typeof value !== "string") {
      throw new ObsidianProjectionError(
        `Workflow report node version for ${nodeId} is not an ID`,
        "invalid_projection",
        false,
      );
    }
    const nodeVersion = store.workflow.getNodeVersion(value);
    if (
      nodeVersion.workflowId !== workflowId ||
      nodeVersion.nodeId !== nodeId
    ) {
      throw new ObsidianProjectionError(
        `Workflow report node binding ${nodeId}/${value} crosses its report workflow`,
        "invalid_projection",
        false,
      );
    }
    ids.push(...nodeVersion.evidenceIds);
  }
  return evidence(ids);
}

function workflowReportBody(
  title: string,
  reportType: string,
  workflowId: string,
  version: ReportVersion,
): string {
  return [
    `# ${heading(title)}`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Report type | ${tableCell(reportType)} |`,
    `| Workflow | \`${tableCell(workflowId)}\` |`,
    `| Version | ${tableCell(version.versionNo)} |`,
    `| Created | ${tableCell(version.createdAt)} |`,
    "",
    "## Report",
    "",
    sanitizeManagedText(version.markdown),
    "",
    "## Bound document versions",
    "",
    indentedJson(version.documentVersions),
  ].join("\n");
}

function pathFor(entityType: string, entityId: string): string {
  const filename = `${portableEntityId(entityId)}.md`;
  switch (entityType) {
    case "memo-series":
    case "memo-version":
      return `memos/${filename}`;
    case "tracking-item":
    case "research-item":
      return `tracking/${filename}`;
    case "valuation-series":
    case "valuation-model":
    case "valuation-model-version":
      return `valuations/models/${filename}`;
    case "valuation-analysis":
    case "valuation-analysis-version":
      return `valuations/analyses/${filename}`;
    case "valuation-derived":
      return `valuations/derived/${filename}`;
    case "workflow-report":
    case "report":
      return `workflows/reports/${filename}`;
    default:
      throw new ObsidianProjectionError(
        `Unsupported authoritative projection entity type: ${entityType}`,
        "invalid_projection",
        false,
      );
  }
}

function tombstoneNote(event: ObsidianOutboxEvent): ObsidianProjectionNote {
  return {
    relativePath: pathFor(event.entityType, event.entityId),
    title: `Archived ${event.entityType} ${event.entityId}`,
    body: "The authoritative entity was removed or archived in SQLite.",
    disposition: "tombstone",
    metadata: {
      authoritative_entity_type: event.entityType,
      authoritative_entity_id: event.entityId,
    },
  };
}

function metadata(
  event: ObsidianOutboxEvent,
  values: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  return {
    authoritative_store: "research.sqlite3",
    authoritative_entity_type: event.entityType,
    authoritative_entity_id: event.entityId,
    ...values,
  };
}

/**
 * Renders only authoritative repository state. Outbox payload fields are never
 * used as content; they are advisory locators at most. Entity ownership and
 * sourceVersion are checked against SQLite before a note is returned.
 */
export class AuthoritativeObsidianRenderer {
  public constructor(private readonly store: WorkflowStore) {}

  public readonly render: ObsidianProjectionRenderer = (
    context,
  ): ObsidianProjectionPlan => {
    try {
      return this.#render(context);
    } catch (error) {
      if (error instanceof ObsidianProjectionError) {
        throw error;
      }
      if (error instanceof WorkflowStoreError) {
        throw new ObsidianProjectionError(
          `Authoritative repository rejected ${context.event.entityType}/${context.event.entityId}: ${error.message}`,
          "invalid_projection",
          false,
          { cause: error },
        );
      }
      throw error;
    }
  };

  #render(context: ObsidianProjectionRenderContext): ObsidianProjectionPlan {
    const { event, binding } = context;
    assertDataset(binding.datasetId, event.datasetId, "Outbox event");
    if (isTombstone(event)) {
      return { notes: [tombstoneNote(event)] };
    }
    switch (event.entityType) {
      case "memo-series":
        return { notes: [this.#memoSeries(event)] };
      case "memo-version":
        return { notes: [this.#memoVersion(event)] };
      case "tracking-item":
      case "research-item":
        return { notes: [this.#trackingItem(event)] };
      case "valuation-series":
      case "valuation-model":
        return { notes: [this.#valuationSeries(event)] };
      case "valuation-model-version":
        return { notes: [this.#valuationModelVersion(event)] };
      case "valuation-analysis":
        return { notes: [this.#valuationAnalysis(event)] };
      case "valuation-analysis-version":
        return { notes: [this.#valuationAnalysisVersion(event)] };
      case "valuation-derived":
        return { notes: [this.#valuationDerived(event)] };
      case "workflow-report":
      case "report":
        return { notes: [this.#workflowReport(event)] };
      default:
        throw new ObsidianProjectionError(
          `Unsupported authoritative projection entity type: ${event.entityType}`,
          "invalid_projection",
          false,
        );
    }
  }

  #memoSeries(event: ObsidianOutboxEvent): ObsidianProjectionNote {
    const series = collectAll((offset, limit) =>
      this.store.tracking.listMemoSeries(event.datasetId, { offset, limit }),
    ).find((candidate) => candidate.seriesId === event.entityId);
    if (series === undefined) {
      throw new ObsidianProjectionError(
        `Memo series ${event.entityId} was not found`,
        "invalid_projection",
        false,
      );
    }
    const versionNo = sourceVersionNumber(event);
    const version = findExactVersion(
      collectAll((offset, limit) =>
        this.store.tracking.listMemoVersions(event.datasetId, {
          seriesId: series.seriesId,
          offset,
          limit,
        }),
      ),
      versionNo,
      (candidate) => candidate.versionNo,
      "Memo",
    );
    const rendered = memoBody(version);
    return {
      relativePath: pathFor(event.entityType, event.entityId),
      title: version.seriesTitle,
      body: rendered.body,
      evidence: rendered.evidence.references,
      metadata: metadata(event, {
        memo_version_id: version.memoVersionId,
        version_no: version.versionNo,
        as_of_date: version.asOfDate,
        status: version.status,
      }),
    };
  }

  #memoVersion(event: ObsidianOutboxEvent): ObsidianProjectionNote {
    const version = this.store.tracking.getMemoVersion(
      event.datasetId,
      event.entityId,
    );
    if (
      event.sourceVersion !== version.memoVersionId &&
      event.sourceVersion !== String(version.versionNo)
    ) {
      throw new ObsidianProjectionError(
        "Memo-version sourceVersion does not match the authoritative version",
        "invalid_projection",
        false,
      );
    }
    const rendered = memoBody(version);
    return {
      relativePath: pathFor(event.entityType, event.entityId),
      title: version.seriesTitle,
      body: rendered.body,
      evidence: rendered.evidence.references,
      metadata: metadata(event, {
        series_id: version.seriesId,
        version_no: version.versionNo,
        as_of_date: version.asOfDate,
      }),
    };
  }

  #trackingItem(event: ObsidianOutboxEvent): ObsidianProjectionNote {
    const timeline = this.store.tracking.getItemTimeline(
      event.datasetId,
      event.entityId,
    );
    const versionNo = sourceVersionNumber(event);
    const exactVersion = timeline.versions.find(
      (version) => version.versionNo === versionNo,
    );
    if (exactVersion === undefined) {
      throw new ObsidianProjectionError(
        `Tracking item version ${String(versionNo)} was not found`,
        "invalid_projection",
        false,
      );
    }
    const exactItem: ResearchItemRecord = {
      ...timeline.item,
      currentVersionNo: versionNo,
      currentVersionId: exactVersion.itemVersionId,
      currentVersion: exactVersion,
      lastSeenAt: exactVersion.observedAt,
      updatedAt: exactVersion.createdAt,
    };
    const includedVersions = timeline.versions.filter(
      (version) => version.versionNo <= versionNo,
    );
    const includedVersionIds = new Set(
      includedVersions.map((version) => version.itemVersionId),
    );
    const exactTimeline = {
      item: exactItem,
      versions: includedVersions,
      changes: timeline.changes.filter((change) =>
        includedVersionIds.has(change.newVersionId),
      ),
      observations: timeline.observations.filter((observation) =>
        observation.itemVersionId === null
          ? observation.observedAt <= exactVersion.observedAt
          : includedVersionIds.has(observation.itemVersionId),
      ),
    };
    const rendered = trackingBody(exactItem, exactTimeline);
    return {
      relativePath: pathFor(event.entityType, event.entityId),
      title: exactItem.title,
      body: rendered.body,
      evidence: rendered.evidence.references,
      metadata: metadata(event, {
        item_type: exactItem.itemType,
        canonical_key: exactItem.canonicalKey,
        version_no: versionNo,
        status: exactItem.status,
      }),
    };
  }

  #valuationSeries(event: ObsidianOutboxEvent): ObsidianProjectionNote {
    const series = this.store.valuation.getSeries(
      event.datasetId,
      event.entityId,
    );
    const versionNo = sourceVersionNumber(event);
    const version = findExactVersion(
      collectAll((offset, limit) =>
        this.store.valuation.listModelVersions(
          event.datasetId,
          series.seriesId,
          { offset, limit },
        ),
      ),
      versionNo,
      (candidate) => candidate.documentVersionNo,
      "Valuation model",
    );
    const rendered = valuationModelBody(series, version, this.store);
    return {
      relativePath: pathFor(event.entityType, event.entityId),
      title: series.name,
      body: rendered.body,
      evidence: rendered.evidence.references,
      metadata: metadata(event, {
        model_version_id: version.modelVersionId,
        document_version_no: version.documentVersionNo,
        company_name: series.companyName,
        company_ticker: series.companyTicker,
        series_status: series.status,
      }),
    };
  }

  #valuationModelVersion(event: ObsidianOutboxEvent): ObsidianProjectionNote {
    const version = this.store.valuation.getModelVersion(
      event.datasetId,
      event.entityId,
    );
    if (
      event.sourceVersion !== version.modelVersionId &&
      event.sourceVersion !== String(version.documentVersionNo) &&
      event.sourceVersion !== version.snapshotHash
    ) {
      throw new ObsidianProjectionError(
        "Valuation model sourceVersion does not match the authoritative version",
        "invalid_projection",
        false,
      );
    }
    const series = this.store.valuation.getSeries(
      event.datasetId,
      version.seriesId,
    );
    const rendered = valuationModelBody(series, version, this.store);
    return {
      relativePath: pathFor(event.entityType, event.entityId),
      title: `${series.name} v${String(version.documentVersionNo)}`,
      body: rendered.body,
      evidence: rendered.evidence.references,
      metadata: metadata(event, {
        series_id: series.seriesId,
        document_version_no: version.documentVersionNo,
      }),
    };
  }

  #valuationAnalysis(event: ObsidianOutboxEvent): ObsidianProjectionNote {
    const analysis = this.store.valuation.getAgentAnalysis(
      event.datasetId,
      event.entityId,
    );
    if (analysis.updatedAt !== event.sourceVersion) {
      throw new ObsidianProjectionError(
        "Valuation analysis sourceVersion does not match updatedAt",
        "invalid_projection",
        false,
      );
    }
    const rendered = agentAnalysisBody(analysis);
    return {
      relativePath: pathFor(event.entityType, event.entityId),
      title: `Valuation analysis ${analysis.analysisId}`,
      body: rendered.body,
      evidence: rendered.evidence.references,
      metadata: metadata(event, {
        series_id: analysis.seriesId,
        base_model_version_id: analysis.baseModelVersionId,
        status: analysis.status,
        updated_at: analysis.updatedAt,
      }),
    };
  }

  #valuationAnalysisVersion(
    event: ObsidianOutboxEvent,
  ): ObsidianProjectionNote {
    const analysis = this.store.valuation.getAnalysisVersion(
      event.datasetId,
      event.entityId,
    );
    if (
      event.sourceVersion !== analysis.analysisVersionId &&
      event.sourceVersion !== analysis.createdAt
    ) {
      throw new ObsidianProjectionError(
        "Valuation analysis-version sourceVersion does not match SQLite",
        "invalid_projection",
        false,
      );
    }
    return {
      relativePath: pathFor(event.entityType, event.entityId),
      title: `Valuation repository analysis ${analysis.analysisVersionId}`,
      body: analysisVersionBody(analysis),
      evidence: evidence(
        nestedEvidenceIds(analysis.analysis as JsonValue),
      ).references,
      metadata: metadata(event, {
        series_id: analysis.seriesId,
        model_version_id: analysis.modelVersionId,
        status: analysis.status,
      }),
    };
  }

  #valuationDerived(event: ObsidianOutboxEvent): ObsidianProjectionNote {
    const model = this.store.valuation.getDerivedModel(
      event.datasetId,
      event.entityId,
    );
    const expected = stableId(
      "projection",
      model.checksum,
      model.resourceStatus,
      model.resourceDocId,
      model.resourceError,
    );
    if (event.sourceVersion !== expected) {
      throw new ObsidianProjectionError(
        "Derived valuation sourceVersion does not match SQLite",
        "invalid_projection",
        false,
      );
    }
    return {
      relativePath: pathFor(event.entityType, event.entityId),
      title: `Derived valuation model ${model.derivedModelId}`,
      body: derivedModelBody(model),
      evidence: evidence([
        ...nestedEvidenceIds(model.appliedChanges),
        ...nestedEvidenceIds(model.skippedChanges),
      ]).references,
      metadata: metadata(event, {
        series_id: model.seriesId,
        analysis_id: model.analysisId,
        resource_status: model.resourceStatus,
      }),
    };
  }

  #workflowReport(event: ObsidianOutboxEvent): ObsidianProjectionNote {
    const report = this.store.workflow.getReport(event.entityId);
    const workflow = this.store.workflow.getWorkflow(report.workflowId);
    assertDataset(event.datasetId, workflow.datasetId, "Workflow report");
    const versionNo = sourceVersionNumber(event);
    const version = findExactVersion(
      collectAll((offset, limit) =>
        this.store.workflow.listReportVersions(report.reportId, {
          offset,
          limit,
        }),
      ),
      versionNo,
      (candidate) => candidate.versionNo,
      "Workflow report",
    );
    const evidenceResult = reportEvidence(
      version,
      this.store,
      report.workflowId,
    );
    const body = appendEvidenceWarning(
      workflowReportBody(
        report.title,
        report.reportType,
        report.workflowId,
        version,
      ),
      evidenceResult,
    );
    return {
      relativePath: pathFor(event.entityType, event.entityId),
      title: report.title,
      body,
      evidence: evidenceResult.references,
      metadata: metadata(event, {
        workflow_id: report.workflowId,
        report_type: report.reportType,
        report_version_id: version.reportVersionId,
        version_no: version.versionNo,
      }),
    };
  }
}
