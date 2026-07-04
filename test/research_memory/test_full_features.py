"""ResearchMemory 全覆盖测试（每个测试独立 mm 实例）。"""
import sys, tempfile, shutil, sqlite3, json, urllib.request
sys.path.insert(0, "FinSagent/src")
from core.ResearchMemory import ResearchMemory

def bge_embed(text):
    d = json.dumps({"input": text[:1000], "model": "BAAI/bge-m3"}).encode()
    r = urllib.request.Request("http://localhost:5433/v1/embeddings", data=d,
        headers={"Content-Type": "application/json"}, method="POST")
    return json.loads(urllib.request.urlopen(r, timeout=10).read())["data"][0]["embedding"]

def fresh_mm():
    t = tempfile.mkdtemp()
    mm = ResearchMemory(base_dir=t + "/.memory")
    mm.set_embedding_fn(bge_embed)
    return mm, t

p = 0; t = 0
def tc(n, c):
    global p, t; t += 1; s = "PASS" if c else "FAIL"; print("  [%s] %s" % (s, n)); p += c

print("=" * 50)
print("RESEARCH MEMORY FULL TEST")
print("=" * 50)

# T1: single-hop exact fact match
print("\n[T1] exact fact")
mm, tmp = fresh_mm()
r = mm.record_turn("s1", "极氪毛利率？", "15.2%",
    facts=[{"entity": "极氪", "metric": "毛利率", "value": "15.2%", "period": "FY2024"}],
    citations=[{"doc_id": "zk_2024.pdf", "page": 92, "display": "年报.pdf p92"}])
tc("record_turn ok", r["ok"])
items = mm.retrieve("极氪毛利率")
tc("has results", len(items) >= 1)
tc("tier exact", items[0]["tier"] == "exact")
tc("value in content", any("15.2%" in i["content"] for i in items))
# Citation check via fact_citations
conn = sqlite3.connect(mm.db_path)
fc = conn.execute("SELECT count(*) FROM fact_citations").fetchone()[0]
conn.close()
tc("fact_citations linked", fc >= 1)
shutil.rmtree(tmp)

# T2: semantic recall
print("\n[T2] semantic")
mm, tmp = fresh_mm()
mm.record_turn("s2", "极氪毛利率？", "15.2%", facts=[{"entity": "极氪", "metric": "毛利率", "value": "15.2%"}])
mm._update_embedding("s2")
items = mm.retrieve("盈利能力")
tc("semantic results", len(items) >= 1)
tc("has semantic tier", any(i["tier"] == "semantic" for i in items))
shutil.rmtree(tmp)

# T3: session context
print("\n[T3] session context")
mm, tmp = fresh_mm()
mm.record_turn("s3", "极氪销量？", "222,123辆")
mm.record_turn("s3", "那毛利率呢？", "15.2%", facts=[{"entity": "极氪", "metric": "毛利率", "value": "15.2%"}])
items = mm.retrieve("那毛利率", session_id="s3")
tc("in-session content", len(items) >= 1 and any("那毛利率" in i["content"] for i in items))
shutil.rmtree(tmp)

# T4: version tracking
print("\n[T4] version")
mm, tmp = fresh_mm()
mm.record_turn("s4a", "初值", "15.2%", facts=[{"entity": "极氪", "metric": "毛利率", "value": "15.2%"}])
mm.record_turn("s4b", "修正", "14.8%", facts=[{"entity": "极氪", "metric": "毛利率", "value": "14.8%"}])
facts = mm.get_facts("极氪")
vers = sorted([f["version"] for f in facts])
tc("versions 1,2", vers == [1, 2])
conn = sqlite3.connect(mm.db_path)
conn.row_factory = sqlite3.Row
v1 = conn.execute("SELECT * FROM facts WHERE entity='极氪' AND version=1").fetchone()
v2 = conn.execute("SELECT * FROM facts WHERE entity='极氪' AND version=2").fetchone()
conn.close()
tc("v1 superseded", v1["superseded_at"] not in (None, ""))
tc("v2 not superseded", v2["superseded_at"] is None)
items = mm.retrieve("极氪毛利率")
tc("v1 value in results", any("15.2%" in i["content"] for i in items))
tc("v2 value in results", any("14.8%" in i["content"] for i in items))
shutil.rmtree(tmp)

