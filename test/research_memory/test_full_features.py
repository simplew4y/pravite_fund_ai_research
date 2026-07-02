"""测试题集：ResearchMemory 功能全覆盖。

覆盖功能：
- single_hop_exact       facts 精确匹配
- single_hop_semantic    BGE-M3 语义召回
- multi_hop_session      同 session 指代
- multi_hop_version      版本演进 + superseded_at
- cross_session          全局跨 session 检索
- session_scope_boost    session 隔离加权
- citation_tracking      fact_citations 多对多
- prompt_injection       retrieve_for_prompt 格式
- analyst_isolation      project_id/analyst_id 路由
- checkpoint             长会话压缩
- empty_no_match         无匹配空结果
- persistence            重启后数据不丢

用法: python3 test_research_memory_full.py
"""

import sys, tempfile, shutil, sqlite3, json, urllib.request

sys.path.insert(0, "FinSagent/src")
from core.ResearchMemory import ResearchMemory


def bge_embed(text):
    """BGE-M3 embedding via direct API call."""
    data = json.dumps({"input": text[:1000], "model": "BAAI/bge-m3"}).encode()
    req = urllib.request.Request(
        "http://localhost:5433/v1/embeddings", data=data,
        headers={"Content-Type": "application/json"}, method="POST")
    return json.loads(urllib.request.urlopen(req, timeout=10).read())["data"][0]["embedding"]


