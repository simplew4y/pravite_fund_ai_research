# Research Memory 模块 — 实现方案 (SRS)

> 版本: 1.0
> 负责人: 廖子兴
> 分支: `lzx_memo`
> 本文档在实现过程中不允许修改，如有异议先开 Issue 讨论。

---

## 目录

1. [概述](#1-概述)
2. [架构与数据流](#2-架构与数据流)
3. [数据模型](#3-数据模型)
4. [接口规范](#4-接口规范)
5. [功能实现](#5-功能实现)
6. [非功能需求](#6-非功能需求)
7. [文件清单](#7-文件清单)
8. [验收测试](#8-验收测试)
9. [部署配置](#9-部署配置)

---

# 1. 概述

## 1.1 产品

Research Memory 是私募投研系统的记忆模块。它记录每次研究问答的原文、事实、引用和审计轨迹，支持精确回看和语义检索，让研究员能跨会话追踪公司研究的历史结论和观点变化。

## 1.2 范围

| 包含 (P0) | 不包含 |
|-----------|--------|
| QA 完整写入 (原文/事实/引用/审计) | LLM 事实提取 (由上层传入) |
| FTS5 + embedding 混合检索 | 观点冲突检测 (P1) |
| REST API | 多用户权限 (P1) |
| 长会话 checkpoint | memory_items 统一索引 (P1) |
| OpenViking 语义索引 | Obsidian 双向同步 (P2) |

## 1.3 关键术语

| 术语 | 定义 |
|------|------|
| session | 一次研究会话，含多次 Q&A 交互 |
| turn | 一问一答 |
| fact | 从问答中提取的结构化关键事实 |
| citation | 回答中引用的证据位置 |
| audit_trail | 回答生成过程的完整审计记录 |
| checkpoint | 长会话中用于压缩的中间摘要 |

---

# 2. 架构与数据流

## 2.1 组件架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        ChatService / Agent                        │
│                                                                   │
│  生成回答后调: ResearchMemory.record_turn()                      │
│  生成回答前调: ResearchMemory.retrieve_for_prompt()              │
└──────────┬──────────────────────────┬────────────────────────────┘
           │                          │
           ▼                          ▼
┌────────────────────┐   ┌──────────────────────────────────────┐
│  ResearchMemory     │   │  deploy/memory_routes.py            │
│  (继承 MemoryManager)│   │  (FastAPI, 给前端调)                │
│                    │   │                                      │
│  record_turn()     │   │  POST  /memory/turn                 │
│  retrieve()        │   │  GET   /memory/retrieve             │
│  get_facts()       │   │  GET   /memory/facts                │
│  get_audit()       │   │  GET   /memory/audit                │
│  get_citations()   │   │  GET   /memory/citations            │
└────────┬───────────┘   └──────────────────────────────────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐  ┌──────────┐
│ SQLite  │  │ 文件系统  │ ← OpenViking
│ 精确检索 │  │ .md 文件  │   add_resource
└────────┘  └──────────┘   → search()
```

## 2.2 数据流

### 写入流 (record_turn)

```
入参:
  session_id: str         会话 ID
  question: str           用户问题
  answer: str             系统回答
  citations: list[Citation]  引用列表 (可选)
  facts: list[Fact]           事实列表 (可选)
  audit: AuditMeta           审计元数据 (可选)

步骤:
  1. qa_messages INSERT (user)
  2. qa_messages INSERT (assistant, 带 citation_ids)
  3. messages.jsonl APPEND (user)
  4. messages.jsonl APPEND (assistant)
  5. content.md APPEND (user 段落 + assistant 段落 + 引用列表)
  6. citations BATCH INSERT
  7. facts BATCH INSERT
  8. audit_trail INSERT
  9. .overview.md REWRITE (最近 6 条)
  10. .abstract.md REWRITE (最新消息摘要)
  11. 如果 turn_count % 5 == 0: _checkpoint()
  12. memory_index.embedding ASYNC UPDATE

  异常处理:
    - 步骤 1-5 失败 → 整体失败, 返回 error
    - 步骤 6-10 失败 → 日志警告, 不阻塞 (数据已写磁盘)
    - 步骤 11-12 失败 → 静默忽略, 下次触发

返回值:
  {
    "ok": true,
    "message_id": "msg_abc123",
    "citation_ids": ["cit_001", "cit_002"]
  }
```

### 检索流 (retrieve)

```
入参:
  query: str              查询文本
  top_k: int = 5          返回条数

步骤:
  1. _search_exact(query, top_k * 2)
     a. facts 表: entity/entity+metric LIKE 匹配
     b. FTS5: qa_messages content 全文匹配
     → score=1.0 (facts表) / score=0.95 (FTS5)
     
  2. _search_semantic(query, top_k * 2)
     a. 如果 _embed 未设置 → return []
     b. OpenViking search(query)
     c. 从 memories/ 路径过滤
     → score=相似度 (0.0~1.0)
     
  3. merge(exact, semantic, top_k)
     a. 精确结果先入, score 不变
     b. 语义结果后入, score = score * 0.7
     c. 按 score 降序, 取 top_k
     d. 同一 source 去重 (保留 score 高的)
     
  4. 格式化 → "[Related History]\n📌 xxx\n🔗 xxx"

返回值:
  给 retrieve_for_prompt: str (直接注入 prompt)
  给 retrieve: list[{"content", "score", "tier", "source"}]
```

### Checkpoint 流 (长会话)

```
触发条件: turn_count > 0 AND turn_count % 5 == 0

步骤:
  1. messages = get_session_messages(session_id)
  2. 如果 len(messages) < 5 → return
  3. recent = messages[-5:]  (最新 5 轮)
  4. session_path = fin://sessions/{session_id}
  5. 如果 .checkpoint.md 存在:
       old = .checkpoint.md 内容
       summary = LLM(旧摘要 + 最新5轮 → 新摘要)
     否则:
       summary = LLM(全部消息 → 首次摘要)
  6. .checkpoint.md 写入新摘要
  7. content.md = summary + "\n---\n" + recent_md
  8. .abstract.md = summary[:120]
  9. embedding 更新 (如果 _embed 已设置)
```

---

# 3. 数据模型

## 3.1 SQLite Schema

所有表建在 `{base_dir}/db_index.db` 中（继承现有 MemoryManager 的 db_path）。

### qa_sessions

```sql
CREATE TABLE IF NOT EXISTS qa_sessions (
    session_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT 'default',
    analyst_id TEXT NOT NULL DEFAULT '',       -- P1 启用
    title TEXT NOT NULL DEFAULT '',
    topic TEXT NOT NULL DEFAULT '',
    entities TEXT NOT NULL DEFAULT '[]',       -- JSON array
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### qa_messages

```sql
CREATE TABLE IF NOT EXISTS qa_messages (
    message_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT 'default',
    analyst_id TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
    content TEXT NOT NULL,
    citation_ids TEXT NOT NULL DEFAULT '[]',   -- assistant 消息的引用ID列表
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON qa_messages(session_id, created_at);
```

### facts

```sql
CREATE TABLE IF NOT EXISTS facts (
    fact_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT 'default',
    analyst_id TEXT NOT NULL DEFAULT '',
    message_id TEXT,                           -- 来源消息
    entity TEXT NOT NULL,                      -- "极氪"
    metric TEXT NOT NULL,                      -- "毛利率"
    value TEXT NOT NULL,                       -- "15.2%"
    unit TEXT NOT NULL DEFAULT '',
    period TEXT NOT NULL DEFAULT '',           -- "FY2024"
    fact_type TEXT NOT NULL DEFAULT 'metric' 
        CHECK(fact_type IN ('metric', 'risk', 'catalyst', 'assumption', 'viewpoint', 'task')),
    source_ref TEXT NOT NULL DEFAULT '',       -- "年报.pdf p92"
    primary_citation_id TEXT,                  -- 主引用
    needs_review INTEGER NOT NULL DEFAULT 0,   -- 1=需要复核
    confidence REAL NOT NULL DEFAULT 1.0,
    version INTEGER NOT NULL DEFAULT 1,
    superseded_at TEXT,                        -- 被新版本取代的时间
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity, metric);
CREATE INDEX IF NOT EXISTS idx_facts_period ON facts(entity, period);
CREATE INDEX IF NOT EXISTS idx_facts_citation ON facts(primary_citation_id);
```

### citations

```sql
CREATE TABLE IF NOT EXISTS citations (
    citation_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT 'default',
    analyst_id TEXT NOT NULL DEFAULT '',
    source_type TEXT NOT NULL CHECK(source_type IN ('qa_message', 'fact', 'memo_section')),
    source_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL DEFAULT '',
    doc_id TEXT NOT NULL,
    doc_type TEXT NOT NULL DEFAULT '',
    page INTEGER,
    table_id TEXT NOT NULL DEFAULT '',
    cell_ref TEXT NOT NULL DEFAULT '',
    claim TEXT NOT NULL DEFAULT '',            -- 该引用支持的结论
    quote TEXT NOT NULL DEFAULT '',            -- 证据原文
    reason TEXT NOT NULL DEFAULT '',           -- 为什么引用
    display TEXT NOT NULL DEFAULT '',          -- 人类可读: "年报.pdf p92"
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_citations_source ON citations(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_citations_doc ON citations(doc_id);
```

### audit_trail

```sql
CREATE TABLE IF NOT EXISTS audit_trail (
    audit_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT 'default',
    analyst_id TEXT NOT NULL DEFAULT '',
    message_id TEXT,
    query_text TEXT NOT NULL,
    rewritten_query TEXT NOT NULL DEFAULT '',
    sub_queries TEXT NOT NULL DEFAULT '[]',
    exact_results TEXT NOT NULL DEFAULT '[]',
    semantic_results TEXT NOT NULL DEFAULT '[]',
    merged_results TEXT NOT NULL DEFAULT '[]',
    used_evidence TEXT NOT NULL DEFAULT '[]',
    generated_answer TEXT NOT NULL DEFAULT '',
    facts_written TEXT NOT NULL DEFAULT '[]',
    citations_written TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'ok',
    error TEXT NOT NULL DEFAULT '',
    latency_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_trail(session_id, created_at);
```

## 3.2 文件系统

```
{base_dir}/
├── db_index.db                    ← SQLite (上述全部表)
│
└── sessions/
    └── {session_id}/
        ├── messages.jsonl         ← 逐行 JSON
        ├── content.md             ← 可读 Markdown
        ├── .abstract.md           ← L0 摘要
        ├── .overview.md           ← L1 最近 6 条
        ├── .checkpoint.md         ← 长会话压缩 (仅长会话有)
        └── last_commit.json       ← 归档记录
```

### messages.jsonl 格式

```jsonl
{"message_id": "msg_001", "session_id": "sess_001", "role": "user", "content": "极氪FY2024毛利率变化怎么看？", "citation_ids": [], "timestamp": "2026-06-26T10:00:00Z"}
{"message_id": "msg_002", "session_id": "sess_001", "role": "assistant", "content": "15.2%，同比+1.8pct", "citation_ids": ["cit_001"], "timestamp": "2026-06-26T10:00:30Z"}
```

### content.md 格式

```markdown
# QA Session sess_001

## User (2026-06-26T10:00:00Z)
极氪FY2024毛利率变化怎么看？

## Assistant (2026-06-26T10:00:30Z)
15.2%，同比+1.8pct

**引用：**
- cit_001: 年报.pdf p92
```

---

# 4. 接口规范

## 4.1 Python 类接口

```python
class ResearchMemory(MemoryManager):
    def __init__(self, base_dir: str = ".memory")
        # 继承 MemoryManager
        # 调用 _init_p0_tables()
        # self._embed = None
        # self._llm = None
    
    # ── 写入 ─────────────────────────────────────
    
    def record_turn(
        self,
        session_id: str,          # 必填
        question: str,            # 必填
        answer: str,              # 必填
        citations: list[dict] = None,  # 可选
        facts: list[dict] = None,      # 可选
        audit: dict = None             # 可选
    ) -> dict
        # 返回: {"ok": bool, "message_id": str, "citation_ids": list[str]}
        # 异常: 不抛出, 失败字段在返回 dict 中标记
    
    # ── 检索 ─────────────────────────────────────
    
    def retrieve(
        self,
        query: str,               # 必填
        top_k: int = 5            # 可选, 默认 5
    ) -> list[dict]
        # 返回: [{content, score, tier, source}]
        # tier: "exact" | "semantic"
    
    def retrieve_for_prompt(
        self,
        query: str,
        top_k: int = 5
    ) -> str
        # 返回: "[Related History]\n📌 xxx\n🔗 xxx" 或 ""(无结果)
    
    # ── 专有查询 ─────────────────────────────────
    
    def get_facts(
        self,
        entity: str,              # 必填
        metric: str = None,       # 可选
        period: str = None,       # 可选
        limit: int = 10
    ) -> list[dict]
    
    def get_audit(self, session_id: str) -> list[dict]
    
    def get_citations(
        self,
        source_type: str,         # "qa_message" | "fact"
        source_id: str
    ) -> list[dict]
    
    # ── 注入 ─────────────────────────────────────
    
    def set_embedding_fn(self, fn: callable)
        # fn: (text: str) -> list[float]
        # 设置后 _search_semantic() 生效
    
    def set_llm_fn(self, fn: callable)
        # fn: (prompt: str) -> str
        # 设置后 _checkpoint_session() 生效
```

## 4.2 REST API

### POST /memory/turn

```json
// Request
{
  "session_id": "sess_001",
  "question": "极氪FY2024毛利率变化怎么看？",
  "answer": "15.2%，同比+1.8pct",
  "citations": [
    {
      "doc_id": "zk_2024_annual_report",
      "doc_type": "pdf",
      "page": 92,
      "evidence_text": "2024年毛利率为15.2%",
      "display": "年报.pdf p92"
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
      "source_ref": "年报.pdf p92"
    }
  ],
  "audit": {
    "model_name": "deepseek-v4-flash",
    "latency_ms": 3240,
    "rewritten_query": "",
    "exact_results": [],
    "semantic_results": [],
    "merged_results": []
  }
}

// Response 201
{
  "ok": true,
  "message_id": "msg_002",
  "citation_ids": ["cit_001"]
}
```

### GET /memory/retrieve

```
GET /memory/retrieve?q=极氪毛利率&k=5

// Response 200
{
  "items": [
    {"content": "极氪 毛利率: 15.2% (FY2024)", "score": 1.0, "tier": "exact", "source": "年报.pdf p92"},
    {"content": "极氪 vs 蔚来毛利率对比分析", "score": 0.87, "tier": "semantic", "source": "viking://memory/sessions/.../content.md"}
  ]
}
```

### GET /memory/facts

```
GET /memory/facts?entity=极氪&metric=毛利率

// Response 200
{
  "facts": [
    {"entity": "极氪", "metric": "毛利率", "value": "15.2%", "period": "FY2024", "source_ref": "年报.pdf p92", "created_at": "2026-06-26..."}
  ]
}
```

### GET /memory/audit/{session_id}

```
// Response 200
{
  "trail": [
    {"query_text": "极氪毛利率？", "generated_answer": "15.2%", "latency_ms": 3240, "status": "ok", "created_at": "..."}
  ]
}
```

### GET /memory/citations

```
GET /memory/citations?source_type=qa_message&source_id=msg_002

// Response 200
{
  "citations": [
    {"doc_id": "zk_2024_annual_report", "page": 92, "evidence_text": "2024年毛利率为15.2%", "display": "年报.pdf p92"}
  ]
}
```

---

# 5. 功能实现

## 5.1 ResearchMemory 类

### 初始化

```python
class ResearchMemory(MemoryManager):
    def __init__(self, base_dir=".memory"):
        super().__init__(base_dir)
        self._init_p0_tables()
        self._embed = None
        self._llm = None
    
    def _init_p0_tables(self):
        """建 P0 表 (幂等)"""
        conn = sqlite3.connect(self.db_path)
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS qa_sessions (...);
            CREATE TABLE IF NOT EXISTS qa_messages (...);
            CREATE TABLE IF NOT EXISTS facts (...);
            CREATE TABLE IF NOT EXISTS citations (...);
            CREATE TABLE IF NOT EXISTS audit_trail (...);
            CREATE INDEX IF NOT EXISTS ...;
        """)
        conn.close()
```

### record_turn

```python
def record_turn(self, session_id, question, answer,
                citations=None, facts=None, audit=None):
    now = datetime.now(timezone.utc).isoformat()
    
    # 1. 生成 ID
    msg_user_id = f"msg_{uuid4().hex[:12]}"
    msg_asst_id = f"msg_{uuid4().hex[:12]}"
    cit_ids = []
    
    conn = sqlite3.connect(self.db_path)
    cur = conn.cursor()
    
    try:
        # 2. citations 写入
        if citations:
            for c in citations:
                cit_id = f"cit_{uuid4().hex[:12]}"
                cit_ids.append(cit_id)
                cur.execute("""
                    INSERT INTO citations (citation_id, session_id, source_type, source_id,
                        doc_id, doc_type, page, evidence_text, claim, display)
                    VALUES (?, ?, 'qa_message', ?, ?, ?, ?, ?, ?, ?)
                """, (cit_id, session_id, msg_asst_id, c.get("doc_id",""),
                      c.get("doc_type",""), c.get("page"), c.get("evidence_text",""),
                      c.get("claim",""), c.get("display","")))
        
        # 3. qa_messages
        cur.execute("INSERT INTO qa_messages VALUES (?,?,?,?,?,?,?,?)",
                    (msg_user_id, session_id, "default", "", "user", question, "[]", "{}", now))
        cur.execute("INSERT INTO qa_messages VALUES (?,?,?,?,?,?,?,?)",
                    (msg_asst_id, session_id, "default", "", "assistant", answer,
                     json.dumps(cit_ids), "{}", now))
        
        # 4. facts
        if facts:
            for f in facts:
                fid = f"fact_{uuid4().hex[:12]}"
                cur.execute("""
                    INSERT INTO facts (fact_id, session_id, message_id, entity, metric,
                        value, unit, period, fact_type, source_ref, confidence)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (fid, session_id, msg_asst_id, f["entity"], f["metric"],
                      f["value"], f.get("unit",""), f.get("period",""),
                      f.get("fact_type","metric"), f.get("source_ref",""), f.get("confidence",1.0)))
        
        # 5. audit
        if audit:
            aid = f"aud_{uuid4().hex[:12]}"
            cur.execute("""
                INSERT INTO audit_trail (audit_id, session_id, message_id, query_text,
                    rewritten_query, sub_queries, exact_results, semantic_results,
                    merged_results, used_evidence, generated_answer, facts_written,
                    citations_written, status, latency_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (aid, session_id, msg_asst_id, question,
                  audit.get("rewritten_query",""), json.dumps(audit.get("sub_queries",[])),
                  json.dumps(audit.get("exact_results",[])), json.dumps(audit.get("semantic_results",[])),
                  json.dumps(audit.get("merged_results",[])), json.dumps(audit.get("used_evidence",[])),
                  answer, json.dumps(audit.get("facts_written",[])),
                  json.dumps(audit.get("citations_written",[])),
                  audit.get("status","ok"), audit.get("latency_ms",0), now))
        
        conn.commit()
    except Exception as e:
        conn.rollback()
        return {"ok": False, "error": str(e), "message_id": "", "citation_ids": []}
    finally:
        conn.close()
    
    # 6. 文件系统消息
    self.append_session_message(session_id, "user", question)
    self.append_session_message(session_id, "assistant", answer)
    
    # 7. checkpoint (静默)
    try:
        turn_count = self._count_messages(session_id)
        self._checkpoint_session(session_id, turn_count)
    except Exception:
        pass
    
    # 8. embedding (静默)
    try:
        self._update_embedding(session_id)
    except Exception:
        pass
    
    return {"ok": True, "message_id": msg_asst_id, "citation_ids": cit_ids}
```

### retrieve

```python
def retrieve(self, query, top_k=5):
    exact = self._search_exact(query, top_k * 2)
    semantic = self._search_semantic(query, top_k * 2)
    return self._merge(exact, semantic, top_k)

def retrieve_for_prompt(self, query, top_k=5):
    items = self.retrieve(query, top_k)
    if not items:
        return ""
    parts = ["[Related History]"]
    for item in items:
        prefix = "📌" if item["tier"] == "exact" else "🔗"
        parts.append(f"{prefix} {item['content']}")
    return "\n".join(parts)

def _search_exact(self, query, limit):
    results = []
    conn = sqlite3.connect(self.db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    
    # facts 表精确匹配
    cur.execute("""
        SELECT entity, metric, value, unit, period, source_ref, created_at
        FROM facts
        WHERE metric LIKE ? OR entity = ?
        ORDER BY created_at DESC
        LIMIT ?
    """, (f"%{query}%", self._extract_entity(query), limit))
    for r in cur.fetchall():
        results.append({
            "content": f"{r['entity']} {r['metric']}: {r['value']}{r['unit']} ({r['period']})",
            "score": 1.0, "tier": "exact",
            "source": r["source_ref"] or f"session/{r['created_at'][:10]}"
        })
    
    # FTS5 全文匹配 (memory_fts 已存在)
    try:
        words = " OR ".join(w + "*" for w in query.split() if w.strip())
        cur.execute("""
            SELECT uri, abstract FROM memory_fts
            WHERE memory_fts MATCH ?
            ORDER BY rank LIMIT ?
        """, (words, limit))
        for r in cur.fetchall():
            results.append({
                "content": r["abstract"],
                "score": 0.95, "tier": "exact",
                "source": r["uri"]
            })
    except Exception:
        pass
    
    conn.close()
    return results

def _search_semantic(self, query, limit):
    if not self._embed:
        return []
    q_emb = self._embed(query)
    conn = sqlite3.connect(self.db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT uri, abstract, embedding FROM memory_index WHERE embedding IS NOT NULL")
    scored = []
    for r in rows:
        if not r["embedding"]:
            continue
        emb = json.loads(r["embedding"])
        score = self._cosine_similarity(q_emb, emb)
        if score > 0.3:  # 低分过滤
            scored.append({
                "content": r["abstract"] or r["uri"],
                "score": score, "tier": "semantic",
                "source": r["uri"]
            })
    conn.close()
    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:limit]

def _merge(self, exact, semantic, top_k):
    seen = set()
    merged = []
    for item in exact:
        key = item["source"][:60]
        if key not in seen:
            merged.append(item)
            seen.add(key)
    for item in semantic:
        key = item["source"][:60]
        if key not in seen and len(merged) < top_k * 2:
            item["score"] *= 0.7
            merged.append(item)
            seen.add(key)
    merged.sort(key=lambda x: x["score"], reverse=True)
    return merged[:top_k]

@staticmethod
def _cosine_similarity(a, b):
    dot = sum(x*y for x,y in zip(a,b))
    na = sum(x*x for x in a)**0.5
    nb = sum(x*x for x in b)**0.5
    return dot/(na*nb) if na*nb else 0

@staticmethod
def _extract_entity(query):
    return query[:20]  # P0 简化, 后续可用 LLM 提取
```

### checkpoint

```python
def _checkpoint_session(self, session_id, turn_count, interval=5):
    if turn_count < interval or turn_count % interval != 0:
        return
    if not self._llm:
        return
    
    messages = self.get_session_messages(session_id)
    if len(messages) < interval * 2:
        return
    
    recent = messages[-interval*2:]
    session_path = self._uri_to_path(f"fin://sessions/{session_id}")
    existing = ""
    if (session_path / ".checkpoint.md").exists():
        existing = (session_path / ".checkpoint.md").read_text(encoding="utf-8")
    
    if existing:
        prompt = f"基于已有摘要和最新对话生成更新摘要。\n已有摘要:\n{existing}\n最新对话:\n{self._fmt_messages(recent)}"
    else:
        prompt = f"总结以下投研对话的核心内容，包括涉及公司、关键数据、观点变化。\n{self._fmt_messages(recent)}"
    
    summary = self._llm(prompt)
    (session_path / ".checkpoint.md").write_text(summary, encoding="utf-8")
    
    recent_md = self._messages_to_md(recent[-interval*2:])
    new_content = f"{summary}\n\n---\n\n## 最新对话\n\n{recent_md}"
    (session_path / "content.md").write_text(new_content, encoding="utf-8")
    
    abstract = summary[:120]
    if len(summary) > 120:
        abstract += "..."
    (session_path / ".abstract.md").write_text(abstract, encoding="utf-8")
    
    self._update_embedding(session_id)

@staticmethod
def _fmt_messages(msgs):
    return "\n".join(f"[{m.get('role','?')}] {str(m.get('content',''))[:200]}" for m in msgs)

@staticmethod
def _messages_to_md(msgs):
    parts = []
    for m in msgs:
        ts = m.get("timestamp", m.get("created_at", ""))
        role = m.get("role", "?")
        content = m.get("content", "")
        parts.append(f"### [{ts}] {role}\n\n{content}")
    return "\n\n".join(parts)
```

### update embedding

```python
def _update_embedding(self, session_id):
    if not self._embed:
        return
    uri = f"fin://sessions/{session_id}"
    content = self.read_memory(uri, "L2")
    if not content or "PathNotFoundError" in content:
        return
    try:
        emb = self._embed(content[:1000])
        conn = sqlite3.connect(self.db_path)
        conn.execute("UPDATE memory_index SET embedding=? WHERE uri=?", 
                     (json.dumps(emb), uri))
        conn.commit()
        conn.close()
    except Exception:
        pass
```

### get_facts / get_audit / get_citations

```python
def get_facts(self, entity, metric=None, period=None, limit=10):
    conn = sqlite3.connect(self.db_path)
    conn.row_factory = sqlite3.Row
    sql = "SELECT * FROM facts WHERE entity=?"
    params = [entity]
    if metric:
        sql += " AND metric LIKE ?"
        params.append(f"%{metric}%")
    if period:
        sql += " AND period=?"
        params.append(period)
    sql += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    conn.close()
    return rows

def get_audit(self, session_id):
    conn = sqlite3.connect(self.db_path)
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM audit_trail WHERE session_id=? ORDER BY created_at", (session_id,)).fetchall()]
    conn.close()
    return rows

def get_citations(self, source_type, source_id):
    conn = sqlite3.connect(self.db_path)
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM citations WHERE source_type=? AND source_id=?",
        (source_type, source_id)).fetchall()]
    conn.close()
    return rows
```

### count_messages

```python
def _count_messages(self, session_id):
    return len(self.get_session_messages(session_id)) // 2
```

## 5.2 FastAPI 路由

文件: `deploy/memory_routes.py`

```python
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional

router = APIRouter(prefix="/memory", tags=["memory"])

class CitationInput(BaseModel):
    doc_id: str
    doc_type: Optional[str] = ""
    page: Optional[int] = None
    evidence_text: Optional[str] = ""
    claim: Optional[str] = ""
    display: Optional[str] = ""

class FactInput(BaseModel):
    entity: str
    metric: str
    value: str
    unit: Optional[str] = ""
    period: Optional[str] = ""
    fact_type: Optional[str] = "metric"
    source_ref: Optional[str] = ""
    confidence: Optional[float] = 1.0

class AuditInput(BaseModel):
    model_name: Optional[str] = ""
    latency_ms: Optional[int] = 0
    rewritten_query: Optional[str] = ""
    exact_results: Optional[list] = []
    semantic_results: Optional[list] = []
    merged_results: Optional[list] = []

class TurnRequest(BaseModel):
    session_id: str
    question: str
    answer: str
    citations: Optional[list[CitationInput]] = []
    facts: Optional[list[FactInput]] = []
    audit: Optional[AuditInput] = None

def _get_memory():
    from app import chat_service
    if chat_service is None:
        raise HTTPException(503, "Chat service not ready")
    mm = getattr(chat_service, "memory", None)
    if mm is None:
        raise HTTPException(503, "Memory not initialized")
    return mm

@router.post("/turn", status_code=201)
async def record_turn(req: TurnRequest):
    mm = _get_memory()
    result = mm.record_turn(
        session_id=req.session_id,
        question=req.question,
        answer=req.answer,
        citations=[c.dict() for c in req.citations] if req.citations else None,
        facts=[f.dict() for f in req.facts] if req.facts else None,
        audit=req.audit.dict() if req.audit else None
    )
    if not result.get("ok"):
        raise HTTPException(500, result.get("error", "unknown"))
    return result

@router.get("/retrieve")
async def retrieve(q: str = Query(..., min_length=1), k: int = 5):
    mm = _get_memory()
    items = mm.retrieve(q, k)
    return {"items": items}

@router.get("/facts")
async def get_facts(entity: str, metric: Optional[str] = None):
    mm = _get_memory()
    facts = mm.get_facts(entity, metric)
    return {"facts": facts}

@router.get("/audit/{session_id}")
async def get_audit(session_id: str):
    mm = _get_memory()
    trail = mm.get_audit(session_id)
    return {"trail": trail}

@router.get("/citations")
async def get_citations(source_type: str, source_id: str):
    mm = _get_memory()
    citations = mm.get_citations(source_type, source_id)
    return {"citations": citations}
```

## 5.3 配置

```yaml
# config/production.yaml 新增
memory:
  dir: ".memory"
  embedding_enabled: true
  search_top_k: 5
  checkpoint_interval: 5
```

---

# 6. 非功能需求

## 6.1 性能

| 操作 | 目标 | 说明 |
|------|------|------|
| record_turn() | < 200ms | 不含 embedding |
| retrieve() | < 500ms | 含 SQLite + OpenViking |
| get_facts() | < 100ms | SQLite 索引查询 |
| 并发 | 10 QPS | SQLite 写锁由上层排队 |

## 6.2 可靠性

- 所有写入操作先写 SQLite（事务保障）再写文件系统
- 文件系统写入失败不影响 SQLite 数据
- embedding / checkpoint 失败不影响主流程
- 重启不丢数据（SQLite + 文件系统均持久化）

## 6.3 安全

- 记录 audit_trail 谁查了什么、用了什么模型
- citations 只存 evidence_id，不存原始文件内容

---

# 7. 文件清单

| 文件 | 操作 | 依赖 | 说明 |
|------|------|------|------|
| `FinSagent/src/core/MemoryManager.py` | **不动** | 无 | 保持 436 行不变 |
| `FinSagent/src/core/ResearchMemory.py` | **新建** | MemoryManager | 约 300 行，核心实现 |
| `FinSagent/deploy/memory_routes.py` | **新建** | FastAPI | 约 100 行，REST 接口 |
| `test/research_memory/` | **新建** | pytest | 测试目录 |
| `config/production.yaml` | **改** | 无 | 加 memory 配置段 |

---

# 8. 验收测试

## 8.1 测试清单

```python
# test/research_memory/test_record_turn.py
def test_record_turn_basic(mm, sample_turn):
    """QA 写入后 messages.jsonl / content.md / qa_messages / facts / citations / audit 都有数据"""
    result = mm.record_turn(**sample_turn)
    assert result["ok"]
    assert result["message_id"].startswith("msg_")
    
    # messages.jsonl 有 2 行
    msgs = mm.get_session_messages(sample_turn["session_id"])
    assert len(msgs) == 2
    
    # content.md 存在
    content = mm.read_memory(f"fin://sessions/{sample_turn['session_id']}", "L2")
    assert "极氪" in content
    
    # facts 有数据
    facts = mm.get_facts("极氪")
    assert len(facts) > 0
    
    # citations 有数据
    cits = mm.get_citations("qa_message", result["message_id"])
    assert len(cits) > 0
    
    # audit 有数据
    audit = mm.get_audit(sample_turn["session_id"])
    assert len(audit) > 0


def test_retrieve_exact(mm, sample_turn):
    """写入后 retrieve 能精确召回"""
    mm.record_turn(**sample_turn)
    items = mm.retrieve("毛利率")
    assert len(items) > 0
    assert items[0]["tier"] == "exact"
    assert "15.2%" in items[0]["content"]


def test_retrieve_empty(mm):
    """无匹配数据返回空列表"""
    items = mm.retrieve("不存在的关键字")
    assert items == []


def test_retrieve_for_prompt(mm, sample_turn):
    """返回格式化的 prompt 注入段"""
    mm.record_turn(**sample_turn)
    prompt = mm.retrieve_for_prompt("毛利率")
    assert prompt.startswith("[Related History]")
    assert "📌" in prompt or "🔗" in prompt


def test_facts_version(mm, sample_turn):
    """同一 entity/metric 多次写入, 各版本保留"""
    mm.record_turn(**sample_turn)
    turn2 = dict(sample_turn)
    turn2["question"] = "毛利率修正？"
    turn2["answer"] = "14.8%"
    turn2["facts"][0]["value"] = "14.8%"
    mm.record_turn(**turn2)
    
    facts = mm.get_facts("极氪", "毛利率")
    assert len(facts) >= 2
    assert facts[0]["value"] != facts[1]["value"]  # 不同版本


def test_persistence(mm, sample_turn, tmp_path):
    """重启后数据不丢"""
    db_path = mm.db_path
    content_path = mm._uri_to_path(f"fin://sessions/{sample_turn['session_id']}")
    
    mm.record_turn(**sample_turn)
    
    # 模拟重启 (新建实例)
    from core.ResearchMemory import ResearchMemory
    mm2 = ResearchMemory(base_dir=str(Path(mm.base_dir).parent))
    
    facts = mm2.get_facts("极氪")
    assert len(facts) > 0


@pytest.fixture
def mm(tmp_path):
    from core.ResearchMemory import ResearchMemory
    m = ResearchMemory(base_dir=str(tmp_path / ".memory"))
    return m

@pytest.fixture
def sample_turn():
    return {
        "session_id": "sess_test_001",
        "question": "极氪毛利率是多少？",
        "answer": "15.2%",
        "citations": [{
            "doc_id": "zk_2024_report", "doc_type": "pdf",
            "page": 92, "evidence_text": "15.2%", "display": "年报.pdf p92"
        }],
        "facts": [{
            "entity": "极氪", "metric": "毛利率", "value": "15.2%",
            "unit": "", "period": "FY2024", "fact_type": "metric",
            "source_ref": "年报.pdf p92"
        }],
        "audit": {"model_name": "test", "latency_ms": 100}
    }
```

## 8.2 通过条件

| # | 测试 | 优先级 | 说明 |
|---|------|--------|------|
| 1 | record_turn 完整写入 | P0 | messages.jsonl / content.md / qa_messages / facts / citations / audit 全部有数据 |
| 2 | retrieve 精确召回 | P0 | 写入 facts 后检索能排第一 |
| 3 | retrieve 空结果 | P0 | 无匹配时返回空列表 |
| 4 | retrieve_for_prompt | P0 | 返回格式化的注入段 |
| 5 | facts 版本保留 | P0 | 同一 entity 两次写入，两个版本都存在 |
| 6 | REST API | P0 | 5 个端点全部返回 200/201 |
| 7 | 重启持久化 | P0 | 新实例能查到旧数据 |
| 8 | 长会话 checkpoint | P1 | 6 轮后 content.md 出现摘要 |
| 9 | 语义检索 | P1 | embedding 注入后检索包含语义结果 |
| 10 | API 错误响应 | P0 | 非法参数返回 422 |

---

# 9. 部署配置

## 9.1 集成到 ChatService

在 `ChatService.__init__()` 中新增：

```python
from core.ResearchMemory import ResearchMemory

class ChatService:
    def __init__(self, config):
        ...
        self.memory = ResearchMemory(
            base_dir=config.get("memory", {}).get("dir", ".memory")
        )
        if hasattr(self, 'rag_manager') and self.rag_manager:
            retriever = self.rag_manager._retrievers[0]
            self.memory.set_embedding_fn(retriever.embeddings.embed_query)
```

在 `generate_response_stream()` 中集成：

```python
# 入口 (检索历史)
memory_context = self.memory.retrieve_for_prompt(query)
prompt = f"{memory_context}\n\n当前问题: {query}"

# 出口 (记录问答)
asyncio.create_task(self._async_record_turn(session_id, question, answer, citations, facts))

async def _async_record_turn(self, session_id, question, answer, citations, facts):
    self.memory.record_turn(session_id, question, answer, citations, facts)
```

## 9.2 注册 FastAPI 路由

在 `deploy/app.py` 中新增：

```python
from memory_routes import router as memory_router
app.include_router(memory_router)
```

---

> 本文档是 SRS，实现过程不允许修改。
> 如发现遗漏或有争议的设计，先开 Issue 讨论，讨论通过后再更新此文档。
> 分支: `lzx_memo`
