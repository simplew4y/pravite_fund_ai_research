import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "./identity";
import {
  PRIVATE_FUND_RESEARCH_MODE_STORAGE_KEY,
  createPrivateFundSourceFolder,
  deletePrivateFundAssets,
  deletePrivateFundFiles,
  deletePrivateFundProject,
  comparePrivateFundMemoVersions,
  getPrivateFundProject,
  getPrivateFundSourceFolders,
  getPrivateFundResearchItemTimeline,
  getPrivateFundTrackingOverview,
  getPrivateFundWorkflow,
  privateFundTokenUsageFromWire,
  privateFundProjectPreamble,
  wrapPrivateFundPromptContext,
  readPrivateFundResearchMode,
  runPrivateFundPipeline,
  runPrivateFundTracking,
  movePrivateFundSourceFile,
  renamePrivateFundSourceFolder,
  updatePrivateFundAlert,
  writePrivateFundResearchMode,
} from "./privateFundApi";

vi.mock("./identity", () => ({ authenticatedFetch: vi.fn() }));

const PROJECT = { datasetId: "sungrow", name: "阳光电源" };

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
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
  const folderTree = {
    dataset_id: "sungrow",
    folders: [
      {
        folder_id: "system:financial_report",
        name: "财务报告",
        kind: "system",
        classification_key: "financial_report",
        files: [{ file_name: "annual.pdf", assignment: "auto" }],
        file_count: 1,
        created_at: "2026-07-14T00:00:00Z",
        updated_at: "2026-07-14T00:00:00Z",
      },
    ],
  };

  it("maps the source folder tree", async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      new Response(JSON.stringify(folderTree), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const tree = await getPrivateFundSourceFolders("sungrow");

    expect(tree.folders[0]).toMatchObject({
      folderId: "system:financial_report",
      classificationKey: "financial_report",
      fileCount: 1,
      files: [{ fileName: "annual.pdf", assignment: "auto" }],
    });
  });

  it("creates, renames, and moves files with the folder API", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(folderTree), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await createPrivateFundSourceFolder("sungrow", "核心资料");
    await renamePrivateFundSourceFolder("sungrow", "folder_1", "重点跟踪");
    await movePrivateFundSourceFile("sungrow", "annual.pdf", "folder_1");

    expect(authenticatedFetch).toHaveBeenNthCalledWith(
      1,
      "/v1/private-fund/projects/sungrow/source-folders",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "核心资料" }) }),
    );
    expect(authenticatedFetch).toHaveBeenNthCalledWith(
      2,
      "/v1/private-fund/projects/sungrow/source-folders/folder_1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "重点跟踪" }) }),
    );
    expect(authenticatedFetch).toHaveBeenNthCalledWith(
      3,
      "/v1/private-fund/projects/sungrow/source-folders/move-file",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ file_name: "annual.pdf", folder_id: "folder_1" }),
      }),
    );
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

describe("private-fund document classification", () => {
  it("maps controlled business type, company and confidence fields", async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          project: { dataset_id: "sungrow", name: "阳光电源", status: "completed" },
          files: [
            {
              name: "2024-annual-report.pdf",
              file_type: "pdf",
              size: 128,
              status: "indexed",
              chunk_count: 12,
              doc_type: "financial_report",
              doc_subtype: "annual_report",
              doc_type_confidence: 0.97,
              classification_status: "accepted",
              classification_method: "rules",
              company_name: "阳光电源股份有限公司",
              company_ticker: "300274.SZ",
              company_confidence: 0.96,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const payload = await getPrivateFundProject("sungrow");

    expect(payload.files[0]).toMatchObject({
      docType: "financial_report",
      docSubtype: "annual_report",
      docTypeConfidence: 0.97,
      classificationStatus: "accepted",
      companyName: "阳光电源股份有限公司",
      companyTicker: "300274.SZ",
      companyConfidence: 0.96,
    });
  });
});

describe("private-fund deletion requests", () => {
  it("deletes a project and sends bulk source and asset selections", async () => {
    vi.mocked(authenticatedFetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ deleted_dataset_id: "sungrow" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            project: {
              dataset_id: "sungrow",
              name: "阳光电源",
              status: "draft",
              file_count: 0,
            },
            files: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ assets: [], context_asset_ids: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    await deletePrivateFundProject("sungrow");
    await deletePrivateFundFiles("sungrow", ["交流会.pdf"]);
    await deletePrivateFundAssets("sungrow", ["node:analysis-1"]);

    expect(authenticatedFetch).toHaveBeenNthCalledWith(1, "/v1/private-fund/projects/sungrow", {
      method: "DELETE",
    });
    expect(JSON.parse(String(vi.mocked(authenticatedFetch).mock.calls[1][1]?.body))).toEqual({
      file_names: ["交流会.pdf"],
    });
    expect(JSON.parse(String(vi.mocked(authenticatedFetch).mock.calls[2][1]?.body))).toEqual({
      asset_ids: ["node:analysis-1"],
    });
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
