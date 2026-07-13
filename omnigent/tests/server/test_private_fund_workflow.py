from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from omnigent.server import private_fund_workflow
from omnigent.tools.builtins.private_fund_dataset import build_private_fund_dataset_tools


def _collection_db(tmp_path: Path) -> Path:
    path = tmp_path / "dataset" / "meta" / "collection.sqlite3"
    path.parent.mkdir(parents=True)
    with sqlite3.connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE documents (
                doc_id TEXT PRIMARY KEY,
                original_filename TEXT NOT NULL,
                status TEXT NOT NULL,
                logical_doc_id TEXT,
                version_no INTEGER,
                source_relpath TEXT,
                is_current INTEGER,
                deleted_at TEXT
            );
            CREATE TABLE chunks (chunk_id TEXT PRIMARY KEY, doc_id TEXT, content TEXT);
            CREATE TABLE chunk_locations (
                chunk_id TEXT,
                location_index INTEGER,
                page_start INTEGER,
                page_end INTEGER,
                slide_start INTEGER,
                slide_end INTEGER,
                sheet_name TEXT,
                cell_range TEXT,
                heading_path TEXT
            );
            INSERT INTO documents
            VALUES ('doc-v1', 'report.pdf', 'indexed', 'report', 1, 'report.pdf', 1, NULL);
            INSERT INTO chunks VALUES ('chunk-1', 'doc-v1', 'evidence');
            INSERT INTO chunk_locations VALUES ('chunk-1', 0, 2, 2, NULL, NULL, NULL, NULL, NULL);
            """
        )
    return path


def test_agentic_workflow_starts_empty_without_preset_research_steps(tmp_path: Path) -> None:
    collection_db = _collection_db(tmp_path)

    payload = private_fund_workflow.get_or_create_workflow(collection_db, "demo")

    assert payload["workflow"]["workflow_type"] == "agentic_research_graph_v2"
    assert payload["workflow"]["current_node_id"] is None
    assert payload["nodes"] == []
    assert payload["edges"] == []
    assert payload["context_node_ids"] == []


def test_agentic_research_mcp_tools_are_registered() -> None:
    names = {tool.name() for tool in build_private_fund_dataset_tools(None)}
    assert "private_fund_research_context" in names
    assert "private_fund_research_node_save" in names
    assert "private_fund_equity_report_generate" in names
    assert "private_fund_equity_report_status" in names
    assert "private_fund_equity_report_get" in names


def test_equity_report_run_reserves_completes_and_reads_package(tmp_path: Path) -> None:
    collection_db = _collection_db(tmp_path)
    reserved = private_fund_workflow.reserve_equity_report_run(
        collection_db,
        "demo",
        run_id="eqr-test",
        title="Demo Equity Report",
        request={"sections": {"risks": "Verified risk."}},
    )

    completed = private_fund_workflow.complete_equity_report_run(
        collection_db,
        run_id="eqr-test",
        markdown="# 📝 Demo Equity Report\n",
        report_package={"schema_version": 1},
        artifact_manifest={"pdf_path": "/tmp/report.pdf"},
        render_engine="finrobot_html_template_professional+fitz_story",
    )
    fetched = private_fund_workflow.get_equity_report_run(collection_db, "demo", "eqr-test")

    assert reserved["version_no"] == 1
    assert completed["status"] == "completed"
    assert fetched["report_package"] == {"schema_version": 1}
    assert fetched["artifact_manifest"]["pdf_path"] == "/tmp/report.pdf"


def test_agent_saves_structured_nodes_and_user_selects_context(tmp_path: Path) -> None:
    collection_db = _collection_db(tmp_path)
    first = private_fund_workflow.save_agent_node(
        collection_db,
        "demo",
        title="海外盈利质量改善",
        summary="海外收入增长同时伴随现金流改善",
        content_markdown="## 结论\n盈利质量改善。\n\n## 不确定性\n汇率仍需跟踪。",
        node_type="insight",
        evidence_ids=["chunk:chunk-1"],
        tags=["海外", "现金流"],
        confidence="medium",
        source_response_ids=["response-1"],
        content_blocks=[
            {
                "type": "metrics",
                "title": "关键指标",
                "evidence_ids": ["chunk:chunk-1"],
                "items": [
                    {
                        "label": "海外毛利率",
                        "value": 31.4,
                        "unit": "%",
                        "delta": "+2.1pct",
                        "sentiment": "positive",
                    }
                ],
            },
            {
                "type": "chart",
                "title": "毛利率走势",
                "chart_type": "line",
                "x_key": "period",
                "series": [{"key": "margin", "label": "毛利率"}],
                "data": [{"period": "2026Q1", "margin": 31.4}],
                "y_unit": "%",
            },
        ],
    )
    first_id = first["node_id"]
    second = private_fund_workflow.save_agent_node(
        collection_db,
        "demo",
        title="汇率敏感性待验证",
        summary="需要验证汇率变化对海外利润的影响",
        content_markdown="## 问题\n汇率变化如何影响利润？",
        node_type="question",
        parent_node_ids=[first_id],
    )
    second_id = second["node_id"]

    selected = private_fund_workflow.set_context_nodes(
        collection_db, "demo", [first_id, second_id]
    )

    assert len(selected["nodes"]) == 2
    assert selected["context_node_ids"] == [first_id, second_id]
    first_payload = next(node for node in selected["nodes"] if node["node_id"] == first_id)
    assert [block["type"] for block in first_payload["content_blocks"]] == ["metrics", "chart"]
    assert first_payload["content_blocks"][0]["items"][0]["value"] == "31.4"
    assert first_payload["content_blocks"][0]["evidence_ids"] == ["chunk:chunk-1"]
    assert first_payload["evidence_sources"][0]["document_name"] == "report.pdf"
    assert first_payload["evidence_sources"][0]["excerpt"] == "evidence"
    assert first_payload["evidence_sources"][0]["markdown_citation"].startswith(
        "[report.pdf p.2](#private-fund-pdf-source?"
    )
    assert selected["edges"] == [
        {
            "edge_id": f"{first_id}-to-{second_id}",
            "source": first_id,
            "target": second_id,
            "dependency_type": "context",
        }
    ]
    with sqlite3.connect(collection_db) as conn:
        structured = json.loads(
            conn.execute(
                "SELECT structured_output_json FROM research_node_versions WHERE node_id=?",
                (first_id,),
            ).fetchone()[0]
        )
        assert structured["tags"] == ["海外", "现金流"]
        assert conn.execute("SELECT COUNT(*) FROM research_node_evidence").fetchone()[0] == 1


def test_agent_chart_html_preserves_self_contained_inline_javascript(tmp_path: Path) -> None:
    collection_db = _collection_db(tmp_path)
    html = (
        '<section><h2>收入结构</h2><svg id="chart"></svg>'
        "<script>const data=[{name:'储能',value:42}];"
        "document.querySelector('#chart').dataset.points=String(data.length)</script></section>"
    )

    saved = private_fund_workflow.save_agent_node(
        collection_db,
        "demo",
        title="收入结构图",
        summary="模型自主选择图形的图文资产",
        content_markdown="## 结论\n储能收入占比需要持续跟踪。",
        evidence_ids=["chunk:chunk-1"],
        content_blocks=[
            {
                "type": "html",
                "title": "收入结构",
                "html": html,
                "height": 520,
                "evidence_ids": ["chunk:chunk-1"],
            }
        ],
    )

    workflow = private_fund_workflow.get_or_create_workflow(collection_db, "demo")
    node = next(item for item in workflow["nodes"] if item["node_id"] == saved["node_id"])
    block = node["content_blocks"][0]
    assert block["type"] == "html"
    assert block["html"] == html
    assert block["height"] == 520
    assert block["evidence_ids"] == ["chunk:chunk-1"]


def test_html_misplaced_in_markdown_is_promoted_to_a_renderable_block(tmp_path: Path) -> None:
    collection_db = _collection_db(tmp_path)
    html = (
        '<section><h2>跨行业财务对比</h2><div id="chart"></div>'
        "<script>document.querySelector('#chart').textContent='rendered'</script></section>"
    )

    saved = private_fund_workflow.save_agent_node(
        collection_db,
        "demo",
        title="跨行业财务对比",
        summary="模型误把 HTML 放进了 Markdown 字段",
        content_markdown=html,
        evidence_ids=["chunk:chunk-1"],
        content_blocks=[],
    )
    current = private_fund_workflow.get_or_create_workflow(collection_db, "demo")
    current_node = next(
        item for item in current["nodes"] if item["node_id"] == saved["node_id"]
    )
    assert current_node["content_blocks"][0]["type"] == "html"
    assert current_node["content_blocks"][0]["html"] == html

    # Simulate a node persisted before the promotion guard existed.
    with sqlite3.connect(collection_db) as conn:
        conn.execute(
            "UPDATE research_node_versions SET structured_output_json=? WHERE node_version_id=?",
            (json.dumps({"content_blocks": []}), saved["node_version_id"]),
        )
        conn.commit()
    workflow = private_fund_workflow.get_or_create_workflow(collection_db, "demo")
    node = next(item for item in workflow["nodes"] if item["node_id"] == saved["node_id"])

    assert node["content_blocks"] == [
        {
            "type": "html",
            "title": "跨行业财务对比",
            "html": html,
            "height": 640,
            "evidence_ids": ["chunk:chunk-1"],
        }
    ]


def test_evidence_ids_never_split_a_json_string_into_characters(tmp_path: Path) -> None:
    collection_db = _collection_db(tmp_path)
    saved = private_fund_workflow.save_agent_node(
        collection_db,
        "demo",
        title="证据格式兼容",
        summary="JSON 字符串也会被安全规范化",
        content_markdown="## 结论\n证据格式已规范化。",
        evidence_ids='["chunk:chunk-1"]',  # type: ignore[arg-type]
    )

    node = next(item for item in saved["nodes"] if item["node_id"] == saved["node_id"])
    assert [item["evidence_id"] for item in node["evidence_sources"]] == ["chunk:chunk-1"]
    with sqlite3.connect(collection_db) as conn:
        assert conn.execute("SELECT COUNT(*) FROM research_node_evidence").fetchone()[0] == 1


def test_report_versions_snapshot_dynamic_nodes_and_documents(tmp_path: Path) -> None:
    collection_db = _collection_db(tmp_path)
    saved = private_fund_workflow.save_agent_node(
        collection_db,
        "demo",
        title="订单增长",
        summary="订单保持增长",
        content_markdown="## 结论\n订单保持增长。",
    )

    report_v1 = private_fund_workflow.create_report_version(
        collection_db, "demo", title="Demo 投资报告"
    )
    report_v2 = private_fund_workflow.create_report_version(
        collection_db, "demo", title="Demo 投资报告"
    )

    assert report_v1["version_no"] == 1
    assert report_v2["version_no"] == 2
    assert report_v1["node_versions"][saved["node_id"]]
    assert report_v1["document_versions"][0]["doc_id"] == "doc-v1"
    assert "订单保持增长" in report_v1["markdown"]


def test_saved_information_assets_are_durable_and_share_one_context_basket(tmp_path: Path) -> None:
    collection_db = _collection_db(tmp_path)
    node = private_fund_workflow.save_agent_node(
        collection_db,
        "demo",
        title="海外盈利改善",
        summary="海外业务盈利能力提升",
        content_markdown="## 结论\n海外盈利改善。",
    )
    saved = private_fund_workflow.save_asset(
        collection_db,
        "demo",
        asset_type="information",
        title="管理层判断",
        summary="管理层认为电网稳定性更值得关注",
        content_markdown="全球电网最大的威胁是稳定性不足。",
        source_response_id="response-42",
        tags=["勾选信息"],
    )
    asset_id = saved["asset_id"]

    selected = private_fund_workflow.set_asset_context(
        collection_db, "demo", [asset_id, f"node:{node['node_id']}"]
    )
    reloaded = private_fund_workflow.list_saved_assets(collection_db, "demo")

    assert selected["context_asset_ids"] == [asset_id, f"node:{node['node_id']}"]
    assert reloaded["assets"][0]["content_markdown"] == "全球电网最大的威胁是稳定性不足。"
    assert reloaded["assets"][0]["tags"] == ["勾选信息"]
    workflow = private_fund_workflow.get_or_create_workflow(collection_db, "demo")
    assert workflow["context_node_ids"] == [node["node_id"]]


def test_delete_assets_removes_saved_items_blocks_nodes_and_context(tmp_path: Path) -> None:
    collection_db = _collection_db(tmp_path)
    node_with_block = private_fund_workflow.save_agent_node(
        collection_db,
        "demo",
        title="可编辑节点",
        summary="包含图表块",
        content_markdown="## 结论\n包含图表块。",
        content_blocks=[
            {
                "type": "metrics",
                "title": "指标",
                "items": [{"label": "收入", "value": "10", "unit": "亿元"}],
            },
            {"type": "markdown", "title": "补充", "markdown": "补充说明"},
        ],
    )
    node_to_delete = private_fund_workflow.save_agent_node(
        collection_db,
        "demo",
        title="待删除节点",
        summary="删除整个节点",
        content_markdown="## 结论\n待删除。",
        parent_node_ids=[node_with_block["node_id"]],
    )
    saved = private_fund_workflow.save_asset(
        collection_db,
        "demo",
        asset_type="information",
        title="待删除信息",
        summary="待删除",
        content_markdown="待删除的重要信息。",
    )
    selected_ids = [
        saved["asset_id"],
        f"block:{node_with_block['node_id']}:0",
        f"node:{node_to_delete['node_id']}",
    ]
    private_fund_workflow.set_asset_context(collection_db, "demo", selected_ids)

    deleted = private_fund_workflow.delete_assets(collection_db, "demo", selected_ids)
    workflow = private_fund_workflow.get_or_create_workflow(collection_db, "demo")
    catalog = private_fund_workflow.list_saved_assets(collection_db, "demo")

    assert deleted == selected_ids
    assert catalog["assets"] == []
    assert catalog["context_asset_ids"] == []
    assert [node["node_id"] for node in workflow["nodes"]] == [node_with_block["node_id"]]
    assert workflow["nodes"][0]["content_blocks"] == [
        {"type": "markdown", "title": "补充", "markdown": "补充说明"}
    ]
    assert workflow["edges"] == []
