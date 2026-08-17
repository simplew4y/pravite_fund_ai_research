import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "./identity";
import {
  PRIVATE_FUND_RESEARCH_MODE_STORAGE_KEY,
  activatePrivateFundProject,
  addPrivateFundValuationDerivedModelToResources,
  createPrivateFundProject,
  createPrivateFundSourceFolder,
  deletePrivateFundAssets,
  deletePrivateFundFile,
  deletePrivateFundFiles,
  deletePrivateFundProject,
  deletePrivateFundSourceFolder,
  derivePrivateFundValuationModel,
  fetchPrivateFundValuationDerivedModelFile,
  comparePrivateFundMemoVersions,
  comparePrivateFundValuationModelVersions,
  getPrivateFundValuationAgentAnalysis,
  getPrivateFundProject,
  getPrivateFundPipelineJob,
  getPrivateFundSourceFolders,
  getPrivateFundResearchItemTimeline,
  getPrivateFundTrackingOverview,
  getPrivateFundValuationModelOverview,
  getPrivateFundValuationTrackingOverview,
  getPrivateFundWorkflow,
  privateFundTokenUsageFromWire,
  privateFundProjectPreamble,
  listPrivateFundProjects,
  wrapPrivateFundPromptContext,
  readPrivateFundResearchMode,
  runPrivateFundPipeline,
  runPrivateFundTracking,
  runPrivateFundValuationAgentAnalysis,
  runPrivateFundValuationTracking,
  movePrivateFundSourceFile,
  renamePrivateFundSourceFolder,
  updatePrivateFundAlert,
  updatePrivateFundValuationAlert,
  updatePrivateFundValuationWatchRule,
  updatePrivateFundProject,
  uploadPrivateFundFiles,
  writePrivateFundResearchMode,
} from "./privateFundApi";

vi.mock("./identity", () => ({ authenticatedFetch: vi.fn() }));

const PROJECT = { datasetId: "sungrow", name: "阳光电源" };
const CANONICAL_PROJECT = {
  id: "sungrow",
  name: "阳光电源",
  companyName: "阳光电源股份有限公司",
  ticker: "300274.SZ",
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
};

function canonicalDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: "doc-1",
    logicalKey: "upload:annual.pdf",
    sourceRoot: "upload",
    sourceRelpath: "annual.pdf",
    title: "Annual report",
    status: "active",
    currentVersionId: "ver-1",
    currentVersionNo: 1,
    metadata: {},
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function canonicalVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: "ver-1",
    documentId: "doc-1",
    versionNo: 1,
    supersedesVersionId: null,
    sha256: "a".repeat(64),
    originalFilename: "annual.pdf",
    storedPath: "/srv/private/sungrow/annual.pdf",
    fileType: "pdf",
    mimeType: "application/pdf",
    fileSize: 128,
    status: "indexed",
    lifecycle: "active",
    parserName: "worker",
    parserVersion: "1",
    metadata: {
      chunkCount: 12,
      docType: "financial_report",
      docSubtype: "annual_report",
      docTypeConfidence: 0.97,
      classificationStatus: "accepted",
      classificationMethod: "rules",
      companyName: "阳光电源股份有限公司",
      companyTicker: "300274.SZ",
      companyConfidence: 0.96,
    },
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

function canonicalPage(items: unknown[], offset = 0, hasMore = false) {
  return {
    items,
    total: hasMore ? offset + items.length + 1 : offset + items.length,
    limit: 500,
    offset,
    hasMore,
  };
}

function apiResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CANONICAL_SOURCE_FOLDERS = {
  folders: [
    {
      id: "folder-old",
      parentId: null,
      name: "核心资料",
      folderKind: "legacy",
      classificationKey: null,
      documentCount: 1,
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
    },
    {
      id: "folder-new",
      parentId: null,
      name: "财务报告",
      folderKind: "classification",
      classificationKey: "financial_report",
      documentCount: 0,
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
    },
  ],
  assignments: [
    {
      documentId: "doc-1",
      folderId: "folder-old",
      assignmentSource: "legacy",
      legacyFileName: "annual.pdf",
    },
  ],
};

afterEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
});

describe("private-fund research instructions", () => {
  it("requires citations for key facts, dates, amounts, and events", () => {
    const preamble = privateFundProjectPreamble(PROJECT);

    expect(preamble).toContain("资料项目「阳光电源」");
    expect(preamble).toContain("dataset_id: sungrow");
    expect(preamble).toContain("显式使用上述 dataset_id");
    expect(preamble).toContain("关键事实、时间、金额和事件必须逐条溯源");
    expect(preamble).toContain("可点击的 Markdown 引用");
    expect(preamble).toContain("markdown_citation");
    expect(preamble).toContain("资料未覆盖/需复核");
  });

  it("uses distinct standard and deep research instructions", () => {
    expect(privateFundProjectPreamble(PROJECT, "standard")).toContain("研究级别：常规研究");

    const deep = privateFundProjectPreamble(PROJECT, "deep");
    expect(deep).toContain("研究级别：深度研究");
    expect(deep).toContain("提高 top_k");
    expect(deep).toContain("metric_facts");
    expect(deep).toContain("source_detail");
    expect(deep).toContain("交叉核验 PDF 与 Excel 证据");
  });

  it("wraps internal project rules in a persistent hidden boundary", () => {
    const wrapped = wrapPrivateFundPromptContext(privateFundProjectPreamble(PROJECT));
    expect(wrapped).toContain("omnigent-private-fund-context:start");
    expect(wrapped).toContain("dataset_id: sungrow");
    expect(wrapped).toContain("omnigent-private-fund-context:end");
  });

  it("persists deep mode and safely falls back to standard", () => {
    expect(readPrivateFundResearchMode()).toBe("standard");

    writePrivateFundResearchMode("deep");
    expect(readPrivateFundResearchMode()).toBe("deep");

    localStorage.setItem(PRIVATE_FUND_RESEARCH_MODE_STORAGE_KEY, "invalid");
    expect(readPrivateFundResearchMode()).toBe("standard");
  });
});