# T5: cross-session
print("\n[T5] cross-session")
mm, tmp = fresh_mm()
mm.record_turn("a", "极氪毛利率？", "15.2%", facts=[{"entity": "极氪", "metric": "毛利率", "value": "15.2%"}])
mm.record_turn("b", "蔚来毛利率？", "12.1%", facts=[{"entity": "蔚来", "metric": "毛利率", "value": "12.1%"}])
items = mm.retrieve("毛利率")
ents = set()
for i in items:
    for e in ["极氪", "蔚来"]:
        if e in i["content"]:
            ents.add(e)
tc("cross-session entities", len(ents) >= 2)
shutil.rmtree(tmp)

# T6: session boost
print("\n[T6] session boost")
mm, tmp = fresh_mm()
mm.record_turn("a", "极氪毛利率？", "15.2%", facts=[{"entity": "极氪", "metric": "毛利率", "value": "15.2%"}])
mm.record_turn("b", "蔚来毛利率？", "12.1%", facts=[{"entity": "蔚来", "metric": "毛利率", "value": "12.1%"}])
items_a = mm.retrieve("毛利率", session_id="a")
items_b = mm.retrieve("毛利率", session_id="b")
tc("a boosted", items_a[0]["score"] > 1.0)
tc("b boosted", items_b[0]["score"] > 1.0)
shutil.rmtree(tmp)

# T7: prompt injection
print("\n[T7] prompt injection")
mm, tmp = fresh_mm()
mm.record_turn("s", "极氪毛利率？", "15.2%", facts=[{"entity": "极氪", "metric": "毛利率", "value": "15.2%"}])
prompt = mm.retrieve_for_prompt("极氪毛利率", session_id="s")
tc("format correct", prompt.startswith("[Related History]"))
tc("has marker", "📌" in prompt)
tc("has value", "15.2%" in prompt)
shutil.rmtree(tmp)

# T8: analyst isolation
print("\n[T8] analyst isolation")
mm, tmp = fresh_mm()
mm.record_turn("a", "q", "a", facts=[{"entity": "X", "metric": "M", "value": "v1"}], project_id="pa", analyst_id="u1")
mm.record_turn("b", "q", "a", facts=[{"entity": "Y", "metric": "M", "value": "v2"}], project_id="pb", analyst_id="u2")
conn = sqlite3.connect(mm.db_path)
conn.row_factory = sqlite3.Row
tc("u1 facts", conn.execute("SELECT count(*) FROM facts WHERE analyst_id='u1'").fetchone()[0] == 1)
tc("u2 facts", conn.execute("SELECT count(*) FROM facts WHERE analyst_id='u2'").fetchone()[0] == 1)
tc("pa facts", conn.execute("SELECT count(*) FROM facts WHERE project_id='pa'").fetchone()[0] == 1)
conn.close()
shutil.rmtree(tmp)

# T9: empty/garbage query
print("\n[T9] empty query")
mm, tmp = fresh_mm()
tc("retrieve empty", len(mm.retrieve("")) == 0)
tc("retrieve space", len(mm.retrieve("  ")) == 0)
tc("retrieve garbage", len(mm.retrieve("xyzxyzxyz123")) == 0)
tc("prompt empty", mm.retrieve_for_prompt("") == "")
tc("prompt garbage", mm.retrieve_for_prompt("xyzxyzxyz123") == "")
shutil.rmtree(tmp)

# T10: persistence
print("\n[T10] persistence")
mm, tmp = fresh_mm()
mm.record_turn("s", "极氪毛利率？", "15.2%", facts=[{"entity": "极氪", "metric": "毛利率", "value": "15.2%"}])
db_path = mm.db_path  # save path before destroying
base_dir = tmp + "/.memory"
del mm
mm2 = ResearchMemory(base_dir=base_dir)
tc("facts persist", len(mm2.get_facts("极氪")) >= 1)
tc("messages persist", len(mm2.get_session_messages("s")) == 2)
shutil.rmtree(tmp)

# T11: global memory
print("\n[T11] global memory")
mm, tmp = fresh_mm()
mm.set_global_memory("style", "简练回答")
tc("set/get", mm.get_global_memory("style") == "简练回答")
mm.set_global_memory("theme", "新能源", analyst_id="a1")
mm.set_global_memory("theme", "半导体", analyst_id="a2")
tc("analyst isolation", mm.get_global_memory("theme", analyst_id="a1") == "新能源")
tc("analyst a2", mm.get_global_memory("theme", analyst_id="a2") == "半导体")
txt = mm.get_global_memory_text()
tc("global text", "[Global Memory]" in txt and "简练回答" in txt)
shutil.rmtree(tmp)

print("\n" + "=" * 50)
print("RESULT: %d/%d PASSED (%.0f%%)" % (p, t, p/t*100))
print("=" * 50)
