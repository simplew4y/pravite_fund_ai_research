import { createHash } from "node:crypto";
import {
  mkdir,
  link,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import type {
  EvidenceRecord,
  ResearchStore,
} from "@private-fund/research-store";
import {
  createResearchStore,
  openProjectDatabase,
} from "@private-fund/research-store";
import {
  createWorkflowStore,
  type TrackingItemType,
  type TrackingPriority,
  type WorkflowStore,
} from "@private-fund/workflow-store";
import type {
  DurableJob,
  EnqueueJobInput,
  EnqueueJobResult,
} from "@private-fund/job-queue";

export const BUSINESS_JOB_TYPES = ["memo.generate"] as const;

export type BusinessJobType = (typeof BUSINESS_JOB_TYPES)[number];

export interface BusinessJob
  extends Pick<
    DurableJob,
    | "id"
    | "type"
    | "payload"
    | "attempt"
    | "tenantNamespace"
    | "projectId"
    | "createdAt"
  > {}

export interface BusinessExecutionOptions {
  readonly signal?: AbortSignal;
}

export interface ChildJobEnqueuer {
  enqueue(input: EnqueueJobInput): EnqueueJobResult;
}

export interface BusinessJobExecutorOptions {
  readonly dataRoot: string;
  readonly childJobs?: ChildJobEnqueuer;
  readonly maxEvidenceRecords?: number;
}

export class BusinessJobError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | "invalid_business_job"
      | "business_path_violation"
      | "business_data_conflict"
      | "business_limit_exceeded",
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BusinessJobError";
  }
}

interface ProjectContext {
  readonly projectRoot: string;
  readonly research: ResearchStore;
  readonly workflow: WorkflowStore;
  close(): void;
}

interface EvidenceSource {
  readonly evidence: EvidenceRecord;
  readonly documentId: string;
  readonly logicalKey: string;
  readonly documentTitle: string;
  readonly documentVersionId: string;
  readonly documentVersionNo: number;
}