describe("private-fund pipeline requests", () => {
  it("uses non-destructive ingestion by default", async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          job: { job_id: "job-1", dataset_id: "sungrow", status: "queued" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await runPrivateFundPipeline("sungrow");

    expect(authenticatedFetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(authenticatedFetch).mock.calls[0];
    expect(url).toBe("/v1/private-fund/projects/sungrow/pipeline");
    expect(JSON.parse(String(init?.body))).toEqual({ reset: false, recursive: true });
  });
});

describe("private-fund source folder requests", () => {
  function mockSourceFolderApi(documents = [canonicalDocument()]) {
    vi.mocked(authenticatedFetch).mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/documents/") && href.includes("/versions?")) {
        const documentId = href.split("/documents/")[1]!.split("/")[0]!;
        return apiResponse(
          canonicalPage([
            canonicalVersion({
              id: documentId === "doc-1" ? "ver-1" : `ver-${documentId}`,
              documentId,
              originalFilename: documentId === "doc-2" ? "unassigned.pdf" : "annual.pdf",
            }),
          ]),
        );
      }
      if (href.includes("/documents?")) return apiResponse(canonicalPage(documents));
      if (href.endsWith("/source-folders") && (!init?.method || init.method === "GET")) {
        return apiResponse(CANONICAL_SOURCE_FOLDERS);
      }
      if (href.includes("/source-folders")) return apiResponse(CANONICAL_SOURCE_FOLDERS);
      throw new Error(`Unexpected request: ${href}`);
    });
  }

  it("maps canonical assignments and places every unassigned active document in a virtual folder", async () => {
    mockSourceFolderApi([
      canonicalDocument(),
      canonicalDocument({
        id: "doc-2",
        logicalKey: "upload:unassigned.pdf",
        sourceRelpath: "unassigned.pdf",
        currentVersionId: "ver-doc-2",
      }),
    ]);

    const tree = await getPrivateFundSourceFolders("sungrow");

    expect(tree.folders.find((folder) => folder.folderId === "folder-old")).toMatchObject({
      kind: "custom",
      files: [{ fileName: "annual.pdf", assignment: "manual" }],
    });
    expect(tree.folders.find((folder) => folder.folderId === "folder-new")?.kind).toBe("auto");
    expect(tree.folders.find((folder) => folder.folderId === "system:unassigned")).toMatchObject({
      name: "待识别",
      kind: "system",
      files: [{ fileName: "unassigned.pdf", assignment: "auto" }],
    });
    expect(
      tree.folders.flatMap((folder) => folder.files.map((file) => file.fileName)).sort(),
    ).toEqual(["annual.pdf", "unassigned.pdf"]);
  });

  it("creates and renames folders through canonical routes but protects the virtual folder", async () => {
    mockSourceFolderApi();

    await createPrivateFundSourceFolder("sungrow", "核心资料");
    await renamePrivateFundSourceFolder("sungrow", "folder-old", "重点跟踪");

    expect(authenticatedFetch).toHaveBeenCalledWith(
      "/v1/projects/sungrow/source-folders",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "核心资料" }) }),
    );
    expect(authenticatedFetch).toHaveBeenCalledWith(
      "/v1/projects/sungrow/source-folders/folder-old",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "重点跟踪" }) }),
    );
    const callsBeforeVirtualMutations = vi.mocked(authenticatedFetch).mock.calls.length;
    await expect(
      renamePrivateFundSourceFolder("sungrow", "system:unassigned", "非法重命名"),
    ).rejects.toThrow("virtual");
    await expect(deletePrivateFundSourceFolder("sungrow", "system:unassigned")).rejects.toThrow(
      "virtual",
    );
    expect(authenticatedFetch).toHaveBeenCalledTimes(callsBeforeVirtualMutations);
  });

  it("uses canonical atomic assignment for a real-folder move", async () => {
    const moved = {
      ...CANONICAL_SOURCE_FOLDERS,
      assignments: [
        {
          documentId: "doc-1",
          folderId: "folder-new",
          assignmentSource: "manual",
          legacyFileName: "annual.pdf",
        },
      ],
    };
    mockSourceFolderApi();
    vi.mocked(authenticatedFetch).mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/documents/") && href.includes("/versions?")) {
        return apiResponse(canonicalPage([canonicalVersion()]));
      }
      if (href.includes("/documents?")) return apiResponse(canonicalPage([canonicalDocument()]));
      if (href.endsWith("/source-folders/folder-new/documents") && init?.method === "POST") {
        return apiResponse(moved);
      }
      if (href.endsWith("/source-folders")) return apiResponse(CANONICAL_SOURCE_FOLDERS);
      throw new Error(`Unexpected request: ${href}`);
    });

    const tree = await movePrivateFundSourceFile("sungrow", " ＡＮＮＵＡＬ.PDF ", "folder-new");

    const mutationCalls = vi
      .mocked(authenticatedFetch)
      .mock.calls.filter(([, init]) => Boolean(init?.method && init.method !== "GET"));
    expect(mutationCalls).toEqual([
      [
        "/v1/projects/sungrow/source-folders/folder-new/documents",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ documentId: "doc-1", assignmentSource: "manual" }),
        }),
      ],
    ]);
    expect(tree.folders.find((folder) => folder.folderId === "folder-new")?.files).toEqual([
      { fileName: "annual.pdf", assignment: "manual" },
    ]);
  });

  it("treats the virtual folder target as unassign without sending its synthetic id", async () => {
    const unassigned = { ...CANONICAL_SOURCE_FOLDERS, assignments: [] };
    mockSourceFolderApi();
    vi.mocked(authenticatedFetch).mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/documents/") && href.includes("/versions?")) {
        return apiResponse(canonicalPage([canonicalVersion()]));
      }
      if (href.includes("/documents?")) return apiResponse(canonicalPage([canonicalDocument()]));
      if (href.includes("/folder-old/documents/doc-1") && init?.method === "DELETE") {
        return apiResponse(unassigned);
      }
      if (href.endsWith("/source-folders")) return apiResponse(CANONICAL_SOURCE_FOLDERS);
      throw new Error(`Unexpected request: ${href}`);
    });

    const tree = await movePrivateFundSourceFile("sungrow", "annual.pdf", "system:unassigned");

    expect(authenticatedFetch).toHaveBeenCalledWith(
      "/v1/projects/sungrow/source-folders/folder-old/documents/doc-1",
      { method: "DELETE" },
    );
    expect(
      vi
        .mocked(authenticatedFetch)
        .mock.calls.some(([url]) => String(url).includes("system%3Aunassigned")),
    ).toBe(false);
    expect(tree.folders.find((folder) => folder.folderId === "system:unassigned")?.files).toEqual([
      { fileName: "annual.pdf", assignment: "auto" },
    ]);
  });
});

