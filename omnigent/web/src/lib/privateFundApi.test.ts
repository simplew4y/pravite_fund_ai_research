import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "./identity";
import {
  PRIVATE_FUND_RESEARCH_MODE_STORAGE_KEY,
  deletePrivateFundAssets,
  deletePrivateFundFiles,
  deletePrivateFundProject,
  getPrivateFundWorkflow,
  privateFundTokenUsageFromWire,
  privateFundProjectPreamble,
  wrapPrivateFundPromptContext,
  readPrivateFundResearchMode,
  runPrivateFundPipeline,
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