interface ClassifiedEvidence {
  readonly type: TrackingItemType;
  readonly priority: TrackingPriority;
  readonly source: EvidenceSource;
  readonly title: string;
  readonly content: string;
  readonly canonicalKey: string;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const TENANT_NAMESPACE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_EVIDENCE_RECORDS = 50_000;
const MEMO_EVIDENCE_LIMIT = 80;

const TRACKING_PATTERNS: ReadonlyArray<{
  readonly type: TrackingItemType;
  readonly pattern: RegExp;
  readonly priority: TrackingPriority;
}> = [
  {
    type: "risk",
    pattern:
      /(?:风险|下滑|下降|亏损|减值|违约|诉讼|不确定|压力|恶化|削弱|risk|declin|loss|impair|default|litigation|uncertain|pressure)/iu,
    priority: "high",
  },
  {
    type: "catalyst",
    pattern:
      /(?:催化|获批|中标|回购|扩产|发布|上线|突破|改善|加速|catalyst|approval|award|buyback|expansion|launch|breakthrough|improv|accelerat)/iu,
    priority: "high",
  },
  {
    type: "assumption",
    pattern:
      /(?:假设|预计|预期|预测|测算|基于.*假定|assum|expect|forecast|estimate)/iu,
    priority: "medium",
  },
  {
    type: "question",
    pattern:
      /(?:待核实|待验证|尚不明确|需要确认|unknown|verify|to be confirmed|open question|\?)/iu,
    priority: "medium",
  },
  {
    type: "metric",
    pattern:
      /(?:收入|营收|利润|毛利率|净利率|现金流|负债率|市盈率|估值|revenue|profit|margin|cash flow|debt|p\/?e|valuation).{0,80}(?:[-+]?\d[\d,.]*%?)/iu,
    priority: "medium",
  },
  {
    type: "thesis",
    pattern:
      /(?:核心逻辑|投资逻辑|竞争优势|护城河|长期价值|investment thesis|competitive advantage|moat|long-term value)/iu,
    priority: "medium",
  },
];

function failure(
  message: string,
  code: BusinessJobError["code"],
  retryable = false,
  cause?: unknown,
): BusinessJobError {
  return new BusinessJobError(
    message,
    code,
    retryable,
    cause === undefined ? undefined : { cause },
  );
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function optionalStringPayload(
  payload: Record<string, unknown>,
  name: string,
): string | null {
  const value = payload[name];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw failure(
      `Business job payload.${name} must be a non-empty string or null`,
      "invalid_business_job",
    );
  }
  return value;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalText(value: string, maximum: number): string {
  return value
    .normalize("NFKC")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

async function writeNewOrIdentical(
  destination: string,
  contents: Buffer,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${sha256(destination).slice(0, 12)}`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, destination);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
      const existing = await readFile(destination);
      if (!existing.equals(contents)) {
        throw failure(
          "A generated business artifact already exists with different bytes",
          "business_data_conflict",
        );
      }
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((error: unknown) => {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    });
  }
}

export class RepositoryBusinessJobExecutor {
  readonly #dataRoot: string;
  readonly #childJobs: ChildJobEnqueuer | undefined;
  readonly #maxEvidenceRecords: number;

  public constructor(options: BusinessJobExecutorOptions) {
    if (!path.isAbsolute(options.dataRoot)) {
      throw new RangeError("Business job dataRoot must be absolute");
    }
    this.#dataRoot = path.resolve(options.dataRoot);
    this.#childJobs = options.childJobs;
    this.#maxEvidenceRecords =
      options.maxEvidenceRecords ?? DEFAULT_MAX_EVIDENCE_RECORDS;
    if (
      !Number.isSafeInteger(this.#maxEvidenceRecords) ||
      this.#maxEvidenceRecords <= 0
    ) {
      throw new RangeError("maxEvidenceRecords must be a positive integer");
    }
  }

  public async execute(
    job: BusinessJob,
    execution: BusinessExecutionOptions = {},
  ): Promise<Record<string, unknown>> {
    execution.signal?.throwIfAborted();
    if (
      !IDENTIFIER.test(job.id) ||
      !IDENTIFIER.test(job.projectId) ||
      !TENANT_NAMESPACE.test(job.tenantNamespace) ||
      !BUSINESS_JOB_TYPES.includes(job.type as BusinessJobType)
    ) {
      throw failure(
        "Business job identity or type is invalid",
        "invalid_business_job",
      );
    }
    if (
      job.payload.datasetId !== undefined &&
      job.payload.datasetId !== job.projectId
    ) {
      throw failure(
        "Business job datasetId does not match its project",
        "invalid_business_job",
      );
    }

    const context = await this.#openProject(job);
    try {
      switch (job.type) {
        case "memo.generate":
          return await this.#generateMemo(job, context, execution.signal);
        default:
          throw failure(
            `Unsupported business job type: ${job.type}`,
            "invalid_business_job",
          );
      }
    } finally {
      context.close();
    }
  }

  async #openProject(job: BusinessJob): Promise<ProjectContext> {
    const lexicalRoot = path.resolve(
      this.#dataRoot,
      "users",
      job.tenantNamespace,
      "projects",
      job.projectId,
    );
    if (!isWithin(lexicalRoot, this.#dataRoot)) {
      throw failure(
        "Business job project path escapes dataRoot",
        "business_path_violation",
      );
    }
    let actualDataRoot: string;
    let actualProjectRoot: string;
    try {
      [actualDataRoot, actualProjectRoot] = await Promise.all([
        realpath(this.#dataRoot),
        realpath(lexicalRoot),
      ]);
    } catch (error) {
      throw failure(
        "Business job project directory does not exist",
        "business_path_violation",
        false,
        error,
      );
    }
    if (!isWithin(actualProjectRoot, actualDataRoot)) {
      throw failure(
        "Business job project resolves outside dataRoot",
        "business_path_violation",
      );
    }
    const database = openProjectDatabase({
      projectRoot: actualProjectRoot,
      databasePath: path.join("data", "research.sqlite3"),
    });
    return {
      projectRoot: actualProjectRoot,
      research: createResearchStore(database),
      workflow: createWorkflowStore(database.connection),
      close: () => database.close(),
    };
  }

  #evidenceSources(
    context: ProjectContext,
    includeHistory: boolean,
    signal?: AbortSignal,
  ): EvidenceSource[] {
    const documents = [];
    for (let offset = 0; ; offset += 500) {
      const page = context.research.documents.list({
        status: "active",
        limit: 500,
        offset,
      });
      documents.push(...page.items);
      if (!page.hasMore) break;
    }
    const result: EvidenceSource[] = [];
    for (const document of documents.sort((a, b) => a.id.localeCompare(b.id))) {
      signal?.throwIfAborted();
      const versions = [];
      if (includeHistory) {
        for (let offset = 0; ; offset += 500) {
          const page = context.research.documents.listVersions(
            document.id,
            { limit: 500, offset },
          );
          versions.push(...page.items);
          if (!page.hasMore) break;
        }
      } else {
        const current =
          context.research.documents.getCurrentVersion(document.id);
        if (current !== null) versions.push(current);
      }
      for (const version of versions) {
        let offset = 0;
        for (;;) {
          signal?.throwIfAborted();
          const page = context.research.evidence.listForVersion(version.id, {
            limit: 500,
            offset,
          });
          for (const evidence of page.items) {
            result.push({
              evidence,
              documentId: document.id,
              logicalKey: document.logicalKey,
              documentTitle: document.title,
              documentVersionId: version.id,
              documentVersionNo: version.versionNo,
            });
            if (result.length > this.#maxEvidenceRecords) {
              throw failure(
                `Business scan exceeds ${String(this.#maxEvidenceRecords)} Evidence records`,
                "business_limit_exceeded",
              );
            }
          }
          if (!page.hasMore) break;
          offset += page.items.length;
        }
      }
    }
    return result;
  }

  #classify(source: EvidenceSource): ClassifiedEvidence | null {
    const searchable = `${source.evidence.title ?? ""}\n${source.evidence.originalText}`;
    const match = TRACKING_PATTERNS.find((candidate) =>
      candidate.pattern.test(searchable),
    );
    if (match === undefined) {
      return null;
    }
    const locator =
      source.evidence.locator.sheetName !== undefined
        ? `${source.evidence.locator.sheetName}!${source.evidence.locator.cellRef ?? source.evidence.locator.cellRange ?? ""}`
        : source.evidence.locator.pageStart !== undefined
          ? `page:${String(source.evidence.locator.pageStart)}`
          : source.evidence.evidenceId;
    const content = canonicalText(source.evidence.originalText, 20_000);
    if (!content) return null;
    return {
      type: match.type,
      priority: match.priority,
      source,
      title: canonicalText(
        source.evidence.title ??
          `${source.documentTitle} · ${match.type}`,
        500,
      ),
      content,
      canonicalKey: canonicalText(
        `${source.logicalKey}:${match.type}:${locator}`,
        500,
      ),
    };
  }

  async #generateMemo(
    job: BusinessJob,
    context: ProjectContext,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const instruction =
      optionalStringPayload(job.payload, "instruction") ??
      optionalStringPayload(job.payload, "topic") ??
      "综合投研更新";
    const topic =
      optionalStringPayload(job.payload, "topic") ??
      canonicalText(instruction, 500);
    const title =
      optionalStringPayload(job.payload, "title") ??
      `${topic}研究 Memo`;
    const requestedEvidence = job.payload.evidenceIds;
    if (
      requestedEvidence !== undefined &&
      (!Array.isArray(requestedEvidence) ||
        !requestedEvidence.every(
          (item) => typeof item === "string" && item.length > 0,
        ))
    ) {
      throw failure(
        "memo.generate payload.evidenceIds must be an array of IDs",
        "invalid_business_job",
      );
    }
    const sources =
      requestedEvidence === undefined
        ? this.#evidenceSources(context, false, signal).slice(
            0,
            MEMO_EVIDENCE_LIMIT,
          )
        : requestedEvidence.slice(0, MEMO_EVIDENCE_LIMIT).map((evidenceId) => {
            const trace = context.research.evidence.trace(evidenceId);
            return {
              evidence: trace,
              documentId: trace.document.id,
              logicalKey: trace.document.logicalKey,
              documentTitle: trace.document.title,
              documentVersionId: trace.documentVersion.id,
              documentVersionNo: trace.documentVersion.versionNo,
            };
          });
    signal?.throwIfAborted();

    const grouped = new Map<string, EvidenceSource[]>();
    for (const source of sources) {
      const classified = this.#classify(source);
      const key =
        classified?.type === "risk"
          ? "risks"
          : classified?.type === "catalyst"
            ? "catalysts"
            : classified?.type === "metric"
              ? "financials"
              : "thesis";
      const group = grouped.get(key) ?? [];
      group.push(source);
      grouped.set(key, group);
    }
    const definitions = [
      ["thesis", "核心观点"],
      ["financials", "经营与财务"],
      ["risks", "主要风险"],
      ["catalysts", "潜在催化剂"],
    ] as const;
    const sections = definitions.map(([sectionKey, sectionTitle]) => {
      const evidence = grouped.get(sectionKey) ?? [];
      const lines =
        evidence.length === 0
          ? ["- 当前资料尚无足够的可核验证据，需进一步补充。"]
          : evidence.slice(0, 20).map((source) => {
              const excerpt = canonicalText(
                source.evidence.originalText,
                800,
              );
              return `- ${excerpt} [${source.evidence.evidenceId}]`;
            });
      return {
        sectionKey,
        title: sectionTitle,
        content: lines.join("\n"),
        evidenceIds: evidence.map(
          (source) => source.evidence.evidenceId,
        ),
        needsReview: evidence.length === 0,
      };
    });
    const markdown = [
      `# ${title}`,
      "",
      `> 主题：${topic}`,
      `> 生成要求：${instruction}`,
      `> 截止日期：${job.createdAt.slice(0, 10)}`,
      "",
      ...sections.flatMap((section) => [
        `## ${section.title}`,
        "",
        section.content,
        "",
      ]),
      "## 证据说明",
      "",
      "方括号中的 Evidence ID 可在项目来源详情中回到原始文档位置。",
      "",
    ].join("\n");
    const contentHash = sha256(markdown);
    const relativeMarkdownPath = path.posix.join(
      "artifacts",
      "memos",
      `${job.id}.md`,
    );
    const absoluteMarkdownPath = path.resolve(
      context.projectRoot,
      relativeMarkdownPath,
    );
    if (!isWithin(absoluteMarkdownPath, context.projectRoot)) {
      throw failure(
        "Memo output path escapes the project",
        "business_path_violation",
      );
    }
    await writeNewOrIdentical(
      absoluteMarkdownPath,
      Buffer.from(markdown, "utf8"),
    );
    const memo = context.workflow.tracking.saveMemoVersion({
      datasetId: job.projectId,
      topic,
      title,
      asOfDate: job.createdAt.slice(0, 10),
      sourceType: "ts-deterministic",
      status: "completed",
      contentHash,
      markdownPath: relativeMarkdownPath,
      documentVersions: [
        ...new Map(
          sources.map((source) => [
            source.documentVersionId,
            {
              documentId: source.documentId,
              documentVersionId: source.documentVersionId,
              versionNo: source.documentVersionNo,
            },
          ]),
        ).values(),
      ],
      inputs: {
        instruction,
        generator: "ts-deterministic-memo-v1",
      },
      sections,
      idempotencyKey: job.id,
      createdAt: job.createdAt,
    });
    const allEvidenceIds = [
      ...new Set(
        sections.flatMap((section) => section.evidenceIds),
      ),
    ];
    const asset = context.research.assets.saveVersion({
      assetId: `memo:${memo.record.seriesId}`,
      assetType: "memo",
      title,
      status: "completed",
      summary: canonicalText(
        sections[0]?.content ?? "研究 Memo",
        2_000,
      ),
      contentMarkdown: markdown,
      structuredContent: {
        memoVersionId: memo.record.memoVersionId,
        seriesId: memo.record.seriesId,
      },
      metadata: {
        markdownPath: relativeMarkdownPath,
        generator: "ts-deterministic-memo-v1",
      },
      tags: ["memo", "research"],
      evidence: allEvidenceIds.map((evidenceId) => ({
        evidenceId,
        relationType: "supports",
      })),
    });

    const renderOutput = path.resolve(
      context.projectRoot,
      "artifacts",
      "memo-renders",
      memo.record.memoVersionId,
    );
    let renderJob: EnqueueJobResult | null = null;
    if (this.#childJobs !== undefined) {
      renderJob = this.#childJobs.enqueue({
        tenantNamespace: job.tenantNamespace,
        projectId: job.projectId,
        type: "report.generate",
        payload: {
          datasetId: job.projectId,
          sourceKind: "memo",
          memoVersionId: memo.record.memoVersionId,
          assetId: asset.asset.id,
          inputPath: absoluteMarkdownPath,
          outputDirectory: renderOutput,
          computeOperation: "render_report",
          options: {
            title,
            outputBasename: `memo-${memo.record.versionNo}`,
            renderPdf: true,
            requirePdf: false,
          },
        },
        idempotencyKey: `${job.id}:render`,
        maxAttempts: 3,
      });
    }
    return {
      kind: "memo.generate",
      memoVersionId: memo.record.memoVersionId,
      seriesId: memo.record.seriesId,
      assetId: asset.asset.id,
      markdownPath: relativeMarkdownPath,
      evidenceCount: allEvidenceIds.length,
      renderJobId: renderJob?.job.id ?? null,
      idempotentReplay:
        !memo.created &&
        !asset.created &&
        (renderJob === null || !renderJob.created),
    };
  }
}