describe("private-fund research tracking requests", () => {
  it("maps tracking overview and starts an asynchronous scan", async () => {
    vi.mocked(authenticatedFetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            dataset_id: "sungrow",
            counts: { risk: 2, catalyst: 1 },
            unread_alert_count: 1,
            items: [
              {
                item_id: "risk-1",
                item_type: "risk",
                canonical_key: "overseas-demand",
                title: "海外需求回落",
                status: "active",
                current_version_no: 2,
                current_version_id: "risk-1-v2",
                first_seen_at: "2026-07-01T00:00:00Z",
                last_seen_at: "2026-07-14T00:00:00Z",
                current_version: {
                  item_version_id: "risk-1-v2",
                  version_no: 2,
                  observed_at: "2026-07-14T00:00:00Z",
                  source_type: "document",
                  source_id: "doc-2",
                  content: "海外需求出现回落迹象",
                  stance: "negative",
                  state: "watching",
                  impact: "high",
                  confidence: 0.82,
                  evidence_ids: ["chunk:2"],
                },
              },
            ],
            alerts: [
              {
                alert_id: "alert-1",
                item_id: "risk-1",
                alert_type: "new_risk",
                priority: "high",
                title: "新增风险：海外需求回落",
                summary: "风险首次出现",
                why_it_matters: "影响盈利预测",
                evidence_ids: ["chunk:2"],
                status: "new",
                created_at: "2026-07-14T00:00:00Z",
                updated_at: "2026-07-14T00:00:00Z",
              },
            ],
            watch_rules: [],
            jobs: [],
            memo_series: [],
            memo_versions: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            job: {
              job_id: "track-1",
              job_type: "manual_scan",
              source_id: "manual:2026-07-14T00:00:00Z",
              status: "queued",
              attempt_count: 0,
              max_attempts: 3,
              created_at: "2026-07-14T00:00:00Z",
            },
          }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        ),
      );

    const overview = await getPrivateFundTrackingOverview("sungrow");
    const job = await runPrivateFundTracking("sungrow");

    expect(overview.unreadAlertCount).toBe(1);
    expect(overview.items[0].currentVersion).toMatchObject({
      state: "watching",
      evidenceIds: ["chunk:2"],
    });
    expect(overview.alerts[0].whyItMatters).toBe("影响盈利预测");
    expect(job).toMatchObject({ jobId: "track-1", status: "queued" });
    expect(authenticatedFetch).toHaveBeenNthCalledWith(
      2,
      "/v1/private-fund/projects/sungrow/tracking/run",
      { method: "POST" },
    );
  });

  it("maps Memo comparisons, item timelines, and alert status updates", async () => {
    const memo = (id: string, version: number) => ({
      memo_version_id: id,
      series_id: "series-1",
      version_no: version,
      as_of_date: `2026-07-${String(version).padStart(2, "0")}`,
      status: "completed",
      topic: "投资逻辑",
      series_title: "投资逻辑 Memo",
      created_at: `2026-07-${String(version).padStart(2, "0")}T00:00:00Z`,
      sections: [],
    });
    vi.mocked(authenticatedFetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            from_version: memo("memo-v1", 1),
            to_version: memo("memo-v2", 2),
            section_changes: [
              {
                section_key: "thesis",
                title: "投资逻辑",
                change_type: "changed",
                similarity: 0.64,
                old_content: "看好海外增长",
                new_content: "海外增长放缓，储能补位",
                old_evidence_ids: ["chunk:1"],
                new_evidence_ids: ["chunk:2"],
              },
            ],
            item_changes: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            item: {
              item_id: "assumption-1",
              item_type: "assumption",
              canonical_key: "revenue/base/2026",
              title: "2026 收入增速",
              status: "active",
              current_version_no: 2,
              first_seen_at: "2026-07-01T00:00:00Z",
              last_seen_at: "2026-07-14T00:00:00Z",
            },
            versions: [
              {
                item_version_id: "assumption-v1",
                version_no: 1,
                observed_at: "2026-07-01T00:00:00Z",
                source_type: "memo",
                source_id: "memo-v1",
                content: "收入增速 25%",
                stance: "base",
                state: "active",
                impact: "high",
                confidence: 0.8,
                evidence_ids: ["chunk:1"],
              },
            ],
            changes: [],
            observations: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            alert: {
              alert_id: "alert-1",
              item_id: "risk-1",
              alert_type: "new_risk",
              priority: "high",
              title: "新增风险",
              summary: "风险首次出现",
              evidence_ids: [],
              status: "acknowledged",
              created_at: "2026-07-14T00:00:00Z",
              updated_at: "2026-07-14T01:00:00Z",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const comparison = await comparePrivateFundMemoVersions("sungrow", "memo-v1", "memo-v2");
    const timeline = await getPrivateFundResearchItemTimeline("sungrow", "assumption-1");
    const alert = await updatePrivateFundAlert("sungrow", "alert-1", {
      status: "acknowledged",
    });

    expect(comparison.sectionChanges[0]).toMatchObject({
      changeType: "changed",
      oldEvidenceIds: ["chunk:1"],
      newEvidenceIds: ["chunk:2"],
    });
    expect(timeline.versions[0]).toMatchObject({ content: "收入增速 25%", versionNo: 1 });
    expect(alert.status).toBe("acknowledged");
    expect(JSON.parse(String(vi.mocked(authenticatedFetch).mock.calls[2][1]?.body))).toEqual({
      status: "acknowledged",
    });
  });
});

