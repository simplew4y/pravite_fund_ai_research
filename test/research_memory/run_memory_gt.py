"""
ResearchMemory CBT: 读 memory_gt.json → 设置前置场景 → 验证检索结果.
"""
import sys, json, tempfile, shutil, urllib.request, traceback, os
sys.path.insert(0, "FinSagent/src")
from core.ResearchMemory import ResearchMemory

GT_PATH = "test/research_memory/memory_gt.json"
SUITE = json.load(open(GT_PATH))

def bge_embed(t):
    d = json.dumps({"input": t[:1000], "model": "BAAI/bge-m3"}).encode()
    r = urllib.request.Request("http://localhost:5433/v1/embeddings", data=d,
        headers={"Content-Type": "application/json"}, method="POST")
    return json.loads(urllib.request.urlopen(r, timeout=10).read())["data"][0]["embedding"]

def setup_case(mm, case):
    """设置测试前置条件."""
    s = case.get("setup", {})
    # Sessions
    for sess in s.get("sessions", []):
        for turn in sess.get("turns", []):
            kwargs = dict(
                session_id=sess["id"],
                question=turn["q"],
                answer=turn["a"],
                facts=turn.get("facts"),
                citations=turn.get("citations"),
                project_id=turn.get("project_id", "default"),
                analyst_id=turn.get("analyst_id", ""),
            )
            mm.record_turn(**{k: v for k, v in kwargs.items() if v is not None})
    # Global memory
    for gm in s.get("global_memory", []):
        mm.set_global_memory(gm["key"], gm["value"], category=gm.get("category", "preference"))
    # Analysts
    for a in s.get("analysts", []):
        for sess in a.get("sessions", []):
            for turn in sess.get("turns", []):
                mm.record_turn(
                    session_id=sess["id"], question=turn["q"], answer=turn["a"],
                    facts=turn.get("facts"), citations=turn.get("citations"),
                    project_id=a.get("project", "default"), analyst_id=a["id"])
    # Update embedding if needed
    if s.get("embedding"):
        for sess in s.get("sessions", []):
            mm._update_embedding(sess["id"])

