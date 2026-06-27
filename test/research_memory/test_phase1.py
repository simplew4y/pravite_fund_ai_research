"""Phase 1 测试：SQLite 核心写入与查询。"""
import pytest, json, tempfile, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../FinSagent/src"))

from core.ResearchMemory import ResearchMemory


@pytest.fixture
def mm(tmp_path):
    m = ResearchMemory(base_dir=str(tmp_path / ".memory"))
    return m


@pytest.fixture
def sample_turn():
    return {
        "session_id": "sess_test_001",
        "question": "极氪2024年毛利率是多少？",
        "answer": "15.2%，同比+1.8个百分点",
        "citations": [
            {
                "doc_id": "zk_2024_annual_report",
                "doc_type": "pdf",
                "page": 92,
                "evidence_text": "2024年毛利率为15.2%",
                "display": "年报.pdf p92",
            }
        ],
        "facts": [
            {
                "entity": "极氪",
                "metric": "毛利率",
                "value": "15.2%",
                "unit": "",
                "period": "FY2024",
                "fact_type": "metric",
                "source_ref": "年报.pdf p92",
            }
        ],
        "audit": {"model_name": "test-model", "latency_ms": 3240},
    }


class TestPhase1SqliteCore:
    """Phase 1: record_turn + get_facts/get_audit/get_citations"""

    def test_record_turn_returns_ok(self, mm, sample_turn):
        """record_turn 返回成功。"""
        result = mm.record_turn(**sample_turn)
        assert result["ok"] is True
        assert result["message_id"].startswith("msg_")
        assert len(result["citation_ids"]) == 1
        assert result["citation_ids"][0].startswith("cit_")

    def test_get_facts_after_turn(self, mm, sample_turn):
        """写入后 facts 表可查询。"""
        mm.record_turn(**sample_turn)
        facts = mm.get_facts("极氪")
        assert len(facts) == 1
        assert facts[0]["metric"] == "毛利率"
        assert facts[0]["value"] == "15.2%"
        assert facts[0]["entity"] == "极氪"
        assert facts[0]["period"] == "FY2024"

    def test_get_facts_with_metric_filter(self, mm, sample_turn):
        """按 entity + metric 模糊查询。"""
        mm.record_turn(**sample_turn)
        facts = mm.get_facts("极氪", metric="毛利")
        assert len(facts) == 1

    def test_get_facts_no_match(self, mm, sample_turn):
        """不存在的 entity 返回空列表。"""
        mm.record_turn(**sample_turn)
        facts = mm.get_facts("蔚来")
        assert facts == []

    def test_get_audit_after_turn(self, mm, sample_turn):
        """写入后 audit_trail 可查询。"""
        mm.record_turn(**sample_turn)
        trail = mm.get_audit("sess_test_001")
        assert len(trail) == 1
        assert trail[0]["query_text"] == sample_turn["question"]
        assert trail[0]["model_name"] == "test-model"
        assert trail[0]["latency_ms"] == 3240

    def test_get_audit_no_match(self, mm, sample_turn):
        """不存在的 session 返回空列表。"""
        trail = mm.get_audit("nonexistent")
        assert trail == []

    def test_get_citations_after_turn(self, mm, sample_turn):
        """写入后 citations 可查询。"""
        result = mm.record_turn(**sample_turn)
        cits = mm.get_citations("qa_message", result["message_id"])
        assert len(cits) == 1
        assert cits[0]["doc_id"] == "zk_2024_annual_report"
        assert cits[0]["page"] == 92

    def test_get_citations_no_match(self, mm):
        """不存在的 source 返回空列表。"""
        cits = mm.get_citations("qa_message", "nonexistent")
        assert cits == []

    def test_two_facts_same_entity_both_kept(self, mm, sample_turn):
        """同一 entity 两次写入，两个版本都存在。"""
        mm.record_turn(**sample_turn)
        turn2 = dict(sample_turn)
        turn2["question"] = "毛利率修正为？"
        turn2["answer"] = "14.8%"
        turn2["facts"][0]["value"] = "14.8%"
        mm.record_turn(**turn2)

        facts = mm.get_facts("极氪")
        assert len(facts) == 2
        values = [f["value"] for f in facts]
        assert "15.2%" in values
        assert "14.8%" in values

    def test_record_turn_without_optional_args(self, mm):
        """不加 citations/facts/audit 也能写入成功。"""
        result = mm.record_turn("sess_min", "问题", "答案")
        assert result["ok"] is True
        assert len(mm.get_facts("无")) == 0

    def test_persistence_after_reinit(self, mm, sample_turn, tmp_path):
        """新实例能查到旧数据。"""
        result = mm.record_turn(**sample_turn)
        assert result["ok"]

        # 模拟重启
        mm2 = ResearchMemory(base_dir=str(tmp_path / ".memory"))
        facts = mm2.get_facts("极氪")
        assert len(facts) > 0

        trail = mm2.get_audit("sess_test_001")
        assert len(trail) > 0

    # ── Phase 2: 文件系统 ──

    def test_messages_jsonl_exists(self, mm, sample_turn):
        """写入后 messages.jsonl 存在且有 2 条消息。"""
        mm.record_turn(**sample_turn)
        msgs = mm.get_session_messages("sess_test_001")
        assert len(msgs) == 2
        assert msgs[0]["role"] == "user"
        assert msgs[1]["role"] == "assistant"

    def test_content_md_exists(self, mm, sample_turn):
        """写入后 content.md 存在且包含问答内容。"""
        mm.record_turn(**sample_turn)
        content = mm.read_memory("fin://sessions/sess_test_001", "L2")
        assert "极氪" in content
        assert "15.2%" in content

    def test_content_md_has_citations(self, mm, sample_turn):
        """content.md 中包含引用信息。"""
        mm.record_turn(**sample_turn)
        content = mm.read_memory("fin://sessions/sess_test_001", "L2")
        assert "引用" in content
        assert "年报.pdf" in content

    def test_overview_md_exists(self, mm, sample_turn):
        """写入后 .overview.md 存在。"""
        mm.record_turn(**sample_turn)
        session_path = mm._uri_to_path("fin://sessions/sess_test_001")
        overview = (session_path / ".overview.md").read_text(encoding="utf-8")
        assert "极氪" in overview or "15.2%" in overview

    def test_abstract_md_exists(self, mm, sample_turn):
        """写入后 .abstract.md 存在。"""
        mm.record_turn(**sample_turn)
        abstract = mm.read_memory("fin://sessions/sess_test_001", "L0")
        assert len(abstract) > 0