describe("private-fund valuation tracking requests", () => {
  const version = (id: string, versionNo: number) => ({
    model_version_id: id,
    document_version_no: versionNo,
    original_filename: `model-v${versionNo}.xlsx`,
    node_count: 24,
    formula_node_count: 8,
    review_required_count: 1,
    created_at: `2026-07-${String(versionNo).padStart(2, "0")}T00:00:00Z`,
    analysis: {
      analysis_version_id: `analysis-${versionNo}`,
      status: "completed",
      summary_markdown: `v${versionNo} 分析`,
      analysis: { change_counts: { high: 1 } },
      analyzer_version: "valuation-tracking-v1",
      created_at: `2026-07-${String(versionNo).padStart(2, "0")}T00:00:00Z`,
    },
  });

  it("maps model series, versions, analysis, jobs, rules, and alerts", async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          dataset_id: "sungrow",
          series: [
            {
              series_id: "series-1",
              series_key: "logical:model",
              name: "阳光电源 DCF",
              company_name: "阳光电源",
              company_ticker: "300274.SZ",
              model_type: "dcf",
              current_model_version_id: "vmv-2",
              current_version_no: 2,
              version_count: 2,
              status: "active",
              updated_at: "2026-07-02T00:00:00Z",
              current_version: version("vmv-2", 2),
              versions: [version("vmv-2", 2), version("vmv-1", 1)],
              metric_analysis: {
                market_data: {
                  snapshot_id: "snapshot-1",
                  provider: "akshare",
                  status: "completed",
                  as_of: "2026-07-20T05:30:00Z",
                  error_message: "",
                  created_at: "2026-07-20T05:30:00Z",
                },
                price_comparison: {
                  price_comparison_id: "price-1",
                  snapshot_id: "snapshot-1",
                  provider: "akshare",
                  provider_symbol: "300274",
                  currency: "CNY",
                  valuation_date: "2026-07-20",
                  benchmark_trade_date: "2026-07-20",
                  benchmark_close: 82,
                  latest_trade_date: "2026-07-21",
                  latest_close: 100,
                  target_price: 120,
                  target_unit: "CNY/share",
                  target_source: "DCF!D20",
                  target_evidence_id: "fact:target-price",
                  implied_upside: 0.4634,
                  latest_upside: 0.2,
                  status: "completed",
                  error_message: "",
                  metadata: { adjustment: "raw" },
                  created_at: "2026-07-21T05:30:00Z",
                },
                metric_comparisons: [
                  {
                    comparison_id: "comparison-1",
                    metric_key: "quarter_net_profit_yoy",
                    label: "单季净利润增速",
                    unit: "percent",
                    model_value: 0.5,
                    actual_value: 0.38,
                    absolute_gap: 0.12,
                    relative_gap: 0.3158,
                    severity: "warning",
                    status: "compared",
                    explanation: "相差 +12.0 个百分点",
                    model_period: "2025Q2",
                    actual_period: "2025Q2",
                    model_source: "QoQ&Results!AF25",
                    actual_source: "Eastmoney F10",
                    model_quality_status: "derived_from_model_facts",
                    evidence_ids: ["fact:net-profit"],
                    created_at: "2026-07-20T05:30:00Z",
                  },
                ],
                metric_timeline: {
                  default_period: "2024Q2",
                  latest_period: "2026Q1",
                  periods: [
                    {
                      period: "2024Q2",
                      label: "2024 Q2",
                      status: "comparable",
                      model_available_count: 3,
                      actual_available_count: 4,
                      compared_count: 3,
                      alert_count: 1,
                      observed_at: "2024-08-24",
                      comparisons: [
                        {
                          comparison_id: "timeline-comparison-1",
                          metric_key: "quarter_net_profit_yoy",
                          label: "单季净利润增速",
                          unit: "percent",
                          model_value: 0.5,
                          actual_value: 0.22,
                          absolute_gap: 0.28,
                          relative_gap: 1.2727,
                          severity: "critical",
                          status: "compared",
                          explanation: "相差 +28.0 个百分点",
                          model_period: "2024Q2",
                          actual_period: "2024Q2",
                          model_source: "QoQ&Results!AH25",
                          actual_source: "Eastmoney F10",
                          model_quality_status: "derived_from_model_facts",
                          evidence_ids: ["fact:historical-net-profit"],
                          created_at: "2026-07-21T05:30:00Z",
                        },
                      ],
                    },
                  ],
                },
                context_cards: [
                  {
                    card_id: "card-1",
                    card_type: "管理层口径",
                    title: "近况交流会",
                    summary: "管理层更新经营情况。",
                    insight: "用于解释模型假设。",
                    source_name: "交流会.pdf",
                    document_date: "2026-07-01",
                    evidence_ids: ["document:meeting"],
                  },
                ],
                valuation_impacts: {
                  run_id: "impact-run-1",
                  status: "completed",
                  source_fingerprint: "supporting-docs-v1",
                  extractor_version: "valuation-impact-skill-v2",
                  skill_name: "private-fund-valuation-impacts",
                  analysis_summary: "项目资料同时包含增长机会与毛利率压力。",
                  warnings: [],
                  cards: [
                    {
                      card_id: "impact-1",
                      direction: "mixed",
                      horizon: "2027年以后",
                      confidence: 0.72,
                      title: "AIDC 增长与交付风险并存",
                      evidence_summary: "会议纪要披露数据中心订单仍待交付确认。",
                      valuation_impact: "采用概率加权收入，并保留时间折现。",
                      affected_inputs: ["revenue_growth", "timing_discount"],
                      watch_items: ["订单交付", "客户验收"],
                      source_refs: ["交流会.pdf p.18"],
                      evidence_ids: ["chunk:meeting-18"],
                      created_at: "2026-07-21T06:00:00Z",
                    },
                  ],
                  error_message: "",
                  updated_at: "2026-07-21T06:00:00Z",
                },
              },
            },
          ],
          alerts: [
            {
              alert_id: "val-1",
              series_id: "series-1",
              change_id: "change-1",
              alert_type: "value_changed",
              priority: "high",
              title: "目标价",
              summary: "目标价：100 → 120",
              evidence_ids: ["fact:target-price"],
              status: "new",
              created_at: "2026-07-02T00:00:00Z",
              updated_at: "2026-07-02T00:00:00Z",
            },
          ],
          metric_alerts: [
            {
              alert_id: "val-gap-1",
              series_id: "series-1",
              change_id: "comparison-1",
              alert_type: "model_actual_gap",
              priority: "medium",
              title: "单季净利润增速",
              summary: "相差 +12.0 个百分点",
              evidence_ids: ["fact:net-profit"],
              status: "new",
              created_at: "2026-07-20T05:30:00Z",
              updated_at: "2026-07-20T05:30:00Z",
            },
          ],
          watch_rules: [
            {
              rule_id: "rule-1",
              name: "自动追踪重大估值变化",
              min_materiality: "medium",
              change_types: [],
              active: 1,
            },
          ],
          jobs: [
            {
              job_id: "vtj-1",
              job_type: "model_version_ingested",
              source_id: "doc-2",
              status: "completed",
              attempt_count: 1,
              max_attempts: 4,
              created_at: "2026-07-02T00:00:00Z",
            },
          ],
          agent_analyses: [
            {
              analysis_id: "vaa-1",
              dataset_id: "sungrow",
              series_id: "series-1",
              base_model_version_id: "vmv-2",
              comparison_model_version_id: "vmv-1",
              status: "completed",
              focus: "WACC 与目标价",
              valuation_method: "DCF",
              executive_summary: "折现率下调推动估值上修。",
              investment_conclusion: "建议复核后采用新假设。",
              analysis: {
                key_findings: [
                  {
                    title: "WACC 下调",
                    detail: "下降 100bp",
                    impact: "high",
                    confidence: 0.92,
                    evidence_ids: ["fact:wacc"],
                  },
                ],
                evidence_chain: [
                  {
                    claim: "折现率下降",
                    reasoning: "输入假设从 10% 调整至 9%",
                    confidence: 0.9,
                    evidence_ids: ["fact:wacc"],
                  },
                ],
                recommended_changes: [
                  {
                    node_id: "node-wacc",
                    display_name: "WACC",
                    metric_key: "wacc",
                    current_value_numeric: 0.1,
                    proposed_value_numeric: 0.09,
                    rationale: "行业风险溢价下降",
                    confidence: 0.92,
                    evidence_ids: ["fact:wacc"],
                    writable: true,
                    sheet_name: "DCF",
                    cell_ref: "E5",
                  },
                ],
                selected_evidence: [
                  {
                    evidence_id: "fact:wacc",
                    kind: "model_node",
                    label: "WACC",
                    source: "DCF!E5",
                    detail: "value=0.1",
                    writable: true,
                  },
                ],
              },
              planner: { analysis_dimensions: ["折现率"] },
              evidence_ids: ["fact:wacc"],
              model_name: "qwen3",
              agent_version: "valuation-agent-v1",
              created_at: "2026-07-02T01:00:00Z",
              updated_at: "2026-07-02T01:01:00Z",
              completed_at: "2026-07-02T01:01:00Z",
            },
          ],
          derived_models: [
            {
              derived_model_id: "vdm-1",
              dataset_id: "sungrow",
              series_id: "series-1",
              analysis_id: "vaa-1",
              base_model_version_id: "vmv-2",
              derived_version_no: 3,
              output_filename: "model-agent-v3.xlsx",
              output_path: "/tmp/model-agent-v3.xlsx",
              checksum: "abc",
              applied_changes: [{ node_id: "node-wacc" }],
              skipped_changes: [],
              created_at: "2026-07-02T01:02:00Z",
            },
          ],
          unread_alert_count: 1,
          unread_metric_alert_count: 1,
          change_counts: { high: 1 },
          analyzer_version: "valuation-tracking-v1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const overview = await getPrivateFundValuationTrackingOverview("sungrow");

    expect(overview.series[0]).toMatchObject({
      seriesId: "series-1",
      currentVersionNo: 2,
      versionCount: 2,
    });
    expect(overview.series[0].currentVersion?.analysis).toMatchObject({
      analysisVersionId: "analysis-2",
      analyzerVersion: "valuation-tracking-v1",
    });
    expect(overview.series[0].metricAnalysis).toMatchObject({
      marketData: { provider: "akshare", status: "completed" },
      priceComparison: {
        provider: "akshare",
        benchmarkClose: 82,
        latestClose: 100,
        targetPrice: 120,
        impliedUpside: 0.4634,
        latestUpside: 0.2,
      },
      metricComparisons: [
        {
          metricKey: "quarter_net_profit_yoy",
          modelValue: 0.5,
          actualValue: 0.38,
          severity: "warning",
        },
      ],
      metricTimeline: {
        defaultPeriod: "2024Q2",
        latestPeriod: "2026Q1",
        periods: [
          {
            period: "2024Q2",
            modelAvailableCount: 3,
            actualAvailableCount: 4,
            comparedCount: 3,
            alertCount: 1,
            comparisons: [
              {
                metricKey: "quarter_net_profit_yoy",
                modelValue: 0.5,
                actualValue: 0.22,
              },
            ],
          },
        ],
      },
      contextCards: [{ cardType: "管理层口径", title: "近况交流会" }],
      valuationImpacts: {
        status: "completed",
        skillName: "private-fund-valuation-impacts",
        cards: [
          {
            direction: "mixed",
            title: "AIDC 增长与交付风险并存",
            affectedInputs: ["revenue_growth", "timing_discount"],
            sourceRefs: ["交流会.pdf p.18"],
          },
        ],
      },
    });
    expect(overview.metricAlerts[0]).toMatchObject({
      alertId: "val-gap-1",
      alertType: "model_actual_gap",
    });
    expect(overview.unreadMetricAlertCount).toBe(1);
    expect(overview.alerts[0]).toMatchObject({
      alertId: "val-1",
      evidenceIds: ["fact:target-price"],
    });
    expect(overview.watchRules[0]).toMatchObject({ ruleId: "rule-1", active: true });
    expect(overview.jobs[0]).toMatchObject({ jobId: "vtj-1", status: "completed" });
    expect(overview.agentAnalyses[0]).toMatchObject({
      analysisId: "vaa-1",
      valuationMethod: "DCF",
      evidenceIds: ["fact:wacc"],
    });
    expect(overview.agentAnalyses[0].recommendedChanges[0]).toMatchObject({
      nodeId: "node-wacc",
      writable: true,
      proposedValueNumeric: 0.09,
    });
    expect(overview.derivedModels[0]).toMatchObject({
      derivedModelId: "vdm-1",
      derivedVersionNo: 3,
    });
  });

  it("maps structured valuation overview data and self-contained HTML", async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          overview_id: "overview-2",
          dataset_id: "sungrow",
          series_id: "series-1",
          model_version_id: "vmv-2",
          doc_id: "doc-2",
          status: "completed",
          overview_version: "valuation-overview-v1",
          created_at: "2026-07-02T00:00:00Z",
          html: "<!DOCTYPE html><html><body>总览</body></html>",
          overview: {
            schema_version: 1,
            model_name: "阳光电源 DCF",
            company_name: "阳光电源",
            company_ticker: "300274.SZ",
            model_version_no: 2,
            model_type: "dcf_model",
            original_filename: "model-v2.xlsx",
            generated_at: "2026-07-02T00:00:00Z",
            summary: {
              detected_statements: ["income_statement", "balance_sheet", "cash_flow"],
              missing_statements: [],
              statement_count: 3,
              trend_count: 1,
              key_metric_count: 2,
              period_start: "2024A",
              period_end: "2026E",
              periods: ["2024A", "2025E", "2026E"],
              fact_count: 30,
              review_required_count: 1,
              quality_flags: ["facts_require_review"],
            },
            key_metrics: [
              {
                metric_key: "target_price",
                label: "Target Price",
                period: "2026E",
                value_numeric: 120,
                unit: "CNY/share",
                evidence_id: "fact:target-price",
                source: "DCF!D20",
              },
            ],
            trends: [
              {
                metric_key: "revenue",
                label: "Revenue",
                statement_type: "income_statement",
                unit: "CNYm",
                sheet_name: "PL_BS_CFS",
                values: [
                  {
                    period: "2024A",
                    value: 100,
                    evidence_id: "fact:revenue-2024",
                    source: "PL_BS_CFS!B3",
                  },
                  {
                    period: "2025E",
                    value: 120,
                    evidence_id: "fact:revenue-2025",
                    source: "PL_BS_CFS!C3",
                  },
                ],
              },
            ],
            statements: [
              {
                statement_type: "income_statement",
                title: "利润表",
                sheet_name: "PL_BS_CFS",
                periods: ["2024A", "2025E"],
                rows: [
                  {
                    metric_key: "revenue",
                    metric_name: "Revenue",
                    unit: "CNYm",
                    row_index: 3,
                    values: [
                      {
                        period: "2024A",
                        value: 100,
                        evidence_id: "fact:revenue-2024",
                        source: "PL_BS_CFS!B3",
                      },
                      null,
                    ],
                  },
                ],
                source_refs: ["PL_BS_CFS!B3"],
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const modelOverview = await getPrivateFundValuationModelOverview(
      "sungrow",
      "series-1",
      "vmv-2",
    );

    expect(modelOverview.overview.summary).toMatchObject({
      statementCount: 3,
      trendCount: 1,
      factCount: 30,
    });
    expect(modelOverview.overview.trends[0]).toMatchObject({
      metricKey: "revenue",
      sheetName: "PL_BS_CFS",
    });
    expect(modelOverview.overview.keyMetrics[0]).toMatchObject({
      metricKey: "target_price",
      valueNumeric: 120,
      evidenceId: "fact:target-price",
    });
    expect(modelOverview.overview.statements[0].rows[0].values[1]).toBeNull();
    expect(modelOverview.html).toContain("<!DOCTYPE html>");
    expect(authenticatedFetch).toHaveBeenCalledWith(
      "/v1/private-fund/projects/sungrow/valuation-models/series-1/versions/vmv-2/overview",
    );
  });

  it("compares versions and calls valuation mutations", async () => {
    vi.mocked(authenticatedFetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            series: {
              series_id: "series-1",
              series_key: "logical:model",
              name: "阳光电源 DCF",
              current_version_no: 2,
              status: "active",
              updated_at: "2026-07-02T00:00:00Z",
            },
            from_version: version("vmv-1", 1),
            to_version: version("vmv-2", 2),
            changes: [
              {
                canonical_key: "output:target-price:2027",
                display_name: "目标价",
                metric_key: "target_price",
                change_type: "value_changed",
                materiality: "high",
                summary: "目标价：100 → 120",
                old_value: { value_numeric: 100 },
                new_value: { value_numeric: 120 },
                relative_change: 0.2,
                evidence_ids: ["fact:old", "fact:new"],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jobs: [
              {
                job_id: "vtj-1",
                job_type: "model_version_ingested",
                source_id: "doc-2",
                status: "queued",
                attempt_count: 0,
                max_attempts: 4,
                created_at: "2026-07-02T00:00:00Z",
              },
            ],
          }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            alert: {
              alert_id: "val-1",
              series_id: "series-1",
              change_id: "change-1",
              alert_type: "value_changed",
              priority: "high",
              title: "目标价",
              summary: "目标价变化",
              status: "acknowledged",
              created_at: "2026-07-02T00:00:00Z",
              updated_at: "2026-07-02T00:00:00Z",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            watch_rule: {
              rule_id: "rule-1",
              name: "重大估值变化",
              min_materiality: "medium",
              change_types: [],
              active: 0,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const comparison = await comparePrivateFundValuationModelVersions(
      "sungrow",
      "series-1",
      "vmv-1",
      "vmv-2",
    );
    const jobs = await runPrivateFundValuationTracking("sungrow");
    const alert = await updatePrivateFundValuationAlert("sungrow", "val-1", {
      status: "acknowledged",
    });
    const rule = await updatePrivateFundValuationWatchRule("sungrow", "rule-1", {
      active: false,
    });

    expect(comparison.changes[0]).toMatchObject({
      metricKey: "target_price",
      relativeChange: 0.2,
      evidenceIds: ["fact:old", "fact:new"],
    });
    expect(jobs[0]).toMatchObject({ jobId: "vtj-1", status: "queued" });
    expect(alert.status).toBe("acknowledged");
    expect(rule.active).toBe(false);
    expect(vi.mocked(authenticatedFetch).mock.calls.map(([url]) => url)).toEqual([
      "/v1/private-fund/projects/sungrow/valuation-models/series-1/compare?from_version=vmv-1&to_version=vmv-2",
      "/v1/private-fund/projects/sungrow/valuation-tracking/run",
      "/v1/private-fund/projects/sungrow/valuation-alerts/val-1",
      "/v1/private-fund/projects/sungrow/valuation-watch-rules/rule-1",
    ]);
  });

  it("runs Agent analysis, derives a model, downloads it, and adds it to resources", async () => {
    const agentAnalysis = {
      analysis_id: "vaa-1",
      dataset_id: "sungrow",
      series_id: "series-1",
      base_model_version_id: "vmv-2",
      comparison_model_version_id: "vmv-1",
      status: "completed",
      focus: "现金流与 WACC",
      valuation_method: "DCF",
      executive_summary: "模型估值上修。",
      investment_conclusion: "复核关键输入后派生新版本。",
      analysis: {
        key_findings: [],
        evidence_chain: [],
        recommended_changes: [],
        risks: [],
        open_questions: [],
        selected_evidence: [],
      },
      planner: {},
      evidence_ids: [],
      model_name: "qwen3",
      agent_version: "valuation-agent-v1",
      created_at: "2026-07-02T00:00:00Z",
      updated_at: "2026-07-02T00:01:00Z",
      completed_at: "2026-07-02T00:01:00Z",
    };
    const derivedModel = {
      derived_model_id: "vdm-1",
      dataset_id: "sungrow",
      series_id: "series-1",
      analysis_id: "vaa-1",
      base_model_version_id: "vmv-2",
      derived_version_no: 3,
      output_filename: "model-agent-v3.xlsx",
      output_path: "/tmp/model-agent-v3.xlsx",
      checksum: "checksum",
      applied_changes: [],
      skipped_changes: [],
      created_at: "2026-07-02T00:02:00Z",
    };
    vi.mocked(authenticatedFetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ analysis: agentAnalysis }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ analysis: agentAnalysis }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ derived_model: derivedModel }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("xlsx-content", {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            derived_model: {
              ...derivedModel,
              resource_file_name: "model.xlsx",
              resource_status: "completed",
              resource_doc_id: "doc-v3",
            },
            job: null,
            resource_import: {
              status: "completed",
              file_name: "model.xlsx",
              already_added: false,
              copied: true,
            },
          }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        ),
      );

    const queued = await runPrivateFundValuationAgentAnalysis("sungrow", "series-1", {
      baseModelVersionId: "vmv-2",
      comparisonModelVersionId: "vmv-1",
      focus: "现金流与 WACC",
    });
    const fetched = await getPrivateFundValuationAgentAnalysis("sungrow", "vaa-1");
    const derived = await derivePrivateFundValuationModel("sungrow", "vaa-1");
    const workbook = await fetchPrivateFundValuationDerivedModelFile("sungrow", "vdm-1");
    const imported = await addPrivateFundValuationDerivedModelToResources("sungrow", "vdm-1");

    expect(queued).toMatchObject({ analysisId: "vaa-1", valuationMethod: "DCF" });
    expect(fetched.executiveSummary).toBe("模型估值上修。");
    expect(derived).toMatchObject({ derivedModelId: "vdm-1", derivedVersionNo: 3 });
    expect(await workbook.text()).toBe("xlsx-content");
    expect(imported).toMatchObject({
      status: "completed",
      fileName: "model.xlsx",
      copied: true,
      derivedModel: { resourceStatus: "completed", resourceDocId: "doc-v3" },
    });
    expect(JSON.parse(String(vi.mocked(authenticatedFetch).mock.calls[0][1]?.body))).toEqual({
      base_model_version_id: "vmv-2",
      comparison_model_version_id: "vmv-1",
      focus: "现金流与 WACC",
    });
    expect(vi.mocked(authenticatedFetch).mock.calls.map(([url]) => url)).toEqual([
      "/v1/private-fund/projects/sungrow/valuation-models/series-1/agent-analysis",
      "/v1/private-fund/projects/sungrow/valuation-agent-analyses/vaa-1",
      "/v1/private-fund/projects/sungrow/valuation-agent-analyses/vaa-1/derive-model",
      "/v1/private-fund/projects/sungrow/valuation-derived-models/vdm-1/file",
      "/v1/private-fund/projects/sungrow/valuation-derived-models/vdm-1/add-to-resources",
    ]);
  });
});

describe("private-fund document classification", () => {
  it("combines canonical project, paginated active documents and their actual versions", async () => {
    const secondDocument = canonicalDocument({
      id: "doc-2",
      logicalKey: "upload:model.xlsx",
      sourceRelpath: "model.xlsx",
      currentVersionId: "ver-2",
      currentVersionNo: 2,
    });
    vi.mocked(authenticatedFetch).mockImplementation(async (url) => {
      const href = String(url);
      if (href === "/v1/projects/sungrow") return apiResponse(CANONICAL_PROJECT);
      if (href.endsWith("/documents?limit=500&offset=0")) {
        return apiResponse(
          canonicalPage(
            [canonicalDocument(), canonicalDocument({ id: "removed", status: "removed" })],
            0,
            true,
          ),
        );
      }
      if (href.endsWith("/documents?limit=500&offset=2")) {
        return apiResponse(canonicalPage([secondDocument], 2));
      }
      if (href.includes("/documents/doc-1/versions?")) {
        return apiResponse(canonicalPage([canonicalVersion()]));
      }
      if (href.includes("/documents/doc-2/versions?")) {
        return apiResponse(
          canonicalPage([
            canonicalVersion({
              id: "ver-2",
              documentId: "doc-2",
              versionNo: 2,
              originalFilename: "model.xlsx",
              fileType: "xlsx",
              storedPath: "/srv/private/sungrow/model.xlsx",
            }),
          ]),
        );
      }
      throw new Error(`Unexpected request: ${href}`);
    });

    const payload = await getPrivateFundProject("sungrow");

    expect(payload.project).toMatchObject({
      datasetId: "sungrow",
      documentCount: 2,
      indexedDocumentCount: 2,
      indexReady: true,
    });
    expect(payload.files).toHaveLength(2);
    expect(payload.files[0]).toMatchObject({
      name: "annual.pdf",
      status: "indexed",
      docType: "financial_report",
      docSubtype: "annual_report",
      docTypeConfidence: 0.97,
      classificationStatus: "accepted",
      companyName: "阳光电源股份有限公司",
      companyTicker: "300274.SZ",
      companyConfidence: 0.96,
      storedPath: null,
    });
    expect(vi.mocked(authenticatedFetch).mock.calls.map(([url]) => url)).not.toContain(
      expect.stringContaining("/documents/removed/versions"),
    );
  });
});

describe("private-fund canonical project requests", () => {
  it("enriches the canonical project list with document readiness", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(async (url) => {
      const href = String(url);
      if (href === "/v1/projects") return apiResponse({ projects: [CANONICAL_PROJECT] });
      if (href.includes("/documents/doc-1/versions?")) {
        return apiResponse(canonicalPage([canonicalVersion()]));
      }
      if (href.includes("/documents?")) {
        return apiResponse(canonicalPage([canonicalDocument()]));
      }
      throw new Error(`Unexpected request: ${href}`);
    });

    const projects = await listPrivateFundProjects();

    expect(projects).toEqual([
      expect.objectContaining({
        datasetId: "sungrow",
        documentCount: 1,
        indexedDocumentCount: 1,
        indexReady: true,
      }),
    ]);
    expect(authenticatedFetch).toHaveBeenCalledWith(
      "/v1/projects/sungrow/documents?limit=500&offset=0",
    );
  });

  it("creates and deletes through canonical routes while activation stays client-side", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(async (url, init) => {
      if (url === "/v1/projects" && init?.method === "POST") {
        return apiResponse(CANONICAL_PROJECT, 201);
      }
      if (url === "/v1/projects/sungrow" && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });

    const created = await createPrivateFundProject({
      name: "阳光电源",
      datasetId: "legacy-client-id",
      companyName: "阳光电源股份有限公司",
      companyTicker: "300274.SZ",
    });
    await deletePrivateFundProject("sungrow");
    await activatePrivateFundProject("sungrow");

    expect(created).toMatchObject({ datasetId: "sungrow", name: "阳光电源" });
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    expect(authenticatedFetch).toHaveBeenNthCalledWith(
      1,
      "/v1/projects",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "阳光电源",
          companyName: "阳光电源股份有限公司",
          ticker: "300274.SZ",
        }),
      }),
    );
    expect(authenticatedFetch).toHaveBeenNthCalledWith(2, "/v1/projects/sungrow", {
      method: "DELETE",
    });
  });

  it("fails explicitly when the canonical API cannot update a project", async () => {
    await expect(
      updatePrivateFundProject("sungrow", {
        name: "阳光电源研究",
        companyName: "阳光电源",
        companyTicker: "300274",
      }),
    ).rejects.toThrow("not supported by the canonical API");
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it("preserves every canonical upload job and polls jobs through /v1/jobs", async () => {
    const documents = [
      canonicalDocument({ currentVersionId: null, currentVersionNo: 0 }),
      canonicalDocument({
        id: "doc-2",
        logicalKey: "upload:model.xlsx",
        sourceRelpath: "model.xlsx",
        currentVersionId: null,
        currentVersionNo: 0,
      }),
    ];
    const versions = [
      canonicalVersion({ status: "parsing", lifecycle: "pending" }),
      canonicalVersion({
        id: "ver-2",
        documentId: "doc-2",
        originalFilename: "model.xlsx",
        fileType: "xlsx",
        storedPath: "/srv/private/sungrow/model.xlsx",
        status: "parsing",
        lifecycle: "pending",
      }),
    ];
    const jobs = [
      {
        id: "job-1",
        projectId: "sungrow",
        status: "queued",
        createdAt: "2026-08-17T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
        result: null,
        error: null,
        tenantNamespace: "server-only",
        payload: { inputPath: "/server-only/path" },
      },
      {
        id: "job-2",
        projectId: "sungrow",
        status: "running",
        createdAt: "2026-08-17T00:00:01.000Z",
        startedAt: "2026-08-17T00:00:02.000Z",
        completedAt: null,
        result: null,
        error: null,
      },
    ];
    vi.mocked(authenticatedFetch).mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.endsWith("/documents/upload") && init?.method === "POST") {
        return apiResponse(
          {
            uploads: documents.map((document, index) => ({
              document,
              version: versions[index],
              job: jobs[index],
              created: true,
            })),
          },
          202,
        );
      }
      if (href === "/v1/projects/sungrow") return apiResponse(CANONICAL_PROJECT);
      if (href.includes("/documents?")) return apiResponse(canonicalPage(documents));
      if (href.includes("/documents/doc-1/versions?")) {
        return apiResponse(canonicalPage([versions[0]]));
      }
      if (href.includes("/documents/doc-2/versions?")) {
        return apiResponse(canonicalPage([versions[1]]));
      }
      if (href === "/v1/jobs/job-1") return apiResponse(jobs[0]);
      throw new Error(`Unexpected request: ${href}`);
    });

    const uploaded = await uploadPrivateFundFiles("sungrow", [
      new File(["pdf"], "annual.pdf", { type: "application/pdf" }),
      new File(["xlsx"], "model.xlsx"),
    ]);
    const polled = await getPrivateFundPipelineJob("job-1");

    expect(uploaded.jobs.map((job) => job.jobId)).toEqual(["job-1", "job-2"]);
    expect(uploaded.job?.jobId).toBe("job-1");
    expect(uploaded.project.indexReady).toBe(false);
    expect(uploaded.files.map((file) => file.status)).toEqual(["parsing", "parsing"]);
    expect(uploaded.files.every((file) => file.storedPath === null)).toBe(true);
    expect(uploaded.jobs[0]).not.toHaveProperty("tenantNamespace");
    expect(uploaded.jobs[0]).not.toHaveProperty("payload");
    expect(polled).toMatchObject({ jobId: "job-1", datasetId: "sungrow", status: "queued" });
    expect(authenticatedFetch).toHaveBeenCalledWith("/v1/jobs/job-1");
    expect(authenticatedFetch).toHaveBeenCalledWith(
      "/v1/projects/sungrow/documents/upload",
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }),
    );
  });
});