def check_assertions(mm, case):
    """验证断言."""
    a = case["assertions"]
    results = {}
    q = case["question"]
    sid = case.get("setup", {}).get("sessions", [{}])[0].get("id") if case.get("setup", {}).get("sessions") else None

    for sess_info in case.get("setup", {}).get("sessions", []):
        sid = sess_info["id"]
        break
    else:
        sid = None

    # Retrieve
    items = mm.retrieve(q, session_id=sid)

    # min_results
    if "min_results" in a:
        results["min_results"] = len(items) >= a["min_results"]

    # top_tier
    if "top_tier" in a:
        results["top_tier"] = len(items) > 0 and items[0]["tier"] == a["top_tier"]

    # content_contains
    if "content_contains" in a:
        joined = " ".join(i["content"] for i in items)
        results["content_contains"] = all(x in joined for x in a["content_contains"])

    # entities_found
    if "entities_found" in a:
        ents = set()
        for i in items:
            for e in a["entities_found"]:
                if e in i["content"]:
                    ents.add(e)
        results["entities_found"] = len(ents) >= len(a["entities_found"])

    # has_semantic_tier
    if "has_semantic_tier" in a:
        results["has_semantic_tier"] = any(i["tier"] == "semantic" for i in items)

    # score_gt
    if "score_gt" in a:
        results["score_gt"] = len(items) > 0 and items[0]["score"] > a["score_gt"]

    # versions
    if "versions" in a:
        facts = mm.get_facts(a["versions"][0] if a["versions"] else "")
        vers_found = any(f["version"] in a["versions"] for f in facts) if facts else False
        # Try exact match
        for ent in ["极氪", "蔚来", "比亚迪"]:
            f2 = mm.get_facts(ent)
            if f2:
                vers = sorted([f["version"] for f in f2])
                results["versions"] = vers == a["versions"]
                break

    if "v1_superseded" in a:
        try:
            conn2 = sqlite3.connect(mm.db_path)
            conn2.row_factory = sqlite3.Row
            rows = conn2.execute("SELECT entity, superseded_at FROM facts WHERE version=1 AND entity IN ('极氪','蔚来','比亚迪')").fetchall()
            if rows:
                results["v1_superseded"] = any(r["superseded_at"] not in (None, "") for r in rows)
            else:
                results["v1_superseded"] = False
            conn2.close()
        except Exception:
            results["v1_superseded"] = False

    if "v2_not_superseded" in a:
        try:
            conn3 = sqlite3.connect(mm.db_path)
            conn3.row_factory = sqlite3.Row
            rows2 = conn3.execute("SELECT entity, superseded_at FROM facts WHERE version=2 AND entity IN ('极氪','蔚来','比亚迪')").fetchall()
            if rows2:
                results["v2_not_superseded"] = all(r["superseded_at"] in (None, "") for r in rows2)
            else:
                results["v2_not_superseded"] = False
            conn3.close()
        except Exception:
            results["v2_not_superseded"] = False

    # fact_citations
    if "fact_citations" in a:
        fc = a["fact_citations"]
        try:
            import sqlite3
            conn = sqlite3.connect(mm.db_path)
            c = conn.execute("SELECT count(*) FROM fact_citations").fetchone()[0]
            conn.close()
            results["fact_citations"] = c >= fc.get("min", 1)
        except Exception:
            results["fact_citations"] = False

    # retrieve_results (empty)
    if "retrieve_results" in a:
        results["retrieve_results"] = len(items) == a["retrieve_results"]

    # prompt_empty
    if "prompt_empty" in a:
        p = mm.retrieve_for_prompt(q, session_id=sid)
        results["prompt_empty"] = (p == "") if a["prompt_empty"] else (p != "")

    # global_memory_text_contains
    if "global_memory_text_contains" in a:
        txt = mm.get_global_memory_text()
        results["global_memory_text"] = all(x in txt for x in a["global_memory_text_contains"])

    # prompt_starts_with
    if "prompt_starts_with" in a:
        p = mm.retrieve_for_prompt(q, session_id=sid)
        results["prompt_starts_with"] = p.startswith(a["prompt_starts_with"])

    # prompt_has_marker/value
    if "prompt_has_marker" in a:
        p = mm.retrieve_for_prompt(q, session_id=sid)
        results["prompt_has_marker"] = "\U0001f4cc" in p  # 📌
    if "prompt_has_value" in a:
        p = mm.retrieve_for_prompt(q, session_id=sid)
        results["prompt_has_value"] = a["prompt_has_value"] in p

    # facts_survive_restart
    if "facts_survive_restart" in a:
        db_path = str(mm.db_path)
        base_dir = os.path.dirname(db_path)
        del mm
        mm2 = ResearchMemory(base_dir=base_dir)
        facts = mm2.get_facts("极氪")
        results["facts_survive_restart"] = len(facts) >= 1

    # messages_survive_restart
    if "messages_survive_restart" in a:
        msgs = mm2.get_session_messages("persist_s")
        results["messages_survive_restart"] = len(msgs) == 2

    return results


passed = 0
total = 0
print("=" * 55)
print("MEMORY GT - CBT RESULTS")
print("=" * 55)

for case in SUITE:
    tmp = tempfile.mkdtemp()
    mm = ResearchMemory(base_dir=tmp + "/.memory")
    try:
        mm.set_embedding_fn(bge_embed)
        setup_case(mm, case)
        results = check_assertions(mm, case)

        case_pass = all(results.values())
        if case_pass:
            passed += 1
        total += 1

        if results:
            detail = " | ".join(f"{k}:{'OK' if v else 'FAIL'}" for k, v in sorted(results.items()))
        else:
            detail = "no assertions"
        print(" [%s] T%d %s" % ("PASS" if case_pass else "FAIL", case["idx"], case["feature"]))
        if not case_pass:
            print("      " + detail)
    except Exception as e:
        print(" [FAIL] T%d %s - ERROR: %s" % (case["idx"], case["feature"], str(e)[:80]))
        total += 1
    finally:
        shutil.rmtree(tmp)

print("\n" + "=" * 55)
print("RESULT: %d/%d PASSED (%.0f%%)" % (passed, total, passed/total * 100))
print("=" * 55)
