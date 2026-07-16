import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "./identity";
import {
  PRIVATE_FUND_RESEARCH_MODE_STORAGE_KEY,
  addPrivateFundValuationDerivedModelToResources,
  createPrivateFundSourceFolder,
  deletePrivateFundAssets,
  deletePrivateFundFiles,
  deletePrivateFundProject,
  derivePrivateFundValuationModel,
  fetchPrivateFundValuationDerivedModelFile,
  comparePrivateFundMemoVersions,
  comparePrivateFundValuationModelVersions,
  getPrivateFundValuationAgentAnalysis,
  getPrivateFundProject,
  getPrivateFundSourceFolders,
  getPrivateFundResearchItemTimeline,
  getPrivateFundTrackingOverview,
  getPrivateFundValuationTrackingOverview,
  getPrivateFundWorkflow,
  privateFundTokenUsageFromWire,
  privateFundProjectPreamble,
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