describe("private-fund deletion requests", () => {
  it("resolves a display filename to a canonical document id before bulk deletion", async () => {
    let deleted = false;
    vi.mocked(authenticatedFetch).mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/documents?")) {
        return apiResponse(
          canonicalPage(
            deleted ? [] : [canonicalDocument({ sourceRelpath: "交流会.pdf", title: "交流会" })],
          ),
        );
      }
      if (href.includes("/documents/doc-1/versions?")) {
        return apiResponse(canonicalPage([canonicalVersion({ originalFilename: "交流会.pdf" })]));
      }
      if (href.endsWith("/documents/delete") && init?.method === "POST") {
        deleted = true;
        return apiResponse({
          documents: [],
          deletedDocumentIds: ["doc-1"],
          alreadyRemovedDocumentIds: [],
        });
      }
      if (href === "/v1/projects/sungrow") return apiResponse(CANONICAL_PROJECT);
      if (href.endsWith("/assets/delete")) {
        return apiResponse({ assets: [], context_asset_ids: [] });
      }
      throw new Error(`Unexpected request: ${href}`);
    });

    await deletePrivateFundFiles("sungrow", ["交流会.pdf"]);
    await deletePrivateFundAssets("sungrow", ["node:analysis-1"]);

    const deleteCall = vi
      .mocked(authenticatedFetch)
      .mock.calls.find(([url]) => String(url).endsWith("/documents/delete"));
    expect(deleteCall?.[0]).toBe("/v1/projects/sungrow/documents/delete");
    expect(JSON.parse(String(deleteCall?.[1]?.body))).toEqual({ documentIds: ["doc-1"] });
    const assetDeleteCall = vi
      .mocked(authenticatedFetch)
      .mock.calls.find(([url]) => String(url).endsWith("/assets/delete"));
    expect(JSON.parse(String(assetDeleteCall?.[1]?.body))).toEqual({
      asset_ids: ["node:analysis-1"],
    });
  });

  it("fails closed when case and NFKC normalization make a filename ambiguous", async () => {
    const documents = [
      canonicalDocument({ sourceRelpath: "ＡＢＣ.pdf" }),
      canonicalDocument({
        id: "doc-2",
        logicalKey: "upload:abc.pdf",
        sourceRelpath: "abc.PDF",
        currentVersionId: "ver-2",
      }),
    ];
    vi.mocked(authenticatedFetch).mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes("/documents?")) return apiResponse(canonicalPage(documents));
      if (href.includes("/documents/doc-1/versions?")) {
        return apiResponse(canonicalPage([canonicalVersion({ originalFilename: "ＡＢＣ.pdf" })]));
      }
      if (href.includes("/documents/doc-2/versions?")) {
        return apiResponse(
          canonicalPage([
            canonicalVersion({
              id: "ver-2",
              documentId: "doc-2",
              originalFilename: "abc.PDF",
            }),
          ]),
        );
      }
      throw new Error(`Unexpected request: ${href}`);
    });

    await expect(deletePrivateFundFile("sungrow", " abc.pdf ")).rejects.toThrow("ambiguous");
    expect(
      vi
        .mocked(authenticatedFetch)
        .mock.calls.some(([url]) => String(url).endsWith("/documents/delete")),
    ).toBe(false);
  });
});