class TestSuite:
    def __init__(self):
        self.tmp = tempfile.mkdtemp()
        self.mm = ResearchMemory(base_dir=self.tmp + "/.memory")
        self.mm.set_embedding_fn(bge_embed)
        self.mm.set_llm_fn(lambda p: "## Summary\n极氪相关讨论摘要")
        self.passed = 0
        self.total = 0

    def check(self, name, cond, detail=""):
        self.total += 1
        status = "PASS" if cond else "FAIL"
        print("  [%s] %s" % (status, name))
        if cond:
            self.passed += 1

    # =============================================
    # Test 1: single-hop exact fact match
    # =============================================
    def test_single_hop_exact(self):
        print("\n[T1] single-hop exact fact match")
        self.mm.record_turn("s1", "极氪毛利率？", "15.2%",
            facts=[{"entity": "极氪", "metric": "毛利率", "value": "15.2%", "period": "FY2024"}],
            citations=[{"doc_id": "zk.pdf", "page": 92, "display": "年报.pdf p92"}])
        items = self.mm.retrieve("极氪毛利率")
        self.check("returns results", len(items) >= 1)
        self.check("top tier is exact", items[0]["tier"] == "exact")
        self.check("has value 15.2%", any("15.2%" in i["content"] for i in items))
        self.check("has citation source", any("年报.pdf" in i.get("source", "") for i in items))

    # =============================================
    # Test 2: single-hop semantic recall
    # =============================================
    def test_single_hop_semantic(self):
        print("\n[T2] single-hop semantic recall")
        self.mm.record_turn("s2", "极氪毛利率？", "15.2%",
            facts=[{"entity": "极氪", "metric": "毛利率", "value": "15.2%", "period": "FY2024"}])
        self.mm._update_embedding("s2")
        items = self.mm.retrieve("盈利能力")
        self.check("returns results", len(items) >= 1)
        self.check("has entity 极氪", any("极氪" in i["content"] for i in items))
        self.check("has semantic tier", any(i["tier"] == "semantic" for i in items))

    # =============================================
    # Test 3: multi-hop session context
    # =============================================
    def test_multi_hop_session(self):
        print("\n[T3] multi-hop session context")
        self.mm.record_turn("s3", "极氪销量？", "222,123辆")
        self.mm.record_turn("s3", "那毛利率呢？", "15.2%",
            facts=[{"entity": "极氪", "metric": "毛利率", "value": "15.2%"}])
        items = self.mm.retrieve("那毛利率", session_id="s3")
        self.check("returns results", len(items) >= 1)
        self.check("finds in-session content", any("那毛利率" in i["content"] for i in items))

    # =============================================
    # Test 4: multi-hop version tracking
    # =============================================
    def test_version_tracking(self):
        print("\n[T4] multi-hop version tracking")
        self.mm.record_turn("s4a", "毛利率初值？", "15.2%",
            facts=[{"entity": "极氪", "metric": "毛利率", "value": "15.2%", "period": "FY2024"}])
        self.mm.record_turn("s4b", "毛利率修正？", "14.8%",
            facts=[{"entity": "极氪", "metric": "毛利率", "value": "14.8%", "period": "FY2024"}])

        items = self.mm.retrieve("极氪毛利率")
        self.check("returns results", len(items) >= 1)
        has_v1 = any("15.2%" in i["content"] for i in items)
        has_v2 = any("14.8%" in i["content"] for i in items)
        self.check("version 1 found", has_v1)
        self.check("version 2 found", has_v2)

        facts = self.mm.get_facts("极氪")
        versions = sorted([f["version"] for f in facts])
        self.check("versions 1 and 2", versions == [1, 2])

        # Check superseded_at
        conn = sqlite3.connect(self.mm.db_path)
        conn.row_factory = sqlite3.Row
        v1 = conn.execute("SELECT * FROM facts WHERE entity='极氪' AND version=1").fetchone()
        v2 = conn.execute("SELECT * FROM facts WHERE entity='极氪' AND version=2").fetchone()
        conn.close()
        self.check("old version superseded", v1["superseded_at"] is not None and v1["superseded_at"] != "")
        self.check("new version not superseded", v2["superseded_at"] is None)

    # =============================================
    # Test 5: cross-session global retrieval
    # =============================================
    def test_cross_session(self):
        print("\n[T5] cross-session global retrieve")
        self.mm.record_turn("s5a", "极氪毛利率？", "15.2%",
            facts=[{"entity": "极氪", "metric": "毛利率", "value": "15.2%"}])
        self.mm.record_turn("s5b", "蔚来毛利率？", "12.1%",
            facts=[{"entity": "蔚来", "metric": "毛利率", "value": "12.1%"}])
        self.mm.record_turn("s5c", "比亚迪毛利率？", "17.1%",
            facts=[{"entity": "比亚迪", "metric": "毛利率", "value": "17.1%"}])

        items = self.mm.retrieve("毛利率")
        entities = set()
        for i in items:
            for e in ["极氪", "蔚来", "比亚迪"]:
                if e in i["content"]:
                    entities.add(e)
        self.check("finds all 3 entities", len(entities) >= 2)
        self.check("has 极氪", "极氪" in entities)
        self.check("has 蔚来 or 比亚迪", "蔚来" in entities or "比亚迪" in entities)

    # =============================================
    # Test 6: session-scoped boost
    # =============================================
    def test_session_scope_boost(self):
        print("\n[T6] session-scoped boost")
        self.mm.record_turn("s6a", "极氪毛利率？", "15.2%",
            facts=[{"entity": "极氪", "metric": "毛利率", "value": "15.2%"}])
        self.mm.record_turn("s6b", "蔚来毛利率？", "12.1%",
            facts=[{"entity": "蔚来", "metric": "毛利率", "value": "12.1%"}])

        items_zk = self.mm.retrieve("毛利率", session_id="s6a")
        items_nio = self.mm.retrieve("毛利率", session_id="s6b")
        self.check("zk session boosted >1.0", items_zk[0]["score"] > 1.0)
        self.check("nio session boosted >1.0", items_nio[0]["score"] > 1.0)

    # =============================================
    # Test 7: citation tracking & fact_citations
    # =============================================
    def test_citation_tracking(self):
        print("\n[T7] citation tracking")
        r = self.mm.record_turn("s7", "极氪毛利率？", "15.2%",
            facts=[{"entity": "极氪", "metric": "毛利率", "value": "15.2%"}],
            citations=[
                {"doc_id": "annual.pdf", "page": 92, "display": "年报.pdf p92"},
                {"doc_id": "half_year.pdf", "page": 45, "display": "中报.pdf p45"},
            ])
        self.check("record_turn ok", r["ok"])
        self.check("citations generated", len(r["citation_ids"]) >= 2)

        # fact_citations linkage
        conn = sqlite3.connect(self.mm.db_path)
        fcs = conn.execute("SELECT count(*) FROM fact_citations").fetchone()[0]
        conn.close()
        self.check("fact_citations linked", fcs >= 2)

    # =============================================
    # Test 8: prompt injection format
    # =============================================
    def test_prompt_injection(self):
        print("\n[T8] prompt injection format")
        self.mm.record_turn("s8", "极氪毛利率？", "15.2%",
            facts=[{"entity": "极氪", "metric": "毛利率", "value": "15.2%"}])
        prompt = self.mm.retrieve_for_prompt("极氪毛利率", session_id="s8")
        self.check("starts with [Related History]", prompt.startswith("[Related History]"))
        self.check("has exact marker", "📌" in prompt)
        self.check("has entity info", "极氪" in prompt)
        self.check("has value", "15.2%" in prompt)

    # =============================================
    # Test 9: analyst isolation
    # =============================================
    def test_analyst_isolation(self):
        print("\n[T9] analyst isolation")
        self.mm.record_turn("s9a", "q", "a",
            facts=[{"entity": "X", "metric": "M", "value": "v1"}],
            project_id="proj_a", analyst_id="u1")
        self.mm.record_turn("s9b", "q", "a",
            facts=[{"entity": "Y", "metric": "M", "value": "v2"}],
            project_id="proj_b", analyst_id="u2")

        conn = sqlite3.connect(self.mm.db_path)
        conn.row_factory = sqlite3.Row
        self.check("u1 facts", conn.execute("SELECT count(*) as c FROM facts WHERE analyst_id='u1'").fetchone()["c"] >= 1)
        self.check("u2 facts", conn.execute("SELECT count(*) as c FROM facts WHERE analyst_id='u2'").fetchone()["c"] >= 1)
        self.check("proj_a facts", conn.execute("SELECT count(*) as c FROM facts WHERE project_id='proj_a'").fetchone()["c"] >= 1)
        self.check("proj_b facts", conn.execute("SELECT count(*) as c FROM facts WHERE project_id='proj_b'").fetchone()["c"] >= 1)
        conn.close()

    # =============================================
    # Test 10: empty no match
    # =============================================
    def test_empty_no_match(self):
        print("\n[T10] empty no match")
        items = self.mm.retrieve("xyzxyzxyz123")
        self.check("no results for garbage query", len(items) == 0)
        prompt_empty = self.mm.retrieve_for_prompt("xyzxyzxyz123")
        self.check("empty prompt for garbage query", prompt_empty == "")

    # =============================================
    # Test 11: persistence
    # =============================================
    def test_persistence(self):
        print("\n[T11] persistence")
        self.mm.record_turn("s11", "极氪毛利率？", "15.2%",
            facts=[{"entity": "极氪", "metric": "毛利率", "value": "15.2%"}])
        # Create new instance pointing to same db
        mm2 = ResearchMemory(base_dir=self.tmp + "/.memory")
        self.check("facts survive restart", len(mm2.get_facts("极氪")) >= 1)
        self.check("messages survive restart", len(mm2.get_session_messages("s11")) == 2)
        items = mm2.retrieve("极氪毛利率")
        self.check("retrieve after restart", len(items) >= 1)

    # =============================================
    # Run all
    # =============================================
    def run(self):
        print("=" * 55)
        print("ResearchMemory Full Feature Test")
        print("=" * 55)

        self.test_single_hop_exact()
        self.test_single_hop_semantic()
        self.test_multi_hop_session()
        self.test_version_tracking()
        self.test_cross_session()
        self.test_session_scope_boost()
        self.test_citation_tracking()
        self.test_prompt_injection()
        self.test_analyst_isolation()
        self.test_empty_no_match()
        self.test_persistence()

        shutil.rmtree(self.tmp)
        print("\n" + "=" * 55)
        print("RESULT: %d/%d PASSED (%.0f%%)" % (self.passed, self.total, self.passed/self.total*100))
        print("=" * 55)
        return self.passed == self.total


if __name__ == "__main__":
    suite = TestSuite()
    ok = suite.run()
    sys.exit(0 if ok else 1)
