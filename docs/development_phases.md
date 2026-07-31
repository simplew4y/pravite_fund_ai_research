# Research Memory — 分阶段开发计划

> 分支: `lzx_memo`
> 每个阶段都是独立可用版本，做好 git tag 管理。

---

## 阶段划分

```
Phase 1 ─── SQLite 核心 ─── 可独立验证的数据层
     │
Phase 2 ─── 文件系统层 ─── 磁盘上有完整归档
     │
Phase 3 ─── 检索闭环 ─── 能问能答 (FTS5)
     │
Phase 4 ─── 长会话管理 ─── 10+ 轮对话不崩
     │
Phase 5 ─── 语义检索 ─── OpenViking 接入
     │
Phase 6 ─── REST API ─── 前端能调
     │
Phase 7 ─── 集成验收 ─── ChatService 联调
```

---

## Phase 1：SQLite 核心

**目标：** ResearchMemory 能创建表、能写入事实和引用、能查询。

**可交付：** 一个可 import 的 Python 类 + pytest

### 实现内容

```
ResearchMemory.__init__()
  → 继承 MemoryManager，建 qa_sessions / qa_messages / facts / citations / audit_trail 表

ResearchMemory.record_turn()  ← SQLite 写入部分
  → INSERT qa_messages (user + assistant)
  → INSERT facts (batch)
  → INSERT citations (batch)
  → INSERT audit_trail
  → 返回 {ok, message_id, citation_ids}

ResearchMemory.get_facts(entity, metric)
  → SELECT FROM facts WHERE entity=?

ResearchMemory.get_audit(session_id)
  → SELECT FROM audit_trail WHERE session_id=?

ResearchMemory.get_citations(source_type, source_id)
  → SELECT FROM citations WHERE source_type=? AND source_id=?
```

### 不做的

- 不写 messages.jsonl / content.md 等文件
- 不做检索
- 不做 checkpoint

### 验证

```python
from core.ResearchMemory import ResearchMemory

mm = ResearchMemory(base_dir="/tmp/test_phase1")
result = mm.record_turn("sess_001", "极氪毛利率？", "15.2%",
    citations=[{"doc_id": "zk.pdf", "page": 92, "evidence_text": "15.2%"}],
    facts=[{"entity": "极氪", "metric": "毛利率", "value": "15.2%", "period": "FY2024"}],
    audit={"model_name": "test", "latency_ms": 100})

assert result["ok"]
assert len(mm.get_facts("极氪")) == 1
assert len(mm.get_audit("sess_001")) == 1
assert len(mm.get_citations("qa_message", result["message_id"])) == 1
```

**git:**
```bash
git add FinSagent/src/core/ResearchMemory.py
git commit -m "[research-memory] phase 1: SQLite core (facts/citations/audit/tables)"
```

---

## Phase 2：文件系统层

**目标：** record_turn 同时写文件（messages.jsonl / content.md），磁盘上有完整归档。

**可交付：** 文件系统 + SQLite 双重存储

### 实现内容

```
record_turn() 中新增:
  append_session_message("user", question)     ← 写 JSONL + MD
  append_session_message("assistant", answer)  ← 写 JSONL + MD
  更新 .overview.md (最近 6 条)
  更新 .abstract.md (最新消息摘要)
```

### 验证

```python
mm.record_turn("sess_001", "极氪毛利率？", "15.2%")
msgs = mm.get_session_messages("sess_001")
assert len(msgs) == 2

content = mm.read_memory("fin://sessions/sess_001", "L2")
assert "极氪" in content
assert "15.2%" in content
assert "引用" in content or "citation" in content
```

**git:**
```bash
git commit -m "[research-memory] phase 2: file system persistence (jsonl + content.md)"
```

---

## Phase 3：检索闭环

**目标：** 能通过 retrieve() / retrieve_for_prompt() 召回已写入的记忆。

**可交付：** query → [Related History] → 注入 prompt 的完整链路

### 实现内容

```
ResearchMemory.retrieve(query, top_k=5)
  → _search_exact()  ← FTS5 + facts 表
     facts WHERE entity=? OR metric LIKE ?
     memory_fts MATCH ?
  → _merge() ← 排序 + 按 source 去重
  → return [{content, score, tier, source}]

ResearchMemory.retrieve_for_prompt(query, top_k=5)
  → retrieve() + 格式化为 "[Related History]..."
  → return str
```

### 验证

```python
mm.record_turn("sess_001", "极氪毛利率？", "15.2%", facts=[{...}])
items = mm.retrieve("毛利率")
assert len(items) > 0
assert items[0]["score"] == 1.0
assert "15.2%" in items[0]["content"]

prompt = mm.retrieve_for_prompt("毛利率")
assert prompt.startswith("[Related History]")
```

**git:**
```bash
git commit -m "[research-memory] phase 3: retrieval loop (FTS5 + facts + merge)"
```

---

## Phase 4：长会话管理

**目标：** 超过 5 轮的对话自动做 checkpoint 压缩，content.md 不无限膨胀。

**可交付：** 稳定的长对话记忆

### 实现内容

```
ResearchMemory._checkpoint_session(session_id, turn_count, interval=5)
  → turn_count % 5 == 0 时触发
  → 读取 .checkpoint.md (如有)
  → LLM: 旧摘要 + 新 5 轮 → 新摘要 (或首次压缩)
  → 写入 .checkpoint.md
  → content.md = 新摘要 + "---" + 最近 5 轮完整内容

ResearchMemory.set_llm_fn(fn)  ← 注入 LLM
```