describe("private-fund workflow requests", () => {
  it("maps persisted workflow nodes and dependencies", async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          workflow: {
            workflow_id: "wf-1",
            dataset_id: "sungrow",
            workflow_type: "investment_research_v1",
            status: "active",
            current_node_id: "business-analysis",
            created_at: "2026-07-12T00:00:00Z",
            updated_at: "2026-07-12T00:00:00Z",
          },
          nodes: [
            {
              node_id: "business-analysis",
              node_type: "analysis",
              title: "经营分析",
              objective: "分析经营质量",
              summary: "增长与现金流",
              status: "ready",
              current_version_no: 0,
              position_no: 20,
              x: 240,
              y: 280,
              tone: "mist",
              kind: "analysis",
              assumption_count: 2,
              latest_output: null,
              content_blocks: [
                {
                  type: "metrics",
                  title: "关键指标",
                  evidence_ids: ["fact:gross-margin"],
                  items: [{ label: "毛利率", value: "31.4", unit: "%" }],
                },
              ],
              evidence_sources: [
                {
                  evidence_id: "fact:gross-margin",
                  relation_type: "supports",
                  citation: "经营数据.xlsx Chart!B2",
                  document_name: "经营数据.xlsx",
                  source_path: "/research/经营数据.xlsx",
                  sheet_name: "Chart",
                  cell_range: "B2",
                  excerpt: "毛利率 31.4%",
                  source_url: "#private-fund-excel-source?workbook_name=经营数据.xlsx",
                  markdown_citation:
                    "[经营数据.xlsx Chart!B2](#private-fund-excel-source?workbook_name=经营数据.xlsx)",
                },
              ],
            },
          ],
          edges: [
            {
              edge_id: "source-to-business",
              source: "source-review",
              target: "business-analysis",
              dependency_type: "completion",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const workflow = await getPrivateFundWorkflow("sungrow");

    expect(workflow.currentNodeId).toBe("business-analysis");
    expect(workflow.nodes[0]).toMatchObject({
      nodeId: "business-analysis",
      status: "ready",
      assumptionCount: 2,
    });
    expect(workflow.nodes[0].contentBlocks[0].evidenceIds).toEqual(["fact:gross-margin"]);
    expect(workflow.nodes[0].evidenceSources?.[0]).toMatchObject({
      evidenceId: "fact:gross-margin",
      documentName: "经营数据.xlsx",
      sheetName: "Chart",
      cellRange: "B2",
      sourceUrl: "#private-fund-excel-source?workbook_name=经营数据.xlsx",
    });
    expect(workflow.edges[0]).toEqual({
      edgeId: "source-to-business",
      source: "source-review",
      target: "business-analysis",
      dependencyType: "completion",
    });
  });
});

describe("private-fund token usage mapping", () => {
  it("preserves cumulative token buckets and coverage", () => {
    expect(
      privateFundTokenUsageFromWire({
        dataset_id: "sungrow",
        session_count: 4,
        sessions_with_token_usage: 3,
        sessions_with_total_tokens: 2,
        sessions_with_cost: 1,
        input_tokens: 12_000,
        output_tokens: 2_400,
        total_tokens: 18_400,
        cache_read_input_tokens: 3_000,
        cache_creation_input_tokens: 1_000,
        total_cost_usd: 1.25,
      }),
    ).toEqual({
      datasetId: "sungrow",
      sessionCount: 4,
      sessionsWithTokenUsage: 3,
      sessionsWithTotalTokens: 2,
      sessionsWithCost: 1,
      inputTokens: 12_000,
      outputTokens: 2_400,
      totalTokens: 18_400,
      cacheReadInputTokens: 3_000,
      cacheCreationInputTokens: 1_000,
      totalCostUsd: 1.25,
    });
  });

  it("keeps missing usage distinct from a known zero-cost session", () => {
    expect(privateFundTokenUsageFromWire(undefined)).toBeNull();
    expect(
      privateFundTokenUsageFromWire({
        dataset_id: "sungrow",
        session_count: 1,
        total_cost_usd: 0,
      }),
    ).toMatchObject({
      sessionCount: 1,
      totalTokens: null,
      totalCostUsd: 0,
    });
  });
});