### 验证

```python
mm.set_llm_fn(lambda p: "## 会话摘要\n- 涉及公司: 极氪\n- 核心数据: 毛利率 15.2%")
for i in range(6):
    mm.record_turn("sess_long", f"问题{i}", f"回答{i}")
content = mm.read_memory("fin://sessions/sess_long", "L2")
assert "会话摘要" in content  # checkpoint 已写入
assert "问题5" in content     # 最新一轮完整保留
```

**git:**
```bash
git commit -m "[research-memory] phase 4: long session checkpoint (every 5 turns)"
```

---

## Phase 5：语义检索

**目标：** OpenViking 语义检索接入，检索结果包含模糊匹配。

**可交付：** 精确 + 语义混合检索

### 实现内容

```
ResearchMemory.set_embedding_fn(fn)  ← 注入 BGE-M3

ResearchMemory._search_semantic(query, limit)
  → _embed(query) → 余弦相似度 → 过滤 score>0.3

ResearchMemory._merge() 中:
  exact 保持 score
  semantic score *= 0.7
  合并排序
```

### 验证

```python
mm.set_embedding_fn(lambda t: [0.1, 0.2, 0.3])  # mock embedding
mm.record_turn("sess_001", "极氪毛利率？", "15.2%")
items = mm.retrieve("盈利能力")
assert any(i["tier"] == "semantic" for i in items)
```

**git:**
```bash
git commit -m "[research-memory] phase 5: semantic retrieval (OpenViking/bge-m3)"
```

---

## Phase 6：REST API

**目标：** 前端和 agent 能通过 HTTP 调 memory。

**可交付：** 5 个端点 + FastAPI 启动

### 实现内容

```python
# deploy/memory_routes.py
POST   /memory/turn          → record_turn()
GET    /memory/retrieve?q=   → retrieve()
GET    /memory/facts?entity= → get_facts()
GET    /memory/audit/{id}    → get_audit()
GET    /memory/citations     → get_citations()
```

### 验证

```bash
curl -X POST localhost:10052/memory/turn \
  -H "Content-Type: application/json" \
  -d '{"session_id":"s1","question":"q","answer":"a"}' | jq .

curl "localhost:10052/memory/retrieve?q=毛利率" | jq .
```

**git:**
```bash
git add deploy/memory_routes.py
git commit -m "[research-memory] phase 6: REST API endpoints"
```

---

## Phase 7：集成验收

**目标：** ChatService 接入 + 全部测试通过 + README 更新。

**可交付：** 完整可用模块

### 实现内容

```
ChatService.__init__ 中:
  self.memory = ResearchMemory(config.memory.dir)
  self.memory.set_embedding_fn(...)
  self.memory.set_llm_fn(...)

ChatService.generate_response_stream 中:
  入口: memory.retrieve_for_prompt(query)
  出口: asyncio.create_task(async_record_turn(...))

README.md 更新:
  "验证方式：运行 test/research_memory/，并 curl memory API"
```

### 验证

```bash
pytest test/research_memory/ -v
# 全部 10 个测试通过

curl localhost:10052/memory/retrieve?q=极氪
# 返回历史数据
```

**git:**
```bash
git add FinSagent/src/core/ResearchMemory.py deploy/memory_routes.py config/production.yaml
git commit -m "[research-memory] phase 7: ChatService integration + full tests"
```

---

## 分支管理

```text
lzx_memo
  │
  ├── phase-1-sqlite-core     ← tag v0.1.0
  ├── phase-2-file-system     ← tag v0.2.0
  ├── phase-3-retrieval       ← tag v0.3.0
  ├── phase-4-checkpoint      ← tag v0.4.0
  ├── phase-5-semantic        ← tag v0.5.0
  ├── phase-6-rest-api        ← tag v0.6.0
  └── phase-7-integration     ← tag v0.7.0 (merge to main)
```

每个阶段打 tag，每个 tag 都是可运行版本：

```bash
git tag v0.1.0 -m "phase 1: SQLite core with facts/citations/audit"
git push origin v0.1.0
```

---

## 每个阶段的不可妥协项

| 阶段 | 必须满足 | 可以没有 |
|------|---------|---------|
| 1 | record_turn SQLite 写入完整；get_facts/get_audit/get_citations 能查 | 文件系统、检索、REST |
| 2 | messages.jsonl + content.md 可读 | 检索、REST |
| 3 | retrieve() 返回正确排序结果 | 语义检索、REST |
| 4 | 6 轮后 content.md 有摘要 | REST、语义 |
| 5 | 混合检索含语义结果 | REST |
| 6 | 5 个端点全部可调 | 前端集成 |
| 7 | ChatService 完整集成 | 无 |

---

## 开发顺序建议

**强烈建议按 1→2→3→6→7 的顺序（先做无争议的），4 和 5 可以并行。**

```
Week 1:  Phase 1 (SQLite) → Phase 2 (文件) → Phase 3 (检索)
         每天一个 phase，每个 phase 写完就 commit + tag

Week 2:  Phase 6 (REST) → Phase 7 (集成)
         中间插 Phase 4 (checkpoint) 和 Phase 5 (语义)

Week 3:  打磨测试 + 修复边缘情况
```

每个 Phase 不超过 2 小时编码 + 30 分钟测试。
